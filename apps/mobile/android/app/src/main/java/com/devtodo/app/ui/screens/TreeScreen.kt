package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.DeletePreviewDto
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.WorkspaceScaffold
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TreeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    initialFolderId: String? = null,
    highlightedTaskId: String? = null,
    locateRequest: Int = 0,
) {
    var currentFolderId by rememberSaveable { mutableStateOf<String?>(initialFolderId) }
    val allFolders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val allTasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val folders =
        allFolders.filter {
            it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
        }
    val tasks =
        allTasks.filter {
            it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
        }
    val tabState = rememberSaveableStateHolder()
    var tab by rememberSaveable { mutableStateOf(0) }
    val listState = rememberLazyListState()
    var handledLocateRequest by rememberSaveable { mutableStateOf(0) }
    LaunchedEffect(locateRequest) {
        if (locateRequest > handledLocateRequest) {
            currentFolderId = initialFolderId
            tab = 0
            handledLocateRequest = locateRequest
        }
    }
    BackHandler(currentFolderId != null && tab == 0) {
        currentFolderId = allFolders.find { it.id == currentFolderId }?.parentFolderId
    }
    var showFolderDialog by rememberSaveable { mutableStateOf(false) }
    var showTaskDialog by rememberSaveable { mutableStateOf(false) }
    var pendingPreview by remember { mutableStateOf<DeletePreviewDto?>(null) }
    var pendingDeleteFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var pendingMoveRow by remember { mutableStateOf<TreeRow?>(null) }
    val scope = rememberCoroutineScope()
    val rows =
        remember(folders, tasks, allFolders, allTasks) {
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

    LaunchedEffect(highlightedTaskId, rows, locateRequest) {
        val index = rows.indexOfFirst { it.id == highlightedTaskId }
        if (index >= 0) listState.animateScrollToItem(index)
    }
    WorkspaceScaffold(
        topBar = {
            Column {
                TopAppBar(
                    windowInsets = WindowInsets(0, 0, 0, 0),
                    title = {
                        Text(
                            if (tab == 0)
                                currentFolderId?.let { folderTitle(it, allFolders) } ?: "任务库"
                            else "全部任务"
                        )
                    },
                    navigationIcon = {
                        if (currentFolderId != null && tab == 0)
                            IconButton(
                                onClick = {
                                    currentFolderId =
                                        allFolders.find { it.id == currentFolderId }?.parentFolderId
                                }
                            ) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回上级目录")
                            }
                    },
                    actions = {
                        if (tab == 0)
                            ActionMenu(
                                "目录操作",
                                listOf(RowAction("新建文件夹") { showFolderDialog = true }),
                            )
                    },
                )
                WorkspaceTabs(listOf("任务库", "全部任务"), tab) { tab = it }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showTaskDialog = true },
                icon = { Icon(Icons.Default.Add, null) },
                text = { Text("新建任务") },
            )
        },
    ) { padding ->
        if (tab == 1)
            tabState.SaveableStateProvider("all-tasks") {
                AllTasksV2Screen(viewModel, onNavigateToDetail)
            }
        else
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                state = listState,
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                items(rows, key = { "${it.kind}:${it.id}" }) { row ->
                    val siblings = rows.filter { it.status == row.status }
                    val index = siblings.indexOfFirst { it.id == row.id }
                    val actions =
                        listOf(
                            RowAction("上移", enabled = index > 0) { moveAdjacent(row, -1) },
                            RowAction("下移", enabled = index < siblings.lastIndex) {
                                moveAdjacent(row, 1)
                            },
                            RowAction("移动到目录") { pendingMoveRow = row },
                        )
                    if (row.folder != null) {
                        val folder = row.folder
                        ListItem(
                            headlineContent = {
                                Text(folder.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            },
                            supportingContent = {
                                Text("${statusLabel(row.status)} · ${row.taskCount} 个任务")
                            },
                            leadingContent = {
                                Icon(
                                    Icons.Default.Folder,
                                    null,
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            },
                            trailingContent = {
                                ActionMenu(
                                    "${folder.title}，更多操作",
                                    actions +
                                        RowAction("归档或删除", destructive = true) {
                                            pendingDeleteFolder = folder
                                        },
                                )
                            },
                            modifier =
                                Modifier.fillMaxWidth().clickable(onClickLabel = "打开目录") {
                                    currentFolderId = folder.id
                                },
                        )
                    } else {
                        val task = row.task!!
                        M3TaskRow(
                            task,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                            actions = actions,
                            highlighted = task.id == highlightedTaskId,
                        )
                    }
                }
                if (rows.isEmpty())
                    item { EmptyState(Icons.Default.Folder, "这个目录还是空的", "添加任务，或通过右上角菜单创建子目录。") }
            }
    }

    if (showFolderDialog)
        CaptureSheet("新建文件夹", "文件夹名称", onDismiss = { showFolderDialog = false }) {
            viewModel.createFolderV2(currentFolderId, it)
        }
    if (showTaskDialog)
        CaptureSheet("新建任务", onDismiss = { showTaskDialog = false }) {
            viewModel.createTreeTaskV2(if (tab == 0) currentFolderId else null, it)
        }
    pendingDeleteFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { pendingDeleteFolder = null },
            title = { Text("处理目录树") },
            text = { Text("选择归档整棵目录，或在线预览后永久删除。删除不会删除流程和事件，但会删除其中的任务及其依赖。") },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(
                        onClick = {
                            viewModel.archiveFolderV2(folder)
                            pendingDeleteFolder = null
                        }
                    ) {
                        Text("递归归档")
                    }
                    TextButton(
                        onClick = {
                            scope.launch {
                                val result = viewModel.api.getV2DeletePreview(folder.id)
                                result
                                    .onSuccess { pendingPreview = it }
                                    .onFailure {
                                        viewModel.showMessage(it.message ?: "无法获取删除预览，请检查连接")
                                    }
                            }
                            pendingDeleteFolder = null
                        }
                    ) {
                        Text("在线预览删除")
                    }
                }
            },
            dismissButton = { TextButton(onClick = { pendingDeleteFolder = null }) { Text("取消") } },
        )
    }
    pendingPreview?.let { preview ->
        AlertDialog(
            onDismissRequest = { pendingPreview = null },
            title = { Text("确认删除 ${preview.title}？") },
            text = {
                Text(
                    "文件夹 ${preview.folderCount} 个，任务 ${preview.taskCount} 个，备注 ${preview.noteCount} 条，步骤 ${preview.stepCount} 条，安排 ${preview.placementCount} 条。此操作不可恢复。"
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val folderId = preview.rootFolderId
                        pendingPreview = null
                        scope.launch {
                            viewModel
                                .deleteFolderTreeV2(folderId, preview.confirmationToken)
                                .onFailure { viewModel.showMessage(it.message ?: "删除失败，请重新预览") }
                        }
                    }
                ) {
                    Text("永久删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { pendingPreview = null }) { Text("取消") } },
        )
    }
    pendingMoveRow?.let { row ->
        val currentFolder = row.folder
        val excludedIds =
            if (currentFolder == null) emptySet()
            else descendantFolderIds(currentFolder.id, allFolders)
        val targets =
            allFolders
                .filter {
                    it.archivedAt == null &&
                        it.deletedAt == null &&
                        it.id !in excludedIds &&
                        it.id != currentFolder?.id
                }
                .sortedWith(
                    compareBy<FolderEntity>(
                        { it.parentFolderId != null },
                        { it.rank.toLongOrNull() ?: 0L },
                        { it.id },
                    )
                )
        AlertDialog(
            onDismissRequest = { pendingMoveRow = null },
            title = { Text("移动到目录") },
            text = {
                Column(
                    modifier =
                        Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(
                        onClick = {
                            viewModel.moveTreeV2(
                                row.kind,
                                row.id,
                                null,
                                row.status,
                                baseVersion = row.version,
                            )
                            pendingMoveRow = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("根目录")
                    }
                    targets.forEach { target ->
                        TextButton(
                            onClick = {
                                viewModel.moveTreeV2(
                                    row.kind,
                                    row.id,
                                    target.id,
                                    row.status,
                                    baseVersion = row.version,
                                )
                                pendingMoveRow = null
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(target.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { pendingMoveRow = null }) { Text("取消") } },
        )
    }
}

@Composable
fun AllTasksV2Screen(viewModel: MainViewModel, onNavigateToDetail: (String) -> Unit) {
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    val visible =
        tasks.filter {
            it.deletedAt == null &&
                it.archivedAt == null &&
                (filter == null || it.status.name == filter) &&
                (it.title.contains(query.trim(), ignoreCase = true) ||
                    it.referenceId?.contains(query.trim(), ignoreCase = true) == true)
        }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query,
            { query = it },
            label = { Text("搜索任务") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        )
        Row(
            Modifier.fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = filter == null,
                onClick = { filter = null },
                label = { Text("全部") },
            )
            TaskStatus.entries.forEach { status ->
                FilterChip(
                    selected = filter == status.name,
                    onClick = { filter = status.name },
                    label = { Text(taskStatusLabel(status)) },
                )
            }
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 96.dp)) {
            items(visible, key = { it.id }) { task ->
                M3TaskRow(
                    task,
                    onClick = { onNavigateToDetail(task.id) },
                    onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                )
            }
            if (visible.isEmpty())
                item { EmptyState(Icons.Default.Search, "没有匹配的任务", "试试其他关键词或状态。") }
        }
    }
}

private fun folderTitle(id: String, folders: List<FolderEntity>): String =
    folders.find { it.id == id }?.title ?: "目录"

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
    val folderRows =
        folders.map { folder ->
            val aggregate = aggregateFor(folder.id, allFolders, allTasks)
            TreeRow(
                "FOLDER",
                folder.id,
                folder = folder,
                status = aggregate.first,
                version = folder.version,
                rank = folder.rank,
                taskCount = aggregate.second,
            )
        }
    val taskRows =
        tasks.map { task ->
            TreeRow(
                "TASK",
                task.id,
                task = task,
                status = task.status,
                version = task.version,
                rank = task.rank,
            )
        }
    return (folderRows + taskRows).sortedWith(
        compareBy<TreeRow>(
            { statusOrder(it.status) },
            { it.rank.toLongOrNull() ?: 0L },
            { if (it.kind == "FOLDER") 0 else 1 },
            { it.id },
        )
    )
}

private fun aggregateFor(
    id: String,
    folders: List<FolderEntity>,
    tasks: List<TaskEntity>,
): Pair<TaskStatus, Int> {
    val ids = mutableSetOf(id)
    var changed = true
    while (changed) {
        changed = false
        folders
            .filter { it.deletedAt == null && it.archivedAt == null && it.parentFolderId in ids }
            .forEach { if (ids.add(it.id)) changed = true }
    }
    val descendants =
        tasks.filter { it.deletedAt == null && it.archivedAt == null && it.parentFolderId in ids }
    val todo = descendants.count { it.status == TaskStatus.TODO }
    val done = descendants.count { it.status == TaskStatus.DONE }
    val status =
        when {
            descendants.isEmpty() || (todo == descendants.size) -> TaskStatus.TODO
            done == descendants.size -> TaskStatus.DONE
            else -> TaskStatus.IN_PROGRESS
        }
    return status to descendants.size
}

private fun statusOrder(status: TaskStatus): Int =
    when (status) {
        TaskStatus.IN_PROGRESS -> 0
        TaskStatus.TODO -> 1
        TaskStatus.DONE -> 2
    }

private fun statusLabel(status: TaskStatus): String =
    when (status) {
        TaskStatus.TODO -> "待办"
        TaskStatus.IN_PROGRESS -> "进行中"
        TaskStatus.DONE -> "已完成"
    }

private fun descendantFolderIds(rootId: String, folders: List<FolderEntity>): Set<String> {
    val ids = mutableSetOf(rootId)
    var changed = true
    while (changed) {
        changed = false
        folders
            .filter { it.parentFolderId != null && it.parentFolderId in ids }
            .forEach { if (ids.add(it.id)) changed = true }
    }
    return ids
}
