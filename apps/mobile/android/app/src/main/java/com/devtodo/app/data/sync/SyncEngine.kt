package com.devtodo.app.data.sync

import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.text.SimpleDateFormat
import java.util.*

enum class SyncState {
    IDLE, SYNCING, OFFLINE, ERROR
}

class SyncEngine(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val authManager: SecureAuthManager
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _syncState = MutableStateFlow(SyncState.IDLE)
    val syncState: StateFlow<SyncState> = _syncState.asStateFlow()

    private val _lastSyncError = MutableStateFlow<String?>(null)
    val lastSyncError: StateFlow<String?> = _lastSyncError.asStateFlow()

    private var activeWebSocket: WebSocket? = null

    companion object {
        private const val SYNC_CURSOR_KEY = "sync_cursor"
    }

    private val isoFormat: SimpleDateFormat
        get() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun start() {
        connectWebSocket()
        scope.launch {
            triggerSync()
        }
    }

    fun stop() {
        activeWebSocket?.close(1000, "App closed")
        activeWebSocket = null
    }

    private fun connectWebSocket() {
        if (!authManager.isLoggedIn) return
        try {
            activeWebSocket = api.createWebSocket(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val element = api.json.parseToJsonElement(text).jsonObject
                        if (element["type"]?.jsonPrimitive?.content == "sync.required") {
                            scope.launch { triggerSync() }
                        }
                    } catch (_: Exception) {}
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    scope.launch {
                        delay(15_000)
                        connectWebSocket()
                    }
                }
            })
        } catch (_: Exception) {}
    }

    suspend fun triggerSync() = withContext(Dispatchers.IO) {
        if (!authManager.isLoggedIn) return@withContext
        if (_syncState.value == SyncState.SYNCING) return@withContext
        _syncState.value = SyncState.SYNCING
        _lastSyncError.value = null

        try {
            var cursor = db.syncMetaDao().get(SYNC_CURSOR_KEY)
            if (cursor == null) {
                val snapshotRes = api.getSnapshot()
                if (snapshotRes.isSuccess) {
                    val snap = snapshotRes.getOrThrow()
                    applySnapshot(snap)
                    cursor = snap.cursor
                    db.syncMetaDao().set(SyncMetaEntity(SYNC_CURSOR_KEY, cursor))
                } else {
                    throw snapshotRes.exceptionOrNull() ?: Exception("Failed to fetch snapshot")
                }
            }

            val pending = db.outboxDao().getPendingItems()
            if (pending.isNotEmpty()) {
                val mutations = pending.map { out ->
                    Mutation(
                        mutationId = out.mutationId,
                        command = out.command,
                        entityId = out.entityId,
                        baseVersion = out.baseVersion,
                        occurredAt = out.occurredAt,
                        payload = api.json.decodeFromString(out.payloadJson)
                    )
                }
                val pushRes = api.pushSync(mutations)
                if (pushRes.isSuccess) {
                    val results = pushRes.getOrThrow().results
                    for (res in results) {
                        if (res.status == "applied") {
                            db.outboxDao().deleteByMutationId(res.mutationId)
                        } else if (res.status == "conflict") {
                            db.outboxDao().deleteByMutationId(res.mutationId)
                            val original = pending.find { it.mutationId == res.mutationId }
                            db.conflictDao().insert(
                                ConflictEntity(
                                    mutationId = res.mutationId,
                                    command = original?.command,
                                    entityType = original?.command?.split(".")?.getOrNull(0) ?: "unknown",
                                    entityId = original?.entityId ?: "",
                                    localJson = original?.payloadJson ?: "{}",
                                    serverJson = res.serverEntity?.toString() ?: "{}",
                                    createdAt = isoFormat.format(Date())
                                )
                            )
                        } else {
                            db.outboxDao().deleteByMutationId(res.mutationId)
                        }
                    }
                }
            }

            var currentCursor = db.syncMetaDao().get(SYNC_CURSOR_KEY) ?: "0"
            var hasMore = true
            while (hasMore) {
                val pullRes = api.pullSync(currentCursor, 100)
                if (pullRes.isSuccess) {
                    val result = pullRes.getOrThrow()
                    applyChanges(result.changes)
                    currentCursor = result.cursor
                    db.syncMetaDao().set(SyncMetaEntity(SYNC_CURSOR_KEY, currentCursor))
                    hasMore = result.hasMore
                } else {
                    hasMore = false
                }
            }

            _syncState.value = SyncState.IDLE
        } catch (e: Exception) {
            _syncState.value = SyncState.ERROR
            _lastSyncError.value = e.message
        }
    }

    private suspend fun applySnapshot(snap: SnapshotResult) {
        db.projectDao().upsertProjects(snap.projects.map { p ->
            ProjectEntity(p.id, p.ownerId, p.name, p.slug, p.description, p.rank, p.version, p.archivedAt, p.createdAt, p.updatedAt)
        })
        db.taskDao().upsertTasks(snap.tasks.map { t ->
            TaskEntity(t.id, t.ownerId, t.projectId, t.referenceId, t.title, t.status, t.category, t.priority, t.rank, t.version, t.archivedAt, t.createdAt, t.updatedAt)
        })
        db.noteDao().upsertNotes(snap.notes.map { n ->
            NoteEntity(n.id, n.ownerId, n.taskId, n.contentMarkdown, n.version, n.createdAt, n.updatedAt)
        })
        db.timePointDao().upsertTimePoints(snap.timePoints.map { tp ->
            TimePointEntity(tp.id, tp.ownerId, tp.type, tp.localDate, tp.title, tp.rank, tp.version, tp.reachedAt, tp.archivedAt, tp.createdAt, tp.updatedAt)
        })
        db.placementDao().upsertPlacements(snap.placements.map { pl ->
            PlacementEntity(pl.id, pl.ownerId, pl.taskId, pl.timePointId, pl.rank, pl.version, pl.createdAt, pl.updatedAt)
        })
        snap.settings?.let { s ->
            db.settingsDao().upsertSettings(SettingsEntity(s.ownerId, s.timezone, s.defaultCaptureTarget, s.recentProjectId, s.createdAt, s.updatedAt))
        }
    }

    private suspend fun applyChanges(changes: List<ChangeItem>) {
        for (c in changes) {
            when (c.entityType) {
                "task" -> {
                    if (c.operation == "delete") db.taskDao().deleteTask(c.entityId)
                    else c.snapshot?.let {
                        val task = api.json.decodeFromJsonElement<TaskDto>(it)
                        db.taskDao().upsertTask(TaskEntity(task.id, task.ownerId, task.projectId, task.referenceId, task.title, task.status, task.category, task.priority, task.rank, task.version, task.archivedAt, task.createdAt, task.updatedAt))
                    }
                }
                "placement" -> {
                    if (c.operation == "delete") db.placementDao().deletePlacement(c.entityId)
                    else c.snapshot?.let {
                        val pl = api.json.decodeFromJsonElement<PlacementDto>(it)
                        db.placementDao().upsertPlacement(PlacementEntity(pl.id, pl.ownerId, pl.taskId, pl.timePointId, pl.rank, pl.version, pl.createdAt, pl.updatedAt))
                    }
                }
                "note" -> {
                    if (c.operation == "delete") db.noteDao().deleteNoteByTaskId(c.entityId)
                    else c.snapshot?.let {
                        val n = api.json.decodeFromJsonElement<NoteDto>(it)
                        db.noteDao().upsertNote(NoteEntity(n.id, n.ownerId, n.taskId, n.contentMarkdown, n.version, n.createdAt, n.updatedAt))
                    }
                }
                "project" -> {
                    if (c.operation == "delete") db.projectDao().deleteProject(c.entityId)
                    else c.snapshot?.let {
                        val p = api.json.decodeFromJsonElement<ProjectDto>(it)
                        db.projectDao().upsertProject(ProjectEntity(p.id, p.ownerId, p.name, p.slug, p.description, p.rank, p.version, p.archivedAt, p.createdAt, p.updatedAt))
                    }
                }
            }
        }
    }

    suspend fun recordLocalMutation(
        command: String,
        entityId: String,
        baseVersion: Long?,
        payload: Map<String, Any?>
    ) {
        val jsonPayload = api.json.encodeToString(payload.mapValues { (_, v) ->
            when (v) {
                null -> JsonNull
                is String -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                else -> JsonPrimitive(v.toString())
            }
        })
        val item = OutboxEntity(
            mutationId = UUID.randomUUID().toString(),
            clientId = authManager.clientId,
            command = command,
            entityId = entityId,
            baseVersion = baseVersion,
            occurredAt = isoFormat.format(Date()),
            payloadJson = jsonPayload
        )
        db.outboxDao().insert(item)
        scope.launch { triggerSync() }
    }
}
