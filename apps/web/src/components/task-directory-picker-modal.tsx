import type { FolderDto, TreeItemDto, TreeTaskDto } from '@devtodo/contracts';
import { Check, ChevronRight, Folder, ListChecksIcon, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, mutationV2, requestV2 } from '../api.js';
import type { TaskStatus } from '@devtodo/contracts';

function taskStatusLabel(status: TaskStatus): string {
  return status === 'IN_PROGRESS' ? '进行中' : status === 'DONE' ? '已完成' : '待开始';
}

function taskStatusClass(status: TaskStatus): string {
  return status === 'IN_PROGRESS' ? 'in-progress' : status === 'DONE' ? 'done' : 'todo';
}
import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  Chip,
  EmptyState as M3EmptyState,
  List,
  ListItem,
  LoadingState,
  Dialog,
  SearchBar,
  TextField,
} from './m3e/index.js';

export interface TaskDirectoryPickerModalProps {
  title: string;
  confirmLabel?: (count: number) => string;
  excludedTaskIds?: ReadonlySet<string>;
  onConfirm: (tasks: TreeTaskDto[]) => Promise<void> | void;
  onClose: () => void;
  /** 可选的新建任务支持（流程页面可切换创建任务与目录选择） */
  createTaskSupport?: {
    onCreateTask: (title: string) => Promise<void> | void;
    helperText?: string;
  };
}

