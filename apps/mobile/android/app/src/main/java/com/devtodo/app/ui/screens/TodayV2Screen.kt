package com.devtodo.app.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Today
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Material 3 Expressive Today View.
 * Focus-first view with dynamic progress header, fluid cards, and bottom Floating Action Island.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: ((String?, String?) -> Unit)? = null,
    onBack: (() -> Unit)? = null,
) {
    val scheduled by viewModel.todayTasks.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val ready by viewModel.dataReady.collectAsStateWithLifecycle()
    val refreshing by viewModel.todayRefreshing.collectAsStateWithLifecycle()

    val todayLabel = remember(settings?.timezone) {
        SimpleDateFormat("M月d日 EEEE", Locale.CHINESE).apply {
            timeZone = TimeZone.getTimeZone(settings?.timezone ?: "Asia/Shanghai")
        }.format(Date())
    }

    val done = scheduled.count { it.first.status == TaskStatus.DONE }
    val total = scheduled.size
    val pending = total - done

    PredictiveBackContainer(
        enabled = onBack != null,
        onBack = { onBack?.invoke() },
    ) {
        WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("今天", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回目录")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        },
        bottomBar = {
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                FloatingActionIsland(
                    onQuickCreate = { title ->
                        viewModel.createTreeTaskV2AtToday(title)
                    },
                    placeholder = "向今天添加任务…",
                    primaryLabel = "安排今日任务",
                )
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::refreshToday,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                // Expressive Today Hero Card
                item {
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        shape = TaskDockShapes.LargeIncreased,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Column(
                            modifier = Modifier.padding(20.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = todayLabel,
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = if (total == 0) "今天暂时没有任务安排" else if (pending == 0) "干得漂亮！今日任务全部完成" else "$pending 项任务待完成",
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                            )

                            if (total > 0) {
                                Spacer(Modifier.height(4.dp))
                                LinearProgressIndicator(
                                    progress = { done.toFloat() / total },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(8.dp)
                                        .clip(TaskDockShapes.FullPill),
                                    color = MaterialTheme.colorScheme.primary,
                                    trackColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                                )
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(
                                        text = "完成进度: ${(done * 100f / total).toInt()}%",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Text(
                                        text = "已完成 $done / $total",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontWeight = FontWeight.Medium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }

                if (!ready) {
                    item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                } else if (scheduled.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Default.Today,
                            title = "专注当下的每一刻",
                            description = "利用下方输入框为今天安排任务，或从已有目录树中挑选待办。",
                            action = {
                                if (onNavigateToTree != null) {
                                    FilledTonalButton(
                                        onClick = { onNavigateToTree.invoke(null, null) },
                                        shape = TaskDockShapes.FullPill,
                                    ) {
                                        Text("浏览目录树")
                                    }
                                }
                            },
                        )
                    }
                }

                // Grouped Status Tasks with Expressive Cards
                listOf(TaskStatus.IN_PROGRESS, TaskStatus.TODO, TaskStatus.DONE).forEach { status ->
                    val group = scheduled.filter { it.first.status == status }
                    if (group.isNotEmpty()) {
                        item {
                            SectionHeading("${taskStatusLabel(status)} · ${group.size}")
                        }
                        items(group, key = { it.first.id }) { pair ->
                            val task = pair.first
                            val placement = pair.second
                            ExpressiveTaskCard(
                                task = task,
                                onClick = { onNavigateToDetail(task.id) },
                                onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                                actions = listOf(
                                    RowAction("从今日移除") { viewModel.removePlacement(placement) },
                                ),
                            )
                        }
                    }
                }
            }
        }
    }
    }
}
