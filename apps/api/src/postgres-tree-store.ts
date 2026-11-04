import type { V2Mutation } from '@devtodo/contracts';
import { DomainError } from '@devtodo/domain';
import type { CacheStore } from './cache.js';
import type { PostgresStore } from './postgres-store.js';
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
export class PostgresTreeStore extends MemoryTreeStore implements V2TreeStore {
  /**
   * The projection is a read cache, not the sync authority. Keep the owner's
   * latest change sequence alongside it so writes on another API instance,
   * including legacy v1 writes, invalidate the cache with one cheap query.
   */
  private readonly loaded = new Map<string, string>();

  constructor(
    readonly postgres: PostgresStore,
    private readonly cache?: CacheStore,
  ) {
    super();
  }

  override async prepare(ownerId?: string): Promise<void> {
    if (!ownerId) return;
    // Warm-cache validation is one round trip. The full load below runs inside
    // a repeatable-read transaction so all tables come from the same snapshot.
    const current = await this.postgres.v2Query(
      `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL) AS owner_ok,
              (SELECT COALESCE(MAX(seq), 0)::text FROM sync_changes WHERE owner_id = $1) AS cursor`,
      [ownerId],
    );
    const currentRow = current.rows[0];
    if (!currentRow || currentRow['owner_ok'] !== true) throw new Error('Owner is not available');
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
      if (applied !== undefined) {
        this.loaded.set(ownerId, applied);
        this.writeCache(ownerId, applied);
        return;
      }
    }

