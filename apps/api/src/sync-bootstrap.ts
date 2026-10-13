import { randomUUID } from 'node:crypto';
import { DomainError } from '@devtodo/domain';
import { PostgresTreeStore } from './postgres-tree-store.js';
import type { V2Snapshot, V2TreeStore } from './tree-store.js';

const ttlMs = 30 * 60_000;
const maxPageBytes = 512_000;
const maxPageItems = 200;
const collections = {
  folders: ['folder', 'folders'],
  tasks: ['task', 'tasks'],
  timePoints: ['timePoint', 'time_points'],
  placements: ['placement', 'placements'],
  workflows: ['workflow', 'workflows'],
  workflowStages: ['workflowStage', 'workflow_stages'],
  workflowTaskMemberships: ['workflowTaskMembership', 'workflow_task_memberships'],
  taskSteps: ['taskStep', 'task_steps'],
  notes: ['note', 'notes'],
} as const;

export interface BootstrapChange {
  seq: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  operation: 'upsert';
  snapshot: unknown;
}
interface Session {
  ownerId: string;
  snapshotId: string;
  cursor: string;
  expiresAt: string;
  pages: BootstrapChange[][];
}

/** Maps SQL rows without loading the mutable domain projection or its notes. */
function dto(row: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
    value[name] =
      raw instanceof Date
        ? key === 'local_date'
          ? raw.toISOString().slice(0, 10)
          : raw.toISOString()
        : raw;
  }
  if ('rank' in value) value['rank'] = String(value['rank']);
  if ('version' in value) value['version'] = Number(value['version']);
  if ('weekStartsOn' in value) value['weekStartsOn'] = Number(value['weekStartsOn']);
  if ('defaultCaptureTarget' in value && value['defaultCaptureTarget'] !== 'ROOT')
    value['defaultCaptureTarget'] = 'RECENT_FOLDER';
  return value;
}

function changes(snapshot: V2Snapshot): BootstrapChange[] {
  const items: BootstrapChange[] = [
    {
      seq: snapshot.cursor,
      entityType: 'settings',
      entityId: snapshot.settings.ownerId,
      entityVersion: snapshot.settings.version,
      operation: 'upsert',
      snapshot: snapshot.settings,
    },
  ];
  for (const [key, [type]] of Object.entries(collections)) {
    for (const row of snapshot[key as keyof typeof collections]) {
      items.push({
        seq: snapshot.cursor,
        entityType: type,
        entityId: row.id,
        entityVersion: row.version,
        operation: 'upsert',
        snapshot: row,
      });
    }
  }
  return items;
}

