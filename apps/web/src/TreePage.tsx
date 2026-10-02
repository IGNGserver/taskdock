import type {
  FolderDto,
  TaskDetailV2Dto,
  TaskStatus,
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
import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { ApiError, mutationV2, requestV2 } from './api.js';
import { useDevice } from './device.js';
import {
  Alert,
  BottomSheet,
  Button,
  ConfirmDialog,
  Dialog,
  Disclosure,
  Snackbar,
  useWindowSizeClass,
  EmptyState,
  IconButton,
  List,
  ListItem,
  LoadingState,
  Menu,
  Select,
  TaskStatusControl,
  TextField,
  useDismissibleMenu,
  type MenuOption,
} from './components/m3e/index.js';
import { recordLastFolderId } from './folder-preference.js';
import { blockedDirectoryTargets } from './directory-paths.js';
import { FolderPicker } from './components/folder-picker.js';
import { TaskDetailEditor } from './components/task-detail-editor.js';
import type { TaskEditorDraft } from './task-editor-draft.js';

/** Stable identity for a directory row, whichever kind it holds. */
function treeItemId(item: TreeItemDto): string {
  return item.kind === 'FOLDER' ? item.folder.id : item.task.id;
}

type MoveSession = { items: TreeItemDto[]; parentFolderId: string | null };
type FolderDeletePreview = {
  folderCount: number;
  taskCount: number;
  noteCount?: number;
  stepCount?: number;
  placementCount?: number;
  workflowMembershipCount?: number;
  confirmationToken: string;
};
function itemRecord(item: TreeItemDto) {
  return item.kind === 'FOLDER' ? item.folder : item.task;
}
function itemStatus(item: TreeItemDto): TaskStatus {
  return item.kind === 'FOLDER' ? item.aggregate.status : item.task.status;
}
function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

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
  onRename,
  onDeleteFolder,
  onDeleteTask,
}: {
  item: TreeItemDto;
  index: number;
  groupLength: number;
  onMove: (item: TreeItemDto, direction: 'up' | 'down') => void;
  onOpenMove: (item: TreeItemDto) => void;
  onRename: (item: TreeItemDto) => void;
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
      label: '同状态上移',
      hint: '↑',
      disabled: index === 0,
    },
    {
      id: 'move-down',
      label: '同状态下移',
      hint: '↓',
      disabled: index === groupLength - 1,
    },
    { id: 'rename', label: '重命名', hint: 'F2' },
    { id: 'move', label: '移动到其他目录' },
    { id: 'delete', label: '永久删除', danger: true },
  ];

  const select = (id: string) => {
    setOpen(false);
    if (id === 'move-up') onMove(item, 'up');
    if (id === 'move-down') onMove(item, 'down');
    if (id === 'rename') onRename(item);
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
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusTaskId = searchParams.get('focusTask');
  const [folderId, setFolderId] = useState<string | null>(params.folderId ?? null);
  const [items, setItems] = useState<TreeItemDto[]>([]);
  const [path, setPath] = useState<Array<Pick<FolderDto, 'id' | 'title'>>>([]);
  const selectedTaskId = searchParams.get('task');
  const selectTask = (id: string, editTitle = false) => {
    const next = new URLSearchParams(searchParams);
    next.set('task', id);
    if (editTitle) next.set('editTitle', '1');
    else next.delete('editTitle');
    setSearchParams(next);
    if (editTitle)
      window.dispatchEvent(new CustomEvent('devtodo:focus-task-title', { detail: id }));
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [moveSession, setMoveSession] = useState<MoveSession | null>(null);
  const [moveError, setMoveError] = useState('');
  const [moveUndo, setMoveUndo] = useState<MoveSession | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [folderDialog, setFolderDialog] = useState<{
    item?: FolderDto;
    parentId: string | null;
  } | null>(null);
  const [folderError, setFolderError] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const captureLock = useRef(false);
  const captureRevision = useRef(0);
  const draggedItem = useRef<TreeItemDto | null>(null);
  const { isPhone } = useDevice();
  const currentFolder = useRef(folderId);
  currentFolder.current = folderId;
  const captureInput = useRef<HTMLInputElement>(null);
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
  const matchesFilter = (item: TreeItemDto) => {
    const record = itemRecord(item);
    return `${record.title} ${item.kind === 'TASK' ? item.task.referenceId : ''}`
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase());
  };
  const visibleGroups = (
    groupByStatus ? groups : [{ key: 'ALL', label: '当前目录', items: orderedItems }]
  )
    .map((group) => ({ ...group, items: group.items.filter(matchesFilter) }))
    .filter((group) => group.items.length > 0);
  const visibleItems = orderedItems.filter(matchesFilter);
  const selectedItems = items.filter((item) => selected.has(treeItemId(item)));
  const blockedTargets = blockedDirectoryTargets(
    moveFolders,
    moveSession?.items.filter((item) => item.kind === 'FOLDER').map(treeItemId) ?? [],
  );
  const toggleSelection = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    setSelected(new Set());
    setSelectionMode(false);
    setFilter('');
  }, [folderId]);
  useEffect(() => {
    setSelected(
      (previous) =>
        new Set([...previous].filter((id) => items.some((item) => treeItemId(item) === id))),
    );
  }, [items]);
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
    if (!title || captureLock.current) return;
    const parent = folderId;
    const submittedRevision = captureRevision.current;
    captureLock.current = true;
    setCaptureBusy(true);
    setError('');
    try {
      await mutationV2('POST', '/tasks', { parentFolderId: parent, title });
      if (currentFolder.current === parent) {
        if (captureRevision.current === submittedRevision) setNewTitle('');
        await load({ keepPins: true });
      }
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setError(errorMessage(cause, '创建任务失败，请重试'));
    } finally {
      captureLock.current = false;
      setCaptureBusy(false);
      if (
        currentFolder.current === parent &&
        (document.activeElement === document.body ||
          document.activeElement === captureInput.current)
      )
        captureInput.current?.focus();
    }
  };
  const createFolder = async (event: FormEvent) => {
    event.preventDefault();
    const title = newFolderTitle.trim();
    if (!title || folderBusy || !folderDialog) return;
    setFolderBusy(true);
    setFolderError('');
    try {
      if (folderDialog.item)
        await mutationV2('PATCH', `/folders/${folderDialog.item.id}`, {
          title,
          baseVersion: folderDialog.item.version,
        });
      else await mutationV2('POST', '/folders', { parentFolderId: folderDialog.parentId, title });
      setNewFolderTitle('');
      setFolderDialog(null);
      await load();
      window.dispatchEvent(new Event('devtodo:data-changed'));
    } catch (cause) {
      setFolderError(errorMessage(cause, '文件夹保存失败，请重试'));
    } finally {
      setFolderBusy(false);
    }
  };
  const renameItem = (item: TreeItemDto) => {
    if (item.kind === 'TASK') selectTask(item.task.id, true);
    else {
      setNewFolderTitle(item.folder.title);
      setFolderError('');
      setFolderDialog({ item: item.folder, parentId: item.folder.parentFolderId });
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
          window.dispatchEvent(new Event('devtodo:data-changed'));
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
            window.dispatchEvent(new Event('devtodo:data-changed'));
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
  const dropItemBefore = async (target: TreeItemDto) => {
    const source = draggedItem.current;
    draggedItem.current = null;
    if (!source || treeItemId(source) === treeItemId(target)) return;
    const latest = source.kind === 'TASK' ? { ...source, task: displayTask(source.task) } : source;
    if (itemStatus(latest) !== itemStatus(target)) {
      setError('请在相同状态的项目之间调整顺序');
      return;
    }
    const sourceIndex = items.findIndex((item) => treeItemId(item) === treeItemId(source));
    const targetIndex = items.findIndex((item) => treeItemId(item) === treeItemId(target));
    try {
      await mutationV2('POST', '/tree/items/move', {
        item: { kind: latest.kind, id: treeItemId(latest) },
        parentFolderId: folderId,
        expectedStatus: itemStatus(latest),
        baseVersion: itemRecord(latest).version,
        ...(sourceIndex < targetIndex
          ? { after: { kind: target.kind, id: treeItemId(target) } }
          : { before: { kind: target.kind, id: treeItemId(target) } }),
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause, '调整顺序失败，请重试'));
    }
  };
  const openMove = async (candidates: TreeItemDto[]) => {
    try {
      const result = await requestV2<{ items: FolderDto[] }>('/folders');
      setMoveFolders(result.items);
      setMoveParentId(folderId ?? '');
      setMoveError('');
      setMoveSession({
        items: candidates.map((item) =>
          item.kind === 'TASK' ? { ...item, task: displayTask(item.task) } : item,
        ),
        parentFolderId: folderId,
      });
    } catch (cause) {
      setError(errorMessage(cause, '无法加载目标文件夹'));
    }
  };
  const submitMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!moveSession || moveBusy) return;
    const targetParent = moveParentId || null;
    if (targetParent === moveSession.parentFolderId || blockedTargets.has(moveParentId)) return;
    setMoveBusy(true);
    setMoveError('');
    const moved: TreeItemDto[] = [];
    const failed: TreeItemDto[] = [];
    const messages: string[] = [];
    for (const item of moveSession.items) {
      try {
        // Read the current version after a previous partial failure or status edit.
        const fresh =
          items.find(
            (candidate) =>
              candidate.kind === item.kind && treeItemId(candidate) === treeItemId(item),
          ) ?? item;
        const latest = fresh.kind === 'TASK' ? { ...fresh, task: displayTask(fresh.task) } : fresh;
        const response = (await mutationV2('POST', '/tree/items/move', {
          item: { kind: latest.kind, id: treeItemId(latest) },
          parentFolderId: targetParent,
          expectedStatus: itemStatus(latest),
          baseVersion: itemRecord(latest).version,
        })) as TreeItemDto;
        moved.push(response);
      } catch (cause) {
        failed.push(item);
        messages.push(`${itemRecord(item).title}：${errorMessage(cause, '移动失败')}`);
      }
    }
    if (moved.length) {
      setMoveUndo({ items: moved, parentFolderId: moveSession.parentFolderId });
      setSelected(
        (previous) =>
          new Set([...previous].filter((id) => !moved.some((item) => treeItemId(item) === id))),
      );
    }
    setMoveSession(failed.length ? { ...moveSession, items: failed } : null);
    await load();
    window.dispatchEvent(new Event('devtodo:data-changed'));
    if (failed.length)
      setMoveError(
        `${moved.length ? `已移动 ${moved.length} 项；` : ''}${failed.length} 项失败，内容仍在原目录。${messages.join('；')}`,
      );
    setMoveBusy(false);
  };
  const undoMove = async () => {
    if (!moveUndo || moveBusy) return;
    setMoveBusy(true);
    const failed: TreeItemDto[] = [];
    const messages: string[] = [];
    for (const item of moveUndo.items) {
      try {
        await mutationV2('POST', '/tree/items/move', {
          item: { kind: item.kind, id: treeItemId(item) },
          parentFolderId: moveUndo.parentFolderId,
          expectedStatus: itemStatus(item),
          baseVersion: itemRecord(item).version,
        });
      } catch (cause) {
        failed.push(item);
        messages.push(`${itemRecord(item).title}：${errorMessage(cause, '撤销失败')}`);
      }
    }
    setMoveUndo(failed.length ? { ...moveUndo, items: failed } : null);
    await load();
    if (failed.length) setError(`撤销失败：${messages.join('；')}`);
    window.dispatchEvent(new Event('devtodo:data-changed'));
    setMoveBusy(false);
  };
  const deleteSelected = async () => {
    if (!selectedItems.length) return;
    try {
      const previews = new Map<string, FolderDeletePreview>();
      for (const item of selectedItems)
        if (item.kind === 'FOLDER')
          previews.set(
            item.folder.id,
            await requestV2<FolderDeletePreview>(`/folders/${item.folder.id}/delete-preview`, {
              method: 'POST',
              body: '{}',
            }),
          );
      const folderCount = [...previews.values()].reduce(
        (sum, preview) => sum + preview.folderCount,
        0,
      );
      const taskCount =
        selectedItems.filter((item) => item.kind === 'TASK').length +
        [...previews.values()].reduce((sum, preview) => sum + preview.taskCount, 0);
      let remaining = [...selectedItems];
      setConfirmation({
        title: '永久删除所选内容',
        description: `将删除 ${folderCount} 个文件夹、${taskCount} 个任务及其备注、步骤和关联安排。此操作不可恢复。`,
        confirmLabel: '永久删除',
        danger: true,
        onConfirm: async () => {
          const failed: TreeItemDto[] = [];
          const messages: string[] = [];
          for (const item of remaining) {
            try {
              if (item.kind === 'TASK')
                await mutationV2('DELETE', `/tasks/${item.task.id}`, {
                  baseVersion: item.task.version,
                });
              else
                await mutationV2('DELETE', `/folders/${item.folder.id}/tree`, {
                  confirmationToken: previews.get(item.folder.id)!.confirmationToken,
                });
            } catch (cause) {
              failed.push(item);
              messages.push(`${itemRecord(item).title}：${errorMessage(cause, '删除失败')}`);
            }
          }
          remaining = failed;
          setSelected(new Set(failed.map(treeItemId)));
          await load();
          window.dispatchEvent(new Event('devtodo:data-changed'));
          if (failed.length)
            throw new Error(`${failed.length} 项未删除：${messages.join('；')}。成功项已移除。`);
          return true;
        },
      });
    } catch (cause) {
      setError(errorMessage(cause, '无法确认删除范围'));
    }
  };
  const renderRows = (rows: TreeItemDto[]) => (
    <List className="m3e-list--tree-group">
      {rows.map((item) => {
        const record = itemRecord(item);
        const position = statusPosition(item);
        const folder = item.kind === 'FOLDER';
        return (
          <ListItem
            key={`${item.kind}-${record.id}`}
            id={folder ? `folder-${record.id}` : `task-${record.id}`}
            className={`m3e-list-item--tree-row${!folder && displayTask(item.task).status === 'DONE' ? ' is-task-done' : ''}`}
            leading={folder ? <Folder size={19} /> : undefined}
            leadingControl={
              <>
                {selectionMode && (
                  <input
                    type="checkbox"
                    className="tree-selection-checkbox"
                    aria-label={`选择 ${record.title}`}
                    checked={selected.has(record.id)}
                    onChange={() => toggleSelection(record.id)}
                  />
                )}
                {!folder && (
                  <TaskStatusControl
                    status={displayTask(item.task).status}
                    onStatusChange={(status) => changeTaskStatus(item.task, status)}
                  />
                )}
              </>
            }
            headline={record.title}
            trailing={
              folder ? (
                <>
                  <span className="tree-count">
                    {item.aggregate.totalCount
                      ? `${item.aggregate.doneCount}/${item.aggregate.totalCount}`
                      : ''}
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </>
              ) : undefined
            }
            selected={
              folder
                ? selected.has(record.id)
                : selectedTaskId === record.id ||
                  focusTaskId === record.id ||
                  selected.has(record.id)
            }
            ariaLabel={`${folder ? '打开文件夹' : '打开任务'} ${record.title}`}
            onClick={() => (folder ? openFolder(record.id) : selectTask(record.id))}
            draggable={!isPhone && !selectionMode}
            onDragStart={(event) => {
              draggedItem.current = item;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', treeItemId(item));
            }}
            onDragOver={(event) => {
              if (draggedItem.current && itemStatus(draggedItem.current) === itemStatus(item)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              void dropItemBefore(item);
            }}
            onDragEnd={() => {
              draggedItem.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === 'F2') {
                event.preventDefault();
                renameItem(item);
              }
            }}
            actions={
              <TreeRowActions
                item={item}
                index={position.index}
                groupLength={position.length}
                onMove={(candidate, direction) => void moveWithinStatus(candidate, direction)}
                onOpenMove={(candidate) => void openMove([candidate])}
                onRename={renameItem}
                onDeleteFolder={(candidate) => void deleteFolder(candidate)}
                onDeleteTask={deleteTask}
              />
            }
          />
        );
      })}
    </List>
  );

  return (
    <section className="page-section tree-page" aria-labelledby="tree-title">
      <nav className="tree-breadcrumbs" aria-label="目录路径">
        <Button
          variant="text"
          size="s"
          aria-current={!folderId ? 'page' : undefined}
          onClick={() => openFolder(null)}
        >
          根目录
        </Button>
        {path.map((crumb) => (
          <span key={crumb.id} className="tree-breadcrumbs__segment">
            <ChevronRight size={14} aria-hidden="true" />
            <Button
              variant="text"
              size="s"
              aria-current={crumb.id === folderId ? 'page' : undefined}
              onClick={() => openFolder(crumb.id)}
            >
              {crumb.title}
            </Button>
          </span>
        ))}
      </nav>
      <div className="page-header tree-page-header">
        <h1 id="tree-title">{path.at(-1)?.title ?? '根目录'}</h1>
        <div className="tree-header-actions">
          <Button
            variant="text"
            size="s"
            leadingIcon={<FolderPlus size={16} />}
            onClick={() => {
              setNewFolderTitle('');
              setFolderError('');
              setFolderDialog({ parentId: folderId });
            }}
          >
            新建文件夹
          </Button>
          <Button
            variant={selectionMode ? 'tonal' : 'text'}
            size="s"
            aria-pressed={selectionMode}
            onClick={() => {
              setSelectionMode((current) => !current);
              setSelected(new Set());
            }}
          >
            {selectionMode ? '结束选择' : '选择'}
          </Button>
        </div>
      </div>
      <form onSubmit={(event) => void createTask(event)} className="tree-capture-form">
        <Plus size={18} aria-hidden="true" />
        <div className="tree-capture-input">
          <input
            ref={captureInput}
            aria-label="新建任务"
            placeholder="添加任务，按 Enter 保存…"
            value={newTitle}
            onChange={(event) => {
              captureRevision.current += 1;
              setNewTitle(event.target.value);
            }}
          />
        </div>
        <Button variant="filled" size="s" type="submit" disabled={captureBusy || !newTitle.trim()}>
          {captureBusy ? '保存中…' : '添加任务'}
        </Button>
      </form>
      <div className="tree-list-toolbar">
        <TextField
          label="筛选当前目录"
          hideLabel
          placeholder="筛选当前目录…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          leadingIcon={<Search size={16} />}
        />
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
      </div>
      {selectionMode && (
        <div className="tree-selection-toolbar" role="region" aria-label="批量操作">
          <label>
            <input
              type="checkbox"
              aria-label="全选当前可见项"
              checked={
                visibleItems.length > 0 &&
                visibleItems.every((item) => selected.has(treeItemId(item)))
              }
              onChange={() =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  const all = visibleItems.every((item) => next.has(treeItemId(item)));
                  for (const item of visibleItems)
                    if (all) next.delete(treeItemId(item));
                    else next.add(treeItemId(item));
                  return next;
                })
              }
            />
            全选
          </label>
          <span>已选 {selectedItems.length} 项</span>
          <Button
            variant="tonal"
            size="s"
            disabled={!selectedItems.length}
            onClick={() => void openMove(selectedItems)}
          >
            移动
          </Button>
          <Button
            variant="text"
            size="s"
            disabled={!selectedItems.length}
            onClick={() => void deleteSelected()}
          >
            删除
          </Button>
        </div>
      )}
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
        <LoadingState label="正在加载目录" />
      ) : loadError && loadedFolder.current !== folderId ? null : visibleGroups.length ? (
        visibleGroups.map((group) =>
          group.key === 'DONE' ? (
            <Disclosure
              key={group.key}
              title={`已完成 · ${group.items.length}`}
              className="tree-completed-group"
            >
              {renderRows(group.items)}
            </Disclosure>
          ) : (
            <section key={group.key} className="tree-list-group" aria-label={group.label}>
              {groupByStatus && (
                <div className="tree-group-heading">
                  <span>{group.label}</span>
                  <span>{group.items.length}</span>
                </div>
              )}
              {renderRows(group.items)}
            </section>
          ),
        )
      ) : (
        <EmptyState
          compact
          title={filter ? '没有匹配项' : '文件夹为空'}
          description={filter ? '换个关键词，或清空筛选。' : '在上方输入任务，或新建一个文件夹。'}
        />
      )}
      {moveUndo && (
        <Snackbar
          message={`已移动 ${moveUndo.items.length} 项`}
          action={{ label: moveBusy ? '处理中…' : '撤销', onAction: () => void undoMove() }}
        />
      )}
      {moveSession && (
        <Dialog
          open
          title={`移动${moveSession.items.length === 1 ? `“${itemRecord(moveSession.items[0]!).title}”` : `${moveSession.items.length} 项`}`}
          onClose={() => {
            if (!moveBusy) setMoveSession(null);
          }}
        >
          <form className="tree-move-sheet" onSubmit={(event) => void submitMove(event)}>
            {moveError && (
              <Alert tone="error" title="部分内容未移动">
                {moveError}
              </Alert>
            )}
            <FolderPicker
              folders={moveFolders}
              value={moveParentId}
              onChange={setMoveParentId}
              blocked={blockedTargets}
              disabled={moveBusy}
            />
            <div className="header-actions">
              <Button variant="text" disabled={moveBusy} onClick={() => setMoveSession(null)}>
                取消
              </Button>
              <Button
                type="submit"
                variant="filled"
                disabled={
                  moveBusy ||
                  moveParentId === (moveSession.parentFolderId ?? '') ||
                  blockedTargets.has(moveParentId)
                }
              >
                {moveBusy ? '移动中…' : moveError ? '重试失败项' : '移动'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {folderDialog && (
        <Dialog
          open
          title={folderDialog.item ? '重命名文件夹' : '新建文件夹'}
          onClose={() => {
            if (!folderBusy) setFolderDialog(null);
          }}
        >
          <form className="tree-move-sheet" onSubmit={(event) => void createFolder(event)}>
            {folderError && (
              <Alert tone="error" title="保存失败">
                {folderError}
              </Alert>
            )}
            <TextField
              label="文件夹名称"
              value={newFolderTitle}
              onChange={(event) => setNewFolderTitle(event.target.value)}
              autoFocus
            />
            <div className="header-actions">
              <Button variant="text" disabled={folderBusy} onClick={() => setFolderDialog(null)}>
                取消
              </Button>
              <Button
                variant="filled"
                type="submit"
                disabled={folderBusy || !newFolderTitle.trim()}
              >
                {folderBusy ? '保存中…' : '保存'}
              </Button>
            </div>
          </form>
        </Dialog>
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
    </section>
  );
}

export function TaskDetailV2Overlay({
  taskId,
  onClose,
  onChanged,
  focusTitle = false,
}: {
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
  focusTitle?: boolean;
}) {
  const [detail, setDetail] = useState<TaskDetailV2Dto | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const drafts = useRef(new Map<string, TaskEditorDraft>());
  const load = useCallback(async () => {
    if (!taskId) return;
    const requestSequence = ++sequence.current;
    try {
      const nextDetail = await requestV2<TaskDetailV2Dto>(`/tasks/${taskId}`);
      if (requestSequence === sequence.current) {
        setDetail(nextDetail);
        setError('');
      }
    } catch (cause) {
      if (requestSequence === sequence.current) setError(errorMessage(cause, '任务详情加载失败'));
    }
  }, [taskId]);
  useEffect(() => {
    setDetail(null);
    setError('');
    void load();
    const changed = () => void load();
    window.addEventListener('devtodo:data-changed', changed);
    return () => {
      sequence.current += 1;
      window.removeEventListener('devtodo:data-changed', changed);
    };
  }, [load]);
  if (!taskId) return null;
  const current = detail?.task.id === taskId ? detail : null;
  return (
    <TaskDetailSurface onClose={onClose}>
      {error && (
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
      )}
      {current ? (
        <TaskDetailEditor
          key={taskId}
          detail={current}
          drafts={drafts.current}
          focusTitle={focusTitle}
          onClose={onClose}
          onChanged={onChanged}
        />
      ) : (
        !error && <LoadingState label="正在加载任务详情" />
      )}
    </TaskDetailSurface>
  );
}
function TaskDetailSurface({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { isPhone } = useDevice();
  const sizeClass = useWindowSizeClass();
  if (isPhone || sizeClass === 'compact')
    return (
      <BottomSheet open onClose={onClose} title="任务详情" size="full">
        {children}
      </BottomSheet>
    );
  return (
    <aside className="workspace-task-detail" aria-label="任务详情">
      <div className="workspace-detail-header">
        <span>任务详情</span>
        <IconButton size="s" label="关闭任务详情" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="workspace-detail-scroll">{children}</div>
    </aside>
  );
}
