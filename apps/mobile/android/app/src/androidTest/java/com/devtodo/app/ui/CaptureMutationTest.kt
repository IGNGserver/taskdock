package com.devtodo.app.ui

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.lifecycle.ViewModelStore
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.ui.screens.MainViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** Tests use a private offline Room database and never touch an account's actual data. */
@RunWith(AndroidJUnit4::class)
class CaptureMutationTest {
    private lateinit var db: AppDatabase
    private lateinit var vm: MainViewModel
    private lateinit var auth: SecureAuthManager
    private val store = ViewModelStore()
    private val owner = "capture-owner"
    private val now = "2026-10-02T10:00:00Z"

    @Before fun setUp() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = "capture-test-${UUID.randomUUID()}-"
        val isolated = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences(prefix + name, mode)
        }
        auth = SecureAuthManager(isolated).apply { ownerId = owner }
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        withContext(Dispatchers.Main) {
            val api = ApiClient(auth)
            val engine = SyncEngine(db, api, auth).apply { setNetworkAvailable(false) }
            vm = MainViewModel(db, engine, auth, api)
            store.put("capture", vm)
        }
    }

    @After fun tearDown() = runBlocking {
        withContext(Dispatchers.Main) { vm.onLoggedOut(); store.clear() }
        db.close()
    }

    private fun task(status: TaskStatus = TaskStatus.IN_PROGRESS) = TaskEntity(
        "capture-task", owner, null, null, "已有任务", status, TaskCategory.MISC,
        TaskPriority.NONE, "1024", 1, null, now, now,
    )

    private fun point(id: String, date: String) = TimePointEntity(id, owner, TimePointType.DATE, date,
        null, "1024", 1, null, null, now, now)

    private suspend fun capture(folder: String?, title: String, date: String?, event: String? = null): String? {
        val result = CompletableDeferred<String?>()
        withContext(Dispatchers.Main) { vm.captureTaskV2(folder, title, date, { result.complete(it) }, event) }
        return withTimeout(10_000) { result.await() }
    }

    @Test fun captureAcknowledgesDurableTaskNotePlacementAndOutbox() = runBlocking {
        db.folderDao().upsert(FolderEntity("capture-folder", owner, null, "工作", "1024", 1, null, null, now, now))
        assertNull(capture("capture-folder", "  完成发布检查  ", "2026-10-04"))
        val created = db.taskDao().getAllTreeTasks(owner).single()
        assertEquals("完成发布检查", created.title)
        assertEquals("capture-folder", created.parentFolderId)
        assertEquals(TaskStatus.TODO, created.status)
        assertNotNull(db.noteDao().getNoteByTaskId(created.id, owner))
        val placement = db.placementDao().getPlacementsByTaskIdForOwner(owner, created.id).single()
        assertEquals("2026-10-04", db.timePointDao().getTimePointById(placement.timePointId, owner)?.localDate)
        val outbox = db.outboxDao().getPendingItems(owner)
        assertEquals(1, outbox.count { it.command == "task.create" && it.entityId == created.id })
        assertEquals(1, outbox.count { it.command == "placement.create" && it.entityId == placement.id })
    }

    @Test fun lateCaptureFailureRollsBackTaskNoteAndOutbox() = runBlocking {
        assertNotNull(capture(null, "不能丢掉的草稿", null, event = "missing-event"))
        assertTrue(db.taskDao().getAllTreeTasks(owner).isEmpty())
        assertTrue(db.outboxDao().getPendingItems(owner).isEmpty())
        db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM notes").use { cursor ->
            assertTrue(cursor.moveToFirst()); assertEquals(0, cursor.getInt(0))
        }
    }

    @Test fun invalidOwnerOrFolderAcknowledgesFailureWithoutCreatingAnything() = runBlocking {
        assertNotNull(capture("missing-folder", "保留草稿", "2026-10-04"))
        assertTrue(db.taskDao().getAllTreeTasks(owner).isEmpty())
        auth.ownerId = null
        assertNotNull(capture(null, "仍然保留草稿", null))
        assertTrue(db.taskDao().getAllTreeTasks(owner).isEmpty())
    }

    @Test fun statusAndUndoKeepEveryDatePlacement() = runBlocking {
        val current = task()
        db.taskDao().upsertTask(current)
        db.timePointDao().upsertTimePoints(listOf(point("first-date", "2026-10-03"), point("second-date", "2026-10-04")))
        val placements = listOf(
            PlacementEntity("first-placement", owner, current.id, "first-date", "1024", 1, now, now),
            PlacementEntity("second-placement", owner, current.id, "second-date", "1024", 1, now, now),
        )
        db.placementDao().upsertPlacements(placements)
        val event = async(start = CoroutineStart.UNDISPATCHED) { vm.statusChanges.first() }
        withContext(Dispatchers.Main) { vm.updateTaskStatus(current, TaskStatus.DONE) }
        val change = withTimeout(10_000) { event.await() }
        assertEquals(TaskStatus.DONE, db.taskDao().getTaskById(current.id, owner)?.status)
        val undone = async(start = CoroutineStart.UNDISPATCHED) { vm.messages.first { it == "已撤销状态修改" } }
        withContext(Dispatchers.Main) { vm.undoTaskStatus(change) }
        withTimeout(10_000) { undone.await() }
        assertEquals(TaskStatus.IN_PROGRESS, db.taskDao().getTaskById(current.id, owner)?.status)
        assertEquals(placements.toSet(), db.placementDao().getPlacementsByTaskIdForOwner(owner, current.id).toSet())
        assertEquals(2, db.outboxDao().getPendingItems(owner).count { it.command == "task.update" })
    }

    @Test fun staleUndoCannotOverwriteNewerTaskChanges() = runBlocking {
        val current = task()
        db.taskDao().upsertTask(current)
        val event = async(start = CoroutineStart.UNDISPATCHED) { vm.statusChanges.first() }
        withContext(Dispatchers.Main) { vm.updateTaskStatus(current, TaskStatus.DONE) }
        val change = withTimeout(10_000) { event.await() }
        val saved = db.taskDao().getTaskById(current.id, owner)!!
        db.taskDao().upsertTask(saved.copy(title = "新的修改", version = saved.version + 1))
        val failed = async(start = CoroutineStart.UNDISPATCHED) { vm.messages.first { it.contains("已有新变化") } }
        withContext(Dispatchers.Main) { vm.undoTaskStatus(change) }
        withTimeout(10_000) { failed.await() }
        assertEquals(TaskStatus.DONE, db.taskDao().getTaskById(current.id, owner)?.status)
        assertEquals("新的修改", db.taskDao().getTaskById(current.id, owner)?.title)
        assertEquals(1, db.outboxDao().getPendingItems(owner).count { it.command == "task.update" })
    }

    @Test fun addingExistingTaskToDateKeepsStatusAndPreviousArrangement() = runBlocking {
        val current = task()
        db.taskDao().upsertTask(current)
        db.timePointDao().upsertTimePoint(point("first-date", "2026-10-03"))
        db.placementDao().upsertPlacement(PlacementEntity("first-placement", owner, current.id, "first-date", "1024", 1, now, now))
        val result = CompletableDeferred<String?>()
        withContext(Dispatchers.Main) { vm.scheduleTask(current, "2026-10-04", copy = true, onComplete = { result.complete(it) }) }
        assertNull(withTimeout(10_000) { result.await() })
        assertEquals(TaskStatus.IN_PROGRESS, db.taskDao().getTaskById(current.id, owner)?.status)
        assertEquals(2, db.placementDao().getPlacementsByTaskIdForOwner(owner, current.id).size)
        assertTrue(db.outboxDao().getPendingItems(owner).none { it.command == "task.update" || it.command == "placement.remove" })
    }
}
