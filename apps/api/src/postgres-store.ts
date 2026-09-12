import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { databaseReady } from '@devtodo/database';
import {
  uuidSchema,
  uuidv7,
  type DeviceDto,
  type Mutation,
  type NoteDto,
  type PlacementDto,
  type ProjectDto,
  type ProjectTaskCountDto,
  type SettingsDto,
  type TaskCategory,
  type TaskDto,
  type TaskPriority,
  type TaskStatus,
  type TimePointDto,
  type TimePointPlacementCountDto,
  type TimePointType,
  type UserDto,
} from '@devtodo/contracts';
import {
  allocateReference,
  assertTaskPlacement,
  DomainError,
  nextLocalDate,
  ranksForIds,
  transitionTask,
  validateLocalDate,
} from '@devtodo/domain';
import type { Pool, PoolClient } from 'pg';
import type {
  DeviceRecord,
  NoteRecord,
  PlacementRecord,
  ProjectRecord,
  RefreshSessionRecord,
  RolloverRecord,
  SettingsRecord,
  Store,
  SyncChange,
  TaskFilters,
  TaskRecord,
  TimePointRecord,
  UserRecord,
} from './store.js';

type Row = Record<string, unknown>;
interface TxContext {
  client: PoolClient;
  pending: Map<string, string>;
}

export interface PostgresPage<T> {
  items: T[];
  nextCursor: string | null;
}

type PageCursor = {
  group: 'rank' | 'date' | 'event';
  value: string;
  id: string;
};

/**
 * The database adapter intentionally has no domain-table mirror. Reads are
 * owner-scoped SQL queries and every mutation, receipt, and change-feed row
 * is committed by the same PostgreSQL transaction.
 */
export class PostgresStore implements Store {
  private readonly tx = new AsyncLocalStorage<TxContext>();
  private readonly clock: () => Date;
  private readonly changeRetentionDays: number;
  private readonly mutationReceiptRetentionDays: number;
  private readonly listeners = new Set<(ownerId: string, cursor: string) => void>();
  private listener: PoolClient | null = null;
  private listenerReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private listenerConnecting = false;
  private poolErrorHandlerAttached = false;
  private closed = false;
  private ready = false;

