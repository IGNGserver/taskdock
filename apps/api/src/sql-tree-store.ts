import type { V2Mutation } from '@devtodo/contracts';
import { DomainError } from '@devtodo/domain';
import type { CacheStore } from './cache.js';
import { OWNER_SNAPSHOT_QUERY } from './sql-statements.js';
import type { SqlStore } from './sql-store.js';
import { v2SqlDto } from './v2-sql-dto.js';
import {
  MemoryTreeStore,
  type V2MutationBatchResult,
  type V2Snapshot,
  type V2SyncChange,
  type V2TreeStore,
  v2MutationIdempotencyInput,
} from './tree-store.js';

/**
 * SQL persistence adapter for the shared v2 domain implementation. The
 * domain operates on one owner-scoped projection, while every flush happens
 * inside PostgresStore's existing transaction and change-feed boundary.
 */
export class SqlTreeStore extends MemoryTreeStore implements V2TreeStore {
  /**
   * The projection is a read cache, not the sync authority. Keep the owner's
   * latest change sequence alongside it so writes on another API instance,
   * including legacy v1 writes, invalidate the cache with one cheap query.
   */
  private readonly loaded = new Map<string, string>();

  constructor(
    readonly sql: SqlStore,
    private readonly cache?: CacheStore,
  ) {
    super();
  }

  /** Dialect of the backing store; a test double without one means Postgres. */
  private get dialect(): 'postgres' | 'mysql' {
    return this.sql.dialect === 'mysql' ? 'mysql' : 'postgres';
  }

  override async prepare(ownerId?: string): Promise<void> {
    if (!ownerId) return;
    // Warm-cache validation is one round trip. The full load below runs inside
    // a repeatable-read transaction so all tables come from the same snapshot.
    const current = await this.sql.v2Query(
      `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL) AS owner_ok,
              (SELECT next_task_number FROM users WHERE id = $1 AND disabled_at IS NULL) AS next_task_number,
              (SELECT COALESCE(MAX(seq), 0)::text FROM sync_changes WHERE owner_id = $1) AS cursor`,
      [ownerId],
    );
    const currentRow = current.rows[0];
    if (!currentRow || !truthy(currentRow['owner_ok'])) throw new Error('Owner is not available');
    // next_task_number only moves forward. A read racing a commit must not
    // overwrite a newer value with the pre-commit snapshot.
    const databaseNextTaskNumber = Number(currentRow['next_task_number']);
    if (databaseNextTaskNumber > this.getNextTaskNumber(ownerId))
      this.setNextTaskNumber(ownerId, databaseNextTaskNumber);
    const currentCursor = String(currentRow['cursor'] ?? '0');
    const previous = this.loaded.get(ownerId);
    if (previous === currentCursor) return;

    // A cold replica can hydrate from Redis when the cached cursor matches the
    // authoritative cursor. If Redis is stale or unavailable, fall through to
    // the database; the cache is never an authority.
    if (await this.hydrateFromCache(ownerId, currentCursor)) return;

    // A replica usually only needs the handful of rows another replica wrote.
    // Fall back to a full load when the feed has gaps, legacy v1 changes, or
    // an unexpectedly large burst.
    if (previous !== undefined) {
      const applied = await this.applyDelta(ownerId, previous);
      // The validation query and delta query are separate round trips. If feed
      // retention or a concurrent change makes the delta end before the cursor
      // we just observed, the hot projection is incomplete and must not be
      // published as caught up.
      if (applied !== undefined && BigInt(applied) >= BigInt(currentCursor)) {
        this.loaded.set(ownerId, applied);
        this.writeCache(ownerId, applied);
        return;
      }
    }

    await this.sql.v2ReadSnapshot(async () => {
      const snapshot = await this.loadOwnerSnapshot(ownerId);
      this.loadOwnerState(ownerId, snapshot.state);
      this.loaded.set(ownerId, snapshot.cursor);
      this.writeCache(ownerId, snapshot.cursor);
    });
  }

