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
import com.devtodo.app.ui.theme.LocalAdaptiveInfo
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

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
) {
    val allFolders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val aggregates by viewModel.folderAggregates.collectAsStateWithLifecycle()
    val loadProgress by viewModel.loadProgress.collectAsStateWithLifecycle()
    val directoryPages by viewModel.directoryPages.collectAsStateWithLifecycle()
    val pageLoads by viewModel.pageLoads.collectAsStateWithLifecycle()
    val directory = directoryPages["directory:${folderId ?: "root"}"]
    val pageLoad = pageLoads["directory:${folderId ?: "root"}"]
    val todayTasks by viewModel.todayTasks.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    LaunchedEffect(folderId) { viewModel.prioritizeDirectory(folderId) }

    val folders by remember(folderId) { viewModel.observeDirectoryFolders(folderId) }
        .collectAsStateWithLifecycle(initialValue = viewModel.cachedDirectoryFolders(folderId))

    // `groupPins` remembers the status a row was loaded with so it stays in its
    // group; `statusOverrides` is what the circle paints right now. Both mirror
    // the web directory (`groupPins` / `statusOverrides` in TreePage.tsx).
    val statusOverrides = remember { mutableStateMapOf<String, TaskStatus>() }
    val groupPins = remember { mutableStateMapOf<String, TaskStatus>() }
    var orderLock by remember { mutableStateOf<List<String>?>(null) }
    var cacheLimit by rememberSaveable(folderId) { mutableIntStateOf(100) }
    val pinned = statusOverrides.keys.toList()
    val tasks by remember(folderId, pinned, cacheLimit) { viewModel.observeDirectoryMembers(folderId, pinned, cacheLimit) }
        .collectAsStateWithLifecycle(initialValue = viewModel.cachedDirectoryMembers(folderId))
    val counts by remember(folderId) { viewModel.observeDirectoryCounts(folderId) }
        .collectAsStateWithLifecycle(
            initialValue = viewModel.cachedDirectoryCounts(folderId) ?: com.devtodo.app.data.local.DirectoryCounts(),
        )
    val visibleCounts = if (directory?.initialized == true)
        com.devtodo.app.data.local.DirectoryCounts(tasks.size, tasks.count { it.status == TaskStatus.DONE }) else counts

    fun groupingStatus(row: TreeRow): TaskStatus = treeGroupingStatus(row, groupPins)

    fun displayTask(row: TreeRow): TaskEntity? =
        row.task?.let { task -> statusOverrides[task.id]?.let { task.copy(status = it) } ?: task }

    fun releasePins() {
        statusOverrides.clear()
        groupPins.clear()
        orderLock = null
    }

    val baseRows = remember(folders, tasks, aggregates, directory, loadProgress.complete) {
        val serverAggregates = directory?.aggregates.orEmpty().mapValues { (_, value) ->
            TaskStatus.valueOf(value.status.name) to value.totalCount
        }
        buildTreeRows(folders, tasks, if (loadProgress.complete) serverAggregates + aggregates else aggregates + serverAggregates)
    }
    // While a status edit is pending the locked order wins, so a background sync
    // that follows the edit cannot slide the row to a new position. Rows that
    // appeared after the lock was taken are appended rather than dropped.
    val rows = remember(baseRows, orderLock, statusOverrides.toMap(), groupPins.toMap()) {
        resolveTreeRows(baseRows, groupPins, orderLock)
    }
    val enteredAt = remember(folderId) { System.nanoTime() }
    var firstContentRecorded by remember(folderId) { mutableStateOf(false) }
    LaunchedEffect(rows.isNotEmpty(), directory?.initialized) {
        if (!firstContentRecorded && (rows.isNotEmpty() || directory?.initialized == true)) {
            withFrameNanos { }
            firstContentRecorded = true
            android.util.Log.d("TaskDockSync", "frame=directory elapsedMs=${(System.nanoTime() - enteredAt) / 1_000_000} rows=${rows.size} networkPage=${directory?.initialized == true}")
        }
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
    var editingFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var pendingPreview by remember { mutableStateOf<DeletePreviewDto?>(null) }
    var pendingDeleteFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var pendingMoveRow by remember { mutableStateOf<TreeRow?>(null) }
    val adaptive = LocalAdaptiveInfo.current
    var inlineTaskId by rememberSaveable(folderId) { mutableStateOf<String?>(null) }
    val activeInlineTaskId = inlineTaskId?.takeIf { id -> rows.any { it.task?.id == id } }
    val scope = rememberCoroutineScope()

    // The scroll state must live in the destination's main composition, not in
    // the Scaffold content slot: Navigation Compose restores the former from
    // the back stack entry, while the latter is a subcomposition that can be
    // torn down before the destination state is saved.
    val listState = rememberLazyListState()
    var showCompleted by rememberSaveable { mutableStateOf(false) }
    var handledLocateRequest by rememberSaveable { mutableIntStateOf(0) }
    val latestRows by rememberUpdatedState(rows)

    // Consume every locate request once. A stale highlight must not pull the
    // list back to that row when the page is re-entered or Room re-emits.
    LaunchedEffect(highlightedTaskId, locateRequest, adaptive.useTwoPane) {
        if (locateRequest <= handledLocateRequest) return@LaunchedEffect
        val targetId = highlightedTaskId
        if (targetId.isNullOrBlank()) {
            handledLocateRequest = locateRequest
            return@LaunchedEffect
        }
        if (adaptive.useTwoPane) {
            inlineTaskId = targetId
            handledLocateRequest = locateRequest
            return@LaunchedEffect
        }
        val index = withTimeoutOrNull(3_000) {
            snapshotFlow { latestRows.indexOfFirst { it.id == targetId } }.first { it >= 0 }
        }
        handledLocateRequest = locateRequest
        if (index == null || index < 0) return@LaunchedEffect
        val row = latestRows.getOrNull(index) ?: return@LaunchedEffect
        if (row.task != null && groupingStatus(row) == TaskStatus.DONE) {
            showCompleted = true
            withFrameNanos { }
        }
        val headerItems =
            (if (folderId == null) 2 else 1) +
                (if (directory?.nextCursor != null) 1 else 0) +
                (if (directory?.initialized != true && counts.total > cacheLimit) 1 else 0)
        listState.animateScrollToItem(index + headerItems)
    }

    fun selectTask(taskId: String) {
        if (adaptive.useTwoPane) {
            inlineTaskId = taskId
        } else {
            onNavigateToDetail(taskId)
        }
    }

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
                            onClick = onOpenSettings,
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(Icons.Default.Settings, "设置", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        val currentFolder = allFolders.find { it.id == folderId }
                        if (currentFolder != null) {
                            IconButton(
                                onClick = { editingFolder = currentFolder },
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) {
                                Icon(Icons.Default.Edit, "重命名当前目录", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
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
        val visibleRows = rows.filter {
            it.folder != null || groupingStatus(it) != TaskStatus.DONE || showCompleted
        }
        val completedCount = counts.done

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            @Composable
            fun DirectoryListPane(modifier: Modifier = Modifier) {
                LazyColumn(
                    modifier = modifier
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
                                compactLandscape = adaptive.isCompactLandscape,
                            )
                        }

                        // Directory Section Header
                        item(key = "directory-heading") {
                            DirectorySectionHeader(
                                folderCount = folders.size,
                                rootTaskCount = visibleCounts.total,
                                onCreateFolder = { showFolderDialog = true },
                            )
                        }
                    } else {
                        item(key = "directory-overview") {
                            DirectoryOverview(
                                folderCount = folders.size,
                                taskCount = visibleCounts.total,
                                pendingCount = tasks.count { it.status != TaskStatus.DONE },
                            )
                        }
                    }

                    if (directory?.nextCursor != null) {
                        item(key = "load-directory-page") {
                            TextButton(onClick = { viewModel.loadMoreDirectory(folderId) },
                                enabled = pageLoad?.loading != true, modifier = Modifier.fillMaxWidth()) {
                                Text(if (pageLoad?.loading == true) "正在加载…" else if (pageLoad?.error != null) "加载失败，重试下一页" else "加载更多目录项")
                            }
                        }
                    }
                    if (directory?.initialized != true && counts.total > cacheLimit) {
                        item(key = "load-cached-directory-page") {
                            TextButton(onClick = { cacheLimit += 100 }, modifier = Modifier.fillMaxWidth()) {
                                Text("显示更多已缓存任务")
                            }
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
                                        actions = actions + listOf(
                                            RowAction("重命名") { editingFolder = folder },
                                            RowAction("删除目录树", destructive = true) {
                                                pendingDeleteFolder = folder
                                            },
                                        ),
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
                                        onClick = { selectTask(task.id) },
                                        onStatusToggle = { changeStatus(row, it) },
                                        actions = actions,
                                        showStatus = folderId == null,
                                        highlighted = task.id == highlightedTaskId || task.id == activeInlineTaskId,
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

                    if (rows.isEmpty() && directory?.initialized != true && !loadProgress.complete) {
                        item { Text(if (pageLoad?.error != null) "目录加载失败，已有缓存保留，可下拉重试。" else "正在加载目录数据…", Modifier.padding(16.dp)) }
                    } else if (rows.isEmpty()) {
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

            if (adaptive.useTwoPane) {
                AdaptiveTwoPaneLayout(
                    primaryPane = { DirectoryListPane() },
                    secondaryPane = {
                        if (activeInlineTaskId != null) {
                            key(activeInlineTaskId) {
                                TaskDetailScreen(
                                    taskId = activeInlineTaskId,
                                    viewModel = viewModel,
                                    onBack = { inlineTaskId = null },
                                    isEmbedded = true,
                                )
                            }
                        } else {
                            DirectoryDetailPlaceholder(
                                folderTitle = folderId?.let { folderTitle(it, allFolders) } ?: "根目录",
                                folderCount = folders.size,
                                taskCount = visibleCounts.total,
                                doneCount = visibleCounts.done,
                            )
                        }
                    },
                )
            } else {
                DirectoryListPane()
            }
        }
    }

    if (showFolderDialog) {
        CaptureSheet("新建文件夹", "文件夹名称", onDismiss = { showFolderDialog = false }) {
            releasePins()
            viewModel.createFolderV2(folderId, it)
        }
    }

    editingFolder?.let { folder ->
        CaptureSheet(
            title = "重命名文件夹",
            label = "文件夹名称",
            initialValue = folder.title,
            confirmLabel = "保存",
            onDismiss = { editingFolder = null },
        ) { newTitle ->
            releasePins()
            viewModel.updateFolderTitleV2(folder, newTitle) { success ->
                if (success) editingFolder = null
            }
        }
    }

    pendingDeleteFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { pendingDeleteFolder = null },
            title = { Text("删除目录树") },
            text = { Text("删除不会删除流程和事件，但会删除其中的任务及其依赖。请先在线预览并确认删除范围。") },
            confirmButton = {
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
    compactLandscape: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    val largeText = LocalDensity.current.fontScale >= 1.4f
    val completion = if (todayTotal == 0) "暂无安排" else "${todayTotal - todayCount} / $todayTotal 完成"
    val shortcuts = listOf(
        Triple("日历", Icons.Default.CalendarToday, Screen.Time.route),
        Triple("流程", Icons.Default.AccountTree, Screen.Workflows.route),
        Triple("事件", Icons.Default.Event, Screen.Events.route),
    )
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = if (compactLandscape) 4.dp else 8.dp),
        verticalArrangement = Arrangement.spacedBy(if (compactLandscape) 4.dp else 8.dp),
    ) {
        Text(
            "快捷视图",
            style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp).semantics { heading() },
        )
        if (compactLandscape && !largeText) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    onClick = { onNavigate(Screen.Today.route) },
                    modifier = Modifier.weight(1f),
                    shape = TaskDockShapes.Large,
                    color = scheme.primaryContainer,
                ) {
                    Row(
                        Modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("今天", style = MaterialTheme.typography.titleSmall, color = scheme.onPrimaryContainer)
                        Text(
                            "$todayCount 件待办",
                            style = MaterialTheme.typography.titleMedium,
                            color = scheme.onPrimaryContainer,
                            modifier = Modifier.weight(1f),
                        )
                        Text(completion, style = MaterialTheme.typography.labelSmall, color = scheme.onPrimaryContainer)
                    }
                }
                Surface(
                    modifier = Modifier.weight(1f),
                    shape = TaskDockShapes.Large,
                    color = scheme.surfaceContainerLow,
                ) {
                    Row(Modifier.fillMaxWidth()) {
                        shortcuts.forEach { (label, icon, route) ->
                            QuietShortcut(label, icon, { onNavigate(route) }, Modifier.weight(1f))
                        }
                    }
                }
            }
        } else {
            Surface(
                onClick = { onNavigate(Screen.Today.route) },
                shape = TaskDockShapes.LargeIncreased,
                color = scheme.primaryContainer,
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
}

@Composable
private fun DirectoryDetailPlaceholder(
    folderTitle: String,
    folderCount: Int,
    taskCount: Int,
    doneCount: Int,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .testTag("directory-detail-placeholder"),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                shape = TaskDockShapes.HeroShape,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
            ) {
                Icon(
                    imageVector = Icons.Default.FolderOpen,
                    contentDescription = null,
                    modifier = Modifier.padding(20.dp).size(28.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                text = folderTitle,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = "点击左侧任务即可在此处查看或编辑详情、子步骤与日程安排",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Surface(
                shape = TaskDockShapes.FullPill,
                color = MaterialTheme.colorScheme.surfaceContainerLow,
            ) {
                Text(
                    text = "$folderCount 个目录 · $taskCount 项任务 · $doneCount 项已完成",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                )
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
    aggregates: Map<String, Pair<TaskStatus, Int>>,
): List<TreeRow> {
    val folderRows =
        folders.map { folder ->
            val aggregate = aggregates[folder.id] ?: (TaskStatus.TODO to 0)
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
