package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.QuickCaptureBottomSheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit
) {
    val tasks by viewModel.inboxTasks.collectAsState()
    val projects by viewModel.projects.collectAsState()
    var showCapture by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("收集箱", style = MaterialTheme.typography.titleLarge)
                        Text(
                            "未规划与全局杂项 (${tasks.size})",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showCapture = true },
                icon = { Icon(Icons.Default.Add, contentDescription = "新增") },
                text = { Text("记录到收集箱") },
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                contentColor = MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
    ) { padding ->
        if (tasks.isEmpty()) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "收集箱已清空",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "所有杂项任务均已妥善排期",
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
                contentPadding = PaddingValues(bottom = 80.dp)
            ) {
                items(tasks, key = { it.id }) { task ->
                    M3TaskRow(
                        task = task,
                        onClick = { onNavigateToDetail(task.id) },
                        onStatusToggle = { next -> viewModel.updateTaskStatus(task, next) }
                    )
                }
            }
        }
    }

    if (showCapture) {
        QuickCaptureBottomSheet(
            onDismiss = { showCapture = false },
            projects = projects,
            onSave = { title, _, scheduleToday ->
                viewModel.createTask(title, null, scheduleToday)
                showCapture = false
            }
        )
    }
}
