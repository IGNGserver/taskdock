import type {
  FolderDto,
  TaskDetailV2Dto,
  TaskStatus,
  TaskStepDto,
  TreeItemDto,
  TreeTaskDto,
  WorkflowDto,
} from '@devtodo/contracts';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
  Plus,
  Workflow as WorkflowGlyph,
} from 'lucide-react';
import { ApiError, mutationV2, requestV2 } from './api.js';
import { useAuth } from './auth.js';
import {
  BottomSheet,
  Button,
  IconButton,
  Menu,
  SideSheet,
  TextField,
  useDismissibleMenu,
  useWindowSizeClass,
  type MenuOption,
} from './components/m3e/index.js';
import { recordLastFolderId, resolveCaptureFolder } from './folder-preference.js';

function statusLabel(status: string): string {
  return status === 'IN_PROGRESS' ? '进行中' : status === 'DONE' ? '已完成' : '待开始';
}

function statusClass(status: string): string {
  return status === 'IN_PROGRESS' ? 'in-progress' : status === 'DONE' ? 'done' : 'todo';
}

type TreeMoveTarget = {
  item: { kind: 'FOLDER' | 'TASK'; id: string };
  parentFolderId: string | null;
  expectedStatus: 'TODO' | 'IN_PROGRESS' | 'DONE';
  baseVersion: number;
  title: string;
};

