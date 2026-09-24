package com.devtodo.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Today
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.heading
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
import com.devtodo.app.ui.navigation.Screen
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect

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
    val folders =
        allFolders.filter {
            it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
        }
    val tasks =
        allTasks.filter {
            it.parentFolderId == currentFolderId && it.archivedAt == null && it.deletedAt == null
        }
    val useInlineTaskAction =
        LocalDensity.current.fontScale >= 1.3f || LocalConfiguration.current.screenHeightDp < 480
    val listStateHolder = rememberSaveableStateHolder()
    var isFabExpanded by rememberSaveable { mutableStateOf(true) }
    var handledLocateRequest by rememberSaveable { mutableStateOf(0) }
    LaunchedEffect(locateRequest) {
        if (locateRequest > handledLocateRequest) {
            currentFolderId = initialFolderId
            handledLocateRequest = locateRequest
        }
    }
    BackHandler(currentFolderId != null) {
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

    WorkspaceScaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Text(
                            currentFolderId?.let { folderTitle(it, allFolders) } ?: "任务",
                            style = if (currentFolderId == null)
                                MaterialTheme.typography.headlineSmall
                            else MaterialTheme.typography.titleLarge,
                        )
                    },
                    navigationIcon = {
                        if (currentFolderId != null)
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
                        if (currentFolderId == null) {
                            IconButton(
                                onClick = onOpenSearch,
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) { Icon(Icons.Default.Search, "搜索全部任务") }
                            IconButton(
                                onClick = onOpenSettings,
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) { Icon(Icons.Default.Settings, "设置") }
                        } else {
                            IconButton(
                                onClick = { showFolderDialog = true },
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) { Icon(Icons.Default.CreateNewFolder, "新建文件夹") }
                        }
                        if (useInlineTaskAction && currentFolderId != null)
                            IconButton(
                                onClick = { showTaskDialog = true },
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) { Icon(Icons.Default.Add, "新建任务") }
                    },
                )
            }
        },
        bottomBar = {
            if (!useInlineTaskAction) {
                Box(
                Modifier.fillMaxWidth()
                        .windowInsetsPadding(WindowInsets.navigationBars)
                        .padding(vertical = 12.dp)
                        .testTag("tree-create-bar"),
                    contentAlignment = Alignment.Center,
                ) {
                    Crossfade(
                        targetState = isFabExpanded,
                        animationSpec = tween(140),
                        label = "treeCreateFab",
                        modifier = Modifier.testTag("tree-create-action"),
                    ) {
                        if (it) {
                            ExtendedFloatingActionButton(
                                onClick = { showTaskDialog = true },
                                icon = { Icon(Icons.Default.Add, null) },
                                text = { Text("新建任务") },
                            )
                        } else {
                            FloatingActionButton(onClick = { showTaskDialog = true }) {
                                Icon(Icons.Default.Add, "新建任务")
                            }
                        }
                    }
                }
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
            LaunchedEffect(listState) {
                snapshotFlow {
                    listState.firstVisibleItemIndex == 0 &&
                        listState.firstVisibleItemScrollOffset < 24
                }.collect { isFabExpanded = it }
            }
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).testTag("directory-tree-list"),
                state = listState,
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                if (currentFolderId == null) {
                    item(key = "directory-shortcuts") {
                        DirectoryShortcuts(
                            onNavigate = onNavigateToShortcut,
                        )
                    }
                    item(key = "directory-heading") {
                        DirectorySectionHeader(
                            folderCount = folders.size,
                            rootTaskCount = tasks.size,
                            onCreateFolder = { showFolderDialog = true },
                        )
                    }
                } else item(key = "directory-overview") {
                    DirectoryOverview(
                        folderCount = folders.size,
                        taskCount = tasks.size,
                        pendingCount = tasks.count { it.status != TaskStatus.DONE },
                    )
                }
                itemsIndexed(rows, key = { _, row -> "${row.kind}:${row.id}" }) { rowIndex, row ->
                    Column(Modifier.testTag("tree-row-${row.id}")) {
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
                        val startsStatusGroup = rowIndex == 0 || rows[rowIndex - 1].status != row.status
                        val endsStatusGroup = rowIndex == rows.lastIndex || rows[rowIndex + 1].status != row.status
                        if (currentFolderId != null && startsStatusGroup) {
                            SectionHeading("${taskStatusLabel(row.status)} · ${siblings.size}")
                        }
                        val startsContainer = if (currentFolderId == null) rowIndex == 0 else startsStatusGroup
                        val endsContainer = if (currentFolderId == null) rowIndex == rows.lastIndex else endsStatusGroup
                        val groupShape =
                            RoundedCornerShape(
                                topStart = if (startsContainer) 24.dp else 0.dp,
                                topEnd = if (startsContainer) 24.dp else 0.dp,
                                bottomEnd = if (endsContainer) 24.dp else 0.dp,
                                bottomStart = if (endsContainer) 24.dp else 0.dp,
                            )
                        Surface(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                            shape = groupShape,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                        ) {
                            Column {
                                if (row.folder != null) {
                                    val folder = row.folder
                                    val childFolderCount = allFolders.count {
                                        it.parentFolderId == folder.id &&
                                            it.archivedAt == null &&
                                            it.deletedAt == null
                                    }
                                    val (folderContainer, folderTint) = when (folder.title.hashCode().ushr(1) % 3) {
                                        0 -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
                                        1 -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
                                        else -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
                                    }
                                    ListItem(
                                        headlineContent = {
                                            Text(
                                                folder.title,
                                                maxLines = 2,
                                                overflow = TextOverflow.Ellipsis,
                                                style = MaterialTheme.typography.titleMedium,
                                                fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                                            )
                                        },
                                        supportingContent = {
                                            val folderHint =
                                                when {
                                                    row.taskCount == 0 && childFolderCount == 0 -> "空目录"
                                                    row.taskCount == 0 -> "$childFolderCount 个子目录"
                                                    row.status == TaskStatus.IN_PROGRESS -> "进行中 · ${row.taskCount} 个任务"
                                                    row.status == TaskStatus.DONE -> "全部完成 · ${row.taskCount} 个任务"
                                                    else -> "${row.taskCount} 个待处理任务"
                                                }
                                            Text(
                                                folderHint,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                style = MaterialTheme.typography.bodySmall,
                                            )
                                        },
                                        leadingContent = {
                                            Surface(
                                                shape = MaterialTheme.shapes.medium,
                                                color = folderContainer,
                                            ) {
                                                Icon(
                                                    Icons.Default.Folder,
                                                    null,
                                                    Modifier.padding(10.dp).size(22.dp),
                                                    tint = folderTint,
                                                )
                                            }
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
                                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                                    )
                                } else {
                                    val task = row.task!!
                                    M3TaskRow(
                                        task,
                                        onClick = { onNavigateToDetail(task.id) },
                                        onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                                        actions = actions,
                                        highlighted = task.id == highlightedTaskId,
                                        containerColorOverride = if (task.status == TaskStatus.DONE)
                                            MaterialTheme.colorScheme.surfaceContainerLow
                                        else Color.Transparent,
                                    )
                                }
                                if (!endsContainer) {
                                    HorizontalDivider(
                                        Modifier.padding(start = 72.dp, end = 16.dp),
                                        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .45f),
                                    )
                                }
                            }
                        }
                    }
                }
                if (rows.isEmpty())
                    item {
                        EmptyState(
                            Icons.Default.Folder,
                            if (currentFolderId == null) "还没有目录或任务" else "这个目录还是空的",
                            if (currentFolderId == null)
                                "先创建一个目录，或添加一条根任务。"
                            else "使用“新建文件夹”创建子目录，或新建一条任务。",
                            action = {
                                if (currentFolderId == null) {
                                    TextButton(onClick = { showFolderDialog = true }) {
                                        Icon(Icons.Default.CreateNewFolder, null)
                                        Spacer(Modifier.width(8.dp))
                                        Text("新建目录")
                                    }
                                }
                            },
                        )
                    }
                if (useInlineTaskAction) {
                    item(key = "inline-create-task") {
                        Button(
                            onClick = { showTaskDialog = true },
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)
                                .heightIn(min = 56.dp)
                                .testTag("tree-inline-create-task"),
                        ) {
                            Icon(Icons.Default.Add, null)
                            Spacer(Modifier.width(8.dp))
                            Text("新建任务")
                        }
                    }
                }
            }
        }
    }

    if (showFolderDialog)
        CaptureSheet("新建文件夹", "文件夹名称", onDismiss = { showFolderDialog = false }) {
            viewModel.createFolderV2(currentFolderId, it)
        }
    if (showTaskDialog)
        CaptureSheet("新建任务", onDismiss = { showTaskDialog = false }) {
            viewModel.createTreeTaskV2(currentFolderId, it)
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
    val visible =
        tasks.filter {
            it.deletedAt == null &&
                it.archivedAt == null &&
                (filter == null || it.status.name == filter) &&
                (it.title.contains(normalizedQuery, ignoreCase = true) ||
                    it.referenceId?.contains(normalizedQuery, ignoreCase = true) == true)
        }
    WorkspaceScaffold(
      topBar = {
        TopAppBar(
            title = { Text("全部任务") },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                }
            },
        )
      },
    ) { padding ->
      Column(Modifier.fillMaxSize().padding(padding)) {
        Surface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            Column(
                Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("搜索任务") },
                    supportingText = { Text("可搜索标题或参考编号") },
                    singleLine = true,
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = {
                        if (query.isNotEmpty()) {
                            IconButton(
                                onClick = { query = "" },
                                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                            ) { Icon(Icons.Default.Close, "清除搜索") }
                        }
                    },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
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
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when {
                    normalizedQuery.isNotEmpty() -> "搜索结果"
                    filter != null -> "${taskStatusLabel(TaskStatus.valueOf(filter!!))}任务"
                    else -> "任务列表"
                },
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text("${visible.size} 项", style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(
            Modifier.weight(1f).imePadding().testTag("all-tasks-list"),
            state = listState,
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            items(visible, key = { it.id }) { task ->
                M3TaskRow(
                    task,
                    onClick = { onNavigateToDetail(task.id) },
                    onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                    showStatus = filter == null,
                    modifier = Modifier.testTag("all-task-${task.id}"),
                )
            }
            if (visible.isEmpty()) {
                item {
                    when {
                        normalizedQuery.isNotEmpty() ->
                            EmptyState(Icons.Default.Search, "没有匹配的任务", "试试其他关键词或状态。")
                        filter != null ->
                            EmptyState(
                                Icons.Default.Search,
                                "当前筛选没有任务",
                                "切换到其他状态，或清除筛选条件。",
                            )
                        else ->
                            EmptyState(
                                Icons.Default.Folder,
                                "还没有任务",
                                "新建一条任务后，它会出现在这里。",
                            )
                    }
                }
            }
        }
      }
    }
}

