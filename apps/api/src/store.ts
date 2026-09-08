import { createHash } from 'node:crypto';
import type {
  DeviceDto,
  Mutation,
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TaskCategory,
  TaskDto,
  TaskPriority,
  TaskStatus,
  TimePointDto,
  TimePointType,
  UserDto,
} from '@devtodo/contracts';
import { uuidSchema, uuidv7 } from '@devtodo/contracts';
import {
  allocateReference,
  assertTaskPlacement,
  DomainError,
  deriveEventState,
  nextLocalDate,
  ranksForIds,
  transitionTask,
  validateLocalDate,
} from '@devtodo/domain';

export interface UserRecord extends UserDto {
  passwordHash: string;
  nextMiscTaskNumber: number;
  updatedAt: string;
  disabledAt: string | null;
}
export interface SettingsRecord extends SettingsDto {
  createdAt: string;
  deletedAt: string | null;
}
export interface ProjectRecord extends ProjectDto {
  ownerId: string;
  nextTaskNumber: number;
  deletedAt: string | null;
}
export interface TaskRecord extends TaskDto {
  ownerId: string;
  deletedAt: string | null;
}
export interface NoteRecord extends NoteDto {
  ownerId: string;
  createdAt: string;
  deletedAt: string | null;
}
export interface TimePointRecord extends TimePointDto {
  ownerId: string;
  deletedAt: string | null;
}
export interface PlacementRecord extends PlacementDto {
  ownerId: string;
  deletedAt: string | null;
}
export interface DeviceRecord extends DeviceDto {
  ownerId: string;
}
export interface RefreshSessionRecord {
  id: string;
  ownerId: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: string;
  replacedById: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface MutationReceipt {
  ownerId: string;
  clientId: string;
  mutationId: string;
  requestHash: string;
  result: unknown;
  firstProcessedAt: string;
  expiresAt: string;
}
export interface SyncChange {
  seq: bigint;
  ownerId: string;
  entityType: 'project' | 'task' | 'note' | 'timePoint' | 'placement' | 'settings';
  entityId: string;
  entityVersion: number;
  operation: 'upsert' | 'delete';
  snapshot: unknown;
  committedAt: string;
}
export interface RolloverRecord {
  id: string;
  ownerId: string;
  sourceDate: string;
  targetDate: string;
  placementIds: string[];
  createdAt: string;
  undoneAt: string | null;
}

export interface NativeAuthChallenge {
  id: string;
  origin: string;
  expiresAt: string;
}

export interface StoreState {
  users: Map<string, UserRecord>;
  settings: Map<string, SettingsRecord>;
  projects: Map<string, ProjectRecord>;
  tasks: Map<string, TaskRecord>;
  notes: Map<string, NoteRecord>;
  timePoints: Map<string, TimePointRecord>;
  placements: Map<string, PlacementRecord>;
  devices: Map<string, DeviceRecord>;
  sessions: Map<string, RefreshSessionRecord>;
  receipts: Map<string, MutationReceipt>;
  changes: SyncChange[];
  rollovers: Map<string, RolloverRecord>;
  nativeChallenges: Map<string, NativeAuthChallenge>;
  cursor: bigint;
}

export interface TaskFilters {
  projectId?: string | null;
  category?: TaskCategory;
  status?: TaskStatus;
  archived?: boolean;
  timePointId?: string;
}

export interface StoreOptions {
  clock?: () => Date;
  changeRetentionDays?: number;
  mutationReceiptRetentionDays?: number;
}

export class MemoryStore {
  readonly state: StoreState;
  protected readonly clock: () => Date;
  private readonly changeRetentionDays: number;
  private readonly mutationReceiptRetentionDays: number;
  private readonly changeListeners = new Set<(ownerId: string, cursor: string) => void>();
  private mutationLock: Promise<void> = Promise.resolve();
  private changeNotificationBatch: Map<string, string> | null = null;

  constructor(options: StoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.changeRetentionDays = options.changeRetentionDays ?? 90;
    this.mutationReceiptRetentionDays = options.mutationReceiptRetentionDays ?? 90;
    this.state = {
      users: new Map(),
      settings: new Map(),
      projects: new Map(),
      tasks: new Map(),
      notes: new Map(),
      timePoints: new Map(),
      placements: new Map(),
      devices: new Map(),
      sessions: new Map(),
      receipts: new Map(),
      changes: [],
      rollovers: new Map(),
      nativeChallenges: new Map(),
      cursor: 0n,
    };
  }

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  createNativeChallenge(origin: string, expiresAt: string): string {
    const id = uuidv7();
    this.state.nativeChallenges.set(id, { id, origin, expiresAt });
    return id;
  }

  consumeNativeChallenge(id: string, origin: string): boolean {
    const challenge = this.state.nativeChallenges.get(id);
    this.state.nativeChallenges.delete(id);
    return Boolean(
      challenge &&
      challenge.origin === origin &&
      new Date(challenge.expiresAt).getTime() > this.clock().getTime(),
    );
  }

  async withMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationLock;
    let release!: () => void;
    this.mutationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = structuredClone(this.state) as StoreState;
    const outermost = this.beginChangeNotificationBatch();
    try {
      const result = await fn();
      this.cleanupExpiredState();
      this.endChangeNotificationBatch(outermost, true);
      return result;
    } catch (error) {
      restoreStoreState(this.state, before);
      this.endChangeNotificationBatch(outermost, false);
      throw error;
    } finally {
      release();
    }
  }

  hasOwner(): boolean {
    return this.state.users.size > 0;
  }

  getUserRecord(ownerId: string): UserRecord {
    const user = this.state.users.get(ownerId);
    if (!user || user.disabledAt) throw new DomainError('AUTH_REQUIRED', '账户不可用');
    return user;
  }

  getUser(ownerId: string): UserDto {
    return this.userDto(this.getUserRecord(ownerId));
  }

  findUserByUsername(username: string): UserRecord | undefined {
    const normalized = normalizeUsername(username);
    return [...this.state.users.values()].find((user) => user.username === normalized);
  }

