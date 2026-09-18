package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.M3TaskRow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: ((String?, String?) -> Unit)? = null
) {
    val scheduled by viewModel.todayTasks.collectAsState()
    var showCreate by rememberSaveable { mutableStateOf(false) }
    var title by rememberSaveable { mutableStateOf("") }
    val done = scheduled.count { it.first.status == TaskStatus.DONE }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { TopAppBar(title = { Text("今日 · $done/${scheduled.size} 已完成") }) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showCreate = true },
                icon = { Icon(Icons.Default.Add, contentDescription = "新建任务") },
                text = { Text("新建今日任务") },
            )
        },
    ) { padding ->
        if (scheduled.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("今天还没有安排任务")
                Text("这里只创建 Task，并通过 Placement 安排到今天。")
                Button(onClick = { showCreate = true }) { Text("新建任务") }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                items(scheduled, key = { it.second.id }) { (task, _) ->
                    Column(modifier = Modifier.fillMaxWidth()) {
                        M3TaskRow(
                            task = task,
                            showPriority = false,
                            dateBadge = "今天",
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { next -> viewModel.updateTaskStatus(task, next) },
                        )
                        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp), horizontalArrangement = Arrangement.End) {
                            TextButton(onClick = { onNavigateToTree?.invoke(task.parentFolderId, task.id) }) {
                                Text("在目录中显示")
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("新建今日任务") },
            text = {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("任务标题") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    enabled = title.trim().isNotEmpty(),
                    onClick = {
                        viewModel.createTreeTaskV2AtToday(title)
                        title = ""
                        showCreate = false
                    },
                ) { Text("创建") }
            },
            dismissButton = { TextButton(onClick = { showCreate = false }) { Text("取消") } },
        )
    }
}