@Composable
private fun DirectoryShortcuts(onNavigate: (String) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(
            "快捷视图",
            Modifier.padding(start = 8.dp, bottom = 8.dp)
                .semantics { heading() },
            style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurfaceVariant,
        )
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = scheme.surfaceContainerLow,
        ) {
            Column {
                QuickViewRow(
                    "今天", Icons.Default.Today, Screen.Today.route,
                    scheme.secondaryContainer, scheme.onSecondaryContainer, onNavigate,
                )
                HorizontalDivider(Modifier.padding(start = 72.dp, end = 16.dp), color = scheme.outlineVariant.copy(alpha = .45f))
                QuickViewRow(
                    "日程", Icons.Default.CalendarToday, Screen.Time.route,
                    scheme.primaryContainer, scheme.onPrimaryContainer, onNavigate,
                )
                HorizontalDivider(Modifier.padding(start = 72.dp, end = 16.dp), color = scheme.outlineVariant.copy(alpha = .45f))
                QuickViewRow(
                    "流程", Icons.Default.AccountTree, Screen.Workflows.route,
                    scheme.tertiaryContainer, scheme.onTertiaryContainer, onNavigate,
                )
                HorizontalDivider(Modifier.padding(start = 72.dp, end = 16.dp), color = scheme.outlineVariant.copy(alpha = .45f))
                QuickViewRow(
                    "全部任务", Icons.Default.Checklist, Screen.AllTasks.route,
                    scheme.secondaryContainer, scheme.onSecondaryContainer, onNavigate,
                )
            }
        }
    }
}

