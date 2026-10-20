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
} from '@devtodo/contracts';
import {
  V2SyncEngine,
  createBrowserSyncId,
  type DevTodoDatabase,
  type V2SyncTransport,
} from '@devtodo/sync-client';
import {
  activateLocalCache,
  applyOfflineWrite,
  cacheMutationSideEffects,
  cacheResponse,
  localCacheGeneration,
  readCachedV2,
  readLocal,
} from './local.js';
import { recordNetworkSample } from './network-policy.js';
import { isAuthLocallyLocked } from './auth-lock.js';
import { normalizeHubOrigin } from './hub-origin.js';

/**
 * v2 is the only product protocol. `/api/v1` is retained solely for the auth,
 * bootstrap, device and legacy rollover compatibility surface that the server
 * still exposes; every product read/write goes through `/api/v2`.
 */
const API_V1_BASE = '/api/v1';
const API_V2_BASE = '/api/v2';
let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
let secureStorageSetup: Promise<void> | null = null;
let lastRefreshFailure: RefreshFailureKind | null = null;
const localRevalidations = new Map<string, Promise<unknown>>();
let mutationRevision = 0;

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

export type RefreshFailureKind = 'network' | 'revoked' | 'transient';

/** Codes that prove the stored refresh token itself is dead. */
const SESSION_REVOCATION_CODES = new Set(['AUTH_SESSION_REVOKED', 'AUTH_INVALID_CREDENTIALS']);

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export function isNativeClient(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeMobileClient(): boolean {
  return Capacitor.isNativePlatform();
}

export function getHubOrigin(): string {
  if (Capacitor.isNativePlatform()) {
    const configured = getConfiguredHubOrigin();
    if (!configured)
      throw new ApiError('HUB_NOT_CONFIGURED', '移动端尚未配置中枢地址。', null, 400);
    return configured;
  }
  if (typeof location !== 'undefined' && location.protocol !== 'file:') return location.origin;
  throw new ApiError('HUB_NOT_CONFIGURED', '无法确定中枢地址。', null, 400);
}

export function getConfiguredHubOrigin(): string | null {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const configured = localStorage.getItem('devtodo.hub-origin');
    if (!configured) return null;
    return normalizeHubOrigin(configured);
  } catch {
    return null;
  }
}

export async function loadConfiguredHubOrigin(): Promise<string | null> {
  return getConfiguredHubOrigin();
}

export async function setHubOrigin(value: string): Promise<string> {
  const origin = normalizeHubOrigin(value);
  if (!Capacitor.isNativePlatform()) throw new Error('仅原生客户端支持保存中枢地址');
  localStorage.setItem('devtodo.hub-origin', origin);
  return origin;
}

export async function clearConfiguredHubOrigin(): Promise<void> {
  try {
    localStorage.removeItem('devtodo.hub-origin');
  } catch {
    // Ignored if localStorage is unavailable.
  }
}