function TreeRowActions({
  item,
  index,
  groupLength,
  onMove,
  onOpenMove,
  onArchiveFolder,
  onDeleteFolder,
  onArchiveTask,
}: {
  item: TreeItemDto;
  index: number;
  groupLength: number;
  onMove: (item: TreeItemDto, direction: 'up' | 'down') => void;
  onOpenMove: (item: TreeItemDto) => void;
  onArchiveFolder: (item: Extract<TreeItemDto, { kind: 'FOLDER' }>) => void;
  onDeleteFolder: (item: Extract<TreeItemDto, { kind: 'FOLDER' }>) => void;
  onArchiveTask: (item: Extract<TreeItemDto, { kind: 'TASK' }>) => void;
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
    { id: 'archive', label: isFolder ? '归档文件夹' : '归档任务' },
    ...(isFolder ? [{ id: 'delete', label: '永久删除', danger: true }] : []),
  ];

  const select = (id: string) => {
    setOpen(false);
    if (id === 'move-up') onMove(item, 'up');
    if (id === 'move-down') onMove(item, 'down');
    if (id === 'move') onOpenMove(item);
    if (id === 'archive') {
      if (isFolder) onArchiveFolder(item);
      else onArchiveTask(item);
    }
    if (id === 'delete' && isFolder) onDeleteFolder(item);
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
  const [detail, setDetail] = useState<TaskDetailV2Dto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [moveTarget, setMoveTarget] = useState<TreeMoveTarget | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderDto[]>([]);
  const [moveParentId, setMoveParentId] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
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
      setItems(children.items);
      setPath(nextPath.items);
      // Remember the folder the user is actually browsing so later quick
      // captures can resolve "most recent valid folder".
      recordLastFolderId(folderId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录加载失败');
    } finally {
      setLoading(false);
    }
  }, [folderId]);

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
    const handler = () => void load();
    window.addEventListener('devtodo:data-changed', handler);
    return () => window.removeEventListener('devtodo:data-changed', handler);
  }, [load]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(null);
      return;
    }
    void requestV2<TaskDetailV2Dto>(`/tasks/${selectedTaskId}`)
      .then(setDetail)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '任务加载失败'));
  }, [selectedTaskId]);

  const groups = useMemo(
    () =>
      [
        { key: 'IN_PROGRESS', label: '进行中' },
        { key: 'TODO', label: '待开始' },
        { key: 'DONE', label: '已完成' },
      ].map((group) => ({
        ...group,
        items: items.filter(
          (item) =>
            (item.kind === 'FOLDER' ? item.aggregate.status : item.task.status) === group.key,
        ),
      })),
    [items],
  );

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    await mutationV2('POST', '/tasks', { parentFolderId: folderId, title });
    setNewTitle('');
    await load();
  };
  const createFolder = async (event: FormEvent) => {
    event.preventDefault();
    const title = newFolderTitle.trim();
    if (!title) return;
    await mutationV2('POST', '/folders', { parentFolderId: folderId, title });
    setNewFolderTitle('');
    await load();
  };
  const archiveFolder = async (item: Extract<TreeItemDto, { kind: 'FOLDER' }>) => {
    if (
      !window.confirm(
        `归档“${item.folder.title}”及其 ${item.aggregate.totalCount} 个有效后代任务？`,
      )
    )
      return;
    await mutationV2('POST', `/folders/${item.folder.id}/archive-tree`, {
      baseVersion: item.folder.version,
    });
    await load();
  };
  const archiveTask = async (item: Extract<TreeItemDto, { kind: 'TASK' }>) => {
    await mutationV2('POST', `/tasks/${item.task.id}/archive`, {
      baseVersion: item.task.version,
    });
    await load();
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
      const deps = [
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
      if (
        !window.confirm(
          `删除目录及全部受影响内容？\n包含：${deps}。\n此操作为永久级联删除，不可恢复。确认继续？`,
        )
      )
        return;
      await mutationV2('DELETE', `/folders/${item.folder.id}/tree`, {
        confirmationToken: preview.confirmationToken,
      });
      await load();
    } catch (cause) {
      // Surface the structured offline-refusal guidance instead of a generic
      // network error. Permanent tree deletion is online-only by design.
      if (cause instanceof ApiError && cause.code === 'OFFLINE_TREE_DELETE_FORBIDDEN') {
        alert(`${cause.message}\n\n建议：改为递归归档整棵目录。`);
        return;
      }
      alert(cause instanceof Error ? cause.message : '删除操作失败');
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
  };
  const openMove = async (item: TreeItemDto) => {
    try {
      const result = await requestV2<{ items: FolderDto[] }>('/folders?archived=false');
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
      <div className="page-header">
        <div>
          <p className="eyebrow">目录</p>
          <h1 id="tree-title">目录</h1>
          <p className="page-subtitle">任务只有一个目录位置，日期、时间点和流程都是独立视图。</p>
        </div>
        <div className="tree-header-actions">
          <form onSubmit={createFolder} className="inline-capture">
            <TextField
              label="新建文件夹"
              hideLabel
              className="tree-inline-field"
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
      <div className="tree-breadcrumbs" aria-label="目录路径">
        <button
          type="button"
          onClick={() => openFolder(null)}
          className={!folderId ? 'active' : ''}
        >
          根目录
        </button>
        {path.map((crumb) => (
          <span key={crumb.id}>
            <ChevronRight size={16} />
            <button
              type="button"
              onClick={() => openFolder(crumb.id)}
              className={crumb.id === folderId ? 'active' : ''}
            >
              {crumb.title}
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={createTask} className="tree-capture-form">
        <Plus size={18} aria-hidden="true" />
        <TextField
          label="新建任务"
          hideLabel
          className="tree-inline-field"
          placeholder={folderId ? '在当前文件夹新建任务…' : '在根目录新建任务…'}
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
        />
        <Button variant="filled" type="submit">
          添加任务
        </Button>
      </form>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="empty-state">正在加载目录…</div>
      ) : (
        groups.map((group) => (
          <section
            key={group.key}
            className="tree-group"
            aria-labelledby={`tree-group-${group.key}`}
          >
            <div className="tree-group-heading">
              <span id={`tree-group-${group.key}`}>{group.label}</span>
              <span>{group.items.length}</span>
            </div>
            {group.items.length === 0 ? (
              <div className="tree-group-empty">暂无{group.label}项</div>
            ) : (
              group.items.map((item, index) =>
                item.kind === 'FOLDER' ? (
                  <article className="tree-row folder-row" key={`folder-${item.folder.id}`}>
                    <button
                      type="button"
                      className="tree-main-button"
                      onClick={() => openFolder(item.folder.id)}
                      aria-label={`打开文件夹 ${item.folder.title}`}
                    >
                      <Folder size={20} />
                      <span className="tree-item-title">{item.folder.title}</span>
                      <span className={`status-chip ${statusClass(item.aggregate.status)}`}>
                        {statusLabel(item.aggregate.status)}
                      </span>
                      <span className="tree-count">
                        {item.aggregate.doneCount}/{item.aggregate.totalCount}
                      </span>
                      <ChevronRight size={16} />
                    </button>
                    <TreeRowActions
                      item={item}
                      index={index}
                      groupLength={group.items.length}
                      onMove={(candidate, direction) => void moveWithinStatus(candidate, direction)}
                      onOpenMove={(candidate) => void openMove(candidate)}
                      onArchiveFolder={(candidate) => void archiveFolder(candidate)}
                      onDeleteFolder={(candidate) => void deleteFolder(candidate)}
                      onArchiveTask={(candidate) => void archiveTask(candidate)}
                    />
                  </article>
                ) : (
                  <article
                    id={`task-${item.task.id}`}
                    className={`tree-row task-row-v2 ${focusTaskId === item.task.id ? 'focused-highlight' : ''}`}
                    key={`task-${item.task.id}`}
                  >
                    <button
                      type="button"
                      className="tree-main-button"
                      onClick={() => setSelectedTaskId(item.task.id)}
                      aria-label={`打开任务 ${item.task.title}`}
                    >
                      <ListChecks size={20} />
                      <span className="tree-item-title">{item.task.title}</span>
                      <code>{item.task.referenceId}</code>
                      <span className={`status-chip ${statusClass(item.task.status)}`}>
                        {statusLabel(item.task.status)}
                      </span>
                    </button>
                    <TreeRowActions
                      item={item}
                      index={index}
                      groupLength={group.items.length}
                      onMove={(candidate, direction) => void moveWithinStatus(candidate, direction)}
                      onOpenMove={(candidate) => void openMove(candidate)}
                      onArchiveFolder={(candidate) => void archiveFolder(candidate)}
                      onDeleteFolder={(candidate) => void deleteFolder(candidate)}
                      onArchiveTask={(candidate) => void archiveTask(candidate)}
                    />
                  </article>
                ),
              )
            )}
          </section>
        ))
      )}
      {moveTarget && (
        <div className="tree-move-sheet" role="dialog" aria-label="移动目录项">
          <form onSubmit={submitMove}>
            <strong>移动“{moveTarget.title}”</strong>
            <label className="field">
              <span>目标文件夹</span>
              <select
                value={moveParentId}
                onChange={(event) => setMoveParentId(event.target.value)}
              >
                <option value="">根目录</option>
                {moveFolders
                  .filter((folder) => folder.id !== moveTarget.item.id)
                  .map((folder) => (
                    <option value={folder.id} key={folder.id}>
                      {folder.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="header-actions">
              <Button variant="tonal" type="button" onClick={() => setMoveTarget(null)}>
                取消
              </Button>
              <Button variant="filled" type="submit" disabled={moveBusy}>
                {moveBusy ? '移动中…' : '移动'}
              </Button>
            </div>
          </form>
        </div>
      )}
      {selectedTaskId && detail && (
        <TaskDetailV2 detail={detail} onClose={() => setSelectedTaskId(null)} onChanged={load} />
      )}
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
  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      setDetail(await requestV2<TaskDetailV2Dto>(`/tasks/${taskId}`));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务详情加载失败');
    }
  }, [taskId]);
  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);
  if (!taskId || !detail)
    return error ? (
      <div className="error-banner" role="alert">
        {error}
      </div>
    ) : null;
  return (
    <TaskDetailSurface open onClose={onClose} title={detail.task.title || '任务详情'}>
      <TaskDetailV2
        detail={detail}
        onClose={onClose}
        onChanged={async () => {
          await load();
          onChanged();
        }}
      />
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
  const archived = Boolean(taskRecord.archivedAt);
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
    if (archived) return;
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
    if (!newStep.trim() || archived) return;
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
    if (!target || archived) return;
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
    if (archived || !window.confirm(`删除步骤“${step.title}”？`)) return;
    try {
      await mutationV2('DELETE', `/task-steps/${step.id}`, { baseVersion: step.version });
      setSteps((current) => current.filter((candidate) => candidate.id !== step.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '步骤删除失败');
    }
  };
  const loadFolderOptions = async () => {
    try {
      const result = await requestV2<{ items: FolderDto[] }>('/folders?archived=false');
      setFolderOptions(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录加载失败');
    }
  };
  const moveTask = async () => {
    if (archived || folderBusy || moveFolderId === (taskRecord.parentFolderId ?? '')) return;
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
    if (archived) return;
    try {
      await mutationV2('DELETE', `/placements/${placement.id}`, { baseVersion: placement.version });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安排移除失败');
    }
  };
  const duplicate = async () => {
    try {
      await mutationV2('POST', `/tasks/${taskRecord.id}/duplicate`, {});
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务复制失败');
    }
  };
  const deleteTask = async () => {
    if (!window.confirm('删除任务及其备注、步骤、安排和流程成员？此操作不可恢复。')) return;
    try {
      await mutationV2('DELETE', `/tasks/${taskRecord.id}`, {
        baseVersion: taskRecord.version,
      });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务删除失败');
    }
  };
  return (
    <div className="task-detail-v2">
      <div className="task-detail-v2-header">
        <div>
          <span className="eyebrow">{taskRecord.referenceId}</span>
          <input
            className="task-detail-title"
            value={title}
            disabled={archived}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() =>
              title.trim() !== taskRecord.title && void updateTask({ title: title.trim() })
            }
          />
        </div>
        <div className="header-actions">
          <Button
            variant="tonal"
            size="s"
            type="button"
            disabled={archived}
            onClick={() => void duplicate()}
          >
            复制任务
          </Button>
          <IconButton label="关闭任务详情" type="button" onClick={onClose}>
            ×
          </IconButton>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {archived && <div className="archive-notice">此任务已归档；恢复后才能编辑。</div>}
      <div className="task-detail-v2-status">
        <span>任务状态</span>
        {(['TODO', 'IN_PROGRESS', 'DONE'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            disabled={archived}
            className={status === candidate ? 'active' : ''}
            onClick={() => void updateTask({ status: candidate })}
          >
            {statusLabel(candidate)}
          </button>
        ))}
      </div>
      <div className="task-detail-v2-section">
        <h3>备注</h3>
        <textarea
          value={note}
          disabled={archived}
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
                <input
                  aria-label={`步骤 ${index + 1} 标题`}
                  value={draft.title}
                  disabled={archived}
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
                <textarea
                  aria-label={`步骤 ${index + 1} 备注`}
                  placeholder="步骤备注（可选）"
                  value={draft.noteMarkdown}
                  disabled={archived}
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
                <select
                  aria-label={`步骤 ${index + 1} 状态`}
                  value={step.status}
                  disabled={archived}
                  onChange={(event) =>
                    void updateStep(step, { status: event.target.value as TaskStepDto['status'] })
                  }
                >
                  <option value="TODO">待开始</option>
                  <option value="IN_PROGRESS">进行中</option>
                  <option value="DONE">已完成</option>
                </select>
              </div>
              <div className="step-actions">
                <IconButton
                  label="步骤上移"
                  type="button"
                  disabled={archived || index === 0}
                  onClick={() => void moveStep(step, 'up')}
                >
                  ↑
                </IconButton>
                <IconButton
                  label="步骤下移"
                  type="button"
                  disabled={archived || index === steps.length - 1}
                  onClick={() => void moveStep(step, 'down')}
                >
                  ↓
                </IconButton>
                <IconButton
                  label="操作"
                  className="m3e-icon-button--danger"
                  type="button"
                  aria-label={`删除步骤 ${step.title}`}
                  disabled={archived}
                  onClick={() => void deleteStep(step)}
                >
                  ×
                </IconButton>
              </div>
            </div>
          );
        })}
        <form className="inline-capture" onSubmit={addStep}>
          <input
            aria-label="新增执行步骤"
            placeholder="新增执行步骤…"
            value={newStep}
            onChange={(event) => setNewStep(event.target.value)}
            disabled={archived}
          />
          <Button variant="tonal" type="submit" disabled={archived || !newStep.trim()}>
            添加
          </Button>
        </form>
        <span className="muted">步骤状态独立于任务状态，不会自动完成任务。</span>
      </div>
      <div className="task-detail-v2-section">
        <h3>所在目录</h3>
        <p>{detail.folderPath.map((folder) => folder.title).join(' / ') || '根目录'}</p>
        <div className="inline-capture">
          <select
            aria-label="移动任务到文件夹"
            value={moveFolderId}
            disabled={archived || folderBusy}
            onFocus={() => void loadFolderOptions()}
            onChange={(event) => setMoveFolderId(event.target.value)}
          >
            <option value="">根目录</option>
            {folderOptions.map((folder) => (
              <option value={folder.id} key={folder.id}>
                {folder.title}
              </option>
            ))}
          </select>
          <Button
            variant="tonal"
            size="s"
            type="button"
            disabled={archived || folderBusy || moveFolderId === (taskRecord.parentFolderId ?? '')}
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
              <span>{placement.timePointId}</span>
              <Button
                variant="tonal"
                size="s"
                type="button"
                disabled={archived}
                onClick={() => void updatePlacement(placement)}
              >
                移除
              </Button>
            </div>
          ))
        ) : (
          <span className="muted">暂无日期或时间点安排</span>
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
      <div className="header-actions">
        <Button
          variant="tonal"
          type="button"
          onClick={() => {
            void mutationV2('POST', `/tasks/${taskRecord.id}/${archived ? 'restore' : 'archive'}`, {
              baseVersion: taskRecord.version,
            })
              .then((updated) => {
                setTaskRecord(updated as TaskDetailV2Dto['task']);
                return onChanged();
              })
              .catch((cause) => setError(cause instanceof Error ? cause.message : '归档操作失败'));
          }}
        >
          {archived ? '恢复任务' : '归档任务'}
        </Button>
        <Button
          variant="filled"
          className="m3e-button--danger"
          type="button"
          onClick={() => void deleteTask()}
        >
          删除任务及全部内容
        </Button>
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const { settings } = useAuth();
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [tasks, setTasks] = useState<TreeTaskDto[]>([]);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [name, setName] = useState('');
  const [stageDrafts, setStageDrafts] = useState<Record<string, string>>({});
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, string>>({});
  const [stageNameDrafts, setStageNameDrafts] = useState<Record<string, string>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [newTaskDrafts, setNewTaskDrafts] = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [workflowResult, taskResult, folderResult] = await Promise.all([
        requestV2<{ items: WorkflowDto[] }>('/workflows?includeArchived=true'),
        requestV2<{ items: TreeTaskDto[] }>('/tasks'),
        requestV2<{ items: FolderDto[] }>('/folders'),
      ]);
      setWorkflows(workflowResult.items);
      setTasks(taskResult.items);
      setFolders(folderResult.items);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '流程加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '流程操作失败');
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    await run(() => mutationV2('POST', '/workflows', { name }));
    setName('');
  };
  const createTaskInStage = async (stage: NonNullable<WorkflowDto['stages']>[number]) => {
    const title = newTaskDrafts[stage.id]?.trim();
    if (!title) return;
    // Honour the same capture-target contract as the tree and Today page: the
    // open folder wins, otherwise the recent/updated folder, and ROOT means root.
    const validFolderId = resolveCaptureFolder({
      activeFolderId: null,
      defaultCaptureTarget: settings?.defaultCaptureTarget,
      folders,
    });
    await run(async () => {
      const created = (await mutationV2('POST', '/tasks', {
        parentFolderId: validFolderId,
        title,
      })) as {
        task: TreeTaskDto;
      };
      await mutationV2('POST', `/workflow-stages/${stage.id}/tasks`, { taskId: created.task.id });
      setNewTaskDrafts((current) => ({ ...current, [stage.id]: '' }));
    });
  };

  return (
    <section className="page-section workflows-page" aria-labelledby="workflows-title">
      <div className="page-header">
        <div>
          <p className="eyebrow">流程</p>
          <h1 id="workflows-title">流程</h1>
          <p className="page-subtitle">一个任务可以加入多个流程；阶段只表示流程位置。</p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={create} className="tree-capture-form">
        <TextField
          label="新建流程"
          hideLabel
          className="tree-inline-field"
          placeholder="新建流程…"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button variant="filled" type="submit">
          创建流程
        </Button>
      </form>
      {workflows.length === 0 && !error && (
        <div className="empty-state workflow-empty-state">
          <div className="empty-icon">
            <WorkflowGlyph size={24} aria-hidden="true" />
          </div>
          <h2>还没有流程</h2>
          <p>把重复的发布、插件或维护步骤拆成可复用的阶段。</p>
        </div>
      )}
      {workflows.map((workflow) => {
        const stages = workflow.stages ?? [];
        const memberIds = new Set(stages.flatMap((stage) => stage.tasks.map((task) => task.id)));
        const availableTasks = tasks.filter((task) => !task.archivedAt && !memberIds.has(task.id));
        return (
          <article className="workflow-card" key={workflow.id}>
            <header>
              <div>
                <input
                  className="workflow-name-input"
                  aria-label={`流程名称 ${workflow.name}`}
                  value={workflowDrafts[workflow.id] ?? workflow.name}
                  disabled={Boolean(workflow.archivedAt)}
                  onChange={(event) =>
                    setWorkflowDrafts((current) => ({
                      ...current,
                      [workflow.id]: event.target.value,
                    }))
                  }
                  onBlur={() => {
                    const nextName = workflowDrafts[workflow.id]?.trim();
                    if (nextName && nextName !== workflow.name)
                      void run(() =>
                        mutationV2('PATCH', `/workflows/${workflow.id}`, {
                          name: nextName,
                          baseVersion: workflow.version,
                        }),
                      );
                  }}
                />
                <span>
                  {stages.length} 个阶段 · {memberIds.size} 个任务
                </span>
              </div>
              <div className="header-actions">
                <Button
                  variant="tonal"
                  size="s"
                  type="button"
                  onClick={() =>
                    void run(() =>
                      mutationV2(
                        'POST',
                        `/workflows/${workflow.id}/${workflow.archivedAt ? 'restore' : 'archive'}`,
                        { baseVersion: workflow.version },
                      ),
                    )
                  }
                >
                  {workflow.archivedAt ? '恢复流程' : '归档流程'}
                </Button>
                <Button
                  variant="filled"
                  size="s"
                  className="m3e-button--danger"
                  type="button"
                  onClick={() => {
                    if (window.confirm('删除流程结构？不会删除任务。'))
                      void run(() =>
                        mutationV2('DELETE', `/workflows/${workflow.id}`, {
                          baseVersion: workflow.version,
                        }),
                      );
                  }}
                >
                  删除
                </Button>
              </div>
            </header>
            <div className="workflow-stages">
              {stages.map((stage, index) => (
                <section key={stage.id}>
                  <div className="workflow-stage-heading">
                    <input
                      className="workflow-stage-name-input"
                      aria-label={`阶段名称 ${stage.name}`}
                      value={stageNameDrafts[stage.id] ?? stage.name}
                      disabled={Boolean(workflow.archivedAt)}
                      onChange={(event) =>
                        setStageNameDrafts((current) => ({
                          ...current,
                          [stage.id]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const nextName = stageNameDrafts[stage.id]?.trim();
                        if (nextName && nextName !== stage.name)
                          void run(() =>
                            mutationV2('PATCH', `/workflow-stages/${stage.id}`, {
                              name: nextName,
                              baseVersion: stage.version,
                            }),
                          );
                      }}
                    />
                    {stage.hiddenTaskCount ? (
                      <span className="muted">{stage.hiddenTaskCount} 个已归档任务已隐藏</span>
                    ) : null}
                    <div>
                      <IconButton
                        label="阶段上移"
                        type="button"
                        disabled={index === 0}
                        onClick={() =>
                          void run(() =>
                            mutationV2('POST', `/workflow-stages/${stage.id}/move`, {
                              beforeId: stages[index - 1]?.id ?? null,
                              afterId: null,
                              baseVersion: stage.version,
                            }),
                          )
                        }
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        label="阶段下移"
                        type="button"
                        disabled={index === stages.length - 1}
                        onClick={() =>
                          void run(() =>
                            mutationV2('POST', `/workflow-stages/${stage.id}/move`, {
                              beforeId: null,
                              afterId: stages[index + 1]?.id ?? null,
                              baseVersion: stage.version,
                            }),
                          )
                        }
                      >
                        ↓
                      </IconButton>
                      <IconButton
                        label="操作"
                        className="m3e-icon-button--danger"
                        type="button"
                        aria-label={`删除阶段 ${stage.name}`}
                        disabled={Boolean(workflow.archivedAt)}
                        onClick={() => {
                          if (window.confirm('删除阶段及其中的流程成员？不会删除任务。'))
                            void run(() =>
                              mutationV2('DELETE', `/workflow-stages/${stage.id}`, {
                                baseVersion: stage.version,
                              }),
                            );
                        }}
                      >
                        ×
                      </IconButton>
                    </div>
                  </div>
                  {stage.tasks.map((task, taskIndex) => {
                    const membership = stage.memberships?.find(
                      (candidate) => candidate.taskId === task.id,
                    );
                    const folderTitle = task.parentFolderId
                      ? (folders.find((f) => f.id === task.parentFolderId)?.title ?? '目录')
                      : '根目录';
                    const nextStatusMap: Record<TaskStatus, TaskStatus> = {
                      TODO: 'IN_PROGRESS',
                      IN_PROGRESS: 'DONE',
                      DONE: 'TODO',
                    };
                    const prevMember = taskIndex > 0 ? stage.tasks[taskIndex - 1] : null;
                    const nextMember =
                      taskIndex < stage.tasks.length - 1 ? stage.tasks[taskIndex + 1] : null;
                    return (
                      <div className="workflow-task" key={task.id}>
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <button
                              type="button"
                              className={`status-pill ${task.status.toLowerCase()}`}
                              title="点击直接切换状态"
                              onClick={() =>
                                void run(() =>
                                  mutationV2('PATCH', `/tasks/${task.id}`, {
                                    status: nextStatusMap[task.status],
                                    baseVersion: task.version,
                                  }),
                                )
                              }
                            >
                              {task.status === 'DONE'
                                ? '✓ 已完成'
                                : task.status === 'IN_PROGRESS'
                                  ? '进行中'
                                  : '待办'}
                            </button>
                            <Button
                              variant="text"
                              type="button"
                              title="打开任务详情"
                              onClick={() => setSelectedTaskId(task.id)}
                              style={{ fontWeight: 500 }}
                            >
                              {task.title}
                            </Button>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              fontSize: '0.8rem',
                              color: '#666',
                            }}
                          >
                            <code>{task.referenceId}</code>
                            <span>📁 {folderTitle}</span>
                          </div>
                        </div>
                        <div className="header-actions">
                          {taskIndex > 0 && membership && prevMember && (
                            <Button
                              variant="text"
                              type="button"
                              title="阶段内上移"
                              onClick={() =>
                                void run(() =>
                                  mutationV2(
                                    'POST',
                                    `/workflow-memberships/${membership.id}/move`,
                                    {
                                      stageId: stage.id,
                                      beforeId: stage.memberships?.find(
                                        (m) => m.taskId === prevMember.id,
                                      )?.id,
                                      baseVersion: membership.version,
                                    },
                                  ),
                                )
                              }
                            >
                              ↑
                            </Button>
                          )}
                          {taskIndex < stage.tasks.length - 1 && membership && nextMember && (
                            <Button
                              variant="text"
                              type="button"
                              title="阶段内下移"
                              onClick={() =>
                                void run(() =>
                                  mutationV2(
                                    'POST',
                                    `/workflow-memberships/${membership.id}/move`,
                                    {
                                      stageId: stage.id,
                                      afterId: stage.memberships?.find(
                                        (m) => m.taskId === nextMember.id,
                                      )?.id,
                                      baseVersion: membership.version,
                                    },
                                  ),
                                )
                              }
                            >
                              ↓
                            </Button>
                          )}
                          {index > 0 && membership && (
                            <Button
                              variant="text"
                              type="button"
                              title="移到上一阶段"
                              onClick={() =>
                                void run(() =>
                                  mutationV2(
                                    'POST',
                                    `/workflow-memberships/${membership.id}/move`,
                                    {
                                      stageId: stages[index - 1]!.id,
                                      baseVersion: membership.version,
                                    },
                                  ),
                                )
                              }
                            >
                              ←
                            </Button>
                          )}
                          {index < stages.length - 1 && membership && (
                            <Button
                              variant="text"
                              type="button"
                              title="移到下一阶段"
                              onClick={() =>
                                void run(() =>
                                  mutationV2(
                                    'POST',
                                    `/workflow-memberships/${membership.id}/move`,
                                    {
                                      stageId: stages[index + 1]!.id,
                                      baseVersion: membership.version,
                                    },
                                  ),
                                )
                              }
                            >
                              →
                            </Button>
                          )}
                          {membership && (
                            <Button
                              variant="text"
                              className="danger-text"
                              type="button"
                              onClick={() =>
                                void run(() =>
                                  mutationV2('DELETE', `/workflow-memberships/${membership.id}`, {
                                    baseVersion: membership.version,
                                  }),
                                )
                              }
                            >
                              移除
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div className="workflow-add-task">
                    <select
                      aria-label={`添加任务到${stage.name}`}
                      value={taskDrafts[stage.id] ?? ''}
                      onChange={(event) =>
                        setTaskDrafts((current) => ({ ...current, [stage.id]: event.target.value }))
                      }
                    >
                      <option value="">添加已有任务…</option>
                      {availableTasks.map((task) => (
                        <option value={task.id} key={task.id}>
                          {task.title}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="tonal"
                      size="s"
                      type="button"
                      disabled={!taskDrafts[stage.id]}
                      onClick={() =>
                        void run(() =>
                          mutationV2('POST', `/workflow-stages/${stage.id}/tasks`, {
                            taskId: taskDrafts[stage.id],
                          }).then(() =>
                            setTaskDrafts((current) => ({ ...current, [stage.id]: '' })),
                          ),
                        )
                      }
                    >
                      添加
                    </Button>
                    <input
                      aria-label={`在${stage.name}中新建任务`}
                      placeholder="新建任务…"
                      value={newTaskDrafts[stage.id] ?? ''}
                      disabled={Boolean(workflow.archivedAt)}
                      onChange={(event) =>
                        setNewTaskDrafts((current) => ({
                          ...current,
                          [stage.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void createTaskInStage(stage);
                      }}
                    />
                    <Button
                      variant="tonal"
                      size="s"
                      type="button"
                      disabled={Boolean(workflow.archivedAt) || !newTaskDrafts[stage.id]?.trim()}
                      onClick={() => void createTaskInStage(stage)}
                    >
                      新建并加入
                    </Button>
                  </div>
                </section>
              ))}
            </div>
            <div className="workflow-add-stage">
              <input
                aria-label={`为${workflow.name}新增阶段`}
                placeholder="新增阶段…"
                value={stageDrafts[workflow.id] ?? ''}
                onChange={(event) =>
                  setStageDrafts((current) => ({ ...current, [workflow.id]: event.target.value }))
                }
              />
              <Button
                variant="tonal"
                size="s"
                type="button"
                disabled={!stageDrafts[workflow.id]?.trim()}
                onClick={() =>
                  void run(() =>
                    mutationV2('POST', `/workflows/${workflow.id}/stages`, {
                      name: stageDrafts[workflow.id],
                    }).then(() => setStageDrafts((current) => ({ ...current, [workflow.id]: '' }))),
                  )
                }
              >
                新增阶段
              </Button>
            </div>
          </article>
        );
      })}
      <TaskDetailV2Overlay
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onChanged={load}
      />
    </section>
  );
}

export function AllTasksV2Page() {
  const [tasks, setTasks] = useState<
    Array<{ id: string; title: string; referenceId: string; status: string; version: number }>
  >([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await requestV2<{ items: typeof tasks }>('/tasks');
      setTasks(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务加载失败');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="page-section all-tasks-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">任务</p>
          <h1>所有任务</h1>
          <p className="page-subtitle">按任务本体查看，不复制目录、日期或流程中的任务。</p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="tree-group">
        {tasks.map((task) => (
          <article className="tree-row task-row-v2" key={task.id}>
            <button
              type="button"
              className="tree-main-button"
              onClick={() => setSelectedTaskId(task.id)}
              aria-label={`打开任务 ${task.title}`}
            >
              <ListChecks size={20} />
              <span className="tree-item-title">{task.title}</span>
              <code>{task.referenceId}</code>
              <span className={`status-chip ${statusClass(task.status)}`}>
                {statusLabel(task.status)}
              </span>
            </button>
            <IconButton
              label="操作"
              type="button"
              onClick={() =>
                void mutationV2('POST', `/tasks/${task.id}/archive`, {
                  baseVersion: task.version,
                }).then(load)
              }
              aria-label={`归档任务 ${task.title}`}
            >
              <Archive size={16} />
            </IconButton>
          </article>
        ))}
      </div>
      <TaskDetailV2Overlay
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onChanged={load}
      />
    </section>
  );
}
