import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaLifecycleNotice() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  if (needRefresh)
    return (
      <div className="pwa-notice" aria-live="polite">
        <span>TaskDock 有新版本可用。</span>
        <button type="button" onClick={() => void updateServiceWorker(true)}>
          立即更新
        </button>
        <button type="button" className="pwa-notice-dismiss" onClick={() => setNeedRefresh(false)}>
          稍后
        </button>
      </div>
    );

  if (offlineReady)
    return (
      <div className="pwa-notice" aria-live="polite">
        <span>应用已准备好，可在离线时打开。</span>
        <button type="button" className="pwa-notice-dismiss" onClick={() => setOfflineReady(false)}>
          知道了
        </button>
      </div>
    );

  return null;
}
