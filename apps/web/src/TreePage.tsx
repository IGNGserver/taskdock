import type {
  FolderDto,
  PlacementDto,
  TaskDetailV2Dto,
  TaskStatus,
  TaskStepDto,
  TimePointDto,
  TreeItemDto,
  TreeTaskDto,
} from '@devtodo/contracts';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Plus } from 'lucide-react';
import { ApiError, mutationV2, requestV2 } from './api.js';
import {
  Alert,
  BottomSheet,
  Button,
  ButtonGroup,
  Card,
  Chip,
  ConfirmDialog,
  DestructiveSection,
  EmptyState,
  IconButton,
  List,
  ListItem,
  LoadingState,
  Menu,
  Select,
  SideSheet,
  TaskStatusControl,
  TextArea,
  TextField,
  useDismissibleMenu,
  useWindowSizeClass,
  type MenuOption,
} from './components/m3e/index.js';
import { recordLastFolderId } from './folder-preference.js';

function statusLabel(status: string): string {
  return status === 'IN_PROGRESS' ? '进行中' : status === 'DONE' ? '已完成' : '待开始';
}

function statusClass(status: string): string {
  return status === 'IN_PROGRESS' ? 'in-progress' : status === 'DONE' ? 'done' : 'todo';
}

/** Stable identity for a directory row, whichever kind it holds. */
function treeItemId(item: TreeItemDto): string {
  return item.kind === 'FOLDER' ? item.folder.id : item.task.id;
}

type TaskPlacementDetail = PlacementDto & { timePoint: TimePointDto };

