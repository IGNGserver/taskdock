package com.devtodo.app.data.local

import androidx.room.*
import com.devtodo.app.data.model.TaskStatus
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    @Query("SELECT * FROM projects WHERE archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getAllProjectsFlow(): Flow<List<ProjectEntity>>

    @Query("SELECT * FROM projects WHERE id = :id")
    suspend fun getProjectById(id: String): ProjectEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProjects(projects: List<ProjectEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProject(project: ProjectEntity)

    @Query("DELETE FROM projects WHERE id = :id")
    suspend fun deleteProject(id: String)
}

@Dao
interface TaskDao {
    @Query("SELECT * FROM tasks WHERE archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getAllTasksFlow(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE projectId IS NULL AND category = 'MISC' AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getInboxTasksFlow(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE projectId = :projectId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getTasksByProjectFlow(projectId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE id = :id")
    suspend fun getTaskById(id: String): TaskEntity?

    @Query("SELECT * FROM tasks WHERE id = :id")
    fun getTaskByIdFlow(id: String): Flow<TaskEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTasks(tasks: List<TaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTask(task: TaskEntity)

    @Query("DELETE FROM tasks WHERE id = :id")
    suspend fun deleteTask(id: String)

    @Query("SELECT * FROM tasks WHERE archivedAt IS NOT NULL ORDER BY updatedAt DESC")
    fun getArchivedTasksFlow(): Flow<List<TaskEntity>>
}

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE taskId = :taskId LIMIT 1")
    suspend fun getNoteByTaskId(taskId: String): NoteEntity?

    @Query("SELECT * FROM notes WHERE taskId = :taskId LIMIT 1")
    fun getNoteByTaskIdFlow(taskId: String): Flow<NoteEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNotes(notes: List<NoteEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNote(note: NoteEntity)

    @Query("DELETE FROM notes WHERE taskId = :taskId")
    suspend fun deleteNoteByTaskId(taskId: String)
}

@Dao
interface TimePointDao {
    @Query("SELECT * FROM time_points WHERE type = 'DATE' AND localDate = :localDate AND archivedAt IS NULL LIMIT 1")
    suspend fun getTimePointByDate(localDate: String): TimePointEntity?

    @Query("SELECT * FROM time_points WHERE type = 'EVENT' AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getActiveEventsFlow(): Flow<List<TimePointEntity>>

    @Query("SELECT * FROM time_points WHERE id = :id")
    suspend fun getTimePointById(id: String): TimePointEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoints(timePoints: List<TimePointEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoint(timePoint: TimePointEntity)
}

@Dao
interface PlacementDao {
    @Query("SELECT * FROM placements WHERE timePointId = :timePointId ORDER BY CAST(rank AS INTEGER) ASC")
    fun getPlacementsByTimePointFlow(timePointId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE timePointId = :timePointId ORDER BY CAST(rank AS INTEGER) ASC")
    suspend fun getPlacementsByTimePoint(timePointId: String): List<PlacementEntity>

    @Query("SELECT * FROM placements WHERE taskId = :taskId")
    fun getPlacementsByTaskFlow(taskId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE taskId = :taskId")
    suspend fun getPlacementsByTaskId(taskId: String): List<PlacementEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacements(placements: List<PlacementEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacement(placement: PlacementEntity)

    @Query("DELETE FROM placements WHERE id = :id")
    suspend fun deletePlacement(id: String)
}

@Dao
interface SettingsDao {
    @Query("SELECT * FROM settings WHERE ownerId = :ownerId LIMIT 1")
    suspend fun getSettings(ownerId: String): SettingsEntity?

    @Query("SELECT * FROM settings LIMIT 1")
    fun getSettingsFlow(): Flow<SettingsEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSettings(settings: SettingsEntity)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY id ASC")
    suspend fun getPendingItems(): List<OutboxEntity>

    @Query("SELECT * FROM outbox ORDER BY id ASC")
    fun getPendingItemsFlow(): Flow<List<OutboxEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: OutboxEntity): Long

    @Query("DELETE FROM outbox WHERE mutationId = :mutationId")
    suspend fun deleteByMutationId(mutationId: String)

    @Query("UPDATE outbox SET attempts = attempts + 1, nextAttemptAt = :nextAttemptAt, lastError = :error WHERE id = :id")
    suspend fun recordAttempt(id: Long, nextAttemptAt: Long, error: String?)
}

@Dao
interface ConflictDao {
    @Query("SELECT * FROM conflicts WHERE resolvedAt IS NULL ORDER BY id DESC")
    fun getUnresolvedConflictsFlow(): Flow<List<ConflictEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(conflict: ConflictEntity): Long

    @Query("UPDATE conflicts SET resolvedAt = :resolvedAt WHERE id = :id")
    suspend fun markResolved(id: Long, resolvedAt: String)
}

@Dao
interface SyncMetaDao {
    @Query("SELECT value FROM sync_meta WHERE `key` = :key LIMIT 1")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun set(meta: SyncMetaEntity)
}
