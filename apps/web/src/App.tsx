import type {
  ArchiveOperationSummaryDto,
  FolderDto,
  PlacementDto,
  TaskDto,
  TimePointDto,
  TimePointPlacementCountDto,
  TreeTaskDto,
  V2SettingsDto,
} from '@devtodo/contracts';
import {
  isMergeableConflictCommand,
  readUpgradePending,
  type ConflictRecord,
  type OutboxItem,
  type UpgradePendingMutation,
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
  Folder,
  Command,
  Copy,
  LayoutList,
  ListChecks as ListChecksIcon,
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
  Workflow as WorkflowIcon,
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
  getConfiguredHubOrigin,
  getHubOriginLoadError,
  isDesktopClient,
  isDesktopShell,
  isNativeClient,
  isNativeMobileClient,
  isWindowsDesktop,
  loadConfiguredHubOrigin,
  normalizeHubOrigin,
  mutationV2,
  requestV1,
  requestV2,
  setHubOrigin,
  testHubConnection,
} from './api.js';
import { useAuth } from './auth.js';
import { BrandMark } from './components/brand-mark.js';
import {
  Button,
  ButtonGroup,
  Chip,
  ConfirmDialog,
  Dialog as M3eDialog,
  FabMenu,
  IconButton,
  LinearProgress,
  NavigationBar,
  NavigationDrawer,
  NavigationRail,
  SearchBar,
  SplitButton,
  Select,
  Snackbar,
  TextField,
  TopAppBar,
  Toolbar,
  SPRING_DURATION,
  isCompactShell,
  useWindowSizeClass,
  type NavigationDestination,
} from './components/m3e/index.js';
import { useDismissibleMenu } from './components/m3e/behavior.js';
import { PwaLifecycleNotice } from './pwa.js';
import { AllTasksV2Page, TaskDetailV2Overlay, TreePage, WorkflowsPage } from './TreePage.js';
import { readRecentCaptureFolder } from './folder-preference.js';
import { nextTaskStatus, taskStatusActionLabel } from './task-behavior.js';

type PlacementWithTask = PlacementDto & { task: TreeTaskDto };
type PresenceState = 'entering' | 'present' | 'exiting';

/**
 * Overlay lifecycle helper. The exit duration comes from the M3E spring tokens
 * (see `scripts/motion-tokens.ts`) so a component can never unmount before its
 * close transition has visually finished.
 */