function placementLabel(placement: TaskPlacementDetail): string {
  const point = placement.timePoint;
  if (point.type === 'EVENT') return point.title?.trim() || '未命名事件';
  if (!point.localDate) return '未命名日期';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${point.localDate}T00:00:00Z`));
}

type TreeMoveTarget = {
  item: { kind: 'FOLDER' | 'TASK'; id: string };
  parentFolderId: string | null;
  expectedStatus: 'TODO' | 'IN_PROGRESS' | 'DONE';
  baseVersion: number;
  title: string;
};

type ConfirmRequest = {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<boolean | void> | boolean | void;
};

function TreeRowActions({
  item,
  index,
  groupLength,
  onMove,
  onOpenMove,
  onDeleteFolder,
  onDeleteTask,
}: {
  item: TreeItemDto;
  index: number;
  groupLength: number;
  onMove: (item: TreeItemDto, direction: 'up' | 'down') => void;
  onOpenMove: (item: TreeItemDto) => void;
  onDeleteFolder: (item: Extract<TreeItemDto, { kind: 'FOLDER' }>) => void;
  onDeleteTask: (item: Extract<TreeItemDto, { kind: 'TASK' }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useDismissibleMenu(open, () => setOpen(false));
  const title = item.kind === 'FOLDER' ? item.folder.title : item.task.title;
  const isFolder = item.kind === 'FOLDER';
  const options: MenuOption[] = [
    {
      id: 'move-up',
      label: '上移',
      hint: '↑',
      disabled: index === 0,
    },
    {
      id: 'move-down',
      label: '下移',
      hint: '↓',
      disabled: index === groupLength - 1,
    },
    { id: 'move', label: '移动到其他目录' },
    { id: 'delete', label: '永久删除', danger: true },
  ];

  const select = (id: string) => {
    setOpen(false);
    if (id === 'move-up') onMove(item, 'up');
    if (id === 'move-down') onMove(item, 'down');
    if (id === 'move') onOpenMove(item);
    if (id === 'delete') {
      if (isFolder) onDeleteFolder(item);
      else onDeleteTask(item);
    }
  };

  return (
    <div ref={containerRef} className="tree-row-actions">
      <IconButton
        label={`打开 ${title} 的操作菜单`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={18} />
      </IconButton>
      {open && (
        <Menu
          id={menuId}
          label={`${title} 的操作`}
          options={options}
          onSelect={select}
          onClose={() => setOpen(false)}
          className="m3e-menu--dense-row"
        />
      )}
    </div>
  );
}

export function TreePage() {
  const params = useParams<{ folderId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusTaskId = searchParams.get('focusTask');
  const [folderId, setFolderId] = useState<string | null>(params.folderId ?? null);
  const [items, setItems] = useState<TreeItemDto[]>([]);
  const [path, setPath] = useState<Array<Pick<FolderDto, 'id' | 'title'>>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [moveTarget, setMoveTarget] = useState<TreeMoveTarget | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderDto[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null);
  const [moveParentId, setMoveParentId] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [groupByStatus, setGroupByStatus] = useState(false);
  /**
   * Status edits are painted onto the row in place so the circle answers the tap
   * immediately, and the row must not move at all until the directory is opened
   * again. Two pins hold it there across the background syncs the edit triggers:
   * `groupPins` remembers the status the row was loaded with so it stays in its
   * group, and `orderLock` remembers the whole row order so a server re-rank
   * cannot shuffle it within that group. Both are released by any load the user
   * asked for directly, so reordering, moving, creating and deleting still land
   * immediately.
   */
  const [statusOverrides, setStatusOverrides] = useState<Record<string, TreeTaskDto>>({});
  const [groupPins, setGroupPins] = useState<Record<string, TaskStatus>>({});
  const [orderLock, setOrderLock] = useState<string[] | null>(null);
  const loadedFolder = useRef<string | null | undefined>(undefined);
  const loadSequence = useRef(0);

  const load = useCallback(
    async (options: { keepPins?: boolean } = {}) => {
      const sequence = ++loadSequence.current;
      const entering = loadedFolder.current !== folderId;
      // Only the background sync triggered by our own status edit may keep the
      // row pinned; arriving in the directory always shows the fresh grouping.
      const keepPins = options.keepPins === true && !entering;
      // Keep rows mounted during background sync so open touch menus survive.
      if (entering) setLoading(true);
      setLoadError('');
      setError('');
      try {
        const query = folderId
          ? `?parentFolderId=${encodeURIComponent(folderId)}`
          : '?parentFolderId=root';
        const [children, nextPath] = await Promise.all([
          requestV2<{ items: TreeItemDto[] }>(`/tree/children${query}`),
          folderId
            ? requestV2<{ items: Array<Pick<FolderDto, 'id' | 'title'>> }>(
                `/folders/${folderId}/path`,
              )
            : Promise.resolve({ items: [] }),
        ]);
        if (sequence !== loadSequence.current) return;
        loadedFolder.current = folderId;
        setItems(children.items);
        // A fresh read is authoritative for the circle.
        setStatusOverrides({});
        if (keepPins) {
          // Drop rows that disappeared; anything still on screen keeps its place.
          const alive = children.items.map(treeItemId);
          setGroupPins((pins) => {
            if (Object.keys(pins).length === 0) return pins;
            const survivors = new Set(alive);
            const kept: Record<string, TaskStatus> = {};
            for (const [id, status] of Object.entries(pins))
              if (survivors.has(id)) kept[id] = status;
            return kept;
          });
          setOrderLock((lock) => {
            if (!lock) return lock;
            const survivors = new Set(alive);
            return lock.filter((id) => survivors.has(id));
          });
        } else {
          setGroupPins({});
          setOrderLock(null);
        }
        setPath(nextPath.items);
        // Remember the folder the user is actually browsing so later quick
        // captures can resolve "most recent valid folder".
        recordLastFolderId(folderId);
      } catch (cause) {
        if (sequence === loadSequence.current)
          setLoadError(cause instanceof Error ? cause.message : '目录加载失败');
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [folderId],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setFolderId(params.folderId ?? null);
  }, [params.folderId]);
  const openFolder = useCallback(
    (id: string | null) => {
      navigate(id ? `/tree/${id}` : '/tree');
    },
    [navigate],
  );
  useEffect(() => {
    if (focusTaskId) {
      const element = document.getElementById(`task-${focusTaskId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [focusTaskId, items]);
  useEffect(() => {
    // Announced from our own status edit and from the sync engine that follows
    // it, so this refresh must not undo the pins that keep the row in place.
    const handler = () => void load({ keepPins: true });
    window.addEventListener('devtodo:data-changed', handler);
    return () => window.removeEventListener('devtodo:data-changed', handler);
  }, [load]);

  const displayTask = useCallback(
    (task: TreeTaskDto): TreeTaskDto => statusOverrides[task.id] ?? task,
    [statusOverrides],
  );

  /**
   * The group a row belongs to. A task the user just re-statused keeps the status
   * it was loaded with, so it only changes group on the next visit.
   */
  const groupingStatus = useCallback(
    (item: TreeItemDto) =>
      item.kind === 'FOLDER'
        ? item.aggregate.status
        : (groupPins[item.task.id] ?? item.task.status),
    [groupPins],
  );

  /**
   * The rows in the order they are drawn. While a status edit is pending the
   * locked order wins, so the background sync that follows the edit can refresh
   * the row's contents without sliding it to a new position. Rows that appeared
   * after the lock was taken are appended rather than dropped.
   */
  const orderedItems = useMemo(() => {
    if (!orderLock) return items;
    const locked = new Map(orderLock.map((id, index) => [id, index]));
    const held: TreeItemDto[] = [];
    const added: TreeItemDto[] = [];
    for (const item of items) (locked.has(treeItemId(item)) ? held : added).push(item);
    held.sort((a, b) => (locked.get(treeItemId(a)) ?? 0) - (locked.get(treeItemId(b)) ?? 0));
    return [...held, ...added];
  }, [items, orderLock]);

  const groups = useMemo(
    () =>
      [
        { key: 'IN_PROGRESS', label: '进行中' },
        { key: 'TODO', label: '待开始' },
        { key: 'DONE', label: '已完成' },
      ].map((group) => ({
        ...group,
        items: orderedItems.filter((item) => groupingStatus(item) === group.key),
      })),
    [orderedItems, groupingStatus],
  );
  const visibleGroups = groupByStatus
    ? groups
    : [{ key: 'ALL', label: '当前目录', items: orderedItems }];
  const statusPosition = (item: TreeItemDto) => {
    const status = groupingStatus(item);
    const group = groups.find((candidate) => candidate.key === status);
    const id = treeItemId(item);
    const index =
      group?.items.findIndex(
        (candidate) => candidate.kind === item.kind && treeItemId(candidate) === id,
      ) ?? 0;
    return { index, length: group?.items.length ?? 1 };
  };

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      await mutationV2('POST', '/tasks', { parentFolderId: folderId, title });
      setNewTitle('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建任务失败，请重试');
    }
  };
  const createFolder = async (event: FormEvent) => {
    event.preventDefault();
    const title = newFolderTitle.trim();
    if (!title) return;
    try {
      await mutationV2('POST', '/folders', { parentFolderId: folderId, title });
      setNewFolderTitle('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建文件夹失败，请重试');
    }
  };
  const deleteTask = (item: Extract<TreeItemDto, { kind: 'TASK' }>) => {
    setConfirmation({
      title: '永久删除任务',
      description: `确定要永久删除“${item.task.title}”吗？它的备注、步骤和所有安排都会一并删除，此操作不可恢复。`,
      confirmLabel: '永久删除',
      danger: true,
      onConfirm: async () => {
        try {
          await mutationV2('DELETE', `/tasks/${item.task.id}`, {
            baseVersion: item.task.version,
          });
          await load();
          return true;
        } catch (cause) {
          throw cause instanceof Error ? cause : new Error('删除任务失败，请重试');
        }
      },
    });
  };
  const changeTaskStatus = async (task: TreeTaskDto, status: TaskStatus) => {
    setError('');
    const current = displayTask(task);
    if (current.status === status) return;
    // Freeze the order currently on screen before the request goes out: the
    // reloads this edit triggers must not slide the row to a new place.
    setOrderLock((lock) => lock ?? items.map(treeItemId));
    try {
      const response = (await mutationV2('PATCH', `/tasks/${task.id}`, {
        status,
        baseVersion: current.version,
      })) as Partial<TreeTaskDto> | null;
      // Keep the row exactly where it is: the circle, its label and the version
      // we send next update locally, while the grouping pin remembers the status
      // this directory was loaded with.
      setStatusOverrides((overrides) => ({
        ...overrides,
        [task.id]: {
          ...current,
          ...response,
          id: task.id,
          status: response?.status ?? status,
          version: response?.version ?? current.version + 1,
        },
      }));
      setGroupPins((pins) => (task.id in pins ? pins : { ...pins, [task.id]: task.status }));
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新任务状态失败，请重试');
    }
  };
  const deleteFolder = async (item: Extract<TreeItemDto, { kind: 'FOLDER' }>) => {
    try {
      const preview = await requestV2<{
        folderCount: number;
        taskCount: number;
        noteCount?: number;
        stepCount?: number;
        placementCount?: number;
        workflowMembershipCount?: number;
        confirmationToken: string;
      }>(`/folders/${item.folder.id}/delete-preview`, { method: 'POST', body: '{}' });
      const dependencies = [
        `文件夹 ${preview.folderCount} 个`,
        `任务 ${preview.taskCount} 个`,
        preview.noteCount !== undefined ? `备注 ${preview.noteCount} 条` : null,
        preview.stepCount !== undefined ? `步骤 ${preview.stepCount} 条` : null,
        preview.placementCount !== undefined ? `日程安排 ${preview.placementCount} 条` : null,
        preview.workflowMembershipCount !== undefined
          ? `流程关联 ${preview.workflowMembershipCount} 条`
          : null,
      ]
        .filter(Boolean)
        .join('，');
      setConfirmation({
        title: '永久删除目录',
        description: (
          <>
            删除“{item.folder.title}”及全部受影响内容。包含：{dependencies}。此操作不可恢复。
          </>
        ),
        confirmLabel: '永久删除',
        danger: true,
        onConfirm: async () => {
          try {
            await mutationV2('DELETE', `/folders/${item.folder.id}/tree`, {
              confirmationToken: preview.confirmationToken,
            });
            await load();
            return true;
          } catch (cause) {
            if (cause instanceof ApiError && cause.code === 'OFFLINE_TREE_DELETE_FORBIDDEN') {
              throw new Error(cause.message);
            }
            throw cause instanceof Error ? cause : new Error('删除操作失败');
          }
        },
      });
    } catch (cause) {
      // Surface the structured offline-refusal guidance instead of a generic
      // network error. Permanent tree deletion is online-only by design.
      if (cause instanceof ApiError && cause.code === 'OFFLINE_TREE_DELETE_FORBIDDEN') {
        setError(cause.message);
        return;
      }
      setError(cause instanceof Error ? cause.message : '删除操作失败');
    }
  };
  const moveWithinStatus = async (item: TreeItemDto, direction: 'up' | 'down') => {
    const status = item.kind === 'FOLDER' ? item.aggregate.status : item.task.status;
    const group = items.filter(
      (candidate) =>
        (candidate.kind === 'FOLDER' ? candidate.aggregate.status : candidate.task.status) ===
        status,
    );
    const index = group.findIndex(
      (candidate) =>
        candidate.kind === item.kind &&
        (candidate.kind === 'FOLDER' ? candidate.folder.id : candidate.task.id) ===
          (item.kind === 'FOLDER' ? item.folder.id : item.task.id),
    );
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= group.length) return;
    const target = group[targetIndex]!;
    try {
      await mutationV2('POST', '/tree/items/move', {
        item: { kind: item.kind, id: item.kind === 'FOLDER' ? item.folder.id : item.task.id },
        parentFolderId: folderId,
        expectedStatus: status,
        baseVersion: item.kind === 'FOLDER' ? item.folder.version : item.task.version,
        ...(direction === 'up'
          ? {
              before: {
                kind: target.kind,
                id: target.kind === 'FOLDER' ? target.folder.id : target.task.id,
              },
            }
          : {
              after: {
                kind: target.kind,
                id: target.kind === 'FOLDER' ? target.folder.id : target.task.id,
              },
            }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '调整顺序失败，请重试');
    }
  };
  const openMove = async (item: TreeItemDto) => {
    try {
      const result = await requestV2<{ items: FolderDto[] }>('/folders');
      const target =
        item.kind === 'FOLDER'
          ? {
              kind: 'FOLDER' as const,
              id: item.folder.id,
              parentFolderId: item.folder.parentFolderId,
              title: item.folder.title,
              expectedStatus: item.aggregate.status,
              baseVersion: item.folder.version,
            }
          : {
              kind: 'TASK' as const,
              id: item.task.id,
              parentFolderId: item.task.parentFolderId,
              title: item.task.title,
              expectedStatus: item.task.status,
              baseVersion: item.task.version,
            };
      setMoveFolders(result.items);
      setMoveParentId(target.parentFolderId ?? '');
      setMoveTarget({
        item: { kind: target.kind, id: target.id },
        parentFolderId: target.parentFolderId,
        title: target.title,
        expectedStatus: target.expectedStatus,
        baseVersion: target.baseVersion,
      });
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法加载目标文件夹');
    }
  };
  const submitMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!moveTarget || moveBusy) return;
    setMoveBusy(true);
    try {
      await mutationV2('POST', '/tree/items/move', {
        item: moveTarget.item,
        parentFolderId: moveParentId || null,
        expectedStatus: moveTarget.expectedStatus,
        baseVersion: moveTarget.baseVersion,
      });
      setMoveTarget(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移动失败，请重试');
    } finally {
      setMoveBusy(false);
    }
  };

  return (
    <section className="page-section tree-page" aria-labelledby="tree-title">
      <div className="page-header tree-page-header">
        <div>
          <p className="eyebrow">目录</p>
          <h1 id="tree-title">目录</h1>
          <p className="page-subtitle">按目录整理任务；日期、事件和流程是任务的其他视图。</p>
        </div>
        <div className="tree-header-actions">
          <Select
            label="显示方式"
            className="m3e-select--tree-view"
            value={groupByStatus ? 'status' : 'tree'}
            onChange={(value) => setGroupByStatus(value === 'status')}
            options={[
              { value: 'tree', label: '目录顺序' },
              { value: 'status', label: '按状态分组' },
            ]}
          />
          <form onSubmit={createFolder} className="inline-capture">
            <TextField
              label="新建文件夹"
              hideLabel
              className="m3e-field--tree-inline"
              placeholder="新建文件夹"
              value={newFolderTitle}
              onChange={(event) => setNewFolderTitle(event.target.value)}
            />
            <Button variant="tonal" type="submit" title="新建文件夹">
              <FolderPlus size={16} />
            </Button>
          </form>
        </div>
      </div>
      <nav className="tree-breadcrumbs" aria-label="目录路径">
        <Button
          variant={!folderId ? 'tonal' : 'text'}
          size="s"
          type="button"
          aria-current={!folderId ? 'page' : undefined}
          className="m3e-button--tree-breadcrumb"
          onClick={() => openFolder(null)}
        >
          根目录
        </Button>
        {path.map((crumb) => (
          <span key={crumb.id} className="tree-breadcrumbs__segment">
            <ChevronRight size={16} aria-hidden="true" />
            <Button
              variant={crumb.id === folderId ? 'tonal' : 'text'}
              size="s"
              type="button"
              aria-current={crumb.id === folderId ? 'page' : undefined}
              className="m3e-button--tree-breadcrumb"
              onClick={() => openFolder(crumb.id)}
            >
              {crumb.title}
            </Button>
          </span>
        ))}
      </nav>
      <form onSubmit={createTask} className="tree-capture-form">
        <Plus size={18} aria-hidden="true" />
        <TextField
          label="新建任务"
          hideLabel
          className="m3e-field--tree-inline"
          placeholder={folderId ? '在当前文件夹新建任务…' : '在根目录新建任务…'}
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
        />
        <Button variant="filled" type="submit">
          添加任务
        </Button>
      </form>
      {error && (
        <Alert tone="error" title="目录操作失败">
          {error}
        </Alert>
      )}
      {loadError && (
        <Alert
          tone="error"
          title="目录加载失败"
          action={
            <Button variant="text" onClick={() => void load()}>
              重试
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}
      {loading ? (
        <LoadingState label="正在加载目录" description="正在同步当前目录中的任务与文件夹。" />
      ) : loadError && loadedFolder.current !== folderId ? null : (
        visibleGroups.map((group) => (
          <Card
            key={group.key}
            as="section"
            variant="outlined"
            className="m3e-card--tree-group"
            aria-labelledby={`tree-group-${group.key}`}
          >
            <div className="tree-group-heading">
              <span id={`tree-group-${group.key}`}>{group.label}</span>
              <span>{group.items.length}</span>
            </div>
            {group.items.length === 0 ? (
              <EmptyState
                compact
                title={`暂无${group.label}项`}
                description="创建任务或文件夹后，它们会显示在这里。"
              />
            ) : (
              <List gap className="m3e-list--tree-group">
                {group.items.map((item, index) =>
                  item.kind === 'FOLDER' ? (
                    <ListItem
                      className="m3e-list-item--tree-row"
                      key={`folder-${item.folder.id}`}
                      leading={<Folder size={20} />}
                      headline={item.folder.title}
                      supporting={
                        <>
                          <Chip
                            kind="assist"
                            label={statusLabel(item.aggregate.status)}
                            className={`m3e-chip--task-status m3e-chip--task-status-${statusClass(item.aggregate.status)}`}
                          />
                          <span className="tree-count">
                            {item.aggregate.doneCount}/{item.aggregate.totalCount} 已完成
                          </span>
                        </>
                      }
                      trailing={<ChevronRight size={16} aria-hidden="true" />}
                      ariaLabel={`打开文件夹 ${item.folder.title}`}
                      onClick={() => openFolder(item.folder.id)}
                      actions={
                        <TreeRowActions
                          item={item}
                          index={groupByStatus ? index : statusPosition(item).index}
                          groupLength={
                            groupByStatus ? group.items.length : statusPosition(item).length
                          }
                          onMove={(candidate, direction) =>
                            void moveWithinStatus(candidate, direction)
                          }
                          onOpenMove={(candidate) => void openMove(candidate)}
                          onDeleteFolder={(candidate) => void deleteFolder(candidate)}
                          onDeleteTask={(candidate) => deleteTask(candidate)}
                        />
                      }
                    />
                  ) : (
                    <ListItem
                      id={`task-${item.task.id}`}
                      className={`m3e-list-item--tree-row${
                        displayTask(item.task).status === 'DONE' ? ' is-task-done' : ''
                      }`}
                      key={`task-${item.task.id}`}
                      leadingControl={
                        <TaskStatusControl
                          status={displayTask(item.task).status}
                          onStatusChange={(status) => changeTaskStatus(item.task, status)}
                        />
                      }
                      headline={item.task.title}
                      supporting={<code>{item.task.referenceId}</code>}
                      selected={focusTaskId === item.task.id}
                      ariaLabel={`打开任务 ${item.task.title}`}
                      onClick={() => setSelectedTaskId(item.task.id)}
                      actions={
                        <TreeRowActions
                          item={item}
                          index={groupByStatus ? index : statusPosition(item).index}
                          groupLength={
                            groupByStatus ? group.items.length : statusPosition(item).length
                          }
                          onMove={(candidate, direction) =>
                            void moveWithinStatus(candidate, direction)
                          }
                          onOpenMove={(candidate) => void openMove(candidate)}
                          onDeleteFolder={(candidate) => void deleteFolder(candidate)}
                          onDeleteTask={(candidate) => deleteTask(candidate)}
                        />
                      }
                    />
                  ),
                )}
              </List>
            )}
          </Card>
        ))
      )}
      {moveTarget && (
        <BottomSheet
          open
          onClose={() => {
            if (!moveBusy) setMoveTarget(null);
          }}
          title="移动目录项"
        >
          <div className="tree-move-sheet">
            <form onSubmit={submitMove}>
              <strong>移动“{moveTarget.title}”</strong>
              {error && (
                <Alert tone="error" title="移动失败">
                  {error}
                </Alert>
              )}
              <Select
                label="目标文件夹"
                value={moveParentId}
                onChange={setMoveParentId}
                options={[
                  { value: '', label: '根目录' },
                  ...moveFolders
                    .filter((folder) => folder.id !== moveTarget.item.id)
                    .map((folder) => ({ value: folder.id, label: folder.title })),
                ]}
              />
              <div className="header-actions">
                <Button
                  variant="tonal"
                  type="button"
                  disabled={moveBusy}
                  onClick={() => setMoveTarget(null)}
                >
                  取消
                </Button>
                <Button variant="filled" type="submit" disabled={moveBusy}>
                  {moveBusy ? '移动中…' : '移动'}
                </Button>
              </div>
            </form>
          </div>
        </BottomSheet>
      )}
      {confirmation && (
        <ConfirmDialog
          open
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          danger={confirmation.danger}
          onClose={() => setConfirmation(null)}
          onConfirm={confirmation.onConfirm}
        />
      )}
      <TaskDetailV2Overlay
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onChanged={() => void load()}
      />
    </section>
  );
}

export function TaskDetailV2Overlay({
  taskId,
  onClose,
  onChanged,
}: {
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetailV2Dto | null>(null);
  const [error, setError] = useState('');
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    if (!taskId) return;
    const sequence = ++loadSequence.current;
    setDetail(null);
    setError('');
    try {
      const nextDetail = await requestV2<TaskDetailV2Dto>(`/tasks/${taskId}`);
      if (sequence === loadSequence.current) setDetail(nextDetail);
    } catch (cause) {
      if (sequence === loadSequence.current)
        setError(cause instanceof Error ? cause.message : '任务详情加载失败');
    }
  }, [taskId]);
  useEffect(() => {
    setDetail(null);
    setError('');
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);
  if (!taskId) return null;
  return (
    <TaskDetailSurface open onClose={onClose} title={detail?.task.title || '任务详情'}>
      {error ? (
        <Alert
          tone="error"
          title="任务详情加载失败"
          action={
            <Button variant="text" size="s" onClick={() => void load()}>
              重试
            </Button>
          }
        >
          {error}
        </Alert>
      ) : detail ? (
        <TaskDetailV2
          key={taskId}
          detail={detail}
          onClose={onClose}
          onChanged={async () => {
            await load();
            onChanged();
          }}
        />
      ) : (
        <LoadingState label="正在加载任务详情" description="正在准备任务、步骤和安排。" />
      )}
    </TaskDetailSurface>
  );
}

/**
 * Task detail presentation. The M3E spec puts a secondary task surface in a
 * side sheet on expanded widths and a bottom sheet on compact/medium, instead
 * of the previous viewport-anchored floating panel.
 */
function TaskDetailSurface({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const sizeClass = useWindowSizeClass();
  if (sizeClass === 'compact' || sizeClass === 'medium')
    return (
      <BottomSheet open={open} onClose={onClose} title={title} size="full">
        {children}
      </BottomSheet>
    );
  return (
    <SideSheet open={open} onClose={onClose} title={title}>
      {children}
    </SideSheet>
  );
}

function TaskDetailV2({
  detail,
  onClose,
  onChanged,
}: {
  detail: TaskDetailV2Dto;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [taskRecord, setTaskRecord] = useState(detail.task);
  const [noteRecord, setNoteRecord] = useState(detail.note);
  const [status, setStatus] = useState(detail.task.status);
  const [title, setTitle] = useState(detail.task.title);
  const [note, setNote] = useState(detail.note.contentMarkdown);
  const [steps, setSteps] = useState(detail.steps);
  const [stepDrafts, setStepDrafts] = useState<
    Record<string, { title: string; noteMarkdown: string }>
  >({});
  const [newStep, setNewStep] = useState('');
  const [folderOptions, setFolderOptions] = useState<FolderDto[]>([]);
  const [moveFolderId, setMoveFolderId] = useState(detail.task.parentFolderId ?? '');
  const [folderBusy, setFolderBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingStepDeletion, setPendingStepDeletion] = useState<TaskStepDto | null>(null);
  const [taskDeletionOpen, setTaskDeletionOpen] = useState(false);
  useEffect(() => {
    setTaskRecord(detail.task);
    setNoteRecord(detail.note);
    setStatus(detail.task.status);
    setTitle(detail.task.title);
    setNote(detail.note.contentMarkdown);
    setSteps(detail.steps);
    setMoveFolderId(detail.task.parentFolderId ?? '');
    setStepDrafts(
      Object.fromEntries(
        detail.steps.map((step) => [
          step.id,
          { title: step.title, noteMarkdown: step.noteMarkdown },
        ]),
      ),
    );
  }, [detail]);
  const updateTask = async (patch: Record<string, unknown>) => {
    try {
      const updated = (await mutationV2('PATCH', `/tasks/${taskRecord.id}`, {
        ...patch,
        baseVersion: taskRecord.version,
      })) as TaskDetailV2Dto['task'];
      setTaskRecord(updated);
      setStatus(updated.status);
      setTitle(updated.title);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务保存失败');
    }
  };
  const updateNote = async () => {
    try {
      const updated = (await mutationV2('PATCH', `/tasks/${taskRecord.id}/note`, {
        contentMarkdown: note,
        baseVersion: noteRecord.version,
      })) as TaskDetailV2Dto['note'];
      setNoteRecord(updated);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备注保存失败');
    }
  };
  const updateStep = async (
    step: TaskStepDto,
    patch: Partial<Pick<TaskStepDto, 'title' | 'noteMarkdown' | 'status'>>,
  ) => {
    try {
      const updated = (await mutationV2('PATCH', `/task-steps/${step.id}`, {
        ...patch,
        baseVersion: step.version,
      })) as TaskStepDto;
      setSteps((current) =>
        current.map((candidate) => (candidate.id === step.id ? updated : candidate)),
      );
      setStepDrafts((current) => ({
        ...current,
        [step.id]: { title: updated.title, noteMarkdown: updated.noteMarkdown },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '步骤保存失败');
    }
  };
  const addStep = async (event: FormEvent) => {
    event.preventDefault();
    if (!newStep.trim()) return;
    try {
      const created = (await mutationV2('POST', `/tasks/${taskRecord.id}/steps`, {
        title: newStep.trim(),
        noteMarkdown: '',
      })) as TaskStepDto;
      setSteps((current) => [...current, created]);
      setNewStep('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '步骤创建失败');
    }
  };
  const moveStep = async (step: TaskStepDto, direction: 'up' | 'down') => {
    const index = steps.findIndex((candidate) => candidate.id === step.id);
    const target = steps[index + (direction === 'up' ? -1 : 1)];
    if (!target) return;
    try {
      const updated = (await mutationV2('POST', `/task-steps/${step.id}/move`, {
        ...(direction === 'up' ? { beforeId: target.id } : { afterId: target.id }),
        baseVersion: step.version,
      })) as TaskStepDto;
      setSteps((current) =>
        [...current.map((candidate) => (candidate.id === step.id ? updated : candidate))].sort(
          (left, right) =>
            BigInt(left.rank) < BigInt(right.rank)
              ? -1
              : BigInt(left.rank) > BigInt(right.rank)
                ? 1
                : 0,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '步骤排序失败');
    }
  };
  const deleteStep = async (step: TaskStepDto) => {
    try {
      await mutationV2('DELETE', `/task-steps/${step.id}`, { baseVersion: step.version });
      setSteps((current) => current.filter((candidate) => candidate.id !== step.id));
      return true;
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('步骤删除失败');
    }
  };
  const loadFolderOptions = async () => {
    try {
      const result = await requestV2<{ items: FolderDto[] }>('/folders');
      setFolderOptions(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录加载失败');
    }
  };
  const moveTask = async () => {
    if (folderBusy || moveFolderId === (taskRecord.parentFolderId ?? '')) return;
    setFolderBusy(true);
    try {
      const updated = (await mutationV2('POST', '/tree/items/move', {
        item: { kind: 'TASK', id: taskRecord.id },
        parentFolderId: moveFolderId || null,
        expectedStatus: taskRecord.status,
        baseVersion: taskRecord.version,
      })) as Extract<TreeItemDto, { kind: 'TASK' }>;
      setTaskRecord(updated.task);
      setStatus(updated.task.status);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录移动失败');
    } finally {
      setFolderBusy(false);
    }
  };
  const updatePlacement = async (placement: TaskDetailV2Dto['placements'][number]) => {
    try {
      await mutationV2('DELETE', `/placements/${placement.id}`, { baseVersion: placement.version });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安排移除失败');
    }
  };
  const deleteTask = async () => {
    try {
      await mutationV2('DELETE', `/tasks/${taskRecord.id}`, {
        baseVersion: taskRecord.version,
      });
      await onChanged();
      onClose();
      return true;
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('任务删除失败');
    }
  };
  return (
    <div className="task-detail-v2">
      <div className="task-detail-v2-header">
        <div>
          <span className="eyebrow">{taskRecord.referenceId}</span>
          <TextField
            className="m3e-field--task-detail-title"
            label="任务标题"
            hideLabel
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() =>
              title.trim() !== taskRecord.title && void updateTask({ title: title.trim() })
            }
          />
        </div>
      </div>
      {error && (
        <Alert tone="error" title="任务操作失败">
          {error}
        </Alert>
      )}
      {pendingStepDeletion && (
        <ConfirmDialog
          open
          title="删除执行步骤"
          description={`删除步骤“${pendingStepDeletion.title}”？此操作不可恢复。`}
          confirmLabel="删除步骤"
          onClose={() => setPendingStepDeletion(null)}
          onConfirm={() => deleteStep(pendingStepDeletion)}
        />
      )}
      {taskDeletionOpen && (
        <ConfirmDialog
          open
          title="删除任务"
          description="删除任务及其备注、步骤、安排和流程成员？此操作不可恢复。"
          confirmLabel="删除任务"
          onClose={() => setTaskDeletionOpen(false)}
          onConfirm={deleteTask}
        />
      )}
      <div className="task-detail-v2-status">
        <ButtonGroup
          value={status}
          label="任务状态"
          onChange={(candidate) => void updateTask({ status: candidate })}
          options={[
            { value: 'TODO', label: '待开始' },
            { value: 'IN_PROGRESS', label: '进行中' },
            { value: 'DONE', label: '已完成' },
          ]}
        />
      </div>
      <div className="task-detail-v2-section">
        <h3>备注</h3>
        <TextArea
          className="m3e-field--task-detail-note"
          label="任务备注"
          hideLabel
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => void updateNote()}
          rows={5}
        />
      </div>
      <div className="task-detail-v2-section">
        <h3>
          执行步骤{' '}
          <span>
            {steps.filter((step) => step.status === 'DONE').length}/{steps.length}
          </span>
        </h3>
        {steps.map((step, index) => {
          const draft = stepDrafts[step.id] ?? {
            title: step.title,
            noteMarkdown: step.noteMarkdown,
          };
          return (
            <div key={step.id} className="step-row step-row-editable">
              <div className="step-editor">
                <TextField
                  className="m3e-field--step-title"
                  label={`步骤 ${index + 1} 标题`}
                  hideLabel
                  value={draft.title}
                  onChange={(event) =>
                    setStepDrafts((current) => ({
                      ...current,
                      [step.id]: { ...draft, title: event.target.value },
                    }))
                  }
                  onBlur={() =>
                    draft.title.trim() !== step.title &&
                    void updateStep(step, { title: draft.title.trim() })
                  }
                />
                <TextArea
                  className="m3e-field--step-note"
                  label={`步骤 ${index + 1} 备注`}
                  hideLabel
                  placeholder="步骤备注（可选）"
                  value={draft.noteMarkdown}
                  onChange={(event) =>
                    setStepDrafts((current) => ({
                      ...current,
                      [step.id]: { ...draft, noteMarkdown: event.target.value },
                    }))
                  }
                  onBlur={() =>
                    draft.noteMarkdown !== step.noteMarkdown &&
                    void updateStep(step, { noteMarkdown: draft.noteMarkdown })
                  }
                  rows={2}
                />
                <Select
                  className="m3e-select--step-status"
                  label={`步骤 ${index + 1} 状态`}
                  value={step.status}
                  onChange={(value) =>
                    void updateStep(step, { status: value as TaskStepDto['status'] })
                  }
                  options={[
                    { value: 'TODO', label: '待开始' },
                    { value: 'IN_PROGRESS', label: '进行中' },
                    { value: 'DONE', label: '已完成' },
                  ]}
                />
              </div>
              <div className="step-actions">
                <IconButton
                  label="步骤上移"
                  type="button"
                  disabled={index === 0}
                  onClick={() => void moveStep(step, 'up')}
                >
                  ↑
                </IconButton>
                <IconButton
                  label="步骤下移"
                  type="button"
                  disabled={index === steps.length - 1}
                  onClick={() => void moveStep(step, 'down')}
                >
                  ↓
                </IconButton>
                <IconButton
                  label="操作"
                  className="m3e-icon-button--danger"
                  type="button"
                  aria-label={`删除步骤 ${step.title}`}
                  onClick={() => setPendingStepDeletion(step)}
                >
                  ×
                </IconButton>
              </div>
            </div>
          );
        })}
        <form className="inline-capture" onSubmit={addStep}>
          <TextField
            className="m3e-field--inline-capture"
            label="新增执行步骤"
            hideLabel
            placeholder="新增执行步骤…"
            value={newStep}
            onChange={(event) => setNewStep(event.target.value)}
          />
          <Button variant="tonal" type="submit" disabled={!newStep.trim()}>
            添加
          </Button>
        </form>
        <span className="muted">步骤状态独立于任务状态，不会自动完成任务。</span>
      </div>
      <div className="task-detail-v2-section">
        <h3>所在目录</h3>
        <p>{detail.folderPath.map((folder) => folder.title).join(' / ') || '根目录'}</p>
        <div className="inline-capture">
          <Select
            className="m3e-select--task-folder"
            label="移动任务到文件夹"
            value={moveFolderId}
            disabled={folderBusy}
            onFocus={() => void loadFolderOptions()}
            onChange={setMoveFolderId}
            options={[
              { value: '', label: '根目录' },
              ...folderOptions.map((folder) => ({ value: folder.id, label: folder.title })),
            ]}
          />
          <Button
            variant="tonal"
            size="s"
            type="button"
            disabled={folderBusy || moveFolderId === (taskRecord.parentFolderId ?? '')}
            onClick={() => void moveTask()}
          >
            {folderBusy ? '移动中…' : '移动'}
          </Button>
        </div>
      </div>
      <div className="task-detail-v2-section">
        <h3>安排</h3>
        {detail.placements.length ? (
          detail.placements.map((placement) => (
            <div className="step-row" key={placement.id}>
              <span>
                <strong>{placementLabel(placement as TaskPlacementDetail)}</strong>
                <small className="muted">
                  {(placement as TaskPlacementDetail).timePoint.type === 'EVENT'
                    ? '事件安排'
                    : '日期安排'}
                </small>
              </span>
              <Button
                variant="tonal"
                size="s"
                type="button"
                onClick={() => void updatePlacement(placement)}
              >
                移除
              </Button>
            </div>
          ))
        ) : (
          <span className="muted">暂无日期或事件安排</span>
        )}
      </div>
      <div className="task-detail-v2-section">
        <h3>所属流程</h3>
        {detail.workflowMemberships.length ? (
          detail.workflowMemberships.map((membership) => (
            <div className="step-row" key={membership.id}>
              <span>
                {membership.workflow.name} · {membership.stage.name}
              </span>
            </div>
          ))
        ) : (
          <span className="muted">暂未加入流程</span>
        )}
      </div>
      <DestructiveSection
        className="m3e-destructive-section--task-detail"
        title="任务管理"
        description={'删除会永久移除任务及其全部关联内容，此操作不可恢复。'}
      >
        <div className="header-actions">
          <Button
            variant="filled"
            className="m3e-button--danger"
            type="button"
            onClick={() => setTaskDeletionOpen(true)}
          >
            删除任务及全部内容
          </Button>
        </div>
      </DestructiveSection>
    </div>
  );
}
