package com.devtodo.app.ui.screens

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.Formatter
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.update.AndroidUpdate
import com.devtodo.app.data.update.AppUpdateState
import com.devtodo.app.data.update.TASKDOCK_RELEASES_PAGE
import com.devtodo.app.data.update.UpdateChannel
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Settings › 关于与更新.
 *
 * The update source is the repository-hosted update feed, not the user's hub:
 * a self-hosted API may be unreachable or older than the installed client.
 */
@Composable
fun AppUpdateSettingsSection(
    state: AppUpdateState,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
    onChannelChange: (UpdateChannel) -> Unit = {},
) {
    val context = LocalContext.current
    ExpressiveSettingsGroup(
        title = "关于与更新",
        description = "客户端 v${state.currentVersion} · ${channelLabel(state)}",
    ) {
        if (state.isDebuggable) {
            Text(
                text = "开发版不提供应用内更新。请安装正式签名版后使用。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@ExpressiveSettingsGroup
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { onChannelChange(UpdateChannel.STABLE) }, enabled = !state.checking && !state.downloading) {
                Text(if (state.currentChannel == UpdateChannel.STABLE) "✓ 正式通道" else "正式通道")
            }
            TextButton(onClick = { onChannelChange(UpdateChannel.PRERELEASE) }, enabled = !state.checking && !state.downloading) {
                Text(if (state.currentChannel == UpdateChannel.PRERELEASE) "✓ 预发布通道" else "预发布通道")
            }
        }
        Text("预发布通道包含正式版；切换通道只升级，不降级。", style = MaterialTheme.typography.bodySmall)
        val update = state.update
        if (update == null) {
            SettingsActionRow(
                title = "检查更新",
                subtitle = when {
                    state.checking -> "正在检查仓库更新…"
                    state.error != null -> "检查失败"
                    state.message != null -> state.message!!
                    state.lastCheckedAt != null -> "上次检查：${relativeTime(state.lastCheckedAt)}"
                    else -> "从 GitHub Releases 获取最新 Android 安装包"
                },
                actionLabel = if (state.checking) "检查中" else "检查",
                enabled = !state.checking,
                onClick = onCheck,
            )
            state.error?.let { error ->
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = { openUrl(context, TASKDOCK_RELEASES_PAGE) }) {
                    Text("打开发布页")
                }
            }
        } else {
            UpdateAvailableCard(
                state = state,
                update = update,
                onCheck = onCheck,
                onDownload = onDownload,
                onCancelDownload = onCancelDownload,
                onInstall = onInstall,
            )
        }
    }
}

@Composable
private fun UpdateAvailableCard(
    state: AppUpdateState,
    update: AndroidUpdate,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    val context = LocalContext.current
    val container = MaterialTheme.colorScheme.secondaryContainer
    val content = MaterialTheme.colorScheme.onSecondaryContainer
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = TaskDockShapes.Large,
        color = container,
        contentColor = content,
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "发现新版本 v${update.version}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = buildString {
                    formatPublished(update.publishedAt)?.let { published ->
                        append("发布于 ").append(published)
                    }
                    if (update.assetSize > 0L) {
                        if (isNotEmpty()) append(" · ")
                        append(Formatter.formatShortFileSize(context, update.assetSize))
                    }
                },
                style = MaterialTheme.typography.bodySmall,
                color = content.copy(alpha = 0.78f),
            )
            update.notes?.takeIf { it.isNotBlank() }?.let { notes ->
                Text(
                    text = notes,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { openUrl(context, update.releaseUrl) }) {
                    Text("查看完整更新说明")
                }
                TextButton(
                    onClick = onCheck,
                    enabled = !state.checking && !state.downloading,
                ) {
                    Text(if (state.checking) "检查中…" else "重新检查")
                }
            }

            when {
                state.downloading -> {
                    LinearProgressIndicator(
                        progress = { state.progress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        text = "正在下载 ${(state.progress * 100).toInt()}% · " +
                            "${bytesLabel(context, state.downloadedBytes)} / " +
                            bytesLabel(context, state.totalBytes),
                        style = MaterialTheme.typography.bodySmall,
                        color = content.copy(alpha = 0.78f),
                    )
                    TextButton(onClick = onCancelDownload) {
                        Text("取消下载")
                    }
                }

                state.downloadedApkUri != null -> {
                    Button(
                        onClick = onInstall,
                        enabled = !state.checking,
                        modifier = Modifier.fillMaxWidth(),
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Text("安装更新")
                    }
                    TextButton(onClick = onDownload, enabled = !state.checking) {
                        Text("重新下载")
                    }
                }

                else -> {
                    Button(
                        onClick = onDownload,
                        enabled = !state.checking,
                        modifier = Modifier.fillMaxWidth(),
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Text(if (state.error != null) "重试下载" else "下载并安装")
                    }
                }
            }

            state.error?.let { error ->
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (state.error == null) {
                state.message?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = content.copy(alpha = 0.78f),
                    )
                }
            }
        }
    }
}

private fun channelLabel(state: AppUpdateState): String = when {
    state.isDebuggable -> "开发版"
    state.currentChannel == UpdateChannel.PRERELEASE -> "预发布通道"
    else -> "正式通道"
}

private fun relativeTime(timestamp: Long): String {
    val elapsed = (System.currentTimeMillis() - timestamp).coerceAtLeast(0L)
    return when {
        elapsed < 60_000L -> "刚刚"
        elapsed < 3_600_000L -> "${elapsed / 60_000L} 分钟前"
        elapsed < 86_400_000L -> "${elapsed / 3_600_000L} 小时前"
        else -> "${elapsed / 86_400_000L} 天前"
    }
}

private fun formatPublished(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    val date = runCatching { parser.parse(raw) }.getOrNull() ?: return raw
    return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(date)
}

private fun bytesLabel(context: Context, bytes: Long): String =
    if (bytes <= 0L) "—" else Formatter.formatShortFileSize(context, bytes)

private fun openUrl(context: Context, url: String) {
    if (!url.startsWith("https://")) return
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
    runCatching { context.startActivity(intent) }
        .onFailure {
            Toast.makeText(context, "无法打开链接", Toast.LENGTH_SHORT).show()
        }
}
