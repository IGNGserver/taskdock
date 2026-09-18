import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ArchiveOperationDetailDto,
  ArchiveOperationDto,
  ArchiveOperationSummaryDto,
  FolderAggregateDto,
  FolderDto,
  NoteDto,
  PlacementDto,
  TaskDetailV2Dto,
  TaskStepDto,
  TaskStatus,
  TreeItemDto,
  TreeTaskDto,
  TimePointType,
  TimePointDto,
  V2Mutation,
  V2SettingsDto,
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTaskMembershipDto,
} from '@devtodo/contracts';
import { uuidSchema, uuidv7 } from '@devtodo/contracts';
import {
  allocateRank,
  assertFolderMoveAllowed,
  assertTreeParentIsActiveFolder,
  deriveFolderAggregate,
  DomainError,
  folderPath,
  nextLocalDate,
  sortTreeItems,
  stepTransition,
  transitionTask,
  validateLocalDate,
} from '@devtodo/domain';
import type { MemoryStore } from './store.js';

type NullableDate = string | null;

interface FolderRecord extends FolderDto {
  ownerId: string;
  archivedByOperationId: string | null;
  deletedAt: NullableDate;
}
interface TreeTaskRecord extends TreeTaskDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface NoteRecord extends NoteDto {
  ownerId: string;
  createdAt: string;
  deletedAt: NullableDate;
}
interface StepRecord extends TaskStepDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface WorkflowRecord extends WorkflowDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface StageRecord extends WorkflowStageDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface MembershipRecord extends WorkflowTaskMembershipDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface ArchiveRecord extends ArchiveOperationDto {
  ownerId: string;
}
interface PlacementRecord extends PlacementDto {
  ownerId: string;
  deletedAt: NullableDate;
}
interface TimePointRecord extends TimePointDto {
  ownerId: string;
  deletedAt: NullableDate;
}

export interface V2SyncChange {
  seq: bigint;
  ownerId: string;
  entityType:
    | 'folder'
    | 'task'
    | 'note'
    | 'taskStep'
    | 'timePoint'
    | 'placement'
    | 'workflow'
    | 'workflowStage'
    | 'workflowTaskMembership'
    | 'settings'
    | 'archiveOperation';
  entityId: string;
  entityVersion: number;
  operation: 'upsert' | 'delete';
  snapshot: unknown;
  committedAt: string;
}

export interface DeletePreviewDto {
  rootFolderId: string;
  title: string;
  folderCount: number;
  taskCount: number;
  noteCount: number;
  stepCount: number;
  placementCount: number;
  workflowMembershipCount: number;
  subtreeFingerprint: string;
  expiresAt: string;
  confirmationToken: string;
}

export interface V2Snapshot {
  folders: FolderDto[];
  tasks: TreeTaskDto[];
  notes: NoteDto[];
  taskSteps: TaskStepDto[];
  timePoints: TimePointDto[];
  placements: PlacementDto[];
  workflows: WorkflowDto[];
  workflowStages: WorkflowStageDto[];
  workflowTaskMemberships: WorkflowTaskMembershipDto[];
  archiveOperations: ArchiveOperationDto[];
  settings: V2SettingsDto;
  cursor: string;
}

/**
 * The HTTP layer assigns occurredAt when it constructs a mutation. It is an
 * audit timestamp, not part of the caller's command identity, so retries must
 * hash the stable command fields only. Keeping this canonical input shared by
 * memory and PostgreSQL stores makes their idempotency semantics identical.
 */
export function v2MutationIdempotencyInput(
  mutation: V2Mutation,
): Pick<V2Mutation, 'mutationId' | 'command' | 'entityId' | 'baseVersion' | 'payload'> {
  return {
    mutationId: mutation.mutationId,
    command: mutation.command,
    entityId: mutation.entityId,
    baseVersion: mutation.baseVersion,
    payload: mutation.payload,
  };
}

export interface V2TreeStore {
  prepare?(ownerId: string): void | Promise<void>;
  withMutation<T>(fn: () => T | Promise<T>): Promise<T>;
  listTreeChildren(
    ownerId: string,
    parentFolderId: string | null,
    archived?: boolean,
  ): TreeItemDto[];
  listFolders(ownerId: string, archived?: boolean): FolderDto[];
  listArchiveOperations(ownerId: string, includeRestored?: boolean): ArchiveOperationSummaryDto[];
  getArchiveOperation(ownerId: string, operationId: string): ArchiveOperationDetailDto;
  getFolder(ownerId: string, id: string, includeArchived?: boolean): FolderDto;
  getFolderPath(ownerId: string, id: string): Array<Pick<FolderDto, 'id' | 'title'>>;
  createFolder(
    ownerId: string,
    input: { id?: string; parentFolderId: string | null; title: string },
  ): FolderDto;
  updateFolder(ownerId: string, id: string, title: string, baseVersion: number): FolderDto;
  moveTree(
    ownerId: string,
    input: {
      item: { kind: 'FOLDER' | 'TASK'; id: string };
      parentFolderId: string | null;
      before?: { kind: 'FOLDER' | 'TASK'; id: string } | null;
      after?: { kind: 'FOLDER' | 'TASK'; id: string } | null;
      expectedStatus: TaskStatus;
      baseVersion: number;
    },
  ): TreeItemDto;
  archiveTree(
    ownerId: string,
    id: string,
    baseVersion: number,
    requestedOperationId?: string,
  ): ArchiveOperationDto;
  restoreTree(ownerId: string, id: string, operationId: string): ArchiveOperationDto;
  previewDelete(ownerId: string, id: string): DeletePreviewDto;
  deleteTree(
    ownerId: string,
    id: string,
    confirmationToken: string,
  ): { folderCount: number; taskCount: number };
  createTask(
    ownerId: string,
    input: { id?: string; parentFolderId: string | null; title: string },
  ): { task: TreeTaskDto; note: NoteDto };
  listTasks(ownerId: string, archived?: boolean): TreeTaskDto[];
  getTask(ownerId: string, id: string, includeArchived?: boolean): TreeTaskDto;
  updateTask(
    ownerId: string,
    id: string,
    patch: { title?: string; status?: TaskStatus },
    baseVersion: number,
  ): TreeTaskDto;
  updateNote(
    ownerId: string,
    taskId: string,
    contentMarkdown: string,
    baseVersion: number,
  ): NoteDto;
  archiveTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto;
  restoreTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto;
  deleteTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto;
  duplicateTask(
    ownerId: string,
    id: string,
    requestedIds?: { taskId?: string; noteId?: string; stepIds?: string[] },
  ): { task: TreeTaskDto; note: NoteDto; steps: TaskStepDto[] };
  getTaskDetails(ownerId: string, id: string): TaskDetailV2Dto;
  createStep(
    ownerId: string,
    taskId: string,
    input: { id?: string; title: string; noteMarkdown: string },
  ): TaskStepDto;
  updateStep(
    ownerId: string,
    id: string,
    patch: { title?: string; noteMarkdown?: string; status?: TaskStatus },
    baseVersion: number,
  ): TaskStepDto;
  moveStep(
    ownerId: string,
    id: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): TaskStepDto;
  deleteStep(ownerId: string, id: string, baseVersion: number): TaskStepDto;
  createDate(ownerId: string, localDate: string, id?: string): TimePointDto;
  createEvent(ownerId: string, title: string, id?: string): TimePointDto;
  listTimePoints(ownerId: string, type?: TimePointType, archived?: boolean): TimePointDto[];
  reorderTimePoints(ownerId: string, ids: string[]): TimePointDto[];
  getTimePoint(ownerId: string, id: string): TimePointDto;
  updateTimePoint(ownerId: string, id: string, title: string, baseVersion: number): TimePointDto;
  reachTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto;
  archiveTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto;
  restoreTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto;
  addPlacement(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): { placement: PlacementDto; existed: boolean };
  listPlacements(ownerId: string, timePointId: string): Array<PlacementDto & { task: TreeTaskDto }>;
  removePlacement(ownerId: string, id: string, baseVersion: number): PlacementDto;
  movePlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    baseVersion: number,
    targetPlacementId?: string,
  ): { placement: PlacementDto; sourcePlacementId: string; existed: boolean };
  copyPlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    targetPlacementId?: string,
  ): { placement: PlacementDto; existed: boolean };
  reorderPlacements(ownerId: string, timePointId: string, ids: string[]): PlacementDto[];
  /**
   * Carry every active placement of `sourceDate` forward to the next day.
   * This is the v2 equivalent of the legacy v1 rollover. It only ever creates
   * Placements (never Tasks) and writes each one through the v2 change feed so
   * every v2 client converges. The returned `createdIds` are what `undoRollover`
   * needs; the operation itself is intentionally stateless so it survives a
   * process restart and works across API instances.
   */
  rollover(
    ownerId: string,
    sourceDate: string,
  ): { createdIds: string[]; skippedTaskIds: string[]; targetDate: string };
  /** Remove placements previously created by `rollover`. */
  undoRollover(
    ownerId: string,
    placementIds: string[],
  ): { removedIds: string[]; skippedIds: string[] };
  updateSettings(
    ownerId: string,
    patch: Partial<Pick<V2SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>>,
    baseVersion: number,
  ): V2SettingsDto;
  listWorkflows(ownerId: string, includeArchived?: boolean): WorkflowDto[];
  getWorkflow(ownerId: string, id: string): WorkflowDto;
  createWorkflow(
    ownerId: string,
    input: { id?: string; name: string; defaultStageId?: string },
  ): WorkflowDto;
  updateWorkflow(ownerId: string, id: string, name: string, baseVersion: number): WorkflowDto;
  archiveWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto;
  restoreWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto;
  deleteWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto;
  createStage(
    ownerId: string,
    workflowId: string,
    input: { id?: string; name: string },
  ): WorkflowStageDto;
  updateStage(ownerId: string, id: string, name: string, baseVersion: number): WorkflowStageDto;
  moveStage(
    ownerId: string,
    id: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): WorkflowStageDto;
  deleteStage(ownerId: string, id: string, baseVersion: number): WorkflowStageDto;
  addWorkflowTask(
    ownerId: string,
    workflowId: string,
    stageId: string,
    taskId: string,
    id?: string,
  ): WorkflowTaskMembershipDto;
  moveWorkflowMembership(
    ownerId: string,
    id: string,
    stageId: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): WorkflowTaskMembershipDto;
  removeWorkflowMembership(
    ownerId: string,
    id: string,
    baseVersion: number,
  ): WorkflowTaskMembershipDto;
  snapshot(ownerId: string): V2Snapshot | Promise<V2Snapshot>;
  pull(
    ownerId: string,
    cursor: string,
    limit: number,
  ):
    | { changes: V2SyncChange[]; nextCursor: string; hasMore: boolean }
    | Promise<{
        changes: V2SyncChange[];
        nextCursor: string;
        hasMore: boolean;
      }>;
  status(
    ownerId: string,
  ):
    | { cursor: string; oldestCursor: string; protocolVersion: 2 }
    | Promise<{ cursor: string; oldestCursor: string; protocolVersion: 2 }>;
  applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: V2Mutation,
  ): Promise<{ replayed: boolean; result: unknown }>;
  subscribeChanges?(listener: (ownerId: string, cursor: string) => void): () => void;
}

export class MemoryTreeStore implements V2TreeStore {
  private readonly folders = new Map<string, FolderRecord>();
  private readonly tasks = new Map<string, TreeTaskRecord>();
  private readonly notes = new Map<string, NoteRecord>();
  private readonly steps = new Map<string, StepRecord>();
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly stages = new Map<string, StageRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly archiveOperations = new Map<string, ArchiveRecord>();
  private readonly timePoints = new Map<string, TimePointRecord>();
  private readonly placements = new Map<string, PlacementRecord>();
  private readonly settings = new Map<string, V2SettingsDto>();
  private readonly changes: V2SyncChange[] = [];
  private readonly receipts = new Map<
    string,
    { hash: string; result: unknown; expiresAt: number }
  >();
  private readonly deleteTokens = new Map<
    string,
    { ownerId: string; rootFolderId: string; fingerprint: string; expiresAt: number }
  >();
  private readonly migratedOwners = new Set<string>();
  private mutationLock: Promise<void> = Promise.resolve();
  private cursor = 0n;
  private nextTaskNumber = new Map<string, number>();
  private readonly changeListeners = new Set<(ownerId: string, cursor: string) => void>();

  constructor(private readonly legacy?: MemoryStore) {}

  prepare(ownerId?: string): void {
    void ownerId;
    // The in-memory projection is loaded lazily by ensureOwner.
  }

