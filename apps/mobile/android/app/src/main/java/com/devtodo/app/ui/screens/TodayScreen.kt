package com.devtodo.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.QuickCaptureBottomSheet
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit
) {
    val items by viewModel.todayTasks.collectAsState()
    val projects by viewModel.projects.collectAsState()
    var showCapture by remember { mutableStateOf(false) }
    var completedExpanded by remember { mutableStateOf(false) }

    val active = items.filter { it.first.status != TaskStatus.DONE }
    val done = items.filter { it.first.status == TaskStatus.DONE }
    val total = items.size
    val progress = if (total > 0) done.size.toFloat() / total else 0f

    val dateFormat = SimpleDateFormat("M月d日 EEEE", Locale.CHINESE)
    val todayHeader = dateFormat.format(Date())

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(todayHeader, style = MaterialTheme.typography.titleLarge)
                        Text(
                            "今日焦点 · 已完成 ${done.size}/$total",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showCapture = true },
                icon = { Icon(Icons.Default.Add, contentDescription = "新增") },
                text = { Text("记录今日") },
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (total > 0) {
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp)),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant
                )
            }

            if (items.isEmpty()) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.fillMaxSize()
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "今日暂无安排",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            "点击下方按钮添加今日专注任务",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.outline
                        )
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 80.dp)
                ) {
                    items(active, key = { it.second.id }) { (task, _) ->
                        val project = projects.find { it.id == task.projectId }
                        M3TaskRow(
                            task = task,
                            projectName = project?.name,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { next -> viewModel.updateTaskStatus(task, next) }
                        )
                    }

                    if (done.isNotEmpty()) {
                        item {
                            Spacer(modifier = Modifier.height(12.dp))
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { completedExpanded = !completedExpanded }
                                    .padding(horizontal = 16.dp, vertical = 8.dp)
                            ) {
                                Text(
                                    "已完成 (${done.size})",
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f)
                                )
                                Icon(
                                    imageVector = if (completedExpanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        if (completedExpanded) {
                            items(done, key = { it.second.id }) { (task, _) ->
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
            }
        }
    }

    if (showCapture) {
        QuickCaptureBottomSheet(
            onDismiss = { showCapture = false },
            projects = projects,
            onSave = { title, projectId, scheduleToday ->
                viewModel.createTask(title, projectId, scheduleToday)
                showCapture = false
            }
        )
    }
}
