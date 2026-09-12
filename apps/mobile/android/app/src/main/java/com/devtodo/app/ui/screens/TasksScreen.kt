package com.devtodo.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.QuickCaptureBottomSheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToProjects: () -> Unit
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
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text("任务库", style = MaterialTheme.typography.titleLarge) },
                actions = {
                    IconButton(onClick = onNavigateToProjects) {
                        Icon(Icons.Default.Folder, contentDescription = "项目管理")
                    }
                }
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
                projects.forEach { project ->
                    FilterChip(
                        selected = selectedProjectId == project.id,
                        onClick = {
                            selectedProjectId = if (selectedProjectId == project.id) {
                                null
                            } else {
                                project.id
                            }
                        },
                        label = {
                            Text(
                                project.name,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 160.dp)
                            )
                        }
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilterChip(
                    selected = selectedStatus == null,
                    onClick = { selectedStatus = null },
                    label = { Text("全部状态") }
                )
                listOf(
                    TaskStatus.TODO to "待办",
                    TaskStatus.IN_PROGRESS to "进行中",
                    TaskStatus.DONE to "已完成"
                ).forEach { (status, label) ->
                    FilterChip(
                        selected = selectedStatus == status,
                        onClick = {
                            selectedStatus = if (selectedStatus == status) null else status
                        },
                        label = { Text(label) }
                    )
                }
            }

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentPadding = PaddingValues(top = 8.dp, bottom = 112.dp)
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
            initialProjectId = selectedProjectId,
            onSave = { title, projectId, scheduleToday ->
                viewModel.createTask(title, projectId, scheduleToday)
                showCapture = false
            }
        )
    }
}
