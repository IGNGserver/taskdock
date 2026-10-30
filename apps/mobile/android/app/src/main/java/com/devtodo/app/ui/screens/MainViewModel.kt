package com.devtodo.app.ui.screens

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.room.withTransaction as roomTransaction
import kotlinx.coroutines.CancellationException
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.remote.ApiClientException
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.update.AppUpdateManager
import com.devtodo.app.data.update.AppUpdateState
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.data.sync.SyncOutcome
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.data.sync.LoadProgress
import com.devtodo.app.ui.theme.ThemeMode
import com.devtodo.app.widget.WidgetPreviewPublisher
import com.devtodo.app.widget.WidgetUpdater
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asContextElement
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
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
    db: AppDatabase,
    syncEngine: SyncEngine,
    val authManager: SecureAuthManager,
    val api: ApiClient,
    private val isolateAccounts: Boolean = false,
) : ViewModel() {
    private var activeDatabase = db
    private var activeEngine = syncEngine
    private val transactionDatabase = ThreadLocal<AppDatabase>()
    private val transactionEngine = ThreadLocal<SyncEngine>()
    private var db: AppDatabase
        get() = transactionDatabase.get() ?: activeDatabase
        set(value) { activeDatabase = value }
    private var syncEngine: SyncEngine
        get() = transactionEngine.get() ?: activeEngine
        set(value) { activeEngine = value }

    private val _syncState = MutableStateFlow(syncEngine.syncState.value)
    val syncState: StateFlow<SyncState> = _syncState.asStateFlow()
    private val _lastSyncError = MutableStateFlow<String?>(null)
    val lastSyncError: StateFlow<String?> = _lastSyncError.asStateFlow()
    private val _loadProgress = MutableStateFlow(LoadProgress())
    val loadProgress: StateFlow<LoadProgress> = _loadProgress.asStateFlow()
    private val _pageLoads = MutableStateFlow<Map<String, com.devtodo.app.data.sync.PageLoadState>>(emptyMap())
    val pageLoads = _pageLoads.asStateFlow()
    private val _directoryPages = MutableStateFlow<Map<String, com.devtodo.app.data.sync.DirectoryPageState>>(emptyMap())
    val directoryPages = _directoryPages.asStateFlow()
    val freshnessWindowMs: Long get() = if (api.isConstrainedNetwork) 360_000L else 120_000L

    // Destinations re-subscribe to Room on every visit, so their flows start
    // from an empty emission. Seeding `collectAsStateWithLifecycle` with the
    // last list keeps the first frame complete: a restored LazyListState is
    // not clamped against an empty list, and detail pages do not flash their
    // "empty" state before the first row arrives. Keys include the owner so a
    // cached list can never leak across accounts.
    private val directoryMembersCache = java.util.concurrent.ConcurrentHashMap<String, List<TaskEntity>>()
    private val directoryFoldersCache = java.util.concurrent.ConcurrentHashMap<String, List<FolderEntity>>()
    private val directoryCountsCache = java.util.concurrent.ConcurrentHashMap<String, DirectoryCounts>()
    private val monthPointsCache = java.util.concurrent.ConcurrentHashMap<String, List<TimePointEntity>>()
    private val monthCountsCache = java.util.concurrent.ConcurrentHashMap<String, List<MonthCount>>()
    private val workflowStagesCache = java.util.concurrent.ConcurrentHashMap<String, List<WorkflowStageEntity>>()
    private val workflowMembershipsCache =
        java.util.concurrent.ConcurrentHashMap<String, List<WorkflowTaskMembershipEntity>>()
    private val taskStepsCache = java.util.concurrent.ConcurrentHashMap<String, List<TaskStepEntity>>()
    private val taskPlacementsCache = java.util.concurrent.ConcurrentHashMap<String, List<PlacementEntity>>()
    private val taskDetailCache = java.util.concurrent.ConcurrentHashMap<String, TaskEntity>()
    private val noteCache = java.util.concurrent.ConcurrentHashMap<String, NoteEntity>()

    private fun cacheKey(scope: String): String = "${authManager.ownerId ?: "anonymous"}:$scope"

    /** Page caches only accelerate a return; bound them so browsing stays flat. */
    private fun <T : Any> java.util.concurrent.ConcurrentHashMap<String, T>.putBounded(
        key: String,
        value: T,
        limit: Int = 48,
    ) {
        if (size >= limit && !containsKey(key)) remove(keys.firstOrNull() ?: key)
        put(key, value)
    }

    private fun clearPageCaches() {
        directoryMembersCache.clear()
        directoryFoldersCache.clear()
        directoryCountsCache.clear()
        monthPointsCache.clear()
        monthCountsCache.clear()
        workflowStagesCache.clear()
        workflowMembershipsCache.clear()
        taskStepsCache.clear()
        taskPlacementsCache.clear()
        taskDetailCache.clear()
        noteCache.clear()
    }
    private var activePageKey: String? = null
    private var foreground = false
    private val ownerIdentity = MutableStateFlow(authManager.ownerId)
    private val databaseVersion = MutableStateFlow(0)
    private val currentOwnerId = combine(ownerIdentity, databaseVersion) { owner, _ -> owner }
    private var boundNamespace = authManager.databaseNamespace
    private var boundSession = authManager.sessionKey
    private var engineObservers: Job? = null
    val hasCachedData = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.syncMetaDao().hasCache(it, "v2:sync_cursor:$it") } ?: flowOf(false)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val lastConfirmedAt = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.syncMetaDao().observe("confirmed:$it").map { value -> value?.toLongOrNull() ?: 0L } } ?: flowOf(0L)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0L)

    private val appUpdateManager = AppUpdateManager(authManager.appContext)
    val appUpdateState: StateFlow<AppUpdateState> = appUpdateManager.state
    val updateInstallEvents = appUpdateManager.installEvents

    private fun bindAccount() {
        if (isolateAccounts && (boundNamespace != authManager.databaseNamespace || boundSession != authManager.sessionKey)) {
            syncEngine.stop()
            db = authManager.scopedDatabase()
            syncEngine = SyncEngine(db, api, authManager)
            boundNamespace = authManager.databaseNamespace
            boundSession = authManager.sessionKey
            databaseVersion.value++
        }
        if (ownerIdentity.value != authManager.ownerId) clearPageCaches()
        ownerIdentity.value = authManager.ownerId
        engineObservers?.cancel()
        engineObservers = viewModelScope.launch {
            launch { syncEngine.syncState.collect {
                _syncState.value = it
                if (it == SyncState.AUTH_REQUIRED && !authManager.isLoggedIn) onLoggedOut()
            } }
            launch { syncEngine.lastSyncError.collect { _lastSyncError.value = it } }
            launch { syncEngine.loadProgress.collect { _loadProgress.value = it } }
            launch { syncEngine.pageLoads.collect { _pageLoads.value = it } }
            launch { syncEngine.directoryPages.collect { _directoryPages.value = it } }
        }
    }

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

    val folderAggregates = combine(foldersV2, currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.taskDao().locationsFlow(it) } ?: flowOf(emptyList())
    }) { folders, locations -> directoryAggregates(folders, locations) }
        .flowOn(Dispatchers.Default)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    fun observeDirectory(parent: String?, limit: Int, pinnedIds: List<String>): Flow<List<TaskEntity>> = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.taskDao().directoryWindow(it, parent, limit, pinnedIds) } ?: flowOf(emptyList())
    }
    fun observeDirectoryMembers(parent: String?, pinnedIds: List<String>, cacheLimit: Int = 100): Flow<List<TaskEntity>> =
        combine(currentOwnerId, directoryPages) { owner, pages -> owner to pages["directory:${parent ?: "root"}"] }
            .flatMapLatest { (owner, page) ->
                when {
                    owner == null -> flowOf(emptyList())
                    page?.initialized == true -> {
                        // Older Android SQLite builds cap bind parameters at 999.
                        val chunks = (page.taskIds + pinnedIds).toList().chunked(800).ifEmpty { listOf(emptyList()) }
                        combine(chunks.map { db.taskDao().directoryMembers(owner, parent, it) }) { rows -> rows.flatMap { it }.distinctBy { it.id } }
                    }
                    else -> db.taskDao().directoryWindow(owner, parent, cacheLimit, pinnedIds)
                }
            }
            .onEach { directoryMembersCache.putBounded(cacheKey("directory-members:${parent ?: "root"}"), it) }

    fun cachedDirectoryMembers(parent: String?): List<TaskEntity> =
        directoryMembersCache[cacheKey("directory-members:${parent ?: "root"}")].orEmpty()

    fun observeDirectoryFolders(parent: String?): Flow<List<FolderEntity>> =
        combine(currentOwnerId, directoryPages) { owner, pages -> owner to pages["directory:${parent ?: "root"}"] }
            .flatMapLatest { (owner, page) ->
                when {
                    owner == null -> flowOf(emptyList())
                    page?.initialized == true -> {
                        val chunks = page.folderIds.toList().chunked(800).ifEmpty { listOf(emptyList()) }
                        combine(chunks.map { db.folderDao().directoryMembers(owner, parent, it) }) { rows -> rows.flatMap { it }.distinctBy { it.id } }
                    }
                    else -> db.folderDao().getChildrenFlow(owner, parent)
                }
            }
            .onEach { directoryFoldersCache.putBounded(cacheKey("directory-folders:${parent ?: "root"}"), it) }

    fun cachedDirectoryFolders(parent: String?): List<FolderEntity> =
        directoryFoldersCache[cacheKey("directory-folders:${parent ?: "root"}")].orEmpty()

    fun observeDirectoryCounts(parent: String?): Flow<DirectoryCounts> = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.taskDao().directoryCounts(it, parent) } ?: flowOf(DirectoryCounts())
    }.onEach { directoryCountsCache.putBounded(cacheKey("directory-counts:${parent ?: "root"}"), it) }

    fun cachedDirectoryCounts(parent: String?): DirectoryCounts? =
        directoryCountsCache[cacheKey("directory-counts:${parent ?: "root"}")]
    fun observeMonthPoints(start: String, end: String): Flow<List<TimePointEntity>> = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.timePointDao().monthPoints(it, start, end) } ?: flowOf(emptyList())
    }.onEach { monthPointsCache.putBounded(cacheKey("month-points:$start:$end"), it) }

    fun cachedMonthPoints(start: String, end: String): List<TimePointEntity>? =
        monthPointsCache[cacheKey("month-points:$start:$end")]

    fun observeMonthCounts(start: String, end: String): Flow<List<MonthCount>> = currentOwnerId.flatMapLatest { owner ->
        owner?.let { db.placementDao().monthCounts(it, start, end) } ?: flowOf(emptyList())
    }.onEach { monthCountsCache.putBounded(cacheKey("month-counts:$start:$end"), it) }

    fun cachedMonthCounts(start: String, end: String): List<MonthCount>? =
        monthCountsCache[cacheKey("month-counts:$start:$end")]

    val workflowsV2: StateFlow<List<WorkflowEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.workflowDao().getActiveFlow(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val archiveOperationsV2: StateFlow<List<ArchiveOperationEntity>> = currentOwnerId
        .flatMapLatest { ownerId -> ownerId?.let { db.archiveOperationDao().getAllFlow(it) } ?: flowOf(emptyList()) }
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

    data class RolloverUndoState(val localDate: String, val createdPlacementIds: List<String>)
    private val _lastRollover = MutableStateFlow<RolloverUndoState?>(null)
    val lastRollover: StateFlow<RolloverUndoState?> = _lastRollover.asStateFlow()
    private val _rolloverEvents = MutableSharedFlow<Int>(extraBufferCapacity = 16)
    val rolloverEvents: SharedFlow<Int> = _rolloverEvents.asSharedFlow()

    private var todayLoadJob: Job? = null
    private var midnightRefreshJob: Job? = null
    private var sessionRestoreJob: Job? = null

    private val todayStr: String
        get() = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone(settings.value?.timezone ?: "Asia/Shanghai")
        }.format(Date())

    init {
        bindAccount()
        if (authManager.isLoggedIn) {
            _dataReady.value = true
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
        if (sessionRestoreJob?.isActive == true) return
        sessionRestoreJob = viewModelScope.launch(Dispatchers.IO) {
            val restored = api.restoreSessionAsync()
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
        bindAccount()
        _authenticated.value = true
        _dataReady.value = true
        loadTodayData()
        syncEngine.start()
        syncEngine.setForeground(foreground)
        activePageKey?.let { syncEngine.prioritizePage(it) }
        WidgetUpdater.refreshAll(authManager.appContext)
        viewModelScope.launch {
            WidgetPreviewPublisher.publishIfDue(authManager.appContext)
        }
    }

    fun onNetworkStateChanged(available: Boolean) {
        syncEngine.setNetworkAvailable(available)
        if (available && authManager.isLoggedIn) {
            restorePersistedSession(showOfflineMessage = false)
        }
    }

    fun onAppForeground() {
        foreground = true
        syncEngine.setForeground(true)
        WidgetUpdater.refreshAll(authManager.appContext)
        if (authManager.isLoggedIn) {
            restorePersistedSession(showOfflineMessage = false)
        }
    }

    fun checkForUpdate(silent: Boolean = false) = appUpdateManager.check(silent)

    fun setUpdateChannel(channel: com.devtodo.app.data.update.UpdateChannel) = appUpdateManager.setUpdateChannel(channel)

    fun downloadUpdate() = appUpdateManager.download()

    fun cancelUpdateDownload() = appUpdateManager.cancelDownload()

    fun requestInstallDownloadedUpdate() = appUpdateManager.requestInstall()

    fun loadTodayData() {
        // Room observation is independent of the network refresh state.
        todayLoadJob?.cancel()
        val ownerId = authManager.ownerId?.takeIf { it.isNotBlank() }
        if (ownerId == null) {
            _todayTasks.value = emptyList()
            return
        }

        todayLoadJob = viewModelScope.launch {
            combine(currentOwnerId, settings) { owner, setting ->
                owner to SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone(setting?.timezone ?: "Asia/Shanghai")
                }.format(Date())
            }.flatMapLatest { (owner, date) ->
                owner?.let { db.placementDao().scheduledTasksFlow(it, date) } ?: flowOf(emptyList())
            }.collect { rows -> _todayTasks.value = rows.map { it.task to it.placement } }
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
                WidgetUpdater.refreshAll(authManager.appContext)
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
    }.onEach { taskStepsCache.putBounded(cacheKey("task-steps:$taskId"), it) }

    fun cachedTaskSteps(taskId: String): List<TaskStepEntity>? =
        taskStepsCache[cacheKey("task-steps:$taskId")]

    fun observeWorkflowStages(workflowId: String): Flow<List<WorkflowStageEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.workflowDao().getStagesFlow(workflowId, it) } ?: flowOf(emptyList())
    }.onEach { workflowStagesCache.putBounded(cacheKey("workflow-stages:$workflowId"), it) }

    fun cachedWorkflowStages(workflowId: String): List<WorkflowStageEntity>? =
        workflowStagesCache[cacheKey("workflow-stages:$workflowId")]

    fun observeWorkflowMemberships(workflowId: String): Flow<List<WorkflowTaskMembershipEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.workflowDao().getMembershipsFlow(workflowId, it) } ?: flowOf(emptyList())
    }.onEach { workflowMembershipsCache.putBounded(cacheKey("workflow-memberships:$workflowId"), it) }

    fun cachedWorkflowMemberships(workflowId: String): List<WorkflowTaskMembershipEntity>? =
        workflowMembershipsCache[cacheKey("workflow-memberships:$workflowId")]

    fun observeTimePointPlacements(timePointId: String): Flow<List<PlacementEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.placementDao().getPlacementsByTimePointFlow(it, timePointId) } ?: flowOf(emptyList())
    }

    fun observeTaskPlacements(taskId: String): Flow<List<PlacementEntity>> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.placementDao().getPlacementsByTaskFlow(taskId, it) } ?: flowOf(emptyList())
    }.onEach { taskPlacementsCache.putBounded(cacheKey("task-placements:$taskId"), it) }

    fun cachedTaskPlacements(taskId: String): List<PlacementEntity>? =
        taskPlacementsCache[cacheKey("task-placements:$taskId")]

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
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建文件夹失败"))
            }
        }
    }

    fun updateFolderTitleV2(folder: FolderEntity, newTitle: String, onComplete: ((Boolean) -> Unit)? = null) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(folder.ownerId == ownerId) { "文件夹不属于当前账户" }
                    val normalized = newTitle.trim()
                    require(normalized.isNotEmpty()) { "文件夹名称不能为空" }
                    val current = db.folderDao().getById(folder.id, ownerId) ?: error("文件夹已不存在")
                    require(current.deletedAt == null && current.archivedAt == null) { "文件夹已不可用" }
                    if (current.title == normalized) {
                        return@withOwnerTransaction
                    }
                    val now = nowIso()
                    db.folderDao().upsert(
                        current.copy(
                            title = normalized,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "folder.update",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = mapOf("title" to normalized),
                        ownerId = ownerId,
                    )
                }
                onComplete?.invoke(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("重命名文件夹失败"))
                onComplete?.invoke(false)
            }
        }
    }

    fun updateFolderStatusV2(folder: FolderEntity, nextStatus: TaskStatus) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(folder.ownerId == ownerId) { "文件夹不属于当前账户" }
                    val current = db.folderDao().getById(folder.id, ownerId) ?: error("文件夹已不存在")
                    require(current.deletedAt == null && current.archivedAt == null) { "文件夹已不可用" }
                    if (current.status == nextStatus) {
                        return@withOwnerTransaction
                    }
                    val now = nowIso()
                    db.folderDao().upsert(
                        current.copy(
                            status = nextStatus,
                            completedAt = if (nextStatus == TaskStatus.DONE) (current.completedAt ?: now) else null,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "folder.update",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = mapOf("status" to nextStatus.name),
                        ownerId = ownerId,
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("更新文件夹状态失败"))
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
                WidgetUpdater.refreshAll(authManager.appContext)
                onComplete(null)
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
                db.withOwnerTransaction { ownerId ->
                    require(folder.ownerId == ownerId) { "文件夹不属于当前账户" }
                    val current = db.folderDao().getById(folder.id, ownerId) ?: error("文件夹已不存在")
                    require(current.archivedAt == null && current.deletedAt == null) { "文件夹已归档或删除" }
                    val now = nowIso()
                    val operationId = UUID.randomUUID().toString()
                    val folders = db.folderDao().getAll(ownerId)
                    val folderIds = mutableSetOf<String>()
                    val pendingFolders = ArrayDeque<String>()
                    pendingFolders.add(current.id)
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
                    db.archiveOperationDao().upsertAll(listOf(ArchiveOperationEntity(operationId, ownerId, current.id, current.version, affectedFolders.size, affectedTasks.size, now, null)))
                    syncEngine.recordLocalMutation("folder.archiveTree", current.id, current.version, mapOf("operationId" to operationId), ownerId = ownerId)
                }
                _messages.tryEmit("目录树已归档")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档目录失败"))
            }
        }
    }

    fun restoreFolderTreeV2(operation: ArchiveOperationEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(operation.ownerId == ownerId) { "归档操作不属于当前账户" }
                    val current = db.archiveOperationDao().getById(operation.id, ownerId) ?: error("归档操作已不存在")
                    val now = nowIso()
                    val folders = db.folderDao().getAll(ownerId)
                    val tasks = db.taskDao().getAllTreeTasks(ownerId)
                    folders.filter { it.archivedByOperationId == current.id }.forEach { folder ->
                        db.folderDao().upsert(folder.copy(archivedAt = null, archivedByOperationId = null, version = folder.version + 1, updatedAt = now, pendingSync = true))
                    }
                    tasks.filter { it.archivedByOperationId == current.id }.forEach { task ->
                        db.taskDao().upsertTask(task.copy(archivedAt = null, archivedByOperationId = null, version = task.version + 1, updatedAt = now, pendingSync = true))
                    }
                    db.archiveOperationDao().upsertAll(listOf(current.copy(restoredAt = now)))
                    syncEngine.recordLocalMutation("folder.restoreTree", current.rootFolderId, null, mapOf("operationId" to current.id), ownerId = ownerId)
                }
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
                db.withOwnerTransaction { ownerId ->
                    require(workflow.ownerId == ownerId) { "流程不属于当前账户" }
                    val current = db.workflowDao().getWorkflowById(workflow.id, ownerId) ?: error("流程已不存在")
                    val now = nowIso()
                    val restoring = current.archivedAt != null
                    db.workflowDao().upsertWorkflow(
                        current.copy(
                            archivedAt = if (restoring) null else now,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        if (restoring) "workflow.restore" else "workflow.archive",
                        current.id,
                        current.version,
                        emptyMap(),
                        ownerId = ownerId,
                    )
                }
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
                db.withOwnerTransaction { ownerId ->
                    require(task.ownerId == ownerId) { "任务不属于当前账户" }
                    val current = db.taskDao().getTaskByIdIncludingDeleted(task.id, ownerId) ?: error("任务已不存在")
                    require(current.deletedAt == null) { "任务已删除" }
                    val now = nowIso()
                    val updated = current.copy(
                        archivedAt = null,
                        archivedByOperationId = null,
                        version = current.version + 1,
                        updatedAt = now,
                        pendingSync = true,
                    )
                    db.taskDao().upsertTask(updated)
                    syncEngine.recordLocalMutation(
                        command = "task.restore",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = emptyMap(),
                        ownerId = ownerId,
                    )
                }
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
                db.withOwnerTransaction { ownerId ->
                    require(task.ownerId == ownerId) { "任务不属于当前账户" }
                    val current = db.taskDao().getTaskByIdIncludingDeleted(task.id, ownerId) ?: error("任务已不存在")
                    require(current.deletedAt == null && current.archivedAt == null) { "任务已归档或删除" }
                    val now = nowIso()
                    val updated = current.copy(
                        archivedAt = now,
                        version = current.version + 1,
                        updatedAt = now,
                        pendingSync = true,
                    )
                    db.taskDao().upsertTask(updated)
                    syncEngine.recordLocalMutation(
                        command = "task.archive",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = emptyMap(),
                        ownerId = ownerId,
                    )
                }
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
                db.withOwnerTransaction { ownerId ->
                    val normalizedTitle = title.trim()
                    require(normalizedTitle.isNotEmpty()) { "任务标题不能为空" }
                    projectId?.let { selectedProjectId ->
                        require(db.projectDao().getProjectById(selectedProjectId, ownerId) != null) {
                            "项目不属于当前账户"
                        }
                    }
                    val taskId = UUID.randomUUID().toString()
                    val noteId = UUID.randomUUID().toString()
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
                        pendingSync = true,
                    )
                    db.taskDao().upsertTask(task)
                    db.noteDao().upsertNote(NoteEntity(noteId, ownerId, taskId, "", 1, now, now, null, true))
                    syncEngine.recordLocalMutation(
                        command = "task.create",
                        entityId = taskId,
                        baseVersion = null,
                        payload = mapOf(
                            "title" to normalizedTitle,
                            "category" to category.name,
                            "projectId" to projectId,
                            "noteId" to noteId,
                        ),
                        ownerId = ownerId,
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
                            pendingSync = true,
                        )
                        db.placementDao().upsertPlacement(placement)
                        syncEngine.recordLocalMutation(
                            command = "placement.create",
                            entityId = placementId,
                            baseVersion = null,
                            payload = mapOf(
                                "taskId" to taskId,
                                "timePointId" to datePoint.id,
                                "__localId" to placementId,
                            ),
                            ownerId = ownerId,
                        )
                    }
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
                db.withOwnerTransaction { ownerId ->
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
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "project.create",
                        entityId = projectId,
                        baseVersion = null,
                        payload = mapOf(
                            "name" to normalizedName,
                            "taskPrefix" to normalizedPrefix,
                            "__localId" to projectId,
                        ),
                        ownerId = ownerId,
                    )
                }
                _messages.tryEmit("项目已创建")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("创建项目失败"))
            }
        }
    }

    fun archiveProject(project: ProjectEntity) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(project.ownerId == ownerId) { "项目不属于当前账户" }
                    val current = db.projectDao().getProjectById(project.id, ownerId) ?: error("项目已不存在")
                    require(current.archivedAt == null) { "项目已归档" }
                    val now = nowIso()
                    db.projectDao().upsertProject(
                        current.copy(
                            archivedAt = now,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "project.archive",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = emptyMap(),
                        ownerId = ownerId,
                    )
                }
                _messages.tryEmit("项目已归档")
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("归档项目失败"))
            }
        }
    }

    /**
     * Adds a task placement to a date. A task-level call cannot identify which
     * existing placement should move, so it must never remove the task's other
     * placements. Use [movePlacementToDate] for the web-compatible move
     * operation on one concrete placement.
     */
    fun scheduleTasks(
        tasks: List<TaskEntity>,
        localDate: String,
        onComplete: ((String?) -> Unit)? = null,
    ) {
        viewModelScope.launch {
            try {
                db.withTransaction {
                    val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
                    val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }
                    require(parser.format(parser.parse(localDate) ?: error("日期无效")) == localDate) { "日期无效" }
                    val datePoint = getOrCreateDatePoint(ownerId, localDate)
                    val currentPlacements = db.placementDao().getPlacementsByTimePoint(datePoint.id, ownerId)
                    val existingTaskIds = currentPlacements.map { it.taskId }.toSet()
                    var nextRank = currentPlacements.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L
                    val now = nowIso()

                    tasks.distinctBy { it.id }.forEach { task ->
                        if (task.id in existingTaskIds) return@forEach
                        require(task.ownerId == ownerId) { "任务不属于当前账户" }
                        val current = db.taskDao().getTaskById(task.id, ownerId) ?: error("任务已不存在")
                        require(current.archivedAt == null && current.deletedAt == null) { "任务已不可用" }

                        nextRank += 1024L
                        val id = UUID.randomUUID().toString()
                        db.placementDao().upsertPlacement(
                            PlacementEntity(
                                id = id,
                                ownerId = ownerId,
                                taskId = task.id,
                                timePointId = datePoint.id,
                                rank = nextRank.toString(),
                                version = 1,
                                createdAt = now,
                                updatedAt = now,
                                deletedAt = null,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "placement.create",
                            entityId = id,
                            baseVersion = null,
                            payload = mapOf(
                                "taskId" to task.id,
                                "timePointId" to datePoint.id,
                                "__localId" to id,
                            ),
                            ownerId = ownerId,
                        )
                    }
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                loadTodayData()
                onComplete?.invoke(null)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = error.userMessage("安排任务失败")
                if (onComplete != null) onComplete(message) else _messages.tryEmit(message)
            }
        }
    }

    @Suppress("UNUSED_PARAMETER")
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
                    require(authManager.ownerId == ownerId) { "当前账户已变化" }
                }
                loadTodayData()
                onComplete?.invoke(null)
                onSuccess()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = error.userMessage("安排任务失败")
                if (onComplete != null) onComplete(message) else _messages.tryEmit(message)
            }
        }
    }

    fun ensureDatePoint(localDate: String, onComplete: (String?) -> Unit = {}) {
        viewModelScope.launch {
            try {
                val pointId = db.withOwnerTransaction { ownerId ->
                    requireValidLocalDate(localDate)
                    getOrCreateDatePoint(ownerId, localDate).id
                }
                onComplete(pointId)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(null)
                _messages.tryEmit(error.userMessage("打开日期失败"))
            }
        }
    }

    fun createEvent(title: String, onComplete: (String?) -> Unit = {}) {
        viewModelScope.launch {
            try {
                val point = db.withOwnerTransaction { ownerId ->
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "事件名称不能为空" }
                    require(normalized.length <= 200) { "事件名称不能超过 200 个字符" }
                    val events = db.timePointDao().getActiveEventsFlow(ownerId).first()
                    val rank = ((events.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                    val now = nowIso()
                    val event = TimePointEntity(
                        id = UUID.randomUUID().toString(),
                        ownerId = ownerId,
                        type = TimePointType.EVENT,
                        localDate = null,
                        title = normalized,
                        rank = rank,
                        version = 1,
                        reachedAt = null,
                        archivedAt = null,
                        createdAt = now,
                        updatedAt = now,
                        pendingSync = true,
                    )
                    db.timePointDao().upsertTimePoint(event)
                    syncEngine.recordLocalMutation(
                        command = "timePoint.event.create",
                        entityId = event.id,
                        baseVersion = null,
                        payload = mapOf("title" to normalized),
                        ownerId = ownerId,
                    )
                    event
                }
                onComplete(point.id)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(null)
                _messages.tryEmit(error.userMessage("创建事件失败"))
            }
        }
    }

    fun updateEvent(event: TimePointEntity, title: String, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(event.ownerId == ownerId) { "事件不属于当前账户" }
                    val current = db.timePointDao().getTimePointById(event.id, ownerId)
                        ?: error("事件已不存在")
                    require(current.type == TimePointType.EVENT) { "日期不能改名" }
                    val normalized = title.trim()
                    require(normalized.isNotEmpty()) { "事件名称不能为空" }
                    require(normalized.length <= 200) { "事件名称不能超过 200 个字符" }
                    val now = nowIso()
                    db.timePointDao().upsertTimePoint(
                        current.copy(
                            title = normalized,
                            version = current.version + 1,
                            updatedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "timePoint.update",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = mapOf("title" to normalized),
                        ownerId = ownerId,
                    )
                }
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("保存事件失败"))
            }
        }
    }

    fun reachEvent(event: TimePointEntity, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(event.ownerId == ownerId) { "事件不属于当前账户" }
                    val current = db.timePointDao().getTimePointById(event.id, ownerId)
                        ?: error("事件已不存在")
                    require(current.type == TimePointType.EVENT) { "日期没有到达状态" }
                    if (current.reachedAt == null) {
                        val now = nowIso()
                        db.timePointDao().upsertTimePoint(
                            current.copy(
                                reachedAt = now,
                                version = current.version + 1,
                                updatedAt = now,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "timePoint.reach",
                            entityId = current.id,
                            baseVersion = current.version,
                            payload = emptyMap(),
                            ownerId = ownerId,
                        )
                    }
                }
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("标记事件失败"))
            }
        }
    }

    fun unreachEvent(event: TimePointEntity, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(event.ownerId == ownerId) { "事件不属于当前账户" }
                    val current = db.timePointDao().getTimePointById(event.id, ownerId)
                        ?: error("事件已不存在")
                    require(current.type == TimePointType.EVENT) { "日期没有到达状态" }
                    if (current.reachedAt != null) {
                        val now = nowIso()
                        db.timePointDao().upsertTimePoint(
                            current.copy(
                                reachedAt = null,
                                version = current.version + 1,
                                updatedAt = now,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "timePoint.unreach",
                            entityId = current.id,
                            baseVersion = current.version,
                            payload = emptyMap(),
                            ownerId = ownerId,
                        )
                    }
                }
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("撤销到达失败"))
            }
        }
    }

    fun deleteEvent(event: TimePointEntity, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(event.ownerId == ownerId) { "事件不属于当前账户" }
                    val current = db.timePointDao().getTimePointById(event.id, ownerId)
                        ?: error("事件已不存在")
                    require(current.type == TimePointType.EVENT) { "日期不能删除" }
                    val now = nowIso()
                    val placements = db.placementDao().getPlacementsByTimePoint(current.id, ownerId)
                    db.placementDao().upsertPlacements(
                        placements.map { placement ->
                            placement.copy(
                                version = placement.version + 1,
                                updatedAt = now,
                                deletedAt = now,
                                pendingSync = true,
                            )
                        },
                    )
                    db.timePointDao().upsertTimePoint(
                        current.copy(
                            version = current.version + 1,
                            updatedAt = now,
                            deletedAt = now,
                            pendingSync = true,
                        ),
                    )
                    syncEngine.recordLocalMutation(
                        command = "timePoint.delete",
                        entityId = current.id,
                        baseVersion = current.version,
                        payload = emptyMap(),
                        ownerId = ownerId,
                    )
                }
                onComplete(true)
                _messages.tryEmit("事件已删除，任务本体仍保留")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("删除事件失败"))
            }
        }
    }

    fun reorderEvents(eventIds: List<String>, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val current = db.timePointDao().getActiveEventsFlow(ownerId).first()
                    require(current.map { it.id }.toSet() == eventIds.toSet() && current.size == eventIds.size) {
                        "事件列表已变化，请刷新后重试"
                    }
                    val byId = current.associateBy { it.id }
                    val now = nowIso()
                    db.timePointDao().upsertTimePoints(
                        eventIds.mapIndexed { index, id ->
                            byId.getValue(id).copy(
                                rank = ((index + 1) * 1024L).toString(),
                                version = byId.getValue(id).version + 1,
                                updatedAt = now,
                                pendingSync = true,
                            )
                        },
                    )
                    syncEngine.recordLocalMutation(
                        command = "timePoint.reorder",
                        entityId = UUID.randomUUID().toString(),
                        baseVersion = null,
                        payload = mapOf("ids" to eventIds),
                        ownerId = ownerId,
                    )
                }
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("事件排序失败"))
            }
        }
    }

    fun addTasksToTimePoint(timePointId: String, taskIds: List<String>, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val point = db.timePointDao().getTimePointById(timePointId, ownerId)
                        ?: error("安排位置不存在")
                    val current = db.placementDao().getPlacementsByTimePoint(timePointId, ownerId)
                    val existingTaskIds = current.map { it.taskId }.toSet()
                    var nextRank = current.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L
                    val now = nowIso()
                    taskIds.distinct().forEach { taskId ->
                        if (taskId in existingTaskIds) return@forEach
                        val task = db.taskDao().getTaskById(taskId, ownerId)
                            ?: error("任务不存在或已归档")
                        require(task.archivedAt == null && task.deletedAt == null) { "任务不可安排" }
                        nextRank += 1024L
                        val placementId = UUID.randomUUID().toString()
                        db.placementDao().upsertPlacement(
                            PlacementEntity(
                                id = placementId,
                                ownerId = ownerId,
                                taskId = task.id,
                                timePointId = point.id,
                                rank = nextRank.toString(),
                                version = 1,
                                createdAt = now,
                                updatedAt = now,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "placement.create",
                            entityId = placementId,
                            baseVersion = null,
                            payload = mapOf(
                                "taskId" to task.id,
                                "timePointId" to point.id,
                                "__localId" to placementId,
                            ),
                            ownerId = ownerId,
                        )
                    }
                }
                loadTodayData()
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("加入任务失败"))
            }
        }
    }

    fun reorderPlacements(timePointId: String, placementIds: List<String>, onComplete: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val current = db.placementDao().getPlacementsByTimePoint(timePointId, ownerId)
                    require(current.map { it.id }.toSet() == placementIds.toSet() && current.size == placementIds.size) {
                        "安排列表已变化，请刷新后重试"
                    }
                    val byId = current.associateBy { it.id }
                    val now = nowIso()
                    db.placementDao().upsertPlacements(
                        placementIds.mapIndexed { index, id ->
                            byId.getValue(id).copy(
                                rank = ((index + 1) * 1024L).toString(),
                                version = byId.getValue(id).version + 1,
                                updatedAt = now,
                                pendingSync = true,
                            )
                        },
                    )
                    syncEngine.recordLocalMutation(
                        command = "placement.reorder",
                        entityId = timePointId,
                        baseVersion = null,
                        payload = mapOf("timePointId" to timePointId, "ids" to placementIds),
                        ownerId = ownerId,
                    )
                }
                loadTodayData()
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("安排排序失败"))
            }
        }
    }

    fun movePlacementToDate(
        placement: PlacementEntity,
        localDate: String,
        copy: Boolean,
        onComplete: (Boolean) -> Unit = {},
    ) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    requireValidLocalDate(localDate)
                    val point = getOrCreateDatePoint(ownerId, localDate)
                    relocatePlacement(ownerId, placement, point.id, copy)
                }
                loadTodayData()
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("移动安排失败"))
            }
        }
    }

    fun movePlacementToTimePoint(
        placement: PlacementEntity,
        timePointId: String,
        copy: Boolean,
        onComplete: (Boolean) -> Unit = {},
    ) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val point = db.timePointDao().getTimePointById(timePointId, ownerId)
                        ?: error("目标安排位置不存在")
                    relocatePlacement(ownerId, placement, point.id, copy)
                }
                loadTodayData()
                onComplete(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onComplete(false)
                _messages.tryEmit(error.userMessage("移动安排失败"))
            }
        }
    }

    private suspend fun relocatePlacement(
        ownerId: String,
        placement: PlacementEntity,
        targetTimePointId: String,
        copy: Boolean,
    ) {
        val current = db.placementDao().getById(placement.id, ownerId)
            ?: error("安排已不存在")
        require(current.deletedAt == null) { "安排已移除" }
        require(current.timePointId != targetTimePointId) { "目标位置与当前位置相同" }
        val targetPlacements = db.placementDao().getPlacementsByTimePoint(targetTimePointId, ownerId)
        val existing = targetPlacements.firstOrNull { it.taskId == current.taskId }
        if (existing != null) {
            if (!copy) {
                val now = nowIso()
                db.placementDao().upsertPlacement(
                    current.copy(
                        version = current.version + 1,
                        updatedAt = now,
                        deletedAt = now,
                        pendingSync = true,
                    ),
                )
                syncEngine.recordLocalMutation(
                    command = "placement.move",
                    entityId = current.id,
                    baseVersion = current.version,
                    payload = mapOf("timePointId" to targetTimePointId, "targetPlacementId" to existing.id),
                    ownerId = ownerId,
                )
            }
            return
        }

        val now = nowIso()
        val targetId = UUID.randomUUID().toString()
        val nextRank = ((targetPlacements.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
        db.placementDao().upsertPlacement(
            PlacementEntity(
                id = targetId,
                ownerId = ownerId,
                taskId = current.taskId,
                timePointId = targetTimePointId,
                rank = nextRank,
                version = 1,
                createdAt = now,
                updatedAt = now,
                pendingSync = true,
            ),
        )
        if (!copy) {
            db.placementDao().upsertPlacement(
                current.copy(
                    version = current.version + 1,
                    updatedAt = now,
                    deletedAt = now,
                    pendingSync = true,
                ),
            )
        }
        syncEngine.recordLocalMutation(
            command = if (copy) "placement.copy" else "placement.move",
            entityId = current.id,
            baseVersion = if (copy) null else current.version,
            payload = mapOf(
                "timePointId" to targetTimePointId,
                "targetPlacementId" to targetId,
            ),
            ownerId = ownerId,
        )
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
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("保存设置失败"))
            }
        }
    }

    fun showMessage(message: String) { _messages.tryEmit(message) }

    fun clearRolloverUndo() {
        _lastRollover.value = null
    }

    /**
     * Rollover uncompleted tasks from localDate into the following calendar date.
     * Web equivalent: POST /api/v2/dates/:localDate/rollover
     */
    fun rolloverTasks(localDate: String, onComplete: ((Int) -> Unit)? = null) {
        viewModelScope.launch {
            try {
                val timezone = settings.value?.timezone ?: "Asia/Shanghai"
                val tomorrow = shiftLocalDate(localDate, 1, timezone)
                val createdIds = mutableListOf<String>()

                db.withOwnerTransaction { ownerId ->
                    val sourcePoint = db.timePointDao().getTimePointByDate(ownerId, localDate)
                    if (sourcePoint == null) {
                        return@withOwnerTransaction
                    }
                    val targetPoint = getOrCreateDatePoint(ownerId, tomorrow)
                    val activeSourcePlacements = db.placementDao().getPlacementsByTimePoint(sourcePoint.id, ownerId)
                    val targetPlacements = db.placementDao().getPlacementsByTimePoint(targetPoint.id, ownerId)
                    val targetTaskIds = targetPlacements.map { it.taskId }.toSet()
                    var nextRank = targetPlacements.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L
                    val now = nowIso()

                    for (placement in activeSourcePlacements) {
                        val task = db.taskDao().getTaskById(placement.taskId, ownerId) ?: continue
                        if (task.status == TaskStatus.DONE || task.archivedAt != null || task.deletedAt != null) {
                            continue
                        }
                        if (task.id in targetTaskIds) {
                            continue
                        }

                        nextRank += 1024L
                        val newPlacementId = UUID.randomUUID().toString()
                        createdIds.add(newPlacementId)
                        db.placementDao().upsertPlacement(
                            PlacementEntity(
                                id = newPlacementId,
                                ownerId = ownerId,
                                taskId = task.id,
                                timePointId = targetPoint.id,
                                rank = nextRank.toString(),
                                version = 1,
                                createdAt = now,
                                updatedAt = now,
                                deletedAt = null,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "placement.create",
                            entityId = newPlacementId,
                            baseVersion = null,
                            payload = mapOf(
                                "taskId" to task.id,
                                "timePointId" to targetPoint.id,
                                "__localId" to newPlacementId,
                            ),
                            ownerId = ownerId,
                        )
                    }
                }

                if (createdIds.isNotEmpty()) {
                    _lastRollover.value = RolloverUndoState(localDate, createdIds)
                    loadTodayData()
                    _rolloverEvents.tryEmit(createdIds.size)
                    onComplete?.invoke(createdIds.size)
                } else {
                    _messages.tryEmit("今天没有未完成的待办任务")
                    onComplete?.invoke(0)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("顺延任务失败"))
                onComplete?.invoke(0)
            }
        }
    }

    /**
     * Undo previous rollover mutation by removing the created placement records.
     * Web equivalent: POST /api/v2/rollovers/undo
     */
    fun undoLastRollover(onComplete: ((Boolean) -> Unit)? = null) {
        val last = _lastRollover.value ?: return
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    val now = nowIso()
                    for (placementId in last.createdPlacementIds) {
                        val placement = db.placementDao().getById(placementId, ownerId) ?: continue
                        db.placementDao().upsertPlacement(
                            placement.copy(
                                version = placement.version + 1,
                                updatedAt = now,
                                deletedAt = now,
                                pendingSync = true,
                            ),
                        )
                        syncEngine.recordLocalMutation(
                            command = "placement.remove",
                            entityId = placement.id,
                            baseVersion = placement.version,
                            payload = emptyMap(),
                            ownerId = ownerId,
                        )
                    }
                }
                _lastRollover.value = null
                loadTodayData()
                _messages.tryEmit("已撤销顺延操作")
                onComplete?.invoke(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("撤销失败"))
                onComplete?.invoke(false)
            }
        }
    }

    /**
     * Resolves an offline/sync conflict with a given strategy:
     * - "server": accept server version and drop local mutation
     * - "local": keep local payload and retry against updated server version
     * - "merged": apply merged text/JSON payload and retry
     * - "discard": drop local optimistic changes and mark resolved
     */
    fun resolveConflict(
        conflict: ConflictEntity,
        strategy: String,
        mergedPayloadJson: String? = null,
        onComplete: ((Boolean) -> Unit)? = null,
    ) {
        viewModelScope.launch {
            try {
                db.withOwnerTransaction { ownerId ->
                    require(conflict.ownerId == ownerId) { "冲突不属于当前账户" }
                    val currentConflict = db.conflictDao().getById(conflict.id, ownerId)
                        ?: error("冲突记录已不存在或已解决")
                    val outboxItem = db.outboxDao().getByMutationId(currentConflict.mutationId, ownerId)

                    val now = nowIso()
                    val serverElement = try {
                        val root = api.json.parseToJsonElement(currentConflict.serverJson)
                        if (root is JsonObject && root["server"] is JsonObject) root["server"]!! else root
                    } catch (_: Exception) {
                        JsonNull
                    }

                    when (strategy) {
                        "server" -> {
                            if (outboxItem != null) {
                                db.outboxDao().deleteByMutationId(outboxItem.mutationId, ownerId)
                            }
                            db.conflictDao().markResolved(currentConflict.id, ownerId, now)
                            // Re-sync entity from server by dropping cursor so next pull will restore authority
                            db.syncMetaDao().remove(SyncEngine.v2SyncCursorKey(ownerId))
                        }
                        "discard" -> {
                            if (outboxItem != null) {
                                syncEngine.discardLocalMutation(outboxItem)
                            } else {
                                db.conflictDao().markResolved(currentConflict.id, ownerId, now)
                            }
                        }
                        "local", "merged" -> {
                            val serverObj = serverElement as? JsonObject
                            val serverVersion = serverObj?.get("version")?.jsonPrimitive?.longOrNull
                                ?: (outboxItem?.baseVersion ?: 1L) + 1L

                            val nextPayloadJson = if (strategy == "merged" && !mergedPayloadJson.isNullOrBlank()) {
                                mergedPayloadJson
                            } else {
                                currentConflict.localJson
                            }

                            if (outboxItem != null) {
                                db.outboxDao().deleteByMutationId(outboxItem.mutationId, ownerId)
                            }

                            val newMutationId = UUID.randomUUID().toString()
                            val nextOutbox = OutboxEntity(
                                mutationId = newMutationId,
                                clientId = authManager.clientId,
                                ownerId = ownerId,
                                command = currentConflict.command ?: "task.update",
                                entityId = currentConflict.entityId,
                                baseVersion = serverVersion,
                                occurredAt = now,
                                payloadJson = nextPayloadJson,
                                attempts = 0,
                                nextAttemptAt = System.currentTimeMillis(),
                                lastError = null,
                            )
                            db.outboxDao().insert(nextOutbox)
                            db.conflictDao().markResolved(currentConflict.id, ownerId, now)
                        }
                        else -> error("未知冲突解决策略: $strategy")
                    }
                }
                syncEngine.triggerSync()
                _messages.tryEmit("已解决冲突并触发同步")
                onComplete?.invoke(true)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _messages.tryEmit(error.userMessage("冲突解决失败"))
                onComplete?.invoke(false)
            }
        }
    }

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
                val page = activePageKey
                val outcome = withTimeoutOrNull(15_000L) {
                    if (page?.startsWith("directory:") == true) {
                        syncEngine.refreshDirectoryPage(page.removePrefix("directory:").takeUnless { it == "root" })
                    } else {
                        page?.let { syncEngine.prioritizePage(it, force = true) }
                        syncEngine.triggerSync()
                    }
                }
                when (outcome) {
                    null -> _messages.tryEmit("刷新仍在后台继续，已保留当前内容")
                    SyncOutcome.Continuing -> Unit
                    SyncOutcome.Success -> {
                        loadTodayData()
                        WidgetUpdater.refreshAll(authManager.appContext)
                    }
                    is SyncOutcome.Failure -> _messages.tryEmit("同步失败：${outcome.message}")
                }
            } catch (cancelled: CancellationException) { throw cancelled
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
                    SyncOutcome.Continuing -> Unit
                    SyncOutcome.Success -> {
                        loadTodayData()
                        WidgetUpdater.refreshAll(authManager.appContext)
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
        bindAccount()
        syncEngine.setNetworkAvailable(true)
        _authenticated.value = true
        _dataReady.value = false
        loadTodayData()
        syncEngine.start()
        WidgetUpdater.refreshAll(authManager.appContext)
        viewModelScope.launch {
            WidgetPreviewPublisher.publishIfDue(authManager.appContext)
        }
        syncNow()
    }

    fun onLoggedOut() {
        sessionRestoreJob?.cancel()
        sessionRestoreJob = null
        syncEngine.stop()
        _authenticated.value = false
        ownerIdentity.value = null
        todayLoadJob?.cancel()
        midnightRefreshJob?.cancel()
        _todayTasks.value = emptyList()
        _dataReady.value = true
        clearPageCaches()
        WidgetUpdater.refreshAll(authManager.appContext)
    }

    fun observeTask(taskId: String): Flow<TaskEntity?> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.taskDao().getTaskByIdFlow(taskId, it) } ?: flowOf(null)
    }.onEach { task ->
        val key = cacheKey("task:$taskId")
        if (task == null) taskDetailCache.remove(key) else taskDetailCache.putBounded(key, task)
    }

    fun cachedTask(taskId: String): TaskEntity? =
        taskDetailCache[cacheKey("task:$taskId")] ?: treeTasksV2.value.firstOrNull { it.id == taskId }

    fun observeTaskById(taskId: String): Flow<TaskEntity?> = observeTask(taskId)

    fun observeNote(taskId: String): Flow<NoteEntity?> = currentOwnerId.flatMapLatest { ownerId ->
        ownerId?.let { db.noteDao().getNoteByTaskIdFlow(taskId, it) } ?: flowOf(null)
    }.onEach { note ->
        val key = cacheKey("note:$taskId")
        if (note == null) noteCache.remove(key) else noteCache.putBounded(key, note)
    }

    fun cachedNote(taskId: String): NoteEntity? = noteCache[cacheKey("note:$taskId")]

    fun loadTaskDetails(taskId: String) {
        activatePage("task:$taskId")
    }
    fun onAppBackground() {
        foreground = false
        syncEngine.setForeground(false)
    }

    fun activatePage(key: String) {
        activePageKey = key
        syncEngine.prioritizePage(key)
    }

    fun retryCurrentPage() {
        activePageKey?.let { syncEngine.prioritizePage(it, force = true) }
        onAppForeground()
        pullRefresh()
    }
    fun prioritizeDirectory(folderId: String?) { activatePage("directory:${folderId ?: "root"}") }
    fun loadMoreDirectory(folderId: String?) {
        viewModelScope.launch { syncEngine.loadDirectoryPage(folderId, append = true) }
    }
    fun exportLegacyCache(destination: android.net.Uri) {
        viewModelScope.launch {
            try { authManager.exportLegacyCache(destination); _messages.tryEmit("旧缓存与离线队列已导出；请妥善保管个人数据") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { _messages.tryEmit(error.message ?: "旧缓存导出失败，原数据库仍保留") }
        }
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
                require(existingNote != null || markdownContent.isBlank()) { "备注尚未加载，请连接中枢后重试" }
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
                        // A task always has a server-side note at version 1;
                        // use that version when this is the first local note
                        // edit rather than sending a null baseVersion.
                        baseVersion = existingNote?.version ?: 1,
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
        WidgetUpdater.refreshAll(authManager.appContext)
    }

    fun setDynamicColor(enabled: Boolean) {
        authManager.dynamicColor = enabled
        _dynamicColor.value = enabled
        WidgetUpdater.refreshAll(authManager.appContext)
    }

    fun setPureBlack(enabled: Boolean) {
        authManager.pureBlack = enabled
        _pureBlack.value = enabled
        WidgetUpdater.refreshAll(authManager.appContext)
    }

    private suspend fun getOrCreateDatePoint(ownerId: String, localDate: String): TimePointEntity {
        return db.withTransaction { db.timePointDao().getTimePointByDate(ownerId, localDate) ?: run {
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
        } }
    }

    private fun readThemeMode(): ThemeMode = ThemeMode.values()
        .firstOrNull { it.name == authManager.themeMode }
        ?: ThemeMode.SYSTEM

    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())

    private fun requireValidLocalDate(localDate: String) {
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { isLenient = false }
        val parsed = parser.parse(localDate)
        require(parsed != null && parser.format(parsed) == localDate) { "日期无效" }
    }

    private suspend fun <T> AppDatabase.withOwnerTransaction(block: suspend (String) -> T): T =
        withTransaction {
            val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
            val result = block(ownerId)
            require(authManager.ownerId == ownerId) { "当前账户已变化" }
            result
        }

    private suspend fun <T> AppDatabase.withTransaction(block: suspend () -> T): T {
        val session = authManager.sessionKey
        val selected = this
        val selectedEngine = syncEngine
        return withContext(transactionDatabase.asContextElement(selected) + transactionEngine.asContextElement(selectedEngine)) {
            selected.roomTransaction {
                require(selected === activeDatabase && authManager.sessionKey == session) { "账户或中枢已变化" }
                val result = block()
                require(selected === activeDatabase && authManager.sessionKey == session) { "账户或中枢已变化" }
                result
            }
        }
    }

    private fun Throwable.userMessage(prefix: String): String {
        val detail = message?.takeIf { it.isNotBlank() }
        return if (detail == null) prefix else "$prefix：$detail"
    }

    override fun onCleared() {
        super.onCleared()
        appUpdateManager.close()
        todayLoadJob?.cancel()
        midnightRefreshJob?.cancel()
        syncEngine.stop()
    }
}

class MainViewModelFactory(private val context: Context) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        val auth = SecureAuthManager(context)
        val db = auth.scopedDatabase()
        val api = ApiClient(auth)
        val syncEngine = SyncEngine(db, api, auth)
        @Suppress("UNCHECKED_CAST")
        return MainViewModel(db, syncEngine, auth, api, isolateAccounts = true) as T
    }
}