export function TaskDirectoryPickerModal({
  title,
  confirmLabel,
  excludedTaskIds,
  onConfirm,
  onClose,
  createTaskSupport,
}: TaskDirectoryPickerModalProps) {
  const [activeTab, setActiveTab] = useState<'existing' | 'create'>('existing');
  const [newTitle, setNewTitle] = useState('');
  const createFormId = useId();

  const [query, setQuery] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [items, setItems] = useState<TreeItemDto[]>([]);
  const [path, setPath] = useState<Array<Pick<FolderDto, 'id' | 'title'>>>([]);
  const [searchIndex, setSearchIndex] = useState<{
    tasks: TreeTaskDto[];
    folders: FolderDto[];
  } | null>(null);
  const [error, setError] = useState('');
  const [pickerError, setPickerError] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Map<string, TreeTaskDto>>(() => new Map());
  const [submitting, setSubmitting] = useState(false);
  const pickerLoadSequence = useRef(0);
  const searchLoadSequence = useRef(0);

  const loadPicker = useCallback(async () => {
    const sequence = ++pickerLoadSequence.current;
    setPickerLoading(true);
    setPickerError('');
    try {
      const queryString = folderId
        ? `?parentFolderId=${encodeURIComponent(folderId)}`
        : '?parentFolderId=root';
      const [children, nextPath] = await Promise.all([
        requestV2<{ items: TreeItemDto[] }>(`/tree/children${queryString}`),
        folderId
          ? requestV2<{ items: Array<Pick<FolderDto, 'id' | 'title'>> }>(
              `/folders/${encodeURIComponent(folderId)}/path`,
            )
          : Promise.resolve({ items: [] }),
      ]);
      if (sequence !== pickerLoadSequence.current) return;
      setItems(children.items);
      setPath(nextPath.items);
    } catch (cause) {
      if (sequence === pickerLoadSequence.current)
        setPickerError(cause instanceof ApiError ? cause.message : '任务目录加载失败，请重试');
    } finally {
      if (sequence === pickerLoadSequence.current) setPickerLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    void loadPicker();
    const listener = () => {
      setSearchIndex(null);
      setSearchError('');
      setSearchRetry((count) => count + 1);
      void loadPicker();
    };
    window.addEventListener('devtodo:data-changed', listener);
    return () => window.removeEventListener('devtodo:data-changed', listener);
  }, [loadPicker]);

  useEffect(() => {
    const searchText = query.trim();
    if (!searchText || searchIndex) return;
    let cancelled = false;
    const sequence = ++searchLoadSequence.current;
    const timeout = window.setTimeout(() => {
      setSearchError('');
      void Promise.all([
        requestV2<{ items: TreeTaskDto[] }>('/tasks'),
        requestV2<{ items: FolderDto[] }>('/folders'),
      ])
        .then(([taskResult, folderResult]) => {
          if (cancelled || sequence !== searchLoadSequence.current) return;
          setSearchIndex({ tasks: taskResult.items, folders: folderResult.items });
        })
        .catch((cause) => {
          if (cancelled || sequence !== searchLoadSequence.current) return;
          setSearchError(cause instanceof ApiError ? cause.message : '搜索索引加载失败，请重试');
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (sequence === searchLoadSequence.current) searchLoadSequence.current += 1;
    };
  }, [query, searchIndex, searchRetry]);

  const activeItems = useMemo(
    () =>
      items.filter((item) => {
        if (item.kind === 'FOLDER') return true;
        if (item.task.deletedAt || item.task.status === 'DONE') return false;
        if (excludedTaskIds?.has(item.task.id)) return false;
        return true;
      }),
    [items, excludedTaskIds],
  );

  const searchFoldersById = useMemo(() => {
    const byId = new Map<string, FolderDto>();
    for (const folder of searchIndex?.folders ?? []) byId.set(folder.id, folder);
    return byId;
  }, [searchIndex]);

  const taskLocation = useCallback(
    (task: TreeTaskDto) => {
      const titles: string[] = [];
      let parentId = task.parentFolderId;
      let visited = 0;
      while (parentId && visited < (searchIndex?.folders.length ?? 0)) {
        const folder = searchFoldersById.get(parentId);
        if (!folder) break;
        titles.unshift(folder.title);
        parentId = folder.parentFolderId;
        visited += 1;
      }
      return titles.join(' / ') || '根目录';
    },
    [searchFoldersById, searchIndex?.folders.length],
  );

  const matchingTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || !searchIndex) return [];
    return searchIndex.tasks.filter((task) => {
      if (task.deletedAt || task.status === 'DONE') return false;
      if (excludedTaskIds?.has(task.id)) return false;
      return (
        task.title.toLocaleLowerCase().includes(needle) ||
        task.referenceId.toLocaleLowerCase().includes(needle) ||
        taskLocation(task).toLocaleLowerCase().includes(needle)
      );
    });
  }, [query, searchIndex, taskLocation, excludedTaskIds]);

  const searchLoading = Boolean(query.trim()) && !searchIndex && !searchError;

  const openFolder = (id: string | null) => {
    setQuery('');
    setFolderId(id);
  };

  const toggleTaskSelection = (task: TreeTaskDto) => {
    setSelectedTasks((current) => {
      const next = new Map(current);
      if (next.has(task.id)) next.delete(task.id);
      else next.set(task.id, task);
      return next;
    });
  };

  const handleConfirmSelected = async () => {
    if (submitting || selectedTasks.size === 0) return;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm([...selectedTasks.values()]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed || !createTaskSupport || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await createTaskSupport.onCreateTask(trimmed);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建任务失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const renderTaskRow = (task: TreeTaskDto, showLocation: boolean) => {
    const selected = selectedTasks.has(task.id);
    return (
      <ListItem
        key={task.id}
        className="m3e-list-item--picker m3e-list-item--tree-row"
        headline={task.title}
        supporting={
          showLocation ? (
            <span className="task-picker-location">{taskLocation(task)}</span>
          ) : undefined
        }
        leading={
          <span
            className={`task-picker-selection${selected ? ' is-selected' : ''}`}
            aria-hidden="true"
          >
            {selected && <Check size={15} strokeWidth={3} />}
          </span>
        }
        trailing={!selected && <Plus size={18} aria-hidden="true" />}
        selected={selected}
        onClick={() => toggleTaskSelection(task)}
        disabled={submitting}
        ariaLabel={`${selected ? '取消选择' : '选择'}任务 ${task.title}`}
      />
    );
  };

  const renderTreeItem = (item: TreeItemDto) =>
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
              label={taskStatusLabel(item.aggregate.status)}
              className={`m3e-chip--task-status m3e-chip--task-status-${taskStatusClass(item.aggregate.status)}`}
            />
            <span className="tree-count">
              {item.aggregate.doneCount}/{item.aggregate.totalCount} 已完成
            </span>
          </>
        }
        trailing={<ChevronRight size={16} aria-hidden="true" />}
        ariaLabel={`打开文件夹 ${item.folder.title}`}
        onClick={() => openFolder(item.folder.id)}
      />
    ) : (
      renderTaskRow(item.task, false)
    );

  const defaultConfirmLabel = (count: number) => `加入日程${count ? `（${count}）` : ''}`;

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        activeTab === 'existing' ? (
          <>
            <span className="task-picker-selection-count" aria-live="polite">
              已选择 {selectedTasks.size} 项
            </span>
            <Button
              variant="text"
              size="s"
              disabled={selectedTasks.size === 0 || submitting}
              onClick={() => setSelectedTasks(new Map())}
            >
              清空选择
            </Button>
            <Button
              variant="filled"
              disabled={selectedTasks.size === 0 || submitting}
              onClick={() => void handleConfirmSelected()}
            >
              {submitting ? '正在加入…' : (confirmLabel ?? defaultConfirmLabel)(selectedTasks.size)}
            </Button>
          </>
        ) : (
          <>
            <Button variant="text" type="button" disabled={submitting} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="filled"
              type="submit"
              form={createFormId}
              disabled={submitting || !newTitle.trim()}
            >
              {submitting ? '创建中…' : '创建并加入'}
            </Button>
          </>
        )
      }
    >
      {createTaskSupport && (
        <ButtonGroup
          label="添加方式"
          value={activeTab}
          options={[
            { value: 'existing' as const, label: '选择已有任务' },
            { value: 'create' as const, label: '新建任务' },
          ]}
          onChange={setActiveTab}
          className="m3e-button-group--add-task-mode"
        />
      )}

      {error && (
        <Alert tone="error" title="操作失败">
          {error}
        </Alert>
      )}

      {activeTab === 'create' && createTaskSupport ? (
        <form id={createFormId} className="stack-form" onSubmit={handleCreateSubmit}>
          <TextField
            label="任务标题"
            autoFocus
            value={newTitle}
            helperText={createTaskSupport.helperText ?? '新任务会先创建在默认捕获目录，再加入。'}
            disabled={submitting}
            onChange={(event) => setNewTitle(event.target.value)}
          />
        </form>
      ) : (
        <>
          <SearchBar
            label="搜索任务或目录"
            variant="view"
            autoFocus
            value={query}
            onChange={(value) => {
              setSearchError('');
              setQuery(value);
            }}
            placeholder="搜索标题、引用 ID 或目录"
            leadingIcon={<Search size={20} />}
          />
          {pickerError && (
            <Alert
              tone="error"
              action={
                <Button variant="text" size="s" onClick={() => void loadPicker()}>
                  重试
                </Button>
              }
            >
              {pickerError}
            </Alert>
          )}
          {searchError && query.trim() && (
            <Alert
              tone="error"
              title="搜索目录失败"
              action={
                <Button
                  variant="text"
                  size="s"
                  onClick={() => {
                    setSearchError('');
                    setSearchRetry((count) => count + 1);
                  }}
                >
                  重试
                </Button>
              }
            >
              {searchError}
            </Alert>
          )}
          {!query.trim() && (
            <p className="field-help picker-hint">
              点选任务可同时选择多项；选择会在切换目录时保留。
            </p>
          )}
          {query.trim() ? (
            <div className="task-picker-scroll" role="region" aria-label="任务搜索结果">
              {searchLoading ? (
                <LoadingState label="正在搜索任务目录" />
              ) : searchError ? null : matchingTasks.length ? (
                <List className="m3e-list--picker m3e-list--tree-group" gap>
                  {matchingTasks.map((task) => renderTaskRow(task, true))}
                </List>
              ) : (
                <M3EmptyState
                  compact
                  icon={<ListChecksIcon size={20} />}
                  title="没有可选择的任务"
                  description="换一个标题、引用 ID 或目录名称再试。"
                />
              )}
            </div>
          ) : (
            <>
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
              <div
                key={folderId ?? 'root'}
                className="task-picker-scroll"
                role="region"
                aria-label="当前目录"
              >
                {pickerLoading ? (
                  <LoadingState label="正在加载目录" />
                ) : pickerError && !activeItems.length ? null : (
                  <Card
                    as="section"
                    variant="outlined"
                    className="m3e-card--tree-group"
                    aria-labelledby="task-picker-current-folder"
                  >
                    <div className="tree-group-heading">
                      <span id="task-picker-current-folder">当前目录</span>
                      <span>{activeItems.length}</span>
                    </div>
                    {activeItems.length ? (
                      <List className="m3e-list--picker m3e-list--tree-group" gap>
                        {activeItems.map(renderTreeItem)}
                      </List>
                    ) : (
                      <M3EmptyState
                        compact
                        icon={<ListChecksIcon size={20} />}
                        title={folderId ? '此目录没有可安排的任务' : '没有未完成任务'}
                        description={
                          folderId
                            ? '当前目录中没有未完成任务；可以返回上级目录。'
                            : '根目录下没有未完成任务。'
                        }
                      />
                    )}
                  </Card>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
