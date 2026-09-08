import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';
import { uuidv7 } from '@devtodo/contracts';
import type {
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TaskDto,
  TimePointDto,
  UserDto,
  DeviceDto,
} from '@devtodo/contracts';
import {
  SyncEngine,
  createBrowserSyncId,
  type DevTodoDatabase,
  type SyncTransport,
} from '@devtodo/sync-client';
import {
  activateLocalCache,
  applyOfflineWrite,
  cacheMutationSideEffects,
  cacheResponse,
  readLocal,
} from './local.js';
import { isAuthLocallyLocked } from './auth-lock.js';

const API_BASE = '/api/v1';
let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
let secureStorageSetup: Promise<void> | null = null;
let runtimeHubOrigin: string | null = null;
let lastRefreshFailure: 'network' | 'unauthorized' | 'unknown' | null = null;
const localRevalidations = new Map<string, Promise<unknown>>();

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface MeResponse {
  user: UserDto;
  settings: SettingsDto;
  capabilities: { syncProtocolVersion: number; websocket: boolean; offline: boolean };
}
export interface TaskDetails {
  task: TaskDto;
  note: NoteDto;
  placements: PlacementDto[];
}
export interface SearchItem {
  task: TaskDto;
  project: ProjectDto | null;
  note: NoteDto;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export function isNativeClient(): boolean {
  return Capacitor.isNativePlatform() || Boolean(desktopBridge());
}

export function isDesktopClient(): boolean {
  return Boolean(desktopBridge());
}

export function isNativeMobileClient(): boolean {
  return Capacitor.isNativePlatform();
}

export function getHubOrigin(): string {
  if (Capacitor.isNativePlatform()) {
    const configured = getConfiguredHubOrigin();
    if (!configured) throw new Error('移动端未配置中枢地址');
    return configured;
  }
  if (location.protocol !== 'file:' && location.protocol !== 'devtodo:') return location.origin;
  const configured =
    runtimeHubOrigin ?? new URLSearchParams(location.search).get('hubOrigin') ?? undefined;
  if (!configured) throw new Error('桌面端未配置中枢地址');
  const parsed = new URL(configured);
  if (parsed.protocol !== 'https:' && !isLocalDevelopmentOrigin(parsed))
    throw new Error('桌面端中枢地址必须使用 HTTPS');
  return parsed.origin;
}

export function getConfiguredHubOrigin(): string | null {
  if (desktopBridge()) {
    const configured = runtimeHubOrigin ?? new URLSearchParams(location.search).get('hubOrigin');
    if (!configured) return null;
    try {
      return normalizeHubOrigin(configured);
    } catch {
      return null;
    }
  }
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const configured = localStorage.getItem('devtodo.hub-origin');
    if (!configured) return null;
    return normalizeHubOrigin(configured);
  } catch {
    return null;
  }
}

export async function setHubOrigin(value: string): Promise<string> {
  const origin = normalizeHubOrigin(value);
  const desktop = desktopBridge();
  if (desktop) {
    await desktop.setHubOrigin(origin);
    runtimeHubOrigin = origin;
    if (typeof window !== 'undefined' && window.location.protocol === 'devtodo:') {
      try {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('hubOrigin', origin);
        window.history.replaceState(null, '', nextUrl);
      } catch {
        // The persisted main-process setting remains authoritative if history is unavailable.
      }
    }
    return origin;
  }
  if (!Capacitor.isNativePlatform()) throw new Error('仅原生客户端支持保存中枢地址');
  localStorage.setItem('devtodo.hub-origin', origin);
  return origin;
}