    await this.postgres.v2ReadSnapshot(async () => {
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
    const result = await this.postgres.v2Query(
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
    const result = await this.postgres.v2Query(
      `SELECT
         (SELECT u.next_task_number FROM users u
          WHERE u.id = $1 AND u.disabled_at IS NULL) AS next_task_number,
         (SELECT COALESCE(MAX(sc.seq), 0)::text FROM sync_changes sc
          WHERE sc.owner_id = $1) AS cursor,
         COALESCE((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object('rank', f.rank::text) ORDER BY f.id)
                   FROM folders f WHERE f.owner_id = $1), '[]'::jsonb) AS folders,
         COALESCE((SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('rank', t.rank::text) ORDER BY t.id)
                   FROM tasks t WHERE t.owner_id = $1), '[]'::jsonb) AS tasks,
         COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id)
                   FROM notes n WHERE n.owner_id = $1), '[]'::jsonb) AS notes,
         COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('rank', s.rank::text) ORDER BY s.id)
                   FROM task_steps s WHERE s.owner_id = $1), '[]'::jsonb) AS steps,
         COALESCE((SELECT jsonb_agg(to_jsonb(w) || jsonb_build_object('rank', w.rank::text) ORDER BY w.id)
                   FROM workflows w WHERE w.owner_id = $1), '[]'::jsonb) AS workflows,
         COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('rank', s.rank::text) ORDER BY s.id)
                   FROM workflow_stages s WHERE s.owner_id = $1), '[]'::jsonb) AS stages,
         COALESCE((SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('rank', m.rank::text) ORDER BY m.id)
                   FROM workflow_task_memberships m WHERE m.owner_id = $1), '[]'::jsonb) AS memberships,
         COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('rank', p.rank::text) ORDER BY p.id)
                   FROM time_points p WHERE p.owner_id = $1), '[]'::jsonb) AS time_points,
         COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('rank', p.rank::text) ORDER BY p.id)
                   FROM placements p WHERE p.owner_id = $1), '[]'::jsonb) AS placements,
         (SELECT to_jsonb(s) FROM user_settings s WHERE s.owner_id = $1) AS settings`,
      [ownerId],
    );
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
      state[key] = Array.isArray(value)
        ? value.map((item) => {
            const mapped = v2SqlDto(item as Record<string, unknown>);
            if (key === 'folders' && !mapped['status']) mapped['status'] = 'TODO';
            return mapped;
          })
        : [];
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
    // Mutate a private draft, persist its delta, and only publish it to the
    // shared read projection after COMMIT. Readers therefore never observe an
    // uncommitted mutation, and a COMMIT failure leaves the projection intact
    // without a full-state rollback clone.
    const response = await super.withMutationLock(() =>
      this.postgres.withMutation(() =>
        this.postgres.withIdempotency(
          ownerId,
          clientId,
          mutation.mutationId,
          v2MutationIdempotencyInput(mutation),
          async () => {
            await this.postgres.v2LockOwner(ownerId);
            await this.prepare(ownerId);
            const draft = new MemoryTreeStore();
            draft.loadOwnerState(ownerId, this.dumpOwnerState(ownerId));
            const result = draft.applyMutationForPersistence(ownerId, mutation);
            changes = draft.changesFrom(0);
            await this.persistChanges(ownerId, changes);
            committedCursor = await this.postgres.appendV2Changes(ownerId, changes);
            return result;
          },
        ),
      ),
    );
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
    await super.withMutationLock(() =>
      this.postgres.withMutation(async () => {
        await this.postgres.v2LockOwner(ownerId);
        await this.prepare(ownerId);
        const draft = new MemoryTreeStore();
        draft.loadOwnerState(ownerId, this.dumpOwnerState(ownerId));
        for (const [index, mutation] of mutations.entries()) {
          const savepoint = `mutation_${index}`;
          const draftBefore = draft.captureDraft(ownerId);
          const changeStart = draft.changeCount();
          await this.postgres.createSavepoint(savepoint);
          try {
            let actionCursor: string | undefined;
            let actionChanges: V2SyncChange[] = [];
            const response = await this.postgres.withIdempotency(
              ownerId,
              clientId,
              mutation.mutationId,
              v2MutationIdempotencyInput(mutation),
              async () => {
                const result = draft.applyMutationForPersistence(ownerId, mutation);
                actionChanges = draft.changesFrom(changeStart);
                await this.persistChanges(ownerId, actionChanges);
                actionCursor = await this.postgres.appendV2Changes(ownerId, actionChanges);
                return result;
              },
            );
            await this.postgres.releaseSavepoint(savepoint);
            results.push({
              mutation,
              status: 'applied',
              replayed: response.replayed,
              result: response.result,
            });
            if (actionCursor) committedCursor = actionCursor;
            published.push(...actionChanges);
          } catch (error) {
            await this.postgres.rollbackToSavepoint(savepoint);
            draft.restoreDraft(ownerId, draftBefore);
            const domain =
              error instanceof DomainError
                ? error
                : new DomainError('MUTATION_REJECTED', 'mutation 被拒绝');
            results.push({
              mutation,
              status: domain.code === 'VERSION_CONFLICT' ? 'conflict' : 'rejected',
              error: {
                code: domain.code,
                message: domain.message,
                details: domain.details,
              },
            });
          }
        }
      }),
    );
    // Publish only after the outer transaction committed. A rollback above
    // therefore never changed what readers see.
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
    const response = await this.postgres.withMutation(() =>
      this.postgres.withIdempotency(
        ownerId,
        clientId,
        mutation.mutationId,
        v2MutationIdempotencyInput(mutation),
        async () => {
          await this.postgres.v2LockOwner(ownerId);
          const taskId =
            mutation.command === 'note.update'
              ? (mutation.payload['taskId'] ?? mutation.entityId)
              : mutation.entityId;
          const tasks = await this.postgres.v2Query(
            'SELECT * FROM tasks WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
            [ownerId, taskId],
          );
          const notes =
            mutation.command === 'note.update'
              ? await this.postgres.v2Query(
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
          await this.postgres.appendV2Changes(ownerId, changes);
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
    return this.postgres.v2ReadSnapshot(async () => {
      await this.prepare(ownerId);
      const snapshot = super.snapshot(ownerId) as V2Snapshot;
      const status = await this.postgres.syncStatusV2(ownerId);
      return { ...snapshot, cursor: status.cursor };
    });
  }

  override async pull(ownerId: string, cursor: string, limit: number) {
    return this.postgres.syncPullV2(ownerId, cursor, limit) as Promise<{
      changes: V2SyncChange[];
      nextCursor: string;
      hasMore: boolean;
    }>;
  }

  override async status(ownerId: string) {
    return this.postgres.syncStatusV2(ownerId);
  }

  override subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void {
    return this.postgres.subscribeChanges(listener);
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
    const payload = changes.map((change) => {
      const row = asRecord(change.snapshot);
      return { change, row };
    });
    const json = (rows: Array<Record<string, unknown>>) => JSON.stringify(rows);
    switch (entityType) {
      case 'folder':
        await this.postgres.v2Query(
          `INSERT INTO folders (id,owner_id,parent_folder_id,title,status,completed_at,rank,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.parent_folder_id, x.title, x.status, x.completed_at, x.rank, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, parent_folder_id uuid, title text, status text, completed_at timestamptz,
             rank bigint, version integer, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET parent_folder_id=EXCLUDED.parent_folder_id,title=EXCLUDED.title,status=EXCLUDED.status,completed_at=EXCLUDED.completed_at,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE folders.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
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
            ),
          ],
        );
        return;
      case 'task': {
        await this.postgres.v2Query(
          `INSERT INTO tasks (id,owner_id,project_id,category,reference_id,title,status,priority,rank,completed_at,version,created_at,updated_at,deleted_at,parent_folder_id)
           SELECT x.id, $1, NULL, 'MISC', x.reference_id, x.title, x.status, 'NONE', x.rank, x.completed_at, x.version, x.created_at, x.updated_at, x.deleted_at, x.parent_folder_id
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, reference_id text, title text, status text, rank bigint,
             completed_at timestamptz, version integer, created_at timestamptz,
             updated_at timestamptz, deleted_at timestamptz, parent_folder_id uuid
           )
           ON CONFLICT (id) DO UPDATE SET reference_id=EXCLUDED.reference_id,title=EXCLUDED.title,status=EXCLUDED.status,rank=EXCLUDED.rank,completed_at=EXCLUDED.completed_at,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at,parent_folder_id=EXCLUDED.parent_folder_id
           WHERE tasks.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                reference_id: row.referenceId,
                title: row.title,
                status: row.status,
                rank: row.rank,
                completed_at: nullableValue(row.completedAt),
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
                parent_folder_id: nullableValue(row.parentFolderId),
              })),
            ),
          ],
        );
        let nextTaskNumber: number | undefined;
        for (const { row } of payload) {
          const match = /^TASK-(\d+)$/.exec(String(row.referenceId));
          if (match) nextTaskNumber = Math.max(nextTaskNumber ?? 0, Number(match[1]) + 1);
        }
        if (nextTaskNumber !== undefined)
          await this.postgres.v2Query(
            'UPDATE users SET next_task_number = GREATEST(next_task_number, $2) WHERE id = $1',
            [ownerId, nextTaskNumber],
          );
        return;
      }
      case 'note':
        await this.postgres.v2Query(
          `INSERT INTO notes (id,owner_id,task_id,content_markdown,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.task_id, x.content_markdown, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, task_id uuid, content_markdown text, version integer,
             created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,content_markdown=EXCLUDED.content_markdown,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE notes.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                task_id: row.taskId,
                content_markdown: row.contentMarkdown,
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
              })),
            ),
          ],
        );
        return;
      case 'taskStep':
        await this.postgres.v2Query(
          `INSERT INTO task_steps (id,owner_id,task_id,title,note_markdown,status,rank,completed_at,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.task_id, x.title, x.note_markdown, x.status, x.rank, x.completed_at, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, task_id uuid, title text, note_markdown text, status text, rank bigint,
             completed_at timestamptz, version integer, created_at timestamptz,
             updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,title=EXCLUDED.title,note_markdown=EXCLUDED.note_markdown,status=EXCLUDED.status,rank=EXCLUDED.rank,completed_at=EXCLUDED.completed_at,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE task_steps.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
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
            ),
          ],
        );
        return;
      case 'workflow':
        await this.postgres.v2Query(
          `INSERT INTO workflows (id,owner_id,name,rank,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.name, x.rank, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, name text, rank bigint, version integer,
             created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflows.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                name: row.name,
                rank: row.rank,
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
              })),
            ),
          ],
        );
        return;
      case 'workflowStage':
        await this.postgres.v2Query(
          `INSERT INTO workflow_stages (id,owner_id,workflow_id,name,rank,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.workflow_id, x.name, x.rank, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, workflow_id uuid, name text, rank bigint, version integer,
             created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,name=EXCLUDED.name,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflow_stages.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                workflow_id: row.workflowId,
                name: row.name,
                rank: row.rank,
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
              })),
            ),
          ],
        );
        return;
      case 'workflowTaskMembership':
        await this.postgres.v2Query(
          `INSERT INTO workflow_task_memberships (id,owner_id,workflow_id,stage_id,task_id,rank,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.workflow_id, x.stage_id, x.task_id, x.rank, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, workflow_id uuid, stage_id uuid, task_id uuid, rank bigint, version integer,
             created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,stage_id=EXCLUDED.stage_id,task_id=EXCLUDED.task_id,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflow_task_memberships.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                workflow_id: row.workflowId,
                stage_id: row.stageId,
                task_id: row.taskId,
                rank: row.rank,
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
              })),
            ),
          ],
        );
        return;
      case 'timePoint':
        await this.postgres.v2Query(
          `INSERT INTO time_points (id,owner_id,type,local_date,title,rank,version,reached_at,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.type, x.local_date, x.title, x.rank, x.version, x.reached_at, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, type text, local_date date, title text, rank bigint, version integer,
             reached_at timestamptz, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,local_date=EXCLUDED.local_date,title=EXCLUDED.title,rank=EXCLUDED.rank,version=EXCLUDED.version,reached_at=EXCLUDED.reached_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE time_points.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
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
            ),
          ],
        );
        return;
      case 'placement':
        await this.postgres.v2Query(
          `INSERT INTO placements (id,owner_id,task_id,time_point_id,rank,version,created_at,updated_at,deleted_at)
           SELECT x.id, $1, x.task_id, x.time_point_id, x.rank, x.version, x.created_at, x.updated_at, x.deleted_at
           FROM jsonb_to_recordset($2::jsonb) AS x(
             id uuid, task_id uuid, time_point_id uuid, rank bigint, version integer,
             created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,time_point_id=EXCLUDED.time_point_id,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE placements.owner_id = EXCLUDED.owner_id`,
          [
            ownerId,
            json(
              payload.map(({ change, row }) => ({
                id: change.entityId,
                task_id: row.taskId,
                time_point_id: row.timePointId,
                rank: row.rank,
                version: row.version,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
                deleted_at: nullableValue(row.deletedAt),
              })),
            ),
          ],
        );
        return;
      case 'settings':
        await this.postgres.v2Query(
          `INSERT INTO user_settings (owner_id,timezone,week_starts_on,default_capture_target,version,created_at,updated_at,deleted_at)
           SELECT $1, x.timezone, x.week_starts_on, x.default_capture_target, x.version, x.updated_at, x.updated_at, NULL
           FROM jsonb_to_recordset($2::jsonb) AS x(
             timezone text, week_starts_on smallint, default_capture_target text,
             version integer, updated_at timestamptz
           )
           ON CONFLICT (owner_id) DO UPDATE SET timezone=EXCLUDED.timezone,week_starts_on=EXCLUDED.week_starts_on,default_capture_target=EXCLUDED.default_capture_target,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,deleted_at=NULL`,
          [
            ownerId,
            json(
              payload.map(({ row }) => ({
                timezone: row.timezone,
                week_starts_on: row.weekStartsOn,
                default_capture_target: row.defaultCaptureTarget,
                version: row.version,
                updated_at: row.updatedAt,
              })),
            ),
          ],
        );
        return;
    }
  }
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
