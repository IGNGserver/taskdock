package com.devtodo.app.widget

import android.content.Context
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
