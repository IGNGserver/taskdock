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
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class OpenWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = WidgetRepository(context).loadOpen()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                OpenWidgetContent(
                    context = context,
                    state = state,
                    expanded = LocalSize.current.height >= EXPANDED_HEIGHT,
                )
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val state = WidgetRepository(context).loadOpen()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                OpenWidgetContent(context = context, state = state, expanded = true)
            }
        }
    }

    private companion object {
        val EXPANDED_HEIGHT = 220.dp
    }
}

class OpenWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = OpenWidget()
}

@Composable
private fun OpenWidgetContent(context: Context, state: OpenWidgetState, expanded: Boolean) {
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
            Column(
                modifier = GlanceModifier.defaultWeight(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = "待办",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontSize = if (expanded) 17.sp else 14.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
                Text(
                    text = if (state.signedIn) "共 ${state.total} 项" else "尚未登录",
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
            SignedOutContent(context, "登录后查看待办")
            return@Column
        }

        if (state.total == 0) {
            Spacer(GlanceModifier.height(if (expanded) 22.dp else 10.dp))
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
                        text = "没有未完成的任务",
                        style = TextStyle(
                            color = GlanceTheme.colors.onSurface,
                            fontSize = 13.sp,
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
                AddCapturePill(context, "记一件事", null, null)
            }
            return@Column
        }

        Spacer(GlanceModifier.height(if (expanded) 10.dp else 4.dp))
        val visible = state.tasks.take(if (expanded) 4 else 2)
        visible.forEach { task ->
            CompletableTaskRow(
                context = context,
                task = task,
                showFolder = true,
                expanded = expanded,
            )
        }

        if (expanded && state.recentDone != null) {
            Spacer(GlanceModifier.height(4.dp))
            CompletableTaskRow(
                context = context,
                task = state.recentDone,
                showFolder = false,
                expanded = false,
                showDivider = true,
            )
        }

        Spacer(GlanceModifier.defaultWeight())

        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            AddCapturePill(context, "记一件事", null, null)
            Spacer(GlanceModifier.defaultWeight())
            Row(
                modifier = GlanceModifier.clickable(actionStartActivity(WidgetIntents.openFolder(context, null))),
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = "任务",
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
