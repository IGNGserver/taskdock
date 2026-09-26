package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
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
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes

/**
 * Material 3 Expressive Workflows Screen.
 * Visual parity with Web Workflows, expressive stage cards,
 * fluid task cards, and bottom Floating Action Island.
 */
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
    var deleteWorkflow by remember { mutableStateOf<WorkflowEntity?>(null) }
    var deleteStage by remember { mutableStateOf<WorkflowStageEntity?>(null) }

    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val selected = workflows.find { it.id == selectedId }

    PredictiveBackContainer(
        enabled = selected != null || onBack != null,
        onBack = {
            if (selected != null) selectedId = null else onBack?.invoke()
        },
    ) {
        WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = selected?.name ?: "流程看板",
                        fontWeight = FontWeight.Bold,
                    )
                },
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
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        },
        bottomBar = {
            if (selected == null) {
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    FloatingActionIsland(
                        onQuickCreate = { title ->
                            viewModel.createWorkflowV2(title)
                        },
                        placeholder = "输入新流程名称…",
                        primaryLabel = "新建流程",
                    )
                }
            }
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            if (selected == null) {
                // Workflow List Overview
                items(workflows, key = { it.id }) { workflow ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                            .clip(TaskDockShapes.Large)
                            .clickable { selectedId = workflow.id },
                        shape = TaskDockShapes.Large,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Surface(
                                shape = TaskDockShapes.Medium,
                                color = MaterialTheme.colorScheme.tertiaryContainer,
                                modifier = Modifier.size(42.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Icon(
                                        imageVector = Icons.Default.AccountTree,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onTertiaryContainer,
                                        modifier = Modifier.size(22.dp),
                                    )
                                }
                            }

                            Spacer(Modifier.width(14.dp))

                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.Center,
                            ) {
                                Text(
                                    text = workflow.name,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Text(
                                    text = if (workflow.archivedAt == null) "查看阶段与任务状态" else "已归档",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }

                            Icon(
                                imageVector = Icons.Default.ChevronRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                        }
                    }
                }

                if (workflows.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Default.AccountTree,
                            title = "将任务按阶段组织为流程",
                            description = "例如“需求设计 → 开发中 → 验收测试”，任务状态在各处实时保持同步。",
                            action = {
                                FilledTonalButton(
                                    onClick = { showCreate = true },
                                    shape = TaskDockShapes.FullPill,
                                ) {
                                    Icon(Icons.Default.Add, null)
                                    Spacer(Modifier.width(8.dp))
                                    Text("新建流程")
                                }
                            }
                        )
                    }
                }
            } else {
                // Workflow Detail & Stages View
                item(key = selected.id) {
                    val workflow = selected
                    val stages by remember(workflow.id) {
                        viewModel.observeWorkflowStages(workflow.id)
                    }.collectAsStateWithLifecycle(initialValue = emptyList())
                    val memberships by remember(workflow.id) {
                        viewModel.observeWorkflowMemberships(workflow.id)
                    }.collectAsStateWithLifecycle(initialValue = emptyList())

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        shape = TaskDockShapes.LargeIncreased,
                        color = MaterialTheme.colorScheme.surfaceContainer,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    text = workflow.name,
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    text = "${stages.size} 个阶段 · ${memberships.size} 项任务流转中",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }

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
                        }
                    }

                    stages.forEachIndexed { index, stage ->
                        ExpressiveStageBlock(
                            workflow = workflow,
                            stage = stage,
                            stageIndex = index,
                            stages = stages,
                            memberships = memberships.filter { it.stageId == stage.id },
                            allTasks = tasks,
                            folders = folders,
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

                    if (stages.isEmpty()) {
                        EmptyState(
                            icon = Icons.Default.AccountTree,
                            title = "当前流程暂无阶段",
                            description = "点击下方添加第一个阶段（如：待开始、进行中）。",
                            action = {
                                FilledTonalButton(
                                    onClick = { stageWorkflow = workflow },
                                    shape = TaskDockShapes.FullPill,
                                ) {
                                    Icon(Icons.Default.Add, null)
                                    Spacer(Modifier.width(8.dp))
                                    Text("添加阶段")
                                }
                            }
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
                    shape = TaskDockShapes.Medium,
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
            title = { Text("为 ${workflow.name} 添加阶段") },
            text = {
                OutlinedTextField(
                    value = stageName,
                    onValueChange = { stageName = it },
                    label = { Text("阶段名称") },
                    singleLine = true,
                    shape = TaskDockShapes.Medium,
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
                    Text("添加")
                }
            },
            dismissButton = { TextButton(onClick = { stageWorkflow = null }) { Text("取消") } },
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
                    shape = TaskDockShapes.Medium,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateWorkflowStageV2(stage, editName)
                        editName = ""
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

    editWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { editWorkflow = null },
            title = { Text("重命名流程") },
            text = {
                OutlinedTextField(
                    value = editName,
                    onValueChange = { editName = it },
                    label = { Text("流程名称") },
                    singleLine = true,
                    shape = TaskDockShapes.Medium,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateWorkflowV2(workflow, editName)
                        editName = ""
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

    deleteWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { deleteWorkflow = null },
            title = { Text("删除流程？") },
            text = { Text("流程中的阶段与归属关系会被删除，任务本身会完整保留。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteWorkflowV2(workflow)
                        deleteWorkflow = null
                        selectedId = null
                    }
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { deleteWorkflow = null }) { Text("取消") } },
        )
    }

    createTaskStage?.let { target ->
        CaptureSheet(
            title = "在 ${target.stage.name} 新建任务",
            onDismiss = { createTaskStage = null },
        ) {
            viewModel.createTaskInWorkflowStageV2(target.workflow, target.stage, it)
        }
    }

    addTarget?.let { target ->
        val candidateTasks = tasks.filter {
            it.archivedAt == null && it.deletedAt == null
        }
        AlertDialog(
            onDismissRequest = { addTarget = null },
            title = { Text("添加已有任务至 ${target.stage.name}") },
            text = {
                Column(
                    modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    candidateTasks.forEach { task ->
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
                }
            },
            confirmButton = { TextButton(onClick = { addTarget = null }) { Text("完成") } },
        )
    }
    }
}

@Composable
private fun ExpressiveStageBlock(
    workflow: WorkflowEntity,
    stage: WorkflowStageEntity,
    stageIndex: Int,
    stages: List<WorkflowStageEntity>,
    memberships: List<WorkflowTaskMembershipEntity>,
    allTasks: List<TaskEntity>,
    folders: List<FolderEntity>,
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
    val sortedMemberships = remember(memberships) {
        memberships.sortedWith(compareBy<WorkflowTaskMembershipEntity> { it.rank.toLongOrNull() ?: 0L }.thenBy { it.id })
    }
    val taskMap = remember(allTasks) { allTasks.associateBy { it.id } }
    val visibleMemberships = remember(sortedMemberships, taskMap) {
        sortedMemberships.filter {
            val task = taskMap[it.taskId]
            task != null && task.archivedAt == null && task.deletedAt == null
        }
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        shape = TaskDockShapes.LargeIncreased,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Surface(
                        shape = TaskDockShapes.Small,
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.size(32.dp),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                text = "${stageIndex + 1}",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                        }
                    }

                    Column {
                        Text(
                            text = stage.name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = "${visibleMemberships.size} 项任务",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                ActionMenu(
                    label = "${stage.name}，阶段操作",
                    actions = listOf(
                        RowAction("添加已有任务", enabled) { onAddTask() },
                        RowAction("新建任务", enabled) { onCreateTask() },
                        RowAction("修改名称", enabled) { onEditStage(stage) },
                        RowAction("上移阶段", enabled && stageIndex > 0) { onMoveStage(-1) },
                        RowAction("下移阶段", enabled && stageIndex < stages.lastIndex) { onMoveStage(1) },
                        RowAction("删除阶段", enabled && stages.size > 1, true) { onDeleteStage(stage) },
                    ),
                )
            }

            visibleMemberships.forEachIndexed { index, member ->
                val task = taskMap[member.taskId] ?: return@forEachIndexed
                ExpressiveTaskCard(
                    task = task,
                    onClick = { onNavigateToDetail(task.id) },
                    onStatusToggle = { onToggleStatus(task, it) },
                    actions = listOf(
                        RowAction("上移", enabled && index > 0) {
                            onMoveTask(member, stage, visibleMemberships[index - 1].id, null)
                        },
                        RowAction("下移", enabled && index < visibleMemberships.lastIndex) {
                            onMoveTask(member, stage, null, visibleMemberships[index + 1].id)
                        },
                    ) + stages.filter { it.id != stage.id }.map { target ->
                        RowAction("移至 ${target.name}", enabled) {
                            onMoveTask(member, target, null, null)
                        }
                    } + RowAction("从流程移除", enabled) { onRemoveTask(member) },
                )
            }

            if (visibleMemberships.isEmpty()) {
                Text(
                    text = "阶段暂无任务，点击右上角菜单添加或新建任务",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
}

private data class AddTarget(val workflow: WorkflowEntity, val stage: WorkflowStageEntity)
