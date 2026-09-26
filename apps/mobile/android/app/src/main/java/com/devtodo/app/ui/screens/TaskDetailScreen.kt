package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskStepEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * Material 3 Expressive Task Detail Screen.
 * Complete visual overhaul with:
 * - Fluid segmented tabs (Content, Steps, Placements)
 * - Tonal card surfaces for notes and attributes
 * - Expressive bounce checkboxes for task steps
 * - Floating save indicator & confirmation toasts
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    taskId: String,
    viewModel: MainViewModel,
    onBack: () -> Unit,
) {
    val detail by remember(taskId) {
        combine(viewModel.observeTask(taskId), viewModel.observeNote(taskId)) { task, note ->
            task to note
        }
    }.collectAsStateWithLifecycle(initialValue = null)

    val task = detail?.first
    val note = detail?.second
    val steps by remember(taskId) { viewModel.observeTaskSteps(taskId) }
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val placements by remember(taskId) { viewModel.observeTaskPlacements(taskId) }
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

    val dirty = (originalTitle != null && title != originalTitle) ||
        (noteEdited && markdownContent != (originalNote ?: ""))

    fun back() {
        if (!isSaving) {
            if (dirty) discard = true else onBack()
        }
    }

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
                viewModel.saveTaskDetails(current, savedTitle, savedNote)
                    .onSuccess {
                        title = savedTitle
                        originalTitle = savedTitle
                        originalNote = savedNote
                        noteEdited = false
                        isSaving = false
                        snackbarHostState.showSnackbar("已保存到本地工作区")
                    }
                    .onFailure {
                        isSaving = false
                        snackbarHostState.showSnackbar(it.message ?: "保存失败，请检查重试")
                    }
            } finally {
                isSaving = false
            }
        }
    }

    PredictiveBackContainer(
        enabled = !isSaving,
        onBack = ::back,
    ) {
        WorkspaceScaffold(
            topBar = {
            Column {
                TopAppBar(
                    title = {
                        Text(
                            text = task?.referenceId ?: "任务详情",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = ::back, enabled = !isSaving) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                        }
                    },
                    actions = {
                        if (dirty) {
                            FilledTonalButton(
                                onClick = ::save,
                                enabled = title.isNotBlank() && !isSaving,
                                shape = TaskDockShapes.FullPill,
                                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                            ) {
                                Text(if (isSaving) "保存中…" else "保存更改")
                            }
                        }

                        task?.let { current ->
                            ActionMenu(
                                "任务操作",
                                listOf(
                                    RowAction("复制任务", !isSaving && !dirty && current.archivedAt == null) {
                                        viewModel.duplicateTaskV2(current)
                                    },
                                    RowAction(if (current.archivedAt == null) "归档任务" else "恢复任务", !isSaving && !dirty) {
                                        showArchiveDialog = true
                                    },
                                    RowAction("删除任务", !isSaving && !dirty, true) {
                                        showDeleteDialog = true
                                    },
                                ),
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    )
                )

                // Segmented Tabs Pill Bar
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    shape = TaskDockShapes.FullPill,
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                ) {
                    Row(
                        modifier = Modifier.padding(4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        listOf("内容与备注", "子步骤 (${steps.size})", "日程位置 (${placements.size})").forEachIndexed { idx, label ->
                            val selected = tab == idx
                            Surface(
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(TaskDockShapes.FullPill)
                                    .clickable { tab = idx },
                                shape = TaskDockShapes.FullPill,
                                color = if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
                            ) {
                                Box(
                                    modifier = Modifier.padding(vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = label,
                                        style = MaterialTheme.typography.labelMedium,
                                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                                        color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val current = task
        if (current == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (!ready || detail == null) CircularProgressIndicator() else Text("找不到任务，可能已被删除")
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when (tab) {
                    0 -> {
                        // Title card
                        Surface(
                            shape = TaskDockShapes.LargeIncreased,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(
                                    text = "任务标题",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                OutlinedTextField(
                                    value = title,
                                    onValueChange = { title = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = !isSaving,
                                    isError = title.isBlank(),
                                    shape = TaskDockShapes.Medium,
                                )
                            }
                        }

                        // Status Flow Section
                        Surface(
                            shape = TaskDockShapes.LargeIncreased,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(
                                    text = "任务状态流转",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    TaskStatus.entries.forEach { status ->
                                        val isCurrent = current.status == status
                                        FilterChip(
                                            selected = isCurrent,
                                            onClick = { viewModel.updateTaskStatus(current, status) },
                                            label = { Text(taskStatusLabel(status)) },
                                            shape = TaskDockShapes.FullPill,
                                            modifier = Modifier.weight(1f),
                                        )
                                    }
                                }
                            }
                        }

                        // Markdown Note card
                        Surface(
                            shape = TaskDockShapes.LargeIncreased,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "开发备注 (Markdown)",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        text = "支持代码块与待办清单",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }

                                OutlinedTextField(
                                    value = markdownContent,
                                    onValueChange = {
                                        markdownContent = it
                                        noteEdited = true
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    minLines = 8,
                                    enabled = !isSaving,
                                    shape = TaskDockShapes.Medium,
                                )
                            }
                        }
                    }
                    1 -> {
                        // Steps Tab
                        Surface(
                            shape = TaskDockShapes.LargeIncreased,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column {
                                        Text(
                                            text = "子步骤清单",
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold,
                                        )
                                        Text(
                                            text = "步骤独立管理，勾选实时保存",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }

                                    FilledTonalButton(
                                        onClick = { createStep = true },
                                        shape = TaskDockShapes.FullPill,
                                    ) {
                                        Icon(Icons.Default.Add, null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text("添加步骤")
                                    }
                                }

                                steps.forEachIndexed { index, step ->
                                    Surface(
                                        shape = TaskDockShapes.Medium,
                                        color = MaterialTheme.colorScheme.surface,
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 8.dp, vertical = 6.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            ExpressiveCheckbox(
                                                checked = step.status == TaskStatus.DONE,
                                                onCheckedChange = { checked ->
                                                    viewModel.updateStepStatusV2(
                                                        step,
                                                        if (checked) TaskStatus.DONE else TaskStatus.TODO,
                                                    )
                                                },
                                                taskTitle = step.title,
                                                status = step.status,
                                            )

                                            Spacer(Modifier.width(8.dp))

                                            Text(
                                                text = step.title,
                                                style = MaterialTheme.typography.bodyLarge,
                                                modifier = Modifier.weight(1f),
                                            )

                                            ActionMenu(
                                                "${step.title}，步骤操作",
                                                listOf(
                                                    RowAction("编辑内容") {
                                                        stepId = step.id
                                                        stepTitle = step.title
                                                        stepNote = step.noteMarkdown
                                                    },
                                                    RowAction("上移", index > 0) { viewModel.moveStepV2(step, -1) },
                                                    RowAction("下移", index < steps.lastIndex) { viewModel.moveStepV2(step, 1) },
                                                    RowAction("删除步骤", destructive = true) { deleteStepId = step.id },
                                                ),
                                            )
                                        }
                                    }
                                }

                                if (steps.isEmpty()) {
                                    Text(
                                        text = "暂无步骤，点击上方“添加步骤”拆分任务",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(vertical = 12.dp),
                                    )
                                }
                            }
                        }
                    }
                    2 -> {
                        // Placements Tab
                        Surface(
                            shape = TaskDockShapes.LargeIncreased,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column {
                                        Text(
                                            text = "所属目录",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.primary,
                                            fontWeight = FontWeight.SemiBold,
                                        )
                                        Text(
                                            text = folderPathLabel(current.parentFolderId, folders),
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold,
                                        )
                                    }

                                    OutlinedButton(
                                        onClick = { showMoveFolder = true },
                                        shape = TaskDockShapes.FullPill,
                                    ) {
                                        Text("移动目录")
                                    }
                                }

                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

                                Text(
                                    text = "日程与事件位置 (Placements)",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    text = "任务本体全局唯一。同一个任务可以同时安排到多个日期或事件，状态全局同步保持一致。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )

                                placements.forEach { placement ->
                                    val point = timePoints.firstOrNull { it.id == placement.timePointId }
                                    Surface(
                                        shape = TaskDockShapes.Medium,
                                        color = MaterialTheme.colorScheme.surface,
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 14.dp, vertical = 10.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                        ) {
                                            Column {
                                                Text(
                                                    text = when {
                                                        point?.title?.isNotBlank() == true -> point.title!!
                                                        point?.localDate?.isNotBlank() == true -> point.localDate!!
                                                        else -> "安排的位置"
                                                    },
                                                    style = MaterialTheme.typography.titleSmall,
                                                    fontWeight = FontWeight.SemiBold,
                                                )
                                                Text(
                                                    text = if (point?.localDate != null) "日期安排" else "里程碑事件",
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }

                                            TextButton(onClick = { viewModel.removePlacement(placement) }) {
                                                Text("移除安排", color = MaterialTheme.colorScheme.error)
                                            }
                                        }
                                    }
                                }

                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    FilledTonalButton(
                                        onClick = {
                                            scheduleCopy = false
                                            showDatePicker = true
                                        },
                                        shape = TaskDockShapes.FullPill,
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Text("移动到日期")
                                    }

                                    OutlinedButton(
                                        onClick = {
                                            scheduleCopy = true
                                            showDatePicker = true
                                        },
                                        shape = TaskDockShapes.FullPill,
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Text("添加另一个日期")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (discard) {
        AlertDialog(
            onDismissRequest = { discard = false },
            title = { Text("放弃未保存的更改？") },
            text = { Text("任务标题或备注尚未保存。") },
            confirmButton = { TextButton(onClick = onBack) { Text("放弃更改") } },
            dismissButton = { TextButton(onClick = { discard = false }) { Text("继续编辑") } },
        )
    }

    if (createStep) {
        CaptureSheet("添加步骤", "步骤标题", onDismiss = { createStep = false }) {
            viewModel.createStepV2(taskId, it)
        }
    }

    val editingStep = steps.find { it.id == stepId }
    if (editingStep != null) {
        fun closeStep() {
            if (stepTitle != editingStep.title || stepNote != editingStep.noteMarkdown) {
                stepDiscard = true
            } else {
                stepId = null
            }
        }

        ModalBottomSheet(
            onDismissRequest = ::closeStep,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            shape = TaskDockShapes.BottomSheetShape,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp)
                    .imePadding(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "编辑步骤",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                OutlinedTextField(
                    value = stepTitle,
                    onValueChange = { stepTitle = it },
                    label = { Text("步骤标题") },
                    singleLine = true,
                    shape = TaskDockShapes.Medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = stepNote,
                    onValueChange = { stepNote = it },
                    label = { Text("步骤备注 (Markdown)") },
                    minLines = 4,
                    shape = TaskDockShapes.Medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = ::closeStep) { Text("取消") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            viewModel.updateStepV2(editingStep, stepTitle, stepNote)
                            stepId = null
                        },
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Text("保存步骤")
                    }
                }
            }
        }
    }

    if (showDatePicker && task != null) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    enabled = datePickerState.selectedDateMillis != null,
                    onClick = {
                        val localDate = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
                            timeZone = TimeZone.getTimeZone("UTC")
                        }.format(Date(datePickerState.selectedDateMillis!!))

                        viewModel.scheduleTask(
                            task = task!!,
                            localDate = localDate,
                            copy = scheduleCopy,
                        ) {
                            showDatePicker = false
                        }
                    },
                ) {
                    Text("确定")
                }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("取消") } },
        ) {
            DatePicker(datePickerState)
        }
    }

    if (showMoveFolder && task != null) {
        AlertDialog(
            onDismissRequest = { showMoveFolder = false },
            title = { Text("移动到目录") },
            text = {
                Column(
                    modifier = Modifier
                        .heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(
                        onClick = {
                            viewModel.moveTreeV2(
                                kind = "TASK",
                                id = task!!.id,
                                parentFolderId = null,
                                expectedStatus = task!!.status,
                                baseVersion = task!!.version,
                            )
                            showMoveFolder = false
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("根目录")
                    }

                    folders.filter { it.archivedAt == null && it.deletedAt == null }.forEach { folder ->
                        TextButton(
                            onClick = {
                                viewModel.moveTreeV2(
                                    kind = "TASK",
                                    id = task!!.id,
                                    parentFolderId = folder.id,
                                    expectedStatus = task!!.status,
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

    deleteStepId?.let { sId ->
        val step = steps.find { it.id == sId }
        if (step != null) {
            AlertDialog(
                onDismissRequest = { deleteStepId = null },
                title = { Text("删除步骤？") },
                text = { Text("确定要删除步骤“${step.title}”吗？此操作无法恢复。") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            viewModel.deleteStepV2(step)
                            deleteStepId = null
                        }
                    ) {
                        Text("删除", color = MaterialTheme.colorScheme.error)
                    }
                },
                dismissButton = { TextButton(onClick = { deleteStepId = null }) { Text("取消") } },
            )
        }
    }

    if (showArchiveDialog && task != null) {
        val isArchived = task!!.archivedAt != null
        AlertDialog(
            onDismissRequest = { showArchiveDialog = false },
            title = { Text(if (isArchived) "恢复任务？" else "归档任务？") },
            text = { Text(if (isArchived) "任务将重新回到原目录树与工作区。" else "任务将从活跃视图归档，您随时可以在归档中心恢复。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showArchiveDialog = false
                        if (isArchived) {
                            viewModel.restoreTask(task!!)
                        } else {
                            viewModel.archiveTask(task!!) { onBack() }
                        }
                    }
                ) {
                    Text(if (isArchived) "恢复" else "归档")
                }
            },
            dismissButton = { TextButton(onClick = { showArchiveDialog = false }) { Text("取消") } },
        )
    }

    if (showDeleteDialog && task != null) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = { Text("删除任务？") },
            text = { Text("将彻底删除该任务及其备注、子步骤与安排。此操作不可恢复。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteTaskV2(task!!)
                        showDeleteDialog = false
                        onBack()
                    }
                ) {
                    Text("永久删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { showDeleteDialog = false }) { Text("取消") } },
        )
    }
    }
}

private fun folderPathLabel(folderId: String?, folders: List<FolderEntity>): String {
    if (folderId == null) return "根目录"
    val target = folders.find { it.id == folderId } ?: return "未知目录"
    return target.title
}
