package com.devtodo.app.widget

import android.content.Context
import com.devtodo.app.data.local.AppDatabase
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A deliberately small read model for home-screen widgets.
 *
 * Widgets must never invent fields or percentages. Everything here is derived
 * from the same entities and date/placement rules the app itself renders.
 */
data class WidgetTask(
    val id: String,
    val title: String,
    val status: TaskStatus,
    val folderTitle: String? = null,
) {
    val isDone: Boolean get() = status == TaskStatus.DONE
    val isInProgress: Boolean get() = status == TaskStatus.IN_PROGRESS
}

data class TodayWidgetState(
    val signedIn: Boolean,
    val dayNumber: String = "",
    val monthLabel: String = "",
    val weekdayLabel: String = "",
    val dateLabel: String = "",
    val localDate: String = "",
    val total: Int = 0,
    val done: Int = 0,
    val tasks: List<WidgetTask> = emptyList(),
    val pendingSync: Boolean = false,
) {
    val remaining: Int get() = (total - done).coerceAtLeast(0)
    val progress: Float get() = if (total <= 0) 0f else done.toFloat() / total
}

data class OpenWidgetState(
    val signedIn: Boolean,
    val total: Int = 0,
    val tasks: List<WidgetTask> = emptyList(),
    val recentDone: WidgetTask? = null,
    val pendingSync: Boolean = false,
)

data class NextWidgetState(
    val signedIn: Boolean,
    val task: WidgetTask? = null,
    val sourceLabel: String = "",
    val pendingSync: Boolean = false,
)

data class FolderWidgetState(
    val signedIn: Boolean,
    val configured: Boolean = false,
    val folderId: String? = null,
    val folderTitle: String? = null,
    val total: Int = 0,
    val tasks: List<WidgetTask> = emptyList(),
    val pendingSync: Boolean = false,
)

data class WidgetFolderOption(
    val id: String?,
    val title: String,
    val path: String,
    val openCount: Int,
)

internal data class WidgetSession(
    val auth: SecureAuthManager,
    val db: AppDatabase,
    val ownerId: String,
    val timezone: TimeZone,
    val today: String,
    val foldersById: Map<String, FolderEntity>,
)

class WidgetRepository(context: Context) {
    private val appContext = context.applicationContext

    suspend fun loadToday(): TodayWidgetState = withContext(Dispatchers.IO) {
        val session = session()
            ?: return@withContext TodayWidgetState(signedIn = false)
        val rows = session.db.placementDao().scheduledTasks(session.ownerId, session.today)
        val placed = rows.map { row ->
            row.toWidgetTask(session.foldersById, session.auth.widgetHideTitles)
        }
        // Keep the user's placement order inside each status group instead of
        // re-sorting titles alphabetically.
        val tasks = placed.filter { it.isInProgress } +
            placed.filter { it.status == TaskStatus.TODO } +
            placed.filter { it.isDone }
        val done = tasks.count { it.isDone }
        val calendar = Calendar.getInstance(session.timezone)
        val month = format(calendar.time, "M月", session.timezone)
        val day = format(calendar.time, "d", session.timezone)
        val weekday = format(calendar.time, "EEE", session.timezone)
        TodayWidgetState(
            signedIn = true,
            dayNumber = day,
            monthLabel = month,
            weekdayLabel = weekday,
            dateLabel = "$month${day}日 · $weekday",
            localDate = session.today,
            total = tasks.size,
            done = done,
            tasks = tasks,
            pendingSync = session.db.outboxDao().countPending(session.ownerId) > 0,
        )
    }

    suspend fun todayLocalDate(): String? = withContext(Dispatchers.IO) {
        session()?.today
    }

    suspend fun loadOpen(): OpenWidgetState = withContext(Dispatchers.IO) {
        val session = session()
            ?: return@withContext OpenWidgetState(signedIn = false)
        val recentSince = format(Date(System.currentTimeMillis() - RECENT_DONE_WINDOW_MS), ISO_PATTERN)
        OpenWidgetState(
            signedIn = true,
            total = session.db.taskDao().countOpenTasks(session.ownerId),
            tasks = session.db.taskDao().getOpenTasks(session.ownerId, WIDGET_ROW_LIMIT)
                .map { it.toWidgetTask(session.foldersById, session.auth.widgetHideTitles) },
            recentDone = session.db.taskDao()
                .getRecentlyCompleted(session.ownerId, recentSince, 1)
                .firstOrNull()
                ?.toWidgetTask(session.foldersById, session.auth.widgetHideTitles),
            pendingSync = session.db.outboxDao().countPending(session.ownerId) > 0,
        )
    }

    suspend fun loadNext(): NextWidgetState = withContext(Dispatchers.IO) {
        val session = session()
            ?: return@withContext NextWidgetState(signedIn = false)
        val todayRows = session.db.placementDao().scheduledTasks(session.ownerId, session.today)
        val todayTasks = todayRows.map { row ->
            row.toWidgetTask(session.foldersById, session.auth.widgetHideTitles)
        }
        val todayTask = todayTasks.firstOrNull { it.isInProgress }
            ?: todayTasks.firstOrNull { it.status == TaskStatus.TODO }
        val fallback = if (todayTask == null) {
            session.db.taskDao().getOpenTasks(session.ownerId, 1)
                .firstOrNull()
                ?.toWidgetTask(session.foldersById, session.auth.widgetHideTitles)
        } else {
            null
        }
        NextWidgetState(
            signedIn = true,
            task = todayTask ?: fallback,
            sourceLabel = if (todayTask != null) "今天" else "待办",
            pendingSync = session.db.outboxDao().countPending(session.ownerId) > 0,
        )
    }

