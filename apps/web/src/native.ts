import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

interface NativeLifecycleOptions {
  onForeground: () => void;
  onNetworkChange: (online: boolean) => void;
}

export function installNativeLifecycle(options: NativeLifecycleOptions): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  let disposed = false;
  let removers: Array<() => void> = [];
  void Promise.all([
    App.addListener('resume', options.onForeground),
    Network.addListener('networkStatusChange', ({ connected }) =>
      options.onNetworkChange(connected),
    ),
    App.addListener('backButton', async ({ canGoBack }) => {
      const event = new CustomEvent('devtodo:native-back', {
        cancelable: true,
        detail: { canGoBack },
      });
      window.dispatchEvent(event);
      if (!event.defaultPrevented) {
        if (canGoBack) window.history.back();
        else await App.exitApp();
      }
    }),
  ]).then((handles) => {
    const nextRemovers = handles.map((handle) => () => void handle.remove());
    if (disposed) nextRemovers.forEach((remove) => remove());
    else removers = nextRemovers;
  });
  void Network.getStatus().then(({ connected }) => {
    if (!disposed) options.onNetworkChange(connected);
  });
  return () => {
    disposed = true;
    removers.forEach((remove) => remove());
  };
}
