import type {
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TaskDto,
  TimePointDto,
} from '@devtodo/contracts';
import {
  isMergeableConflictCommand,
  type ConflictRecord,
  type OutboxItem,
} from '@devtodo/sync-client';
import {
  Archive,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  Command,
  Copy,
  FolderKanban,
  Inbox,
  LayoutList,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Target,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import {
  ApiError,
  addPlacement,
  createDate,
  createEvent,
  createTask,
  getConfiguredHubOrigin,
  isDesktopClient,
  isDesktopShell,
  isNativeClient,
  isNativeMobileClient,
  isWindowsDesktop,
  loadConfiguredHubOrigin,
  normalizeHubOrigin,
  mutation,
  request,
  requestAll,
  setHubOrigin,
  testHubConnection,
} from './api.js';
import { useAuth } from './auth.js';
import { M3Button, M3Chip, M3IconButton, M3SegmentedControl } from './components/m3.js';
import { nextTaskStatus, reorderIds, taskStatusActionLabel } from './task-behavior.js';

type PlacementWithTask = { id: string; task: TaskDto };
type PresenceState = 'entering' | 'present' | 'exiting';

function usePresence(open: boolean, exitDuration = 220) {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? 'present' : 'exiting');
  const duration =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 1
      : exitDuration;

  useEffect(() => {
    let frame = 0;
    let timer: number | undefined;
    if (open) {
      setMounted(true);
      setState('entering');
      frame = window.requestAnimationFrame(() => setState('present'));
    } else if (mounted) {
      setState('exiting');
      timer = window.setTimeout(() => setMounted(false), duration);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [duration, mounted, open]);

  return { mounted, state };
}

export function App() {
  const auth = useAuth();
  const desktopShell = isDesktopShell();
  const content =
    desktopShell && !isDesktopClient() ? (
      <DesktopBridgeUnavailableScreen />
    ) : desktopShell ? (
      <DesktopStartup />
    ) : auth.status === 'loading' ? (
      <LoadingScreen label="正在打开本地工作区" />
    ) : auth.status === 'anonymous' ? (
      <LoginScreen initialized={auth.initialized} />
    ) : (
      <AuthenticatedApp />
    );
  return <DesktopChrome>{content}</DesktopChrome>;
}

function DesktopChrome({ children }: { children: ReactNode }) {
  const windowsDesktop = isWindowsDesktop();
  if (!windowsDesktop) return children;
  return (
    <div className="desktop-app-shell">
      <div className="desktop-window-drag-region" aria-hidden="true" />
      {children}
    </div>
  );
}

type DesktopStartupPhase = 'checking' | 'setup' | 'waiting' | 'ready' | 'error';

function DesktopBridgeUnavailableScreen() {
  return (
    <main className="auth-page hub-setup-page">
      <div className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">D</span>
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">DESKTOP RUNTIME</p>
        <h1>桌面安全通道未加载</h1>
        <p className="auth-intro">
          当前窗口是桌面客户端，但安全桥接没有启动，因此无法读取或保存中枢地址。
        </p>
        <div className="form-error" role="alert">
          请完全退出 TaskDock 后重试；如果问题持续，请重新安装最新桌面版本。
        </div>
        <button
          type="button"
          className="primary-button wide"
          onClick={() => window.location.reload()}
        >
          重新加载客户端
        </button>
      </div>
      <aside className="auth-aside">
        <span className="aside-number">00</span>
        <p>先恢复连接，再开始工作。</p>
        <span className="aside-rule" />
        <small>桌面端不会在桥接缺失时回退到网页登录，避免错误地使用错误的中枢会话。</small>
      </aside>
    </main>
  );
}

function DesktopStartup() {
  const auth = useAuth();
  const [origin, setOrigin] = useState<string | null>(null);
  const [phase, setPhase] = useState<DesktopStartupPhase>('checking');
  const [message, setMessage] = useState('');

  const verify = useCallback(async (candidate: string) => {
    setPhase('checking');
    setMessage('正在连接中枢…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const status = await testHubConnection(candidate, controller.signal);
      setPhase(status.initialized ? 'ready' : 'waiting');
      setMessage('');
    } catch (cause) {
      setPhase('error');
      setMessage(
        cause instanceof DOMException && cause.name === 'AbortError'
          ? '连接超时，请检查地址、证书和网络。'
          : cause instanceof Error
            ? cause.message
            : '无法连接中枢，请检查地址、证书和网络。',
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadConfiguredHubOrigin().then((initialOrigin) => {
      if (!active) return;
      setOrigin(initialOrigin);
      if (initialOrigin) void verify(initialOrigin);
      else setPhase('setup');
    });
    return () => {
      active = false;
    };
  }, [verify]);

  const handleConnected = useCallback((nextOrigin: string, initialized: boolean) => {
    setOrigin(nextOrigin);
    setMessage('');
    setPhase(initialized ? 'ready' : 'waiting');
  }, []);
  const handleChangeOrigin = useCallback(() => {
    setPhase('setup');
    setMessage('');
  }, []);
  const prepareSwitch = useCallback(
    async (nextOrigin: string) => {
      const currentOrigin = getConfiguredHubOrigin();
      if (currentOrigin && currentOrigin !== nextOrigin) await auth.logout();
    },
    [auth],
  );

  if (phase === 'setup')
    return (
      <HubSetupScreen
        initialOrigin={origin ?? ''}
        errorMessage={message}
        onConnected={handleConnected}
        beforeSave={prepareSwitch}
      />
    );
  if (phase === 'checking') return <LoadingScreen label="正在连接中枢" />;
  if (phase === 'error')
    return (
      <HubSetupScreen
        initialOrigin={origin ?? ''}
        errorMessage={message}
        onConnected={handleConnected}
        beforeSave={prepareSwitch}
      />
    );
  if (phase === 'waiting')
    return (
      <HubWaitingScreen
        origin={origin ?? ''}
        onRetry={() => origin && void verify(origin)}
        onChangeOrigin={handleChangeOrigin}
      />
    );
  if (auth.status === 'loading') return <LoadingScreen label="正在打开本地工作区" />;
  if (auth.status === 'anonymous')
    return <LoginScreen initialized onChangeHub={handleChangeOrigin} />;
  return <AuthenticatedApp />;
}

function HubSetupScreen({
  initialOrigin,
  errorMessage,
  onConnected,
  beforeSave,
}: {
  initialOrigin: string;
  errorMessage: string;
  onConnected: (origin: string, initialized: boolean) => void;
  beforeSave?: (origin: string) => Promise<void>;
}) {
  const [origin, setOrigin] = useState(initialOrigin);
  const [state, setState] = useState<'idle' | 'checking' | 'error'>('idle');
  const [message, setMessage] = useState(errorMessage);

  useEffect(() => setMessage(errorMessage), [errorMessage]);

  const connect = async () => {
    if (state === 'checking' || !origin.trim()) return;
    setState('checking');
    setMessage('正在测试连接…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const normalized = normalizeHubOrigin(origin);
      const status = await testHubConnection(normalized, controller.signal);
      await beforeSave?.(normalized);
      const saved = await setHubOrigin(normalized);
      onConnected(saved, status.initialized);
    } catch (cause) {
      setState('error');
      setMessage(
        cause instanceof DOMException && cause.name === 'AbortError'
          ? '连接超时，请检查地址、证书和网络。'
          : cause instanceof Error
            ? cause.message
            : '无法连接中枢，请检查地址、证书和网络。',
      );
    } finally {
      window.clearTimeout(timeout);
    }
  };

  return (
    <main className="auth-page hub-setup-page">
      <div className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">D</span>
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">DESKTOP CONNECTION</p>
        <h1>{initialOrigin ? '连接中枢' : '配置中枢地址'}</h1>
        <p className="auth-intro">
          桌面端不会默认绑定网页地址。先连接你的自托管中枢，之后登录、同步和离线数据都会跟随这个地址隔离。
        </p>
        {message && (
          <div className={`${state === 'error' ? 'form-error' : 'bootstrap-notice'}`} role="status">
            {message}
          </div>
        )}
        {isHttpOrigin(origin) && (
          <div className="http-security-warning" role="alert">
            <strong>当前地址使用 HTTP</strong>
            <span>
              HTTP 地址可以连接外网中枢，但密码和会话信息会明文传输；正式公网部署仍建议使用 HTTPS。
            </span>
          </div>
        )}
        <div className="stack-form">
          <Field
            label="中枢 HTTP/HTTPS 地址"
            value={origin}
            onChange={(value) => {
              setOrigin(value);
              setState('idle');
              setMessage('');
            }}
            type="url"
            autoComplete="url"
            autoFocus={!initialOrigin}
          />
          <p className="field-help">
            例如 https://todo.example.com、http://47.95.17.77:48731 或 http://localhost:3000。HTTP
            地址会显示安全提示。
          </p>
          <button
            type="button"
            className="primary-button wide"
            onClick={() => void connect()}
            disabled={state === 'checking' || !origin.trim()}
          >
            {state === 'checking' ? <LoaderCircle className="spin" size={17} /> : '测试并连接'}
          </button>
        </div>
      </div>
      <aside className="auth-aside">
        <span className="aside-number">01</span>
        <p>先连接，再安排。</p>
        <span className="aside-rule" />
        <small>中枢地址是桌面端的运行边界，切换地址不会串用另一套会话。</small>
      </aside>
    </main>
  );
}

function HubWaitingScreen({
  origin,
  onRetry,
  onChangeOrigin,
}: {
  origin: string;
  onRetry: () => void;
  onChangeOrigin: () => void;
}) {
  return (
    <main className="auth-page hub-setup-page">
      <div className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">D</span>
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">DESKTOP CONNECTION</p>
        <h1>等待中枢初始化</h1>
        <p className="auth-intro">已连接到中枢，但部署者还没有完成首次 Owner 初始化。</p>
        <div className="bootstrap-notice" role="status">
          <strong>请先完成中枢部署</strong>
          <span>
            初始化令牌只在部署中枢时使用。请让部署者在服务器端完成首次 Owner
            初始化，完成后点击重试即可登录。
          </span>
        </div>
        <div className="hub-origin-card">
          <span>当前中枢</span>
          <code>{origin}</code>
        </div>
        <div className="hub-check-row">
          <button type="button" className="primary-button" onClick={onRetry}>
            重新检查
          </button>
          <button type="button" className="secondary-button" onClick={onChangeOrigin}>
            更换中枢
          </button>
        </div>
      </div>
      <aside className="auth-aside">
        <span className="aside-number">02</span>
        <p>部署完成，再开始。</p>
        <span className="aside-rule" />
        <small>桌面端不会代替部署者创建 Owner，初始化仍由中枢服务端负责。</small>
      </aside>
    </main>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  const location = useLocation();
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickKind, setQuickKind] = useState<'task' | 'project' | 'event'>('task');
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileActionOpen, setMobileActionOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useSearchParams();
  const recentProjectId =
    auth.settings?.defaultCaptureTarget === 'RECENT_CONTEXT'
      ? (/^\/projects\/([^/]+)/.exec(location.pathname)?.[1] ?? null)
      : null;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === 'Escape') {
        setCommandOpen(false);
        setQuickOpen(false);
        setMobileActionOpen(false);
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const openTask = useCallback(
    (taskId: string) => {
      const next = new URLSearchParams(selectedTask);
      next.set('task', taskId);
      setSelectedTask(next);
    },
    [selectedTask, setSelectedTask],
  );
  const closeTask = useCallback(() => {
    const next = new URLSearchParams(selectedTask);
    next.delete('task');
    setSelectedTask(next);
  }, [selectedTask, setSelectedTask]);

  useEffect(() => {
    const listener = (event: Event) => {
      if (commandOpen) setCommandOpen(false);
      else if (quickOpen) setQuickOpen(false);
      else if (mobileActionOpen) setMobileActionOpen(false);
      else if (selectedTask.get('task')) closeTask();
      else if (mobileSidebarOpen) setMobileSidebarOpen(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener('devtodo:native-back', listener);
    return () => window.removeEventListener('devtodo:native-back', listener);
  }, [closeTask, commandOpen, mobileActionOpen, mobileSidebarOpen, quickOpen, selectedTask]);
  const navItems = useMemo(
    () => [
      { to: '/today', label: '今日', icon: Target },
      { to: '/inbox', label: '收集箱', icon: Inbox },
      { to: '/tasks', label: '任务库', icon: LayoutList },
      { to: '/time/calendar', label: '日历', icon: CalendarDays },
      { to: '/time/events', label: '时间点', icon: Clock3 },
    ],
    [],
  );
  const mobileNavItems = useMemo(
    () => [
      { to: '/today', label: '今日', icon: Target },
      { to: '/inbox', label: '收集箱', icon: Inbox },
      { to: '/projects', label: '项目', icon: FolderKanban },
      { to: '/time', label: '时间', icon: Clock3 },
      { to: '/more', label: '更多', icon: MoreHorizontal },
    ],
    [],
  );
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">D</span>
          <span>TaskDock</span>
        </div>
        <nav aria-label="主导航" className="primary-nav">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavItem key={to} to={to} label={label} icon={<Icon size={17} />} />
          ))}
        </nav>
        <div className="nav-section-label">项目</div>
        <ProjectNav />
        <nav aria-label="更多导航" className="secondary-nav">
          <NavItem to="/archive" label="归档" icon={<Archive size={17} />} />
          <NavItem to="/settings" label="设置" icon={<Settings size={17} />} />
        </nav>
        <div className="sidebar-bottom">
          <ConnectionStatus />
          <button className="user-chip" onClick={() => void auth.logout()} title="退出当前设备">
            <span className="avatar">{auth.user?.username?.slice(0, 1).toUpperCase() ?? '?'}</span>
            <span className="user-name">{auth.user?.username}</span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="打开侧边栏"
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">{breadcrumb(location.pathname)}</div>
          <button
            className="command-trigger"
            aria-label="搜索任务和备注"
            onClick={() => setCommandOpen(true)}
          >
            <Search size={16} />
            <span>搜索任务、备注…</span>
            <kbd>⌘ K</kbd>
          </button>
          <ConnectionStatus />
          <M3Button
            className="quick-button"
            leadingIcon={<Plus size={17} />}
            aria-label="快速添加"
            onClick={() => {
              setQuickKind('task');
              setQuickOpen(true);
            }}
          >
            快速添加
          </M3Button>
        </header>
        <div className="page-wrap">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage onOpenTask={openTask} />} />
            <Route path="/tasks" element={<TasksPage onOpenTask={openTask} />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectPage onOpenTask={openTask} />} />
            <Route path="/inbox" element={<InboxPage onOpenTask={openTask} />} />
            <Route path="/misc" element={<Navigate to="/inbox" replace />} />
            <Route path="/time" element={<TimeHubPage />} />
            <Route path="/time/calendar" element={<CalendarPage onOpenTask={openTask} />} />
            <Route
              path="/time/calendar/:localDate"
              element={<CalendarPage onOpenTask={openTask} />}
            />
            <Route path="/time/events" element={<EventsPage />} />
            <Route path="/time/events/:eventId" element={<EventPage onOpenTask={openTask} />} />
            <Route path="/archive" element={<ArchivePage onOpenTask={openTask} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/more" element={<MorePage onOpenSearch={() => setCommandOpen(true)} />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </div>
      </main>
      <MobileSidebar
        open={mobileSidebarOpen}
        navItems={navItems}
        onClose={() => setMobileSidebarOpen(false)}
      />
      <nav className="mobile-bottom-nav" aria-label="移动导航">
        {mobileNavItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `mobile-nav-link ${isActive ? 'active' : ''}`}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <button
        className="mobile-fab"
        aria-label="打开创建菜单"
        onClick={() => setMobileActionOpen(true)}
      >
        <Plus size={23} />
      </button>
      <MobileActionSheet
        open={mobileActionOpen}
        onClose={() => setMobileActionOpen(false)}
        onSelect={(kind) => {
          setMobileActionOpen(false);
          setQuickKind(kind);
          setQuickOpen(true);
        }}
      />
      <QuickCaptureDialog
        open={quickOpen}
        initialKind={quickKind}
        defaultTaskProjectId={recentProjectId}
        placeTaskOnToday={location.pathname === '/today'}
        onClose={() => setQuickOpen(false)}
      />
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenTask={(id) => {
          setCommandOpen(false);
          openTask(id);
        }}
        onQuickCapture={(kind) => {
          setCommandOpen(false);
          setQuickKind(kind);
          setQuickOpen(true);
        }}
      />
      <TaskDetail
        taskId={selectedTask.get('task')}
        onClose={closeTask}
        onChanged={() => window.dispatchEvent(new Event('devtodo:data-changed'))}
      />
    </div>
  );
}

function LoginScreen({
  initialized,
  onChangeHub,
}: {
  initialized: boolean;
  onChangeHub?: () => void;
}) {
  const auth = useAuth();
  const nativeClient = isNativeClient();
  const mobileClient = isNativeMobileClient();
  const desktopClient = isDesktopClient();
  const [hubInitialized, setHubInitialized] = useState(initialized);
  const [hubOrigin, setHubOriginValue] = useState(getConfiguredHubOrigin() ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hubCheck, setHubCheck] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [hubCheckMessage, setHubCheckMessage] = useState('');

  useEffect(() => setHubInitialized(initialized), [initialized]);

  const checkHub = async (): Promise<boolean | null> => {
    if (!mobileClient || hubCheck === 'checking' || !hubOrigin.trim()) return null;
    setError('');
    setHubCheck('checking');
    setHubCheckMessage('正在测试连接…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const status = await testHubConnection(hubOrigin, controller.signal);
      await setHubOrigin(hubOrigin);
      setHubCheck('success');
      setHubInitialized(status.initialized);
      setHubCheckMessage(
        status.initialized ? '连接成功 · Owner 已初始化' : '连接成功 · 等待部署者初始化',
      );
      return status.initialized;
    } catch (cause) {
      setHubCheck('error');
      setHubCheckMessage(
        cause instanceof DOMException && cause.name === 'AbortError'
          ? '连接超时，请检查地址、证书和网络'
          : cause instanceof Error
            ? cause.message
            : '无法连接中枢，请检查地址、证书和网络',
      );
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      let nextInitialized = hubInitialized;
      if (mobileClient) {
        const configured = getConfiguredHubOrigin();
        if (!configured || configured !== normalizeHubOrigin(hubOrigin)) {
          const checked = await checkHub();
          if (checked === null) return;
          nextInitialized = checked;
        }
      }
      if (!nextInitialized) {
        setError('中枢尚未完成初始化，请先在部署中枢时完成 Owner 初始化。');
        return;
      }
      await auth.login(username, password, desktopClient ? '桌面端' : '浏览器');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败，请检查网络和输入');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">D</span>
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">PERSONAL DEV WORKSPACE</p>
        <h1>{hubInitialized ? '欢迎回来' : '等待中枢初始化'}</h1>
        <p className="auth-intro">一个任务本体，多处安排。离线时也能继续捕获和整理。</p>
        {desktopClient && onChangeHub && (
          <div className="hub-origin-card login-hub-origin">
            <span>当前中枢</span>
            <code>{hubOrigin}</code>
            <button type="button" className="text-button" onClick={onChangeHub}>
              更换中枢
            </button>
          </div>
        )}
        {!hubInitialized && (
          <div className="bootstrap-notice" role="status">
            <strong>请先完成中枢部署</strong>
            <span>
              初始化令牌只在部署中枢时使用。请让部署者在服务器端完成首次 Owner
              初始化，完成后刷新此页面即可登录。
            </span>
          </div>
        )}
        {isHttpOrigin(nativeClient ? hubOrigin : window.location.origin) && (
          <div className="http-security-warning" role="alert">
            <strong>当前使用 HTTP</strong>
            <span>密码和会话信息会以明文传输，请确认网络可信；正式公网部署仍建议使用 HTTPS。</span>
          </div>
        )}
        <form onSubmit={submit} className="stack-form">
          {mobileClient && (
            <>
              <Field
                label="中枢 HTTP/HTTPS 地址"
                value={hubOrigin}
                onChange={(value) => {
                  setHubOriginValue(value);
                  setHubCheck('idle');
                  setHubCheckMessage('');
                }}
                type="url"
                autoComplete="url"
              />
              <div className="hub-check-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void checkHub()}
                  disabled={busy || hubCheck === 'checking' || !hubOrigin.trim()}
                >
                  {hubCheck === 'checking' ? '测试中…' : '测试连接'}
                </button>
                {hubCheckMessage && (
                  <span className={`hub-check-message ${hubCheck}`} role="status">
                    {hubCheckMessage}
                  </span>
                )}
              </div>
              <p className="field-help">
                首次使用先填写自托管中枢地址，例如 https://todo.example.com；也支持外网或内网
                http:// 地址，但密码和会话信息会明文传输。
              </p>
            </>
          )}
          <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" />
          <Field
            label="密码"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="current-password"
          />
          <p className="field-help">
            密码为至少 6 位；可以直接使用 6 位纯数字。浏览器会用安全 Cookie 保持会话。
          </p>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          <button className="primary-button wide" disabled={busy || !hubInitialized}>
            {busy ? <LoaderCircle className="spin" size={17} /> : '登录'}
          </button>
        </form>
      </div>
      <aside className="auth-aside">
        <span className="aside-number">01</span>
        <p>先捕获，再安排。</p>
        <span className="aside-rule" />
        <small>Task 与 Placement 分离，今天、明天和事件共享同一个真实状态。</small>
      </aside>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        required
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        data-modal-autofocus={autoFocus ? 'true' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NavItem({
  to,
  label,
  icon,
  onClick,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function MobileSidebar({
  open,
  navItems,
  onClose,
}: {
  open: boolean;
  navItems: Array<{ to: string; label: string; icon: typeof Target }>;
  onClose: () => void;
}) {
  const presence = usePresence(open);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, [open]);
  if (!presence.mounted) return null;
  const interactive = presence.state !== 'exiting';
  return (
    <div className={`mobile-sidebar-layer presence-${presence.state}`} aria-hidden={!interactive}>
      <button
        className="mobile-sidebar-backdrop"
        aria-label="关闭侧边栏"
        tabIndex={interactive ? 0 : -1}
        onClick={onClose}
      />
      <aside className="mobile-sidebar" aria-label="移动侧边栏">
        <header className="mobile-sidebar-header">
          <div className="brand">
            <span className="brand-mark">D</span>
            <span>TaskDock</span>
          </div>
          <button
            ref={closeRef}
            className="sidebar-close"
            aria-label="关闭侧边栏"
            onClick={onClose}
            tabIndex={interactive ? 0 : -1}
          >
            <X size={19} />
          </button>
        </header>
        <nav aria-label="移动主导航" className="primary-nav">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavItem key={to} to={to} label={label} icon={<Icon size={17} />} onClick={onClose} />
          ))}
        </nav>
        <div className="nav-section-label">项目</div>
        <ProjectNav onNavigate={onClose} />
        <nav aria-label="移动更多导航" className="secondary-nav">
          <NavItem to="/archive" label="归档" icon={<Archive size={17} />} onClick={onClose} />
          <NavItem to="/settings" label="设置" icon={<Settings size={17} />} onClick={onClose} />
        </nav>
      </aside>
    </div>
  );
}

function MobileActionSheet({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (kind: 'task' | 'project' | 'event') => void;
}) {
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  const actions = [
    {
      kind: 'task' as const,
      label: '新建任务',
      description: '先记下下一步，再决定安排在哪里。',
      icon: Check,
    },
    {
      kind: 'project' as const,
      label: '新建项目',
      description: '建立一个新的开发工作区。',
      icon: FolderKanban,
    },
    {
      kind: 'event' as const,
      label: '新建时间点',
      description: '创建一个可反复安排任务的事件节点。',
      icon: Clock3,
    },
  ];
  return (
    <Modal title="创建" onClose={onClose} state={presence.state}>
      <div className="mobile-action-sheet">
        {actions.map(({ kind, label, description, icon: Icon }) => (
          <button key={kind} className="mobile-action-item" onClick={() => onSelect(kind)}>
            <span className="mobile-action-icon">
              <Icon size={18} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

function TimeHubPage() {
  const { settings } = useAuth();
  const localDate = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  return (
    <div className="page">
      <PageHeader
        eyebrow="TIME"
        title="时间"
        description="日期和自定义时间点都是安排位置；任务本体不会因为换了时间而复制。"
      />
      <div className="more-grid time-hub-grid">
        <NavLink to={`/time/calendar/${localDate}`} className="more-link-card">
          <span className="more-link-icon">
            <CalendarDays size={18} />
          </span>
          <span>
            <strong>日期日历</strong>
            <small>按月查看每日安排，今天是 {localDate}。</small>
          </span>
          <ChevronRight size={16} />
        </NavLink>
        <NavLink to="/time/events" className="more-link-card">
          <span className="more-link-icon">
            <Clock3 size={18} />
          </span>
          <span>
            <strong>自定义时间点</strong>
            <small>管理事件节点、到达状态和其中的任务安排。</small>
          </span>
          <ChevronRight size={16} />
        </NavLink>
      </div>
    </div>
  );
}

function MorePage({ onOpenSearch }: { onOpenSearch: () => void }) {
  const links = [
    { to: '/tasks', label: '任务库', description: '浏览和整理完整任务库。', icon: LayoutList },
    {
      to: '/inbox',
      label: '收集箱',
      description: '先收集不属于具体项目的任务，再决定何时安排。',
      icon: Inbox,
    },
    {
      to: '/archive',
      label: '归档',
      description: '恢复已归档的项目、任务和时间点。',
      icon: Archive,
    },
    {
      to: '/settings',
      label: '设置',
      description: '调整时区、默认捕获位置和设备会话。',
      icon: Settings,
    },
  ];
  return (
    <div className="page">
      <PageHeader
        eyebrow="MORE"
        title="更多"
        description="次要入口集中在这里，底部导航保持专注于今天、项目和时间。"
      />
      <button className="more-search-button" onClick={onOpenSearch}>
        <Search size={17} />
        搜索任务、备注和引用 ID
      </button>
      <div className="more-grid">
        {links.map(({ to, label, description, icon: Icon }) => (
          <NavLink key={to} to={to} className="more-link-card">
            <span className="more-link-icon">
              <Icon size={18} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <ChevronRight size={16} />
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function ProjectNav({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const reload = useCallback(() => {
    void requestAll<ProjectDto>('/projects')
      .then((result) => setProjects(result))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener('devtodo:data-changed', reload);
    return () => window.removeEventListener('devtodo:data-changed', reload);
  }, [reload]);
  return (
    <div className="project-nav">
      {projects.slice(0, 6).map((project) => (
        <NavLink
          key={project.id}
          to={`/projects/${project.id}`}
          onClick={onNavigate}
          className={({ isActive }) => `project-nav-item ${isActive ? 'active' : ''}`}
        >
          <span className="project-dot" />
          {project.name}
          <span className="nav-prefix">{project.taskPrefix}</span>
        </NavLink>
      ))}
      <NavLink to="/projects" onClick={onNavigate} className="nav-item nav-create">
        <Plus size={16} />
        <span>新建项目</span>
      </NavLink>
    </div>
  );
}

function ConnectionStatus() {
  const { connection } = useAuth();
  const config = {
    online: ['在线', 'status-online'],
    offline: ['离线 · 本地可用', 'status-offline'],
    syncing: ['同步中', 'status-syncing'],
    conflict: ['有待处理冲突', 'status-conflict'],
    error: ['同步失败', 'status-error'],
  } as const;
  const [label, className] = config[connection];
  return (
    <div className={`connection-status ${className}`}>
      <span className="status-dot" />
      {label}
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="loading-screen">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <div className="page-header-line">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="inline-error">
      <span>{error}</span>
      <button className="text-button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function useReloadable<T>(loader: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loader());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [loader]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [reload]);
  return { data, setData, loading, error, reload };
}

function QuickCapture({
  projectId = null,
  category = 'MISC',
  onCreated,
}: {
  projectId?: string | null;
  category?: 'FEATURE' | 'MISC';
  onCreated?: (task: TaskDto) => Promise<void> | void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const task = await createTask({ projectId, category, title: title.trim() });
      setTitle('');
      await onCreated?.(task);
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建任务失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="quick-capture" onSubmit={submit}>
      <Plus size={17} />
      <input
        aria-label="快速创建任务"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={category === 'FEATURE' ? '添加一个功能任务…' : '现在要记下什么？'}
      />
      <kbd aria-hidden="true">↵</kbd>
      {error && (
        <span className="capture-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function QuickCaptureDialog({
  open,
  initialKind = 'task',
  defaultTaskProjectId,
  placeTaskOnToday = false,
  onClose,
}: {
  open: boolean;
  initialKind?: 'task' | 'project' | 'event';
  defaultTaskProjectId?: string | null;
  placeTaskOnToday?: boolean;
  onClose: () => void;
}) {
  const { settings } = useAuth();
  const [kind, setKind] = useState<'task' | 'project' | 'event'>(initialKind);
  const [title, setTitle] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setTitle('');
      setPrefix('');
      setError('');
    }
  }, [initialKind, open]);
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'task') {
        const task = await createTask({
          projectId: defaultTaskProjectId ?? null,
          category: 'MISC',
          title,
        });
        if (placeTaskOnToday) {
          const point = await createDate(todayInTimezone(settings?.timezone ?? 'Asia/Shanghai'));
          await addPlacement(task.id, point.id);
        }
      }
      if (kind === 'event') await createEvent(title);
      if (kind === 'project')
        await request('/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: title,
            taskPrefix:
              prefix ||
              title
                .replace(/[^A-Za-z0-9]/g, '')
                .slice(0, 8)
                .toUpperCase() ||
              'WORK',
          }),
        });
      window.dispatchEvent(new Event('devtodo:data-changed'));
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="快速添加" onClose={onClose} state={presence.state}>
      <M3SegmentedControl
        label="创建类型"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'task', label: '任务' },
          { value: 'project', label: '项目' },
          { value: 'event', label: '时间点' },
        ]}
      />
      <form onSubmit={submit} className="stack-form">
        <Field
          label={kind === 'task' ? '任务标题' : kind === 'project' ? '项目名称' : '时间点名称'}
          value={title}
          onChange={setTitle}
          autoComplete="off"
          autoFocus
        />
        {kind === 'task' && (
          <p className="field-help">
            {placeTaskOnToday
              ? defaultTaskProjectId
                ? '将创建到当前项目的杂项分组，并同时安排到今天。任务本体仍只保留一份。'
                : '将创建到全局杂项，并同时安排到今天。任务本体仍只保留一份。'
              : defaultTaskProjectId
                ? '将创建到当前项目的杂项分组。之后可以从任务行安排日期或时间点。'
                : '将创建到全局杂项。之后可以从任务行安排日期或时间点。'}
          </p>
        )}
        {kind === 'project' && (
          <Field label="项目代号" value={prefix} onChange={setPrefix} autoComplete="off" />
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button wide" disabled={busy || !title.trim()}>
          {busy ? '保存中…' : '创建'}
        </button>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
  state = 'present',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  state?: PresenceState;
}) {
  const interactive = state !== 'exiting';
  const modalRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal || !interactive) return;
    const focusToRestore = previousFocus.current;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    const first = modal.querySelector<HTMLElement>('[data-modal-autofocus]') ?? focusable()[0];
    first?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const firstElement = elements[0]!;
      const lastElement = elements[elements.length - 1]!;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    modal.addEventListener('keydown', onKeyDown);
    return () => {
      modal.removeEventListener('keydown', onKeyDown);
      focusToRestore?.focus();
    };
  }, [interactive, onClose]);
  return (
    <div
      className={`modal-layer presence-${state}`}
      aria-hidden={!interactive}
      role="presentation"
      onMouseDown={(event) => {
        if (interactive && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`modal presence-${state}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function CommandPalette({
  open,
  onClose,
  onOpenTask,
  onQuickCapture,
}: {
  open: boolean;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onQuickCapture: (kind: 'task' | 'project' | 'event') => void;
}) {
  const navigate = useNavigate();
  const { settings } = useAuth();
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [items, setItems] = useState<Array<{ task: TaskDto; project: ProjectDto | null }>>([]);
  const [actionError, setActionError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const presence = usePresence(open);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIncludeArchived(false);
    setActionError('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    if (!query.trim()) {
      setItems([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void request<{ items: Array<{ task: TaskDto; project: ProjectDto | null }> }>(
        `/search/tasks?q=${encodeURIComponent(query)}${includeArchived ? '&includeArchived=true' : ''}`,
      )
        .then((result) => setItems(result.items))
        .catch(() => setItems([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [includeArchived, query]);
  const arrangeToday = async (taskId: string) => {
    try {
      const point = await createDate(todayInTimezone(settings?.timezone ?? 'Asia/Shanghai'));
      await addPlacement(taskId, point.id);
      setActionError('已安排到今天');
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '安排到今天失败，请重试');
    }
  };
  if (!presence.mounted) return null;
  return (
    <div
      className={`modal-layer command-layer presence-${presence.state}`}
      aria-hidden={presence.state === 'exiting'}
      onMouseDown={(event) => {
        if (presence.state !== 'exiting' && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`command-panel presence-${presence.state}`}
        role="dialog"
        aria-modal="true"
        aria-label="搜索和命令面板"
      >
        <div className="command-input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务、引用 ID、项目或备注…"
          />
          <label className="command-archive-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            含归档
          </label>
          <kbd>ESC</kbd>
        </div>
        {query ? (
          <div className="command-results">
            {actionError && (
              <div className="command-action-status" role="status">
                {actionError}
              </div>
            )}
            {items.length ? (
              items.map(({ task, project }) => (
                <div key={task.id} className="command-result">
                  <button className="command-result-main" onClick={() => onOpenTask(task.id)}>
                    <span className="status-icon">
                      <StatusIcon status={task.status} />
                    </span>
                    <span className="result-copy">
                      <strong>{task.title}</strong>
                      <small>
                        {task.referenceId} · {project?.name ?? '全局杂项'}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                  <button
                    className="command-result-action"
                    onClick={() => void arrangeToday(task.id)}
                  >
                    安排今天
                  </button>
                </div>
              ))
            ) : (
              <div className="command-empty">没有找到匹配任务</div>
            )}
          </div>
        ) : (
          <div className="command-hints">
            <span>
              <Command size={15} /> 输入关键词开始搜索
            </span>
            <span>搜索标题、备注、项目名和引用 ID</span>
            <div className="command-actions">
              <button onClick={() => onQuickCapture('task')}>新建任务</button>
              <button onClick={() => onQuickCapture('project')}>新建项目</button>
              <button onClick={() => onQuickCapture('event')}>新建时间点</button>
              <button
                onClick={() => {
                  onClose();
                  navigate('/settings');
                }}
              >
                前往设置
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusIcon({ status }: { status: TaskDto['status'] }) {
  if (status === 'DONE')
    return (
      <span className="task-check done">
        <Check size={13} />
      </span>
    );
  if (status === 'IN_PROGRESS')
    return (
      <span className="task-check progress">
        <span />
      </span>
    );
  return (
    <span className="task-check">
      <Circle size={15} />
    </span>
  );
}

function TaskRow({
  task,
  onOpen,
  onChanged,
  compact = false,
  onMove,
  onDrop,
  canMoveUp = false,
  canMoveDown = false,
}: {
  task: TaskDto;
  onOpen: (id: string) => void;
  onChanged?: () => void;
  compact?: boolean;
  onMove?: (direction: 'up' | 'down') => Promise<void> | void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const [placementTargetOpen, setPlacementTargetOpen] = useState(false);
  const longPressRef = useRef<number | null>(null);
  const cancelLongPress = () => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };
  const startLongPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('button,a,input,select,textarea')
    )
      return;
    cancelLongPress();
    longPressRef.current = window.setTimeout(() => {
      setMenu(true);
      longPressRef.current = null;
    }, 550);
  };
  const toggleStatus = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutation('PATCH', `/tasks/${task.id}`, {
        status: nextTaskStatus(task.status),
        baseVersion: task.version,
      });
      onChanged?.();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新任务失败');
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const action = task.archivedAt ? 'restore' : 'archive';
      await mutation('POST', `/tasks/${task.id}/${action}`, { baseVersion: task.version });
      onChanged?.();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '归档操作失败');
    } finally {
      setBusy(false);
      setMenu(false);
    }
  };
  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutation('POST', `/tasks/${task.id}/duplicate`, {});
      onChanged?.();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '复制任务失败');
    } finally {
      setBusy(false);
      setMenu(false);
    }
  };
  const move = async (direction: 'up' | 'down') => {
    if (!onMove || busy) return;
    setBusy(true);
    setError('');
    try {
      await onMove(direction);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '排序失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`task-row ${task.status === 'DONE' ? 'is-done' : ''} ${task.status === 'IN_PROGRESS' ? 'is-progress' : ''} ${compact ? 'compact' : ''}`}
      data-testid={`task-${task.id}`}
      data-task-id={task.id}
      draggable={Boolean(onDrop)}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-devtodo-task', task.id);
        event.dataTransfer.setData('text/plain', task.id);
      }}
      onDragOver={(event) => {
        if (onDrop) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDrop) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(event);
      }}
    >
      <button
        className="task-status-button"
        aria-label={taskStatusActionLabel(task.status)}
        title={taskStatusActionLabel(task.status)}
        onClick={() => void toggleStatus()}
        disabled={busy}
      >
        <StatusIcon status={task.status} />
      </button>
      {onMove && (
        <div className="task-reorder-actions" aria-label="调整任务顺序">
          <button
            className="icon-button"
            aria-label="上移任务"
            onClick={() => void move('up')}
            disabled={busy || !canMoveUp}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下移任务"
            onClick={() => void move('down')}
            disabled={busy || !canMoveDown}
          >
            <ChevronDown size={15} />
          </button>
        </div>
      )}
      <button className="task-main" onClick={() => onOpen(task.id)}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          <span className="reference-id">{task.referenceId || '待同步分配'}</span>
          {task.priority !== 'NONE' && <PriorityPill priority={task.priority} />}
          {task.status === 'IN_PROGRESS' && <span className="status-label">进行中</span>}
        </span>
      </button>
      <div className="task-actions">
        <M3IconButton
          className="icon-button task-schedule-action"
          label="安排到时间点"
          onClick={() => setPlacementTargetOpen(true)}
        >
          <CalendarDays size={16} />
        </M3IconButton>
        <M3IconButton
          className="icon-button"
          label="更多任务操作（也可长按任务行）"
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal size={17} />
        </M3IconButton>
        {menu && (
          <div className="row-menu">
            <button onClick={() => void archive()}>
              {task.archivedAt ? <Undo2 size={15} /> : <Archive size={15} />}
              {task.archivedAt ? '恢复任务' : '归档任务'}
            </button>
            <button onClick={() => void duplicate()}>
              <Copy size={15} />
              复制任务
            </button>
            <button
              onClick={() => {
                onOpen(task.id);
                setMenu(false);
              }}
            >
              <Link2 size={15} />
              打开详情
            </button>
            <button
              onClick={() => {
                setMenu(false);
                setPlacementTargetOpen(true);
              }}
            >
              <Target size={15} />
              安排到时间点
            </button>
          </div>
        )}
      </div>
      {error && (
        <span className="row-error" role="alert">
          {error}
        </span>
      )}
      {placementTargetOpen && (
        <TaskPlacementTargetModal
          task={task}
          onClose={() => setPlacementTargetOpen(false)}
          onDone={() => {
            setPlacementTargetOpen(false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function PriorityPill({ priority }: { priority: TaskDto['priority'] }) {
  const labels = { LOW: '低', MEDIUM: '中', HIGH: '高', NONE: '' };
  return <span className={`priority priority-${priority.toLowerCase()}`}>{labels[priority]}</span>;
}

function TaskList({
  tasks,
  onOpenTask,
  onChanged,
  onMove,
  emptyTitle = '这里还没有任务',
  emptyDescription = '用上方的一行输入，先把脑中的下一步记下来。',
}: {
  tasks: TaskDto[];
  onOpenTask: (id: string) => void;
  onChanged?: () => void;
  onMove?: (taskId: string, direction: 'up' | 'down') => Promise<void> | void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const handleDrop = async (event: ReactDragEvent<HTMLElement>, targetTaskId: string) => {
    if (!onMove) return;
    const sourceTaskId = event.dataTransfer.getData('application/x-devtodo-task');
    if (!sourceTaskId || sourceTaskId === targetTaskId) return;
    const nextIds = reorderIds(
      tasks.map((task) => task.id),
      sourceTaskId,
      targetTaskId,
    );
    if (nextIds.every((id, index) => id === tasks[index]?.id)) return;
    await mutation('POST', '/tasks/reorder', { ids: nextIds });
    onChanged?.();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  if (!tasks.length)
    return (
      <EmptyState icon={<Sparkles size={20} />} title={emptyTitle} description={emptyDescription} />
    );
  return (
    <div
      className={`task-list ${onMove ? 'task-drop-target' : ''}`}
      onDragOver={(event) => {
        if (onMove) event.preventDefault();
      }}
    >
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          onOpen={onOpenTask}
          onChanged={onChanged}
          onMove={onMove ? (direction) => onMove(task.id, direction) : undefined}
          onDrop={onMove ? (event) => void handleDrop(event, task.id) : undefined}
          canMoveUp={index > 0}
          canMoveDown={index < tasks.length - 1}
        />
      ))}
    </div>
  );
}

function TodayPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { settings } = useAuth();
  const localDate = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  const loader = useCallback(async () => {
    const point = await createDate(localDate);
    const [items, reachedEvents] = await Promise.all([
      requestAll<PlacementWithTask>(`/time-points/${point.id}/placements`),
      requestAll<TimePointDto>('/time-points?type=EVENT&archived=false'),
    ]);
    return {
      point,
      items,
      reachedEvents: reachedEvents.filter((candidate) => candidate.reachedAt),
    };
  }, [localDate]);
  const { data, loading, error, reload } = useReloadable(loader, {
    point: null as TimePointDto | null,
    items: [] as PlacementWithTask[],
    reachedEvents: [] as TimePointDto[],
  });
  const [rollover, setRollover] = useState<{ operationId: string; count: number } | null>(null);
  const [rolloverError, setRolloverError] = useState('');
  const [completedOpen, setCompletedOpen] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const doRollover = async () => {
    setRolloverError('');
    try {
      const result = await request<{ operationId: string; createdIds: string[] }>(
        `/dates/${localDate}/rollover`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setRollover({ operationId: result.operationId, count: result.createdIds.length });
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setRolloverError(cause instanceof ApiError ? cause.message : '安排到明天失败，请重试');
    }
  };
  const undo = async () => {
    if (!rollover) return;
    setRolloverError('');
    try {
      await request(`/rollovers/${rollover.operationId}/undo`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setRollover(null);
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setRolloverError(cause instanceof ApiError ? cause.message : '撤销失败，请重试');
    }
  };
  const active = data.items.filter(({ task }) => task.status !== 'DONE');
  const done = data.items.filter(({ task }) => task.status === 'DONE');
  const total = active.length + done.length;
  const completionPercent = total ? Math.round((done.length / total) * 100) : 0;
  const movePlacement = async (placementId: string, direction: 'up' | 'down') => {
    if (!data.point) return;
    const activeIndexes = data.items
      .map((item, index) => (item.task.status === 'DONE' ? -1 : index))
      .filter((index) => index >= 0);
    const index = activeIndexes.indexOf(data.items.findIndex((item) => item.id === placementId));
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= activeIndexes.length) return;
    const next = [...data.items];
    const sourcePosition = activeIndexes[index]!;
    const targetPosition = activeIndexes[targetIndex]!;
    [next[sourcePosition], next[targetPosition]] = [next[targetPosition]!, next[sourcePosition]!];
    await mutation('POST', `/time-points/${data.point.id}/placements/reorder`, {
      ids: next.map((item) => item.id),
    });
    await reload();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="TODAY"
        title={formatDate(localDate)}
        description="把今天要处理的内容放在眼前，完成状态会同步到每一个安排位置。"
        action={
          <div className="header-actions">
            <M3Button
              variant="tonal"
              leadingIcon={<Plus size={16} />}
              onClick={() => setShowTaskPicker(true)}
              disabled={!data.point}
            >
              从任务库加入
            </M3Button>
            <M3Button
              variant="outlined"
              leadingIcon={<Copy size={16} />}
              onClick={() => void doRollover()}
              disabled={!data.point || active.length === 0}
            >
              安排未完成到明天
            </M3Button>
          </div>
        }
      />
      <section className="today-overview" aria-label="今日进度">
        <div className="today-overview-copy">
          <span className="today-overview-label">今日聚焦</span>
          <strong>{total ? `${done.length} / ${total} 已完成` : '还没有安排任务'}</strong>
        </div>
        <div
          className="today-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={completionPercent}
        >
          <span style={{ width: `${completionPercent}%` }} />
        </div>
        <span className="today-overview-percent">{completionPercent}%</span>
      </section>
      {rollover && (
        <div className="undo-banner">
          <span>已安排 {rollover.count} 项到明天</span>
          <button className="text-button" onClick={() => void undo()}>
            <Undo2 size={15} />
            撤销
          </button>
        </div>
      )}
      {rolloverError && (
        <ErrorState error={rolloverError} onRetry={() => void (rollover ? undo() : doRollover())} />
      )}
      {data.reachedEvents.length > 0 && (
        <section className="reached-events" aria-labelledby="reached-events-title">
          <div className="section-title">
            <h2 id="reached-events-title">已到达的时间点</h2>
            <span className="muted-label">任务仍按自己的状态管理</span>
          </div>
          <div className="reached-event-list">
            {data.reachedEvents.map((event) => (
              <NavLink key={event.id} to={`/time/events/${event.id}`} className="reached-event">
                <span className="timeline-node reached" />
                <span>
                  <strong>{event.title}</strong>
                  <small>查看其中未完成的安排</small>
                </span>
                <EventCount pointId={event.id} />
                <ChevronRight size={16} />
              </NavLink>
            ))}
          </div>
        </section>
      )}
      <QuickCapture
        category="MISC"
        onCreated={async (task) => {
          const point = data.point ?? (await createDate(localDate));
          await addPlacement(task.id, point.id);
          await reload();
        }}
      />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : (
        <>
          <SectionTitle title="今天要做" count={active.length} />
          <PlacementList
            items={active}
            pointId={data.point?.id}
            onOpenTask={onOpenTask}
            onChanged={() => void reload()}
            onMove={movePlacement}
            emptyTitle="今天还没有安排"
            emptyDescription="可以从所有任务中安排内容，或先捕获一个全局杂项。"
            emptyAction={
              data.point ? (
                <M3Button
                  variant="filled"
                  leadingIcon={<Plus size={16} />}
                  onClick={() => setShowTaskPicker(true)}
                >
                  从任务库加入
                </M3Button>
              ) : undefined
            }
          />
          <SectionTitle
            title="已完成"
            count={done.length}
            action={
              done.length > 0 ? (
                <button
                  className="text-button"
                  onClick={() => setCompletedOpen((current) => !current)}
                  aria-expanded={completedOpen}
                >
                  {completedOpen ? '收起' : '展开'}
                </button>
              ) : undefined
            }
          />
          {done.length > 0 && completedOpen ? (
            <div className="task-list completed-list">
              {done.map((item) => (
                <PlacementRow
                  key={item.id}
                  placementId={item.id}
                  task={item.task}
                  onOpen={onOpenTask}
                  onChanged={() => void reload()}
                  onToggleStatus
                />
              ))}
            </div>
          ) : (
            <div className="quiet-empty">
              {done.length > 0 ? '已完成任务默认收起' : '完成的任务会收在这里'}
            </div>
          )}
        </>
      )}
      {showTaskPicker && data.point && (
        <AddTaskModal
          pointId={data.point.id}
          onClose={() => setShowTaskPicker(false)}
          onAdded={() => {
            setShowTaskPicker(false);
            void reload();
            window.dispatchEvent(new Event('devtodo:data-changed'));
          }}
        />
      )}
    </div>
  );
}

function TasksPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const loader = useCallback(() => requestAll<TaskDto>('/tasks?archived=false'), []);
  const { data, loading, error, reload } = useReloadable(loader, []);
  const [filter, setFilter] = useState<'ALL' | 'IN_PROGRESS' | 'TODO' | 'DONE'>('ALL');
  const tasks = filter === 'ALL' ? data : data.filter((task) => task.status === filter);
  return (
    <div className="page">
      <PageHeader
        eyebrow="TASK LIBRARY"
        title="任务库"
        description="任务本体只保留一份；日期和时间点是可重复的安排位置。"
      />
      <QuickCapture onCreated={() => void reload()} />
      <div className="task-library-summary" aria-label="任务状态概览">
        <M3Chip selected>{data.length} 个任务</M3Chip>
        <M3Chip>{data.filter((task) => task.status === 'IN_PROGRESS').length} 进行中</M3Chip>
        <M3Chip>{data.filter((task) => task.status === 'TODO').length} 待开始</M3Chip>
        <M3Chip>{data.filter((task) => task.status === 'DONE').length} 已完成</M3Chip>
      </div>
      <M3SegmentedControl
        label="任务状态筛选"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'ALL', label: '全部', count: data.length },
          {
            value: 'IN_PROGRESS',
            label: '进行中',
            count: data.filter((task) => task.status === 'IN_PROGRESS').length,
          },
          {
            value: 'TODO',
            label: '待开始',
            count: data.filter((task) => task.status === 'TODO').length,
          },
          {
            value: 'DONE',
            label: '已完成',
            count: data.filter((task) => task.status === 'DONE').length,
          },
        ]}
      />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : (
        <TaskList tasks={tasks} onOpenTask={onOpenTask} onChanged={() => void reload()} />
      )}
    </div>
  );
}

function InboxPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const loader = useCallback(
    () => requestAll<TaskDto>('/tasks?projectId=null&category=MISC&archived=false'),
    [],
  );
  const { data, loading, error, reload } = useReloadable(loader, []);
  const moveTask = async (taskId: string, direction: 'up' | 'down') => {
    const index = data.findIndex((task) => task.id === taskId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= data.length) return;
    const next = [...data];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    await mutation('POST', '/tasks/reorder', { ids: next.map((task) => task.id) });
    await reload();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="INBOX"
        title="收集箱"
        description="先把下一步收进来，再安排到项目、日期或时间点；这里的任务仍是全局杂项。"
      />
      <QuickCapture category="MISC" onCreated={() => void reload()} />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : (
        <TaskList
          tasks={data}
          onOpenTask={onOpenTask}
          onChanged={() => void reload()}
          onMove={(taskId, direction) => moveTask(taskId, direction)}
          emptyTitle="收集箱是空的"
          emptyDescription="例如：整理开发服务器、更新个人工具或记录一个想法。捕获后可以从任务行直接安排时间。"
        />
      )}
    </div>
  );
}

function ProjectPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { projectId } = useParams();
  const loader = useCallback(async () => {
    if (!projectId) throw new Error('缺少项目');
    const [project, tasks] = await Promise.all([
      request<ProjectDto>(`/projects/${projectId}`),
      requestAll<TaskDto>(`/tasks?projectId=${projectId}&archived=false`),
    ]);
    return { project, tasks };
  }, [projectId]);
  const { data, loading, error, reload } = useReloadable(loader, {
    project: null as ProjectDto | null,
    tasks: [] as TaskDto[],
  });
  const [tab, setTab] = useState<'FEATURE' | 'MISC'>('FEATURE');
  const [editOpen, setEditOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const moveTask = async (taskId: string, direction: 'up' | 'down') => {
    const group = data.tasks.filter((task) => task.category === tab && !task.archivedAt);
    const index = group.findIndex((task) => task.id === taskId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= group.length) return;
    const next = [...group];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    await mutation('POST', '/tasks/reorder', { ids: next.map((task) => task.id) });
    await reload();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  const archiveProject = async () => {
    if (!data.project) return;
    try {
      setActionError('');
      const action = data.project.archivedAt ? 'restore' : 'archive';
      await mutation('POST', `/projects/${data.project.id}/${action}`, {
        baseVersion: data.project.version,
      });
      await reload();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '项目操作失败');
    }
  };
  if (loading && !data.project)
    return (
      <div className="page">
        <SkeletonList />
      </div>
    );
  return (
    <div className="page">
      <PageHeader
        eyebrow={data.project?.taskPrefix}
        title={data.project?.name ?? '项目'}
        description={`${data.tasks.filter((task) => task.status !== 'DONE').length} 项未完成 · ${data.tasks.filter((task) => task.status === 'DONE').length} 项已完成`}
        action={
          data.project ? (
            <div className="header-actions">
              <M3Button
                variant="outlined"
                leadingIcon={<Pencil size={16} />}
                onClick={() => setEditOpen(true)}
              >
                编辑项目
              </M3Button>
              <M3Button
                variant="outlined"
                leadingIcon={data.project.archivedAt ? <Undo2 size={16} /> : <Archive size={16} />}
                onClick={() => void archiveProject()}
              >
                {data.project.archivedAt ? '恢复项目' : '归档项目'}
              </M3Button>
            </div>
          ) : undefined
        }
      />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {actionError && <ErrorState error={actionError} onRetry={() => void archiveProject()} />}
      <M3SegmentedControl
        label="项目任务类型"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'FEATURE',
            label: '功能',
            count: data.tasks.filter((task) => task.category === 'FEATURE').length,
          },
          {
            value: 'MISC',
            label: '杂项',
            count: data.tasks.filter((task) => task.category === 'MISC').length,
          },
        ]}
      />
      <QuickCapture projectId={projectId} category={tab} onCreated={() => void reload()} />
      <TaskList
        tasks={data.tasks.filter((task) => task.category === tab)}
        onOpenTask={onOpenTask}
        onChanged={() => void reload()}
        onMove={(taskId, direction) => moveTask(taskId, direction)}
        emptyTitle={tab === 'FEATURE' ? '还没有功能任务' : '项目杂项为空'}
        emptyDescription="从一行输入开始，之后可以在详情中补充备注和安排。"
      />
      {editOpen && data.project && (
        <EditProjectModal
          project={data.project}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            void reload();
            window.dispatchEvent(new Event('devtodo:data-changed'));
          }}
        />
      )}
    </div>
  );
}

function EditProjectModal({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation('PATCH', `/projects/${project.id}`, {
        name,
        baseVersion: project.version,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    }
  };
  return (
    <Modal title="编辑项目" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <Field label="项目名称" value={name} onChange={setName} autoComplete="off" />
        <p className="field-help">项目代号为 {project.taskPrefix}；已有任务后不可修改。</p>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <button className="primary-button wide" disabled={!name.trim()}>
          保存项目
        </button>
      </form>
    </Modal>
  );
}

function ProjectsPage() {
  const loader = useCallback(() => requestAll<ProjectDto>('/projects'), []);
  const { data, loading, error, reload } = useReloadable(loader, []);
  const [open, setOpen] = useState(false);
  const moveProject = async (projectId: string, direction: 'up' | 'down') => {
    const index = data.findIndex((project) => project.id === projectId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= data.length) return;
    const next = [...data];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    await mutation('POST', '/projects/reorder', { ids: next.map((project) => project.id) });
    await reload();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="PROJECTS"
        title="项目"
        description="每个项目有固定的功能与杂项两组任务。"
        action={
          <button className="primary-button" onClick={() => setOpen(true)}>
            <Plus size={16} />
            新建项目
          </button>
        }
      />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : data.length ? (
        <div className="project-grid">
          {data.map((project, index) => (
            <div key={project.id} className="project-card-shell">
              <NavLink to={`/projects/${project.id}`} className="project-card">
                <div className="project-card-top">
                  <span className="project-icon">
                    <FolderKanban size={18} />
                  </span>
                  <span className="reference-id">{project.taskPrefix}</span>
                </div>
                <h2>{project.name}</h2>
                <ProjectCount projectId={project.id} />
              </NavLink>
              <div className="card-reorder-actions" aria-label="调整项目顺序">
                <button
                  className="icon-button"
                  aria-label="上移项目"
                  onClick={() => void moveProject(project.id, 'up')}
                  disabled={index === 0}
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="下移项目"
                  onClick={() => void moveProject(project.id, 'down')}
                  disabled={index === data.length - 1}
                >
                  <ChevronDown size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FolderKanban size={20} />}
          title="还没有项目"
          description="为一个长期开发方向建立项目，再把功能和杂项放进去。"
          action={
            <button className="primary-button" onClick={() => setOpen(true)}>
              <Plus size={16} />
              建立第一个项目
            </button>
          }
        />
      )}
      {open && (
        <CreateProjectModal
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            void reload();
            window.dispatchEvent(new Event('devtodo:data-changed'));
          }}
        />
      )}
    </div>
  );
}

function ProjectCount({ projectId }: { projectId: string }) {
  const [count, setCount] = useState<{ open: number; done: number } | null>(null);
  useEffect(() => {
    void requestAll<TaskDto>(`/tasks?projectId=${projectId}`)
      .then((items) =>
        setCount({
          open: items.filter((task) => task.status !== 'DONE').length,
          done: items.filter((task) => task.status === 'DONE').length,
        }),
      )
      .catch(() => undefined);
  }, [projectId]);
  return (
    <p className="project-count">
      {count ? `${count.open} 项未完成 · ${count.done} 项已完成` : '读取任务…'}
    </p>
  );
}

function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await request('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, taskPrefix: prefix }),
      });
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    }
  };
  return (
    <Modal title="新建项目" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <Field label="项目名称" value={name} onChange={setName} autoComplete="off" />
        <Field
          label="项目代号"
          value={prefix}
          onChange={(value) => setPrefix(value.toUpperCase())}
          autoComplete="off"
        />
        <p className="field-help">2–10 位大写字母或数字，以字母开头。创建任务后代号不可修改。</p>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button wide" disabled={!name.trim() || !prefix.trim()}>
          创建项目
        </button>
      </form>
    </Modal>
  );
}

function SkeletonList() {
  return (
    <div className="skeleton-list" role="status" aria-label="加载中">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function EventsPage() {
  const loader = useCallback(async () => {
    const [active, archived] = await Promise.all([
      requestAll<TimePointDto>('/time-points?type=EVENT&archived=false'),
      requestAll<TimePointDto>('/time-points?type=EVENT&archived=true'),
    ]);
    return { active, archived };
  }, []);
  const { data, loading, error, reload } = useReloadable(loader, {
    active: [] as TimePointDto[],
    archived: [] as TimePointDto[],
  });
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<TimePointDto | null>(null);
  const [actionError, setActionError] = useState('');
  const moveEvent = async (eventId: string, direction: 'up' | 'down') => {
    try {
      const index = data.active.findIndex((point) => point.id === eventId);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= data.active.length) return;
      const next = [...data.active];
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      await mutation('POST', '/time-points/events/reorder', {
        ids: next.map((point) => point.id),
      });
      await reload();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '时间点排序失败，请重试');
    }
  };
  const renderEvent = (point: TimePointDto) => {
    const index = data.active.findIndex((candidate) => candidate.id === point.id);
    return (
      <div className="timeline-item-shell" key={point.id}>
        <NavLink to={`/time/events/${point.id}`} className="timeline-item">
          <span className={`timeline-node ${point.reachedAt ? 'reached' : ''}`} />
          <span className="timeline-copy">
            <strong>{point.title}</strong>
            <small>{point.reachedAt ? `已于 ${formatTime(point.reachedAt)} 到达` : '等待中'}</small>
          </span>
          <EventCount pointId={point.id} />
          <ChevronRight size={16} />
        </NavLink>
        <div className="timeline-actions" aria-label="时间点操作">
          <button
            className="icon-button"
            aria-label="上移时间点"
            onClick={() => void moveEvent(point.id, 'up')}
            disabled={index <= 0}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下移时间点"
            onClick={() => void moveEvent(point.id, 'down')}
            disabled={index < 0 || index >= data.active.length - 1}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`编辑${point.title}`}
            onClick={() => setEdit(point)}
          >
            <Pencil size={15} />
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="TIME POINTS"
        title="时间点"
        description="事件有自己的生命周期，不会自动完成或移动其中的任务。"
        action={
          <M3Button leadingIcon={<Plus size={16} />} onClick={() => setOpen(true)}>
            新建时间点
          </M3Button>
        }
      />
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {actionError && <ErrorState error={actionError} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : data.active.length || data.archived.length ? (
        <>
          {data.active.length > 0 && (
            <div className="timeline-list">
              <SectionTitle
                title="进行中的时间点"
                count={data.active.length}
                action={
                  <span className="muted-label">
                    {data.active.filter((point) => point.reachedAt).length} 项已到达 ·{' '}
                    {data.active.filter((point) => !point.reachedAt).length} 项等待中
                  </span>
                }
              />
              {data.active.map(renderEvent)}
            </div>
          )}
          {data.archived.length > 0 && (
            <div className="timeline-list archived-timeline-list">
              <SectionTitle title="已归档" count={data.archived.length} />
              {data.archived.map((point) => (
                <div className="timeline-item-shell" key={point.id}>
                  <NavLink to={`/time/events/${point.id}`} className="timeline-item">
                    <span className="timeline-node" />
                    <span className="timeline-copy">
                      <strong>{point.title}</strong>
                      <small>已归档 · {point.reachedAt ? '曾到达' : '未到达'}</small>
                    </span>
                    <EventCount pointId={point.id} />
                    <ChevronRight size={16} />
                  </NavLink>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <EmptyState
          icon={<Clock3 size={20} />}
          title="还没有自定义时间点"
          description="例如“Codex 额度重置后”或下一次发布窗口。"
          action={
            <M3Button leadingIcon={<Plus size={16} />} onClick={() => setOpen(true)}>
              创建时间点
            </M3Button>
          }
        />
      )}
      {open && (
        <CreateEventModal
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            void reload();
          }}
        />
      )}
      {edit && (
        <EditEventModal
          point={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            setActionError('');
            void reload();
            window.dispatchEvent(new Event('devtodo:data-changed'));
          }}
        />
      )}
    </div>
  );
}

function CreateEventModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await createEvent(title);
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    }
  };
  return (
    <Modal title="新建时间点" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <Field label="名称" value={title} onChange={setTitle} autoComplete="off" />
        <p className="field-help">
          这是一个事件节点，不是截止日期；它的到达状态与任务完成状态独立。
        </p>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button wide" disabled={!title.trim()}>
          创建时间点
        </button>
      </form>
    </Modal>
  );
}

function EditEventModal({
  point,
  onClose,
  onSaved,
}: {
  point: TimePointDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(point.title ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutation('PATCH', `/time-points/${point.id}`, {
        title,
        baseVersion: point.version,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="编辑时间点" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <Field label="名称" value={title} onChange={setTitle} autoComplete="off" />
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button wide" disabled={busy || !title.trim()}>
          {busy ? '保存中…' : '保存时间点'}
        </button>
      </form>
    </Modal>
  );
}

function EventCount({ pointId }: { pointId: string }) {
  const [count, setCount] = useState('');
  useEffect(() => {
    void requestAll<{ task: TaskDto }>(`/time-points/${pointId}/placements`)
      .then((items) =>
        setCount(`${items.filter(({ task }) => task.status !== 'DONE').length} 项未完成`),
      )
      .catch(() => undefined);
  }, [pointId]);
  return <span className="event-count">{count}</span>;
}

function EventPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { eventId } = useParams();
  const [point, setPoint] = useState<TimePointDto | null>(null);
  const [items, setItems] = useState<PlacementWithTask[]>([]);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const [nextPoint, placements] = await Promise.all([
        request<TimePointDto>(`/time-points/${eventId}`),
        requestAll<PlacementWithTask>(`/time-points/${eventId}/placements`),
      ]);
      setPoint(nextPoint);
      setItems(placements);
      setError('');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    }
  }, [eventId]);
  useEffect(() => {
    void load();
    const listener = () => void load();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [load]);
  if (error)
    return (
      <div className="page">
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  if (!point)
    return (
      <div className="page">
        <SkeletonList />
      </div>
    );
  const archiveOrReach = async () => {
    try {
      if (point.archivedAt)
        await mutation('POST', `/time-points/${point.id}/restore`, { baseVersion: point.version });
      else if (point.reachedAt)
        await mutation('POST', `/time-points/${point.id}/archive`, { baseVersion: point.version });
      else await mutation('POST', `/time-points/${point.id}/reach`, { baseVersion: point.version });
      await load();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败');
    }
  };
  const movePlacement = async (placementId: string, direction: 'up' | 'down') => {
    const index = items.findIndex((item) => item.id === placementId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    try {
      await mutation('POST', `/time-points/${point.id}/placements/reorder`, {
        ids: next.map((item) => item.id),
      });
      await load();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '安排排序失败，请重试');
    }
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="EVENT"
        title={point.title ?? ''}
        description={`${items.length} 项安排 · ${items.filter(({ task }) => task.status === 'DONE').length} 项已完成`}
        action={
          <div className="header-actions">
            <M3Button
              variant="outlined"
              leadingIcon={<Pencil size={16} />}
              onClick={() => setEditOpen(true)}
            >
              编辑时间点
            </M3Button>
            <M3Button
              variant="outlined"
              leadingIcon={
                point.archivedAt ? (
                  <Undo2 size={16} />
                ) : point.reachedAt ? (
                  <Archive size={16} />
                ) : (
                  <Check size={16} />
                )
              }
              onClick={() => void archiveOrReach()}
            >
              {point.archivedAt ? '恢复时间点' : point.reachedAt ? '归档时间点' : '标记已到达'}
            </M3Button>
          </div>
        }
      />
      <div className="event-state-line">
        <span className={`event-state ${point.reachedAt ? 'reached' : ''}`}>
          {point.archivedAt ? '已归档' : point.reachedAt ? '已到达' : '等待中'}
        </span>
        <span>任务状态与时间点状态互不影响</span>
      </div>
      <SectionTitle
        title="安排在这里"
        count={items.length}
        action={
          <M3Button
            size="small"
            variant="tonal"
            leadingIcon={<Plus size={15} />}
            onClick={() => setShowAdd(true)}
          >
            从任务库加入
          </M3Button>
        }
      />
      <PlacementList
        items={items}
        pointId={point.id}
        onOpenTask={onOpenTask}
        onChanged={() => void load()}
        onMove={movePlacement}
        emptyTitle="这个时间点还没有安排"
        emptyDescription="从任务库加入已有任务；它不会创建新的 Task。"
        emptyAction={
          <M3Button leadingIcon={<Plus size={16} />} onClick={() => setShowAdd(true)}>
            加入任务
          </M3Button>
        }
      />
      {showAdd && (
        <AddTaskModal
          pointId={point.id}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load();
            window.dispatchEvent(new Event('devtodo:data-changed'));
          }}
        />
      )}
      {editOpen && (
        <EditEventModal
          point={point}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PlacementRow({
  placementId,
  task,
  onOpen,
  onChanged,
  onDrop,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
  onToggleStatus = false,
}: {
  placementId: string;
  task: TaskDto;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  onMove?: (direction: 'up' | 'down') => Promise<void> | void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onToggleStatus?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [placement, setPlacement] = useState<PlacementDto | null>(null);
  const [targetMode, setTargetMode] = useState<'copy' | 'move' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const longPressRef = useRef<number | null>(null);
  const cancelLongPress = () => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };
  const startLongPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('button,a,input,select,textarea')
    )
      return;
    cancelLongPress();
    longPressRef.current = window.setTimeout(() => {
      setMenu(true);
      longPressRef.current = null;
    }, 550);
  };
  const loadPlacement = useCallback(async () => {
    const detail = await request<{ task: TaskDto; placements: PlacementDto[] }>(
      `/tasks/${task.id}`,
    );
    const next = detail.placements.find((item) => item.id === placementId);
    if (!next) throw new Error('安排不存在');
    setPlacement(next);
    return next;
  }, [placementId, task.id]);
  useEffect(() => {
    void loadPlacement().catch(() => undefined);
  }, [loadPlacement]);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const current = placement ?? (await loadPlacement());
      await mutation('DELETE', `/placements/${placementId}`, { baseVersion: current.version });
      onChanged();
      window.dispatchEvent(new Event('devtodo:data-changed'));
      setMenu(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '移除安排失败');
    } finally {
      setBusy(false);
    }
  };
  const move = async (direction: 'up' | 'down') => {
    if (!onMove || busy) return;
    setBusy(true);
    setError('');
    try {
      await onMove(direction);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '安排排序失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  const toggleStatus = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutation('PATCH', `/tasks/${task.id}`, {
        status: nextTaskStatus(task.status),
        baseVersion: task.version,
      });
      onChanged();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新任务失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="task-row"
      draggable
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-devtodo-placement', placementId);
        event.dataTransfer.setData('application/x-devtodo-task', task.id);
        event.dataTransfer.setData('text/plain', task.id);
      }}
      onDragOver={(event) => {
        if (onDrop) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDrop) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(event);
      }}
    >
      <button
        className="task-status-button"
        aria-label={onToggleStatus ? taskStatusActionLabel(task.status) : '打开任务'}
        title={onToggleStatus ? taskStatusActionLabel(task.status) : '打开任务'}
        onClick={() => (onToggleStatus ? void toggleStatus() : onOpen(task.id))}
        disabled={busy}
      >
        <StatusIcon status={task.status} />
      </button>
      {onMove && (
        <div className="task-reorder-actions" aria-label="调整安排顺序">
          <button
            className="icon-button"
            aria-label="上移安排"
            onClick={() => void move('up')}
            disabled={busy || !canMoveUp}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下移安排"
            onClick={() => void move('down')}
            disabled={busy || !canMoveDown}
          >
            <ChevronDown size={15} />
          </button>
        </div>
      )}
      <button className="task-main" onClick={() => onOpen(task.id)}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          <span className="reference-id">{task.referenceId}</span>
        </span>
      </button>
      <div className="task-actions">
        <button
          className="icon-button"
          aria-label="安排操作（也可长按安排行）"
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal size={17} />
        </button>
        {menu && (
          <div className="row-menu">
            <button onClick={() => void remove()}>
              <Trash2 size={15} />
              从此处移除
            </button>
            <button
              onClick={() => {
                setMenu(false);
                setTargetMode('move');
              }}
            >
              <Target size={15} />
              移动到其他时间点
            </button>
            <button
              onClick={() => {
                setMenu(false);
                setTargetMode('copy');
              }}
            >
              <Copy size={15} />
              再安排到其他时间点
            </button>
          </div>
        )}
      </div>
      {error && <span className="row-error">{error}</span>}
      {targetMode && placement && (
        <PlacementTargetModal
          placement={placement}
          mode={targetMode}
          onClose={() => setTargetMode(null)}
          onDone={() => {
            setTargetMode(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function PlacementList({
  items,
  pointId,
  onOpenTask,
  onChanged,
  onMove,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: {
  items: PlacementWithTask[];
  pointId?: string;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
  onMove?: (placementId: string, direction: 'up' | 'down') => Promise<void> | void;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: ReactNode;
}) {
  const handleDrop = async (event: ReactDragEvent<HTMLElement>, targetPlacementId?: string) => {
    if (!pointId) return;
    const sourcePlacementId = event.dataTransfer.getData('application/x-devtodo-placement');
    if (targetPlacementId && sourcePlacementId && sourcePlacementId !== targetPlacementId) {
      const sourceIndex = items.findIndex((item) => item.id === sourcePlacementId);
      const targetIndex = items.findIndex((item) => item.id === targetPlacementId);
      if (sourceIndex >= 0 && targetIndex >= 0) {
        const next = [...items];
        const [moved] = next.splice(sourceIndex, 1);
        const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        if (moved) next.splice(insertionIndex, 0, moved);
        try {
          await mutation('POST', `/time-points/${pointId}/placements/reorder`, {
            ids: next.map((item) => item.id),
          });
          onChanged();
          window.dispatchEvent(new Event('devtodo:data-changed'));
        } catch {
          /* the destination page reload surfaces the current server state */
        }
        return;
      }
    }
    await moveDraggedPlacement(event, pointId);
  };
  const empty = (
    <EmptyState
      icon={<Sparkles size={20} />}
      title={emptyTitle}
      description={emptyDescription}
      action={emptyAction}
    />
  );
  if (!items.length)
    return (
      <div
        className="task-list placement-drop-target placement-empty-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void handleDrop(event)}
      >
        {empty}
      </div>
    );
  return (
    <div
      className="task-list placement-drop-target"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => void handleDrop(event)}
    >
      {items.map((item, index) => (
        <PlacementRow
          key={item.id}
          placementId={item.id}
          task={item.task}
          onOpen={onOpenTask}
          onChanged={onChanged}
          onDrop={(event) => void handleDrop(event, item.id)}
          onMove={onMove ? (direction) => onMove(item.id, direction) : undefined}
          canMoveUp={index > 0}
          canMoveDown={index < items.length - 1}
          onToggleStatus
        />
      ))}
    </div>
  );
}

function PlacementTargetModal({
  placement,
  mode,
  onClose,
  onDone,
}: {
  placement: PlacementDto;
  mode: 'copy' | 'move';
  onClose: () => void;
  onDone: () => void;
}) {
  const { settings } = useAuth();
  const [points, setPoints] = useState<TimePointDto[]>([]);
  const [targetKind, setTargetKind] = useState<'date' | 'event'>('date');
  const [targetId, setTargetId] = useState('');
  const [localDate, setLocalDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  const tomorrow = shiftLocalDate(today, 1);
  const eventPoints = points.filter((point) => point.type === 'EVENT');
  useEffect(() => {
    void requestAll<TimePointDto>('/time-points?archived=false')
      .then((items) => setPoints(items))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '时间点加载失败'));
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let nextId = targetId;
      if (targetKind === 'date' && localDate.trim())
        nextId = (await createDate(localDate.trim())).id;
      if (!nextId) throw new Error('请选择事件或输入日期');
      if (mode === 'move' && nextId === placement.timePointId)
        throw new Error('目标时间点不能与当前位置相同');
      await mutation(
        'POST',
        `/placements/${placement.id}/${mode}`,
        mode === 'move'
          ? { timePointId: nextId, baseVersion: placement.version }
          : { timePointId: nextId },
      );
      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === 'move' ? '移动到其他时间点' : '再安排到其他时间点'} onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <p className="field-help">
          {mode === 'move'
            ? '移动会改变当前安排的位置，任务本体和其他安排不受影响。'
            : '再安排会保留当前安排，并为同一个任务创建一个新的安排位置。'}
        </p>
        <M3SegmentedControl
          label="目标类型"
          value={targetKind}
          options={[
            { value: 'date', label: '日期' },
            { value: 'event', label: '自定义时间点' },
          ]}
          onChange={(nextMode) => {
            setTargetKind(nextMode);
            setTargetId('');
            setLocalDate('');
          }}
        />
        {targetKind === 'date' ? (
          <>
            <div className="date-shortcuts" aria-label="快速选择日期">
              <M3Chip selected={localDate === today} onClick={() => setLocalDate(today)}>
                今天
              </M3Chip>
              <M3Chip selected={localDate === tomorrow} onClick={() => setLocalDate(tomorrow)}>
                明天
              </M3Chip>
            </div>
            <label className="field">
              <span>选择日期</span>
              <input
                type="date"
                value={localDate}
                onChange={(event) => setLocalDate(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>选择自定义时间点</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">选择事件</option>
              {eventPoints.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.title}
                </option>
              ))}
            </select>
            {!eventPoints.length && (
              <small className="field-help">还没有可用的自定义时间点。</small>
            )}
          </label>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <M3Button
          className="wide"
          disabled={busy || (targetKind === 'event' ? !targetId : !localDate)}
        >
          {busy ? '处理中…' : mode === 'move' ? '移动安排' : '创建副本安排'}
        </M3Button>
      </form>
    </Modal>
  );
}

async function moveDraggedPlacement(event: ReactDragEvent<HTMLElement>, targetTimePointId: string) {
  event.preventDefault();
  const placementId = event.dataTransfer.getData('application/x-devtodo-placement');
  const taskId =
    event.dataTransfer.getData('application/x-devtodo-task') ||
    event.dataTransfer.getData('text/plain');
  if (!taskId) return;
  try {
    if (!placementId) {
      await addPlacement(taskId, targetTimePointId);
      window.dispatchEvent(new Event('devtodo:data-changed'));
      return;
    }
    const detail = await request<{ placements: PlacementDto[] }>(`/tasks/${taskId}`);
    const placement = detail.placements.find((item) => item.id === placementId);
    if (!placement || placement.timePointId === targetTimePointId) return;
    await mutation('POST', `/placements/${placementId}/move`, {
      timePointId: targetTimePointId,
      baseVersion: placement.version,
    });
    window.dispatchEvent(new Event('devtodo:data-changed'));
  } catch {
    /* the destination page reload surfaces the current server state */
  }
}

function TaskPlacementTargetModal({
  task,
  onClose,
  onDone,
}: {
  task: TaskDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { settings } = useAuth();
  const [points, setPoints] = useState<TimePointDto[]>([]);
  const [mode, setMode] = useState<'date' | 'event'>('date');
  const [targetId, setTargetId] = useState('');
  const [localDate, setLocalDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  const tomorrow = shiftLocalDate(today, 1);
  const eventPoints = points.filter((point) => point.type === 'EVENT');
  useEffect(() => {
    void requestAll<TimePointDto>('/time-points?archived=false')
      .then((items) => setPoints(items))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '时间点加载失败'));
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let nextId = targetId;
      if (mode === 'date' && localDate.trim()) nextId = (await createDate(localDate.trim())).id;
      if (!nextId) throw new Error('请选择事件或输入日期');
      await addPlacement(task.id, nextId);
      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : '安排任务失败',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="安排到时间点" onClose={onClose}>
      <form className="stack-form" onSubmit={submit}>
        <p className="field-help">将“{task.title}”安排到一个日期或事件，不会复制任务本体。</p>
        <M3SegmentedControl
          label="安排类型"
          value={mode}
          options={[
            { value: 'date', label: '日期' },
            { value: 'event', label: '自定义时间点' },
          ]}
          onChange={(nextMode) => {
            setMode(nextMode);
            setTargetId('');
            setLocalDate('');
          }}
        />
        {mode === 'date' ? (
          <>
            <div className="date-shortcuts" aria-label="快速选择日期">
              <M3Chip selected={localDate === today} onClick={() => setLocalDate(today)}>
                今天
              </M3Chip>
              <M3Chip selected={localDate === tomorrow} onClick={() => setLocalDate(tomorrow)}>
                明天
              </M3Chip>
            </div>
            <label className="field">
              <span>选择日期</span>
              <input
                type="date"
                value={localDate}
                onChange={(event) => setLocalDate(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>选择自定义时间点</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">选择事件</option>
              {eventPoints.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.title}
                </option>
              ))}
            </select>
            {!eventPoints.length && (
              <small className="field-help">还没有可用的自定义时间点。</small>
            )}
          </label>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <M3Button className="wide" disabled={busy || (mode === 'event' ? !targetId : !localDate)}>
          {busy ? '处理中…' : '安排任务'}
        </M3Button>
      </form>
    </Modal>
  );
}

function AddTaskModal({
  pointId,
  onClose,
  onAdded,
}: {
  pointId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<TaskDto[]>([]);
  const [error, setError] = useState('');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query.trim()) {
        void request<{ items: Array<{ task: TaskDto }> }>(
          `/search/tasks?q=${encodeURIComponent(query)}`,
        )
          .then((result) => setItems(result.items.map(({ task }) => task)))
          .catch(() => setItems([]));
        return;
      }
      void requestAll<TaskDto>('/tasks?archived=false')
        .then((result) => setItems(result.filter((task) => task.status !== 'DONE').slice(0, 12)))
        .catch(() => setItems([]));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);
  const add = async (task: TaskDto) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    setError('');
    try {
      await request('/placements', {
        method: 'POST',
        body: JSON.stringify({ taskId: task.id, timePointId: pointId }),
      });
      onAdded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '安排任务失败，请重试');
    } finally {
      setBusyTaskId(null);
    }
  };
  return (
    <Modal title="从任务库加入" onClose={onClose}>
      <label className="search-field">
        <Search size={16} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入标题或引用 ID"
        />
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!query && <p className="field-help picker-hint">最近未完成的任务</p>}
      <div className="picker-list">
        {items.map((task) => (
          <button
            key={task.id}
            className="picker-item"
            onClick={() => void add(task)}
            disabled={Boolean(busyTaskId)}
          >
            <StatusIcon status={task.status} />
            <span>
              <strong>{task.title}</strong>
              <small>{task.referenceId}</small>
            </span>
            {busyTaskId === task.id ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
          </button>
        ))}
      </div>
      {!items.length && (
        <div className="command-empty">
          {query ? '没有可加入的任务' : '没有未完成任务，可以先在任务库创建。'}
        </div>
      )}
    </Modal>
  );
}

function CalendarPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { settings } = useAuth();
  const params = useParams();
  const initial = params.localDate ?? todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  const [month, setMonth] = useState(initial.slice(0, 7));
  const [selected, setSelected] = useState(params.localDate ?? initial);
  const [items, setItems] = useState<PlacementWithTask[]>([]);
  const [point, setPoint] = useState<TimePointDto | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
  const [detailError, setDetailError] = useState('');
  const days = useMemo(
    () => calendarDays(month, settings?.weekStartsOn ?? 1),
    [month, settings?.weekStartsOn],
  );
  const selectDate = (date: string) => {
    setSelected(date);
    setMonth(date.slice(0, 7));
  };
  const onCalendarKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, date: string) => {
    const delta =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -7
            : event.key === 'ArrowDown'
              ? 7
              : 0;
    if (!delta) return;
    event.preventDefault();
    selectDate(shiftLocalDate(date, delta));
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dates = new Set(days.filter((day) => day.inMonth).map((day) => day.date));
      const points = await requestAll<TimePointDto>('/time-points?type=DATE');
      const relevant = points.filter(
        (candidate) => candidate.localDate && dates.has(candidate.localDate),
      );
      const counts = await Promise.all(
        relevant.map(async (candidate) => {
          const items = await requestAll<TaskDto>(`/tasks?timePointId=${candidate.id}`);
          return [candidate.localDate!, items.length] as const;
        }),
      );
      if (!cancelled) setDateCounts(Object.fromEntries(counts));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [days]);
  const loadSelected = useCallback(async () => {
    const nextPoint = await createDate(selected);
    const items = await requestAll<PlacementWithTask>(`/time-points/${nextPoint.id}/placements`);
    setPoint(nextPoint);
    setItems(items);
    setDetailError('');
  }, [selected]);
  useEffect(() => {
    void loadSelected().catch((cause) =>
      setDetailError(cause instanceof ApiError ? cause.message : '日期任务加载失败'),
    );
    const listener = () => void loadSelected();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [loadSelected]);
  const movePlacement = async (placementId: string, direction: 'up' | 'down') => {
    if (!point) return;
    const index = items.findIndex((item) => item.id === placementId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    await mutation('POST', `/time-points/${point.id}/placements/reorder`, {
      ids: next.map((item) => item.id),
    });
    await loadSelected();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="CALENDAR"
        title="日历"
        description="按本地日期安排任务，不把日期当成截止日期。"
        action={
          <M3Button
            variant="outlined"
            leadingIcon={<Target size={16} />}
            onClick={() => {
              const today = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
              setMonth(today.slice(0, 7));
              selectDate(today);
            }}
          >
            回到今天
          </M3Button>
        }
      />
      <div className="calendar-layout">
        <section className="calendar-panel">
          <div className="calendar-head">
            <M3IconButton
              label="上个月"
              aria-label="上个月"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft size={18} />
            </M3IconButton>
            <h2>{formatMonth(month)}</h2>
            <M3IconButton
              label="下个月"
              aria-label="下个月"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={18} />
            </M3IconButton>
          </div>
          <label className="calendar-date-jump">
            <span>跳转到日期</span>
            <input
              type="date"
              value={selected}
              onChange={(event) => {
                if (event.target.value) selectDate(event.target.value);
              }}
            />
          </label>
          <div className="weekday-row">
            {weekdayLabels(settings?.weekStartsOn ?? 1).map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {days.map((day) => (
              <button
                key={day.date}
                className={`calendar-day ${day.inMonth ? '' : 'muted'} ${selected === day.date ? 'selected' : ''}`}
                onClick={() => selectDate(day.date)}
                onKeyDown={(event) => onCalendarKeyDown(event, day.date)}
                aria-label={day.date}
              >
                <span>{day.label}</span>
                {(dateCounts[day.date] ?? 0) > 0 && <i>{dateCounts[day.date]}</i>}
              </button>
            ))}
          </div>
        </section>
        <section className="calendar-detail">
          <div className="calendar-detail-head">
            <div>
              <span className="eyebrow">SELECTED DATE</span>
              <h2>{formatDate(selected)}</h2>
            </div>
            <M3Button
              size="small"
              variant="tonal"
              leadingIcon={<Plus size={15} />}
              onClick={() => setShowAdd(true)}
            >
              加入任务
            </M3Button>
          </div>
          {detailError && <ErrorState error={detailError} onRetry={() => void loadSelected()} />}
          <PlacementList
            items={items}
            pointId={point?.id}
            onOpenTask={onOpenTask}
            onChanged={() => void loadSelected()}
            onMove={movePlacement}
            emptyTitle="这一天还没有安排"
            emptyDescription="从任务库添加已有任务，任务本体不会被复制。"
          />
          {showAdd && point && (
            <AddTaskModal
              pointId={point.id}
              onClose={() => setShowAdd(false)}
              onAdded={() => {
                setShowAdd(false);
                window.dispatchEvent(new Event('devtodo:data-changed'));
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function ArchivePage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const taskLoader = useCallback(() => requestAll<TaskDto>('/tasks?archived=true'), []);
  const projectLoader = useCallback(() => requestAll<ProjectDto>('/projects?archived=true'), []);
  const eventLoader = useCallback(
    () => requestAll<TimePointDto>('/time-points?type=EVENT&archived=true'),
    [],
  );
  const tasks = useReloadable(taskLoader, []);
  const projects = useReloadable(projectLoader, []);
  const events = useReloadable(eventLoader, []);
  return (
    <div className="page">
      <PageHeader
        eyebrow="HISTORY"
        title="归档"
        description="归档只影响默认可见性，任务、备注、安排和历史引用仍然保留。"
      />
      {tasks.error && <ErrorState error={tasks.error} onRetry={() => void tasks.reload()} />}
      <SectionTitle title="任务" count={tasks.data.length} />
      {tasks.loading ? (
        <SkeletonList />
      ) : (
        <TaskList
          tasks={tasks.data}
          onOpenTask={onOpenTask}
          onChanged={() => void tasks.reload()}
          emptyTitle="没有归档任务"
          emptyDescription="归档的任务会出现在这里，也可以恢复。"
        />
      )}
      {projects.data.length > 0 && (
        <>
          <SectionTitle title="项目" count={projects.data.length} />
          <div className="archive-project-list">
            {projects.data.map((project) => (
              <div className="archive-project" key={project.id}>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.taskPrefix}</small>
                </span>
                <button
                  className="secondary-button small"
                  onClick={() => void restoreEntity(`/projects/${project.id}`, project.version)}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {events.data.length > 0 && (
        <>
          <SectionTitle title="时间点" count={events.data.length} />
          <div className="archive-project-list">
            {events.data.map((event) => (
              <div className="archive-project" key={event.id}>
                <span>
                  <strong>{event.title}</strong>
                  <small>
                    {event.reachedAt ? `已到达 · ${formatTime(event.reachedAt)}` : '未到达'}
                  </small>
                </span>
                <button
                  className="secondary-button small"
                  onClick={() =>
                    void restoreEntity(`/time-points/${event.id}`, event.version).then(
                      () => void events.reload(),
                    )
                  }
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SettingsPage() {
  const auth = useAuth();
  const [timezone, setTimezone] = useState(auth.settings?.timezone ?? 'Asia/Shanghai');
  const [weekStartsOn, setWeekStartsOn] = useState<0 | 1>(auth.settings?.weekStartsOn ?? 1);
  const [defaultCaptureTarget, setDefaultCaptureTarget] = useState(
    auth.settings?.defaultCaptureTarget ?? 'GLOBAL_MISC',
  );
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!auth.settings) return;
    try {
      const updated = (await mutation('PATCH', '/settings', {
        timezone,
        weekStartsOn,
        defaultCaptureTarget,
        baseVersion: auth.settings.version,
      })) as SettingsDto;
      auth.updateSettings(updated);
      setSaved('已保存');
      setError('');
      window.setTimeout(() => setSaved(''), 2200);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    }
  };
  const [devices, setDevices] = useState<
    Array<{
      id: string;
      name: string;
      platform: string;
      lastSeenAt: string;
      revokedAt: string | null;
    }>
  >([]);
  useEffect(() => {
    void request<typeof devices>('/devices')
      .then(setDevices)
      .catch(() => undefined);
  }, []);
  return (
    <div className="page narrow-page">
      <PageHeader
        eyebrow="PREFERENCES"
        title="设置"
        description="偏好设置会随账号同步；本地数据与服务端数据保持同一份领域语义。"
      />
      {isNativeClient() && <HubSettingsSection />}
      <form className="settings-form" onSubmit={save}>
        <div className="settings-section">
          <h2>日期与安排</h2>
          <label className="field">
            <span>时区</span>
            <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              <option>Asia/Shanghai</option>
              <option>Asia/Tokyo</option>
              <option>UTC</option>
              <option>America/Los_Angeles</option>
            </select>
          </label>
          <label className="field">
            <span>每周起始日</span>
            <select
              value={weekStartsOn}
              onChange={(event) => setWeekStartsOn(Number(event.target.value) as 0 | 1)}
            >
              <option value={1}>周一</option>
              <option value={0}>周日</option>
            </select>
          </label>
          <label className="field">
            <span>默认新任务位置</span>
            <select
              value={defaultCaptureTarget}
              onChange={(event) => setDefaultCaptureTarget(event.target.value)}
            >
              <option value="GLOBAL_MISC">全局杂项</option>
              <option value="RECENT_CONTEXT">最近打开的项目或页面</option>
            </select>
          </label>
          <p className="field-help">日期任务使用此时区的本地日期；不会把 UTC 日期直接展示给你。</p>
        </div>
        <div className="settings-section">
          <h2>设备会话</h2>
          {devices.map((device) => (
            <div className="device-row" key={device.id}>
              <span className="device-icon">
                <LayoutList size={16} />
              </span>
              <span>
                <strong>{device.name}</strong>
                <small>
                  {device.platform} · 最近活动 {formatTime(device.lastSeenAt)}
                </small>
              </span>
              {device.revokedAt ? (
                <span className="muted-label">已撤销</span>
              ) : (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() =>
                    void request(`/devices/${device.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({}),
                    }).then(() =>
                      setDevices((current) =>
                        current.map((item) =>
                          item.id === device.id
                            ? { ...item, revokedAt: new Date().toISOString() }
                            : item,
                        ),
                      ),
                    )
                  }
                >
                  撤销
                </button>
              )}
            </div>
          ))}
        </div>
        <ConflictSection />
        <RejectedMutationSection />
        <div className="settings-actions">
          <button type="submit" className="primary-button">
            保存设置
          </button>
          {saved && (
            <span className="save-state">
              <Check size={15} />
              {saved}
            </span>
          )}
          {error && <span className="form-error">{error}</span>}
        </div>
      </form>
    </div>
  );
}

function HubSettingsSection() {
  const auth = useAuth();
  const [origin, setOrigin] = useState(getConfiguredHubOrigin() ?? '');
  const [state, setState] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const save = async () => {
    if (state === 'checking' || !origin.trim()) return;
    setState('checking');
    setMessage('正在测试连接…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const nextOrigin = normalizeHubOrigin(origin);
      const status = await testHubConnection(nextOrigin, controller.signal);
      const currentOrigin = getConfiguredHubOrigin();
      if (currentOrigin !== nextOrigin) await auth.logout();
      await setHubOrigin(nextOrigin);
      setState('success');
      setMessage(status.initialized ? '连接成功，正在切换中枢…' : '连接成功，等待中枢初始化…');
      window.setTimeout(() => window.location.reload(), 250);
    } catch (cause) {
      setState('error');
      setMessage(
        cause instanceof DOMException && cause.name === 'AbortError'
          ? '连接超时，请检查地址、证书和网络'
          : cause instanceof Error
            ? cause.message
            : '无法连接中枢',
      );
    } finally {
      window.clearTimeout(timeout);
    }
  };
  return (
    <div className="settings-section hub-settings-section">
      <h2>中枢连接</h2>
      <p className="field-help">
        修改前会先测试新地址。切换后会清理当前设备会话并重新载入，旧中枢的 refresh token
        不会带到新中枢。
      </p>
      <label className="field">
        <span>中枢地址</span>
        <input
          type="url"
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value);
            setState('idle');
            setMessage('');
          }}
          placeholder="https://todo.example.com 或 http://192.168.1.10"
          autoComplete="url"
        />
      </label>
      {isHttpOrigin(origin) && (
        <div className="http-security-warning" role="alert">
          <strong>当前地址使用 HTTP</strong>
          <span>密码和会话信息会以明文传输，请确认网络可信；正式公网部署仍建议使用 HTTPS。</span>
        </div>
      )}
      <div className="hub-check-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void save()}
          disabled={state === 'checking' || !origin.trim()}
        >
          {state === 'checking' ? '测试中…' : '测试并保存'}
        </button>
        {message && (
          <span className={`hub-check-message ${state}`} role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

function ConflictSection() {
  const { db, engine } = useAuth();
  const [items, setItems] = useState<ConflictRecord[]>([]);
  const reload = useCallback(async () => {
    if (!db) {
      setItems([]);
      return;
    }
    setItems((await db.conflicts.toArray()).filter((item) => !item.resolvedAt));
  }, [db]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [reload]);
  if (!items.length) return null;
  return (
    <div className="settings-section conflict-inbox">
      <h2>待处理冲突</h2>
      <p className="field-help">同步不会静默覆盖较新的版本。请选择每条本地改动如何处理。</p>
      {items.map((item) => (
        <ConflictInboxItem
          key={item.id ?? item.mutationId}
          item={item}
          engine={engine}
          onResolved={reload}
        />
      ))}
    </div>
  );
}

function ConflictInboxItem({
  item,
  engine,
  onResolved,
}: {
  item: ConflictRecord;
  engine: ReturnType<typeof useAuth>['engine'];
  onResolved: () => Promise<void>;
}) {
  const server =
    isRecord(item.server) && isRecord(item.server['server']) ? item.server['server'] : item.server;
  const [merged, setMerged] = useState(() => {
    if (item.entityType === 'note') {
      if (typeof item.local === 'string') return item.local;
      return isRecord(item.local) && typeof item.local['contentMarkdown'] === 'string'
        ? item.local['contentMarkdown']
        : '';
    }
    const base = isRecord(server) ? server : {};
    return JSON.stringify({ ...base, ...(isRecord(item.local) ? item.local : {}) }, null, 2);
  });
  const [error, setError] = useState('');
  const restoreAvailable =
    isRecord(server) &&
    Boolean(server['archivedAt']) &&
    ['project', 'task', 'timePoint'].includes(item.entityType);
  // Older IndexedDB conflict rows do not have command; keep them resolvable,
  // but do not expose a merge action unless the command is known.
  const mergeSupported = isMergeableConflictCommand(item.command ?? '');
  const resolve = async (strategy: 'server' | 'local' | 'merged' | 'discard' | 'restore') => {
    if (!engine || item.id === undefined) return;
    setError('');
    try {
      let value: unknown;
      if (strategy === 'merged') {
        if (item.entityType === 'note') value = merged;
        else {
          try {
            value = JSON.parse(merged) as unknown;
          } catch {
            setError('合并内容必须是有效 JSON');
            return;
          }
        }
      }
      await engine.resolveConflict(item.id, strategy, value);
      await onResolved();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '冲突处理失败');
    }
  };
  return (
    <div className="inbox-conflict">
      <div className="conflict-inbox-head">
        <strong>
          {item.entityType} · {item.entityId.slice(0, 8)}
        </strong>
        <span>{formatTime(item.createdAt)}</span>
      </div>
      <div className="conflict-columns">
        <div>
          <span>本地意图</span>
          <pre>{JSON.stringify(item.local, null, 2)}</pre>
        </div>
        <div>
          <span>服务器版本</span>
          <pre>{JSON.stringify(server, null, 2)}</pre>
        </div>
      </div>
      {mergeSupported && (
        <label className="conflict-merge-field">
          <span>{item.entityType === 'note' ? '编辑合并后的备注' : '编辑合并后的字段 JSON'}</span>
          <textarea
            aria-label="编辑合并版本"
            value={merged}
            onChange={(event) => setMerged(event.target.value)}
            rows={item.entityType === 'note' ? 5 : 7}
          />
        </label>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="conflict-actions">
        <button
          type="button"
          className="secondary-button small"
          onClick={() => void resolve('server')}
        >
          采用服务器版本
        </button>
        <button
          type="button"
          className="secondary-button small"
          onClick={() => void resolve('local')}
        >
          保留本地并重试
        </button>
        {restoreAvailable && (
          <button
            type="button"
            className="secondary-button small"
            onClick={() => void resolve('restore')}
          >
            恢复后应用本地
          </button>
        )}
        {mergeSupported && (
          <button
            type="button"
            className="primary-button small"
            onClick={() => void resolve('merged')}
          >
            保存合并版本
          </button>
        )}
        <button
          type="button"
          className="danger-button small"
          onClick={() => void resolve('discard')}
        >
          丢弃本地改动
        </button>
      </div>
    </div>
  );
}

function RejectedMutationSection() {
  const { db, engine } = useAuth();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const reload = useCallback(async () => {
    if (!db) {
      setItems([]);
      return;
    }
    setItems(
      (await db.outbox.toArray()).filter(
        (item) => Boolean(item.lastError) && item.nextAttemptAt === Number.MAX_SAFE_INTEGER,
      ),
    );
  }, [db]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [reload]);
  if (!items.length) return null;
  return (
    <div className="settings-section rejected-inbox">
      <h2>待重试的失败操作</h2>
      <p className="field-help">服务器拒绝的本地操作已暂停，不会在后台无限重复提交。</p>
      {items.map((item) => (
        <div className="rejected-mutation" key={item.id ?? item.mutationId}>
          <span>
            <strong>{item.command}</strong>
            <small>
              {item.entityId.slice(0, 8)} · {item.lastError}
            </small>
          </span>
          <div className="rejected-actions">
            <button
              type="button"
              className="secondary-button small"
              onClick={() =>
                void engine?.retryRejectedMutation(item.mutationId).then(() => {
                  void reload();
                  void engine.sync().catch(() => undefined);
                })
              }
            >
              重试
            </button>
            <button
              type="button"
              className="text-button danger-text"
              onClick={() =>
                void engine?.discardRejectedMutation(item.mutationId).then(() => void reload())
              }
            >
              丢弃
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskDetail({
  taskId,
  onClose,
  onChanged,
}: {
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<{
    task: TaskDto;
    note: NoteDto;
    placements: PlacementDto[];
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [timePoints, setTimePoints] = useState<TimePointDto[]>([]);
  const [placementTarget, setPlacementTarget] = useState('');
  const [conflict, setConflict] = useState<{
    kind: 'task' | 'note';
    local: Record<string, unknown> | string;
    server: TaskDto | NoteDto;
  } | null>(null);
  const [mergedConflict, setMergedConflict] = useState('');
  const presence = usePresence(Boolean(taskId));
  const loadDetail = useCallback(async () => {
    if (!taskId) return;
    const next = await request<{ task: TaskDto; note: NoteDto; placements: PlacementDto[] }>(
      `/tasks/${taskId}`,
    );
    setDetail(next);
    setDraft(next.note.contentMarkdown);
    setError('');
  }, [taskId]);
  useEffect(() => {
    void loadDetail().catch((cause) =>
      setError(cause instanceof ApiError ? cause.message : '任务详情加载失败'),
    );
  }, [loadDetail]);
  useEffect(() => {
    void requestAll<ProjectDto>('/projects').then((items) => setProjects(items));
    void requestAll<TimePointDto>('/time-points?archived=false').then((items) =>
      setTimePoints(items),
    );
  }, [taskId]);
  if (!presence.mounted || !taskId || !detail) return null;
  const saveTask = async (patch: Record<string, unknown>) => {
    try {
      const task = (await mutation('PATCH', `/tasks/${detail.task.id}`, {
        ...patch,
        baseVersion: detail.task.version,
      })) as TaskDto;
      setDetail((current) => (current ? { ...current, task } : current));
      setConflict(null);
      setError('');
      onChanged();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === 'VERSION_CONFLICT' &&
        isRecord(cause.details) &&
        isRecord(cause.details['server'])
      ) {
        setConflict({
          kind: 'task',
          local: patch,
          server: cause.details['server'] as unknown as TaskDto,
        });
        setMergedConflict(
          JSON.stringify(
            {
              ...(cause.details['server'] as Record<string, unknown>),
              ...patch,
            },
            null,
            2,
          ),
        );
      }
      setError(cause instanceof ApiError ? cause.message : '任务保存失败');
    }
  };
  const saveNote = async () => {
    setSaving(true);
    try {
      const note = (await mutation('PUT', `/tasks/${detail.task.id}/note`, {
        contentMarkdown: draft,
        baseVersion: detail.note.version,
      })) as NoteDto;
      setDetail((current) => (current ? { ...current, note } : current));
      setConflict(null);
      setError('');
      onChanged();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === 'VERSION_CONFLICT' &&
        isRecord(cause.details) &&
        isRecord(cause.details['server'])
      ) {
        setConflict({
          kind: 'note',
          local: draft,
          server: cause.details['server'] as unknown as NoteDto,
        });
        setMergedConflict(draft);
      }
      setError(cause instanceof ApiError ? cause.message : '备注保存失败');
    } finally {
      setSaving(false);
    }
  };
  const resolveConflict = async (strategy: 'server' | 'local' | 'merged' | 'restore') => {
    if (!conflict) return;
    if (strategy === 'server') {
      if (conflict.kind === 'task')
        setDetail((current) =>
          current ? { ...current, task: conflict.server as TaskDto } : current,
        );
      else {
        const note = conflict.server as NoteDto;
        setDetail((current) => (current ? { ...current, note } : current));
        setDraft(note.contentMarkdown);
      }
      setConflict(null);
      setMergedConflict('');
      setError('已采用服务器版本');
      return;
    }
    try {
      const localPatch =
        strategy === 'merged'
          ? (() => {
              try {
                return JSON.parse(mergedConflict) as Record<string, unknown>;
              } catch {
                throw new Error('合并内容必须是有效 JSON');
              }
            })()
          : (conflict.local as Record<string, unknown>);
      if (strategy === 'restore') {
        if (conflict.kind !== 'task' || !(conflict.server as TaskDto).archivedAt)
          throw new Error('当前冲突不支持恢复后应用');
        const restored = (await mutation('POST', `/tasks/${detail.task.id}/restore`, {
          baseVersion: conflict.server.version,
        })) as TaskDto;
        const task = (await mutation('PATCH', `/tasks/${detail.task.id}`, {
          ...localPatch,
          baseVersion: restored.version,
        })) as TaskDto;
        setDetail((current) => (current ? { ...current, task } : current));
      } else if (conflict.kind === 'task') {
        const task = (await mutation('PATCH', `/tasks/${detail.task.id}`, {
          ...localPatch,
          baseVersion: conflict.server.version,
        })) as TaskDto;
        setDetail((current) => (current ? { ...current, task } : current));
      } else {
        const note = (await mutation('PUT', `/tasks/${detail.task.id}/note`, {
          contentMarkdown: strategy === 'merged' ? mergedConflict : String(conflict.local),
          baseVersion: conflict.server.version,
        })) as NoteDto;
        setDetail((current) => (current ? { ...current, note } : current));
      }
      setConflict(null);
      setMergedConflict('');
      setError('');
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '重新保存失败');
    }
  };
  const addPlacement = async () => {
    if (!placementTarget) return;
    try {
      await mutation('POST', '/placements', {
        taskId: detail.task.id,
        timePointId: placementTarget,
      });
      setPlacementTarget('');
      await loadDetail();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '安排任务失败');
    }
  };
  const removePlacement = async (placement: PlacementDto) => {
    try {
      await mutation('DELETE', `/placements/${placement.id}`, { baseVersion: placement.version });
      await loadDetail();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '移除安排失败');
    }
  };
  const duplicateTask = async () => {
    try {
      await mutation('POST', `/tasks/${detail.task.id}/duplicate`, {});
      setNotice('已复制任务，原任务保持不变');
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '复制任务失败');
    }
  };
  const archiveOrRestore = async () => {
    try {
      const action = detail.task.archivedAt ? 'restore' : 'archive';
      await mutation('POST', `/tasks/${detail.task.id}/${action}`, {
        baseVersion: detail.task.version,
      });
      onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '归档操作失败');
    }
  };
  return (
    <aside
      className={`detail-panel presence-${presence.state}`}
      aria-label="任务详情"
      aria-hidden={presence.state === 'exiting'}
    >
      <div className="detail-header">
        <div>
          <span className="reference-id">{detail.task.referenceId || '待同步分配'}</span>
          <span className="detail-sync">{saving ? '本地保存中…' : '已保存'}</span>
        </div>
        <button className="icon-button" aria-label="关闭任务详情" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="detail-scroll">
        <input
          className="detail-title-input"
          value={detail.task.title}
          onChange={(event) =>
            setDetail({ ...detail, task: { ...detail.task, title: event.target.value } })
          }
          onBlur={() => void saveTask({ title: detail.task.title })}
        />
        <div className="detail-fields">
          <label className="field">
            <span>状态</span>
            <select
              value={detail.task.status}
              onChange={(event) => void saveTask({ status: event.target.value })}
            >
              <option value="TODO">待开始</option>
              <option value="IN_PROGRESS">进行中</option>
              <option value="DONE">已完成</option>
            </select>
          </label>
          <label className="field">
            <span>优先级</span>
            <select
              value={detail.task.priority}
              onChange={(event) => void saveTask({ priority: event.target.value })}
            >
              <option value="NONE">无</option>
              <option value="LOW">低</option>
              <option value="MEDIUM">中</option>
              <option value="HIGH">高</option>
            </select>
          </label>
          <label className="field">
            <span>项目</span>
            <select
              value={detail.task.projectId ?? ''}
              onChange={(event) => {
                const projectId = event.target.value || null;
                void saveTask({ projectId, category: projectId ? detail.task.category : 'MISC' });
              }}
            >
              <option value="">全局杂项</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>分类</span>
            <select
              value={detail.task.category}
              disabled={!detail.task.projectId}
              onChange={(event) => void saveTask({ category: event.target.value })}
            >
              <option value="FEATURE">功能</option>
              <option value="MISC">杂项</option>
            </select>
          </label>
        </div>
        {conflict && (
          <div className="conflict-panel" role="alert">
            <strong>检测到服务器版本较新</strong>
            <p>本地改动没有覆盖服务器内容，请选择保留哪一版。</p>
            <div className="conflict-columns">
              <div>
                <span>本地版本</span>
                <pre>
                  {typeof conflict.local === 'string'
                    ? conflict.local
                    : JSON.stringify(conflict.local, null, 2)}
                </pre>
              </div>
              <div>
                <span>服务器版本</span>
                <pre>
                  {conflict.kind === 'note'
                    ? (conflict.server as NoteDto).contentMarkdown
                    : JSON.stringify(conflict.server, null, 2)}
                </pre>
              </div>
            </div>
            <label className="conflict-merge-field">
              <span>{conflict.kind === 'note' ? '编辑合并后的备注' : '编辑合并后的任务 JSON'}</span>
              <textarea
                aria-label="编辑任务详情合并版本"
                value={mergedConflict}
                onChange={(event) => setMergedConflict(event.target.value)}
                rows={conflict.kind === 'note' ? 5 : 7}
              />
            </label>
            <div className="conflict-actions">
              <button
                className="secondary-button small"
                onClick={() => void resolveConflict('server')}
              >
                采用服务器版本
              </button>
              <button
                className="secondary-button small"
                onClick={() => void resolveConflict('local')}
              >
                保留本地并重试
              </button>
              {conflict.kind === 'task' && (conflict.server as TaskDto).archivedAt && (
                <button
                  className="secondary-button small"
                  onClick={() => void resolveConflict('restore')}
                >
                  恢复后应用本地
                </button>
              )}
              <button
                className="primary-button small"
                onClick={() => void resolveConflict('merged')}
              >
                保存合并版本
              </button>
              <button
                className="danger-button small"
                onClick={() => {
                  if (conflict.kind === 'task') {
                    setDetail((current) =>
                      current ? { ...current, task: conflict.server as TaskDto } : current,
                    );
                  } else {
                    const note = conflict.server as NoteDto;
                    setDetail((current) => (current ? { ...current, note } : current));
                    setDraft(note.contentMarkdown);
                  }
                  setConflict(null);
                  setMergedConflict('');
                  setError('已丢弃本地改动，保留服务器版本');
                }}
              >
                丢弃本地改动
              </button>
            </div>
          </div>
        )}
        <div className="note-editor">
          <div className="editor-tabs">
            <button className={!preview ? 'selected' : ''} onClick={() => setPreview(false)}>
              编辑
            </button>
            <button className={preview ? 'selected' : ''} onClick={() => setPreview(true)}>
              预览
            </button>
            <span>{saving ? '保存中' : 'Markdown'}</span>
          </div>
          {preview ? (
            <SafeMarkdown markdown={draft} />
          ) : (
            <textarea
              aria-label="任务 Markdown 备注"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void saveNote()}
              placeholder="记录上下文、代码片段或下一步…"
            />
          )}
        </div>
        <div className="detail-meta">
          <MetaRow label="创建于" value={formatTime(detail.task.createdAt)} />
          <MetaRow label="更新于" value={formatTime(detail.task.updatedAt)} />
          <MetaRow
            label="完成于"
            value={detail.task.completedAt ? formatTime(detail.task.completedAt) : '未完成'}
          />
          <MetaRow label="安排位置" value={`${detail.placements.length} 个`} />
        </div>
        <div className="detail-placements">
          <div className="detail-subhead">
            <strong>安排位置</strong>
            <span>同一任务可出现在多个日期或事件</span>
          </div>
          {detail.placements.map((placement) => (
            <div className="detail-placement" key={placement.id}>
              <span>{timePointLabel(timePoints, placement.timePointId)}</span>
              <button
                className="text-button danger-text"
                onClick={() => void removePlacement(placement)}
              >
                从此处移除
              </button>
            </div>
          ))}
          <div className="placement-add">
            <select
              aria-label="选择安排时间点"
              value={placementTarget}
              onChange={(event) => setPlacementTarget(event.target.value)}
            >
              <option value="">选择时间点…</option>
              {timePoints
                .filter((point) => !detail.placements.some((item) => item.timePointId === point.id))
                .map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.type === 'DATE' ? point.localDate : point.title}
                  </option>
                ))}
            </select>
            <button
              className="secondary-button small"
              onClick={() => void addPlacement()}
              disabled={!placementTarget}
            >
              <Plus size={14} />
              安排
            </button>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {notice && <div className="save-state">{notice}</div>}
        <div className="detail-actions">
          <button className="secondary-button" onClick={() => void saveNote()} disabled={saving}>
            {saving ? '保存中…' : '保存备注'}
          </button>
          <button className="secondary-button small" onClick={() => void duplicateTask()}>
            <Copy size={15} />
            复制任务
          </button>
          <button className="text-button danger-text" onClick={() => void archiveOrRestore()}>
            {detail.task.archivedAt ? '恢复任务' : '归档任务'}
          </button>
        </div>
      </div>
    </aside>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SafeMarkdown({ markdown }: { markdown: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    const references = [...new Set(markdown.match(/\b(?:[A-Z][A-Z0-9]{1,9}|MISC)-\d+\b/g) ?? [])];
    void Promise.all([
      import('marked'),
      import('dompurify'),
      Promise.all(
        references.map(async (reference) => {
          try {
            const result = await request<{ items: Array<{ task: TaskDto }> }>(
              `/search/tasks?q=${encodeURIComponent(reference)}`,
            );
            const match = result.items.find(({ task }) => task.referenceId === reference);
            return match ? ([reference, match.task.id] as const) : null;
          } catch {
            return null;
          }
        }),
      ),
    ]).then(([{ marked }, { default: DOMPurify }, resolvedReferences]) => {
      if (cancelled) return;
      const safe = DOMPurify.sanitize(marked.parse(markdown) as string, {
        USE_PROFILES: { html: false },
      });
      setHtml(
        linkTaskReferences(safe, new Map(resolvedReferences.filter(Boolean) as [string, string][])),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [markdown]);
  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function linkTaskReferences(html: string, references: Map<string, string>): string {
  if (!references.size || typeof DOMParser === 'undefined') return html;
  const document = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = document.body.firstElementChild;
  if (!root) return html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.parentElement && !current.parentElement.closest('a, code, pre'))
      nodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const pattern = /\b(?:[A-Z][A-Z0-9]{1,9}|MISC)-\d+\b/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const fragment = document.createDocumentFragment();
    let replaced = false;
    while ((match = pattern.exec(text))) {
      const taskId = references.get(match[0]);
      if (!taskId) continue;
      replaced = true;
      if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));
      const link = document.createElement('a');
      link.href = `?task=${encodeURIComponent(taskId)}`;
      link.textContent = match[0];
      fragment.append(link);
      lastIndex = match.index + match[0].length;
    }
    if (replaced) {
      if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
      node.replaceWith(fragment);
    }
  }
  for (const link of root.querySelectorAll('a')) {
    if (link.protocol === 'http:' || link.protocol === 'https:') {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  return root.innerHTML;
}

async function restoreEntity(path: string, baseVersion: number): Promise<void> {
  await mutation('POST', `${path}/restore`, { baseVersion });
  window.dispatchEvent(new Event('devtodo:data-changed'));
}
function timePointLabel(points: TimePointDto[], id: string): string {
  const point = points.find((candidate) => candidate.id === id);
  if (!point) return '未知时间点';
  return point.type === 'DATE' ? `日期 · ${point.localDate}` : `事件 · ${point.title}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isHttpOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

function breadcrumb(pathname: string): string {
  if (pathname.startsWith('/today')) return '今日';
  if (pathname.startsWith('/tasks')) return '任务库';
  if (pathname.startsWith('/projects')) return '项目';
  if (pathname.startsWith('/inbox') || pathname.startsWith('/misc')) return '收集箱';
  if (pathname.startsWith('/time/calendar')) return '时间 / 日历';
  if (pathname.startsWith('/time/events')) return '时间 / 时间点';
  if (pathname.startsWith('/archive')) return '归档';
  if (pathname.startsWith('/settings')) return '设置';
  return 'TaskDock';
}
function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values['year']}-${values['month']}-${values['day']}`;
}
function formatDate(localDate: string): string {
  const date = new Date(`${localDate}T12:00:00`);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date);
}
function formatMonth(month: string): string {
  const date = new Date(`${month}-01T12:00:00`);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(date);
}
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
function shiftLocalDate(localDate: string, delta: number): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function weekdayLabels(weekStartsOn: 0 | 1): string[] {
  const mondayFirst = ['一', '二', '三', '四', '五', '六', '日'];
  return weekStartsOn === 1 ? mondayFirst : ['日', ...mondayFirst.slice(0, 6)];
}
interface CalendarDay {
  date: string;
  label: number;
  inMonth: boolean;
  taskCount: number;
}
function calendarDays(month: string, weekStartsOn: 0 | 1 = 1): CalendarDay[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, monthNumber! - 1, 1));
  const offset = weekStartsOn === 1 ? (first.getUTCDay() + 6) % 7 : first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  const previousDays = new Date(Date.UTC(year!, monthNumber! - 1, 0)).getUTCDate();
  return Array.from({ length: 42 }, (_, index) => {
    const dayIndex = index - offset + 1;
    const date = new Date(Date.UTC(year!, monthNumber! - 1, dayIndex));
    const inMonth = dayIndex >= 1 && dayIndex <= daysInMonth;
    return {
      date: date.toISOString().slice(0, 10),
      label: inMonth ? dayIndex : dayIndex < 1 ? previousDays + dayIndex : dayIndex - daysInMonth,
      inMonth,
      taskCount: 0,
    };
  });
}
