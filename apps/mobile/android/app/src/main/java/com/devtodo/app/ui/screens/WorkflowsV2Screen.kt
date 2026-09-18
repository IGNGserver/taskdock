package com.devtodo.app.ui.screens

import androidx.compose.ui.Alignment
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.model.TaskStatus
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
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.WorkflowEntity
import com.devtodo.app.data.local.WorkflowStageEntity
import com.devtodo.app.data.local.WorkflowTaskMembershipEntity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowsV2Screen(viewModel: MainViewModel) {
    val workflows by viewModel.workflowsV2.collectAsState()
    val tasks by viewModel.treeTasksV2.collectAsState()
    val folders by viewModel.foldersV2.collectAsState()
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

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { TopAppBar(title = { Text("流程") }) }
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilledTonalButton(onClick = { showCreate = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Add, contentDescription = null)
                Text("新建流程", modifier = Modifier.padding(start = 8.dp))
            }
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(workflows, key = { it.id }) { workflow ->
                    val stages by viewModel.observeWorkflowStages(workflow.id).collectAsState(initial = emptyList())
                    val memberships by viewModel.observeWorkflowMemberships(workflow.id).collectAsState(initial = emptyList())
                    ListItem(
                        headlineContent = { Text(workflow.name, style = MaterialTheme.typography.titleMedium) },
                        supportingContent = { Text("${stages.size} 个阶段 · ${memberships.size} 个任务成员") },
                    )
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { editWorkflow = workflow; editName = workflow.name }) { Text("改名") }
                        TextButton(onClick = { viewModel.setWorkflowArchivedV2(workflow) }) {
                            Text(if (workflow.archivedAt == null) "归档" else "恢复")
                        }
                        TextButton(onClick = { deleteWorkflow = workflow }) { Text("删除", color = MaterialTheme.colorScheme.error) }
                        TextButton(onClick = { stageWorkflow = workflow }, enabled = workflow.archivedAt == null) { Text("新增阶段") }
                    }
                    stages.forEachIndexed { index, stage ->
                        StageBlock(
                            workflow = workflow,
                            stage = stage,
                            stageIndex = index,
                            stages = stages,
                            memberships = memberships.filter { it.stageId == stage.id },
                            allTasks = tasks,
                            allFolders = folders,
                            onMoveStage = { direction -> viewModel.moveWorkflowStageV2(stage, stages, direction) },
                            onAddTask = { addTarget = AddTarget(workflow, stage) },
                            onCreateTask = { createTaskStage = AddTarget(workflow, stage) },
                            onEditStage = { editStage = it; editName = it.name },
                            onDeleteStage = { viewModel.deleteWorkflowStageV2(it) },
                            enabled = workflow.archivedAt == null,
                            onMoveTask = { membership, target, beforeId, afterId -> viewModel.moveWorkflowMembershipV2(membership, target, beforeId, afterId) },
                            onRemoveTask = { viewModel.removeWorkflowMembershipV2(it) },
                            onToggleStatus = { task, nextStatus -> viewModel.updateTaskStatus(task, nextStatus) }
                        )
                    }
                }
                if (workflows.isEmpty()) item { Text("还没有流程", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp)) }
            }
        }
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("新建流程") },
            text = { OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("流程名称") }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = { viewModel.createWorkflowV2(name); name = ""; showCreate = false }, enabled = name.trim().isNotEmpty()) { Text("创建") }
            },
            dismissButton = { TextButton(onClick = { showCreate = false }) { Text("取消") } },
        )
    }
    stageWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { stageWorkflow = null },
            title = { Text("新增阶段") },
            text = { OutlinedTextField(value = stageName, onValueChange = { stageName = it }, label = { Text("阶段名称") }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = { viewModel.createWorkflowStageV2(workflow, stageName); stageName = ""; stageWorkflow = null }, enabled = stageName.trim().isNotEmpty()) { Text("创建") }
            },
            dismissButton = { TextButton(onClick = { stageWorkflow = null }) { Text("取消") } },
        )
    }
    editWorkflow?.let { workflow ->
        AlertDialog(
            onDismissRequest = { editWorkflow = null },
            title = { Text("修改流程名称") },
            text = { OutlinedTextField(value = editName, onValueChange = { editName = it }, label = { Text("流程名称") }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = { viewModel.updateWorkflowV2(workflow, editName); editWorkflow = null }, enabled = editName.trim().isNotEmpty()) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { editWorkflow = null }) { Text("取消") } },
        )
    }
    editStage?.let { stage ->
        AlertDialog(
            onDismissRequest = { editStage = null },
            title = { Text("修改阶段名称") },
            text = { OutlinedTextField(value = editName, onValueChange = { editName = it }, label = { Text("阶段名称") }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = { viewModel.updateWorkflowStageV2(stage, editName); editStage = null }, enabled = editName.trim().isNotEmpty()) { Text("保存") }
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
                TextButton(onClick = { viewModel.deleteWorkflowV2(workflow); deleteWorkflow = null }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleteWorkflow = null }) { Text("取消") } },
        )
    }
    addTarget?.let { target ->
        val existingTaskIds by viewModel.observeWorkflowMemberships(target.workflow.id).collectAsState(initial = emptyList())
        val selectable = tasks.filter { task -> task.archivedAt == null && task.deletedAt == null && existingTaskIds.none { it.taskId == task.id } }
        AlertDialog(
            onDismissRequest = { addTarget = null },
            title = { Text("添加任务到 ${target.stage.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    selectable.forEach { task ->
                        TextButton(onClick = { viewModel.addWorkflowTaskV2(target.workflow, target.stage, task); addTarget = null }, modifier = Modifier.fillMaxWidth()) {
                            Text(task.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (selectable.isEmpty()) Text("没有可添加的未归档任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { addTarget = null }) { Text("取消") } },
        )
    }
    createTaskStage?.let { target ->
        AlertDialog(
            onDismissRequest = { createTaskStage = null },
            title = { Text("在 ${target.stage.name} 中新建任务") },
            text = { OutlinedTextField(value = newTaskTitle, onValueChange = { newTaskTitle = it }, label = { Text("任务标题") }, singleLine = true) },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.createTaskInWorkflowStageV2(target.workflow, target.stage, newTaskTitle)
                        newTaskTitle = ""
                        createTaskStage = null
                    },
                    enabled = newTaskTitle.trim().isNotEmpty(),
                ) { Text("创建") }
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
) {
    val sortedMemberships = memberships.sortedWith(compareBy({ it.rank.toLongOrNull() ?: 0L }, { it.id }))
    val visibleMemberships = sortedMemberships.filter { membership ->
        val task = allTasks.firstOrNull { it.id == membership.taskId }
        task != null && task.deletedAt == null && task.archivedAt == null
    }
    val hiddenCount = sortedMemberships.size - visibleMemberships.size

    Column(modifier = Modifier.fillMaxWidth().padding(start = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stage.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            TextButton(onClick = { onEditStage(stage) }, enabled = enabled) { Text("改名") }
            TextButton(onClick = { onMoveStage(-1) }, enabled = enabled && stageIndex > 0) { Text("上移") }
            TextButton(onClick = { onMoveStage(1) }, enabled = enabled && stageIndex < stages.lastIndex) { Text("下移") }
            TextButton(onClick = onAddTask, enabled = enabled) { Text("加已有") }
            TextButton(onClick = onCreateTask, enabled = enabled) { Text("新建") }
            TextButton(onClick = { onDeleteStage(stage) }, enabled = enabled) { Text("删除", color = MaterialTheme.colorScheme.error) }
        }
        visibleMemberships.forEachIndexed { memberIndex, membership ->
            val task = allTasks.firstOrNull { it.id == membership.taskId }
            val taskTitle = task?.title ?: "已删除任务"
            val folderTitle = task?.parentFolderId?.let { pId -> allFolders.firstOrNull { it.id == pId }?.title } ?: "根目录"
            val prevMember = if (memberIndex > 0) visibleMemberships[memberIndex - 1] else null
            val nextMember = if (memberIndex < visibleMemberships.lastIndex) visibleMemberships[memberIndex + 1] else null

            Column(modifier = Modifier.fillMaxWidth().padding(start = 8.dp, top = 4.dp, bottom = 4.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (task != null) {
                        TextButton(
                            onClick = {
                                val next = when (task.status) {
                                    TaskStatus.TODO -> TaskStatus.IN_PROGRESS
                                    TaskStatus.IN_PROGRESS -> TaskStatus.DONE
                                    TaskStatus.DONE -> TaskStatus.TODO
                                }
                                onToggleStatus(task, next)
                            },
                            enabled = enabled
                        ) {
                            Text(if (task.status == TaskStatus.DONE) "✓" else if (task.status == TaskStatus.IN_PROGRESS) "▶" else "○")
                        }
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text(taskTitle, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("📁 $folderTitle", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    }
                    if (memberIndex > 0) {
                        TextButton(onClick = { onMoveTask(membership, stage, prevMember?.id, null) }, enabled = enabled) { Text("↑") }
                    }
                    if (memberIndex < visibleMemberships.lastIndex) {
                        TextButton(onClick = { onMoveTask(membership, stage, null, nextMember?.id) }, enabled = enabled) { Text("↓") }
                    }
                    stages.filter { it.id != stage.id }.forEach { target ->
                        TextButton(onClick = { onMoveTask(membership, target, null, null) }, enabled = enabled) { Text("→${target.name}") }
                    }
                    TextButton(onClick = { onRemoveTask(membership) }, enabled = enabled) { Text("移除") }
                }
            }
        }
        if (hiddenCount > 0) {
            Text("$hiddenCount 个已归档任务已隐藏", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp, top = 2.dp))
        }
        if (sortedMemberships.isEmpty()) Text("空阶段", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
    }
}

private data class AddTarget(val workflow: WorkflowEntity, val stage: WorkflowStageEntity)
