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
interface FolderDao {
    @Query("SELECT * FROM folders WHERE ownerId = :ownerId AND deletedAt IS NULL AND archivedAt IS NULL AND ((:parentFolderId IS NULL AND parentFolderId IS NULL) OR parentFolderId = :parentFolderId) ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getChildrenFlow(ownerId: String, parentFolderId: String?): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders WHERE ownerId = :ownerId AND id = :id LIMIT 1")
    suspend fun getById(id: String, ownerId: String): FolderEntity?

    @Query("SELECT * FROM folders WHERE ownerId = :ownerId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getAllFlow(ownerId: String): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders WHERE ownerId = :ownerId AND deletedAt IS NULL")
    suspend fun getAll(ownerId: String): List<FolderEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(folder: FolderEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(folders: List<FolderEntity>)

    @Query("UPDATE folders SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM folders WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
}

@Dao
interface TaskDao {
    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getAllTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND projectId IS NULL AND category = 'MISC' AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getInboxTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND projectId = :projectId AND archivedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getTasksByProjectFlow(projectId: String, ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE id = :id AND ownerId = :ownerId AND deletedAt IS NULL")
    suspend fun getTaskById(id: String, ownerId: String): TaskEntity?

    @Query("SELECT * FROM tasks WHERE id = :id AND ownerId = :ownerId AND deletedAt IS NULL")
    fun getTaskByIdFlow(id: String, ownerId: String): Flow<TaskEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTasks(tasks: List<TaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTask(task: TaskEntity)

    @Query("DELETE FROM tasks WHERE id = :id AND ownerId = :ownerId")
    suspend fun deleteTask(id: String, ownerId: String)

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NOT NULL AND deletedAt IS NULL ORDER BY updatedAt DESC")
    fun getArchivedTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NULL AND deletedAt IS NULL AND ((:parentFolderId IS NULL AND parentFolderId IS NULL) OR parentFolderId = :parentFolderId) ORDER BY CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END, CAST(rank AS INTEGER) ASC, id ASC")
    fun getTreeTasksByParentFlow(parentFolderId: String?, ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND archivedAt IS NULL AND deletedAt IS NULL ORDER BY CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END, CAST(rank AS INTEGER) ASC, id ASC")
    fun getTreeTasksFlow(ownerId: String): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE ownerId = :ownerId AND deletedAt IS NULL")
    suspend fun getAllTreeTasks(ownerId: String): List<TaskEntity>

    @Query("UPDATE tasks SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM tasks WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
}

@Dao
interface TaskStepDao {
    @Query("SELECT * FROM task_steps WHERE ownerId = :ownerId AND taskId = :taskId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getByTaskFlow(taskId: String, ownerId: String): Flow<List<TaskStepEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(step: TaskStepEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(steps: List<TaskStepEntity>)

    @Query("SELECT * FROM task_steps WHERE id = :id AND ownerId = :ownerId LIMIT 1")
    suspend fun getById(id: String, ownerId: String): TaskStepEntity?

    @Query("UPDATE task_steps SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM task_steps WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
}

@Dao
interface WorkflowDao {
    @Query("SELECT * FROM workflows WHERE ownerId = :ownerId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getActiveFlow(ownerId: String): Flow<List<WorkflowEntity>>

    @Query("SELECT * FROM workflow_stages WHERE ownerId = :ownerId AND workflowId = :workflowId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getStagesFlow(workflowId: String, ownerId: String): Flow<List<WorkflowStageEntity>>

    @Query("SELECT * FROM workflow_task_memberships WHERE ownerId = :ownerId AND workflowId = :workflowId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC, id ASC")
    fun getMembershipsFlow(workflowId: String, ownerId: String): Flow<List<WorkflowTaskMembershipEntity>>

    @Query("SELECT * FROM workflow_task_memberships WHERE ownerId = :ownerId AND taskId = :taskId AND deletedAt IS NULL")
    suspend fun getMembershipsForTask(taskId: String, ownerId: String): List<WorkflowTaskMembershipEntity>

    // Point lookups used when a remote delete change must tombstone the real
    // row instead of fabricating an empty stub.
    @Query("SELECT * FROM workflows WHERE id = :id AND ownerId = :ownerId LIMIT 1")
    suspend fun getWorkflowById(id: String, ownerId: String): WorkflowEntity?

    @Query("SELECT * FROM workflow_stages WHERE id = :id AND ownerId = :ownerId LIMIT 1")
    suspend fun getStageById(id: String, ownerId: String): WorkflowStageEntity?

    @Query("SELECT * FROM workflow_task_memberships WHERE id = :id AND ownerId = :ownerId LIMIT 1")
    suspend fun getMembershipById(id: String, ownerId: String): WorkflowTaskMembershipEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWorkflow(workflow: WorkflowEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWorkflows(workflows: List<WorkflowEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertStages(stages: List<WorkflowStageEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMemberships(memberships: List<WorkflowTaskMembershipEntity>)

    @Query("UPDATE workflows SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM workflows WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPendingWorkflows(ownerId: String)

    @Query("UPDATE workflow_stages SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markStageSynced(ownerId: String, id: String)

    @Query("DELETE FROM workflow_stages WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPendingStages(ownerId: String)

    @Query("UPDATE workflow_task_memberships SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markMembershipSynced(ownerId: String, id: String)

    @Query("DELETE FROM workflow_task_memberships WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPendingMemberships(ownerId: String)
}

@Dao
interface ArchiveOperationDao {
    @Query("SELECT * FROM archive_operations WHERE ownerId = :ownerId ORDER BY createdAt DESC")
    fun getAllFlow(ownerId: String): Flow<List<ArchiveOperationEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(operations: List<ArchiveOperationEntity>)

    @Query("SELECT * FROM archive_operations WHERE id = :id AND ownerId = :ownerId LIMIT 1")
    suspend fun getById(id: String, ownerId: String): ArchiveOperationEntity?

    @Query("DELETE FROM archive_operations WHERE ownerId = :ownerId")
    suspend fun clearArchiveOperations(ownerId: String)
}

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE taskId = :taskId AND ownerId = :ownerId AND deletedAt IS NULL LIMIT 1")
    suspend fun getNoteByTaskId(taskId: String, ownerId: String): NoteEntity?

    @Query("SELECT * FROM notes WHERE taskId = :taskId AND ownerId = :ownerId AND deletedAt IS NULL LIMIT 1")
    fun getNoteByTaskIdFlow(taskId: String, ownerId: String): Flow<NoteEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNotes(notes: List<NoteEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNote(note: NoteEntity)

    @Query("DELETE FROM notes WHERE taskId = :taskId AND ownerId = :ownerId")
    suspend fun deleteNoteByTaskId(taskId: String, ownerId: String)

    @Query("UPDATE notes SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM notes WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
}

@Dao
interface TimePointDao {
    @Query("SELECT * FROM time_points WHERE ownerId = :ownerId AND archivedAt IS NULL AND deletedAt IS NULL ORDER BY type, localDate, CAST(rank AS INTEGER)")
    fun getActiveTimePointsFlow(ownerId: String): Flow<List<TimePointEntity>>

    @Query("SELECT * FROM time_points WHERE ownerId = :ownerId AND type = 'DATE' AND localDate = :localDate AND archivedAt IS NULL AND deletedAt IS NULL LIMIT 1")
    suspend fun getTimePointByDate(ownerId: String, localDate: String): TimePointEntity?

    @Query("SELECT * FROM time_points WHERE ownerId = :ownerId AND type = 'EVENT' AND archivedAt IS NULL AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getActiveEventsFlow(ownerId: String): Flow<List<TimePointEntity>>

    @Query("SELECT * FROM time_points WHERE id = :id AND ownerId = :ownerId AND deletedAt IS NULL")
    suspend fun getTimePointById(id: String, ownerId: String): TimePointEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoints(timePoints: List<TimePointEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimePoint(timePoint: TimePointEntity)

    @Query("UPDATE time_points SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM time_points WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
}

@Dao
interface PlacementDao {
    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND deletedAt IS NULL ORDER BY timePointId ASC, CAST(rank AS INTEGER) ASC")
    fun getActivePlacementsFlow(ownerId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND timePointId = :timePointId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    fun getPlacementsByTimePointFlow(ownerId: String, timePointId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND timePointId = :timePointId AND deletedAt IS NULL ORDER BY CAST(rank AS INTEGER) ASC")
    suspend fun getPlacementsByTimePoint(timePointId: String, ownerId: String): List<PlacementEntity>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId AND deletedAt IS NULL")
    fun getPlacementsByTaskFlow(taskId: String, ownerId: String): Flow<List<PlacementEntity>>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId AND deletedAt IS NULL")
    suspend fun getPlacementsByTaskId(taskId: String, ownerId: String): List<PlacementEntity>

    @Query("SELECT * FROM placements WHERE ownerId = :ownerId AND taskId = :taskId AND deletedAt IS NULL")
    suspend fun getPlacementsByTaskIdForOwner(ownerId: String, taskId: String): List<PlacementEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacements(placements: List<PlacementEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPlacement(placement: PlacementEntity)

    @Query("DELETE FROM placements WHERE id = :id AND ownerId = :ownerId")
    suspend fun deletePlacement(id: String, ownerId: String)

    @Query("DELETE FROM placements WHERE ownerId = :ownerId AND id = :id")
    suspend fun deletePlacementForOwner(ownerId: String, id: String)

    @Query("UPDATE placements SET pendingSync = 0 WHERE ownerId = :ownerId AND id = :id")
    suspend fun markSynced(ownerId: String, id: String)

    @Query("DELETE FROM placements WHERE ownerId = :ownerId AND pendingSync = 0")
    suspend fun clearNonPending(ownerId: String)
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