  private async hydrateFromCache(ownerId: string, cursor: string): Promise<boolean> {
    if (!this.cache?.enabled || this.cache.snapshotTtlSeconds <= 0) return false;
    const raw = await this.cache.get(`tree:${ownerId}`);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as { cursor?: unknown; state?: unknown };
      if (String(parsed.cursor) !== cursor) return false;
      if (!parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state))
        return false;
      this.loadOwnerState(ownerId, parsed.state as Record<string, unknown>);
      this.loaded.set(ownerId, cursor);
      return true;
    } catch {
      return false;
    }
  }

  private writeCache(ownerId: string, cursor: string): void {
    if (!this.cache?.enabled || this.cache.snapshotTtlSeconds <= 0) return;
    try {
      const state = this.dumpOwnerState(ownerId);
      void this.cache.set(
        `tree:${ownerId}`,
        JSON.stringify({ cursor, state }),
        this.cache.snapshotTtlSeconds,
      );
    } catch {
      /* Cache writes are best-effort and never affect the projection. */
    }
  }

  private invalidateCache(ownerId: string): void {
    if (this.cache?.enabled) void this.cache.del(`tree:${ownerId}`);
  }

  private async applyDelta(ownerId: string, previousCursor: string): Promise<string | undefined> {
    const result = await this.sql.v2Query(
      `SELECT seq::text, protocol_version, entity_type, operation, snapshot
       FROM sync_changes
       WHERE owner_id = $1 AND seq > $2
       ORDER BY seq
       LIMIT 201`,
      [ownerId, previousCursor],
    );
    if (!result.rows.length || result.rows.length > 200) return undefined;
    for (const row of result.rows) {
      if (Number(row['protocol_version']) !== 2) return undefined;
      const snapshot = row['snapshot'];
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
      if (
        row['entity_type'] !== 'settings' &&
        typeof (snapshot as Record<string, unknown>)['id'] !== 'string'
      )
        return undefined;
    }
    for (const row of result.rows) {
      if (
        !this.applySyncChange(
          ownerId,
          row['entity_type'] as V2SyncChange['entityType'],
          row['snapshot'],
        )
      )
        return undefined;
    }
    return String(result.rows.at(-1)!['seq']);
  }

  /**
   * Load every owner collection in one statement. The previous implementation
   * issued 11 sequential SELECTs after the cache check; on a 50-80ms RTT link
   * that alone added almost a second to every cold request.
   */
  private async loadOwnerSnapshot(
    ownerId: string,
  ): Promise<{ state: Record<string, unknown>; cursor: string }> {
    const result = await this.sql.v2Query(OWNER_SNAPSHOT_QUERY[this.dialect], [ownerId]);
    const row = result.rows[0];
    if (!row || row['next_task_number'] === null || row['next_task_number'] === undefined)
      throw new Error('Owner is not available');
    const collections = [
      ['folders', 'folders'],
      ['tasks', 'tasks'],
      ['notes', 'notes'],
      ['steps', 'steps'],
      ['workflows', 'workflows'],
      ['stages', 'stages'],
      ['memberships', 'memberships'],
      ['time_points', 'timePoints'],
      ['placements', 'placements'],
    ] as const;
    const state: Record<string, unknown> = {};
    for (const [source, key] of collections) {
      const value = row[source];
      const mapped = Array.isArray(value)
        ? value.map((item) => {
            const dto = v2SqlDto(item as Record<string, unknown>);
            if (key === 'folders' && !dto['status']) dto['status'] = 'TODO';
            return dto;
          })
        : [];
      // JSON_ARRAYAGG does not preserve the derived table's ORDER BY.
      if (this.dialect === 'mysql')
        mapped.sort((left, right) => String(left['id']).localeCompare(String(right['id'])));
      state[key] = mapped;
    }
    state['settings'] = row['settings']
      ? v2SqlDto(row['settings'] as Record<string, unknown>)
      : undefined;
    state['nextTaskNumber'] = Number(row['next_task_number']);
    return { state, cursor: String(row['cursor'] ?? '0') };
  }

  override async applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: V2Mutation,
  ): Promise<{ replayed: boolean; result: unknown }> {
    if (mutation.command === 'task.update' || mutation.command === 'note.update') {
      return this.applyFocusedMutation(ownerId, clientId, mutation);
    }
    let committedCursor: string | undefined;
    let changes: V2SyncChange[] = [];
    let nextTaskNumber: number | undefined;
    // Mutate a private draft, persist its delta, and only publish it to the
    // shared read projection after COMMIT. Readers therefore never observe an
    // uncommitted mutation, and a COMMIT failure leaves the projection intact
    // without a full-state rollback clone.
    const response = await super.withOwnerMutationLock(ownerId, () =>
      this.sql.withMutation(() =>
        this.sql.withIdempotency(
          ownerId,
          clientId,
          mutation.mutationId,
          v2MutationIdempotencyInput(mutation),
          async () => {
            await this.sql.v2LockOwner(ownerId);
            await this.prepare(ownerId);
            const draft = new MemoryTreeStore();
            draft.loadOwnerState(ownerId, this.dumpOwnerState(ownerId));
            const result = draft.applyMutationForPersistence(ownerId, mutation);
            changes = draft.changesFrom(0);
            nextTaskNumber = draft.getNextTaskNumber(ownerId);
            await this.persistChanges(ownerId, changes);
            committedCursor = await this.sql.appendV2Changes(ownerId, changes);
            return result;
          },
        ),
      ),
    );
    if (nextTaskNumber !== undefined) this.setNextTaskNumber(ownerId, nextTaskNumber);
    if (committedCursor) {
      let published = true;
      for (const change of changes) {
        if (!this.applySyncChange(ownerId, change.entityType, change.snapshot)) {
          published = false;
          break;
        }
      }
      if (published) this.loaded.set(ownerId, committedCursor);
      else this.loaded.delete(ownerId);
    }
    this.invalidateCache(ownerId);
    return response;
  }

  /**
   * Process an offline outbox batch in one database transaction. Each mutation
   * gets a savepoint, so a VERSION_CONFLICT or validation failure only rolls
   * back that mutation while earlier successes still commit. This removes the
   * per-mutation BEGIN/SET/lock/prepare/cleanup/COMMIT overhead that made a
   * 500-item push untenable on a high-latency link.
   */
  override async applyMutationBatch(
    ownerId: string,
    clientId: string,
    mutations: V2Mutation[],
  ): Promise<V2MutationBatchResult[]> {
    if (!mutations.length) return [];
    const results: V2MutationBatchResult[] = [];
    const published: V2SyncChange[] = [];
    let committedCursor: string | undefined;
    let nextTaskNumber: number | undefined;
    await super.withOwnerMutationLock(ownerId, () =>
      this.sql.withMutation(async () => {
        await this.sql.v2LockOwner(ownerId);
        await this.prepare(ownerId);
        const draft = new MemoryTreeStore();
        const baseState = this.dumpOwnerState(ownerId);
        draft.loadOwnerState(ownerId, structuredClone(baseState));
        for (const [index, mutation] of mutations.entries()) {
          const savepoint = `mutation_${index}`;
          const changeStart = draft.changeCount();
          await this.sql.createSavepoint(savepoint);
          try {
            let actionCursor: string | undefined;
            let actionChanges: V2SyncChange[] = [];
            const response = await this.sql.withIdempotency(
              ownerId,
              clientId,
              mutation.mutationId,
              v2MutationIdempotencyInput(mutation),
              async () => {
                const result = draft.applyMutationForPersistence(ownerId, mutation);
                actionChanges = draft.changesFrom(changeStart);
                await this.persistChanges(ownerId, actionChanges);
                actionCursor = await this.sql.appendV2Changes(ownerId, actionChanges);
                return result;
              },
            );
            await this.sql.releaseSavepoint(savepoint);
            results.push({
              mutation,
              status: 'applied',
              replayed: response.replayed,
              result: response.result,
            });
            if (actionCursor) committedCursor = actionCursor;
            published.push(...actionChanges);
          } catch (error) {
            await this.sql.rollbackToSavepoint(savepoint);
            // A rejected item rolls back only its savepoint. Rebuild from the
            // one batch base plus successful deltas instead of cloning the
            // entire owner before every mutation (the former O(batch²) path).
            draft.restoreDraftFromChanges(ownerId, baseState, '0', 0, published);
            // Only domain validation/conflict failures are permanent per-item
            // outcomes. Database/network/serialization failures must abort the
            // outer transaction so the client retries instead of permanently
            // rejecting an otherwise valid mutation.
            if (!(error instanceof DomainError)) throw error;
            results.push({
              mutation,
              status: error.code === 'VERSION_CONFLICT' ? 'conflict' : 'rejected',
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            });
          }
        }
        nextTaskNumber = draft.getNextTaskNumber(ownerId);
      }),
    );
    // Publish only after the outer transaction committed. A rollback above
    // therefore never changed what readers see.
    if (nextTaskNumber !== undefined) this.setNextTaskNumber(ownerId, nextTaskNumber);
    if (committedCursor) {
      let applied = true;
      for (const change of published) {
        if (!this.applySyncChange(ownerId, change.entityType, change.snapshot)) {
          applied = false;
          break;
        }
      }
      if (applied) this.loaded.set(ownerId, committedCursor);
      else this.loaded.delete(ownerId);
    }
    this.invalidateCache(ownerId);
    return results;
  }

  /** Frequent mobile edits use the same domain rules on a one-task projection.
   * No account-wide notes read, clone, or flush is needed. Receipt, row and feed
   * remain in the existing atomic transaction and owner lock. */
  private async applyFocusedMutation(ownerId: string, clientId: string, mutation: V2Mutation) {
    const response = await this.sql.withMutation(() =>
      this.sql.withIdempotency(
        ownerId,
        clientId,
        mutation.mutationId,
        v2MutationIdempotencyInput(mutation),
        async () => {
          await this.sql.v2LockOwner(ownerId);
          const taskId =
            mutation.command === 'note.update'
              ? (mutation.payload['taskId'] ?? mutation.entityId)
              : mutation.entityId;
          const tasks = await this.sql.v2Query(
            'SELECT * FROM tasks WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
            [ownerId, taskId],
          );
          const notes =
            mutation.command === 'note.update'
              ? await this.sql.v2Query(
                  'SELECT * FROM notes WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL FOR UPDATE',
                  [ownerId, taskId],
                )
              : { rows: [] };
          const focused = new MemoryTreeStore();
          focused.loadOwnerState(ownerId, {
            tasks: tasks.rows.map((row) => ({
              id: String(row.id),
              ownerId,
              referenceId: String(row.reference_id),
              parentFolderId: nullableString(row.parent_folder_id),
              title: String(row.title),
              status: String(row.status),
              rank: String(row.rank),
              version: Number(row.version),
              completedAt: isoOrNull(row.completed_at),
              createdAt: iso(row.created_at),
              updatedAt: iso(row.updated_at),
              deletedAt: null,
            })),
            notes: notes.rows.map((row) => ({
              id: String(row.id),
              ownerId,
              taskId: String(row.task_id),
              contentMarkdown: String(row.content_markdown),
              version: Number(row.version),
              createdAt: iso(row.created_at),
              updatedAt: iso(row.updated_at),
              deletedAt: null,
            })),
          });
          const result = await focused.applyMutationIdempotent(ownerId, clientId, mutation);
          const changes = focused.changesFrom(0);
          await this.persistChanges(ownerId, changes);
          await this.sql.appendV2Changes(ownerId, changes);
          return result.result;
        },
      ),
    );
    // Invalidate only after COMMIT. A rolled-back focused edit never touches
    // the shared read projection; other replicas invalidate via the DB cursor.
    this.loaded.delete(ownerId);
    this.invalidateCache(ownerId);
    return response;
  }

  override async snapshot(ownerId: string) {
    return this.sql.v2ReadSnapshot(async () => {
      await this.prepare(ownerId);
      const snapshot = super.snapshot(ownerId) as V2Snapshot;
      const status = await this.sql.syncStatusV2(ownerId);
      return { ...snapshot, cursor: status.cursor };
    });
  }

  override async pull(ownerId: string, cursor: string, limit: number) {
    return this.sql.syncPullV2(ownerId, cursor, limit) as Promise<{
      changes: V2SyncChange[];
      nextCursor: string;
      hasMore: boolean;
    }>;
  }

  override async status(ownerId: string) {
    return this.sql.syncStatusV2(ownerId);
  }

  override subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void {
    return this.sql.subscribeChanges(listener);
  }

  private async persistChanges(ownerId: string, changes: V2SyncChange[]): Promise<void> {
    if (!changes.length) return;
    const priority: Record<V2SyncChange['entityType'], number> = {
      folder: 20,
      workflow: 30,
      task: 40,
      timePoint: 50,
      note: 60,
      taskStep: 60,
      workflowStage: 60,
      placement: 70,
      workflowTaskMembership: 70,
      settings: 80,
    };
    const groups = new Map<V2SyncChange['entityType'], V2SyncChange[]>();
    for (const change of [...changes].sort((left, right) => {
      const byType = priority[left.entityType] - priority[right.entityType];
      return byType || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    })) {
      const group = groups.get(change.entityType);
      if (group) group.push(change);
      else groups.set(change.entityType, [change]);
    }
    // One multi-row statement per entity type instead of one statement per
    // changed entity. A tree delete can touch hundreds of rows.
    for (const [entityType, group] of groups) await this.persistBatch(ownerId, entityType, group);
  }

  private async persistBatch(
    ownerId: string,
    entityType: V2SyncChange['entityType'],
    changes: V2SyncChange[],
  ): Promise<void> {
    const payload = changes.map((change) => ({ change, row: asRecord(change.snapshot) }));
    switch (entityType) {
      case 'folder':
        await this.upsertBatch(
          'folders',
          FOLDER_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            parent_folder_id: nullableValue(row.parentFolderId),
            title: row.title,
            status: row.status ?? 'TODO',
            completed_at: nullableValue(row.completedAt),
            rank: row.rank,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'task': {
        await this.upsertBatch(
          'tasks',
          TASK_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            project_id: null,
            category: 'MISC',
            reference_id: row.referenceId,
            title: row.title,
            status: row.status,
            priority: 'NONE',
            rank: row.rank,
            completed_at: nullableValue(row.completedAt),
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
            parent_folder_id: nullableValue(row.parentFolderId),
          })),
        );
        let nextTaskNumber: number | undefined;
        for (const { row } of payload) {
          const match = /^TASK-(\d+)$/.exec(String(row.referenceId));
          if (match) nextTaskNumber = Math.max(nextTaskNumber ?? 0, Number(match[1]) + 1);
        }
        if (nextTaskNumber !== undefined)
          await this.sql.v2Query(
            'UPDATE users SET next_task_number = GREATEST(next_task_number, $2) WHERE id = $1',
            [ownerId, nextTaskNumber],
          );
        return;
      }
      case 'note':
        await this.upsertBatch(
          'notes',
          NOTE_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            task_id: row.taskId,
            content_markdown: row.contentMarkdown,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'taskStep':
        await this.upsertBatch(
          'task_steps',
          TASK_STEP_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            task_id: row.taskId,
            title: row.title,
            note_markdown: row.noteMarkdown,
            status: row.status,
            rank: row.rank,
            completed_at: nullableValue(row.completedAt),
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'workflow':
        await this.upsertBatch(
          'workflows',
          WORKFLOW_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            name: row.name,
            rank: row.rank,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'workflowStage':
        await this.upsertBatch(
          'workflow_stages',
          WORKFLOW_STAGE_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            workflow_id: row.workflowId,
            name: row.name,
            rank: row.rank,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'workflowTaskMembership':
        await this.upsertBatch(
          'workflow_task_memberships',
          WORKFLOW_MEMBERSHIP_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            workflow_id: row.workflowId,
            stage_id: row.stageId,
            task_id: row.taskId,
            rank: row.rank,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'timePoint':
        await this.upsertBatch(
          'time_points',
          TIME_POINT_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            type: row.type,
            local_date: nullableValue(row.localDate),
            title: nullableValue(row.title),
            rank: row.rank,
            version: row.version,
            reached_at: nullableValue(row.reachedAt),
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'placement':
        await this.upsertBatch(
          'placements',
          PLACEMENT_COLUMNS,
          payload.map(({ change, row }) => ({
            id: change.entityId,
            owner_id: ownerId,
            task_id: row.taskId,
            time_point_id: row.timePointId,
            rank: row.rank,
            version: row.version,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            deleted_at: nullableValue(row.deletedAt),
          })),
        );
        return;
      case 'settings':
        await this.upsertBatch(
          'user_settings',
          SETTINGS_COLUMNS,
          payload.map(({ row }) => ({
            owner_id: ownerId,
            timezone: row.timezone,
            week_starts_on: row.weekStartsOn,
            default_capture_target: row.defaultCaptureTarget,
            version: row.version,
            created_at: row.updatedAt,
            updated_at: row.updatedAt,
            deleted_at: null,
          })),
          { conflict: ['owner_id'], guardOwner: false },
        );
        return;
    }
  }

  /**
   * One multi-row upsert per entity type.
   *
   * PostgreSQL uses ON CONFLICT with a row-count guard so a stray id from
   * another owner can never be overwritten. MySQL has no ON CONFLICT and no
   * EXCLUDED, so the same batch is expressed as INSERT ... AS new ON
   * DUPLICATE KEY UPDATE; id collisions across owners are impossible because
   * entity ids are server-generated UUIDv7.
   */
  private async upsertBatch(
    table: string,
    columns: readonly string[],
    rows: Array<Record<string, unknown>>,
    options: { conflict?: readonly string[]; guardOwner?: boolean } = {},
  ): Promise<void> {
    if (!rows.length) return;
    const conflict = options.conflict ?? ['id'];
    const dialect = this.dialect;
    const quoted = columns.map(ident);
    const updatable = columns
      .filter((column) => !conflict.includes(column) && column !== 'owner_id')
      .map(ident);
    const chunkSize = Math.max(1, Math.min(200, Math.floor(20_000 / columns.length)));
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const parameters: unknown[] = [];
      const tuples = chunk.map((row) => {
        const values = columns.map((column) => {
          parameters.push(row[column] ?? null);
          return `$${parameters.length}`;
        });
        return `(${values.join(',')})`;
      });
      const statement =
        dialect === 'mysql'
          ? `INSERT INTO ${table} (${quoted.join(',')}) VALUES ${tuples.join(',')} AS new ON DUPLICATE KEY UPDATE ${updatable
              .map((column) => `${column} = new.${column}`)
              .join(',')}`
          : `INSERT INTO ${table} (${quoted.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (${conflict
              .map(ident)
              .join(',')}) DO UPDATE SET ${updatable
              .map((column) => `${column} = EXCLUDED.${column}`)
              .join(
                ',',
              )}${options.guardOwner === false ? '' : ` WHERE ${table}.owner_id = EXCLUDED.owner_id`}`;
      await this.sql.v2Query(statement, parameters);
    }
  }
}

const FOLDER_COLUMNS = [
  'id',
  'owner_id',
  'parent_folder_id',
  'title',
  'status',
  'completed_at',
  'rank',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const TASK_COLUMNS = [
  'id',
  'owner_id',
  'project_id',
  'category',
  'reference_id',
  'title',
  'status',
  'priority',
  'rank',
  'completed_at',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
  'parent_folder_id',
] as const;
const NOTE_COLUMNS = [
  'id',
  'owner_id',
  'task_id',
  'content_markdown',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const TASK_STEP_COLUMNS = [
  'id',
  'owner_id',
  'task_id',
  'title',
  'note_markdown',
  'status',
  'rank',
  'completed_at',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const WORKFLOW_COLUMNS = [
  'id',
  'owner_id',
  'name',
  'rank',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const WORKFLOW_STAGE_COLUMNS = [
  'id',
  'owner_id',
  'workflow_id',
  'name',
  'rank',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const WORKFLOW_MEMBERSHIP_COLUMNS = [
  'id',
  'owner_id',
  'workflow_id',
  'stage_id',
  'task_id',
  'rank',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const TIME_POINT_COLUMNS = [
  'id',
  'owner_id',
  'type',
  'local_date',
  'title',
  'rank',
  'version',
  'reached_at',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const PLACEMENT_COLUMNS = [
  'id',
  'owner_id',
  'task_id',
  'time_point_id',
  'rank',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
const SETTINGS_COLUMNS = [
  'owner_id',
  'timezone',
  'week_starts_on',
  'default_capture_target',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

const RESERVED_IDENTIFIERS = new Set(['rank', 'cursor']);

function ident(name: string): string {
  return RESERVED_IDENTIFIERS.has(name) ? `\`${name}\`` : name;
}

/** MySQL reports booleans and EXISTS as 1/0; PostgreSQL reports true/false. */
function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid v2 change snapshot');
  return value as Record<string, unknown>;
}

function nullableValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
