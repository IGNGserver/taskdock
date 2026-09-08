import type {
  LocalTaskDto,
  Mutation,
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TimePointDto,
} from '@devtodo/contracts';
import { uuidv7 } from '@devtodo/contracts';
import { Dexie, type Table } from 'dexie';

export interface LocalProject extends ProjectDto {
  pendingSync?: boolean;
}
export interface LocalNote extends NoteDto {
  pendingSync?: boolean;
}
export interface LocalTimePoint extends TimePointDto {
  pendingSync?: boolean;
}
export interface LocalPlacement extends PlacementDto {
  pendingSync?: boolean;
}
export interface OutboxItem {
  id?: number;
  mutationId: string;
  clientId: string;
  command: string;
  entityId: string;
  baseVersion: number | null;
  occurredAt: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  beforeImage?: LocalStateImage;
  afterImage?: LocalStateImage;
}

export type LocalImageTable =
  'projects' | 'tasks' | 'notes' | 'timePoints' | 'placements' | 'settings';

export interface LocalImageRow {
  table: LocalImageTable;
  id: string;
  value: unknown | null;
}

export interface LocalStateImage {
  rows: LocalImageRow[];
}
export interface ConflictRecord {
  id?: number;
  mutationId: string;
  /** Optional for compatibility with conflict rows written before command was persisted. */
  command?: string;
  entityType: string;
  entityId: string;
  local: unknown;
  server: unknown;
  createdAt: string;
  resolvedAt?: string;
}
export interface SyncMeta {
  key: string;
  value: string;
}

export interface DeferredChange {
  id?: number;
  seq: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  operation: string;
  snapshot: unknown;
}

export class DevTodoDatabase extends Dexie {
  projects!: Table<LocalProject, string>;
  tasks!: Table<LocalTaskDto, string>;
  notes!: Table<LocalNote, string>;
  timePoints!: Table<LocalTimePoint, string>;
  placements!: Table<LocalPlacement, string>;
  settings!: Table<SettingsDto, string>;
  outbox!: Table<OutboxItem, number>;
  conflicts!: Table<ConflictRecord, number>;
  deferredChanges!: Table<DeferredChange, number>;
  syncMeta!: Table<SyncMeta, string>;

  constructor(hubOrigin: string, ownerId: string) {
    const safeName = `devtodo:${new URL(hubOrigin).origin}:${ownerId}`.slice(0, 240);
    super(safeName);
    this.version(1).stores({
      projects: '&id, rank, archivedAt',
      tasks: '&id, [projectId+category], status, rank, referenceId, archivedAt',
      notes: '&id, taskId, updatedAt',
      timePoints: '&id, [type+localDate], type, rank, archivedAt',
      placements: '&id, [timePointId+rank], [taskId+timePointId]',
      settings: '&ownerId',
      outbox: '++id, mutationId, nextAttemptAt, clientId',
      conflicts: '++id, mutationId, entityId, createdAt',
      syncMeta: '&key',
    });
    this.version(2).stores({
      deferredChanges: '++id, seq, entityType, entityId',
    });
  }
}

export interface SyncTransport {
  push(request: {
    protocolVersion: 1;
    clientId: string;
    mutations: Mutation[];
  }): Promise<PushResult>;
  pull(cursor: string, limit: number): Promise<PullResult>;
  snapshot(): Promise<SnapshotResult>;
}

export interface PushResult {
  results: Array<{
    mutationId: string;
    status: 'applied' | 'conflict' | 'rejected';
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: unknown };
  }>;
}
export interface PullResult {
  changes: Array<{
    seq: string;
    entityType: string;
    entityId: string;
    entityVersion: number;
    operation: string;
    snapshot: unknown;
  }>;
  nextCursor: string;
  hasMore: boolean;
}
export interface SnapshotResult {
  projects: LocalProject[];
  tasks: LocalTaskDto[];
  notes: LocalNote[];
  timePoints: LocalTimePoint[];
  placements: LocalPlacement[];
  settings: SettingsDto | null;
  cursor: string;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'conflict';
export type ConflictStrategy = 'server' | 'local' | 'merged' | 'discard' | 'restore';

const MERGEABLE_CONFLICT_COMMANDS = new Set([
  'project.update',
  'task.update',
  'note.update',
  'timePoint.update',
  'settings.update',
]);

export function isMergeableConflictCommand(command: string): boolean {
  return MERGEABLE_CONFLICT_COMMANDS.has(command);
}

export class SyncEngine {
  private state: SyncState = 'idle';
  private readonly listeners = new Set<(state: SyncState) => void>();
  private syncPromise: Promise<void> | null = null;

  constructor(
    private readonly db: DevTodoDatabase,
    private readonly clientId: string,
    private readonly transport: SyncTransport,
  ) {}

  getStatus(): SyncState {
    return this.state;
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async queue(
    mutation: Omit<OutboxItem, 'id' | 'mutationId' | 'clientId' | 'attempts' | 'nextAttemptAt'>,
  ): Promise<string> {
    const mutationId = uuidv7();
    await this.db.outbox.add({
      ...mutation,
      mutationId,
      clientId: this.clientId,
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
    return mutationId;
  }

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runSync(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState('offline');
      return;
    }
    this.setState('syncing');
    try {
      await this.pushOutbox();
      await this.pullAll();
      const conflicts = (await this.db.conflicts.toArray()).filter(
        (conflict) => conflict.resolvedAt === undefined,
      ).length;
      const rejected = (await this.db.outbox.toArray()).filter(
        (item) => item.lastError && item.nextAttemptAt === Number.MAX_SAFE_INTEGER,
      ).length;
      this.setState(conflicts > 0 ? 'conflict' : rejected > 0 ? 'error' : 'idle');
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof Error && /network|fetch/i.test(error.message))
      ) {
        this.setState('offline');
      } else {
        this.setState('error');
      }
      throw error;
    }
  }

