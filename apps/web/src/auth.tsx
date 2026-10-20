import type { SettingsDto, UserDto } from '@devtodo/contracts';
import type { V2SyncEngine } from '@devtodo/sync-client';
import { DevTodoDatabase } from '@devtodo/sync-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createSyncEngine,
  clearNativePendingRefreshToken,
  clearNativeRefreshToken,
  getHubOrigin,
  getAccessToken,
  getLastRefreshFailure,
  isNativeClient,
  isSessionRevocationError,
  readNativeRefreshToken,
  refreshAccessToken,
  requestV1,
  requestNativeChallenge,
  saveNativeRefreshToken,
  setAccessToken,
  websocketUrl,
  type MeResponse,
} from './api.js';
import { isAuthLocallyLocked, lockAuthLocally, unlockAuthLocally } from './auth-lock.js';
import { deactivateLocalCache } from './local.js';
import { installNativeLifecycle } from './native.js';
import { verificationInterval } from './network-policy.js';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';
export type ConnectionStatus = 'online' | 'offline' | 'syncing' | 'conflict' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  initialized: boolean;
  user: UserDto | null;
  settings: SettingsDto | null;
  db: DevTodoDatabase | null;
  engine: V2SyncEngine | null;
  connection: ConnectionStatus;
  login: (username: string, password: string, deviceName?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateSettings: (next: SettingsDto) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_NETWORK_TIMEOUT_MS = 5_000;

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException('认证请求超时', 'TimeoutError')),
    milliseconds,
  );
  try {
    return await operation(controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [initialized, setInitialized] = useState(false);
  const [user, setUser] = useState<UserDto | null>(null);
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [db, setDb] = useState<DevTodoDatabase | null>(null);
  const [engine, setEngine] = useState<V2SyncEngine | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>(
    navigator.onLine ? 'syncing' : 'offline',
  );
  const socketRef = useRef<WebSocket | null>(null);
  const socketReconnectTimerRef = useRef<number | null>(null);
  const socketReconnectAttemptRef = useRef(0);
  const socketConnectRef = useRef<(() => void) | null>(null);
  const dbRef = useRef<DevTodoDatabase | null>(null);
  const engineRef = useRef<V2SyncEngine | null>(null);
  const unsubscribeEngineRef = useRef<(() => void) | null>(null);
  const sessionGenerationRef = useRef(0);
  const authOperationRef = useRef(0);
  const localIdentityRef = useRef<string | null>(null);
  const refreshFlightRef = useRef<Promise<void> | null>(null);

  const disposeLocalSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    if (socketReconnectTimerRef.current !== null) {
      window.clearTimeout(socketReconnectTimerRef.current);
      socketReconnectTimerRef.current = null;
    }
    socketReconnectAttemptRef.current = 0;
    socketConnectRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    unsubscribeEngineRef.current?.();
    unsubscribeEngineRef.current = null;
    if (dbRef.current) {
      deactivateLocalCache(dbRef.current);
      try {
        dbRef.current.close();
      } catch {
        /* Closing an already closed local database is harmless. */
      }
    }
    dbRef.current = null;
    engineRef.current = null;
    localIdentityRef.current = null;
    setDb(null);
    setEngine(null);
  }, []);

  const initialize = useCallback(
    async (me: MeResponse, sync = true) => {
      const operation = authOperationRef.current;
      const identity = JSON.stringify([getHubOrigin(), me.user.id]);
      const currentDb = dbRef.current;
      const currentEngine = engineRef.current;
      if (localIdentityRef.current === identity && currentDb && currentEngine) {
        // Revalidating the same restored account is not an account switch.
        // Keep its DB/engine generation so in-flight page reads stay valid.
        const generation = sessionGenerationRef.current;
        await currentDb.settings.put(me.settings);
        await currentDb.syncMeta.put({ key: 'user', value: JSON.stringify(me.user) });
        if (sessionGenerationRef.current !== generation || operation !== authOperationRef.current)
          return;
        setUser(me.user);
        setSettings(me.settings);
        if (sync && navigator.onLine) {
          socketConnectRef.current?.();
          void currentEngine.sync().catch(() => undefined);
        }
        return;
      }
      disposeLocalSession();
      const generation = sessionGenerationRef.current;
      const localDb = new DevTodoDatabase(getHubOrigin(), me.user.id);
      try {
        await localDb.settings.put(me.settings);
        await localDb.syncMeta.bulkPut([
          { key: 'user', value: JSON.stringify(me.user) },
          { key: 'ownerId', value: me.user.id },
        ]);
        if (sessionGenerationRef.current !== generation || operation !== authOperationRef.current) {
          localDb.close();
          return;
        }
        try {
          localStorage.setItem('devtodo.owner-id', me.user.id);
        } catch {
          /* private browsing may disable localStorage; IndexedDB remains usable */
        }
      } catch (error) {
        deactivateLocalCache(localDb);
        try {
          localDb.close();
        } catch {
          /* Closing a partially opened local database is harmless. */
        }
        throw error;
      }

      if (navigator.storage?.persist) void navigator.storage.persist();
      const localEngine = createSyncEngine(localDb);
      const unsubscribeState = localEngine.subscribe((next) => {
        if (sessionGenerationRef.current !== generation) return;
        setConnection(next === 'idle' ? 'online' : next);
      });
      const unsubscribeData = localEngine.subscribeData(() => {
        if (sessionGenerationRef.current === generation)
          window.dispatchEvent(new Event('devtodo:data-changed'));
      });
      dbRef.current = localDb;
      engineRef.current = localEngine;
      localIdentityRef.current = identity;
      setDb(localDb);
      setEngine(localEngine);
      unsubscribeEngineRef.current = () => {
        unsubscribeState();
        unsubscribeData();
      };
      setUser(me.user);
      setSettings(me.settings);
      setStatus('authenticated');
      setInitialized(true);
      setConnection(sync && navigator.onLine ? 'syncing' : 'offline');
      socketRef.current?.close();
      socketRef.current = null;
      socketReconnectAttemptRef.current = 0;
      {
        const scheduleReconnect = (): void => {
          if (
            sessionGenerationRef.current !== generation ||
            !navigator.onLine ||
            socketReconnectTimerRef.current !== null
          )
            return;
          const attempt = Math.min(socketReconnectAttemptRef.current, 6);
          socketReconnectAttemptRef.current = Math.min(socketReconnectAttemptRef.current + 1, 7);
          const delay = Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 1_001);
          socketReconnectTimerRef.current = window.setTimeout(() => {
            socketReconnectTimerRef.current = null;
            socketConnectRef.current?.();
          }, delay);
        };
        const connectSocket = (): void => {
          if (sessionGenerationRef.current !== generation || !navigator.onLine || socketRef.current)
            return;
          try {
            const socket = new WebSocket(websocketUrl());
            socketRef.current = socket;
            socket.onopen = () => {
              socketReconnectAttemptRef.current = 0;
              const token = getAccessToken();
              if (token && socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
            };
            socket.onmessage = (event) => {
              try {
                const message = JSON.parse(String(event.data)) as { type?: string };
                if (message.type === 'sync.required')
                  void localEngine.sync().catch(() => undefined);
              } catch {
                // Malformed push data must not break the sync state machine.
              }
            };
            socket.onerror = () => {
              // close schedules the bounded reconnect; do not create a second loop.
            };
            socket.onclose = () => {
              if (socketRef.current === socket) socketRef.current = null;
              scheduleReconnect();
            };
          } catch {
            scheduleReconnect();
          }
        };
        socketConnectRef.current = connectSocket;
        if (sync && navigator.onLine) connectSocket();
      }
      if (!sync) return;
      if (navigator.onLine) void localEngine.sync().catch(() => undefined);
    },
    [disposeLocalSession],
  );

  const restoreOfflineSession = useCallback(async (): Promise<boolean> => {
    const operation = authOperationRef.current;
    let ownerId: string | null = null;
    try {
      ownerId = localStorage.getItem('devtodo.owner-id');
    } catch {
      return false;
    }
    if (!ownerId) return false;
    let localDb: DevTodoDatabase | null = null;
    try {
      localDb = new DevTodoDatabase(getHubOrigin(), ownerId);
      const [userMeta, localSettings] = await Promise.all([
        localDb.syncMeta.get('user'),
        localDb.settings.toCollection().first(),
      ]);
      if (!userMeta || !localSettings) return false;
      const localUser = JSON.parse(userMeta.value) as UserDto;
      if (localUser.id !== ownerId || !localUser.username) return false;
      if (operation !== authOperationRef.current) return false;
      await initialize(
        {
          user: localUser,
          settings: localSettings,
          capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
        },
        false,
      );
      return true;
    } catch {
      return false;
    } finally {
      try {
        localDb?.close();
      } catch {
        /* Closing a read-only recovery database is best effort. */
      }
    }
  }, [initialize]);

  const restoreAndVerifySession = useCallback(async () => {
    const operation = authOperationRef.current;
    if (isAuthLocallyLocked()) {
      try {
        setInitialized(
          (
            await withTimeout(
              (signal) => requestV1<{ initialized: boolean }>('/bootstrap/status', { signal }),
              AUTH_NETWORK_TIMEOUT_MS,
            )
          ).initialized,
        );
      } catch {
        setInitialized(false);
      }
      if (operation === authOperationRef.current) setStatus('anonymous');
      return;
    }
    // Restore IndexedDB before touching the network. This keeps a cached PWA
    // useful during a cold offline start and prevents a dead Hub from holding
    // the whole shell on the loading screen.
    const hasLocalSession = await restoreOfflineSession();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (hasLocalSession) return;
      if (operation === authOperationRef.current) {
        setInitialized(false);
        setStatus('anonymous');
      }
      return;
    }
    const refreshed = await withTimeout(
      (signal) => refreshAccessToken(signal),
      AUTH_NETWORK_TIMEOUT_MS,
    ).catch(() => false);
    if (!refreshed) {
      if (operation !== authOperationRef.current) return;
      const failure = getLastRefreshFailure();
      if (failure === 'revoked') {
        lockAuthLocally();
        await clearNativeRefreshToken().catch(() => undefined);
        try {
          localStorage.removeItem('devtodo.owner-id');
        } catch {
          /* The lock is authoritative when localStorage is available. */
        }
      } else if (hasLocalSession) {
        // An unreachable or unverified Hub must not cost the device its
        // credential; keep the workspace and let the next retry refresh.
        setConnection('offline');
        return;
      }
      if (operation !== authOperationRef.current) return;
      try {
        setInitialized(
          (
            await withTimeout(
              (signal) => requestV1<{ initialized: boolean }>('/bootstrap/status', { signal }),
              AUTH_NETWORK_TIMEOUT_MS,
            )
          ).initialized,
        );
      } catch {
        setInitialized(false);
      }
      if (operation !== authOperationRef.current) return;
      setStatus('anonymous');
      return;
    }
    if (operation !== authOperationRef.current) return;
    try {
      const me = await requestV1<MeResponse>('/me');
      if (operation !== authOperationRef.current) return;
      await initialize(me);
    } catch (cause) {
      if (operation !== authOperationRef.current) return;
      const revoked = isSessionRevocationError(cause);
      if (revoked) {
        lockAuthLocally();
        await clearNativeRefreshToken().catch(() => undefined);
        try {
          localStorage.removeItem('devtodo.owner-id');
        } catch {
          /* The local lock remains authoritative when storage is available. */
        }
      }
      if (hasLocalSession && !revoked) {
        setConnection('offline');
        return;
      }
      setAccessToken(null);
      setStatus('anonymous');
      setInitialized(false);
    }
  }, [initialize, restoreOfflineSession]);

  const refresh = useCallback(() => {
    // StrictMode setup and simultaneous foreground callbacks must share the
    // whole restore flow, not only the refresh-token HTTP exchange.
    refreshFlightRef.current ??= restoreAndVerifySession().finally(() => {
      refreshFlightRef.current = null;
    });
    return refreshFlightRef.current;
  }, [restoreAndVerifySession]);

  useEffect(() => {
    void refresh();
    const syncCurrent = () => {
      const currentEngine = engineRef.current;
      if (!currentEngine) return;
      if (!navigator.onLine) {
        setConnection('offline');
        return;
      }
      socketConnectRef.current?.();
      setConnection('syncing');
      void currentEngine.sync().catch(() => undefined);
    };
    const onOnline = () => syncCurrent();
    const onOffline = () => setConnection('offline');
    const onFocus = () => {
      if (!document.hidden) syncCurrent();
    };
    const removeNativeLifecycle = installNativeLifecycle({
      onForeground: () => syncCurrent(),
      onNetworkChange: (online) => {
        if (online) syncCurrent();
        else setConnection('offline');
      },
    });
    window.addEventListener('online', onOnline);
    window.addEventListener('devtodo:outbox-changed', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    let lastVerification = 0;
    const timer = window.setInterval(() => {
      if (document.hidden || Date.now() - lastVerification < verificationInterval()) return;
      lastVerification = Date.now();
      syncCurrent();
    }, 10_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('devtodo:outbox-changed', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(timer);
      removeNativeLifecycle();
      if (socketReconnectTimerRef.current !== null) {
        window.clearTimeout(socketReconnectTimerRef.current);
        socketReconnectTimerRef.current = null;
      }
      socketConnectRef.current = null;
      socketRef.current?.close();
    };
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string, deviceName?: string) => {
      authOperationRef.current += 1;
      const nativeChallenge = isNativeClient() ? await requestNativeChallenge() : undefined;
      const result = await requestV1<{
        accessToken: string;
        refreshToken?: string;
        user: UserDto;
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          deviceName: deviceName ?? '浏览器',
          platform: 'web',
          ...(nativeChallenge ? { nativeChallenge } : {}),
        }),
      });
      unlockAuthLocally();
      setAccessToken(result.accessToken);
      if (isNativeClient() && !result.refreshToken)
        throw new Error('native refresh token was not returned');
      if (isNativeClient() && result.refreshToken) {
        await saveNativeRefreshToken(result.refreshToken);
        await clearNativePendingRefreshToken();
      }
      await initialize(await requestV1<MeResponse>('/me'));
    },
    [initialize],
  );

  const logout = useCallback(async () => {
    authOperationRef.current += 1;
    lockAuthLocally();
    const nativeRefreshToken = await readNativeRefreshToken().catch(() => null);
    await requestV1('/auth/logout', {
      method: 'POST',
      body: JSON.stringify(nativeRefreshToken ? { refreshToken: nativeRefreshToken } : {}),
    }).catch(() => undefined);
    try {
      await clearNativeRefreshToken();
    } catch {
      /* token cleanup failure must not leave the UI in an authenticated state */
    }
    disposeLocalSession();
    try {
      localStorage.removeItem('devtodo.owner-id');
    } catch {
      /* The owner marker is only a convenience; the per-owner database remains locked by logout. */
    }
    setAccessToken(null);
    setUser(null);
    setSettings(null);
    setDb(null);
    setEngine(null);
    setStatus('anonymous');
  }, [disposeLocalSession]);
  const updateSettings = useCallback((next: SettingsDto) => setSettings(next), []);

  const value = useMemo(
    () => ({
      status,
      initialized,
      user,
      settings,
      db,
      engine,
      connection,
      login,
      logout,
      refresh,
      updateSettings,
    }),
    [
      status,
      initialized,
      user,
      settings,
      db,
      engine,
      connection,
      login,
      logout,
      refresh,
      updateSettings,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