export async function testHubConnection(
  value: string,
  signal?: AbortSignal,
): Promise<{ initialized: boolean }> {
  const origin = normalizeHubOrigin(value);
  const response = await fetch(`${origin}${API_BASE}/bootstrap/status`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`中枢返回 HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { initialized?: unknown } | null;
  if (!body || typeof body.initialized !== 'boolean') throw new Error('中枢响应格式无效');
  return { initialized: body.initialized };
}

export async function requestNativeChallenge(): Promise<string> {
  if (!isNativeClient()) throw new Error('仅原生客户端支持安全令牌交换');
  const response = await fetch(`${getHubOrigin()}${API_BASE}/auth/native/challenge`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  const body = (await response.json().catch(() => ({}))) as {
    challenge?: unknown;
    code?: string;
    message?: string;
    details?: unknown;
  };
  if (!response.ok)
    throw new ApiError(
      body.code ?? 'AUTH_REQUIRED',
      body.message ?? '原生客户端安全挑战失败',
      body.details,
      response.status,
    );
  if (typeof body.challenge !== 'string') throw new Error('原生客户端安全挑战响应无效');
  return body.challenge;
}

export async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (canReadFromLocalFirst(path, method)) {
    const localValue = await readLocal(path).catch(() => undefined);
    if (localValue !== undefined) {
      if (!localRevalidations.has(path)) {
        const localSnapshot = JSON.stringify(localValue);
        const revalidation = requestNetwork<T>(path, init, retry)
          .then((freshValue) => {
            if (JSON.stringify(freshValue) !== localSnapshot && typeof window !== 'undefined')
              window.dispatchEvent(new Event('devtodo:data-changed'));
            return freshValue;
          })
          .catch(() => undefined)
          .finally(() => localRevalidations.delete(path));
        localRevalidations.set(path, revalidation);
      }
      return localValue as T;
    }
  }
  return requestNetwork<T>(path, init, retry);
}

export async function requestAll<T>(path: string): Promise<T[]> {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('limit', '500');
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    if (cursor) params.set('cursor', cursor);
    else params.delete('cursor');
    const suffix = params.toString();
    const response = await requestNetwork<{ items?: unknown; nextCursor?: string | null }>(
      `${pathname}${suffix ? `?${suffix}` : ''}`,
      {},
      true,
      undefined,
      page === 0,
    );
    if (!Array.isArray(response.items)) throw new Error('分页响应格式无效');
    items.push(...(response.items as T[]));
    const next = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    if (!next || next === cursor) return items;
    cursor = next;
  }
  throw new Error('分页响应超过安全上限');
}

async function requestNetwork<T>(
  path: string,
  init: RequestInit,
  retry: boolean,
  previousHeaders?: Headers,
  allowLocalFallback = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (previousHeaders) {
    for (const [key, value] of previousHeaders) headers.set(key, value);
  }
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  else headers.delete('Authorization');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('Idempotency-Key', headers.get('Idempotency-Key') ?? uuidv7());
    headers.set('X-Client-Id', headers.get('X-Client-Id') ?? createBrowserSyncId());
  }
  let response: Response;
  try {
    response = await fetch(`${getHubOrigin()}${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    if (isNetworkError(error)) {
      const pathname = path.split('?')[0] ?? path;
      if (
        allowLocalFallback &&
        ['GET', 'HEAD', 'OPTIONS'].includes(method) &&
        !pathname.startsWith('/sync/')
      ) {
        const localValue = await readLocal(path);
        if (localValue !== undefined) return localValue as T;
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const localResult = await applyOfflineWrite(path, method, init, headers);
        if (localResult) return localResult.value as T;
      }
    }
    throw error;
  }
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return requestNetwork<T>(path, init, false, headers, allowLocalFallback);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      details?: unknown;
    };
    throw new ApiError(
      body.code ?? 'INTERNAL_ERROR',
      body.message ?? '请求失败',
      body.details,
      response.status,
    );
  }
  if (response.status === 204) {
    await cacheMutationSideEffects(path, method);
    return undefined as T;
  }
  const value = (await response.json()) as T;
  await cacheResponse(path, value);
  return value;
}

function canReadFromLocalFirst(path: string, method: string): boolean {
  if (!['GET', 'HEAD'].includes(method)) return false;
  const pathname = path.split('?')[0] ?? path;
  return (
    pathname !== '/me' &&
    !pathname.startsWith('/auth/') &&
    !pathname.startsWith('/sync/') &&
    pathname !== '/bootstrap/status'
  );
}

