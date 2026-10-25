import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { readUpgradePending } from '@devtodo/sync-client';
import { Download } from 'lucide-react';
import { isNativeClient } from './api.js';
import { useAuth } from './auth.js';
import { detectStandalone } from './device.js';
import { Button, Dialog, Snackbar } from './components/m3e/index.js';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Permanent entry points are available before login and in Settings / More. */
export function PwaInstallButton() {
  const [installed, setInstalled] = useState(detectStandalone);
  useEffect(() => {
    const update = () => setInstalled(detectStandalone());
    const query = window.matchMedia('(display-mode: standalone)');
    query.addEventListener('change', update);
    const onInstalled = () => setInstalled(true);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (isNativeClient()) return null;
  return (
    <Button
      variant="outlined"
      leadingIcon={<Download size={18} />}
      onClick={() => window.dispatchEvent(new Event('taskdock:pwa-help'))}
    >
      {installed ? '应用与离线使用' : '安装 TaskDock'}
    </Button>
  );
}

export function PwaLifecycleNotice() {
  const { db, connection } = useAuth();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(detectStandalone);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const {
    needRefresh: [needRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, value) {
      registration.current = value;
    },
    onRegisterError() {
      setFeedback('离线组件暂未就绪，联网后重新打开可重试。');
    },
  });

  useEffect(() => {
    const show = () => {
      setOpen(true);
      setFeedback('');
    };
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const done = () => {
      setPrompt(null);
      setInstalled(true);
    };
    const foreground = () => {
      if (!document.hidden && navigator.onLine)
        void registration.current?.update().catch(() => undefined);
    };
    window.addEventListener('taskdock:pwa-help', show);
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', done);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.removeEventListener('taskdock:pwa-help', show);
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', done);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, []);
  useEffect(() => {
    if (!offlineReady) return;
    const timer = window.setTimeout(() => setOfflineReady(false), 5000);
    return () => window.clearTimeout(timer);
  }, [offlineReady, setOfflineReady]);

  const install = async () => {
    if (!prompt) return;
    setBusy(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setFeedback(
        choice.outcome === 'accepted'
          ? '已请求安装，可从主屏幕打开。'
          : '可稍后从浏览器菜单再次安装。',
      );
      setPrompt(null);
    } catch {
      setFeedback('请从浏览器菜单选择安装应用或添加到主屏幕。');
    } finally {
      setBusy(false);
    }
  };
  const update = async () => {
    setBusy(true);
    try {
      // Leave the user's durable offline mutations and upgrade queue in place;
      // wait for synchronization before changing the code that consumes them.
      if (
        db &&
        (connection === 'syncing' ||
          (await db.outbox.count()) > 0 ||
          (await readUpgradePending(db)).length > 0)
      ) {
        setFeedback('还有正在同步或待同步的改动。请联网完成同步后再更新，本地任务会继续保留。');
        return;
      }
      if (!window.confirm('更新会重新打开页面。请确认当前输入和设置已经保存，再继续更新。')) return;
      await updateServiceWorker(true);
    } catch {
      setFeedback('暂时无法更新，请稍后重试。当前版本仍可继续使用。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {needRefresh && !updateDismissed ? (
        <Snackbar
          message="TaskDock 有新版本可用。"
          action={{ label: '查看更新', onAction: () => setOpen(true) }}
          onDismiss={() => setUpdateDismissed(true)}
          duration={0}
        />
      ) : (
        offlineReady && (
          <Snackbar
            message="应用核心已缓存，已访问的页面可离线打开。"
            action={{ label: '知道了', onAction: () => setOfflineReady(false) }}
            onDismiss={() => setOfflineReady(false)}
            duration={5000}
          />
        )
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="安装与离线使用"
        footer={
          <Button variant="text" onClick={() => setOpen(false)}>
            完成
          </Button>
        }
      >
        <div className="pwa-help">
          {installed ? (
            <p>当前已在独立应用窗口中打开 TaskDock。</p>
          ) : (
            <>
              <p>安装后可从主屏幕打开同一个任务工作区。</p>
              {!window.isSecureContext && <p>请使用 HTTPS 地址打开，才能启用安装和离线启动。</p>}
              {prompt && (
                <Button disabled={busy} onClick={() => void install()}>
                  安装 TaskDock
                </Button>
              )}
              <p>
                iPhone / iPad：在 Safari 分享菜单选择“添加到主屏幕”，并启用“作为网页 App 打开”。
              </p>
              <p>
                安卓：在浏览器菜单查找“安装应用”或“添加到主屏幕”。Edge
                的菜单和支持程度取决于版本；没有弹出安装提示时仍可查看菜单，或用 Chrome
                打开同一地址安装。
              </p>
            </>
          )}
          <p>已保存的任务保留在本机并在联网后同步。尚未访问的页面或服务器功能可能需要联网。</p>
          {needRefresh && (
            <>
              <p>新版本已下载。请先保存当前输入；完成待同步改动后可更新并重新打开。</p>
              <Button disabled={busy} onClick={() => void update()}>
                {busy ? '正在检查' : '更新并重新打开'}
              </Button>
            </>
          )}
          {feedback && <p role="status">{feedback}</p>}
        </div>
      </Dialog>
    </>
  );
}
