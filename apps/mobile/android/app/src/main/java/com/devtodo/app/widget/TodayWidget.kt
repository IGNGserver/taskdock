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
import androidx.glance.appwidget.LinearProgressIndicator
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
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import com.devtodo.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class TodayWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = WidgetRepository(context).loadToday()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                TodayWidgetContent(
                    context = context,
                    state = state,
                    expanded = LocalSize.current.height >= EXPANDED_HEIGHT,
                    wide = LocalSize.current.width >= WIDE_WIDTH,
                )
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val state = WidgetRepository(context).loadToday()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                TodayWidgetContent(
                    context = context,
                    state = state,
                    expanded = false,
                    wide = true,
                )
            }
        }
    }

    private companion object {
        val EXPANDED_HEIGHT = 220.dp
        val WIDE_WIDTH = 280.dp
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

@Composable
private fun TodayWidgetContent(
    context: Context,
    state: TodayWidgetState,
    expanded: Boolean,
    wide: Boolean,
) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(GlanceTheme.colors.surface)
            .cornerRadius(28.dp)
            .padding(horizontal = if (expanded) 18.dp else 15.dp, vertical = if (expanded) 16.dp else 13.dp),
        verticalAlignment = Alignment.Top,
        horizontalAlignment = Alignment.Start,
    ) {
        if (!state.signedIn) {
            SignedOutToday(context)
            return@Column
        }

        TodayHeader(context, state, expanded, wide)
        Spacer(GlanceModifier.height(if (expanded) 14.dp else 9.dp))
        LinearProgressIndicator(
            progress = state.progress,
            modifier = GlanceModifier.fillMaxWidth().height(if (expanded) 6.dp else 5.dp).cornerRadius(999.dp),
            color = GlanceTheme.colors.primary,
            backgroundColor = GlanceTheme.colors.surfaceVariant,
        )

        if (state.total == 0) {
            Spacer(GlanceModifier.height(if (expanded) 18.dp else 10.dp))
            EmptyToday(context, state.localDate, expanded)
            return@Column
        }

        val open = state.tasks.filterNot { it.isDone }
        val doneTask = state.tasks.firstOrNull { it.isDone }
        val openLimit = if (expanded && doneTask != null) 3 else if (expanded) 4 else 2
        val visibleOpen = open.take(openLimit)
        if (visibleOpen.isNotEmpty()) {
            Spacer(GlanceModifier.height(if (expanded) 10.dp else 5.dp))
            visibleOpen.forEach { task ->
                WidgetTaskRow(context, task, expanded)
            }
        } else {
            Spacer(GlanceModifier.height(if (expanded) 16.dp else 8.dp))
            Text(
                text = "今天的安排已完成",
                modifier = GlanceModifier.fillMaxWidth(),
                style = TextStyle(
                    color = GlanceTheme.colors.primary,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
        }

        if (expanded && doneTask != null) {
            Spacer(GlanceModifier.height(4.dp))
            Text(
                text = "${state.done} 项已完成 · 点按可撤销",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.sp,
                ),
                maxLines = 1,
            )
            WidgetTaskRow(context, doneTask, expanded = false)
        }

        Spacer(GlanceModifier.defaultWeight())

        TodayFooter(context, state, expanded)
    }
}

@Composable
private fun TodayHeader(
    context: Context,
    state: TodayWidgetState,
    expanded: Boolean,
    wide: Boolean,
) {
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            text = state.dayNumber,
            style = TextStyle(
                color = GlanceTheme.colors.primary,
                fontSize = if (expanded) 48.sp else 34.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = 1,
        )
        Spacer(GlanceModifier.size(if (expanded) 10.dp else 8.dp))
        Column(
            modifier = GlanceModifier.defaultWeight(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = if (state.remaining > 0) "还有 ${state.remaining} 件待办" else "今天已完成",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurface,
                    fontSize = if (expanded) 16.sp else 13.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Text(
                text = state.dateLabel,
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.5.sp,
                ),
                maxLines = 1,
            )
        }
        if (wide || expanded) {
            Column(
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.End,
            ) {
                Text(
                    text = "${state.done} / ${state.total}",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurfaceVariant,
                        fontSize = 10.5.sp,
                    ),
                    maxLines = 1,
                )
                Spacer(GlanceModifier.height(3.dp))
                Image(
                    provider = ImageProvider(R.drawable.ic_widget_refresh),
                    contentDescription = "同步并刷新小组件",
                    modifier = GlanceModifier.size(18.dp)
                        .clickable(actionRunCallback<WidgetRefreshAction>()),
                    colorFilter = ColorFilter.tint(GlanceTheme.colors.onSurfaceVariant),
                )
            }
        }
    }
}

