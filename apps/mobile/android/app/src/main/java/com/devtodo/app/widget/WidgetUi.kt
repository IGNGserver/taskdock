package com.devtodo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.clickable
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import com.devtodo.app.R

@Composable
internal fun CompletableTaskRow(
    context: Context,
    task: WidgetTask,
    showFolder: Boolean,
    expanded: Boolean = false,
    showDivider: Boolean = false,
) {
    if (showDivider) {
        Spacer(
            GlanceModifier
                .fillMaxWidth()
                .height(1.dp)
                .background(GlanceTheme.colors.outline)
        )
    }
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = if (expanded) 7.dp else 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.Start,
    ) {
        Box(
            modifier = GlanceModifier
                .size(if (expanded) 30.dp else 24.dp)
                .clickable(
                    actionRunCallback<WidgetToggleTaskAction>(
                        actionParametersOf(WidgetActionKeys.TASK_ID to task.id)
                    )
                ),
            contentAlignment = Alignment.Center,
        ) {
            when {
                task.isDone -> Box(
                    modifier = GlanceModifier
                        .size(if (expanded) 19.dp else 17.dp)
                        .background(GlanceTheme.colors.primary)
                        .cornerRadius(999.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Image(
                        provider = ImageProvider(R.drawable.ic_widget_check),
                        contentDescription = "撤销完成：${task.title}",
                        modifier = GlanceModifier.size(if (expanded) 12.dp else 10.dp),
                        colorFilter = ColorFilter.tint(GlanceTheme.colors.onPrimary),
                    )
                }
                task.isInProgress -> Image(
                    provider = ImageProvider(R.drawable.ic_widget_progress),
                    contentDescription = "完成任务：${task.title}",
                    modifier = GlanceModifier.size(if (expanded) 20.dp else 18.dp),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.primary),
                )
                else -> Image(
                    provider = ImageProvider(R.drawable.ic_widget_circle),
                    contentDescription = "完成任务：${task.title}",
                    modifier = GlanceModifier.size(if (expanded) 20.dp else 18.dp),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.outline),
                )
            }
        }
        Spacer(GlanceModifier.size(if (expanded) 10.dp else 8.dp))
        Text(
            text = task.title.widgetText(if (expanded) 34 else 28),
            modifier = GlanceModifier
                .defaultWeight()
                .clickable(actionStartActivity(WidgetIntents.openTask(context, task.id))),
            style = TextStyle(
                color = if (task.isDone) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.onSurface,
                fontSize = if (expanded) 13.sp else 12.sp,
                textDecoration = if (task.isDone) TextDecoration.LineThrough else TextDecoration.None,
            ),
            maxLines = 1,
        )
        if (showFolder) {
            Spacer(GlanceModifier.size(6.dp))
            Text(
                text = (task.folderTitle ?: "收件箱").widgetText(9),
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.sp,
                ),
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun AddCapturePill(
    context: Context,
    label: String,
    folderId: String?,
    localDate: String?,
) {
    Box(
        modifier = GlanceModifier
            .background(GlanceTheme.colors.primaryContainer)
            .cornerRadius(999.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clickable(actionStartActivity(WidgetIntents.capture(context, folderId, localDate))),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_widget_add),
                contentDescription = null,
                modifier = GlanceModifier.size(14.dp),
                colorFilter = ColorFilter.tint(GlanceTheme.colors.onPrimaryContainer),
            )
            Spacer(GlanceModifier.size(4.dp))
            Text(
                text = label,
                style = TextStyle(
                    color = GlanceTheme.colors.onPrimaryContainer,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun RefreshIcon() {
    Box(
        modifier = GlanceModifier
            .size(30.dp)
            .clickable(actionRunCallback<WidgetRefreshAction>()),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            provider = ImageProvider(R.drawable.ic_widget_refresh),
            contentDescription = "同步并刷新小组件",
            modifier = GlanceModifier.size(16.dp),
            colorFilter = ColorFilter.tint(GlanceTheme.colors.onSurfaceVariant),
        )
    }
}

@Composable
internal fun PendingDot() {
    Spacer(
        GlanceModifier
            .size(6.dp)
            .background(GlanceTheme.colors.tertiary)
            .cornerRadius(999.dp)
    )
}

@Composable
internal fun SignedOutContent(
    context: Context,
    title: String = "登录后查看",
    subtitle: String = "打开 TaskDock 连接你的中枢。",
) {
    Box(
        modifier = GlanceModifier.fillMaxWidth().clickable(actionStartActivity(WidgetIntents.openToday(context))),
        contentAlignment = Alignment.CenterStart,
    ) {
        androidx.glance.layout.Column(
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = title,
                style = TextStyle(
                    color = GlanceTheme.colors.onSurface,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.size(3.dp))
            Text(
                text = subtitle,
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.5.sp,
                ),
                maxLines = 2,
            )
        }
    }
}

internal fun String.widgetText(maxChars: Int): String {
    val normalized = replace('\n', ' ').replace('\r', ' ').trim()
    if (normalized.length <= maxChars) return normalized
    return normalized.take((maxChars - 1).coerceAtLeast(1)) + "…"
}
