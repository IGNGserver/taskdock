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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHubOrigin, validateHubRequest, type HubRequestInput } from './hub-policy.js';

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
  return theme === 'dark' ? '#11141a' : '#f5f6f8';
}

function themeTitleBar(theme: SystemTheme): { color: string; symbolColor: string } {
  return theme === 'dark'
    ? { color: '#171b23', symbolColor: '#eef2f7' }
    : { color: '#f5f6f8', symbolColor: '#1f2430' };
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
  try {
    const parsed = JSON.parse(readFileSync(hubOriginFile(), 'utf8')) as { origin?: unknown };
    return typeof parsed.origin === 'string' ? parseHubOrigin(parsed.origin) : null;
  } catch {
    return null;
  }
}

function saveConfiguredHubOrigin(value: string): string {
  const origin = parseHubOrigin(value);
  if (!origin) throw new Error('Hub origin must be a valid HTTP or HTTPS URL without credentials');
  writeFileSync(hubOriginFile(), JSON.stringify({ origin }), { mode: 0o600 });
  return origin;
}

function removeConfiguredHubOrigin(): void {
  try {
    unlinkSync(hubOriginFile());
  } catch {
    /* an absent origin file is already the desired state */
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

async function saveSecureRefreshToken(token: string): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(token);
      const payload = Buffer.concat([SECURE_TOKEN_MAGIC_SAFE, encrypted]);
      await writeFile(secureFile(), payload, { mode: 0o600 });
      return;
    } catch {
      // safeStorage failed despite being available, fallback to restricted file
    }
  }
  const payload = Buffer.concat([SECURE_TOKEN_MAGIC_PLAIN, Buffer.from(token, 'utf8')]);
  await writeFile(secureFile(), payload, { mode: 0o600 });
}

async function readSecureRefreshToken(): Promise<string | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(secureFile());
  } catch {
    return null;
  }
  if (fileBuffer.length < 4) return null;

  const magic = fileBuffer.subarray(0, 4);
  const data = fileBuffer.subarray(4);

  if (magic.equals(SECURE_TOKEN_MAGIC_SAFE)) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(data);
    } catch {
      return null;
    }
  }

  if (magic.equals(SECURE_TOKEN_MAGIC_PLAIN)) {
    return data.toString('utf8');
  }

  // Backward compatibility with legacy tokens saved directly as safeStorage ciphertext
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(fileBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

async function removeSecureRefreshToken(): Promise<void> {
  try {
    await unlink(secureFile());
  } catch {
    /* an absent token is already the desired state */
  }
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
    await saveSecureRefreshToken(refreshToken);
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
  let refreshToken: string | null;
  try {
    refreshToken = await readSecureRefreshToken();
  } catch {
    return nativeAuthFailure(503, 'AUTH_STORAGE_UNAVAILABLE', '系统安全存储不可用');
  }
  if (!refreshToken) return nativeAuthFailure(401, 'AUTH_SESSION_REVOKED', '会话不存在或已撤销');
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
  const refreshResponse = await postHubJson('/auth/refresh', {
    refreshToken,
    nativeChallenge: challenge,
  });
  if (refreshResponse.status < 200 || refreshResponse.status >= 300) {
    if (refreshResponse.status === 401) await removeSecureRefreshToken();
    return nativeAuthFailure(
      refreshResponse.status || 503,
      responseString(refreshResponse.body, 'code', 'AUTH_REQUIRED'),
      responseString(refreshResponse.body, 'message', '会话刷新失败'),
      responseDetails(refreshResponse.body),
    );
  }
  const accessToken = refreshResponse.body['accessToken'];
  const nextRefreshToken = refreshResponse.body['refreshToken'];
  const user = refreshResponse.body['user'];
  const device = refreshResponse.body['device'];
  if (
    typeof accessToken !== 'string' ||
    typeof nextRefreshToken !== 'string' ||
    !user ||
    typeof user !== 'object' ||
    !device ||
    typeof device !== 'object'
  )
    return nativeAuthFailure(502, 'INTERNAL_ERROR', '中枢刷新响应格式无效');
  try {
    await saveSecureRefreshToken(nextRefreshToken);
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
    const refreshToken = await readSecureRefreshToken();
    if (refreshToken) await postHubJson('/auth/logout', { refreshToken });
  } catch {
    /* local logout must complete even if the Hub or secure storage is unavailable */
  } finally {
    await removeSecureRefreshToken();
    removeConfiguredHubOrigin();
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
      ipcMain.handle('devtodo:hub-set', async (event, value: unknown) => {
        assertIpcSender(event.sender);
        if (typeof value !== 'string') throw new Error('invalid request');
        const previous = readConfiguredHubOrigin();
        const next = saveConfiguredHubOrigin(value);
        if (previous !== next) await removeSecureRefreshToken();
        return next;
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
