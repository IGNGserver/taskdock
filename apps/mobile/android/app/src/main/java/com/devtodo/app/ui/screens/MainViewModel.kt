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
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

class MainViewModel(
    private val db: AppDatabase,
    private val syncEngine: SyncEngine,
    val authManager: SecureAuthManager,
    val api: ApiClient
) : ViewModel() {

    val syncState: StateFlow<SyncState> = syncEngine.syncState
    val projects: StateFlow<List<ProjectEntity>> = db.projectDao().getAllProjectsFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val allTasks: StateFlow<List<TaskEntity>> = db.taskDao().getAllTasksFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val inboxTasks: StateFlow<List<TaskEntity>> = db.taskDao().getInboxTasksFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val activeEvents: StateFlow<List<TimePointEntity>> = db.timePointDao().getActiveEventsFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _todayTasks = MutableStateFlow<List<Pair<TaskEntity, PlacementEntity>>>(emptyList())
    val todayTasks: StateFlow<List<Pair<TaskEntity, PlacementEntity>>> = _todayTasks.asStateFlow()

    private val todayStr: String
        get() = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())

    init {
        loadTodayData()
        syncEngine.start()
    }

    fun loadTodayData() {
        viewModelScope.launch {
            val datePoint = db.timePointDao().getTimePointByDate(todayStr) ?: run {
                val newPoint = TimePointEntity(
                    id = UUID.randomUUID().toString(),
                    ownerId = authManager.ownerId ?: "",
                    type = TimePointType.DATE,
                    localDate = todayStr,
                    title = null,
                    rank = "1000",
                    version = 1,
                    reachedAt = null,
                    archivedAt = null,
                    createdAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date()),
                    updatedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())
                )
                db.timePointDao().upsertTimePoint(newPoint)
                newPoint
            }

            db.placementDao().getPlacementsByTimePointFlow(datePoint.id).collect { placements ->
                val list = mutableListOf<Pair<TaskEntity, PlacementEntity>>()
                for (pl in placements) {
                    val task = db.taskDao().getTaskById(pl.taskId)
                    if (task != null && task.archivedAt == null) {
                        list.add(task to pl)
                    }
                }
                _todayTasks.value = list
            }
        }
    }

    fun updateTaskStatus(task: TaskEntity, nextStatus: TaskStatus) {
        viewModelScope.launch {
            val updated = task.copy(status = nextStatus, version = task.version + 1)
            db.taskDao().upsertTask(updated)
            syncEngine.recordLocalMutation(
                command = "task.update",
                entityId = task.id,
                baseVersion = task.version,
                payload = mapOf("status" to nextStatus.name)
            )
            loadTodayData()
        }
    }

    fun createTask(title: String, projectId: String?, scheduleToday: Boolean) {
        viewModelScope.launch {
            val taskId = UUID.randomUUID().toString()
            val now = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())
            val category = if (projectId == null) TaskCategory.MISC else TaskCategory.FEATURE
            val task = TaskEntity(
                id = taskId,
                ownerId = authManager.ownerId ?: "",
                projectId = projectId,
                referenceId = null,
                title = title,
                status = TaskStatus.TODO,
                category = category,
                priority = TaskPriority.NONE,
                rank = "1000",
                version = 1,
                archivedAt = null,
                createdAt = now,
                updatedAt = now
            )
            db.taskDao().upsertTask(task)
            syncEngine.recordLocalMutation(
                command = "task.create",
                entityId = taskId,
                baseVersion = null,
                payload = mapOf(
                    "title" to title,
                    "category" to category.name,
                    "projectId" to projectId
                )
            )

            if (scheduleToday) {
                val datePoint = db.timePointDao().getTimePointByDate(todayStr) ?: return@launch
                val placementId = UUID.randomUUID().toString()
                val placement = PlacementEntity(
                    id = placementId,
                    ownerId = authManager.ownerId ?: "",
                    taskId = taskId,
                    timePointId = datePoint.id,
                    rank = "1000",
                    version = 1,
                    createdAt = now,
                    updatedAt = now
                )
                db.placementDao().upsertPlacement(placement)
                syncEngine.recordLocalMutation(
                    command = "placement.create",
                    entityId = placementId,
                    baseVersion = null,
                    payload = mapOf("taskId" to taskId, "timePointId" to datePoint.id)
                )
                loadTodayData()
            }
        }
    }

    fun syncNow() {
        viewModelScope.launch {
            syncEngine.triggerSync()
            loadTodayData()
        }
    }

    override fun onCleared() {
        super.onCleared()
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
