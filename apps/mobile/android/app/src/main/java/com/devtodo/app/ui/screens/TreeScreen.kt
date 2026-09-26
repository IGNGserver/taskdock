package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.DeletePreviewDto
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.navigation.Screen
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * Material 3 Expressive Home Hub & Directory Tree.
 * Completely redesigned to feature:
 * - Expressive Top Header with sync state & global action pills
 * - Grid of Expressive Smart Metric Cards (Today, Schedule, Workflows, All Tasks)
 * - Tonal Folder and Task Cards with fluid spring interactions
 * - Floating Action Island at bottom for effortless single-hand task capture
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TreeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    initialFolderId: String? = null,
    highlightedTaskId: String? = null,
    locateRequest: Int = 0,
    onNavigateToShortcut: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onOpenSearch: () -> Unit = {},
) {
    var currentFolderId by rememberSaveable { mutableStateOf<String?>(initialFolderId) }
    val allFolders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val allTasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val todayTasks by viewModel.todayTasks.collectAsStateWithLifecycle()
    val workflows by viewModel.workflowsV2.collectAsStateWithLifecycle()

    val folders = allFolders.filter {
        it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
    }
    val tasks = allTasks.filter {
        it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
    }

    val listStateHolder = rememberSaveableStateHolder()
    var handledLocateRequest by rememberSaveable { mutableStateOf(0) }

    LaunchedEffect(locateRequest) {
        if (locateRequest > handledLocateRequest) {
            currentFolderId = initialFolderId
            handledLocateRequest = locateRequest
        }
    }

    PredictiveBackContainer(
        enabled = currentFolderId != null,
        onBack = {
            currentFolderId = allFolders.find { it.id == currentFolderId }?.parentFolderId
        },
    ) {
        var showFolderDialog by rememberSaveable { mutableStateOf(false) }
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

        WorkspaceScaffold(
            topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = currentFolderId?.let { folderTitle(it, allFolders) } ?: "TaskDock",
                        style = if (currentFolderId == null) {
                            MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold)
                        } else {
                            MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold)
                        },
                    )
                },
                navigationIcon = {
                    if (currentFolderId != null) {
                        IconButton(
                            onClick = {
                                currentFolderId = allFolders.find { it.id == currentFolderId }?.parentFolderId
                            }
                        ) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回上级目录")
                        }
                    }
                },
                actions = {
                    if (currentFolderId == null) {
                        IconButton(
                            onClick = onOpenSearch,
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.Search, "搜索全部任务")
                        }
                        IconButton(
                            onClick = onOpenSettings,
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.Settings, "设置")
                        }
                    } else {
                        IconButton(
                            onClick = { showFolderDialog = true },
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.CreateNewFolder, "新建子目录")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        },
        bottomBar = {
            // Floating Action Island: single-hand friendly, quick task creation
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("tree-create-bar"),
                contentAlignment = Alignment.Center,
            ) {
                FloatingActionIsland(
                    onQuickCreate = { title ->
                        viewModel.createTreeTaskV2(currentFolderId, title)
                    },
                    placeholder = if (currentFolderId == null) "新建一条任务…" else "在此目录下添加任务…",
                    primaryLabel = "新建任务",
                )
            }
        },
    ) { padding ->
        listStateHolder.SaveableStateProvider(currentFolderId ?: "root-directory") {
            val listState = rememberLazyListState()

            LaunchedEffect(highlightedTaskId, rows, locateRequest) {
                val index = rows.indexOfFirst { it.id == highlightedTaskId }
                if (index >= 0) {
                    listState.animateScrollToItem(index + if (currentFolderId == null) 2 else 1)
                }
            }

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .testTag("directory-tree-list"),
                state = listState,
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                if (currentFolderId == null) {
                    // Expressive Smart View Dashboard
                    item(key = "expressive-smart-dashboard") {
                        ExpressiveSmartDashboard(
                            todayCount = todayTasks.count { it.first.status != TaskStatus.DONE },
                            todayTotal = todayTasks.size,
                            workflowCount = workflows.size,
                            totalTasks = allTasks.count { it.archivedAt == null && it.deletedAt == null },
                            onNavigate = onNavigateToShortcut,
                        )
                    }

                    // Directory Section Header
                    item(key = "directory-heading") {
                        DirectorySectionHeader(
                            folderCount = folders.size,
                            rootTaskCount = tasks.size,
                            onCreateFolder = { showFolderDialog = true },
                        )
                    }
                } else {
                    item(key = "directory-overview") {
                        DirectoryOverview(
                            folderCount = folders.size,
                            taskCount = tasks.size,
                            pendingCount = tasks.count { it.status != TaskStatus.DONE },
                        )
                    }
                }

                // Directory rows
                itemsIndexed(rows, key = { _, row -> "${row.kind}:${row.id}" }) { rowIndex, row ->
                    val siblings = rows.filter { it.status == row.status }
                    val index = siblings.indexOfFirst { it.id == row.id }
                    val actions = listOf(
                        RowAction("上移", enabled = index > 0) { moveAdjacent(row, -1) },
                        RowAction("下移", enabled = index < siblings.lastIndex) { moveAdjacent(row, 1) },
                        RowAction("移动到目录") { pendingMoveRow = row },
                    )

                    val startsStatusGroup = rowIndex == 0 || rows[rowIndex - 1].status != row.status
                    if (currentFolderId != null && startsStatusGroup) {
                        SectionHeading("${taskStatusLabel(row.status)} · ${siblings.size}")
                    }

                    if (row.folder != null) {
                        val folder = row.folder
                        val (badgeColor, badgeContent) = when (folder.title.hashCode().ushr(1) % 3) {
                            0 -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
                            1 -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
                            else -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
                        }

                        ExpressiveFolderCard(
                            folder = folder,
                            itemCount = row.taskCount,
                            onClick = { currentFolderId = folder.id },
                            actions = actions + RowAction("归档或删除", destructive = true) {
                                pendingDeleteFolder = folder
                            },
                            badgeColor = badgeColor,
                            badgeContentColor = badgeContent,
                            modifier = Modifier.testTag("tree-row-${row.id}"),
                        )
                    } else {
                        val task = row.task!!
                        ExpressiveTaskCard(
                            task = task,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                            actions = actions,
                            highlighted = task.id == highlightedTaskId,
                            modifier = Modifier.testTag("tree-row-${row.id}"),
                        )
                    }
                }

                if (rows.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Default.Folder,
                            title = if (currentFolderId == null) "目录为空" else "当前目录暂无任务",
                            description = if (currentFolderId == null)
                                "通过下方快捷操作随手记下第一条任务，或新建文件夹归类工作。"
                            else "通过底部输入栏新建任务，或创建下级子目录。",
                            action = {
                                if (currentFolderId == null) {
                                    FilledTonalButton(
                                        onClick = { showFolderDialog = true },
                                        shape = TaskDockShapes.FullPill,
                                    ) {
                                        Icon(Icons.Default.CreateNewFolder, null)
                                        Spacer(Modifier.width(8.dp))
                                        Text("新建目录")
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    if (showFolderDialog) {
        CaptureSheet("新建文件夹", "文件夹名称", onDismiss = { showFolderDialog = false }) {
            viewModel.createFolderV2(currentFolderId, it)
        }
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
                    modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
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
}

/**
 * Expressive Smart Dashboard Cards Grid (Inspired by Breezy Weather).
 */
@Composable
private fun ExpressiveSmartDashboard(
    todayCount: Int,
    todayTotal: Int,
    workflowCount: Int,
    totalTasks: Int,
    onNavigate: (String) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = "快捷视图",
            style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurfaceVariant,
            modifier = Modifier
                .padding(start = 4.dp)
                .semantics { heading() },
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Today Card
            ExpressiveSmartCard(
                title = "今天",
                countText = "$todayCount 待办",
                icon = Icons.Default.Today,
                onClick = { onNavigate(Screen.Today.route) },
                progress = if (todayTotal > 0) (todayTotal - todayCount).toFloat() / todayTotal else null,
                iconContainerColor = scheme.primaryContainer,
                iconColor = scheme.onPrimaryContainer,
                modifier = Modifier.weight(1f),
            )

            // Schedule Card
            ExpressiveSmartCard(
                title = "日程",
                countText = "查看",
                icon = Icons.Default.CalendarToday,
                onClick = { onNavigate(Screen.Time.route) },
                iconContainerColor = scheme.secondaryContainer,
                iconColor = scheme.onSecondaryContainer,
                modifier = Modifier.weight(1f),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Workflows Card
            ExpressiveSmartCard(
                title = "流程",
                countText = "$workflowCount 条",
                icon = Icons.Default.AccountTree,
                onClick = { onNavigate(Screen.Workflows.route) },
                iconContainerColor = scheme.tertiaryContainer,
                iconColor = scheme.onTertiaryContainer,
                modifier = Modifier.weight(1f),
            )

            // All Tasks Card
            ExpressiveSmartCard(
                title = "全部任务",
                countText = "$totalTasks 项",
                icon = Icons.Default.Checklist,
                onClick = { onNavigate(Screen.AllTasks.route) },
                iconContainerColor = scheme.surfaceContainerHighest,
                iconColor = scheme.onSurface,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun DirectorySectionHeader(
    folderCount: Int,
    rootTaskCount: Int,
    onCreateFolder: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, top = 16.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "目录树",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "$folderCount 个目录 · $rootTaskCount 条根任务",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        FilledTonalButton(
            onClick = onCreateFolder,
            shape = TaskDockShapes.FullPill,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Icon(Icons.Default.CreateNewFolder, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("新建目录")
        }
    }
}

@Composable
private fun DirectoryOverview(
    folderCount: Int,
    taskCount: Int,
    pendingCount: Int,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        shape = TaskDockShapes.LargeIncreased,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                shape = TaskDockShapes.Medium,
                color = MaterialTheme.colorScheme.tertiaryContainer,
                modifier = Modifier.size(42.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Default.Folder,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onTertiaryContainer,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "当前目录",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "$folderCount 个子目录 · $taskCount 条任务 · $pendingCount 项待办",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
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

private fun descendantFolderIds(rootId: String, folders: List<FolderEntity>): Set<String> {
    val ids = mutableSetOf(rootId)
    var changed = true
    while (changed) {
        changed = false
        folders
            .filter { it.deletedAt == null && it.archivedAt == null && it.parentFolderId in ids }
            .forEach { if (ids.add(it.id)) changed = true }
    }
    return ids
}

/**
 * AllTasks Search & Filter View (Redesigned with M3 Expressive)
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun AllTasksV2Screen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    listState: LazyListState = rememberLazyListState(),
    onBack: () -> Unit = {},
) {
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    val normalizedQuery = query.trim()
    val visible = tasks.filter {
        it.deletedAt == null &&
            it.archivedAt == null &&
            (filter == null || it.status.name == filter) &&
            (it.title.contains(normalizedQuery, ignoreCase = true) ||
                it.referenceId?.contains(normalizedQuery, ignoreCase = true) == true)
    }

    PredictiveBackContainer(
        enabled = true,
        onBack = onBack,
    ) {
        WorkspaceScaffold(
            topBar = {
                TopAppBar(
                    title = { Text("全部任务", fontWeight = FontWeight.Bold) },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    )
                )
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                // Expressive Search & Filter Header
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    shape = TaskDockShapes.LargeIncreased,
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = { Text("搜索任务标题或引用编号…") },
                            singleLine = true,
                            leadingIcon = { Icon(Icons.Default.Search, null) },
                            trailingIcon = {
                                if (query.isNotEmpty()) {
                                    IconButton(onClick = { query = "" }) {
                                        Icon(Icons.Default.Close, "清除搜索")
                                    }
                                }
                            },
                            shape = TaskDockShapes.FullPill,
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            FilterChip(
                                selected = filter == null,
                                onClick = { filter = null },
                                label = { Text("全部 (${tasks.size})") },
                                shape = TaskDockShapes.FullPill,
                            )
                            TaskStatus.entries.forEach { status ->
                                val count = tasks.count { it.status == status }
                                FilterChip(
                                    selected = filter == status.name,
                                    onClick = { filter = status.name },
                                    label = { Text("${taskStatusLabel(status)} ($count)") },
                                    shape = TaskDockShapes.FullPill,
                                )
                            }
                        }
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = when {
                            normalizedQuery.isNotEmpty() -> "搜索结果"
                            filter != null -> "${taskStatusLabel(TaskStatus.valueOf(filter!!))}任务"
                            else -> "任务列表"
                        },
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "${visible.size} 项",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .imePadding()
                        .testTag("all-tasks-list"),
                    state = listState,
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    items(visible, key = { it.id }) { task ->
                        ExpressiveTaskCard(
                            task = task,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                            showStatus = filter == null,
                            modifier = Modifier.testTag("all-task-${task.id}"),
                        )
                    }

                    if (visible.isEmpty()) {
                        item {
                            EmptyState(
                                icon = Icons.Default.Search,
                                title = if (normalizedQuery.isNotEmpty()) "没有匹配的任务" else "暂无该状态任务",
                                description = "尝试更换关键词或筛选条件。",
                            )
                        }
                    }
                }
            }
        }
    }
}
