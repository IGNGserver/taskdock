package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
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
    LaunchedEffect(confirmedAt) {
        while (true) {
            now = System.currentTimeMillis()
            delay(15_000)
        }
    }
    val recent = isRecentlyConfirmed(confirmedAt, now, viewModel.freshnessWindowMs)
    val pageVerified = page?.let { it.error == null && isRecentlyConfirmed(it.loadedAt, now, viewModel.freshnessWindowMs) } == true
    val checking = state == SyncState.SYNCING || page?.loading == true
    val checkedLabel =
        if (pageVerified) {
            "当前页面已更新"
        } else if (confirmedAt > 0) {
            "上次核验 ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(confirmedAt))}"
        } else {
            "尚未完成中枢核验"
        }
    val content = resolveSyncBanner(
        state = state,
        progress = progress,
        cached = cached,
        recent = recent,
        checking = checking,
        pageError = page?.error,
        pendingCount = pending.size,
        lastSyncError = error,
        checkedLabel = checkedLabel,
        pageVerified = pageVerified,
    )

    if (content.mode == SyncBannerMode.COMPACT) {
        Row(
            modifier = Modifier.fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .testTag("sync-last-confirmed"),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (content.showProgress) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                content.message,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    val isError = content.mode == SyncBannerMode.ERROR
    val colors = MaterialTheme.colorScheme
    Surface(
        color = if (isError) colors.errorContainer else colors.secondaryContainer,
        contentColor = if (isError) colors.onErrorContainer else colors.onSecondaryContainer,
        modifier = Modifier.fillMaxWidth()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
            .testTag("sync-status-banner")
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (isError) Icons.Default.Warning else Icons.Default.Info,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
                Column(Modifier.weight(1f)) {
                    Text(content.message, style = MaterialTheme.typography.labelLarge)
                    content.detail?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (content.showRetry) {
                    TextButton(onClick = viewModel::retryCurrentPage) { Text("重试") }
                }
            }
            if (content.showProgress) {
                LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
            }
        }
    }
}
