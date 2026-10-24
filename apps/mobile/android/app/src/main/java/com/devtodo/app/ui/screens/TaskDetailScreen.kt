package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.NoteEntity
import com.devtodo.app.data.local.PlacementEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.TaskStepEntity
import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.LocalAdaptiveInfo
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * Material 3 Expressive Task Detail Screen & Inline Detail Pane.
 *
 * Supports both standalone full-screen navigation and inline master-detail
 * embedding on tablets/landscape. When the pane width is >= 680dp, Content/Notes
 * and Steps/Placements are displayed side-by-side without requiring tab switches,
 * while preserving the segmented tabs for quick jumps and test parity.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    taskId: String,
    viewModel: MainViewModel,
    onBack: () -> Unit,
    isEmbedded: Boolean = false,
) {
    val cachedTask = remember(taskId) { viewModel.cachedTask(taskId) }
    val cachedNote = remember(taskId) { viewModel.cachedNote(taskId) }
    val detail by remember(taskId) {
        combine(viewModel.observeTask(taskId), viewModel.observeNote(taskId)) { task, note ->
            task to note
        }
    }.collectAsStateWithLifecycle(initialValue = cachedTask?.let { it to cachedNote })

    val task = detail?.first
    val note = detail?.second
    val steps by remember(taskId) { viewModel.observeTaskSteps(taskId) }
        .collectAsStateWithLifecycle(initialValue = viewModel.cachedTaskSteps(taskId).orEmpty())
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val placements by remember(taskId) { viewModel.observeTaskPlacements(taskId) }
        .collectAsStateWithLifecycle(initialValue = viewModel.cachedTaskPlacements(taskId).orEmpty())
    val timePoints by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val ready by viewModel.dataReady.collectAsStateWithLifecycle()
    val pageLoads by viewModel.pageLoads.collectAsStateWithLifecycle()
    val pageLoad = pageLoads["task:$taskId"]
    LaunchedEffect(taskId) { viewModel.loadTaskDetails(taskId) }

    var title by rememberSaveable(taskId) { mutableStateOf("") }
    var markdownContent by rememberSaveable(taskId) { mutableStateOf("") }
    var originalTitle by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var originalNote by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var titleConflict by rememberSaveable(taskId) { mutableStateOf(false) }
    var noteConflict by rememberSaveable(taskId) { mutableStateOf(false) }
    var noteEdited by rememberSaveable(taskId) { mutableStateOf(false) }
    var tab by rememberSaveable(taskId) { mutableIntStateOf(0) }
    var isSaving by remember { mutableStateOf(false) }
    var discard by remember { mutableStateOf(false) }
    var showDeleteDialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var showMoveFolder by rememberSaveable(taskId) { mutableStateOf(false) }
    var showDatePicker by rememberSaveable(taskId) { mutableStateOf(false) }
    var scheduleCopy by rememberSaveable(taskId) { mutableStateOf(false) }
    var schedulingPlacement by remember(taskId) { mutableStateOf<PlacementEntity?>(null) }
    var createStep by rememberSaveable(taskId) { mutableStateOf(false) }
    var stepId by rememberSaveable(taskId) { mutableStateOf<String?>(null) }
    var stepTitle by rememberSaveable(taskId) { mutableStateOf("") }
    var stepNote by rememberSaveable(taskId) { mutableStateOf("") }
    var stepDiscard by remember { mutableStateOf(false) }
    var deleteStepId by rememberSaveable(taskId) { mutableStateOf<String?>(null) }

    val datePickerState = rememberDatePickerState()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    // Hoisted out of the Scaffold content so Navigation Compose restores them.
    val detailScroll = rememberScrollState()
    val splitLeftScroll = rememberScrollState()
    val splitRightScroll = rememberScrollState()

    val dirty = (originalTitle != null && title != originalTitle) ||
        (noteEdited && markdownContent != (originalNote ?: ""))

    fun back() {
        if (!isSaving) {
            if (dirty) discard = true else onBack()
        }
    }

    // Unsaved edits keep the back gesture in the page (the discard dialog is not
    // a predictive-back destination); a clean page lets Navigation Compose pop
    // it with the normal predictive back preview.
    BackHandler(enabled = dirty || isSaving || isEmbedded) { back() }

    LaunchedEffect(task?.id, task?.version, task?.title, title, originalTitle) {
        task?.let {
            val reconciled = reconcileDraft(title, originalTitle, it.title)
            title = reconciled.value
            originalTitle = reconciled.baseline
            titleConflict = reconciled.conflict
        }
    }

    LaunchedEffect(note?.id, note?.version, note?.contentMarkdown, markdownContent, originalNote, noteEdited) {
        note?.let {
            // A note typed before its first response is also a draft.
            val baseline = originalNote ?: if (noteEdited) "" else null
            val reconciled = reconcileDraft(markdownContent, baseline, it.contentMarkdown)
            markdownContent = reconciled.value
            originalNote = reconciled.baseline
            noteConflict = reconciled.conflict
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
                        titleConflict = false
                        noteConflict = false
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

    @Composable
    fun TopBarContent() {
        Column {
            TopAppBar(
                title = {
                    Text(
                        text = task?.referenceId ?: "任务详情",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = ::back, enabled = !isSaving) {
                        Icon(
                            if (isEmbedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack,
                            if (isEmbedded) "关闭详情" else "返回",
                        )
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
                            Text(if (isSaving) "保存中…" else "保存")
                        }
                    }

                    task?.let { current ->
                        ActionMenu(
                            "任务操作",
                            listOf(
                                RowAction("复制任务", !isSaving && !dirty && current.archivedAt == null) {
                                    viewModel.duplicateTaskV2(current)
                                },
                                RowAction("删除任务", !isSaving && !dirty, true) {
                                    showDeleteDialog = true
                                },
                            ),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = if (isEmbedded) MaterialTheme.colorScheme.surfaceContainerLowest else MaterialTheme.colorScheme.surface,
                ),
            )

            if (titleConflict || noteConflict) {
                Surface(color = MaterialTheme.colorScheme.errorContainer) {
                    Text(
                        "中枢内容已变化，已保留你的未保存编辑。请核对后再保存。",
                        Modifier.fillMaxWidth().padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
            PrimaryScrollableTabRow(
                selectedTabIndex = tab,
                edgePadding = 16.dp,
                containerColor = if (isEmbedded) MaterialTheme.colorScheme.surfaceContainerLowest else MaterialTheme.colorScheme.surface,
            ) {
                listOf("内容与备注", "子步骤 (${steps.size})", "日程位置 (${placements.size})").forEachIndexed { index, label ->
                    Tab(
                        selected = tab == index,
                        onClick = { tab = index },
                        text = { Text(label) },
                        modifier = Modifier.testTag("detail-tab-$index"),
                    )
                }
            }
        }
    }

    @Composable
    fun DetailBody(padding: PaddingValues) {
        val current = task
        if (current == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                when {
                    pageLoad?.error != null -> Text("详情加载失败，请使用顶部重试。", Modifier.padding(16.dp))
                    pageLoad?.loading == true || !ready || detail == null -> CircularProgressIndicator()
                    else -> Text("找不到任务，可能已被删除")
                }
            }
        } else {
            val adaptive = LocalAdaptiveInfo.current
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding(),
            ) {
                val useSplitDetailColumns = maxWidth >= 680.dp && tab == 0
                if (useSplitDetailColumns) {
                    Row(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = if (adaptive.isCompactLandscape) 12.dp else 16.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Column(
                            modifier = Modifier
                                .weight(0.55f)
                                .fillMaxHeight()
                                .verticalScroll(splitLeftScroll),
                            verticalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            TaskContentAndNoteSection(
                                current = current,
                                title = title,
                                onTitleChange = { title = it },
                                markdownContent = markdownContent,
                                onMarkdownChange = {
                                    markdownContent = it
                                    noteEdited = true
                                },
                                note = note,
                                isSaving = isSaving,
                                onStatusChange = { viewModel.updateTaskStatus(current, it) },
                            )
                        }
                        Column(
                            modifier = Modifier
                                .weight(0.45f)
                                .fillMaxHeight()
                                .verticalScroll(splitRightScroll),
                            verticalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            TaskStepsSection(
                                steps = steps,
                                onCreateStep = { createStep = true },
                                onToggleStep = { step, checked ->
                                    viewModel.updateStepStatusV2(
                                        step,
                                        if (checked) TaskStatus.DONE else TaskStatus.TODO,
                                    )
                                },
                                onEditStep = { step ->
                                    stepId = step.id
                                    stepTitle = step.title
                                    stepNote = step.noteMarkdown
                                },
                                onMoveStep = { step, dir -> viewModel.moveStepV2(step, dir) },
                                onDeleteStep = { deleteStepId = it },
                            )
                            TaskPlacementsSection(
                                current = current,
                                folders = folders,
                                placements = placements,
                                timePoints = timePoints,
                                onShowMoveFolder = { showMoveFolder = true },
                                onScheduleNew = {
                                    schedulingPlacement = null
                                    scheduleCopy = false
                                    showDatePicker = true
                                },
                                onMovePlacement = { placement ->
                                    schedulingPlacement = placement
                                    scheduleCopy = false
                                    showDatePicker = true
                                },
                                onCopyPlacement = { placement ->
                                    schedulingPlacement = placement
                                    scheduleCopy = true
                                    showDatePicker = true
                                },
                                onRemovePlacement = { viewModel.removePlacement(it) },
                            )
                        }
                    }
                } else {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(detailScroll)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        AnimatedContent(
                            targetState = tab,
                            transitionSpec = {
                                (fadeIn(TaskDockMotion.springEffectsFast()) +
                                    slideInHorizontally(
                                        animationSpec = TaskDockMotion.springSpatial(),
                                        initialOffsetX = { it / 10 },
                                    )) togetherWith
                                    (fadeOut(TaskDockMotion.springEffectsFast()) +
                                        slideOutHorizontally(
                                            animationSpec = TaskDockMotion.springSpatial(),
                                            targetOffsetX = { -it / 10 },
                                        ))
                            },
                            label = "detailTabContent",
                        ) { selectedTab ->
                            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                when (selectedTab) {
                                    0 -> {
                                        TaskContentAndNoteSection(
                                            current = current,
                                            title = title,
                                            onTitleChange = { title = it },
                                            markdownContent = markdownContent,
                                            onMarkdownChange = {
                                                markdownContent = it
                                                noteEdited = true
                                            },
                                            note = note,
                                            isSaving = isSaving,
                                            onStatusChange = { viewModel.updateTaskStatus(current, it) },
                                        )
                                    }
                                    1 -> {
                                        TaskStepsSection(
                                            steps = steps,
                                            onCreateStep = { createStep = true },
                                            onToggleStep = { step, checked ->
                                                viewModel.updateStepStatusV2(
                                                    step,
                                                    if (checked) TaskStatus.DONE else TaskStatus.TODO,
                                                )
                                            },
                                            onEditStep = { step ->
                                                stepId = step.id
                                                stepTitle = step.title
                                                stepNote = step.noteMarkdown
                                            },
                                            onMoveStep = { step, dir -> viewModel.moveStepV2(step, dir) },
                                            onDeleteStep = { deleteStepId = it },
                                        )
                                    }
                                    2 -> {
                                        TaskPlacementsSection(
                                            current = current,
                                            folders = folders,
                                            placements = placements,
                                            timePoints = timePoints,
                                            onShowMoveFolder = { showMoveFolder = true },
                                            onScheduleNew = {
                                                schedulingPlacement = null
                                                scheduleCopy = false
                                                showDatePicker = true
                                            },
                                            onMovePlacement = { placement ->
                                                schedulingPlacement = placement
                                                scheduleCopy = false
                                                showDatePicker = true
                                            },
                                            onCopyPlacement = { placement ->
                                                schedulingPlacement = placement
                                                scheduleCopy = true
                                                showDatePicker = true
                                            },
                                            onRemovePlacement = { viewModel.removePlacement(it) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (isEmbedded) {
        Scaffold(
            modifier = Modifier.fillMaxSize().testTag("embedded-task-detail-pane"),
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            topBar = { TopBarContent() },
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { padding ->
            DetailBody(padding)
        }
    } else {
        WorkspaceScaffold(
            topBar = { TopBarContent() },
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { padding ->
            DetailBody(padding)
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
                    fontWeight = FontWeight.Medium,
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

                        val placement = schedulingPlacement
                        if (placement == null) {
                            viewModel.scheduleTask(
                                task = task!!,
                                localDate = localDate,
                                copy = false,
                            ) { failure ->
                                if (failure == null) showDatePicker = false
                            }
                        } else {
                            viewModel.movePlacementToDate(placement, localDate, scheduleCopy) { success ->
                                if (success) {
                                    schedulingPlacement = null
                                    showDatePicker = false
                                }
                            }
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

@Composable
private fun TaskContentAndNoteSection(
    current: TaskEntity,
    title: String,
    onTitleChange: (String) -> Unit,
    markdownContent: String,
    onMarkdownChange: (String) -> Unit,
    note: NoteEntity?,
    isSaving: Boolean,
    onStatusChange: (TaskStatus) -> Unit,
) {
    // Title card
    Surface(
        shape = TaskDockShapes.LargeIncreased,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
                value = title,
                label = { Text("任务标题") },
                onValueChange = onTitleChange,
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
                text = "状态",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TaskStatus.entries.forEach { status ->
                    val isCurrent = current.status == status
                    FilterChip(
                        selected = isCurrent,
                        onClick = { onStatusChange(status) },
                        label = { Text(taskStatusLabel(status)) },
                        shape = TaskDockShapes.FullPill,
                        modifier = Modifier.heightIn(min = 48.dp),
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
                    text = "备注",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = if (note == null) "备注尚未加载，连接中枢后可编辑" else "支持 Markdown",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            OutlinedTextField(
                value = markdownContent,
                onValueChange = onMarkdownChange,
                modifier = Modifier.fillMaxWidth(),
                minLines = 8,
                enabled = !isSaving && note != null,
                shape = TaskDockShapes.Medium,
            )
        }
    }
}

@Composable
private fun TaskStepsSection(
    steps: List<TaskStepEntity>,
    onCreateStep: () -> Unit,
    onToggleStep: (TaskStepEntity, Boolean) -> Unit,
    onEditStep: (TaskStepEntity) -> Unit,
    onMoveStep: (TaskStepEntity, Int) -> Unit,
    onDeleteStep: (String) -> Unit,
) {
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
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "子步骤清单",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = "步骤独立管理，勾选实时保存",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                FilledTonalButton(
                    onClick = onCreateStep,
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
                    modifier = Modifier
                        .fillMaxWidth()
                        .animateContentSize(animationSpec = TaskDockMotion.springSpatial()),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ExpressiveCheckbox(
                            checked = step.status == TaskStatus.DONE,
                            onCheckedChange = { checked -> onToggleStep(step, checked) },
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
                                RowAction("编辑内容") { onEditStep(step) },
                                RowAction("上移", index > 0) { onMoveStep(step, -1) },
                                RowAction("下移", index < steps.lastIndex) { onMoveStep(step, 1) },
                                RowAction("删除步骤", destructive = true) { onDeleteStep(step.id) },
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

@Composable
private fun TaskPlacementsSection(
    current: TaskEntity,
    folders: List<FolderEntity>,
    placements: List<PlacementEntity>,
    timePoints: List<TimePointEntity>,
    onShowMoveFolder: () -> Unit,
    onScheduleNew: () -> Unit,
    onMovePlacement: (PlacementEntity) -> Unit,
    onCopyPlacement: (PlacementEntity) -> Unit,
    onRemovePlacement: (PlacementEntity) -> Unit,
) {
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
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "所属目录",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = folderPathLabel(current.parentFolderId, folders),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }

                OutlinedButton(
                    onClick = onShowMoveFolder,
                    shape = TaskDockShapes.FullPill,
                ) {
                    Text("移动目录")
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

            Text(
                text = "日程与事件位置 (Placements)",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
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

                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            TextButton(onClick = { onMovePlacement(placement) }) {
                                Text("移动")
                            }
                            TextButton(onClick = { onCopyPlacement(placement) }) {
                                Text("复制")
                            }
                            TextButton(onClick = { onRemovePlacement(placement) }) {
                                Text("移除", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }

            if (placements.isEmpty()) {
                FilledTonalButton(
                    onClick = onScheduleNew,
                    shape = TaskDockShapes.FullPill,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("安排到日期")
                }
            } else {
                Text(
                    "每个安排都可以单独移动、复制或移除；任务本体不会被复制。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun folderPathLabel(folderId: String?, folders: List<FolderEntity>): String {
    if (folderId == null) return "根目录"
    val target = folders.find { it.id == folderId } ?: return "未知目录"
    return target.title
}
