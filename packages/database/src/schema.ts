import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  smallint,
} from 'drizzle-orm/pg-core';

const timestamps = {
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    nextMiscTaskNumber: integer('next_misc_task_number').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_username_uq').on(table.username)],
);

export const userSettings = pgTable('user_settings', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => users.id),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  weekStartsOn: smallint('week_starts_on').notNull().default(1),
  defaultCaptureTarget: text('default_capture_target').notNull().default('GLOBAL_MISC'),
  ...timestamps,
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 160 }).notNull(),
    taskPrefix: varchar('task_prefix', { length: 10 }).notNull(),
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    rank: bigint('rank', { mode: 'bigint' }).notNull().default(1024n),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('projects_owner_archived_rank_idx').on(table.ownerId, table.archivedAt, table.rank),
    uniqueIndex('projects_owner_prefix_uq').on(table.ownerId, table.taskPrefix),
    uniqueIndex('projects_owner_id_uq').on(table.ownerId, table.id),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    projectId: uuid('project_id'),
    category: text('category').notNull(),
    referenceId: varchar('reference_id', { length: 32 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    status: text('status').notNull().default('TODO'),
    priority: text('priority').notNull().default('NONE'),
    rank: bigint('rank', { mode: 'bigint' }).notNull().default(1024n),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tasks_owner_reference_uq').on(table.ownerId, table.referenceId),
    uniqueIndex('tasks_owner_id_uq').on(table.ownerId, table.id),
    foreignKey({
      name: 'tasks_owner_project_fk',
      columns: [table.ownerId, table.projectId],
      foreignColumns: [projects.ownerId, projects.id],
    }),
    index('tasks_owner_project_category_idx').on(
      table.ownerId,
      table.projectId,
      table.category,
      table.archivedAt,
      table.status,
      table.rank,
    ),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    taskId: uuid('task_id').notNull(),
    contentMarkdown: text('content_markdown').notNull().default(''),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('notes_owner_task_uq').on(table.ownerId, table.taskId),
    foreignKey({
      name: 'notes_owner_task_fk',
      columns: [table.ownerId, table.taskId],
      foreignColumns: [tasks.ownerId, tasks.id],
    }),
  ],
);

export const timePoints = pgTable(
  'time_points',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    localDate: date('local_date'),
    title: varchar('title', { length: 200 }),
    rank: bigint('rank', { mode: 'bigint' }).notNull().default(1024n),
    reachedAt: timestamp('reached_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('time_points_owner_type_date_idx').on(table.ownerId, table.type, table.localDate),
    index('time_points_owner_event_state_idx').on(
      table.ownerId,
      table.type,
      table.archivedAt,
      table.reachedAt,
    ),
    uniqueIndex('time_points_owner_id_uq').on(table.ownerId, table.id),
  ],
);

export const placements = pgTable(
  'placements',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    taskId: uuid('task_id').notNull(),
    timePointId: uuid('time_point_id').notNull(),
    rank: bigint('rank', { mode: 'bigint' }).notNull().default(1024n),
    ...timestamps,
  },
  (table) => [
    index('placements_owner_timepoint_rank_idx').on(table.ownerId, table.timePointId, table.rank),
    uniqueIndex('placements_task_timepoint_active_uq')
      .on(table.taskId, table.timePointId)
      .where(sql`deleted_at IS NULL`),
    foreignKey({
      name: 'placements_owner_task_fk',
      columns: [table.ownerId, table.taskId],
      foreignColumns: [tasks.ownerId, tasks.id],
    }),
    foreignKey({
      name: 'placements_owner_time_point_fk',
      columns: [table.ownerId, table.timePointId],
      foreignColumns: [timePoints.ownerId, timePoints.id],
    }),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 100 }).notNull(),
    platform: varchar('platform', { length: 40 }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('devices_owner_id_uq').on(table.ownerId, table.id)],
);

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    replacedById: uuid('replaced_by_id'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refresh_sessions_token_hash_uq').on(table.tokenHash),
    uniqueIndex('refresh_sessions_owner_id_uq').on(table.ownerId, table.id),
    foreignKey({
      name: 'refresh_sessions_owner_device_fk',
      columns: [table.ownerId, table.deviceId],
      foreignColumns: [devices.ownerId, devices.id],
    }),
    foreignKey({
      name: 'refresh_sessions_owner_replaced_by_fk',
      columns: [table.ownerId, table.replacedById],
      foreignColumns: [table.ownerId, table.id],
    }),
  ],
);

export const clientMutations = pgTable(
  'client_mutations',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    clientId: uuid('client_id').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').notNull(),
    firstProcessedAt: timestamp('first_processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.clientId, table.mutationId] })],
);

export const syncChanges = pgTable(
  'sync_changes',
  {
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    entityVersion: integer('entity_version').notNull(),
    operation: varchar('operation', { length: 20 }).notNull(),
    snapshot: jsonb('snapshot'),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sync_changes_owner_seq_idx').on(table.ownerId, table.seq)],
);

export const rolloverOperations = pgTable('rollover_operations', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  sourceDate: date('source_date').notNull(),
  targetDate: date('target_date').notNull(),
  placementIds: jsonb('placement_ids').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type TimePointRow = typeof timePoints.$inferSelect;
export type PlacementRow = typeof placements.$inferSelect;
