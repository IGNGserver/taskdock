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
    val steps by viewModel.observeTaskSteps(taskId).collectAsState(initial = emptyList())
    val folders by viewModel.foldersV2.collectAsState()
    val dataReady by viewModel.dataReady.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var title by rememberSaveable(taskId) { mutableStateOf("") }
    var markdownContent by rememberSaveable(taskId) { mutableStateOf("") }
    var titleInitialized by rememberSaveable(taskId) { mutableStateOf(false) }
    var noteInitialized by rememberSaveable(taskId) { mutableStateOf(false) }
    var isSaving by rememberSaveable(taskId) { mutableStateOf(false) }
    var showArchiveDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDeleteDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showMoveFolder by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDatePicker by rememberSaveable(taskId) { mutableStateOf(false) }
    var scheduleCopy by rememberSaveable(taskId) { mutableStateOf(false) }
    var newStepTitle by rememberSaveable(taskId) { mutableStateOf("") }
    var expandedStepId by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var stepDrafts by remember(taskId) { mutableStateOf<Map<String, StepDraft>>(emptyMap()) }
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

                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("所在目录", style = MaterialTheme.typography.labelLarge)
                            Text(folderPathLabel(currentTask.parentFolderId, folders))
                        }
                        TextButton(onClick = { showMoveFolder = true }) { Text("移动") }
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

                    Text("执行步骤", style = MaterialTheme.typography.labelLarge)
                    steps.forEachIndexed { index, step ->
                        val draft = stepDrafts[step.id] ?: StepDraft(step.title, step.noteMarkdown)
                        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                TextButton(onClick = { expandedStepId = if (expandedStepId == step.id) null else step.id }) {
                                    Text(if (expandedStepId == step.id) "收起" else "编辑")
                                }
                                Text(step.title, modifier = Modifier.weight(1f), maxLines = 1)
                                TextButton(onClick = { viewModel.moveStepV2(step, -1) }, enabled = index > 0) { Text("↑") }
                                TextButton(onClick = { viewModel.moveStepV2(step, 1) }, enabled = index < steps.lastIndex) { Text("↓") }
                                TextButton(onClick = { viewModel.deleteStepV2(step) }) { Text("删除", color = MaterialTheme.colorScheme.error) }
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                TaskStatus.values().forEach { status ->
                                    TextButton(onClick = { viewModel.updateStepStatusV2(step, status) }) {
                                        Text(
                                            when (status) {
                                                TaskStatus.TODO -> "待办"
                                                TaskStatus.IN_PROGRESS -> "进行中"
                                                TaskStatus.DONE -> "完成"
                                            },
                                            color = if (step.status == status) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                            if (expandedStepId == step.id) {
                                OutlinedTextField(
                                    value = draft.title,
                                    onValueChange = { value -> stepDrafts = stepDrafts + (step.id to draft.copy(title = value)) },
                                    label = { Text("步骤标题") },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                )
                                OutlinedTextField(
                                    value = draft.noteMarkdown,
                                    onValueChange = { value -> stepDrafts = stepDrafts + (step.id to draft.copy(noteMarkdown = value)) },
                                    label = { Text("步骤备注") },
                                    modifier = Modifier.fillMaxWidth(),
                                    minLines = 3,
                                )
                                TextButton(
                                    onClick = {
                                        viewModel.updateStepV2(step, draft.title, draft.noteMarkdown)
                                        expandedStepId = null
                                    },
                                    enabled = draft.title.trim().isNotEmpty(),
                                ) { Text("保存步骤") }
                            }
                        }
                    }
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = newStepTitle,
                            onValueChange = { newStepTitle = it },
                            label = { Text("新增步骤") },
                            modifier = Modifier.weight(1f),
                            singleLine = true
                        )
                        TextButton(
                            onClick = {
                                viewModel.createStepV2(taskId, newStepTitle)
                                newStepTitle = ""
                            },
                            enabled = newStepTitle.trim().isNotEmpty()
                        ) { Text("添加") }
                    }

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
                            if (currentTask.archivedAt == null) "归档任务" else "恢复任务",
                            color = MaterialTheme.colorScheme.error
                        )
                    }

                    TextButton(
                        onClick = { showDeleteDialog = true },
                        enabled = !isSaving,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("删除任务及全部内容", color = MaterialTheme.colorScheme.error)
                    }

                    TextButton(
                        onClick = { viewModel.duplicateTaskV2(currentTask) },
                        enabled = !isSaving && currentTask.archivedAt == null,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("复制任务") }

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
            title = { Text(if (task!!.archivedAt == null) "归档任务？" else "恢复任务？") },
            text = { Text(if (task!!.archivedAt == null) "归档后任务会从当前列表隐藏。" else "恢复后任务会重新出现在目录和流程的活动视图中。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showArchiveDialog = false
                        if (task!!.archivedAt == null) viewModel.archiveTask(task!!) { onBack() }
                        else viewModel.restoreTask(task!!)
                    }
                ) {
                    Text(if (task!!.archivedAt == null) "归档" else "恢复")
                }
            },
            dismissButton = {
                TextButton(onClick = { showArchiveDialog = false }) {
                    Text("取消")
                }
            }
        )
    }

    if (showDeleteDialog && task != null) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = { Text("删除任务及全部内容？") },
            text = { Text("备注、执行步骤、日期安排和流程成员都会生成删除 tombstone，用户界面不可恢复。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDeleteDialog = false
                        viewModel.deleteTaskV2(task!!) { onBack() }
                    }
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { showDeleteDialog = false }) { Text("取消") } }
        )
    }

    if (showMoveFolder && task != null) {
        AlertDialog(
            onDismissRequest = { showMoveFolder = false },
            title = { Text("移动到目录") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    TextButton(
                        onClick = {
                            viewModel.moveTreeV2("TASK", task!!.id, null, task!!.status, baseVersion = task!!.version)
                            showMoveFolder = false
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("根目录") }
                    folders.filter { it.archivedAt == null && it.deletedAt == null }.forEach { folder ->
                        TextButton(
                            onClick = {
                                viewModel.moveTreeV2("TASK", task!!.id, folder.id, task!!.status, baseVersion = task!!.version)
                                showMoveFolder = false
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text(folder.title) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showMoveFolder = false }) { Text("取消") } },
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

private fun folderPathLabel(parentFolderId: String?, folders: List<com.devtodo.app.data.local.FolderEntity>): String {
    if (parentFolderId == null) return "根目录"
    val byId = folders.associateBy { it.id }
    val path = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    var current: String? = parentFolderId
    while (current != null && seen.add(current)) {
        val folder = byId[current] ?: break
        path += folder.title
        current = folder.parentFolderId
    }
    return path.asReversed().joinToString(" / ").ifBlank { "根目录" }
}

private data class StepDraft(val title: String, val noteMarkdown: String)
