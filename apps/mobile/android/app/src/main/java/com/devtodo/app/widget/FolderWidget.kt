package com.devtodo.app.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.devtodo.app.R
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object FolderWidgetStore {
    private const val PREFS = "taskdock_widget_state"
    private const val PREFIX = "folder_widget_"
    const val ROOT = "__root__"

    fun read(context: Context, appWidgetId: Int): String? =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("$PREFIX$appWidgetId", null)

    fun write(context: Context, appWidgetId: Int, key: String) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("$PREFIX$appWidgetId", key)
            .apply()
    }

    fun folderId(key: String?): String? = when (key) {
        null, ROOT -> null
        else -> key
    }

    fun clear(context: Context, appWidgetId: Int) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove("$PREFIX$appWidgetId")
            .apply()
    }
}

class FolderWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val stored = FolderWidgetStore.read(context, appWidgetId)
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        val state = if (stored == null) {
            FolderWidgetState(
                signedIn = SecureAuthManager(context).isLoggedIn,
                configured = false,
            )
        } else {
            WidgetRepository(context).loadFolder(FolderWidgetStore.folderId(stored))
        }
        provideContent {
            WidgetTheme(appearance) {
                FolderWidgetContent(
                    context = context,
                    appWidgetId = appWidgetId,
                    state = state,
                    expanded = LocalSize.current.height >= 220.dp,
                )
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val state = WidgetRepository(context).loadFolder(null)
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                FolderWidgetContent(
                    context = context,
                    appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID,
                    state = state,
                    expanded = true,
                )
            }
        }
    }
}

class FolderWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = FolderWidget()

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        appWidgetIds.forEach { FolderWidgetStore.clear(context, it) }
    }
}

@Composable
private fun FolderWidgetContent(
    context: Context,
    appWidgetId: Int,
    state: FolderWidgetState,
    expanded: Boolean,
) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(GlanceTheme.colors.surface)
            .cornerRadius(28.dp)
            .padding(horizontal = if (expanded) 18.dp else 14.dp, vertical = if (expanded) 16.dp else 12.dp),
        verticalAlignment = Alignment.Top,
        horizontalAlignment = Alignment.Start,
    ) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_widget_folder),
                contentDescription = null,
                modifier = GlanceModifier.size(17.dp),
                colorFilter = ColorFilter.tint(GlanceTheme.colors.primary),
            )
            Spacer(GlanceModifier.size(7.dp))
            Column(
                modifier = GlanceModifier.defaultWeight(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = state.folderTitle ?: "目录",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontSize = if (expanded) 15.sp else 13.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
                Text(
                    text = if (state.configured) "共 ${state.total} 项待办" else "尚未选择目录",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurfaceVariant,
                        fontSize = 10.5.sp,
                    ),
                    maxLines = 1,
                )
            }
            if (state.pendingSync) {
                PendingDot()
                Spacer(GlanceModifier.size(5.dp))
            }
            RefreshIcon()
        }

        if (!state.signedIn) {
            Spacer(GlanceModifier.height(12.dp))
            SignedOutContent(context, "登录后查看目录")
            return@Column
        }

        if (!state.configured) {
            Spacer(GlanceModifier.height(if (expanded) 18.dp else 8.dp))
            Text(
                text = if (state.folderTitle == null && state.folderId != null) "目录已不存在" else "选择一个目录",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurface,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.size(4.dp))
            Text(
                text = "固定查看一个目录里的待办。",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.5.sp,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.size(10.dp))
            ConfigurePill(context, appWidgetId)
            return@Column
        }

        Spacer(GlanceModifier.height(if (expanded) 10.dp else 4.dp))
        if (state.tasks.isEmpty()) {
            Spacer(GlanceModifier.size(if (expanded) 14.dp else 6.dp))
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = "这个目录还没有待办",
                    modifier = GlanceModifier.defaultWeight(),
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
            }
        } else {
            state.tasks.take(if (expanded) 5 else 2).forEach { task ->
                CompletableTaskRow(
                    context = context,
                    task = task,
                    showFolder = false,
                    expanded = expanded,
                )
            }
        }

        Spacer(GlanceModifier.defaultWeight())

        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            AddCapturePill(context, "记一件事", state.folderId, null)
            Spacer(GlanceModifier.defaultWeight())
            Row(
                modifier = GlanceModifier.clickable(
                    actionStartActivity(WidgetIntents.openFolder(context, state.folderId))
                ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = "打开目录",
                    style = TextStyle(
                        color = GlanceTheme.colors.primary,
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
                Spacer(GlanceModifier.size(3.dp))
                Image(
                    provider = ImageProvider(R.drawable.ic_widget_arrow),
                    contentDescription = null,
                    modifier = GlanceModifier.size(12.dp),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.primary),
                )
            }
        }
    }
}

@Composable
private fun ConfigurePill(context: Context, appWidgetId: Int) {
    val intent = Intent(context, FolderWidgetConfigureActivity::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    Box(
        modifier = GlanceModifier
            .background(GlanceTheme.colors.primaryContainer)
            .cornerRadius(999.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clickable(actionStartActivity(intent)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "选择目录",
            style = TextStyle(
                color = GlanceTheme.colors.onPrimaryContainer,
                fontSize = 10.5.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = 1,
        )
    }
}
