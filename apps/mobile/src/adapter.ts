import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

export interface MobileLifecycleAdapter {
  onForeground(callback: () => void): () => void;
  onNetworkChange(callback: (online: boolean) => void): () => void;
  onBack(callback: () => Promise<boolean>): () => void;
  openExternal(url: string): Promise<void>;
  saveRefreshToken(token: string): Promise<void>;
  readRefreshToken(): Promise<string | null>;
}

const refreshTokenKey = 'refresh-token';
let secureStorageSetup: Promise<void> | null = null;

/** Capacitor integration boundary. The web app owns data semantics and calls this adapter. */
export function createMobileAdapter(): MobileLifecycleAdapter {
  return {
    onForeground(callback) {
      let disposed = false;
      let remove: (() => void) | null = null;
      void App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) callback();
      }).then((handle) => {
        if (disposed) void handle.remove();
        else remove = () => void handle.remove();
      });
      return () => {
        disposed = true;
        remove?.();
      };
    },
    onNetworkChange(callback) {
      let disposed = false;
      let remove: (() => void) | null = null;
      void Network.addListener('networkStatusChange', ({ connected }) => callback(connected)).then(
        (handle) => {
          if (disposed) void handle.remove();
          else remove = () => void handle.remove();
        },
      );
      void Network.getStatus().then(({ connected }) => {
        if (!disposed) callback(connected);
      });
      return () => {
        disposed = true;
        remove?.();
      };
    },
    onBack(callback) {
      let disposed = false;
      let remove: (() => void) | null = null;
      void App.addListener('backButton', async () => {
        if (disposed) return;
        if (!(await callback())) await App.exitApp();
      }).then((handle) => {
        if (disposed) void handle.remove();
        else remove = () => void handle.remove();
      });
      return () => {
        disposed = true;
        remove?.();
      };
    },
    async openExternal(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('only HTTPS links are allowed');
      if (Capacitor.isNativePlatform()) await Browser.open({ url: parsed.toString() });
      else window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    },
    async saveRefreshToken(token) {
      await ensureSecureStorage();
      await SecureStorage.set(refreshTokenKey, token, false, false);
    },
    async readRefreshToken() {
      await ensureSecureStorage();
      const value = await SecureStorage.get(refreshTokenKey, false, false);
      return typeof value === 'string' ? value : null;
    },
  };
}

async function ensureSecureStorage(): Promise<void> {
  if (!Capacitor.isNativePlatform())
    throw new Error('refresh token secure storage is available only in the native app');
  secureStorageSetup ??= SecureStorage.setKeyPrefix('devtodo_');
  await secureStorageSetup;
}