export async function testHubConnection(
  value: string,
  signal?: AbortSignal,
): Promise<{ initialized: boolean }> {
  const origin = normalizeHubOrigin(value);
  const response = await fetch(`${origin}${API_V1_BASE}/bootstrap/status`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`中枢返回 HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { initialized?: unknown } | null;
  if (!body || typeof body.initialized !== 'boolean') throw new Error('中枢响应格式无效');
  return { initialized: body.initialized };
}

export async function requestNativeChallenge(signal?: AbortSignal): Promise<string> {
  if (!isNativeClient()) throw new Error('仅原生客户端支持安全令牌交换');
  const response = await fetch(`${getHubOrigin()}${API_V1_BASE}/auth/native/challenge`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-Client-Id': createBrowserSyncId() },
    credentials: 'include',
    signal,
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

export async function requestV1<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
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
  apiBase = API_V1_BASE,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
    path.startsWith('/sync/') ? 60_000 : 15_000,
  );
  try {
    return await requestNetworkBound<T>(
      path,
      { ...init, signal: controller.signal },
      retry,
      previousHeaders,
      allowLocalFallback,
      apiBase,
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

async function requestNetworkBound<T>(
  path: string,
  init: RequestInit,
  retry: boolean,
  previousHeaders: Headers | undefined,
  allowLocalFallback: boolean,
  apiBase: string,
): Promise<T> {
  const generation = localCacheGeneration();
  const started = performance.now();
  const headers = new Headers(init.headers);
  if (previousHeaders) {
    for (const [key, value] of previousHeaders) headers.set(key, value);
  }
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  else headers.delete('Authorization');
  const method = (init.method ?? 'GET').toUpperCase();
  const cachePath = apiBase === API_V2_BASE ? `/v2${path}` : path;
  // Authentication and immutable bootstrap use POST without editing product
  // rows. They must not invalidate a cold page read running alongside them.
  const controlPath =
    path.startsWith('/sync/') || path.startsWith('/auth/') || path.startsWith('/bootstrap');
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !controlPath;
  const readRevision = mutationRevision;
  if (writing) mutationRevision++;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('Idempotency-Key', headers.get('Idempotency-Key') ?? uuidv7());
    headers.set('X-Client-Id', headers.get('X-Client-Id') ?? createBrowserSyncId());
  }
  let response: Response;
  try {
    response = await fetch(`${getHubOrigin()}${apiBase}${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
    if (init.signal?.aborted) throw error;
    if (isNetworkError(error)) {
      const pathname = path.split('?')[0] ?? path;
      if (
        allowLocalFallback &&
        ['GET', 'HEAD', 'OPTIONS'].includes(method) &&
        !pathname.startsWith('/sync/')
      ) {
        const localValue =
          apiBase === API_V2_BASE ? await readCachedV2(path) : await readLocal(cachePath);
        if (localValue !== undefined) return localValue as T;
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const localResult = await applyOfflineWrite(cachePath, method, init, headers);
        if (localResult) return localResult.value as T;
      }
    }
    throw error;
  }
  if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
  recordNetworkSample(performance.now() - started);
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await refreshAccessToken();
    if (refreshed)
      return requestNetwork<T>(path, init, false, headers, allowLocalFallback, apiBase);
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
    if (writing) mutationRevision++;
    await cacheMutationSideEffects(cachePath, method);
    return undefined as T;
  }
  const value = (await response.json()) as T;
  if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
  if (!writing && readRevision !== mutationRevision && !controlPath)
    throw new DOMException('读取期间数据已变化', 'AbortError');
  if (writing) mutationRevision++;
  if (!path.startsWith('/sync/')) await cacheResponse(cachePath, value);
  if (method === 'DELETE') await cacheMutationSideEffects(cachePath, method);
  return value;
}

function canReadFromLocalFirst(path: string, method: string): boolean {
  if (!['GET', 'HEAD'].includes(method)) return false;
  const pathname = path.split('?')[0] ?? path;
  const derivedRead =
    pathname === '/projects/task-counts' || pathname === '/time-points/placement-counts';
  return (
    pathname !== '/me' &&
    !pathname.startsWith('/auth/') &&
    !pathname.startsWith('/sync/') &&
    pathname !== '/bootstrap/status' &&
    !derivedRead
  );
}