export async function refreshAccessToken(): Promise<boolean> {
  if (isAuthLocallyLocked()) {
    lastRefreshFailure = 'unauthorized';
    setAccessToken(null);
    return false;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    lastRefreshFailure = null;
    try {
      if (isDesktopClient()) {
        const result = await desktopAuthRefresh();
        if (isAuthLocallyLocked()) {
          lastRefreshFailure = 'unauthorized';
          setAccessToken(null);
          return false;
        }
        setAccessToken(result.accessToken);
        return true;
      }
      const nativeRefreshToken = await readNativeRefreshToken();
      const nativeChallenge = isNativeClient() ? await requestNativeChallenge() : undefined;
      const result = await request<{ accessToken: string; refreshToken?: string }>(
        '/auth/refresh',
        {
          method: 'POST',
          body: JSON.stringify({
            ...(nativeRefreshToken ? { refreshToken: nativeRefreshToken } : {}),
            ...(nativeChallenge ? { nativeChallenge } : {}),
          }),
        },
        false,
      );
      if (isAuthLocallyLocked()) {
        lastRefreshFailure = 'unauthorized';
        setAccessToken(null);
        return false;
      }
      setAccessToken(result.accessToken);
      if (isNativeClient()) {
        if (!result.refreshToken) throw new Error('native refresh token was not returned');
        await saveNativeRefreshToken(result.refreshToken);
      }
      return true;
    } catch (error) {
      lastRefreshFailure =
        error instanceof ApiError && error.status === 401
          ? 'unauthorized'
          : isNetworkError(error)
            ? 'network'
            : 'unknown';
      setAccessToken(null);
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function getLastRefreshFailure(): 'network' | 'unauthorized' | 'unknown' | null {
  return lastRefreshFailure;
}

export async function cacheSnapshot(
  db: DevTodoDatabase,
  snapshot: {
    projects: ProjectDto[];
    tasks: TaskDto[];
    notes: NoteDto[];
    timePoints: TimePointDto[];
    placements: PlacementDto[];
    settings: SettingsDto;
    cursor: string;
  },
): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.tasks, db.notes, db.timePoints, db.placements, db.settings, db.syncMeta],
    async () => {
      await Promise.all([
        db.projects.bulkPut(snapshot.projects),
        db.tasks.bulkPut(snapshot.tasks),
        db.notes.bulkPut(snapshot.notes),
        db.timePoints.bulkPut(snapshot.timePoints),
        db.placements.bulkPut(snapshot.placements),
        db.settings.put(snapshot.settings),
      ]);
      await db.syncMeta.put({ key: 'cursor', value: snapshot.cursor });
    },
  );
}

