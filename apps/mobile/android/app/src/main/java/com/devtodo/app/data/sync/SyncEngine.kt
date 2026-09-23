package com.devtodo.app.data.sync

import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.remote.ApiClientException
import com.devtodo.app.data.remote.ApiFailureCategory
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ThreadLocalRandom

enum class SyncState {
    IDLE, SYNCING, OFFLINE, AUTH_REQUIRED, INCOMPATIBLE, SERVER_UNAVAILABLE, ERROR
}

sealed interface SyncOutcome {
    data object Success : SyncOutcome
    data class Failure(val message: String) : SyncOutcome
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
    private val syncMutex = Mutex()

    private val socketLock = Any()
    @Volatile private var activeWebSocket: WebSocket? = null
    @Volatile private var started = false
    @Volatile private var networkAvailable = true
    private var socketGeneration = 0L
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null

    companion object {
        private const val SYNC_CURSOR_KEY = "sync_cursor"
    }

    private fun syncCursorKey(ownerId: String): String = "$SYNC_CURSOR_KEY:$ownerId"
    private fun v2SyncCursorKey(ownerId: String): String = "v2:$SYNC_CURSOR_KEY:$ownerId"

    private val isoFormat: SimpleDateFormat
        get() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun start() {
        val alreadyStarted = synchronized(socketLock) {
            if (started) true
            else {
                started = true
                reconnectAttempt = 0
                false
            }
        }
        if (alreadyStarted) {
            if (networkAvailable) scope.launch { triggerSync() }
            return
        }
        connectWebSocket()
        scope.launch {
            triggerSync()
        }
    }

    fun stop() {
        val socket = synchronized(socketLock) {
            started = false
            reconnectJob?.cancel()
            reconnectJob = null
            reconnectAttempt = 0
            val current = activeWebSocket
            activeWebSocket = null
            current
        }
        // Stop cancels every in-flight sync, refresh, and reconnect child as
        // well as the socket. The parent scope stays reusable when the app
        // logs out/in again, while no old engine generation can continue to
        // mutate the database after stop.
        scope.coroutineContext.cancelChildren()
        socket?.close(1000, "App closed")
        _syncState.value = SyncState.IDLE
    }

    fun setNetworkAvailable(available: Boolean) {
        val socketToCancel = synchronized(socketLock) {
            networkAvailable = available
            if (!available) {
                reconnectJob?.cancel()
                reconnectJob = null
                val current = activeWebSocket
                activeWebSocket = null
                current
            } else {
                reconnectJob?.cancel()
                reconnectJob = null
                reconnectAttempt = 0
                null
            }
        }
        if (!available) {
            socketToCancel?.cancel()
            if (started) _syncState.value = SyncState.OFFLINE
            return
        }
        if (started) {
            _syncState.value = SyncState.IDLE
            connectWebSocket()
            scope.launch { triggerSync() }
        }
    }

