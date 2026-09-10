import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('devtodoDesktop', {
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke('devtodo:version'),
  getSystemTheme: (): Promise<'light' | 'dark'> => ipcRenderer.invoke('devtodo:theme-get'),
  onSystemThemeChanged: (listener: (theme: 'light' | 'dark') => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => listener(theme);
    ipcRenderer.on('devtodo:theme-changed', handler);
    return () => ipcRenderer.removeListener('devtodo:theme-changed', handler);
  },
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
  testHubConnection: (origin: string): Promise<{ initialized: boolean }> =>
    ipcRenderer.invoke('devtodo:hub-test', origin),
  request: (input: DesktopHubRequest): Promise<DesktopHubResponse> =>
    ipcRenderer.invoke('devtodo:hub-request', input),
  onQuickCapture: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on('devtodo:quick-capture', handler);
    return () => ipcRenderer.removeListener('devtodo:quick-capture', handler);
  },
});

interface DesktopHubRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface DesktopHubResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface DesktopAuthSuccess {
  ok: true;
  accessToken: string;
  user: Record<string, unknown>;
  device: Record<string, unknown>;
}

interface DesktopAuthFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

type DesktopAuthResponse = DesktopAuthSuccess | DesktopAuthFailure;
