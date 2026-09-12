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
            sessionRestoreJob = viewModelScope.launch(Dispatchers.IO) {
                val restored = api.restoreSession()
                if (!isActive) return@launch
                when {
                    restored -> syncEngine.start()
                    !authManager.isLoggedIn -> withContext(Dispatchers.Main.immediate) {
                        onLoggedOut()
                        _messages.tryEmit("登录已失效，请重新登录")
                    }
                    else -> withContext(Dispatchers.Main.immediate) {
                        _dataReady.value = true
                        _messages.tryEmit("暂时无法恢复中枢连接，登录状态已保留")
                    }
                }
            }
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
                        ?.takeIf { it.archivedAt == null }
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
