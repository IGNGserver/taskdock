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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.DeletePreviewDto
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.M3TaskRow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TreeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit
) {
    var currentFolderId by rememberSaveable { mutableStateOf<String?>(null) }
    val folders by viewModel.observeChildFolders(currentFolderId).collectAsState(initial = emptyList())
    val tasks by viewModel.observeChildTasks(currentFolderId).collectAsState(initial = emptyList())
    val allFolders by viewModel.foldersV2.collectAsState()
    val allTasks by viewModel.treeTasksV2.collectAsState()
    var showFolderDialog by rememberSaveable { mutableStateOf(false) }
    var showTaskDialog by rememberSaveable { mutableStateOf(false) }
    var draftTitle by rememberSaveable { mutableStateOf("") }
    var pendingPreview by remember { mutableStateOf<DeletePreviewDto?>(null) }
    var pendingDeleteFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var pendingMoveRow by remember { mutableStateOf<TreeRow?>(null) }
    val scope = rememberCoroutineScope()
    val rows = remember(folders, tasks, allFolders, allTasks) {
        buildTreeRows(folders, tasks, allFolders, allTasks)
    }

    fun moveAdjacent(row: TreeRow, direction: Int) {
        val siblings = rows.filter { it.status == row.status }
        val index = siblings.indexOfFirst { it.id == row.id }
        val target = siblings.getOrNull(index + direction) ?: return
        viewModel.moveTreeV2(
            kind = row.kind,
            id = row.id,
            parentFolderId = currentFolderId,
            expectedStatus = row.status,
            beforeId = if (direction < 0) target.id else null,
            afterId = if (direction > 0) target.id else null,
            baseVersion = row.version,
        )
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(currentFolderId?.let { folderTitle(it, allFolders) } ?: "目录") },
                navigationIcon = {
                    if (currentFolderId != null) {
                        IconButton(onClick = { currentFolderId = allFolders.find { it.id == currentFolderId }?.parentFolderId }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回上级目录")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { showTaskDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = "新建任务")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                FilledTonalButton(onClick = { showFolderDialog = true }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Folder, contentDescription = null)
                    Text("新建文件夹", modifier = Modifier.padding(start = 6.dp))
                }
                FilledTonalButton(onClick = { showTaskDialog = true }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Add, contentDescription = null)
                    Text("新建任务", modifier = Modifier.padding(start = 6.dp))
                }
            }
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                val groups = listOf(
                    Triple(TaskStatus.IN_PROGRESS, "进行中", rows.filter { it.status == TaskStatus.IN_PROGRESS }),
                    Triple(TaskStatus.TODO, "未开始", rows.filter { it.status == TaskStatus.TODO }),
                    Triple(TaskStatus.DONE, "已完成", rows.filter { it.status == TaskStatus.DONE }),
                )
                groups.forEach { (_, label, groupRows) ->
                    if (groupRows.isNotEmpty()) {
                        item(key = "header_$label") {
                            Text(
                                text = "$label (${groupRows.size})",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                            )
                        }
                        items(groupRows, key = { "${it.kind}:${it.id}" }) { row ->
                            if (row.folder != null) {
                                val folder = row.folder
                                ListItem(
                                    headlineContent = { Text(folder.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                    supportingContent = { Text("${statusLabel(row.status)} · ${row.taskCount} 个任务") },
                                    leadingContent = { Icon(Icons.Default.Folder, contentDescription = null) },
                                    trailingContent = {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            TextButton(onClick = { pendingMoveRow = row }) { Text("移动") }
                                            IconButton(onClick = { pendingDeleteFolder = folder }) {
                                                Icon(Icons.Default.DeleteOutline, contentDescription = "删除目录树")
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)
                                )
                                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    TextButton(onClick = { moveAdjacent(row, -1) }) { Text("上移") }
                                    TextButton(onClick = { moveAdjacent(row, 1) }) { Text("下移") }
                                    Button(onClick = { currentFolderId = folder.id }, modifier = Modifier.weight(1f)) { Text("打开目录") }
                                }
                            } else {
                                val task = row.task!!
                                M3TaskRow(
                                    task = task,
                                    projectName = null,
                                    showPriority = false,
                                    onClick = { onNavigateToDetail(task.id) },
                                    onStatusToggle = { next -> viewModel.updateTaskStatus(task, next) }
                                )
                                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    TextButton(onClick = { moveAdjacent(row, -1) }) { Text("上移") }
                                    TextButton(onClick = { moveAdjacent(row, 1) }) { Text("下移") }
                                    TextButton(onClick = { pendingMoveRow = row }) { Text("移动到目录") }
                                }
                            }
                        }
                    }
                }
                if (rows.isEmpty()) {
                    item { Text("当前目录为空", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp)) }
                }
            }
        }
    }

    if (showFolderDialog) {
        TitleDialog(
            title = "新建文件夹",
            label = "文件夹名称",
            value = draftTitle,
            onValueChange = { draftTitle = it },
            onDismiss = { showFolderDialog = false; draftTitle = "" },
            onConfirm = { viewModel.createFolderV2(currentFolderId, draftTitle); showFolderDialog = false; draftTitle = "" }
        )
    }
    if (showTaskDialog) {
        TitleDialog(
            title = "新建任务",
            label = "任务标题",
            value = draftTitle,
            onValueChange = { draftTitle = it },
            onDismiss = { showTaskDialog = false; draftTitle = "" },
            onConfirm = { viewModel.createTreeTaskV2(currentFolderId, draftTitle); showTaskDialog = false; draftTitle = "" }
        )
    }
    pendingDeleteFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { pendingDeleteFolder = null },
            title = { Text("处理目录树") },
            text = { Text("选择归档整棵目录，或在线预览后永久删除。删除不会删除流程和时间点，但会删除其中的任务及其依赖。") },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { viewModel.archiveFolderV2(folder); pendingDeleteFolder = null }) { Text("递归归档") }
                    TextButton(onClick = {
                        scope.launch {
                            val result = viewModel.api.getV2DeletePreview(folder.id)
                            result.getOrNull()?.let { pendingPreview = it }
                        }
                        pendingDeleteFolder = null
                    }) { Text("在线预览删除") }
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteFolder = null }) { Text("取消") }
            }
        )
    }
    pendingPreview?.let { preview ->
        AlertDialog(
            onDismissRequest = { pendingPreview = null },
            title = { Text("确认删除 ${preview.title}？") },
            text = { Text("文件夹 ${preview.folderCount} 个，任务 ${preview.taskCount} 个，备注 ${preview.noteCount} 条，步骤 ${preview.stepCount} 条，安排 ${preview.placementCount} 条。此操作不可恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    val folderId = preview.rootFolderId
                    pendingPreview = null
                    scope.launch { viewModel.deleteFolderTreeV2(folderId, preview.confirmationToken) }
                }) { Text("永久删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingPreview = null }) { Text("取消") } }
        )
    }
    pendingMoveRow?.let { row ->
        val currentFolder = row.folder
        val excludedIds = if (currentFolder == null) emptySet() else descendantFolderIds(currentFolder.id, allFolders)
        val targets = allFolders
            .filter { it.archivedAt == null && it.deletedAt == null && it.id !in excludedIds && it.id != currentFolder?.id }
            .sortedWith(compareBy<FolderEntity>({ it.parentFolderId != null }, { it.rank.toLongOrNull() ?: 0L }, { it.id }))
        AlertDialog(
            onDismissRequest = { pendingMoveRow = null },
            title = { Text("移动到目录") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = {
                        viewModel.moveTreeV2(row.kind, row.id, null, row.status, baseVersion = row.version)
                        pendingMoveRow = null
                    }, modifier = Modifier.fillMaxWidth()) { Text("根目录") }
                    targets.forEach { target ->
                        TextButton(onClick = {
                            viewModel.moveTreeV2(row.kind, row.id, target.id, row.status, baseVersion = row.version)
                            pendingMoveRow = null
                        }, modifier = Modifier.fillMaxWidth()) { Text(target.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { pendingMoveRow = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun TitleDialog(
    title: String,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(value = value, onValueChange = onValueChange, label = { Text(label) }, singleLine = true) },
        confirmButton = { TextButton(onClick = onConfirm, enabled = value.trim().isNotEmpty()) { Text("创建") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AllTasksV2Screen(viewModel: MainViewModel, onNavigateToDetail: (String) -> Unit) {
    val tasks by viewModel.treeTasksV2.collectAsState()
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { TopAppBar(title = { Text("所有任务") }) }
    ) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(12.dp)) {
            items(tasks, key = { it.id }) { task ->
                M3TaskRow(task = task, projectName = null, showPriority = false, onClick = { onNavigateToDetail(task.id) }, onStatusToggle = { next -> viewModel.updateTaskStatus(task, next) })
            }
        }
    }
}

private fun folderTitle(id: String, folders: List<FolderEntity>): String = folders.find { it.id == id }?.title ?: "目录"

private data class TreeRow(
    val kind: String,
    val id: String,
    val folder: FolderEntity? = null,
    val task: TaskEntity? = null,
    val status: TaskStatus,
    val version: Long,
    val rank: String,
    val taskCount: Int = 0,
)

private fun buildTreeRows(
    folders: List<FolderEntity>,
    tasks: List<TaskEntity>,
    allFolders: List<FolderEntity>,
    allTasks: List<TaskEntity>,
): List<TreeRow> {
    val folderRows = folders.map { folder ->
        val aggregate = aggregateFor(folder.id, allFolders, allTasks)
        TreeRow("FOLDER", folder.id, folder = folder, status = aggregate.first, version = folder.version, rank = folder.rank, taskCount = aggregate.second)
    }
    val taskRows = tasks.map { task ->
        TreeRow("TASK", task.id, task = task, status = task.status, version = task.version, rank = task.rank)
    }
    return (folderRows + taskRows).sortedWith(
        compareBy<TreeRow>(
            { statusOrder(it.status) },
            { it.rank.toLongOrNull() ?: 0L },
            { if (it.kind == "FOLDER") 0 else 1 },
            { it.id }
        )
    )
}

private fun aggregateFor(id: String, folders: List<FolderEntity>, tasks: List<TaskEntity>): Pair<TaskStatus, Int> {
    val ids = mutableSetOf(id)
    var changed = true
    while (changed) {
        changed = false
        folders
            .filter { it.deletedAt == null && it.archivedAt == null && it.parentFolderId in ids }
            .forEach { if (ids.add(it.id)) changed = true }
    }
    val descendants = tasks.filter { it.deletedAt == null && it.archivedAt == null && it.parentFolderId in ids }
    val inProgress = descendants.count { it.status == TaskStatus.IN_PROGRESS }
    val todo = descendants.count { it.status == TaskStatus.TODO }
    val done = descendants.count { it.status == TaskStatus.DONE }
    val status = when {
        descendants.isEmpty() || (todo == descendants.size) -> TaskStatus.TODO
        done == descendants.size -> TaskStatus.DONE
        else -> TaskStatus.IN_PROGRESS
    }
    return status to descendants.size
}

private fun statusOrder(status: TaskStatus): Int = when (status) {
    TaskStatus.IN_PROGRESS -> 0
    TaskStatus.TODO -> 1
    TaskStatus.DONE -> 2
}

private fun statusLabel(status: TaskStatus): String = when (status) {
    TaskStatus.TODO -> "待办"
    TaskStatus.IN_PROGRESS -> "进行中"
    TaskStatus.DONE -> "已完成"
}

private fun descendantFolderIds(rootId: String, folders: List<FolderEntity>): Set<String> {
    val ids = mutableSetOf(rootId)
    var changed = true
    while (changed) {
        changed = false
        folders.filter { it.parentFolderId != null && it.parentFolderId in ids }.forEach { if (ids.add(it.id)) changed = true }
    }
    return ids
}
