import { z } from 'zod';

export const taskStatuses = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
export const taskCategories = ['FEATURE', 'MISC'] as const;
export const taskPriorities = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const timePointTypes = ['DATE', 'EVENT'] as const;

export const TaskStatusSchema = z.enum(taskStatuses);
export const TaskCategorySchema = z.enum(taskCategories);
export const TaskPrioritySchema = z.enum(taskPriorities);
export const TimePointTypeSchema = z.enum(timePointTypes);
export const uuidSchema = z.string().uuid();
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD');
export const rankSchema = z.string().regex(/^\d+$/, 'rank 必须是十进制整数字符串');

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskCategory = z.infer<typeof TaskCategorySchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TimePointType = z.infer<typeof TimePointTypeSchema>;

export interface UserDto {
  id: string;
  username: string;
  createdAt: string;
}

export interface SettingsDto {
  ownerId: string;
  timezone: string;
  weekStartsOn: 0 | 1;
  defaultCaptureTarget: string;
  version: number;
  updatedAt: string;
}

export const captureTargets = ['GLOBAL_MISC', 'RECENT_CONTEXT'] as const;
export type CaptureTarget = (typeof captureTargets)[number];

export interface ProjectDto {
  id: string;
  name: string;
  taskPrefix: string;
  rank: string;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDto {
  id: string;
  referenceId: string;
  projectId: string | null;
  category: TaskCategory;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  rank: string;
  version: number;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTaskDto extends Omit<TaskDto, 'referenceId'> {
  referenceId: string | null;
  pendingSync?: boolean;
}

export interface NoteDto {
  id: string;
  taskId: string;
  contentMarkdown: string;
  version: number;
  updatedAt: string;
}

export interface TimePointDto {
  id: string;
  type: TimePointType;
  localDate: string | null;
  title: string | null;
  rank: string;
  version: number;
  reachedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlacementDto {
  id: string;
  taskId: string;
  timePointId: string;
  rank: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceDto {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export const errorCodes = [
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_SESSION_REVOKED',
  'BOOTSTRAP_ALREADY_COMPLETED',
  'BOOTSTRAP_TOKEN_INVALID',
  'VALIDATION_FAILED',
  'ENTITY_NOT_FOUND',
  'ENTITY_ARCHIVED',
  'VERSION_CONFLICT',
  'PLACEMENT_ALREADY_EXISTS',
  'INVALID_STATE_TRANSITION',
  'SYNC_CURSOR_EXPIRED',
  'SYNC_PROTOCOL_UNSUPPORTED',
  'MUTATION_REJECTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId: string;
  details: unknown;
}

export const mutationSchema = z.object({
  mutationId: uuidSchema,
  command: z.string().min(1).max(80),
  entityId: uuidSchema,
  baseVersion: z.number().int().nonnegative().nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
});
export type Mutation = z.infer<typeof mutationSchema>;

export const pushSchema = z.object({
  protocolVersion: z.literal(1),
  clientId: uuidSchema,
  mutations: z.array(mutationSchema).max(500),
});
export type PushRequest = z.infer<typeof pushSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  taskPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/),
});
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  taskPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/)
    .optional(),
  baseVersion: z.number().int().positive(),
});
export const createTaskSchema = z.object({
  id: uuidSchema.optional(),
  projectId: uuidSchema.nullable().optional(),
  category: TaskCategorySchema,
  title: z.string().trim().min(1).max(500),
  priority: TaskPrioritySchema.default('NONE'),
});
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  projectId: uuidSchema.nullable().optional(),
  category: TaskCategorySchema.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  rank: rankSchema.optional(),
  baseVersion: z.number().int().positive(),
});
export const noteSchema = z.object({
  contentMarkdown: z.string().max(1024 * 1024),
  baseVersion: z.number().int().positive(),
});
export const createEventSchema = z.object({ title: z.string().trim().min(1).max(200) });
export const updateTimePointSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  baseVersion: z.number().int().positive(),
});
export const createPlacementSchema = z.object({ taskId: uuidSchema, timePointId: uuidSchema });
export const placementTargetSchema = z.object({ timePointId: uuidSchema });
export const reorderSchema = z.object({
  ids: z.array(uuidSchema).max(1000),
  baseVersion: z.number().int().positive().optional(),
});
export const bootstrapSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(12).max(200),
});
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  deviceId: uuidSchema.optional(),
  deviceName: z.string().trim().min(1).max(100).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
});

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