function usePresence(open: boolean, exitDuration: number = SPRING_DURATION.effects) {
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
  const showPwaNotice =
    !isNativeClient() &&
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:');
  return (
    <DesktopChrome>
      {showPwaNotice && <PwaLifecycleNotice />}
      {content}
    </DesktopChrome>
  );
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
          <BrandMark size="lg" />
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
        <Button
          variant="filled"
          className="m3e-button--wide"
          type="button"
          onClick={() => window.location.reload()}
        >
          重新加载客户端
        </Button>
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
      else {
        const loadError = getHubOriginLoadError();
        setMessage(loadError?.includes('尚未配置') ? '' : (loadError ?? ''));
        setPhase('setup');
      }
    });
    return () => {
      active = false;
    };
  }, [verify]);

  useEffect(() => {
    let active = true;
    if (auth.status === 'anonymous') {
      void loadConfiguredHubOrigin().then((currentOrigin) => {
        if (!active) return;
        setOrigin(currentOrigin);
        if (!currentOrigin) {
          const loadError = getHubOriginLoadError();
          setMessage(loadError?.includes('尚未配置') ? '' : (loadError ?? ''));
          setPhase('setup');
        }
      });
    }
    return () => {
      active = false;
    };
  }, [auth.status]);

  const handleConnected = useCallback((nextOrigin: string, initialized: boolean) => {
    setOrigin(nextOrigin);
    setMessage('');
    setPhase(initialized ? 'ready' : 'waiting');
  }, []);
  const handleChangeOrigin = useCallback(() => {
    setPhase('setup');
    setMessage('');
  }, []);
  const finishSwitch = useCallback(
    async (nextOrigin: string, previousOrigin: string | null) => {
      if (previousOrigin && previousOrigin !== nextOrigin) await auth.logout();
    },
    [auth],
  );

  if (phase === 'setup')
    return (
      <HubSetupScreen
        initialOrigin={origin ?? ''}
        errorMessage={message}
        onConnected={handleConnected}
        afterSave={finishSwitch}
      />
    );
  if (phase === 'checking') return <LoadingScreen label="正在连接中枢" />;
  if (phase === 'error')
    return (
      <HubSetupScreen
        initialOrigin={origin ?? ''}
        errorMessage={message}
        onConnected={handleConnected}
        afterSave={finishSwitch}
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
  afterSave,
}: {
  initialOrigin: string;
  errorMessage: string;
  onConnected: (origin: string, initialized: boolean) => void;
  afterSave?: (origin: string, previousOrigin: string | null) => Promise<void>;
}) {
  const [origin, setOrigin] = useState(initialOrigin);
  const [state, setState] = useState<'idle' | 'checking' | 'error'>(
    errorMessage ? 'error' : 'idle',
  );
  const [message, setMessage] = useState(errorMessage);
  const originEdited = useRef(false);

  useEffect(() => {
    setMessage(errorMessage);
    if (errorMessage) setState('error');
  }, [errorMessage]);
  useEffect(() => {
    if (!originEdited.current) setOrigin(initialOrigin);
  }, [initialOrigin]);

  const connect = async () => {
    if (state === 'checking' || !origin.trim()) return;
    setState('checking');
    setMessage('正在测试连接…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const normalized = normalizeHubOrigin(origin);
      const status = await testHubConnection(normalized, controller.signal);
      const previousOrigin = getConfiguredHubOrigin();
      const saved = await setHubOrigin(normalized);
      await afterSave?.(saved, previousOrigin);
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
          <BrandMark size="lg" />
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">DESKTOP CONNECTION</p>
        <h1>{origin ? '连接中枢' : '配置中枢地址'}</h1>
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
              originEdited.current = true;
              setOrigin(value);
              setState('idle');
              setMessage('');
            }}
            type="url"
            autoComplete="url"
            autoFocus={!origin}
          />
          <p className="field-help">
            例如 https://todo.example.com、http://your-hub.example:48731 或
            http://localhost:3000。HTTP 地址会显示安全提示。
          </p>
          <Button
            variant="filled"
            className="m3e-button--wide"
            type="button"
            onClick={() => void connect()}
            disabled={state === 'checking' || !origin.trim()}
          >
            {state === 'checking' ? <LoaderCircle className="spin" size={18} /> : '测试并连接'}
          </Button>
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
          <BrandMark size="lg" />
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
          <Button variant="filled" type="button" onClick={onRetry}>
            重新检查
          </Button>
          <Button variant="tonal" type="button" onClick={onChangeOrigin}>
            更换中枢
          </Button>
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
  const navigate = useNavigate();
  const sizeClass = useWindowSizeClass();
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickKind, setQuickKind] = useState<'task'>('task');
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileActionOpen, setMobileActionOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useSearchParams();
  const activeFolderId = /^\/tree\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  const defaultTaskFolderId =
    activeFolderId ?? readRecentCaptureFolder(auth.settings?.defaultCaptureTarget);

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
  const navItems = useMemo<NavigationDestination[]>(
    () => [
      { to: '/today', label: '今日', icon: <Target size={20} /> },
      { to: '/tree', label: '目录', icon: <LayoutList size={20} /> },
      { to: '/tasks', label: '所有任务', icon: <ListChecksIcon size={20} /> },
      { to: '/workflows', label: '流程', icon: <WorkflowIcon size={20} /> },
      { to: '/time/calendar', label: '日历', icon: <CalendarDays size={20} /> },
      { to: '/time/events', label: '时间点', icon: <Clock3 size={20} /> },
      { to: '/archive', label: '归档', icon: <Archive size={20} /> },
      { to: '/settings', label: '设置', icon: <Settings size={20} /> },
    ],
    [],
  );
  /* The compact shell keeps five destinations; the rest live under /more. */
  const compactNavItems = useMemo<NavigationDestination[]>(
    () => [
      { to: '/today', label: '今日', icon: <Target size={22} /> },
      { to: '/tree', label: '目录', icon: <LayoutList size={22} /> },
      { to: '/workflows', label: '流程', icon: <WorkflowIcon size={22} /> },
      { to: '/time', label: '时间', icon: <Clock3 size={22} /> },
      { to: '/more', label: '更多', icon: <MoreHorizontal size={22} /> },
    ],
    [],
  );
  const activeRoot = useMemo(() => {
    const path = location.pathname;
    return (
      compactNavItems.find((item) => path === item.to || path.startsWith(`${item.to}/`))?.to ??
      compactNavItems[0]!.to
    );
  }, [compactNavItems, location.pathname]);
  const activeExpanded = useMemo(() => {
    const path = location.pathname;
    return navItems.find((item) => path === item.to || path.startsWith(`${item.to}/`))?.to ?? '';
  }, [location.pathname, navItems]);
  /** Navigating to a folder detail should still highlight 目录. */
  const activeForExpanded = activeExpanded || '/tree';

  /*
   * Navigation destinations are rendered as router links so middle-click and
   * "open in new tab" keep working and assistive tech announces a link.
   */
  const navLinkComponent = useMemo(
    () =>
      function NavDestinationLink({
        to,
        className,
        children,
        'aria-current': ariaCurrent,
        tabIndex,
        onClick,
      }: {
        to: string;
        className?: string;
        children: ReactNode;
        'aria-current'?: 'page' | undefined;
        tabIndex?: number;
        onClick?: () => void;
      }) {
        return (
          <NavLink
            to={to}
            className={className}
            aria-current={ariaCurrent}
            tabIndex={tabIndex}
            onClick={onClick}
          >
            {children}
          </NavLink>
        );
      },
    [],
  );

  const drawerHeader = (
    <div className="brand">
      <BrandMark />
      <span>TaskDock</span>
    </div>
  );
  const drawerFooter = (
    <>
      <ConnectionStatus />
      <button className="user-chip" onClick={() => void auth.logout()} title="退出当前设备">
        <span className="avatar">{auth.user?.username?.slice(0, 1).toUpperCase() ?? '?'}</span>
        <span className="user-name">{auth.user?.username}</span>
        <LogOut size={16} />
      </button>
    </>
  );

  return (
    <div className="app-frame">
      {sizeClass === 'medium' && (
        <NavigationRail
          label="主导航"
          destinations={navItems}
          activeTo={activeForExpanded}
          onNavigate={navigate}
          linkAs={navLinkComponent}
          header={<BrandMark size="sm" />}
          footer={<ConnectionStatus />}
        />
      )}
      {!isCompactShell(sizeClass) && sizeClass !== 'medium' && (
        /* Expanded and up: the drawer is persistent, so it is never modal. */
        <NavigationDrawer
          open
          onClose={() => undefined}
          modal={false}
          side="start"
          label="主导航"
          destinations={navItems}
          activeTo={activeForExpanded}
          onNavigate={navigate}
          linkAs={navLinkComponent}
          header={drawerHeader}
          footer={drawerFooter}
          className="m3e-drawer-layer--persistent"
        />
      )}
      <main className="main-shell">
        <TopAppBar
          variant={sizeClass === 'compact' ? 'small' : 'large'}
          title={breadcrumb(location.pathname)}
          leading={
            isCompactShell(sizeClass) ? (
              <IconButton
                label="打开侧边栏"
                aria-expanded={mobileSidebarOpen}
                onClick={() => setMobileSidebarOpen(true)}
              >
                <Menu size={22} />
              </IconButton>
            ) : undefined
          }
          actions={
            <>
              {sizeClass !== 'compact' ? (
                <Toolbar variant="floating" ariaLabel="工作区操作" className="app-toolbar">
                  <button
                    className="command-trigger"
                    aria-label="搜索任务和备注"
                    onClick={() => setCommandOpen(true)}
                  >
                    <Search size={20} />
                    <span>搜索任务、备注…</span>
                    {!isNativeMobileClient() && <kbd>⌘ K</kbd>}
                  </button>
                  <ConnectionStatus />
                  <SplitButton
                    icon={<Plus size={20} />}
                    label="快速添加"
                    onPrimary={() => {
                      setQuickKind('task');
                      setQuickOpen(true);
                    }}
                    options={[
                      { id: 'search', label: '搜索任务和备注', icon: <Search size={18} /> },
                      { id: 'tasks', label: '打开所有任务', icon: <ListChecksIcon size={18} /> },
                    ]}
                    onSelect={(id) => {
                      if (id === 'search') setCommandOpen(true);
                      if (id === 'tasks') navigate('/tasks');
                    }}
                    menuLabel="更多创建操作"
                  />
                </Toolbar>
              ) : (
                <IconButton label="搜索任务和备注" onClick={() => setCommandOpen(true)}>
                  <Search size={22} />
                </IconButton>
              )}
            </>
          }
        />
        <div className="page-wrap">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage onOpenTask={openTask} />} />
            <Route path="/tree" element={<TreePage />} />
            <Route path="/tree/:folderId" element={<TreePage />} />
            <Route path="/tasks" element={<AllTasksV2Page />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/projects" element={<Navigate to="/tree" replace />} />
            <Route path="/projects/:projectId" element={<Navigate to="/tree" replace />} />
            <Route path="/inbox" element={<Navigate to="/tree" replace />} />
            <Route path="/misc" element={<Navigate to="/tree" replace />} />
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
      {isCompactShell(sizeClass) && (
        <NavigationDrawer
          open={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
          label="移动侧边栏"
          destinations={navItems}
          activeTo={activeForExpanded}
          onNavigate={(to) => {
            navigate(to);
            setMobileSidebarOpen(false);
          }}
          linkAs={navLinkComponent}
          header={drawerHeader}
          footer={drawerFooter}
        />
      )}
      {sizeClass === 'compact' && (
        <NavigationBar
          label="移动导航"
          destinations={compactNavItems}
          activeTo={activeRoot}
          onNavigate={navigate}
          linkAs={navLinkComponent}
          className="mobile-bottom-nav"
        />
      )}
      {sizeClass === 'compact' && (
        <div role="region" aria-label="创建" className="app-float-layer">
          <FabMenu
            label="打开创建菜单"
            open={mobileActionOpen}
            onOpenChange={setMobileActionOpen}
            icon={<Plus size={24} />}
            items={[
              { id: 'task', label: '新建任务', icon: <Check size={20} /> },
              { id: 'search', label: '搜索任务', icon: <Search size={20} /> },
            ]}
            onSelect={(id) => {
              if (id === 'search') setCommandOpen(true);
              else {
                setQuickKind('task');
                setQuickOpen(true);
              }
            }}
          />
        </div>
      )}
      <QuickCaptureDialog
        open={quickOpen}
        initialKind={quickKind}
        defaultTaskFolderId={defaultTaskFolderId}
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
      <TaskDetailV2Overlay
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
  const hubOriginEdited = useRef(false);

  useEffect(() => setHubInitialized(initialized), [initialized]);
  useEffect(() => {
    let active = true;
    void loadConfiguredHubOrigin().then((configured) => {
      if (active && configured && !hubOriginEdited.current) setHubOriginValue(configured);
    });
    return () => {
      active = false;
    };
  }, []);

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
          <BrandMark size="lg" />
          <span>TaskDock</span>
        </div>
        <p className="eyebrow">PERSONAL DEV WORKSPACE</p>
        <h1>{hubInitialized ? '欢迎回来' : '等待中枢初始化'}</h1>
        <p className="auth-intro">一个任务本体，多处安排。离线时也能继续捕获和整理。</p>
        {desktopClient && onChangeHub && (
          <div className="hub-origin-card login-hub-origin">
            <span>当前中枢</span>
            <code>{hubOrigin}</code>
            <Button variant="text" type="button" onClick={onChangeHub}>
              更换中枢
            </Button>
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
                  hubOriginEdited.current = true;
                  setHubOriginValue(value);
                  setHubCheck('idle');
                  setHubCheckMessage('');
                }}
                type="url"
                autoComplete="url"
              />
              <div className="hub-check-row">
                <Button
                  variant="tonal"
                  type="button"
                  onClick={() => void checkHub()}
                  disabled={busy || hubCheck === 'checking' || !hubOrigin.trim()}
                >
                  {hubCheck === 'checking' ? '测试中…' : '测试连接'}
                </Button>
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
          <Button
            variant="filled"
            className="m3e-button--wide"
            type="submit"
            disabled={busy || !hubInitialized}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : '登录'}
          </Button>
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
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  error?: string;
}) {
  return (
    <TextField
      label={label}
      required
      type={type}
      value={value}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      error={error}
      /* The overlay focus trap looks for this marker; without it the dialog
         would focus its close button instead of the first field. */
      data-modal-autofocus={autoFocus ? 'true' : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
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
            <CalendarDays size={20} />
          </span>
          <span>
            <strong>日期日历</strong>
            <small>按月查看每日安排，今天是 {localDate}。</small>
          </span>
          <ChevronRight size={16} />
        </NavLink>
        <NavLink to="/time/events" className="more-link-card">
          <span className="more-link-icon">
            <Clock3 size={20} />
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
      to: '/archive',
      label: '归档',
      description: '恢复已归档的文件夹、任务和时间点。',
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
        description="次要入口集中在这里，底部导航保持专注于今天、目录和时间。"
      />
      <button className="more-search-button" onClick={onOpenSearch}>
        <Search size={18} />
        搜索任务、备注和引用 ID
      </button>
      <div className="more-grid">
        {links.map(({ to, label, description, icon: Icon }) => (
          <NavLink key={to} to={to} className="more-link-card">
            <span className="more-link-icon">
              <Icon size={20} />
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
    <main className="loading-screen" aria-busy="true">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <h1 className="m3e-visually-hidden">{label}</h1>
      <span aria-hidden="true">{label}</span>
    </main>
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
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="inline-error">
      <span>{error}</span>
      <Button variant="text" type="submit" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function useReloadable<T>(loader: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
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
      setHasLoaded(true);
    }
  }, [loader]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [reload]);
  // `loading` stays true across background revalidation. Views that would swap
  // interactive content for a skeleton should gate on `initialLoading` instead,
  // so an in-flight refresh never unmounts a button mid-interaction.
  return { data, setData, loading, initialLoading: loading && !hasLoaded, error, reload };
}

function QuickCapture({
  defaultTaskFolderId = null,
  onCreated,
}: {
  defaultTaskFolderId?: string | null;
  onCreated?: (task: TreeTaskDto) => Promise<void> | void;
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
      const result = (await mutationV2('POST', '/tasks', {
        parentFolderId: defaultTaskFolderId,
        title: title.trim(),
      })) as { task: TreeTaskDto };
      const task = result.task;
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
    <form className="quick-capture m3e-search-bar" onSubmit={submit}>
      <span className="m3e-search-bar__leading">
        <Plus size={20} />
      </span>
      <input
        className="m3e-search-bar__input"
        aria-label="快速创建任务"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="现在要记下什么？"
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
  defaultTaskFolderId,
  placeTaskOnToday = false,
  onClose,
}: {
  open: boolean;
  initialKind?: 'task';
  defaultTaskFolderId?: string | null;
  placeTaskOnToday?: boolean;
  onClose: () => void;
}) {
  const { settings } = useAuth();
  const kind = 'task' as const;
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setTitle('');
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
        // POST /api/v2/tasks returns { task, note }; unwrap `task` before
        // reading the id, otherwise the follow-up placement is rejected with
        // "taskId: Required" and the task never appears on Today.
        const created = (await mutationV2('POST', '/tasks', {
          parentFolderId: defaultTaskFolderId ?? null,
          title: title.trim(),
        })) as { task: TreeTaskDto };
        if (placeTaskOnToday) {
          const point = (await mutationV2('POST', '/time-points/date', {
            localDate: todayInTimezone(settings?.timezone ?? 'Asia/Shanghai'),
          })) as TimePointDto;
          await mutationV2('POST', '/placements', {
            taskId: created.task.id,
            timePointId: point.id,
          });
        }
      }
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
      <form onSubmit={submit} className="stack-form">
        <Field label="任务标题" value={title} onChange={setTitle} autoComplete="off" autoFocus />
        {kind === 'task' && (
          <p className="field-help">
            {placeTaskOnToday
              ? `${defaultTaskFolderId ? '将创建到当前文件夹' : '将创建到根目录'}，并同时安排到今天。任务本体仍只保留一份。`
              : `${defaultTaskFolderId ? '将创建到当前文件夹' : '将创建到根目录'}。之后可以从目录、任务详情或日期视图安排。`}
          </p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <Button
          variant="filled"
          className="m3e-button--wide"
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy ? '保存中…' : '创建'}
        </Button>
      </form>
    </Modal>
  );
}

/**
 * Dialog adapter kept for the existing call sites that drive the presence
 * lifecycle themselves. It forwards to the M3E `Dialog`, which owns the scrim,
 * focus trap and scroll lock.
 */
function Modal({
  title,
  onClose,
  children,
  state,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  state?: PresenceState;
}) {
  return (
    <M3eDialog title={title} onClose={onClose} open state={state}>
      {children}
    </M3eDialog>
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
  onQuickCapture: (kind: 'task') => void;
}) {
  const navigate = useNavigate();
  const { settings } = useAuth();
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [items, setItems] = useState<TreeTaskDto[]>([]);
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
      void requestV2<{ items: TreeTaskDto[] }>(
        `/tasks?archived=${includeArchived ? 'true' : 'false'}`,
      )
        .then((result) => {
          const needle = query.trim().toLocaleLowerCase();
          setItems(
            result.items.filter(
              (task) =>
                task.title.toLocaleLowerCase().includes(needle) ||
                task.referenceId.toLocaleLowerCase().includes(needle),
            ),
          );
        })
        .catch(() => setItems([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [includeArchived, query]);
  const arrangeToday = async (taskId: string) => {
    try {
      const point = (await mutationV2('POST', '/time-points/date', {
        localDate: todayInTimezone(settings?.timezone ?? 'Asia/Shanghai'),
      })) as TimePointDto;
      await mutationV2('POST', '/placements', { taskId, timePointId: point.id });
      setActionError('已安排到今天');
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '安排到今天失败，请重试');
    }
  };
  if (!presence.mounted) return null;
  return (
    <div
      className={`command-layer presence-${presence.state}`}
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
          <Search size={20} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务和引用 ID…"
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
              items.map((task) => (
                <div key={task.id} className="command-result">
                  <button className="command-result-main" onClick={() => onOpenTask(task.id)}>
                    <span className="status-icon">
                      <StatusIcon status={task.status} />
                    </span>
                    <span className="result-copy">
                      <strong>{task.title}</strong>
                      <small>
                        {task.referenceId} · {task.archivedAt ? '已归档' : '目录任务'}
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
              <Command size={16} /> 输入关键词开始搜索
            </span>
            <span>搜索任务标题和引用 ID</span>
            <div className="command-actions">
              <button onClick={() => onQuickCapture('task')}>新建任务</button>
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
        <Check size={14} />
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
      <Circle size={16} />
    </span>
  );
}

function TodayPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { settings } = useAuth();
  const localDate = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
  const defaultTaskFolderId = readRecentCaptureFolder(settings?.defaultCaptureTarget);
  const loader = useCallback(async () => {
    const point = (await mutationV2('POST', '/time-points/date', { localDate })) as TimePointDto;
    const [placementResponse, eventResponse, eventCountResponse] = await Promise.all([
      requestV2<{ items: PlacementWithTask[] }>(`/time-points/${point.id}/placements`),
      requestV2<{ items: TimePointDto[] }>('/time-points?type=EVENT&archived=false'),
      requestV2<{ items: TimePointPlacementCountDto[] }>(
        '/time-points/placement-counts?type=EVENT&archived=false',
      ),
    ]);
    return {
      point,
      items: placementResponse.items,
      reachedEvents: eventResponse.items.filter((candidate) => candidate.reachedAt),
      eventCounts: Object.fromEntries(
        eventCountResponse.items.map((item) => [item.timePointId, item]),
      ),
    };
  }, [localDate]);
  const { data, loading, error, reload } = useReloadable<{
    point: TimePointDto | null;
    items: PlacementWithTask[];
    reachedEvents: TimePointDto[];
    eventCounts: Record<string, TimePointPlacementCountDto>;
  }>(loader, {
    point: null as TimePointDto | null,
    items: [] as PlacementWithTask[],
    reachedEvents: [] as TimePointDto[],
    eventCounts: {} as Record<string, TimePointPlacementCountDto>,
  });
  // Rollover is a v2 mutation: it must go through `/api/v2` so the created
  // placements land in the v2 change feed and every client converges. The
  // operation is stateless, so the created ids are held client-side for undo.
  const [rollover, setRollover] = useState<{ placementIds: string[]; count: number } | null>(null);
  const [rolloverError, setRolloverError] = useState('');
  const [completedOpen, setCompletedOpen] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const doRollover = async () => {
    setRolloverError('');
    try {
      const result = await mutationV2<Record<string, unknown>>(
        'POST',
        `/dates/${localDate}/rollover`,
        {},
      );
      const createdIds = (result as { createdIds?: string[] })?.createdIds ?? [];
      setRollover({ placementIds: createdIds, count: createdIds.length });
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setRolloverError(cause instanceof ApiError ? cause.message : '安排到明天失败，请重试');
    }
  };
  const undo = async () => {
    if (!rollover) return;
    setRolloverError('');
    try {
      await mutationV2('POST', '/rollovers/undo', { placementIds: rollover.placementIds });
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
  const dayNumber = localDate.slice(-2);
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
    await mutationV2('POST', `/time-points/${data.point.id}/placements/reorder`, {
      ids: next.map((item) => item.id),
    });
    await reload();
    window.dispatchEvent(new Event('devtodo:data-changed'));
  };
  return (
    <div className="page page--today">
      <PageHeader
        eyebrow="TODAY"
        title={formatDate(localDate)}
        description="把今天要处理的内容放在眼前，完成状态会同步到每一个安排位置。"
        action={
          <Toolbar variant="floating" ariaLabel="今日操作" className="today-toolbar">
            <Button
              variant="tonal"
              leadingIcon={<Plus size={16} />}
              onClick={() => setShowTaskPicker(true)}
              disabled={!data.point}
            >
              从任务库加入
            </Button>
            <Button
              variant="outlined"
              leadingIcon={<Copy size={16} />}
              onClick={() => void doRollover()}
              disabled={!data.point || active.length === 0}
            >
              安排未完成到明天
            </Button>
          </Toolbar>
        }
      />
      <section className="today-stage" aria-label="今日工作区">
        <section className="today-overview" aria-label="今日进度">
          <div className="today-overview-identity">
            <span className="today-day-marker" aria-hidden="true">
              {dayNumber}
            </span>
            <div className="today-overview-copy">
              <span className="today-overview-label">今天的焦点</span>
              <strong>{total ? `${done.length} / ${total} 已完成` : '还没有安排任务'}</strong>
              <span className="today-overview-supporting">
                {total ? '完成一个任务，下一步会自然浮现' : '从捕获一个小任务开始'}
              </span>
            </div>
          </div>
          <div className="today-overview-metric">
            <LinearProgress
              value={done.length}
              max={total}
              label="今日任务完成度"
              wavy
              className="today-progress"
            />
            <span className="today-overview-percent">{completionPercent}%</span>
          </div>
        </section>
        <aside className="today-context" aria-labelledby="today-context-title">
          <div className="today-context-heading">
            <div>
              <span className="today-context-eyebrow">CONTEXT</span>
              <h2 id="today-context-title">今天的上下文</h2>
            </div>
            <span className="today-context-mark" aria-hidden="true">
              <Clock3 size={18} />
            </span>
          </div>
          {data.reachedEvents.length > 0 ? (
            <div className="today-context-events">
              <span className="today-context-label">已到达的时间点</span>
              {data.reachedEvents.slice(0, 3).map((event) => (
                <NavLink
                  key={event.id}
                  to={`/time/events/${event.id}`}
                  className="today-context-event"
                >
                  <span className="timeline-node reached" />
                  <span>
                    <strong>{event.title}</strong>
                    <small>{data.eventCounts[event.id]?.openCount ?? 0} 项未完成</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </NavLink>
              ))}
              {data.reachedEvents.length > 3 && (
                <NavLink to="/time/events" className="today-context-more">
                  查看全部时间点
                </NavLink>
              )}
            </div>
          ) : (
            <div className="today-context-note">
              <span className="today-context-note-icon" aria-hidden="true">
                <Target size={18} />
              </span>
              <p>没有已到达的事件。任务状态与时间点状态始终独立。</p>
            </div>
          )}
        </aside>
      </section>
      {rollover && (
        <Snackbar
          message={`已安排 ${rollover.count} 项到明天`}
          action={{ label: '撤销', onAction: () => void undo() }}
        />
      )}
      {rolloverError && (
        <ErrorState error={rolloverError} onRetry={() => void (rollover ? undo() : doRollover())} />
      )}
      <section className="capture-zone" aria-labelledby="capture-zone-title">
        <div className="capture-zone-copy">
          <span className="capture-zone-eyebrow">CAPTURE</span>
          <h2 id="capture-zone-title">先记下来，再决定怎么安排</h2>
          <p>今天页面创建的任务会自动获得今天的安排位置。</p>
        </div>
        <QuickCapture
          defaultTaskFolderId={defaultTaskFolderId}
          onCreated={async (task) => {
            const point =
              data.point ??
              ((await mutationV2('POST', '/time-points/date', { localDate })) as TimePointDto);
            await mutationV2('POST', '/placements', { taskId: task.id, timePointId: point.id });
            await reload();
          }}
        />
      </section>
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      {loading ? (
        <SkeletonList />
      ) : (
        <section className="today-task-workspace">
          <section className="today-task-pane" aria-label="今天要做">
            <SectionTitle title="今天要做" count={active.length} />
            <PlacementList
              items={active}
              reorderItems={data.items}
              pointId={data.point?.id}
              onOpenTask={onOpenTask}
              onChanged={() => void reload()}
              onMove={movePlacement}
              emptyTitle="今天还没有安排"
              emptyDescription="可以从所有任务中安排内容，或先捕获一个位于最近目录的任务。"
              emptyAction={
                data.point ? (
                  <Button
                    variant="filled"
                    leadingIcon={<Plus size={16} />}
                    onClick={() => setShowTaskPicker(true)}
                  >
                    从任务库加入
                  </Button>
                ) : undefined
              }
            />
          </section>
          <aside className="today-complete-pane" aria-label="已完成任务">
            <SectionTitle
              title="已完成"
              count={done.length}
              action={
                done.length > 0 ? (
                  <Button
                    variant="text"
                    type="submit"
                    onClick={() => setCompletedOpen((current) => !current)}
                    aria-expanded={completedOpen}
                  >
                    {completedOpen ? '收起' : '展开'}
                  </Button>
                ) : undefined
              }
            />
            {done.length > 0 && completedOpen ? (
              <div className="task-list completed-list m3e-stagger">
                {done.map((item) => (
                  <PlacementRow
                    key={item.id}
                    placement={item}
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
          </aside>
        </section>
      )}
      {showTaskPicker && data.point && (
        <AddTaskModal
          pointId={data.point.id}
          defaultFolderId={defaultTaskFolderId}
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
    const [active, archived, countResponse] = await Promise.all([
      requestV2<{ items: TimePointDto[] }>('/time-points?type=EVENT&archived=false').then(
        (result) => result.items,
      ),
      requestV2<{ items: TimePointDto[] }>('/time-points?type=EVENT&archived=true').then(
        (result) => result.items,
      ),
      requestV2<{ items: TimePointPlacementCountDto[] }>(
        '/time-points/placement-counts?type=EVENT',
      ).then((result) => result.items),
    ]);
    return {
      active,
      archived,
      counts: Object.fromEntries(countResponse.map((item) => [item.timePointId, item])),
    };
  }, []);
  const { data, loading, error, reload } = useReloadable(loader, {
    active: [] as TimePointDto[],
    archived: [] as TimePointDto[],
    counts: {} as Record<string, TimePointPlacementCountDto>,
  });
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<TimePointDto | null>(null);
  const [actionError, setActionError] = useState('');
  const [restoreBusyId, setRestoreBusyId] = useState<string | null>(null);
  const moveEvent = async (eventId: string, direction: 'up' | 'down') => {
    try {
      const index = data.active.findIndex((point) => point.id === eventId);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= data.active.length) return;
      const next = [...data.active];
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      await mutationV2('POST', '/time-points/events/reorder', {
        ids: next.map((point) => point.id),
      });
      await reload();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '时间点排序失败，请重试');
    }
  };
  const restoreEvent = async (point: TimePointDto) => {
    if (restoreBusyId) return;
    setRestoreBusyId(point.id);
    setActionError('');
    try {
      await mutationV2('POST', `/time-points/${point.id}/restore`, { baseVersion: point.version });
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '恢复时间点失败，请重试');
    } finally {
      setRestoreBusyId(null);
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
          <EventCount count={data.counts[point.id]?.openCount} />
          <ChevronRight size={16} />
        </NavLink>
        <div className="timeline-actions" aria-label="时间点操作">
          <IconButton
            label="上移时间点"
            type="submit"
            onClick={() => void moveEvent(point.id, 'up')}
            disabled={index <= 0}
          >
            <ChevronUp size={16} />
          </IconButton>
          <IconButton
            label="下移时间点"
            type="submit"
            onClick={() => void moveEvent(point.id, 'down')}
            disabled={index < 0 || index >= data.active.length - 1}
          >
            <ChevronDown size={16} />
          </IconButton>
          <IconButton
            label="操作"
            type="submit"
            aria-label={`编辑${point.title}`}
            onClick={() => setEdit(point)}
          >
            <Pencil size={16} />
          </IconButton>
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
          <Button leadingIcon={<Plus size={16} />} onClick={() => setOpen(true)}>
            新建时间点
          </Button>
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
                    <EventCount count={data.counts[point.id]?.openCount} />
                    <ChevronRight size={16} />
                  </NavLink>
                  <div className="timeline-actions archived-timeline-actions">
                    <Button
                      variant="tonal"
                      size="s"
                      type="submit"
                      disabled={restoreBusyId === point.id}
                      onClick={() => void restoreEvent(point)}
                    >
                      {restoreBusyId === point.id ? '恢复中…' : '恢复时间点'}
                    </Button>
                  </div>
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
            <Button leadingIcon={<Plus size={16} />} onClick={() => setOpen(true)}>
              创建时间点
            </Button>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutationV2('POST', '/time-points/events', { title: title.trim() });
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    } finally {
      setBusy(false);
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
        <Button
          variant="filled"
          className="m3e-button--wide"
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy ? '创建中…' : '创建时间点'}
        </Button>
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
      await mutationV2('PATCH', `/time-points/${point.id}`, {
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
        <Button
          variant="filled"
          className="m3e-button--wide"
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy ? '保存中…' : '保存时间点'}
        </Button>
      </form>
    </Modal>
  );
}

function EventCount({ count }: { count?: number }) {
  return <span className="event-count">{count === undefined ? '—' : `${count} 项未完成`}</span>;
}

function EventPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { eventId } = useParams();
  const { settings } = useAuth();
  // Date/event pages may only add Tasks, never Folders (spec 15.4), and a new
  // Task must land in the recent/current folder rather than always in root.
  const captureFolderId = readRecentCaptureFolder(settings?.defaultCaptureTarget);
  const [point, setPoint] = useState<TimePointDto | null>(null);
  const [items, setItems] = useState<PlacementWithTask[]>([]);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const [nextPoint, placements] = await Promise.all([
        requestV2<TimePointDto>(`/time-points/${eventId}`),
        requestV2<{ items: PlacementWithTask[] }>(`/time-points/${eventId}/placements`),
      ]);
      setPoint(nextPoint);
      setItems(placements.items);
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
  const changeEventState = async (): Promise<boolean> => {
    setActionBusy(true);
    try {
      if (point.archivedAt)
        await mutationV2('POST', `/time-points/${point.id}/restore`, {
          baseVersion: point.version,
        });
      else if (point.reachedAt)
        await mutationV2('POST', `/time-points/${point.id}/archive`, {
          baseVersion: point.version,
        });
      else
        await mutationV2('POST', `/time-points/${point.id}/reach`, { baseVersion: point.version });
      await load();
      window.dispatchEvent(new Event('devtodo:data-changed'));
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败');
      return false;
    } finally {
      setActionBusy(false);
    }
  };
  const movePlacement = async (placementId: string, direction: 'up' | 'down') => {
    const index = items.findIndex((item) => item.id === placementId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    try {
      await mutationV2('POST', `/time-points/${point.id}/placements/reorder`, {
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
            <Button
              variant="outlined"
              leadingIcon={<Pencil size={16} />}
              disabled={Boolean(point.archivedAt) || actionBusy}
              onClick={() => setEditOpen(true)}
            >
              编辑时间点
            </Button>
            <Button
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
              disabled={actionBusy}
              onClick={() =>
                point.archivedAt || !point.reachedAt
                  ? void changeEventState()
                  : setArchiveConfirmOpen(true)
              }
            >
              {point.archivedAt ? '恢复时间点' : point.reachedAt ? '归档时间点' : '标记已到达'}
            </Button>
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
          <Button
            size="s"
            variant="tonal"
            leadingIcon={<Plus size={16} />}
            onClick={() => setShowAdd(true)}
            disabled={Boolean(point.archivedAt)}
          >
            从任务库加入
          </Button>
        }
      />
      <PlacementList
        items={items}
        pointId={point.id}
        onOpenTask={onOpenTask}
        onChanged={() => void load()}
        onMove={point.archivedAt ? undefined : movePlacement}
        readOnly={Boolean(point.archivedAt)}
        emptyTitle="这个时间点还没有安排"
        emptyDescription="从任务库加入已有任务；它不会创建新的 Task。"
        emptyAction={
          <Button leadingIcon={<Plus size={16} />} onClick={() => setShowAdd(true)}>
            加入任务
          </Button>
        }
      />
      {showAdd && (
        <AddTaskModal
          pointId={point.id}
          defaultFolderId={captureFolderId}
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
      {archiveConfirmOpen && (
        <ConfirmDialog
          title="归档时间点"
          description={`确定要归档“${point.title ?? ''}”吗？其中的任务安排会保留，但这个时间点将从默认列表隐藏；之后可以从归档中心恢复。`}
          confirmLabel="归档时间点"
          error={error}
          onClose={() => setArchiveConfirmOpen(false)}
          onConfirm={changeEventState}
        />
      )}
    </div>
  );
}

function PlacementRow({
  placement,
  task,
  onOpen,
  onChanged,
  onDrop,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
  onToggleStatus = false,
  readOnly = false,
}: {
  placement: PlacementDto;
  task: TreeTaskDto;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  onMove?: (direction: 'up' | 'down') => Promise<void> | void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onToggleStatus?: boolean;
  readOnly?: boolean;
}) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [targetMode, setTargetMode] = useState<'copy' | 'move' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const longPressRef = useRef<number | null>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const menuRef = useDismissibleMenu(menu, closeMenu);
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
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await mutationV2('DELETE', `/placements/${placement.id}`, { baseVersion: placement.version });
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
      await mutationV2('PATCH', `/tasks/${task.id}`, {
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
      className={`task-row${dragging ? ' dragging' : ''}`}
      aria-busy={busy || undefined}
      aria-grabbed={dragging}
      draggable={!readOnly}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onDragStart={(event) => {
        if (readOnly) return;
        setDragging(true);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-devtodo-placement', placement.id);
        event.dataTransfer.setData('application/x-devtodo-task', task.id);
        event.dataTransfer.setData('text/plain', task.id);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(event) => {
        if (onDrop && !readOnly) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDrop || readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(event);
      }}
    >
      <button
        className="task-status-button"
        aria-label={onToggleStatus ? taskStatusActionLabel(task.status) : '打开任务'}
        title={onToggleStatus ? taskStatusActionLabel(task.status) : '打开任务'}
        onClick={() => (onToggleStatus && !readOnly ? void toggleStatus() : onOpen(task.id))}
        disabled={busy}
      >
        <StatusIcon status={task.status} />
      </button>
      {onMove && !readOnly && (
        <div className="task-reorder-actions" aria-label="调整安排顺序">
          <IconButton
            label="上移安排"
            type="submit"
            onClick={() => void move('up')}
            disabled={busy || !canMoveUp}
          >
            <ChevronUp size={16} />
          </IconButton>
          <IconButton
            label="下移安排"
            type="submit"
            onClick={() => void move('down')}
            disabled={busy || !canMoveDown}
          >
            <ChevronDown size={16} />
          </IconButton>
        </div>
      )}
      <button className="task-main" onClick={() => onOpen(task.id)}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          <span className="reference-id">{task.referenceId}</span>
        </span>
      </button>
      {!readOnly && (
        <div ref={menuRef} className="task-actions">
          <IconButton
            label="安排操作（也可长按安排行）"
            type="submit"
            aria-expanded={menu}
            aria-haspopup="menu"
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          {menu && (
            <div className="row-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  const dest = task.parentFolderId
                    ? `/tree/${task.parentFolderId}?focusTask=${task.id}`
                    : `/tree?focusTask=${task.id}`;
                  navigate(dest);
                }}
              >
                <Folder size={16} />
                在目录中显示
              </button>
              <button role="menuitem" onClick={() => void remove()}>
                <Trash2 size={16} />
                从此处移除
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setTargetMode('move');
                }}
              >
                <Target size={16} />
                移动到其他时间点
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setTargetMode('copy');
                }}
              >
                <Copy size={16} />
                再安排到其他时间点
              </button>
            </div>
          )}
        </div>
      )}
      {error && <span className="row-error">{error}</span>}
      {targetMode && (
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
  reorderItems,
  emptyTitle,
  emptyDescription,
  emptyAction,
  readOnly = false,
}: {
  items: PlacementWithTask[];
  pointId?: string;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
  onMove?: (placementId: string, direction: 'up' | 'down') => Promise<void> | void;
  reorderItems?: PlacementWithTask[];
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: ReactNode;
  readOnly?: boolean;
}) {
  const [dropError, setDropError] = useState('');
  const [dropBusy, setDropBusy] = useState(false);
  const allItems = reorderItems ?? items;
  const handleDrop = async (event: ReactDragEvent<HTMLElement>, targetPlacementId?: string) => {
    if (!pointId || readOnly || dropBusy) return;
    const sourcePlacementId = event.dataTransfer.getData('application/x-devtodo-placement');
    if (targetPlacementId && sourcePlacementId && sourcePlacementId !== targetPlacementId) {
      const sourceIndex = allItems.findIndex((item) => item.id === sourcePlacementId);
      const targetIndex = allItems.findIndex((item) => item.id === targetPlacementId);
      if (sourceIndex >= 0 && targetIndex >= 0) {
        const next = [...allItems];
        const [moved] = next.splice(sourceIndex, 1);
        const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        if (moved) next.splice(insertionIndex, 0, moved);
        setDropBusy(true);
        setDropError('');
        try {
          await mutationV2('POST', `/time-points/${pointId}/placements/reorder`, {
            ids: next.map((item) => item.id),
          });
          onChanged();
          window.dispatchEvent(new Event('devtodo:data-changed'));
        } catch (cause) {
          setDropError(cause instanceof ApiError ? cause.message : '安排排序失败，请重试');
        } finally {
          setDropBusy(false);
        }
        return;
      }
    }
    setDropBusy(true);
    setDropError('');
    try {
      await moveDraggedPlacement(event, pointId);
      onChanged();
    } catch (cause) {
      setDropError(cause instanceof ApiError ? cause.message : '安排操作失败，请重试');
    } finally {
      setDropBusy(false);
    }
  };
  const empty = (
    <EmptyState
      icon={<Sparkles size={20} />}
      title={emptyTitle}
      description={emptyDescription}
      action={emptyAction}
    />
  );
  const dropNotice = dropError ? (
    <div className="inline-error" role="alert">
      {dropError}
    </div>
  ) : null;
  if (!items.length)
    return (
      <>
        {dropNotice}
        <div
          className="task-list placement-drop-target placement-empty-drop m3e-stagger"
          onDragOver={(event) => {
            if (!readOnly && !dropBusy) event.preventDefault();
          }}
          onDrop={(event) => void handleDrop(event)}
        >
          {empty}
        </div>
      </>
    );
  return (
    <>
      {dropNotice}
      <div
        className="task-list placement-drop-target m3e-stagger"
        onDragOver={(event) => {
          if (!readOnly && !dropBusy) event.preventDefault();
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        {items.map((item, index) => (
          <PlacementRow
            key={item.id}
            placement={item}
            task={item.task}
            onOpen={onOpenTask}
            onChanged={onChanged}
            onDrop={readOnly ? undefined : (event) => void handleDrop(event, item.id)}
            onMove={
              readOnly ? undefined : onMove ? (direction) => onMove(item.id, direction) : undefined
            }
            canMoveUp={index > 0}
            canMoveDown={index < items.length - 1}
            onToggleStatus={!readOnly}
            readOnly={readOnly}
          />
        ))}
      </div>
    </>
  );
}

function EventTargetField({
  points,
  value,
  onChange,
  onPointCreated,
}: {
  points: TimePointDto[];
  value: string;
  onChange: (value: string) => void;
  onPointCreated: (point: TimePointDto) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const eventPoints = points.filter((point) => point.type === 'EVENT');
  return (
    <div className="field">
      <span>选择自定义时间点</span>
      {createOpen ? (
        <InlineEventCreator
          onCancel={() => setCreateOpen(false)}
          onCreated={(point) => {
            onPointCreated(point);
            setCreateOpen(false);
          }}
        />
      ) : (
        <>
          <Select
            label="选择自定义时间点"
            value={value}
            onChange={onChange}
            options={[
              { value: '', label: '选择事件' },
              ...eventPoints.map((point) => ({
                value: point.id,
                label: point.title ?? '未命名事件',
              })),
            ]}
          />
          <div className="event-target-actions">
            <small className="field-help">
              {eventPoints.length ? '也可以新建一个自定义时间点。' : '还没有可用的自定义时间点。'}
            </small>
            <Button variant="text" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={16} />
              新建时间点
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function InlineEventCreator({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (point: TimePointDto) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      onCreated(
        (await mutationV2('POST', '/time-points/events', { title: title.trim() })) as TimePointDto,
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建时间点失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-event-creator">
      <Field label="时间点名称" value={title} onChange={setTitle} autoFocus autoComplete="off" />
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="inline-event-actions">
        <Button variant="text" type="button" onClick={onCancel} disabled={busy}>
          返回选择
        </Button>
        <Button
          size="s"
          type="button"
          onClick={() => void create()}
          disabled={busy || !title.trim()}
        >
          {busy ? '创建中…' : '创建并选择'}
        </Button>
      </div>
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
  useEffect(() => {
    void requestV2<{ items: TimePointDto[] }>('/time-points?archived=false')
      .then((result) => setPoints(result.items))
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
        nextId = (
          (await mutationV2('POST', '/time-points/date', {
            localDate: localDate.trim(),
          })) as TimePointDto
        ).id;
      if (!nextId) throw new Error('请选择事件或输入日期');
      if (mode === 'move' && nextId === placement.timePointId)
        throw new Error('目标时间点不能与当前位置相同');
      await mutationV2(
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
        <ButtonGroup
          label="目标类型"
          value={targetKind}
          options={[
            { value: 'date' as const, label: '日期' },
            { value: 'event' as const, label: '自定义时间点' },
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
              <Chip
                kind="filter"
                label="今天"
                selected={localDate === today}
                onClick={() => setLocalDate(today)}
              />
              <Chip
                kind="filter"
                label="明天"
                selected={localDate === tomorrow}
                onClick={() => setLocalDate(tomorrow)}
              />
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
          <EventTargetField
            points={points}
            value={targetId}
            onChange={setTargetId}
            onPointCreated={(point) => {
              setPoints((current) => [...current, point]);
              setTargetId(point.id);
            }}
          />
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <Button
          className="wide"
          disabled={busy || (targetKind === 'event' ? !targetId : !localDate)}
        >
          {busy ? '处理中…' : mode === 'move' ? '移动安排' : '创建副本安排'}
        </Button>
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
  if (!placementId) {
    await mutationV2('POST', '/placements', { taskId, timePointId: targetTimePointId });
    window.dispatchEvent(new Event('devtodo:data-changed'));
    return;
  }
  const detail = await requestV2<{ placements: PlacementDto[] }>(`/tasks/${taskId}`);
  const placement = detail.placements.find((item) => item.id === placementId);
  if (!placement || placement.timePointId === targetTimePointId) return;
  await mutationV2('POST', `/placements/${placementId}/move`, {
    timePointId: targetTimePointId,
    baseVersion: placement.version,
  });
  window.dispatchEvent(new Event('devtodo:data-changed'));
}

function AddTaskModal({
  pointId,
  onClose,
  onAdded,
  defaultFolderId,
}: {
  pointId: string;
  onClose: () => void;
  onAdded: () => void;
  defaultFolderId?: string | null;
}) {
  const [activeTab, setActiveTab] = useState<'existing' | 'create'>('create');
  const [createTitle, setCreateTitle] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<TreeTaskDto[]>([]);
  const [error, setError] = useState('');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleCreateNew = async (e: FormEvent) => {
    e.preventDefault();
    const title = createTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    setError('');
    try {
      const result = (await mutationV2('POST', '/tasks', {
        parentFolderId: defaultFolderId ?? null,
        title,
      })) as { task?: TreeTaskDto; id?: string };
      const taskId = result.task?.id ?? result.id;
      if (!taskId) throw new Error('任务创建失败');
      await mutationV2('POST', '/placements', { taskId, timePointId: pointId });
      onAdded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建并安排任务失败');
    } finally {
      setCreating(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query.trim()) {
        void requestV2<{ items: TreeTaskDto[] }>('/tasks?archived=false')
          .then((result) => {
            const needle = query.trim().toLocaleLowerCase();
            setItems(
              result.items
                .filter(
                  (task) =>
                    task.status !== 'DONE' &&
                    (task.title.toLocaleLowerCase().includes(needle) ||
                      task.referenceId.toLocaleLowerCase().includes(needle)),
                )
                .slice(0, 12),
            );
          })
          .catch(() => setItems([]));
        return;
      }
      void requestV2<{ items: TreeTaskDto[] }>('/tasks?archived=false')
        .then((result) =>
          setItems(result.items.filter((task) => task.status !== 'DONE').slice(0, 12)),
        )
        .catch(() => setItems([]));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);
  const add = async (task: TreeTaskDto) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    setError('');
    try {
      await mutationV2('POST', '/placements', { taskId: task.id, timePointId: pointId });
      onAdded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '安排任务失败，请重试');
    } finally {
      setBusyTaskId(null);
    }
  };
  return (
    <Modal title="安排任务" onClose={onClose}>
      <ButtonGroup
        label="安排方式"
        value={activeTab}
        options={[
          { value: 'create' as const, label: '新建任务并安排' },
          { value: 'existing' as const, label: '从任务库加入已有' },
        ]}
        onChange={setActiveTab}
        className="add-task-mode"
      />

      {activeTab === 'create' ? (
        <form
          onSubmit={handleCreateNew}
          style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>任务标题</span>
            <input
              autoFocus
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="输入任务标题..."
              className="form-input"
              disabled={creating}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <Button variant="filled" type="submit" disabled={creating || !createTitle.trim()}>
            {creating ? '创建中…' : '立即创建并安排'}
          </Button>
        </form>
      ) : (
        <>
          <SearchBar
            label="搜索任务"
            variant="view"
            autoFocus
            value={query}
            onChange={setQuery}
            placeholder="输入标题或引用 ID"
            leadingIcon={<Search size={20} />}
          />
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
              {query ? '没有可加入的任务' : '没有未完成任务，可以先新建任务。'}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function CalendarPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { settings } = useAuth();
  const captureFolderId = readRecentCaptureFolder(settings?.defaultCaptureTarget);
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
  const monthDates = useMemo(
    () => days.filter((day) => day.inMonth).map((day) => day.date),
    [days],
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
    setDateCounts({});
    if (!monthDates.length) return () => undefined;
    void requestV2<{ items: TimePointPlacementCountDto[] }>(
      `/time-points/placement-counts?type=DATE&from=${monthDates[0]}&to=${monthDates[monthDates.length - 1]}`,
    )
      .then((result) => {
        if (!cancelled)
          setDateCounts(
            Object.fromEntries(
              result.items
                .filter((item) => item.localDate)
                .map((item) => [item.localDate!, item.totalCount]),
            ),
          );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [monthDates]);
  const loadSelected = useCallback(async () => {
    const nextPoint = (await mutationV2('POST', '/time-points/date', {
      localDate: selected,
    })) as TimePointDto;
    const result = await requestV2<{ items: PlacementWithTask[] }>(
      `/time-points/${nextPoint.id}/placements`,
    );
    setPoint(nextPoint);
    setItems(result.items);
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
    await mutationV2('POST', `/time-points/${point.id}/placements/reorder`, {
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
          <Button
            variant="outlined"
            leadingIcon={<Target size={16} />}
            onClick={() => {
              const today = todayInTimezone(settings?.timezone ?? 'Asia/Shanghai');
              setMonth(today.slice(0, 7));
              selectDate(today);
            }}
          >
            回到今天
          </Button>
        }
      />
      <div className="calendar-layout">
        <section className="calendar-panel">
          <div className="calendar-head">
            <IconButton
              label="上个月"
              aria-label="上个月"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft size={20} />
            </IconButton>
            <h2>{formatMonth(month)}</h2>
            <IconButton
              label="下个月"
              aria-label="下个月"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={20} />
            </IconButton>
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
            <Button
              size="s"
              variant="tonal"
              leadingIcon={<Plus size={16} />}
              onClick={() => setShowAdd(true)}
            >
              加入任务
            </Button>
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
              defaultFolderId={captureFolderId}
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
  const operationLoader = useCallback(
    () =>
      requestV2<{ items?: ArchiveOperationSummaryDto[] }>('/archive-operations').then(
        (result) => result.items ?? [],
      ),
    [],
  );
  const taskLoader = useCallback(
    () =>
      requestV2<{ items?: TreeTaskDto[] }>('/tasks?archived=true').then(
        (result) => result.items ?? [],
      ),
    [],
  );
  const folderLoader = useCallback(
    () =>
      requestV2<{ items?: FolderDto[] }>('/folders?archived=true').then(
        (result) => result.items ?? [],
      ),
    [],
  );
  const eventLoader = useCallback(
    () =>
      requestV2<{ items?: TimePointDto[] }>('/time-points?type=EVENT&archived=true').then(
        (result) => result.items ?? [],
      ),
    [],
  );
  const operations = useReloadable(operationLoader, [] as ArchiveOperationSummaryDto[]);
  const tasks = useReloadable(taskLoader, [] as TreeTaskDto[]);
  const folders = useReloadable(folderLoader, [] as FolderDto[]);
  const events = useReloadable(eventLoader, [] as TimePointDto[]);
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const reloadAll = async () => {
    await Promise.all([operations.reload(), tasks.reload(), folders.reload(), events.reload()]);
  };
  const runAction = async (id: string, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id);
    setActionError('');
    try {
      await action();
      await reloadAll();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '恢复失败，请重试');
    } finally {
      setBusyId(null);
    }
  };
  // A folder archived outside a cascade operation has no archive operation to
  // restore by id. Never send `{}`: the server requires a real operationId.
  const restoreFolder = (folder: FolderDto) => {
    if (!folder.archivedByOperationId) {
      setActionError(
        '该文件夹不是通过级联归档产生的，无法按归档操作精确恢复。请恢复其父目录，或先在目录页恢复。',
      );
      return;
    }
    return runAction(folder.id, async () => {
      await mutationV2('POST', `/folders/${folder.id}/restore-tree`, {
        operationId: folder.archivedByOperationId,
      });
    });
  };
  const operationFolderIds = new Set(
    operations.data.flatMap((operation) => operation.folders.map((folder) => folder.id)),
  );
  const looseFolders = folders.data.filter((folder) => !operationFolderIds.has(folder.id));
  const looseTasks = tasks.data.filter(
    (task) => !task.parentFolderId || !operationFolderIds.has(task.parentFolderId),
  );
  return (
    <div className="page">
      <PageHeader
        eyebrow="HISTORY"
        title="归档"
        description="归档只影响默认可见性，任务、备注、安排和历史引用仍然保留。"
      />
      {actionError && (
        <div className="inline-error" role="alert">
          {actionError}
        </div>
      )}
      {(operations.error || tasks.error || folders.error || events.error) && (
        <ErrorState
          error={operations.error || tasks.error || folders.error || events.error}
          onRetry={() => void reloadAll()}
        />
      )}
      <SectionTitle title="目录级联归档" count={operations.data.length} />
      {operations.initialLoading ? (
        <SkeletonList />
      ) : operations.data.length === 0 ? (
        <div className="quiet-empty">没有目录级联归档</div>
      ) : (
        <div className="archive-project-list">
          {operations.data.map((operation) => {
            const expanded = expandedId === operation.id;
            const busy = busyId === operation.id;
            return (
              <div className="archive-project" key={operation.id}>
                <span>
                  <strong>{operation.rootFolderTitle || '（未命名目录）'}</strong>
                  <small>
                    {operation.descendantFolderCount} 个文件夹 · {operation.descendantTaskCount}{' '}
                    个任务
                    {operation.previouslyArchivedFolderCount +
                      operation.previouslyArchivedTaskCount >
                    0
                      ? ` · 另有 ${operation.previouslyArchivedFolderCount} 个文件夹、${operation.previouslyArchivedTaskCount} 个任务原本已归档`
                      : ''}
                  </small>
                  <small>归档于 {formatTime(operation.createdAt)}</small>
                </span>
                <div className="archive-project-actions">
                  <Button
                    variant="tonal"
                    size="s"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : operation.id)}
                  >
                    {expanded ? '收起明细' : '查看明细'}
                  </Button>
                  <Button
                    variant="tonal"
                    size="s"
                    type="submit"
                    disabled={busy}
                    onClick={() =>
                      void runAction(operation.id, async () => {
                        await mutationV2(
                          'POST',
                          `/folders/${operation.rootFolderId}/restore-tree`,
                          { operationId: operation.id },
                        );
                      })
                    }
                  >
                    {busy ? '恢复中…' : '恢复整棵目录'}
                  </Button>
                </div>
                {expanded && (
                  <div className="archive-operation-children">
                    {operation.folders.map((folder) => (
                      <div key={folder.id} className="archive-operation-child">
                        <span>
                          {folder.parentFolderId ? '└ ' : ''}
                          {folder.title}
                        </span>
                        {folder.archivedAt ? (
                          <small>
                            {folder.archivedByOperationId === operation.id
                              ? '由本次归档'
                              : '原本已归档，恢复时保留'}
                          </small>
                        ) : (
                          <small>已恢复</small>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <SectionTitle title="独立归档任务" count={looseTasks.length} />
      {tasks.initialLoading ? (
        <SkeletonList />
      ) : (
        <div className="task-list">
          {looseTasks.length === 0 ? (
            <div className="quiet-empty">没有独立归档任务</div>
          ) : (
            looseTasks.map((task) => (
              <div className="task-row" key={task.id}>
                <button className="task-main" onClick={() => onOpenTask(task.id)}>
                  <span className="task-title">{task.title}</span>
                  <span className="task-meta">
                    <span className="reference-id">{task.referenceId}</span>
                    <span className="status-label">已归档</span>
                  </span>
                </button>
                <Button
                  variant="tonal"
                  size="s"
                  type="submit"
                  disabled={busyId === task.id}
                  onClick={() =>
                    void runAction(task.id, async () => {
                      await mutationV2('POST', `/tasks/${task.id}/restore`, {
                        baseVersion: task.version,
                      });
                    })
                  }
                >
                  {busyId === task.id ? '恢复中…' : '恢复任务'}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
      {(folders.initialLoading || looseFolders.length > 0) && (
        <>
          <SectionTitle title="独立归档文件夹" count={looseFolders.length} />
          {folders.initialLoading ? (
            <SkeletonList />
          ) : (
            <div className="archive-project-list">
              {looseFolders.map((folder) => (
                <div className="archive-project" key={folder.id}>
                  <span>
                    <strong>{folder.title}</strong>
                    <small>
                      {folder.archivedByOperationId
                        ? '来自批量归档操作'
                        : '独立归档（需先恢复父目录）'}
                    </small>
                  </span>
                  <Button
                    variant="tonal"
                    size="s"
                    type="submit"
                    disabled={busyId === folder.id || !folder.archivedByOperationId}
                    title={
                      folder.archivedByOperationId ? undefined : '独立归档文件夹不能按归档操作恢复'
                    }
                    onClick={() => void restoreFolder(folder)}
                  >
                    {busyId === folder.id ? '恢复中…' : '恢复文件夹'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {(events.initialLoading || events.data.length > 0) && (
        <>
          <SectionTitle title="时间点" count={events.data.length} />
          {events.initialLoading ? (
            <SkeletonList />
          ) : (
            <div className="archive-project-list">
              {events.data.map((event) => (
                <div className="archive-project" key={event.id}>
                  <span>
                    <strong>{event.title}</strong>
                    <small>
                      已归档 ·{' '}
                      {event.reachedAt ? `已到达 · ${formatTime(event.reachedAt)}` : '未到达'}
                    </small>
                  </span>
                  <Button
                    variant="tonal"
                    size="s"
                    type="submit"
                    disabled={busyId === event.id}
                    onClick={() =>
                      void runAction(event.id, async () => {
                        await mutationV2('POST', `/time-points/${event.id}/restore`, {
                          baseVersion: event.version,
                        });
                      })
                    }
                  >
                    {busyId === event.id ? '恢复中…' : '恢复时间点'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SettingsPage() {
  const auth = useAuth();
  const [timezone, setTimezone] = useState(auth.settings?.timezone ?? 'Asia/Shanghai');
  const [weekStartsOn, setWeekStartsOn] = useState<0 | 1>(auth.settings?.weekStartsOn ?? 1);
  const [defaultCaptureTarget, setDefaultCaptureTarget] = useState<'ROOT' | 'RECENT_FOLDER'>(
    auth.settings?.defaultCaptureTarget === 'RECENT_CONTEXT' ? 'RECENT_FOLDER' : 'ROOT',
  );
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!auth.settings) return;
    try {
      const updated = (await mutationV2('PATCH', '/settings', {
        timezone,
        weekStartsOn,
        defaultCaptureTarget,
        baseVersion: auth.settings.version,
      })) as V2SettingsDto;
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
    void requestV1<typeof devices>('/devices')
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
            <Select
              label="时区"
              value={timezone}
              onChange={setTimezone}
              options={[
                { value: 'Asia/Shanghai', label: 'Asia/Shanghai' },
                { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
                { value: 'UTC', label: 'UTC' },
                { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
              ]}
            />
          </label>
          <label className="field">
            <span>每周起始日</span>
            <Select
              label="每周起始日"
              value={String(weekStartsOn)}
              onChange={(next) => setWeekStartsOn(Number(next) as 0 | 1)}
              options={[
                { value: '1', label: '周一' },
                { value: '0', label: '周日' },
              ]}
            />
          </label>
          <label className="field">
            <span>默认新任务位置</span>
            <Select
              label="默认新任务位置"
              value={defaultCaptureTarget}
              onChange={(next) => {
                if (next === 'ROOT' || next === 'RECENT_FOLDER') setDefaultCaptureTarget(next);
              }}
              options={[
                { value: 'ROOT', label: '根目录' },
                { value: 'RECENT_FOLDER', label: '最近文件夹' },
              ]}
            />
          </label>
          <p className="field-help">日期任务使用此时区的本地日期；不会把 UTC 日期直接展示给你。</p>
        </div>
        <div className="settings-section">
          <h2>已登录设备</h2>
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
            </div>
          ))}
        </div>
        <ConflictSection />
        <RejectedMutationSection />
        <div className="settings-actions">
          <Button variant="filled" type="submit">
            保存设置
          </Button>
          {saved && (
            <span className="save-state">
              <Check size={16} />
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
  const originEdited = useRef(false);
  useEffect(() => {
    let active = true;
    void loadConfiguredHubOrigin().then((configured) => {
      if (active && configured && !originEdited.current) setOrigin(configured);
    });
    return () => {
      active = false;
    };
  }, []);
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
      await setHubOrigin(nextOrigin);
      if (currentOrigin !== nextOrigin) await auth.logout();
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
            originEdited.current = true;
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
        <Button
          variant="tonal"
          type="button"
          onClick={() => void save()}
          disabled={state === 'checking' || !origin.trim()}
        >
          {state === 'checking' ? '测试中…' : '测试并保存'}
        </Button>
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
  // Show "restore then apply local" for every entity type whose sync engine has
  // a real restore path: v1 handles project/task/timePoint, v2 handles
  // task/timePoint/workflow (folders restore through their cascade operation).
  const restoreAvailable =
    isRecord(server) &&
    Boolean(server['archivedAt']) &&
    ['project', 'task', 'timePoint', 'workflow'].includes(item.entityType);
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
        <Button variant="tonal" size="s" type="button" onClick={() => void resolve('server')}>
          采用服务器版本
        </Button>
        <Button variant="tonal" size="s" type="button" onClick={() => void resolve('local')}>
          保留本地并重试
        </Button>
        {restoreAvailable && (
          <Button variant="tonal" size="s" type="button" onClick={() => void resolve('restore')}>
            恢复后应用本地
          </Button>
        )}
        {mergeSupported && (
          <Button variant="filled" size="s" type="button" onClick={() => void resolve('merged')}>
            保存合并版本
          </Button>
        )}
        <Button
          variant="filled"
          size="s"
          className="m3e-button--danger"
          type="button"
          onClick={() => void resolve('discard')}
        >
          丢弃本地改动
        </Button>
      </div>
    </div>
  );
}

function RejectedMutationSection() {
  const { db, engine } = useAuth();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [upgradePending, setUpgradePending] = useState<UpgradePendingMutation[]>([]);
  const reload = useCallback(async () => {
    if (!db) {
      setItems([]);
      setUpgradePending([]);
      return;
    }
    setItems(
      (await db.outbox.toArray()).filter(
        (item) => Boolean(item.lastError) && item.nextAttemptAt === Number.MAX_SAFE_INTEGER,
      ),
    );
    // Typed v1->v2 upgrade queue. It carries the precise reason and payload that
    // raw outbox rows cannot express, so surface it separately.
    setUpgradePending(await readUpgradePending(db));
  }, [db]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [reload]);
  if (!items.length && !upgradePending.length) return null;
  return (
    <div className="settings-section rejected-inbox">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>待重试的失败操作 / 升级待处理项</h2>
        <Button
          variant="tonal"
          size="s"
          type="button"
          onClick={() => {
            const blob = new Blob([JSON.stringify({ upgradePending, rejected: items }, null, 2)], {
              type: 'application/json',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `devtodo-upgrade-pending-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          导出待处理项
        </Button>
      </div>
      <p className="field-help">
        服务器拒绝的本地操作或未完成协议升级项已暂停，不会在后台无限重复提交。
      </p>
      {upgradePending.length > 0 && (
        <div className="upgrade-pending-list">
          <h3>v1 升级待处理（{upgradePending.length}）</h3>
          {upgradePending.map((entry) => (
            <div className="rejected-mutation" key={entry.mutationId}>
              <span>
                <strong>{entry.command}</strong>
                <small>
                  {entry.mutationId.slice(0, 8)} · {entry.reason}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
      {items.map((item) => (
        <div className="rejected-mutation" key={item.id ?? item.mutationId}>
          <span>
            <strong>{item.command}</strong>
            <small>
              {item.entityId.slice(0, 8)} · {item.lastError}
            </small>
          </span>
          <div className="rejected-actions">
            <Button
              variant="tonal"
              size="s"
              type="button"
              onClick={() =>
                void engine?.retryRejectedMutation(item.mutationId).then(() => {
                  void reload();
                  void engine.sync().catch(() => undefined);
                })
              }
            >
              重试
            </Button>
            <Button
              variant="text"
              className="danger-text"
              type="button"
              onClick={() =>
                void engine?.discardRejectedMutation(item.mutationId).then(() => void reload())
              }
            >
              丢弃
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
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
  if (
    pathname.startsWith('/projects') ||
    pathname.startsWith('/inbox') ||
    pathname.startsWith('/misc')
  )
    return '目录';
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
