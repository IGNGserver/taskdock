package com.devtodo.app.data.sync

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.util.Base64
import androidx.room.Room
import androidx.room.withTransaction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SyncEngineTest {
    private lateinit var db: AppDatabase
    private lateinit var auth: SecureAuthManager
    private lateinit var engine: SyncEngine
    private lateinit var api: ApiClient
    private val server = MockWebServer()
    private val owner = "sync-test-owner"
    private val now = "2026-10-13T00:00:00Z"

    @Before fun setup() {
        server.start()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = UUID.randomUUID().toString()
        val isolated = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences("$prefix-$name", mode)
        }
        auth = SecureAuthManager(isolated).apply {
            hubOrigin = server.url("/").toString().trimEnd('/')
            ownerId = owner
            val payload = Base64.encodeToString("{\"exp\":${System.currentTimeMillis() / 1000 + 3600}}".toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            accessToken = "fixture.$payload.fixture"
        }
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        api = ApiClient(auth)
        engine = SyncEngine(db, api, auth)
    }
    @After fun cleanup() { engine.stop(); db.close(); server.shutdown() }
    private fun response(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
    private fun task(id: String, pending: Boolean = false) = TaskEntity(id, owner, null, null, id,
        TaskStatus.TODO, TaskCategory.MISC, TaskPriority.NONE, "1024", 1, null, now, now, pendingSync = pending)
    private fun snapshot(id: String = "hub-task") = """{"folders":[],"tasks":[{"id":"$id","referenceId":"TEST-1","title":"$id","status":"TODO","rank":"1024","version":1}],"notes":[],"taskSteps":[],"timePoints":[],"placements":[],"workflows":[],"workflowStages":[],"workflowTaskMemberships":[],"settings":{"ownerId":"$owner","timezone":"Asia/Shanghai"},"cursor":"7"}"""
    private fun taskChange(id: String) = """{"seq":"7","entityType":"task","entityId":"$id","entityVersion":1,"operation":"upsert","snapshot":{"id":"$id","referenceId":"TEST-1","title":"$id","status":"TODO","rank":"1024","version":1}}"""

    @Test fun initialHttpFailureRetriesWithoutRefreshOrRestart() = runBlocking {
        var snapshots = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v2/sync/capabilities" -> response("{}", 404)
                request.path == "/api/v2/sync/snapshot" -> if (++snapshots == 1) response("{}", 503) else response(snapshot())
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        engine.start()
        withTimeout(10_000) { db.taskDao().getTaskByIdFlow("hub-task", owner).first { it != null } }
        assertTrue(snapshots >= 2)
    }

    @Test fun pageFailurePreservesCacheAndResumesWithoutAdvancingGlobalCursor() = runBlocking {
        db.taskDao().upsertTask(task("last-good-cache"))
        var pageZero = 0; var pageOne = 0
        val id = UUID.randomUUID().toString()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v2/sync/capabilities" -> response("""{"protocolVersion":2,"pagedSnapshot":true}""")
                request.path?.startsWith("/api/v2/sync/preview") == true -> response("""{"changes":[],"complete":false}""")
                request.path == "/api/v2/sync/bootstrap" -> response("""{"snapshotId":"$id","cursor":"7","expiresAt":"2099-01-01T00:00:00Z","pageCount":2,"protocolVersion":2}""")
                request.path?.endsWith("page=0") == true -> { pageZero++; response("""{"snapshotId":"$id","cursor":"7","page":0,"pageCount":2,"nextPage":1,"protocolVersion":2,"changes":[${taskChange("first-page") }]}""") }
                request.path?.endsWith("page=1") == true -> if (++pageOne == 1) response("{}", 503) else response("""{"snapshotId":"$id","cursor":"7","page":1,"pageCount":2,"nextPage":null,"protocolVersion":2,"changes":[${taskChange("second-page") }]}""")
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        assertTrue(engine.triggerSync() is SyncOutcome.Failure)
        assertNotNull(db.taskDao().getTaskById("last-good-cache", owner))
        assertNotNull(db.taskDao().getTaskById("first-page", owner))
        assertNull(db.syncMetaDao().get("v2:sync_cursor:$owner"))
        assertEquals(SyncOutcome.Success, engine.triggerSync())
        assertEquals(1, pageZero)
        assertEquals("7", db.syncMetaDao().get("v2:sync_cursor:$owner"))
        assertNull(db.taskDao().getTaskById("last-good-cache", owner))
        assertNotNull(db.taskDao().getTaskById("second-page", owner))
    }

    @Test fun dateJoinObservesHubPlacementAndTaskUpdatesDespiteLocalDuplicate() = runBlocking {
        val date = "2026-10-13"
        db.taskDao().upsertTask(task("scheduled"))
        db.timePointDao().upsertTimePoints(listOf("local-date", "hub-date").map { TimePointEntity(it, owner,
            TimePointType.DATE, date, null, "1024", 1, null, null, now, now) })
        db.placementDao().upsertPlacement(PlacementEntity("placement", owner, "scheduled", "hub-date", "1024", 1, now, now))
        assertEquals("scheduled", db.placementDao().scheduledTasksFlow(owner, date).first().single().task.id)
        val updated = async { db.placementDao().scheduledTasksFlow(owner, date).first { it.singleOrNull()?.task?.status == TaskStatus.DONE } }
        db.taskDao().upsertTask(task("scheduled").copy(status = TaskStatus.DONE))
        assertEquals(TaskStatus.DONE, withTimeout(5_000) { updated.await() }.single().task.status)
    }

    @Test fun guardsRemainUntilLastMutationForAnEntityIsAcknowledged() = runBlocking {
        db.withTransaction {
            db.taskDao().upsertTask(task("edited", true))
            engine.recordLocalMutation("task.update", "edited", 1, mapOf("title" to "first"))
            engine.recordLocalMutation("task.update", "edited", 2, mapOf("title" to "second"))
        }
        val items = db.outboxDao().getPendingItems(owner)
        val guards = MutationGuards(db, api.json)
        db.withTransaction { guards.release(items[0]); db.outboxDao().deleteByMutationId(items[0].mutationId, owner) }
        assertTrue(db.taskDao().getTaskById("edited", owner)!!.pendingSync)
        db.withTransaction { guards.release(items[1]); db.outboxDao().deleteByMutationId(items[1].mutationId, owner) }
        assertFalse(db.taskDao().getTaskById("edited", owner)!!.pendingSync)
    }

    @Test fun incompleteLegacySnapshotCannotEraseCachedData() = runBlocking {
        db.taskDao().upsertTask(task("last-good-cache"))
        server.enqueue(response("{}", 404)); server.enqueue(response("""{"tasks":[],"cursor":"10"}"""))
        assertTrue(engine.triggerSync() is SyncOutcome.Failure)
        assertNotNull(db.taskDao().getTaskById("last-good-cache", owner))
        assertNull(db.syncMetaDao().get("v2:sync_cursor:$owner"))
    }

    @Test fun repairingLegacyProtectionDoesNotAssignUnrelatedRowsToTheFirstMutation() = runBlocking {
        db.withTransaction {
            db.taskDao().upsertTasks(listOf(task("one", true), task("two", true)))
            val first = OutboxEntity(mutationId = "first", clientId = auth.clientId, ownerId = owner, command = "task.update", entityId = "one", baseVersion = 1, payloadJson = "{\"title\":\"one\"}", occurredAt = now)
            val second = first.copy(mutationId = "second", entityId = "two")
            val guards = MutationGuards(db, api.json)
            guards.track(first); guards.track(second)
            guards.release(first)
            assertFalse(db.taskDao().getTaskById("one", owner)!!.pendingSync)
            assertTrue(db.taskDao().getTaskById("two", owner)!!.pendingSync)
        }
    }

    @Test fun incompletePushAcknowledgementPreservesAllPendingOperations() = runBlocking {
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        db.withTransaction {
            db.taskDao().upsertTask(task("edited", true))
            engine.recordLocalMutation("task.update", "edited", 1, mapOf("title" to "offline edit"))
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v2/sync/push" -> response("{\"results\":[]}")
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        assertTrue(engine.triggerSync() is SyncOutcome.Failure)
        assertEquals(1, db.outboxDao().getPendingItems(owner).size)
        assertTrue(db.taskDao().getTaskById("edited", owner)!!.pendingSync)
    }

    @Test fun sameOwnerOnDifferentHubsHasSeparateCacheWhileVerifiedAliasesShare() {
        auth.rememberHubIdentity("hub-a")
        val first = auth.databaseNamespace
        auth.hubOrigin = "https://second.test"; auth.rememberHubIdentity("hub-b")
        assertNotEquals(first, auth.databaseNamespace)
        auth.hubOrigin = "https://alias.test"; auth.rememberHubIdentity("hub-a")
        assertEquals(first, auth.databaseNamespace)
        auth.rememberHubIdentity("hub-replaced")
        assertNotEquals(first, auth.databaseNamespace)
    }

    @Test fun accountSwitchDuringHttpRequestCannotCommitOldData() = runBlocking {
        val received = CompletableDeferred<Unit>()
        val release = java.util.concurrent.CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/v2/sync/capabilities" -> response("{}", 404)
                "/api/v2/sync/snapshot" -> { received.complete(Unit); release.await(5, java.util.concurrent.TimeUnit.SECONDS); response(snapshot("stale-response")) }
                else -> response("{}", 404)
            }
        }
        val flight = async { engine.triggerSync() }
        withTimeout(5_000) { received.await() }
        auth.ownerId = "different-owner"
        release.countDown()
        try { flight.await(); fail("stale request should be cancelled") } catch (_: CancellationException) { }
        assertNull(db.taskDao().getTaskById("stale-response", owner))
    }

    @Test fun pullKeepsRemoteShadowUntilThePendingMutationIsAcknowledged() = runBlocking {
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        val mutation = db.withTransaction {
            db.taskDao().upsertTask(task("edited", true))
            engine.recordLocalMutation("task.update", "edited", 1, mapOf("title" to "offline edit"))
            db.outboxDao().getPendingItems(owner).single()
        }
        var pushes = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v2/sync/push" -> if (++pushes == 1) response("{}", 503)
                    else response("""{"results":[{"mutationId":"${mutation.mutationId}","status":"applied","result":{"id":"edited","referenceId":"TEST-1","title":"confirmed edit","status":"TODO","rank":"1024","version":2}}]}""")
                request.path?.contains("cursor=1&") == true -> response("""{"nextCursor":"7","changes":[${taskChange("edited")}],"hasMore":false}""")
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        assertTrue(engine.triggerSync() is SyncOutcome.Failure)
        assertEquals(1, db.syncJournalDao().deferred().size)
        assertTrue(db.taskDao().getTaskById("edited", owner)!!.pendingSync)
        assertEquals("7", db.syncMetaDao().get("v2:sync_cursor:$owner"))
        assertEquals(SyncOutcome.Success, engine.triggerSync())
        assertEquals("confirmed edit", db.taskDao().getTaskById("edited", owner)!!.title)
        assertTrue(db.syncJournalDao().deferred().isEmpty())
    }

    @Test fun boundedRefreshPreservesCacheAndDoesNotConfirmAnUnansweredRequest() = runBlocking {
        engine.stop()
        engine = SyncEngine(db, api, auth, syncBudgetMs = 250)
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        db.taskDao().upsertTask(task("cached"))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
        }
        val result = withTimeout(5_000) { engine.triggerSync() }
        assertTrue(result is SyncOutcome.Failure)
        assertEquals(SyncState.ERROR, engine.syncState.value)
        assertNotNull(db.taskDao().getTaskById("cached", owner))
        assertNull(db.syncMetaDao().get("confirmed:$owner"))
    }

    @Test fun expiredCursorRecoversThroughPagesWithoutDownloadingLegacySnapshot() = runBlocking {
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        db.taskDao().upsertTask(task("deleted-on-hub"))
        val id = UUID.randomUUID().toString()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.contains("cursor=1&") == true -> response("""{"code":"SYNC_CURSOR_EXPIRED","message":"expired"}""", 410)
                request.path == "/api/v2/sync/capabilities" -> response("""{"protocolVersion":2,"pagedSnapshot":true}""")
                request.path?.startsWith("/api/v2/sync/preview") == true -> response("""{"changes":[],"complete":false}""")
                request.path == "/api/v2/sync/bootstrap" -> response("""{"snapshotId":"$id","cursor":"7","expiresAt":"2099-01-01T00:00:00Z","pageCount":1,"protocolVersion":2}""")
                request.path?.endsWith("page=0") == true -> response("""{"snapshotId":"$id","cursor":"7","page":0,"pageCount":1,"nextPage":null,"protocolVersion":2,"changes":[${taskChange("current")}]}""")
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 500)
            }
        }
        assertEquals(SyncOutcome.Success, engine.triggerSync())
        assertNull(db.taskDao().getTaskById("deleted-on-hub", owner))
        assertNotNull(db.taskDao().getTaskById("current", owner))
        assertNotNull(db.syncMetaDao().get("confirmed:$owner"))
    }

    @Test fun revokedSessionCannotLeaveTheEngineSpinning() = runBlocking {
        auth.clearSession()
        try { engine.triggerSync(); fail("revoked session should cancel the old engine") }
        catch (_: CancellationException) { }
        assertEquals(SyncState.AUTH_REQUIRED, engine.syncState.value)
    }

    @Test fun missedSocketNotificationIsRecoveredByForegroundVerification() = runBlocking {
        engine.stop()
        engine = SyncEngine(db, api, auth, verificationIntervalMs = 200)
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        val publish = java.util.concurrent.atomic.AtomicBoolean(false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.startsWith("/api/v2/sync/pull") == true -> if (publish.get())
                    response("""{"nextCursor":"7","changes":[${taskChange("missed-notification")}],"hasMore":false}""")
                    else response("""{"nextCursor":"1","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        engine.setForeground(true)
        engine.start()
        withTimeout(5_000) { db.syncMetaDao().observe("confirmed:$owner").first { it != null } }
        publish.set(true)
        withTimeout(5_000) { db.taskDao().getTaskByIdFlow("missed-notification", owner).first { it != null } }
        engine.setForeground(false)
    }

    @Test fun remoteChangesAreVisibleBeforeASlowUploadFinishes() = runBlocking {
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        db.withTransaction {
            db.taskDao().upsertTask(task("local-edit", true))
            engine.recordLocalMutation("task.update", "local-edit", 1, mapOf("title" to "draft"))
        }
        val uploading = CompletableDeferred<Unit>()
        val release = java.util.concurrent.CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[${taskChange("remote-first")}],"hasMore":false}""")
                request.path == "/api/v2/sync/push" -> { uploading.complete(Unit); release.await(5, java.util.concurrent.TimeUnit.SECONDS); response("{}", 503) }
                else -> response("{}", 404)
            }
        }
        val flight = async { engine.triggerSync() }
        try {
            withTimeout(5_000) { uploading.await() }
            assertNotNull(db.taskDao().getTaskById("remote-first", owner))
            assertTrue(db.taskDao().getTaskById("local-edit", owner)!!.pendingSync)
        } finally { release.countDown() }
        assertTrue(flight.await() is SyncOutcome.Failure)
    }

    @Test fun returnedDateIdentityRewritesDependentPlacementsAndOutbox() = runBlocking {
        db.syncMetaDao().set(SyncMetaEntity("v2:sync_cursor:$owner", "1"))
        db.withTransaction {
            db.timePointDao().upsertTimePoint(TimePointEntity("local-date", owner, TimePointType.DATE,
                "2026-10-13", null, "1024", 1, null, null, now, now, pendingSync = true))
            engine.recordLocalMutation("timePoint.date.create", "local-date", null, mapOf("localDate" to "2026-10-13"))
            db.placementDao().upsertPlacement(PlacementEntity("local-placement", owner, "scheduled", "local-date", "1024", 1, now, now, pendingSync = true))
            engine.recordLocalMutation("placement.create", "local-placement", null, mapOf("taskId" to "scheduled", "timePointId" to "local-date"))
        }
        var requests = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v2/sync/push" -> {
                    val body = api.json.parseToJsonElement(request.body.readUtf8()).jsonObject
                    val item = body.getValue("mutations").jsonArray.single().jsonObject
                    val mutationId = item.getValue("mutationId").jsonPrimitive.content
                    if (++requests == 1) response("""{"results":[{"mutationId":"$mutationId","status":"applied","result":{"id":"hub-date","type":"DATE","localDate":"2026-10-13","rank":"1024","version":1}}]}""")
                    else {
                        assertEquals("hub-date", item.getValue("payload").jsonObject.getValue("timePointId").jsonPrimitive.content)
                        response("""{"results":[{"mutationId":"$mutationId","status":"applied","result":{"id":"local-placement","taskId":"scheduled","timePointId":"hub-date","rank":"1024","version":1}}]}""")
                    }
                }
                request.path?.startsWith("/api/v2/sync/pull") == true -> response("""{"nextCursor":"7","changes":[],"hasMore":false}""")
                else -> response("{}", 404)
            }
        }
        assertEquals(SyncOutcome.Success, engine.triggerSync())
        assertNull(db.timePointDao().getTimePointByIdIncludingDeleted("local-date", owner))
        assertEquals("hub-date", db.placementDao().getById("local-placement", owner)!!.timePointId)
        assertTrue(db.outboxDao().getPendingItems(owner).isEmpty())
    }
}
