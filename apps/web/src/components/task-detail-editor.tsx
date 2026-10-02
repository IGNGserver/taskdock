import type { FolderDto, TaskDetailV2Dto, TaskStatus, TaskStepDto } from '@devtodo/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { mutationV2, requestV2 } from '../api.js';
import { useAuth } from '../auth.js';
import {
  createTaskEditorDraft,
  mergeTaskEditorDraft,
  type TaskEditorDraft,
  type StepDraft,
} from '../task-editor-draft.js';
import { FolderPicker } from './folder-picker.js';
import {
  Alert,
  Button,
  ButtonGroup,
  ConfirmDialog,
  Disclosure,
  IconButton,
  Menu,
  TaskStatusControl,
  TextArea,
  TextField,
  useDismissibleMenu,
} from './m3e/index.js';

export function TaskDetailEditor({
  detail,
  drafts,
  onChanged,
  onClose,
  focusTitle = false,
}: {
  detail: TaskDetailV2Dto;
  drafts: Map<string, TaskEditorDraft>;
  onChanged: () => void;
  onClose: () => void;
  focusTitle?: boolean;
}) {
  const { settings } = useAuth();
  const [draft] = useState(() => {
    const existing = drafts.get(detail.task.id);
    if (existing) {
      mergeTaskEditorDraft(existing, detail);
      return existing;
    }
    const created = createTaskEditorDraft(detail);
    drafts.set(detail.task.id, created);
    return created;
  });
  const [, render] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const notify = () => {
    for (const listener of draft.listeners) listener();
  };
  const [editingSteps, setEditingSteps] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [moveFolderId, setMoveFolderId] = useState(detail.task.parentFolderId ?? '');
  const [deletingTask, setDeletingTask] = useState(false);
  const [deletingStep, setDeletingStep] = useState<TaskStepDto | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismissibleMenu(menuOpen, () => setMenuOpen(false));
  const flushRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let frame = 0;
    const focus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== detail.task.id) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        editorRef.current
          ?.querySelector<HTMLInputElement>('.m3e-field--task-detail-title input')
          ?.focus(),
      );
    };
    window.addEventListener('devtodo:focus-task-title', focus);
    return () => {
      window.removeEventListener('devtodo:focus-task-title', focus);
      window.cancelAnimationFrame(frame);
    };
  }, [detail.task.id]);

  useEffect(() => {
    mergeTaskEditorDraft(draft, detail);
    render((version) => version + 1);
  }, [detail, draft]);
  useEffect(() => {
    const listener = () => render((version) => version + 1);
    draft.listeners.add(listener);
    return () => {
      draft.listeners.delete(listener);
      flushRef.current();
    };
  }, [draft]);

  const save = (key: string, operation: () => Promise<void>): Promise<boolean> => {
    if (draft.deleted) return Promise.resolve(false);
    draft.pending += 1;
    notify();
    const result = draft.queue
      .then(async () => {
        if (draft.deleted) return false;
        try {
          await operation();
          delete draft.failures[key];
          draft.retries.delete(key);
          changed.current();
          return true;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '保存失败，请重试';
          draft.failures[key] = message;
          draft.retries.set(key, () => save(key, operation));
          window.dispatchEvent(
            new CustomEvent('devtodo:toast', {
              detail: { message: `“${draft.title}”保存失败，编辑内容已保留` },
            }),
          );
          return false;
        }
      })
      .finally(() => {
        draft.pending -= 1;
        notify();
      });
    draft.queue = result.then(() => undefined);
    return result;
  };
  const saveTask = (patch: Partial<Pick<TaskDetailV2Dto['task'], 'title' | 'status'>>) =>
    save(patch.title !== undefined ? 'title' : 'status', async () => {
      const record = draft.record.task;
      if (patch.title !== undefined && !patch.title.trim()) throw new Error('任务标题不能为空');
      if (
        (patch.title === undefined || patch.title === record.title) &&
        (patch.status === undefined || patch.status === record.status)
      )
        return;
      const task = (await mutationV2('PATCH', `/tasks/${record.id}`, {
        ...patch,
        baseVersion: record.version,
      })) as TaskDetailV2Dto['task'];
      draft.record = { ...draft.record, task };
      if (patch.title !== undefined && draft.title.trim() === patch.title) draft.title = task.title;
    });
  const saveNote = (content: string) =>
    save('note', async () => {
      if (content === draft.record.note.contentMarkdown) return;
      const note = (await mutationV2('PATCH', `/tasks/${detail.task.id}/note`, {
        contentMarkdown: content,
        baseVersion: draft.record.note.version,
      })) as TaskDetailV2Dto['note'];
      draft.record = { ...draft.record, note };
    });
  const saveStep = (id: string, patch: Partial<StepDraft>) =>
    save(`step:${id}`, async () => {
      const step = draft.record.steps.find((candidate) => candidate.id === id);
      if (!step) throw new Error('步骤已移除，请刷新后检查');
      if (patch.title !== undefined && !patch.title.trim()) throw new Error('步骤标题不能为空');
      if (Object.entries(patch).every(([key, value]) => step[key as keyof StepDraft] === value))
        return;
      const updated = (await mutationV2('PATCH', `/task-steps/${id}`, {
        ...patch,
        baseVersion: step.version,
      })) as TaskStepDto;
      draft.record = {
        ...draft.record,
        steps: draft.record.steps.map((candidate) => (candidate.id === id ? updated : candidate)),
      };
    });
  const flush = () => {
    if (draft.deleted) return;
    if (draft.title !== draft.record.task.title) void saveTask({ title: draft.title.trim() });
    if (draft.status !== draft.record.task.status) void saveTask({ status: draft.status });
    if (draft.note !== draft.record.note.contentMarkdown) void saveNote(draft.note);
    for (const step of draft.record.steps) {
      const local = draft.steps[step.id];
      if (
        local &&
        (local.title !== step.title ||
          local.noteMarkdown !== step.noteMarkdown ||
          local.status !== step.status)
      )
        void saveStep(step.id, { ...local, title: local.title.trim() });
    }
  };
  flushRef.current = flush;

  const addStep = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.newStep.trim();
    if (!title || draft.pending > 0) return;
    await save('new-step', async () => {
      const step = (await mutationV2('POST', `/tasks/${detail.task.id}/steps`, {
        title,
        noteMarkdown: '',
      })) as TaskStepDto;
      draft.record = { ...draft.record, steps: [...draft.record.steps, step] };
      draft.steps[step.id] = {
        title: step.title,
        noteMarkdown: step.noteMarkdown,
        status: step.status,
      };
      if (draft.newStep.trim() === title) draft.newStep = '';
    });
  };
  const moveStep = (id: string, direction: 'up' | 'down') =>
    save(`step:${id}`, async () => {
      const index = draft.record.steps.findIndex((candidate) => candidate.id === id);
      const step = draft.record.steps[index];
      const target = draft.record.steps[index + (direction === 'up' ? -1 : 1)];
      if (!step || !target) return;
      const updated = (await mutationV2('POST', `/task-steps/${id}/move`, {
        ...(direction === 'up' ? { beforeId: target.id } : { afterId: target.id }),
        baseVersion: step.version,
      })) as TaskStepDto;
      draft.record = {
        ...draft.record,
        steps: draft.record.steps
          .map((candidate) => (candidate.id === id ? updated : candidate))
          .sort((left, right) =>
            BigInt(left.rank) < BigInt(right.rank)
              ? -1
              : BigInt(left.rank) > BigInt(right.rank)
                ? 1
                : 0,
          ),
      };
    });
  const loadFolders = async () => {
    try {
      setFolders((await requestV2<{ items: FolderDto[] }>('/folders')).items);
      setFoldersLoaded(true);
      setMoveFolderId(draft.record.task.parentFolderId ?? '');
      delete draft.failures.folders;
      notify();
    } catch (cause) {
      draft.failures.folders = cause instanceof Error ? cause.message : '无法加载目录';
      draft.retries.set('folders', async () => {
        await loadFolders();
        return !draft.failures.folders;
      });
      notify();
    }
  };
  const moveTask = () =>
    save('folder', async () => {
      const task = draft.record.task;
      if (moveFolderId === (task.parentFolderId ?? '')) return;
      const updated = (await mutationV2('POST', '/tree/items/move', {
        item: { kind: 'TASK', id: task.id },
        parentFolderId: moveFolderId || null,
        expectedStatus: task.status,
        baseVersion: task.version,
      })) as { task: TaskDetailV2Dto['task'] };
      draft.record = { ...draft.record, task: updated.task };
    });
  const arrangeToday = () =>
    save('arrange', async () => {
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: settings?.timezone ?? 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const point = (await mutationV2('POST', '/time-points/date', { localDate })) as {
        id: string;
      };
      await mutationV2('POST', '/placements', { taskId: detail.task.id, timePointId: point.id });
    });
  const failures = Object.values(draft.failures);
  const dirty =
    draft.title !== draft.record.task.title ||
    draft.note !== draft.record.note.contentMarkdown ||
    draft.status !== draft.record.task.status ||
    draft.record.steps.some((step) => {
      const local = draft.steps[step.id];
      return (
        local &&
        (local.title !== step.title ||
          local.noteMarkdown !== step.noteMarkdown ||
          local.status !== step.status)
      );
    });
  const saveLabel = failures.length
    ? '保存失败 · 内容已保留'
    : draft.pending
      ? '正在保存…'
      : dirty
        ? '编辑中'
        : '已保存';

  return (
    <div ref={editorRef} className="task-detail-v2 workspace-editor">
      <div className="task-detail-v2-header">
        <TextField
          label="任务标题"
          hideLabel
          className="m3e-field--task-detail-title"
          value={draft.title}
          autoFocus={focusTitle}
          onChange={(event) => {
            draft.title = event.target.value;
            notify();
          }}
          onBlur={() => {
            if (draft.title !== draft.record.task.title)
              void saveTask({ title: draft.title.trim() });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div ref={menuRef}>
          <IconButton
            label="更多任务操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          {menuOpen && (
            <Menu
              label="任务操作"
              options={[{ id: 'delete', label: '永久删除任务', danger: true }]}
              onSelect={() => {
                setMenuOpen(false);
                setDeletingTask(true);
              }}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>
      <span
        className={`task-save-state${failures.length ? ' has-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {saveLabel}
      </span>
      {failures.length > 0 && (
        <Alert
          tone="error"
          title="保存失败"
          action={
            <Button
              variant="text"
              onClick={() => {
                for (const key of Object.keys(draft.failures)) {
                  const retry = draft.retries.get(key);
                  if (retry) void retry();
                }
                flush();
                notify();
              }}
            >
              重试保存
            </Button>
          }
        >
          {failures.join('；')}
        </Alert>
      )}
      <ButtonGroup
        value={draft.status}
        label="任务状态"
        onChange={(candidate) => {
          draft.status = candidate as TaskStatus;
          notify();
          void saveTask({ status: draft.status });
        }}
        options={[
          { value: 'TODO', label: '待开始' },
          { value: 'IN_PROGRESS', label: '进行中' },
          { value: 'DONE', label: '已完成' },
        ]}
      />
      <section className="task-detail-v2-section">
        <h3>备注</h3>
        <TextArea
          className="m3e-field--task-detail-note"
          label="任务备注"
          hideLabel
          placeholder="添加备注…"
          value={draft.note}
          onChange={(event) => {
            draft.note = event.target.value;
            notify();
          }}
          onBlur={() => {
            if (draft.note !== draft.record.note.contentMarkdown) void saveNote(draft.note);
          }}
          rows={3}
        />
      </section>
      <section className="task-detail-v2-section">
        <h3>
          步骤{' '}
          <span>
            {draft.record.steps.filter((step) => step.status === 'DONE').length}/
            {draft.record.steps.length}
          </span>
        </h3>
        <div className="workspace-steps">
          {draft.record.steps.map((step, index) => {
            const local = draft.steps[step.id] ?? {
              title: step.title,
              noteMarkdown: step.noteMarkdown,
              status: step.status,
            };
            const editing = editingSteps.has(step.id);
            return (
              <div className="workspace-step" key={step.id}>
                <div className="workspace-step-row">
                  <TaskStatusControl
                    status={local.status}
                    onStatusChange={(status) => {
                      draft.steps[step.id] = { ...local, status };
                      notify();
                      return saveStep(step.id, { status }).then(() => undefined);
                    }}
                  />
                  <button
                    type="button"
                    className="workspace-step-title"
                    aria-label={`编辑步骤 ${local.title}`}
                    aria-expanded={editing}
                    onClick={() =>
                      setEditingSteps((current) => {
                        const next = new Set(current);
                        if (editing) next.delete(step.id);
                        else next.add(step.id);
                        return next;
                      })
                    }
                  >
                    {local.title}
                    {local.noteMarkdown && !editing && <small>{local.noteMarkdown}</small>}
                  </button>
                </div>
                {editing && (
                  <div className="workspace-step-editor">
                    <TextField
                      label={`步骤 ${index + 1} 标题`}
                      value={local.title}
                      onChange={(event) => {
                        draft.steps[step.id] = { ...local, title: event.target.value };
                        notify();
                      }}
                      onBlur={() =>
                        void saveStep(step.id, { title: draft.steps[step.id]!.title.trim() })
                      }
                    />
                    <TextArea
                      label={`步骤 ${index + 1} 备注`}
                      value={local.noteMarkdown}
                      onChange={(event) => {
                        draft.steps[step.id] = { ...local, noteMarkdown: event.target.value };
                        notify();
                      }}
                      onBlur={() =>
                        void saveStep(step.id, { noteMarkdown: draft.steps[step.id]!.noteMarkdown })
                      }
                      rows={2}
                    />
                    <div className="header-actions">
                      <Button
                        variant="text"
                        size="s"
                        disabled={index === 0}
                        onClick={() => void moveStep(step.id, 'up')}
                      >
                        上移
                      </Button>
                      <Button
                        variant="text"
                        size="s"
                        disabled={index === draft.record.steps.length - 1}
                        onClick={() => void moveStep(step.id, 'down')}
                      >
                        下移
                      </Button>
                      <Button variant="text" size="s" onClick={() => setDeletingStep(step)}>
                        删除步骤
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <form className="inline-capture" onSubmit={(event) => void addStep(event)}>
          <TextField
            label="新增执行步骤"
            hideLabel
            className="m3e-field--inline-capture"
            placeholder="新增步骤…"
            value={draft.newStep}
            onChange={(event) => {
              draft.newStep = event.target.value;
              notify();
            }}
          />
          <Button
            variant="text"
            type="submit"
            disabled={!draft.newStep.trim() || draft.pending > 0}
          >
            添加
          </Button>
        </form>
      </section>
      <Disclosure
        title={
          <>安排{draft.record.placements.length ? ` · ${draft.record.placements.length}` : ''}</>
        }
        defaultOpen={draft.record.placements.length > 0}
      >
        {draft.record.placements.map((placement) => (
          <div className="workspace-relation" key={placement.id}>
            <span>
              {placement.timePoint.type === 'EVENT'
                ? placement.timePoint.title
                : placement.timePoint.localDate}
            </span>
            <Button
              variant="text"
              size="s"
              onClick={() =>
                void save(`placement:${placement.id}`, async () => {
                  await mutationV2('DELETE', `/placements/${placement.id}`, {
                    baseVersion: placement.version,
                  });
                  draft.record = {
                    ...draft.record,
                    placements: draft.record.placements.filter((item) => item.id !== placement.id),
                  };
                })
              }
            >
              移除安排
            </Button>
          </div>
        ))}
        <Button
          variant="text"
          size="s"
          disabled={draft.pending > 0}
          onClick={() => void arrangeToday()}
        >
          安排今天
        </Button>
      </Disclosure>
      <Disclosure
        title="所在目录"
        description={draft.record.folderPath.map((folder) => folder.title).join(' / ') || '根目录'}
      >
        <Button variant="text" size="s" onClick={() => void loadFolders()}>
          选择其他文件夹
        </Button>
        {foldersLoaded && (
          <>
            <FolderPicker
              label="移动任务到文件夹"
              folders={folders}
              value={moveFolderId}
              onChange={setMoveFolderId}
              disabled={draft.pending > 0}
            />
            <Button
              variant="tonal"
              size="s"
              disabled={
                draft.pending > 0 || moveFolderId === (draft.record.task.parentFolderId ?? '')
              }
              onClick={() => void moveTask()}
            >
              移动
            </Button>
          </>
        )}
      </Disclosure>
      {draft.record.workflowMemberships.length > 0 && (
        <Disclosure title={`所属流程 · ${draft.record.workflowMemberships.length}`}>
          {draft.record.workflowMemberships.map((membership) => (
            <p key={membership.id}>
              {membership.workflow.name} / {membership.stage.name}
            </p>
          ))}
        </Disclosure>
      )}
      <Disclosure title="任务信息">
        <span className="muted">引用 ID</span>
        <code className="task-reference-id">{draft.record.task.referenceId}</code>
      </Disclosure>
      {deletingTask && (
        <ConfirmDialog
          open
          title="删除任务"
          description="永久删除此任务及备注、步骤、安排和流程关联？此操作不可恢复。"
          confirmLabel="永久删除"
          danger
          onClose={() => setDeletingTask(false)}
          onConfirm={() =>
            save('delete-task', async () => {
              await mutationV2('DELETE', `/tasks/${detail.task.id}`, {
                baseVersion: draft.record.task.version,
              });
              draft.deleted = true;
              drafts.delete(detail.task.id);
              onClose();
            })
          }
        />
      )}
      {deletingStep && (
        <ConfirmDialog
          open
          title="删除执行步骤"
          description={`永久删除步骤“${deletingStep.title}”？`}
          confirmLabel="删除步骤"
          danger
          onClose={() => setDeletingStep(null)}
          onConfirm={() =>
            save(`step:${deletingStep.id}`, async () => {
              const step = draft.record.steps.find((item) => item.id === deletingStep.id);
              if (!step) return;
              await mutationV2('DELETE', `/task-steps/${step.id}`, { baseVersion: step.version });
              draft.record = {
                ...draft.record,
                steps: draft.record.steps.filter((item) => item.id !== step.id),
              };
              delete draft.steps[step.id];
            })
          }
        />
      )}
    </div>
  );
}