export async function refreshAccessToken(signal?: AbortSignal): Promise<boolean> {
  if (isAuthLocallyLocked()) {
    lastRefreshFailure = 'revoked';
    setAccessToken(null);
    return false;
  }
  if (refreshPromise) return refreshPromise;
  const generation = localCacheGeneration();
  refreshPromise = (async () => {
    lastRefreshFailure = null;
    try {
      // Browsers keep the session in an HttpOnly cookie and have no stored
      // refresh token; only a native platform owns the credential directly.
      const ownsNativeToken = Capacitor.isNativePlatform();
      const confirmedRefreshToken = ownsNativeToken ? await readNativeRefreshToken() : null;
      if (ownsNativeToken && !confirmedRefreshToken) {
        lastRefreshFailure = 'revoked';
        setAccessToken(null);
        return false;
      }
      // The replacement secret is generated here and stored before the request,
      // so a rotation the Hub applied but whose reply was lost is resumable:
      // the retry presents the same pair instead of replaying a spent token.
      const candidate = ownsNativeToken
        ? ((await readNativePendingRefreshToken()) ?? generateRefreshCandidate())
        : null;
      if (candidate) await saveNativePendingRefreshToken(candidate);
      const nativeChallenge = isNativeClient() ? await requestNativeChallenge(signal) : undefined;
      if (generation !== localCacheGeneration() || signal?.aborted) return false;
      const result = await requestV1<{ accessToken: string; refreshToken?: string }>(
        '/auth/refresh',
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            ...(confirmedRefreshToken ? { refreshToken: confirmedRefreshToken } : {}),
            ...(candidate ? { nextRefreshToken: candidate } : {}),
            ...(nativeChallenge ? { nativeChallenge } : {}),
          }),
        },
        false,
      );
      if (generation !== localCacheGeneration() || signal?.aborted) return false;
      if (isAuthLocallyLocked()) {
        lastRefreshFailure = 'revoked';
        setAccessToken(null);
        return false;
      }
      setAccessToken(result.accessToken);
      if (ownsNativeToken && candidate) {
        // An older Hub answers with its own generated token; honour it.
        await saveNativeRefreshToken(result.refreshToken?.trim() || candidate);
        await clearNativePendingRefreshToken();
      }
      return true;
    } catch (error) {
      if (generation !== localCacheGeneration()) return false;
      lastRefreshFailure = classifyRefreshFailure(error);
      setAccessToken(null);
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/**
 * Only a session the Hub explicitly revoked or replaced may destroy a stored
 * credential. A lost native challenge, a rate limit or an unreachable Hub must
 * keep the refresh token so the next launch can retry.
 */
function classifyRefreshFailure(error: unknown): RefreshFailureKind {
  if (error instanceof ApiError)
    return SESSION_REVOCATION_CODES.has(error.code) ? 'revoked' : 'transient';
  return isNetworkError(error) ? 'network' : 'transient';
}

/**
 * True only when the Hub named the stored session itself as the problem. An
 * expired access token, a rejected native challenge or a proxy error must never
 * be read as "this device's credential is dead".
 */
export function isSessionRevocationError(error: unknown): boolean {
  return error instanceof ApiError && SESSION_REVOCATION_CODES.has(error.code);
}

export function getLastRefreshFailure(): RefreshFailureKind | null {
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

export function createSyncEngine(db: DevTodoDatabase): V2SyncEngine {
  const clientId = createBrowserSyncId();
  activateLocalCache(db, clientId);
  const generation = localCacheGeneration();
  const bound = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
    const result = await operation();
    if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
    return result;
  };
  const localDate = async () => {
    const settings = await db.settings.toCollection().first();
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: settings?.timezone ?? 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  };
  const transport: V2SyncTransport = {
    push: (body) =>
      bound(() =>
        requestV2<Awaited<ReturnType<V2SyncTransport['push']>>>('/sync/push', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    pull: (cursor, limit) =>
      bound(() =>
        requestV2<Awaited<ReturnType<V2SyncTransport['pull']>>>(
          `/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
        ),
      ),
    snapshot: () =>
      bound(() => requestV2<Awaited<ReturnType<V2SyncTransport['snapshot']>>>('/sync/snapshot')),
    preview: () =>
      bound(async () =>
        requestV2(`/sync/preview?localDate=${await localDate()}&parentFolderId=root`),
      ),
    beginBootstrap: () =>
      bound(async () =>
        requestV2('/sync/bootstrap', {
          method: 'POST',
          body: JSON.stringify({ localDate: await localDate() }),
        }),
      ),
    bootstrapPage: (id, page) =>
      bound(() => requestV2(`/sync/bootstrap/${encodeURIComponent(id)}?page=${page}`)),
  };
  return new V2SyncEngine(db, clientId, transport);
}

export async function hydrateAndSync(db: DevTodoDatabase, engine: V2SyncEngine): Promise<void> {
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
  return requestV1('/tasks', {
    method: 'POST',
    body: JSON.stringify({ ...input, priority: input.priority ?? 'NONE' }),
  });
}

export async function createDate(localDate: string): Promise<TimePointDto> {
  return requestV1('/time-points/date', { method: 'POST', body: JSON.stringify({ localDate }) });
}
export async function createEvent(title: string): Promise<TimePointDto> {
  return requestV1('/time-points/events', { method: 'POST', body: JSON.stringify({ title }) });
}
export async function addPlacement(taskId: string, timePointId: string): Promise<PlacementDto> {
  return requestV1('/placements', {
    method: 'POST',
    body: JSON.stringify({ taskId, timePointId }),
  });
}

export function websocketUrl(): string {
  const parsed = new URL(getHubOrigin());
  const base = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}${API_V2_BASE}/ws`;
  return base;
}

export async function saveNativeRefreshToken(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.set('refresh-token', token, false, false);
}

/**
 * The replacement secret a refresh call is about to offer. It is written before
 * the request so a lost reply cannot strand the client on a spent token.
 */
export async function saveNativePendingRefreshToken(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.set('pending-refresh-token', token, false, false);
}

export async function readNativePendingRefreshToken(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  await ensureNativeStorage();
  const value = await SecureStorage.get('pending-refresh-token', false, false);
  return typeof value === 'string' && value ? value : null;
}

export async function clearNativePendingRefreshToken(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.remove('pending-refresh-token', false);
}

function generateRefreshCandidate(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function clearNativeRefreshToken(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensureNativeStorage();
  await SecureStorage.remove('refresh-token', false);
  await SecureStorage.remove('pending-refresh-token', false);
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

export async function requestV2<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const localDirectoryCursor =
    path.startsWith('/tree/children?') &&
    new URLSearchParams(path.split('?')[1]).get('cursor')?.startsWith('local.');
  // Mutation previews, sync and auth must always consult the authority.
  if (method === 'GET' && !path.startsWith('/sync/') && !path.includes('delete-preview')) {
    const generation = localCacheGeneration();
    const local = await readCachedV2(path).catch(() => undefined);
    if (init.signal?.aborted) throw init.signal.reason;
    if (generation !== localCacheGeneration()) throw new DOMException('会话已变化', 'AbortError');
    if (local !== undefined) {
      const key = `${generation}:${path}`;
      if (navigator.onLine && !localDirectoryCursor && !localRevalidations.has(key)) {
        const revalidation = requestNetwork<T>(path, init, true, undefined, false, API_V2_BASE)
          .then(async () => {
            const updated = await readCachedV2(path);
            if (
              generation === localCacheGeneration() &&
              JSON.stringify(local) !== JSON.stringify(updated) &&
              typeof window !== 'undefined'
            )
              window.dispatchEvent(new Event('devtodo:data-changed'));
          })
          .catch(() => undefined)
          .finally(() => localRevalidations.delete(key));
        localRevalidations.set(key, revalidation);
      }
      return local as T;
    }
  }
  if (localDirectoryCursor)
    throw new ApiError(
      'SYNC_CURSOR_EXPIRED',
      '本地目录已变化，请重新加载后继续',
      { scope: 'directory' },
      410,
    );
  return requestNetwork<T>(path, init, true, undefined, true, API_V2_BASE);
}

export function mutationV2<T extends Record<string, unknown>>(
  method: string,
  path: string,
  body: T,
): Promise<unknown> {
  return requestV2(path, { method, body: JSON.stringify(body) });
}

export { isHttpOrigin, normalizeHubOrigin } from './hub-origin.js';

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /network|fetch|offline/i.test(error.message))
  );
}
