package com.devtodo.app.ui.screens

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.data.sync.SyncOutcome
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

data class TaskStatusChange(
    val taskId: String,
    val ownerId: String,
    val title: String,
    val before: TaskStatus,
    val after: TaskStatus,
    val appliedVersion: Long,
)

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

    val activeTimePoints: StateFlow<List<TimePointEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.timePointDao().getActiveTimePointsFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val activeTimePointPlacements: StateFlow<List<PlacementEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.placementDao().getActivePlacementsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val activeEvents: StateFlow<List<TimePointEntity>> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.timePointDao().getActiveEventsFlow(it) } ?: flowOf(emptyList())
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val settings: StateFlow<SettingsEntity?> = currentOwnerId
        .flatMapLatest { ownerId ->
            ownerId?.let { db.settingsDao().getSettingsFlow(it) } ?: flowOf(null)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    private val _todayTasks = MutableStateFlow<List<Pair<TaskEntity, PlacementEntity>>>(emptyList())
    val todayTasks: StateFlow<List<Pair<TaskEntity, PlacementEntity>>> = _todayTasks.asStateFlow()

    private val _dataReady = MutableStateFlow(!authManager.isLoggedIn)
    val dataReady: StateFlow<Boolean> = _dataReady.asStateFlow()

    private val _pullRefreshing = MutableStateFlow(false)
    val pullRefreshing: StateFlow<Boolean> = _pullRefreshing.asStateFlow()

    private val _authenticated = MutableStateFlow(authManager.isLoggedIn)
    val authenticated: StateFlow<Boolean> = _authenticated.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val messages: SharedFlow<String> = _messages.asSharedFlow()
    private val _statusChanges = MutableSharedFlow<TaskStatusChange>(extraBufferCapacity = 16)
    val statusChanges = _statusChanges.asSharedFlow()

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
        get() = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone(settings.value?.timezone ?: "Asia/Shanghai")
        }.format(Date())

    init {
        if (authManager.isLoggedIn) {
            loadTodayData()
            restorePersistedSession(showOfflineMessage = true)
        } else {
            scheduleSessionStoreRetry()
        }
    }

    /**
     * A cold boot can reject the first Keystore read, which would otherwise put
     * the login screen in front of a device that still holds a valid session.
     * Reopen the store once before believing that.
     */
    private fun scheduleSessionStoreRetry() {
        viewModelScope.launch(Dispatchers.IO) {
            delay(600L)
            if (!isActive || !authManager.retrySecureStore()) return@launch
            withContext(Dispatchers.Main.immediate) { restorePersistedSession(true) }
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
                val change = db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    require(task.ownerId == ownerId) { "任务不属于当前账户" }
                    val current = db.taskDao().getTaskById(task.id, ownerId) ?: error("任务已不存在")
                    if (current.status == nextStatus) return@withTransaction null
                    val now = nowIso()
                    val updated = current.copy(status = nextStatus, version = current.version + 1,
                        completedAt = if (nextStatus == TaskStatus.DONE) now else null,
                        updatedAt = now, pendingSync = true)
                    db.taskDao().upsertTask(updated)
                    syncEngine.recordLocalMutation("task.update", current.id, current.version,
                        mapOf("status" to nextStatus.name), ownerId = ownerId)
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                    TaskStatusChange(current.id, ownerId, current.title, current.status, nextStatus, updated.version)
                }
                loadTodayData()
                change?.let { _statusChanges.emit(it) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("更新任务状态失败"))
            }
        }
    }

    fun undoTaskStatus(change: TaskStatusChange) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    require(authManager.ownerId == change.ownerId) { "当前账户已变化" }
                    val current = db.taskDao().getTaskById(change.taskId, change.ownerId)
                        ?: error("任务已不存在")
                    require(current.status == change.after && current.version == change.appliedVersion) {
                        "任务已有新变化，无法撤销这次操作"
                    }
                    val now = nowIso()
                    db.taskDao().upsertTask(current.copy(status = change.before,
                        completedAt = if (change.before == TaskStatus.DONE) now else null,
                        version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("task.update", current.id, current.version,
                        mapOf("status" to change.before.name), ownerId = change.ownerId)
                    require(authManager.ownerId == change.ownerId) { "当前账户已变化" }
                }
                loadTodayData()
                _messages.tryEmit("已撤销状态修改")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("撤销失败"))
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

    fun observeTaskPlacements(taskId: String): Flow<List<PlacementEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.placementDao().getPlacementsByTaskFlow(taskId, it) } ?: flowOf(emptyList())
    }

    fun createFolderV2(parentFolderId: String?, title: String) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "文件夹名称不能为空" }
                    parentFolderId?.let { parentId ->
                        val parent = db.folderDao().getById(parentId, ownerId)
                        require(parent != null && parent.deletedAt == null && parent.archivedAt == null) {
                            "父目录已不存在，请重新选择保存位置"
                        }
                    }
                    val id = UUID.randomUUID().toString()
                    val now = nowIso()
                    db.folderDao().upsert(FolderEntity(id, ownerId, parentFolderId, normalized, "1024", 1, null, null, now, now, null, true))
                    syncEngine.recordLocalMutation(
                        "folder.create",
                        id,
                        null,
                        mapOf("parentFolderId" to parentFolderId, "title" to normalized),
                        ownerId = ownerId,
                    )
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                _messages.tryEmit("文件夹已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建文件夹失败"))
            }
        }
    }

    fun createTreeTaskV2(parentFolderId: String?, title: String, onComplete: (String?) -> Unit = {}) {
        captureTaskV2(parentFolderId, title, null, onComplete)
    }

    fun createTreeTaskV2AtToday(title: String, onComplete: (String?) -> Unit = {}) {
        captureTaskV2(null, title, todayStr, onComplete)
    }

    fun createTreeTaskV2AtTimePoint(title: String, target: String, isDate: Boolean,
        onComplete: (String?) -> Unit = {}) {
        captureTaskV2(null, title, if (isDate) target else null, onComplete,
            eventId = if (isDate) null else target)
    }

    /** A capture is acknowledged only after its task, note, placement and outbox are durable. */
    fun captureTaskV2(parentFolderId: String?, title: String, localDate: String?,
        onComplete: (String?) -> Unit = {}, eventId: String? = null) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "任务标题不能为空" }
                    if (parentFolderId != null) {
                        val folder = db.folderDao().getById(parentFolderId, ownerId)
                        require(folder != null && folder.archivedAt == null && folder.deletedAt == null) {
                            "目录已不存在，请重新选择保存位置"
                        }
                    }
                    if (localDate != null) {
                        val format = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }
                        require(format.format(format.parse(localDate) ?: error("日期无效")) == localDate) { "日期无效" }
                    }
                    val taskId = UUID.randomUUID().toString()
                    val noteId = UUID.randomUUID().toString()
                    val now = nowIso()
                    val rank = ((db.taskDao().getAllTreeTasks(ownerId).filter {
                        it.parentFolderId == parentFolderId && it.status == TaskStatus.TODO &&
                            it.archivedAt == null && it.deletedAt == null
                    }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                    db.taskDao().upsertTask(TaskEntity(taskId, ownerId, null, null, normalized,
                        TaskStatus.TODO, TaskCategory.MISC, TaskPriority.NONE, rank, 1,
                        null, now, now, parentFolderId, null, null, null, true))
                    db.noteDao().upsertNote(NoteEntity(noteId, ownerId, taskId, "", 1, now, now, null, true))
                    syncEngine.recordLocalMutation("task.create", taskId, null,
                        mapOf("parentFolderId" to parentFolderId, "title" to normalized, "noteId" to noteId), ownerId = ownerId)
                    val point = when {
                        localDate != null -> getOrCreateDatePoint(ownerId, localDate)
                        eventId != null -> db.timePointDao().getTimePointById(eventId, ownerId)
                            ?.takeIf { it.deletedAt == null && it.archivedAt == null && it.type == TimePointType.EVENT }
                            ?: error("事件节点不存在")
                        else -> null
                    }
                    if (point != null) {
                        val placementId = UUID.randomUUID().toString()
                        db.placementDao().upsertPlacement(PlacementEntity(placementId, ownerId,
                            taskId, point.id, "1024", 1, now, now, null, true))
                        syncEngine.recordLocalMutation("placement.create", placementId, null,
                            mapOf("taskId" to taskId, "timePointId" to point.id, "__localId" to placementId), ownerId = ownerId)
                    }
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                loadTodayData()
                onComplete(null)
                _messages.tryEmit("已保存到本地")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(error.userMessage("保存失败，草稿已保留"))
            }
        }
    }

    fun duplicateTaskV2(task: TaskEntity) {
        viewModelScope.launch {
            try {
                db.withTransaction {
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
                    syncEngine.recordLocalMutation(
                        "task.duplicate",
                        task.id,
                        null,
                        mapOf("taskId" to taskId, "noteId" to noteId, "stepIds" to stepIds),
                        ownerId = ownerId,
                    )
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
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
                db.withTransaction {
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
                        ownerId = ownerId,
                    )
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
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

    fun createWorkflowV2(name: String, onComplete: (String?) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    val normalized = name.trim()
                    require(normalized.isNotEmpty()) { "流程名称不能为空" }
                    val id = UUID.randomUUID().toString()
                    val now = nowIso()
                    val stageId = UUID.randomUUID().toString()
                    db.workflowDao().upsertWorkflow(WorkflowEntity(id, ownerId, normalized, "1024", 1, null, now, now, null, true))
                    db.workflowDao().upsertStages(listOf(WorkflowStageEntity(stageId, ownerId, id, "阶段 1", "1024", 1, now, now, null, true)))
                    syncEngine.recordLocalMutation("workflow.create", id, null, mapOf("name" to normalized, "defaultStageId" to stageId), ownerId = ownerId)
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                onComplete(null)
                _messages.tryEmit("流程已创建")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = error.userMessage("创建流程失败")
                onComplete(message)
                _messages.tryEmit(message)
            }
        }
    }

    fun createWorkflowStageV2(workflow: WorkflowEntity, name: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId) { "流程不属于当前账户" }
                    val normalized = name.trim()
                    require(normalized.isNotEmpty()) { "阶段名称不能为空" }
                    val id = UUID.randomUUID().toString()
                    val now = nowIso()
                    val existing = db.workflowDao().getStagesFlow(workflow.id, ownerId).first()
                    val rank = ((existing.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                    db.workflowDao().upsertStages(listOf(WorkflowStageEntity(id, ownerId, workflow.id, normalized, rank, 1, now, now, null, true)))
                    syncEngine.recordLocalMutation(
                        "workflowStage.create",
                        id,
                        null,
                        mapOf("workflowId" to workflow.id, "name" to normalized),
                        ownerId = ownerId,
                    )
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建阶段失败"))
            }
        }
    }

    fun updateWorkflowV2(workflow: WorkflowEntity, name: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId) { "流程不属于当前账户" }
                    val normalized = name.trim()
                    require(normalized.isNotEmpty()) { "流程名称不能为空" }
                    val current = db.workflowDao().getWorkflowById(workflow.id, ownerId) ?: error("流程已不存在")
                    val now = nowIso()
                    db.workflowDao().upsertWorkflow(current.copy(name = normalized, version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("workflow.update", current.id, current.version, mapOf("name" to normalized), ownerId = ownerId)
                }
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
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId) { "流程不属于当前账户" }
                    val current = db.workflowDao().getWorkflowById(workflow.id, ownerId) ?: error("流程已不存在")
                    val now = nowIso()
                    val stages = db.workflowDao().getStagesFlow(workflow.id, ownerId).first()
                    val memberships = db.workflowDao().getMembershipsFlow(workflow.id, ownerId).first()
                    memberships.forEach { membership ->
                        db.workflowDao().upsertMemberships(listOf(membership.copy(deletedAt = now, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                        syncEngine.recordLocalMutation("workflowTask.remove", membership.id, membership.version, emptyMap(), ownerId = ownerId)
                    }
                    stages.forEach { stage ->
                        db.workflowDao().upsertStages(listOf(stage.copy(deletedAt = now, version = stage.version + 1, updatedAt = now, pendingSync = true)))
                        syncEngine.recordLocalMutation("workflowStage.delete", stage.id, stage.version, emptyMap(), ownerId = ownerId)
                    }
                    db.workflowDao().upsertWorkflow(current.copy(deletedAt = now, version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("workflow.delete", current.id, current.version, emptyMap(), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除流程失败"))
            }
        }
    }

    fun updateWorkflowStageV2(stage: WorkflowStageEntity, name: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(stage.ownerId == ownerId) { "阶段不属于当前账户" }
                    val normalized = name.trim()
                    require(normalized.isNotEmpty()) { "阶段名称不能为空" }
                    val current = db.workflowDao().getStageById(stage.id, ownerId) ?: error("阶段已不存在")
                    val now = nowIso()
                    db.workflowDao().upsertStages(listOf(current.copy(name = normalized, version = current.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation("workflowStage.update", current.id, current.version, mapOf("name" to normalized), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存阶段失败"))
            }
        }
    }

    fun deleteWorkflowStageV2(stage: WorkflowStageEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(stage.ownerId == ownerId) { "阶段不属于当前账户" }
                    val current = db.workflowDao().getStageById(stage.id, ownerId) ?: error("阶段已不存在")
                    val stages = db.workflowDao().getStagesFlow(current.workflowId, ownerId).first()
                    require(stages.size > 1) { "流程至少需要保留一个阶段" }
                    val now = nowIso()
                    db.workflowDao().getMembershipsFlow(current.workflowId, ownerId).first()
                        .filter { it.stageId == current.id }
                        .forEach { membership ->
                            db.workflowDao().upsertMemberships(listOf(membership.copy(deletedAt = now, version = membership.version + 1, updatedAt = now, pendingSync = true)))
                            syncEngine.recordLocalMutation("workflowTask.remove", membership.id, membership.version, emptyMap(), ownerId = ownerId)
                        }
                    db.workflowDao().upsertStages(listOf(current.copy(deletedAt = now, version = current.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation("workflowStage.delete", current.id, current.version, emptyMap(), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除阶段失败"))
            }
        }
    }

    fun createTaskInWorkflowStageV2(workflow: WorkflowEntity, stage: WorkflowStageEntity, title: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId && stage.ownerId == ownerId) { "流程或阶段不属于当前账户" }
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
                    syncEngine.recordLocalMutation("task.create", taskId, null, mapOf("parentFolderId" to parentFolderId, "title" to normalized, "noteId" to noteId), ownerId = ownerId)
                    val membershipId = UUID.randomUUID().toString()
                    db.workflowDao().upsertMemberships(listOf(WorkflowTaskMembershipEntity(membershipId, ownerId, workflow.id, stage.id, taskId, "1024", 1, now, now, null, true)))
                    syncEngine.recordLocalMutation("workflowTask.add", membershipId, null, mapOf("workflowId" to workflow.id, "stageId" to stage.id, "taskId" to taskId), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建流程任务失败"))
            }
        }
    }

    fun moveWorkflowStageV2(stage: WorkflowStageEntity, siblings: List<WorkflowStageEntity>, direction: Int) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(stage.ownerId == ownerId) { "阶段不属于当前账户" }
                    val current = db.workflowDao().getStageById(stage.id, ownerId) ?: error("阶段已不存在")
                    val currentSiblings = db.workflowDao().getStagesFlow(current.workflowId, ownerId).first()
                    val index = currentSiblings.indexOfFirst { it.id == current.id }
                    val target = currentSiblings.getOrNull(index + direction) ?: return@withOwnerTransaction
                    val anchorRank = target.rank.toLongOrNull() ?: 1024L
                    val nextRank = if (direction < 0) (anchorRank - 1L).coerceAtLeast(0L) else anchorRank + 1L
                    val now = nowIso()
                    db.workflowDao().upsertStages(listOf(current.copy(rank = nextRank.toString(), version = current.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation(
                        "workflowStage.move",
                        current.id,
                        current.version,
                        mapOf(
                            "beforeId" to if (direction < 0) target.id else null,
                            "afterId" to if (direction > 0) target.id else null,
                        ),
                        ownerId = ownerId,
                    )
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动阶段失败"))
            }
        }
    }

    fun addWorkflowTaskV2(workflow: WorkflowEntity, stage: WorkflowStageEntity, task: TaskEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId && stage.ownerId == ownerId && task.ownerId == ownerId) { "流程、阶段或任务不属于当前账户" }
                    val existing = db.workflowDao().getMembershipsFlow(workflow.id, ownerId).first()
                    require(existing.none { it.taskId == task.id }) { "任务已经在该流程中" }
                    val id = UUID.randomUUID().toString()
                    val rank = ((existing.filter { it.stageId == stage.id }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                    val now = nowIso()
                    db.workflowDao().upsertMemberships(listOf(WorkflowTaskMembershipEntity(id, ownerId, workflow.id, stage.id, task.id, rank, 1, now, now, null, true)))
                    syncEngine.recordLocalMutation("workflowTask.add", id, null, mapOf("workflowId" to workflow.id, "stageId" to stage.id, "taskId" to task.id), ownerId = ownerId)
                }
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
                db.withOwnerTransaction { ownerId ->
                    require(membership.ownerId == ownerId && targetStage.ownerId == ownerId) { "流程任务或目标阶段不属于当前账户" }
                    val current = db.workflowDao().getMembershipById(membership.id, ownerId) ?: error("流程任务已不存在")
                    val siblings = db.workflowDao().getMembershipsFlow(current.workflowId, ownerId).first()
                    val targetSiblings = siblings.filter { it.stageId == targetStage.id && it.id != current.id }
                    require(siblings.none { it.id != current.id && it.taskId == current.taskId && it.workflowId == current.workflowId && it.stageId != targetStage.id }) { "任务已经在该流程中" }
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
                    db.workflowDao().upsertMemberships(listOf(current.copy(stageId = targetStage.id, rank = rank, version = current.version + 1, updatedAt = now, pendingSync = true)))
                    val payload = mutableMapOf<String, Any?>("stageId" to targetStage.id)
                    if (beforeId != null) payload["beforeId"] = beforeId
                    if (afterId != null) payload["afterId"] = afterId
                    syncEngine.recordLocalMutation("workflowTask.move", current.id, current.version, payload, ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动流程任务失败"))
            }
        }
    }

    fun removeWorkflowMembershipV2(membership: WorkflowTaskMembershipEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(membership.ownerId == ownerId) { "流程任务不属于当前账户" }
                    val current = db.workflowDao().getMembershipById(membership.id, ownerId) ?: error("流程任务已不存在")
                    val now = nowIso()
                    db.workflowDao().upsertMemberships(listOf(current.copy(deletedAt = now, version = current.version + 1, updatedAt = now, pendingSync = true)))
                    syncEngine.recordLocalMutation("workflowTask.remove", current.id, current.version, emptyMap(), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移除流程任务失败"))
            }
        }
    }

    fun createStepV2(taskId: String, title: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(db.taskDao().getTaskById(taskId, ownerId) != null) { "任务已不存在" }
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "步骤标题不能为空" }
                    val id = UUID.randomUUID().toString()
                    val now = nowIso()
                    db.taskStepDao().upsert(TaskStepEntity(id, ownerId, taskId, normalized, "", TaskStatus.TODO, "1024", null, 1, now, now, null, true))
                    syncEngine.recordLocalMutation("taskStep.create", id, null, mapOf("taskId" to taskId, "title" to normalized, "noteMarkdown" to ""), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建步骤失败"))
            }
        }
    }

    fun updateStepStatusV2(step: TaskStepEntity, nextStatus: TaskStatus) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(step.ownerId == ownerId) { "步骤不属于当前账户" }
                    val current = db.taskStepDao().getById(step.id, ownerId) ?: error("步骤已不存在")
                    val now = nowIso()
                    db.taskStepDao().upsert(current.copy(status = nextStatus, completedAt = if (nextStatus == TaskStatus.DONE) now else null, version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("taskStep.update", current.id, current.version, mapOf("status" to nextStatus.name), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("更新步骤失败"))
            }
        }
    }

    fun updateStepV2(step: TaskStepEntity, title: String, noteMarkdown: String) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(step.ownerId == ownerId) { "步骤不属于当前账户" }
                    val current = db.taskStepDao().getById(step.id, ownerId) ?: error("步骤已不存在")
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "步骤标题不能为空" }
                    require(noteMarkdown.length <= 1024 * 1024) { "步骤备注过大" }
                    val now = nowIso()
                    db.taskStepDao().upsert(
                        current.copy(
                            title = normalized,
                            noteMarkdown = noteMarkdown,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        "taskStep.update",
                        current.id,
                        current.version,
                        mapOf("title" to normalized, "noteMarkdown" to noteMarkdown),
                        ownerId = ownerId,
                    )
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存步骤失败"))
            }
        }
    }

    fun moveStepV2(step: TaskStepEntity, direction: Int) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(step.ownerId == ownerId) { "步骤不属于当前账户" }
                    val current = db.taskStepDao().getById(step.id, ownerId) ?: error("步骤已不存在")
                    val siblings = db.taskStepDao().getByTaskFlow(current.taskId, ownerId).first()
                    val index = siblings.indexOfFirst { it.id == current.id }
                    val target = siblings.getOrNull(index + direction) ?: return@withOwnerTransaction
                    val targetRank = target.rank.toLongOrNull() ?: 1024L
                    val rank = if (direction < 0) (targetRank - 1L).coerceAtLeast(0L) else targetRank + 1L
                    val now = nowIso()
                    db.taskStepDao().upsert(current.copy(rank = rank.toString(), version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation(
                        "taskStep.move",
                        current.id,
                        current.version,
                        mapOf("beforeId" to if (direction < 0) target.id else null, "afterId" to if (direction > 0) target.id else null),
                        ownerId = ownerId,
                    )
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移动步骤失败"))
            }
        }
    }

    fun deleteStepV2(step: TaskStepEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(step.ownerId == ownerId) { "步骤不属于当前账户" }
                    val current = db.taskStepDao().getById(step.id, ownerId) ?: error("步骤已不存在")
                    val now = nowIso()
                    db.taskStepDao().upsert(current.copy(deletedAt = now, version = current.version + 1, updatedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("taskStep.delete", current.id, current.version, emptyMap(), ownerId = ownerId)
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除步骤失败"))
            }
        }
    }

    fun retryOutboxItem(item: OutboxEntity) {
        viewModelScope.launch {
            try {
                val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                require(item.ownerId == ownerId) { "操作不属于当前账户" }
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
                syncEngine.discardLocalMutation(item)
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
            try {
                db.withOwnerTransaction { ownerId ->
                    require(task.ownerId == ownerId) { "任务不属于当前账户" }
                    val current = db.taskDao().getTaskById(task.id, ownerId) ?: error("任务已不存在")
                    val now = nowIso()
                    val priorNote = db.noteDao().getNoteByTaskId(current.id, ownerId)
                    val priorSteps = db.taskStepDao().getByTaskFlow(current.id, ownerId).first()
                    val priorPlacements = db.placementDao().getPlacementsByTaskIdForOwner(ownerId, current.id)
                    val priorMemberships = db.workflowDao().getMembershipsForTask(current.id, ownerId)
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
                    db.taskDao().upsertTask(current.copy(version = current.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation("task.delete", current.id, current.version, emptyMap(), ownerId = ownerId)
                }
                _messages.tryEmit("任务及其内容已删除")
                onSuccess()
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("删除任务失败"))
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
        onSuccess: () -> Unit = {},
        onComplete: ((String?) -> Unit)? = null,
    ) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    require(task.ownerId == ownerId) { "任务不属于当前账户" }
                    val current = db.taskDao().getTaskById(task.id, ownerId) ?: error("任务已不存在")
                    require(current.archivedAt == null && current.deletedAt == null) { "任务已不可用" }
                    val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }
                    require(parser.format(parser.parse(localDate) ?: error("日期无效")) == localDate) { "日期无效" }
                    val datePoint = getOrCreateDatePoint(ownerId, localDate)
                    val placements = db.placementDao().getPlacementsByTaskIdForOwner(ownerId, task.id)
                    if (placements.none { it.timePointId == datePoint.id }) {
                        val now = nowIso()
                        val id = UUID.randomUUID().toString()
                        db.placementDao().upsertPlacement(PlacementEntity(id, ownerId, task.id, datePoint.id,
                            "1024", 1, now, now, null, true))
                        syncEngine.recordLocalMutation("placement.create", id, null,
                            mapOf("taskId" to task.id, "timePointId" to datePoint.id, "__localId" to id), ownerId = ownerId)
                    }
                    if (!copy) placements.filter { it.timePointId != datePoint.id }.forEach { placement ->
                        val now = nowIso()
                        db.placementDao().upsertPlacement(
                            placement.copy(
                                version = placement.version + 1,
                                updatedAt = now,
                                deletedAt = now,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation("placement.remove", placement.id, placement.version, emptyMap(), ownerId = ownerId)
                    }
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                loadTodayData()
                onComplete?.invoke(null)
                onSuccess()
                _messages.tryEmit("已安排到 $localDate")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = error.userMessage("安排任务失败")
                if (onComplete != null) onComplete(message) else _messages.tryEmit(message)
            }
        }
    }

    fun removePlacement(placement: PlacementEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(placement.ownerId == ownerId) { "安排不属于当前账户" }
                    val current = db.placementDao().getById(placement.id, ownerId) ?: error("安排已不存在")
                    val now = nowIso()
                    db.placementDao().upsertPlacement(current.copy(version = current.version + 1, updatedAt = now, deletedAt = now, pendingSync = true))
                    syncEngine.recordLocalMutation(
                        command = "placement.remove",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = emptyMap(),
                        ownerId = ownerId,
                    )
                }
                loadTodayData()
                _messages.tryEmit("安排已移除")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("移除安排失败"))
            }
        }
    }

    fun updateSettings(
        timezone: String? = null,
        weekStartsOn: Int? = null,
        defaultCaptureTarget: String? = null,
    ) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val current = db.settingsDao().getSettings(ownerId) ?: error("账户设置尚未同步")
                    val updated = current.copy(
                        timezone = timezone ?: current.timezone,
                        weekStartsOn = weekStartsOn ?: current.weekStartsOn,
                        defaultCaptureTarget = defaultCaptureTarget ?: current.defaultCaptureTarget,
                        updatedAt = nowIso(),
                        version = current.version + 1,
                    )
                    db.settingsDao().upsertSettings(updated)
                    syncEngine.recordLocalMutation(
                        command = "settings.update",
                        entityId = ownerId,
                        baseVersion = current.version,
                        payload = mapOf(
                            "timezone" to updated.timezone,
                            "weekStartsOn" to updated.weekStartsOn,
                            "defaultCaptureTarget" to updated.defaultCaptureTarget,
                        ),
                        ownerId = ownerId,
                    )
                }
                _messages.tryEmit("设置已保存")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存设置失败"))
            }
        }
    }

    fun showMessage(message: String) { _messages.tryEmit(message) }

    /**
     * Pull-to-refresh entry point for every list screen. Runs a full sync
     * (push the outbox, then pull changes) and keeps the M3 indicator spinning
     * until the hub answers; failures surface as a message, success is silent.
     */
    fun pullRefresh() {
        if (_pullRefreshing.value) return
        if (!authManager.isLoggedIn) return
        _pullRefreshing.value = true
        viewModelScope.launch {
            try {
                when (val outcome = syncEngine.triggerSync()) {
                    SyncOutcome.Success -> loadTodayData()
                    is SyncOutcome.Failure -> _messages.tryEmit("同步失败：${outcome.message}")
                }
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("同步失败"))
            } finally {
                _pullRefreshing.value = false
            }
        }
    }

    fun syncNow() {
        viewModelScope.launch {
            if (!authManager.isLoggedIn) return@launch
            _dataReady.value = false
            try {
                when (val outcome = syncEngine.triggerSync()) {
                    SyncOutcome.Success -> {
                        loadTodayData()
                        _messages.tryEmit("同步成功")
                    }
                    is SyncOutcome.Failure -> _messages.tryEmit("同步失败：${outcome.message}")
                }
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
            db.withOwnerTransaction { ownerId ->
                require(task.ownerId == ownerId) { "任务不属于当前账户" }
                val current = db.taskDao().getTaskById(task.id, ownerId) ?: error("任务已不存在")
                val normalizedTitle = title.trim()
                require(normalizedTitle.isNotEmpty()) { "任务标题不能为空" }
                val now = nowIso()

                if (normalizedTitle != current.title) {
                    db.taskDao().upsertTask(
                        current.copy(
                            title = normalizedTitle,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "task.update",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = mapOf("title" to normalizedTitle),
                        ownerId = ownerId,
                    )
                }

                val existingNote = db.noteDao().getNoteByTaskId(current.id, ownerId)
                if (existingNote?.contentMarkdown != markdownContent &&
                    (existingNote != null || markdownContent.isNotBlank())
                ) {
                    val note = (existingNote ?: NoteEntity(
                        id = UUID.randomUUID().toString(),
                        ownerId = ownerId,
                        taskId = current.id,
                        contentMarkdown = "",
                        version = 0,
                        createdAt = now,
                        updatedAt = now,
                    )).copy(
                        contentMarkdown = markdownContent,
                        version = existingNote?.version?.plus(1) ?: 1,
                        updatedAt = now,
                        pendingSync = true,
                    )
                    db.noteDao().upsertNote(note)
                    syncEngine.recordLocalMutation(
                        command = "note.update",
                        entityId = current.id,
                        baseVersion = existingNote?.version,
                        payload = mapOf("contentMarkdown" to markdownContent),
                        ownerId = ownerId,
                    )
                }
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
                    payload = mapOf("localDate" to localDate),
                    ownerId = ownerId,
                )
            }
        }
    }

    private fun readThemeMode(): ThemeMode = ThemeMode.values()
        .firstOrNull { it.name == authManager.themeMode }
        ?: ThemeMode.SYSTEM

    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())

    private suspend fun <T> AppDatabase.withOwnerTransaction(block: suspend (String) -> T): T =
        withTransaction {
            val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
            val result = block(ownerId)
            require(authManager.ownerId == ownerId) { "当前账户已变化" }
            result
        }

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
