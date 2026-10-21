package com.devtodo.app.widget

import android.appwidget.AppWidgetProviderInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.collection.intSetOf
import androidx.glance.appwidget.GlanceAppWidgetManager
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Android 15+ shows a generated preview in the widget picker, but only after
 * the app pushes it. Keep this out of the hot path (at most twice a day) and
 * never publish a signed-out / empty preview as the permanent first impression.
 */
object WidgetPreviewPublisher {
    private const val PREFS = "taskdock_widget_state"
    private const val KEY_LAST_PUBLISHED = "preview_last_published"
    private const val PUBLISH_INTERVAL_MS = 12 * 60 * 60 * 1000L

    suspend fun publishIfDue(context: Context) = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return@withContext
        if (!SecureAuthManager(context).isLoggedIn) return@withContext
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val last = prefs.getLong(KEY_LAST_PUBLISHED, 0L)
        if (System.currentTimeMillis() - last < PUBLISH_INTERVAL_MS) return@withContext
        if (publish(context)) {
            prefs.edit().putLong(KEY_LAST_PUBLISHED, System.currentTimeMillis()).apply()
        }
    }

    @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
    private suspend fun publish(context: Context): Boolean {
        val manager = GlanceAppWidgetManager(context.applicationContext)
        val categories = intSetOf(AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN)
        val results = listOf(
            runCatching { manager.setWidgetPreviews(TodayWidgetReceiver::class, categories) },
            runCatching { manager.setWidgetPreviews(OpenWidgetReceiver::class, categories) },
            runCatching { manager.setWidgetPreviews(NextWidgetReceiver::class, categories) },
            runCatching { manager.setWidgetPreviews(CaptureWidgetReceiver::class, categories) },
            runCatching { manager.setWidgetPreviews(FolderWidgetReceiver::class, categories) },
        )
        return results.any {
            it.getOrNull() == GlanceAppWidgetManager.SET_WIDGET_PREVIEWS_RESULT_SUCCESS
        }
    }
}
