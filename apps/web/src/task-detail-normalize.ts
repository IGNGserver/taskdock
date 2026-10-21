import type {
  FolderDto,
  NoteDto,
  PlacementDto,
  TaskDetailV2Dto,
  TaskStatus,
  TaskStepDto,
  TimePointDto,
  TreeTaskDto,
  WorkflowStageDto,
  WorkflowTaskMembershipDto,
  WorkflowDto,
} from '@devtodo/contracts';

/**
 * The v2 detail response is assembled by several stores and may also be served
 * from an older local cache during a rollout. Types disappear at runtime, so a
 * missing array or note must not reach the editor: one bad payload otherwise
 * blanks the whole workspace because the panel sits outside the page boundary.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function pointInTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function status(value: unknown): TaskStatus {
  return value === 'IN_PROGRESS' || value === 'DONE' ? value : 'TODO';
}

function normalizeTask(value: unknown, now: string): TreeTaskDto | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !value['id']) return null;
  return {
    id: value['id'],
    referenceId: text(value['referenceId']),
    parentFolderId: typeof value['parentFolderId'] === 'string' ? value['parentFolderId'] : null,
    title: text(value['title']),
    status: status(value['status']),
    rank: text(value['rank'], '1024'),
    version: typeof value['version'] === 'number' ? value['version'] : 1,
    completedAt: typeof value['completedAt'] === 'string' ? value['completedAt'] : null,
    deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
    createdAt: pointInTime(value['createdAt'], now),
    updatedAt: pointInTime(value['updatedAt'], now),
  };
}

function normalizeNote(value: unknown, task: TreeTaskDto): NoteDto {
  if (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['contentMarkdown'] === 'string'
  ) {
    return {
      id: value['id'],
      taskId: text(value['taskId'], task.id),
      contentMarkdown: value['contentMarkdown'],
      version: typeof value['version'] === 'number' ? value['version'] : 1,
      createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : undefined,
      updatedAt: pointInTime(value['updatedAt'], task.updatedAt),
      deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
    };
  }
  return {
    id: `local-note-${task.id}`,
    taskId: task.id,
    contentMarkdown: '',
    version: 0,
    updatedAt: task.updatedAt,
  };
}

function normalizeStep(value: unknown, taskId: string, now: string): TaskStepDto | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !value['id']) return null;
  return {
    id: value['id'],
    taskId: text(value['taskId'], taskId),
    title: text(value['title']),
    noteMarkdown: text(value['noteMarkdown']),
    status: status(value['status']),
    rank: text(value['rank'], '1024'),
    completedAt: typeof value['completedAt'] === 'string' ? value['completedAt'] : null,
    version: typeof value['version'] === 'number' ? value['version'] : 1,
    createdAt: pointInTime(value['createdAt'], now),
    updatedAt: pointInTime(value['updatedAt'], now),
    deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
  };
}

function normalizeTimePoint(value: unknown, now: string): TimePointDto | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !value['id']) return null;
  const type = value['type'] === 'EVENT' ? 'EVENT' : 'DATE';
  return {
    id: value['id'],
    type,
    localDate: typeof value['localDate'] === 'string' ? value['localDate'] : null,
    title: typeof value['title'] === 'string' ? value['title'] : null,
    rank: text(value['rank'], '1024'),
    version: typeof value['version'] === 'number' ? value['version'] : 1,
    reachedAt: typeof value['reachedAt'] === 'string' ? value['reachedAt'] : null,
    deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
    createdAt: pointInTime(value['createdAt'], now),
    updatedAt: pointInTime(value['updatedAt'], now),
  };
}

function normalizePlacement(
  value: unknown,
  task: TreeTaskDto,
  now: string,
): (PlacementDto & { timePoint: TimePointDto }) | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !value['id']) return null;
  const timePoint = normalizeTimePoint(value['timePoint'], now);
  if (!timePoint) return null;
  return {
    id: value['id'],
    taskId: text(value['taskId'], task.id),
    timePointId: text(value['timePointId'], timePoint.id),
    rank: text(value['rank'], '1024'),
    version: typeof value['version'] === 'number' ? value['version'] : 1,
    createdAt: pointInTime(value['createdAt'], now),
    updatedAt: pointInTime(value['updatedAt'], now),
    deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
    timePoint,
  };
}

function normalizeMembership(
  value: unknown,
  task: TreeTaskDto,
  now: string,
):
  | (WorkflowTaskMembershipDto & {
      workflow: Pick<WorkflowDto, 'id' | 'name'>;
      stage: Pick<WorkflowStageDto, 'id' | 'name'>;
    })
  | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !value['id']) return null;
  const workflow = isRecord(value['workflow']) ? value['workflow'] : null;
  const stage = isRecord(value['stage']) ? value['stage'] : null;
  if (!workflow || !stage) return null;
  return {
    id: value['id'],
    workflowId: text(value['workflowId'], text(workflow['id'])),
    stageId: text(value['stageId'], text(stage['id'])),
    taskId: text(value['taskId'], task.id),
    rank: text(value['rank'], '1024'),
    version: typeof value['version'] === 'number' ? value['version'] : 1,
    createdAt: pointInTime(value['createdAt'], now),
    updatedAt: pointInTime(value['updatedAt'], now),
    deletedAt: typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null,
    workflow: { id: text(workflow['id']), name: text(workflow['name']) },
    stage: { id: text(stage['id']), name: text(stage['name']) },
  };
}

function normalizeFolderPath(value: unknown): Array<Pick<FolderDto, 'id' | 'title'>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item['id'] === 'string' && typeof item['title'] === 'string'
      ? [{ id: item['id'], title: item['title'] }]
      : [],
  );
}

export function normalizeTaskDetail(value: unknown): TaskDetailV2Dto | null {
  if (!isRecord(value)) return null;
  const now = new Date().toISOString();
  const task = normalizeTask(value['task'], now);
  if (!task) return null;
  return {
    task,
    note: normalizeNote(value['note'], task),
    steps: Array.isArray(value['steps'])
      ? value['steps'].flatMap((step) => {
          const normalized = normalizeStep(step, task.id, now);
          return normalized ? [normalized] : [];
        })
      : [],
    placements: Array.isArray(value['placements'])
      ? value['placements'].flatMap((placement) => {
          const normalized = normalizePlacement(placement, task, now);
          return normalized ? [normalized] : [];
        })
      : [],
    workflowMemberships: Array.isArray(value['workflowMemberships'])
      ? value['workflowMemberships'].flatMap((membership) => {
          const normalized = normalizeMembership(membership, task, now);
          return normalized ? [normalized] : [];
        })
      : [],
    folderPath: normalizeFolderPath(value['folderPath']),
  };
}
