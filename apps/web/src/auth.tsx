import type { SettingsDto, UserDto } from '@devtodo/contracts';
import type { SyncEngine } from '@devtodo/sync-client';
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
  ApiError,
  createSyncEngine,
  clearNativeRefreshToken,
  desktopAuthLogin,
  desktopAuthLogout,
  getHubOrigin,
  getAccessToken,
  getLastRefreshFailure,
  isNativeClient,
  isDesktopClient,
  readNativeRefreshToken,
  refreshAccessToken,
  request,
  requestNativeChallenge,
  saveNativeRefreshToken,
  setAccessToken,
  websocketUrl,
  type MeResponse,
} from './api.js';
import { isAuthLocallyLocked, lockAuthLocally, unlockAuthLocally } from './auth-lock.js';
import { deactivateLocalCache } from './local.js';
import { installNativeLifecycle } from './native.js';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';
export type ConnectionStatus = 'online' | 'offline' | 'syncing' | 'conflict' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  initialized: boolean;
  user: UserDto | null;
  settings: SettingsDto | null;
  db: DevTodoDatabase | null;
  engine: SyncEngine | null;
  connection: ConnectionStatus;
  login: (username: string, password: string, deviceName?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateSettings: (next: SettingsDto) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [initialized, setInitialized] = useState(false);
  const [user, setUser] = useState<UserDto | null>(null);
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [db, setDb] = useState<DevTodoDatabase | null>(null);
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>(
    navigator.onLine ? 'online' : 'offline',
  );
  const socketRef = useRef<WebSocket | null>(null);
  const dbRef = useRef<DevTodoDatabase | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const authOperationRef = useRef(0);

  const initialize = useCallback(async (me: MeResponse, sync = true) => {
    setUser(me.user);
    setSettings(me.settings);
    setStatus('authenticated');
    setInitialized(true);
    if (navigator.storage?.persist) void navigator.storage.persist();
    const localDb = new DevTodoDatabase(getHubOrigin(), me.user.id);
    await localDb.settings.put(me.settings);
    await localDb.syncMeta.bulkPut([
      { key: 'user', value: JSON.stringify(me.user) },
      { key: 'ownerId', value: me.user.id },
    ]);
    try {
      localStorage.setItem('devtodo.owner-id', me.user.id);
    } catch {
      /* private browsing may disable localStorage; IndexedDB remains usable */
    }
    const localEngine = createSyncEngine(localDb);
    localEngine.subscribe((next) => {
      setConnection(next === 'idle' ? 'online' : next);
      if (next === 'idle' || next === 'conflict' || next === 'error')
        window.dispatchEvent(new Event('devtodo:data-changed'));
    });
    dbRef.current = localDb;
    engineRef.current = localEngine;
    setDb(localDb);
    setEngine(localEngine);
    if (!sync) {
      setConnection('offline');
      return;
    }
    if (navigator.onLine) void localEngine.sync().catch(() => undefined);
    socketRef.current?.close();
    if (isDesktopClient()) return;
    try {
      const socket = new WebSocket(websocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        const token = getAccessToken();
        if (token) socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'sync.required') void localEngine.sync().catch(() => undefined);
      };
      socket.onclose = () => {
        socketRef.current = null;
      };
    } catch {
      /* polling and online/focus events remain the fallback */
    }
  }, []);

  const restoreOfflineSession = useCallback(async (): Promise<boolean> => {
    let ownerId: string | null = null;
    try {
      ownerId = localStorage.getItem('devtodo.owner-id');
    } catch {
      return false;
    }
    if (!ownerId) return false;
    try {
      const localDb = new DevTodoDatabase(getHubOrigin(), ownerId);
      const [userMeta, localSettings] = await Promise.all([
        localDb.syncMeta.get('user'),
        localDb.settings.toCollection().first(),
      ]);
      if (!userMeta || !localSettings) return false;
      const localUser = JSON.parse(userMeta.value) as UserDto;
      if (localUser.id !== ownerId || !localUser.username) return false;
      await initialize(
        {
          user: localUser,
          settings: localSettings,
          capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
        },
        false,
      );
      return true;
    } catch {
      return false;
    }
  }, [initialize]);

  const refresh = useCallback(async () => {
    const operation = authOperationRef.current;
    if (isAuthLocallyLocked()) {
      try {
        setInitialized((await request<{ initialized: boolean }>('/bootstrap/status')).initialized);
      } catch {
        setInitialized(false);
      }
      if (operation === authOperationRef.current) setStatus('anonymous');
      return;
    }
    if (!(await refreshAccessToken())) {
      if (operation !== authOperationRef.current) return;
      const failure = getLastRefreshFailure();
      if (failure === 'unauthorized') {
        lockAuthLocally();
        await clearNativeRefreshToken().catch(() => undefined);
        try {
          localStorage.removeItem('devtodo.owner-id');
        } catch {
          /* The lock is authoritative when localStorage is available. */
        }
      }
      if (
        (failure === 'network' || (typeof navigator !== 'undefined' && !navigator.onLine)) &&
        (await restoreOfflineSession())
      )
        return;
      if (operation !== authOperationRef.current) return;
      try {
        setInitialized((await request<{ initialized: boolean }>('/bootstrap/status')).initialized);
      } catch {
        setInitialized(false);
      }
      if (operation !== authOperationRef.current) return;
      setStatus('anonymous');
      return;
    }
    if (operation !== authOperationRef.current) return;
    try {
      const me = await request<MeResponse>('/me');
      if (operation !== authOperationRef.current) return;
      await initialize(me);
    } catch (cause) {
      if (operation !== authOperationRef.current) return;
      if (cause instanceof ApiError && cause.status === 401) {
        lockAuthLocally();
        await clearNativeRefreshToken().catch(() => undefined);
        try {
          localStorage.removeItem('devtodo.owner-id');
        } catch {
          /* The local lock remains authoritative when storage is available. */
        }
      }
      setAccessToken(null);
      setStatus('anonymous');
      setInitialized(false);
    }
  }, [initialize, restoreOfflineSession]);

  useEffect(() => {
    void refresh();
    const onOnline = () => {
      setConnection('online');
      void engineRef.current?.sync().catch(() => undefined);
    };
    const onOffline = () => setConnection('offline');
    const onFocus = () => {
      if (navigator.onLine) void engineRef.current?.sync().catch(() => undefined);
    };
    const removeNativeLifecycle = installNativeLifecycle({
      onForeground: () => void engineRef.current?.sync().catch(() => undefined),
      onNetworkChange: (online) => {
        setConnection(online ? 'online' : 'offline');
        if (online) void engineRef.current?.sync().catch(() => undefined);
      },
    });
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (navigator.onLine) void engineRef.current?.sync().catch(() => undefined);
    }, 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
      removeNativeLifecycle();
      socketRef.current?.close();
    };
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string, deviceName?: string) => {
      authOperationRef.current += 1;
      if (isDesktopClient()) {
        const result = await desktopAuthLogin(username, password, deviceName ?? '桌面端');
        unlockAuthLocally();
        setAccessToken(result.accessToken);
        await initialize(await request<MeResponse>('/me'));
        return;
      }
      const nativeChallenge = isNativeClient() ? await requestNativeChallenge() : undefined;
      const result = await request<{
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
      if (isNativeClient() && result.refreshToken)
        await saveNativeRefreshToken(result.refreshToken);
      await initialize(await request<MeResponse>('/me'));
    },
    [initialize],
  );

  const logout = useCallback(async () => {
    authOperationRef.current += 1;
    lockAuthLocally();
    if (isDesktopClient()) {
      await desktopAuthLogout().catch(() => undefined);
    } else {
      const nativeRefreshToken = await readNativeRefreshToken().catch(() => null);
      await request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify(nativeRefreshToken ? { refreshToken: nativeRefreshToken } : {}),
      }).catch(() => undefined);
    }
    socketRef.current?.close();
    try {
      await clearNativeRefreshToken();
    } catch {
      /* token cleanup failure must not leave the UI in an authenticated state */
    }
    if (dbRef.current) {
      deactivateLocalCache(dbRef.current);
      try {
        dbRef.current.close();
      } catch {
        /* closing an already closed local database is harmless */
      }
    }
    try {
      localStorage.removeItem('devtodo.owner-id');
    } catch {
      /* The owner marker is only a convenience; the per-owner database remains locked by logout. */
    }
    dbRef.current = null;
    engineRef.current = null;
    setAccessToken(null);
    setUser(null);
    setSettings(null);
    setDb(null);
    setEngine(null);
    setStatus('anonymous');
  }, []);
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
