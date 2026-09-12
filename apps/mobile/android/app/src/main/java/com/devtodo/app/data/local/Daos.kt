package com.devtodo.app.data.local

import androidx.room.*
import com.devtodo.app.data.model.TaskStatus
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    @Query("SELECT * FROM projects WHERE ownerId = :ownerId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getAllProjectsFlow(ownerId: String): Flow<List<ProjectEntity>>

    @Query("SELECT * FROM projects WHERE id = :id AND ownerId = :ownerId")
    suspend fun getProjectById(id: String, ownerId: String): ProjectEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProjects(projects: List<ProjectEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProject(project: ProjectEntity)

    @Query("DELETE FROM projects WHERE id = :id AND ownerId = :ownerId")
    suspend fun deleteProject(id: String, ownerId: String)
}

@Dao
interface TaskDao {
    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getAllTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND projectId IS NULL AND category = 'MISC' AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getInboxTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND projectId = :projectId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getTasksByProjectFlow(projectId: String, ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE id = :id AND ownerId = :ownerId")
    suspend fun getTaskById(id: String, ownerId: String): TaskEntity?

    @Query("SELECT * FROM tasks WHERE id = :id AND ownerId = :ownerId")
    fun getTaskByIdFlow(id: String, ownerId: String): Flow<TaskEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTasks(tasks: List<TaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTask(task: TaskEntity)

    @Query("DELETE FROM tasks WHERE id = :id AND ownerId = :ownerId")
    suspend fun deleteTask(id: String, ownerId: String)

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NOT NULL ORDER BY updatedAt DESC")
    fun getArchivedTasksFlow(ownerId: String): Flow<List<TaskEntity>>
}

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE taskId = :taskId AND ownerId = :ownerId LIMIT 1")
    suspend fun getNoteByTaskId(taskId: String, ownerId: String): NoteEntity?

    @Query("SELECT * FROM notes WHERE taskId = :taskId AND ownerId = :ownerId LIMIT 1")
    fun getNoteByTaskIdFlow(taskId: String, ownerId: String): Flow<NoteEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNotes(notes: List<NoteEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNote(note: NoteEntity)

    @Query("DELETE FROM notes WHERE taskId = :taskId AND ownerId = :ownerId")
    suspend fun deleteNoteByTaskId(taskId: String, ownerId: String)
}

@Dao
interface TimePointDao {
    @Query("SELECT * FROM time_points WHERE ownerId = :ownerId AND type = 'DATE' AND localDate = :localDate AND archivedAt IS NULL LIMIT 1")
    suspend fun getTimePointByDate(ownerId: String, localDate: String): TimePointEntity?

    @Query("SELECT * FROM time_points WHERE ownerId = :ownerId AND type = 'EVENT' AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getActiveEventsFlow(ownerId: String): Flow<List<TimePointEntity>>

    @Query("SELECT * FROM time_points WHERE id = :id AND ownerId = :ownerId")
    suspend fun getTimePointById(id: String, ownerId: String): TimePointEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoints(timePoints: List<TimePointEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoint(timePoint: TimePointEntity)
}

@Dao
interface PlacementDao {
    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND timePointId = :timePointId ORDER BY CAST(rank AS INTEGER) ASC")
    fun getPlacementsByTimePointFlow(ownerId: String, timePointId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND timePointId = :timePointId ORDER BY CAST(rank AS INTEGER) ASC")
    suspend fun getPlacementsByTimePoint(timePointId: String, ownerId: String): List<PlacementEntity>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId")
    fun getPlacementsByTaskFlow(taskId: String, ownerId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId")
    suspend fun getPlacementsByTaskId(taskId: String, ownerId: String): List<PlacementEntity>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId")
    suspend fun getPlacementsByTaskIdForOwner(ownerId: String, taskId: String): List<PlacementEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacements(placements: List<PlacementEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacement(placement: PlacementEntity)

    @Query("DELETE FROM placements WHERE id = :id AND ownerId = :ownerId")
    suspend fun deletePlacement(id: String, ownerId: String)

    @Query("DELETE FROM placements WHERE ownerId = :ownerId AND id = :id")
    suspend fun deletePlacementForOwner(ownerId: String, id: String)
}

@Dao
interface SettingsDao {
    @Query("SELECT * FROM settings WHERE ownerId = :ownerId LIMIT 1")
    suspend fun getSettings(ownerId: String): SettingsEntity?

    @Query("SELECT * FROM settings WHERE ownerId = :ownerId LIMIT 1")
    fun getSettingsFlow(ownerId: String): Flow<SettingsEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSettings(settings: SettingsEntity)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox WHERE ownerId = :ownerId ORDER BY id ASC")
    suspend fun getPendingItems(ownerId: String): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE ownerId = :ownerId ORDER BY id ASC")
    fun getPendingItemsFlow(ownerId: String): Flow<List<OutboxEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: OutboxEntity): Long

    @Query("DELETE FROM outbox WHERE mutationId = :mutationId AND ownerId = :ownerId")
    suspend fun deleteByMutationId(mutationId: String, ownerId: String)

    @Query("UPDATE outbox SET attempts = attempts + 1, nextAttemptAt = :nextAttemptAt, lastError = :error WHERE id = :id AND ownerId = :ownerId")
    suspend fun recordAttempt(id: Long, ownerId: String, nextAttemptAt: Long, error: String?)
}

@Dao
interface ConflictDao {
    @Query("SELECT * FROM conflicts WHERE ownerId = :ownerId AND resolvedAt IS NULL ORDER BY id DESC")
    fun getUnresolvedConflictsFlow(ownerId: String): Flow<List<ConflictEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(conflict: ConflictEntity): Long

    @Query("UPDATE conflicts SET resolvedAt = :resolvedAt WHERE id = :id AND ownerId = :ownerId")
    suspend fun markResolved(id: Long, ownerId: String, resolvedAt: String)
}

@Dao
interface SyncMetaDao {
    @Query("SELECT value FROM sync_meta WHERE `key` = :key LIMIT 1")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun set(meta: SyncMetaEntity)
}