export function createSyncEngine(db: DevTodoDatabase): SyncEngine {
  const clientId = createBrowserSyncId();
  activateLocalCache(db, clientId);
  const transport: SyncTransport = {
    push: (body) =>
      request<Awaited<ReturnType<SyncTransport['push']>>>('/sync/push', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    pull: (cursor, limit) =>
      request<Awaited<ReturnType<SyncTransport['pull']>>>(
        `/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
      ),
    snapshot: async () => {
      const snapshot = await request<{
        projects: ProjectDto[];
        tasks: TaskDto[];
        notes: NoteDto[];
        timePoints: TimePointDto[];
        placements: PlacementDto[];
        settings: SettingsDto;
        cursor: string;
      }>('/sync/snapshot');
      return snapshot;
    },
  };
  return new SyncEngine(db, clientId, transport);
}

export async function hydrateAndSync(db: DevTodoDatabase, engine: SyncEngine): Promise<void> {
  try {
    await engine.sync();
  } catch {
    /* UI keeps local data and exposes offline state. */
  }
}

export async function createTask(input: {
  projectId: string | null;
  category: 'FEATURE' | 'MISC';
  title: string;
  priority?: string;
}): Promise<TaskDto> {
  return request('/tasks', {
    method: 'POST',
    body: JSON.stringify({ ...input, priority: input.priority ?? 'NONE' }),
  });
}

export async function createDate(localDate: string): Promise<TimePointDto> {
  return request('/time-points/date', { method: 'POST', body: JSON.stringify({ localDate }) });
}
export async function createEvent(title: string): Promise<TimePointDto> {
  return request('/time-points/events', { method: 'POST', body: JSON.stringify({ title }) });
}
export async function addPlacement(taskId: string, timePointId: string): Promise<PlacementDto> {
  return request('/placements', { method: 'POST', body: JSON.stringify({ taskId, timePointId }) });
}

export function websocketUrl(): string {
  const parsed = new URL(getHubOrigin());
  const base = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}${API_BASE}/ws`;
  return base;
}

export async function saveNativeRefreshToken(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.set('refresh-token', token, false, false);
}

export async function clearNativeRefreshToken(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.remove('refresh-token', false);
}

export async function readNativeRefreshToken(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  await ensureNativeStorage();
  const value = await SecureStorage.get('refresh-token', false, false);
  return typeof value === 'string' ? value : null;
}

async function ensureNativeStorage(): Promise<void> {
  if (!isNativeClient()) return;
  secureStorageSetup ??= SecureStorage.setKeyPrefix('devtodo_');
  await secureStorageSetup;
}

export function mutation<T extends Record<string, unknown>>(
  method: string,
  path: string,
  body: T,
): Promise<unknown> {
  return request(path, { method, body: JSON.stringify(body) });
}

export { API_BASE };

function normalizeHubOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('中枢地址不是有效 URL');
  }
  if (parsed.protocol !== 'https:' && !isLocalDevelopmentOrigin(parsed))
    throw new Error('中枢地址必须使用 HTTPS；开发环境仅允许 localhost HTTP');
  return parsed.origin;
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /network|fetch|offline/i.test(error.message))
  );
}

function isLocalDevelopmentOrigin(value: URL): boolean {
  return (
    value.protocol === 'http:' && (value.hostname === 'localhost' || value.hostname === '127.0.0.1')
  );
}

interface DesktopBridge {
  authLogin: (
    username: string,
    password: string,
    deviceName: string,
  ) => Promise<DesktopAuthResponse>;
  authRefresh: () => Promise<DesktopAuthResponse>;
  authLogout: () => Promise<{ ok: true }>;
  getHubOrigin: () => Promise<string | null>;
  setHubOrigin: (origin: string) => Promise<string>;
}

interface DesktopAuthSuccess {
  ok: true;
  accessToken: string;
  user: UserDto;
  device: DeviceDto;
}

interface DesktopAuthFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

type DesktopAuthResponse = DesktopAuthSuccess | DesktopAuthFailure;

export async function desktopAuthLogin(
  username: string,
  password: string,
  deviceName: string,
): Promise<DesktopAuthSuccess> {
  const desktop = desktopBridge();
  if (!desktop) throw new ApiError('AUTH_REQUIRED', '桌面安全通道不可用', null, 503);
  const result = await desktop.authLogin(username, password, deviceName);
  if (!result.ok)
    throw new ApiError(result.code, result.message, result.details ?? null, result.status);
  return result;
}

export async function desktopAuthRefresh(): Promise<DesktopAuthSuccess> {
  const desktop = desktopBridge();
  if (!desktop) throw new ApiError('AUTH_REQUIRED', '桌面安全通道不可用', null, 503);
  const result = await desktop.authRefresh();
  if (!result.ok)
    throw new ApiError(result.code, result.message, result.details ?? null, result.status);
  return result;
}

export async function desktopAuthLogout(): Promise<void> {
  const desktop = desktopBridge();
  if (!desktop) return;
  await desktop.authLogout();
}

function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { devtodoDesktop?: DesktopBridge }).devtodoDesktop;
}
