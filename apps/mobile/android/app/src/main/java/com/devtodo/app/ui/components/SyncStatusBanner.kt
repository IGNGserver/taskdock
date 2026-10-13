package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.ui.screens.MainViewModel

@Composable
fun SyncStatusBanner(viewModel: MainViewModel) {
    val state by viewModel.syncState.collectAsStateWithLifecycle()
    val progress by viewModel.loadProgress.collectAsStateWithLifecycle()
    val cached by viewModel.hasCachedData.collectAsStateWithLifecycle()
    val error by viewModel.lastSyncError.collectAsStateWithLifecycle()
    if (state == SyncState.IDLE && progress.complete) return
    val message = when {
        state == SyncState.OFFLINE -> if (cached) "离线 · 显示本地缓存" else "离线 · 暂无本地缓存"
        state == SyncState.AUTH_REQUIRED -> "登录需要恢复 · 本地缓存已保留"
        state == SyncState.INCOMPATIBLE -> "中枢协议不兼容 · 本地缓存已保留"
        error != null -> if (cached) "更新失败 · 已保留缓存，稍后自动重试" else "首次加载失败 · 稍后自动重试"
        progress.totalPages > 0 -> "后台加载 ${progress.completedPages}/${progress.totalPages} 批 · 已有数据可用"
        cached -> "显示本地缓存 · 正在更新"
        else -> "正在加载中枢数据…"
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("sync-status-banner")) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            Text(message, style = MaterialTheme.typography.labelMedium)
            if (state == SyncState.SYNCING) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
        }
    }
}