  /** Used by the PostgreSQL adapter to keep the domain implementation shared. */
  dumpOwnerState(ownerId: string): Record<string, unknown> {
    this.ensureOwner(ownerId);
    const own = <T extends { ownerId: string }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.ownerId === ownerId);
    return {
      folders: own(this.folders.values()),
      tasks: own(this.tasks.values()),
      notes: own(this.notes.values()),
      steps: own(this.steps.values()),
      workflows: own(this.workflows.values()),
      stages: own(this.stages.values()),
      memberships: own(this.memberships.values()),
      archiveOperations: own(this.archiveOperations.values()),
      timePoints: own(this.timePoints.values()),
      placements: own(this.placements.values()),
      settings: this.settings.get(ownerId) ?? this.defaultSettings(ownerId),
      nextTaskNumber: this.nextTaskNumber.get(ownerId) ?? 1,
    };
  }

  loadOwnerState(ownerId: string, state: Record<string, unknown>): void {
    this.migratedOwners.add(ownerId);
    const replace = <T extends { ownerId: string }>(target: Map<string, T>, value: unknown) => {
      for (const [id, row] of target) if (row.ownerId === ownerId) target.delete(id);
      if (!Array.isArray(value)) return;
      for (const row of value)
        if (row && typeof row === 'object' && (row as { ownerId?: string }).ownerId === ownerId)
          target.set(String((row as { id: string }).id), row as T);
    };
    replace(this.folders, state.folders);
    replace(this.tasks, state.tasks);
    replace(this.notes, state.notes);
    replace(this.steps, state.steps);
    replace(this.workflows, state.workflows);
    replace(this.stages, state.stages);
    replace(this.memberships, state.memberships);
    replace(this.archiveOperations, state.archiveOperations);
    replace(this.timePoints, state.timePoints);
    replace(this.placements, state.placements);
    if (state.settings && typeof state.settings === 'object')
      this.settings.set(ownerId, state.settings as V2SettingsDto);
    if (typeof state.nextTaskNumber === 'number')
      this.nextTaskNumber.set(ownerId, state.nextTaskNumber);
  }

  changeCount(): number {
    return this.changes.length;
  }
  changesFrom(index: number): V2SyncChange[] {
    return this.changes.slice(index);
  }
  subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Clear the local feed buffer after a PostgreSQL transaction is committed. */
  clearChangeBuffer(): void {
    this.changes.splice(0, this.changes.length);
  }

  async withMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationLock;
    let release!: () => void;
    this.mutationLock = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const state = this.cloneState();
    try {
      const result = await fn();
      release();
      return result;
    } catch (error) {
      this.restoreState(state);
      release();
      throw error;
    }
  }

  listTreeChildren(
    ownerId: string,
    parentFolderId: string | null,
    archived = false,
  ): TreeItemDto[] {
    this.ensureOwner(ownerId);
    const items: TreeItemDto[] = [];
    for (const folder of this.folders.values()) {
      if (
        folder.ownerId !== ownerId ||
        folder.deletedAt ||
        folder.parentFolderId !== parentFolderId
      )
        continue;
      if (!archived && folder.archivedAt) continue;
      items.push({
        kind: 'FOLDER',
        folder: this.folderDto(folder),
        aggregate: this.aggregate(ownerId, folder.id),
      });
    }
    for (const task of this.tasks.values()) {
      if (task.ownerId !== ownerId || task.deletedAt || task.parentFolderId !== parentFolderId)
        continue;
      if (!archived && task.archivedAt) continue;
      items.push({ kind: 'TASK', task: this.taskDto(task) });
    }
    return sortTreeItems(items);
  }

  listFolders(ownerId: string, archived = false): FolderDto[] {
    return this.ownerFolders(ownerId)
      .filter((folder) => (archived ? Boolean(folder.archivedAt) : !folder.archivedAt))
      .sort((left, right) => rankSort(left, right))
      .map((folder) => this.folderDto(folder));
  }

  /**
   * Top-level cascade-archive entries for the archive centre. Each operation is
   * returned once with the folders/tasks it actually controls, instead of
   * flattening every archived descendant into a thousand separate rows.
   */
  listArchiveOperations(ownerId: string, includeRestored = false): ArchiveOperationSummaryDto[] {
    this.ensureOwner(ownerId);
    const archivedFolders = this.ownerFolders(ownerId).filter((row) => row.archivedAt);
    const archivedTasks = [...this.tasks.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && row.archivedAt,
    );
    return [...this.archiveOperations.values()]
      .filter((operation) => operation.ownerId === ownerId)
      .filter((operation) => includeRestored || !operation.restoredAt)
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .map((operation) => this.archiveOperationSummary(operation, archivedFolders, archivedTasks));
  }

  getArchiveOperation(ownerId: string, operationId: string): ArchiveOperationDetailDto {
    this.ensureOwner(ownerId);
    const operation = this.archiveOperations.get(operationId);
    if (!operation || operation.ownerId !== ownerId)
      throw new DomainError('ENTITY_NOT_FOUND', '归档操作不存在');
    const archivedFolders = this.ownerFolders(ownerId).filter((row) => row.archivedAt);
    const archivedTasks = [...this.tasks.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && row.archivedAt,
    );
    const summary = this.archiveOperationSummary(operation, archivedFolders, archivedTasks);
    const folders = this.subtreeFolders(ownerId, operation.rootFolderId);
    const folderIds = new Set(folders.map((row) => row.id));
    const tasks = archivedTasks
      .filter((task) => {
        const operationValue = (task as TreeTaskRecord & { archivedByOperationId?: string | null })
          .archivedByOperationId;
        if (operationValue === operationId) return true;
        return Boolean(task.parentFolderId && folderIds.has(task.parentFolderId));
      })
      .map((task) => this.taskDto(task))
      .sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0));
    // Independently archived tasks: archived but not tied to any archive operation.
    const standaloneArchivedTasks = [...this.tasks.values()]
      .filter(
        (row) =>
          row.ownerId === ownerId &&
          !row.deletedAt &&
          row.archivedAt &&
          !(row as TreeTaskRecord & { archivedByOperationId?: string | null })
            .archivedByOperationId &&
          !(row.parentFolderId && folderIds.has(row.parentFolderId)),
      )
      .map((row) => this.taskDto(row))
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    return { ...summary, tasks, standaloneArchivedTasks };
  }

  private archiveOperationSummary(
    operation: ArchiveRecord,
    archivedFolders: readonly FolderRecord[],
    archivedTasks: readonly TreeTaskRecord[],
  ): ArchiveOperationSummaryDto {
    const subtree = this.subtreeFolders(operation.ownerId, operation.rootFolderId);
    const subtreeIds = new Set(subtree.map((row) => row.id));
    // Folders restored by this operation are no longer archived, so only count
    // currently archived rows; the tree shape still comes from the subtree.
    const controlledFolders = archivedFolders.filter(
      (folder) => subtreeIds.has(folder.id) && folder.archivedByOperationId === operation.id,
    );
    const previouslyArchivedFolders = archivedFolders.filter(
      (folder) => subtreeIds.has(folder.id) && folder.archivedByOperationId !== operation.id,
    );
    const inSubtree = (task: TreeTaskRecord) =>
      Boolean(task.parentFolderId && subtreeIds.has(task.parentFolderId));
    const operationIdOf = (task: TreeTaskRecord) =>
      (task as TreeTaskRecord & { archivedByOperationId?: string | null }).archivedByOperationId;
    const controlledTasks = archivedTasks.filter(
      (task) => inSubtree(task) && operationIdOf(task) === operation.id,
    );
    // Descendants archived before this operation ran must stay archived on restore.
    const previouslyArchivedTasks = archivedTasks.filter(
      (task) => inSubtree(task) && operationIdOf(task) !== operation.id,
    );
    return {
      ...this.archiveDto(operation),
      rootFolderTitle: this.folders.get(operation.rootFolderId)?.title ?? '',
      descendantFolderCount: controlledFolders.length,
      descendantTaskCount: controlledTasks.length,
      previouslyArchivedFolderCount: previouslyArchivedFolders.length,
      previouslyArchivedTaskCount: previouslyArchivedTasks.length,
      folders: [...subtree]
        .sort((left, right) => rankSort(left, right))
        .map((folder) => ({
          id: folder.id,
          parentFolderId: folder.parentFolderId,
          title: folder.title,
          archivedAt: folder.archivedAt,
          archivedByOperationId: folder.archivedByOperationId,
          version: folder.version,
        })),
    };
  }

  getFolder(ownerId: string, id: string, includeArchived = true): FolderDto {
    const folder = this.folder(ownerId, id);
    if (!includeArchived && folder.archivedAt)
      throw new DomainError('ENTITY_ARCHIVED', '文件夹已归档');
    return this.folderDto(folder);
  }

  getFolderPath(ownerId: string, id: string): Array<Pick<FolderDto, 'id' | 'title'>> {
    this.ensureOwner(ownerId);
    return folderPath(
      id,
      [...this.folders.values()].filter((row) => row.ownerId === ownerId && !row.deletedAt),
    );
  }

  createFolder(
    ownerId: string,
    input: { id?: string; parentFolderId: string | null; title: string },
  ): FolderDto {
    this.ensureOwner(ownerId);
    assertTreeParentIsActiveFolder(input.parentFolderId, this.ownerFolders(ownerId));
    const title = input.title.trim();
    if (!title || title.length > 160) throw new DomainError('VALIDATION_FAILED', '文件夹名称无效');
    const id = this.entityId(input.id);
    if (this.folders.has(id) || this.tasks.has(id))
      throw new DomainError('MUTATION_REJECTED', '目录实体 ID 已存在');
    const rank = this.nextSiblingRank(ownerId, input.parentFolderId, 'FOLDER');
    const now = this.now();
    const folder: FolderRecord = {
      id,
      ownerId,
      parentFolderId: input.parentFolderId,
      title,
      rank,
      version: 1,
      archivedAt: null,
      archivedByOperationId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.folders.set(id, folder);
    this.record(ownerId, 'folder', id, 1, 'upsert', this.folderDto(folder));
    return this.folderDto(folder);
  }

  updateFolder(ownerId: string, id: string, title: string, baseVersion: number): FolderDto {
    const folder = this.folder(ownerId, id);
    this.assertVersion(folder.version, baseVersion, this.folderDto(folder));
    const normalized = title.trim();
    if (!normalized || normalized.length > 160)
      throw new DomainError('VALIDATION_FAILED', '文件夹名称无效');
    folder.title = normalized;
    folder.version += 1;
    folder.updatedAt = this.now();
    this.record(ownerId, 'folder', id, folder.version, 'upsert', this.folderDto(folder));
    return this.folderDto(folder);
  }

  moveTree(
    ownerId: string,
    input: {
      item: { kind: 'FOLDER' | 'TASK'; id: string };
      parentFolderId: string | null;
      before?: { kind: 'FOLDER' | 'TASK'; id: string } | null;
      after?: { kind: 'FOLDER' | 'TASK'; id: string } | null;
      expectedStatus: TaskStatus;
      baseVersion: number;
    },
  ): TreeItemDto {
    this.ensureOwner(ownerId);
    assertTreeParentIsActiveFolder(input.parentFolderId, this.ownerFolders(ownerId));
    const current =
      input.item.kind === 'FOLDER'
        ? this.folder(ownerId, input.item.id)
        : this.taskRecord(ownerId, input.item.id);
    if (current.archivedAt)
      throw new DomainError(
        'ENTITY_ARCHIVED',
        input.item.kind === 'FOLDER' ? '文件夹已归档' : '任务已归档',
      );
    this.assertVersion(
      current.version,
      input.baseVersion,
      input.item.kind === 'FOLDER'
        ? this.folderDto(current as FolderRecord)
        : this.taskDto(current as TreeTaskRecord),
    );
    if (input.item.kind === 'FOLDER')
      assertFolderMoveAllowed(input.item.id, input.parentFolderId, this.ownerFolders(ownerId));
    const currentStatus =
      input.item.kind === 'FOLDER'
        ? this.aggregate(ownerId, input.item.id).status
        : (current as TreeTaskRecord).status;
    if (currentStatus !== input.expectedStatus)
      throw new DomainError('VERSION_CONFLICT', '目录状态已变化', { server: currentStatus });
    const anchor = input.before ?? input.after ?? null;
    if (anchor) {
      const anchorItem = this.findTreeItem(ownerId, anchor);
      const anchorStatus =
        anchor.kind === 'FOLDER'
          ? this.aggregate(ownerId, anchor.id).status
          : (anchorItem as TreeTaskRecord).status;
      const anchorParent =
        anchor.kind === 'FOLDER'
          ? (anchorItem as FolderRecord).parentFolderId
          : (anchorItem as TreeTaskRecord).parentFolderId;
      if (
        anchorParent !== input.parentFolderId ||
        anchorStatus !== input.expectedStatus ||
        anchor.id === input.item.id
      )
        throw new DomainError('VERSION_CONFLICT', '排序锚点已变化');
    }
    const siblings = this.listTreeChildren(ownerId, input.parentFolderId)
      .filter(
        (item) =>
          (item.kind === 'FOLDER' ? item.aggregate.status : item.task.status) ===
          input.expectedStatus,
      )
      .filter(
        (item) =>
          !(
            item.kind === input.item.kind &&
            (item.kind === 'FOLDER' ? item.folder.id : item.task.id) === input.item.id
          ),
      );
    const rank = this.rankForMove(siblings, input.before ?? null, input.after ?? null);
    if (input.item.kind === 'FOLDER') {
      const folder = current as FolderRecord;
      folder.parentFolderId = input.parentFolderId;
      folder.rank = rank;
      folder.version += 1;
      folder.updatedAt = this.now();
      this.record(ownerId, 'folder', folder.id, folder.version, 'upsert', this.folderDto(folder));
      return {
        kind: 'FOLDER',
        folder: this.folderDto(folder),
        aggregate: this.aggregate(ownerId, folder.id),
      };
    }
    const task = current as TreeTaskRecord;
    task.parentFolderId = input.parentFolderId;
    task.rank = rank;
    task.version += 1;
    task.updatedAt = this.now();
    this.record(ownerId, 'task', task.id, task.version, 'upsert', this.taskDto(task));
    return { kind: 'TASK', task: this.taskDto(task) };
  }

  archiveTree(
    ownerId: string,
    id: string,
    baseVersion: number,
    requestedOperationId?: string,
  ): ArchiveOperationDto {
    this.ensureOwner(ownerId);
    const root = this.folder(ownerId, id);
    if (requestedOperationId) {
      const existing = this.archiveOperations.get(requestedOperationId);
      if (existing) {
        if (existing.ownerId !== ownerId || existing.rootFolderId !== id) {
          throw new DomainError('MUTATION_REJECTED', '归档操作 ID 已被其他目录使用');
        }
        return this.archiveDto(existing);
      }
    }
    this.assertVersion(root.version, baseVersion, this.folderDto(root));
    if (root.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '文件夹已归档');
    const operationId = requestedOperationId ?? uuidv7();
    const folders = this.subtreeFolders(ownerId, id);
    const folderIds = new Set(folders.map((row) => row.id));
    const tasks = [...this.tasks.values()].filter(
      (task) =>
        task.ownerId === ownerId &&
        !task.deletedAt &&
        task.parentFolderId &&
        folderIds.has(task.parentFolderId),
    );
    const now = this.now();
    const operation: ArchiveRecord = {
      id: operationId,
      ownerId,
      rootFolderId: id,
      rootBaseVersion: baseVersion,
      folderCount: folders.filter((row) => !row.archivedAt).length,
      taskCount: tasks.filter((row) => !row.archivedAt).length,
      createdAt: now,
      restoredAt: null,
    };
    this.archiveOperations.set(operationId, operation);
    for (const folder of folders) {
      if (folder.archivedAt) continue;
      folder.archivedAt = now;
      folder.archivedByOperationId = operationId;
      folder.version += 1;
      folder.updatedAt = now;
      this.record(ownerId, 'folder', folder.id, folder.version, 'upsert', this.folderDto(folder));
    }
    for (const task of tasks) {
      if (task.archivedAt) continue;
      task.archivedAt = now;
      task.version += 1;
      // The operation id is not part of the public Task DTO but is retained in
      // the record for exact restoration and included in the sync snapshot.
      (task as TreeTaskRecord & { archivedByOperationId?: string | null }).archivedByOperationId =
        operationId;
      task.updatedAt = now;
      this.record(ownerId, 'task', task.id, task.version, 'upsert', this.taskDto(task));
    }
    this.record(ownerId, 'archiveOperation', operationId, 1, 'upsert', this.archiveDto(operation));
    return this.archiveDto(operation);
  }

  restoreTree(ownerId: string, id: string, operationId: string): ArchiveOperationDto {
    this.ensureOwner(ownerId);
    const root = this.folder(ownerId, id);
    const operation = this.archiveOperations.get(operationId);
    if (
      !operation ||
      operation.ownerId !== ownerId ||
      operation.rootFolderId !== id ||
      operation.restoredAt
    )
      throw new DomainError('ENTITY_NOT_FOUND', '归档操作不存在或已恢复');
    const rootOperation = (root as FolderRecord).archivedByOperationId;
    if (rootOperation !== operationId)
      throw new DomainError('ANCESTOR_ARCHIVED', '祖先归档边界不允许单独恢复');
    const now = this.now();
    for (const folder of this.folders.values()) {
      if (
        folder.ownerId !== ownerId ||
        folder.deletedAt ||
        folder.archivedByOperationId !== operationId
      )
        continue;
      folder.archivedAt = null;
      folder.archivedByOperationId = null;
      folder.version += 1;
      folder.updatedAt = now;
      this.record(ownerId, 'folder', folder.id, folder.version, 'upsert', this.folderDto(folder));
    }
    for (const task of this.tasks.values()) {
      const operationValue = (task as TreeTaskRecord & { archivedByOperationId?: string | null })
        .archivedByOperationId;
      if (task.ownerId !== ownerId || task.deletedAt || operationValue !== operationId) continue;
      task.archivedAt = null;
      delete (task as TreeTaskRecord & { archivedByOperationId?: string | null })
        .archivedByOperationId;
      task.version += 1;
      task.updatedAt = now;
      this.record(ownerId, 'task', task.id, task.version, 'upsert', this.taskDto(task));
    }
    operation.restoredAt = now;
    this.record(ownerId, 'archiveOperation', operation.id, 2, 'upsert', this.archiveDto(operation));
    return this.archiveDto(operation);
  }

  previewDelete(ownerId: string, id: string): DeletePreviewDto {
    this.ensureOwner(ownerId);
    const root = this.folder(ownerId, id);
    const folders = this.subtreeFolders(ownerId, id);
    const ids = new Set(folders.map((row) => row.id));
    const tasks = [...this.tasks.values()].filter(
      (row) =>
        row.ownerId === ownerId &&
        !row.deletedAt &&
        row.parentFolderId &&
        ids.has(row.parentFolderId),
    );
    const taskIds = new Set(tasks.map((row) => row.id));
    const notes = [...this.notes.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const steps = [...this.steps.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const placements = [...this.placements.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const memberships = [...this.memberships.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const fingerprint = this.subtreeFingerprint(
      folders,
      tasks,
      notes,
      steps,
      placements,
      memberships,
    );
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const token = this.generateDeleteToken(ownerId, id, fingerprint, Date.parse(expiresAt));
    this.deleteTokens.set(token, {
      ownerId,
      rootFolderId: id,
      fingerprint,
      expiresAt: Date.parse(expiresAt),
    });
    return {
      rootFolderId: id,
      title: root.title,
      folderCount: folders.length,
      taskCount: tasks.length,
      noteCount: notes.length,
      stepCount: steps.length,
      placementCount: placements.length,
      workflowMembershipCount: memberships.length,
      subtreeFingerprint: fingerprint,
      expiresAt,
      confirmationToken: token,
    };
  }

  deleteTree(
    ownerId: string,
    id: string,
    confirmationToken: string,
  ): { folderCount: number; taskCount: number } {
    this.ensureOwner(ownerId);
    const token = this.verifyDeleteToken(confirmationToken, ownerId, id);
    if (!token) throw new DomainError('DELETE_CONFIRMATION_REQUIRED', '删除确认令牌无效或已过期');
    const folders = this.subtreeFolders(ownerId, id);
    const folderIds = new Set(folders.map((row) => row.id));
    const tasks = [...this.tasks.values()].filter(
      (row) =>
        row.ownerId === ownerId &&
        !row.deletedAt &&
        row.parentFolderId &&
        folderIds.has(row.parentFolderId),
    );
    const taskIds = new Set(tasks.map((row) => row.id));
    const notes = [...this.notes.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const steps = [...this.steps.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const placements = [...this.placements.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const memberships = [...this.memberships.values()].filter(
      (row) => row.ownerId === ownerId && !row.deletedAt && taskIds.has(row.taskId),
    );
    const current = this.subtreeFingerprint(folders, tasks, notes, steps, placements, memberships);
    if (current !== token.fingerprint)
      throw new DomainError('SUBTREE_CHANGED', '预览后的目录内容已变化');
    const now = this.now();
    for (const membership of memberships)
      this.tombstone(ownerId, 'workflowTaskMembership', membership, now);
    for (const placement of placements) this.tombstone(ownerId, 'placement', placement, now);
    for (const step of steps) this.tombstone(ownerId, 'taskStep', step, now);
    for (const note of notes) this.tombstone(ownerId, 'note', note, now);
    for (const task of tasks) this.tombstone(ownerId, 'task', task, now);
    for (const folder of folders.sort(
      (a, b) => this.depth(ownerId, b.id) - this.depth(ownerId, a.id),
    ))
      this.tombstone(ownerId, 'folder', folder, now);
    this.deleteTokens.delete(confirmationToken);
    return { folderCount: folders.length, taskCount: tasks.length };
  }

  createTask(
    ownerId: string,
    input: { id?: string; parentFolderId: string | null; title: string },
  ): { task: TreeTaskDto; note: NoteDto } {
    this.ensureOwner(ownerId);
    assertTreeParentIsActiveFolder(input.parentFolderId, this.ownerFolders(ownerId));
    const title = input.title.trim();
    if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
    const id = this.entityId(input.id);
    if (this.tasks.has(id) || this.folders.has(id))
      throw new DomainError('MUTATION_REJECTED', '任务 ID 已存在');
    const number = this.nextTaskNumber.get(ownerId) ?? 1;
    this.nextTaskNumber.set(ownerId, number + 1);
    const now = this.now();
    const task: TreeTaskRecord = {
      id,
      ownerId,
      referenceId: `TASK-${number}`,
      parentFolderId: input.parentFolderId,
      title,
      status: 'TODO',
      rank: this.nextSiblingRank(ownerId, input.parentFolderId, 'TASK'),
      version: 1,
      completedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const note: NoteRecord = {
      id: uuidv7(),
      ownerId,
      taskId: id,
      contentMarkdown: '',
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.tasks.set(id, task);
    this.notes.set(note.id, note);
    this.record(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    this.record(ownerId, 'note', note.id, note.version, 'upsert', this.noteDto(note));
    return { task: this.taskDto(task), note: this.noteDto(note) };
  }

  listTasks(ownerId: string, archived = false): TreeTaskDto[] {
    this.ensureOwner(ownerId);
    return [...this.tasks.values()]
      .filter(
        (row) =>
          row.ownerId === ownerId &&
          !row.deletedAt &&
          (archived ? Boolean(row.archivedAt) : !row.archivedAt),
      )
      .sort((a, b) =>
        BigInt(a.rank) < BigInt(b.rank)
          ? -1
          : BigInt(a.rank) > BigInt(b.rank)
            ? 1
            : a.id.localeCompare(b.id),
      )
      .map((row) => this.taskDto(row));
  }

  getTask(ownerId: string, id: string, includeArchived = true): TreeTaskDto {
    const task = this.taskRecord(ownerId, id);
    if (!includeArchived && task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    return this.taskDto(task);
  }

  updateTask(
    ownerId: string,
    id: string,
    patch: { title?: string; status?: TaskStatus },
    baseVersion: number,
  ): TreeTaskDto {
    const task = this.taskRecord(ownerId, id);
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
      task.title = title;
    }
    if (patch.status !== undefined) {
      const next = transitionTask(
        task.status,
        patch.status,
        new Date(this.now()),
        task.completedAt,
      );
      task.status = next.status;
      task.completedAt = next.completedAt?.toISOString() ?? null;
    }
    task.version += 1;
    task.updatedAt = this.now();
    this.record(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  updateNote(
    ownerId: string,
    taskId: string,
    contentMarkdown: string,
    baseVersion: number,
  ): NoteDto {
    this.taskRecord(ownerId, taskId);
    const note = this.noteForTask(ownerId, taskId);
    this.assertVersion(note.version, baseVersion, this.noteDto(note));
    if (contentMarkdown.length > 1024 * 1024)
      throw new DomainError('VALIDATION_FAILED', '备注超过 1 MiB');
    note.contentMarkdown = contentMarkdown;
    note.version += 1;
    note.updatedAt = this.now();
    this.record(ownerId, 'note', note.id, note.version, 'upsert', this.noteDto(note));
    return this.noteDto(note);
  }

  archiveTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto {
    const task = this.taskRecord(ownerId, id);
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    task.archivedAt = this.now();
    task.version += 1;
    task.updatedAt = this.now();
    this.record(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  restoreTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto {
    const task = this.taskRecord(ownerId, id);
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    assertTreeParentIsActiveFolder(task.parentFolderId, this.ownerFolders(ownerId));
    task.archivedAt = null;
    delete (task as TreeTaskRecord & { archivedByOperationId?: string | null })
      .archivedByOperationId;
    task.version += 1;
    task.updatedAt = this.now();
    this.record(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  deleteTask(ownerId: string, id: string, baseVersion: number): TreeTaskDto {
    const task = this.taskRecord(ownerId, id);
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    const now = this.now();
    for (const membership of this.memberships.values()) {
      if (membership.ownerId === ownerId && membership.taskId === id && !membership.deletedAt)
        this.tombstone(ownerId, 'workflowTaskMembership', membership, now);
    }
    for (const placement of this.placements.values()) {
      if (placement.ownerId === ownerId && placement.taskId === id && !placement.deletedAt)
        this.tombstone(ownerId, 'placement', placement, now);
    }
    for (const step of this.steps.values()) {
      if (step.ownerId === ownerId && step.taskId === id && !step.deletedAt)
        this.tombstone(ownerId, 'taskStep', step, now);
    }
    for (const note of this.notes.values()) {
      if (note.ownerId === ownerId && note.taskId === id && !note.deletedAt)
        this.tombstone(ownerId, 'note', note, now);
    }
    this.tombstone(ownerId, 'task', task, now);
    return this.taskDto(task);
  }

  duplicateTask(
    ownerId: string,
    id: string,
    requestedIds: { taskId?: string; noteId?: string; stepIds?: string[] } = {},
  ): { task: TreeTaskDto; note: NoteDto; steps: TaskStepDto[] } {
    const source = this.taskRecord(ownerId, id);
    const sourceNote = this.noteForTask(ownerId, id);
    const created = this.createTask(ownerId, {
      id: requestedIds.taskId,
      parentFolderId: source.parentFolderId,
      title: source.title,
    });
    const task = this.tasks.get(created.task.id)!;
    task.rank = this.nextSiblingRank(ownerId, source.parentFolderId, 'TASK');
    const note = this.notes.get(created.note.id)!;
    if (requestedIds.noteId) {
      this.notes.delete(note.id);
      note.id = requestedIds.noteId;
      this.notes.set(note.id, note);
    }
    note.contentMarkdown = sourceNote.contentMarkdown;
    note.version += 1;
    note.updatedAt = this.now();
    this.record(ownerId, 'note', note.id, note.version, 'upsert', this.noteDto(note));
    const copiedSteps: TaskStepDto[] = [];
    for (const [index, step] of this.stepsForTask(ownerId, id).entries()) {
      const copy: StepRecord = {
        ...step,
        id: requestedIds.stepIds?.[index] ?? uuidv7(),
        taskId: task.id,
        status: 'TODO',
        completedAt: null,
        version: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
        deletedAt: null,
      };
      this.steps.set(copy.id, copy);
      copiedSteps.push(this.stepDto(copy));
      this.record(ownerId, 'taskStep', copy.id, 1, 'upsert', this.stepDto(copy));
    }
    return { task: this.taskDto(task), note: this.noteDto(note), steps: copiedSteps };
  }

  getTaskDetails(ownerId: string, id: string): TaskDetailV2Dto {
    const task = this.taskRecord(ownerId, id);
    const memberships = [...this.memberships.values()].filter(
      (membership) =>
        membership.ownerId === ownerId && membership.taskId === id && !membership.deletedAt,
    );
    return {
      task: this.taskDto(task),
      note: this.noteDto(this.noteForTask(ownerId, id)),
      steps: this.stepsForTask(ownerId, id).map((row) => this.stepDto(row)),
      placements: [...this.placements.values()]
        .filter((row) => row.ownerId === ownerId && row.taskId === id && !row.deletedAt)
        .map((row) => this.placementDto(row)),
      workflowMemberships: memberships.map((membership) => {
        const workflow = this.workflow(ownerId, membership.workflowId);
        const stage = this.stage(ownerId, membership.stageId);
        return {
          ...this.membershipDto(membership),
          workflow: { id: workflow.id, name: workflow.name },
          stage: { id: stage.id, name: stage.name },
        };
      }),
      folderPath: folderPath(task.parentFolderId, this.ownerFolders(ownerId)).map((row) => ({
        id: row.id,
        title: row.title,
      })),
    };
  }

  createStep(
    ownerId: string,
    taskId: string,
    input: { id?: string; title: string; noteMarkdown: string },
  ): TaskStepDto {
    this.taskRecord(ownerId, taskId);
    const title = input.title.trim();
    if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '步骤标题无效');
    if (input.noteMarkdown.length > 1024 * 1024)
      throw new DomainError('VALIDATION_FAILED', '步骤备注过大');
    const id = this.entityId(input.id);
    if (this.steps.has(id)) throw new DomainError('MUTATION_REJECTED', '步骤 ID 已存在');
    const now = this.now();
    const step: StepRecord = {
      id,
      ownerId,
      taskId,
      title,
      noteMarkdown: input.noteMarkdown,
      status: 'TODO',
      rank: this.nextStepRank(ownerId, taskId),
      completedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.steps.set(id, step);
    this.record(ownerId, 'taskStep', id, 1, 'upsert', this.stepDto(step));
    return this.stepDto(step);
  }

  updateStep(
    ownerId: string,
    id: string,
    patch: { title?: string; noteMarkdown?: string; status?: TaskStatus },
    baseVersion: number,
  ): TaskStepDto {
    const step = this.step(ownerId, id);
    this.assertVersion(step.version, baseVersion, this.stepDto(step));
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '步骤标题无效');
      step.title = title;
    }
    if (patch.noteMarkdown !== undefined) {
      if (patch.noteMarkdown.length > 1024 * 1024)
        throw new DomainError('VALIDATION_FAILED', '步骤备注过大');
      step.noteMarkdown = patch.noteMarkdown;
    }
    if (patch.status !== undefined) {
      const next = stepTransition(
        step.status,
        patch.status,
        new Date(this.now()),
        step.completedAt,
      );
      step.status = next.status;
      step.completedAt = next.completedAt?.toISOString() ?? null;
    }
    step.version += 1;
    step.updatedAt = this.now();
    this.record(ownerId, 'taskStep', id, step.version, 'upsert', this.stepDto(step));
    return this.stepDto(step);
  }

  moveStep(
    ownerId: string,
    id: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): TaskStepDto {
    const step = this.step(ownerId, id);
    this.assertVersion(step.version, baseVersion, this.stepDto(step));
    const siblings = this.stepsForTask(ownerId, step.taskId).filter((row) => row.id !== id);
    if (beforeId && !siblings.some((row) => row.id === beforeId))
      throw new DomainError('VERSION_CONFLICT', '步骤锚点已变化');
    if (afterId && !siblings.some((row) => row.id === afterId))
      throw new DomainError('VERSION_CONFLICT', '步骤锚点已变化');
    step.rank = this.rankForRecordMove(siblings, beforeId ?? null, afterId ?? null);
    step.version += 1;
    step.updatedAt = this.now();
    this.record(ownerId, 'taskStep', id, step.version, 'upsert', this.stepDto(step));
    return this.stepDto(step);
  }

  deleteStep(ownerId: string, id: string, baseVersion: number): TaskStepDto {
    const step = this.step(ownerId, id);
    this.assertVersion(step.version, baseVersion, this.stepDto(step));
    step.deletedAt = this.now();
    step.version += 1;
    step.updatedAt = this.now();
    this.record(ownerId, 'taskStep', id, step.version, 'delete', this.stepDto(step));
    return this.stepDto(step);
  }

  createDate(ownerId: string, localDate: string, id?: string): TimePointDto {
    validateLocalDate(localDate);
    this.ensureOwner(ownerId);
    const existing = [...this.timePoints.values()].find(
      (point) =>
        point.ownerId === ownerId &&
        point.type === 'DATE' &&
        point.localDate === localDate &&
        !point.deletedAt,
    );
    if (existing) return this.timePointDto(existing);
    return this.createTimePoint(ownerId, { type: 'DATE', localDate, id });
  }

  createEvent(ownerId: string, title: string, id?: string): TimePointDto {
    return this.createTimePoint(ownerId, { type: 'EVENT', title, id });
  }

  listTimePoints(ownerId: string, type?: TimePointType, archived?: boolean): TimePointDto[] {
    this.ensureOwner(ownerId);
    return [...this.timePoints.values()]
      .filter(
        (point) =>
          point.ownerId === ownerId &&
          !point.deletedAt &&
          (!type || point.type === type) &&
          (archived === undefined || archived === Boolean(point.archivedAt)),
      )
      .sort((left, right) =>
        left.type === 'DATE' && right.type === 'DATE'
          ? (left.localDate ?? '').localeCompare(right.localDate ?? '')
          : rankSort(left, right),
      )
      .map((point) => this.timePointDto(point));
  }

  reorderTimePoints(ownerId: string, ids: string[]): TimePointDto[] {
    this.ensureOwner(ownerId);
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '时间点排序列表不能有重复项');
    const points = ids.map((id) => this.timePoint(ownerId, id));
    if (points.some((point) => point.type !== 'EVENT'))
      throw new DomainError('VALIDATION_FAILED', '只能排序事件');
    const expected = [...this.timePoints.values()].filter(
      (point) =>
        point.ownerId === ownerId &&
        point.type === 'EVENT' &&
        !point.deletedAt &&
        !point.archivedAt,
    );
    if (expected.length !== ids.length || expected.some((point) => !ids.includes(point.id)))
      throw new DomainError('VALIDATION_FAILED', '时间点排序列表必须包含整个活动列表');
    for (const [index, id] of ids.entries()) {
      const point = this.timePoint(ownerId, id);
      point.rank = ((index + 1) * 1024).toString();
      point.version += 1;
      point.updatedAt = this.now();
      this.record(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    }
    return this.listTimePoints(ownerId, 'EVENT', false);
  }

  getTimePoint(ownerId: string, id: string): TimePointDto {
    const point = this.timePoints.get(id);
    if (!point || point.ownerId !== ownerId || point.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '时间点不存在');
    return this.timePointDto(point);
  }

  updateTimePoint(ownerId: string, id: string, title: string, baseVersion: number): TimePointDto {
    const point = this.timePoint(ownerId, id);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不可改名');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    const normalized = title.trim();
    if (!normalized || normalized.length > 200)
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    point.title = normalized;
    point.version += 1;
    point.updatedAt = this.now();
    this.record(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  reachTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    const point = this.timePoint(ownerId, id);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期没有到达状态');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    point.reachedAt ??= this.now();
    point.version += 1;
    point.updatedAt = this.now();
    this.record(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  archiveTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    return this.setTimePointArchived(ownerId, id, baseVersion, true);
  }

  restoreTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    return this.setTimePointArchived(ownerId, id, baseVersion, false);
  }

  private setTimePointArchived(
    ownerId: string,
    id: string,
    baseVersion: number,
    archived: boolean,
  ): TimePointDto {
    const point = this.timePoint(ownerId, id);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不能归档或恢复');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    point.archivedAt = archived ? this.now() : null;
    point.version += 1;
    point.updatedAt = this.now();
    this.record(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  addPlacement(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): { placement: PlacementDto; existed: boolean } {
    const task = this.taskRecord(ownerId, taskId);
    const point = this.timePoint(ownerId, timePointId);
    if (task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = [...this.placements.values()].find(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.taskId === taskId &&
        placement.timePointId === timePointId &&
        !placement.deletedAt,
    );
    if (existing) return { placement: this.placementDto(existing), existed: true };
    const placementId = this.entityId(id);
    if (this.placements.has(placementId))
      throw new DomainError('MUTATION_REJECTED', '安排 ID 已存在');
    const siblings = [...this.placements.values()].filter(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.timePointId === timePointId &&
        !placement.deletedAt,
    );
    const now = this.now();
    const placement: PlacementRecord = {
      id: placementId,
      ownerId,
      taskId,
      timePointId,
      rank: (
        (siblings.length
          ? siblings
              .map((row) => BigInt(row.rank))
              .reduce((max, value) => (value > max ? value : max), 0n)
          : 0n) + 1024n
      ).toString(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.placements.set(placementId, placement);
    this.record(ownerId, 'placement', placementId, 1, 'upsert', this.placementDto(placement));
    return { placement: this.placementDto(placement), existed: false };
  }

  listPlacements(
    ownerId: string,
    timePointId: string,
  ): Array<PlacementDto & { task: TreeTaskDto }> {
    this.timePoint(ownerId, timePointId);
    return [...this.placements.values()]
      .filter(
        (placement) =>
          placement.ownerId === ownerId &&
          placement.timePointId === timePointId &&
          !placement.deletedAt,
      )
      .sort(rankSort)
      .flatMap((placement) => {
        const task = this.tasks.get(placement.taskId);
        return task && task.ownerId === ownerId && !task.deletedAt
          ? [{ ...this.placementDto(placement), task: this.taskDto(task) }]
          : [];
      });
  }

  removePlacement(ownerId: string, id: string, baseVersion: number): PlacementDto {
    const placement = this.placement(ownerId, id);
    this.assertVersion(placement.version, baseVersion, this.placementDto(placement));
    placement.deletedAt = this.now();
    placement.version += 1;
    placement.updatedAt = this.now();
    this.record(ownerId, 'placement', id, placement.version, 'delete', { ...placement });
    return this.placementDto(placement);
  }

  movePlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    baseVersion: number,
    targetPlacementId?: string,
  ): { placement: PlacementDto; sourcePlacementId: string; existed: boolean } {
    const source = this.placement(ownerId, id);
    this.assertVersion(source.version, baseVersion, this.placementDto(source));
    const target = this.timePoint(ownerId, targetTimePointId);
    if (source.timePointId === targetTimePointId)
      throw new DomainError('VALIDATION_FAILED', '安排已经位于目标时间点');
    if (target.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = [...this.placements.values()].find(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.taskId === source.taskId &&
        placement.timePointId === targetTimePointId &&
        !placement.deletedAt,
    );
    if (existing) {
      source.deletedAt = this.now();
      source.version += 1;
      source.updatedAt = this.now();
      this.record(ownerId, 'placement', source.id, source.version, 'delete', { ...source });
      return {
        placement: this.placementDto(existing),
        sourcePlacementId: source.id,
        existed: true,
      };
    }
    const result = this.addPlacement(ownerId, source.taskId, targetTimePointId, targetPlacementId);
    source.deletedAt = this.now();
    source.version += 1;
    source.updatedAt = this.now();
    this.record(ownerId, 'placement', source.id, source.version, 'delete', { ...source });
    return { placement: result.placement, sourcePlacementId: source.id, existed: false };
  }

  copyPlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    targetPlacementId?: string,
  ): { placement: PlacementDto; existed: boolean } {
    const source = this.placement(ownerId, id);
    return this.addPlacement(ownerId, source.taskId, targetTimePointId, targetPlacementId);
  }

  reorderPlacements(ownerId: string, timePointId: string, ids: string[]): PlacementDto[] {
    this.timePoint(ownerId, timePointId);
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '安排排序列表不能有重复项');
    const expected = [...this.placements.values()].filter(
      (row) => row.ownerId === ownerId && row.timePointId === timePointId && !row.deletedAt,
    );
    if (expected.length !== ids.length || expected.some((row) => !ids.includes(row.id)))
      throw new DomainError('VALIDATION_FAILED', '安排排序列表必须包含整个时间点列表');
    for (const [index, id] of ids.entries()) {
      const placement = this.placement(ownerId, id);
      placement.rank = ((index + 1) * 1024).toString();
      placement.version += 1;
      placement.updatedAt = this.now();
      this.record(
        ownerId,
        'placement',
        id,
        placement.version,
        'upsert',
        this.placementDto(placement),
      );
    }
    return expected.sort(rankSort).map((row) => this.placementDto(row));
  }

  rollover(
    ownerId: string,
    sourceDate: string,
  ): { createdIds: string[]; skippedTaskIds: string[]; targetDate: string } {
    validateLocalDate(sourceDate);
    this.ensureOwner(ownerId);
    const targetDate = nextLocalDate(sourceDate);
    const source = this.createDate(ownerId, sourceDate);
    const target = this.createDate(ownerId, targetDate);
    const createdIds: string[] = [];
    const skippedTaskIds: string[] = [];
    const sourcePlacements = [...this.placements.values()]
      .filter((row) => row.ownerId === ownerId && row.timePointId === source.id && !row.deletedAt)
      .sort(rankSort);
    for (const placement of sourcePlacements) {
      const task = this.tasks.get(placement.taskId);
      if (!task || task.deletedAt || task.archivedAt || task.status === 'DONE') {
        skippedTaskIds.push(placement.taskId);
        continue;
      }
      const added = this.addPlacement(ownerId, placement.taskId, target.id);
      if (added.existed) skippedTaskIds.push(placement.taskId);
      else createdIds.push(added.placement.id);
    }
    return { createdIds, skippedTaskIds, targetDate };
  }

  undoRollover(
    ownerId: string,
    placementIds: string[],
  ): { removedIds: string[]; skippedIds: string[] } {
    this.ensureOwner(ownerId);
    const removedIds: string[] = [];
    const skippedIds: string[] = [];
    for (const placementId of placementIds) {
      const placement = this.placements.get(placementId);
      if (!placement || placement.ownerId !== ownerId || placement.deletedAt) {
        skippedIds.push(placementId);
        continue;
      }
      this.removePlacement(ownerId, placementId, placement.version);
      removedIds.push(placementId);
    }
    return { removedIds, skippedIds };
  }

  listWorkflows(ownerId: string, includeArchived = false): WorkflowDto[] {
    this.ensureOwner(ownerId);
    return [...this.workflows.values()]
      .filter(
        (row) => row.ownerId === ownerId && !row.deletedAt && (includeArchived || !row.archivedAt),
      )
      .sort(rankSort)
      .map((row) => this.workflowDtoWithChildren(ownerId, row));
  }

  getWorkflow(ownerId: string, id: string): WorkflowDto {
    return this.workflowDtoWithChildren(ownerId, this.workflow(ownerId, id));
  }

  createWorkflow(
    ownerId: string,
    input: { id?: string; name: string; defaultStageId?: string },
  ): WorkflowDto {
    this.ensureOwner(ownerId);
    const name = input.name.trim();
    if (!name || name.length > 200) throw new DomainError('VALIDATION_FAILED', '流程名称无效');
    const id = this.entityId(input.id);
    if (this.workflows.has(id)) throw new DomainError('MUTATION_REJECTED', '流程 ID 已存在');
    const now = this.now();
    const workflow: WorkflowRecord = {
      id,
      ownerId,
      name,
      rank: this.nextWorkflowRank(ownerId),
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.workflows.set(id, workflow);
    this.record(ownerId, 'workflow', id, 1, 'upsert', this.workflowDto(workflow));
    this.createStage(ownerId, id, { id: input.defaultStageId, name: '阶段 1' });
    return this.workflowDtoWithChildren(ownerId, workflow);
  }

  updateWorkflow(ownerId: string, id: string, name: string, baseVersion: number): WorkflowDto {
    const workflow = this.workflow(ownerId, id);
    this.assertVersion(workflow.version, baseVersion, this.workflowDto(workflow));
    const normalized = name.trim();
    if (!normalized || normalized.length > 200)
      throw new DomainError('VALIDATION_FAILED', '流程名称无效');
    workflow.name = normalized;
    workflow.version += 1;
    workflow.updatedAt = this.now();
    this.record(ownerId, 'workflow', id, workflow.version, 'upsert', this.workflowDto(workflow));
    return this.workflowDtoWithChildren(ownerId, workflow);
  }

  archiveWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto {
    return this.setWorkflowArchived(ownerId, id, baseVersion, true);
  }

  restoreWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto {
    return this.setWorkflowArchived(ownerId, id, baseVersion, false);
  }

  deleteWorkflow(ownerId: string, id: string, baseVersion: number): WorkflowDto {
    const workflow = this.workflow(ownerId, id);
    this.assertVersion(workflow.version, baseVersion, this.workflowDto(workflow));
    const now = this.now();
    for (const stage of this.stages.values())
      if (stage.workflowId === id && !stage.deletedAt)
        this.tombstone(ownerId, 'workflowStage', stage, now);
    for (const membership of this.memberships.values())
      if (membership.workflowId === id && !membership.deletedAt)
        this.tombstone(ownerId, 'workflowTaskMembership', membership, now);
    this.tombstone(ownerId, 'workflow', workflow, now);
    return this.workflowDto(workflow);
  }

  createStage(
    ownerId: string,
    workflowId: string,
    input: { id?: string; name: string },
  ): WorkflowStageDto {
    const workflow = this.workflow(ownerId, workflowId);
    if (workflow.archivedAt) throw new DomainError('TARGET_ARCHIVED', '流程已归档');
    const name = input.name.trim();
    if (!name || name.length > 200) throw new DomainError('VALIDATION_FAILED', '阶段名称无效');
    const id = this.entityId(input.id);
    if (this.stages.has(id)) throw new DomainError('MUTATION_REJECTED', '阶段 ID 已存在');
    const now = this.now();
    const stage: StageRecord = {
      id,
      ownerId,
      workflowId,
      name,
      rank: this.nextStageRank(ownerId, workflowId),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.stages.set(id, stage);
    this.record(ownerId, 'workflowStage', id, 1, 'upsert', this.stageDto(stage));
    return this.stageDto(stage);
  }

  updateStage(ownerId: string, id: string, name: string, baseVersion: number): WorkflowStageDto {
    const stage = this.stage(ownerId, id);
    this.assertVersion(stage.version, baseVersion, this.stageDto(stage));
    const normalized = name.trim();
    if (!normalized || normalized.length > 200)
      throw new DomainError('VALIDATION_FAILED', '阶段名称无效');
    stage.name = normalized;
    stage.version += 1;
    stage.updatedAt = this.now();
    this.record(ownerId, 'workflowStage', id, stage.version, 'upsert', this.stageDto(stage));
    return this.stageDto(stage);
  }

  moveStage(
    ownerId: string,
    id: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): WorkflowStageDto {
    const stage = this.stage(ownerId, id);
    this.assertVersion(stage.version, baseVersion, this.stageDto(stage));
    const siblings = [...this.stages.values()].filter(
      (row) =>
        row.ownerId === ownerId &&
        row.workflowId === stage.workflowId &&
        !row.deletedAt &&
        row.id !== id,
    );
    if (beforeId && !siblings.some((row) => row.id === beforeId))
      throw new DomainError('VERSION_CONFLICT', '阶段锚点已变化');
    if (afterId && !siblings.some((row) => row.id === afterId))
      throw new DomainError('VERSION_CONFLICT', '阶段锚点已变化');
    const ordered = siblings.sort(rankSort);
    const anchorId = beforeId ?? afterId;
    if (!anchorId) stage.rank = this.nextStageRank(ownerId, stage.workflowId);
    else {
      const index = ordered.findIndex((row) => row.id === anchorId);
      const anchor = ordered[index]!;
      const lower = beforeId
        ? (ordered[index - 1]?.rank ?? (BigInt(anchor.rank) - 1024n).toString())
        : anchor.rank;
      const upper = beforeId
        ? anchor.rank
        : (ordered[index + 1]?.rank ?? (BigInt(anchor.rank) + 1024n).toString());
      stage.rank = allocateRank([BigInt(lower), BigInt(upper)], 1).toString();
    }
    stage.version += 1;
    stage.updatedAt = this.now();
    this.record(ownerId, 'workflowStage', id, stage.version, 'upsert', this.stageDto(stage));
    return this.stageDto(stage);
  }

  deleteStage(ownerId: string, id: string, baseVersion: number): WorkflowStageDto {
    const stage = this.stage(ownerId, id);
    this.assertVersion(stage.version, baseVersion, this.stageDto(stage));
    const activeStageCount = [...this.stages.values()].filter(
      (candidate) =>
        candidate.ownerId === ownerId &&
        candidate.workflowId === stage.workflowId &&
        !candidate.deletedAt,
    ).length;
    if (activeStageCount <= 1)
      throw new DomainError('VALIDATION_FAILED', '流程至少需要保留一个阶段');
    const now = this.now();
    for (const membership of this.memberships.values())
      if (membership.stageId === id && !membership.deletedAt)
        this.tombstone(ownerId, 'workflowTaskMembership', membership, now);
    this.tombstone(ownerId, 'workflowStage', stage, now);
    return this.stageDto(stage);
  }

  addWorkflowTask(
    ownerId: string,
    workflowId: string,
    stageId: string,
    taskId: string,
    id?: string,
  ): WorkflowTaskMembershipDto {
    const workflow = this.workflow(ownerId, workflowId);
    const stage = this.stage(ownerId, stageId);
    const task = this.taskRecord(ownerId, taskId);
    if (stage.workflowId !== workflow.id)
      throw new DomainError('STAGE_WORKFLOW_MISMATCH', '阶段不属于该流程');
    if (workflow.archivedAt || task.archivedAt)
      throw new DomainError('TARGET_ARCHIVED', '流程或任务已归档');
    if (
      [...this.memberships.values()].some(
        (row) =>
          row.ownerId === ownerId &&
          row.workflowId === workflowId &&
          row.taskId === taskId &&
          !row.deletedAt,
      )
    )
      throw new DomainError('WORKFLOW_TASK_ALREADY_EXISTS', '任务已在该流程中');
    const membershipId = this.entityId(id);
    const now = this.now();
    const membership: MembershipRecord = {
      id: membershipId,
      ownerId,
      workflowId,
      stageId,
      taskId,
      rank: this.nextMembershipRank(ownerId, stageId),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.memberships.set(membershipId, membership);
    this.record(
      ownerId,
      'workflowTaskMembership',
      membershipId,
      1,
      'upsert',
      this.membershipDto(membership),
    );
    return this.membershipDto(membership);
  }

  moveWorkflowMembership(
    ownerId: string,
    id: string,
    stageId: string,
    beforeId: string | null | undefined,
    afterId: string | null | undefined,
    baseVersion: number,
  ): WorkflowTaskMembershipDto {
    const membership = this.membership(ownerId, id);
    const stage = this.stage(ownerId, stageId);
    this.assertVersion(membership.version, baseVersion, this.membershipDto(membership));
    if (stage.workflowId !== membership.workflowId)
      throw new DomainError('STAGE_WORKFLOW_MISMATCH', '阶段不属于该流程');
    if (
      [...this.memberships.values()].some(
        (row) =>
          row.id !== id &&
          row.ownerId === ownerId &&
          row.workflowId === membership.workflowId &&
          row.taskId === membership.taskId &&
          !row.deletedAt,
      )
    )
      throw new DomainError('WORKFLOW_TASK_ALREADY_EXISTS', '任务已在该流程中');
    const siblings = [...this.memberships.values()]
      .filter(
        (row) =>
          row.ownerId === ownerId && row.stageId === stageId && !row.deletedAt && row.id !== id,
      )
      .sort(rankSort);
    if (beforeId && !siblings.some((row) => row.id === beforeId))
      throw new DomainError('VERSION_CONFLICT', '流程任务排序锚点已变化');
    if (afterId && !siblings.some((row) => row.id === afterId))
      throw new DomainError('VERSION_CONFLICT', '流程任务排序锚点已变化');
    membership.stageId = stageId;
    if (!beforeId && !afterId) membership.rank = this.nextMembershipRank(ownerId, stageId);
    else {
      const anchorId = beforeId ?? afterId;
      const index = siblings.findIndex((row) => row.id === anchorId);
      const anchor = siblings[index]!;
      const lower = beforeId
        ? (siblings[index - 1]?.rank ?? (BigInt(anchor.rank) - 1024n).toString())
        : anchor.rank;
      const upper = beforeId
        ? anchor.rank
        : (siblings[index + 1]?.rank ?? (BigInt(anchor.rank) + 1024n).toString());
      membership.rank = allocateRank([BigInt(lower), BigInt(upper)], 1).toString();
    }
    membership.version += 1;
    membership.updatedAt = this.now();
    this.record(
      ownerId,
      'workflowTaskMembership',
      id,
      membership.version,
      'upsert',
      this.membershipDto(membership),
    );
    return this.membershipDto(membership);
  }

  removeWorkflowMembership(
    ownerId: string,
    id: string,
    baseVersion: number,
  ): WorkflowTaskMembershipDto {
    const membership = this.membership(ownerId, id);
    this.assertVersion(membership.version, baseVersion, this.membershipDto(membership));
    this.tombstone(ownerId, 'workflowTaskMembership', membership, this.now());
    return this.membershipDto(membership);
  }

  snapshot(ownerId: string): V2Snapshot | Promise<V2Snapshot> {
    this.ensureOwner(ownerId);
    return {
      folders: [...this.folders.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.folderDto(row)),
      tasks: [...this.tasks.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.taskDto(row)),
      notes: [...this.notes.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.noteDto(row)),
      taskSteps: [...this.steps.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.stepDto(row)),
      timePoints: [...this.timePoints.values()]
        .filter((row) => row.ownerId === ownerId)
        .map((row) => this.timePointDto(row)),
      placements: [...this.placements.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.placementDto(row)),
      workflows: [...this.workflows.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.workflowDto(row)),
      workflowStages: [...this.stages.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.stageDto(row)),
      workflowTaskMemberships: [...this.memberships.values()]
        .filter((row) => row.ownerId === ownerId && !row.deletedAt)
        .map((row) => this.membershipDto(row)),
      archiveOperations: [...this.archiveOperations.values()]
        .filter((row) => row.ownerId === ownerId)
        .map((row) => this.archiveDto(row)),
      settings: this.settings.get(ownerId) ?? this.defaultSettings(ownerId),
      cursor: this.cursor.toString(),
    };
  }

  pull(
    ownerId: string,
    cursor: string,
    limit: number,
  ):
    | { changes: V2SyncChange[]; nextCursor: string; hasMore: boolean }
    | Promise<{
        changes: V2SyncChange[];
        nextCursor: string;
        hasMore: boolean;
      }> {
    this.ensureOwner(ownerId);
    if (!/^\d+$/.test(cursor)) throw new DomainError('VALIDATION_FAILED', 'cursor 无效');
    const requested = BigInt(cursor);
    const first = this.changes[0];
    if (first && requested < first.seq - 1n)
      throw new DomainError('SYNC_CURSOR_EXPIRED', '同步游标已超过保留窗口');
    const selected = this.changes
      .filter((change) => change.ownerId === ownerId && change.seq > requested)
      .slice(0, Math.min(limit, 500));
    const next = selected.at(-1)?.seq ?? requested;
    return {
      changes: selected,
      nextCursor: next.toString(),
      hasMore: this.changes.some((change) => change.ownerId === ownerId && change.seq > next),
    };
  }

  status(
    ownerId: string,
  ):
    | { cursor: string; oldestCursor: string; protocolVersion: 2 }
    | Promise<{ cursor: string; oldestCursor: string; protocolVersion: 2 }> {
    this.ensureOwner(ownerId);
    return {
      cursor: this.cursor.toString(),
      oldestCursor: this.changes[0]
        ? (this.changes[0].seq - 1n).toString()
        : this.cursor.toString(),
      protocolVersion: 2,
    };
  }

  async applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: V2Mutation,
  ): Promise<{ replayed: boolean; result: unknown }> {
    this.ensureOwner(ownerId);
    const key = `${ownerId}:${clientId}:${mutation.mutationId}`;
    const requestHash = hash(v2MutationIdempotencyInput(mutation));
    const existing = this.receipts.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.hash !== requestHash)
        throw new DomainError('MUTATION_REJECTED', '相同 mutationId 的内容不同');
      return { replayed: true, result: existing.result };
    }
    const result = await this.withMutation(() => this.dispatchMutation(ownerId, mutation));
    this.receipts.set(key, { hash: requestHash, result, expiresAt: Date.now() + 90 * 86_400_000 });
    return { replayed: false, result };
  }

  /**
   * Applies a v2 command to the owner-scoped projection. The PostgreSQL
   * adapter uses this protected primitive inside its database transaction so
   * the projection can be persisted from the emitted delta without relying
   * on an in-memory receipt or cursor as an authority.
   */
  protected dispatchMutation(ownerId: string, mutation: V2Mutation): unknown {
    const p = mutation.payload;
    const base = mutation.baseVersion;
    switch (mutation.command) {
      case 'folder.create':
        return this.createFolder(ownerId, {
          id: mutation.entityId,
          parentFolderId: nullableUuid(p.parentFolderId),
          title: stringValue(p.title),
        });
      case 'folder.update':
        return this.updateFolder(
          ownerId,
          mutation.entityId,
          stringValue(p.title),
          numberValue(base),
        );
      case 'folder.archiveTree':
        return this.archiveTree(
          ownerId,
          mutation.entityId,
          numberValue(base),
          optionalString(p.operationId),
        );
      case 'folder.restoreTree':
        return this.restoreTree(ownerId, mutation.entityId, stringValue(p.operationId));
      case 'folder.deleteTree':
        return this.deleteTree(ownerId, mutation.entityId, stringValue(p.confirmationToken));
      case 'tree.move':
        return this.moveTree(ownerId, {
          item: {
            kind: enumValue(isRecord(p.item) ? p.item.kind : undefined, ['FOLDER', 'TASK']),
            id: mutation.entityId,
          },
          parentFolderId: nullableUuid(p.parentFolderId),
          before:
            p.before && typeof p.before === 'object'
              ? (p.before as { kind: 'FOLDER' | 'TASK'; id: string })
              : null,
          after:
            p.after && typeof p.after === 'object'
              ? (p.after as { kind: 'FOLDER' | 'TASK'; id: string })
              : null,
          expectedStatus: enumValue(p.expectedStatus, ['TODO', 'IN_PROGRESS', 'DONE']),
          baseVersion: numberValue(base),
        });
      case 'task.create':
        return this.createTask(ownerId, {
          id: mutation.entityId,
          parentFolderId: nullableUuid(p.parentFolderId),
          title: stringValue(p.title),
        });
      case 'task.update':
        return this.updateTask(
          ownerId,
          mutation.entityId,
          {
            title: optionalString(p.title),
            status: optionalEnum(p.status, ['TODO', 'IN_PROGRESS', 'DONE']),
          },
          numberValue(base),
        );
      case 'note.update':
        return this.updateNote(
          ownerId,
          stringValue(p.taskId ?? mutation.entityId),
          stringValueAllowEmpty(p.contentMarkdown),
          numberValue(base),
        );
      case 'task.archive':
        return this.archiveTask(ownerId, mutation.entityId, numberValue(base));
      case 'task.restore':
        return this.restoreTask(ownerId, mutation.entityId, numberValue(base));
      case 'task.delete':
        return this.deleteTask(ownerId, mutation.entityId, numberValue(base));
      case 'task.duplicate':
        return this.duplicateTask(ownerId, mutation.entityId, {
          taskId: optionalString(p.taskId),
          noteId: optionalString(p.noteId),
          stepIds: Array.isArray(p.stepIds) ? stringArrayValue(p.stepIds) : undefined,
        });
      case 'taskStep.create':
        return this.createStep(ownerId, stringValue(p.taskId), {
          id: mutation.entityId,
          title: stringValue(p.title),
          noteMarkdown: typeof p.noteMarkdown === 'string' ? p.noteMarkdown : '',
        });
      case 'taskStep.update':
        return this.updateStep(
          ownerId,
          mutation.entityId,
          {
            title: optionalString(p.title),
            noteMarkdown: optionalString(p.noteMarkdown),
            status: optionalEnum(p.status, ['TODO', 'IN_PROGRESS', 'DONE']),
          },
          numberValue(base),
        );
      case 'taskStep.move':
        return this.moveStep(
          ownerId,
          mutation.entityId,
          nullableUuid(p.beforeId),
          nullableUuid(p.afterId),
          numberValue(base),
        );
      case 'taskStep.delete':
        return this.deleteStep(ownerId, mutation.entityId, numberValue(base));
      case 'timePoint.date.create':
        return this.createDate(ownerId, stringValue(p.localDate), mutation.entityId);
      case 'timePoint.event.create':
        return this.createEvent(ownerId, stringValue(p.title), mutation.entityId);
      case 'timePoint.update':
        return this.updateTimePoint(
          ownerId,
          mutation.entityId,
          stringValue(p.title),
          numberValue(base),
        );
      case 'timePoint.reach':
        return this.reachTimePoint(ownerId, mutation.entityId, numberValue(base));
      case 'timePoint.archive':
        return this.archiveTimePoint(ownerId, mutation.entityId, numberValue(base));
      case 'timePoint.restore':
        return this.restoreTimePoint(ownerId, mutation.entityId, numberValue(base));
      case 'timePoint.reorder':
        return this.reorderTimePoints(ownerId, stringArrayValue(p.ids));
      case 'placement.create':
        return this.addPlacement(
          ownerId,
          stringValue(p.taskId),
          stringValue(p.timePointId),
          mutation.entityId,
        );
      case 'placement.remove':
        return this.removePlacement(ownerId, mutation.entityId, numberValue(base));
      case 'placement.move':
        return this.movePlacement(
          ownerId,
          mutation.entityId,
          stringValue(p.timePointId),
          numberValue(base),
          optionalString(p.targetPlacementId),
        );
      case 'placement.copy':
        return this.copyPlacement(
          ownerId,
          mutation.entityId,
          stringValue(p.timePointId),
          optionalString(p.targetPlacementId),
        );
      case 'placement.reorder':
        return this.reorderPlacements(ownerId, stringValue(p.timePointId), stringArrayValue(p.ids));
      case 'rollover.create':
        return this.rollover(ownerId, stringValue(p.localDate));
      case 'rollover.undo':
        return this.undoRollover(ownerId, stringArrayValue(p.placementIds));
      case 'settings.update':
        return this.updateSettings(
          ownerId,
          {
            timezone: optionalString(p.timezone),
            weekStartsOn: p.weekStartsOn === 0 || p.weekStartsOn === 1 ? p.weekStartsOn : undefined,
            defaultCaptureTarget: optionalEnum(p.defaultCaptureTarget, ['ROOT', 'RECENT_FOLDER']),
          },
          numberValue(base),
        );
      case 'workflow.create':
        return this.createWorkflow(ownerId, {
          id: mutation.entityId,
          name: stringValue(p.name),
          defaultStageId: optionalString(p.defaultStageId),
        });
      case 'workflow.update':
        return this.updateWorkflow(
          ownerId,
          mutation.entityId,
          stringValue(p.name),
          numberValue(base),
        );
      case 'workflow.archive':
        return this.archiveWorkflow(ownerId, mutation.entityId, numberValue(base));
      case 'workflow.restore':
        return this.restoreWorkflow(ownerId, mutation.entityId, numberValue(base));
      case 'workflow.delete':
        return this.deleteWorkflow(ownerId, mutation.entityId, numberValue(base));
      case 'workflowStage.create':
        return this.createStage(ownerId, stringValue(p.workflowId), {
          id: mutation.entityId,
          name: stringValue(p.name),
        });
      case 'workflowStage.update':
        return this.updateStage(ownerId, mutation.entityId, stringValue(p.name), numberValue(base));
      case 'workflowStage.move':
        return this.moveStage(
          ownerId,
          mutation.entityId,
          nullableUuid(p.beforeId),
          nullableUuid(p.afterId),
          numberValue(base),
        );
      case 'workflowStage.delete':
        return this.deleteStage(ownerId, mutation.entityId, numberValue(base));
      case 'workflowTask.add':
        return this.addWorkflowTask(
          ownerId,
          stringValue(p.workflowId),
          stringValue(p.stageId),
          stringValue(p.taskId),
          mutation.entityId,
        );
      case 'workflowTask.move':
        return this.moveWorkflowMembership(
          ownerId,
          mutation.entityId,
          stringValue(p.stageId),
          nullableUuid(p.beforeId),
          nullableUuid(p.afterId),
          numberValue(base),
        );
      case 'workflowTask.remove':
        return this.removeWorkflowMembership(ownerId, mutation.entityId, numberValue(base));
      default:
        throw new DomainError('MUTATION_REJECTED', `不支持的 v2 mutation: ${mutation.command}`);
    }
  }

  private ensureOwner(ownerId: string): void {
    if (this.legacy) this.legacy.getUser(ownerId);
    if (this.migratedOwners.has(ownerId)) return;
    this.migratedOwners.add(ownerId);
    if (this.legacy) {
      const now = this.now();
      const legacyProjects = [...this.legacy.state.projects.values()].filter(
        (row) => row.ownerId === ownerId && !row.deletedAt,
      );
      for (const project of legacyProjects) {
        const archiveOperationId = project.archivedAt ? project.id : null;
        this.folders.set(project.id, {
          id: project.id,
          ownerId,
          parentFolderId: null,
          title: project.name,
          rank: project.rank,
          version: project.version,
          archivedAt: project.archivedAt,
          archivedByOperationId: archiveOperationId,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          deletedAt: null,
        });
        if (archiveOperationId && project.archivedAt) {
          const taskCount = [...this.legacy.state.tasks.values()].filter(
            (task) =>
              task.ownerId === ownerId &&
              task.projectId === project.id &&
              !task.deletedAt &&
              !task.archivedAt,
          ).length;
          this.archiveOperations.set(archiveOperationId, {
            id: archiveOperationId,
            ownerId,
            rootFolderId: project.id,
            rootBaseVersion: project.version,
            folderCount: 1,
            taskCount,
            createdAt: project.archivedAt,
            restoredAt: null,
          });
        }
      }
      for (const task of this.legacy.state.tasks.values()) {
        if (task.ownerId !== ownerId || task.deletedAt) continue;
        const parent = task.projectId && this.folders.has(task.projectId) ? task.projectId : null;
        const project = task.projectId ? this.legacy.state.projects.get(task.projectId) : undefined;
        this.tasks.set(task.id, {
          id: task.id,
          ownerId,
          referenceId: task.referenceId,
          parentFolderId: parent,
          title: task.title,
          status: task.status,
          rank: task.rank,
          version: task.version,
          completedAt: task.completedAt,
          archivedAt: task.archivedAt,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          deletedAt: null,
        });
        if (project?.archivedAt && !task.archivedAt) {
          (
            this.tasks.get(task.id)! as TreeTaskRecord & { archivedByOperationId?: string | null }
          ).archivedByOperationId = project.id;
        }
      }
      for (const note of this.legacy.state.notes.values()) {
        if (note.ownerId !== ownerId || note.deletedAt) continue;
        this.notes.set(note.id, { ...note });
      }
      for (const point of this.legacy.state.timePoints.values())
        if (point.ownerId === ownerId && !point.deletedAt)
          this.timePoints.set(point.id, { ...point });
      for (const placement of this.legacy.state.placements.values())
        if (placement.ownerId === ownerId && !placement.deletedAt)
          this.placements.set(placement.id, { ...placement });
      const settings = this.legacy.state.settings.get(ownerId);
      this.settings.set(ownerId, {
        ownerId,
        timezone: settings?.timezone ?? 'Asia/Shanghai',
        weekStartsOn: settings?.weekStartsOn ?? 1,
        defaultCaptureTarget:
          settings?.defaultCaptureTarget === 'RECENT_CONTEXT' ? 'RECENT_FOLDER' : 'ROOT',
        version: settings?.version ?? 1,
        updatedAt: settings?.updatedAt ?? now,
      });
      const max = [...this.tasks.values()]
        .filter((row) => row.ownerId === ownerId)
        .map((row) => /^TASK-(\d+)$/.exec(row.referenceId)?.[1])
        .filter((value): value is string => Boolean(value))
        .reduce((value, current) => Math.max(value, Number(current) + 1), 1);
      this.nextTaskNumber.set(ownerId, max);
    }
  }

  private defaultSettings(ownerId: string): V2SettingsDto {
    const settings: V2SettingsDto = {
      ownerId,
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1,
      defaultCaptureTarget: 'ROOT',
      version: 1,
      updatedAt: this.now(),
    };
    this.settings.set(ownerId, settings);
    return settings;
  }

  updateSettings(
    ownerId: string,
    patch: Partial<Pick<V2SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>>,
    baseVersion: number,
  ): V2SettingsDto {
    const current = this.settings.get(ownerId) ?? this.defaultSettings(ownerId);
    this.assertVersion(current.version, baseVersion, current);
    const timezone = patch.timezone?.trim() || current.timezone;
    if (timezone.length > 80) throw new DomainError('VALIDATION_FAILED', '时区无效');
    const next: V2SettingsDto = {
      ...current,
      timezone,
      weekStartsOn: patch.weekStartsOn ?? current.weekStartsOn,
      defaultCaptureTarget: patch.defaultCaptureTarget ?? current.defaultCaptureTarget,
      version: current.version + 1,
      updatedAt: this.now(),
    };
    this.settings.set(ownerId, next);
    this.record(ownerId, 'settings', ownerId, next.version, 'upsert', next);
    return next;
  }

  private ownerFolders(ownerId: string): FolderRecord[] {
    this.ensureOwner(ownerId);
    return [...this.folders.values()].filter((row) => row.ownerId === ownerId && !row.deletedAt);
  }
  private folder(ownerId: string, id: string): FolderRecord {
    this.ensureOwner(ownerId);
    const row = this.folders.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '文件夹不存在');
    return row;
  }
  private taskRecord(ownerId: string, id: string): TreeTaskRecord {
    this.ensureOwner(ownerId);
    const row = this.tasks.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '任务不存在');
    return row;
  }
  private step(ownerId: string, id: string): StepRecord {
    this.ensureOwner(ownerId);
    const row = this.steps.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '步骤不存在');
    return row;
  }
  private workflow(ownerId: string, id: string): WorkflowRecord {
    this.ensureOwner(ownerId);
    const row = this.workflows.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '流程不存在');
    return row;
  }
  private stage(ownerId: string, id: string): StageRecord {
    this.ensureOwner(ownerId);
    const row = this.stages.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '阶段不存在');
    return row;
  }
  private membership(ownerId: string, id: string): MembershipRecord {
    this.ensureOwner(ownerId);
    const row = this.memberships.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '流程成员不存在');
    return row;
  }
  private timePoint(ownerId: string, id: string): TimePointRecord {
    this.ensureOwner(ownerId);
    const row = this.timePoints.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '时间点不存在');
    return row;
  }
  private placement(ownerId: string, id: string): PlacementRecord {
    this.ensureOwner(ownerId);
    const row = this.placements.get(id);
    if (!row || row.ownerId !== ownerId || row.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', '安排不存在');
    return row;
  }
  private noteForTask(ownerId: string, taskId: string): NoteRecord {
    const row = [...this.notes.values()].find(
      (candidate) =>
        candidate.ownerId === ownerId && candidate.taskId === taskId && !candidate.deletedAt,
    );
    if (!row) throw new DomainError('ENTITY_NOT_FOUND', '任务备注不存在');
    return row;
  }
  private stepsForTask(ownerId: string, taskId: string): StepRecord[] {
    return [...this.steps.values()]
      .filter((row) => row.ownerId === ownerId && row.taskId === taskId && !row.deletedAt)
      .sort(rankSort);
  }
  private subtreeFolders(ownerId: string, rootId: string): FolderRecord[] {
    const all = this.ownerFolders(ownerId);
    const children = new Map<string, string[]>();
    for (const row of all)
      if (row.parentFolderId)
        children.set(row.parentFolderId, [...(children.get(row.parentFolderId) ?? []), row.id]);
    const result: FolderRecord[] = [];
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) throw new DomainError('TREE_CYCLE', '目录树存在循环');
      seen.add(id);
      const row = all.find((candidate) => candidate.id === id);
      if (!row) throw new DomainError('ENTITY_NOT_FOUND', '目录树不完整');
      result.push(row);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    return result;
  }
  private findTreeItem(
    ownerId: string,
    item: { kind: 'FOLDER' | 'TASK'; id: string },
  ): FolderRecord | TreeTaskRecord {
    return item.kind === 'FOLDER'
      ? this.folder(ownerId, item.id)
      : this.taskRecord(ownerId, item.id);
  }
  private aggregate(ownerId: string, folderId: string): FolderAggregateDto {
    return deriveFolderAggregate(
      folderId,
      this.ownerFolders(ownerId),
      [...this.tasks.values()].filter((row) => row.ownerId === ownerId),
    );
  }
  private nextSiblingRank(
    ownerId: string,
    parentFolderId: string | null,
    kind: 'FOLDER' | 'TASK',
  ): string {
    if (kind === 'FOLDER') {
      const folderValues = [...this.folders.values()]
        .filter(
          (row) =>
            row.ownerId === ownerId && !row.deletedAt && row.parentFolderId === parentFolderId,
        )
        .map((row) => BigInt(row.rank));
      return (
        folderValues.length
          ? folderValues.reduce((max, value) => (value > max ? value : max), 0n) + 1024n
          : 1024n
      ).toString();
    }
    const taskValues = [...this.tasks.values()]
      .filter(
        (row) => row.ownerId === ownerId && !row.deletedAt && row.parentFolderId === parentFolderId,
      )
      .map((row) => BigInt(row.rank));
    const folderValues = [...this.folders.values()]
      .filter(
        (row) => row.ownerId === ownerId && !row.deletedAt && row.parentFolderId === parentFolderId,
      )
      .map((row) => BigInt(row.rank));
    const minTaskBase =
      (folderValues.length ? folderValues.reduce((max, v) => (v > max ? v : max), 0n) : 0n) + 1024n;
    const maxTask = taskValues.length
      ? taskValues.reduce((max, value) => (value > max ? value : max), 0n) + 1024n
      : 0n;
    return (maxTask > minTaskBase ? maxTask : minTaskBase).toString();
  }
  private nextStepRank(ownerId: string, taskId: string): string {
    const values = this.stepsForTask(ownerId, taskId).map((row) => BigInt(row.rank));
    return (
      values.length ? values.reduce((max, value) => (value > max ? value : max), 0n) + 1024n : 1024n
    ).toString();
  }
  private nextWorkflowRank(ownerId: string): string {
    const values = [...this.workflows.values()]
      .filter((row) => row.ownerId === ownerId && !row.deletedAt)
      .map((row) => BigInt(row.rank));
    return (
      values.length ? values.reduce((max, value) => (value > max ? value : max), 0n) + 1024n : 1024n
    ).toString();
  }
  private nextStageRank(ownerId: string, workflowId: string): string {
    const values = [...this.stages.values()]
      .filter((row) => row.ownerId === ownerId && row.workflowId === workflowId && !row.deletedAt)
      .map((row) => BigInt(row.rank));
    return (
      values.length ? values.reduce((max, value) => (value > max ? value : max), 0n) + 1024n : 1024n
    ).toString();
  }
  private nextMembershipRank(ownerId: string, stageId: string): string {
    const values = [...this.memberships.values()]
      .filter((row) => row.ownerId === ownerId && row.stageId === stageId && !row.deletedAt)
      .map((row) => BigInt(row.rank));
    return (
      values.length ? values.reduce((max, value) => (value > max ? value : max), 0n) + 1024n : 1024n
    ).toString();
  }
  private createTimePoint(
    ownerId: string,
    input: { type: TimePointType; localDate?: string; title?: string; id?: string },
  ): TimePointDto {
    this.ensureOwner(ownerId);
    const id = this.entityId(input.id);
    if (this.timePoints.has(id)) throw new DomainError('MUTATION_REJECTED', '时间点 ID 已存在');
    if (input.type === 'DATE') {
      if (!input.localDate) throw new DomainError('VALIDATION_FAILED', '日期不能为空');
      validateLocalDate(input.localDate);
    }
    const title = input.title?.trim() ?? null;
    if (input.type === 'EVENT' && (!title || title.length > 200))
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    const list = [...this.timePoints.values()].filter(
      (point) => point.ownerId === ownerId && point.type === 'EVENT' && !point.deletedAt,
    );
    const now = this.now();
    const point: TimePointRecord = {
      id,
      ownerId,
      type: input.type,
      localDate: input.localDate ?? null,
      title,
      rank: (
        (list.length
          ? list
              .map((row) => BigInt(row.rank))
              .reduce((max, value) => (value > max ? value : max), 0n)
          : 0n) + 1024n
      ).toString(),
      version: 1,
      reachedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.timePoints.set(id, point);
    this.record(ownerId, 'timePoint', id, 1, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }
  private rankForMove(
    items: TreeItemDto[],
    before: { kind: 'FOLDER' | 'TASK'; id: string } | null,
    after: { kind: 'FOLDER' | 'TASK'; id: string } | null,
  ): string {
    const itemRank = (item: TreeItemDto): bigint =>
      BigInt(item.kind === 'FOLDER' ? item.folder.rank : item.task.rank);
    const itemId = (item: TreeItemDto): string =>
      item.kind === 'FOLDER' ? item.folder.id : item.task.id;
    if (!before && !after) {
      const maximum = items.length
        ? items.map(itemRank).reduce((max, value) => (value > max ? value : max), 0n)
        : 0n;
      return (maximum + 1024n).toString();
    }
    const id = before?.id ?? after?.id;
    const index = items.findIndex((item) => itemId(item) === id);
    if (index < 0) throw new DomainError('VERSION_CONFLICT', '排序锚点已变化');
    const anchor = itemRank(items[index]!);
    const lower = before
      ? items[index - 1]
        ? itemRank(items[index - 1]!)
        : anchor - 1024n
      : anchor;
    const upper = before ? anchor : items[index + 1] ? itemRank(items[index + 1]!) : anchor + 1024n;
    return allocateRank([lower, upper], 1).toString();
  }
  private rankForRecordMove(
    items: StepRecord[],
    before: string | null,
    after: string | null,
  ): string {
    const byId = new Map(items.map((row) => [row.id, row]));
    const anchorId = before ?? after;
    if (!anchorId) return this.nextStepRank(items[0]?.ownerId ?? '', items[0]?.taskId ?? '');
    const anchor = byId.get(anchorId);
    if (!anchor) throw new DomainError('VERSION_CONFLICT', '步骤锚点已变化');
    const ordered = [...items].sort(rankSort);
    const index = ordered.findIndex((row) => row.id === anchorId);
    const lower = before
      ? (ordered[index - 1]?.rank ?? (BigInt(anchor.rank) - 1024n).toString())
      : anchor.rank;
    const upper = before
      ? anchor.rank
      : (ordered[index + 1]?.rank ?? (BigInt(anchor.rank) + 1024n).toString());
    return allocateRank([BigInt(lower), BigInt(upper)], 1).toString();
  }
  private depth(ownerId: string, id: string): number {
    let depth = 0;
    let current = this.folder(ownerId, id).parentFolderId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw new DomainError('TREE_CYCLE', '目录树存在循环');
      seen.add(current);
      depth += 1;
      current = this.folder(ownerId, current).parentFolderId;
    }
    return depth;
  }
  private subtreeFingerprint(
    ...groups: Array<Array<{ id: string; version: number; deletedAt?: string | null }>>
  ): string {
    return createHash('sha256')
      .update(
        groups
          .flat()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => `${row.id}:${row.version}:${row.deletedAt ?? ''}`)
          .join('|'),
      )
      .digest('hex');
  }
  private setWorkflowArchived(
    ownerId: string,
    id: string,
    baseVersion: number,
    archived: boolean,
  ): WorkflowDto {
    const workflow = this.workflow(ownerId, id);
    this.assertVersion(workflow.version, baseVersion, this.workflowDto(workflow));
    workflow.archivedAt = archived ? this.now() : null;
    workflow.version += 1;
    workflow.updatedAt = this.now();
    this.record(ownerId, 'workflow', id, workflow.version, 'upsert', this.workflowDto(workflow));
    return this.workflowDtoWithChildren(ownerId, workflow);
  }
  private tombstone(
    ownerId: string,
    entityType: V2SyncChange['entityType'],
    row: { id: string; version: number; updatedAt: string; deletedAt?: string | null },
    now: string,
  ): void {
    row.deletedAt = now;
    row.version += 1;
    row.updatedAt = now;
    this.record(ownerId, entityType, row.id, row.version, 'delete', { ...row });
  }
  private record(
    ownerId: string,
    entityType: V2SyncChange['entityType'],
    entityId: string,
    entityVersion: number,
    operation: V2SyncChange['operation'],
    snapshot: unknown,
  ): void {
    this.cursor += 1n;
    this.changes.push({
      seq: this.cursor,
      ownerId,
      entityType,
      entityId,
      entityVersion,
      operation,
      snapshot,
      committedAt: this.now(),
    });
    for (const listener of this.changeListeners) listener(ownerId, this.cursor.toString());
  }
  private cloneState(): Record<string, unknown> {
    return structuredClone({
      folders: this.folders,
      tasks: this.tasks,
      notes: this.notes,
      steps: this.steps,
      workflows: this.workflows,
      stages: this.stages,
      memberships: this.memberships,
      archiveOperations: this.archiveOperations,
      timePoints: this.timePoints,
      placements: this.placements,
      settings: this.settings,
      changes: this.changes,
      cursor: this.cursor,
      nextTaskNumber: this.nextTaskNumber,
      receipts: this.receipts,
      deleteTokens: this.deleteTokens,
      migratedOwners: this.migratedOwners,
    });
  }
  private restoreState(snapshot: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(snapshot)) {
      const target = (this as unknown as Record<string, unknown>)[key];
      if (target instanceof Map && value instanceof Map) {
        target.clear();
        for (const [id, row] of value.entries()) target.set(id, row);
      } else if (target instanceof Set && value instanceof Set) {
        target.clear();
        for (const id of value.values()) target.add(id);
      } else if (Array.isArray(target) && Array.isArray(value)) {
        target.splice(0, target.length, ...value);
      } else if (key === 'cursor' && typeof value === 'bigint') {
        this.cursor = value;
      }
    }
  }
  private get tokenSecret(): string {
    return process.env['ACCESS_TOKEN_SECRET'] ?? 'devtodo-local-access-secret-change-me-now';
  }

  private generateDeleteToken(
    ownerId: string,
    rootFolderId: string,
    fingerprint: string,
    expiresAt: number,
  ): string {
    const payload = `${ownerId}:${rootFolderId}:${fingerprint}:${expiresAt}`;
    const sig = createHmac('sha256', this.tokenSecret).update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${sig}`;
  }

  private verifyDeleteToken(
    token: string,
    ownerId: string,
    rootFolderId: string,
  ): { ownerId: string; rootFolderId: string; fingerprint: string; expiresAt: number } | null {
    // Also check memory map first if present
    const memory = this.deleteTokens.get(token);
    if (memory) {
      if (
        memory.ownerId === ownerId &&
        memory.rootFolderId === rootFolderId &&
        memory.expiresAt > Date.now()
      ) {
        return memory;
      }
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payloadStr = Buffer.from(parts[0]!, 'base64url').toString('utf8');
    const expectedSig = createHmac('sha256', this.tokenSecret)
      .update(payloadStr)
      .digest('base64url');
    const providedSig = parts[1]!;
    if (expectedSig.length !== providedSig.length) return null;
    if (!timingSafeEqual(Buffer.from(expectedSig), Buffer.from(providedSig))) return null;

    const [tOwner, tRoot, fingerprint, expiresAtStr] = payloadStr.split(':');
    if (!tOwner || !tRoot || !fingerprint || !expiresAtStr) return null;
    const expiresAt = Number(expiresAtStr);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return null;
    if (tOwner !== ownerId || tRoot !== rootFolderId) return null;

    return {
      ownerId: tOwner,
      rootFolderId: tRoot,
      fingerprint,
      expiresAt,
    };
  }

  private entityId(value?: string): string {
    const id = value ?? uuidv7();
    if (!uuidSchema.safeParse(id).success)
      throw new DomainError('VALIDATION_FAILED', 'UUID 参数无效');
    return id;
  }
  private assertVersion(actual: number, expected: number, server: unknown): void {
    if (actual !== expected)
      throw new DomainError('VERSION_CONFLICT', '实体版本已变化', { server });
  }
  private now(): string {
    return new Date().toISOString();
  }
  private folderDto(row: FolderRecord): FolderDto {
    const {
      id,
      parentFolderId,
      title,
      rank,
      version,
      archivedAt,
      archivedByOperationId,
      deletedAt,
      createdAt,
      updatedAt,
    } = row;
    return {
      id,
      parentFolderId,
      title,
      rank,
      version,
      archivedAt,
      archivedByOperationId,
      deletedAt,
      createdAt,
      updatedAt,
    };
  }
  private taskDto(row: TreeTaskRecord): TreeTaskDto {
    const {
      id,
      referenceId,
      parentFolderId,
      title,
      status,
      rank,
      version,
      completedAt,
      archivedAt,
      archivedByOperationId,
      createdAt,
      updatedAt,
      deletedAt,
    } = row as TreeTaskRecord & { archivedByOperationId?: string | null };
    return {
      id,
      referenceId,
      parentFolderId,
      title,
      status,
      rank,
      version,
      completedAt,
      archivedAt,
      archivedByOperationId,
      deletedAt,
      createdAt,
      updatedAt,
    };
  }
  private noteDto(row: NoteRecord): NoteDto {
    const { id, taskId, contentMarkdown, version, createdAt, updatedAt, deletedAt } = row;
    return { id, taskId, contentMarkdown, version, createdAt, updatedAt, deletedAt };
  }
  private stepDto(row: StepRecord): TaskStepDto {
    const {
      id,
      taskId,
      title,
      noteMarkdown,
      status,
      rank,
      completedAt,
      version,
      createdAt,
      updatedAt,
      deletedAt,
    } = row;
    return {
      id,
      taskId,
      title,
      noteMarkdown,
      status,
      rank,
      completedAt,
      version,
      createdAt,
      updatedAt,
      deletedAt,
    };
  }
  private workflowDto(row: WorkflowRecord): WorkflowDto {
    const { id, name, rank, version, archivedAt, createdAt, updatedAt, deletedAt } = row;
    return { id, name, rank, version, archivedAt, createdAt, updatedAt, deletedAt };
  }
  private workflowDtoWithChildren(ownerId: string, row: WorkflowRecord): WorkflowDto {
    const dto = this.workflowDto(row);
    dto.stages = [...this.stages.values()]
      .filter(
        (stage) => stage.ownerId === ownerId && stage.workflowId === row.id && !stage.deletedAt,
      )
      .sort(rankSort)
      .map((stage) => {
        const memberships = [...this.memberships.values()]
          .filter(
            (membership) =>
              membership.ownerId === ownerId &&
              membership.stageId === stage.id &&
              !membership.deletedAt,
          )
          .sort(rankSort);
        const visibleMemberships = memberships.filter((membership) => {
          const task = this.tasks.get(membership.taskId);
          return task && !task.deletedAt && !task.archivedAt;
        });
        return {
          ...this.stageDto(stage),
          memberships: memberships.map((membership) => this.membershipDto(membership)),
          hiddenTaskCount: memberships.length - visibleMemberships.length,
          tasks: visibleMemberships.map((membership) =>
            this.taskDto(this.tasks.get(membership.taskId)!),
          ),
        };
      });
    return dto;
  }
  private stageDto(row: StageRecord): WorkflowStageDto {
    const { id, workflowId, name, rank, version, createdAt, updatedAt, deletedAt } = row;
    return { id, workflowId, name, rank, version, createdAt, updatedAt, deletedAt };
  }
  private membershipDto(row: MembershipRecord): WorkflowTaskMembershipDto {
    const { id, workflowId, stageId, taskId, rank, version, createdAt, updatedAt, deletedAt } = row;
    return { id, workflowId, stageId, taskId, rank, version, createdAt, updatedAt, deletedAt };
  }
  private archiveDto(row: ArchiveRecord): ArchiveOperationDto {
    const { id, rootFolderId, rootBaseVersion, folderCount, taskCount, createdAt, restoredAt } =
      row;
    return { id, rootFolderId, rootBaseVersion, folderCount, taskCount, createdAt, restoredAt };
  }
  private placementDto(row: PlacementRecord): PlacementDto {
    const { id, taskId, timePointId, rank, version, createdAt, updatedAt, deletedAt } = row;
    return { id, taskId, timePointId, rank, version, createdAt, updatedAt, deletedAt };
  }
  private timePointDto(row: TimePointRecord): TimePointDto {
    const {
      id,
      type,
      localDate,
      title,
      rank,
      version,
      reachedAt,
      archivedAt,
      deletedAt,
      createdAt,
      updatedAt,
    } = row;
    return {
      id,
      type,
      localDate,
      title,
      rank,
      version,
      reachedAt,
      archivedAt,
      createdAt,
      updatedAt,
      deletedAt,
    };
  }
}

function rankSort(a: { rank: string }, b: { rank: string }): number {
  const left = BigInt(a.rank);
  const right = BigInt(b.rank);
  return left === right ? 0 : left < right ? -1 : 1;
}
function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new DomainError('VALIDATION_FAILED', '字符串参数无效');
  return value;
}
function stringValueAllowEmpty(value: unknown): string {
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', '字符串参数无效');
  return value;
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : stringValue(value);
}
function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new DomainError('VALIDATION_FAILED', '字符串数组参数无效');
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nullableUuid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !uuidSchema.safeParse(value).success)
    throw new DomainError('VALIDATION_FAILED', 'UUID 参数无效');
  return value;
}
function numberValue(value: number | null): number {
  if (!Number.isInteger(value) || value === null || value < 1)
    throw new DomainError('VERSION_CONFLICT', '缺少有效 baseVersion');
  return value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new DomainError('VALIDATION_FAILED', '枚举值无效');
  return value as T;
}
function optionalEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return value === undefined ? undefined : enumValue(value, values);
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
