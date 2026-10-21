package com.devtodo.app.data.local

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.devtodo.app.data.model.TaskCategory
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WidgetDaoTest {
    private lateinit var db: AppDatabase
    private val owner = "widget-owner"
    private val now = "2026-10-21T09:00:00.000Z"

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun widgetQueriesRespectOwnershipArchiveAndCompletion() = runBlocking {
        db.folderDao().upsert(
            FolderEntity(
                id = "f1", ownerId = owner, parentFolderId = null, title = "工作",
                rank = "1024", version = 1, archivedAt = null,
                createdAt = now, updatedAt = now,
            )
        )
        db.taskDao().upsertTasks(
            listOf(
                task("t1", "进行中", TaskStatus.IN_PROGRESS, rank = "1024"),
                task("t2", "目录待办", TaskStatus.TODO, folder = "f1", rank = "2048"),
                task("t3", "根待办", TaskStatus.TODO, rank = "3072"),
                task("t4", "刚完成", TaskStatus.DONE, folder = "f1", rank = "4096",
                    completedAt = "2026-10-21T10:00:00.000Z"),
                task("t5", "已归档", TaskStatus.TODO, rank = "5120", archivedAt = now),
                task("t6", "已删除", TaskStatus.TODO, rank = "6144", deletedAt = now),
            )
        )
        db.timePointDao().upsertTimePoint(
            TimePointEntity(
                id = "p1", ownerId = owner, type = TimePointType.DATE,
                localDate = "2026-10-21", title = null, rank = "1000", version = 1,
                reachedAt = null, archivedAt = null, createdAt = now, updatedAt = now,
            )
        )
        db.placementDao().upsertPlacements(
            listOf(
                placement("pl1", "t1", "1024"),
                placement("pl2", "t2", "512"),
                placement("pl3", "t4", "2048"),
            )
        )
        db.outboxDao().insert(
            OutboxEntity(
                mutationId = "m1", clientId = "c1", ownerId = owner,
                command = "task.update", entityId = "t1", baseVersion = 1,
                occurredAt = now, payloadJson = "{}",
            )
        )

        val today = db.placementDao().scheduledTasks(owner, "2026-10-21")
        assertEquals(listOf("t2", "t1", "t4"), today.map { it.task.id })

        val open = db.taskDao().getOpenTasks(owner, 10)
        assertEquals(listOf("t1", "t2", "t3"), open.map { it.id })
        assertEquals(3, db.taskDao().countOpenTasks(owner))

        val recent = db.taskDao().getRecentlyCompleted(owner, "2026-10-21T00:00:00.000Z", 5)
        assertEquals(listOf("t4"), recent.map { it.id })

        val folder = db.taskDao().getOpenTasksInFolder(owner, "f1", 10)
        assertEquals(listOf("t2"), folder.map { it.id })
        assertEquals(1, db.taskDao().countOpenTasksInFolder(owner, "f1"))

        val root = db.taskDao().getOpenTasksInFolder(owner, null, 10)
        assertEquals(listOf("t1", "t3"), root.map { it.id })
        assertEquals(2, db.taskDao().countOpenTasksInFolder(owner, null))

        assertEquals(1, db.outboxDao().countPending(owner))
    }

    private fun task(
        id: String,
        title: String,
        status: TaskStatus,
        folder: String? = null,
        rank: String,
        completedAt: String? = null,
        archivedAt: String? = null,
        deletedAt: String? = null,
    ) = TaskEntity(
        id = id,
        ownerId = owner,
        projectId = null,
        referenceId = null,
        title = title,
        status = status,
        category = TaskCategory.MISC,
        priority = TaskPriority.NONE,
        rank = rank,
        version = 1,
        archivedAt = archivedAt,
        createdAt = now,
        updatedAt = now,
        parentFolderId = folder,
        completedAt = completedAt,
        deletedAt = deletedAt,
    )

    private fun placement(id: String, taskId: String, rank: String) = PlacementEntity(
        id = id,
        ownerId = owner,
        taskId = taskId,
        timePointId = "p1",
        rank = rank,
        version = 1,
        createdAt = now,
        updatedAt = now,
    )
}
