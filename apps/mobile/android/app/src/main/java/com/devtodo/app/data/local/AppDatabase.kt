package com.devtodo.app.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        ProjectEntity::class,
        TaskEntity::class,
        NoteEntity::class,
        TimePointEntity::class,
        PlacementEntity::class,
        SettingsEntity::class,
        OutboxEntity::class,
        ConflictEntity::class,
        SyncMetaEntity::class
    ],
    version = 3,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun projectDao(): ProjectDao
    abstract fun taskDao(): TaskDao
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
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                .fallbackToDestructiveMigration()
                .build().also { INSTANCE = it }
            }
        }

        private val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE outbox ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''")
            }
        }

        private val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conflicts ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''")
            }
        }
    }
}
