package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.NoteEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    taskId: String,
    viewModel: MainViewModel,
    onBack: () -> Unit
) {
    var task by remember { mutableStateOf<TaskEntity?>(null) }
    var title by remember { mutableStateOf("") }
    var markdownContent by remember { mutableStateOf("") }

    LaunchedEffect(taskId) {
        task = viewModel.allTasks.value.find { it.id == taskId }
        title = task?.title ?: ""
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("任务详情", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        }
    ) { padding ->
        task?.let { currentTask ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("任务标题") },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp)
                )

                Text("任务状态", style = MaterialTheme.typography.labelLarge)
                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    TaskStatus.values().forEachIndexed { index, status ->
                        SegmentedButton(
                            shape = SegmentedButtonDefaults.itemShape(index = index, count = TaskStatus.values().size),
                            onClick = { viewModel.updateTaskStatus(currentTask, status) },
                            selected = currentTask.status == status
                        ) {
                            Text(
                                when (status) {
                                    TaskStatus.TODO -> "待办"
                                    TaskStatus.IN_PROGRESS -> "进行中"
                                    TaskStatus.DONE -> "已完成"
                                }
                            )
                        }
                    }
                }

                Text("Markdown 备注", style = MaterialTheme.typography.labelLarge)
                OutlinedTextField(
                    value = markdownContent,
                    onValueChange = { markdownContent = it },
                    placeholder = { Text("支持 Markdown 语法与代码块…") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(180.dp),
                    shape = RoundedCornerShape(12.dp)
                )

                Button(
                    onClick = { onBack() },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text("保存更改")
                }
            }
        } ?: Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxSize().padding(padding)
        ) {
            CircularProgressIndicator()
        }
    }
}
