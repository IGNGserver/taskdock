package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.model.TimePointType
import com.devtodo.app.ui.components.*
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: ((String) -> Unit)? = null,
    onNavigateToTree: ((String?, String?) -> Unit)? = null,
) {
    val points by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedDate by rememberSaveable { mutableStateOf<String?>(null) }
    var datePicker by rememberSaveable { mutableStateOf(false) }
    val dateState = rememberDatePickerState()
    WorkspaceScaffold(
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { datePicker = true },
                icon = { Icon(Icons.Default.Add, null) },
                text = { Text("安排任务") },
            )
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            if (points.isEmpty())
                item {
                    EmptyState(
                        Icons.Default.Event,
                        "还没有日期或事件",
                        "选择一个日期安排任务；已有事件会在同步后显示。",
                    )
                }
            items(points, key = { it.id }) { point ->
                val placements by
                    remember(point.id) { viewModel.observeTimePointPlacements(point.id) }
                        .collectAsStateWithLifecycle(initialValue = emptyList())
                val visible =
                    placements.mapNotNull { placement ->
                        tasks.find {
                            it.id == placement.taskId &&
                                it.archivedAt == null &&
                                it.deletedAt == null
                        }
                    }
                ListItem(
                    headlineContent = {
                        Text(
                            if (point.type == TimePointType.DATE) point.localDate.orEmpty()
                            else point.title ?: "未命名事件"
                        )
                    },
                    supportingContent = {
                        val context =
                            if (point.type == TimePointType.DATE) "日期安排"
                            else if (point.reachedAt != null) "已到达事件"
                            else "未到达事件"
                        Text("$context · ${visible.size} 个任务")
                    },
                    leadingContent = {
                        Icon(Icons.Default.Event, null, tint = MaterialTheme.colorScheme.primary)
                    },
                    trailingContent = {
                        IconButton(onClick = { selectedId = point.id }) {
                            Icon(Icons.Default.Add, "在此计划中新建任务")
                        }
                    },
                    colors =
                        ListItemDefaults.colors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerLow
                        ),
                )
                visible.forEach { task ->
                    M3TaskRow(
                        task,
                        onClick = { onNavigateToDetail?.invoke(task.id) },
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
    if (datePicker)
        DatePickerDialog(
            onDismissRequest = { datePicker = false },
            confirmButton = {
                TextButton(
                    enabled = dateState.selectedDateMillis != null,
                    onClick = {
                        selectedDate =
                            SimpleDateFormat("yyyy-MM-dd", Locale.US)
                                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                                .format(Date(dateState.selectedDateMillis!!))
                        datePicker = false
                    },
                ) {
                    Text("选择日期")
                }
            },
            dismissButton = { TextButton(onClick = { datePicker = false }) { Text("取消") } },
        ) {
            DatePicker(dateState)
        }
    if (selectedId != null || selectedDate != null)
        CaptureSheet(
            "新建安排",
            onDismiss = {
                selectedId = null
                selectedDate = null
            },
        ) {
            viewModel.createTreeTaskV2AtTimePoint(
                it,
                selectedDate ?: selectedId!!,
                selectedDate != null,
            )
        }
}
