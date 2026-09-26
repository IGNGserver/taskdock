package com.devtodo.app.ui.screens

import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
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
import com.devtodo.app.ui.components.PredictiveBackContainer
import com.devtodo.app.ui.components.RowAction
import com.devtodo.app.ui.components.WorkspaceScaffold
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.ThemeMode

/**
 * Material 3 Expressive Settings Screen.
 * Featuring expressive sync status hero card, fluid pill selection chips,
 * and unified surface containers.
 */
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

    PredictiveBackContainer(
        enabled = onBack != null,
        onBack = { onBack?.invoke() },
    ) {
        WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 48.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Expressive Sync & Account Card
            ExpressiveSyncSummaryCard(
                username = viewModel.authManager.username ?: "当前账户",
                state = sync,
                pendingCount = pending.size,
                conflictCount = conflicts.size,
                error = error,
                onSync = viewModel::syncNow,
                onReauthenticate = { logout = true },
            )

            // Server Connection Group
            ExpressiveSettingsGroup(
                title = "服务器中枢",
                description = serverSummary(viewModel.authManager.hubOrigin),
            ) {
                SettingsActionRow(
                    title = "中枢服务地址",
                    subtitle = "完整地址只在编辑时显示",
                    actionLabel = "更改",
                ) {
                    hub = viewModel.authManager.hubOrigin
                    showHub = true
                }
            }

            // Sync Queue Group
            ExpressiveSettingsGroup(
                title = "离线同步队列",
                description = "${pending.size} 项本地待提交 · ${conflicts.size} 项冲突",
            ) {
                SettingsActionRow(
                    title = "本地待处理队列",
                    subtitle = if (pending.isEmpty() && conflicts.isEmpty()) "队列畅通，无积压操作" else "查看、重试或丢弃离线队列",
                    actionLabel = if (queue) "收起" else "查看",
                ) {
                    queue = !queue
                }

                AnimatedVisibility(queue) {
                    Column(Modifier.padding(bottom = 8.dp)) {
                        if (conflicts.isNotEmpty()) {
                            Text(
                                text = "存在版本冲突。请在 Web 端“设置 → 高级同步”中检视并解决冲突。",
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 8.dp),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        conflicts.forEach { conflict ->
                            ListItem(
                                headlineContent = { Text(conflict.command ?: conflict.entityType) },
                                supportingContent = { Text("记录 ID: ${conflict.entityId.take(8)}") },
                                colors = transparentListItemColors(),
                            )
                        }
                        pending.forEach { item ->
                            ListItem(
                                headlineContent = { Text(item.command) },
                                supportingContent = { Text(item.lastError ?: "等待同步") },
                                trailingContent = {
                                    ActionMenu(
                                        "待提交操作",
                                        listOf(
                                            RowAction("立即重试") { viewModel.retryOutboxItem(item) },
                                            RowAction("丢弃操作", destructive = true) { discard = item },
                                        ),
                                    )
                                },
                                colors = transparentListItemColors(),
                            )
                        }
                    }
                }
            }

            // Date & Regional Group
            ExpressiveSettingsGroup(
                title = "日期与安排设置",
                description = "日期规划与今日视图的时间准则。",
            ) {
                SettingsActionRow(
                    title = "工作区时区",
                    subtitle = timezoneLabel(settings?.timezone ?: "Asia/Shanghai"),
                    actionLabel = "更改",
                ) {
                    showTimezone = true
                }

                ExpressiveChoiceRow(
                    title = "每周起始日",
                    options = listOf(1 to "周一", 0 to "周日"),
                    selected = settings?.weekStartsOn ?: 1,
                    onSelect = { viewModel.updateSettings(weekStartsOn = it) },
                )

                ExpressiveChoiceRow(
                    title = "新任务默认捕获至",
                    options = listOf("ROOT" to "根目录", "RECENT_FOLDER" to "最近文件夹"),
                    selected = settings?.defaultCaptureTarget ?: "ROOT",
                    onSelect = { viewModel.updateSettings(defaultCaptureTarget = it) },
                )
            }

            // Appearance & Themes Group
            ExpressiveSettingsGroup(
                title = "外观与主题",
                description = "采用 Material 3 Expressive 色阶与动效。",
            ) {
                ExpressiveChoiceRow(
                    title = "色彩模式",
                    options = listOf(
                        ThemeMode.SYSTEM to "跟随系统",
                        ThemeMode.LIGHT to "浅色",
                        ThemeMode.DARK to "深色",
                    ),
                    selected = theme,
                    onSelect = onThemeModeChange,
                )

                ExpressiveSwitchRow(
                    title = "Material You 动态配色",
                    subtitle = if (Build.VERSION.SDK_INT >= 31) "提取系统壁纸颜色呈现" else "需要 Android 12 或更新版本",
                    checked = dynamic,
                    onCheckedChange = onDynamicColorChange,
                    enabled = Build.VERSION.SDK_INT >= 31,
                )

                ExpressiveSwitchRow(
                    title = "AMOLED 纯黑底色",
                    subtitle = "在深色模式下使用纯黑背景降低能耗",
                    checked = black,
                    onCheckedChange = onPureBlackChange,
                )
            }

            // Data & Actions Group
            ExpressiveSettingsGroup(title = "数据与账户") {
                SettingsActionRow(
                    title = "归档中心",
                    subtitle = "检视并恢复已归档的任务与目录",
                    actionLabel = "打开",
                    onClick = onNavigateToArchived,
                )

                SettingsActionRow(
                    title = "退出当前账户",
                    subtitle = "本地任务将安全保留；未提交操作需重新登录原账户同步。",
                    actionLabel = "退出",
                    destructive = true,
                ) {
                    logout = true
                }
            }
        }
    }

    if (showTimezone) {
        AlertDialog(
            onDismissRequest = { showTimezone = false },
            title = { Text("选择工作区时区") },
            text = {
                Column(Modifier.selectableGroup()) {
                    listOf(
                        "Asia/Shanghai" to "中国标准时间 (UTC+08:00)",
                        "Asia/Tokyo" to "日本标准时间 (UTC+09:00)",
                        "UTC" to "协调世界时 (UTC)",
                        "America/Los_Angeles" to "太平洋时间 (US/Pacific)",
                    ).forEach { (value, label) ->
                        val selected = settings?.timezone == value
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(TaskDockShapes.Medium)
                                .selectable(
                                    selected = selected,
                                    role = Role.RadioButton,
                                    onClick = {
                                        viewModel.updateSettings(timezone = value)
                                        showTimezone = false
                                    },
                                )
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selected, onClick = null)
                            Spacer(Modifier.width(12.dp))
                            Text(label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showTimezone = false }) { Text("取消") } },
        )
    }

    if (showHub) {
        AlertDialog(
            onDismissRequest = { showHub = false },
            title = { Text("配置服务器中枢地址") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = hub,
                        onValueChange = { hub = it },
                        label = { Text("中枢服务地址") },
                        singleLine = true,
                        shape = TaskDockShapes.Medium,
                        isError = hub.isNotBlank() && normalizedHubOrigin(hub) == null,
                        supportingText = {
                            Text(
                                if (hub.startsWith("http://")) "HTTP 明文传输仅建议在家庭内网或受信任局域网使用。"
                                else "请输入 HTTP 或 HTTPS 完整地址（例如 https://todo.example.com）。"
                            )
                        },
                    )
                    if (pending.isNotEmpty()) {
                        Text("当前有未同步操作，请等待同步完毕后再切换服务器。", color = MaterialTheme.colorScheme.error)
                    }
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
    }

    confirmOrigin?.let { origin ->
        AlertDialog(
            onDismissRequest = { confirmOrigin = null },
            title = { Text("切换服务器并重新登录？") },
            text = { Text("将切换连接至 $origin。当前本地已缓存任务仍会保留。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onLogout()
                        viewModel.authManager.hubOrigin = origin
                        confirmOrigin = null
                    }
                ) {
                    Text("切换并登录")
                }
            },
            dismissButton = { TextButton(onClick = { confirmOrigin = null }) { Text("取消") } },
        )
    }

    if (logout) {
        AlertDialog(
            onDismissRequest = { logout = false },
            title = { Text("退出登录？") },
            text = {
                Text(
                    if (pending.isEmpty()) "退出后本地任务仍然保留，再次登录即可恢复云端同步。"
                    else "注意：还有 ${pending.size} 项操作未提交至中枢。退出后须重新登录当前账户才能继续上传。"
                )
            },
            confirmButton = { TextButton(onClick = onLogout) { Text("确认退出") } },
            dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } },
        )
    }

    discard?.let { item ->
        AlertDialog(
            onDismissRequest = { discard = null },
            title = { Text("丢弃离线待提交操作？") },
            text = { Text("该操作将从离线队列彻底移除，可能造成多端数据不一致。确定丢弃？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.discardOutboxItem(item)
                        discard = null
                    }
                ) {
                    Text("丢弃", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { discard = null }) { Text("取消") } },
        )
    }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ExpressiveSyncSummaryCard(
    username: String,
    state: SyncState,
    pendingCount: Int,
    conflictCount: Int,
    error: String?,
    onSync: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        shape = TaskDockShapes.LargeIncreased,
        color = colors.primaryContainer.copy(alpha = 0.6f),
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    shape = TaskDockShapes.FullPill,
                    color = colors.primary,
                    modifier = Modifier.size(46.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = username.take(1).uppercase(),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = colors.onPrimary,
                        )
                    }
                }

                Spacer(Modifier.width(14.dp))

                Column(Modifier.weight(1f)) {
                    Text(
                        text = username,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = colors.onPrimaryContainer,
                    )
                    Text(
                        text = "同步状态: ${syncStateLabel(state)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onPrimaryContainer.copy(alpha = 0.8f),
                    )
                }

                if (state == SyncState.SYNCING) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.5.dp)
                }
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Surface(
                    shape = TaskDockShapes.FullPill,
                    color = colors.surface.copy(alpha = 0.8f),
                ) {
                    Text(
                        text = "$pendingCount 项待提交",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.onSurface,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }

                if (conflictCount > 0) {
                    Surface(
                        shape = TaskDockShapes.FullPill,
                        color = colors.errorContainer,
                    ) {
                        Text(
                            text = "$conflictCount 项冲突待解决",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.onErrorContainer,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
            }

            if (error != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Default.ErrorOutline, null, tint = colors.error, modifier = Modifier.size(18.dp))
                    Text(error, color = colors.error, style = MaterialTheme.typography.bodySmall)
                }
            }

            FilledTonalButton(
                onClick = if (state == SyncState.AUTH_REQUIRED) onReauthenticate else onSync,
                enabled = state != SyncState.SYNCING,
                shape = TaskDockShapes.FullPill,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    imageVector = if (state == SyncState.AUTH_REQUIRED) Icons.Default.AccountCircle else Icons.Default.CloudSync,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    when (state) {
                        SyncState.AUTH_REQUIRED -> "重新验证账户"
                        SyncState.SYNCING -> "正在双向同步…"
                        SyncState.OFFLINE -> "检查网络并重连"
                        SyncState.ERROR, SyncState.SERVER_UNAVAILABLE -> "重试同步"
                        SyncState.INCOMPATIBLE -> "检查版本协议"
                        SyncState.IDLE -> "立即同步"
                    }
                )
            }
        }
    }
}

