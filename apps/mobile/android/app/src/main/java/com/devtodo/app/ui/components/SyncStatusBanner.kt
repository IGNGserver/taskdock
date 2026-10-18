package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.data.sync.isRecentlyConfirmed
import com.devtodo.app.ui.screens.MainViewModel
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SyncStatusBanner(viewModel: MainViewModel, pageKey: String) {
    val state by viewModel.syncState.collectAsStateWithLifecycle()
    val progress by viewModel.loadProgress.collectAsStateWithLifecycle()
    val cached by viewModel.hasCachedData.collectAsStateWithLifecycle()
    val error by viewModel.lastSyncError.collectAsStateWithLifecycle()
    val confirmedAt by viewModel.lastConfirmedAt.collectAsStateWithLifecycle()
    val pages by viewModel.pageLoads.collectAsStateWithLifecycle()
    val pending by viewModel.pendingOutboxItems.collectAsStateWithLifecycle()
    val page = pages[pageKey]
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(confirmedAt) { while (true) { now = System.currentTimeMillis(); delay(15_000) } }
    val recent = isRecentlyConfirmed(confirmedAt, now)
    val failed = state in setOf(SyncState.OFFLINE, SyncState.AUTH_REQUIRED, SyncState.INCOMPATIBLE,
        SyncState.SERVER_UNAVAILABLE, SyncState.ERROR) || page?.error != null
    val loading = !failed && (state == SyncState.SYNCING || page?.loading == true)
    val checked = if (confirmedAt > 0) "上次确认 ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(confirmedAt))}" else "尚未完成中枢核验"
    if (recent && !failed && !loading && progress.complete && pending.isEmpty()) {
        Text(checked, style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("sync-last-confirmed"))
        return
    }
    val message = when {
        state == SyncState.OFFLINE -> if (cached) "离线 · 显示本地缓存" else "离线 · 暂无本地缓存"
        state == SyncState.AUTH_REQUIRED -> "登录需要恢复 · 本地缓存已保留"
        state == SyncState.INCOMPATIBLE -> "中枢协议不兼容 · 本地缓存已保留"
        state == SyncState.SERVER_UNAVAILABLE -> "中枢服务暂不可用 · 已保留缓存"
        page?.error != null -> "当前页面更新失败 · 已保留缓存"
        error != null -> if (cached) "更新失败 · 已保留缓存，稍后自动重试" else "首次加载失败 · 稍后自动重试"
        progress.totalPages > 0 -> "后台加载 ${progress.completedPages}/${progress.totalPages} 批 · 已有数据可用"
        loading -> if (cached) "显示缓存 · 正在检查中枢更新" else "正在加载中枢数据…"
        !recent -> "数据尚未核验 · 当前内容可能不是最新"
        pending.isNotEmpty() -> "已核验中枢数据 · ${pending.size} 项本地操作待处理"
        else -> "中枢数据已核验"
    }
    Surface(
        color = if (failed) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        contentColor = if (failed) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
        modifier = Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
            .testTag("sync-status-banner").semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(if (failed) Icons.Default.Warning else Icons.Default.Info, contentDescription = null,
                    modifier = Modifier.size(20.dp))
                Column(Modifier.weight(1f)) {
                    Text(message, style = MaterialTheme.typography.labelLarge)
                    Text(checked, style = MaterialTheme.typography.labelSmall)
                }
                if (failed || (!recent && !loading)) TextButton(onClick = viewModel::retryCurrentPage) { Text("重试") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
        }
    }
}
