package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.model.TaskStatus
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    taskId: String,
    viewModel: MainViewModel,
    onBack: () -> Unit
) {
    val haptic = LocalHapticFeedback.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val task by viewModel.observeTask(taskId).collectAsState(initial = null)
    val note by viewModel.observeNote(taskId).collectAsState(initial = null)
    val dataReady by viewModel.dataReady.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var title by rememberSaveable(taskId) { mutableStateOf("") }
    var markdownContent by rememberSaveable(taskId) { mutableStateOf("") }
    var titleInitialized by rememberSaveable(taskId) { mutableStateOf(false) }
    var noteInitialized by rememberSaveable(taskId) { mutableStateOf(false) }
    var isSaving by rememberSaveable(taskId) { mutableStateOf(false) }
    var showArchiveDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDatePicker by rememberSaveable(taskId) { mutableStateOf(false) }
    var scheduleCopy by rememberSaveable(taskId) { mutableStateOf(false) }
    val datePickerState = rememberDatePickerState(initialSelectedDateMillis = System.currentTimeMillis())

    LaunchedEffect(task?.id) {
        task?.let { currentTask ->
            if (!titleInitialized) {
                title = currentTask.title
                titleInitialized = true
            }
        }
    }
    LaunchedEffect(note?.id) {
        note?.let { currentNote ->
            if (!noteInitialized) {
                markdownContent = currentNote.contentMarkdown
                noteInitialized = true
            }
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text("任务详情", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        onBack()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        when {
            task != null -> {
                val currentTask = task!!
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .navigationBarsPadding()
                        .imePadding()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    OutlinedTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = { Text("任务标题") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
                    )

                    Text("任务状态", style = MaterialTheme.typography.labelLarge)
                    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                        TaskStatus.values().forEachIndexed { index, status ->
                            SegmentedButton(
                                shape = SegmentedButtonDefaults.itemShape(
                                    index = index,
                                    count = TaskStatus.values().size
                                ),
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    viewModel.updateTaskStatus(currentTask, status)
                                },
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
                            .heightIn(min = 144.dp),
                        minLines = 6
                    )

                    Button(
                        onClick = {
                            if (isSaving) return@Button
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            scope.launch {
                                isSaving = true
                                val result = viewModel.saveTaskDetails(
                                    task = currentTask,
                                    title = title,
                                    markdownContent = markdownContent
                                )
                                isSaving = false
                                result.onSuccess {
                                    onBack()
                                }.onFailure { error ->
                                    snackbarHostState.showSnackbar(
                                        error.message ?: "保存失败，请稍后重试"
                                    )
                                }
                            }
                        },
                        enabled = !isSaving,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        if (isSaving) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Text("保存更改")
                        }
                    }

                    TextButton(
                        onClick = { showArchiveDialog = true },
                        enabled = !isSaving,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            "归档任务",
                            color = MaterialTheme.colorScheme.error
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        TextButton(
                            onClick = {
                                scheduleCopy = false
                                showDatePicker = true
                            },
                            enabled = !isSaving
                        ) {
                            Text("移动到日期")
                        }
                        TextButton(
                            onClick = {
                                scheduleCopy = true
                                showDatePicker = true
                            },
                            enabled = !isSaving
                        ) {
                            Text("复制到日期")
                        }
                    }
                }
            }

            dataReady -> {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("找不到任务", style = MaterialTheme.typography.titleMedium)
                        Button(onClick = onBack) {
                            Text("返回")
                        }
                    }
                }
            }

            else -> {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                ) {
                    CircularProgressIndicator()
                }
            }
        }
    }

    if (showArchiveDialog && task != null) {
        AlertDialog(
            onDismissRequest = { showArchiveDialog = false },
            title = { Text("归档任务？") },
            text = { Text("归档后任务会从当前列表隐藏，可在设置中的已归档列表恢复。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showArchiveDialog = false
                        viewModel.archiveTask(task!!) { onBack() }
                    }
                ) {
                    Text("归档")
                }
            },
            dismissButton = {
                TextButton(onClick = { showArchiveDialog = false }) {
                    Text("取消")
                }
            }
        )
    }

    if (showDatePicker && task != null) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        datePickerState.selectedDateMillis?.let { selectedDateMillis ->
                            val localDate = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                                timeZone = TimeZone.getTimeZone("UTC")
                            }.format(Date(selectedDateMillis))
                            viewModel.scheduleTask(
                                task = task!!,
                                localDate = localDate,
                                copy = scheduleCopy
                            ) {
                                showDatePicker = false
                            }
                        }
                    },
                    enabled = datePickerState.selectedDateMillis != null
                ) {
                    Text("确定")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) {
                    Text("取消")
                }
            }
        ) {
            DatePicker(state = datePickerState)
        }
    }
}
