package com.devtodo.app.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Debounced, process-scoped widget refresh.
 *
 * Room is the source of truth; widgets do not hold a long-lived Flow because
 * the launcher can render them while the app process is absent. The app,
 * commands and background sync all call this single entry point instead.
 */
object WidgetUpdater {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val requests = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
    private var started = false

    @Volatile
    private var appContext: Context? = null

    fun refreshAll(context: Context) {
        appContext = context.applicationContext
        ensureStarted()
        requests.tryEmit(Unit)
    }

    private fun ensureStarted() {
        synchronized(this) {
            if (started) return
            started = true
            scope.launch {
                requests.collectLatest {
                    // Coalesce bursts from a transaction + a sync completion.
                    delay(120)
                    val context = appContext ?: return@collectLatest
                    runCatching { TodayWidget().updateAll(context) }
                    runCatching { OpenWidget().updateAll(context) }
                    runCatching { NextWidget().updateAll(context) }
                    runCatching { CaptureWidget().updateAll(context) }
                    runCatching { FolderWidget().updateAll(context) }
                }
            }
        }
    }
}
