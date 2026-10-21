package com.devtodo.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback

object WidgetActionKeys {
    val TASK_ID = ActionParameters.Key<String>("taskdock.taskId")
    val FOLDER_ID = ActionParameters.Key<String>("taskdock.folderId")
    val LOCAL_DATE = ActionParameters.Key<String>("taskdock.localDate")
}

class WidgetToggleTaskAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        val taskId = parameters[WidgetActionKeys.TASK_ID] ?: return
        runCatching { WidgetTaskCommands(context).toggleDone(taskId) }
        WidgetUpdater.refreshAll(context)
    }
}

class WidgetRefreshAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        WidgetUpdater.refreshAll(context)
        WidgetSyncWorker.enqueue(context)
    }
}

object WidgetPin {
    fun today(context: Context): Boolean = pin(context, TodayWidgetReceiver::class.java)

    fun open(context: Context): Boolean = pin(context, OpenWidgetReceiver::class.java)

    fun next(context: Context): Boolean = pin(context, NextWidgetReceiver::class.java)

    fun capture(context: Context): Boolean = pin(context, CaptureWidgetReceiver::class.java)

    fun folder(context: Context): Boolean = pin(context, FolderWidgetReceiver::class.java)

    private fun pin(context: Context, receiver: Class<*>): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val manager = AppWidgetManager.getInstance(context.applicationContext)
        if (!manager.isRequestPinAppWidgetSupported) return false
        val provider = ComponentName(context.applicationContext, receiver)
        return manager.requestPinAppWidget(provider, null, null)
    }
}
