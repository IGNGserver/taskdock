package com.devtodo.app.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.OutboxEntity
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.ThemeMode

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    viewModel: MainViewModel,
    onThemeModeChange: (ThemeMode) -> Unit,
    onDynamicColorChange: (Boolean) -> Unit,
    onPureBlackChange: (Boolean) -> Unit,
    onNavigateToArchived: () -> Unit,
    onLogout: () -> Unit,
) {
    val sync by viewModel.syncState.collectAsStateWithLifecycle()
    val error by viewModel.lastSyncError.collectAsStateWithLifecycle()
    val theme by viewModel.themeMode.collectAsStateWithLifecycle()
    val dynamic by viewModel.dynamicColor.collectAsStateWithLifecycle()
    val black by viewModel.pureBlack.collectAsStateWithLifecycle()
    val pending by viewModel.pendingOutboxItems.collectAsStateWithLifecycle()
    val conflicts by viewModel.unresolvedConflicts.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    var showHub by rememberSaveable { mutableStateOf(false) }
    var hub by rememberSaveable { mutableStateOf(viewModel.authManager.hubOrigin) }
    var confirmOrigin by rememberSaveable { mutableStateOf<String?>(null) }
    var logout by rememberSaveable { mutableStateOf(false) }
    var discard by remember { mutableStateOf<OutboxEntity?>(null) }
    var queue by rememberSaveable { mutableStateOf(false) }
    var showTimezone by rememberSaveable { mutableStateOf(false) }
    WorkspaceScaffold(
        topBar = { TopAppBar(title = { Text("更多") }, windowInsets = WindowInsets(0, 0, 0, 0)) }
    ) { padding ->
        Column(
            Modifier.fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp)
        ) {
            SectionHeading("账户与同步")
            ListItem(
                headlineContent = { Text(viewModel.authManager.username ?: "当前账户") },
                supportingContent = { Text(syncStateLabel(sync)) },
                leadingContent = { Icon(Icons.Default.CloudSync, null) },
                trailingContent = {
                    TextButton(onClick = viewModel::syncNow, enabled = sync != SyncState.SYNCING) {
                        Text("同步")
                    }
                },
            )
            if (sync == SyncState.SYNCING) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let {
                Text(
                    it,
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    color = MaterialTheme.colorScheme.error,
                )
            }
            ListItem(
                headlineContent = { Text("服务器连接") },
                supportingContent = { Text(viewModel.authManager.hubOrigin) },
                trailingContent = {
                    TextButton(
                        onClick = {
                            hub = viewModel.authManager.hubOrigin
                            showHub = true
                        }
                    ) {
                        Text("更改")
                    }
                },
            )
            ListItem(
                headlineContent = { Text("同步队列") },
                supportingContent = { Text("${pending.size} 项待提交 · ${conflicts.size} 项冲突") },
                trailingContent = {
                    TextButton(onClick = { queue = !queue }) { Text(if (queue) "收起" else "查看") }
                },
            )
            if (queue) {
                if (conflicts.isNotEmpty())
                    Text(
                        "冲突数据已保留，请打开 Web 端的“更多 → 设置 → 高级同步与故障处理”选择要保留的版本。",
                        Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.error,
                    )
                conflicts.forEach { conflict ->
                    ListItem(
                        headlineContent = { Text(conflict.command ?: conflict.entityType) },
                        supportingContent = { Text(conflict.entityId.take(8)) },
                    )
                }
                pending.forEach { item ->
                    ListItem(
                        headlineContent = { Text(item.command) },
                        supportingContent = { Text(item.lastError ?: "等待提交") },
                        trailingContent = {
                            ActionMenu(
                                "待提交操作",
                                listOf(
                                    RowAction("重试") { viewModel.retryOutboxItem(item) },
                                    RowAction("丢弃", destructive = true) { discard = item },
                                ),
                            )
                        },
                    )
                }
                if (pending.isEmpty() && conflicts.isEmpty())
                    Text("没有待处理项", Modifier.padding(16.dp))
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            SectionHeading("日期与安排")
            ListItem(
                headlineContent = { Text("时区") },
                supportingContent = {
                    Text(timezoneLabel(settings?.timezone ?: "Asia/Shanghai"))
                },
                trailingContent = {
                    TextButton(onClick = { showTimezone = true }) { Text("更改") }
                },
            )
            Text(
                "今日、日期安排和日历都会使用这个时区。",
                Modifier.padding(horizontal = 16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("每周开始于", Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp))
            FlowRow(
                Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(1 to "周一", 0 to "周日").forEach { (value, label) ->
                    FilterChip(
                        selected = settings?.weekStartsOn == value,
                        onClick = { viewModel.updateSettings(weekStartsOn = value) },
                        label = { Text(label) },
                    )
                }
            }
            Text("新任务默认放到", Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp))
            FlowRow(
                Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("ROOT" to "根目录", "RECENT_FOLDER" to "最近文件夹").forEach { (value, label) ->
                    FilterChip(
                        selected = (settings?.defaultCaptureTarget ?: "ROOT") == value,
                        onClick = { viewModel.updateSettings(defaultCaptureTarget = value) },
                        label = { Text(label) },
                    )
                }
            }
            Text(
                "这只决定快速新建任务的起点，之后仍可移动到其他目录。",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            SectionHeading("外观")
            FlowRow(
                Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(ThemeMode.SYSTEM to "跟随系统", ThemeMode.LIGHT to "浅色", ThemeMode.DARK to "深色")
                    .forEach { (mode, label) ->
                        FilterChip(
                            theme == mode,
                            { onThemeModeChange(mode) },
                            label = { Text(label) },
                        )
                    }
            }
            SettingSwitchRow(
                "动态配色",
                if (Build.VERSION.SDK_INT >= 31) "使用系统壁纸颜色" else "需要 Android 12 或更新版本",
                dynamic,
                onDynamicColorChange,
                Build.VERSION.SDK_INT >= 31,
            )
            SettingSwitchRow("纯黑背景", "在深色主题中使用", black, onPureBlackChange)
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            SectionHeading("数据")
            ListItem(
                headlineContent = { Text("归档中心") },
                supportingContent = { Text("查看和恢复已归档的任务与目录") },
                leadingContent = { Icon(Icons.Default.Archive, null) },
                trailingContent = { TextButton(onClick = onNavigateToArchived) { Text("打开") } },
            )
            TextButton(onClick = { logout = true }, modifier = Modifier.padding(16.dp)) {
                Text("退出登录", color = MaterialTheme.colorScheme.error)
            }
        }
    }
    if (showTimezone)
        AlertDialog(
            onDismissRequest = { showTimezone = false },
            title = { Text("选择时区") },
            text = {
                Column {
                    listOf(
                        "Asia/Shanghai" to "中国标准时间 (UTC+08:00)",
                        "Asia/Tokyo" to "日本标准时间 (UTC+09:00)",
                        "UTC" to "协调世界时 (UTC)",
                        "America/Los_Angeles" to "太平洋时间",
                    ).forEach { (value, label) ->
                        TextButton(
                            onClick = {
                                viewModel.updateSettings(timezone = value)
                                showTimezone = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                label,
                                modifier = Modifier.fillMaxWidth(),
                                color =
                                    if (settings?.timezone == value)
                                        MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showTimezone = false }) { Text("取消") }
            },
        )
    if (showHub)
        AlertDialog(
            onDismissRequest = { showHub = false },
            title = { Text("服务器连接") },
            text = {
                Column {
                    OutlinedTextField(
                        hub,
                        { hub = it },
                        label = { Text("服务器地址") },
                        singleLine = true,
                        isError = hub.isNotBlank() && normalizedHubOrigin(hub) == null,
                        supportingText = {
                            Text(
                                if (hub.startsWith("http://")) "HTTP 会明文传输账号和任务数据，请仅在可信网络使用。"
                                else "请输入 HTTP 或 HTTPS 地址，不含路径。"
                            )
                        },
                    )
                    if (pending.isNotEmpty())
                        Text("请先完成待提交操作，再更换服务器。", color = MaterialTheme.colorScheme.error)
                }
            },
            confirmButton = {
                TextButton(
                    enabled = normalizedHubOrigin(hub) != null && pending.isEmpty(),
                    onClick = {
                        val origin = normalizedHubOrigin(hub)!!
                        showHub = false
                        if (origin != viewModel.authManager.hubOrigin) confirmOrigin = origin
                        else viewModel.showMessage("服务器地址未改变")
                    },
                ) {
                    Text("保存")
                }
            },
            dismissButton = { TextButton(onClick = { showHub = false }) { Text("取消") } },
        )
    confirmOrigin?.let { origin ->
        AlertDialog(
            onDismissRequest = { confirmOrigin = null },
            title = { Text("切换服务器并重新登录？") },
            text = { Text("将连接 $origin。当前设备上的任务不会被删除。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onLogout()
                        viewModel.authManager.hubOrigin = origin
                        confirmOrigin = null
                    }
                ) {
                    Text("切换")
                }
            },
            dismissButton = { TextButton(onClick = { confirmOrigin = null }) { Text("取消") } },
        )
    }
    if (logout)
        AlertDialog(
            onDismissRequest = { logout = false },
            title = { Text("退出登录？") },
            text = {
                Text(
                    if (pending.isEmpty()) "本地任务会保留，重新登录后继续同步。"
                    else "还有 ${pending.size} 项未提交。重新登录当前账户后才能继续同步。"
                )
            },
            confirmButton = { TextButton(onClick = onLogout) { Text("退出登录") } },
            dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } },
        )
    discard?.let { item ->
        AlertDialog(
            onDismissRequest = { discard = null },
            title = { Text("丢弃待提交操作？") },
            text = { Text("这条操作将不再发送到服务器，本地显示可能与其他设备不同。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.discardOutboxItem(item)
                        discard = null
                    }
                ) {
                    Text("丢弃")
                }
            },
            dismissButton = { TextButton(onClick = { discard = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun SettingSwitchRow(
    title: String,
    description: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    enabled: Boolean = true,
) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(description) },
        trailingContent = { Switch(checked, null, enabled = enabled) },
        modifier =
            Modifier.toggleable(
                checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onChange,
            ),
    )
}

private fun syncStateLabel(state: SyncState): String =
    when (state) {
        SyncState.IDLE -> "当前没有同步任务"
        SyncState.SYNCING -> "正在同步"
        SyncState.OFFLINE -> "离线，修改会保存在此设备"
        SyncState.AUTH_REQUIRED -> "需要重新登录"
        SyncState.INCOMPATIBLE -> "请升级服务器后重试"
        SyncState.SERVER_UNAVAILABLE -> "服务器暂不可用"
        SyncState.ERROR -> "同步失败，请重试"
    }

private fun timezoneLabel(timezone: String): String =
    when (timezone) {
        "Asia/Shanghai" -> "中国标准时间 (UTC+08:00)"
        "Asia/Tokyo" -> "日本标准时间 (UTC+09:00)"
        "UTC" -> "协调世界时 (UTC)"
        "America/Los_Angeles" -> "太平洋时间"
        else -> timezone
    }