  constructor(
    private readonly pool: Pool,
    options: {
      clock?: () => Date;
      changeRetentionDays?: number;
      mutationReceiptRetentionDays?: number;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.changeRetentionDays = options.changeRetentionDays ?? 90;
    this.mutationReceiptRetentionDays = options.mutationReceiptRetentionDays ?? 90;
  }

  async init(): Promise<void> {
    this.closed = false;
    this.attachPoolErrorHandler();
    if (!(await databaseReady(this.pool)))
      throw new Error('PostgreSQL schema is not ready; run the migrate job first');
    const listener = await this.pool.connect();
    try {
      await listener.query('LISTEN devtodo_sync_changes');
    } catch (error) {
      listener.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.listener = listener;
    this.attachListener(listener);
    this.ready = true;
  }

  private attachPoolErrorHandler(): void {
    if (this.poolErrorHandlerAttached) return;
    this.pool.on('error', this.handlePoolError);
    this.poolErrorHandlerAttached = true;
  }

  private readonly handlePoolError = (error: Error): void => {
    if (this.closed) return;
    this.ready = false;
    console.warn(
      JSON.stringify({
        event: 'postgres.pool_error',
        message: error.message,
        code: (error as Error & { code?: string }).code,
      }),
    );
  };

  private attachListener(listener: PoolClient): void {
    listener.on('notification', (message) => {
      if (message.channel !== 'devtodo_sync_changes') return;
      try {
        const payload = JSON.parse(message.payload ?? '') as {
          ownerId?: unknown;
          cursor?: unknown;
        };
        if (typeof payload.ownerId === 'string' && typeof payload.cursor === 'string')
          this.notify(payload.ownerId, payload.cursor);
      } catch {
        /* Notifications are advisory; the pull cursor remains authoritative. */
      }
    });
    listener.on('error', (error: Error) => this.handleListenerFailure(listener, error));
    listener.on('end', () => this.handleListenerFailure(listener));
  }

  private handleListenerFailure(listener: PoolClient, error?: Error): void {
    if (this.listener !== listener || this.closed) return;
    this.listener = null;
    if (error) {
      try {
        listener.release(error);
      } catch {
        /* The pool may already have removed a failed client. */
      }
    }
    this.scheduleListenerReconnect();
  }

  private scheduleListenerReconnect(): void {
    if (this.closed || this.listener || this.listenerReconnectTimer) return;
    this.listenerReconnectTimer = setTimeout(() => {
      this.listenerReconnectTimer = undefined;
      void this.reconnectListener();
    }, 1_000);
    this.listenerReconnectTimer.unref?.();
  }

  private async reconnectListener(): Promise<void> {
    if (this.closed || this.listener || this.listenerConnecting) return;
    this.listenerConnecting = true;
    try {
      const listener = await this.pool.connect();
      if (this.closed) {
        listener.release();
        return;
      }
      try {
        await listener.query('LISTEN devtodo_sync_changes');
      } catch (error) {
        listener.release(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      this.listener = listener;
      this.attachListener(listener);
    } catch (error) {
      console.warn(
        JSON.stringify({ event: 'sync.listener_reconnect_failed', message: String(error) }),
      );
      this.scheduleListenerReconnect();
    } finally {
      this.listenerConnecting = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async checkReady(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.listenerReconnectTimer) {
      clearTimeout(this.listenerReconnectTimer);
      this.listenerReconnectTimer = undefined;
    }
    if (this.listener) {
      try {
        await this.listener.query('UNLISTEN devtodo_sync_changes');
      } catch {
        /* Preserve shutdown even when the listener connection is already closed. */
      }
      this.listener.release();
      this.listener = null;
    }
    this.ready = false;
    if (this.poolErrorHandlerAttached) {
      this.pool.off('error', this.handlePoolError);
      this.poolErrorHandlerAttached = false;
    }
    await this.pool.end();
  }

  async createNativeChallenge(origin: string, expiresAt: string): Promise<string> {
    const id = uuidv7();
    await this.query(
      'INSERT INTO native_auth_challenges (id, origin, expires_at) VALUES ($1, $2, $3)',
      [id, origin, expiresAt],
    );
    return id;
  }

  async consumeNativeChallenge(id: string, origin: string): Promise<boolean> {
    const result = await this.query(
      'DELETE FROM native_auth_challenges WHERE id = $1 AND origin = $2 AND expires_at > now() RETURNING id',
      [id, origin],
    );
    return result.rowCount === 1;
  }

  async withMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    const nested = this.tx.getStore();
    if (nested) return await fn();
    const client = await this.pool.connect();
    const context: TxContext = { client, pending: new Map() };
    try {
      await client.query('BEGIN');
      const value = await this.tx.run(context, async () => {
        const result = await fn();
        const changeCleanup = await client.query(
          'DELETE FROM sync_changes WHERE seq IN (' +
            "SELECT seq FROM sync_changes WHERE committed_at < now() - ($1::double precision * interval '1 day') " +
            'ORDER BY seq LIMIT 1000) RETURNING seq',
          [this.changeRetentionDays],
        );
        const receiptCleanup = await client.query(
          'DELETE FROM client_mutations WHERE (owner_id, client_id, mutation_id) IN (' +
            'SELECT owner_id, client_id, mutation_id FROM client_mutations WHERE expires_at <= now() ' +
            'ORDER BY expires_at LIMIT 1000) RETURNING mutation_id',
        );
        const challengeCleanup = await client.query(
          'DELETE FROM native_auth_challenges WHERE expires_at <= now() ' + 'RETURNING id',
        );
        const cleanup = {
          syncChanges: changeCleanup.rowCount ?? 0,
          mutationReceipts: receiptCleanup.rowCount ?? 0,
          nativeChallenges: challengeCleanup.rowCount ?? 0,
        };
        if (cleanup.syncChanges || cleanup.mutationReceipts || cleanup.nativeChallenges)
          console.info(JSON.stringify({ event: 'maintenance.cleanup', ...cleanup }));
        for (const [ownerId, cursor] of context.pending)
          await client.query('SELECT pg_notify($1, $2)', [
            'devtodo_sync_changes',
            JSON.stringify({ ownerId, cursor }),
          ]);
        await client.query('COMMIT');
        return result;
      });
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the original error. */
      }
      if (error instanceof DomainError) throw error;
      throwSql(error, '数据库事务被拒绝', 'MUTATION_REJECTED');
    } finally {
      client.release();
    }
  }

  private async readSnapshot<T>(fn: () => T | Promise<T>): Promise<T> {
    const nested = this.tx.getStore();
    if (nested) return await fn();
    const client = await this.pool.connect();
    const context: TxContext = { client, pending: new Map() };
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await this.tx.run(context, fn);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the original error. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const client = this.tx.getStore()?.client ?? this.pool;
    return (await client.query(text, values)) as { rows: Row[]; rowCount: number | null };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async owner(ownerId: string, lock = false): Promise<UserRecord> {
    const result = await this.query(
      'SELECT id, username, password_hash, next_misc_task_number, created_at, updated_at, disabled_at ' +
        'FROM users WHERE id = $1' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId],
    );
    const row = result.rows[0];
    if (!row || row.disabled_at) throw new DomainError('AUTH_REQUIRED', '账户不可用');
    return userRecord(row);
  }

  private async lockOwner(ownerId: string): Promise<UserRecord> {
    return this.owner(ownerId, true);
  }

  async hasOwner(): Promise<boolean> {
    const result = await this.query('SELECT 1 FROM users WHERE disabled_at IS NULL LIMIT 1');
    return result.rowCount === 1;
  }

  async getUserRecord(ownerId: string): Promise<UserRecord> {
    return this.owner(ownerId);
  }

  async getUser(ownerId: string): Promise<UserDto> {
    return userDto(await this.owner(ownerId));
  }

  async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    const result = await this.query(
      'SELECT id, username, password_hash, next_misc_task_number, created_at, updated_at, disabled_at ' +
        'FROM users WHERE username = $1',
      [normalizeUsername(username)],
    );
    return result.rows[0] ? userRecord(result.rows[0]) : undefined;
  }

  async createOwner(username: string, passwordHash: string): Promise<UserDto> {
    await this.query("SELECT pg_advisory_xact_lock(hashtextextended('devtodo:bootstrap', 0))");
    if (await this.hasOwner())
      throw new DomainError('BOOTSTRAP_ALREADY_COMPLETED', 'Owner 已初始化');
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || normalizedUsername.length > 64)
      throw new DomainError('VALIDATION_FAILED', '用户名无效');
    const id = uuidv7();
    const now = this.now();
    try {
      const result = await this.query(
        'INSERT INTO users (id, username, password_hash, next_misc_task_number, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, 1, $4, $4) ' +
          'RETURNING id, username, password_hash, next_misc_task_number, created_at, updated_at, disabled_at',
        [id, normalizedUsername, passwordHash, now],
      );
      await this.query(
        'INSERT INTO user_settings ' +
          '(owner_id, timezone, week_starts_on, default_capture_target, version, created_at, updated_at) ' +
          "VALUES ($1, 'Asia/Shanghai', 1, 'GLOBAL_MISC', 1, $2, $2)",
        [id, now],
      );
      await this.appendChange(id, 'settings', id, 1, 'upsert', {
        ownerId: id,
        timezone: 'Asia/Shanghai',
        weekStartsOn: 1,
        defaultCaptureTarget: 'GLOBAL_MISC',
        version: 1,
        updatedAt: now,
      });
      return userDto(userRecord(result.rows[0]!));
    } catch (error) {
      throwSql(error, '用户名已存在或 Owner 初始化失败');
    }
  }

  async getSettings(ownerId: string): Promise<SettingsDto> {
    await this.owner(ownerId);
    return settingsDto(await this.settingsRecord(ownerId));
  }

  async updateSettings(
    ownerId: string,
    patch: Partial<Pick<SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>>,
    baseVersion: number,
  ): Promise<SettingsDto> {
    await this.lockOwner(ownerId);
    const current = await this.settingsRecord(ownerId, true);
    assertVersion(current.version, baseVersion, settingsDto(current));
    const timezone = patch.timezone ?? current.timezone;
    if (!isValidTimezone(timezone)) throw new DomainError('VALIDATION_FAILED', '无效的 IANA 时区');
    const weekStartsOn = patch.weekStartsOn ?? current.weekStartsOn;
    if (weekStartsOn !== 0 && weekStartsOn !== 1)
      throw new DomainError('VALIDATION_FAILED', '每周起始日无效');
    const defaultCaptureTarget = patch.defaultCaptureTarget ?? current.defaultCaptureTarget;
    if (!['GLOBAL_MISC', 'RECENT_CONTEXT'].includes(defaultCaptureTarget))
      throw new DomainError('VALIDATION_FAILED', '默认捕获位置无效');
    const result = await this.query(
      'UPDATE user_settings SET timezone = $2, week_starts_on = $3, default_capture_target = $4, ' +
        'version = version + 1, updated_at = $5 ' +
        'WHERE owner_id = $1 AND version = $6 ' +
        'RETURNING owner_id, timezone, week_starts_on, default_capture_target, version, created_at, updated_at, deleted_at',
      [ownerId, timezone, weekStartsOn, defaultCaptureTarget, this.now(), baseVersion],
    );
    if (!result.rows[0])
      throw new DomainError('VERSION_CONFLICT', '实体版本已变化', {
        server: settingsDto(await this.settingsRecord(ownerId)),
      });
    const next = settingsRecord(result.rows[0]);
    const dto = settingsDto(next);
    await this.appendChange(ownerId, 'settings', ownerId, next.version, 'upsert', dto);
    return dto;
  }

  async createDevice(
    ownerId: string,
    id: string | undefined,
    name: string,
    platform: string,
  ): Promise<DeviceDto> {
    await this.lockOwner(ownerId);
    const existing = id ? await this.deviceById(id) : undefined;
    if (existing && existing.ownerId !== ownerId)
      throw new DomainError('MUTATION_REJECTED', '设备 ID 已属于其他 Owner');
    const now = this.now();
    if (existing) {
      const result = await this.query(
        'UPDATE devices SET name = $2, platform = $3, last_seen_at = $4, revoked_at = NULL ' +
          'WHERE id = $1 RETURNING id, owner_id, name, platform, last_seen_at, created_at, revoked_at',
        [id, name, platform, now],
      );
      return deviceDto(deviceRecord(requireUpdatedRow(result, '设备版本已变化')));
    }
    try {
      const result = await this.query(
        'INSERT INTO devices (id, owner_id, name, platform, last_seen_at, created_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $5) ' +
          'RETURNING id, owner_id, name, platform, last_seen_at, created_at, revoked_at',
        [id ?? uuidv7(), ownerId, name, platform, now],
      );
      return deviceDto(deviceRecord(result.rows[0]!));
    } catch (error) {
      throwSql(error, '设备 ID 已存在');
    }
  }

  async getDevice(ownerId: string, id: string): Promise<DeviceRecord> {
    const device = await this.deviceById(id);
    if (!device || device.ownerId !== ownerId)
      throw new DomainError('AUTH_SESSION_REVOKED', '设备会话已撤销');
    return device;
  }

  async listDevices(ownerId: string): Promise<DeviceDto[]> {
    await this.owner(ownerId);
    const result = await this.query(
      'SELECT id, owner_id, name, platform, last_seen_at, created_at, revoked_at ' +
        'FROM devices WHERE owner_id = $1 ORDER BY last_seen_at DESC, id',
      [ownerId],
    );
    return result.rows.map((row) => deviceDto(deviceRecord(row)));
  }

  async revokeDevice(ownerId: string, id: string): Promise<void> {
    await this.lockOwner(ownerId);
    await this.getDevice(ownerId, id);
    const revokedAt = this.now();
    await this.query('UPDATE devices SET revoked_at = $3 WHERE owner_id = $1 AND id = $2', [
      ownerId,
      id,
      revokedAt,
    ]);
    await this.query(
      'UPDATE refresh_sessions SET revoked_at = $3 WHERE owner_id = $1 AND device_id = $2',
      [ownerId, id, revokedAt],
    );
  }

  async createSession(
    ownerId: string,
    deviceId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<RefreshSessionRecord> {
    const device = await this.getDevice(ownerId, deviceId);
    if (device.revokedAt) throw new DomainError('AUTH_SESSION_REVOKED', '设备会话已撤销');
    const result = await this.query(
      'INSERT INTO refresh_sessions ' +
        '(id, owner_id, device_id, token_hash, expires_at, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'RETURNING id, owner_id, device_id, token_hash, expires_at, replaced_by_id, used_at, revoked_at, created_at',
      [uuidv7(), ownerId, deviceId, tokenHash, expiresAt, this.now()],
    );
    return sessionRecord(result.rows[0]!);
  }

  async findSessionByHash(tokenHash: string): Promise<RefreshSessionRecord | undefined> {
    const result = await this.query(
      'SELECT id, owner_id, device_id, token_hash, expires_at, replaced_by_id, used_at, revoked_at, created_at ' +
        'FROM refresh_sessions WHERE token_hash = $1 FOR UPDATE',
      [tokenHash],
    );
    return result.rows[0] ? sessionRecord(result.rows[0]) : undefined;
  }

  async rotateSession(
    sessionId: string,
    nextTokenHash: string,
    expiresAt: string,
  ): Promise<{ session: RefreshSessionRecord; device: DeviceRecord }> {
    const result = await this.query(
      'SELECT id, owner_id, device_id, token_hash, expires_at, replaced_by_id, used_at, revoked_at, created_at ' +
        'FROM refresh_sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    );
    if (!result.rows[0]) throw new DomainError('AUTH_SESSION_REVOKED', '会话不存在或已撤销');
    const session = sessionRecord(result.rows[0]);
    const device = await this.getDevice(session.ownerId, session.deviceId);
    const next = await this.createSession(
      session.ownerId,
      session.deviceId,
      nextTokenHash,
      expiresAt,
    );
    const now = this.now();
    await this.query(
      'UPDATE refresh_sessions SET used_at = $2, replaced_by_id = $3 WHERE id = $1',
      [sessionId, now, next.id],
    );
    await this.query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [device.id, now]);
    return { session: next, device: { ...device, lastSeenAt: now } };
  }

  async revokeSessionChain(session: RefreshSessionRecord): Promise<void> {
    await this.query(
      'UPDATE refresh_sessions SET revoked_at = $3 ' +
        'WHERE owner_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [session.ownerId, session.deviceId, this.now()],
    );
  }

  async createProject(
    ownerId: string,
    name: string,
    taskPrefix: string,
    id?: string,
  ): Promise<ProjectDto> {
    await this.lockOwner(ownerId);
    const normalizedName = name.trim();
    const normalizedPrefix = taskPrefix.trim().toUpperCase();
    if (
      !normalizedName ||
      normalizedName.length > 160 ||
      !/^[A-Z][A-Z0-9]{1,9}$/.test(normalizedPrefix)
    )
      throw new DomainError('VALIDATION_FAILED', '项目名称或代号无效');
    const existing = await this.query(
      'SELECT 1 FROM projects WHERE owner_id = $1 AND task_prefix = $2 AND deleted_at IS NULL',
      [ownerId, normalizedPrefix],
    );
    if (existing.rowCount) throw new DomainError('VALIDATION_FAILED', '项目代号已存在');
    const result = await this.query(
      'INSERT INTO projects ' +
        '(id, owner_id, name, task_prefix, next_task_number, rank, version, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, 1, (SELECT COALESCE(MAX(rank), 0) + 1024 FROM projects WHERE owner_id = $2 AND deleted_at IS NULL), 1, $5, $5) ' +
        'RETURNING id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at',
      [newEntityId(id), ownerId, normalizedName, normalizedPrefix, this.now()],
    );
    const project = projectRecord(result.rows[0]!);
    const dto = projectDto(project);
    await this.appendChange(ownerId, 'project', project.id, 1, 'upsert', dto);
    return dto;
  }

  async listProjects(ownerId: string, archived = false): Promise<ProjectDto[]> {
    await this.owner(ownerId);
    const result = await this.query(
      'SELECT id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at ' +
        'FROM projects WHERE owner_id = $1 AND deleted_at IS NULL AND archived_at IS ' +
        (archived ? 'NOT ' : '') +
        'NULL ORDER BY rank, id',
      [ownerId],
    );
    return result.rows.map((row) => projectDto(projectRecord(row)));
  }

  async listProjectTaskCounts(ownerId: string, archived = false): Promise<ProjectTaskCountDto[]> {
    await this.owner(ownerId);
    const result = await this.query(
      'SELECT p.id AS project_id, ' +
        "COUNT(t.id) FILTER (WHERE t.status <> 'DONE')::int AS open_count, " +
        "COUNT(t.id) FILTER (WHERE t.status = 'DONE')::int AS done_count " +
        'FROM projects p ' +
        'LEFT JOIN tasks t ON t.owner_id = p.owner_id AND t.project_id = p.id ' +
        'AND t.deleted_at IS NULL AND t.archived_at IS NULL ' +
        'WHERE p.owner_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS ' +
        (archived ? 'NOT ' : '') +
        'NULL GROUP BY p.id, p.rank ORDER BY p.rank, p.id',
      [ownerId],
    );
    return result.rows.map((row) => ({
      projectId: String(row.project_id),
      openCount: Number(row.open_count),
      doneCount: Number(row.done_count),
    }));
  }

  async listProjectsPage(
    ownerId: string,
    archived = false,
    cursor?: string,
    limit = 100,
  ): Promise<PostgresPage<ProjectDto>> {
    const pageSize = checkedPageLimit(limit);
    await this.owner(ownerId);
    const values: unknown[] = [ownerId];
    const where = [
      'owner_id = $1',
      'deleted_at IS NULL',
      'archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL',
    ];
    const after = cursor ? requirePageCursor(cursor, 'rank') : undefined;
    if (after) appendRankCursor(where, values, 'rank', 'id', after);
    values.push(pageSize + 1);
    const result = await this.query(
      'SELECT id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at ' +
        'FROM projects WHERE ' +
        where.join(' AND ') +
        ' ORDER BY rank, id LIMIT $' +
        values.length,
      values,
    );
    return makePage(
      result.rows.map((row) => projectDto(projectRecord(row))),
      pageSize,
      (project) => rankPageCursor(project.rank, project.id),
    );
  }

  async getProject(ownerId: string, id: string, includeArchived = true): Promise<ProjectDto> {
    const project = await this.projectRecord(ownerId, id);
    if (!includeArchived && project.archivedAt)
      throw new DomainError('ENTITY_ARCHIVED', '项目已归档');
    return projectDto(project);
  }

  async updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; taskPrefix?: string },
    baseVersion: number,
  ): Promise<ProjectDto> {
    await this.lockOwner(ownerId);
    const project = await this.projectRecord(ownerId, id, true);
    assertVersion(project.version, baseVersion, projectDto(project));
    const name = patch.name === undefined ? project.name : patch.name.trim();
    const taskPrefix =
      patch.taskPrefix === undefined ? project.taskPrefix : patch.taskPrefix.trim().toUpperCase();
    if (!name || name.length > 160) throw new DomainError('VALIDATION_FAILED', '项目名称无效');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(taskPrefix))
      throw new DomainError('VALIDATION_FAILED', '项目代号无效');
    if (taskPrefix !== project.taskPrefix) {
      const task = await this.query(
        'SELECT 1 FROM tasks WHERE owner_id = $1 AND project_id = $2 AND deleted_at IS NULL LIMIT 1',
        [ownerId, id],
      );
      if (task.rowCount) throw new DomainError('VALIDATION_FAILED', '项目已有任务后不能修改代号');
      const duplicate = await this.query(
        'SELECT 1 FROM projects WHERE owner_id = $1 AND task_prefix = $2 AND id <> $3 AND deleted_at IS NULL',
        [ownerId, taskPrefix, id],
      );
      if (duplicate.rowCount) throw new DomainError('VALIDATION_FAILED', '项目代号无效或已存在');
    }
    const result = await this.query(
      'UPDATE projects SET name = $3, task_prefix = $4, version = version + 1, updated_at = $5 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $6 ' +
        'RETURNING id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at',
      [ownerId, id, name, taskPrefix, this.now(), baseVersion],
    );
    const next = projectRecord(requireUpdatedRow(result, '项目版本已变化'));
    const dto = projectDto(next);
    await this.appendChange(ownerId, 'project', id, next.version, 'upsert', dto);
    return dto;
  }

  async archiveProject(ownerId: string, id: string, baseVersion: number): Promise<ProjectDto> {
    return this.setProjectArchived(ownerId, id, baseVersion, true);
  }

  async restoreProject(ownerId: string, id: string, baseVersion: number): Promise<ProjectDto> {
    return this.setProjectArchived(ownerId, id, baseVersion, false);
  }

  private async setProjectArchived(
    ownerId: string,
    id: string,
    baseVersion: number,
    archived: boolean,
  ): Promise<ProjectDto> {
    await this.lockOwner(ownerId);
    const project = await this.projectRecord(ownerId, id, true);
    assertVersion(project.version, baseVersion, projectDto(project));
    const result = await this.query(
      'UPDATE projects SET archived_at = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at',
      [ownerId, id, archived ? this.now() : null, this.now(), baseVersion],
    );
    const next = projectRecord(requireUpdatedRow(result, '项目版本已变化'));
    const dto = projectDto(next);
    await this.appendChange(ownerId, 'project', id, next.version, 'upsert', dto);
    return dto;
  }

  async reorderProjects(ownerId: string, ids: string[]): Promise<ProjectDto[]> {
    await this.lockOwner(ownerId);
    ensureUnique(ids, '项目排序列表不能有重复项');
    const result = await this.query(
      'SELECT id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at ' +
        'FROM projects WHERE owner_id = $1 AND deleted_at IS NULL',
      [ownerId],
    );
    const projects = result.rows.map((row) => projectRecord(row));
    const active = projects.filter((project) => !project.archivedAt);
    if (active.length !== ids.length || active.some((project) => !ids.includes(project.id)))
      throw new DomainError('VALIDATION_FAILED', '项目排序列表必须包含整个活动列表');
    const byId = new Map(projects.map((project) => [project.id, project]));
    const ranks = ranksForIds(ids);
    for (const id of ids) {
      const next = await this.updateRankedProject(
        ownerId,
        byId.get(id)!,
        ranks.get(id)!.toString(),
      );
      byId.set(id, next);
    }
    return [...byId.values()]
      .filter((project) => !project.archivedAt)
      .sort(rankSort)
      .map(projectDto);
  }

  async createTask(
    ownerId: string,
    input: {
      id?: string;
      projectId?: string | null;
      category: TaskCategory;
      title: string;
      priority: TaskPriority;
    },
  ): Promise<TaskDto> {
    const user = await this.lockOwner(ownerId);
    const projectId = input.projectId ?? null;
    assertTaskPlacement(projectId, input.category);
    const project = projectId ? await this.projectRecord(ownerId, projectId, true) : null;
    if (project?.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '项目已归档');
    const title = input.title.trim();
    if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
    const number = project ? project.nextTaskNumber : user.nextMiscTaskNumber;
    const referenceId = allocateReference(project?.taskPrefix ?? 'MISC', number);
    const taskId = newEntityId(input.id);
    const noteId = uuidv7();
    const result = await this.query(
      'INSERT INTO tasks ' +
        '(id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 'TODO', $7, " +
        '(SELECT COALESCE(MAX(rank), 0) + 1024 FROM tasks WHERE owner_id = $2 AND project_id IS NOT DISTINCT FROM $3 AND category = $4 AND deleted_at IS NULL), ' +
        '1, $8, $8) ' +
        'RETURNING id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at',
      [taskId, ownerId, projectId, input.category, referenceId, title, input.priority, this.now()],
    );
    await this.query(
      'INSERT INTO notes (id, owner_id, task_id, content_markdown, version, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, '', 1, $4, $4)",
      [noteId, ownerId, taskId, this.now()],
    );
    if (project)
      await this.query(
        'UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = $1',
        [project.id],
      );
    else
      await this.query(
        'UPDATE users SET next_misc_task_number = next_misc_task_number + 1 WHERE id = $1',
        [ownerId],
      );
    const task = taskRecord(result.rows[0]!);
    await this.appendChange(ownerId, 'task', task.id, 1, 'upsert', taskDto(task));
    await this.appendChange(ownerId, 'note', noteId, 1, 'upsert', {
      id: noteId,
      taskId,
      contentMarkdown: '',
      version: 1,
      updatedAt: task.createdAt,
    });
    return taskDto(task);
  }

  async listTasks(ownerId: string, filters: TaskFilters = {}): Promise<TaskDto[]> {
    await this.owner(ownerId);
    const values: unknown[] = [ownerId];
    const where = ['t.owner_id = $1', 't.deleted_at IS NULL'];
    if (filters.projectId !== undefined) {
      if (filters.projectId === null) where.push('t.project_id IS NULL');
      else {
        values.push(filters.projectId);
        where.push('t.project_id = $' + values.length);
      }
    }
    if (filters.category) {
      values.push(filters.category);
      where.push('t.category = $' + values.length);
    }
    if (filters.status) {
      values.push(filters.status);
      where.push('t.status = $' + values.length);
    }
    if (filters.archived !== undefined)
      where.push('t.archived_at IS ' + (filters.archived ? 'NOT ' : '') + 'NULL');
    if (filters.timePointId) {
      values.push(filters.timePointId);
      where.push(
        'EXISTS (SELECT 1 FROM placements p WHERE p.owner_id = t.owner_id AND p.task_id = t.id AND p.time_point_id = $' +
          values.length +
          ' AND p.deleted_at IS NULL)',
      );
    }
    const result = await this.query(
      'SELECT t.id, t.owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, ' +
        't.rank, t.version, t.completed_at, t.archived_at, t.created_at, t.updated_at, t.deleted_at ' +
        'FROM tasks t WHERE ' +
        where.join(' AND ') +
        ' ORDER BY t.rank, t.id',
      values,
    );
    return result.rows.map((row) => taskDto(taskRecord(row)));
  }

  async listTasksPage(
    ownerId: string,
    filters: TaskFilters = {},
    cursor?: string,
    limit = 100,
  ): Promise<PostgresPage<TaskDto>> {
    const pageSize = checkedPageLimit(limit);
    await this.owner(ownerId);
    const values: unknown[] = [ownerId];
    const where = ['t.owner_id = $1', 't.deleted_at IS NULL'];
    if (filters.projectId !== undefined) {
      if (filters.projectId === null) where.push('t.project_id IS NULL');
      else {
        values.push(filters.projectId);
        where.push('t.project_id = $' + values.length);
      }
    }
    if (filters.category) {
      values.push(filters.category);
      where.push('t.category = $' + values.length);
    }
    if (filters.status) {
      values.push(filters.status);
      where.push('t.status = $' + values.length);
    }
    if (filters.archived !== undefined)
      where.push('t.archived_at IS ' + (filters.archived ? 'NOT ' : '') + 'NULL');
    if (filters.timePointId) {
      values.push(filters.timePointId);
      where.push(
        'EXISTS (SELECT 1 FROM placements p WHERE p.owner_id = t.owner_id AND p.task_id = t.id AND p.time_point_id = $' +
          values.length +
          ' AND p.deleted_at IS NULL)',
      );
    }
    const after = cursor ? requirePageCursor(cursor, 'rank') : undefined;
    if (after) appendRankCursor(where, values, 't.rank', 't.id', after);
    values.push(pageSize + 1);
    const result = await this.query(
      'SELECT t.id, t.owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, ' +
        't.rank, t.version, t.completed_at, t.archived_at, t.created_at, t.updated_at, t.deleted_at ' +
        'FROM tasks t WHERE ' +
        where.join(' AND ') +
        ' ORDER BY t.rank, t.id LIMIT $' +
        values.length,
      values,
    );
    return makePage(
      result.rows.map((row) => taskDto(taskRecord(row))),
      pageSize,
      (task) => rankPageCursor(task.rank, task.id),
    );
  }

  async getTask(ownerId: string, id: string, includeArchived = true): Promise<TaskDto> {
    const task = await this.taskRecord(ownerId, id);
    if (!includeArchived && task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    return taskDto(task);
  }

  async getTaskDetails(
    ownerId: string,
    id: string,
  ): Promise<{
    task: TaskDto;
    note: NoteDto;
    placements: PlacementDto[];
  }> {
    const task = await this.getTask(ownerId, id);
    const note = await this.getNote(ownerId, id);
    const result = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL ORDER BY rank, id',
      [ownerId, id],
    );
    return {
      task,
      note,
      placements: result.rows.map((row) => placementDto(placementRecord(row))),
    };
  }

  async updateTask(
    ownerId: string,
    id: string,
    patch: {
      title?: string;
      projectId?: string | null;
      category?: TaskCategory;
      status?: TaskStatus;
      priority?: TaskPriority;
      rank?: string;
    },
    baseVersion: number,
  ): Promise<TaskDto> {
    await this.lockOwner(ownerId);
    const task = await this.taskRecord(ownerId, id, true);
    assertVersion(task.version, baseVersion, taskDto(task));
    const projectId = patch.projectId === undefined ? task.projectId : patch.projectId;
    const category = patch.category ?? task.category;
    assertTaskPlacement(projectId, category);
    const project = projectId ? await this.projectRecord(ownerId, projectId, true) : null;
    if (project?.archivedAt && projectId !== task.projectId)
      throw new DomainError('ENTITY_ARCHIVED', '不能移入已归档项目');
    const title = patch.title === undefined ? task.title : patch.title.trim();
    if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
    const priority = patch.priority ?? task.priority;
    const rank = patch.rank ?? task.rank;
    if (!/^\d+$/.test(rank) || BigInt(rank) < 1n)
      throw new DomainError('VALIDATION_FAILED', 'rank 无效');
    let status = task.status;
    let completedAt = task.completedAt;
    if (patch.status !== undefined && patch.status !== task.status) {
      const transition = transitionTask(task.status, patch.status, new Date(this.now()));
      status = transition.status;
      completedAt = transition.completedAt?.toISOString() ?? null;
    }
    const result = await this.query(
      'UPDATE tasks SET project_id = $3, category = $4, title = $5, status = $6, priority = $7, ' +
        'rank = $8, completed_at = $9, version = version + 1, updated_at = $10 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $11 ' +
        'RETURNING id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at',
      [
        ownerId,
        id,
        projectId,
        category,
        title,
        status,
        priority,
        rank,
        completedAt,
        this.now(),
        baseVersion,
      ],
    );
    const next = taskRecord(requireUpdatedRow(result, '任务版本已变化'));
    const dto = taskDto(next);
    await this.appendChange(ownerId, 'task', id, next.version, 'upsert', dto);
    return dto;
  }

  async archiveTask(ownerId: string, id: string, baseVersion: number): Promise<TaskDto> {
    return this.setTaskArchived(ownerId, id, baseVersion, true);
  }

  async restoreTask(ownerId: string, id: string, baseVersion: number): Promise<TaskDto> {
    return this.setTaskArchived(ownerId, id, baseVersion, false);
  }

  private async setTaskArchived(
    ownerId: string,
    id: string,
    baseVersion: number,
    archived: boolean,
  ): Promise<TaskDto> {
    await this.lockOwner(ownerId);
    const task = await this.taskRecord(ownerId, id, true);
    assertVersion(task.version, baseVersion, taskDto(task));
    const result = await this.query(
      'UPDATE tasks SET archived_at = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at',
      [ownerId, id, archived ? this.now() : null, this.now(), baseVersion],
    );
    const next = taskRecord(requireUpdatedRow(result, '任务版本已变化'));
    const dto = taskDto(next);
    await this.appendChange(ownerId, 'task', id, next.version, 'upsert', dto);
    return dto;
  }

  async reorderTasks(ownerId: string, ids: string[]): Promise<TaskDto[]> {
    await this.lockOwner(ownerId);
    ensureUnique(ids, '任务排序列表不能有重复项');
    if (ids.length === 0) return [];
    const result = await this.query(
      'SELECT id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM tasks WHERE owner_id = $1 AND deleted_at IS NULL',
      [ownerId],
    );
    const tasks = result.rows.map((row) => taskRecord(row));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const selected = ids.map((id) => byId.get(id));
    const first = selected[0];
    if (
      !first ||
      selected.some(
        (task) => !task || task.projectId !== first.projectId || task.category !== first.category,
      )
    )
      throw new DomainError('VALIDATION_FAILED', '只能在同一任务分组内排序');
    const expected = tasks.filter(
      (task) =>
        !task.archivedAt && task.projectId === first.projectId && task.category === first.category,
    );
    if (expected.length !== ids.length || expected.some((task) => !ids.includes(task.id)))
      throw new DomainError('VALIDATION_FAILED', '任务排序列表必须包含整个活动分组');
    const ranks = ranksForIds(ids);
    for (const id of ids) {
      const next = await this.updateRankedTask(ownerId, byId.get(id)!, ranks.get(id)!.toString());
      byId.set(id, next);
    }
    return [...byId.values()]
      .filter(
        (task) =>
          !task.archivedAt &&
          task.projectId === first.projectId &&
          task.category === first.category,
      )
      .sort(rankSort)
      .map(taskDto);
  }

  async duplicateTask(
    ownerId: string,
    id: string,
    requestedIds: { taskId?: string; noteId?: string } = {},
  ): Promise<{ task: TaskDto; note: NoteDto }> {
    const user = await this.lockOwner(ownerId);
    const source = await this.taskRecord(ownerId, id, true);
    const project = source.projectId
      ? await this.projectRecord(ownerId, source.projectId, true)
      : null;
    const number = project ? project.nextTaskNumber : user.nextMiscTaskNumber;
    const taskId = newEntityId(requestedIds.taskId);
    const noteId = newEntityId(requestedIds.noteId);
    const sourceNote = await this.findNoteRecord(ownerId, id);
    const result = await this.query(
      'INSERT INTO tasks ' +
        '(id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 'TODO', $7, " +
        '(SELECT COALESCE(MAX(rank), 0) + 1024 FROM tasks WHERE owner_id = $2 AND project_id IS NOT DISTINCT FROM $3 AND category = $4 AND deleted_at IS NULL), ' +
        '1, $8, $8) ' +
        'RETURNING id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at',
      [
        taskId,
        ownerId,
        source.projectId,
        source.category,
        allocateReference(project?.taskPrefix ?? 'MISC', number),
        source.title,
        source.priority,
        this.now(),
      ],
    );
    const noteResult = await this.query(
      'INSERT INTO notes (id, owner_id, task_id, content_markdown, version, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, 1, $5, $5) ' +
        'RETURNING id, owner_id, task_id, content_markdown, version, created_at, updated_at, deleted_at',
      [noteId, ownerId, taskId, sourceNote?.contentMarkdown ?? '', this.now()],
    );
    if (project)
      await this.query(
        'UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = $1',
        [project.id],
      );
    else
      await this.query(
        'UPDATE users SET next_misc_task_number = next_misc_task_number + 1 WHERE id = $1',
        [ownerId],
      );
    const task = taskRecord(result.rows[0]!);
    const note = noteRecord(noteResult.rows[0]!);
    await this.appendChange(ownerId, 'task', task.id, 1, 'upsert', taskDto(task));
    await this.appendChange(ownerId, 'note', note.id, 1, 'upsert', noteDto(note));
    return { task: taskDto(task), note: noteDto(note) };
  }

  async getNote(ownerId: string, taskId: string): Promise<NoteDto> {
    await this.taskRecord(ownerId, taskId);
    const note = await this.findNoteRecord(ownerId, taskId);
    if (!note) throw new DomainError('ENTITY_NOT_FOUND', '备注不存在');
    return noteDto(note);
  }

  async updateNote(
    ownerId: string,
    taskId: string,
    contentMarkdown: string,
    baseVersion: number,
  ): Promise<NoteDto> {
    await this.lockOwner(ownerId);
    await this.taskRecord(ownerId, taskId, true);
    const note = await this.findNoteRecord(ownerId, taskId, true);
    if (!note) throw new DomainError('ENTITY_NOT_FOUND', '备注不存在');
    assertVersion(note.version, baseVersion, noteDto(note));
    if (contentMarkdown.length > 1024 * 1024)
      throw new DomainError('VALIDATION_FAILED', '备注超过 1 MiB');
    const result = await this.query(
      'UPDATE notes SET content_markdown = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND task_id = $2 AND version = $5 AND deleted_at IS NULL ' +
        'RETURNING id, owner_id, task_id, content_markdown, version, created_at, updated_at, deleted_at',
      [ownerId, taskId, contentMarkdown, this.now(), baseVersion],
    );
    const next = noteRecord(requireUpdatedRow(result, '备注版本已变化'));
    const dto = noteDto(next);
    await this.appendChange(ownerId, 'note', next.id, next.version, 'upsert', dto);
    return dto;
  }

  async createDate(ownerId: string, localDate: string, id?: string): Promise<TimePointDto> {
    validateLocalDate(localDate);
    await this.lockOwner(ownerId);
    const existing = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        "FROM time_points WHERE owner_id = $1 AND type = 'DATE' AND local_date = $2 AND deleted_at IS NULL",
      [ownerId, localDate],
    );
    if (existing.rows[0]) return timePointDto(timePointRecord(existing.rows[0]));
    return this.createTimePoint(ownerId, { type: 'DATE', localDate, id });
  }

  async createEvent(ownerId: string, title: string, id?: string): Promise<TimePointDto> {
    return this.createTimePoint(ownerId, { type: 'EVENT', title, id });
  }

  private async createTimePoint(
    ownerId: string,
    input: { type: TimePointType; localDate?: string; title?: string; id?: string },
  ): Promise<TimePointDto> {
    await this.lockOwner(ownerId);
    if (input.type === 'DATE') {
      if (!input.localDate) throw new DomainError('VALIDATION_FAILED', '日期不能为空');
      validateLocalDate(input.localDate);
    }
    const title = input.title?.trim() ?? null;
    if (input.type === 'EVENT' && (!title || title.length > 200))
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    const result = await this.query(
      'INSERT INTO time_points (id, owner_id, type, local_date, title, rank, version, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, ' +
        "(SELECT COALESCE(MAX(rank), 0) + 1024 FROM time_points WHERE owner_id = $2 AND type = 'EVENT' AND deleted_at IS NULL), " +
        '1, $6, $6) ' +
        (input.type === 'DATE'
          ? "ON CONFLICT (owner_id, local_date) WHERE type = 'DATE' AND deleted_at IS NULL DO NOTHING "
          : '') +
        'RETURNING id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at',
      [newEntityId(input.id), ownerId, input.type, input.localDate ?? null, title, this.now()],
    );
    if (!result.rows[0] && input.type === 'DATE') {
      const existing = await this.query(
        'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
          "FROM time_points WHERE owner_id = $1 AND type = 'DATE' AND local_date = $2 AND deleted_at IS NULL",
        [ownerId, input.localDate],
      );
      if (existing.rows[0]) return timePointDto(timePointRecord(existing.rows[0]));
    }
    const point = timePointRecord(requireInsertedRow(result, '时间点创建失败'));
    const dto = timePointDto(point);
    await this.appendChange(ownerId, 'timePoint', point.id, 1, 'upsert', dto);
    return dto;
  }

  async listTimePoints(
    ownerId: string,
    type?: TimePointType,
    archived?: boolean,
  ): Promise<TimePointDto[]> {
    await this.owner(ownerId);
    const values: unknown[] = [ownerId];
    const where = ['owner_id = $1', 'deleted_at IS NULL'];
    if (type) {
      values.push(type);
      where.push('type = $' + values.length);
    }
    if (archived !== undefined) where.push('archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL');
    const result = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM time_points WHERE ' +
        where.join(' AND ') +
        " ORDER BY CASE WHEN type = 'DATE' THEN 0 ELSE 1 END, local_date NULLS LAST, rank, id",
      values,
    );
    return result.rows.map((row) => timePointDto(timePointRecord(row)));
  }

  async listTimePointPlacementCounts(
    ownerId: string,
    type: TimePointType,
    archived?: boolean,
    fromDate?: string,
    toDate?: string,
  ): Promise<TimePointPlacementCountDto[]> {
    await this.owner(ownerId);
    const values: unknown[] = [ownerId, type];
    const where = ['tp.owner_id = $1', 'tp.type = $2', 'tp.deleted_at IS NULL'];
    if (archived !== undefined)
      where.push('tp.archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL');
    if (fromDate !== undefined) {
      values.push(fromDate);
      where.push('tp.local_date >= $' + values.length + '::date');
    }
    if (toDate !== undefined) {
      values.push(toDate);
      where.push('tp.local_date <= $' + values.length + '::date');
    }
    const result = await this.query(
      'SELECT tp.id AS time_point_id, tp.local_date, ' +
        'COUNT(t.id)::int AS total_count, ' +
        "COUNT(t.id) FILTER (WHERE t.status <> 'DONE')::int AS open_count, " +
        "COUNT(t.id) FILTER (WHERE t.status = 'DONE')::int AS done_count " +
        'FROM time_points tp ' +
        'LEFT JOIN placements p ON p.owner_id = tp.owner_id AND p.time_point_id = tp.id ' +
        'AND p.deleted_at IS NULL ' +
        'LEFT JOIN tasks t ON t.owner_id = p.owner_id AND t.id = p.task_id ' +
        'AND t.deleted_at IS NULL AND t.archived_at IS NULL ' +
        'WHERE ' +
        where.join(' AND ') +
        ' GROUP BY tp.id, tp.local_date ' +
        "ORDER BY CASE WHEN tp.type = 'DATE' THEN 0 ELSE 1 END, tp.local_date NULLS LAST, tp.id",
      values,
    );
    return result.rows.map((row) => ({
      timePointId: String(row.time_point_id),
      localDate: localDateValue(row.local_date),
      totalCount: Number(row.total_count),
      openCount: Number(row.open_count),
      doneCount: Number(row.done_count),
    }));
  }

  async listTimePointsPage(
    ownerId: string,
    type?: TimePointType,
    archived?: boolean,
    cursor?: string,
    limit = 100,
  ): Promise<PostgresPage<TimePointDto>> {
    const pageSize = checkedPageLimit(limit);
    await this.owner(ownerId);
    const values: unknown[] = [ownerId];
    const where = ['owner_id = $1', 'deleted_at IS NULL'];
    if (type) {
      values.push(type);
      where.push('type = $' + values.length);
    }
    if (archived !== undefined) where.push('archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL');
    const after = cursor ? requirePageCursor(cursor) : undefined;
    if (after) {
      if (type) {
        if (type === 'DATE') appendDateCursor(where, values, after);
        else appendEventCursor(where, values, after);
      } else if (after.group === 'date') {
        const dateIndex = values.push(after.value);
        const idIndex = values.push(after.id);
        where.push(
          "(type = 'EVENT' OR (type = 'DATE' AND (local_date > $" +
            dateIndex +
            '::date OR (local_date = $' +
            dateIndex +
            '::date AND id > $' +
            idIndex +
            '))))',
        );
      } else {
        appendEventCursor(where, values, after);
      }
    }
    values.push(pageSize + 1);
    const result = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM time_points WHERE ' +
        where.join(' AND ') +
        " ORDER BY CASE WHEN type = 'DATE' THEN 0 ELSE 1 END, local_date NULLS LAST, rank, id LIMIT $" +
        values.length,
      values,
    );
    return makePage(
      result.rows.map((row) => timePointDto(timePointRecord(row))),
      pageSize,
      (point) =>
        point.type === 'DATE'
          ? datePageCursor(point.localDate ?? '', point.id)
          : rankPageCursor(point.rank, point.id, 'event'),
    );
  }

  async getTimePoint(ownerId: string, id: string): Promise<TimePointDto> {
    return timePointDto(await this.timePointRecord(ownerId, id));
  }

  async updateTimePoint(
    ownerId: string,
    id: string,
    title: string,
    baseVersion: number,
  ): Promise<TimePointDto> {
    await this.lockOwner(ownerId);
    const point = await this.timePointRecord(ownerId, id, true);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不可改名');
    assertVersion(point.version, baseVersion, timePointDto(point));
    const normalized = title.trim();
    if (!normalized || normalized.length > 200)
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    return this.updateTimePointRow(ownerId, point, normalized, point.archivedAt);
  }

  async reachTimePoint(ownerId: string, id: string, baseVersion: number): Promise<TimePointDto> {
    await this.lockOwner(ownerId);
    const point = await this.timePointRecord(ownerId, id, true);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期没有到达状态');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    assertVersion(point.version, baseVersion, timePointDto(point));
    const result = await this.query(
      'UPDATE time_points SET reached_at = COALESCE(reached_at, $3), version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at',
      [ownerId, id, this.now(), this.now(), baseVersion],
    );
    const next = timePointRecord(requireUpdatedRow(result, '时间点版本已变化'));
    const dto = timePointDto(next);
    await this.appendChange(ownerId, 'timePoint', id, next.version, 'upsert', dto);
    return dto;
  }

  async archiveTimePoint(ownerId: string, id: string, baseVersion: number): Promise<TimePointDto> {
    return this.setTimePointArchived(ownerId, id, baseVersion, true);
  }

  async restoreTimePoint(ownerId: string, id: string, baseVersion: number): Promise<TimePointDto> {
    return this.setTimePointArchived(ownerId, id, baseVersion, false);
  }

  private async setTimePointArchived(
    ownerId: string,
    id: string,
    baseVersion: number,
    archived: boolean,
  ): Promise<TimePointDto> {
    await this.lockOwner(ownerId);
    const point = await this.timePointRecord(ownerId, id, true);
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不能归档');
    assertVersion(point.version, baseVersion, timePointDto(point));
    return this.updateTimePointRow(ownerId, point, point.title, archived ? this.now() : null);
  }

  async reorderEvents(ownerId: string, ids: string[]): Promise<TimePointDto[]> {
    await this.lockOwner(ownerId);
    ensureUnique(ids, '时间点排序列表不能有重复项');
    const result = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        "FROM time_points WHERE owner_id = $1 AND type = 'EVENT' AND deleted_at IS NULL",
      [ownerId],
    );
    const points = result.rows.map((row) => timePointRecord(row));
    const active = points.filter((point) => !point.archivedAt);
    if (active.length !== ids.length || active.some((point) => !ids.includes(point.id)))
      throw new DomainError('VALIDATION_FAILED', '时间点排序列表必须包含整个活动列表');
    const byId = new Map(points.map((point) => [point.id, point]));
    const ranks = ranksForIds(ids);
    for (const id of ids) {
      const next = await this.updateRankedTimePoint(
        ownerId,
        byId.get(id)!,
        ranks.get(id)!.toString(),
      );
      byId.set(id, next);
    }
    return [...byId.values()]
      .filter((point) => !point.archivedAt)
      .sort(rankSort)
      .map(timePointDto);
  }

  async addPlacement(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): Promise<{ placement: PlacementDto; existed: boolean }> {
    await this.lockOwner(ownerId);
    return this.addPlacementInTransaction(ownerId, taskId, timePointId, id);
  }

  private async addPlacementInTransaction(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): Promise<{ placement: PlacementDto; existed: boolean }> {
    const task = await this.taskRecord(ownerId, taskId, true);
    const point = await this.timePointRecord(ownerId, timePointId, true);
    if (task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND task_id = $2 AND time_point_id = $3 AND deleted_at IS NULL',
      [ownerId, taskId, timePointId],
    );
    if (existing.rows[0])
      return { placement: placementDto(placementRecord(existing.rows[0])), existed: true };
    const result = await this.query(
      'INSERT INTO placements (id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, ' +
        '(SELECT COALESCE(MAX(rank), 0) + 1024 FROM placements WHERE owner_id = $2 AND time_point_id = $4 AND deleted_at IS NULL), ' +
        '1, $5, $5) ' +
        'ON CONFLICT (task_id, time_point_id) WHERE deleted_at IS NULL DO NOTHING ' +
        'RETURNING id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at',
      [newEntityId(id), ownerId, taskId, timePointId, this.now()],
    );
    if (!result.rows[0]) {
      const concurrent = await this.query(
        'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
          'FROM placements WHERE owner_id = $1 AND task_id = $2 AND time_point_id = $3 AND deleted_at IS NULL',
        [ownerId, taskId, timePointId],
      );
      if (concurrent.rows[0])
        return { placement: placementDto(placementRecord(concurrent.rows[0])), existed: true };
    }
    const placement = placementRecord(requireInsertedRow(result, '安排创建失败'));
    const dto = placementDto(placement);
    await this.appendChange(ownerId, 'placement', placement.id, 1, 'upsert', dto);
    return { placement: dto, existed: false };
  }

  async listPlacements(
    ownerId: string,
    timePointId: string,
  ): Promise<Array<PlacementDto & { task: TaskDto }>> {
    await this.timePointRecord(ownerId, timePointId);
    const result = await this.query(
      'SELECT p.id, p.owner_id, p.task_id, p.time_point_id, p.rank, p.version, p.created_at, p.updated_at, p.deleted_at, ' +
        't.id AS task_id_value, t.owner_id AS task_owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, ' +
        't.rank AS task_rank, t.version AS task_version, t.completed_at, t.archived_at, t.created_at AS task_created_at, t.updated_at AS task_updated_at, t.deleted_at AS task_deleted_at ' +
        'FROM placements p JOIN tasks t ON t.owner_id = p.owner_id AND t.id = p.task_id ' +
        'WHERE p.owner_id = $1 AND p.time_point_id = $2 AND p.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY p.rank, p.id',
      [ownerId, timePointId],
    );
    return result.rows.map((row) => ({
      ...placementDto(placementRecord(row)),
      task: taskDto(taskRecordFromJoin(row)),
    }));
  }

  async listPlacementsPage(
    ownerId: string,
    timePointId: string,
    cursor?: string,
    limit = 100,
  ): Promise<PostgresPage<PlacementDto & { task: TaskDto }>> {
    const pageSize = checkedPageLimit(limit);
    await this.timePointRecord(ownerId, timePointId);
    const values: unknown[] = [ownerId, timePointId];
    const where = [
      'p.owner_id = $1',
      'p.time_point_id = $2',
      'p.deleted_at IS NULL',
      't.deleted_at IS NULL',
    ];
    const after = cursor ? requirePageCursor(cursor, 'rank') : undefined;
    if (after) appendRankCursor(where, values, 'p.rank', 'p.id', after);
    values.push(pageSize + 1);
    const result = await this.query(
      'SELECT p.id, p.owner_id, p.task_id, p.time_point_id, p.rank, p.version, p.created_at, p.updated_at, p.deleted_at, ' +
        't.id AS task_id_value, t.owner_id AS task_owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, ' +
        't.rank AS task_rank, t.version AS task_version, t.completed_at, t.archived_at, t.created_at AS task_created_at, t.updated_at AS task_updated_at, t.deleted_at AS task_deleted_at ' +
        'FROM placements p JOIN tasks t ON t.owner_id = p.owner_id AND t.id = p.task_id ' +
        'WHERE ' +
        where.join(' AND ') +
        ' ORDER BY p.rank, p.id LIMIT $' +
        values.length,
      values,
    );
    return makePage(
      result.rows.map((row) => ({
        ...placementDto(placementRecord(row)),
        task: taskDto(taskRecordFromJoin(row)),
      })),
      pageSize,
      (placement) => rankPageCursor(placement.rank, placement.id),
    );
  }

  async removePlacement(ownerId: string, id: string, baseVersion: number): Promise<PlacementDto> {
    await this.lockOwner(ownerId);
    const placement = await this.placementRecord(ownerId, id);
    assertVersion(placement.version, baseVersion, placementDto(placement));
    const result = await this.query(
      'UPDATE placements SET deleted_at = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 AND deleted_at IS NULL ' +
        'RETURNING id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at',
      [ownerId, id, this.now(), this.now(), baseVersion],
    );
    const next = placementRecord(requireUpdatedRow(result, '安排版本已变化'));
    await this.appendChange(ownerId, 'placement', id, next.version, 'delete', null);
    return placementDto(next);
  }

  async movePlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    baseVersion: number,
    targetPlacementId?: string,
  ): Promise<{ placement: PlacementDto; sourcePlacementId: string; existed: boolean }> {
    await this.lockOwner(ownerId);
    const source = await this.placementRecord(ownerId, id);
    assertVersion(source.version, baseVersion, placementDto(source));
    const target = await this.timePointRecord(ownerId, targetTimePointId, true);
    if (source.timePointId === targetTimePointId)
      throw new DomainError('VALIDATION_FAILED', '安排已经位于目标时间点');
    if (target.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND task_id = $2 AND time_point_id = $3 AND deleted_at IS NULL',
      [ownerId, source.taskId, targetTimePointId],
    );
    let placement: PlacementDto;
    let existed = false;
    if (existing.rows[0]) {
      placement = placementDto(placementRecord(existing.rows[0]));
      existed = true;
    } else {
      placement = (
        await this.addPlacementInTransaction(
          ownerId,
          source.taskId,
          targetTimePointId,
          targetPlacementId,
        )
      ).placement;
    }
    const result = await this.query(
      'UPDATE placements SET deleted_at = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 AND deleted_at IS NULL ' +
        'RETURNING id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at',
      [ownerId, id, this.now(), this.now(), baseVersion],
    );
    const deleted = placementRecord(requireUpdatedRow(result, '安排版本已变化'));
    await this.appendChange(ownerId, 'placement', id, deleted.version, 'delete', null);
    return { placement, sourcePlacementId: id, existed };
  }

  async copyPlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    targetPlacementId?: string,
  ): Promise<{ placement: PlacementDto; existed: boolean }> {
    await this.lockOwner(ownerId);
    const source = await this.placementRecord(ownerId, id);
    return this.addPlacementInTransaction(
      ownerId,
      source.taskId,
      targetTimePointId,
      targetPlacementId,
    );
  }

  async reorderPlacements(
    ownerId: string,
    timePointId: string,
    ids: string[],
  ): Promise<PlacementDto[]> {
    await this.lockOwner(ownerId);
    await this.timePointRecord(ownerId, timePointId, true);
    ensureUnique(ids, '安排排序列表不能有重复项');
    const result = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND time_point_id = $2 AND deleted_at IS NULL',
      [ownerId, timePointId],
    );
    const placements = result.rows.map((row) => placementRecord(row));
    if (
      placements.length !== ids.length ||
      placements.some((placement) => !ids.includes(placement.id))
    )
      throw new DomainError('VALIDATION_FAILED', '安排排序列表必须包含整个时间点列表');
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    const ranks = ranksForIds(ids);
    for (const id of ids) {
      const next = await this.updateRankedPlacement(
        ownerId,
        byId.get(id)!,
        ranks.get(id)!.toString(),
      );
      byId.set(id, next);
    }
    return [...byId.values()].sort(rankSort).map(placementDto);
  }

  async rollover(
    ownerId: string,
    sourceDate: string,
  ): Promise<{
    operationId: string;
    createdIds: string[];
    skippedTaskIds: string[];
    targetDate: string;
  }> {
    validateLocalDate(sourceDate);
    await this.lockOwner(ownerId);
    const targetDate = nextLocalDate(sourceDate);
    const source = await this.createDate(ownerId, sourceDate);
    const target = await this.createDate(ownerId, targetDate);
    const result = await this.query(
      'SELECT p.id, p.owner_id, p.task_id, p.time_point_id, p.rank, p.version, p.created_at, p.updated_at, p.deleted_at, ' +
        't.id AS task_id_value, t.owner_id AS task_owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, ' +
        't.rank AS task_rank, t.version AS task_version, t.completed_at, t.archived_at, t.created_at AS task_created_at, t.updated_at AS task_updated_at, t.deleted_at AS task_deleted_at ' +
        'FROM placements p JOIN tasks t ON t.owner_id = p.owner_id AND t.id = p.task_id ' +
        'WHERE p.owner_id = $1 AND p.time_point_id = $2 AND p.deleted_at IS NULL ORDER BY p.rank, p.id',
      [ownerId, source.id],
    );
    const createdIds: string[] = [];
    const skippedTaskIds: string[] = [];
    for (const row of result.rows) {
      const task = taskRecordFromJoin(row);
      if (task.status === 'DONE' || task.archivedAt || task.deletedAt) {
        skippedTaskIds.push(task.id);
        continue;
      }
      const added = await this.addPlacementInTransaction(ownerId, task.id, target.id);
      if (added.existed) skippedTaskIds.push(task.id);
      else createdIds.push(added.placement.id);
    }
    const operationId = uuidv7();
    await this.query(
      'INSERT INTO rollover_operations (id, owner_id, source_date, target_date, placement_ids, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [operationId, ownerId, sourceDate, targetDate, JSON.stringify(createdIds), this.now()],
    );
    return { operationId, createdIds, skippedTaskIds, targetDate };
  }

  async undoRollover(
    ownerId: string,
    operationId: string,
  ): Promise<{ removedIds: string[]; skippedIds: string[] }> {
    await this.lockOwner(ownerId);
    const result = await this.query(
      'SELECT id, owner_id, source_date, target_date, placement_ids, created_at, undone_at ' +
        'FROM rollover_operations WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [operationId, ownerId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('ENTITY_NOT_FOUND', '批量安排操作不存在');
    const operation = rolloverRecord(row);
    if (operation.undoneAt) return { removedIds: [], skippedIds: operation.placementIds };
    const removedIds: string[] = [];
    const skippedIds: string[] = [];
    for (const placementId of operation.placementIds) {
      const placement = await this.placementRecord(ownerId, placementId, true);
      if (placement.deletedAt || placement.version !== 1) {
        skippedIds.push(placementId);
        continue;
      }
      const deleteResult = await this.query(
        'UPDATE placements SET deleted_at = $3, version = version + 1, updated_at = $4 ' +
          'WHERE owner_id = $1 AND id = $2 AND version = 1 AND deleted_at IS NULL ' +
          'RETURNING id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at',
        [ownerId, placementId, this.now(), this.now()],
      );
      if (!deleteResult.rows[0]) {
        skippedIds.push(placementId);
        continue;
      }
      const deleted = placementRecord(deleteResult.rows[0]);
      await this.appendChange(ownerId, 'placement', placementId, deleted.version, 'delete', null);
      removedIds.push(placementId);
    }
    await this.query('UPDATE rollover_operations SET undone_at = $2 WHERE id = $1', [
      operationId,
      this.now(),
    ]);
    return { removedIds, skippedIds };
  }

  async search(
    ownerId: string,
    query: string,
    includeArchived = false,
    limit = 100,
  ): Promise<Array<{ task: TaskDto; project: ProjectDto | null; note: NoteDto }>> {
    await this.owner(ownerId);
    const normalized = query.trim();
    if (!normalized) return [];
    const pattern = '%' + escapeLike(normalized) + '%';
    const boundedLimit = checkedPageLimit(limit);
    const result = await this.query(
      'SELECT t.id, t.owner_id, t.project_id, t.category, t.reference_id, t.title, t.status, t.priority, t.rank, t.version, t.completed_at, t.archived_at, t.created_at, t.updated_at, t.deleted_at, ' +
        'p.id AS project_id_value, p.owner_id AS project_owner_id, p.name AS project_name, p.task_prefix AS project_task_prefix, p.next_task_number AS project_next_task_number, p.rank AS project_rank, p.version AS project_version, p.archived_at AS project_archived_at, p.created_at AS project_created_at, p.updated_at AS project_updated_at, p.deleted_at AS project_deleted_at, ' +
        'n.id AS note_id_value, n.owner_id AS note_owner_id, n.task_id AS note_task_id, n.content_markdown, n.version AS note_version, n.created_at AS note_created_at, n.updated_at AS note_updated_at, n.deleted_at AS note_deleted_at ' +
        'FROM tasks t LEFT JOIN projects p ON p.owner_id = t.owner_id AND p.id = t.project_id ' +
        'LEFT JOIN notes n ON n.owner_id = t.owner_id AND n.task_id = t.id AND n.deleted_at IS NULL ' +
        'WHERE t.owner_id = $1 AND t.deleted_at IS NULL AND (' +
        (includeArchived ? 'TRUE' : 't.archived_at IS NULL') +
        ") AND (t.title ILIKE $2 OR t.reference_id ILIKE $2 OR COALESCE(p.name, '') ILIKE $2 OR COALESCE(n.content_markdown, '') ILIKE $2) " +
        'ORDER BY t.updated_at DESC, t.id LIMIT $3',
      [ownerId, pattern, boundedLimit],
    );
    return result.rows.map((row) => ({
      task: taskDto(taskRecord(row)),
      project: row.project_id_value ? projectDto(projectRecordFromSearch(row)) : null,
      note: row.note_id_value
        ? noteDto(noteRecordFromSearch(row))
        : {
            id: '',
            taskId: String(row.id),
            contentMarkdown: '',
            version: 0,
            updatedAt: iso(row.updated_at),
          },
    }));
  }

  async withIdempotency<T>(
    ownerId: string,
    clientId: string,
    mutationId: string,
    input: unknown,
    action: () => T | Promise<T>,
  ): Promise<{ replayed: boolean; result: T }> {
    if (!this.tx.getStore())
      return this.withMutation(() =>
        this.withIdempotency(ownerId, clientId, mutationId, input, action),
      );
    const key = ownerId + ':' + clientId + ':' + mutationId;
    const requestHash = hash(input);
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    await this.query(
      'DELETE FROM client_mutations WHERE owner_id = $1 AND client_id = $2 AND mutation_id = $3 AND expires_at <= now()',
      [ownerId, clientId, mutationId],
    );
    const existing = await this.query(
      'SELECT request_hash, result FROM client_mutations WHERE owner_id = $1 AND client_id = $2 AND mutation_id = $3',
      [ownerId, clientId, mutationId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash)
        throw new DomainError('MUTATION_REJECTED', '同一 mutationId 不能对应不同请求');
      return { replayed: true, result: existing.rows[0].result as T };
    }
    const result = await action();
    const now = this.now();
    await this.query(
      'INSERT INTO client_mutations (owner_id, client_id, mutation_id, request_hash, result, first_processed_at, expires_at) ' +
        'VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [
        ownerId,
        clientId,
        mutationId,
        requestHash,
        JSON.stringify(result),
        now,
        new Date(
          new Date(now).getTime() + this.mutationReceiptRetentionDays * 86_400_000,
        ).toISOString(),
      ],
    );
    return { replayed: false, result };
  }

  async applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: Mutation,
  ): Promise<{ replayed: boolean; result: unknown }> {
    return this.withMutation(() =>
      this.withIdempotency(ownerId, clientId, mutation.mutationId, mutation, () =>
        this.dispatchMutation(ownerId, mutation),
      ),
    );
  }

  async applyMutation(ownerId: string, clientId: string, mutation: Mutation): Promise<unknown> {
    void clientId;
    return this.dispatchMutation(ownerId, mutation);
  }

  private async dispatchMutation(ownerId: string, mutation: Mutation): Promise<unknown> {
    const payload = mutation.payload;
    switch (mutation.command) {
      case 'project.create':
        return this.createProject(
          ownerId,
          stringValue(payload.name),
          stringValue(payload.taskPrefix),
          mutation.entityId,
        );
      case 'project.update':
        return this.updateProject(
          ownerId,
          mutation.entityId,
          {
            name: optionalString(payload.name),
            taskPrefix: optionalString(payload.taskPrefix),
          },
          numberValue(mutation.baseVersion),
        );
      case 'project.archive':
        return this.archiveProject(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'project.restore':
        return this.restoreProject(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'project.reorder':
        return this.reorderProjects(ownerId, stringArrayValue(payload.ids));
      case 'task.create': {
        const task = await this.createTask(ownerId, {
          id: mutation.entityId,
          projectId: optionalNullableString(payload.projectId),
          category: enumValue(payload.category, ['FEATURE', 'MISC']),
          title: stringValue(payload.title),
          priority: enumValue(payload.priority ?? 'NONE', ['NONE', 'LOW', 'MEDIUM', 'HIGH']),
        });
        return { task, note: await this.getNote(ownerId, task.id) };
      }
      case 'task.update':
        return this.updateTask(
          ownerId,
          mutation.entityId,
          {
            title: optionalString(payload.title),
            projectId: optionalNullableString(payload.projectId),
            category: optionalEnum(payload.category, ['FEATURE', 'MISC']),
            status: optionalEnum(payload.status, ['TODO', 'IN_PROGRESS', 'DONE']),
            priority: optionalEnum(payload.priority, ['NONE', 'LOW', 'MEDIUM', 'HIGH']),
            rank: optionalString(payload.rank),
          },
          numberValue(mutation.baseVersion),
        );
      case 'task.archive':
        return this.archiveTask(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'task.restore':
        return this.restoreTask(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'task.reorder':
        return this.reorderTasks(ownerId, stringArrayValue(payload.ids));
      case 'task.duplicate':
        return this.duplicateTask(ownerId, mutation.entityId, {
          taskId: optionalUuid(payload.__localTaskId),
          noteId: optionalUuid(payload.__localNoteId),
        });
      case 'note.update':
        return this.updateNote(
          ownerId,
          mutation.entityId,
          stringValue(payload.contentMarkdown),
          numberValue(mutation.baseVersion),
        );
      case 'timePoint.date.create':
        return this.createDate(ownerId, stringValue(payload.localDate), mutation.entityId);
      case 'timePoint.event.create':
        return this.createEvent(ownerId, stringValue(payload.title), mutation.entityId);
      case 'timePoint.update':
        return this.updateTimePoint(
          ownerId,
          mutation.entityId,
          stringValue(payload.title),
          numberValue(mutation.baseVersion),
        );
      case 'timePoint.reach':
        return this.reachTimePoint(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'timePoint.archive':
        return this.archiveTimePoint(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'timePoint.restore':
        return this.restoreTimePoint(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'timePoint.reorder':
        return this.reorderEvents(ownerId, stringArrayValue(payload.ids));
      case 'placement.create':
        return this.addPlacement(
          ownerId,
          stringValue(payload.taskId),
          stringValue(payload.timePointId),
          optionalUuid(payload.__localId) ?? mutation.entityId,
        );
      case 'placement.remove':
        return this.removePlacement(ownerId, mutation.entityId, numberValue(mutation.baseVersion));
      case 'placement.move':
        return this.movePlacement(
          ownerId,
          mutation.entityId,
          stringValue(payload.timePointId),
          numberValue(mutation.baseVersion),
          optionalUuid(payload.__localId),
        );
      case 'placement.copy':
        return this.copyPlacement(
          ownerId,
          mutation.entityId,
          stringValue(payload.timePointId),
          optionalUuid(payload.__localId),
        );
      case 'placement.reorder':
        return this.reorderPlacements(ownerId, mutation.entityId, stringArrayValue(payload.ids));
      case 'settings.update': {
        const patch: Partial<
          Pick<SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>
        > = {};
        const timezone = optionalString(payload.timezone);
        const target = optionalString(payload.defaultCaptureTarget);
        if (timezone !== undefined) patch.timezone = timezone;
        if (payload.weekStartsOn === 0 || payload.weekStartsOn === 1)
          patch.weekStartsOn = payload.weekStartsOn;
        if (target !== undefined) patch.defaultCaptureTarget = target;
        return this.updateSettings(ownerId, patch, numberValue(mutation.baseVersion));
      }
      case 'rollover.create':
        return this.rollover(ownerId, stringValue(payload.localDate));
      case 'rollover.undo':
        return this.undoRollover(ownerId, mutation.entityId);
      default:
        throw new DomainError('MUTATION_REJECTED', '不支持的 mutation: ' + mutation.command);
    }
  }

  async syncSnapshot(ownerId: string): Promise<{
    projects: ProjectDto[];
    tasks: TaskDto[];
    notes: NoteDto[];
    timePoints: TimePointDto[];
    placements: PlacementDto[];
    settings: SettingsDto;
    cursor: string;
  }> {
    return this.readSnapshot(async () => {
      await this.owner(ownerId);
      const projects = await this.snapshotProjects(ownerId);
      const tasks = await this.snapshotTasks(ownerId);
      const notes = await this.snapshotNotes(ownerId);
      const timePoints = await this.snapshotTimePoints(ownerId);
      const placements = await this.snapshotPlacements(ownerId);
      const settings = await this.getSettings(ownerId);
      const status = await this.syncStatus(ownerId);
      return { projects, tasks, notes, timePoints, placements, settings, cursor: status.cursor };
    });
  }

  async syncPull(
    ownerId: string,
    cursor: string,
    limit: number,
  ): Promise<{ changes: SyncChange[]; nextCursor: string; hasMore: boolean }> {
    await this.owner(ownerId);
    if (!/^\d+$/.test(cursor)) throw new DomainError('VALIDATION_FAILED', 'cursor 无效');
    const requested = BigInt(cursor);
    // seq is global across owners. A client's cursor is also global, so the
    // retention boundary must be global; using the owner's first row would
    // incorrectly expire a new owner whose first change happened later.
    const oldest = await this.query('SELECT seq FROM sync_changes ORDER BY seq LIMIT 1');
    if (oldest.rows[0] && requested < BigInt(String(oldest.rows[0].seq)) - 1n)
      throw new DomainError('SYNC_CURSOR_EXPIRED', '同步游标已超过保留窗口');
    const result = await this.query(
      'SELECT seq, owner_id, entity_type, entity_id, entity_version, operation, snapshot, committed_at ' +
        'FROM sync_changes WHERE owner_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [ownerId, cursor, Math.min(limit, 500)],
    );
    const changes = result.rows.map((row) => syncChange(row));
    const nextCursor = changes.at(-1)?.seq ?? requested;
    const more = await this.query(
      'SELECT 1 FROM sync_changes WHERE owner_id = $1 AND seq > $2 LIMIT 1',
      [ownerId, nextCursor.toString()],
    );
    return { changes, nextCursor: nextCursor.toString(), hasMore: more.rowCount === 1 };
  }

  async syncStatus(
    ownerId: string,
  ): Promise<{ cursor: string; oldestCursor: string; protocolVersion: 1 }> {
    await this.owner(ownerId);
    const current = await this.query(
      'SELECT COALESCE(MAX(seq), 0)::text AS cursor FROM sync_changes WHERE owner_id = $1',
      [ownerId],
    );
    const first = await this.query('SELECT seq FROM sync_changes ORDER BY seq LIMIT 1');
    const cursor = String(current.rows[0]?.cursor ?? '0');
    const oldestCursor = first.rows[0]
      ? (BigInt(String(first.rows[0].seq)) - 1n).toString()
      : cursor;
    return { cursor, oldestCursor, protocolVersion: 1 };
  }

  eventState(point: TimePointDto): string | null {
    if (point.type !== 'EVENT') return null;
    if (point.archivedAt) return 'ARCHIVED';
    return point.reachedAt ? 'REACHED' : 'WAITING';
  }

  subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(ownerId: string, cursor: string): void {
    for (const listener of this.listeners) {
      try {
        listener(ownerId, cursor);
      } catch {
        /* A WebSocket observer cannot roll back a committed transaction. */
      }
    }
  }

  private async appendChange(
    ownerId: string,
    entityType: SyncChange['entityType'],
    entityId: string,
    entityVersion: number,
    operation: SyncChange['operation'],
    snapshot: unknown,
  ): Promise<void> {
    const result = await this.query(
      'INSERT INTO sync_changes (owner_id, entity_type, entity_id, entity_version, operation, snapshot, committed_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING seq',
      [
        ownerId,
        entityType,
        entityId,
        entityVersion,
        operation,
        JSON.stringify(snapshot),
        this.now(),
      ],
    );
    const cursor = String(result.rows[0]!.seq);
    const context = this.tx.getStore();
    if (context) context.pending.set(ownerId, cursor);
    else this.notify(ownerId, cursor);
  }

  private async settingsRecord(ownerId: string, lock = false): Promise<SettingsRecord> {
    const result = await this.query(
      'SELECT owner_id, timezone, week_starts_on, default_capture_target, version, created_at, updated_at, deleted_at ' +
        'FROM user_settings WHERE owner_id = $1 AND deleted_at IS NULL' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '设置不存在');
    return settingsRecord(result.rows[0]);
  }

  private async deviceById(id: string): Promise<DeviceRecord | undefined> {
    const result = await this.query(
      'SELECT id, owner_id, name, platform, last_seen_at, created_at, revoked_at FROM devices WHERE id = $1',
      [id],
    );
    return result.rows[0] ? deviceRecord(result.rows[0]) : undefined;
  }

  private async projectRecord(ownerId: string, id: string, lock = false): Promise<ProjectRecord> {
    const result = await this.query(
      'SELECT id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at ' +
        'FROM projects WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId, id],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '项目不存在');
    return projectRecord(result.rows[0]);
  }

  private async taskRecord(ownerId: string, id: string, lock = false): Promise<TaskRecord> {
    const result = await this.query(
      'SELECT id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM tasks WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId, id],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '任务不存在');
    return taskRecord(result.rows[0]);
  }

  private async findNoteRecord(
    ownerId: string,
    taskId: string,
    lock = false,
  ): Promise<NoteRecord | undefined> {
    const result = await this.query(
      'SELECT id, owner_id, task_id, content_markdown, version, created_at, updated_at, deleted_at ' +
        'FROM notes WHERE owner_id = $1 AND task_id = $2 AND deleted_at IS NULL' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId, taskId],
    );
    return result.rows[0] ? noteRecord(result.rows[0]) : undefined;
  }

  private async timePointRecord(
    ownerId: string,
    id: string,
    lock = false,
  ): Promise<TimePointRecord> {
    const result = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM time_points WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL' +
        (lock ? ' FOR UPDATE' : ''),
      [ownerId, id],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '时间点不存在');
    return timePointRecord(result.rows[0]);
  }

  private async placementRecord(
    ownerId: string,
    id: string,
    includeDeleted = false,
  ): Promise<PlacementRecord> {
    const result = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND id = $2' +
        (includeDeleted ? '' : ' AND deleted_at IS NULL'),
      [ownerId, id],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '安排不存在');
    return placementRecord(result.rows[0]);
  }

  private async updateRankedProject(
    ownerId: string,
    project: ProjectRecord,
    rank: string,
  ): Promise<ProjectRecord> {
    const result = await this.query(
      'UPDATE projects SET rank = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at',
      [ownerId, project.id, rank, this.now(), project.version],
    );
    const next = projectRecord(requireUpdatedRow(result, '项目版本已变化'));
    await this.appendChange(ownerId, 'project', next.id, next.version, 'upsert', projectDto(next));
    return next;
  }

  private async updateRankedTask(
    ownerId: string,
    task: TaskRecord,
    rank: string,
  ): Promise<TaskRecord> {
    const result = await this.query(
      'UPDATE tasks SET rank = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at',
      [ownerId, task.id, rank, this.now(), task.version],
    );
    const next = taskRecord(requireUpdatedRow(result, '任务版本已变化'));
    await this.appendChange(ownerId, 'task', next.id, next.version, 'upsert', taskDto(next));
    return next;
  }

  private async updateTimePointRow(
    ownerId: string,
    point: TimePointRecord,
    title: string | null,
    archivedAt: string | null,
  ): Promise<TimePointDto> {
    const result = await this.query(
      'UPDATE time_points SET title = $3, archived_at = $4, version = version + 1, updated_at = $5 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $6 ' +
        'RETURNING id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at',
      [ownerId, point.id, title, archivedAt, this.now(), point.version],
    );
    const next = timePointRecord(requireUpdatedRow(result, '时间点版本已变化'));
    const dto = timePointDto(next);
    await this.appendChange(ownerId, 'timePoint', next.id, next.version, 'upsert', dto);
    return dto;
  }

  private async updateRankedTimePoint(
    ownerId: string,
    point: TimePointRecord,
    rank: string,
  ): Promise<TimePointRecord> {
    const result = await this.query(
      'UPDATE time_points SET rank = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at',
      [ownerId, point.id, rank, this.now(), point.version],
    );
    const next = timePointRecord(requireUpdatedRow(result, '时间点版本已变化'));
    await this.appendChange(
      ownerId,
      'timePoint',
      next.id,
      next.version,
      'upsert',
      timePointDto(next),
    );
    return next;
  }

  private async updateRankedPlacement(
    ownerId: string,
    placement: PlacementRecord,
    rank: string,
  ): Promise<PlacementRecord> {
    const result = await this.query(
      'UPDATE placements SET rank = $3, version = version + 1, updated_at = $4 ' +
        'WHERE owner_id = $1 AND id = $2 AND version = $5 ' +
        'RETURNING id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at',
      [ownerId, placement.id, rank, this.now(), placement.version],
    );
    const next = placementRecord(requireUpdatedRow(result, '安排版本已变化'));
    await this.appendChange(
      ownerId,
      'placement',
      next.id,
      next.version,
      'upsert',
      placementDto(next),
    );
    return next;
  }

  private async snapshotProjects(ownerId: string): Promise<ProjectDto[]> {
    const result = await this.query(
      'SELECT id, owner_id, name, task_prefix, next_task_number, rank, version, archived_at, created_at, updated_at, deleted_at ' +
        'FROM projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id',
      [ownerId],
    );
    return result.rows.map((row) => projectDto(projectRecord(row)));
  }

  private async snapshotTasks(ownerId: string): Promise<TaskDto[]> {
    const result = await this.query(
      'SELECT id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, completed_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM tasks WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id',
      [ownerId],
    );
    return result.rows.map((row) => taskDto(taskRecord(row)));
  }

  private async snapshotNotes(ownerId: string): Promise<NoteDto[]> {
    const result = await this.query(
      'SELECT id, owner_id, task_id, content_markdown, version, created_at, updated_at, deleted_at ' +
        'FROM notes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id',
      [ownerId],
    );
    return result.rows.map((row) => noteDto(noteRecord(row)));
  }

  private async snapshotTimePoints(ownerId: string): Promise<TimePointDto[]> {
    const result = await this.query(
      'SELECT id, owner_id, type, local_date, title, rank, version, reached_at, archived_at, created_at, updated_at, deleted_at ' +
        'FROM time_points WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id',
      [ownerId],
    );
    return result.rows.map((row) => timePointDto(timePointRecord(row)));
  }

  private async snapshotPlacements(ownerId: string): Promise<PlacementDto[]> {
    const result = await this.query(
      'SELECT id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at, deleted_at ' +
        'FROM placements WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id',
      [ownerId],
    );
    return result.rows.map((row) => placementDto(placementRecord(row)));
  }
}

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function userRecord(row: Row): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    nextMiscTaskNumber: Number(row.next_misc_task_number),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    disabledAt: nullableIso(row.disabled_at),
  };
}

function userDto(value: UserRecord): UserDto {
  return { id: value.id, username: value.username, createdAt: value.createdAt };
}

function settingsRecord(row: Row): SettingsRecord {
  return {
    ownerId: String(row.owner_id),
    timezone: String(row.timezone),
    weekStartsOn: Number(row.week_starts_on) as 0 | 1,
    defaultCaptureTarget: String(row.default_capture_target),
    version: Number(row.version),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

function settingsDto(value: SettingsRecord): SettingsDto {
  return {
    ownerId: value.ownerId,
    timezone: value.timezone,
    weekStartsOn: value.weekStartsOn,
    defaultCaptureTarget: value.defaultCaptureTarget,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

function projectRecord(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    taskPrefix: String(row.task_prefix),
    nextTaskNumber: Number(row.next_task_number),
    rank: String(row.rank),
    version: Number(row.version),
    archivedAt: nullableIso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

function projectRecordFromSearch(row: Row): ProjectRecord {
  return {
    id: String(row.project_id_value),
    ownerId: String(row.project_owner_id),
    name: String(row.project_name),
    taskPrefix: String(row.project_task_prefix),
    nextTaskNumber: Number(row.project_next_task_number),
    rank: String(row.project_rank),
    version: Number(row.project_version),
    archivedAt: nullableIso(row.project_archived_at),
    createdAt: iso(row.project_created_at),
    updatedAt: iso(row.project_updated_at),
    deletedAt: nullableIso(row.project_deleted_at),
  };
}

function projectDto(value: ProjectRecord): ProjectDto {
  return {
    id: value.id,
    name: value.name,
    taskPrefix: value.taskPrefix,
    rank: value.rank,
    version: value.version,
    archivedAt: value.archivedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function taskRecord(row: Row): TaskRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    category: row.category as TaskCategory,
    referenceId: String(row.reference_id),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    rank: String(row.rank),
    version: Number(row.version),
    completedAt: nullableIso(row.completed_at),
    archivedAt: nullableIso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

function taskRecordFromJoin(row: Row): TaskRecord {
  return {
    id: String(row.task_id_value),
    ownerId: String(row.task_owner_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    category: row.category as TaskCategory,
    referenceId: String(row.reference_id),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    rank: String(row.task_rank),
    version: Number(row.task_version),
    completedAt: nullableIso(row.completed_at),
    archivedAt: nullableIso(row.archived_at),
    createdAt: iso(row.task_created_at),
    updatedAt: iso(row.task_updated_at),
    deletedAt: nullableIso(row.task_deleted_at),
  };
}

function taskDto(value: TaskRecord): TaskDto {
  return {
    id: value.id,
    referenceId: value.referenceId,
    projectId: value.projectId,
    category: value.category,
    title: value.title,
    status: value.status,
    priority: value.priority,
    rank: value.rank,
    version: value.version,
    completedAt: value.completedAt,
    archivedAt: value.archivedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function noteRecord(row: Row): NoteRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    taskId: String(row.task_id),
    contentMarkdown: String(row.content_markdown),
    version: Number(row.version),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

function noteRecordFromSearch(row: Row): NoteRecord {
  return {
    id: String(row.note_id_value),
    ownerId: String(row.note_owner_id),
    taskId: String(row.note_task_id),
    contentMarkdown: String(row.content_markdown),
    version: Number(row.note_version),
    updatedAt: iso(row.note_updated_at),
    createdAt: iso(row.note_created_at),
    deletedAt: nullableIso(row.note_deleted_at),
  };
}

function noteDto(value: NoteRecord): NoteDto {
  return {
    id: value.id,
    taskId: value.taskId,
    contentMarkdown: value.contentMarkdown,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

function timePointRecord(row: Row): TimePointRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    type: row.type as TimePointType,
    localDate: localDateValue(row.local_date),
    title: row.title === null ? null : String(row.title),
    rank: String(row.rank),
    version: Number(row.version),
    reachedAt: nullableIso(row.reached_at),
    archivedAt: nullableIso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

/**
 * node-postgres parses PostgreSQL DATE values as JavaScript Date objects by
 * default. Formatting those objects with String() produces a locale-specific
 * timestamp and breaks the YYYY-MM-DD keyset cursor contract. The Date parser
 * constructs the value at local midnight, so the local calendar fields are
 * the stable representation of the original PostgreSQL date regardless of the
 * process timezone. Keep accepting strings as well for explicit ::text
 * queries and test doubles.
 */
function localDateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid PostgreSQL date');
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) =>
        index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'),
      )
      .join('-');
  }
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(text);
  if (!match) throw new Error('Invalid PostgreSQL date');
  return match[1]!;
}

function timePointDto(value: TimePointRecord): TimePointDto {
  return {
    id: value.id,
    type: value.type,
    localDate: value.localDate,
    title: value.title,
    rank: value.rank,
    version: value.version,
    reachedAt: value.reachedAt,
    archivedAt: value.archivedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function placementRecord(row: Row): PlacementRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    taskId: String(row.task_id),
    timePointId: String(row.time_point_id),
    rank: String(row.rank),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}

function placementDto(value: PlacementRecord): PlacementDto {
  return {
    id: value.id,
    taskId: value.taskId,
    timePointId: value.timePointId,
    rank: value.rank,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function deviceRecord(row: Row): DeviceRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    platform: String(row.platform),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    revokedAt: nullableIso(row.revoked_at),
  };
}

function deviceDto(value: DeviceRecord): DeviceDto {
  return {
    id: value.id,
    name: value.name,
    platform: value.platform,
    lastSeenAt: value.lastSeenAt,
    createdAt: value.createdAt,
    revokedAt: value.revokedAt,
  };
}

function checkedPageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500)
    throw new DomainError('VALIDATION_FAILED', '列表页大小无效');
  return value;
}

function makePage<T>(items: T[], limit: number, keyFor: (item: T) => PageCursor): PostgresPage<T> {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor: hasMore && last ? encodePageCursor(keyFor(last)) : null,
  };
}

function appendRankCursor(
  where: string[],
  values: unknown[],
  rankColumn: string,
  idColumn: string,
  cursor: PageCursor,
): void {
  if (cursor.group !== 'rank' && cursor.group !== 'event')
    throw new DomainError('VALIDATION_FAILED', '列表游标类型无效');
  const rankIndex = values.push(cursor.value);
  const idIndex = values.push(cursor.id);
  where.push(
    `(${rankColumn} > $${rankIndex}::bigint OR (${rankColumn} = $${rankIndex}::bigint AND ${idColumn} > $${idIndex}))`,
  );
}

function appendDateCursor(where: string[], values: unknown[], cursor: PageCursor): void {
  if (cursor.group !== 'date') throw new DomainError('VALIDATION_FAILED', '列表游标类型无效');
  const dateIndex = values.push(cursor.value);
  const idIndex = values.push(cursor.id);
  where.push(
    `(local_date > $${dateIndex}::date OR (local_date = $${dateIndex}::date AND id > $${idIndex}))`,
  );
}

function appendEventCursor(where: string[], values: unknown[], cursor: PageCursor): void {
  if (cursor.group !== 'event') throw new DomainError('VALIDATION_FAILED', '列表游标类型无效');
  appendRankCursor(where, values, 'rank', 'id', cursor);
}

function rankPageCursor(rank: string, id: string, group: 'rank' | 'event' = 'rank'): PageCursor {
  return { group, value: rank, id };
}

function datePageCursor(localDate: string, id: string): PageCursor {
  return { group: 'date', value: localDate, id };
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function requirePageCursor(value: string, expected?: PageCursor['group']): PageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      group?: unknown;
      value?: unknown;
      id?: unknown;
    };
    if (
      (parsed.group !== 'rank' && parsed.group !== 'date' && parsed.group !== 'event') ||
      typeof parsed.value !== 'string' ||
      typeof parsed.id !== 'string' ||
      !uuidSchema.safeParse(parsed.id).success ||
      (parsed.group === 'date'
        ? !/^\d{4}-\d{2}-\d{2}$/.test(parsed.value)
        : !/^\d+$/.test(parsed.value)) ||
      (expected !== undefined && parsed.group !== expected)
    )
      throw new Error('invalid page cursor');
    return { group: parsed.group, value: parsed.value, id: parsed.id };
  } catch {
    throw new DomainError('VALIDATION_FAILED', '列表游标无效');
  }
}

function sessionRecord(row: Row): RefreshSessionRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    deviceId: String(row.device_id),
    tokenHash: String(row.token_hash),
    expiresAt: iso(row.expires_at),
    replacedById: row.replaced_by_id === null ? null : String(row.replaced_by_id),
    usedAt: nullableIso(row.used_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function rolloverRecord(row: Row): RolloverRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    sourceDate: String(row.source_date),
    targetDate: String(row.target_date),
    placementIds: Array.isArray(row.placement_ids)
      ? row.placement_ids.filter((value): value is string => typeof value === 'string')
      : [],
    createdAt: iso(row.created_at),
    undoneAt: nullableIso(row.undone_at),
  };
}

function syncChange(row: Row): SyncChange {
  return {
    seq: BigInt(String(row.seq)),
    ownerId: String(row.owner_id),
    entityType: row.entity_type as SyncChange['entityType'],
    entityId: String(row.entity_id),
    entityVersion: Number(row.entity_version),
    operation: row.operation as SyncChange['operation'],
    snapshot: row.snapshot,
    committedAt: iso(row.committed_at),
  };
}

function rankSort(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  const left = BigInt(a.rank);
  const right = BigInt(b.rank);
  if (left !== right) return left < right ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function assertVersion<T>(actual: number, expected: number, snapshot: T): void {
  if (actual !== expected)
    throw new DomainError('VERSION_CONFLICT', '实体版本已变化', { server: snapshot });
}

function requireUpdatedRow(result: { rows: Row[] }, message: string): Row {
  const row = result.rows[0];
  if (!row) throw new DomainError('VERSION_CONFLICT', message);
  return row;
}

function requireInsertedRow(result: { rows: Row[] }, message: string): Row {
  const row = result.rows[0];
  if (!row) throw new DomainError('MUTATION_REJECTED', message);
  return row;
}

function ensureUnique(ids: string[], message: string): void {
  if (new Set(ids).size !== ids.length) throw new DomainError('VALIDATION_FAILED', message);
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\\\%_]/g, (character) => '\\\\' + character);
}

function throwSql(
  error: unknown,
  message: string,
  duplicateCode: 'VALIDATION_FAILED' | 'MUTATION_REJECTED' = 'VALIDATION_FAILED',
): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    if (error.code === '23505') throw new DomainError(duplicateCode, message);
    if (error.code === '23503' || error.code === '23514')
      throw new DomainError('VALIDATION_FAILED', message);
  }
  throw error;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function newEntityId(value: string | undefined): string {
  const id = value ?? uuidv7();
  if (!uuidSchema.safeParse(id).success)
    throw new DomainError('VALIDATION_FAILED', 'UUID 参数无效');
  return id;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DomainError('VALIDATION_FAILED', '字符串参数无效');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : stringValue(value);
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stringValue(value);
}

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'UUID 参数无效');
  return parsed.data;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    throw new DomainError('VALIDATION_FAILED', '字符串数组参数无效');
  return value;
}

function numberValue(value: number | null): number {
  if (!Number.isInteger(value) || value === null || value < 1)
    throw new DomainError('VERSION_CONFLICT', '缺少有效 baseVersion');
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new DomainError('VALIDATION_FAILED', '枚举参数无效');
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return value === undefined ? undefined : enumValue(value, values);
}
