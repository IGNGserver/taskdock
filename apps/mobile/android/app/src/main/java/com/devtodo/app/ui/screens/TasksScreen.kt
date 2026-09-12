package com.devtodo.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.QuickCaptureBottomSheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit
) {
    val tasks by viewModel.allTasks.collectAsState()
    val projects by viewModel.projects.collectAsState()
    var selectedProjectId by remember { mutableStateOf<String?>(null) }
    var selectedStatus by remember { mutableStateOf<TaskStatus?>(null) }
    var showCapture by remember { mutableStateOf(false) }

    val filtered = tasks.filter { task ->
        (selectedProjectId == null || task.projectId == selectedProjectId) &&
        (selectedStatus == null || task.status == selectedStatus)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("任务库", style = MaterialTheme.typography.titleLarge) }
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showCapture = true },
                containerColor = MaterialTheme.colorScheme.primary
            ) {
                Icon(Icons.Default.Add, contentDescription = "新增")
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilterChip(
                    selected = selectedProjectId == null,
                    onClick = { selectedProjectId = null },
                    label = { Text("全部项目") }
                )
                projects.forEach { p ->
                    FilterChip(
                        selected = selectedProjectId == p.id,
                        onClick = { selectedProjectId = if (selectedProjectId == p.id) null else p.id },
                        label = { Text(p.name) }
                    )
                }
            }

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 80.dp)
            ) {
                items(filtered, key = { it.id }) { task ->
                    val project = projects.find { it.id == task.projectId }
                    M3TaskRow(
                        task = task,
                        projectName = project?.name,
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
            onSave = { title, projectId, scheduleToday ->
                viewModel.createTask(title, projectId ?: selectedProjectId, scheduleToday)
                showCapture = false
            }
        )
    }
}
