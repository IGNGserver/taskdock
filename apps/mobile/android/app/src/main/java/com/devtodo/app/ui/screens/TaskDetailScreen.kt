package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import java.text.SimpleDateFormat
import java.util.*
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(taskId: String, viewModel: MainViewModel, onBack: () -> Unit) {
    val detail by
        remember(taskId) {
                combine(viewModel.observeTask(taskId), viewModel.observeNote(taskId)) { task, note
                    ->
                    task to note
                }
            }
            .collectAsStateWithLifecycle(initialValue = null)
    val task = detail?.first
    val note = detail?.second
    val steps by
        remember(taskId) { viewModel.observeTaskSteps(taskId) }
            .collectAsStateWithLifecycle(initialValue = emptyList())
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val placements by
        remember(taskId) { viewModel.observeTaskPlacements(taskId) }
            .collectAsStateWithLifecycle(initialValue = emptyList())
    val timePoints by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val ready by viewModel.dataReady.collectAsStateWithLifecycle()
    var title by rememberSaveable(taskId) { mutableStateOf("") }
    var markdownContent by rememberSaveable(taskId) { mutableStateOf("") }
    var originalTitle by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var originalNote by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var noteEdited by rememberSaveable(taskId) { mutableStateOf(false) }
    var tab by rememberSaveable(taskId) { mutableIntStateOf(0) }
    var isSaving by remember { mutableStateOf(false) }
    var discard by remember { mutableStateOf(false) }
    var showArchiveDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDeleteDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showMoveFolder by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDatePicker by rememberSaveable(taskId) { mutableStateOf(false) }
    var scheduleCopy by rememberSaveable(taskId) { mutableStateOf(false) }
    var createStep by rememberSaveable(taskId) { mutableStateOf(false) }
    var stepId by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var stepTitle by rememberSaveable(taskId) { mutableStateOf("") }
    var stepNote by rememberSaveable(taskId) { mutableStateOf("") }
    var stepDiscard by remember { mutableStateOf(false) }
    var deleteStepId by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    val datePickerState = rememberDatePickerState()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val dirty =
        (originalTitle != null && title != originalTitle) ||
            (noteEdited && markdownContent != (originalNote ?: ""))
    fun back() {
        if (!isSaving) {
            if (dirty) discard = true else onBack()
        }
    }
    BackHandler { back() }
    LaunchedEffect(task?.id) {
        if (originalTitle == null && task != null) {
            title = task!!.title
            originalTitle = title
        }
    }
    LaunchedEffect(note?.id) {
        if (originalNote == null && note != null) {
            originalNote = note!!.contentMarkdown
            if (!noteEdited) markdownContent = note!!.contentMarkdown
        }
    }
    fun save() {
        val current = task ?: return
        if (isSaving || title.isBlank()) return
        isSaving = true
        val savedTitle = title.trim()
        val savedNote = markdownContent
        scope.launch {
            try {
                viewModel
                    .saveTaskDetails(current, savedTitle, savedNote)
                    .onSuccess {
                        title = savedTitle
                        originalTitle = savedTitle
                        originalNote = savedNote
                        noteEdited = false
                        isSaving = false
                        snackbarHostState.showSnackbar("已保存到此设备")
                    }
                    .onFailure {
                        isSaving = false
                        snackbarHostState.showSnackbar(it.message ?: "保存失败，请重试")
                    }
            } finally {
                isSaving = false
            }
        }
    }
    WorkspaceScaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text("任务详情") },
                    navigationIcon = {
                        IconButton(onClick = ::back, enabled = !isSaving) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                        }
                    },
                    actions = {
                        TextButton(
                            onClick = ::save,
                            enabled = dirty && title.isNotBlank() && !isSaving,
                        ) {
                            Text(if (isSaving) "保存中" else "保存")
                        }
                        task?.let { current ->
                            ActionMenu(
                                "任务操作",
                                listOf(
                                    RowAction(
                                        "复制任务",
                                        !isSaving && !dirty && current.archivedAt == null,
                                    ) {
                                        viewModel.duplicateTaskV2(current)
                                    },
                                    RowAction(
                                        if (current.archivedAt == null) "归档任务" else "恢复任务",
                                        !isSaving && !dirty,
                                    ) {
                                        showArchiveDialog = true
                                    },
                                    RowAction("删除任务", !isSaving && !dirty, true) {
                                        showDeleteDialog = true
                                    },
                                ),
                            )
                        }
                    },
                )
                WorkspaceTabs(listOf("内容", "步骤", "安排"), tab) { tab = it }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val current = task
        if (current == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (!ready || detail == null) CircularProgressIndicator() else Text("找不到任务，可能已被删除")
            }
        } else
            Column(
                Modifier.fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when (tab) {
                    0 -> {
                        OutlinedTextField(
                            title,
                            { title = it },
                            label = { Text("任务标题") },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !isSaving,
                            isError = title.isBlank(),
                            minLines = 1,
                            maxLines = 4,
                        )
                        SectionHeading("状态")
                        // Chips wrap on narrow windows and with larger system fonts.
                        StatusChoices(current.status) { viewModel.updateTaskStatus(current, it) }
                        OutlinedTextField(
                            markdownContent,
                            {
                                markdownContent = it
                                noteEdited = true
                            },
                            label = { Text("备注") },
                            supportingText = { Text("支持 Markdown 与代码块") },
                            modifier = Modifier.fillMaxWidth(),
                            minLines = 8,
                            enabled = !isSaving,
                        )
                        if (dirty)
                            Text(
                                "有未保存的内容",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary,
                            )
                    }
                    1 -> {
                        Text(
                            "步骤独立于任务状态，修改后立即保存。",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        steps.forEachIndexed { index, step ->
                            ListItem(
                                headlineContent = { Text(step.title) },
                                supportingContent = { Text(taskStatusLabel(step.status)) },
                                leadingContent = {
                                    Checkbox(
                                        step.status == TaskStatus.DONE,
                                        {
                                            viewModel.updateStepStatusV2(
                                                step,
                                                if (it) TaskStatus.DONE else TaskStatus.TODO,
                                            )
                                        },
                                        modifier =
                                            Modifier.semantics {
                                                contentDescription = "${step.title}，完成状态"
                                                stateDescription = taskStatusLabel(step.status)
                                            },
                                    )
                                },
                                trailingContent = {
                                    ActionMenu(
                                        "${step.title}，步骤操作",
                                        listOf(
                                            RowAction("编辑内容") {
                                                stepId = step.id
                                                stepTitle = step.title
                                                stepNote = step.noteMarkdown
                                            },
                                            RowAction("上移", index > 0) {
                                                viewModel.moveStepV2(step, -1)
                                            },
                                            RowAction("下移", index < steps.lastIndex) {
                                                viewModel.moveStepV2(step, 1)
                                            },
                                            RowAction("删除步骤", destructive = true) {
                                                deleteStepId = step.id
                                            },
                                        ) +
                                            TaskStatus.entries
                                                .filter { it != step.status }
                                                .map { status ->
                                                    RowAction("标记为${taskStatusLabel(status)}") {
                                                        viewModel.updateStepStatusV2(step, status)
                                                    }
                                                },
                                    )
                                },
                            )
                        }
                        FilledTonalButton(onClick = { createStep = true }) {
                            Icon(Icons.Default.Add, null)
                            Text("添加步骤")
                        }
                    }
                    2 -> {
                        ListItem(
                            headlineContent = { Text("所在目录") },
                            supportingContent = {
                                Text(folderPathLabel(current.parentFolderId, folders))
                            },
                            trailingContent = {
                                TextButton(onClick = { showMoveFolder = true }) { Text("移动") }
                            },
                        )
                        SectionHeading("日期安排")
                        Text(
                            "同一任务可以安排到多个日期，完成状态保持一致。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (placements.isEmpty()) {
                            Text(
                                "还没有安排。可以添加日期，或从日程安排到事件。",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            placements.forEach { placement ->
                                val point = timePoints.firstOrNull { it.id == placement.timePointId }
                                ListItem(
                                    headlineContent = {
                                        Text(
                                            when {
                                                point?.title?.isNotBlank() == true -> point.title!!
                                                point?.localDate?.isNotBlank() == true -> point.localDate!!
                                                else -> "已安排的位置"
                                            }
                                        )
                                    },
                                    supportingContent = {
                                        Text(if (point?.localDate != null) "日期安排" else "事件安排")
                                    },
                                    trailingContent = {
                                        TextButton(onClick = { viewModel.removePlacement(placement) }) {
                                            Text("移除")
                                        }
                                    },
                                )
                            }
                        }
                        FilledTonalButton(
                            onClick = {
                                scheduleCopy = false
                                showDatePicker = true
                            }
                        ) {
                            Text("移到日期")
                        }
                        OutlinedButton(
                            onClick = {
                                scheduleCopy = true
                                showDatePicker = true
                            }
                        ) {
                            Text("添加另一个日期")
                        }
                    }
                }
            }
    }
    if (discard)
        AlertDialog(
            onDismissRequest = { discard = false },
            title = { Text("放弃未保存的更改？") },
            text = { Text("任务标题或备注尚未保存。") },
            confirmButton = { TextButton(onClick = onBack) { Text("放弃更改") } },
            dismissButton = { TextButton(onClick = { discard = false }) { Text("继续编辑") } },
        )
    if (createStep)
        CaptureSheet("添加步骤", "步骤标题", onDismiss = { createStep = false }) {
            viewModel.createStepV2(taskId, it)
        }
    val editingStep = steps.find { it.id == stepId }
    if (editingStep != null) {
        fun closeStep() {
            if (stepTitle != editingStep.title || stepNote != editingStep.noteMarkdown)
                stepDiscard = true
            else stepId = null
        }
        ModalBottomSheet(
            onDismissRequest = ::closeStep,
            sheetState =
                rememberModalBottomSheetState(
                    skipPartiallyExpanded = true,
                    confirmValueChange = { next ->
                        if (
                            next == SheetValue.Hidden &&
                                (stepTitle != editingStep.title ||
                                    stepNote != editingStep.noteMarkdown)
                        ) {
                            stepDiscard = true
                            false
                        } else true
                    },
                ),
        ) {
            Column(
                Modifier.fillMaxWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("编辑步骤", style = MaterialTheme.typography.headlineSmall)
                OutlinedTextField(
                    stepTitle,
                    { stepTitle = it },
                    label = { Text("步骤标题") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    stepNote,
                    { stepNote = it },
                    label = { Text("步骤备注") },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        viewModel.updateStepV2(editingStep, stepTitle, stepNote)
                        stepId = null
                    },
                    enabled = stepTitle.isNotBlank(),
                ) {
                    Text("保存步骤")
                }
            }
        }
    }
    if (stepDiscard)
        AlertDialog(
            onDismissRequest = { stepDiscard = false },
            title = { Text("放弃步骤更改？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        stepDiscard = false
                        stepId = null
                    }
                ) {
                    Text("放弃")
                }
            },
            dismissButton = { TextButton(onClick = { stepDiscard = false }) { Text("继续编辑") } },
        )
    deleteStepId?.let { id ->
        AlertDialog(
            onDismissRequest = { deleteStepId = null },
            title = { Text("删除步骤？") },
            text = { Text("步骤及其备注将被删除。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        steps.find { it.id == id }?.let { viewModel.deleteStepV2(it) }
                        deleteStepId = null
                    }
                ) {
                    Text("删除")
                }
            },
            dismissButton = { TextButton(onClick = { deleteStepId = null }) { Text("取消") } },
        )
    }
    if (showArchiveDialog && task != null) {
        AlertDialog(
            onDismissRequest = { showArchiveDialog = false },
            title = { Text(if (task!!.archivedAt == null) "归档任务？" else "恢复任务？") },
            text = {
                Text(if (task!!.archivedAt == null) "归档后任务会从当前列表隐藏。" else "恢复后任务会重新出现在目录和流程的活动视图中。")
            },
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
            dismissButton = { TextButton(onClick = { showArchiveDialog = false }) { Text("取消") } },
        )
    }

    if (showDeleteDialog && task != null) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = { Text("删除任务及全部内容？") },
            text = { Text("任务的备注、步骤、日期安排和流程关联都会被删除，无法撤销。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDeleteDialog = false
                        viewModel.deleteTaskV2(task!!) { onBack() }
                    }
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { showDeleteDialog = false }) { Text("取消") } },
        )
    }

    if (showMoveFolder && task != null) {
        AlertDialog(
            onDismissRequest = { showMoveFolder = false },
            title = { Text("移动到目录") },
            text = {
                Column(
                    Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    TextButton(
                        onClick = {
                            viewModel.moveTreeV2(
                                "TASK",
                                task!!.id,
                                null,
                                task!!.status,
                                baseVersion = task!!.version,
                            )
                            showMoveFolder = false
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("根目录")
                    }
                    folders
                        .filter { it.archivedAt == null && it.deletedAt == null }
                        .forEach { folder ->
                            TextButton(
                                onClick = {
                                    viewModel.moveTreeV2(
                                        "TASK",
                                        task!!.id,
                                        folder.id,
                                        task!!.status,
                                        baseVersion = task!!.version,
                                    )
                                    showMoveFolder = false
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(folder.title)
                            }
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
                            val localDate =
                                SimpleDateFormat("yyyy-MM-dd", Locale.US)
                                    .apply { timeZone = TimeZone.getTimeZone("UTC") }
                                    .format(Date(selectedDateMillis))
                            viewModel.scheduleTask(
                                task = task!!,
                                localDate = localDate,
                                copy = scheduleCopy,
                            ) {
                                showDatePicker = false
                            }
                        }
                    },
                    enabled = datePickerState.selectedDateMillis != null,
                ) {
                    Text("确定")
                }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("取消") } },
        ) {
            DatePicker(state = datePickerState)
        }
    }
}

private fun folderPathLabel(
    parentFolderId: String?,
    folders: List<com.devtodo.app.data.local.FolderEntity>,
): String {
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusChoices(selected: TaskStatus, onSelect: (TaskStatus) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TaskStatus.entries.forEach { status ->
            FilterChip(
                selected == status,
                { onSelect(status) },
                label = { Text(taskStatusLabel(status)) },
            )
        }
    }
}
