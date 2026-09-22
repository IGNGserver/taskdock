import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { Snackbar } from './components/m3e/index.js';

/**
 * Service-worker feedback is deliberately a Snackbar: it is transient global
 * state, not page content. This keeps refresh/offline affordances consistent
 * with the rest of the M3 Expressive feedback model.
 */
export function PwaLifecycleNotice() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!offlineReady) return;
    const timer = window.setTimeout(() => setOfflineReady(false), 5000);
    return () => window.clearTimeout(timer);
  }, [offlineReady, setOfflineReady]);

  if (needRefresh)
    return (
      <Snackbar
        message="TaskDock 有新版本可用。"
        action={{ label: '立即更新', onAction: () => void updateServiceWorker(true) }}
        onDismiss={() => setNeedRefresh(false)}
        duration={0}
      />
    );

  if (offlineReady)
    return (
      <Snackbar
        message="应用已准备好，可在离线时打开。"
        action={{ label: '知道了', onAction: () => setOfflineReady(false) }}
        onDismiss={() => setOfflineReady(false)}
        duration={5000}
      />
    );

  return null;
}