@Composable
private fun TodayFooter(context: Context, state: TodayWidgetState, expanded: Boolean) {
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.Start,
    ) {
        if (expanded) {
            Box(
                modifier = GlanceModifier
                    .background(GlanceTheme.colors.primaryContainer)
                    .cornerRadius(999.dp)
                    .padding(horizontal = 11.dp, vertical = 7.dp)
                    .clickable(
                        actionStartActivity(
                            WidgetIntents.capture(context, null, state.localDate.takeIf { it.isNotBlank() })
                        )
                    ),
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
                        text = "记一件事",
                        style = TextStyle(
                            color = GlanceTheme.colors.onPrimaryContainer,
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.Medium,
                        ),
                        maxLines = 1,
                    )
                }
            }
        } else {
            Text(
                text = if (state.remaining > 0) "还有 ${state.remaining} 件" else "今天已完成",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.5.sp,
                ),
                maxLines = 1,
            )
        }
        Spacer(GlanceModifier.defaultWeight())
        Row(
            modifier = GlanceModifier.clickable(actionStartActivity(WidgetIntents.openToday(context))),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            if (state.pendingSync) {
                Spacer(
                    GlanceModifier.size(6.dp)
                        .background(GlanceTheme.colors.tertiary)
                        .cornerRadius(999.dp)
                )
                Spacer(GlanceModifier.size(5.dp))
            }
            Text(
                text = "打开今天",
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

@Composable
private fun EmptyToday(context: Context, localDate: String, expanded: Boolean) {
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.Start,
    ) {
        Column(
            modifier = GlanceModifier.defaultWeight(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = "今天还没有安排",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurface,
                    fontSize = if (expanded) 15.sp else 13.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Text(
                text = "从一件小事开始。",
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.5.sp,
                ),
                maxLines = 1,
            )
        }
        Box(
            modifier = GlanceModifier
                .background(GlanceTheme.colors.primaryContainer)
                .cornerRadius(999.dp)
                .padding(horizontal = 11.dp, vertical = 7.dp)
                .clickable(
                    actionStartActivity(
                        WidgetIntents.capture(context, null, localDate.takeIf { it.isNotBlank() })
                    )
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "记一件事",
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
private fun SignedOutToday(context: Context) {
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            text = "登录后查看今天",
            style = TextStyle(
                color = GlanceTheme.colors.onSurface,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = 1,
        )
        Spacer(GlanceModifier.height(4.dp))
        Text(
            text = "打开 TaskDock 连接你的中枢。",
            style = TextStyle(
                color = GlanceTheme.colors.onSurfaceVariant,
                fontSize = 10.5.sp,
            ),
            maxLines = 2,
        )
        Spacer(GlanceModifier.height(10.dp))
        Box(
            modifier = GlanceModifier
                .background(GlanceTheme.colors.primaryContainer)
                .cornerRadius(999.dp)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .clickable(actionStartActivity(WidgetIntents.openToday(context))),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "打开 App",
                style = TextStyle(
                    color = GlanceTheme.colors.onPrimaryContainer,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun WidgetTaskRow(context: Context, task: WidgetTask, expanded: Boolean) {
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = if (expanded) 5.dp else 3.dp),
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
        Spacer(GlanceModifier.size(if (expanded) 9.dp else 8.dp))
        Text(
            text = task.title.widgetText(if (expanded) 38 else 26),
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
        if (expanded && task.folderTitle != null) {
            Spacer(GlanceModifier.size(6.dp))
            Text(
                text = task.folderTitle!!.widgetText(10),
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 10.sp,
                ),
                maxLines = 1,
            )
        }
    }
}