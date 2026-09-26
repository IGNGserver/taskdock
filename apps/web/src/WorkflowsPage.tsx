import type {
  FolderDto,
  TaskStatus,
  TreeTaskDto,
  WorkflowDto,
  WorkflowTaskMembershipDto,
} from '@devtodo/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  Folder,
  ListChecks as ListChecksIcon,
  MoreHorizontal,
  Plus,
  Search,
  Workflow as WorkflowGlyph,
} from 'lucide-react';

import { mutationV2, requestV2 } from './api.js';
import { useAuth } from './auth.js';
import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  List,
  ListItem,
  LoadingState,
  Menu,
  SearchBar,
  TaskStatusControl,
  TextField,
  useDismissibleMenu,
  type MenuOption,
} from './components/m3e/index.js';
import { resolveCaptureFolder } from './folder-preference.js';
import { TaskDetailV2Overlay } from './TreePage.js';

type WorkflowStage = NonNullable<WorkflowDto['stages']>[number];

/** The single modal slot of the board: every verb opens one of these. */
type WorkflowDialog =
  | { kind: 'create-workflow' }
  | { kind: 'rename-workflow'; workflow: WorkflowDto }
  | { kind: 'add-stage'; workflow: WorkflowDto }
  | { kind: 'rename-stage'; stage: WorkflowStage }
  | { kind: 'add-task'; stage: WorkflowStage; candidates: TreeTaskDto[] };

type WorkflowConfirm = {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<boolean | void> | boolean | void;
};

/** Membership belonging to the task at `taskIndex` inside a stage. */
function membershipAt(stage: WorkflowStage, taskIndex: number) {
  const task = stage.tasks[taskIndex];
  if (!task) return null;
  return stage.memberships?.find((candidate) => candidate.taskId === task.id) ?? null;
}

/**
 * Overflow trigger shared by workflow cards, stage columns and task rows. The
 * row level verbs live in a menu so the board stays readable at every width
 * instead of showing a cluster of icon buttons per task.
 */