    suspend fun loadFolder(folderId: String?): FolderWidgetState = withContext(Dispatchers.IO) {
        val session = session()
            ?: return@withContext FolderWidgetState(signedIn = false)
        val folder = folderId?.let { session.db.folderDao().getById(it, session.ownerId) }
        if (folderId != null && (folder == null || folder.deletedAt != null || folder.archivedAt != null)) {
            return@withContext FolderWidgetState(
                signedIn = true,
                configured = false,
                folderId = folderId,
                folderTitle = null,
            )
        }
        val title = folder?.title ?: "根目录"
        FolderWidgetState(
            signedIn = true,
            configured = true,
            folderId = folderId,
            folderTitle = title,
            total = session.db.taskDao().countOpenTasksInFolder(session.ownerId, folderId),
            tasks = session.db.taskDao().getOpenTasksInFolder(session.ownerId, folderId, WIDGET_ROW_LIMIT)
                .map { it.toWidgetTask(session.foldersById, session.auth.widgetHideTitles) },
            pendingSync = session.db.outboxDao().countPending(session.ownerId) > 0,
        )
    }

    suspend fun loadFolderOptions(): List<WidgetFolderOption> = withContext(Dispatchers.IO) {
        runCatching {
            val auth = SecureAuthManager(appContext)
            if (!auth.isLoggedIn) return@runCatching emptyList()
            val ownerId = auth.ownerId?.takeIf { it.isNotBlank() } ?: return@runCatching emptyList()
            val db = auth.scopedDatabase()
            val folders = db.folderDao().getAll(ownerId)
            val byId = folders.associateBy { it.id }
            val options = ArrayList<WidgetFolderOption>()
            options += WidgetFolderOption(
                id = null,
                title = "根目录",
                path = "根目录",
                openCount = db.taskDao().countOpenTasksInFolder(ownerId, null),
            )
            options += folders
                .filter { it.deletedAt == null && it.archivedAt == null }
                .sortedBy { it.title.lowercase(Locale.ROOT) }
                .map { folder ->
                    WidgetFolderOption(
                        id = folder.id,
                        title = folder.title,
                        path = folderPath(folder, byId),
                        openCount = db.taskDao().countOpenTasksInFolder(ownerId, folder.id),
                    )
                }
            options
        }.getOrDefault(emptyList())
    }

    private suspend fun session(): WidgetSession? = runCatching {
        val auth = SecureAuthManager(appContext)
        if (!auth.isLoggedIn) return@runCatching null
        val ownerId = auth.ownerId?.takeIf { it.isNotBlank() } ?: return@runCatching null
        val db = auth.scopedDatabase()
        val settings = db.settingsDao().getSettings(ownerId)
        val timezone = runCatching {
            TimeZone.getTimeZone(settings?.timezone ?: DEFAULT_TIMEZONE)
        }.getOrDefault(TimeZone.getTimeZone(DEFAULT_TIMEZONE))
        val now = Calendar.getInstance(timezone).time
        val today = format(now, DATE_PATTERN, timezone)
        val folders = db.folderDao().getAll(ownerId)
            .filter { it.deletedAt == null && it.archivedAt == null }
            .associateBy { it.id }
        WidgetSession(auth, db, ownerId, timezone, today, folders)
    }.getOrNull()

    private fun folderPath(folder: FolderEntity, byId: Map<String, FolderEntity>): String {
        val parts = ArrayDeque<String>()
        var current: FolderEntity? = folder
        var guard = 0
        while (current != null && guard++ < 32) {
            parts.addFirst(current.title)
            current = current.parentFolderId?.let(byId::get)
        }
        return parts.joinToString(" / ")
    }

    private fun format(date: Date, pattern: String, timeZone: TimeZone = TimeZone.getDefault()): String =
        SimpleDateFormat(pattern, Locale.CHINESE).apply { this.timeZone = timeZone }.format(date)

    private fun com.devtodo.app.data.local.ScheduledTaskRow.toWidgetTask(
        foldersById: Map<String, FolderEntity>,
        hideTitles: Boolean,
    ): WidgetTask = task.toWidgetTask(foldersById, hideTitles)

    private fun TaskEntity.toWidgetTask(
        foldersById: Map<String, FolderEntity>,
        hideTitles: Boolean,
    ): WidgetTask =
        WidgetTask(
            id = id,
            title = if (hideTitles) "已隐藏任务" else title,
            status = status,
            folderTitle = parentFolderId?.let { foldersById[it]?.title },
        )

    companion object {
        const val WIDGET_ROW_LIMIT = 8
        private const val DEFAULT_TIMEZONE = "Asia/Shanghai"
        private const val DATE_PATTERN = "yyyy-MM-dd"
        private const val ISO_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        private const val RECENT_DONE_WINDOW_MS = 10 * 60 * 1000L
    }
}