  async resolveConflict(
    conflictId: number,
    strategy: ConflictStrategy,
    merged?: unknown,
  ): Promise<void> {
    const conflict = await this.db.conflicts.get(conflictId);
    if (!conflict || conflict.resolvedAt) return;
    const server = conflictServerSnapshot(conflict.server);
    const item = await this.db.outbox.where('mutationId').equals(conflict.mutationId).first();
    if (!item || item.id === undefined) throw new Error('冲突缺少可重试的 mutation');
    if (strategy === 'restore') {
      await this.resolveArchivedConflict(conflict, item);
      return;
    }
    if (strategy !== 'server' && strategy !== 'discard') {
      if (!server || typeof server.version !== 'number' || !Number.isInteger(server.version))
        throw new Error('服务端实体已删除，请选择丢弃或重新创建');
      const baseVersion = server.version;
      const payload =
        strategy === 'merged'
          ? mergedConflictPayload(item, merged)
          : withoutBaseVersion(item.payload);
      const beforeImage = await captureLocalStateImage(
        this.db,
        item.command,
        item.entityId,
        item.payload,
      );
      await this.db.transaction(
        'rw',
        [
          this.db.projects,
          this.db.tasks,
          this.db.notes,
          this.db.timePoints,
          this.db.placements,
          this.db.settings,
          this.db.outbox,
          this.db.conflicts,
          this.db.deferredChanges,
        ],
        async () => {
          if (strategy === 'merged')
            await applyMergedOptimisticValue(this.db, item, server, payload);
          const afterImage = await captureLocalStateImage(
            this.db,
            item.command,
            item.entityId,
            payload,
          );
          const nextItem: OutboxItem = {
            ...item,
            id: undefined,
            mutationId: uuidv7(),
            baseVersion,
            occurredAt: new Date().toISOString(),
            payload,
            attempts: 0,
            nextAttemptAt: Date.now(),
            lastError: undefined,
            beforeImage,
            afterImage,
          };
          await this.db.outbox.delete(item.id!);
          await this.db.outbox.add(nextItem);
          await this.db.conflicts.update(conflictId, { resolvedAt: new Date().toISOString() });
        },
      );
      return;
    }
    const all = await this.db.outbox.orderBy('id').toArray();
    const discarded =
      strategy === 'discard' || !server
        ? !server
          ? await this.deletedConflictMutationClosure(
              conflict.entityType,
              conflict.entityId,
              item,
              all,
            )
          : conflictMutationClosure(item, all, false)
        : [item];
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.tasks,
        this.db.notes,
        this.db.timePoints,
        this.db.placements,
        this.db.settings,
        this.db.outbox,
        this.db.conflicts,
        this.db.deferredChanges,
      ],
      async () => {
        if (server) await this.putAuthoritativeConflict(conflict.entityType, server);
        else await this.deleteAuthoritativeConflict(conflict.entityType, conflict.entityId);
        for (const removed of discarded) {
          if (removed.id !== undefined) await this.db.outbox.delete(removed.id);
        }
        await this.db.conflicts.update(conflictId, { resolvedAt: new Date().toISOString() });
        await this.flushDeferredChanges();
        await this.reapplyPendingImages();
      },
    );
  }

  private async resolveArchivedConflict(conflict: ConflictRecord, item: OutboxItem): Promise<void> {
    const server = conflictServerSnapshot(conflict.server);
    if (
      !server ||
      !isArchivedConflictCommand(conflict.entityType, item.command) ||
      !server['archivedAt'] ||
      typeof server['version'] !== 'number' ||
      !Number.isInteger(server['version'])
    )
      throw new Error('当前冲突实体不支持恢复后应用');
    const originalAfterImage = item.afterImage;
    if (!originalAfterImage) throw new Error('冲突缺少本地 after-image，无法安全恢复');
    const restoreCommand = restoreCommandForEntity(conflict.entityType);
    const restoreBaseVersion = server['version'];
    const retryBaseVersion = restoreBaseVersion + 1;
    const retryPayload = withoutBaseVersion(item.payload);
    const tables = [
      this.db.projects,
      this.db.tasks,
      this.db.notes,
      this.db.timePoints,
      this.db.placements,
      this.db.settings,
      this.db.outbox,
      this.db.conflicts,
      this.db.deferredChanges,
    ];
    await this.db.transaction('rw', tables, async () => {
      await this.putAuthoritativeConflict(conflict.entityType, server);
      const restoreBeforeImage = await captureLocalStateImage(
        this.db,
        restoreCommand,
        item.entityId,
        {},
      );
      await applyRestoredOptimisticValue(this.db, conflict.entityType, item.entityId, server);
      const restoreAfterImage = await captureLocalStateImage(
        this.db,
        restoreCommand,
        item.entityId,
        {},
      );
      const retryAfterImage = rebaseStateImage(
        originalAfterImage,
        conflict.entityType,
        item.entityId,
        retryBaseVersion + 1,
      );
      const restoreItem: OutboxItem = {
        ...item,
        id: undefined,
        mutationId: uuidv7(),
        command: restoreCommand,
        baseVersion: restoreBaseVersion,
        occurredAt: new Date().toISOString(),
        payload: {},
        attempts: 0,
        nextAttemptAt: Date.now(),
        lastError: undefined,
        beforeImage: restoreBeforeImage,
        afterImage: restoreAfterImage,
      };
      const retryItem: OutboxItem = {
        ...item,
        id: undefined,
        mutationId: uuidv7(),
        baseVersion: retryBaseVersion,
        occurredAt: new Date().toISOString(),
        payload: retryPayload,
        attempts: 0,
        nextAttemptAt: Date.now(),
        lastError: undefined,
        beforeImage: restoreAfterImage,
        afterImage: retryAfterImage,
      };
      await this.db.outbox.delete(item.id!);
      await this.db.outbox.add(restoreItem);
      await this.db.outbox.add(retryItem);
      await this.db.conflicts.update(conflict.id!, { resolvedAt: new Date().toISOString() });
      await this.flushDeferredChanges();
      await this.reapplyPendingImages();
    });
  }

  async retryRejectedMutation(mutationId: string): Promise<void> {
    const item = await this.db.outbox.where('mutationId').equals(mutationId).first();
    if (!item || item.id === undefined) return;
    await this.db.outbox.update(item.id, {
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: undefined,
    });
  }

  async discardRejectedMutation(mutationId: string): Promise<void> {
    const item = await this.db.outbox.where('mutationId').equals(mutationId).first();
    if (!item || item.id === undefined) return;
    const all = await this.db.outbox.orderBy('id').toArray();
    const discarded = dependentMutationClosure(item, all);
    let snapshot: SnapshotResult | null = null;
    try {
      snapshot = await this.transport.snapshot();
    } catch {
      if (discarded.some((candidate) => !candidate.beforeImage))
        throw new Error('无法取得服务端权威状态，拒绝的 mutation 未被丢弃');
    }
    const discardedIds = new Set(discarded.map((candidate) => candidate.mutationId));
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.tasks,
        this.db.notes,
        this.db.timePoints,
        this.db.placements,
        this.db.settings,
        this.db.syncMeta,
        this.db.outbox,
        this.db.deferredChanges,
      ],
      async () => {
        if (snapshot) await replaceWithSnapshot(this.db, snapshot);
        else {
          const earliest = earliestBeforeImage(discarded);
          if (!earliest) throw new Error('拒绝的 mutation 缺少本地 before-image');
          await applyLocalStateImage(this.db, earliest);
        }
        for (const pending of all) {
          if (discardedIds.has(pending.mutationId) || !pending.afterImage) continue;
          await applyLocalStateImage(this.db, pending.afterImage);
        }
        for (const removed of discarded) await this.db.outbox.delete(removed.id!);
        if (snapshot) await this.db.syncMeta.put({ key: 'cursor', value: snapshot.cursor });
        else await this.db.syncMeta.put({ key: 'needs-full-resync', value: '1' });
        await this.flushDeferredChanges();
        await this.reapplyPendingImages();
      },
    );
  }

  private async pushOutbox(): Promise<void> {
    while (true) {
      const now = Date.now();
      const head = (await this.db.outbox.orderBy('id').first()) ?? null;
      if (head && head.nextAttemptAt > now) return;
      if (!head || head.id === undefined) return;
      const item = head;
      let response: PushResult;
      try {
        response = await this.transport.push({
          protocolVersion: 1,
          // Keep the receipt namespace stable when an app restarts before
          // localStorage can restore the current browser client ID.
          clientId: item.clientId,
          mutations: [
            {
              mutationId: item.mutationId,
              command: item.command,
              entityId: item.entityId,
              baseVersion: item.baseVersion,
              occurredAt: item.occurredAt,
              payload: item.payload,
            },
          ],
        });
      } catch (error) {
        await this.deferFailedTransport(item, error);
        throw error;
      }
      const result = response.results.find((candidate) => candidate.mutationId === item.mutationId);
      if (!result) throw new Error('同步响应缺少 mutation 结果');
      await this.db.transaction(
        'rw',
        [
          this.db.projects,
          this.db.tasks,
          this.db.notes,
          this.db.timePoints,
          this.db.placements,
          this.db.settings,
          this.db.outbox,
          this.db.conflicts,
          this.db.deferredChanges,
        ],
        async () => {
          if (result.status === 'applied') {
            await this.applyMutationResult(item, result.result);
            await this.db.outbox.delete(item.id!);
            await this.flushDeferredChanges();
            await this.reapplyPendingImages();
            return;
          }
          if (result.status === 'conflict') {
            await this.db.conflicts.add({
              mutationId: item.mutationId,
              command: item.command,
              entityType: entityTypeForCommand(item.command),
              entityId: item.entityId,
              local: item.payload,
              server: result.error?.details ?? result.result ?? null,
              createdAt: new Date().toISOString(),
            });
            await this.db.outbox.update(item.id!, {
              lastError: result.error?.code ?? 'VERSION_CONFLICT',
              nextAttemptAt: Number.MAX_SAFE_INTEGER,
            });
            return;
          }
          const attempts = item.attempts + 1;
          await this.db.outbox.update(item.id!, {
            attempts,
            nextAttemptAt: Number.MAX_SAFE_INTEGER,
            lastError: result.error?.code ?? 'MUTATION_REJECTED',
          });
        },
      );
    }
  }

  private async deferFailedTransport(item: OutboxItem, error: unknown): Promise<void> {
    if (item.id === undefined) return;
    const attempts = item.attempts + 1;
    const authenticationFailure = isAuthenticationError(error);
    await this.db.outbox.update(item.id, {
      attempts,
      nextAttemptAt: authenticationFailure
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + retryDelayMs(item.attempts),
      lastError: authenticationFailure ? 'AUTH_REQUIRED' : 'NETWORK_ERROR',
    });
  }

  private async pullAll(): Promise<void> {
    let cursor = (await this.db.syncMeta.get('cursor'))?.value ?? '0';
    let more = true;
    let resynced = false;
    while (more) {
      try {
        const batch = await this.transport.pull(cursor, 500);
        await this.applyChanges(batch.changes, batch.nextCursor);
        cursor = batch.nextCursor;
        more = batch.hasMore;
      } catch (error) {
        if (isCursorExpired(error) && !resynced) {
          await this.fullResync();
          cursor = (await this.db.syncMeta.get('cursor'))?.value ?? '0';
          await this.pushOutbox();
          resynced = true;
          more = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async fullResync(): Promise<void> {
    const snapshot = await this.transport.snapshot();
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.tasks,
        this.db.notes,
        this.db.timePoints,
        this.db.placements,
        this.db.settings,
        this.db.syncMeta,
        this.db.outbox,
        this.db.deferredChanges,
      ],
      async () => {
        const [
          pending,
          localProjects,
          localTasks,
          localNotes,
          localTimePoints,
          localPlacements,
          localSettings,
        ] = await Promise.all([
          this.db.outbox.toArray(),
          this.db.projects.toArray(),
          this.db.tasks.toArray(),
          this.db.notes.toArray(),
          this.db.timePoints.toArray(),
          this.db.placements.toArray(),
          this.db.settings.toCollection().first(),
        ]);
        const intent = pendingSyncIntent(pending, localNotes);
        const projects = mergePendingRows(snapshot.projects, localProjects, intent.projectIds);
        const tasks = mergePendingRows(snapshot.tasks, localTasks, intent.taskIds);
        const notes = mergePendingRows(snapshot.notes, localNotes, intent.noteIds);
        const timePoints = mergePendingRows(
          snapshot.timePoints,
          localTimePoints,
          intent.timePointIds,
        );
        const placements = mergePendingRows(
          snapshot.placements,
          localPlacements,
          intent.placementIds,
        ).filter((placement) => !intent.deletedPlacementIds.has(placement.id));
        const settings = intent.settings && localSettings ? localSettings : snapshot.settings;
        await Promise.all([
          this.db.projects.clear(),
          this.db.tasks.clear(),
          this.db.notes.clear(),
          this.db.timePoints.clear(),
          this.db.placements.clear(),
          this.db.settings.clear(),
          this.db.deferredChanges.clear(),
        ]);
        await this.db.projects.bulkPut(projects);
        await this.db.tasks.bulkPut(tasks);
        await this.db.notes.bulkPut(notes);
        await this.db.timePoints.bulkPut(timePoints);
        await this.db.placements.bulkPut(placements);
        if (settings) await this.db.settings.put(settings);
        await this.db.syncMeta.put({ key: 'cursor', value: snapshot.cursor });
      },
    );
  }

  private async applyChanges(changes: PullResult['changes'], nextCursor: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.tasks,
        this.db.notes,
        this.db.timePoints,
        this.db.placements,
        this.db.settings,
        this.db.syncMeta,
        this.db.outbox,
        this.db.deferredChanges,
      ],
      async () => {
        const [pending, notes] = await Promise.all([
          this.db.outbox.toArray(),
          this.db.notes.toArray(),
        ]);
        const intent = pendingSyncIntent(pending, notes);
        for (const change of changes) {
          if (protectsPendingIntent(change, intent)) {
            const previous = await this.db.deferredChanges.where('seq').equals(change.seq).first();
            if (previous?.id !== undefined)
              await this.db.deferredChanges.put({ ...change, id: previous.id });
            else await this.db.deferredChanges.add(change);
            continue;
          }
          await this.applyServerChange(change);
        }
        await this.db.syncMeta.put({ key: 'cursor', value: nextCursor });
        await this.flushDeferredChanges();
        await this.reapplyPendingImages();
      },
    );
  }

  private async applyServerChange(change: PullResult['changes'][number]): Promise<void> {
    const table = this.tableFor(change.entityType);
    const current = await table.get(change.entityId);
    const currentVersion =
      current && typeof current === 'object' && 'version' in current
        ? Number((current as { version?: unknown }).version)
        : 0;
    if (Number.isFinite(currentVersion) && currentVersion > change.entityVersion) return;
    if (change.operation === 'delete') {
      await table.delete(change.entityId);
      return;
    }
    if (!change.snapshot || !isRecord(change.snapshot)) return;
    await table.put(change.snapshot as never);
  }

  private async flushDeferredChanges(): Promise<void> {
    const [pending, notes] = await Promise.all([
      this.db.outbox.orderBy('id').toArray(),
      this.db.notes.toArray(),
    ]);
    const intent = pendingSyncIntent(pending, notes);
    const deferred = await this.db.deferredChanges.orderBy('seq').toArray();
    for (const change of deferred) {
      if (protectsPendingIntent(change, intent)) continue;
      await this.applyServerChange(change);
      if (change.id !== undefined) await this.db.deferredChanges.delete(change.id);
    }
  }

  private async reapplyPendingImages(): Promise<void> {
    const pending = await this.db.outbox.orderBy('id').toArray();
    for (const item of pending) {
      if (item.afterImage) await applyLocalStateImage(this.db, item.afterImage);
    }
  }

  private tableFor(entityType: string): Table<unknown, string> {
    switch (entityType) {
      case 'project':
        return this.db.projects as unknown as Table<unknown, string>;
      case 'task':
        return this.db.tasks as unknown as Table<unknown, string>;
      case 'note':
        return this.db.notes as unknown as Table<unknown, string>;
      case 'timePoint':
        return this.db.timePoints as unknown as Table<unknown, string>;
      case 'placement':
        return this.db.placements as unknown as Table<unknown, string>;
      case 'settings':
        return this.db.settings as unknown as Table<unknown, string>;
      default:
        throw new Error(`未知同步实体: ${entityType}`);
    }
  }

  private async applyMutationResult(item: OutboxItem, result: Record<string, unknown> | undefined) {
    if (!result) return;
    const put = async (table: Table<unknown, string>, value: unknown) => {
      if (!isRecord(value) || typeof value['id'] !== 'string') return;
      const next = { ...value };
      delete next['pendingSync'];
      await table.put(next as never);
    };
    const putMany = async (table: Table<unknown, string>, value: unknown) => {
      if (Array.isArray(value))
        await table.bulkPut(value.filter((item) => item && typeof item === 'object') as never[]);
    };
    const reconcileCreated = async (
      entityType: 'project' | 'task' | 'note' | 'timePoint' | 'placement',
      localId: unknown,
      value: unknown,
    ): Promise<Record<string, unknown> | null> => {
      if (typeof localId !== 'string' || !isRecord(value) || typeof value['id'] !== 'string')
        return null;
      await this.remapEntityId(entityType, localId, value['id']);
      return value;
    };
    switch (item.command) {
      case 'project.create': {
        const project = await reconcileCreated(
          'project',
          item.payload['__localId'] ?? item.entityId,
          result,
        );
        await put(this.db.projects as unknown as Table<unknown, string>, project);
        return;
      }
      case 'project.update':
      case 'project.archive':
      case 'project.restore':
        await put(this.db.projects as unknown as Table<unknown, string>, result);
        return;
      case 'project.reorder':
        await putMany(this.db.projects as unknown as Table<unknown, string>, result);
        return;
      case 'task.create': {
        const task = await reconcileCreated(
          'task',
          item.payload['__localId'] ?? item.entityId,
          'task' in result ? result['task'] : result,
        );
        await put(this.db.tasks as unknown as Table<unknown, string>, task);
        const note = await reconcileCreated('note', item.payload['__localNoteId'], result['note']);
        await put(this.db.notes as unknown as Table<unknown, string>, note);
        return;
      }
      case 'task.update':
      case 'task.archive':
      case 'task.restore':
        await put(this.db.tasks as unknown as Table<unknown, string>, result);
        return;
      case 'task.reorder':
        await putMany(this.db.tasks as unknown as Table<unknown, string>, result);
        return;
      case 'task.duplicate': {
        const task = await reconcileCreated('task', item.payload['__localTaskId'], result['task']);
        const note = await reconcileCreated('note', item.payload['__localNoteId'], result['note']);
        await put(this.db.tasks as unknown as Table<unknown, string>, task);
        await put(this.db.notes as unknown as Table<unknown, string>, note);
        return;
      }
      case 'note.update':
        await put(this.db.notes as unknown as Table<unknown, string>, result);
        return;
      case 'timePoint.date.create':
      case 'timePoint.event.create': {
        const point = await reconcileCreated(
          'timePoint',
          item.payload['__localId'] ?? item.entityId,
          result,
        );
        await put(this.db.timePoints as unknown as Table<unknown, string>, point);
        return;
      }
      case 'timePoint.update':
      case 'timePoint.reach':
      case 'timePoint.archive':
      case 'timePoint.restore':
        await put(this.db.timePoints as unknown as Table<unknown, string>, result);
        return;
      case 'timePoint.reorder':
        await putMany(this.db.timePoints as unknown as Table<unknown, string>, result);
        return;
      case 'settings.update':
        await put(this.db.settings as unknown as Table<unknown, string>, result);
        return;
      case 'placement.create':
      case 'placement.copy': {
        const placement = await reconcileCreated(
          'placement',
          item.payload['__localId'] ?? item.entityId,
          result['placement'],
        );
        await put(this.db.placements as unknown as Table<unknown, string>, placement);
        return;
      }
      case 'placement.move': {
        const placement = await reconcileCreated(
          'placement',
          item.payload['__localId'] ?? item.entityId,
          result['placement'],
        );
        await put(this.db.placements as unknown as Table<unknown, string>, placement);
        const sourceId = result['sourcePlacementId'];
        if (typeof sourceId === 'string') await this.db.placements.delete(sourceId);
        return;
      }
      case 'placement.remove':
        await this.db.placements.delete(item.entityId);
        return;
      case 'placement.reorder':
        await putMany(this.db.placements as unknown as Table<unknown, string>, result);
        return;
      default:
        return;
    }
  }

  private async remapEntityId(
    entityType: 'project' | 'task' | 'note' | 'timePoint' | 'placement',
    fromId: string,
    toId: string,
  ): Promise<void> {
    if (fromId === toId) return;
    const outbox = await this.db.outbox.toArray();
    for (const item of outbox) {
      if (item.id === undefined) continue;
      const payload = remapPayload(item.payload, fromId, toId);
      const entityId = item.entityId === fromId ? toId : item.entityId;
      const beforeImage = remapStateImage(item.beforeImage, fromId, toId);
      const afterImage = remapStateImage(item.afterImage, fromId, toId);
      if (
        entityId !== item.entityId ||
        payload !== item.payload ||
        beforeImage !== item.beforeImage ||
        afterImage !== item.afterImage
      )
        await this.db.outbox.update(item.id, { entityId, payload, beforeImage, afterImage });
    }
    const tableName =
      entityType === 'project'
        ? 'projects'
        : entityType === 'task'
          ? 'tasks'
          : entityType === 'note'
            ? 'notes'
            : entityType === 'timePoint'
              ? 'timePoints'
              : 'placements';
    const table = imageTable(this.db, tableName);
    const source = await table.get(fromId);
    if (source && isRecord(source)) {
      const target = await table.get(toId);
      if (!target) await table.put({ ...source, id: toId } as never);
      await table.delete(fromId);
    }
    if (entityType === 'timePoint') {
      const placements = await this.db.placements.toArray();
      for (const placement of placements) {
        if (placement.timePointId === fromId)
          await this.db.placements.put({ ...placement, timePointId: toId });
      }
    }
    if (entityType === 'project') {
      const tasks = await this.db.tasks.toArray();
      for (const task of tasks) {
        if (task.projectId === fromId) await this.db.tasks.put({ ...task, projectId: toId });
      }
    }
    if (entityType === 'task') {
      const notes = await this.db.notes.toArray();
      const placements = await this.db.placements.toArray();
      for (const note of notes)
        if (note.taskId === fromId) await this.db.notes.put({ ...note, taskId: toId });
      for (const placement of placements)
        if (placement.taskId === fromId)
          await this.db.placements.put({ ...placement, taskId: toId });
    }
  }

  private async putAuthoritativeConflict(
    entityType: string,
    server: Record<string, unknown>,
  ): Promise<void> {
    const value = { ...server };
    delete value['pendingSync'];
    await this.tableFor(entityType).put(value as never);
  }

  private async deleteAuthoritativeConflict(entityType: string, entityId: string): Promise<void> {
    switch (entityType) {
      case 'project': {
        const tasks = await this.db.tasks.where('projectId').equals(entityId).toArray();
        for (const task of tasks) await this.deleteTaskGraph(task.id);
        await this.db.projects.delete(entityId);
        return;
      }
      case 'task':
        await this.deleteTaskGraph(entityId);
        return;
      case 'note': {
        const notes = await this.db.notes.where('taskId').equals(entityId).toArray();
        for (const note of notes) await this.db.notes.delete(note.id);
        await this.db.notes.delete(entityId);
        return;
      }
      case 'timePoint': {
        const placements = await this.db.placements.where('timePointId').equals(entityId).toArray();
        for (const placement of placements) await this.db.placements.delete(placement.id);
        await this.db.timePoints.delete(entityId);
        return;
      }
      case 'placement':
        await this.db.placements.delete(entityId);
        return;
      case 'settings':
        await this.db.settings.delete(entityId);
        return;
      default:
        throw new Error(`未知同步实体: ${entityType}`);
    }
  }

  private async deleteTaskGraph(taskId: string): Promise<void> {
    const [notes, placements] = await Promise.all([
      this.db.notes.where('taskId').equals(taskId).toArray(),
      this.db.placements.where('taskId').equals(taskId).toArray(),
    ]);
    for (const note of notes) await this.db.notes.delete(note.id);
    for (const placement of placements) await this.db.placements.delete(placement.id);
    await this.db.tasks.delete(taskId);
  }

  private async deletedConflictMutationClosure(
    entityType: string,
    entityId: string,
    root: OutboxItem,
    items: OutboxItem[],
  ): Promise<OutboxItem[]> {
    const graphIds = await this.deletedConflictGraphIds(entityType, entityId);
    return conflictMutationClosure(root, items, true, graphIds, entityType);
  }

  private async deletedConflictGraphIds(
    entityType: string,
    entityId: string,
  ): Promise<Set<string>> {
    const graphIds = new Set<string>([entityId]);
    if (entityType === 'project') {
      const tasks = await this.db.tasks.where('projectId').equals(entityId).toArray();
      const taskIds = tasks.map((task) => task.id);
      taskIds.forEach((id) => graphIds.add(id));
      const [notes, placements] = await Promise.all([
        this.db.notes.toArray(),
        this.db.placements.toArray(),
      ]);
      notes
        .filter((note) => taskIds.includes(note.taskId))
        .forEach((note) => graphIds.add(note.id));
      placements
        .filter((placement) => taskIds.includes(placement.taskId))
        .forEach((placement) => graphIds.add(placement.id));
    } else if (entityType === 'task') {
      const [notes, placements] = await Promise.all([
        this.db.notes.where('taskId').equals(entityId).toArray(),
        this.db.placements.where('taskId').equals(entityId).toArray(),
      ]);
      notes.forEach((note) => graphIds.add(note.id));
      placements.forEach((placement) => graphIds.add(placement.id));
    } else if (entityType === 'note') {
      const notes = await this.db.notes.where('taskId').equals(entityId).toArray();
      notes.forEach((note) => graphIds.add(note.id));
      graphIds.delete(entityId);
    } else if (entityType === 'timePoint') {
      const placements = await this.db.placements.where('timePointId').equals(entityId).toArray();
      placements.forEach((placement) => graphIds.add(placement.id));
    }
    return graphIds;
  }

  private setState(next: SyncState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

export async function captureLocalStateImage(
  db: DevTodoDatabase,
  command: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<LocalStateImage> {
  const keys = await mutationImageKeys(db, command, entityId, payload);
  const rows: LocalImageRow[] = [];
  for (const key of keys) {
    const table = imageTable(db, key.table);
    const value = await table.get(key.id);
    rows.push({ table: key.table, id: key.id, value: value ?? null });
  }
  return { rows };
}

export async function applyLocalStateImage(
  db: DevTodoDatabase,
  image: LocalStateImage,
): Promise<void> {
  for (const row of image.rows) {
    const table = imageTable(db, row.table);
    if (row.value === null) await table.delete(row.id);
    else await table.put(row.value as never);
  }
}

interface ImageKey {
  table: LocalImageTable;
  id: string;
}

async function mutationImageKeys(
  db: DevTodoDatabase,
  command: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<ImageKey[]> {
  const keys: ImageKey[] = [];
  const seen = new Set<string>();
  const add = (table: LocalImageTable, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    const key = `${table}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ table, id });
  };
  const addIds = (table: LocalImageTable) => {
    if (Array.isArray(payload['ids'])) for (const id of payload['ids']) add(table, id);
  };
  if (command.startsWith('project.')) {
    add(command === 'project.reorder' ? 'projects' : 'projects', entityId);
    if (command === 'project.reorder') addIds('projects');
  } else if (command.startsWith('task.')) {
    if (command === 'task.reorder') addIds('tasks');
    else add('tasks', entityId);
    add('tasks', payload['__localTaskId']);
    add('notes', payload['__localNoteId']);
  } else if (command === 'note.update') {
    const note = await db.notes.where('taskId').equals(entityId).first();
    add('notes', note?.id);
  } else if (command.startsWith('timePoint.')) {
    if (command === 'timePoint.reorder') addIds('timePoints');
    else add('timePoints', entityId);
  } else if (command.startsWith('placement.')) {
    if (command === 'placement.reorder') addIds('placements');
    else {
      add('placements', entityId);
      add('placements', payload['__localId']);
    }
  } else if (command === 'settings.update') {
    const settings = await db.settings.toCollection().first();
    add('settings', settings?.ownerId);
  }
  return keys;
}

function imageTable(db: DevTodoDatabase, table: LocalImageTable): Table<unknown, string> {
  switch (table) {
    case 'projects':
      return db.projects as unknown as Table<unknown, string>;
    case 'tasks':
      return db.tasks as unknown as Table<unknown, string>;
    case 'notes':
      return db.notes as unknown as Table<unknown, string>;
    case 'timePoints':
      return db.timePoints as unknown as Table<unknown, string>;
    case 'placements':
      return db.placements as unknown as Table<unknown, string>;
    case 'settings':
      return db.settings as unknown as Table<unknown, string>;
  }
}

function withoutBaseVersion(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload };
  delete next['baseVersion'];
  return next;
}

function mergedConflictPayload(item: OutboxItem, merged: unknown): Record<string, unknown> {
  if (item.command === 'note.update') {
    if (typeof merged !== 'string') throw new Error('合并后的备注内容无效');
    return { contentMarkdown: merged };
  }
  if (!isRecord(merged)) throw new Error('合并后的实体内容无效');
  return { ...merged };
}

async function applyMergedOptimisticValue(
  db: DevTodoDatabase,
  item: OutboxItem,
  server: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const version = Number(server['version']);
  if (!Number.isInteger(version)) throw new Error('冲突服务端版本无效');
  if (item.command === 'note.update') {
    const note = await db.notes.where('taskId').equals(item.entityId).first();
    if (!note) throw new Error('本地备注不存在');
    await db.notes.put({
      ...note,
      contentMarkdown: String(payload['contentMarkdown'] ?? ''),
      version: version + 1,
      updatedAt: now,
      pendingSync: true,
    });
    return;
  }
  if (item.command === 'task.update') {
    const current = await db.tasks.get(item.entityId);
    if (!current) throw new Error('本地任务不存在');
    await db.tasks.put({
      ...current,
      ...(typeof payload['title'] === 'string' ? { title: payload['title'] } : {}),
      ...(payload['projectId'] === null || typeof payload['projectId'] === 'string'
        ? { projectId: payload['projectId'] as string | null }
        : {}),
      ...(typeof payload['category'] === 'string'
        ? { category: payload['category'] as LocalTaskDto['category'] }
        : {}),
      ...(typeof payload['status'] === 'string'
        ? { status: payload['status'] as LocalTaskDto['status'] }
        : {}),
      ...(typeof payload['priority'] === 'string'
        ? { priority: payload['priority'] as LocalTaskDto['priority'] }
        : {}),
      ...(typeof payload['rank'] === 'string' ? { rank: payload['rank'] } : {}),
      version: version + 1,
      updatedAt: now,
      pendingSync: true,
    });
    return;
  }
  if (item.command === 'project.update') {
    const current = await db.projects.get(item.entityId);
    if (!current) throw new Error('本地项目不存在');
    await db.projects.put({
      ...current,
      ...(typeof payload['name'] === 'string' ? { name: payload['name'] } : {}),
      ...(typeof payload['taskPrefix'] === 'string' ? { taskPrefix: payload['taskPrefix'] } : {}),
      version: version + 1,
      updatedAt: now,
      pendingSync: true,
    });
    return;
  }
  if (item.command === 'timePoint.update') {
    const current = await db.timePoints.get(item.entityId);
    if (!current) throw new Error('本地时间点不存在');
    await db.timePoints.put({
      ...current,
      ...(typeof payload['title'] === 'string' ? { title: payload['title'] } : {}),
      version: version + 1,
      updatedAt: now,
      pendingSync: true,
    });
    return;
  }
  if (item.command === 'settings.update') {
    const current = await db.settings.get(item.entityId);
    if (!current) throw new Error('本地设置不存在');
    await db.settings.put({
      ...current,
      ...(typeof payload['timezone'] === 'string' ? { timezone: payload['timezone'] } : {}),
      ...(payload['weekStartsOn'] === 0 || payload['weekStartsOn'] === 1
        ? { weekStartsOn: payload['weekStartsOn'] }
        : {}),
      ...(payload['defaultCaptureTarget'] === 'GLOBAL_MISC' ||
      payload['defaultCaptureTarget'] === 'RECENT_CONTEXT'
        ? { defaultCaptureTarget: payload['defaultCaptureTarget'] }
        : {}),
      version: version + 1,
      updatedAt: now,
    });
    return;
  }
  throw new Error('当前冲突类型不支持合并编辑');
}

function entityTypeForCommand(command: string): string {
  if (command.startsWith('timePoint.')) return 'timePoint';
  if (command.startsWith('project.')) return 'project';
  if (command.startsWith('task.')) return 'task';
  if (command.startsWith('placement.')) return 'placement';
  if (command.startsWith('note.')) return 'note';
  if (command.startsWith('settings.')) return 'settings';
  return command.split('.')[0] ?? 'unknown';
}

function dependentMutationClosure(root: OutboxItem, items: OutboxItem[]): OutboxItem[] {
  return conflictMutationClosure(root, items, false);
}

function conflictMutationClosure(
  root: OutboxItem,
  items: OutboxItem[],
  includeEntityDependents: boolean,
  extraDependencyIds: Iterable<string> = [],
  rootEntityType?: string,
): OutboxItem[] {
  const discarded = new Map<string, OutboxItem>([[root.mutationId, root]]);
  const dependencyIds = new Set([
    ...(includeEntityDependents && rootEntityType !== 'note' ? [root.entityId] : []),
    ...createdIds(root),
    ...extraDependencyIds,
  ]);
  for (const candidate of items) {
    if (candidate.mutationId === root.mutationId || !candidate.id || !root.id) continue;
    if (candidate.id <= root.id) continue;
    const referencesDependency = [...dependencyIds].some((id) => mutationReferences(candidate, id));
    const isSameDeletedNote =
      includeEntityDependents &&
      rootEntityType === 'note' &&
      candidate.command === 'note.update' &&
      candidate.entityId === root.entityId;
    if (!referencesDependency && !isSameDeletedNote) continue;
    discarded.set(candidate.mutationId, candidate);
    for (const id of createdIds(candidate)) dependencyIds.add(id);
  }
  return items.filter((candidate) => discarded.has(candidate.mutationId));
}

function createdIds(item: OutboxItem): string[] {
  if (
    item.command === 'project.create' ||
    item.command === 'task.create' ||
    item.command === 'timePoint.date.create' ||
    item.command === 'timePoint.event.create' ||
    item.command === 'placement.create' ||
    item.command === 'placement.copy' ||
    item.command === 'placement.move'
  )
    return [
      item.entityId,
      ...['__localId', '__localTaskId', '__localNoteId']
        .map((key) => item.payload[key])
        .filter((value): value is string => typeof value === 'string'),
    ];
  if (item.command === 'task.duplicate')
    return ['__localTaskId', '__localNoteId']
      .map((key) => item.payload[key])
      .filter((value): value is string => typeof value === 'string');
  return [];
}

function mutationReferences(item: OutboxItem, id: string): boolean {
  if (item.entityId === id) return true;
  if (Object.values(item.payload).some((value) => valueReferencesId(value, id))) return true;
  return [...(item.beforeImage?.rows ?? []), ...(item.afterImage?.rows ?? [])].some((row) => {
    const value = row.value;
    return (
      row.id === id ||
      (isRecord(value) &&
        ['id', 'ownerId', 'projectId', 'taskId', 'timePointId'].some(
          (field) => value[field] === id,
        ))
    );
  });
}

function valueReferencesId(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((candidate) => valueReferencesId(candidate, id));
  if (isRecord(value))
    return Object.values(value).some((candidate) => valueReferencesId(candidate, id));
  return false;
}

function earliestBeforeImage(items: OutboxItem[]): LocalStateImage | null {
  const rows = new Map<string, LocalImageRow>();
  for (const item of items) {
    for (const row of item.beforeImage?.rows ?? []) {
      const key = `${row.table}:${row.id}`;
      if (!rows.has(key)) rows.set(key, row);
    }
  }
  return rows.size ? { rows: [...rows.values()] } : null;
}

async function replaceWithSnapshot(db: DevTodoDatabase, snapshot: SnapshotResult): Promise<void> {
  await Promise.all([
    db.projects.clear(),
    db.tasks.clear(),
    db.notes.clear(),
    db.timePoints.clear(),
    db.placements.clear(),
    db.settings.clear(),
    db.deferredChanges.clear(),
  ]);
  await Promise.all([
    db.projects.bulkPut(snapshot.projects),
    db.tasks.bulkPut(snapshot.tasks),
    db.notes.bulkPut(snapshot.notes),
    db.timePoints.bulkPut(snapshot.timePoints),
    db.placements.bulkPut(snapshot.placements),
    snapshot.settings ? db.settings.put(snapshot.settings) : Promise.resolve(),
  ]);
}

export function createBrowserSyncId(): string {
  const key = 'devtodo.client-id';
  try {
    const existing = globalThis.localStorage?.getItem(key);
    if (existing) return existing;
    const created = uuidv7();
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    // IndexedDB remains usable when a private WebView blocks localStorage.
    return uuidv7();
  }
}

function conflictServerSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if ('server' in value) {
    const server = value['server'];
    return isRecord(server) ? server : null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArchivedConflictCommand(entityType: string, command: string): boolean {
  return (
    (entityType === 'project' &&
      ['project.update', 'project.archive', 'project.restore'].includes(command)) ||
    (entityType === 'task' && ['task.update', 'task.archive', 'task.restore'].includes(command)) ||
    (entityType === 'timePoint' &&
      ['timePoint.update', 'timePoint.reach', 'timePoint.archive', 'timePoint.restore'].includes(
        command,
      ))
  );
}

function restoreCommandForEntity(entityType: string): string {
  if (entityType === 'project') return 'project.restore';
  if (entityType === 'task') return 'task.restore';
  if (entityType === 'timePoint') return 'timePoint.restore';
  throw new Error('当前冲突实体不支持恢复');
}

async function applyRestoredOptimisticValue(
  db: DevTodoDatabase,
  entityType: string,
  entityId: string,
  server: Record<string, unknown>,
): Promise<void> {
  const tableName = imageTableName(entityType);
  const table = imageTable(db, tableName);
  const current = await table.get(entityId);
  if (!isRecord(current)) throw new Error('服务端归档实体不在本地缓存中');
  await table.put({
    ...current,
    archivedAt: null,
    version: Number(server['version']) + 1,
    updatedAt: new Date().toISOString(),
    pendingSync: true,
  } as never);
}

function rebaseStateImage(
  image: LocalStateImage,
  entityType: string,
  entityId: string,
  version: number,
): LocalStateImage {
  const tableName = imageTableName(entityType);
  return {
    rows: image.rows.map((row) => {
      if (row.table !== tableName || row.id !== entityId || !isRecord(row.value)) return row;
      return {
        ...row,
        value: { ...row.value, version, pendingSync: true },
      };
    }),
  };
}

function imageTableName(entityType: string): LocalImageTable {
  if (entityType === 'project') return 'projects';
  if (entityType === 'task') return 'tasks';
  if (entityType === 'timePoint') return 'timePoints';
  throw new Error('当前冲突实体不支持恢复');
}

interface PendingSyncIntent {
  projectIds: Set<string>;
  taskIds: Set<string>;
  noteIds: Set<string>;
  timePointIds: Set<string>;
  placementIds: Set<string>;
  deletedPlacementIds: Set<string>;
  settings: boolean;
}

function pendingSyncIntent(items: OutboxItem[], notes: LocalNote[]): PendingSyncIntent {
  const intent: PendingSyncIntent = {
    projectIds: new Set(),
    taskIds: new Set(),
    noteIds: new Set(),
    timePointIds: new Set(),
    placementIds: new Set(),
    deletedPlacementIds: new Set(),
    settings: false,
  };
  const noteIdByTaskId = new Map(notes.map((note) => [note.taskId, note.id]));
  for (const item of items) {
    const ids = Array.isArray(item.payload['ids'])
      ? item.payload['ids'].filter((value): value is string => typeof value === 'string')
      : [];
    switch (item.command) {
      case 'project.create':
      case 'project.update':
      case 'project.archive':
      case 'project.restore':
        intent.projectIds.add(item.entityId);
        break;
      case 'project.reorder':
        ids.forEach((id) => intent.projectIds.add(id));
        break;
      case 'task.update':
      case 'task.archive':
      case 'task.restore':
        intent.taskIds.add(item.entityId);
        break;
      case 'task.create':
        intent.taskIds.add(item.entityId);
        if (typeof item.payload['__localNoteId'] === 'string')
          intent.noteIds.add(item.payload['__localNoteId']);
        break;
      case 'task.duplicate':
        if (typeof item.payload['__localTaskId'] === 'string')
          intent.taskIds.add(item.payload['__localTaskId']);
        if (typeof item.payload['__localNoteId'] === 'string')
          intent.noteIds.add(item.payload['__localNoteId']);
        break;
      case 'task.reorder':
        ids.forEach((id) => intent.taskIds.add(id));
        break;
      case 'note.update': {
        const noteId = noteIdByTaskId.get(item.entityId);
        if (noteId) intent.noteIds.add(noteId);
        break;
      }
      case 'timePoint.date.create':
      case 'timePoint.event.create':
      case 'timePoint.update':
      case 'timePoint.reach':
      case 'timePoint.archive':
      case 'timePoint.restore':
        intent.timePointIds.add(item.entityId);
        break;
      case 'timePoint.reorder':
        ids.forEach((id) => intent.timePointIds.add(id));
        break;
      case 'placement.create':
      case 'placement.copy':
        intent.placementIds.add(
          typeof item.payload['__localId'] === 'string' ? item.payload['__localId'] : item.entityId,
        );
        break;
      case 'placement.move':
        intent.deletedPlacementIds.add(item.entityId);
        if (typeof item.payload['__localId'] === 'string')
          intent.placementIds.add(item.payload['__localId']);
        break;
      case 'placement.remove':
        intent.deletedPlacementIds.add(item.entityId);
        break;
      case 'placement.reorder':
        ids.forEach((id) => intent.placementIds.add(id));
        break;
      case 'settings.update':
        intent.settings = true;
        break;
      default:
        break;
    }
  }
  return intent;
}

function protectsPendingIntent(
  change: PullResult['changes'][number],
  intent: PendingSyncIntent,
): boolean {
  const ids =
    change.entityType === 'project'
      ? intent.projectIds
      : change.entityType === 'task'
        ? intent.taskIds
        : change.entityType === 'note'
          ? intent.noteIds
          : change.entityType === 'timePoint'
            ? intent.timePointIds
            : change.entityType === 'placement'
              ? intent.placementIds
              : null;
  if (ids?.has(change.entityId)) return true;
  if (change.entityType === 'placement' && intent.deletedPlacementIds.has(change.entityId))
    return true;
  return change.entityType === 'settings' && intent.settings;
}

function mergePendingRows<T extends { id: string }>(
  serverRows: T[],
  localRows: T[],
  pendingIds: Set<string>,
): T[] {
  const rows = new Map(serverRows.map((row) => [row.id, row]));
  for (const row of localRows) {
    const pending = 'pendingSync' in row && row.pendingSync === true;
    if (pending || pendingIds.has(row.id)) rows.set(row.id, row);
  }
  return [...rows.values()];
}

function remapPayload(
  payload: Record<string, unknown>,
  fromId: string,
  toId: string,
): Record<string, unknown> {
  const remapped = remapNestedValue(payload, fromId, toId);
  return isRecord(remapped.value) && remapped.changed ? remapped.value : payload;
}

function remapStateImage(
  image: LocalStateImage | undefined,
  fromId: string,
  toId: string,
): LocalStateImage | undefined {
  if (!image) return undefined;
  let changed = false;
  const rows = image.rows.map((row) => {
    let rowChanged = row.id === fromId;
    const remapped = remapNestedValue(row.value, fromId, toId);
    rowChanged ||= remapped.changed;
    if (!rowChanged) return row;
    changed = true;
    return {
      ...row,
      id: row.id === fromId ? toId : row.id,
      value: remapped.value,
    };
  });
  return changed ? { rows } : image;
}

function remapNestedValue(
  value: unknown,
  fromId: string,
  toId: string,
): { value: unknown; changed: boolean } {
  if (value === fromId) return { value: toId, changed: true };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const remapped = remapNestedValue(item, fromId, toId);
      changed ||= remapped.changed;
      return remapped.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const remapped = remapNestedValue(item, fromId, toId);
    changed ||= remapped.changed;
    next[key] = remapped.value;
  }
  return { value: changed ? next : value, changed };
}

function isCursorExpired(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error['code'] === 'SYNC_CURSOR_EXPIRED') ||
    (error instanceof Error && error.message.includes('SYNC_CURSOR_EXPIRED'))
  );
}

function isAuthenticationError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error['status'] === 401 || error['code'] === 'AUTH_REQUIRED';
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 8);
  const base = Math.min(5 * 60_000, 1_000 * 2 ** exponent);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
