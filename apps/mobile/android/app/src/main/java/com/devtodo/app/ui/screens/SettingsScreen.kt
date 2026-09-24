package com.devtodo.app.ui.screens

import android.os.Build
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.MoreTime
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.OutboxEntity
import com.devtodo.app.data.sync.SyncState
import com.devtodo.app.ui.components.ActionMenu
import com.devtodo.app.ui.components.RowAction
import com.devtodo.app.ui.components.WorkspaceScaffold
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
    onBack: (() -> Unit)? = null,
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
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                        }
                    }
                },
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SyncSummaryCard(
                username = viewModel.authManager.username ?: "当前账户",
                state = sync,
                pendingCount = pending.size,
                conflictCount = conflicts.size,
                error = error,
                onSync = viewModel::syncNow,
                onReauthenticate = { logout = true },
            )

            SettingsGroup(
                title = "服务器连接",
                description = serverSummary(viewModel.authManager.hubOrigin),
                icon = { Icon(Icons.Default.CloudSync, null) },
            ) {
                SettingsActionRow("服务器地址", "完整地址只在编辑时显示", "更改") {
                    hub = viewModel.authManager.hubOrigin
                    showHub = true
                }
            }

            SettingsGroup(
                title = "同步队列",
                description = "${pending.size} 项待提交 · ${conflicts.size} 项冲突",
                icon = { Icon(Icons.Default.Storage, null) },
            ) {
                SettingsActionRow(
                    "本地待处理操作",
                    if (pending.isEmpty() && conflicts.isEmpty()) "没有待处理项"
                    else "查看、重试或丢弃本地操作",
                    if (queue) "收起" else "查看",
                ) { queue = !queue }
                AnimatedVisibility(queue) {
                    Column {
                        if (conflicts.isNotEmpty()) {
                            Text(
                                "冲突数据已保留，请打开 Web 端的“更多 → 设置 → 高级同步与故障处理”选择要保留的版本。",
                                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        conflicts.forEach { conflict ->
                            ListItem(
                                headlineContent = { Text(conflict.command ?: conflict.entityType) },
                                supportingContent = { Text("记录 ${conflict.entityId.take(8)}") },
                                colors = transparentListItemColors(),
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
                                colors = transparentListItemColors(),
                            )
                        }
                    }
                }
            }

            SettingsGroup(
                title = "日期与安排",
                description = "日期、今日视图和日历使用同一时区。",
                icon = { Icon(Icons.Default.MoreTime, null) },
            ) {
                SettingsActionRow(
                    "时区",
                    timezoneLabel(settings?.timezone ?: "Asia/Shanghai"),
                    "更改",
                ) { showTimezone = true }
                SettingsChoiceRow(
                    title = "每周开始于",
                    description = null,
                    options = listOf(1 to "周一", 0 to "周日"),
                    selected = settings?.weekStartsOn ?: 1,
                    onSelect = { viewModel.updateSettings(weekStartsOn = it) },
                )
                SettingsChoiceRow(
                    title = "新任务默认放到",
                    description = "这是快速新建任务的起点，之后仍可移动到其他目录。",
                    options = listOf("ROOT" to "根目录", "RECENT_FOLDER" to "最近文件夹"),
                    selected = settings?.defaultCaptureTarget ?: "ROOT",
                    onSelect = { viewModel.updateSettings(defaultCaptureTarget = it) },
                )
            }

            SettingsGroup(
                title = "外观",
                description = "颜色选择会同时适用于列表、菜单和系统栏。",
            ) {
                SettingsChoiceRow(
                    title = "主题",
                    description = null,
                    options =
                        listOf(
                            ThemeMode.SYSTEM to "跟随系统",
                            ThemeMode.LIGHT to "浅色",
                            ThemeMode.DARK to "深色",
                        ),
                    selected = theme,
                    onSelect = onThemeModeChange,
                )
                SettingSwitchRow(
                    "动态配色",
                    if (Build.VERSION.SDK_INT >= 31) "使用系统壁纸颜色"
                    else "需要 Android 12 或更新版本",
                    dynamic,
                    onDynamicColorChange,
                    Build.VERSION.SDK_INT >= 31,
                )
                SettingSwitchRow("纯黑背景", "在深色主题中使用", black, onPureBlackChange)
            }

            SettingsGroup(title = "数据与账户") {
                SettingsActionRow(
                    "归档中心",
                    "查看和恢复已归档的任务与目录",
                    "打开",
                    onClick = onNavigateToArchived,
                )
                SettingsActionRow(
                    "退出登录",
                    "本地任务会保留；未提交操作仍需原账户继续同步。",
                    "退出",
                    destructive = true,
                ) { logout = true }
            }
        }
    }
    if (showTimezone)
        AlertDialog(
        onDismissRequest = { showTimezone = false },
        title = { Text("选择时区") },
        text = {
                Column(Modifier.selectableGroup()) {
                    listOf(
                        "Asia/Shanghai" to "中国标准时间 (UTC+08:00)",
                        "Asia/Tokyo" to "日本标准时间 (UTC+09:00)",
                        "UTC" to "协调世界时 (UTC)",
                        "America/Los_Angeles" to "太平洋时间",
                    ).forEach { (value, label) ->
                        val selected = settings?.timezone == value
                        Row(
                            Modifier.fillMaxWidth()
                                .defaultMinSize(minHeight = 52.dp)
                                .selectable(
                                    selected = selected,
                                    role = Role.RadioButton,
                                    onClick = {
                                viewModel.updateSettings(timezone = value)
                                showTimezone = false
                                    },
                                )
                                .padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selected, onClick = null)
                            Text(label, style = MaterialTheme.typography.bodyMedium)
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SyncSummaryCard(
    username: String,
    state: SyncState,
    pendingCount: Int,
    conflictCount: Int,
    error: String?,
    onSync: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val stateColor =
        when (state) {
            SyncState.AUTH_REQUIRED, SyncState.INCOMPATIBLE, SyncState.SERVER_UNAVAILABLE,
            SyncState.ERROR -> colors.error
            SyncState.OFFLINE -> colors.onSecondaryContainer
            SyncState.IDLE, SyncState.SYNCING -> colors.onSecondaryContainer
        }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        shape = MaterialTheme.shapes.extraLarge,
        color = colors.secondaryContainer,
    ) {
        Column(
            Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = CircleShape, color = colors.surfaceContainerHigh) {
                    Icon(
                        Icons.Default.AccountCircle,
                        contentDescription = null,
                        modifier = Modifier.padding(12.dp).size(24.dp),
                        tint = colors.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        username,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.onSecondaryContainer,
                    )
                    Text("TaskDock 账户", style = MaterialTheme.typography.bodySmall,
                        color = colors.onSecondaryContainer)
                }
                if (state == SyncState.SYNCING) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
            Text(
                syncStateLabel(state),
                style = MaterialTheme.typography.bodyMedium,
                color = stateColor,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SyncCountPill("$pendingCount 项待提交")
                if (conflictCount > 0) {
                    SyncCountPill("$conflictCount 项冲突", isError = true)
                }
            }
            if (error != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Default.ErrorOutline, null, tint = colors.error)
                    Text(error, color = colors.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (state == SyncState.SYNCING) LinearProgressIndicator(Modifier.fillMaxWidth())
            Button(
                onClick = if (state == SyncState.AUTH_REQUIRED) onReauthenticate else onSync,
                enabled = state != SyncState.SYNCING,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) {
                Icon(
                    if (state == SyncState.AUTH_REQUIRED) Icons.Default.AccountCircle
                    else Icons.Default.CloudSync,
                    null,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    when (state) {
                        SyncState.AUTH_REQUIRED -> "重新登录"
                        SyncState.SYNCING -> "正在同步"
                        SyncState.OFFLINE -> "尝试连接"
                        SyncState.ERROR, SyncState.SERVER_UNAVAILABLE -> "重试同步"
                        SyncState.INCOMPATIBLE -> "检查连接"
                        SyncState.IDLE -> "立即同步"
                    }
                )
            }
        }
    }
}

@Composable
private fun SyncCountPill(text: String, isError: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (isError) colors.errorContainer else colors.surfaceContainerHigh,
    ) {
        Text(
            text,
            Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            color = if (isError) colors.onErrorContainer else colors.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
private fun SettingsGroup(
    title: String,
    description: String? = null,
    icon: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = 16.dp)
            .clip(MaterialTheme.shapes.extraLarge)
            .background(MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon?.let {
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { it() }
                }
            }
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                if (description != null) {
                    Text(
                        description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        content()
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun SettingsActionRow(
    title: String,
    description: String,
    action: String,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(description) },
        trailingContent = {
            TextButton(onClick = onClick, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) {
                Text(
                    action,
                    color = if (destructive) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.primary,
                )
            }
        },
        colors = transparentListItemColors(),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> SettingsChoiceRow(
    title: String,
    description: String?,
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
        FlowRow(
            modifier = Modifier.fillMaxWidth().selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEach { (value, label) ->
                val isSelected = value == selected
                Row(
                    Modifier.clip(MaterialTheme.shapes.large)
                        .background(
                            if (isSelected) MaterialTheme.colorScheme.secondaryContainer
                            else MaterialTheme.colorScheme.surfaceContainerHigh
                        )
                        .selectable(
                            selected = isSelected,
                            role = Role.RadioButton,
                            onClick = { onSelect(value) },
                        )
                        .defaultMinSize(minHeight = 52.dp)
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    RadioButton(selected = isSelected, onClick = null)
                    Text(
                        label,
                        modifier = Modifier.padding(end = 8.dp),
                        color = if (isSelected) MaterialTheme.colorScheme.onSecondaryContainer
                        else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun transparentListItemColors() =
    ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent)

private fun serverSummary(origin: String): String {
    val uri = Uri.parse(origin)
    val host = uri.host ?: return "服务器地址已配置"
    val port = uri.port.takeIf { it >= 0 }?.let { ":$it" }.orEmpty()
    val scheme = uri.scheme?.uppercase() ?: "HTTPS"
    return "$scheme · $host$port"
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
                )
                .defaultMinSize(minHeight = 64.dp),
        colors = transparentListItemColors(),
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