  createOwner(username: string, passwordHash: string): UserDto {
    if (this.hasOwner()) throw new DomainError('BOOTSTRAP_ALREADY_COMPLETED', 'Owner 已初始化');
    const now = this.now();
    const user: UserRecord = {
      id: uuidv7(),
      username: normalizeUsername(username),
      passwordHash,
      nextMiscTaskNumber: 1,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    this.state.users.set(user.id, user);
    this.state.settings.set(user.id, {
      ownerId: user.id,
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1,
      defaultCaptureTarget: 'GLOBAL_MISC',
      version: 1,
      updatedAt: now,
      createdAt: now,
      deletedAt: null,
    });
    this.recordChange(
      user.id,
      'settings',
      user.id,
      1,
      'upsert',
      this.settingsDto(this.state.settings.get(user.id)!),
    );
    return this.userDto(user);
  }

  getSettings(ownerId: string): SettingsDto {
    this.getUser(ownerId);
    const settings = this.state.settings.get(ownerId);
    if (!settings) throw new DomainError('ENTITY_NOT_FOUND', '设置不存在');
    return this.settingsDto(settings);
  }

  updateSettings(
    ownerId: string,
    patch: Partial<Pick<SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>>,
    baseVersion: number,
  ): SettingsDto {
    const current = this.state.settings.get(ownerId);
    if (!current) throw new DomainError('ENTITY_NOT_FOUND', '设置不存在');
    this.assertVersion(current.version, baseVersion, current);
    if (patch.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone }).format();
      } catch {
        throw new DomainError('VALIDATION_FAILED', '无效的 IANA 时区');
      }
      current.timezone = patch.timezone;
    }
    if (patch.weekStartsOn !== undefined && patch.weekStartsOn !== 0 && patch.weekStartsOn !== 1)
      throw new DomainError('VALIDATION_FAILED', '每周起始日无效');
    if (patch.weekStartsOn !== undefined) current.weekStartsOn = patch.weekStartsOn;
    if (patch.defaultCaptureTarget !== undefined) {
      if (!['GLOBAL_MISC', 'RECENT_CONTEXT'].includes(patch.defaultCaptureTarget))
        throw new DomainError('VALIDATION_FAILED', '默认捕获位置无效');
      current.defaultCaptureTarget = patch.defaultCaptureTarget;
    }
    current.version += 1;
    current.updatedAt = this.now();
    this.recordChange(
      ownerId,
      'settings',
      ownerId,
      current.version,
      'upsert',
      this.settingsDto(current),
    );
    return this.settingsDto(current);
  }

  createDevice(ownerId: string, id: string | undefined, name: string, platform: string): DeviceDto {
    this.getUser(ownerId);
    const now = this.now();
    const existing = id ? this.state.devices.get(id) : undefined;
    if (existing && existing.ownerId !== ownerId)
      throw new DomainError('MUTATION_REJECTED', '设备 ID 已属于其他 Owner');
    if (existing && existing.ownerId === ownerId) {
      existing.name = name;
      existing.platform = platform;
      existing.lastSeenAt = now;
      existing.revokedAt = null;
      return this.deviceDto(existing);
    }
    const device: DeviceRecord = {
      id: id ?? uuidv7(),
      ownerId,
      name,
      platform,
      lastSeenAt: now,
      createdAt: now,
      revokedAt: null,
    };
    this.state.devices.set(device.id, device);
    return this.deviceDto(device);
  }

  listDevices(ownerId: string): DeviceDto[] {
    this.getUser(ownerId);
    return [...this.state.devices.values()]
      .filter((device) => device.ownerId === ownerId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((device) => this.deviceDto(device));
  }

  getDevice(ownerId: string, id: string): DeviceRecord {
    return this.owned(this.state.devices, ownerId, id, '设备');
  }

  revokeDevice(ownerId: string, id: string): void {
    const device = this.owned(this.state.devices, ownerId, id, '设备');
    device.revokedAt = this.now();
    for (const session of this.state.sessions.values())
      if (session.deviceId === id && session.ownerId === ownerId)
        session.revokedAt = device.revokedAt;
  }

  createSession(
    ownerId: string,
    deviceId: string,
    tokenHash: string,
    expiresAt: string,
  ): RefreshSessionRecord {
    const session: RefreshSessionRecord = {
      id: uuidv7(),
      ownerId,
      deviceId,
      tokenHash,
      expiresAt,
      replacedById: null,
      usedAt: null,
      revokedAt: null,
      createdAt: this.now(),
    };
    this.state.sessions.set(session.id, session);
    return session;
  }

  rotateSession(
    sessionId: string,
    nextTokenHash: string,
    expiresAt: string,
  ): { session: RefreshSessionRecord; device: DeviceRecord } {
    const session = this.state.sessions.get(sessionId);
    if (!session) throw new DomainError('AUTH_SESSION_REVOKED', '会话不存在或已撤销');
    const device = this.getDevice(session.ownerId, session.deviceId);
    const now = this.now();
    session.usedAt = now;
    const next = this.createSession(session.ownerId, session.deviceId, nextTokenHash, expiresAt);
    session.replacedById = next.id;
    device.lastSeenAt = now;
    return { session: next, device };
  }

  findSessionByHash(tokenHash: string): RefreshSessionRecord | undefined {
    return [...this.state.sessions.values()].find((session) => session.tokenHash === tokenHash);
  }

  revokeSessionChain(session: RefreshSessionRecord): void {
    const revokedAt = this.now();
    const ids = new Set<string>();
    let current: RefreshSessionRecord | undefined = session;
    while (current) {
      if (ids.has(current.id)) break;
      ids.add(current.id);
      current.revokedAt = revokedAt;
      current = current.replacedById ? this.state.sessions.get(current.replacedById) : undefined;
    }
    for (const candidate of this.state.sessions.values())
      if (candidate.ownerId === session.ownerId && candidate.deviceId === session.deviceId)
        candidate.revokedAt = revokedAt;
  }

  createProject(ownerId: string, name: string, taskPrefix: string, id?: string): ProjectDto {
    this.getUser(ownerId);
    const normalizedName = name.trim();
    const normalizedPrefix = taskPrefix.trim().toUpperCase();
    if (
      !normalizedName ||
      normalizedName.length > 160 ||
      !/^[A-Z][A-Z0-9]{1,9}$/.test(normalizedPrefix)
    )
      throw new DomainError('VALIDATION_FAILED', '项目名称或代号无效');
    if (
      [...this.state.projects.values()].some(
        (project) =>
          project.ownerId === ownerId &&
          project.taskPrefix === normalizedPrefix &&
          !project.deletedAt,
      )
    )
      throw new DomainError('VALIDATION_FAILED', '项目代号已存在');
    const projectId = newEntityId(id);
    if (this.state.projects.has(projectId))
      throw new DomainError('MUTATION_REJECTED', '项目 ID 已存在');
    const rank =
      this.maxRank(
        [...this.state.projects.values()]
          .filter((project) => project.ownerId === ownerId && !project.deletedAt)
          .map((project) => project.rank),
      ) + 1024n;
    const now = this.now();
    const project: ProjectRecord = {
      id: projectId,
      ownerId,
      name: normalizedName,
      taskPrefix: normalizedPrefix,
      nextTaskNumber: 1,
      rank: rank.toString(),
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.state.projects.set(project.id, project);
    this.recordChange(
      ownerId,
      'project',
      project.id,
      project.version,
      'upsert',
      this.projectDto(project),
    );
    return this.projectDto(project);
  }

  listProjects(ownerId: string, archived = false): ProjectDto[] {
    this.getUser(ownerId);
    return [...this.state.projects.values()]
      .filter(
        (project) =>
          project.ownerId === ownerId &&
          !project.deletedAt &&
          (archived ? Boolean(project.archivedAt) : !project.archivedAt),
      )
      .sort(rankSort)
      .map((project) => this.projectDto(project));
  }

  getProject(ownerId: string, id: string, includeArchived = true): ProjectDto {
    const project = this.owned(this.state.projects, ownerId, id, '项目');
    if (!includeArchived && project.archivedAt)
      throw new DomainError('ENTITY_ARCHIVED', '项目已归档');
    return this.projectDto(project);
  }

  updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; taskPrefix?: string },
    baseVersion: number,
  ): ProjectDto {
    const project = this.owned(this.state.projects, ownerId, id, '项目');
    this.assertVersion(project.version, baseVersion, this.projectDto(project));
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 160) throw new DomainError('VALIDATION_FAILED', '项目名称无效');
      project.name = name;
    }
    if (patch.taskPrefix !== undefined) {
      if ([...this.state.tasks.values()].some((task) => task.projectId === id && !task.deletedAt))
        throw new DomainError('VALIDATION_FAILED', '项目已有任务后不能修改代号');
      const prefix = patch.taskPrefix.trim().toUpperCase();
      if (
        !/^[A-Z][A-Z0-9]{1,9}$/.test(prefix) ||
        [...this.state.projects.values()].some(
          (candidate) =>
            candidate.ownerId === ownerId &&
            candidate.id !== id &&
            candidate.taskPrefix === prefix &&
            !candidate.deletedAt,
        )
      )
        throw new DomainError('VALIDATION_FAILED', '项目代号无效或已存在');
      project.taskPrefix = prefix;
    }
    project.version += 1;
    project.updatedAt = this.now();
    this.recordChange(ownerId, 'project', id, project.version, 'upsert', this.projectDto(project));
    return this.projectDto(project);
  }

  archiveProject(ownerId: string, id: string, baseVersion: number): ProjectDto {
    const project = this.owned(this.state.projects, ownerId, id, '项目');
    this.assertVersion(project.version, baseVersion, this.projectDto(project));
    project.archivedAt = this.now();
    project.version += 1;
    project.updatedAt = this.now();
    this.recordChange(ownerId, 'project', id, project.version, 'upsert', this.projectDto(project));
    return this.projectDto(project);
  }

  restoreProject(ownerId: string, id: string, baseVersion: number): ProjectDto {
    const project = this.owned(this.state.projects, ownerId, id, '项目');
    this.assertVersion(project.version, baseVersion, this.projectDto(project));
    project.archivedAt = null;
    project.version += 1;
    project.updatedAt = this.now();
    this.recordChange(ownerId, 'project', id, project.version, 'upsert', this.projectDto(project));
    return this.projectDto(project);
  }

  reorderProjects(ownerId: string, ids: string[]): ProjectDto[] {
    this.getUser(ownerId);
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '项目排序列表不能有重复项');
    const projects = ids.map((id) => this.owned(this.state.projects, ownerId, id, '项目'));
    const expected = [...this.state.projects.values()].filter(
      (project) => project.ownerId === ownerId && !project.deletedAt && !project.archivedAt,
    );
    if (expected.length !== ids.length || expected.some((project) => !ids.includes(project.id)))
      throw new DomainError('VALIDATION_FAILED', '项目排序列表必须包含整个活动列表');
    const ranks = ranksForIds(ids);
    for (const project of projects) {
      project.rank = ranks.get(project.id)!.toString();
      project.version += 1;
      project.updatedAt = this.now();
      this.recordChange(
        ownerId,
        'project',
        project.id,
        project.version,
        'upsert',
        this.projectDto(project),
      );
    }
    return this.listProjects(ownerId);
  }

  createTask(
    ownerId: string,
    input: {
      id?: string;
      projectId?: string | null;
      category: TaskCategory;
      title: string;
      priority: TaskPriority;
    },
  ): TaskDto {
    const user = this.getUserRecord(ownerId);
    const projectId = input.projectId ?? null;
    assertTaskPlacement(projectId, input.category);
    const taskId = newEntityId(input.id);
    if (this.state.tasks.has(taskId)) throw new DomainError('MUTATION_REJECTED', '任务 ID 已存在');
    const project = projectId
      ? this.owned(this.state.projects, ownerId, projectId, '项目')
      : undefined;
    if (project?.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '项目已归档');
    const title = input.title.trim();
    if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
    const number = project ? project.nextTaskNumber++ : user.nextMiscTaskNumber++;
    const referenceId = allocateReference(project?.taskPrefix ?? 'MISC', number);
    const now = this.now();
    const list = [...this.state.tasks.values()].filter(
      (task) =>
        task.ownerId === ownerId &&
        !task.deletedAt &&
        task.projectId === projectId &&
        task.category === input.category,
    );
    const task: TaskRecord = {
      id: taskId,
      ownerId,
      referenceId,
      projectId,
      category: input.category,
      title,
      status: 'TODO',
      priority: input.priority,
      rank: (this.maxRank(list.map((item) => item.rank)) + 1024n).toString(),
      version: 1,
      completedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.state.tasks.set(task.id, task);
    const note: NoteRecord = {
      id: uuidv7(),
      ownerId,
      taskId: task.id,
      contentMarkdown: '',
      version: 1,
      updatedAt: now,
      createdAt: now,
      deletedAt: null,
    };
    this.state.notes.set(note.id, note);
    this.recordChange(ownerId, 'task', task.id, task.version, 'upsert', this.taskDto(task));
    this.recordChange(ownerId, 'note', note.id, note.version, 'upsert', this.noteDto(note));
    return this.taskDto(task);
  }

  listTasks(ownerId: string, filters: TaskFilters = {}): TaskDto[] {
    this.getUser(ownerId);
    let result = [...this.state.tasks.values()].filter(
      (task) => task.ownerId === ownerId && !task.deletedAt,
    );
    if (filters.projectId !== undefined)
      result = result.filter((task) => task.projectId === filters.projectId);
    if (filters.category) result = result.filter((task) => task.category === filters.category);
    if (filters.status) result = result.filter((task) => task.status === filters.status);
    if (filters.archived !== undefined)
      result = result.filter((task) =>
        filters.archived ? Boolean(task.archivedAt) : !task.archivedAt,
      );
    if (filters.timePointId) {
      const taskIds = new Set(
        [...this.state.placements.values()]
          .filter(
            (placement) =>
              placement.ownerId === ownerId &&
              placement.timePointId === filters.timePointId &&
              !placement.deletedAt,
          )
          .map((placement) => placement.taskId),
      );
      result = result.filter((task) => taskIds.has(task.id));
    }
    return result.sort(rankSort).map((task) => this.taskDto(task));
  }

  getTask(ownerId: string, id: string, includeArchived = true): TaskDto {
    const task = this.owned(this.state.tasks, ownerId, id, '任务');
    if (!includeArchived && task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    return this.taskDto(task);
  }

  updateTask(
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
  ): TaskDto {
    const task = this.owned(this.state.tasks, ownerId, id, '任务');
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    const projectId = patch.projectId === undefined ? task.projectId : patch.projectId;
    const category = patch.category ?? task.category;
    assertTaskPlacement(projectId, category);
    const project = projectId
      ? this.owned(this.state.projects, ownerId, projectId, '项目')
      : undefined;
    if (project?.archivedAt && projectId !== task.projectId)
      throw new DomainError('ENTITY_ARCHIVED', '不能移入已归档项目');
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 500) throw new DomainError('VALIDATION_FAILED', '任务标题无效');
      task.title = title;
    }
    if (patch.projectId !== undefined || patch.category !== undefined) {
      task.projectId = projectId;
      task.category = category;
    }
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.rank !== undefined) {
      if (!/^\d+$/.test(patch.rank) || BigInt(patch.rank) < 1n)
        throw new DomainError('VALIDATION_FAILED', 'rank 无效');
      task.rank = patch.rank;
    }
    if (patch.status !== undefined && patch.status !== task.status) {
      const transition = transitionTask(task.status, patch.status, new Date(this.now()));
      task.status = transition.status;
      task.completedAt = transition.completedAt?.toISOString() ?? null;
    }
    task.version += 1;
    task.updatedAt = this.now();
    this.recordChange(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  archiveTask(ownerId: string, id: string, baseVersion: number): TaskDto {
    const task = this.owned(this.state.tasks, ownerId, id, '任务');
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    task.archivedAt = this.now();
    task.version += 1;
    task.updatedAt = this.now();
    this.recordChange(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  restoreTask(ownerId: string, id: string, baseVersion: number): TaskDto {
    const task = this.owned(this.state.tasks, ownerId, id, '任务');
    this.assertVersion(task.version, baseVersion, this.taskDto(task));
    task.archivedAt = null;
    task.version += 1;
    task.updatedAt = this.now();
    this.recordChange(ownerId, 'task', id, task.version, 'upsert', this.taskDto(task));
    return this.taskDto(task);
  }

  reorderTasks(ownerId: string, ids: string[]): TaskDto[] {
    this.getUser(ownerId);
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '任务排序列表不能有重复项');
    if (ids.length === 0) return [];
    const tasks = ids.map((id) => this.owned(this.state.tasks, ownerId, id, '任务'));
    const first = tasks[0]!;
    if (
      tasks.some((task) => task.projectId !== first.projectId || task.category !== first.category)
    )
      throw new DomainError('VALIDATION_FAILED', '只能在同一任务分组内排序');
    const expected = [...this.state.tasks.values()].filter(
      (task) =>
        task.ownerId === ownerId &&
        !task.deletedAt &&
        !task.archivedAt &&
        task.projectId === first.projectId &&
        task.category === first.category,
    );
    if (expected.length !== ids.length || expected.some((task) => !ids.includes(task.id)))
      throw new DomainError('VALIDATION_FAILED', '任务排序列表必须包含整个活动分组');
    const ranks = ranksForIds(ids);
    for (const task of tasks) {
      task.rank = ranks.get(task.id)!.toString();
      task.version += 1;
      task.updatedAt = this.now();
      this.recordChange(ownerId, 'task', task.id, task.version, 'upsert', this.taskDto(task));
    }
    return this.listTasks(ownerId, {
      projectId: first.projectId,
      category: first.category,
      archived: false,
    });
  }

  duplicateTask(
    ownerId: string,
    id: string,
    requestedIds: { taskId?: string; noteId?: string } = {},
  ): { task: TaskDto; note: NoteDto } {
    const source = this.owned(this.state.tasks, ownerId, id, '任务');
    const taskId = newEntityId(requestedIds.taskId);
    const noteId = newEntityId(requestedIds.noteId);
    if (this.state.tasks.has(taskId) || this.state.notes.has(noteId))
      throw new DomainError('MUTATION_REJECTED', '复制任务的 ID 已存在');
    const project = source.projectId
      ? this.owned(this.state.projects, ownerId, source.projectId, '项目')
      : undefined;
    const number = project
      ? project.nextTaskNumber++
      : this.getUserRecord(ownerId).nextMiscTaskNumber++;
    const now = this.now();
    const task: TaskRecord = {
      ...source,
      id: taskId,
      referenceId: allocateReference(project?.taskPrefix ?? 'MISC', number),
      status: 'TODO',
      completedAt: null,
      archivedAt: null,
      rank: (
        this.maxRank(
          this.listTasks(ownerId, {
            projectId: source.projectId,
            category: source.category,
            archived: false,
          }).map((item) => item.rank),
        ) + 1024n
      ).toString(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const sourceNote = this.findNote(ownerId, source.id);
    const note: NoteRecord = {
      id: noteId,
      ownerId,
      taskId: task.id,
      contentMarkdown: sourceNote?.contentMarkdown ?? '',
      version: 1,
      updatedAt: now,
      createdAt: now,
      deletedAt: null,
    };
    this.state.tasks.set(task.id, task);
    this.state.notes.set(note.id, note);
    this.recordChange(ownerId, 'task', task.id, 1, 'upsert', this.taskDto(task));
    this.recordChange(ownerId, 'note', note.id, 1, 'upsert', this.noteDto(note));
    return { task: this.taskDto(task), note: this.noteDto(note) };
  }

  getNote(ownerId: string, taskId: string): NoteDto {
    const note = this.findNote(ownerId, taskId);
    if (!note) throw new DomainError('ENTITY_NOT_FOUND', '备注不存在');
    return this.noteDto(note);
  }

  getTaskDetails(
    ownerId: string,
    taskId: string,
  ): {
    task: TaskDto;
    note: NoteDto;
    placements: PlacementDto[];
  } {
    return {
      task: this.getTask(ownerId, taskId),
      note: this.getNote(ownerId, taskId),
      placements: [...this.state.placements.values()]
        .filter(
          (placement) =>
            placement.ownerId === ownerId && placement.taskId === taskId && !placement.deletedAt,
        )
        .sort(rankSort)
        .map((placement) => this.placementDto(placement)),
    };
  }

  updateNote(
    ownerId: string,
    taskId: string,
    contentMarkdown: string,
    baseVersion: number,
  ): NoteDto {
    this.owned(this.state.tasks, ownerId, taskId, '任务');
    const note = this.findNote(ownerId, taskId);
    if (!note) throw new DomainError('ENTITY_NOT_FOUND', '备注不存在');
    this.assertVersion(note.version, baseVersion, this.noteDto(note));
    if (contentMarkdown.length > 1024 * 1024)
      throw new DomainError('VALIDATION_FAILED', '备注超过 1 MiB');
    note.contentMarkdown = contentMarkdown;
    note.version += 1;
    note.updatedAt = this.now();
    this.recordChange(ownerId, 'note', note.id, note.version, 'upsert', this.noteDto(note));
    return this.noteDto(note);
  }

  createDate(ownerId: string, localDate: string, id?: string): TimePointDto {
    validateLocalDate(localDate);
    this.getUser(ownerId);
    const existing = [...this.state.timePoints.values()].find(
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

  private createTimePoint(
    ownerId: string,
    input: { type: TimePointType; localDate?: string; title?: string; id?: string },
  ): TimePointDto {
    this.getUser(ownerId);
    const pointId = newEntityId(input.id);
    if (this.state.timePoints.has(pointId))
      throw new DomainError('MUTATION_REJECTED', '时间点 ID 已存在');
    const now = this.now();
    if (input.type === 'DATE') {
      if (!input.localDate) throw new DomainError('VALIDATION_FAILED', '日期不能为空');
      validateLocalDate(input.localDate);
    }
    if (input.type === 'EVENT' && (!input.title?.trim() || input.title.trim().length > 200))
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    const list = [...this.state.timePoints.values()].filter(
      (point) => point.ownerId === ownerId && point.type === 'EVENT' && !point.deletedAt,
    );
    const point: TimePointRecord = {
      id: pointId,
      ownerId,
      type: input.type,
      localDate: input.localDate ?? null,
      title: input.title?.trim() ?? null,
      rank: (this.maxRank(list.map((item) => item.rank)) + 1024n).toString(),
      version: 1,
      reachedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.state.timePoints.set(point.id, point);
    this.recordChange(ownerId, 'timePoint', point.id, 1, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  listTimePoints(ownerId: string, type?: TimePointType, archived?: boolean): TimePointDto[] {
    this.getUser(ownerId);
    return [...this.state.timePoints.values()]
      .filter(
        (point) =>
          point.ownerId === ownerId &&
          !point.deletedAt &&
          (!type || point.type === type) &&
          (archived === undefined || archived === Boolean(point.archivedAt)),
      )
      .sort((a, b) =>
        a.type === 'DATE' && b.type === 'DATE'
          ? (a.localDate ?? '').localeCompare(b.localDate ?? '')
          : rankSort(a, b),
      )
      .map((point) => this.timePointDto(point));
  }

  getTimePoint(ownerId: string, id: string): TimePointDto {
    return this.timePointDto(this.owned(this.state.timePoints, ownerId, id, '时间点'));
  }

  updateTimePoint(ownerId: string, id: string, title: string, baseVersion: number): TimePointDto {
    const point = this.owned(this.state.timePoints, ownerId, id, '时间点');
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不可改名');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    const normalized = title.trim();
    if (!normalized || normalized.length > 200)
      throw new DomainError('VALIDATION_FAILED', '时间点名称无效');
    point.title = normalized;
    point.version += 1;
    point.updatedAt = this.now();
    this.recordChange(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  reachTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    const point = this.owned(this.state.timePoints, ownerId, id, '时间点');
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期没有到达状态');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    point.reachedAt ??= this.now();
    point.version += 1;
    point.updatedAt = this.now();
    this.recordChange(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  archiveTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    const point = this.owned(this.state.timePoints, ownerId, id, '时间点');
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不能归档');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    point.archivedAt = this.now();
    point.version += 1;
    point.updatedAt = this.now();
    this.recordChange(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  restoreTimePoint(ownerId: string, id: string, baseVersion: number): TimePointDto {
    const point = this.owned(this.state.timePoints, ownerId, id, '时间点');
    if (point.type !== 'EVENT') throw new DomainError('VALIDATION_FAILED', '日期不能恢复');
    this.assertVersion(point.version, baseVersion, this.timePointDto(point));
    point.archivedAt = null;
    point.version += 1;
    point.updatedAt = this.now();
    this.recordChange(ownerId, 'timePoint', id, point.version, 'upsert', this.timePointDto(point));
    return this.timePointDto(point);
  }

  reorderEvents(ownerId: string, ids: string[]): TimePointDto[] {
    this.getUser(ownerId);
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '时间点排序列表不能有重复项');
    const points = ids.map((id) => this.owned(this.state.timePoints, ownerId, id, '时间点'));
    if (points.some((point) => point.type !== 'EVENT'))
      throw new DomainError('VALIDATION_FAILED', '只能排序事件');
    const expected = [...this.state.timePoints.values()].filter(
      (point) =>
        point.ownerId === ownerId &&
        point.type === 'EVENT' &&
        !point.deletedAt &&
        !point.archivedAt,
    );
    if (expected.length !== ids.length || expected.some((point) => !ids.includes(point.id)))
      throw new DomainError('VALIDATION_FAILED', '时间点排序列表必须包含整个活动列表');
    const ranks = ranksForIds(ids);
    for (const point of points) {
      point.rank = ranks.get(point.id)!.toString();
      point.version += 1;
      point.updatedAt = this.now();
      this.recordChange(
        ownerId,
        'timePoint',
        point.id,
        point.version,
        'upsert',
        this.timePointDto(point),
      );
    }
    return this.listTimePoints(ownerId, 'EVENT');
  }

  addPlacement(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): { placement: PlacementDto; existed: boolean } {
    const task = this.owned(this.state.tasks, ownerId, taskId, '任务');
    const point = this.owned(this.state.timePoints, ownerId, timePointId, '时间点');
    if (task.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '任务已归档');
    if (point.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = [...this.state.placements.values()].find(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.taskId === taskId &&
        placement.timePointId === timePointId &&
        !placement.deletedAt,
    );
    if (existing) return { placement: this.placementDto(existing), existed: true };
    const placementId = newEntityId(id);
    if (this.state.placements.has(placementId))
      throw new DomainError('MUTATION_REJECTED', '安排 ID 已存在');
    const list = [...this.state.placements.values()].filter(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.timePointId === timePointId &&
        !placement.deletedAt,
    );
    const now = this.now();
    const placement: PlacementRecord = {
      id: placementId,
      ownerId,
      taskId: task.id,
      timePointId: point.id,
      rank: (this.maxRank(list.map((item) => item.rank)) + 1024n).toString(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.state.placements.set(placement.id, placement);
    this.recordChange(
      ownerId,
      'placement',
      placement.id,
      1,
      'upsert',
      this.placementDto(placement),
    );
    return { placement: this.placementDto(placement), existed: false };
  }

  listPlacements(ownerId: string, timePointId: string): Array<PlacementDto & { task: TaskDto }> {
    this.owned(this.state.timePoints, ownerId, timePointId, '时间点');
    return [...this.state.placements.values()]
      .filter(
        (placement) =>
          placement.ownerId === ownerId &&
          placement.timePointId === timePointId &&
          !placement.deletedAt,
      )
      .sort(rankSort)
      .flatMap((placement) => {
        const task = this.state.tasks.get(placement.taskId);
        return task && !task.deletedAt
          ? [{ ...this.placementDto(placement), task: this.taskDto(task) }]
          : [];
      });
  }

  removePlacement(ownerId: string, id: string, baseVersion: number): PlacementDto {
    const placement = this.owned(this.state.placements, ownerId, id, '安排');
    this.assertVersion(placement.version, baseVersion, this.placementDto(placement));
    placement.deletedAt = this.now();
    placement.version += 1;
    placement.updatedAt = this.now();
    this.recordChange(ownerId, 'placement', id, placement.version, 'delete', null);
    return this.placementDto(placement);
  }

  movePlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    baseVersion: number,
    targetPlacementId?: string,
  ): { placement: PlacementDto; sourcePlacementId: string; existed: boolean } {
    const source = this.owned(this.state.placements, ownerId, id, '安排');
    this.assertVersion(source.version, baseVersion, this.placementDto(source));
    const target = this.owned(this.state.timePoints, ownerId, targetTimePointId, '时间点');
    if (source.timePointId === targetTimePointId)
      throw new DomainError('VALIDATION_FAILED', '安排已经位于目标时间点');
    if (target.archivedAt) throw new DomainError('ENTITY_ARCHIVED', '时间点已归档');
    const existing = [...this.state.placements.values()].find(
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
      this.recordChange(ownerId, 'placement', source.id, source.version, 'delete', null);
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
    this.recordChange(ownerId, 'placement', source.id, source.version, 'delete', null);
    return { placement: result.placement, sourcePlacementId: source.id, existed: false };
  }

  copyPlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    targetPlacementId?: string,
  ): { placement: PlacementDto; existed: boolean } {
    const source = this.owned(this.state.placements, ownerId, id, '安排');
    return this.addPlacement(ownerId, source.taskId, targetTimePointId, targetPlacementId);
  }

  reorderPlacements(ownerId: string, timePointId: string, ids: string[]): PlacementDto[] {
    this.owned(this.state.timePoints, ownerId, timePointId, '时间点');
    if (new Set(ids).size !== ids.length)
      throw new DomainError('VALIDATION_FAILED', '安排排序列表不能有重复项');
    const placements = ids.map((id) => this.owned(this.state.placements, ownerId, id, '安排'));
    if (placements.some((placement) => placement.timePointId !== timePointId))
      throw new DomainError('VALIDATION_FAILED', '安排不属于该时间点');
    const expected = [...this.state.placements.values()].filter(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.timePointId === timePointId &&
        !placement.deletedAt,
    );
    if (expected.length !== ids.length || expected.some((placement) => !ids.includes(placement.id)))
      throw new DomainError('VALIDATION_FAILED', '安排排序列表必须包含整个时间点列表');
    const ranks = ranksForIds(ids);
    for (const placement of placements) {
      placement.rank = ranks.get(placement.id)!.toString();
      placement.version += 1;
      placement.updatedAt = this.now();
      this.recordChange(
        ownerId,
        'placement',
        placement.id,
        placement.version,
        'upsert',
        this.placementDto(placement),
      );
    }
    return this.listPlacements(ownerId, timePointId).map(({ task, ...placement }) => {
      void task;
      return placement;
    });
  }

  rollover(
    ownerId: string,
    sourceDate: string,
  ): { operationId: string; createdIds: string[]; skippedTaskIds: string[]; targetDate: string } {
    validateLocalDate(sourceDate);
    const targetDate = nextLocalDate(sourceDate);
    const source = this.createDate(ownerId, sourceDate);
    const target = this.createDate(ownerId, targetDate);
    const sourcePlacements = [...this.state.placements.values()].filter(
      (placement) =>
        placement.ownerId === ownerId &&
        placement.timePointId === source.id &&
        !placement.deletedAt,
    );
    const createdIds: string[] = [];
    const skippedTaskIds: string[] = [];
    for (const placement of sourcePlacements) {
      const task = this.state.tasks.get(placement.taskId);
      if (!task || task.status === 'DONE' || task.deletedAt || task.archivedAt) {
        skippedTaskIds.push(placement.taskId);
        continue;
      }
      const added = this.addPlacement(ownerId, placement.taskId, target.id);
      if (added.existed) skippedTaskIds.push(placement.taskId);
      else createdIds.push(added.placement.id);
    }
    const operation: RolloverRecord = {
      id: uuidv7(),
      ownerId,
      sourceDate,
      targetDate,
      placementIds: createdIds,
      createdAt: this.now(),
      undoneAt: null,
    };
    this.state.rollovers.set(operation.id, operation);
    return { operationId: operation.id, createdIds, skippedTaskIds, targetDate };
  }

  undoRollover(
    ownerId: string,
    operationId: string,
  ): { removedIds: string[]; skippedIds: string[] } {
    const operation = this.state.rollovers.get(operationId);
    if (!operation || operation.ownerId !== ownerId)
      throw new DomainError('ENTITY_NOT_FOUND', '批量安排操作不存在');
    if (operation.undoneAt) return { removedIds: [], skippedIds: operation.placementIds };
    const removedIds: string[] = [];
    const skippedIds: string[] = [];
    for (const id of operation.placementIds) {
      const placement = this.state.placements.get(id);
      if (!placement || placement.deletedAt || placement.version !== 1) {
        skippedIds.push(id);
        continue;
      }
      placement.deletedAt = this.now();
      placement.version += 1;
      placement.updatedAt = this.now();
      this.recordChange(ownerId, 'placement', id, placement.version, 'delete', null);
      removedIds.push(id);
    }
    operation.undoneAt = this.now();
    return { removedIds, skippedIds };
  }

  search(
    ownerId: string,
    query: string,
    includeArchived = false,
    limit = 100,
  ): Array<{ task: TaskDto; project: ProjectDto | null; note: NoteDto }> {
    this.getUser(ownerId);
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    return [...this.state.tasks.values()]
      .filter(
        (task) =>
          task.ownerId === ownerId && !task.deletedAt && (includeArchived || !task.archivedAt),
      )
      .flatMap((task) => {
        const project = task.projectId ? this.state.projects.get(task.projectId) : undefined;
        const note = this.findNote(ownerId, task.id);
        const haystack = [
          task.title,
          task.referenceId,
          project?.name ?? '',
          note?.contentMarkdown ?? '',
        ]
          .join('\n')
          .toLocaleLowerCase();
        return haystack.includes(q)
          ? [
              {
                task: this.taskDto(task),
                project: project ? this.projectDto(project) : null,
                note: note
                  ? this.noteDto(note)
                  : {
                      id: '',
                      taskId: task.id,
                      contentMarkdown: '',
                      version: 0,
                      updatedAt: task.updatedAt,
                    },
              },
            ]
          : [];
      })
      .slice(0, limit);
  }

  withIdempotency<T>(
    ownerId: string,
    clientId: string,
    mutationId: string,
    input: unknown,
    action: () => T | Promise<T>,
  ): { replayed: boolean; result: T } | Promise<{ replayed: boolean; result: T }> {
    const key = `${ownerId}:${clientId}:${mutationId}`;
    const requestHash = hash(input);
    const existing = this.state.receipts.get(key);
    if (existing) {
      if (new Date(existing.expiresAt).getTime() <= this.clock().getTime()) {
        this.state.receipts.delete(key);
      } else {
        if (existing.requestHash !== requestHash)
          throw new DomainError('MUTATION_REJECTED', '同一 mutationId 不能对应不同请求');
        return { replayed: true, result: existing.result as T };
      }
    }
    const result = action();
    if (isPromiseLike(result))
      return result.then((resolved) => {
        this.saveReceipt(key, ownerId, clientId, mutationId, requestHash, resolved);
        return { replayed: false, result: resolved };
      });
    this.saveReceipt(key, ownerId, clientId, mutationId, requestHash, result);
    return { replayed: false, result };
  }

  applyMutation(ownerId: string, clientId: string, mutation: Mutation): unknown {
    return this.dispatchMutation(ownerId, clientId, mutation).result;
  }

  async applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: Mutation,
  ): Promise<{ replayed: boolean; result: unknown }> {
    return this.withIdempotency(
      ownerId,
      clientId,
      mutation.mutationId,
      mutation,
      () => this.dispatchMutation(ownerId, clientId, mutation).result,
    );
  }

  private dispatchMutation(
    ownerId: string,
    _clientId: string,
    mutation: Mutation,
  ): { result: unknown } {
    const payload = mutation.payload;
    switch (mutation.command) {
      case 'project.create':
        return {
          result: this.createProject(
            ownerId,
            stringValue(payload['name']),
            stringValue(payload['taskPrefix']),
            mutation.entityId,
          ),
        };
      case 'project.update': {
        const projectPatch: { name?: string; taskPrefix?: string } = {};
        const name = optionalString(payload['name']);
        const taskPrefix = optionalString(payload['taskPrefix']);
        if (name !== undefined) projectPatch.name = name;
        if (taskPrefix !== undefined) projectPatch.taskPrefix = taskPrefix;
        return {
          result: this.updateProject(
            ownerId,
            mutation.entityId,
            projectPatch,
            numberValue(mutation.baseVersion),
          ),
        };
      }
      case 'project.archive':
        return {
          result: this.archiveProject(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'project.restore':
        return {
          result: this.restoreProject(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'project.reorder':
        return {
          result: this.reorderProjects(ownerId, stringArrayValue(payload['ids'])),
        };
      case 'task.create': {
        const task = this.createTask(ownerId, {
          id: mutation.entityId,
          projectId: optionalNullableString(payload['projectId']),
          category: enumValue(payload['category'], ['FEATURE', 'MISC']),
          title: stringValue(payload['title']),
          priority: enumValue(payload['priority'] ?? 'NONE', ['NONE', 'LOW', 'MEDIUM', 'HIGH']),
        });
        return { result: { task, note: this.getNote(ownerId, task.id) } };
      }
      case 'task.update':
        return {
          result: this.updateTask(
            ownerId,
            mutation.entityId,
            {
              title: optionalString(payload['title']),
              projectId: optionalNullableString(payload['projectId']),
              category: optionalEnum(payload['category'], ['FEATURE', 'MISC']),
              status: optionalEnum(payload['status'], ['TODO', 'IN_PROGRESS', 'DONE']),
              priority: optionalEnum(payload['priority'], ['NONE', 'LOW', 'MEDIUM', 'HIGH']),
              rank: optionalString(payload['rank']),
            },
            numberValue(mutation.baseVersion),
          ),
        };
      case 'task.archive':
        return {
          result: this.archiveTask(ownerId, mutation.entityId, numberValue(mutation.baseVersion)),
        };
      case 'task.restore':
        return {
          result: this.restoreTask(ownerId, mutation.entityId, numberValue(mutation.baseVersion)),
        };
      case 'task.reorder':
        return { result: this.reorderTasks(ownerId, stringArrayValue(payload['ids'])) };
      case 'task.duplicate':
        return {
          result: this.duplicateTask(ownerId, mutation.entityId, {
            taskId: optionalUuid(payload['__localTaskId']),
            noteId: optionalUuid(payload['__localNoteId']),
          }),
        };
      case 'note.update':
        return {
          result: this.updateNote(
            ownerId,
            mutation.entityId,
            stringValue(payload['contentMarkdown']),
            numberValue(mutation.baseVersion),
          ),
        };
      case 'timePoint.date.create':
        return {
          result: this.createDate(ownerId, stringValue(payload['localDate']), mutation.entityId),
        };
      case 'timePoint.event.create':
        return {
          result: this.createEvent(ownerId, stringValue(payload['title']), mutation.entityId),
        };
      case 'timePoint.update':
        return {
          result: this.updateTimePoint(
            ownerId,
            mutation.entityId,
            stringValue(payload['title']),
            numberValue(mutation.baseVersion),
          ),
        };
      case 'timePoint.reach':
        return {
          result: this.reachTimePoint(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'timePoint.archive':
        return {
          result: this.archiveTimePoint(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'timePoint.restore':
        return {
          result: this.restoreTimePoint(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'timePoint.reorder':
        return {
          result: this.reorderEvents(ownerId, stringArrayValue(payload['ids'])),
        };
      case 'placement.create':
        return {
          result: this.addPlacement(
            ownerId,
            stringValue(payload['taskId']),
            stringValue(payload['timePointId']),
            optionalUuid(payload['__localId']) ?? mutation.entityId,
          ),
        };
      case 'placement.remove':
        return {
          result: this.removePlacement(
            ownerId,
            mutation.entityId,
            numberValue(mutation.baseVersion),
          ),
        };
      case 'placement.move':
        return {
          result: this.movePlacement(
            ownerId,
            mutation.entityId,
            stringValue(payload['timePointId']),
            numberValue(mutation.baseVersion),
            optionalUuid(payload['__localId']),
          ),
        };
      case 'placement.copy':
        return {
          result: this.copyPlacement(
            ownerId,
            mutation.entityId,
            stringValue(payload['timePointId']),
            optionalUuid(payload['__localId']),
          ),
        };
      case 'placement.reorder':
        return {
          result: this.reorderPlacements(
            ownerId,
            mutation.entityId,
            stringArrayValue(payload['ids']),
          ),
        };
      case 'settings.update': {
        const patch: Partial<
          Pick<SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>
        > = {};
        const timezone = optionalString(payload['timezone']);
        const defaultCaptureTarget = optionalString(payload['defaultCaptureTarget']);
        if (timezone !== undefined) patch.timezone = timezone;
        if (payload['weekStartsOn'] === 0 || payload['weekStartsOn'] === 1)
          patch.weekStartsOn = payload['weekStartsOn'];
        if (defaultCaptureTarget !== undefined) patch.defaultCaptureTarget = defaultCaptureTarget;
        return {
          result: this.updateSettings(ownerId, patch, numberValue(mutation.baseVersion)),
        };
      }
      case 'rollover.create':
        return {
          result: this.rollover(ownerId, stringValue(payload['localDate'])),
        };
      case 'rollover.undo':
        return { result: this.undoRollover(ownerId, mutation.entityId) };
      default:
        throw new DomainError('MUTATION_REJECTED', `不支持的 mutation: ${mutation.command}`);
    }
  }

  syncSnapshot(ownerId: string): {
    projects: ProjectDto[];
    tasks: TaskDto[];
    notes: NoteDto[];
    timePoints: TimePointDto[];
    placements: PlacementDto[];
    settings: SettingsDto;
    cursor: string;
  } {
    this.getUser(ownerId);
    return {
      projects: this.listAll(this.state.projects, ownerId, this.projectDto),
      tasks: this.listAll(this.state.tasks, ownerId, this.taskDto),
      notes: this.listAll(this.state.notes, ownerId, this.noteDto),
      timePoints: this.listAll(this.state.timePoints, ownerId, this.timePointDto),
      placements: this.listAll(this.state.placements, ownerId, this.placementDto),
      settings: this.getSettings(ownerId),
      cursor: this.state.cursor.toString(),
    };
  }

  syncPull(
    ownerId: string,
    cursor: string,
    limit: number,
  ): { changes: SyncChange[]; nextCursor: string; hasMore: boolean } {
    this.getUser(ownerId);
    if (!/^\d+$/.test(cursor)) throw new DomainError('VALIDATION_FAILED', 'cursor 无效');
    const requested = BigInt(cursor);
    const ownerChanges = this.state.changes.filter((change) => change.ownerId === ownerId);
    // The cursor is global across owners; use the global retention boundary
    // so a later-created owner is not incorrectly treated as expired.
    const oldest = this.state.changes[0]?.seq;
    if (oldest !== undefined && requested < oldest - 1n)
      throw new DomainError('SYNC_CURSOR_EXPIRED', '同步游标已超过保留窗口');
    const selected = ownerChanges
      .filter((change) => change.seq > requested)
      .slice(0, Math.min(limit, 500));
    const nextCursor = selected.at(-1)?.seq ?? requested;
    return {
      changes: selected,
      nextCursor: nextCursor.toString(),
      hasMore: ownerChanges.some((change) => change.seq > nextCursor),
    };
  }

  syncStatus(ownerId: string): { cursor: string; oldestCursor: string; protocolVersion: 1 } {
    this.getUser(ownerId);
    const first = this.state.changes[0];
    return {
      cursor: this.state.cursor.toString(),
      oldestCursor: first ? (first.seq - 1n).toString() : this.state.cursor.toString(),
      protocolVersion: 1,
    };
  }

  eventState(point: TimePointDto): string | null {
    return deriveEventState(point.type, point.reachedAt, point.archivedAt);
  }

  subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  protected now(): string {
    return this.clock().toISOString();
  }

  protected recordChange(
    ownerId: string,
    entityType: SyncChange['entityType'],
    entityId: string,
    entityVersion: number,
    operation: SyncChange['operation'],
    snapshot: unknown,
  ): void {
    this.state.cursor += 1n;
    this.state.changes.push({
      seq: this.state.cursor,
      ownerId,
      entityType,
      entityId,
      entityVersion,
      operation,
      snapshot,
      committedAt: this.now(),
    });
    const keepAfter = new Date(
      new Date(this.now()).getTime() - this.changeRetentionDays * 86_400_000,
    ).toISOString();
    while (this.state.changes.length > 1 && this.state.changes[0]!.committedAt < keepAfter)
      this.state.changes.shift();
    if (this.changeNotificationBatch) {
      this.changeNotificationBatch.set(ownerId, this.state.cursor.toString());
    } else {
      this.notifyChange(ownerId, this.state.cursor.toString());
    }
  }

  protected beginChangeNotificationBatch(): boolean {
    const outermost = this.changeNotificationBatch === null;
    this.changeNotificationBatch ??= new Map();
    return outermost;
  }

  protected endChangeNotificationBatch(outermost: boolean, committed: boolean): void {
    if (!outermost) return;
    const pending = this.changeNotificationBatch;
    this.changeNotificationBatch = null;
    if (!committed || !pending) return;
    for (const [ownerId, cursor] of pending) this.notifyChange(ownerId, cursor);
  }

  private notifyChange(ownerId: string, cursor: string): void {
    for (const listener of this.changeListeners) {
      try {
        listener(ownerId, cursor);
      } catch {
        // Observers (for example WebSocket clients) must not fail a committed mutation.
      }
    }
  }

  private cleanupExpiredState(): void {
    const now = this.clock().getTime();
    for (const [key, receipt] of this.state.receipts)
      if (new Date(receipt.expiresAt).getTime() <= now) this.state.receipts.delete(key);
    for (const [id, challenge] of this.state.nativeChallenges)
      if (new Date(challenge.expiresAt).getTime() <= now) this.state.nativeChallenges.delete(id);
    const keepAfter = now - this.changeRetentionDays * 86_400_000;
    while (
      this.state.changes.length > 1 &&
      new Date(this.state.changes[0]!.committedAt).getTime() < keepAfter
    )
      this.state.changes.shift();
  }

  private saveReceipt(
    key: string,
    ownerId: string,
    clientId: string,
    mutationId: string,
    requestHash: string,
    result: unknown,
  ): void {
    const now = this.now();
    this.state.receipts.set(key, {
      ownerId,
      clientId,
      mutationId,
      requestHash,
      result,
      firstProcessedAt: now,
      expiresAt: new Date(
        new Date(now).getTime() + this.mutationReceiptRetentionDays * 86_400_000,
      ).toISOString(),
    });
  }

  private findNote(ownerId: string, taskId: string): NoteRecord | undefined {
    return [...this.state.notes.values()].find(
      (note) => note.ownerId === ownerId && note.taskId === taskId && !note.deletedAt,
    );
  }
  private maxRank(ranks: Array<string | bigint>): bigint {
    return ranks.reduce<bigint>((max, value) => {
      const rank = BigInt(value);
      return rank > max ? rank : max;
    }, 0n);
  }
  private assertVersion<T>(actual: number, expected: number, snapshot: T): void {
    if (actual !== expected)
      throw new DomainError('VERSION_CONFLICT', '实体版本已变化', { server: snapshot });
  }
  private owned<T extends { ownerId: string; deletedAt?: string | null }>(
    map: Map<string, T>,
    ownerId: string,
    id: string,
    label: string,
  ): T {
    const entity = map.get(id);
    if (!entity || entity.ownerId !== ownerId || entity.deletedAt)
      throw new DomainError('ENTITY_NOT_FOUND', `${label}不存在`);
    return entity;
  }
  private listAll<T extends { ownerId: string; deletedAt: string | null }, D>(
    map: Map<string, T>,
    ownerId: string,
    dto: (entity: T) => D,
  ): D[] {
    return [...map.values()]
      .filter((entity) => entity.ownerId === ownerId && !entity.deletedAt)
      .map(dto);
  }
  private userDto(user: UserRecord): UserDto {
    return { id: user.id, username: user.username, createdAt: user.createdAt };
  }
  private settingsDto(settings: SettingsRecord): SettingsDto {
    const { ownerId, timezone, weekStartsOn, defaultCaptureTarget, version, updatedAt } = settings;
    return { ownerId, timezone, weekStartsOn, defaultCaptureTarget, version, updatedAt };
  }
  private projectDto(project: ProjectRecord): ProjectDto {
    const { id, name, taskPrefix, rank, version, archivedAt, createdAt, updatedAt } = project;
    return { id, name, taskPrefix, rank, version, archivedAt, createdAt, updatedAt };
  }
  private taskDto(task: TaskRecord): TaskDto {
    const {
      id,
      referenceId,
      projectId,
      category,
      title,
      status,
      priority,
      rank,
      version,
      completedAt,
      archivedAt,
      createdAt,
      updatedAt,
    } = task;
    return {
      id,
      referenceId,
      projectId,
      category,
      title,
      status,
      priority,
      rank,
      version,
      completedAt,
      archivedAt,
      createdAt,
      updatedAt,
    };
  }
  private noteDto(note: NoteRecord): NoteDto {
    const { id, taskId, contentMarkdown, version, updatedAt } = note;
    return { id, taskId, contentMarkdown, version, updatedAt };
  }
  private timePointDto(point: TimePointRecord): TimePointDto {
    const {
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
    } = point;
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
    };
  }
  private placementDto(placement: PlacementRecord): PlacementDto {
    const { id, taskId, timePointId, rank, version, createdAt, updatedAt } = placement;
    return { id, taskId, timePointId, rank, version, createdAt, updatedAt };
  }
  private deviceDto(device: DeviceRecord): DeviceDto {
    const { id, name, platform, lastSeenAt, createdAt, revokedAt } = device;
    return { id, name, platform, lastSeenAt, createdAt, revokedAt };
  }
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  withMutation<T>(fn: () => T | Promise<T>): Promise<T>;
  createNativeChallenge(origin: string, expiresAt: string): MaybePromise<string>;
  consumeNativeChallenge(id: string, origin: string): MaybePromise<boolean>;
  hasOwner(): MaybePromise<boolean>;
  getUserRecord(ownerId: string): MaybePromise<UserRecord>;
  getUser(ownerId: string): MaybePromise<UserDto>;
  findUserByUsername(username: string): MaybePromise<UserRecord | undefined>;
  createOwner(username: string, passwordHash: string): MaybePromise<UserDto>;
  getSettings(ownerId: string): MaybePromise<SettingsDto>;
  updateSettings(
    ownerId: string,
    patch: Partial<Pick<SettingsDto, 'timezone' | 'weekStartsOn' | 'defaultCaptureTarget'>>,
    baseVersion: number,
  ): MaybePromise<SettingsDto>;
  createDevice(
    ownerId: string,
    id: string | undefined,
    name: string,
    platform: string,
  ): MaybePromise<DeviceDto>;
  listDevices(ownerId: string): MaybePromise<DeviceDto[]>;
  getDevice(ownerId: string, id: string): MaybePromise<DeviceRecord>;
  revokeDevice(ownerId: string, id: string): MaybePromise<void>;
  createSession(
    ownerId: string,
    deviceId: string,
    tokenHash: string,
    expiresAt: string,
  ): MaybePromise<RefreshSessionRecord>;
  findSessionByHash(tokenHash: string): MaybePromise<RefreshSessionRecord | undefined>;
  rotateSession(
    sessionId: string,
    nextTokenHash: string,
    expiresAt: string,
  ): MaybePromise<{ session: RefreshSessionRecord; device: DeviceRecord }>;
  revokeSessionChain(session: RefreshSessionRecord): MaybePromise<void>;
  createProject(
    ownerId: string,
    name: string,
    taskPrefix: string,
    id?: string,
  ): MaybePromise<ProjectDto>;
  listProjects(ownerId: string, archived?: boolean): MaybePromise<ProjectDto[]>;
  getProject(ownerId: string, id: string, includeArchived?: boolean): MaybePromise<ProjectDto>;
  updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; taskPrefix?: string },
    baseVersion: number,
  ): MaybePromise<ProjectDto>;
  archiveProject(ownerId: string, id: string, baseVersion: number): MaybePromise<ProjectDto>;
  restoreProject(ownerId: string, id: string, baseVersion: number): MaybePromise<ProjectDto>;
  reorderProjects(ownerId: string, ids: string[]): MaybePromise<ProjectDto[]>;
  createTask(
    ownerId: string,
    input: {
      id?: string;
      projectId?: string | null;
      category: TaskCategory;
      title: string;
      priority: TaskPriority;
    },
  ): MaybePromise<TaskDto>;
  listTasks(ownerId: string, filters?: TaskFilters): MaybePromise<TaskDto[]>;
  getTask(ownerId: string, id: string, includeArchived?: boolean): MaybePromise<TaskDto>;
  getTaskDetails(
    ownerId: string,
    taskId: string,
  ): MaybePromise<{
    task: TaskDto;
    note: NoteDto;
    placements: PlacementDto[];
  }>;
  updateTask(
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
  ): MaybePromise<TaskDto>;
  archiveTask(ownerId: string, id: string, baseVersion: number): MaybePromise<TaskDto>;
  restoreTask(ownerId: string, id: string, baseVersion: number): MaybePromise<TaskDto>;
  reorderTasks(ownerId: string, ids: string[]): MaybePromise<TaskDto[]>;
  duplicateTask(
    ownerId: string,
    id: string,
    requestedIds?: { taskId?: string; noteId?: string },
  ): MaybePromise<{ task: TaskDto; note: NoteDto }>;
  getNote(ownerId: string, taskId: string): MaybePromise<NoteDto>;
  updateNote(
    ownerId: string,
    taskId: string,
    contentMarkdown: string,
    baseVersion: number,
  ): MaybePromise<NoteDto>;
  createDate(ownerId: string, localDate: string, id?: string): MaybePromise<TimePointDto>;
  createEvent(ownerId: string, title: string, id?: string): MaybePromise<TimePointDto>;
  listTimePoints(
    ownerId: string,
    type?: TimePointType,
    archived?: boolean,
  ): MaybePromise<TimePointDto[]>;
  getTimePoint(ownerId: string, id: string): MaybePromise<TimePointDto>;
  updateTimePoint(
    ownerId: string,
    id: string,
    title: string,
    baseVersion: number,
  ): MaybePromise<TimePointDto>;
  reachTimePoint(ownerId: string, id: string, baseVersion: number): MaybePromise<TimePointDto>;
  archiveTimePoint(ownerId: string, id: string, baseVersion: number): MaybePromise<TimePointDto>;
  restoreTimePoint(ownerId: string, id: string, baseVersion: number): MaybePromise<TimePointDto>;
  reorderEvents(ownerId: string, ids: string[]): MaybePromise<TimePointDto[]>;
  addPlacement(
    ownerId: string,
    taskId: string,
    timePointId: string,
    id?: string,
  ): MaybePromise<{ placement: PlacementDto; existed: boolean }>;
  listPlacements(
    ownerId: string,
    timePointId: string,
  ): MaybePromise<Array<PlacementDto & { task: TaskDto }>>;
  removePlacement(ownerId: string, id: string, baseVersion: number): MaybePromise<PlacementDto>;
  movePlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    baseVersion: number,
    targetPlacementId?: string,
  ): MaybePromise<{ placement: PlacementDto; sourcePlacementId: string; existed: boolean }>;
  copyPlacement(
    ownerId: string,
    id: string,
    targetTimePointId: string,
    targetPlacementId?: string,
  ): MaybePromise<{ placement: PlacementDto; existed: boolean }>;
  reorderPlacements(
    ownerId: string,
    timePointId: string,
    ids: string[],
  ): MaybePromise<PlacementDto[]>;
  rollover(
    ownerId: string,
    sourceDate: string,
  ): MaybePromise<{
    operationId: string;
    createdIds: string[];
    skippedTaskIds: string[];
    targetDate: string;
  }>;
  undoRollover(
    ownerId: string,
    operationId: string,
  ): MaybePromise<{
    removedIds: string[];
    skippedIds: string[];
  }>;
  search(
    ownerId: string,
    query: string,
    includeArchived?: boolean,
    limit?: number,
  ): MaybePromise<Array<{ task: TaskDto; project: ProjectDto | null; note: NoteDto }>>;
  withIdempotency<T>(
    ownerId: string,
    clientId: string,
    mutationId: string,
    input: unknown,
    action: () => T | Promise<T>,
  ): MaybePromise<{ replayed: boolean; result: T }>;
  applyMutationIdempotent(
    ownerId: string,
    clientId: string,
    mutation: Mutation,
  ): MaybePromise<{ replayed: boolean; result: unknown }>;
  syncSnapshot(ownerId: string): MaybePromise<{
    projects: ProjectDto[];
    tasks: TaskDto[];
    notes: NoteDto[];
    timePoints: TimePointDto[];
    placements: PlacementDto[];
    settings: SettingsDto;
    cursor: string;
  }>;
  syncPull(
    ownerId: string,
    cursor: string,
    limit: number,
  ): MaybePromise<{ changes: SyncChange[]; nextCursor: string; hasMore: boolean }>;
  syncStatus(ownerId: string): MaybePromise<{
    cursor: string;
    oldestCursor: string;
    protocolVersion: 1;
  }>;
  eventState(point: TimePointDto): string | null;
  subscribeChanges(listener: (ownerId: string, cursor: string) => void): () => void;
}

type MaybePromise<T> = T | Promise<T>;

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function restoreStoreState(target: StoreState, snapshot: StoreState): void {
  target.users.clear();
  for (const [id, row] of snapshot.users) target.users.set(id, row);
  target.settings.clear();
  for (const [id, row] of snapshot.settings) target.settings.set(id, row);
  target.projects.clear();
  for (const [id, row] of snapshot.projects) target.projects.set(id, row);
  target.tasks.clear();
  for (const [id, row] of snapshot.tasks) target.tasks.set(id, row);
  target.notes.clear();
  for (const [id, row] of snapshot.notes) target.notes.set(id, row);
  target.timePoints.clear();
  for (const [id, row] of snapshot.timePoints) target.timePoints.set(id, row);
  target.placements.clear();
  for (const [id, row] of snapshot.placements) target.placements.set(id, row);
  target.devices.clear();
  for (const [id, row] of snapshot.devices) target.devices.set(id, row);
  target.sessions.clear();
  for (const [id, row] of snapshot.sessions) target.sessions.set(id, row);
  target.receipts.clear();
  for (const [id, row] of snapshot.receipts) target.receipts.set(id, row);
  target.rollovers.clear();
  for (const [id, row] of snapshot.rollovers) target.rollovers.set(id, row);
  target.nativeChallenges.clear();
  for (const [id, row] of snapshot.nativeChallenges) target.nativeChallenges.set(id, row);
  target.changes.splice(0, target.changes.length, ...snapshot.changes);
  target.cursor = snapshot.cursor;
}

function newEntityId(value: string | undefined): string {
  const id = value ?? uuidv7();
  if (!uuidSchema.safeParse(id).success)
    throw new DomainError('VALIDATION_FAILED', 'UUID 参数无效');
  return id;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function rankSort(a: { rank: string }, b: { rank: string }): number {
  const left = BigInt(a.rank);
  const right = BigInt(b.rank);
  return left < right ? -1 : left > right ? 1 : 0;
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
    throw new DomainError('VALIDATION_FAILED', '枚举值无效');
  return value as T;
}
function optionalEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return value === undefined ? undefined : enumValue(value, values);
}
