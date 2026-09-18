package com.devtodo.app.ui.screens

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.ui.theme.ThemeMode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel(
    private val db: AppDatabase,
    private val syncEngine: SyncEngine,
    val authManager: SecureAuthManager,
    val api: ApiClient
) : ViewModel() {

    val syncState: StateFlow<SyncState> = syncEngine.syncState
    val lastSyncError: StateFlow<String?> = syncEngine.lastSyncError
    private val currentOwnerId = MutableStateFlow(authManager.ownerId)

    val projects: StateFlow<List<ProjectEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.projectDao().getAllProjectsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val foldersV2: StateFlow<List<FolderEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.folderDao().getAllFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val treeTasksV2: StateFlow<List<TaskEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.taskDao().getTreeTasksFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val workflowsV2: StateFlow<List<WorkflowEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.workflowDao().getActiveFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val archiveOperationsV2: StateFlow<List<ArchiveOperationEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.archiveOperationDao().getAllFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val allTasks: StateFlow<List<TaskEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.taskDao().getAllTasksFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val inboxTasks: StateFlow<List<TaskEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.taskDao().getInboxTasksFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val archivedTasks: StateFlow<List<TaskEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.taskDao().getArchivedTasksFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val unresolvedConflicts: StateFlow<List<ConflictEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.conflictDao().getUnresolvedConflictsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val pendingOutboxItems: StateFlow<List<OutboxEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.outboxDao().getPendingItemsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val activeEvents: StateFlow<List<TimePointEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.timePointDao().getActiveEventsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _todayTasks = MutableStateFlow<List<Pair<TaskEntity, PlacementEntity>>>(emptyList())
    val todayTasks: StateFlow<List<Pair<TaskEntity, PlacementEntity>>> = _todayTasks.asStateFlow()

    private val _dataReady = MutableStateFlow(!authManager.isLoggedIn)
    val dataReady: StateFlow<Boolean> = _dataReady.asStateFlow()

    private val _authenticated = MutableStateFlow(authManager.isLoggedIn)
    val authenticated: StateFlow<Boolean> = _authenticated.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private val _themeMode = MutableStateFlow(readThemeMode())
    val themeMode: StateFlow<ThemeMode> = _themeMode.asStateFlow()

    private val _dynamicColor = MutableStateFlow(authManager.dynamicColor)
    val dynamicColor: StateFlow<Boolean> = _dynamicColor.asStateFlow()

    private val _pureBlack = MutableStateFlow(authManager.pureBlack)
    val pureBlack: StateFlow<Boolean> = _pureBlack.asStateFlow()

    private var todayLoadJob: Job? = null
    private var midnightRefreshJob: Job? = null
    private var sessionRestoreJob: Job? = null

    private val todayStr: String
        get() = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())

    init {
        if (authManager.isLoggedIn) {
            loadTodayData()
            restorePersistedSession(showOfflineMessage = true)
        }
    }

    private fun restorePersistedSession(showOfflineMessage: Boolean) {
        if (!authManager.isLoggedIn) return
        sessionRestoreJob?.cancel()
        sessionRestoreJob = viewModelScope.launch(Dispatchers.IO) {
            val restored = api.restoreSession()
            if (!isActive) return@launch
            withContext(Dispatchers.Main.immediate) {
                when {
                    restored -> {
                        markSessionReady()
                    }
                    !authManager.isLoggedIn -> {
                        onLoggedOut()
                        _messages.tryEmit("登录已失效，请重新登录")
                    }
                    else -> {
                        // Keep the local session and start the engine even
                        // while offline. A later network callback will retry
                        // refresh and sync instead of leaving stale local data.
                        markSessionReady()
                        if (showOfflineMessage) {
                            _messages.tryEmit("暂时无法恢复中枢连接，登录状态已保留")
                        }
                    }
                }
            }
        }
    }

    private fun markSessionReady() {
        _authenticated.value = true
        currentOwnerId.value = authManager.ownerId
        _dataReady.value = true
        loadTodayData()
        syncEngine.start()
    }

    fun onNetworkStateChanged(available: Boolean) {
        syncEngine.setNetworkAvailable(available)
        if (available && authManager.isLoggedIn) {
            restorePersistedSession(showOfflineMessage = false)
        }
    }

    fun onAppForeground() {
        if (authManager.isLoggedIn) {
            restorePersistedSession(showOfflineMessage = false)
        }
    }

    fun loadTodayData() {
        todayLoadJob?.cancel()
        val ownerId = authManager.ownerId?.takeIf { it.isNotBlank() }
        if (ownerId == null) {
            _todayTasks.value = emptyList()
            return
        }

        todayLoadJob = viewModelScope.launch {
            val datePoint = getOrCreateDatePoint(ownerId, todayStr)
            db.placementDao().getPlacementsByTimePointFlow(ownerId, datePoint.id).collect { placements ->
                _todayTasks.value = placements.mapNotNull { placement ->
                    db.taskDao().getTaskById(placement.taskId, ownerId)
                        ?.takeIf { it.archivedAt == null && it.deletedAt == null }
                        ?.let { it to placement }
                }
            }
        }

        if (midnightRefreshJob?.isActive != true) {
            midnightRefreshJob = viewModelScope.launch {
                var observedDate = todayStr
                while (isActive) {
                    delay(60_000L)
                    val nextDate = todayStr
                    if (nextDate != observedDate) {
                        observedDate = nextDate
                        loadTodayData()
                    }
                }
            }
        }
    }

    fun updateTaskStatus(task: TaskEntity, nextStatus: TaskStatus) {
        viewModelScope.launch {
            try {
                require(task.ownerId == authManager.ownerId) { "任务不属于当前账户" }
                val updated = task.copy(
                    status = nextStatus,
                    version = task.version + 1,
                    updatedAt = nowIso(),
                    pendingSync = true
                )
                db.taskDao().upsertTask(updated)
                syncEngine.recordLocalMutation(
                    command = "task.update",
                    entityId = task.id,
                    baseVersion = task.version,
                    payload = mapOf("status" to nextStatus.name)
                )
                loadTodayData()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("更新任务状态失败"))
            }
        }
    }

    fun observeChildFolders(parentFolderId: String?): Flow<List<FolderEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.folderDao().getChildrenFlow(it, parentFolderId) } ?: flowOf(emptyList())
    }

    fun observeChildTasks(parentFolderId: String?): Flow<List<TaskEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.taskDao().getTreeTasksByParentFlow(parentFolderId, it) } ?: flowOf(emptyList())
    }

    fun observeTaskSteps(taskId: String): Flow<List<TaskStepEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.taskStepDao().getByTaskFlow(taskId, it) } ?: flowOf(emptyList())
    }

    fun observeWorkflowStages(workflowId: String): Flow<List<WorkflowStageEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.workflowDao().getStagesFlow(workflowId, it) } ?: flowOf(emptyList())
    }

    fun observeWorkflowMemberships(workflowId: String): Flow<List<WorkflowTaskMembershipEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.workflowDao().getMembershipsFlow(workflowId, it) } ?: flowOf(emptyList())
    }

    fun observeTimePointPlacements(timePointId: String): Flow<List<PlacementEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.placementDao().getPlacementsByTimePointFlow(it, timePointId) } ?: flowOf(emptyList())
    }

    fun createFolderV2(parentFolderId: String?, title: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "文件夹名称不能为空" }
                val id = UUID.randomUUID().toString()
                val now = nowIso()
                db.folderDao().upsert(FolderEntity(id, ownerId, parentFolderId, normalized, "1024", 1, null, null, now, now, null, true))
                syncEngine.recordLocalMutation("folder.create", id, null, mapOf("parentFolderId" to parentFolderId, "title" to normalized))
                _messages.tryEmit("文件夹已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建文件夹失败"))
            }
        }
    }

    fun createTreeTaskV2(parentFolderId: String?, title: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "任务标题不能为空" }
                val id = UUID.randomUUID().toString()
                val noteId = UUID.randomUUID().toString()
                val now = nowIso()
                db.taskDao().upsertTask(TaskEntity(id, ownerId, null, null, normalized, TaskStatus.TODO, TaskCategory.MISC, TaskPriority.NONE, "1024", 1, null, now, now, parentFolderId, null, null, null, true))
                db.noteDao().upsertNote(NoteEntity(noteId, ownerId, id, "", 1, now, now, null, true))
                syncEngine.recordLocalMutation("task.create", id, null, mapOf("parentFolderId" to parentFolderId, "title" to normalized))
                _messages.tryEmit("任务已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建任务失败"))
            }
        }
    }

    fun createTreeTaskV2AtToday(title: String) {
        createTreeTaskV2AtTimePoint(title, todayStr, true)
    }

    fun createTreeTaskV2AtTimePoint(title: String, target: String, isDate: Boolean) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "任务标题不能为空" }
                val parentFolderId = db.folderDao().getAll(ownerId)
                    .filter { it.archivedAt == null && it.deletedAt == null }
                    .maxByOrNull { it.updatedAt }
                    ?.id
                val taskId = UUID.randomUUID().toString()
                val noteId = UUID.randomUUID().toString()
                val now = nowIso()
                db.taskDao().upsertTask(TaskEntity(taskId, ownerId, null, null, normalized, TaskStatus.TODO, TaskCategory.MISC, TaskPriority.NONE, "1024", 1, null, now, now, parentFolderId, null, null, null, true))
                db.noteDao().upsertNote(NoteEntity(noteId, ownerId, taskId, "", 1, now, now, null, true))
                syncEngine.recordLocalMutation("task.create", taskId, null, mapOf("parentFolderId" to parentFolderId, "title" to normalized))
                val timePoint = if (isDate) {
                    getOrCreateDatePoint(ownerId, target)
                } else {
                    db.timePointDao().getTimePointById(target, ownerId) ?: error("事件节点不存在")
                }
                val placementId = UUID.randomUUID().toString()
                db.placementDao().upsertPlacement(PlacementEntity(placementId, ownerId, taskId, timePoint.id, "1024", 1, now, now, null, true))
                syncEngine.recordLocalMutation("placement.create", placementId, null, mapOf("taskId" to taskId, "timePointId" to timePoint.id, "__localId" to placementId))
                loadTodayData()
                _messages.tryEmit("任务及安排已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建任务及安排失败"))
            }
        }
    }

    fun duplicateTaskV2(task: TaskEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                val now = nowIso()
                val taskId = UUID.randomUUID().toString()
                val noteId = UUID.randomUUID().toString()
                val sourceNote = db.noteDao().getNoteByTaskId(task.id, ownerId)
                val sourceSteps = db.taskStepDao().getByTaskFlow(task.id, ownerId).first()
                val existingSiblings = db.taskDao().getAllTreeTasks(ownerId).filter {
                    it.parentFolderId == task.parentFolderId && it.status == TaskStatus.TODO && it.deletedAt == null
                }
                val nextRank = ((existingSiblings.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                val copy = task.copy(id = taskId, referenceId = null, status = TaskStatus.TODO, completedAt = null, archivedAt = null, archivedByOperationId = null, deletedAt = null, rank = nextRank, version = 1, createdAt = now, updatedAt = now, pendingSync = true)
                db.taskDao().upsertTask(copy)
                db.noteDao().upsertNote(NoteEntity(noteId, ownerId, taskId, sourceNote?.contentMarkdown ?: "", 1, now, now, null, true))
                val stepIds = sourceSteps.map { UUID.randomUUID().toString() }
                db.taskStepDao().upsertAll(sourceSteps.mapIndexed { index, step ->
                    TaskStepEntity(stepIds[index], ownerId, taskId, step.title, step.noteMarkdown, TaskStatus.TODO, ((index + 1) * 1024).toString(), null, 1, now, now, null, true)
                })
                syncEngine.recordLocalMutation("task.duplicate", task.id, null, mapOf("taskId" to taskId, "noteId" to noteId, "stepIds" to stepIds))
                _messages.tryEmit("任务已复制")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("复制任务失败"))
            }
        }
    }

    fun moveTreeV2(
        kind: String,
        id: String,
        parentFolderId: String?,
        expectedStatus: TaskStatus,
        beforeId: String? = null,
        afterId: String? = null,
        baseVersion: Long
    ) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                require(kind == "FOLDER" || kind == "TASK") { "无效的树节点类型" }
                val folders = db.folderDao().getAll(ownerId)
                val tasks = db.taskDao().getAllTreeTasks(ownerId)
                val currentFolder = folders.find { kind == "FOLDER" && it.id == id }
                val currentTask = tasks.find { kind == "TASK" && it.id == id }
                require(currentFolder != null || currentTask != null) { "树节点不存在" }
                val currentVersion = currentFolder?.version ?: currentTask!!.version
                require(currentVersion == baseVersion) { "树节点已变化，请刷新后重试" }
                val anchor = (beforeId ?: afterId)?.let { anchorId ->
                    folders.firstOrNull { it.id == anchorId }?.rank
                        ?: tasks.firstOrNull { it.id == anchorId }?.rank
                }
                val nextRank = when {
                    anchor == null -> ((folders.filter { it.parentFolderId == parentFolderId }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L)
                        .coerceAtLeast(tasks.filter { it.parentFolderId == parentFolderId }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                    beforeId != null -> ((anchor.toLongOrNull() ?: 1024L) - 1L).coerceAtLeast(0L).toString()
                    else -> ((anchor.toLongOrNull() ?: 0L) + 1L).toString()
                }
                val now = nowIso()
                if (currentFolder != null) {
                    db.folderDao().upsert(currentFolder.copy(parentFolderId = parentFolderId, rank = nextRank, version = currentFolder.version + 1, updatedAt = now, pendingSync = true))
                } else {
                    db.taskDao().upsertTask(currentTask!!.copy(parentFolderId = parentFolderId, rank = nextRank, version = currentTask.version + 1, updatedAt = now, pendingSync = true))
                }
                syncEngine.recordLocalMutation(
                    command = "tree.move",
                    entityId = id,
                    baseVersion = currentVersion,
                    payload = mapOf(
                        "item" to mapOf("kind" to kind, "id" to id),
                        "parentFolderId" to parentFolderId,
                        "before" to beforeId?.let { mapOf("kind" to if (folders.any { folder -> folder.id == it }) "FOLDER" else "TASK", "id" to it) },
                        "after" to afterId?.let { mapOf("kind" to if (folders.any { folder -> folder.id == it }) "FOLDER" else "TASK", "id" to it) },
                        "expectedStatus" to expectedStatus.name,
                    ),
                )
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动树节点失败"))
            }
        }
    }

    fun archiveFolderV2(folder: FolderEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                require(folder.ownerId == ownerId) { "文件夹不属于当前账户" }
                require(folder.archivedAt == null) { "文件夹已归档" }
                val now = nowIso()
                val operationId = UUID.randomUUID().toString()
                val folders = db.folderDao().getAll(ownerId)
                val folderIds = mutableSetOf<String>()
                val pendingFolders = ArrayDeque<String>()
                pendingFolders.add(folder.id)
                while (pendingFolders.isNotEmpty()) {
                    val currentId = pendingFolders.removeFirst()
                    if (!folderIds.add(currentId)) continue
                    folders.filter { it.parentFolderId == currentId }.forEach { pendingFolders.addLast(it.id) }
                }
                val tasks = db.taskDao().getAllTreeTasks(ownerId)
                val affectedFolders = folders.filter { it.id in folderIds && it.archivedAt == null }
                val affectedTasks = tasks.filter { it.parentFolderId != null && it.parentFolderId in folderIds && it.archivedAt == null }
                db.folderDao().upsertAll(folders.map { candidate ->
                    if (candidate.id in folderIds && candidate.archivedAt == null) {
                        candidate.copy(archivedAt = now, archivedByOperationId = operationId, version = candidate.version + 1, updatedAt = now, pendingSync = true)
                    } else candidate
                })
                db.taskDao().upsertTasks(tasks.map { candidate ->
                    if (candidate.parentFolderId in folderIds && candidate.archivedAt == null) {
                        candidate.copy(archivedAt = now, archivedByOperationId = operationId, version = candidate.version + 1, updatedAt = now, pendingSync = true)
                    } else candidate
                })
                db.archiveOperationDao().upsertAll(listOf(ArchiveOperationEntity(operationId, ownerId, folder.id, folder.version, affectedFolders.size, affectedTasks.size, now, null)))
                syncEngine.recordLocalMutation("folder.archiveTree", folder.id, folder.version, mapOf("operationId" to operationId))
                _messages.tryEmit("目录树已归档")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档目录失败"))
            }
        }
    }

    fun restoreFolderTreeV2(operation: ArchiveOperationEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                require(operation.ownerId == ownerId) { "归档操作不属于当前账户" }
                val now = nowIso()
                val folders = db.folderDao().getAll(ownerId)
                val tasks = db.taskDao().getAllTreeTasks(ownerId)
                folders.filter { it.archivedByOperationId == operation.id }.forEach { folder ->
                    db.folderDao().upsert(folder.copy(archivedAt = null, archivedByOperationId = null, version = folder.version + 1, updatedAt = now, pendingSync = true))
                }
                tasks.filter { it.archivedByOperationId == operation.id }.forEach { task ->
                    db.taskDao().upsertTask(task.copy(archivedAt = null, archivedByOperationId = null, version = task.version + 1, updatedAt = now, pendingSync = true))
                }
                db.archiveOperationDao().upsertAll(listOf(operation.copy(restoredAt = now)))
                syncEngine.recordLocalMutation("folder.restoreTree", operation.rootFolderId, null, mapOf("operationId" to operation.id))
                _messages.tryEmit("目录树已恢复")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("恢复目录失败"))
            }
        }
    }

    suspend fun deleteFolderTreeV2(folderId: String, confirmationToken: String): Result<Unit> {
        val result = api.deleteV2Tree(folderId, confirmationToken)
        if (result.isSuccess) syncEngine.triggerSync()
        return result
    }

    fun createWorkflowV2(name: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = name.trim()
                require(normalized.isNotEmpty()) { "流程名称不能为空" }
                val id = UUID.randomUUID().toString()
                val now = nowIso()
                val stageId = UUID.randomUUID().toString()
                db.workflowDao().upsertWorkflow(WorkflowEntity(id, ownerId, normalized, "1024", 1, null, now, now, null, true))
                db.workflowDao().upsertStages(listOf(WorkflowStageEntity(stageId, ownerId, id, "阶段 1", "1024", 1, now, now, null, true)))
                syncEngine.recordLocalMutation("workflow.create", id, null, mapOf("name" to normalized, "defaultStageId" to stageId))
                _messages.tryEmit("流程已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建流程失败"))
            }
        }
    }

    fun createWorkflowStageV2(workflow: WorkflowEntity, name: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = name.trim()
                require(normalized.isNotEmpty()) { "阶段名称不能为空" }
                val id = UUID.randomUUID().toString()
                val now = nowIso()
                val existing = db.workflowDao().getStagesFlow(workflow.id, ownerId).first()
                val rank = ((existing.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                db.workflowDao().upsertStages(listOf(WorkflowStageEntity(id, ownerId, workflow.id, normalized, rank, 1, now, now, null, true)))
                syncEngine.recordLocalMutation("workflowStage.create", id, null, mapOf("workflowId" to workflow.id, "name" to normalized))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建阶段失败"))
            }
        }
    }

    fun updateWorkflowV2(workflow: WorkflowEntity, name: String) {
        viewModelScope.launch {
            try {
                val normalized = name.trim()
                require(normalized.isNotEmpty()) { "流程名称不能为空" }
                val now = nowIso()
                db.workflowDao().upsertWorkflow(workflow.copy(name = normalized, version = workflow.version + 1, updatedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation("workflow.update", workflow.id, workflow.version, mapOf("name" to normalized))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存流程失败"))
            }
        }
    }

    fun setWorkflowArchivedV2(workflow: WorkflowEntity) {
        viewModelScope.launch {
            try {
                val now = nowIso()
                val restoring = workflow.archivedAt != null
                db.workflowDao().upsertWorkflow(
                    workflow.copy(
                        archivedAt = if (restoring) null else now,
                        version = workflow.version + 1,
                        updatedAt = now,
                        pendingSync = true,
                    ),
                )
                syncEngine.recordLocalMutation(
                    if (restoring) "workflow.restore" else "workflow.archive",
                    workflow.id,
                    workflow.version,
                    emptyMap(),
                )
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档流程失败"))
            }
        }
    }

    fun deleteWorkflowV2(workflow: WorkflowEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val now = nowIso()
                val stages = db.workflowDao().getStagesFlow(workflow.id, ownerId).first()
                val memberships = db.workflowDao().getMembershipsFlow(workflow.id, ownerId).first()
                memberships.forEach { membership ->
                    db.workflowDao().upsertMemberships(listOf(membership.copy(deletedAt = now, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation("workflowTask.remove", membership.id, membership.version, emptyMap())
                }
                stages.forEach { stage ->
                    db.workflowDao().upsertStages(listOf(stage.copy(deletedAt = now, version = stage.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation("workflowStage.delete", stage.id, stage.version, emptyMap())
                }
                db.workflowDao().upsertWorkflow(workflow.copy(deletedAt = now, version = workflow.version + 1, updatedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation("workflow.delete", workflow.id, workflow.version, emptyMap())
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除流程失败"))
            }
        }
    }

    fun updateWorkflowStageV2(stage: WorkflowStageEntity, name: String) {
        viewModelScope.launch {
            try {
                val normalized = name.trim()
                require(normalized.isNotEmpty()) { "阶段名称不能为空" }
                val now = nowIso()
                db.workflowDao().upsertStages(listOf(stage.copy(name = normalized, version = stage.version + 1, updatedAt = now, pendingSync = true)))
                syncEngine.recordLocalMutation("workflowStage.update", stage.id, stage.version, mapOf("name" to normalized))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存阶段失败"))
            }
        }
    }

    fun deleteWorkflowStageV2(stage: WorkflowStageEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val stages = db.workflowDao().getStagesFlow(stage.workflowId, ownerId).first()
                require(stages.size > 1) { "流程至少需要保留一个阶段" }
                val now = nowIso()
                db.workflowDao().getMembershipsFlow(stage.workflowId, ownerId).first()
                    .filter { it.stageId == stage.id }
                    .forEach { membership ->
                        db.workflowDao().upsertMemberships(listOf(membership.copy(deletedAt = now, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                        syncEngine.recordLocalMutation("workflowTask.remove", membership.id, membership.version, emptyMap())
                    }
                db.workflowDao().upsertStages(listOf(stage.copy(deletedAt = now, version = stage.version + 1, updatedAt = now, pendingSync = true)))
                syncEngine.recordLocalMutation("workflowStage.delete", stage.id, stage.version, emptyMap())
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除阶段失败"))
            }
        }
    }

    fun createTaskInWorkflowStageV2(workflow: WorkflowEntity, stage: WorkflowStageEntity, title: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "任务标题不能为空" }
                require(workflow.archivedAt == null) { "流程已归档" }
                val parentFolderId = db.folderDao().getAll(ownerId)
                    .filter { it.archivedAt == null && it.deletedAt == null }
                    .maxByOrNull { it.updatedAt }
                    ?.id
                val now = nowIso()
                val taskId = UUID.randomUUID().toString()
                val noteId = UUID.randomUUID().toString()
                db.taskDao().upsertTask(TaskEntity(taskId, ownerId, null, null, normalized, TaskStatus.TODO, TaskCategory.MISC, TaskPriority.NONE, "1024", 1, null, now, now, parentFolderId, null, null, null, true))
                db.noteDao().upsertNote(NoteEntity(noteId, ownerId, taskId, "", 1, now, now, null, true))
                syncEngine.recordLocalMutation("task.create", taskId, null, mapOf("parentFolderId" to parentFolderId, "title" to normalized))
                val membershipId = UUID.randomUUID().toString()
                db.workflowDao().upsertMemberships(listOf(WorkflowTaskMembershipEntity(membershipId, ownerId, workflow.id, stage.id, taskId, "1024", 1, now, now, null, true)))
                syncEngine.recordLocalMutation("workflowTask.add", membershipId, null, mapOf("workflowId" to workflow.id, "stageId" to stage.id, "taskId" to taskId))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建流程任务失败"))
            }
        }
    }

    fun moveWorkflowStageV2(stage: WorkflowStageEntity, siblings: List<WorkflowStageEntity>, direction: Int) {
        viewModelScope.launch {
            try {
                val index = siblings.indexOfFirst { it.id == stage.id }
                val target = siblings.getOrNull(index + direction) ?: return@launch
                val anchorRank = target.rank.toLongOrNull() ?: 1024L
                val nextRank = if (direction < 0) (anchorRank - 1L).coerceAtLeast(0L) else anchorRank + 1L
                val now = nowIso()
                db.workflowDao().upsertStages(listOf(stage.copy(rank = nextRank.toString(), version = stage.version + 1, updatedAt = now, pendingSync = true)))
                syncEngine.recordLocalMutation(
                    "workflowStage.move",
                    stage.id,
                    stage.version,
                    mapOf(
                        "beforeId" to if (direction < 0) target.id else null,
                        "afterId" to if (direction > 0) target.id else null,
                    ),
                )
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动阶段失败"))
            }
        }
    }

    fun addWorkflowTaskV2(workflow: WorkflowEntity, stage: WorkflowStageEntity, task: TaskEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val existing = db.workflowDao().getMembershipsFlow(workflow.id, ownerId).first()
                require(existing.none { it.taskId == task.id }) { "任务已经在该流程中" }
                val id = UUID.randomUUID().toString()
                val rank = ((existing.filter { it.stageId == stage.id }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                val now = nowIso()
                db.workflowDao().upsertMemberships(listOf(WorkflowTaskMembershipEntity(id, ownerId, workflow.id, stage.id, task.id, rank, 1, now, now, null, true)))
                syncEngine.recordLocalMutation("workflowTask.add", id, null, mapOf("workflowId" to workflow.id, "stageId" to stage.id, "taskId" to task.id))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("添加流程任务失败"))
            }
        }
    }

    fun moveWorkflowMembershipV2(
        membership: WorkflowTaskMembershipEntity,
        targetStage: WorkflowStageEntity,
        beforeId: String? = null,
        afterId: String? = null
    ) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val siblings = db.workflowDao().getMembershipsFlow(membership.workflowId, ownerId).first()
                val targetSiblings = siblings.filter { it.stageId == targetStage.id && it.id != membership.id }
                require(siblings.none { it.id != membership.id && it.taskId == membership.taskId && it.workflowId == membership.workflowId && it.stageId != targetStage.id }) { "任务已经在该流程中" }
                val rank = when {
                    beforeId != null -> {
                        val anchorRank = targetSiblings.firstOrNull { it.id == beforeId }?.rank?.toLongOrNull() ?: 1024L
                        (anchorRank - 1L).coerceAtLeast(0L).toString()
                    }
                    afterId != null -> {
                        val anchorRank = targetSiblings.firstOrNull { it.id == afterId }?.rank?.toLongOrNull() ?: 1024L
                        (anchorRank + 1L).toString()
                    }
                    else -> ((targetSiblings.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                }
                val now = nowIso()
                db.workflowDao().upsertMemberships(listOf(membership.copy(stageId = targetStage.id, rank = rank, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                val payload = mutableMapOf<String, Any?>("stageId" to targetStage.id)
                if (beforeId != null) payload["beforeId"] = beforeId
                if (afterId != null) payload["afterId"] = afterId
                syncEngine.recordLocalMutation("workflowTask.move", membership.id, membership.version, payload)
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动流程任务失败"))
            }
        }
    }

    fun removeWorkflowMembershipV2(membership: WorkflowTaskMembershipEntity) {
        viewModelScope.launch {
            try {
                val now = nowIso()
                db.workflowDao().upsertMemberships(listOf(membership.copy(deletedAt = now, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                syncEngine.recordLocalMutation("workflowTask.remove", membership.id, membership.version, emptyMap())
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移除流程任务失败"))
            }
        }
    }

    fun createStepV2(taskId: String, title: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "步骤标题不能为空" }
                val id = UUID.randomUUID().toString()
                val now = nowIso()
                db.taskStepDao().upsert(TaskStepEntity(id, ownerId, taskId, normalized, "", TaskStatus.TODO, "1024", null, 1, now, now, null, true))
                syncEngine.recordLocalMutation("taskStep.create", id, null, mapOf("taskId" to taskId, "title" to normalized, "noteMarkdown" to ""))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建步骤失败"))
            }
        }
    }

    fun updateStepStatusV2(step: TaskStepEntity, nextStatus: TaskStatus) {
        viewModelScope.launch {
            try {
                val now = nowIso()
                db.taskStepDao().upsert(step.copy(status = nextStatus, completedAt = if (nextStatus == TaskStatus.DONE) now else null, version = step.version + 1, updatedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation("taskStep.update", step.id, step.version, mapOf("status" to nextStatus.name))
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("更新步骤失败"))
            }
        }
    }

    fun updateStepV2(step: TaskStepEntity, title: String, noteMarkdown: String) {
        viewModelScope.launch {
            try {
                val normalized = title.trim()
                require(normalized.isNotEmpty()) { "步骤标题不能为空" }
                require(noteMarkdown.length <= 1024 * 1024) { "步骤备注过大" }
                val now = nowIso()
                db.taskStepDao().upsert(
                    step.copy(
                        title = normalized,
                        noteMarkdown = noteMarkdown,
                        version = step.version + 1,
                        updatedAt = now,
                        pendingSync = true,
                    ),
                )
                syncEngine.recordLocalMutation(
                    "taskStep.update",
                    step.id,
                    step.version,
                    mapOf("title" to normalized, "noteMarkdown" to noteMarkdown),
                )
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存步骤失败"))
            }
        }
    }

    fun moveStepV2(step: TaskStepEntity, direction: Int) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                val siblings = db.taskStepDao().getByTaskFlow(step.taskId, ownerId).first()
                val index = siblings.indexOfFirst { it.id == step.id }
                val target = siblings.getOrNull(index + direction) ?: return@launch
                val targetRank = target.rank.toLongOrNull() ?: 1024L
                val rank = if (direction < 0) (targetRank - 1L).coerceAtLeast(0L) else targetRank + 1L
                val now = nowIso()
                db.taskStepDao().upsert(step.copy(rank = rank.toString(), version = step.version + 1, updatedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation(
                    "taskStep.move",
                    step.id,
                    step.version,
                    mapOf("beforeId" to if (direction < 0) target.id else null, "afterId" to if (direction > 0) target.id else null),
                )
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动步骤失败"))
            }
        }
    }

    fun deleteStepV2(step: TaskStepEntity) {
        viewModelScope.launch {
            try {
                val now = nowIso()
                db.taskStepDao().upsert(step.copy(deletedAt = now, version = step.version + 1, updatedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation("taskStep.delete", step.id, step.version, emptyMap())
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除步骤失败"))
            }
        }
    }

    fun retryOutboxItem(item: OutboxEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                db.outboxDao().recordAttempt(item.id, ownerId, 0L, null)
                syncEngine.triggerSync()
                _messages.tryEmit("已重置并触发同步")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("重试失败"))
            }
        }
    }

    fun discardOutboxItem(item: OutboxEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                db.outboxDao().deleteByMutationId(item.mutationId, ownerId)
                _messages.tryEmit("已丢弃操作")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("丢弃失败"))
            }
        }
    }

    fun restoreTask(task: TaskEntity, onSuccess: () -> Unit = {}) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                val now = nowIso()
                val updated = task.copy(
                    archivedAt = null,
                    archivedByOperationId = null,
                    version = task.version + 1,
                    updatedAt = now,
                    pendingSync = true
                )
                db.taskDao().upsertTask(updated)
                syncEngine.recordLocalMutation(
                    command = "task.restore",
                    entityId = task.id,
                    baseVersion = task.version,
                    payload = emptyMap()
                )
                loadTodayData()
                _messages.tryEmit("任务已恢复")
                onSuccess()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("恢复任务失败"))
            }
        }
    }

    fun archiveTask(task: TaskEntity, onSuccess: () -> Unit = {}) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                val now = nowIso()
                val updated = task.copy(
                    archivedAt = now,
                    version = task.version + 1,
                    updatedAt = now,
                    pendingSync = true
                )
                db.taskDao().upsertTask(updated)
                syncEngine.recordLocalMutation(
                    command = "task.archive",
                    entityId = task.id,
                    baseVersion = task.version,
                    payload = emptyMap()
                )
                loadTodayData()
                _messages.tryEmit("任务已归档")
                onSuccess()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档任务失败"))
            }
        }
    }

    fun deleteTaskV2(task: TaskEntity, onSuccess: () -> Unit = {}) {
        viewModelScope.launch {
            val ownerId = authManager.ownerId ?: run {
                _messages.tryEmit("登录状态已失效，请重新登录")
                return@launch
            }
            if (task.ownerId != ownerId) {
                _messages.tryEmit("任务不属于当前账户")
                return@launch
            }
            val now = nowIso()
            val priorNote = db.noteDao().getNoteByTaskId(task.id, ownerId)
            val priorSteps = db.taskStepDao().getByTaskFlow(task.id, ownerId).first()
            val priorPlacements = db.placementDao().getPlacementsByTaskIdForOwner(ownerId, task.id)
            val priorMemberships = db.workflowDao().getMembershipsForTask(task.id, ownerId)
            try {
                priorNote?.let { note ->
                    db.noteDao().upsertNote(note.copy(version = note.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                }
                priorSteps.forEach { step ->
                    db.taskStepDao().upsert(step.copy(version = step.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                }
                priorPlacements.forEach { placement ->
                    db.placementDao().upsertPlacement(placement.copy(version = placement.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                }
                priorMemberships.forEach { membership ->
                    db.workflowDao().upsertMemberships(listOf(membership.copy(version = membership.version + 1, updatedAt = now, deletedAt = now, pendingSync = true)))
                }
                db.taskDao().upsertTask(task.copy(version = task.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                syncEngine.recordLocalMutation("task.delete", task.id, task.version, emptyMap())
                _messages.tryEmit("任务及其内容已删除")
                onSuccess()
            } catch (error: Exception) {
                // Restore before-image on local failure
                priorNote?.let { db.noteDao().upsertNote(it) }
                db.taskStepDao().upsertAll(priorSteps)
                db.placementDao().upsertPlacements(priorPlacements)
                db.workflowDao().upsertMemberships(priorMemberships)
                db.taskDao().upsertTask(task)
                _messages.tryEmit(error.userMessage("删除任务失败，已回退"))
            }
        }
    }

    fun restoreTask(task: TaskEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                val now = nowIso()
                db.taskDao().upsertTask(
                    task.copy(
                        archivedAt = null,
                        version = task.version + 1,
                        updatedAt = now,
                        pendingSync = true
                    )
                )
                syncEngine.recordLocalMutation(
                    command = "task.restore",
                    entityId = task.id,
                    baseVersion = task.version,
                    payload = emptyMap()
                )
                _messages.tryEmit("任务已恢复")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("恢复任务失败"))
            }
        }
    }

    fun createTask(title: String, projectId: String?, scheduleToday: Boolean) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                val normalizedTitle = title.trim()
                require(normalizedTitle.isNotEmpty()) { "任务标题不能为空" }
                projectId?.let { selectedProjectId ->
                    require(db.projectDao().getProjectById(selectedProjectId, ownerId) != null) {
                        "项目不属于当前账户"
                    }
                }
                val taskId = UUID.randomUUID().toString()
                val now = nowIso()
                val category = if (projectId == null) TaskCategory.MISC else TaskCategory.FEATURE
                val task = TaskEntity(
                    id = taskId,
                    ownerId = ownerId,
                    projectId = projectId,
                    referenceId = null,
                    title = normalizedTitle,
                    status = TaskStatus.TODO,
                    category = category,
                    priority = TaskPriority.NONE,
                    rank = "1000",
                    version = 1,
                    archivedAt = null,
                    createdAt = now,
                    updatedAt = now,
                    pendingSync = true
                )
                db.taskDao().upsertTask(task)
                syncEngine.recordLocalMutation(
                    command = "task.create",
                    entityId = taskId,
                    baseVersion = null,
                    payload = mapOf(
                        "title" to normalizedTitle,
                        "category" to category.name,
                        "projectId" to projectId
                    )
                )

                if (scheduleToday) {
                    val datePoint = getOrCreateDatePoint(ownerId, todayStr)
                    val placementId = UUID.randomUUID().toString()
                    val placement = PlacementEntity(
                        id = placementId,
                        ownerId = ownerId,
                        taskId = taskId,
                        timePointId = datePoint.id,
                        rank = "1000",
                        version = 1,
                        createdAt = now,
                        updatedAt = now,
                        pendingSync = true
                    )
                    db.placementDao().upsertPlacement(placement)
                    syncEngine.recordLocalMutation(
                        command = "placement.create",
                        entityId = placementId,
                        baseVersion = null,
                        payload = mapOf(
                            "taskId" to taskId,
                            "timePointId" to datePoint.id,
                            "__localId" to placementId
                        )
                    )
                }
                loadTodayData()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建任务失败"))
            }
        }
    }

    fun createProject(name: String, taskPrefix: String) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                val normalizedName = name.trim()
                val normalizedPrefix = taskPrefix.trim().uppercase(Locale.US)
                require(normalizedName.isNotEmpty()) { "项目名称不能为空" }
                require(normalizedPrefix.matches(Regex("[A-Z][A-Z0-9]{1,9}"))) {
                    "项目代号需为 2-10 位大写字母或数字"
                }
                val projectId = UUID.randomUUID().toString()
                val now = nowIso()
                db.projectDao().upsertProject(
                    ProjectEntity(
                        id = projectId,
                        ownerId = ownerId,
                        name = normalizedName,
                        slug = normalizedPrefix.lowercase(Locale.US),
                        description = "",
                        rank = "1000",
                        version = 1,
                        archivedAt = null,
                        createdAt = now,
                        updatedAt = now,
                        pendingSync = true
                    )
                )
                syncEngine.recordLocalMutation(
                    command = "project.create",
                    entityId = projectId,
                    baseVersion = null,
                    payload = mapOf(
                        "name" to normalizedName,
                        "taskPrefix" to normalizedPrefix,
                        "__localId" to projectId
                    )
                )
                _messages.tryEmit("项目已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建项目失败"))
            }
        }
    }

    fun archiveProject(project: ProjectEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                require(project.ownerId == ownerId) { "项目不属于当前账户" }
                val now = nowIso()
                db.projectDao().upsertProject(
                    project.copy(
                        archivedAt = now,
                        version = project.version + 1,
                        updatedAt = now,
                        pendingSync = true
                    )
                )
                syncEngine.recordLocalMutation(
                    command = "project.archive",
                    entityId = project.id,
                    baseVersion = project.version,
                    payload = emptyMap()
                )
                _messages.tryEmit("项目已归档")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档项目失败"))
            }
        }
    }

    fun scheduleTask(
        task: TaskEntity,
        localDate: String,
        copy: Boolean,
        onSuccess: () -> Unit = {}
    ) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId
                    ?: throw IllegalStateException("登录状态已失效，请重新登录")
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                require(localDate.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) {
                    "日期格式无效"
                }
                val datePoint = getOrCreateDatePoint(ownerId, localDate)
                val placements = db.placementDao().getPlacementsByTaskIdForOwner(ownerId, task.id)
                val targetPlacement = placements.firstOrNull { it.timePointId == datePoint.id }
                if (targetPlacement == null) {
                    val now = nowIso()
                    val placementId = UUID.randomUUID().toString()
                    db.placementDao().upsertPlacement(
                        PlacementEntity(
                            id = placementId,
                            ownerId = ownerId,
                            taskId = task.id,
                            timePointId = datePoint.id,
                            rank = "1000",
                            version = 1,
                            createdAt = now,
                            updatedAt = now,
                            pendingSync = true
                        )
                    )
                    syncEngine.recordLocalMutation(
                        command = "placement.create",
                        entityId = placementId,
                        baseVersion = null,
                        payload = mapOf(
                            "taskId" to task.id,
                            "timePointId" to datePoint.id,
                            "__localId" to placementId
                        )
                    )
                }

                if (!copy) {
                    placements
                        .filter { it.timePointId != datePoint.id }
                        .forEach { placement ->
                            db.placementDao().deletePlacementForOwner(ownerId, placement.id)
                            syncEngine.recordLocalMutation(
                                command = "placement.remove",
                                entityId = placement.id,
                                baseVersion = placement.version,
                                payload = emptyMap()
                            )
                        }
                }
                loadTodayData()
                _messages.tryEmit(if (copy) "任务已复制到 $localDate" else "任务已安排到 $localDate")
                onSuccess()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("安排任务失败"))
            }
        }
    }

    fun syncNow() {
        viewModelScope.launch {
            if (!authManager.isLoggedIn) return@launch
            _dataReady.value = false
            try {
                syncEngine.triggerSync()
                loadTodayData()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("同步失败"))
            } finally {
                _dataReady.value = true
            }
        }
    }

    fun onAuthenticated() {
        sessionRestoreJob?.cancel()
        sessionRestoreJob = null
        syncEngine.setNetworkAvailable(true)
        _authenticated.value = true
        currentOwnerId.value = authManager.ownerId
        _dataReady.value = false
        loadTodayData()
        syncEngine.start()
        syncNow()
    }

    fun onLoggedOut() {
        sessionRestoreJob?.cancel()
        sessionRestoreJob = null
        syncEngine.stop()
        _authenticated.value = false
        currentOwnerId.value = null
        todayLoadJob?.cancel()
        midnightRefreshJob?.cancel()
        _todayTasks.value = emptyList()
        _dataReady.value = true
    }

    fun observeTask(taskId: String): Flow<TaskEntity?> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.taskDao().getTaskByIdFlow(taskId, it) } ?: flowOf(null)
    }

    fun observeTaskById(taskId: String): Flow<TaskEntity?> = observeTask(taskId)

    fun observeNote(taskId: String): Flow<NoteEntity?> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.noteDao().getNoteByTaskIdFlow(taskId, it) } ?: flowOf(null)
    }

    suspend fun saveTaskDetails(
        task: TaskEntity,
        title: String,
        markdownContent: String
    ): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val ownerId = authManager.ownerId
                ?: throw IllegalStateException("登录状态已失效，请重新登录")
            require(task.ownerId == ownerId) { "任务不属于当前账户" }
            val normalizedTitle = title.trim()
            require(normalizedTitle.isNotEmpty()) { "任务标题不能为空" }
            val now = nowIso()

            if (normalizedTitle != task.title) {
                db.taskDao().upsertTask(
                    task.copy(
                        title = normalizedTitle,
                        version = task.version + 1,
                        updatedAt = now,
                        pendingSync = true
                    )
                )
                syncEngine.recordLocalMutation(
                    command = "task.update",
                    entityId = task.id,
                    baseVersion = task.version,
                    payload = mapOf("title" to normalizedTitle)
                )
            }

            val existingNote = db.noteDao().getNoteByTaskId(task.id, ownerId)
            if (existingNote?.contentMarkdown != markdownContent &&
                (existingNote != null || markdownContent.isNotBlank())
            ) {
                val note = (existingNote ?: NoteEntity(
                    id = UUID.randomUUID().toString(),
                    ownerId = ownerId,
                    taskId = task.id,
                    contentMarkdown = "",
                    version = 0,
                    createdAt = now,
                    updatedAt = now
                )).copy(
                    contentMarkdown = markdownContent,
                    version = existingNote?.version?.plus(1) ?: 1,
                    updatedAt = now,
                    pendingSync = true
                )
                db.noteDao().upsertNote(note)
                syncEngine.recordLocalMutation(
                    command = "note.update",
                    entityId = task.id,
                    baseVersion = existingNote?.version,
                    payload = mapOf("contentMarkdown" to markdownContent)
                )
            }
            loadTodayData()
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        authManager.themeMode = mode.name
        _themeMode.value = mode
    }

    fun setDynamicColor(enabled: Boolean) {
        authManager.dynamicColor = enabled
        _dynamicColor.value = enabled
    }

    fun setPureBlack(enabled: Boolean) {
        authManager.pureBlack = enabled
        _pureBlack.value = enabled
    }

    private suspend fun getOrCreateDatePoint(ownerId: String, localDate: String): TimePointEntity {
        return db.timePointDao().getTimePointByDate(ownerId, localDate) ?: run {
            val now = nowIso()
            TimePointEntity(
                id = UUID.randomUUID().toString(),
                ownerId = ownerId,
                type = TimePointType.DATE,
                localDate = localDate,
                title = null,
                rank = "1000",
                version = 1,
                reachedAt = null,
                archivedAt = null,
                createdAt = now,
                updatedAt = now,
                pendingSync = true
            ).also { newPoint ->
                db.timePointDao().upsertTimePoint(newPoint)
                syncEngine.recordLocalMutation(
                    command = "timePoint.date.create",
                    entityId = newPoint.id,
                    baseVersion = null,
                    payload = mapOf("localDate" to localDate)
                )
            }
        }
    }

    private fun readThemeMode(): ThemeMode = ThemeMode.values()
        .firstOrNull { it.name == authManager.themeMode }
        ?: ThemeMode.SYSTEM

    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())

    private fun Throwable.userMessage(prefix: String): String {
        val detail = message?.takeIf { it.isNotBlank() }
        return if (detail == null) prefix else "$prefix：$detail"
    }

    override fun onCleared() {
        super.onCleared()
        todayLoadJob?.cancel()
        midnightRefreshJob?.cancel()
        syncEngine.stop()
    }
}

class MainViewModelFactory(private val context: Context) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        val db = AppDatabase.getInstance(context)
        val auth = SecureAuthManager(context)
        val api = ApiClient(auth)
        val syncEngine = SyncEngine(db, api, auth)
        @Suppress("UNCHECKED_CAST")
        return MainViewModel(db, syncEngine, auth, api) as T
    }
}
