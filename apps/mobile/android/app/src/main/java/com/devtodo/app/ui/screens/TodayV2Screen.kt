package com.devtodo.app.ui.screens

import androidx.compose.animation.*
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.Today
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: ((String?, String?) -> Unit)? = null,
    onBack: (() -> Unit)? = null,
) {
    val scheduled by viewModel.todayTasks.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val folderAggregates by viewModel.folderAggregates.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val ready by viewModel.dataReady.collectAsStateWithLifecycle()
    val loadProgress by viewModel.loadProgress.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    val timezone = settings?.timezone ?: "Asia/Shanghai"
    val today = currentLocalDate(timezone)
    val todayLabel = SimpleDateFormat("M月d日 EEEE", Locale.CHINESE).apply {
        timeZone = TimeZone.getTimeZone(timezone)
    }.format(Date())
    var showDone by rememberSaveable { mutableStateOf(false) }
    var chooseExisting by rememberSaveable { mutableStateOf(false) }
    val done = scheduled.count { it.first.status == TaskStatus.DONE }
    val total = scheduled.size
    val pending = total - done
    val progress by animateFloatAsState(
        targetValue = if (total == 0) 0f else done.toFloat() / total,
        animationSpec = TaskDockMotion.springEffects(),
        label = "todayProgress",
    )

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("今天") },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回目录") }
                },
                actions = {
                    IconButton(onClick = { chooseExisting = true }) { Icon(Icons.Default.Add, "从已有任务安排到今天") }
                },
            )
        },
        bottomBar = { TaskCaptureIsland(viewModel, initialDate = today, primaryLabel = "记一件事", useCapturePreference = true) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing, onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(Modifier.fillMaxSize().testTag("today-task-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "today-summary") {
                    Surface(
                        Modifier.fillMaxWidth().padding(16.dp)
                            .animateContentSize(animationSpec = TaskDockMotion.springSpatial()),
                        shape = TaskDockShapes.HeroShape,
                        color = MaterialTheme.colorScheme.primaryContainer) {
                        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(todayLabel, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                            Text(when {
                                total == 0 && !loadProgress.complete -> "正在恢复今日安排"
                                total == 0 -> "从一件小事开始"
                                pending == 0 -> "今天的安排已完成"
                                else -> "还有 $pending 件待办"
                            }, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
                            if (total > 0) {
                                LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(6.dp),
                                    color = MaterialTheme.colorScheme.primary, trackColor = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.12f))
                                Text("已完成 $done / $total", style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer)
                            }
                            TextButton(onClick = { chooseExisting = true }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text("从已有任务中挑选")
                            }
                        }
                    }
                }
                if (scheduled.isEmpty() && (!ready || !loadProgress.complete)) {
                    item { Text("今日安排尚未加载完整，请查看顶部更新状态。", Modifier.padding(16.dp)) }
                } else if (scheduled.isEmpty()) {
                    item {
                        EmptyState(Icons.Default.Today, "今天还没有安排", "记一件事，或从已有任务中挑选。")
                    }
                }
                listOf(TaskStatus.IN_PROGRESS, TaskStatus.TODO).forEach { status ->
                    val group = scheduled.filter { it.first.status == status }
                    if (group.isNotEmpty()) {
                        item(key = "heading-$status") { SectionHeading("${taskStatusLabel(status)} · ${group.size}") }
                        itemsIndexed(group, key = { _, pair -> pair.first.id }) { index, (task, placement) ->
                            ExpressiveTaskCard(
                                task, { onNavigateToDetail(task.id) }, { viewModel.updateTaskStatus(task, it) },
                                projectName = folderPath(task.parentFolderId, folders), showStatus = false,
                                actions = listOf(RowAction("从今日移除") { viewModel.removePlacement(placement) }),
                                rowShape = TaskDockShapes.groupedRow(index, group.size),
                                modifier = Modifier.animateItem(),
                            )
                        }
                    }
                }
                val completed = scheduled.filter { it.first.status == TaskStatus.DONE }
                if (completed.isNotEmpty()) {
                    item(key = "completed-heading") {
                        TextButton(onClick = { showDone = !showDone }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp)) {
                            Text("已完成 · ${completed.size}", modifier = Modifier.weight(1f))
                            Icon(if (showDone) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                if (showDone) "收起已完成任务" else "展开已完成任务")
                        }
                    }
                    item(key = "completed-content") {
                        AnimatedVisibility(
                            visible = showDone,
                            enter = fadeIn(TaskDockMotion.springEffectsFast()) +
                                expandVertically(TaskDockMotion.springSpatial()),
                            exit = fadeOut(TaskDockMotion.springEffectsFast()) +
                                shrinkVertically(TaskDockMotion.springSpatial()),
                        ) {
                            Column {
                                completed.forEachIndexed { index, (task, placement) ->
                                    ExpressiveTaskCard(
                                        task,
                                        { onNavigateToDetail(task.id) },
                                        { viewModel.updateTaskStatus(task, it) },
                                        showStatus = false,
                                        actions = listOf(RowAction("从今日移除") { viewModel.removePlacement(placement) }),
                                        rowShape = TaskDockShapes.groupedRow(index, completed.size),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (chooseExisting) {
        val allTasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
        val scheduledIds = remember(scheduled) { scheduled.map { it.first.id }.toSet() }
        DirectoryTaskPickerDialog(
            title = "安排到今天",
            allFolders = folders,
            allTasks = allTasks,
            folderAggregates = folderAggregates,
            alreadyScheduledTaskIds = scheduledIds,
            onDismiss = { chooseExisting = false },
            onConfirm = { ids ->
                val targetTasks = allTasks.filter { it.id in ids }
                viewModel.scheduleTasks(targetTasks, today) { failure ->
                    if (failure == null) chooseExisting = false
                }
            },
        )
    }
}