export function splitBootstrapPages(items: BootstrapChange[]): BootstrapChange[][] {
  const pages: BootstrapChange[][] = [];
  let page: BootstrapChange[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (page.length && (page.length >= maxPageItems || bytes + size > maxPageBytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

export class BootstrapSnapshots {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly tree: V2TreeStore) {}

  private async capture(ownerId: string): Promise<V2Snapshot> {
    if (!(this.tree instanceof PostgresTreeStore)) return this.tree.snapshot(ownerId);
    const postgres = this.tree.postgres;
    return postgres.v2ReadSnapshot(async () => {
      const snapshot: Record<string, unknown> = {};
      for (const [key, [, table]] of Object.entries(collections)) {
        const order =
          table === 'folders' || table === 'tasks' ? 'parent_folder_id NULLS FIRST, id' : 'id';
        const rank = table === 'notes' ? '' : ', rank::text AS rank';
        const rows = await postgres.v2Query(
          `SELECT *${rank} FROM ${table} WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY ${order}`,
          [ownerId],
        );
        snapshot[key] = rows.rows.map(dto);
      }
      const settings = await postgres.v2Query('SELECT * FROM user_settings WHERE owner_id = $1', [
        ownerId,
      ]);
      if (!settings.rows[0]) throw new DomainError('AUTH_REQUIRED', '账户设置不可用');
      snapshot['settings'] = dto(settings.rows[0]);
      snapshot['cursor'] = (await postgres.syncStatusV2(ownerId)).cursor;
      return snapshot as unknown as V2Snapshot;
    });
  }

  async preview(ownerId: string, localDate: string, parentFolderId: string | null) {
    if (!(this.tree instanceof PostgresTreeStore)) {
      const full = await this.capture(ownerId);
      const points = full.timePoints.filter((p) => p.localDate === localDate);
      const ids = new Set(points.map((p) => p.id));
      const placements = full.placements.filter((p) => ids.has(p.timePointId)).slice(0, 100);
      const tasks = new Set(placements.map((p) => p.taskId));
      const priority = { IN_PROGRESS: 0, TODO: 1, DONE: 2 };
      const roots = full.tasks
        .filter((t) => t.parentFolderId === parentFolderId)
        .sort(
          (a, b) =>
            priority[a.status] - priority[b.status] ||
            (BigInt(a.rank) < BigInt(b.rank)
              ? -1
              : BigInt(a.rank) > BigInt(b.rank)
                ? 1
                : a.id.localeCompare(b.id)),
        )
        .slice(0, 100);
      const selected = new Map(
        [...roots, ...full.tasks.filter((t) => tasks.has(t.id))].map((t) => [t.id, t]),
      );
      return {
        changes: changes({
          ...full,
          folders: full.folders.filter((f) => f.parentFolderId === parentFolderId).slice(0, 100),
          tasks: [...selected.values()],
          timePoints: points,
          placements,
          notes: [],
          taskSteps: [],
          workflows: [],
          workflowStages: [],
          workflowTaskMemberships: [],
        }),
        complete: false,
      };
    }
    const postgres = this.tree.postgres;
    return postgres.v2ReadSnapshot(async () => {
      const settings = await postgres.v2Query('SELECT * FROM user_settings WHERE owner_id = $1', [
        ownerId,
      ]);
      const folders = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM folders WHERE owner_id = $1 AND deleted_at IS NULL AND parent_folder_id IS NOT DISTINCT FROM $2::uuid ORDER BY folders.rank, id LIMIT 100',
        [ownerId, parentFolderId],
      );
      const points = await postgres.v2Query(
        "SELECT *, rank::text AS rank FROM time_points WHERE owner_id = $1 AND type = 'DATE' AND local_date = $2::date AND deleted_at IS NULL",
        [ownerId, localDate],
      );
      const pointIds = points.rows.map((p) => p['id']);
      const placements = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM placements WHERE owner_id = $1 AND time_point_id = ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY placements.rank, id LIMIT 100',
        [ownerId, pointIds],
      );
      const taskIds = placements.rows.map((p) => p['task_id']);
      const rootTasks = await postgres.v2Query(
        "SELECT *, rank::text AS rank FROM tasks WHERE owner_id = $1 AND parent_folder_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL ORDER BY CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END, tasks.rank, id LIMIT 100",
        [ownerId, parentFolderId],
      );
      const scheduledTasks = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM tasks WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
        [ownerId, taskIds],
      );
      const selected = new Map(
        [...rootTasks.rows, ...scheduledTasks.rows].map((t) => [t['id'], dto(t)]),
      );
      const snapshot = {
        settings: dto(settings.rows[0]!),
        folders: folders.rows.map(dto),
        tasks: [...selected.values()],
        timePoints: points.rows.map(dto),
        placements: placements.rows.map(dto),
        cursor: '0',
        notes: [],
        taskSteps: [],
        workflows: [],
        workflowStages: [],
        workflowTaskMemberships: [],
      } as unknown as V2Snapshot;
      return { changes: changes(snapshot), complete: false };
    });
  }

  async create(ownerId: string, localDate: string) {
    if (this.tree instanceof PostgresTreeStore) return this.createPostgres(ownerId);
    const snapshot = await this.capture(ownerId);
    // Dependencies precede relations; large note bodies are always last.
    const todayIds = new Set(
      snapshot.timePoints.filter((p) => p.localDate === localDate).map((p) => p.id),
    );
    const scheduled = new Set(
      snapshot.placements.filter((p) => todayIds.has(p.timePointId)).map((p) => p.taskId),
    );
    snapshot.tasks.sort(
      (a, b) =>
        Number(b.parentFolderId === null || scheduled.has(b.id)) -
          Number(a.parentFolderId === null || scheduled.has(a.id)) || a.id.localeCompare(b.id),
    );
    const session: Session = {
      ownerId,
      snapshotId: randomUUID(),
      cursor: snapshot.cursor,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      pages: splitBootstrapPages(changes(snapshot)),
    };
    for (const [id, stored] of this.sessions)
      if (Date.parse(stored.expiresAt) <= Date.now()) this.sessions.delete(id);
    // Memory mode is development-only. Bound retained sessions globally.
    while (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(session.snapshotId, session);
    return {
      snapshotId: session.snapshotId,
      cursor: session.cursor,
      expiresAt: session.expiresAt,
      pageCount: session.pages.length,
      protocolVersion: 2,
    };
  }

  private async createPostgres(ownerId: string) {
    if (!(this.tree instanceof PostgresTreeStore)) throw new Error('PostgreSQL required');
    const postgres = this.tree.postgres;
    // Maintenance precedes the capture transaction; it must not pin its MVCC view.
    await postgres.v2Query('DELETE FROM sync_bootstrap_snapshots WHERE expires_at <= now()');
    await postgres.v2Query(
      'DELETE FROM sync_bootstrap_snapshots WHERE id IN (SELECT id FROM sync_bootstrap_snapshots WHERE owner_id = $1 ORDER BY expires_at DESC OFFSET 3)',
      [ownerId],
    );
    return postgres.withMutation(async () => {
      await postgres.v2Query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const cursor = (await postgres.syncStatusV2(ownerId)).cursor;
      const snapshotId = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await postgres.v2Query(
        'INSERT INTO sync_bootstrap_snapshots(id,owner_id,cursor,expires_at,page_count) VALUES($1,$2,$3,$4,0)',
        [snapshotId, ownerId, cursor, expiresAt],
      );
      let page: BootstrapChange[] = [];
      let bytes = 0;
      let pageCount = 0;
      const flush = async () => {
        if (!page.length) return;
        await postgres.v2Query(
          'INSERT INTO sync_bootstrap_pages(snapshot_id,page,payload) VALUES($1,$2,$3::jsonb)',
          [snapshotId, pageCount++, JSON.stringify(page)],
        );
        page = [];
        bytes = 0;
      };
      const append = async (type: string, row: Record<string, unknown>) => {
        const value = dto(row);
        const change: BootstrapChange = {
          seq: cursor,
          entityType: type,
          entityId: String(value['id'] ?? value['ownerId']),
          entityVersion: Number(value['version']),
          operation: 'upsert',
          snapshot: value,
        };
        const size = Buffer.byteLength(JSON.stringify(change));
        if (page.length && (page.length >= maxPageItems || bytes + size > maxPageBytes))
          await flush();
        page.push(change);
        bytes += size;
      };
      const settings = await postgres.v2Query('SELECT * FROM user_settings WHERE owner_id = $1', [
        ownerId,
      ]);
      if (!settings.rows[0]) throw new DomainError('AUTH_REQUIRED', '账户设置不可用');
      await append('settings', settings.rows[0]);
      // Stable keyset scans spool straight to persisted pages. Large accounts
      // never create a full mutable projection or a full in-memory snapshot.
      for (const [, [type, table]] of Object.entries(collections)) {
        let lastId: string | undefined;
        while (true) {
          const rank = table === 'notes' ? '' : ', rank::text AS rank';
          const after = lastId ? ' AND id > $2::uuid' : '';
          const values = lastId ? [ownerId, lastId] : [ownerId];
          const rows = await postgres.v2Query(
            `SELECT *${rank} FROM ${table} WHERE owner_id = $1 AND deleted_at IS NULL${after} ORDER BY id LIMIT ${table === 'notes' ? 50 : maxPageItems}`,
            values,
          );
          if (!rows.rows.length) break;
          for (const row of rows.rows) await append(type, row);
          lastId = String(rows.rows.at(-1)!['id']);
        }
      }
      await flush();
      await postgres.v2Query('UPDATE sync_bootstrap_snapshots SET page_count = $2 WHERE id = $1', [
        snapshotId,
        pageCount,
      ]);
      return { snapshotId, cursor, expiresAt, pageCount, protocolVersion: 2 };
    });
  }

  async detail(ownerId: string, id: string) {
    if (!(this.tree instanceof PostgresTreeStore)) return this.tree.getTaskDetails(ownerId, id);
    const postgres = this.tree.postgres;
    return postgres.v2ReadSnapshot(async () => {
      const tasks = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM tasks WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL',
        [ownerId, id],
      );
      if (!tasks.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '找不到任务');
      const task = dto(tasks.rows[0]);
      const notes = await postgres.v2Query(
        'SELECT * FROM notes WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL',
        [ownerId, id],
      );
      const steps = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM task_steps WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL ORDER BY task_steps.rank, id',
        [ownerId, id],
      );
      const placements = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM placements WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL ORDER BY placements.rank, id',
        [ownerId, id],
      );
      const memberships = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM workflow_task_memberships WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL ORDER BY workflow_task_memberships.rank, id',
        [ownerId, id],
      );
      const points = await postgres.v2Query(
        'SELECT *, rank::text AS rank FROM time_points WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
        [ownerId, placements.rows.map((p) => p['time_point_id'])],
      );
      const pointById = new Map(points.rows.map((p) => [p['id'], dto(p)]));
      const workflows = await postgres.v2Query(
        'SELECT id, name FROM workflows WHERE owner_id = $1 AND id = ANY($2::uuid[])',
        [ownerId, memberships.rows.map((m) => m['workflow_id'])],
      );
      const stages = await postgres.v2Query(
        'SELECT id, name FROM workflow_stages WHERE owner_id = $1 AND id = ANY($2::uuid[])',
        [ownerId, memberships.rows.map((m) => m['stage_id'])],
      );
      const workflowById = new Map(workflows.rows.map((w) => [w['id'], w]));
      const stageById = new Map(stages.rows.map((s) => [s['id'], s]));
      const path = await postgres.v2Query(
        'WITH RECURSIVE path AS (SELECT f.*, ARRAY[f.id] AS visited, 0 AS depth FROM folders f WHERE owner_id = $1 AND id = $2 UNION ALL SELECT f.*, path.visited || f.id, depth + 1 FROM folders f JOIN path ON f.id = path.parent_folder_id WHERE f.owner_id = $1 AND NOT f.id = ANY(path.visited)) SELECT * FROM path ORDER BY depth DESC',
        [ownerId, task['parentFolderId']],
      );
      if (!notes.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '找不到任务备注');
      return {
        task,
        note: dto(notes.rows[0]),
        steps: steps.rows.map(dto),
        placements: placements.rows.map((p) => ({
          ...dto(p),
          timePoint: pointById.get(p['time_point_id']),
        })),
        workflowMemberships: memberships.rows.map((m) => ({
          ...dto(m),
          workflow: workflowById.get(m['workflow_id']),
          stage: stageById.get(m['stage_id']),
        })),
        folderPath: path.rows.map((p) => ({ id: p['id'], title: p['title'] })),
      };
    });
  }

  async page(ownerId: string, id: string, page: number) {
    let cursor: string;
    let expiresAt: string;
    let pageCount: number;
    let items: BootstrapChange[] | undefined;
    if (this.tree instanceof PostgresTreeStore) {
      const rows = await this.tree.postgres.v2Query(
        'SELECT s.cursor::text, s.expires_at, s.page_count, p.payload FROM sync_bootstrap_snapshots s JOIN sync_bootstrap_pages p ON p.snapshot_id = s.id WHERE s.id = $1 AND s.owner_id = $2 AND p.page = $3 AND s.expires_at > now()',
        [id, ownerId, page],
      );
      const row = rows.rows[0];
      if (!row)
        throw new DomainError('SYNC_CURSOR_EXPIRED', '快照已过期或页面不可用，请重新开始同步');
      cursor = String(row['cursor']);
      expiresAt = new Date(String(row['expires_at'])).toISOString();
      pageCount = Number(row['page_count']);
      items = row['payload'] as BootstrapChange[];
    } else {
      const session = this.sessions.get(id);
      if (
        !session ||
        session.ownerId !== ownerId ||
        Date.parse(session.expiresAt) <= Date.now() ||
        !session.pages[page]
      )
        throw new DomainError('SYNC_CURSOR_EXPIRED', '快照已过期或页面不可用，请重新开始同步');
      ({ cursor, expiresAt } = session);
      pageCount = session.pages.length;
      items = session.pages[page];
    }
    return {
      snapshotId: id,
      cursor,
      expiresAt,
      page,
      pageCount,
      changes: items,
      nextPage: page + 1 < pageCount ? page + 1 : null,
      protocolVersion: 2,
    };
  }
}
