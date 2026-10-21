package com.devtodo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
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
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CaptureWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val localDate = WidgetRepository(context).todayLocalDate()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                CaptureWidgetContent(context = context, localDate = localDate)
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val localDate = WidgetRepository(context).todayLocalDate()
        val appearance = withContext(Dispatchers.IO) { resolveWidgetAppearance(context) }
        provideContent {
            WidgetTheme(appearance) {
                CaptureWidgetContent(context = context, localDate = localDate)
            }
        }
    }
}

class CaptureWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CaptureWidget()
}

@Composable
private fun CaptureWidgetContent(context: Context, localDate: String?) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(GlanceTheme.colors.primaryContainer)
            .cornerRadius(28.dp)
            .padding(horizontal = 15.dp, vertical = 14.dp),
        verticalAlignment = Alignment.Top,
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            text = "速记",
            style = TextStyle(
                color = GlanceTheme.colors.onPrimaryContainer,
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = 1,
        )

        if (localDate == null) {
            Spacer(GlanceModifier.size(10.dp))
            Text(
                text = "登录后记录",
                style = TextStyle(
                    color = GlanceTheme.colors.onPrimaryContainer,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                ),
                maxLines = 1,
            )
            Spacer(GlanceModifier.defaultWeight())
            Box(
                modifier = GlanceModifier
                    .clickable(actionStartActivity(WidgetIntents.openToday(context)))
                    .padding(vertical = 6.dp),
                contentAlignment = Alignment.CenterStart,
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
            return@Column
        }

        Spacer(GlanceModifier.defaultWeight())
        Box(
            modifier = GlanceModifier
                .size(36.dp)
                .background(GlanceTheme.colors.primary)
                .cornerRadius(999.dp)
                .clickable(
                    actionStartActivity(WidgetIntents.capture(context, null, localDate))
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "＋",
                style = TextStyle(
                    color = GlanceTheme.colors.onPrimary,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Normal,
                ),
                maxLines = 1,
            )
        }
        Spacer(GlanceModifier.size(5.dp))
        Text(
            text = "记一件事",
            style = TextStyle(
                color = GlanceTheme.colors.onPrimaryContainer,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            ),
            maxLines = 1,
        )
        Text(
            text = "今天 · 收件箱",
            style = TextStyle(
                color = GlanceTheme.colors.onPrimaryContainer,
                fontSize = 10.5.sp,
            ),
            maxLines = 1,
        )
        Spacer(GlanceModifier.defaultWeight())
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.Start,
        ) {
            Box(
                modifier = GlanceModifier
                    .background(GlanceTheme.colors.surface)
                    .cornerRadius(999.dp)
                    .clickable(actionStartActivity(WidgetIntents.capture(context, null, localDate)))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "今天",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
            }
            Spacer(GlanceModifier.size(8.dp))
            Box(
                modifier = GlanceModifier
                    .background(GlanceTheme.colors.surface)
                    .cornerRadius(999.dp)
                    .clickable(actionStartActivity(WidgetIntents.capture(context, null, null)))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "收件箱",
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontSize = 10.sp,
                    ),
                    maxLines = 1,
                )
            }
        }
    }
}
