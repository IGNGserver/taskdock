package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TimePointEntity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: ((String) -> Unit)? = null,
    onNavigateToTree: ((String?, String?) -> Unit)? = null
) {
    val events by viewModel.activeEvents.collectAsState()
    var selectedEvent by remember { mutableStateOf<TimePointEntity?>(null) }
    var showCreateTaskDialog by rememberSaveable { mutableStateOf(false) }
    var newTaskTitle by rememberSaveable { mutableStateOf("") }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text("时间与里程碑", style = MaterialTheme.typography.titleLarge) }
            )
        }
    ) { padding ->
        if (events.isEmpty()) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "暂无活动事件",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.size(4.dp))
                    Text(
                        "在 Web 端或中枢创建发布窗口与关键节点",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(events, key = { it.id }) { event ->
                    val placements by viewModel.observeTimePointPlacements(event.id).collectAsState(initial = emptyList())
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(
                                    Icons.Default.Event,
                                    contentDescription = "事件",
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(24.dp)
                                )
                                Spacer(modifier = Modifier.width(12.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        event.title ?: "未命名里程碑",
                                        style = MaterialTheme.typography.titleMedium,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Text(
                                        "安排任务: ${placements.size} 个",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                TextButton(onClick = {
                                    selectedEvent = event
                                    showCreateTaskDialog = true
                                }) {
                                    Icon(Icons.Default.Add, contentDescription = null)
                                    Text("添加任务")
                                }
                            }
                            if (placements.isNotEmpty()) {
                                Spacer(modifier = Modifier.height(8.dp))
                                placements.forEach { placement ->
                                    PlacementTaskItem(
                                        viewModel = viewModel,
                                        placement = placement,
                                        onNavigateToDetail = onNavigateToDetail,
                                        onNavigateToTree = onNavigateToTree
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreateTaskDialog && selectedEvent != null) {
        AlertDialog(
            onDismissRequest = {
                showCreateTaskDialog = false
                selectedEvent = null
                newTaskTitle = ""
            },
            title = { Text("在「${selectedEvent?.title}」创建新任务") },
            text = {
                OutlinedTextField(
                    value = newTaskTitle,
                    onValueChange = { newTaskTitle = it },
                    label = { Text("任务标题") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        selectedEvent?.let { ev ->
                            viewModel.createTreeTaskV2AtTimePoint(newTaskTitle, ev.id, false)
                        }
                        showCreateTaskDialog = false
                        selectedEvent = null
                        newTaskTitle = ""
                    },
                    enabled = newTaskTitle.trim().isNotEmpty()
                ) { Text("创建任务与安排") }
            },
            dismissButton = {
                TextButton(onClick = {
                    showCreateTaskDialog = false
                    selectedEvent = null
                    newTaskTitle = ""
                }) { Text("取消") }
            }
        )
    }
}

@Composable
private fun PlacementTaskItem(
    viewModel: MainViewModel,
    placement: com.devtodo.app.data.local.PlacementEntity,
    onNavigateToDetail: ((String) -> Unit)?,
    onNavigateToTree: ((String?, String?) -> Unit)?
) {
    val task by viewModel.observeTaskById(placement.taskId).collectAsState(initial = null)
    task?.let { t ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextButton(onClick = { onNavigateToDetail?.invoke(t.id) }, modifier = Modifier.weight(1f)) {
                Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = { onNavigateToTree?.invoke(t.parentFolderId, t.id) }) {
                Text("在目录中显示")
            }
        }
    }
}
