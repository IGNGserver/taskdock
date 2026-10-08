package com.devtodo.app.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
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
import kotlinx.coroutines.launch

/**
 * A single directory page. Every folder is a navigation destination, so opening
 * a folder and swiping back run through Navigation Compose's predictive back
 * with the same M3 Expressive transitions as the rest of the app.
 *
 * Status edits paint the row in place: the circle answers the tap immediately,
 * but the row keeps the group and order it had when the directory was opened.
 * The pins are released when the user re-enters the directory (a new route
 * entry) or performs a structural edit such as moving or deleting a row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TreeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    folderId: String? = null,
    onOpenFolder: (String) -> Unit = {},
    onBack: (() -> Unit)? = null,
    highlightedTaskId: String? = null,
    locateRequest: Int = 0,
    onNavigateToShortcut: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onOpenSearch: () -> Unit = {},
) {
    val allFolders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val allTasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val todayTasks by viewModel.todayTasks.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()

    val folders = allFolders.filter {
        it.parentFolderId == folderId && it.archivedAt == null && it.deletedAt == null
    }
    val tasks = allTasks.filter {
        it.parentFolderId == folderId && it.archivedAt == null && it.deletedAt == null
    }

    // `groupPins` remembers the status a row was loaded with so it stays in its
    // group; `statusOverrides` is what the circle paints right now. Both mirror
    // the web directory (`groupPins` / `statusOverrides` in TreePage.tsx).
    val statusOverrides = remember { mutableStateMapOf<String, TaskStatus>() }
    val groupPins = remember { mutableStateMapOf<String, TaskStatus>() }
    var orderLock by remember { mutableStateOf<List<String>?>(null) }

    fun groupingStatus(row: TreeRow): TaskStatus = treeGroupingStatus(row, groupPins)

    fun displayTask(row: TreeRow): TaskEntity? =
        row.task?.let { task -> statusOverrides[task.id]?.let { task.copy(status = it) } ?: task }

    fun releasePins() {
        statusOverrides.clear()
        groupPins.clear()
        orderLock = null
    }

    val baseRows = remember(folders, tasks, allFolders, allTasks) {
        buildTreeRows(folders, tasks, allFolders, allTasks)
    }
    // While a status edit is pending the locked order wins, so a background sync
    // that follows the edit cannot slide the row to a new position. Rows that
    // appeared after the lock was taken are appended rather than dropped.
    val rows = remember(baseRows, orderLock, statusOverrides.toMap(), groupPins.toMap()) {
        resolveTreeRows(baseRows, groupPins, orderLock)
    }

    fun changeStatus(row: TreeRow, nextStatus: TaskStatus) {
        val task = row.task ?: return
        if (orderLock == null) orderLock = rows.map { "${it.kind}:${it.id}" }
        statusOverrides[task.id] = nextStatus
        if (task.id !in groupPins) groupPins[task.id] = row.status
        viewModel.updateTaskStatus(task, nextStatus)
    }

    fun moveAdjacent(row: TreeRow, direction: Int) {
        val status = groupingStatus(row)
        val siblings = rows.filter { groupingStatus(it) == status }
        val index = siblings.indexOfFirst { it.id == row.id }
        val target = siblings.getOrNull(index + direction) ?: return
        releasePins()
        viewModel.moveTreeV2(
            kind = row.kind,
            id = row.id,
            parentFolderId = folderId,
            expectedStatus = row.status,
            beforeId = if (direction < 0) target.id else null,
            afterId = if (direction > 0) target.id else null,
            baseVersion = row.version,
        )
    }

    var showFolderDialog by rememberSaveable { mutableStateOf(false) }
    var pendingPreview by remember { mutableStateOf<DeletePreviewDto?>(null) }
    var pendingDeleteFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var pendingMoveRow by remember { mutableStateOf<TreeRow?>(null) }
    val scope = rememberCoroutineScope()

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = folderId?.let { folderTitle(it, allFolders) } ?: "TaskDock",
                        style = if (folderId == null) {
                            MaterialTheme.typography.headlineSmall
                        } else {
                            MaterialTheme.typography.titleLarge
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                "返回上级目录",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                actions = {
                    if (folderId == null) {
                        IconButton(
                            onClick = onOpenSearch,
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.Search, "搜索全部任务", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        IconButton(
                            onClick = onOpenSettings,
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.Settings, "设置", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        IconButton(
                            onClick = { showFolderDialog = true },
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.CreateNewFolder, "新建子目录", tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
                TaskCaptureIsland(viewModel, initialFolderId = folderId)
            }
        },
    ) { padding ->
        val listState = rememberLazyListState()
        var showCompleted by rememberSaveable { mutableStateOf(false) }
        val visibleRows = rows.filter {
            it.folder != null || groupingStatus(it) != TaskStatus.DONE || showCompleted
        }
        val completedCount = rows.count {
            it.task != null && groupingStatus(it) == TaskStatus.DONE
        }

        LaunchedEffect(highlightedTaskId, rows, locateRequest) {
            val index = rows.indexOfFirst { it.id == highlightedTaskId }
            if (index >= 0) {
                if (rows[index].task != null && groupingStatus(rows[index]) == TaskStatus.DONE) {
                    showCompleted = true
                    withFrameNanos { }
                }
                listState.animateScrollToItem(index + if (folderId == null) 2 else 1)
            }
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("directory-tree-list"),
                state = listState,
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                if (folderId == null) {
                    // Expressive Smart View Dashboard
                    item(key = "expressive-smart-dashboard") {
                        ExpressiveSmartDashboard(
                            todayCount = todayTasks.count { it.first.status != TaskStatus.DONE },
                            todayTotal = todayTasks.size,
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
                    val status = groupingStatus(row)
                    val siblings = rows.filter { groupingStatus(it) == status }
                    val index = siblings.indexOfFirst { it.id == row.id }
                    val actions = listOf(
                        RowAction("上移", enabled = index > 0) { moveAdjacent(row, -1) },
                        RowAction("下移", enabled = index < siblings.lastIndex) { moveAdjacent(row, 1) },
                        RowAction("移动到目录") { pendingMoveRow = row },
                    )

                    AnimatedVisibility(
                        visible = row.folder != null || status != TaskStatus.DONE || showCompleted,
                        modifier = Modifier.animateItem(),
                        enter = fadeIn(TaskDockMotion.springEffectsFast()) + expandVertically(TaskDockMotion.springSpatial()),
                        exit = fadeOut(TaskDockMotion.springEffectsFast()) + shrinkVertically(TaskDockMotion.springSpatial()),
                    ) {
                        Column {
                            val startsStatusGroup = rowIndex == 0 || groupingStatus(rows[rowIndex - 1]) != status
                            if (folderId != null && startsStatusGroup) {
                                SectionHeading("${taskStatusLabel(status)} · ${siblings.size}")
                            }

                            if (row.folder != null) {
                                val folder = row.folder

                                ExpressiveFolderCard(
                                    folder = folder,
                                    itemCount = row.taskCount,
                                    onClick = { onOpenFolder(folder.id) },
                                    actions = actions + RowAction("归档或删除", destructive = true) {
                                        pendingDeleteFolder = folder
                                    },
                                    rowShape = TaskDockShapes.groupedRow(
                                        visibleRows.indexOfFirst { it.id == row.id }.coerceAtLeast(0),
                                        visibleRows.size,
                                    ),
                                    modifier = Modifier.testTag("tree-row-${row.id}"),
                                )
                            } else {
                                val task = displayTask(row)!!
                                ExpressiveTaskCard(
                                    task = task,
                                    onClick = { onNavigateToDetail(task.id) },
                                    onStatusToggle = { changeStatus(row, it) },
                                    actions = actions,
                                    showStatus = folderId == null,
                                    highlighted = task.id == highlightedTaskId,
                                    rowShape = TaskDockShapes.groupedRow(
                                        visibleRows.indexOfFirst { it.id == row.id }.coerceAtLeast(0),
                                        visibleRows.size,
                                    ),
                                    modifier = Modifier.testTag("tree-row-${row.id}"),
                                )
                            }
                        }
                    }
                }
                if (completedCount > 0) {
                    item(key = "completed-toggle") {
                        TextButton(onClick = { showCompleted = !showCompleted }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp)) {
                            Text("已完成任务 · $completedCount", modifier = Modifier.weight(1f))
                            Icon(if (showCompleted) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                if (showCompleted) "收起已完成任务" else "展开已完成任务")
                        }
                    }
                }

                if (rows.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Default.Folder,
                            title = if (folderId == null) "目录为空" else "当前目录暂无任务",
                            description = if (folderId == null)
                                "点下方“记一件事”开始，或先建一个目录。"
                            else "点下方“记一件事”，任务会保存在这个目录。",
                            action = {
                                if (folderId == null) {
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
            releasePins()
            viewModel.createFolderV2(folderId, it)
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
                            releasePins()
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
                            releasePins()
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
                                releasePins()
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

/** Keep the daily summary compact so directories remain visible on small screens. */
@Composable
private fun ExpressiveSmartDashboard(
    todayCount: Int,
    todayTotal: Int,
    onNavigate: (String) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val largeText = LocalDensity.current.fontScale >= 1.4f
    val completion = if (todayTotal == 0) "暂无安排" else "${todayTotal - todayCount} / $todayTotal 完成"
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("快捷视图", style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp).semantics { heading() })
        Surface(
            onClick = { onNavigate(Screen.Today.route) },
            shape = TaskDockShapes.LargeIncreased, color = scheme.primaryContainer,
        ) {
            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("今天", style = MaterialTheme.typography.titleMedium, color = scheme.onPrimaryContainer)
                    Text("$todayCount 件待办", style = MaterialTheme.typography.titleLarge,
                        color = scheme.onPrimaryContainer, modifier = Modifier.weight(1f))
                    if (!largeText) Text(completion, style = MaterialTheme.typography.bodySmall, color = scheme.onPrimaryContainer)
                }
                if (largeText) Text(completion, style = MaterialTheme.typography.bodySmall, color = scheme.onPrimaryContainer)
                if (todayTotal > 0) {
                    LinearProgressIndicator(progress = { (todayTotal - todayCount).toFloat() / todayTotal },
                        modifier = Modifier.fillMaxWidth().height(4.dp), color = scheme.primary,
                        trackColor = scheme.onPrimaryContainer.copy(alpha = 0.12f))
                }
            }
        }
        val shortcuts = listOf(
            Triple("日程", Icons.Default.CalendarToday, Screen.Time.route),
            Triple("流程", Icons.Default.AccountTree, Screen.Workflows.route),
            Triple("全部任务", Icons.Default.Checklist, Screen.AllTasks.route),
        )
        Surface(
            modifier = Modifier.animateContentSize(animationSpec = TaskDockMotion.springSpatial()),
            shape = TaskDockShapes.Large,
            color = scheme.surfaceContainerLow,
        ) {
            if (largeText) {
                Column(Modifier.fillMaxWidth()) {
                    shortcuts.forEach { (label, icon, route) ->
                        QuietShortcut(label, icon, { onNavigate(route) }, Modifier.fillMaxWidth())
                    }
                }
            } else {
                Row(Modifier.fillMaxWidth()) {
                    shortcuts.forEach { (label, icon, route) ->
                        QuietShortcut(label, icon, { onNavigate(route) }, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun QuietShortcut(label: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier) {
    Surface(onClick = onClick, modifier = modifier, shape = TaskDockShapes.Large, color = Color.Transparent) {
        Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(4.dp))
            Text(label, style = MaterialTheme.typography.labelLarge)
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
            .padding(start = 18.dp, top = 8.dp, end = 14.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "我的目录",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = "$folderCount 个目录 · $rootTaskCount 条任务",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        FilledTonalButton(
            onClick = onCreateFolder,
            shape = TaskDockShapes.FullPill,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
            modifier = Modifier.heightIn(min = 48.dp),
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

internal data class TreeRow(
    val kind: String,
    val id: String,
    val folder: FolderEntity? = null,
    val task: TaskEntity? = null,
    val status: TaskStatus,
    val version: Long,
    val rank: String,
    val taskCount: Int = 0,
)

/**
 * The group a row is drawn in. A task the user just re-statused keeps the
 * status the directory was loaded with, so it only changes group on the next
 * visit (the web directory pins rows the same way).
 */
internal fun treeGroupingStatus(row: TreeRow, groupPins: Map<String, TaskStatus>): TaskStatus =
    if (row.kind == "FOLDER") row.status else groupPins[row.id] ?: row.status

/**
 * Rows in draw order: default grouping by status then rank, unless an order
 * lock taken before a status edit is still holding the previous slots. Rows
 * that appeared after the lock are appended rather than dropped.
 */
internal fun resolveTreeRows(
    baseRows: List<TreeRow>,
    groupPins: Map<String, TaskStatus>,
    orderLock: List<String>?,
): List<TreeRow> {
    fun rowKey(row: TreeRow) = "${row.kind}:${row.id}"
    val defaultRows = baseRows.sortedWith(
        compareBy<TreeRow>(
            { statusOrder(treeGroupingStatus(it, groupPins)) },
            { it.rank.toLongOrNull() ?: 0L },
            { if (it.kind == "FOLDER") 0 else 1 },
            { it.id },
        )
    )
    if (orderLock == null) return defaultRows
    val lockIndex = orderLock.withIndex().associate { (index, key) -> key to index }
    val held = baseRows
        .filter { rowKey(it) in lockIndex }
        .sortedBy { lockIndex[rowKey(it)] ?: Int.MAX_VALUE }
    val added = defaultRows.filter { rowKey(it) !in lockIndex }
    return held + added
}

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
    return folderRows + taskRows
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
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    val activeTasks = tasks.filter { it.archivedAt == null && it.deletedAt == null }
    val normalizedQuery = query.trim()
    val visible = activeTasks.filter {
        it.deletedAt == null &&
            it.archivedAt == null &&
            (filter == null || it.status.name == filter) &&
            (it.title.contains(normalizedQuery, ignoreCase = true) ||
                it.referenceId?.contains(normalizedQuery, ignoreCase = true) == true)
    }

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("全部任务", fontWeight = FontWeight.Medium) },
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
                    .animateContentSize(animationSpec = TaskDockMotion.springSpatial())
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
                        label = { Text("搜索任务") },
                        placeholder = { Text("标题或引用编号") },
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
                        modifier = Modifier.fillMaxWidth().testTag("all-task-search"),
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
                            label = { Text("全部 (${activeTasks.size})") },
                            shape = TaskDockShapes.FullPill,
                        )
                        TaskStatus.entries.forEach { status ->
                            val count = activeTasks.count { it.status == status }
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

            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = viewModel::pullRefresh,
                modifier = Modifier
                    .weight(1f)
                    .imePadding(),
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .testTag("all-tasks-list"),
                    state = listState,
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    itemsIndexed(visible, key = { _, task -> task.id }) { index, task ->
                        ExpressiveTaskCard(
                            task = task,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                            showStatus = filter == null,
                            rowShape = TaskDockShapes.groupedRow(index, visible.size),
                            modifier = Modifier
                                .animateItem()
                                .testTag("all-task-${task.id}"),
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
