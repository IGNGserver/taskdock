import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHubOrigin, validateHubRequest, type HubRequestInput } from './hub-policy.js';
import {
  atomicWriteFile,
  decodeDesktopSession,
  encodeDesktopSession,
  readHubOriginFile,
  writeHubOriginFile,
  type DesktopSessionSecrets,
  type HubOriginFileState,
} from './persistence.js';

const isDevelopment = process.env['NODE_ENV'] === 'development';
const configuredRendererOrigin = process.env['DEVTODO_APP_ORIGIN'];
const developmentOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const moduleDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const secureFile = () => join(app.getPath('userData'), 'refresh-token.bin');
const hubOriginFile = () => join(app.getPath('userData'), 'hub-origin.json');
const windowStateFile = () => join(app.getPath('userData'), 'window-state.json');
const webRoot = app.isPackaged
  ? join(process.resourcesPath, 'web')
  : resolve(moduleDir, '../../web/dist');
const appIcon = app.isPackaged
  ? join(process.resourcesPath, 'brand', 'taskdock-icon.png')
  : resolve(moduleDir, '../resources/icons/taskdock-icon.png');

const singleInstanceLock = app.requestSingleInstanceLock();

protocol.registerSchemesAsPrivileged([
  { scheme: 'devtodo', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface NativeAuthSuccess {
  ok: true;
  accessToken: string;
  user: Record<string, unknown>;
  device: Record<string, unknown>;
}

interface NativeAuthFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  details: unknown;
}

type NativeAuthResponse = NativeAuthSuccess | NativeAuthFailure;

interface HubResponse {
  status: number;
  body: Record<string, unknown>;
}

interface HubRequestResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

type SystemTheme = 'light' | 'dark';

function getSystemTheme(): SystemTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function themeBackground(theme: SystemTheme): string {
  return theme === 'dark' ? '#1a1b20' : '#f5f2f9';
}

function themeTitleBar(theme: SystemTheme): { color: string; symbolColor: string } {
  return theme === 'dark'
    ? { color: '#171b23', symbolColor: '#eef2f7' }
    : { color: '#f5f2f9', symbolColor: '#1f2430' };
}

function applyWindowTheme(): void {
  if (!mainWindow) return;
  const theme = getSystemTheme();
  mainWindow.setBackgroundColor(themeBackground(theme));
  if (process.platform === 'win32')
    mainWindow.setTitleBarOverlay({ ...themeTitleBar(theme), height: 36 });
  if (!mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('devtodo:theme-changed', theme);
}

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const state = readWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 640,
    show: false,
    icon: appIcon,
    backgroundColor: themeBackground(getSystemTheme()),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...themeTitleBar(getSystemTheme()), height: 36 },
        }
      : {}),
    webPreferences: {
      preload: join(moduleDir, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.once('did-finish-load', () => {
    applyWindowTheme();
    const windowForSmoke = mainWindow;
    if (!windowForSmoke) return;
    void windowForSmoke.webContents
      .executeJavaScript('Boolean(window.devtodoDesktop)', true)
      .then((bridgeReady) => {
        if (process.env['DEVTODO_DESKTOP_SMOKE'] !== '1') return;
        console.log(
          bridgeReady ? 'DEVTODO_DESKTOP_BRIDGE_READY' : 'DEVTODO_DESKTOP_BRIDGE_MISSING',
        );
        console.log('DEVTODO_DESKTOP_RENDERER_READY');
      })
      .catch(() => {
        if (process.env['DEVTODO_DESKTOP_SMOKE'] === '1')
          console.log('DEVTODO_DESKTOP_BRIDGE_MISSING');
      });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  const webIndex = resolve(webRoot, 'index.html');
  const configuredHubOrigin = readConfiguredHubOrigin();
  if (isDevelopment) {
    const origin = configuredRendererOrigin ?? 'http://localhost:5173';
    if (!isAllowedNavigation(origin)) throw new Error('development app origin is not allowed');
    const rendererUrl = new URL(origin);
    rendererUrl.searchParams.set('desktop', '1');
    if (configuredHubOrigin) rendererUrl.searchParams.set('hubOrigin', configuredHubOrigin);
    void mainWindow.loadURL(rendererUrl.toString());
  } else {
    if (!existsSync(webIndex)) throw new Error('packaged web assets are missing');
    const query = new URLSearchParams({ desktop: '1' });
    if (configuredHubOrigin) query.set('hubOrigin', configuredHubOrigin);
    void mainWindow.loadURL(`devtodo://app/index.html?${query.toString()}`);
  }
  mainWindow.on('closed', () => {
    nativeTheme.removeListener('updated', applyWindowTheme);
    mainWindow = null;
  });
  nativeTheme.on('updated', applyWindowTheme);
  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    try {
      writeFileSync(windowStateFile(), JSON.stringify(bounds), { mode: 0o600 });
    } catch {
      /* Window state is a convenience and must never block shutdown. */
    }
  });
}

function isAllowedNavigation(url: string): boolean {
  try {
    if (url.startsWith('devtodo://app/')) return true;
    const origin = new URL(url).origin;
    return isDevelopment ? developmentOrigin.test(origin) : false;
  } catch {
    return false;
  }
}

function readConfiguredHubOrigin(): string | null {
  return readHubOriginFile(hubOriginFile()).origin;
}

function readConfiguredHubOriginState(): HubOriginFileState {
  return readHubOriginFile(hubOriginFile());
}

function saveConfiguredHubOrigin(value: string): string {
  return writeHubOriginFile(hubOriginFile(), value);
}

async function clearConfiguredHubOrigin(): Promise<void> {
  try {
    await unlink(hubOriginFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertIpcSender(sender: Electron.WebContents): void {
  if (sender !== mainWindow?.webContents) throw new Error('invalid sender');
}

function nativeAuthFailure(
  status: number,
  code: string,
  message: string,
  details: unknown = null,
): NativeAuthFailure {
  return { ok: false, status, code, message, details };
}

async function requestHub(
  input: HubRequestInput,
  allowUnconfiguredOrigin = false,
): Promise<HubRequestResult> {
  const validated = validateHubRequest(input, readConfiguredHubOrigin(), allowUnconfiguredOrigin);
  const headers = new Headers(validated.headers);
  headers.set('Origin', 'devtodo://app');

  let response: Response;
  try {
    response = await fetch(validated.url, {
      method: validated.method,
      headers,
      body:
        validated.method === 'GET' || validated.method === 'HEAD'
          ? undefined
          : (validated.body ?? undefined),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('network request failed: 无法连接中枢，请检查地址、证书和网络');
  }

  const responseHeaders: Record<string, string> = {};
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders['content-type'] = contentType;
  return { status: response.status, body: await response.text(), headers: responseHeaders };
}

async function testHubConnection(
  value: string,
  signal?: AbortSignal,
): Promise<{ initialized: boolean }> {
  const origin = parseHubOrigin(value);
  if (!origin) throw new Error('invalid hub origin');
  const requested = new URL(`${origin}/api/v1/bootstrap/status`);
  let response: Response;
  try {
    response = await fetch(requested, {
      method: 'GET',
      headers: { Accept: 'application/json', Origin: 'devtodo://app' },
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error('network request failed: 无法连接中枢，请检查地址、证书和网络');
  }
  if (!response.ok) throw new Error(`中枢返回 HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { initialized?: unknown } | null;
  if (!body || typeof body.initialized !== 'boolean') throw new Error('中枢响应格式无效');
  return { initialized: body.initialized };
}

async function postHubJson(path: string, body: Record<string, unknown>): Promise<HubResponse> {
  const origin = readConfiguredHubOrigin();
  if (!origin)
    return {
      status: 400,
      body: { code: 'HUB_NOT_CONFIGURED', message: '请先配置中枢地址' },
    };
  try {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'devtodo://app',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = (await response.json().catch(() => ({}))) as unknown;
    const responseBody =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { status: response.status, body: responseBody };
  } catch {
    return {
      status: 0,
      body: { code: 'NETWORK_ERROR', message: '无法连接中枢，请检查地址、证书和网络' },
    };
  }
}

function responseString(body: Record<string, unknown>, key: string, fallback: string): string {
  return typeof body[key] === 'string' && body[key] ? body[key] : fallback;
}

function responseDetails(body: Record<string, unknown>): unknown {
  return body['details'] ?? null;
}

const SECURE_TOKEN_MAGIC_SAFE = Buffer.from([0x54, 0x4b, 0x53, 0x31]); // 'TKS1'
const SECURE_TOKEN_MAGIC_PLAIN = Buffer.from([0x54, 0x4b, 0x50, 0x31]); // 'TKP1'

/**
 * 'unavailable' means the credential is on disk but the OS keystore could not
 * be read right now. It is deliberately not a logout: a keyring that is still
 * locked after a reboot used to look exactly like a revoked session.
 */
type StoredSessionResult =
  | (DesktopSessionSecrets & { state: 'available' })
  | { state: 'missing' }
  | { state: 'unavailable' }
  | { state: 'corrupt' };

let consecutiveUnreadableReads = 0;
const MAX_UNREADABLE_READS = 3;

async function saveSecureRefreshToken(session: DesktopSessionSecrets): Promise<void> {
  const json = encodeDesktopSession(session);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(json);
      atomicWriteFile(secureFile(), Buffer.concat([SECURE_TOKEN_MAGIC_SAFE, encrypted]));
      return;
    } catch {
      // safeStorage failed despite being available, fallback to restricted file
    }
  }
  const payload = Buffer.concat([SECURE_TOKEN_MAGIC_PLAIN, Buffer.from(json, 'utf8')]);
  atomicWriteFile(secureFile(), payload);
}

async function readSecureRefreshToken(): Promise<StoredSessionResult> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(secureFile());
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unavailable' };
  }
  if (fileBuffer.length < 4) return { state: 'corrupt' };

  const magic = fileBuffer.subarray(0, 4);
  const data = fileBuffer.subarray(4);
  let json: string;
  if (magic.equals(SECURE_TOKEN_MAGIC_PLAIN)) {
    json = data.toString('utf8');
  } else if (!safeStorage.isEncryptionAvailable()) {
    return { state: 'unavailable' };
  } else {
    try {
      // A TKS1 file carries the payload after the header; a headerless file is a
      // token written before the magic prefix existed.
      json = safeStorage.decryptString(magic.equals(SECURE_TOKEN_MAGIC_SAFE) ? data : fileBuffer);
    } catch {
      return { state: 'unavailable' };
    }
  }
  const session = decodeDesktopSession(json);
  return session ? { state: 'available', ...session } : { state: 'corrupt' };
}

async function removeSecureRefreshToken(): Promise<void> {
  try {
    await unlink(secureFile());
  } catch {
    /* an absent token is already the desired state */
  }
}

/** Only a Hub answer that names this session may discard the stored credential. */
function isSessionRevocation(status: number, body: Record<string, unknown>): boolean {
  if (status !== 401) return false;
  const code = body['code'];
  return code === 'AUTH_SESSION_REVOKED' || code === 'AUTH_INVALID_CREDENTIALS';
}

function newRefreshCandidate(): string {
  return randomBytes(48).toString('base64url');
}

async function nativeLogin(
  username: string,
  password: string,
  deviceName: string,
): Promise<NativeAuthResponse> {
  if (!username || !password || !deviceName)
    return nativeAuthFailure(400, 'VALIDATION_FAILED', '登录参数无效');
  const challengeResponse = await postHubJson('/auth/native/challenge', {});
  if (challengeResponse.status < 200 || challengeResponse.status >= 300)
    return nativeAuthFailure(
      challengeResponse.status || 503,
      responseString(challengeResponse.body, 'code', 'AUTH_REQUIRED'),
      responseString(challengeResponse.body, 'message', '原生客户端安全挑战失败'),
      responseDetails(challengeResponse.body),
    );
  const challenge = challengeResponse.body['challenge'];
  if (typeof challenge !== 'string' || !challenge)
    return nativeAuthFailure(502, 'AUTH_REQUIRED', '原生客户端安全挑战响应无效');
  const loginResponse = await postHubJson('/auth/login', {
    username,
    password,
    deviceName,
    platform: 'electron',
    nativeChallenge: challenge,
  });
  if (loginResponse.status < 200 || loginResponse.status >= 300)
    return nativeAuthFailure(
      loginResponse.status || 503,
      responseString(loginResponse.body, 'code', 'AUTH_REQUIRED'),
      responseString(loginResponse.body, 'message', '登录失败'),
      responseDetails(loginResponse.body),
    );
  const accessToken = loginResponse.body['accessToken'];
  const refreshToken = loginResponse.body['refreshToken'];
  const user = loginResponse.body['user'];
  const device = loginResponse.body['device'];
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    !user ||
    typeof user !== 'object' ||
    !device ||
    typeof device !== 'object'
  )
    return nativeAuthFailure(502, 'INTERNAL_ERROR', '中枢登录响应格式无效');
  try {
    await saveSecureRefreshToken({ refreshToken, pendingRefreshToken: null });
  } catch {
    return nativeAuthFailure(503, 'AUTH_STORAGE_UNAVAILABLE', '系统安全存储不可用');
  }
  return {
    ok: true,
    accessToken,
    user: user as Record<string, unknown>,
    device: device as Record<string, unknown>,
  };
}

async function nativeRefresh(): Promise<NativeAuthResponse> {
  const stored = await readSecureRefreshToken();
  if (stored.state === 'missing')
    return nativeAuthFailure(401, 'AUTH_SESSION_REVOKED', '会话不存在或已撤销');
  if (stored.state === 'corrupt') {
    await removeSecureRefreshToken();
    return nativeAuthFailure(401, 'AUTH_SESSION_REVOKED', '登录凭证无法读取，请重新登录');
  }
  if (stored.state === 'unavailable') {
    consecutiveUnreadableReads += 1;
    // The file stays untouched. Only after repeated failures inside one run does
    // the desktop fall back to the login screen, where signing in rewrites it.
    if (consecutiveUnreadableReads >= MAX_UNREADABLE_READS)
      return nativeAuthFailure(401, 'AUTH_SESSION_REVOKED', '系统安全存储长时间不可用');
    return nativeAuthFailure(503, 'AUTH_STORAGE_UNAVAILABLE', '系统安全存储暂不可用');
  }
  consecutiveUnreadableReads = 0;
  const refreshToken = stored.refreshToken;
  if (!refreshToken) return nativeAuthFailure(401, 'AUTH_SESSION_REVOKED', '会话不存在或已撤销');
  // Staging the replacement secret before the request makes a rotation whose
  // reply was lost resumable, instead of replaying a spent token next launch.
  const candidate = stored.pendingRefreshToken ?? newRefreshCandidate();
  if (!stored.pendingRefreshToken) {
    try {
      await saveSecureRefreshToken({ refreshToken, pendingRefreshToken: candidate });
    } catch {
      return nativeAuthFailure(503, 'AUTH_STORAGE_UNAVAILABLE', '系统安全存储不可用');
    }
  }
  const challengeResponse = await postHubJson('/auth/native/challenge', {});
  if (challengeResponse.status < 200 || challengeResponse.status >= 300)
    return nativeAuthFailure(
      challengeResponse.status || 503,
      responseString(challengeResponse.body, 'code', 'AUTH_CHALLENGE_INVALID'),
      responseString(challengeResponse.body, 'message', '原生客户端安全挑战失败'),
      responseDetails(challengeResponse.body),
    );
  const challenge = challengeResponse.body['challenge'];
  if (typeof challenge !== 'string' || !challenge)
    return nativeAuthFailure(502, 'AUTH_CHALLENGE_INVALID', '原生客户端安全挑战响应无效');
  const refreshResponse = await postHubJson('/auth/refresh', {
    refreshToken,
    nextRefreshToken: candidate,
    nativeChallenge: challenge,
  });
  if (refreshResponse.status < 200 || refreshResponse.status >= 300) {
    if (isSessionRevocation(refreshResponse.status, refreshResponse.body))
      await removeSecureRefreshToken();
    return nativeAuthFailure(
      refreshResponse.status || 503,
      responseString(refreshResponse.body, 'code', 'AUTH_SESSION_REVOKED'),
      responseString(refreshResponse.body, 'message', '会话刷新失败'),
      responseDetails(refreshResponse.body),
    );
  }
  const accessToken = refreshResponse.body['accessToken'];
  // An older Hub returns its own generated token; honour it over our candidate.
  const nextRefreshToken = responseString(refreshResponse.body, 'refreshToken', candidate);
  const user = refreshResponse.body['user'];
  const device = refreshResponse.body['device'];
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    !user ||
    typeof user !== 'object' ||
    !device ||
    typeof device !== 'object'
  )
    return nativeAuthFailure(502, 'INTERNAL_ERROR', '中枢刷新响应格式无效');
  try {
    await saveSecureRefreshToken({ refreshToken: nextRefreshToken, pendingRefreshToken: null });
  } catch {
    return nativeAuthFailure(503, 'AUTH_STORAGE_UNAVAILABLE', '系统安全存储不可用');
  }
  return {
    ok: true,
    accessToken,
    user: user as Record<string, unknown>,
    device: device as Record<string, unknown>,
  };
}

async function nativeLogout(): Promise<{ ok: true }> {
  try {
    const stored = await readSecureRefreshToken();
    const refreshToken = stored.state === 'available' ? stored.refreshToken : null;
    if (refreshToken) await postHubJson('/auth/logout', { refreshToken });
  } catch {
    /* local logout must complete even if the Hub or secure storage is unavailable */
  } finally {
    consecutiveUnreadableReads = 0;
    await removeSecureRefreshToken();
  }
  return { ok: true };
}

function readWindowState(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as Partial<WindowState>;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    return {
      x: Number.isFinite(parsed.x) ? parsed.x : undefined,
      y: Number.isFinite(parsed.y) ? parsed.y : undefined,
      width: Number.isFinite(width) ? Math.max(900, Math.round(width)) : 1280,
      height: Number.isFinite(height) ? Math.max(640, Math.round(height)) : 820,
    };
  } catch {
    return { width: 1280, height: 820 };
  }
}

function openExternal(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(parsed.toString());
  } catch {
    /* invalid external URLs are ignored */
  }
}

function registerAppProtocol(): void {
  protocol.handle('devtodo', async (request) => {
    let requestedPath: string;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      requestedPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
    const candidate = resolve(webRoot, relativePath);
    const relativeCandidate = relative(webRoot, candidate);
    if (relativeCandidate === '..' || relativeCandidate.startsWith(`..${sep}`))
      return new Response('Forbidden', { status: 403 });
    let filePath = candidate;
    if (!existsSync(filePath) && !extname(relativePath)) filePath = join(webRoot, 'index.html');
    try {
      const contents = await readFile(filePath);
      return new Response(contents, {
        headers: { 'content-type': contentType(filePath) },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function contentType(filePath: string): string {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function triggerQuickCapture(): void {
  if (!mainWindow) {
    createWindow();
    const createdWindow = mainWindow as BrowserWindow | null;
    if (!createdWindow) return;
    createdWindow.webContents.once('did-finish-load', () => {
      createdWindow.webContents.send('devtodo:quick-capture');
    });
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('devtodo:quick-capture');
}

if (singleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
  });

  app
    .whenReady()
    .then(() => {
      registerAppProtocol();
      if (process.platform === 'win32') Menu.setApplicationMenu(null);
      ipcMain.handle('devtodo:version', (event) => {
        assertIpcSender(event.sender);
        return app.getVersion();
      });
      ipcMain.handle('devtodo:theme-get', (event) => {
        assertIpcSender(event.sender);
        return getSystemTheme();
      });
      ipcMain.handle('devtodo:open-external', (event, url: unknown) => {
        assertIpcSender(event.sender);
        if (typeof url !== 'string') throw new Error('invalid request');
        openExternal(url);
        return true;
      });
      ipcMain.handle('devtodo:hub-get', (event) => {
        assertIpcSender(event.sender);
        return readConfiguredHubOrigin();
      });
      ipcMain.handle('devtodo:hub-state', (event) => {
        assertIpcSender(event.sender);
        return readConfiguredHubOriginState();
      });
      ipcMain.handle('devtodo:hub-set', async (event, value: unknown) => {
        assertIpcSender(event.sender);
        if (typeof value !== 'string') throw new Error('invalid request');
        const previous = readConfiguredHubOrigin();
        const next = saveConfiguredHubOrigin(value);
        if (previous !== next) await removeSecureRefreshToken();
        return next;
      });
      ipcMain.handle('devtodo:hub-clear', async (event) => {
        assertIpcSender(event.sender);
        await clearConfiguredHubOrigin();
        await removeSecureRefreshToken();
        return true;
      });
      ipcMain.handle('devtodo:hub-test', async (event, value: unknown) => {
        assertIpcSender(event.sender);
        if (typeof value !== 'string') throw new Error('invalid request');
        return testHubConnection(value);
      });
      ipcMain.handle('devtodo:hub-request', async (event, input: unknown) => {
        assertIpcSender(event.sender);
        return requestHub(input as HubRequestInput);
      });
      ipcMain.handle(
        'devtodo:auth-login',
        (event, username: unknown, password: unknown, deviceName: unknown) => {
          assertIpcSender(event.sender);
          if (
            typeof username !== 'string' ||
            typeof password !== 'string' ||
            typeof deviceName !== 'string'
          )
            throw new Error('invalid request');
          return nativeLogin(username, password, deviceName);
        },
      );
      ipcMain.handle('devtodo:auth-refresh', (event) => {
        assertIpcSender(event.sender);
        return nativeRefresh();
      });
      ipcMain.handle('devtodo:auth-logout', async (event) => {
        assertIpcSender(event.sender);
        return nativeLogout();
      });
      globalShortcut.register('CommandOrControl+Shift+Space', () => {
        triggerQuickCapture();
      });
      createWindow();
      if (process.env['DEVTODO_DESKTOP_SMOKE'] === '1')
        console.log('DEVTODO_DESKTOP_WINDOW_CREATED');
    })
    .catch((error: unknown) => {
      console.error('TaskDock desktop failed to start', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
} else {
  app.quit();
}
