package com.devtodo.app.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * The date block must not stay on yesterday when the app is closed at midnight.
 * One delayed worker per day is enough; it is not a polling loop.
 */
class WidgetDayChangeWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): androidx.work.ListenableWorker.Result {
        WidgetUpdater.refreshAll(applicationContext)
        WidgetScheduler.ensureScheduled(applicationContext)
        return androidx.work.ListenableWorker.Result.success()
    }
}

object WidgetScheduler {
    private const val UNIQUE_NAME = "taskdock-widget-day-change"

    suspend fun ensureScheduled(context: Context) {
        runCatching {
            val delay = nextMidnightDelayMs(context).coerceAtLeast(60_000L)
            val request = OneTimeWorkRequestBuilder<WidgetDayChangeWorker>()
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_NAME, ExistingWorkPolicy.REPLACE, request)
        }
    }

    private suspend fun nextMidnightDelayMs(context: Context): Long {
        val repository = WidgetRepository(context)
        // Widgets render with the workspace timezone when signed in. Fall back
        // to the device timezone before login.
        val localDate = repository.todayLocalDate()
        val zone = if (localDate != null) {
            runCatching {
                val auth = com.devtodo.app.data.security.SecureAuthManager(context)
                val ownerId = auth.ownerId
                val settings = ownerId?.let { auth.scopedDatabase().settingsDao().getSettings(it) }
                java.util.TimeZone.getTimeZone(settings?.timezone ?: "Asia/Shanghai")
            }.getOrDefault(java.util.TimeZone.getDefault())
        } else {
            java.util.TimeZone.getDefault()
        }
        val calendar = Calendar.getInstance(zone)
        val next = (calendar.clone() as Calendar).apply {
            add(Calendar.DAY_OF_YEAR, 1)
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        return (next.timeInMillis - calendar.timeInMillis).coerceAtLeast(60_000L)
    }
}
