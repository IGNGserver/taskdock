import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('devtodoDesktop', {
  version: (): Promise<string> => ipcRenderer.invoke('devtodo:version'),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('devtodo:open-external', url),
  authLogin: (
    username: string,
    password: string,
    deviceName: string,
  ): Promise<DesktopAuthResponse> =>
    ipcRenderer.invoke('devtodo:auth-login', username, password, deviceName),
  authRefresh: (): Promise<DesktopAuthResponse> => ipcRenderer.invoke('devtodo:auth-refresh'),
  authLogout: (): Promise<{ ok: true }> => ipcRenderer.invoke('devtodo:auth-logout'),
  getHubOrigin: (): Promise<string | null> => ipcRenderer.invoke('devtodo:hub-get'),
  setHubOrigin: (origin: string): Promise<string> => ipcRenderer.invoke('devtodo:hub-set', origin),
  onQuickCapture: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on('devtodo:quick-capture', handler);
    return () => ipcRenderer.removeListener('devtodo:quick-capture', handler);
  },
});

interface DesktopAuthResponse {
  ok: boolean;
  accessToken?: string;
  user?: Record<string, unknown>;
  device?: Record<string, unknown>;
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
}

declare global {
  interface Window {
    devtodoDesktop?: {
      version: () => Promise<string>;
      openExternal: (url: string) => Promise<boolean>;
      authLogin: (
        username: string,
        password: string,
        deviceName: string,
      ) => Promise<DesktopAuthResponse>;
      authRefresh: () => Promise<DesktopAuthResponse>;
      authLogout: () => Promise<{ ok: true }>;
      getHubOrigin: () => Promise<string | null>;
      setHubOrigin: (origin: string) => Promise<string>;
      onQuickCapture: (listener: () => void) => () => void;
    };
  }
}