@Composable
private fun QuickViewRow(
    title: String,
    icon: ImageVector,
    route: String,
    iconContainer: Color,
    iconTint: Color,
    onNavigate: (String) -> Unit,
) {
    ListItem(
        headlineContent = { Text(title, style = MaterialTheme.typography.titleMedium) },
        leadingContent = {
            Surface(shape = MaterialTheme.shapes.medium, color = iconContainer) {
                Icon(
                    icon,
                    contentDescription = null,
                    modifier = Modifier.padding(10.dp).size(22.dp),
                    tint = iconTint,
                )
            }
        },
        trailingContent = {
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        },
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClickLabel = "打开$title") {
            onNavigate(route)
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
private fun DirectorySectionHeader(
    folderCount: Int,
    rootTaskCount: Int,
    onCreateFolder: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 24.dp, top = 20.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                "目录",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
            )
            Text(
                "$folderCount 个目录 · $rootTaskCount 条根任务",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onCreateFolder, modifier = Modifier.heightIn(min = 48.dp)) {
            Icon(Icons.Default.CreateNewFolder, contentDescription = null)
            Spacer(Modifier.width(8.dp))
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
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            Modifier.padding(horizontal = 18.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(
                    Icons.Default.Folder,
                    contentDescription = null,
                    modifier = Modifier.padding(12.dp).size(24.dp),
                    tint = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "当前目录",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                )
                Text(
                    "$folderCount 个子目录 · $taskCount 条任务 · $pendingCount 条未完成",
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
