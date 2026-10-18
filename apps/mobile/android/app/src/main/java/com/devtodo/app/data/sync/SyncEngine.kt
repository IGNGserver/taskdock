package com.devtodo.app.data.sync

import androidx.room.withTransaction
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.remote.ApiClientException
import com.devtodo.app.data.remote.ApiFailureCategory
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
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

data class LoadProgress(val phase: String = "cache", val completedPages: Int = 0, val totalPages: Int = 0,
    val complete: Boolean = false)

class SyncEngine(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val authManager: SecureAuthManager,
    private val syncBudgetMs: Long = 45_000L,
    private val verificationIntervalMs: Long = 30_000L,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _syncState = MutableStateFlow(SyncState.IDLE)
    val syncState: StateFlow<SyncState> = _syncState.asStateFlow()

    private val _lastSyncError = MutableStateFlow<String?>(null)
    val lastSyncError: StateFlow<String?> = _lastSyncError.asStateFlow()
    private val _loadProgress = MutableStateFlow(LoadProgress())
    val loadProgress: StateFlow<LoadProgress> = _loadProgress.asStateFlow()
    private val _pageLoads = MutableStateFlow<Map<String, PageLoadState>>(emptyMap())
    val pageLoads = _pageLoads.asStateFlow()
    @Volatile private var foreground = false
    @Volatile private var activePage: String? = null
    private val pageFlights = mutableMapOf<String, Deferred<SyncOutcome>>()
    private val priorityReads = Semaphore(2)
    private val syncMutex = Mutex()
    private val flightLock = Any()
    private var syncFlight: Deferred<SyncOutcome>? = null
    private var syncRequested = 0L
    private var retrySyncJob: Job? = null
    private var retrySyncAttempt = 0
    private var engineEpoch = 0L
    private val boundSession = authManager.sessionKey

    private suspend fun ensureSession() {
        currentCoroutineContext().ensureActive()
        if (authManager.sessionKey != boundSession) {
            if (!authManager.isLoggedIn) {
                _syncState.value = SyncState.AUTH_REQUIRED
                _lastSyncError.value = "登录已失效，请重新登录"
            }
            throw CancellationException("账户或中枢已变化")
        }
    }

    /** All callers share an engine-owned flight. Logout cancels manual refresh too. */
    suspend fun triggerSync(): SyncOutcome {
        val flight = synchronized(flightLock) {
            syncRequested++
            syncFlight?.takeIf { it.isActive } ?: scope.async {
                var outcome: SyncOutcome
                var passes = 0
                val flightStartedAt = System.nanoTime()
                do {
                    val requested = synchronized(flightLock) { syncRequested }
                    outcome = try {
                        val remaining = syncBudgetMs - (System.nanoTime() - flightStartedAt) / 1_000_000
                        withTimeout(remaining.coerceAtLeast(1L)) { runSync() }
                    } catch (timeout: TimeoutCancellationException) {
                        currentCoroutineContext().ensureActive()
                        val message = "更新超时，已保留缓存和加载进度，可重试"
                        _syncState.value = SyncState.ERROR
                        _lastSyncError.value = message
                        SyncOutcome.Failure(message)
                    }
                    passes++
                    if (outcome is SyncOutcome.Failure) break
                } while (passes < 2 && synchronized(flightLock) { requested != syncRequested })
                if (outcome is SyncOutcome.Failure) scheduleSyncRetry()
                else { retrySyncAttempt = 0; retrySyncJob?.cancel() }
                outcome
            }.also { syncFlight = it }
        }
        return flight.await()
    }

    private fun scheduleSyncRetry() {
        if (!started || !networkAvailable || !authManager.isLoggedIn ||
            _syncState.value in setOf(SyncState.AUTH_REQUIRED, SyncState.INCOMPATIBLE) ||
            retrySyncJob?.isActive == true) return
        val delayMs = (1_000L shl retrySyncAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
        retrySyncAttempt++
        retrySyncJob = scope.launch {
            delay(delayMs + ThreadLocalRandom.current().nextLong(500))
            retrySyncJob = null
            triggerSync()
        }
    }

    private val socketLock = Any()
    @Volatile private var activeWebSocket: WebSocket? = null
    @Volatile private var started = false
    @Volatile private var networkAvailable = true
    private var socketGeneration = 0L
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null

    // Outbox mutations are recorded inside Room transactions; a sync fired from
    // inside the transaction can read the pre-commit snapshot and find nothing
    // to push. Observing the outbox table fires after commit, so every write is
    // pushed immediately no matter where it was recorded.
    private val outboxRequests = Channel<Unit>(Channel.CONFLATED)

    companion object {
        private const val SYNC_CURSOR_KEY = "sync_cursor"
        private const val OUTBOX_DEBOUNCE_MS = 80L
        private const val MAX_PUSH_MUTATIONS = 100
        private const val MAX_PUSH_BYTES = 900_000
        private const val TARGET_PUSH_BYTES = 256_000

        fun v2SyncCursorKey(ownerId: String): String = "v2:$SYNC_CURSOR_KEY:$ownerId"
    }

    private fun syncCursorKey(ownerId: String): String = "$SYNC_CURSOR_KEY:$ownerId"

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
        scope.launch { outboxSyncLoop() }
        scope.launch { observeOutbox() }
        scope.launch {
            triggerSync()
        }
        scope.launch {
            while (isActive) {
                delay(verificationIntervalMs)
                if (foreground && networkAvailable && authManager.isLoggedIn) {
                    val page = activePage
                    if (page != null) prioritizePage(page, force = true) else triggerSync()
                }
            }
        }
    }

    fun setForeground(value: Boolean) { foreground = value }

    fun prioritizePage(key: String, force: Boolean = false) {
        val previousPage = activePage
        activePage = key
        if (previousPage != null && previousPage != key) synchronized(pageFlights) {
            pageFlights.remove(previousPage)?.cancel()
        }
        if (!networkAvailable || !authManager.isLoggedIn) return
        val previous = _pageLoads.value[key]
        if (!force && previous?.error == null && previous != null &&
            System.currentTimeMillis() - previous.loadedAt in 0 until verificationIntervalMs) return
        scope.launch {
            if (activePage != key) return@launch
            when {
                key.startsWith("task:") -> loadTaskDetails(key.removePrefix("task:"))
                key.startsWith("directory:") || key == "today" -> loadPreview(key)
            }
            // Preview/detail responses are partial. Reconcile deletions and
            // relations with the global feed before claiming cache freshness.
            triggerSync()
        }
    }

    private suspend fun pageRequest(key: String, block: suspend () -> Unit): SyncOutcome {
        val flight = synchronized(pageFlights) {
            if (pageFlights.size >= 48) {
                pageFlights.entries.removeAll { !it.value.isActive && it.key != key && it.key != activePage }
                _pageLoads.update { states -> states.filterKeys { it in pageFlights || it == key || it == activePage } }
            }
            pageFlights[key]?.takeIf { it.isActive } ?: scope.async(start = CoroutineStart.LAZY) {
                val job = currentCoroutineContext()[Job]
                fun publish(transform: (PageLoadState) -> PageLoadState) = synchronized(pageFlights) {
                    if (pageFlights[key] === job) _pageLoads.update { it + (key to transform(it[key] ?: PageLoadState())) }
                }
                fun failure(message: String): SyncOutcome.Failure {
                    publish { it.copy(loading = false, error = message) }
                    return SyncOutcome.Failure(message)
                }
                if (activePage != null && activePage != key) throw CancellationException("页面已变化")
                publish { it.copy(loading = true, error = null) }
                try {
                    withTimeout(12_000L) { priorityReads.withPermit { ensureSession(); block(); ensureSession() } }
                    publish { PageLoadState(loadedAt = System.currentTimeMillis()) }
                    SyncOutcome.Success
                } catch (timeout: TimeoutCancellationException) {
                    currentCoroutineContext().ensureActive()
                    failure("页面更新超时，显示已缓存内容")
                } catch (cancelled: CancellationException) { throw cancelled
                } catch (error: Exception) {
                    ensureSession()
                    failure(error.message ?: "页面更新失败")
                } finally {
                    publish { it.copy(loading = false) }
                }
            }.also { pageFlights[key] = it; it.start() }
        }
        return flight.await()
    }

    private suspend fun loadPreview(key: String): SyncOutcome = pageRequest(key) {
        val owner = authManager.ownerId ?: error("账户不可用")
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone(db.settingsDao().getSettings(owner)?.timezone ?: "Asia/Shanghai")
        }.format(Date())
        val folder = key.takeIf { it.startsWith("directory:") }?.removePrefix("directory:")?.takeUnless { it == "root" }
        val response = api.syncPreview(date, folder)
        val failure = response.exceptionOrNull() as? ApiClientException
        // Older v2 Hubs have no preview route. The caller still runs the
        // authoritative global sync; absence is not a page failure forever.
        if (failure?.statusCode == 404) return@pageRequest
        val preview = response.getOrThrow()
        require(!preview.complete) { "首屏响应不能作为完整快照" }
        applyV2Changes(preview.changes, owner)
    }

    private suspend fun outboxSyncLoop() {
        for (request in outboxRequests) {
            // Coalesce bursts (a capture writes task + note + placement) into a
            // single push instead of one request per mutation.
            delay(OUTBOX_DEBOUNCE_MS)
            triggerSync()
        }
    }

    private suspend fun observeOutbox() {
        val ownerId = authManager.ownerId ?: return
        var seen = emptySet<String>()
        db.outboxDao().getPendingItemsFlow(ownerId).collect { pending ->
            val ids = pending.map { it.mutationId }.toSet()
            if ((ids - seen).isNotEmpty()) outboxRequests.trySend(Unit)
            seen = ids
        }
    }

    fun stop() {
        engineEpoch++
        api.cancelSessionCalls(boundSession)
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
        synchronized(flightLock) { syncFlight = null }
        synchronized(pageFlights) { pageFlights.clear() }
        _pageLoads.value = emptyMap()
        retrySyncJob = null
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
                    if (!isCurrentSocket(webSocket, generation)) return
                    try {
                        val element = api.json.parseToJsonElement(text).jsonObject
                        if (element["type"]?.jsonPrimitive?.content in setOf("sync.required", "ready")) {
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
        activeWebSocket === socket && socketGeneration == generation && authManager.sessionKey == boundSession
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

    private suspend fun runSync(): SyncOutcome = syncMutex.withLock {
        withContext(Dispatchers.IO) {
            ensureSession()
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
                _loadProgress.value = LoadProgress("cache", complete = db.syncMetaDao().get(v2SyncCursorKey(ownerId)) != null)
                val message = "当前处于离线状态，请检查网络后重试"
                _syncState.value = SyncState.OFFLINE
                _lastSyncError.value = message
                return@withContext SyncOutcome.Failure(message)
            }
            _syncState.value = SyncState.SYNCING
            _lastSyncError.value = null
            try {
                repairProtection(ownerId)
                val cursorKey = v2SyncCursorKey(ownerId)
                var cursor = db.syncMetaDao().get(cursorKey)
                if (cursor == null) {
                    bootstrap(ownerId)
                    cursor = db.syncMetaDao().get(cursorKey)
                } else {
                    _loadProgress.value = LoadProgress("refresh", complete = true)
                }

                // Remote reads must not wait behind a large or failing Outbox.
                // Pending rows are protected and their remote versions journalled.
                pullRemote(ownerId)

                val hadPending = db.outboxDao().getPendingItems(ownerId).isNotEmpty()
                var pushFailure: Exception? = null
                val blockedMutation = try { pushPendingV2(ownerId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    if (classifyError(failure) in setOf(SyncState.AUTH_REQUIRED, SyncState.INCOMPATIBLE)) throw failure
                    pushFailure = failure
                    null
                }
                if (blockedMutation != null) {
                    // Rejected/unsupported mutations have just been released
                    // from their pending guards. Reconcile against the
                    // authoritative snapshot now so a locally-created ghost
                    // is not left behind until cursor retention expires.
                    bootstrap(ownerId)
                }

                if (hadPending || blockedMutation != null) pullRemote(ownerId)
                replayDeferred(ownerId)
                _loadProgress.value = LoadProgress("ready", complete = true)
                pushFailure?.let { throw it }
                if (blockedMutation != null) {
                    _syncState.value = SyncState.ERROR
                    _lastSyncError.value = blockedMutation
                    SyncOutcome.Failure(blockedMutation)
                } else {
                    _syncState.value = if (networkAvailable) SyncState.IDLE else SyncState.OFFLINE
                    SyncOutcome.Success
                }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (error: Exception) {
                ensureSession()
                _syncState.value = classifyError(error)
                val message = error.message?.takeIf { it.isNotBlank() } ?: "同步失败，请稍后重试"
                _lastSyncError.value = message
                SyncOutcome.Failure(message)
            }
        }
    }

    private suspend fun pullRemote(ownerId: String) {
        val cursorKey = v2SyncCursorKey(ownerId)
        var cursor = db.syncMetaDao().get(cursorKey) ?: "0"
        var resynced = false
        while (true) {
            val result = try { api.pullSyncV2(cursor, 200).getOrThrow() }
            catch (error: ApiClientException) {
                if (error.category != ApiFailureCategory.CURSOR_EXPIRED || resynced) throw error
                bootstrap(ownerId)
                cursor = db.syncMetaDao().get(cursorKey) ?: error("缺少快照游标")
                resynced = true
                continue
            }
            ensureSession()
            require(result.cursor.matches(Regex("\\d+")) && result.cursor.toBigInteger() >= cursor.toBigInteger() &&
                (!result.hasMore || result.cursor.toBigInteger() > cursor.toBigInteger())) { "增量游标未正确前进" }
            db.withTransaction {
                applyV2Changes(result.changes, ownerId)
                db.syncMetaDao().set(SyncMetaEntity(cursorKey, result.cursor))
                if (!result.hasMore) db.syncMetaDao().set(SyncMetaEntity("confirmed:$ownerId", System.currentTimeMillis().toString()))
            }
            cursor = result.cursor
            if (!result.hasMore) break
        }
    }

    private suspend fun bootstrap(ownerId: String) {
        _loadProgress.value = LoadProgress("preview")
        val capabilities = api.syncCapabilities()
        val unsupported = capabilities.exceptionOrNull() as? ApiClientException
        if (unsupported?.statusCode == 404 || capabilities.getOrNull()?.pagedSnapshot == false) {
            _loadProgress.value = LoadProgress("snapshot")
            applyV2Snapshot(api.getSnapshotV2().getOrThrow(), ownerId)
            return
        }
        require(capabilities.getOrThrow().protocolVersion == 2) { "中枢同步协议不兼容" }
        val key = "bootstrap:$ownerId"
        val pageKey = "$key:page"
        val format = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone(db.settingsDao().getSettings(ownerId)?.timezone ?: "Asia/Shanghai")
        }
        var date = format.format(Date())
        var restarted = false
        while (true) {
            var manifest = db.syncMetaDao().get(key)?.let { api.json.decodeFromString<BootstrapManifest>(it) }
            if (manifest == null) {
                val priorityFolder = activePage?.takeIf { it.startsWith("directory:") }
                    ?.removePrefix("directory:")?.takeUnless { it == "root" }
                val preview = api.syncPreview(date, priorityFolder).getOrThrow()
                require(!preview.complete) { "首屏响应不能作为完整快照" }
                applyV2Changes(preview.changes, ownerId)
                format.timeZone = TimeZone.getTimeZone(db.settingsDao().getSettings(ownerId)?.timezone ?: "Asia/Shanghai")
                val correctedDate = format.format(Date())
                if (correctedDate != date) {
                    date = correctedDate
                    applyV2Changes(api.syncPreview(date, priorityFolder).getOrThrow().changes, ownerId)
                }
                manifest = api.createBootstrap(date).getOrThrow()
                require(manifest.protocolVersion == 2 && manifest.pageCount > 0 && manifest.cursor.matches(Regex("\\d+")))
                db.withTransaction {
                    ensureSession()
                    db.syncJournalDao().resetBootstrap()
                    db.syncMetaDao().set(SyncMetaEntity(key, api.json.encodeToString(manifest)))
                    db.syncMetaDao().set(SyncMetaEntity(pageKey, "0"))
                }
            }
            var page = db.syncMetaDao().get(pageKey)?.toIntOrNull() ?: 0
            try {
                while (page < manifest.pageCount) {
                    val batch = api.bootstrapPage(manifest.snapshotId, page).getOrThrow()
                    require(batch.snapshotId == manifest.snapshotId && batch.cursor == manifest.cursor &&
                        batch.page == page && batch.pageCount == manifest.pageCount && batch.protocolVersion == 2 &&
                        batch.nextPage == (page + 1).takeIf { it < manifest.pageCount }) { "快照页面校验失败，已保留缓存" }
                    require(batch.changes.all { it.snapshot != null && it.operation == "upsert" &&
                        (it.entityType in MutationGuards.tables || it.entityType == "settings") })
                    db.withTransaction {
                        ensureSession()
                        applyV2Changes(batch.changes, ownerId)
                        db.syncJournalDao().seen(batch.changes.map { BootstrapRowEntity(it.entityType, it.entityId) })
                        db.syncMetaDao().set(SyncMetaEntity(pageKey, (page + 1).toString()))
                    }
                    page++
                    _loadProgress.value = LoadProgress("bootstrap", page, manifest.pageCount)
                    android.util.Log.d("TaskDockSync", "bootstrap pages=$page/${manifest.pageCount} rows=${batch.changes.size}")
                    yield()
                }
                db.withTransaction {
                    ensureSession()
                    // Never infer deletion from a partial page or preview.
                    for ((type, table) in MutationGuards.tables.filterKeys { it != "project" }) {
                        db.openHelper.writableDatabase.execSQL("DELETE FROM $table WHERE ownerId = ? AND pendingSync = 0 AND id NOT IN (SELECT entityId FROM bootstrap_rows WHERE entityType = ?)", arrayOf(ownerId, type))
                    }
                    db.syncMetaDao().set(SyncMetaEntity(v2SyncCursorKey(ownerId), manifest.cursor))
                    db.syncMetaDao().set(SyncMetaEntity("protocol:$ownerId", "2"))
                    db.syncMetaDao().remove(key)
                    db.syncMetaDao().remove(pageKey)
                    db.syncJournalDao().resetBootstrap()
                }
                return
            } catch (error: ApiClientException) {
                if (error.category != ApiFailureCategory.CURSOR_EXPIRED || restarted) throw error
                db.withTransaction { ensureSession(); db.syncMetaDao().remove(key); db.syncMetaDao().remove(pageKey) }
                restarted = true
            }
        }
    }

    suspend fun loadTaskDetails(taskId: String): SyncOutcome = pageRequest("task:$taskId") {
            val epoch = engineEpoch
            ensureSession()
            val owner = authManager.ownerId ?: error("账户不可用")
            val detail = api.taskDetails(taskId).getOrThrow()
            if (epoch != engineEpoch) throw CancellationException("详情请求已失效")
            fun <T> change(type: String, id: String, version: Long, value: T, serializer: kotlinx.serialization.SerializationStrategy<T>) =
                ChangeItem("0", type, id, version, "upsert", api.json.encodeToJsonElement(serializer, value))
            applyV2Changes(buildList {
                add(change("task", detail.task.id, detail.task.version, detail.task, TreeTaskDto.serializer()))
                add(change("note", detail.note.id, detail.note.version, detail.note, NoteDto.serializer()))
                detail.steps.forEach { add(change("taskStep", it.id, it.version, it, TaskStepDto.serializer())) }
            }, owner)
    }

    fun prioritizeDirectory(folderId: String?) {
        prioritizePage("directory:${folderId ?: "root"}")
    }

    /**
     * Clear the optimistic `pendingSync` flag for the entity an applied mutation
     * targeted, so a later snapshot resync can reconcile it like any server row.
     * Cascading deletes also clear the child tombstones that the server mutation
     * owns; otherwise the pull guard would intentionally preserve them forever.
     */
    private suspend fun markEntitySynced(ownerId: String, item: OutboxEntity) {
        require(item.ownerId == ownerId)
        MutationGuards(db, api.json).release(item)
    }

    /**
     * Drops a local mutation without leaving its optimistic rows permanently
     * protected from future snapshots. The caller uses this for an explicit
     * user discard; rejected oversized/unsupported mutations use the same
     * cleanup path internally.
     */
    suspend fun discardLocalMutation(item: OutboxEntity) {
        val ownerId = authManager.ownerId ?: error("登录状态已失效，请重新登录")
        require(item.ownerId == ownerId) { "操作不属于当前账户" }
        db.withTransaction {
            markEntitySynced(ownerId, item)
            db.outboxDao().deleteByMutationId(item.mutationId, ownerId)
            db.conflictDao().markResolvedByMutationId(item.mutationId, ownerId, isoFormat.format(Date()))
            // Discard abandons an optimistic version; rebuild from authority,
            // not an incremental cursor that already skipped that version.
            db.syncMetaDao().remove(v2SyncCursorKey(ownerId))
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

    private data class PendingEntityIds(
        val folders: Set<String>,
        val tasks: Set<String>,
        val notes: Set<String>,
        val taskSteps: Set<String>,
        val timePoints: Set<String>,
        val placements: Set<String>,
        val workflows: Set<String>,
        val workflowStages: Set<String>,
        val memberships: Set<String>,
        val settings: Boolean,
    )

    private suspend fun pendingEntityIds(ownerId: String): PendingEntityIds = PendingEntityIds(
        folders = db.folderDao().getPendingIds(ownerId).toSet(),
        tasks = db.taskDao().getPendingIds(ownerId).toSet(),
        notes = db.noteDao().getPendingIds(ownerId).toSet(),
        taskSteps = db.taskStepDao().getPendingIds(ownerId).toSet(),
        timePoints = db.timePointDao().getPendingIds(ownerId).toSet() + db.syncJournalDao().guards().filter { it.entityType == "timePoint" }.map { it.entityId },
        placements = db.placementDao().getPendingIds(ownerId).toSet() + db.syncJournalDao().guards().filter { it.entityType == "placement" }.map { it.entityId },
        workflows = db.workflowDao().getPendingWorkflowIds(ownerId).toSet(),
        workflowStages = db.workflowDao().getPendingStageIds(ownerId).toSet(),
        memberships = db.workflowDao().getPendingMembershipIds(ownerId).toSet(),
        settings = db.outboxDao().getPendingItems(ownerId).any { it.command == "settings.update" && it.lastError?.startsWith("TERMINAL:") != true },
    )

    /**
     * Pushes only due, non-terminal mutations in bounded requests. A single
     * oversized request used to poison the entire queue because the API rejects
     * more than 500 mutations (and also has a body-size limit).
     *
     * @return a user-actionable message when the server permanently rejected or
     * conflicted with at least one mutation.
     */
    private suspend fun pushPendingV2(ownerId: String): String? {
        val pending = db.outboxDao().getDueItems(ownerId, System.currentTimeMillis())
        if (pending.isEmpty()) return null
        db.withTransaction {
            ensureSession()
            val tracked = db.syncJournalDao().guards().map { it.mutationId }.toSet()
            pending.filter { it.mutationId !in tracked }.forEach { MutationGuards(db, api.json).track(it) }
        }

        var blockedMessage: String? = null
        val converted = mutableListOf<ConvertedOutbox>()
        for (item in pending) {
            if (item.lastError?.startsWith("CLIENT_UPGRADE_REQUIRED") == true ||
                item.lastError?.startsWith("TERMINAL:CLIENT_UPGRADE_REQUIRED") == true
            ) continue
            val archiveOperationId = pending
                .firstOrNull { it.command == "project.archive" && it.entityId == item.entityId }
                ?.mutationId
            val convertedItem = convertV1Outbox(item, archiveOperationId)
            if (convertedItem != null) {
                converted += convertedItem
            } else {
                blockedMessage = blockedMessage ?: "有本地操作需要升级后才能同步"
            }
        }
        if (converted.isEmpty()) return blockedMessage

        for (batch in splitPushBatches(converted)) {
            if (batch.size == 1 && encodedPushSize(batch) > MAX_PUSH_BYTES) {
                val source = batch.single().source
                val message = "TERMINAL:mutation payload exceeds the sync request limit"
                db.withTransaction {
                    ensureSession()
                    db.outboxDao().recordAttempt(source.id, ownerId, Long.MAX_VALUE, message)
                    markEntitySynced(ownerId, source)
                }
                blockedMessage = blockedMessage ?: message.removePrefix("TERMINAL:")
                continue
            }

            ensureSession()
            // A date creation may return the existing server ID. Re-read later
            // dependent batches after the acknowledged mapping was committed.
            val live = db.outboxDao().getPendingItems(ownerId).associateBy { it.mutationId }
            val guardsByMutation = db.syncJournalDao().guards().groupBy { it.mutationId }
            val blockedTargets = live.values.filter { it.lastError?.startsWith("CONFLICT:") == true }
                .flatMap { guardsByMutation[it.mutationId].orEmpty() }.map { it.entityType to it.entityId }.toSet()
            val refreshed = batch.mapNotNull { converted ->
                live[converted.source.mutationId]?.let { item ->
                    if (guardsByMutation[item.mutationId].orEmpty().any { (it.entityType to it.entityId) in blockedTargets }) {
                        blockedMessage = blockedMessage ?: "有同步冲突，依赖操作已保留等待处理"
                        null
                    } else convertV1Outbox(item, null)
                }
            }
            if (refreshed.isEmpty()) continue
            val push = api.pushSyncV2(refreshed.map { it.mutation }).getOrThrow()
            require(push.results.map { it.mutationId }.toSet() == refreshed.map { it.mutation.mutationId }.toSet() &&
                push.results.size == refreshed.size && push.results.all { it.status in setOf("applied", "conflict", "rejected") }) { "上传结果不完整，离线队列已保留" }
            for (result in push.results) {
                val original = refreshed.firstOrNull { it.mutation.mutationId == result.mutationId }?.source
                    ?: continue
                when (result.status) {
                    "applied" -> {
                        db.withTransaction {
                            ensureSession()
                            reconcileReturnedIds(ownerId, original, result.result)
                            db.outboxDao().deleteByMutationId(result.mutationId, ownerId)
                            // The optimistic row is now authoritative on the server,
                            // so drop its pending flag before the next pull.
                            markEntitySynced(ownerId, original)
                            applyReturnedResult(ownerId, original.command, result.result)
                        }
                    }
                    "conflict" -> {
                        val detail = result.error?.toString() ?: result.message ?: "VERSION_CONFLICT"
                        val message = "CONFLICT:$detail"
                        db.withTransaction {
                            ensureSession()
                            db.outboxDao().recordAttempt(original.id, ownerId, Long.MAX_VALUE, message)
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
                        }
                        blockedMessage = blockedMessage ?: "有同步冲突需要处理"
                    }
                    else -> {
                        val detail = result.error?.toString() ?: result.message ?: "v2 mutation 未应用"
                        val message = "TERMINAL:$detail"
                        db.withTransaction {
                            ensureSession()
                            db.outboxDao().recordAttempt(original.id, ownerId, Long.MAX_VALUE, message)
                            markEntitySynced(ownerId, original)
                        }
                        blockedMessage = blockedMessage ?: "有同步操作被中枢拒绝"
                    }
                }
            }
            // Yield between bounded uploads so other devices' changes remain visible.
            pullRemote(ownerId)
        }
        return blockedMessage
    }

    private suspend fun splitPushBatches(items: List<ConvertedOutbox>): List<List<ConvertedOutbox>> {
        val batches = mutableListOf<List<ConvertedOutbox>>()
        var current = mutableListOf<ConvertedOutbox>()
        val guards = db.syncJournalDao().guards().groupBy { it.mutationId }
        fun targets(item: ConvertedOutbox) = guards[item.source.mutationId].orEmpty().map { it.entityType to it.entityId }.toSet()
        for (item in items) {
            if (item.source.command in setOf("timePoint.date.create", "placement.create", "placement.copy", "placement.move")) {
                if (current.isNotEmpty()) batches += current
                batches += listOf(item)
                current = mutableListOf()
                continue
            }
            val candidate = current + item
            if (current.isNotEmpty() &&
                (candidate.size > MAX_PUSH_MUTATIONS || encodedPushSize(candidate) > TARGET_PUSH_BYTES ||
                    current.any { previous -> targets(previous).any { it in targets(item) } })
            ) {
                batches += current
                current = mutableListOf(item)
            } else {
                current += item
            }
        }
        if (current.isNotEmpty()) batches += current
        return batches
    }

    private fun encodedPushSize(batch: List<ConvertedOutbox>): Int =
        api.json.encodeToString(
            V2PushRequest(
                clientId = authManager.clientId,
                mutations = batch.map { it.mutation },
            ),
        ).toByteArray(Charsets.UTF_8).size

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
                val title = payload["title"] ?: return markUpgradeRequired(item)
                Mutation(item.mutationId, "task.create", item.entityId, null, item.occurredAt,
                    buildMap {
                        put("parentFolderId", parent)
                        put("title", title)
                        payload["noteId"]?.let { put("noteId", it) }
                    })
            }
            "task.update" -> {
                if (payload.keys.any { it in setOf("projectId", "category", "priority", "rank") }) return markUpgradeRequired(item)
                Mutation(item.mutationId, "task.update", item.entityId, item.baseVersion, item.occurredAt,
                    payload.filterKeys { it == "title" || it == "status" })
            }
            "task.archive", "task.restore", "task.duplicate", "task.delete" -> Mutation(item.mutationId, item.command, item.entityId, item.baseVersion, item.occurredAt, payload)
            "note.update" -> Mutation(item.mutationId, "note.update", item.entityId, item.baseVersion, item.occurredAt,
                mapOf("taskId" to JsonPrimitive(item.entityId), "contentMarkdown" to (payload["contentMarkdown"] ?: JsonPrimitive(""))))
            "timePoint.date.create", "timePoint.event.create", "timePoint.update",
            "timePoint.reach", "timePoint.unreach", "timePoint.archive", "timePoint.restore", "timePoint.delete",
            "timePoint.reorder",
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
        db.withTransaction {
            ensureSession()
            db.outboxDao().recordAttempt(item.id, item.ownerId, Long.MAX_VALUE, "TERMINAL:CLIENT_UPGRADE_REQUIRED: ${item.command} 需要确认后转换")
            markEntitySynced(item.ownerId, item)
        }
        return null
    }

    private suspend fun applyV2Snapshot(snapshot: V2SnapshotResult, ownerId: String) {
        val now = isoFormat.format(Date())
        db.withTransaction {
                ensureSession()
                val pending = pendingEntityIds(ownerId)
                // Persist protected rows from full snapshots too. Advancing C
                // must not lose the authority we deliberately did not apply.
                val encoded = api.json.encodeToJsonElement(snapshot).jsonObject
                for ((collection, type) in mapOf("folders" to "folder", "tasks" to "task", "notes" to "note",
                    "taskSteps" to "taskStep", "timePoints" to "timePoint", "placements" to "placement",
                    "workflows" to "workflow", "workflowStages" to "workflowStage",
                    "workflowTaskMemberships" to "workflowTaskMembership")) {
                    val incoming = encoded[collection]?.jsonArray.orEmpty().map { row ->
                        val obj = row.jsonObject
                        ChangeItem(snapshot.cursor, type, obj.getValue("id").jsonPrimitive.content,
                            obj.getValue("version").jsonPrimitive.long, "upsert", row)
                    }
                    applyV2Changes(incoming, ownerId)
                }
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

                db.folderDao().upsertAll(snapshot.folders
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.folders }
                    .map { folderEntity(it, ownerId, now) })
                val tasks = snapshot.tasks
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.tasks }
                    .map { treeTaskEntity(it, ownerId, now) }
                db.taskDao().upsertTasks(tasks)
                db.noteDao().upsertNotes(snapshot.notes
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.notes }
                    .map { noteEntity(it, ownerId, now) })
                db.taskStepDao().upsertAll(snapshot.taskSteps
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.taskSteps }
                    .map { stepEntity(it, ownerId, now) })
                db.timePointDao().upsertTimePoints(snapshot.timePoints
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.timePoints }
                    .map { timePointEntity(it, ownerId, now) })
                db.placementDao().upsertPlacements(snapshot.placements
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.placements }
                    .map { placementEntity(it, ownerId, now) })
                db.workflowDao().upsertWorkflows(snapshot.workflows
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.workflows }
                    .map { workflowEntity(it, ownerId, now) })
                db.workflowDao().upsertStages(snapshot.workflowStages
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.workflowStages }
                    .map { stageEntity(it, ownerId, now) })
                db.workflowDao().upsertMemberships(snapshot.workflowTaskMemberships
                    .filter { (it.ownerId == null || it.ownerId == ownerId) && it.id !in pending.memberships }
                    .map { membershipEntity(it, ownerId, now) })
                db.archiveOperationDao().upsertAll(snapshot.archiveOperations.filter { it.ownerId == null || it.ownerId == ownerId }.map { archiveEntity(it, ownerId, now) })
                snapshot.settings?.takeIf { it.ownerId == ownerId && !pending.settings }?.let { settings ->
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
                db.syncMetaDao().set(SyncMetaEntity(v2SyncCursorKey(ownerId), snapshot.cursor))
                ensureSession()
        }
    }

    private suspend fun applyV2Changes(changes: List<ChangeItem>, ownerId: String) {
        val startedAt = System.nanoTime()
        val now = isoFormat.format(Date())
        db.withTransaction {
                ensureSession()
                val pending = pendingEntityIds(ownerId)
                val deferred = db.syncJournalDao().deferred().associateBy { it.entityType to it.entityId }.toMutableMap()
                for (change in changes) {
                    val isPending = when (change.entityType) {
                        "folder" -> change.entityId in pending.folders
                        "task" -> change.entityId in pending.tasks
                        "note" -> change.entityId in pending.notes
                        "taskStep" -> change.entityId in pending.taskSteps
                        "timePoint" -> change.entityId in pending.timePoints
                        "placement" -> change.entityId in pending.placements
                        "workflow" -> change.entityId in pending.workflows
                        "workflowStage" -> change.entityId in pending.workflowStages
                        "workflowTaskMembership" -> change.entityId in pending.memberships
                        "settings" -> pending.settings
                        else -> false
                    }
                    // A remote pull must never overwrite an optimistic local
                    // row whose outbox mutation has not reached a terminal
                    // server result yet. The next pull will reconcile it after
                    // the mutation is applied or explicitly blocked.
                    if (isPending) {
                        val existing = deferred[change.entityType to change.entityId]
                        if (existing == null || existing.version <= change.entityVersion) {
                            val shadow = RemoteChangeEntity(change.entityType, change.entityId,
                                change.entityVersion, api.json.encodeToString(change))
                            db.syncJournalDao().defer(shadow)
                            deferred[change.entityType to change.entityId] = shadow
                        }
                        continue
                    }
                    val snapshot = change.snapshot
                    (snapshot as? JsonObject)?.let { obj ->
                        val returnedOwner = obj["ownerId"]?.jsonPrimitive?.contentOrNull
                        require(returnedOwner == null || returnedOwner == ownerId) { "响应账户不匹配" }
                        val returnedId = obj["id"]?.jsonPrimitive?.contentOrNull
                        require(returnedId == null || returnedId == change.entityId) { "响应实体 ID 不匹配" }
                    }
                    if (snapshot == null || change.operation == "delete") {
                        when (change.entityType) {
                            "folder" -> db.folderDao().getById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.folderDao().upsert(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "task" -> db.taskDao().getTaskByIdIncludingDeleted(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.taskDao().upsertTask(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "note" -> db.noteDao().getById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.noteDao().upsertNote(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "taskStep" -> db.taskStepDao().getById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.taskStepDao().upsert(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "timePoint" -> db.timePointDao().getTimePointByIdIncludingDeleted(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.timePointDao().upsertTimePoint(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "placement" -> db.placementDao().getById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.placementDao().upsertPlacement(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            // Tombstone the existing row instead of fabricating an
                            // empty "deleted" stub, which used to show up in the
                            // workflow list as a nameless entry.
                            "workflow" -> db.workflowDao().getWorkflowById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.workflowDao().upsertWorkflow(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false))
                                }
                            }
                            "workflowStage" -> db.workflowDao().getStageById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.workflowDao().upsertStages(listOf(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false)))
                                }
                            }
                            "workflowTaskMembership" -> db.workflowDao().getMembershipById(change.entityId, ownerId)?.let {
                                if (it.version <= change.entityVersion) {
                                    db.workflowDao().upsertMemberships(listOf(it.copy(deletedAt = now, version = change.entityVersion.toLong(), pendingSync = false)))
                                }
                            }
                            "archiveOperation" -> db.archiveOperationDao().getById(change.entityId, ownerId)?.let {
                                db.archiveOperationDao().upsertAll(listOf(it.copy(restoredAt = now)))
                            }
                        }
                        continue
                    }
                    when (change.entityType) {
                        "folder" -> {
                            val folder = folderEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.folderDao().getById(folder.id, ownerId)
                            if (local == null || (local.version <= folder.version && local != folder)) db.folderDao().upsert(folder)
                        }
                        "task" -> {
                            val task = treeTaskEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.taskDao().getTaskByIdIncludingDeleted(task.id, ownerId)
                            if (local == null || (local.version <= task.version && local != task)) db.taskDao().upsertTask(task)
                        }
                        "note" -> {
                            val note = noteEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.noteDao().getById(note.id, ownerId)
                            if (local == null || (local.version <= note.version && local != note)) db.noteDao().upsertNote(note)
                        }
                        "taskStep" -> {
                            val step = stepEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.taskStepDao().getById(step.id, ownerId)
                            if (local == null || (local.version <= step.version && local != step)) db.taskStepDao().upsert(step)
                        }
                        "timePoint" -> {
                            val timePoint = timePointEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.timePointDao().getTimePointByIdIncludingDeleted(timePoint.id, ownerId)
                            if (local == null || (local.version <= timePoint.version && local != timePoint)) db.timePointDao().upsertTimePoint(timePoint)
                        }
                        "placement" -> {
                            val placement = placementEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.placementDao().getById(placement.id, ownerId)
                            if (local == null || (local.version <= placement.version && local != placement)) db.placementDao().upsertPlacement(placement)
                        }
                        "workflow" -> {
                            val workflow = workflowEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.workflowDao().getWorkflowById(workflow.id, ownerId)
                            if (local == null || (local.version <= workflow.version && local != workflow)) db.workflowDao().upsertWorkflow(workflow)
                        }
                        "workflowStage" -> {
                            val stage = stageEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.workflowDao().getStageById(stage.id, ownerId)
                            if (local == null || (local.version <= stage.version && local != stage)) db.workflowDao().upsertStages(listOf(stage))
                        }
                        "workflowTaskMembership" -> {
                            val membership = membershipEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)
                            val local = db.workflowDao().getMembershipById(membership.id, ownerId)
                            if (local == null || (local.version <= membership.version && local != membership)) db.workflowDao().upsertMemberships(listOf(membership))
                        }
                        "settings" -> {
                            val settings = api.json.decodeFromJsonElement<V2SettingsDto>(snapshot)
                            if (settings.ownerId == ownerId) {
                                val local = db.settingsDao().getSettings(ownerId)
                                if (local == null || local.version <= settings.version) {
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
                                        ),
                                    )
                                }
                            }
                        }
                        "archiveOperation" -> db.archiveOperationDao().upsertAll(listOf(archiveEntity(api.json.decodeFromJsonElement(snapshot), ownerId, now)))
                    }
                }
                ensureSession()
        }
        android.util.Log.d("TaskDockSync", "stage=apply rows=${changes.size} durationMs=${(System.nanoTime() - startedAt) / 1_000_000}")
    }

    private suspend fun replayDeferred(ownerId: String) {
        db.withTransaction {
            ensureSession()
            for (item in db.syncJournalDao().deferred()) {
                if (db.syncJournalDao().guardCount(item.entityType, item.entityId) != 0) continue
                if (item.entityType == "settings" && db.outboxDao().getPendingItems(ownerId).any {
                    it.command == "settings.update" && it.lastError?.startsWith("TERMINAL:") != true }) continue
                applyV2Changes(listOf(api.json.decodeFromString<ChangeItem>(item.json)), ownerId)
                db.syncJournalDao().removeDeferred(item.entityType, item.entityId)
            }
        }
    }

    private suspend fun reconcileReturnedIds(ownerId: String, item: OutboxEntity, result: JsonElement?) {
        val obj = result as? JsonObject ?: return
        val entity = if (item.command.startsWith("placement.")) obj["placement"] as? JsonObject ?: obj else obj
        val target = entity["id"]?.jsonPrimitive?.contentOrNull ?: return
        val source = if (item.command in setOf("placement.copy", "placement.move")) {
            api.json.parseToJsonElement(item.payloadJson).jsonObject["targetPlacementId"]?.jsonPrimitive?.contentOrNull ?: return
        } else item.entityId
        if (target == source || item.command !in setOf("timePoint.date.create", "placement.create", "placement.copy", "placement.move")) return
        fun remap(value: JsonElement, reference: Boolean = false): JsonElement = when (value) {
            is JsonObject -> JsonObject(value.mapValues { (key, child) -> remap(child, key in setOf("id", "entityId", "timePointId", "targetPlacementId", "ids")) })
            is JsonArray -> JsonArray(value.map { remap(it, reference) })
            is JsonPrimitive -> if (reference && value.isString && value.content == source) JsonPrimitive(target) else value
            else -> value
        }
        if (item.command == "timePoint.date.create") {
            db.placementDao().remapDate(ownerId, source, target)
            db.timePointDao().upsertTimePoint(timePointEntity(api.json.decodeFromJsonElement(entity), ownerId, isoFormat.format(Date())))
            db.openHelper.writableDatabase.execSQL("DELETE FROM time_points WHERE id = ? AND ownerId = ?", arrayOf(source, ownerId))
        } else {
            db.placementDao().upsertPlacement(placementEntity(api.json.decodeFromJsonElement(entity), ownerId, isoFormat.format(Date())))
            db.openHelper.writableDatabase.execSQL("DELETE FROM placements WHERE id = ? AND ownerId = ?", arrayOf(source, ownerId))
        }
        db.outboxDao().getPendingItems(ownerId).filter { it.id != item.id }.forEach { pending ->
            db.outboxDao().remap(pending.id, remap(api.json.parseToJsonElement(pending.payloadJson)).toString(),
                if (pending.entityId == source) target else pending.entityId)
        }
        val type = item.command.substringBefore('.')
        db.openHelper.writableDatabase.execSQL("INSERT OR IGNORE INTO sync_guards (mutationId, entityType, entityId) SELECT mutationId, entityType, ? FROM sync_guards WHERE entityId = ? AND entityType = ?", arrayOf(target, source, type))
        db.openHelper.writableDatabase.execSQL("DELETE FROM sync_guards WHERE entityId = ? AND entityType = ?", arrayOf(source, type))
        val table = MutationGuards.tables.getValue(type)
        db.openHelper.writableDatabase.execSQL("UPDATE $table SET pendingSync = 1 WHERE id = ? AND ownerId = ?", arrayOf(target, ownerId))
    }

    private suspend fun repairProtection(ownerId: String) = db.withTransaction {
        ensureSession()
        val items = db.outboxDao().getPendingItems(ownerId)
        val tracker = MutationGuards(db, api.json)
        val tracked = db.syncJournalDao().guards().map { it.mutationId }.toSet()
        items.filter { it.mutationId !in tracked }.forEach { tracker.track(it) }
        items.filter { it.lastError?.startsWith("TERMINAL:") == true }.forEach { tracker.release(it) }
        for ((type, table) in MutationGuards.tables) {
            db.openHelper.writableDatabase.execSQL("UPDATE $table SET pendingSync = 0 WHERE ownerId = ? AND pendingSync = 1 AND NOT EXISTS (SELECT 1 FROM sync_guards WHERE entityType = ? AND entityId = $table.id)", arrayOf(ownerId, type))
        }
    }

    private suspend fun applyReturnedResult(ownerId: String, command: String, result: JsonElement?) {
        if (result == null) return
        val returned = mutableListOf<ChangeItem>()
        fun collect(type: String, value: JsonElement) {
            if (value is JsonArray) { value.forEach { collect(type, it) }; return }
            val obj = value as? JsonObject ?: return
            val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return
            val version = obj["version"]?.jsonPrimitive?.longOrNull ?: return
            if (type !in MutationGuards.tables && type != "settings") return
            returned += ChangeItem("0", type, id, version, if (obj["deletedAt"] is JsonPrimitive && obj["deletedAt"] != JsonNull) "delete" else "upsert", obj)
        }
        var primary = command.substringBefore('.')
        if (primary == "workflowTask") primary = "workflowTaskMembership"
        if (primary == "tree") primary = "task"
        collect(primary, result)
        (result as? JsonObject)?.let { obj ->
            for ((key, type) in mapOf("task" to "task", "folder" to "folder", "note" to "note", "steps" to "taskStep", "placement" to "placement", "workflow" to "workflow", "stage" to "workflowStage")) {
                obj[key]?.let { collect(type, it) }
            }
        }
        applyV2Changes(returned, ownerId)
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
        payload: Map<String, Any?>,
        ownerId: String = authManager.ownerId
            ?: throw IllegalStateException("登录状态已失效，请重新登录"),
    ) {
        require(authManager.ownerId == ownerId) { "当前账户已变化" }
        val jsonPayload = api.json.encodeToString(payload.mapValues { (_, value) -> jsonElement(value) })
        val item = OutboxEntity(
            mutationId = UUID.randomUUID().toString(),
            clientId = authManager.clientId,
            ownerId = ownerId,
            command = command,
            entityId = entityId,
            baseVersion = baseVersion,
            occurredAt = isoFormat.format(Date()),
            payloadJson = jsonPayload
        )
        db.outboxDao().insert(item)
        MutationGuards(db, api.json).track(item)
        // The outbox observer picks this up after the surrounding transaction
        // commits, so callers may record mutations from inside `withTransaction`.
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
