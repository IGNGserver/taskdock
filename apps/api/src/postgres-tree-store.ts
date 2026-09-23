import type { TaskStepDto, TreeTaskDto, V2Mutation, V2SettingsDto } from '@devtodo/contracts';
import type { PostgresStore } from './postgres-store.js';
import {
  MemoryTreeStore,
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

  constructor(private readonly postgres: PostgresStore) {
    super();
  }

  override async prepare(ownerId?: string): Promise<void> {
    if (!ownerId) return;
    const owner = await this.postgres.v2Query(
      'SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL',
      [ownerId],
    );
    if (!owner.rows[0]) throw new Error('Owner is not available');
    const cursor = await this.postgres.v2Query(
      // This projection includes rows written by the legacy v1 API too. Use
      // the owner-wide change sequence for cache invalidation so a v1 date
      // point created on another API instance cannot remain invisible here.
      'SELECT COALESCE(MAX(seq), 0)::text AS cursor FROM sync_changes WHERE owner_id = $1',
      [ownerId],
    );
    const currentCursor = String(cursor.rows[0]?.cursor ?? '0');
    if (this.loaded.get(ownerId) === currentCursor) return;
    // All v2Query calls below share the current transaction client. Keep them
    // sequential: pg clients do not support Promise.all on one active query
    // stream, and queued concurrent calls become an execution hazard in pg 9.
    const folders = await this.postgres.v2Query(
      'SELECT id, owner_id, parent_folder_id, title, rank::text, version, archived_at, archived_by_operation_id, created_at, updated_at, deleted_at FROM folders WHERE owner_id = $1',
      [ownerId],
    );
    const tasks = await this.postgres.v2Query(
      'SELECT id, owner_id, reference_id, parent_folder_id, title, status, rank::text, version, completed_at, archived_at, created_at, updated_at, deleted_at, archived_by_operation_id FROM tasks WHERE owner_id = $1',
      [ownerId],
    );
    const notes = await this.postgres.v2Query(
      'SELECT id, owner_id, task_id, content_markdown, version, created_at, updated_at, deleted_at FROM notes WHERE owner_id = $1',
      [ownerId],
    );
    const steps = await this.postgres.v2Query(
      'SELECT id, owner_id, task_id, title, note_markdown, status, rank::text, completed_at, version, created_at, updated_at, deleted_at FROM task_steps WHERE owner_id = $1',
      [ownerId],
    );
    const workflows = await this.postgres.v2Query(
      'SELECT id, owner_id, name, rank::text, version, archived_at, created_at, updated_at, deleted_at FROM workflows WHERE owner_id = $1',
      [ownerId],
    );
    const stages = await this.postgres.v2Query(
      'SELECT id, owner_id, workflow_id, name, rank::text, version, created_at, updated_at, deleted_at FROM workflow_stages WHERE owner_id = $1',
      [ownerId],
    );
    const memberships = await this.postgres.v2Query(
      'SELECT id, owner_id, workflow_id, stage_id, task_id, rank::text, version, created_at, updated_at, deleted_at FROM workflow_task_memberships WHERE owner_id = $1',
      [ownerId],
    );
    const archiveOperations = await this.postgres.v2Query(
      'SELECT id, owner_id, root_folder_id, root_base_version, folder_count, task_count, created_at, restored_at FROM archive_operations WHERE owner_id = $1',
      [ownerId],
    );
    const timePoints = await this.postgres.v2Query(
      'SELECT id, owner_id, type, local_date, title, rank::text, version, reached_at, archived_at, created_at, updated_at, deleted_at FROM time_points WHERE owner_id = $1',
      [ownerId],
    );
    const placements = await this.postgres.v2Query(
      'SELECT id, owner_id, task_id, time_point_id, rank::text, version, created_at, updated_at, deleted_at FROM placements WHERE owner_id = $1',
      [ownerId],
    );
    const settings = await this.postgres.v2Query(
      'SELECT owner_id, timezone, week_starts_on, default_capture_target, version, updated_at FROM user_settings WHERE owner_id = $1',
      [ownerId],
    );
    const user = await this.postgres.v2Query('SELECT next_task_number FROM users WHERE id = $1', [
      ownerId,
    ]);
    const settingsRow = settings.rows[0];
    this.loadOwnerState(ownerId, {
      folders: folders.rows.map((row) => ({
        ...row,
        ownerId: String(row.owner_id),
        parentFolderId: nullableString(row.parent_folder_id),
        rank: String(row.rank),
        archivedAt: isoOrNull(row.archived_at),
        archivedByOperationId: nullableString(row.archived_by_operation_id),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      tasks: tasks.rows.map((row) => ({
        ...row,
        ownerId: String(row.owner_id),
        referenceId: String(row.reference_id),
        parentFolderId: nullableString(row.parent_folder_id),
        title: String(row.title),
        status: String(row.status) as TreeTaskDto['status'],
        rank: String(row.rank),
        version: Number(row.version),
        completedAt: isoOrNull(row.completed_at),
        archivedAt: isoOrNull(row.archived_at),
        archivedByOperationId: nullableString(row.archived_by_operation_id),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      notes: notes.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        taskId: String(row.task_id),
        contentMarkdown: String(row.content_markdown),
        version: Number(row.version),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      steps: steps.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        taskId: String(row.task_id),
        title: String(row.title),
        noteMarkdown: String(row.note_markdown),
        status: String(row.status) as TaskStepDto['status'],
        rank: String(row.rank),
        completedAt: isoOrNull(row.completed_at),
        version: Number(row.version),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      workflows: workflows.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        name: String(row.name),
        rank: String(row.rank),
        version: Number(row.version),
        archivedAt: isoOrNull(row.archived_at),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      stages: stages.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        workflowId: String(row.workflow_id),
        name: String(row.name),
        rank: String(row.rank),
        version: Number(row.version),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      memberships: memberships.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        workflowId: String(row.workflow_id),
        stageId: String(row.stage_id),
        taskId: String(row.task_id),
        rank: String(row.rank),
        version: Number(row.version),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      archiveOperations: archiveOperations.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        rootFolderId: String(row.root_folder_id),
        rootBaseVersion: Number(row.root_base_version),
        folderCount: Number(row.folder_count),
        taskCount: Number(row.task_count),
        createdAt: iso(row.created_at),
        restoredAt: isoOrNull(row.restored_at),
      })),
      timePoints: timePoints.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        type: String(row.type),
        localDate: nullableDate(row.local_date),
        title: nullableString(row.title),
        rank: String(row.rank),
        version: Number(row.version),
        reachedAt: isoOrNull(row.reached_at),
        archivedAt: isoOrNull(row.archived_at),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      placements: placements.rows.map((row) => ({
        id: String(row.id),
        ownerId: String(row.owner_id),
        taskId: String(row.task_id),
        timePointId: String(row.time_point_id),
        rank: String(row.rank),
        version: Number(row.version),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        deletedAt: isoOrNull(row.deleted_at),
      })),
      settings: settingsRow
        ? ({
            ownerId,
            timezone: String(settingsRow.timezone),
            weekStartsOn: Number(settingsRow.week_starts_on) as 0 | 1,
            defaultCaptureTarget:
              settingsRow.default_capture_target === 'RECENT_CONTEXT' ||
              settingsRow.default_capture_target === 'RECENT_FOLDER'
                ? 'RECENT_FOLDER'
                : 'ROOT',
            version: Number(settingsRow.version),
            updatedAt: iso(settingsRow.updated_at),
          } satisfies V2SettingsDto)
        : undefined,
      nextTaskNumber: Number(user.rows[0]?.next_task_number ?? 1),
    });
    this.loaded.set(ownerId, currentCursor);
  }

  override async applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: V2Mutation,
  ): Promise<{ replayed: boolean; result: unknown }> {
    let committedCursor: string | undefined;
    // Snapshot the projection outside the database transaction as well. If
    // COMMIT itself fails, MemoryTreeStore restores the exact pre-request
    // maps/cursor/change buffer instead of leaving an uncommitted mutation in
    // this process.
    const response = await super.withMutation(() =>
      this.postgres.withMutation(() =>
        this.postgres.withIdempotency(
          ownerId,
          clientId,
          mutation.mutationId,
          v2MutationIdempotencyInput(mutation),
          async () => {
            await this.postgres.v2LockOwner(ownerId);
            await this.prepare(ownerId);
            const changeStart = this.changeCount();
            const result = await this.dispatchMutation(ownerId, mutation);
            const changes = this.changesFrom(changeStart);
            await this.persistChanges(ownerId, changes);
            for (const change of changes)
              committedCursor = await this.postgres.appendV2Change(
                ownerId,
                change.entityType,
                change.entityId,
                change.entityVersion,
                change.operation,
                change.snapshot,
              );
            return result;
          },
        ),
      ),
    );
    if (committedCursor) this.loaded.set(ownerId, committedCursor);
    this.clearChangeBuffer();
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
    const priority: Record<V2SyncChange['entityType'], number> = {
      archiveOperation: 10,
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
    for (const change of [...changes].sort((left, right) => {
      const byType = priority[left.entityType] - priority[right.entityType];
      return byType || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    }))
      await this.persistChange(ownerId, change);
  }

  private async persistChange(ownerId: string, change: V2SyncChange): Promise<void> {
    const row = asRecord(change.snapshot);
    switch (change.entityType) {
      case 'archiveOperation':
        await this.postgres.v2Query(
          `INSERT INTO archive_operations (id,owner_id,root_folder_id,root_base_version,folder_count,task_count,created_at,restored_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET root_folder_id=EXCLUDED.root_folder_id,root_base_version=EXCLUDED.root_base_version,folder_count=EXCLUDED.folder_count,task_count=EXCLUDED.task_count,created_at=EXCLUDED.created_at,restored_at=EXCLUDED.restored_at`,
          [
            change.entityId,
            ownerId,
            row.rootFolderId,
            row.rootBaseVersion,
            row.folderCount,
            row.taskCount,
            row.createdAt,
            nullableValue(row.restoredAt),
          ],
        );
        return;
      case 'folder':
        await this.postgres.v2Query(
          `INSERT INTO folders (id,owner_id,parent_folder_id,title,rank,version,archived_at,archived_by_operation_id,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET parent_folder_id=EXCLUDED.parent_folder_id,title=EXCLUDED.title,rank=EXCLUDED.rank,version=EXCLUDED.version,archived_at=EXCLUDED.archived_at,archived_by_operation_id=EXCLUDED.archived_by_operation_id,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE folders.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            nullableValue(row.parentFolderId),
            row.title,
            row.rank,
            row.version,
            nullableValue(row.archivedAt),
            nullableValue(row.archivedByOperationId),
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'task': {
        await this.postgres.v2Query(
          `INSERT INTO tasks (id,owner_id,project_id,category,reference_id,title,status,priority,rank,completed_at,archived_at,version,created_at,updated_at,deleted_at,parent_folder_id,archived_by_operation_id)
           VALUES ($1,$2,NULL,'MISC',$3,$4,$5,'NONE',$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (id) DO UPDATE SET reference_id=EXCLUDED.reference_id,title=EXCLUDED.title,status=EXCLUDED.status,rank=EXCLUDED.rank,completed_at=EXCLUDED.completed_at,archived_at=EXCLUDED.archived_at,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at,parent_folder_id=EXCLUDED.parent_folder_id,archived_by_operation_id=EXCLUDED.archived_by_operation_id
           WHERE tasks.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.referenceId,
            row.title,
            row.status,
            row.rank,
            nullableValue(row.completedAt),
            nullableValue(row.archivedAt),
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
            nullableValue(row.parentFolderId),
            nullableValue(row.archivedByOperationId),
          ],
        );
        const match = /^TASK-(\d+)$/.exec(String(row.referenceId));
        if (match)
          await this.postgres.v2Query(
            'UPDATE users SET next_task_number = GREATEST(next_task_number, $2) WHERE id = $1',
            [ownerId, Number(match[1]) + 1],
          );
        return;
      }
      case 'note':
        await this.postgres.v2Query(
          `INSERT INTO notes (id,owner_id,task_id,content_markdown,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,content_markdown=EXCLUDED.content_markdown,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE notes.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.taskId,
            row.contentMarkdown,
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'taskStep':
        await this.postgres.v2Query(
          `INSERT INTO task_steps (id,owner_id,task_id,title,note_markdown,status,rank,completed_at,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,title=EXCLUDED.title,note_markdown=EXCLUDED.note_markdown,status=EXCLUDED.status,rank=EXCLUDED.rank,completed_at=EXCLUDED.completed_at,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE task_steps.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.taskId,
            row.title,
            row.noteMarkdown,
            row.status,
            row.rank,
            nullableValue(row.completedAt),
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'workflow':
        await this.postgres.v2Query(
          `INSERT INTO workflows (id,owner_id,name,rank,version,archived_at,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,rank=EXCLUDED.rank,version=EXCLUDED.version,archived_at=EXCLUDED.archived_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflows.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.name,
            row.rank,
            row.version,
            nullableValue(row.archivedAt),
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'workflowStage':
        await this.postgres.v2Query(
          `INSERT INTO workflow_stages (id,owner_id,workflow_id,name,rank,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,name=EXCLUDED.name,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflow_stages.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.workflowId,
            row.name,
            row.rank,
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'workflowTaskMembership':
        await this.postgres.v2Query(
          `INSERT INTO workflow_task_memberships (id,owner_id,workflow_id,stage_id,task_id,rank,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,stage_id=EXCLUDED.stage_id,task_id=EXCLUDED.task_id,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE workflow_task_memberships.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.workflowId,
            row.stageId,
            row.taskId,
            row.rank,
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'timePoint':
        await this.postgres.v2Query(
          `INSERT INTO time_points (id,owner_id,type,local_date,title,rank,version,reached_at,archived_at,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,local_date=EXCLUDED.local_date,title=EXCLUDED.title,rank=EXCLUDED.rank,version=EXCLUDED.version,reached_at=EXCLUDED.reached_at,archived_at=EXCLUDED.archived_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE time_points.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.type,
            nullableValue(row.localDate),
            nullableValue(row.title),
            row.rank,
            row.version,
            nullableValue(row.reachedAt),
            nullableValue(row.archivedAt),
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'placement':
        await this.postgres.v2Query(
          `INSERT INTO placements (id,owner_id,task_id,time_point_id,rank,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id,time_point_id=EXCLUDED.time_point_id,rank=EXCLUDED.rank,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
           WHERE placements.owner_id = EXCLUDED.owner_id`,
          [
            change.entityId,
            ownerId,
            row.taskId,
            row.timePointId,
            row.rank,
            row.version,
            row.createdAt,
            row.updatedAt,
            nullableValue(row.deletedAt),
          ],
        );
        return;
      case 'settings':
        await this.postgres.v2Query(
          `INSERT INTO user_settings (owner_id,timezone,week_starts_on,default_capture_target,version,created_at,updated_at,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,NULL)
           ON CONFLICT (owner_id) DO UPDATE SET timezone=EXCLUDED.timezone,week_starts_on=EXCLUDED.week_starts_on,default_capture_target=EXCLUDED.default_capture_target,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,deleted_at=NULL`,
          [
            ownerId,
            row.timezone,
            row.weekStartsOn,
            row.defaultCaptureTarget,
            row.version,
            row.updatedAt,
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
function nullableDate(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).slice(0, 10);
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
