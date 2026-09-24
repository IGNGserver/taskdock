package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.WorkflowEntity
import com.devtodo.app.data.local.WorkflowStageEntity
import com.devtodo.app.data.local.WorkflowTaskMembershipEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.components.WorkspaceScaffold

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowsV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit = {},
    onBack: (() -> Unit)? = null,
) {
    val workflows by viewModel.workflowsV2.collectAsStateWithLifecycle()
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    var showCreate by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var stageWorkflow by remember { mutableStateOf<WorkflowEntity?>(null) }
    var stageName by rememberSaveable { mutableStateOf("") }
    var addTarget by remember { mutableStateOf<AddTarget?>(null) }
    var editWorkflow by remember { mutableStateOf<WorkflowEntity?>(null) }
    var editStage by remember { mutableStateOf<WorkflowStageEntity?>(null) }
    var editName by rememberSaveable { mutableStateOf("") }
    var createTaskStage by remember { mutableStateOf<AddTarget?>(null) }
    var newTaskTitle by rememberSaveable { mutableStateOf("") }
    var deleteWorkflow by remember { mutableStateOf<WorkflowEntity?>(null) }

    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var deleteStage by remember { mutableStateOf<WorkflowStageEntity?>(null) }
    val selected = workflows.find { it.id == selectedId }
    BackHandler(selected != null) { selectedId = null }
    WorkspaceScaffold(
        topBar = {
            androidx.compose.material3.TopAppBar(
                title = { Text("流程") },
                navigationIcon = {
                    IconButton(onClick = {
                        if (selected != null) selectedId = null else onBack?.invoke()
                    }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            if (selected != null) "返回流程列表" else "返回目录",
                        )
                    }
                },
            )
        },
        floatingActionButton = {
            if (selected == null)
                ExtendedFloatingActionButton(
                    onClick = { showCreate = true },
                    icon = { Icon(Icons.Default.Add, null) },
                    text = { Text("新建流程") },
                )
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            if (selected == null) {
                items(workflows, key = { it.id }) { workflow ->
                    ListItem(
                        headlineContent = { Text(workflow.name) },
                        supportingContent = {
                            Text(if (workflow.archivedAt == null) "查看阶段与任务" else "已归档")
                        },
                        leadingContent = { Icon(Icons.Default.AccountTree, null) },
                        modifier = Modifier.clickable { selectedId = workflow.id },
                    )
                }
                if (workflows.isEmpty())
                    item {
                        EmptyState(
                            Icons.Default.AccountTree,
                            "把任务组织成流程",
                            "创建流程，再添加阶段与任务。任务状态在各处保持一致。",
                        )
                    }
            } else {
                item(key = selected.id) {
                    val workflow = selected
                    val stages by
                        remember(workflow.id) { viewModel.observeWorkflowStages(workflow.id) }
                            .collectAsStateWithLifecycle(initialValue = emptyList())
                    val memberships by
                        remember(workflow.id) { viewModel.observeWorkflowMemberships(workflow.id) }
                            .collectAsStateWithLifecycle(initialValue = emptyList())
                    ListItem(
                        headlineContent = {
                            Text(workflow.name, style = MaterialTheme.typography.titleLarge)
                        },
                        supportingContent = { Text("${stages.size} 个阶段") },
                        leadingContent = { Icon(Icons.Default.AccountTree, null) },
                        trailingContent = {
                            ActionMenu(
                                "流程操作",
                                listOf(
                                    RowAction("修改名称") {
                                        editWorkflow = workflow
                                        editName = workflow.name
                                    },
                                    RowAction("新增阶段", enabled = workflow.archivedAt == null) {
                                        stageWorkflow = workflow
                                    },
                                    RowAction(if (workflow.archivedAt == null) "归档流程" else "恢复流程") {
                                        viewModel.setWorkflowArchivedV2(workflow)
                                    },
                                    RowAction("删除流程", destructive = true) {
                                        deleteWorkflow = workflow
                                    },
                                ),
                            )
                        },
                    )
                    stages.forEachIndexed { index, stage ->
                        StageBlock(
                            workflow,
                            stage,
                            index,
                            stages,
                            memberships.filter { it.stageId == stage.id },
                            tasks,
                            folders,
                            onMoveStage = { viewModel.moveWorkflowStageV2(stage, stages, it) },
                            onAddTask = { addTarget = AddTarget(workflow, stage) },
                            onCreateTask = { createTaskStage = AddTarget(workflow, stage) },
                            onEditStage = {
                                editStage = it
                                editName = it.name
                            },
                            onDeleteStage = { deleteStage = it },
                            enabled = workflow.archivedAt == null,
                            onMoveTask = { member, target, before, after ->
                                viewModel.moveWorkflowMembershipV2(member, target, before, after)
                            },
                            onRemoveTask = { viewModel.removeWorkflowMembershipV2(it) },
                            onToggleStatus = { task, status ->
                                viewModel.updateTaskStatus(task, status)
                            },
                            onNavigateToDetail = onNavigateToDetail,
                        )
                    }
                }
            }
        }
    }
    deleteStage?.let { stage ->
        AlertDialog(
            onDismissRequest = { deleteStage = null },
            title = { Text("删除阶段？") },
            text = { Text("该阶段的任务会从流程中移除，任务本身会保留。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteWorkflowStageV2(stage)
                        deleteStage = null
                    }
                ) {
                    Text("删除阶段")
                }
            },
            dismissButton = { TextButton(onClick = { deleteStage = null }) { Text("取消") } },
        )
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("新建流程") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("流程名称") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.createWorkflowV2(name)
                        name = ""
                        showCreate = false
                    },
                    enabled = name.trim().isNotEmpty(),
                ) {
                    Text("创建")
                }
            },
            dismissButton = { TextButton(onClick = { showCreate = false }) { Text("取消") } },
        )
    }
    stageWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { stageWorkflow = null },
            title = { Text("新增阶段") },
            text = {
                OutlinedTextField(
                    value = stageName,
                    onValueChange = { stageName = it },
                    label = { Text("阶段名称") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.createWorkflowStageV2(workflow, stageName)
                        stageName = ""
                        stageWorkflow = null
                    },
                    enabled = stageName.trim().isNotEmpty(),
                ) {
                    Text("创建")
                }
            },
            dismissButton = { TextButton(onClick = { stageWorkflow = null }) { Text("取消") } },
        )
    }
    editWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { editWorkflow = null },
            title = { Text("修改流程名称") },
            text = {
                OutlinedTextField(
                    value = editName,
                    onValueChange = { editName = it },
                    label = { Text("流程名称") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateWorkflowV2(workflow, editName)
                        editWorkflow = null
                    },
                    enabled = editName.trim().isNotEmpty(),
                ) {
                    Text("保存")
                }
            },
            dismissButton = { TextButton(onClick = { editWorkflow = null }) { Text("取消") } },
        )
    }
    editStage?.let { stage ->
        AlertDialog(
            onDismissRequest = { editStage = null },
            title = { Text("修改阶段名称") },
            text = {
                OutlinedTextField(
                    value = editName,
                    onValueChange = { editName = it },
                    label = { Text("阶段名称") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateWorkflowStageV2(stage, editName)
                        editStage = null
                    },
                    enabled = editName.trim().isNotEmpty(),
                ) {
                    Text("保存")
                }
            },
            dismissButton = { TextButton(onClick = { editStage = null }) { Text("取消") } },
        )
    }
    deleteWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { deleteWorkflow = null },
            title = { Text("删除流程结构？") },
            text = { Text("会删除阶段和成员关系，但不会删除任何任务。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteWorkflowV2(workflow)
                        deleteWorkflow = null
                    }
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { deleteWorkflow = null }) { Text("取消") } },
        )
    }
    addTarget?.let { target ->
        val existingTaskIds by
            viewModel
                .observeWorkflowMemberships(target.workflow.id)
                .collectAsStateWithLifecycle(initialValue = emptyList())
        val selectable =
            tasks.filter { task ->
                task.archivedAt == null &&
                    task.deletedAt == null &&
                    existingTaskIds.none { it.taskId == task.id }
            }
        AlertDialog(
            onDismissRequest = { addTarget = null },
            title = { Text("添加任务到 ${target.stage.name}") },
            text = {
                Column(
                    Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    selectable.forEach { task ->
                        TextButton(
                            onClick = {
                                viewModel.addWorkflowTaskV2(target.workflow, target.stage, task)
                                addTarget = null
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(task.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (selectable.isEmpty())
                        Text("没有可添加的未归档任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { addTarget = null }) { Text("取消") } },
        )
    }
    createTaskStage?.let { target ->
        AlertDialog(
            onDismissRequest = { createTaskStage = null },
            title = { Text("在 ${target.stage.name} 中新建任务") },
            text = {
                OutlinedTextField(
                    value = newTaskTitle,
                    onValueChange = { newTaskTitle = it },
                    label = { Text("任务标题") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.createTaskInWorkflowStageV2(
                            target.workflow,
                            target.stage,
                            newTaskTitle,
                        )
                        newTaskTitle = ""
                        createTaskStage = null
                    },
                    enabled = newTaskTitle.trim().isNotEmpty(),
                ) {
                    Text("创建")
                }
            },
            dismissButton = { TextButton(onClick = { createTaskStage = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun StageBlock(
    workflow: WorkflowEntity,
    stage: WorkflowStageEntity,
    stageIndex: Int,
    stages: List<WorkflowStageEntity>,
    memberships: List<WorkflowTaskMembershipEntity>,
    allTasks: List<TaskEntity>,
    allFolders: List<FolderEntity>,
    onMoveStage: (Int) -> Unit,
    onAddTask: () -> Unit,
    onCreateTask: () -> Unit,
    onEditStage: (WorkflowStageEntity) -> Unit,
    onDeleteStage: (WorkflowStageEntity) -> Unit,
    enabled: Boolean,
    onMoveTask: (WorkflowTaskMembershipEntity, WorkflowStageEntity, String?, String?) -> Unit,
    onRemoveTask: (WorkflowTaskMembershipEntity) -> Unit,
    onToggleStatus: (TaskEntity, TaskStatus) -> Unit,
    onNavigateToDetail: (String) -> Unit,
) {
    val sortedMemberships =
        memberships.sortedWith(compareBy({ it.rank.toLongOrNull() ?: 0L }, { it.id }))
    val visibleMemberships =
        sortedMemberships.filter { membership ->
            val task = allTasks.firstOrNull { it.id == membership.taskId }
            task != null && task.deletedAt == null && task.archivedAt == null
        }
    val hiddenCount = sortedMemberships.size - visibleMemberships.size

    var expanded by rememberSaveable(stage.id) { mutableStateOf(true) }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        ListItem(
            headlineContent = { Text(stage.name, style = MaterialTheme.typography.titleMedium) },
            supportingContent = {
                Text("${visibleMemberships.size} 个任务${if (expanded) " · 点击收起" else " · 点击展开"}")
            },
            modifier = Modifier.clickable { expanded = !expanded },
            trailingContent = {
                ActionMenu(
                    "${stage.name}，阶段操作",
                    listOf(
                        RowAction("添加已有任务", enabled) { onAddTask() },
                        RowAction("新建任务", enabled) { onCreateTask() },
                        RowAction("修改名称", enabled) { onEditStage(stage) },
                        RowAction("上移阶段", enabled && stageIndex > 0) { onMoveStage(-1) },
                        RowAction("下移阶段", enabled && stageIndex < stages.lastIndex) {
                            onMoveStage(1)
                        },
                        RowAction("删除阶段", enabled && stages.size > 1, true) { onDeleteStage(stage) },
                    ),
                )
            },
            colors =
                androidx.compose.material3.ListItemDefaults.colors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLow
                ),
        )
        if (expanded) {
            visibleMemberships.forEachIndexed { index, member ->
                val task = allTasks.first { it.id == member.taskId }
                M3TaskRow(
                    task,
                    onClick = { onNavigateToDetail(task.id) },
                    onStatusToggle = { onToggleStatus(task, it) },
                    actions =
                        listOf(
                            RowAction("上移", enabled && index > 0) {
                                onMoveTask(member, stage, visibleMemberships[index - 1].id, null)
                            },
                            RowAction("下移", enabled && index < visibleMemberships.lastIndex) {
                                onMoveTask(member, stage, null, visibleMemberships[index + 1].id)
                            },
                        ) +
                            stages
                                .filter { it.id != stage.id }
                                .map { target ->
                                    RowAction("移至 ${target.name}", enabled) {
                                        onMoveTask(member, target, null, null)
                                    }
                                } +
                            RowAction("从流程移除", enabled) { onRemoveTask(member) },
                )
            }
            if (hiddenCount > 0)
                Text(
                    "$hiddenCount 个已归档任务已隐藏",
                    Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            if (sortedMemberships.isEmpty())
                Text(
                    "从阶段菜单添加任务",
                    Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
        }
    }
}

private data class AddTarget(val workflow: WorkflowEntity, val stage: WorkflowStageEntity)
