package com.devtodo.app.widget

import android.content.Context
import android.content.Intent
import com.devtodo.app.MainActivity

enum class WidgetDestination {
    TODAY,
    TASK,
    FOLDER,
}

data class WidgetNavigation(
    val requestId: Long,
    val destination: WidgetDestination,
    val taskId: String? = null,
    val folderId: String? = null,
)

/**
 * Explicit widget -> activity intents. A URL scheme would add an exported deep
 * link surface for no benefit; the widget and activity live in the same app.
 */
object WidgetIntents {
    const val ACTION_OPEN = "com.devtodo.app.widget.OPEN"
    const val EXTRA_DESTINATION = "com.devtodo.app.widget.DESTINATION"
    const val EXTRA_TASK_ID = "com.devtodo.app.widget.TASK_ID"
    const val EXTRA_FOLDER_ID = "com.devtodo.app.widget.FOLDER_ID"
    const val EXTRA_CAPTURE_DATE = "com.devtodo.app.widget.CAPTURE_DATE"
    const val DESTINATION_TODAY = "today"
    const val DESTINATION_TASK = "task"
    const val DESTINATION_FOLDER = "folder"

    fun openToday(context: Context): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            putExtra(EXTRA_DESTINATION, DESTINATION_TODAY)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

    fun openTask(context: Context, taskId: String): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            putExtra(EXTRA_DESTINATION, DESTINATION_TASK)
            putExtra(EXTRA_TASK_ID, taskId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

    fun openFolder(context: Context, folderId: String?): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            putExtra(EXTRA_DESTINATION, DESTINATION_FOLDER)
            putExtra(EXTRA_FOLDER_ID, folderId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

    fun capture(context: Context, folderId: String?, localDate: String?): Intent =
        Intent(context, CaptureActivity::class.java).apply {
            putExtra(EXTRA_FOLDER_ID, folderId)
            putExtra(EXTRA_CAPTURE_DATE, localDate)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

    fun navigationFrom(intent: Intent?): WidgetNavigation? {
        if (intent?.action != ACTION_OPEN) return null
        val taskId = intent.getStringExtra(EXTRA_TASK_ID)
        val folderId = intent.getStringExtra(EXTRA_FOLDER_ID)
        val destination = when (intent.getStringExtra(EXTRA_DESTINATION)) {
            DESTINATION_TODAY -> WidgetDestination.TODAY
            DESTINATION_TASK -> WidgetDestination.TASK
            DESTINATION_FOLDER -> WidgetDestination.FOLDER
            else -> return null
        }
        return WidgetNavigation(
            requestId = System.nanoTime(),
            destination = destination,
            taskId = taskId,
            folderId = folderId,
        )
    }
}