    private fun connectWebSocket() {
        if (!started || !networkAvailable || !authManager.isLoggedIn) return
        val generation: Long
        synchronized(socketLock) {
            if (!started || !networkAvailable || activeWebSocket != null) return
            generation = ++socketGeneration
        }
        try {
            val socket = api.createV2WebSocket(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (isCurrentSocket(webSocket, generation)) {
                        synchronized(socketLock) { reconnectAttempt = 0 }
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val element = api.json.parseToJsonElement(text).jsonObject
                        if (element["type"]?.jsonPrimitive?.content == "sync.required") {
                            scope.launch { triggerSync() }
                        }
                    } catch (_: Exception) {}
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    handleWebSocketEnd(webSocket, generation)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handleWebSocketEnd(webSocket, generation)
                }
            })
            synchronized(socketLock) {
                if (started && networkAvailable && activeWebSocket == null) {
                    activeWebSocket = socket
                } else {
                    socket.cancel()
                }
            }
        } catch (_: Exception) {
            scheduleReconnect()
        }
    }

    private fun isCurrentSocket(socket: WebSocket, generation: Long): Boolean = synchronized(socketLock) {
        activeWebSocket === socket && socketGeneration == generation
    }

    private fun handleWebSocketEnd(socket: WebSocket, generation: Long) {
        val shouldReconnect = synchronized(socketLock) {
            if (activeWebSocket !== socket || socketGeneration != generation) return@synchronized false
            activeWebSocket = null
            started && networkAvailable && authManager.isLoggedIn
        }
        if (shouldReconnect) {
            scope.launch {
                // Refresh an expired short-lived access token before opening
                // the next first-message-authenticated WebSocket.
                api.restoreSession()
                scheduleReconnect()
            }
        }
    }

    private fun scheduleReconnect() {
        synchronized(socketLock) {
            if (!started || !networkAvailable || !authManager.isLoggedIn || reconnectJob?.isActive == true)
                return
            val attempt = reconnectAttempt.coerceAtMost(6)
            reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(7)
            val backoffMs = (1_000L shl attempt).coerceAtMost(60_000L)
            val jitterMs = ThreadLocalRandom.current().nextLong(0L, 1_001L)
            reconnectJob = scope.launch {
                delay(backoffMs + jitterMs)
                synchronized(socketLock) { reconnectJob = null }
                if (started && networkAvailable && authManager.isLoggedIn) connectWebSocket()
            }
        }
    }

    private suspend fun triggerV1Sync() = withContext(Dispatchers.IO) {
        if (!authManager.isLoggedIn) return@withContext
        val ownerId = authManager.ownerId ?: return@withContext
        if (_syncState.value == SyncState.SYNCING) return@withContext
        _syncState.value = SyncState.SYNCING
        _lastSyncError.value = null

        try {
            val cursorKey = v2SyncCursorKey(ownerId)
            var cursor = db.syncMetaDao().get(cursorKey)
            if (cursor == null) {
                val snapshotRes = api.getSnapshot()
                if (snapshotRes.isSuccess) {
                    val snap = snapshotRes.getOrThrow()
                    applySnapshot(snap, ownerId)
                    cursor = snap.cursor
                    db.syncMetaDao().set(SyncMetaEntity(cursorKey, cursor))
                } else {
                    throw snapshotRes.exceptionOrNull() ?: Exception("Failed to fetch snapshot")
                }
            }

            val pending = db.outboxDao().getPendingItems(ownerId)
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
                if (pushRes.isFailure) {
                    throw pushRes.exceptionOrNull() ?: IOException("Push sync failed")
                }
                val results = pushRes.getOrThrow().results
                for (res in results) {
                    if (res.status == "applied") {
                        db.outboxDao().deleteByMutationId(res.mutationId, ownerId)
                    } else if (res.status == "conflict") {
                        db.outboxDao().deleteByMutationId(res.mutationId, ownerId)
                        val original = pending.find { it.mutationId == res.mutationId }
                        db.conflictDao().insert(
                            ConflictEntity(
                                mutationId = res.mutationId,
                                ownerId = ownerId,
                                command = original?.command,
                                entityType = original?.command?.split(".")?.getOrNull(0) ?: "unknown",
                                entityId = original?.entityId ?: "",
                                localJson = original?.payloadJson ?: "{}",
                                serverJson = res.result?.toString() ?: "{}",
                                createdAt = isoFormat.format(Date())
                            )
                        )
                    } else {
                        db.outboxDao().deleteByMutationId(res.mutationId, ownerId)
                    }
                }
            }

            var currentCursor = db.syncMetaDao().get(cursorKey) ?: "0"
            var hasMore = true
            while (hasMore) {
                val pullRes = api.pullSync(currentCursor, 100)
                if (pullRes.isSuccess) {
                    val result = pullRes.getOrThrow()
                    applyChanges(result.changes, ownerId)
                    currentCursor = result.cursor
                    db.syncMetaDao().set(SyncMetaEntity(cursorKey, currentCursor))
                    hasMore = result.hasMore
                } else {
                    throw pullRes.exceptionOrNull() ?: IOException("Pull sync failed")
                }
            }

            _syncState.value = SyncState.IDLE
        } catch (e: Exception) {
            _syncState.value = classifyError(e)
            _lastSyncError.value = e.message
        }
    }

    suspend fun triggerSync(): SyncOutcome = syncMutex.withLock {
        withContext(Dispatchers.IO) {
            if (!authManager.isLoggedIn) {
                val message = "登录已失效，请重新登录"
                _syncState.value = SyncState.AUTH_REQUIRED
                _lastSyncError.value = message
                return@withContext SyncOutcome.Failure(message)
            }
            val ownerId = authManager.ownerId
            if (ownerId.isNullOrBlank()) {
                val message = "账户信息不可用，请重新登录"
                _syncState.value = SyncState.AUTH_REQUIRED
                _lastSyncError.value = message
                return@withContext SyncOutcome.Failure(message)
            }
            if (!networkAvailable) {
                val message = "当前处于离线状态，请检查网络后重试"
                _syncState.value = SyncState.OFFLINE
                _lastSyncError.value = message
                return@withContext SyncOutcome.Failure(message)
            }
            _syncState.value = SyncState.SYNCING
            _lastSyncError.value = null
            try {
                val cursorKey = v2SyncCursorKey(ownerId)
                var cursor = db.syncMetaDao().get(cursorKey)
                if (cursor == null) {
                    val snapshot = api.getSnapshotV2().getOrThrow()
                    applyV2Snapshot(snapshot, ownerId)
                    cursor = snapshot.cursor
                    db.syncMetaDao().set(SyncMetaEntity(cursorKey, cursor))
                }

                val pending = db.outboxDao().getPendingItems(ownerId)
                val converted = buildList {
                    for (item in pending) {
                        if (item.lastError?.startsWith("CLIENT_UPGRADE_REQUIRED") == true) continue
                        val archiveOperationId = pending
                            .firstOrNull { it.command == "project.archive" && it.entityId == item.entityId }
                            ?.mutationId
                        convertV1Outbox(item, archiveOperationId)?.let(::add)
                    }
                }
                if (converted.isNotEmpty()) {
                    val push = api.pushSyncV2(converted.map { it.mutation }).getOrThrow()
                    for (result in push.results) {
                        val original = converted.firstOrNull { it.mutation.mutationId == result.mutationId }?.source
                        if (original == null) continue
                        if (result.status == "applied") {
                            db.outboxDao().deleteByMutationId(result.mutationId, ownerId)
                            // The optimistic row is now authoritative on the server,
                            // so drop its pending flag. Without this the row stays
                            // pendingSync=1 forever and clearNonPending can never
                            // reconcile it away during a snapshot resync.
                            markEntitySynced(ownerId, original)
                        } else if (result.status == "conflict") {
                            db.outboxDao().recordAttempt(original.id, ownerId, Long.MAX_VALUE, result.error?.toString() ?: result.message ?: "VERSION_CONFLICT")
                            db.conflictDao().insert(
                                ConflictEntity(
                                    mutationId = original.mutationId,
                                    ownerId = ownerId,
                                    command = original.command,
                                    entityType = original.command.substringBefore('.'),
                                    entityId = original.entityId,
                                    localJson = original.payloadJson,
                                    serverJson = result.error?.toString() ?: "{}",
                                    createdAt = isoFormat.format(Date()),
                                ),
                            )
                        } else {
                            val error = result.error?.toString() ?: result.message ?: "v2 mutation 未应用"
                            db.outboxDao().recordAttempt(original.id, ownerId, Long.MAX_VALUE, error)
                        }
                    }
                }

                var currentCursor = db.syncMetaDao().get(cursorKey) ?: "0"
                var hasMore = true
                var resynced = false
                while (hasMore) {
                    val result = try {
                        api.pullSyncV2(currentCursor, 100).getOrThrow()
                    } catch (error: ApiClientException) {
                        // The server dropped changes older than our cursor. Rebuild
                        // from an authoritative snapshot instead of silently
                        // skipping data, then replay the still-pending outbox.
                        if (error.category != ApiFailureCategory.CURSOR_EXPIRED || resynced) throw error
                        val snapshot = api.getSnapshotV2().getOrThrow()
                        applyV2Snapshot(snapshot, ownerId)
                        currentCursor = snapshot.cursor
                        db.syncMetaDao().set(SyncMetaEntity(cursorKey, currentCursor))
                        resynced = true
                        continue
                    }
                    applyV2Changes(result.changes, ownerId)
                    currentCursor = result.cursor
                    db.syncMetaDao().set(SyncMetaEntity(cursorKey, currentCursor))
                    hasMore = result.hasMore
                }
                _syncState.value = SyncState.IDLE
                SyncOutcome.Success
            } catch (error: Exception) {
                _syncState.value = classifyError(error)
                val message = error.message?.takeIf { it.isNotBlank() } ?: "同步失败，请稍后重试"
                _lastSyncError.value = message
                SyncOutcome.Failure(message)
            }
        }
    }

    /**
     * Clear the optimistic `pendingSync` flag for the entity an applied mutation
     * targeted, so a later snapshot resync can reconcile it like any server row.
     * Commands that only produce derived state (reorder, membership moves and
     * deletes) are intentionally skipped: their affected rows are covered by the
     * following pull changes.
     */
    private suspend fun markEntitySynced(ownerId: String, item: OutboxEntity) {
        val entityId = item.entityId
        when (item.command) {
            "folder.create", "folder.update", "folder.archiveTree", "folder.restoreTree" ->
                db.folderDao().markSynced(ownerId, entityId)
            "task.create", "task.update", "task.archive", "task.restore", "task.duplicate" ->
                db.taskDao().markSynced(ownerId, entityId)
            "note.update" -> db.noteDao().markSynced(ownerId, entityId)
            "taskStep.create", "taskStep.update", "taskStep.move" ->
                db.taskStepDao().markSynced(ownerId, entityId)
            "timePoint.date.create", "timePoint.event.create", "timePoint.update",
            "timePoint.reach", "timePoint.archive", "timePoint.restore" ->
                db.timePointDao().markSynced(ownerId, entityId)
            "placement.create", "placement.move", "placement.copy" ->
                db.placementDao().markSynced(ownerId, entityId)
            "workflow.create", "workflow.update", "workflow.archive", "workflow.restore" ->
                db.workflowDao().markSynced(ownerId, entityId)
            "workflowStage.create", "workflowStage.update", "workflowStage.move" ->
                db.workflowDao().markStageSynced(ownerId, entityId)
            "workflowTask.add", "workflowTask.move" ->
                db.workflowDao().markMembershipSynced(ownerId, entityId)
            else -> Unit
        }
    }

    private fun classifyError(error: Throwable): SyncState {
        var current: Throwable? = error
        while (current != null) {
            if (current is ApiClientException) {
                return when (current.category) {
                    ApiFailureCategory.AUTH_REQUIRED -> SyncState.AUTH_REQUIRED
                    ApiFailureCategory.INCOMPATIBLE -> SyncState.INCOMPATIBLE
                    ApiFailureCategory.SERVER_UNAVAILABLE -> SyncState.SERVER_UNAVAILABLE
                    ApiFailureCategory.REQUEST_REJECTED -> SyncState.ERROR
                    ApiFailureCategory.CURSOR_EXPIRED -> SyncState.ERROR
                }
            }
            if (current is IOException) return SyncState.OFFLINE
            current = current.cause
        }
        return SyncState.ERROR
    }

    private data class ConvertedOutbox(val source: OutboxEntity, val mutation: Mutation)

    private suspend fun convertV1Outbox(item: OutboxEntity, archiveOperationId: String?): ConvertedOutbox? {
        val payload = api.json.decodeFromString<Map<String, JsonElement>>(item.payloadJson)
        val converted = when (item.command) {
            "project.create" -> Mutation(item.mutationId, "folder.create", item.entityId, null, item.occurredAt,
                mapOf("parentFolderId" to JsonNull, "title" to (payload["name"] ?: JsonPrimitive("未命名目录"))))
            "project.update" -> Mutation(item.mutationId, "folder.update", item.entityId, item.baseVersion, item.occurredAt,
                mapOf("title" to (payload["name"] ?: return markUpgradeRequired(item))))
            "project.archive" -> Mutation(item.mutationId, "folder.archiveTree", item.entityId, item.baseVersion, item.occurredAt,
                mapOf("operationId" to JsonPrimitive(archiveOperationId ?: item.mutationId)))
            "project.restore" -> Mutation(item.mutationId, "folder.restoreTree", item.entityId, null, item.occurredAt,
                mapOf("operationId" to (payload["operationId"] ?: JsonPrimitive(archiveOperationId ?: item.entityId))))
            "task.create" -> {
                val parent = payload["projectId"] ?: payload["parentFolderId"] ?: JsonNull
                Mutation(item.mutationId, "task.create", item.entityId, null, item.occurredAt,
                    mapOf("parentFolderId" to parent, "title" to (payload["title"] ?: return markUpgradeRequired(item))))
            }
            "task.update" -> {
                if (payload.keys.any { it in setOf("projectId", "category", "priority", "rank") }) return markUpgradeRequired(item)
                Mutation(item.mutationId, "task.update", item.entityId, item.baseVersion, item.occurredAt,
                    payload.filterKeys { it == "title" || it == "status" })
            }
            "task.archive", "task.restore", "task.duplicate" -> Mutation(item.mutationId, item.command, item.entityId, item.baseVersion, item.occurredAt, payload)
            "note.update" -> Mutation(item.mutationId, "note.update", item.entityId, item.baseVersion, item.occurredAt,
                mapOf("taskId" to JsonPrimitive(item.entityId), "contentMarkdown" to (payload["contentMarkdown"] ?: JsonPrimitive(""))))
            "timePoint.date.create", "timePoint.event.create", "timePoint.update",
            "timePoint.reach", "timePoint.archive", "timePoint.restore", "timePoint.reorder",
            "placement.create", "placement.remove", "placement.move", "placement.copy", "placement.reorder" ->
                Mutation(item.mutationId, item.command, item.entityId, item.baseVersion, item.occurredAt, payload)
            "folder.create", "folder.update", "folder.archiveTree", "folder.restoreTree", "folder.deleteTree",
            "tree.move", "taskStep.create", "taskStep.update", "taskStep.move", "taskStep.delete",
            "workflow.create", "workflow.update", "workflow.archive", "workflow.restore", "workflow.delete",
            "workflowStage.create", "workflowStage.update", "workflowStage.move", "workflowStage.delete",
            "workflowTask.add", "workflowTask.move", "workflowTask.remove" ->
                Mutation(item.mutationId, item.command, item.entityId, item.baseVersion, item.occurredAt, payload)
            "settings.update" ->
                Mutation(item.mutationId, item.command, item.entityId, item.baseVersion, item.occurredAt, payload)
            else -> return markUpgradeRequired(item)
        }
        return ConvertedOutbox(item, converted)
    }

    private suspend fun markUpgradeRequired(item: OutboxEntity): ConvertedOutbox? {
        db.outboxDao().recordAttempt(item.id, item.ownerId, Long.MAX_VALUE, "CLIENT_UPGRADE_REQUIRED: ${item.command} 需要确认后转换")
        return null
    }

    private suspend fun applyV2Snapshot(snapshot: V2SnapshotResult, ownerId: String) {
        val now = isoFormat.format(Date())
        db.runInTransaction {
            runBlocking {
                // Clear non-pending entities to avoid stale local ghosts, but protect local pending outbox
                db.folderDao().clearNonPending(ownerId)
                db.taskDao().clearNonPending(ownerId)
                db.taskStepDao().clearNonPending(ownerId)
                db.workflowDao().clearNonPendingWorkflows(ownerId)
                db.workflowDao().clearNonPendingStages(ownerId)
                db.workflowDao().clearNonPendingMemberships(ownerId)
                db.archiveOperationDao().clearArchiveOperations(ownerId)
                db.noteDao().clearNonPending(ownerId)
                db.timePointDao().clearNonPending(ownerId)
                db.placementDao().clearNonPending(ownerId)

                db.folderDao().upsertAll(snapshot.folders.filter { it.ownerId == null || it.ownerId == ownerId }.map { folderEntity(it, ownerId, now) })
                val tasks = snapshot.tasks.filter { it.ownerId == null || it.ownerId == ownerId }.map { treeTaskEntity(it, ownerId, now) }
                db.taskDao().upsertTasks(tasks)
                db.noteDao().upsertNotes(snapshot.notes.filter { it.ownerId == null || it.ownerId == ownerId }.map { noteEntity(it, ownerId, now) })
                db.taskStepDao().upsertAll(snapshot.taskSteps.filter { it.ownerId == null || it.ownerId == ownerId }.map { stepEntity(it, ownerId, now) })
                db.timePointDao().upsertTimePoints(snapshot.timePoints.filter { it.ownerId == null || it.ownerId == ownerId }.map { timePointEntity(it, ownerId, now) })
                db.placementDao().upsertPlacements(snapshot.placements.filter { it.ownerId == null || it.ownerId == ownerId }.map { placementEntity(it, ownerId, now) })
                db.workflowDao().upsertWorkflows(snapshot.workflows.filter { it.ownerId == null || it.ownerId == ownerId }.map { workflowEntity(it, ownerId, now) })
                db.workflowDao().upsertStages(snapshot.workflowStages.filter { it.ownerId == null || it.ownerId == ownerId }.map { stageEntity(it, ownerId, now) })
                db.workflowDao().upsertMemberships(snapshot.workflowTaskMemberships.filter { it.ownerId == null || it.ownerId == ownerId }.map { membershipEntity(it, ownerId, now) })
                db.archiveOperationDao().upsertAll(snapshot.archiveOperations.filter { it.ownerId == null || it.ownerId == ownerId }.map { archiveEntity(it, ownerId, now) })
                snapshot.settings?.takeIf { it.ownerId == ownerId }?.let { settings ->
                    db.settingsDao().upsertSettings(
                        SettingsEntity(
                            ownerId = ownerId,
                            timezone = settings.timezone,
                            defaultCaptureTarget = settings.defaultCaptureTarget,
                            recentProjectId = null,
                            weekStartsOn = settings.weekStartsOn,
                            createdAt = settings.updatedAt ?: now,
                            updatedAt = settings.updatedAt ?: now,
                            version = settings.version,
                        )
                    )
                }
                db.syncMetaDao().set(SyncMetaEntity("protocol:$ownerId", "2"))
            }
        }
    }

    private suspend fun applyV2Changes(changes: List<ChangeItem>, ownerId: String) {
        val now = isoFormat.format(Date())
        db.runInTransaction {
            runBlocking {
                for (change in changes) {
                    val snapshot = change.snapshot
                    if (snapshot == null || change.operation == "delete") {
                        when (change.entityType) {
                            "folder" -> db.folderDao().getById(change.entityId, ownerId)?.let {
                                db.folderDao().upsert(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "task" -> db.taskDao().getTaskById(change.entityId, ownerId)?.let {
                                db.taskDao().upsertTask(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "note" -> db.noteDao().getNoteByTaskId(change.entityId, ownerId)?.let {
                                db.noteDao().upsertNote(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "taskStep" -> db.taskStepDao().getById(change.entityId, ownerId)?.let {
                                db.taskStepDao().upsert(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "timePoint" -> db.timePointDao().getTimePointById(change.entityId, ownerId)?.let {
                                db.timePointDao().upsertTimePoint(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "placement" -> db.placementDao().deletePlacementForOwner(ownerId, change.entityId)
                            // Tombstone the existing row instead of fabricating an
                            // empty "deleted" stub, which used to show up in the
                            // workflow list as a nameless entry.
                            "workflow" -> db.workflowDao().getWorkflowById(change.entityId, ownerId)?.let {
                                db.workflowDao().upsertWorkflow(it.copy(deletedAt = now, version = change.entityVersion.toLong()))
                            }
                            "workflowStage" -> db.workflowDao().getStageById(change.entityId, ownerId)?.let {
                                db.workflowDao().upsertStages(listOf(it.copy(deletedAt = now, version = change.entityVersion.toLong())))
                            }
                            "workflowTaskMembership" -> db.workflowDao().getMembershipById(change.entityId, ownerId)?.let {
                                db.workflowDao().upsertMemberships(listOf(it.copy(deletedAt = now, version = change.entityVersion.toLong())))
                            }
                            "archiveOperation" -> db.archiveOperationDao().getById(change.entityId, ownerId)?.let {
                                db.archiveOperationDao().upsertAll(listOf(it.copy(restoredAt = now)))
                            }
                        }
                        continue
                    }
                    when (change.entityType) {
                        "folder" -> db.folderDao().upsert(folderEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "task" -> {
                            val task = treeTaskEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            db.taskDao().upsertTask(task)
                        }
                        "note" -> db.noteDao().upsertNote(noteEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "taskStep" -> db.taskStepDao().upsert(stepEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "timePoint" -> db.timePointDao().upsertTimePoint(timePointEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "placement" -> db.placementDao().upsertPlacement(placementEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "workflow" -> db.workflowDao().upsertWorkflow(workflowEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now))
                        "workflowStage" -> db.workflowDao().upsertStages(listOf(stageEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)))
                        "workflowTaskMembership" -> db.workflowDao().upsertMemberships(listOf(membershipEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)))
                        "archiveOperation" -> db.archiveOperationDao().upsertAll(listOf(archiveEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)))
                    }
                }
            }
        }
    }

    private fun folderEntity(dto: FolderDto, ownerId: String, now: String) = FolderEntity(dto.id, dto.ownerId ?: ownerId, dto.parentFolderId, dto.title, dto.rank, dto.version, dto.archivedAt, dto.archivedByOperationId, dto.createdAt ?: now, dto.updatedAt ?: now, null, false)
    private fun treeTaskEntity(dto: TreeTaskDto, ownerId: String, now: String) = TaskEntity(dto.id, dto.ownerId ?: ownerId, null, dto.referenceId, dto.title, dto.status, TaskCategory.MISC, TaskPriority.NONE, dto.rank, dto.version, dto.archivedAt, dto.createdAt ?: now, dto.updatedAt ?: now, dto.parentFolderId, dto.completedAt, dto.archivedByOperationId, dto.deletedAt, false)
    private fun noteEntity(dto: NoteDto, ownerId: String, now: String) = NoteEntity(dto.id, dto.ownerId ?: ownerId, dto.taskId, dto.contentMarkdown, dto.version, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun stepEntity(dto: TaskStepDto, ownerId: String, now: String) = TaskStepEntity(dto.id, dto.ownerId ?: ownerId, dto.taskId, dto.title, dto.noteMarkdown, dto.status, dto.rank, dto.completedAt, dto.version, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun timePointEntity(dto: TimePointDto, ownerId: String, now: String) = TimePointEntity(dto.id, dto.ownerId ?: ownerId, dto.type, dto.localDate, dto.title, dto.rank, dto.version, dto.reachedAt, dto.archivedAt, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun placementEntity(dto: PlacementDto, ownerId: String, now: String) = PlacementEntity(dto.id, dto.ownerId ?: ownerId, dto.taskId, dto.timePointId, dto.rank, dto.version, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun workflowEntity(dto: WorkflowDto, ownerId: String, now: String) = WorkflowEntity(dto.id, dto.ownerId ?: ownerId, dto.name, dto.rank, dto.version, dto.archivedAt, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun stageEntity(dto: WorkflowStageDto, ownerId: String, now: String) = WorkflowStageEntity(dto.id, dto.ownerId ?: ownerId, dto.workflowId, dto.name, dto.rank, dto.version, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun membershipEntity(dto: WorkflowTaskMembershipDto, ownerId: String, now: String) = WorkflowTaskMembershipEntity(dto.id, dto.ownerId ?: ownerId, dto.workflowId, dto.stageId, dto.taskId, dto.rank, dto.version, dto.createdAt ?: now, dto.updatedAt ?: now, dto.deletedAt, false)
    private fun archiveEntity(dto: ArchiveOperationDto, ownerId: String, now: String) = ArchiveOperationEntity(dto.id, dto.ownerId ?: ownerId, dto.rootFolderId, dto.rootBaseVersion, dto.folderCount, dto.taskCount, dto.createdAt ?: now, dto.restoredAt)

    private suspend fun applySnapshot(snap: SnapshotResult, ownerId: String) {
        val now = isoFormat.format(Date())
        db.projectDao().upsertProjects(snap.projects.filter { it.ownerId == null || it.ownerId == ownerId }.map { p ->
            ProjectEntity(
                id = p.id,
                ownerId = p.ownerId ?: ownerId,
                name = p.name,
                slug = p.slug ?: p.taskPrefix ?: p.name.lowercase(),
                description = p.description,
                rank = p.rank,
                version = p.version,
                archivedAt = p.archivedAt,
                createdAt = p.createdAt ?: now,
                updatedAt = p.updatedAt ?: now
            )
        })
        db.taskDao().upsertTasks(snap.tasks.filter { it.ownerId == null || it.ownerId == ownerId }.map { t ->
            TaskEntity(
                id = t.id,
                ownerId = t.ownerId ?: ownerId,
                projectId = t.projectId,
                referenceId = t.referenceId,
                title = t.title,
                status = t.status,
                category = t.category,
                priority = t.priority,
                rank = t.rank,
                version = t.version,
                archivedAt = t.archivedAt,
                createdAt = t.createdAt ?: now,
                updatedAt = t.updatedAt ?: now
            )
        })
        db.noteDao().upsertNotes(snap.notes.filter { it.ownerId == null || it.ownerId == ownerId }.map { n ->
            NoteEntity(
                id = n.id,
                ownerId = n.ownerId ?: ownerId,
                taskId = n.taskId,
                contentMarkdown = n.contentMarkdown,
                version = n.version,
                createdAt = n.createdAt ?: now,
                updatedAt = n.updatedAt ?: now
            )
        })
        db.timePointDao().upsertTimePoints(snap.timePoints.filter { it.ownerId == null || it.ownerId == ownerId }.map { tp ->
            TimePointEntity(
                id = tp.id,
                ownerId = tp.ownerId ?: ownerId,
                type = tp.type,
                localDate = tp.localDate,
                title = tp.title,
                rank = tp.rank,
                version = tp.version,
                reachedAt = tp.reachedAt,
                archivedAt = tp.archivedAt,
                createdAt = tp.createdAt ?: now,
                updatedAt = tp.updatedAt ?: now
            )
        })
        db.placementDao().upsertPlacements(snap.placements.filter { it.ownerId == null || it.ownerId == ownerId }.map { pl ->
            PlacementEntity(
                id = pl.id,
                ownerId = pl.ownerId ?: ownerId,
                taskId = pl.taskId,
                timePointId = pl.timePointId,
                rank = pl.rank,
                version = pl.version,
                createdAt = pl.createdAt ?: now,
                updatedAt = pl.updatedAt ?: now
            )
        })
        snap.settings?.takeIf { it.ownerId == ownerId }?.let { s ->
            db.settingsDao().upsertSettings(
                SettingsEntity(
                    ownerId = s.ownerId,
                    timezone = s.timezone,
                    defaultCaptureTarget = s.defaultCaptureTarget,
                    recentProjectId = s.recentProjectId,
                    createdAt = s.createdAt ?: now,
                    updatedAt = s.updatedAt ?: now
                )
            )
        }
    }

    private suspend fun applyChanges(changes: List<ChangeItem>, ownerId: String) {
        val now = isoFormat.format(Date())
        for (c in changes) {
            when (c.entityType) {
                "task" -> {
                    if (c.operation == "delete") db.taskDao().deleteTask(c.entityId, ownerId)
                    else c.snapshot?.let {
                        val task = api.json.decodeFromJsonElement<TaskDto>(it)
                        if (task.ownerId != null && task.ownerId != ownerId) return@let
                        db.taskDao().upsertTask(
                            TaskEntity(
                                id = task.id,
                                ownerId = task.ownerId ?: ownerId,
                                projectId = task.projectId,
                                referenceId = task.referenceId,
                                title = task.title,
                                status = task.status,
                                category = task.category,
                                priority = task.priority,
                                rank = task.rank,
                                version = task.version,
                                archivedAt = task.archivedAt,
                                createdAt = task.createdAt ?: now,
                                updatedAt = task.updatedAt ?: now
                            )
                        )
                    }
                }
                "placement" -> {
                    c.snapshot?.let {
                        val pl = api.json.decodeFromJsonElement<PlacementDto>(it)
                        if (pl.ownerId != null && pl.ownerId != ownerId) return@let
                        db.placementDao().upsertPlacement(
                            PlacementEntity(
                                id = pl.id,
                                ownerId = pl.ownerId ?: ownerId,
                                taskId = pl.taskId,
                                timePointId = pl.timePointId,
                                rank = pl.rank,
                                version = pl.version,
                                createdAt = pl.createdAt ?: now,
                                updatedAt = pl.updatedAt ?: now,
                                deletedAt = pl.deletedAt
                            )
                        )
                    } ?: run {
                        if (c.operation == "delete") {
                            db.placementDao().deletePlacement(c.entityId, ownerId)
                        }
                    }
                }
                "settings" -> {
                    c.snapshot?.let {
                        val settings = api.json.decodeFromJsonElement<V2SettingsDto>(it)
                        if (settings.ownerId != ownerId) return@let
                        db.settingsDao().upsertSettings(
                            SettingsEntity(
                                ownerId = settings.ownerId,
                                timezone = settings.timezone,
                                defaultCaptureTarget = settings.defaultCaptureTarget,
                                recentProjectId = null,
                                weekStartsOn = settings.weekStartsOn,
                                createdAt = settings.updatedAt ?: now,
                                updatedAt = settings.updatedAt ?: now,
                                version = settings.version,
                            )
                        )
                    }
                }
                "note" -> {
                    c.snapshot?.let {
                        val n = api.json.decodeFromJsonElement<NoteDto>(it)
                        if (n.ownerId != null && n.ownerId != ownerId) return@let
                        db.noteDao().upsertNote(
                            NoteEntity(
                                id = n.id,
                                ownerId = n.ownerId ?: ownerId,
                                taskId = n.taskId,
                                contentMarkdown = n.contentMarkdown,
                                version = n.version,
                                createdAt = n.createdAt ?: now,
                                updatedAt = n.updatedAt ?: now,
                                deletedAt = n.deletedAt
                            )
                        )
                    } ?: run {
                        if (c.operation == "delete") {
                            db.noteDao().deleteNoteByTaskId(c.entityId, ownerId)
                        }
                    }
                }
                "project" -> {
                    if (c.operation == "delete") db.projectDao().deleteProject(c.entityId, ownerId)
                    else c.snapshot?.let {
                        val p = api.json.decodeFromJsonElement<ProjectDto>(it)
                        if (p.ownerId != null && p.ownerId != ownerId) return@let
                        db.projectDao().upsertProject(
                            ProjectEntity(
                                id = p.id,
                                ownerId = p.ownerId ?: ownerId,
                                name = p.name,
                                slug = p.slug ?: p.taskPrefix ?: p.name.lowercase(),
                                description = p.description,
                                rank = p.rank,
                                version = p.version,
                                archivedAt = p.archivedAt,
                                createdAt = p.createdAt ?: now,
                                updatedAt = p.updatedAt ?: now
                            )
                        )
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
        val jsonPayload = api.json.encodeToString(payload.mapValues { (_, value) -> jsonElement(value) })
        val item = OutboxEntity(
            mutationId = UUID.randomUUID().toString(),
            clientId = authManager.clientId,
            ownerId = authManager.ownerId
                ?: throw IllegalStateException("登录状态已失效，请重新登录"),
            command = command,
            entityId = entityId,
            baseVersion = baseVersion,
            occurredAt = isoFormat.format(Date()),
            payloadJson = jsonPayload
        )
        db.outboxDao().insert(item)
        scope.launch { triggerSync() }
    }

    private fun jsonElement(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is Map<*, *> -> buildJsonObject {
            value.forEach { (key, nested) -> if (key is String) put(key, jsonElement(nested)) }
        }
        is Iterable<*> -> buildJsonArray { value.forEach { add(jsonElement(it)) } }
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        else -> JsonPrimitive(value.toString())
    }
}
