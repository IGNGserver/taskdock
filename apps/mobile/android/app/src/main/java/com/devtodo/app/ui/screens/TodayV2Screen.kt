package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Today
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: ((String?, String?) -> Unit)? = null,
) {
    val scheduled by viewModel.todayTasks.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val ready by viewModel.dataReady.collectAsStateWithLifecycle()
    val refreshing by viewModel.todayRefreshing.collectAsStateWithLifecycle()
    val todayLabel =
        remember(settings?.timezone) {
            SimpleDateFormat("yyyy-MM-dd (EEE)", Locale.getDefault()).apply {
                timeZone = TimeZone.getTimeZone(settings?.timezone ?: "Asia/Shanghai")
            }.format(Date())
        }
    var create by rememberSaveable { mutableStateOf(false) }
    val done = scheduled.count { it.first.status == TaskStatus.DONE }
    WorkspaceScaffold(
        topBar = { TopAppBar(title = { Text("今日") }, windowInsets = WindowInsets(0, 0, 0, 0)) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { create = true },
                icon = { Icon(Icons.Default.Add, null) },
                text = { Text("新建任务") },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::refreshToday,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                item {
                    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            todayLabel,
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            if (scheduled.isEmpty()) "为今天留一点专注" else "${scheduled.size - done} 项待完成",
                            style = MaterialTheme.typography.headlineMedium,
                        )
                        if (scheduled.isNotEmpty()) {
                            LinearProgressIndicator(
                                progress = { done.toFloat() / scheduled.size },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text(
                                "已完成 $done / ${scheduled.size}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                if (!ready) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                else if (scheduled.isEmpty())
                    item {
                        if (onNavigateToTree != null) {
                            EmptyState(
                                Icons.Default.Today,
                                "今天还没有安排",
                                "先新建一个任务，或从任务库加入已有任务。",
                                action = {
                                    FilledTonalButton(onClick = { onNavigateToTree.invoke(null, null) }) {
                                        Text("打开任务库")
                                    }
                                },
                            )
                        } else {
                            EmptyState(
                                Icons.Default.Today,
                                "今天还没有安排",
                                "先新建一个任务，或从任务库加入已有任务。",
                            )
                        }
                    }
                listOf(TaskStatus.IN_PROGRESS, TaskStatus.TODO, TaskStatus.DONE).forEach { status ->
                    val group = scheduled.filter { it.first.status == status }
                    if (group.isNotEmpty()) {
                        item(key = status.name) {
                            SectionHeading("${taskStatusLabel(status)} · ${group.size}")
                        }
                        items(group, key = { it.second.id }) { (task, _) ->
                            M3TaskRow(
                                task,
                                onClick = { onNavigateToDetail(task.id) },
                                onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                                actions =
                                    listOf(
                                        RowAction("在目录中显示") {
                                            onNavigateToTree?.invoke(task.parentFolderId, task.id)
                                        }
                                    ),
                            )
                        }
                    }
                }
            }
        }
    }
    if (create)
        CaptureSheet(
            "新建今日任务",
            onDismiss = { create = false },
            onCreate = viewModel::createTreeTaskV2AtToday,
        )
}
