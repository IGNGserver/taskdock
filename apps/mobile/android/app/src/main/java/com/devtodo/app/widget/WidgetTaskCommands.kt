package com.devtodo.app.widget

import android.content.Context
import androidx.room.withTransaction
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.ListenableWorker
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.devtodo.app.data.local.NoteEntity
import com.devtodo.app.data.local.PlacementEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TaskCategory
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.data.sync.SyncOutcome
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * The widget writes through the same local-first contract as the app: mutate
 * Room in one transaction, record an outbox mutation, then let a single
 * background worker reconcile with the Hub.
 *
 * This deliberately does not depend on MainViewModel: a widget action can
 * arrive while the activity (and its ViewModel) is gone.
 */
class WidgetTaskCommands(context: Context) {
    private val appContext = context.applicationContext
    private val auth = SecureAuthManager(appContext)
    private val db by lazy { auth.scopedDatabase() }
    private val api by lazy { ApiClient(auth) }
    private val recorder by lazy { SyncEngine(db, api, auth) }

    suspend fun toggleDone(taskId: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            require(auth.isLoggedIn) { "登录已失效，请打开 TaskDock 重新登录" }
            val ownerId = auth.ownerId?.takeIf { it.isNotBlank() }
                ?: error("账户信息不可用，请重新登录")
            db.withTransaction {
                val current = db.taskDao().getTaskById(taskId, ownerId)
                    ?: error("任务已不存在")
                val nextStatus = if (current.status == TaskStatus.DONE) TaskStatus.TODO else TaskStatus.DONE
                val now = nowIso()
                db.taskDao().upsertTask(
                    current.copy(
                        status = nextStatus,
                        version = current.version + 1,
                        completedAt = if (nextStatus == TaskStatus.DONE) now else null,
                        updatedAt = now,
                        pendingSync = true,
                    )
                )
                recorder.recordLocalMutation(
                    command = "task.update",
                    entityId = current.id,
                    baseVersion = current.version,
                    payload = mapOf("status" to nextStatus.name),
                    ownerId = ownerId,
                )
                require(auth.ownerId == ownerId) { "当前账户已变化" }
            }
            WidgetUpdater.refreshAll(appContext)
            WidgetSyncWorker.enqueue(appContext)
        }
    }

    suspend fun capture(
        title: String,
        parentFolderId: String?,
        localDate: String?,
    ): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            require(auth.isLoggedIn) { "登录已失效，请打开 TaskDock 重新登录" }
            val ownerId = auth.ownerId?.takeIf { it.isNotBlank() }
                ?: error("账户信息不可用，请重新登录")
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
                require(format.format(format.parse(localDate) ?: error("日期无效")) == localDate) {
                    "日期无效"
                }
            }

            val taskId = UUID.randomUUID().toString()
            val noteId = UUID.randomUUID().toString()
            db.withTransaction {
                val now = nowIso()
                val rank = ((db.taskDao().getAllTreeTasks(ownerId).filter {
                    it.parentFolderId == parentFolderId && it.status == TaskStatus.TODO &&
                        it.archivedAt == null && it.deletedAt == null
                }.maxOfOrNull { it.rank.toLongOrNull() ?: 0L } ?: 0L) + 1024L).toString()
                db.taskDao().upsertTask(
                    TaskEntity(
                        id = taskId,
                        ownerId = ownerId,
                        projectId = null,
                        referenceId = null,
                        title = normalized,
                        status = TaskStatus.TODO,
                        category = TaskCategory.MISC,
                        priority = TaskPriority.NONE,
                        rank = rank,
                        version = 1,
                        archivedAt = null,
                        createdAt = now,
                        updatedAt = now,
                        parentFolderId = parentFolderId,
                        pendingSync = true,
                    )
                )
                db.noteDao().upsertNote(
                    NoteEntity(
                        id = noteId,
                        ownerId = ownerId,
                        taskId = taskId,
                        contentMarkdown = "",
                        version = 1,
                        createdAt = now,
                        updatedAt = now,
                        pendingSync = true,
                    )
                )
                recorder.recordLocalMutation(
                    command = "task.create",
                    entityId = taskId,
                    baseVersion = null,
                    payload = mapOf(
                        "parentFolderId" to parentFolderId,
                        "title" to normalized,
                        "noteId" to noteId,
                    ),
                    ownerId = ownerId,
                )

                val point = localDate?.let { datePoint(ownerId, it) }
                if (point != null) {
                    val placementId = UUID.randomUUID().toString()
                    db.placementDao().upsertPlacement(
                        PlacementEntity(
                            id = placementId,
                            ownerId = ownerId,
                            taskId = taskId,
                            timePointId = point.id,
                            rank = "1024",
                            version = 1,
                            createdAt = now,
                            updatedAt = now,
                            pendingSync = true,
                        )
                    )
                    recorder.recordLocalMutation(
                        command = "placement.create",
                        entityId = placementId,
                        baseVersion = null,
                        payload = mapOf(
                            "taskId" to taskId,
                            "timePointId" to point.id,
                            "__localId" to placementId,
                        ),
                        ownerId = ownerId,
                    )
                }
                require(auth.ownerId == ownerId) { "当前账户已变化" }
            }
            WidgetUpdater.refreshAll(appContext)
            WidgetSyncWorker.enqueue(appContext)
            taskId
        }
    }

    private suspend fun datePoint(ownerId: String, localDate: String): TimePointEntity {
        db.timePointDao().getTimePointByDate(ownerId, localDate)?.let { return it }
        val now = nowIso()
        val point = TimePointEntity(
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
            pendingSync = true,
        )
        db.timePointDao().upsertTimePoint(point)
        recorder.recordLocalMutation(
            command = "timePoint.date.create",
            entityId = point.id,
            baseVersion = null,
            payload = mapOf("localDate" to localDate),
            ownerId = ownerId,
        )
        return point
    }

    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date())
}

class WidgetSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): ListenableWorker.Result {
        val auth = SecureAuthManager(applicationContext)
        if (!auth.isLoggedIn || auth.ownerId.isNullOrBlank()) return ListenableWorker.Result.success()
        val db = auth.scopedDatabase()
        val api = ApiClient(auth)
        val engine = SyncEngine(db, api, auth)
        return try {
            engine.setNetworkAvailable(true)
            engine.triggerSync()
            WidgetUpdater.refreshAll(applicationContext)
            ListenableWorker.Result.success()
        } catch (_: Exception) {
            // Keep the outbox durable. The next app foreground or widget tap
            // will try again; a periodic retry storm is worse for a personal
            // task list than a delayed sync.
            ListenableWorker.Result.success()
        } finally {
            engine.stop()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "taskdock-widget-sync"

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<WidgetSyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
