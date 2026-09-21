package com.devtodo.app.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ProjectEntity::class,
        TaskEntity::class,
        NoteEntity::class,
        TimePointEntity::class,
        PlacementEntity::class,
        FolderEntity::class,
        TaskStepEntity::class,
        WorkflowEntity::class,
        WorkflowStageEntity::class,
        WorkflowTaskMembershipEntity::class,
        ArchiveOperationEntity::class,
        SettingsEntity::class,
        OutboxEntity::class,
        ConflictEntity::class,
        SyncMetaEntity::class
    ],
    version = 7,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun projectDao(): ProjectDao
    abstract fun folderDao(): FolderDao
    abstract fun taskDao(): TaskDao
    abstract fun taskStepDao(): TaskStepDao
    abstract fun workflowDao(): WorkflowDao
    abstract fun archiveOperationDao(): ArchiveOperationDao
    abstract fun noteDao(): NoteDao
    abstract fun timePointDao(): TimePointDao
    abstract fun placementDao(): PlacementDao
    abstract fun settingsDao(): SettingsDao
    abstract fun outboxDao(): OutboxDao
    abstract fun conflictDao(): ConflictDao
    abstract fun syncMetaDao(): SyncMetaDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "devtodo_local.db"
                )
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7)
                .build().also { INSTANCE = it }
            }
        }

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE outbox ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''")
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conflicts ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''")
            }
        }

        internal val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE tasks ADD COLUMN parentFolderId TEXT")
                db.execSQL("ALTER TABLE tasks ADD COLUMN completedAt TEXT")
                db.execSQL("ALTER TABLE tasks ADD COLUMN archivedByOperationId TEXT")
                db.execSQL("ALTER TABLE tasks ADD COLUMN deletedAt TEXT")

                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS folders (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        parentFolderId TEXT,
                        title TEXT NOT NULL,
                        rank TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        archivedAt TEXT,
                        archivedByOperationId TEXT,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        deletedAt TEXT,
                        pendingSync INTEGER NOT NULL DEFAULT 0
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_folders_ownerId_parentFolderId ON folders(ownerId, parentFolderId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_folders_ownerId_archivedAt ON folders(ownerId, archivedAt)")
                db.execSQL("""
                    INSERT OR IGNORE INTO folders (id, ownerId, parentFolderId, title, rank, version, archivedAt, archivedByOperationId, createdAt, updatedAt, deletedAt, pendingSync)
                    SELECT id, ownerId, NULL, name, rank, version, archivedAt, NULL, createdAt, updatedAt, NULL, pendingSync
                    FROM projects
                """.trimIndent())
                db.execSQL("UPDATE tasks SET parentFolderId = projectId WHERE parentFolderId IS NULL AND projectId IS NOT NULL")

                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS task_steps (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        taskId TEXT NOT NULL,
                        title TEXT NOT NULL,
                        noteMarkdown TEXT NOT NULL,
                        status TEXT NOT NULL,
                        rank TEXT NOT NULL,
                        completedAt TEXT,
                        version INTEGER NOT NULL,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        deletedAt TEXT,
                        pendingSync INTEGER NOT NULL DEFAULT 0
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_task_steps_ownerId_taskId ON task_steps(ownerId, taskId)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS workflows (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        name TEXT NOT NULL,
                        rank TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        archivedAt TEXT,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        deletedAt TEXT,
                        pendingSync INTEGER NOT NULL DEFAULT 0
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_workflows_ownerId_archivedAt ON workflows(ownerId, archivedAt)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS workflow_stages (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        workflowId TEXT NOT NULL,
                        name TEXT NOT NULL,
                        rank TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        deletedAt TEXT,
                        pendingSync INTEGER NOT NULL DEFAULT 0
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_workflow_stages_ownerId_workflowId ON workflow_stages(ownerId, workflowId)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS workflow_task_memberships (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        workflowId TEXT NOT NULL,
                        stageId TEXT NOT NULL,
                        taskId TEXT NOT NULL,
                        rank TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        deletedAt TEXT,
                        pendingSync INTEGER NOT NULL DEFAULT 0
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_workflow_task_memberships_ownerId_workflowId ON workflow_task_memberships(ownerId, workflowId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_workflow_task_memberships_ownerId_stageId ON workflow_task_memberships(ownerId, stageId)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS archive_operations (
                        id TEXT NOT NULL PRIMARY KEY,
                        ownerId TEXT NOT NULL,
                        rootFolderId TEXT NOT NULL,
                        rootBaseVersion INTEGER NOT NULL,
                        folderCount INTEGER NOT NULL,
                        taskCount INTEGER NOT NULL,
                        createdAt TEXT NOT NULL,
                        restoredAt TEXT
                    )
                """.trimIndent())
                db.execSQL("INSERT OR REPLACE INTO sync_meta (`key`, value) VALUES ('v2_protocol', '2')")
            }
        }

        internal val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE notes ADD COLUMN deletedAt TEXT")
                db.execSQL("ALTER TABLE time_points ADD COLUMN deletedAt TEXT")
                db.execSQL("ALTER TABLE placements ADD COLUMN deletedAt TEXT")
            }
        }

        internal val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE settings ADD COLUMN weekStartsOn INTEGER NOT NULL DEFAULT 1")
            }
        }

        internal val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            }
        }
    }
}
