package com.devtodo.app.widget

import android.content.Context
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
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
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
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.devtodo.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class NextWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = WidgetRepository(context).loadNext()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                NextWidgetContent(
                    context = context,
                    state = state,
                    expanded = LocalSize.current.height >= 150.dp,
                )
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val state = WidgetRepository(context).loadNext()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                NextWidgetContent(context = context, state = state, expanded = true)
            }
        }
    }
}

class NextWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextWidget()
}

@Composable
private fun NextWidgetContent(context: Context, state: NextWidgetState, expanded: Boolean) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(GlanceTheme.colors.tertiaryContainer)
            .cornerRadius(28.dp)
            .padding(horizontal = 15.dp, vertical = 14.dp),
        verticalAlignment = Alignment.Top,
        horizontalAlignment = Alignment.Start,
    ) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = "下一步",
                modifier = GlanceModifier.defaultWeight(),
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            if (state.pendingSync) {
                Spacer(
                    GlanceModifier
                        .size(5.dp)
                        .background(GlanceTheme.colors.tertiary)
                        .cornerRadius(999.dp)
                )
                Spacer(GlanceModifier.size(4.dp))
            }
            Box(
                modifier = GlanceModifier.size(28.dp).clickable(actionRunCallback<WidgetRefreshAction>()),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    provider = ImageProvider(R.drawable.ic_widget_refresh),
                    contentDescription = "同步并刷新小组件",
                    modifier = GlanceModifier.size(14.dp),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.onTertiaryContainer),
                )
            }
        }

        if (!state.signedIn) {
            Spacer(GlanceModifier.size(8.dp))
            Text(
                text = "登录后查看下一步",
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 2,
            )
            Spacer(GlanceModifier.size(4.dp))
            Text(
                text = "打开 TaskDock 连接你的中枢。",
                modifier = GlanceModifier.clickable(actionStartActivity(WidgetIntents.openToday(context))),
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 10.5.sp,
                ),
                maxLines = 2,
            )
            return@Column
        }

        val task = state.task
        if (task == null) {
            Spacer(GlanceModifier.size(10.dp))
            Text(
                text = "没有未完成的任务",
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.size(4.dp))
            Text(
                text = "今天清空了。",
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 10.5.sp,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.defaultWeight())
            AddCapturePill(context, "记一件事", null, null)
            return@Column
        }

        Spacer(GlanceModifier.size(if (expanded) 10.dp else 7.dp))
        Text(
            text = task.title.widgetText(if (expanded) 64 else 50),
            modifier = GlanceModifier.fillMaxWidth()
                .clickable(actionStartActivity(WidgetIntents.openTask(context, task.id))),
            style = TextStyle(
                color = GlanceTheme.colors.onTertiaryContainer,
                fontSize = if (expanded) 16.sp else 14.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = if (expanded) 3 else 2,
        )
        Spacer(GlanceModifier.size(5.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_widget_folder),
                contentDescription = null,
                modifier = GlanceModifier.size(12.dp),
                colorFilter = ColorFilter.tint(GlanceTheme.colors.onTertiaryContainer),
            )
            Spacer(GlanceModifier.size(4.dp))
            Text(
                text = (task.folderTitle ?: "收件箱").widgetText(14),
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 10.sp,
                ),
                maxLines = 1,
            )
        }
        Spacer(GlanceModifier.defaultWeight())
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = if (task.isInProgress) "进行中 · ${state.sourceLabel}" else "待办 · ${state.sourceLabel}",
                modifier = GlanceModifier.defaultWeight(),
                style = TextStyle(
                    color = GlanceTheme.colors.onTertiaryContainer,
                    fontSize = 10.sp,
                ),
                maxLines = 1,
            )
            Box(
                modifier = GlanceModifier.size(30.dp).clickable(
                    actionRunCallback<WidgetToggleTaskAction>(
                        actionParametersOf(WidgetActionKeys.TASK_ID to task.id)
                    )
                ),
                contentAlignment = Alignment.Center,
            ) {
                if (task.isInProgress) {
                    Image(
                        provider = ImageProvider(R.drawable.ic_widget_progress),
                        contentDescription = "完成任务：${task.title}",
                        modifier = GlanceModifier.size(21.dp),
                        colorFilter = ColorFilter.tint(GlanceTheme.colors.onTertiaryContainer),
                    )
                } else {
                    Image(
                        provider = ImageProvider(R.drawable.ic_widget_circle),
                        contentDescription = "完成任务：${task.title}",
                        modifier = GlanceModifier.size(21.dp),
                        colorFilter = ColorFilter.tint(GlanceTheme.colors.onTertiaryContainer),
                    )
                }
            }
            Spacer(GlanceModifier.size(4.dp))
            Box(
                modifier = GlanceModifier.size(30.dp).clickable(
                    actionStartActivity(WidgetIntents.openTask(context, task.id))
                ),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    provider = ImageProvider(R.drawable.ic_widget_arrow),
                    contentDescription = "打开任务",
                    modifier = GlanceModifier.size(15.dp),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.onTertiaryContainer),
                )
            }
        }
    }
}