function WorkflowMenu({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: MenuOption[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useDismissibleMenu(open, () => setOpen(false));
  return (
    <div ref={containerRef} className={`workflow-menu${open ? ' is-open' : ''}`}>
      <IconButton
        label={label}
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
          label={label}
          options={options}
          className="m3e-menu--dense-row"
          onSelect={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Single-field dialog behind every create and rename verb on the board. */
function WorkflowNameDialog({
  title,
  fieldLabel,
  initialValue = '',
  submitLabel,
  helperText,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  fieldLabel: string;
  initialValue?: string;
  submitLabel: string;
  helperText?: string;
  busy: boolean;
  error: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const formId = useId();
  const trimmed = value.trim();
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="text" type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="filled" type="submit" form={formId} disabled={busy || !trimmed}>
            {busy ? '保存中…' : submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && !busy) onSubmit(trimmed);
        }}
      >
        <TextField
          label={fieldLabel}
          autoFocus
          value={value}
          helperText={helperText}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Dialog>
  );
}

/**
 * Adding to a stage happens in one dialog: pick tasks that already live in the
 * directory, or capture a new one. The confirm action sits in the pinned dialog
 * footer so it never scrolls out of reach on a small screen.
 */
function WorkflowAddTaskDialog({
  stage,
  candidates,
  folders,
  busy,
  error,
  onAddExisting,
  onCreateTask,
  onClose,
}: {
  stage: WorkflowStage;
  candidates: TreeTaskDto[];
  folders: FolderDto[];
  busy: boolean;
  error: string;
  onAddExisting: (taskIds: string[]) => void;
  onCreateTask: (title: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [title, setTitle] = useState('');
  const formId = useId();
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter(
        (task) =>
          task.title.toLowerCase().includes(needle) ||
          task.referenceId.toLowerCase().includes(needle),
      )
    : candidates;
  const toggle = (taskId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const folderTitle = (task: TreeTaskDto) =>
    task.parentFolderId
      ? (folders.find((folder) => folder.id === task.parentFolderId)?.title ?? '目录')
      : '根目录';

  return (
    <Dialog
      open
      title={`添加任务到「${stage.name}」`}
      onClose={onClose}
      footer={
        mode === 'existing' ? (
          <>
            <span className="task-picker-selection-count" aria-live="polite">
              已选择 {selected.size} 项
            </span>
            <Button variant="text" type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="filled"
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => onAddExisting([...selected])}
            >
              {busy ? '加入中…' : `加入流程${selected.size ? `（${selected.size}）` : ''}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="text" type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button variant="filled" type="submit" form={formId} disabled={busy || !title.trim()}>
              {busy ? '创建中…' : '创建并加入'}
            </Button>
          </>
        )
      }
    >
      <ButtonGroup
        label="添加方式"
        value={mode}
        options={[
          { value: 'existing' as const, label: '选择已有任务' },
          { value: 'create' as const, label: '新建任务' },
        ]}
        onChange={setMode}
        className="m3e-button-group--add-task-mode"
      />
      {error && <Alert tone="error">{error}</Alert>}
      {mode === 'existing' ? (
        <>
          <SearchBar
            label="搜索任务"
            variant="view"
            autoFocus
            value={query}
            onChange={setQuery}
            placeholder="搜索标题或引用 ID"
            leadingIcon={<Search size={20} />}
          />
          {matches.length ? (
            <List gap className="m3e-list--picker workflow-add-task__list">
              {matches.map((task) => {
                const isSelected = selected.has(task.id);
                return (
                  <ListItem
                    key={task.id}
                    className="m3e-list-item--picker"
                    headline={task.title}
                    supporting={
                      <span className="workflow-task__meta">
                        <code>{task.referenceId}</code>
                        <span className="workflow-task__folder">
                          <Folder size={14} aria-hidden="true" />
                          {folderTitle(task)}
                        </span>
                      </span>
                    }
                    leading={
                      <span
                        className={`task-picker-selection${isSelected ? ' is-selected' : ''}`}
                        aria-hidden="true"
                      >
                        {isSelected && <Check size={15} strokeWidth={3} />}
                      </span>
                    }
                    selected={isSelected}
                    disabled={busy}
                    ariaLabel={`${isSelected ? '取消选择' : '选择'}任务 ${task.title}`}
                    onClick={() => toggle(task.id)}
                  />
                );
              })}
            </List>
          ) : (
            <EmptyState
              compact
              icon={<ListChecksIcon size={20} />}
              title={candidates.length ? '没有匹配的任务' : '没有可加入的任务'}
              description={
                candidates.length
                  ? '换一个标题或引用 ID 再试。'
                  : '目录里的任务都已在这个流程中；可以改为新建任务。'
              }
            />
          )}
        </>
      ) : (
        <form
          id={formId}
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (next && !busy) onCreateTask(next);
          }}
        >
          <TextField
            label="任务标题"
            autoFocus
            value={title}
            helperText="新任务会先创建在默认捕获目录，再加入这个阶段。"
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </form>
      )}
    </Dialog>
  );
}

/**
 * Workflow board. A workflow is a card, its stages are columns in reading
 * order, and every mutation is reachable from one overflow menu per card,
 * column and task row.
 */
export function WorkflowsPage() {
  const { settings } = useAuth();
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [tasks, setTasks] = useState<TreeTaskDto[]>([]);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [dialog, setDialog] = useState<WorkflowDialog | null>(null);
  const [confirmation, setConfirmation] = useState<WorkflowConfirm | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hasData, setHasData] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const [workflowResult, taskResult, folderResult] = await Promise.all([
        requestV2<{ items: WorkflowDto[] }>('/workflows'),
        requestV2<{ items: TreeTaskDto[] }>('/tasks'),
        requestV2<{ items: FolderDto[] }>('/folders'),
      ]);
      if (sequence !== loadSequence.current) return;
      setWorkflows(workflowResult.items);
      setTasks(taskResult.items);
      setFolders(folderResult.items);
      setHasData(true);
    } catch (cause) {
      if (sequence === loadSequence.current)
        setLoadError(cause instanceof Error ? cause.message : '流程加载失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const listener = () => void load();
    window.addEventListener('devtodo:data-changed', listener);
    return () => {
      loadSequence.current += 1;
      window.removeEventListener('devtodo:data-changed', listener);
    };
  }, [load]);

  /** Runs a mutation, reloads the board and reports whether it succeeded. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setActionError('');
    setBusy(true);
    try {
      await action();
      await load();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '流程操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Same as `run`, but closes the open dialog once the mutation lands. */
  const runDialog = async (action: () => Promise<unknown>) => {
    if (await run(action)) setDialog(null);
  };

  const addExistingTasks = async (stage: WorkflowStage, taskIds: string[]) => {
    if (taskIds.length === 0) return;
    setActionError('');
    setBusy(true);
    const failures: unknown[] = [];
    let added = 0;
    try {
      for (const taskId of taskIds) {
        try {
          await mutationV2('POST', `/workflow-stages/${stage.id}/tasks`, { taskId });
          added += 1;
        } catch (cause) {
          failures.push(cause);
        }
      }
      await load();
      if (failures.length === 0) {
        setDialog(null);
        return;
      }
      const cause = failures[0];
      setActionError(
        `已加入 ${added} 项，${failures.length} 项失败：${
          cause instanceof Error ? cause.message : '请检查后重试'
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  const createTaskInStage = (stage: WorkflowStage, title: string) =>
    void runDialog(async () => {
      // Honour the same capture-target contract as the tree and Today page: the
      // open folder wins, otherwise the recent/updated folder, and ROOT means root.
      const validFolderId = resolveCaptureFolder({
        activeFolderId: null,
        defaultCaptureTarget: settings?.defaultCaptureTarget,
        folders,
      });
      const created = (await mutationV2('POST', '/tasks', {
        parentFolderId: validFolderId,
        title,
      })) as { task: TreeTaskDto };
      await mutationV2('POST', `/workflow-stages/${stage.id}/tasks`, { taskId: created.task.id });
    });

  const changeTaskStatus = async (task: TreeTaskDto, status: TaskStatus) => {
    const applied = await run(() =>
      mutationV2('PATCH', `/tasks/${task.id}`, { status, baseVersion: task.version }),
    );
    if (applied) window.dispatchEvent(new Event('devtodo:data-changed'));
  };

  const moveMembership = (
    membership: WorkflowTaskMembershipDto,
    patch: { stageId?: string; beforeId?: string | null; afterId?: string | null },
  ) =>
    void run(() =>
      mutationV2('POST', `/workflow-memberships/${membership.id}/move`, {
        ...patch,
        baseVersion: membership.version,
      }),
    );

  const visibleWorkflows = workflows;

  return (
    <section className="page-section workflows-page" aria-labelledby="workflows-title">
      <div className="page-header workflows-header">
        <div>
          <p className="eyebrow">流程</p>
          <h1 id="workflows-title">流程</h1>
          <p className="page-subtitle">
            阶段只表示任务在流程中的位置；同一个任务可以出现在多个流程里。
          </p>
        </div>
        <div className="workflows-header__actions">
          <Button
            variant="filled"
            size="s"
            type="button"
            leadingIcon={<Plus size={16} />}
            onClick={() => setDialog({ kind: 'create-workflow' })}
          >
            新建流程
          </Button>
        </div>
      </div>
      {loadError && (
        <Alert
          tone="error"
          title="流程加载失败"
          action={
            <Button variant="text" size="s" onClick={() => void load()}>
              重试
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}
      {actionError && !dialog && (
        <Alert
          tone="error"
          title="流程操作失败"
          action={
            <Button variant="text" size="s" onClick={() => void load()}>
              刷新
            </Button>
          }
        >
          {actionError}
        </Alert>
      )}
      {loading && !hasData ? (
        <LoadingState label="正在加载流程" description="正在准备流程、阶段和可加入的任务。" />
      ) : !hasData ? null : visibleWorkflows.length === 0 ? (
        <EmptyState
          className="m3e-empty-state--workflow"
          icon={<WorkflowGlyph size={24} aria-hidden="true" />}
          title={workflows.length === 0 ? '还没有流程' : '没有进行中的流程'}
          description="把重复的发布、插件或维护步骤拆成可复用的阶段。"
          action={
            <Button
              variant="filled"
              type="button"
              leadingIcon={<Plus size={16} />}
              onClick={() => setDialog({ kind: 'create-workflow' })}
            >
              新建流程
            </Button>
          }
        />
      ) : (
        <div className="workflow-board">
          {visibleWorkflows.map((workflow) => {
            const stages = workflow.stages ?? [];
            const memberIds = new Set(
              stages.flatMap((stage) => stage.tasks.map((task) => task.id)),
            );
            const taskCount = stages.reduce((total, stage) => total + stage.tasks.length, 0);
            const doneCount = stages.reduce(
              (total, stage) => total + stage.tasks.filter((task) => task.status === 'DONE').length,
              0,
            );
            const candidates = tasks.filter((task) => !memberIds.has(task.id));
            return (
              <Card
                as="article"
                variant="outlined"
                className="m3e-card--workflow"
                key={workflow.id}
              >
                <header className="workflow-card__header">
                  <div className="workflow-card__heading">
                    <h2 className="workflow-card__name">{workflow.name}</h2>
                    <p className="workflow-card__meta">
                      <span>{stages.length} 个阶段</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {doneCount}/{taskCount} 已完成
                      </span>
                    </p>
                  </div>
                  <WorkflowMenu
                    label={`${workflow.name} 的操作`}
                    options={[
                      { id: 'add-stage', label: '新增阶段' },
                      { id: 'rename', label: '重命名流程' },
                      { id: 'delete', label: '删除流程', danger: true },
                    ]}
                    onSelect={(id) => {
                      if (id === 'add-stage') setDialog({ kind: 'add-stage', workflow });
                      if (id === 'rename') setDialog({ kind: 'rename-workflow', workflow });
                      if (id === 'delete')
                        setConfirmation({
                          title: '删除流程',
                          description: `删除“${workflow.name}”的阶段与成员关系，但不会删除任务。此操作不可恢复。`,
                          confirmLabel: '删除流程',
                          danger: true,
                          onConfirm: async () => {
                            await mutationV2('DELETE', `/workflows/${workflow.id}`, {
                              baseVersion: workflow.version,
                            });
                            await load();
                            return true;
                          },
                        });
                    }}
                  />
                </header>
                <div className="workflow-stages">
                  {stages.map((stage, index) => {
                    const prevStage = index > 0 ? stages[index - 1] : null;
                    const nextStage = index < stages.length - 1 ? stages[index + 1] : null;
                    return (
                      <section
                        className="workflow-stage"
                        key={stage.id}
                        aria-labelledby={`workflow-stage-${stage.id}`}
                      >
                        <header className="workflow-stage__header">
                          <h3 className="workflow-stage__name" id={`workflow-stage-${stage.id}`}>
                            {stage.name}
                          </h3>
                          <span className="workflow-stage__count">{stage.tasks.length}</span>
                          <WorkflowMenu
                            label={`${stage.name} 阶段的操作`}
                            options={[
                              { id: 'add-task', label: '添加任务' },
                              { id: 'rename', label: '重命名阶段' },
                              {
                                id: 'move-prev',
                                label: '向前移动',
                                hint: '←',
                                disabled: !prevStage,
                              },
                              {
                                id: 'move-next',
                                label: '向后移动',
                                hint: '→',
                                disabled: !nextStage,
                              },
                              {
                                id: 'delete',
                                label: '删除阶段',
                                danger: true,
                              },
                            ]}
                            onSelect={(id) => {
                              if (id === 'add-task')
                                setDialog({ kind: 'add-task', stage, candidates });
                              if (id === 'rename') setDialog({ kind: 'rename-stage', stage });
                              if (id === 'move-prev' && prevStage)
                                void run(() =>
                                  mutationV2('POST', `/workflow-stages/${stage.id}/move`, {
                                    beforeId: prevStage.id,
                                    afterId: null,
                                    baseVersion: stage.version,
                                  }),
                                );
                              if (id === 'move-next' && nextStage)
                                void run(() =>
                                  mutationV2('POST', `/workflow-stages/${stage.id}/move`, {
                                    beforeId: null,
                                    afterId: nextStage.id,
                                    baseVersion: stage.version,
                                  }),
                                );
                              if (id === 'delete')
                                setConfirmation({
                                  title: '删除阶段',
                                  description: `删除“${stage.name}”及其中的流程成员关系，但不会删除任务。此操作不可恢复。`,
                                  confirmLabel: '删除阶段',
                                  danger: true,
                                  onConfirm: async () => {
                                    await mutationV2('DELETE', `/workflow-stages/${stage.id}`, {
                                      baseVersion: stage.version,
                                    });
                                    await load();
                                    return true;
                                  },
                                });
                            }}
                          />
                        </header>
                        {stage.tasks.length ? (
                          <List gap className="m3e-list--workflow-stage">
                            {stage.tasks.map((task, taskIndex) => {
                              const membership = membershipAt(stage, taskIndex);
                              const prevMembership = membershipAt(stage, taskIndex - 1);
                              const nextMembership = membershipAt(stage, taskIndex + 1);
                              const folderTitle = task.parentFolderId
                                ? (folders.find((folder) => folder.id === task.parentFolderId)
                                    ?.title ?? '目录')
                                : '根目录';
                              return (
                                <ListItem
                                  className={`m3e-list-item--workflow-task${
                                    task.status === 'DONE' ? ' is-task-done' : ''
                                  }`}
                                  key={task.id}
                                  leadingControl={
                                    <TaskStatusControl
                                      status={task.status}
                                      onStatusChange={(status) => changeTaskStatus(task, status)}
                                    />
                                  }
                                  headline={
                                    <button
                                      type="button"
                                      className="workflow-task__title"
                                      onClick={() => setSelectedTaskId(task.id)}
                                    >
                                      {task.title}
                                    </button>
                                  }
                                  supporting={
                                    <span className="workflow-task__meta">
                                      <code>{task.referenceId}</code>
                                      <span className="workflow-task__folder">
                                        <Folder size={14} aria-hidden="true" />
                                        {folderTitle}
                                      </span>
                                    </span>
                                  }
                                  trailing={
                                    <WorkflowMenu
                                      label={`${task.title} 的操作`}
                                      options={[
                                        {
                                          id: 'stage-prev',
                                          label: prevStage
                                            ? `移到「${prevStage.name}」`
                                            : '移到上一阶段',
                                          disabled: !prevStage || !membership,
                                        },
                                        {
                                          id: 'stage-next',
                                          label: nextStage
                                            ? `移到「${nextStage.name}」`
                                            : '移到下一阶段',
                                          disabled: !nextStage || !membership,
                                        },
                                        {
                                          id: 'up',
                                          label: '在阶段内上移',
                                          hint: '↑',
                                          disabled: !membership || !prevMembership,
                                        },
                                        {
                                          id: 'down',
                                          label: '在阶段内下移',
                                          hint: '↓',
                                          disabled: !membership || !nextMembership,
                                        },
                                        {
                                          id: 'remove',
                                          label: '从阶段移除',
                                          danger: true,
                                          disabled: !membership,
                                        },
                                      ]}
                                      onSelect={(id) => {
                                        if (!membership) return;
                                        if (id === 'stage-prev' && prevStage)
                                          moveMembership(membership, { stageId: prevStage.id });
                                        if (id === 'stage-next' && nextStage)
                                          moveMembership(membership, { stageId: nextStage.id });
                                        if (id === 'up' && prevMembership)
                                          moveMembership(membership, {
                                            stageId: stage.id,
                                            beforeId: prevMembership.id,
                                          });
                                        if (id === 'down' && nextMembership)
                                          moveMembership(membership, {
                                            stageId: stage.id,
                                            afterId: nextMembership.id,
                                          });
                                        if (id === 'remove')
                                          void run(() =>
                                            mutationV2(
                                              'DELETE',
                                              `/workflow-memberships/${membership.id}`,
                                              { baseVersion: membership.version },
                                            ),
                                          );
                                      }}
                                    />
                                  }
                                />
                              );
                            })}
                          </List>
                        ) : (
                          <p className="workflow-stage__empty">这个阶段还没有任务</p>
                        )}
                        <Button
                          variant="text"
                          size="s"
                          type="button"
                          className="workflow-stage__add"
                          leadingIcon={<Plus size={16} />}
                          disabled={busy}
                          onClick={() => setDialog({ kind: 'add-task', stage, candidates })}
                        >
                          添加任务
                        </Button>
                      </section>
                    );
                  })}
                  <button
                    type="button"
                    className="workflow-stage-add"
                    disabled={busy}
                    onClick={() => setDialog({ kind: 'add-stage', workflow })}
                  >
                    <Plus size={18} aria-hidden="true" />
                    <span>新增阶段</span>
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {dialog?.kind === 'create-workflow' && (
        <WorkflowNameDialog
          title="新建流程"
          fieldLabel="流程名称"
          submitLabel="创建流程"
          helperText="例如“插件发布”或“网站上线”；阶段可以稍后再加。"
          busy={busy}
          error={actionError}
          onClose={() => setDialog(null)}
          onSubmit={(value) =>
            void runDialog(() => mutationV2('POST', '/workflows', { name: value }))
          }
        />
      )}
      {dialog?.kind === 'rename-workflow' && (
        <WorkflowNameDialog
          title="重命名流程"
          fieldLabel="流程名称"
          initialValue={dialog.workflow.name}
          submitLabel="保存名称"
          busy={busy}
          error={actionError}
          onClose={() => setDialog(null)}
          onSubmit={(value) =>
            void runDialog(() =>
              mutationV2('PATCH', `/workflows/${dialog.workflow.id}`, {
                name: value,
                baseVersion: dialog.workflow.version,
              }),
            )
          }
        />
      )}
      {dialog?.kind === 'add-stage' && (
        <WorkflowNameDialog
          title={`为「${dialog.workflow.name}」新增阶段`}
          fieldLabel="阶段名称"
          submitLabel="新增阶段"
          helperText="新阶段会排在最后，之后可以调整顺序。"
          busy={busy}
          error={actionError}
          onClose={() => setDialog(null)}
          onSubmit={(value) =>
            void runDialog(() =>
              mutationV2('POST', `/workflows/${dialog.workflow.id}/stages`, { name: value }),
            )
          }
        />
      )}
      {dialog?.kind === 'rename-stage' && (
        <WorkflowNameDialog
          title="重命名阶段"
          fieldLabel="阶段名称"
          initialValue={dialog.stage.name}
          submitLabel="保存名称"
          busy={busy}
          error={actionError}
          onClose={() => setDialog(null)}
          onSubmit={(value) =>
            void runDialog(() =>
              mutationV2('PATCH', `/workflow-stages/${dialog.stage.id}`, {
                name: value,
                baseVersion: dialog.stage.version,
              }),
            )
          }
        />
      )}
      {dialog?.kind === 'add-task' && (
        <WorkflowAddTaskDialog
          stage={dialog.stage}
          candidates={dialog.candidates}
          folders={folders}
          busy={busy}
          error={actionError}
          onClose={() => setDialog(null)}
          onAddExisting={(taskIds) => void addExistingTasks(dialog.stage, taskIds)}
          onCreateTask={(value) => createTaskInStage(dialog.stage, value)}
        />
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
        onChanged={load}
      />
    </section>
  );
}