@Composable
private fun ExpressiveSettingsGroup(
    title: String,
    description: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        shape = TaskDockShapes.LargeIncreased,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                if (description != null) {
                    Text(
                        text = description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            content()
        }
    }
}

@Composable
private fun SettingsActionRow(
    title: String,
    subtitle: String,
    actionLabel: String,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        FilledTonalButton(
            onClick = onClick,
            shape = TaskDockShapes.FullPill,
            colors = if (destructive) {
                ButtonDefaults.filledTonalButtonColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                )
            } else {
                ButtonDefaults.filledTonalButtonColors()
            },
        ) {
            Text(actionLabel)
        }
    }
}

@Composable
private fun <T> ExpressiveChoiceRow(
    title: String,
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEach { (value, label) ->
                val isSelected = selected == value
                FilterChip(
                    selected = isSelected,
                    onClick = { onSelect(value) },
                    label = { Text(label) },
                    shape = TaskDockShapes.FullPill,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun ExpressiveSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
        )
    }
}

@Composable
private fun transparentListItemColors() =
    ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface)

private fun syncStateLabel(state: SyncState): String =
    when (state) {
        SyncState.IDLE -> "就绪（已与云端同步）"
        SyncState.SYNCING -> "正在与中枢双向同步…"
        SyncState.OFFLINE -> "离线（本地优先工作）"
        SyncState.ERROR -> "同步出错，可手动重试"
        SyncState.AUTH_REQUIRED -> "会话已过期，请重新登录"
        SyncState.SERVER_UNAVAILABLE -> "中枢服务无法连接"
        SyncState.INCOMPATIBLE -> "服务协议版本不兼容"
    }

private fun serverSummary(origin: String): String =
    when {
        origin.startsWith("http://10.") ||
            origin.startsWith("http://192.168.") ||
            origin.startsWith("http://172.") -> "局域网中枢 ($origin)"
        origin.startsWith("https://") -> "安全中枢 ($origin)"
        origin.startsWith("http://") -> "公开 HTTP 中枢 ($origin)"
        else -> origin
    }

private fun timezoneLabel(tz: String): String =
    when (tz) {
        "Asia/Shanghai" -> "中国标准时间 (Asia/Shanghai)"
        "Asia/Tokyo" -> "日本标准时间 (Asia/Tokyo)"
        "UTC" -> "协调世界时 (UTC)"
        else -> tz
    }
