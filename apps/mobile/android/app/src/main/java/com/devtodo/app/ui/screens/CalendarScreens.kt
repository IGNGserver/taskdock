@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.devtodo.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.PlacementEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType
import com.devtodo.app.ui.components.EmptyState
import com.devtodo.app.ui.components.ExpressiveTaskCard
import com.devtodo.app.ui.components.RowAction
import com.devtodo.app.ui.components.SectionHeading
import com.devtodo.app.ui.components.TaskCaptureIsland
import com.devtodo.app.ui.components.WorkspaceScaffold
import com.devtodo.app.ui.components.folderPath
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Monthly calendar entry point. Dates remain local-date strings and never become instants. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    viewModel: MainViewModel,
    onNavigateToDay: (String) -> Unit,
    onNavigateToEvents: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    val timezone = settings?.timezone ?: "Asia/Shanghai"
    val today = currentLocalDate(timezone)
    val todayParts = remember(today) { localDateParts(today) }
    var year by rememberSaveable { mutableIntStateOf(todayParts.first) }
    var month by rememberSaveable { mutableIntStateOf(todayParts.second) }
    val rangeStart = String.format(Locale.US, "%04d-%02d-01", year, month)
    val rangeEnd = String.format(Locale.US, "%04d-%02d-31", year, month)
    val points by remember(rangeStart, rangeEnd) { viewModel.observeMonthPoints(rangeStart, rangeEnd) }
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val monthCounts by remember(rangeStart, rangeEnd) { viewModel.observeMonthCounts(rangeStart, rangeEnd) }
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val events by viewModel.activeEvents.collectAsStateWithLifecycle()
    val weekStartsOn = settings?.weekStartsOn ?: 1
    val datePoints = remember(points) {
        points.filter { it.type == TimePointType.DATE && it.localDate != null }
            .associateBy { it.localDate!! }
    }
    val countByDate = remember(monthCounts) { monthCounts.associate { it.localDate to it.total } }
    val cells = remember(year, month, weekStartsOn) { monthCells(year, month, weekStartsOn) }

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("日历") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回目录")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onNavigateToEvents) {
                        Icon(Icons.Default.Event, "事件")
                    }
                },
            )
        },
        bottomBar = {
            TaskCaptureIsland(
                viewModel = viewModel,
                initialDate = today,
                primaryLabel = "记一件事",
                useCapturePreference = true,
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag("calendar-month"),
                contentPadding = PaddingValues(bottom = 28.dp),
            ) {
                item(key = "calendar-controls") {
                    CalendarMonthHeader(
                        year = year,
                        month = month,
                        onPrevious = {
                            if (month == Calendar.JANUARY) {
                                month = Calendar.DECEMBER
                                year -= 1
                            } else month -= 1
                        },
                        onNext = {
                            if (month == Calendar.DECEMBER) {
                                month = Calendar.JANUARY
                                year += 1
                            } else month += 1
                        },
                        onToday = {
                            year = todayParts.first
                            month = todayParts.second
                        },
                    )
                }
                item(key = "calendar-weekdays") {
                    WeekdayHeader(weekStartsOn)
                }
                item(key = "calendar-grid") {
                    CalendarGrid(
                        cells = cells,
                        currentMonth = month,
                        today = today,
                        countByDate = countByDate,
                        onDateClick = onNavigateToDay,
                    )
                }
                item(key = "calendar-events-link") {
                    Surface(
                        onClick = onNavigateToEvents,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        shape = TaskDockShapes.Large,
                        color = MaterialTheme.colorScheme.tertiaryContainer,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Default.EventAvailable, null)
                            Column(Modifier.weight(1f)) {
                                Text("事件", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text(
                                    if (events.isEmpty()) "创建事件并为它安排任务" else "${events.size} 个事件 · 查看事件安排",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                                )
                            }
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, "打开事件")
                        }
                    }
                }
                if (datePoints.isEmpty()) {
                    item(key = "calendar-empty") {
                        EmptyState(
                            icon = Icons.Default.CalendarMonth,
                            title = "这个月还没有日期安排",
                            description = "点击任意日期查看当天安排，或从底部记下一件事。",
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CalendarMonthHeader(
    year: Int,
    month: Int,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("${year}年${month + 1}月", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("点击日期查看当天安排", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = onToday) { Icon(Icons.Default.CalendarToday, "回到今天") }
        IconButton(onClick = onPrevious) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "上个月") }
        IconButton(onClick = onNext) { Icon(Icons.AutoMirrored.Filled.ArrowForward, "下个月") }
    }
}

@Composable
private fun WeekdayHeader(weekStartsOn: Int) {
    val labels = remember(weekStartsOn) { weekdayLabels(weekStartsOn) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        labels.forEach { label ->
            Text(
                text = label,
                modifier = Modifier.weight(1f).padding(vertical = 8.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun CalendarGrid(
    cells: List<CalendarCell>,
    currentMonth: Int,
    today: String,
    countByDate: Map<String, Int>,
    onDateClick: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        cells.chunked(7).forEachIndexed { rowIndex, row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.forEachIndexed { columnIndex, cell ->
                    CalendarDayCell(
                        cell = cell,
                        currentMonth = currentMonth,
                        today = today,
                        count = cell.localDate?.let { countByDate[it] ?: 0 } ?: 0,
                        modifier = Modifier.weight(1f).testTag(cell.localDate?.let { "calendar-day-$it" } ?: "calendar-day-empty-$rowIndex-$columnIndex"),
                        onClick = { cell.localDate?.let(onDateClick) },
                    )
                }
            }
        }
    }
}

@Composable
private fun CalendarDayCell(
    cell: CalendarCell,
    currentMonth: Int,
    today: String,
    count: Int,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val date = cell.localDate
    val isToday = date == today
    val isCurrentMonth = cell.month == currentMonth
    Surface(
        onClick = onClick,
        enabled = date != null,
        modifier = modifier.heightIn(min = 64.dp),
        shape = TaskDockShapes.Medium,
        color = when {
            isToday -> MaterialTheme.colorScheme.primaryContainer
            isCurrentMonth -> MaterialTheme.colorScheme.surfaceContainerLow
            else -> MaterialTheme.colorScheme.surfaceContainerLowest
        },
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = cell.day?.toString().orEmpty(),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                color = if (isCurrentMonth) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
            )
            if (count > 0) {
                Surface(shape = TaskDockShapes.FullPill, color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary) {
                    Text(
                        text = count.toString(),
                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isToday) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSecondary,
                    )
                }
            } else {
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DayScheduleScreen(
    localDate: String,
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: (String?, String?) -> Unit,
    onNavigateToEvents: () -> Unit,
    onBack: () -> Unit,
) {
    val points by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val placements by viewModel.activeTimePointPlacements.collectAsStateWithLifecycle()
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    val point = points.firstOrNull { it.type == TimePointType.DATE && it.localDate == localDate }
    val taskById = remember(tasks) { tasks.associateBy { it.id } }
    val scheduled = remember(point, placements, taskById) {
        placements.filter { it.timePointId == point?.id }.mapNotNull { placement ->
            taskById[placement.taskId]?.takeIf { it.deletedAt == null && it.archivedAt == null }?.let { it to placement }
        }
    }
    var pickerPointId by rememberSaveable { mutableStateOf<String?>(null) }
    var showPicker by rememberSaveable { mutableStateOf(false) }
    var targetPlacement by remember { mutableStateOf<PlacementEntity?>(null) }
    var targetCopy by rememberSaveable { mutableStateOf(false) }
    val timezone = settings?.timezone ?: "Asia/Shanghai"

    fun openPicker() {
        if (point != null) {
            pickerPointId = point.id
            showPicker = true
        } else {
            viewModel.ensureDatePoint(localDate) { id ->
                if (id != null) {
                    pickerPointId = id
                    showPicker = true
                }
            }
        }
    }

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text(formatLocalDate(localDate, timezone)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回日历") } },
                actions = {
                    IconButton(onClick = onNavigateToEvents) { Icon(Icons.Default.Event, "事件") }
                    IconButton(onClick = ::openPicker) { Icon(Icons.Default.Add, "从已有任务安排") }
                },
            )
        },
        bottomBar = {
            TaskCaptureIsland(viewModel = viewModel, initialDate = localDate, primaryLabel = "记一件事")
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag("day-schedule-$localDate"),
                contentPadding = PaddingValues(bottom = 28.dp),
            ) {
                item(key = "day-summary") {
                    DaySummaryCard(localDate, scheduled.size, timezone, ::openPicker)
                }
                if (scheduled.isEmpty()) {
                    item(key = "day-empty") {
                        EmptyState(
                            icon = Icons.Default.CalendarToday,
                            title = "这一天还没有安排",
                            description = "记下一件事，或从已有任务中选择。",
                            action = {
                                FilledTonalButton(onClick = ::openPicker, shape = TaskDockShapes.FullPill) {
                                    Icon(Icons.Default.Add, null)
                                    Spacer(Modifier.width(8.dp))
                                    Text("添加已有任务")
                                }
                            },
                        )
                    }
                } else {
                    item(key = "day-heading") { SectionHeading("当天安排 · ${scheduled.size}") }
                    itemsIndexed(scheduled, key = { _, pair -> pair.second.id }) { index, (task, placement) ->
                        ExpressiveTaskCard(
                            task = task,
                            onClick = { onNavigateToDetail(task.id) },
                            onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                            projectName = folderPath(task.parentFolderId, folders),
                            actions = listOf(
                                RowAction("移动到其他位置") {
                                    targetPlacement = placement
                                    targetCopy = false
                                },
                                RowAction("复制到其他位置") {
                                    targetPlacement = placement
                                    targetCopy = true
                                },
                                RowAction("从当天移除", destructive = true) { viewModel.removePlacement(placement) },
                                RowAction("在目录中定位") { onNavigateToTree(task.parentFolderId, task.id) },
                            ),
                            rowShape = TaskDockShapes.groupedRow(index, scheduled.size),
                            modifier = Modifier.animateItem(),
                        )
                        PlacementOrderButtons(
                            canMoveUp = index > 0,
                            canMoveDown = index < scheduled.lastIndex,
                            onMoveUp = {
                                viewModel.reorderPlacements(point!!.id, scheduled.map { it.second.id }.moveItem(index, index - 1))
                            },
                            onMoveDown = {
                                viewModel.reorderPlacements(point!!.id, scheduled.map { it.second.id }.moveItem(index, index + 1))
                            },
                        )
                    }
                }
            }
        }
    }

    if (showPicker && pickerPointId != null) {
        TaskPickerDialog(
            title = "添加到当天安排",
            tasks = tasks.filter {
                it.archivedAt == null && it.deletedAt == null && scheduled.none { item -> item.first.id == it.id }
            },
            onDismiss = { showPicker = false },
            onConfirm = { ids ->
                viewModel.addTasksToTimePoint(pickerPointId!!, ids) { success ->
                    if (success) showPicker = false
                }
            },
        )
    }
    targetPlacement?.let { placement ->
        PlacementTargetDialog(
            placement = placement,
            copy = targetCopy,
            excludeTimePointId = point?.id,
            viewModel = viewModel,
            onDismiss = { targetPlacement = null },
        )
    }
}

@Composable
private fun DaySummaryCard(localDate: String, count: Int, timezone: String, onAdd: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        shape = TaskDockShapes.HeroShape,
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(formatLocalDate(localDate, timezone), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(if (count == 0) "还没有任务安排" else "$count 个任务安排", color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
            FilledTonalButton(onClick = onAdd, shape = TaskDockShapes.FullPill) {
                Icon(Icons.Default.Add, null)
                Spacer(Modifier.width(6.dp))
                Text("添加")
            }
        }
    }
}

@Composable
fun EventsScreen(
    viewModel: MainViewModel,
    onNavigateToEvent: (String) -> Unit,
    onBack: () -> Unit,
) {
    val events by viewModel.activeEvents.collectAsStateWithLifecycle()
    val placements by viewModel.activeTimePointPlacements.collectAsStateWithLifecycle()
    val refreshing by viewModel.pullRefreshing.collectAsStateWithLifecycle()
    var showCreate by rememberSaveable { mutableStateOf(false) }

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("事件") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回日历") } },
                actions = { IconButton(onClick = { showCreate = true }) { Icon(Icons.Default.Add, "创建事件") } },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showCreate = true },
                icon = { Icon(Icons.Default.Add, null) },
                text = { Text("创建事件") },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag("events-list"),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                item(key = "events-intro") {
                    Text(
                        "事件是可重复使用的里程碑位置；任务本体不会因为事件删除而消失。",
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (events.isEmpty()) {
                    item(key = "events-empty") {
                        EmptyState(
                            icon = Icons.Default.Event,
                            title = "还没有事件",
                            description = "创建一个里程碑，再把已有任务加入其中。",
                            action = {
                                FilledTonalButton(onClick = { showCreate = true }, shape = TaskDockShapes.FullPill) {
                                    Icon(Icons.Default.Add, null)
                                    Spacer(Modifier.width(8.dp))
                                    Text("创建事件")
                                }
                            },
                        )
                    }
                } else {
                    item(key = "events-heading") { SectionHeading("事件列表 · ${events.size}") }
                    itemsIndexed(events, key = { _, event -> event.id }) { index, event ->
                        EventListRow(
                            event = event,
                            count = placements.count { it.timePointId == event.id },
                            onClick = { onNavigateToEvent(event.id) },
                        )
                        PlacementOrderButtons(
                            canMoveUp = index > 0,
                            canMoveDown = index < events.lastIndex,
                            onMoveUp = { viewModel.reorderEvents(events.map { it.id }.moveItem(index, index - 1)) },
                            onMoveDown = { viewModel.reorderEvents(events.map { it.id }.moveItem(index, index + 1)) },
                        )
                    }
                }
            }
        }
    }

    if (showCreate) {
        EventNameDialog(
            title = "创建事件",
            initialValue = "",
            confirmLabel = "创建",
            onDismiss = { showCreate = false },
            onConfirm = { name -> viewModel.createEvent(name) { id -> if (id != null) showCreate = false } },
        )
    }
}

@Composable
private fun EventListRow(event: TimePointEntity, count: Int, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        shape = TaskDockShapes.Large,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 10.dp, top = 13.dp, bottom = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = TaskDockShapes.Medium, color = MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(Icons.Default.Event, null, Modifier.padding(10.dp), tint = MaterialTheme.colorScheme.onTertiaryContainer)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(event.title?.ifBlank { "未命名事件" } ?: "未命名事件", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    if (event.reachedAt != null) "已到达 · $count 个安排" else "未到达 · $count 个安排",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(Icons.AutoMirrored.Filled.ArrowForward, "打开事件")
        }
    }
}

@Composable
fun EventDetailScreen(
    eventId: String,
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: (String?, String?) -> Unit,
    onBack: () -> Unit,
) {
    val events by viewModel.activeEvents.collectAsStateWithLifecycle()
    val placements by viewModel.activeTimePointPlacements.collectAsStateWithLifecycle()
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val event = events.firstOrNull { it.id == eventId }
    val taskById = remember(tasks) { tasks.associateBy { it.id } }
    val scheduled = remember(event, placements, taskById) {
        placements.filter { it.timePointId == event?.id }.mapNotNull { placement ->
            taskById[placement.taskId]?.takeIf { it.deletedAt == null && it.archivedAt == null }?.let { it to placement }
        }
    }
    val timezone = settings?.timezone ?: "Asia/Shanghai"
    var showPicker by rememberSaveable { mutableStateOf(false) }
    var showEdit by rememberSaveable { mutableStateOf(false) }
    var showDelete by rememberSaveable { mutableStateOf(false) }
    var targetPlacement by remember { mutableStateOf<PlacementEntity?>(null) }
    var targetCopy by rememberSaveable { mutableStateOf(false) }

    if (event == null) {
        WorkspaceScaffold(
            topBar = { TopAppBar(title = { Text("事件详情") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                EmptyState(Icons.Default.Event, "事件不存在", "它可能已被删除或尚未同步。")
            }
        }
        return
    }

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text(event.title ?: "事件详情", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回事件列表") } },
                actions = {
                    IconButton(onClick = { showEdit = true }) { Icon(Icons.Default.Edit, "编辑事件") }
                    IconButton(onClick = { showDelete = true }) { Icon(Icons.Default.Delete, "删除事件") }
                },
            )
        },
        bottomBar = {
            TaskCaptureIsland(
                viewModel = viewModel,
                eventId = event.id,
                eventTitle = event.title,
                primaryLabel = "在事件中记一件事",
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).testTag("event-detail-${event.id}"),
            contentPadding = PaddingValues(bottom = 28.dp),
        ) {
            item(key = "event-summary") {
                EventSummaryCard(
                    event = event,
                    count = scheduled.size,
                    onReach = { viewModel.reachEvent(event) },
                    onAdd = { showPicker = true },
                )
            }
            if (scheduled.isEmpty()) {
                item(key = "event-empty") {
                    EmptyState(
                        icon = Icons.Default.Event,
                        title = "事件中还没有任务",
                        description = "从已有任务中挑选，或用底部按钮新建任务。",
                        action = {
                            FilledTonalButton(onClick = { showPicker = true }, shape = TaskDockShapes.FullPill) {
                                Icon(Icons.Default.Add, null)
                                Spacer(Modifier.width(8.dp))
                                Text("添加已有任务")
                            }
                        },
                    )
                }
            } else {
                item(key = "event-heading") { SectionHeading("事件安排 · ${scheduled.size}") }
                itemsIndexed(scheduled, key = { _, pair -> pair.second.id }) { index, (task, placement) ->
                    ExpressiveTaskCard(
                        task = task,
                        onClick = { onNavigateToDetail(task.id) },
                        onStatusToggle = { viewModel.updateTaskStatus(task, it) },
                        projectName = folderPath(task.parentFolderId, folders),
                        actions = listOf(
                            RowAction("移动到其他位置") {
                                targetPlacement = placement
                                targetCopy = false
                            },
                            RowAction("复制到其他位置") {
                                targetPlacement = placement
                                targetCopy = true
                            },
                            RowAction("从事件移除", destructive = true) { viewModel.removePlacement(placement) },
                            RowAction("在目录中定位") { onNavigateToTree(task.parentFolderId, task.id) },
                        ),
                        rowShape = TaskDockShapes.groupedRow(index, scheduled.size),
                        modifier = Modifier.animateItem(),
                    )
                    PlacementOrderButtons(
                        canMoveUp = index > 0,
                        canMoveDown = index < scheduled.lastIndex,
                        onMoveUp = { viewModel.reorderPlacements(event.id, scheduled.map { it.second.id }.moveItem(index, index - 1)) },
                        onMoveDown = { viewModel.reorderPlacements(event.id, scheduled.map { it.second.id }.moveItem(index, index + 1)) },
                    )
                }
            }
        }
    }

    if (showPicker) {
        TaskPickerDialog(
            title = "添加到事件",
            tasks = tasks.filter {
                it.archivedAt == null && it.deletedAt == null && scheduled.none { item -> item.first.id == it.id }
            },
            onDismiss = { showPicker = false },
            onConfirm = { ids ->
                viewModel.addTasksToTimePoint(event.id, ids) { success ->
                    if (success) showPicker = false
                }
            },
        )
    }
    if (showEdit) {
        EventNameDialog(
            title = "编辑事件",
            initialValue = event.title.orEmpty(),
            confirmLabel = "保存",
            onDismiss = { showEdit = false },
            onConfirm = { name -> viewModel.updateEvent(event, name) { success -> if (success) showEdit = false } },
        )
    }
    if (showDelete) {
        AlertDialog(
            onDismissRequest = { showDelete = false },
            icon = { Icon(Icons.Default.Delete, null) },
            title = { Text("删除事件？") },
            text = { Text("事件中的安排会被移除，但任务本体会保留在目录中。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteEvent(event) { success ->
                            if (success) {
                                showDelete = false
                                onBack()
                            }
                        }
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { showDelete = false }) { Text("取消") } },
        )
    }
    targetPlacement?.let { placement ->
        PlacementTargetDialog(
            placement = placement,
            copy = targetCopy,
            excludeTimePointId = event.id,
            viewModel = viewModel,
            onDismiss = { targetPlacement = null },
        )
    }
}

@Composable
private fun EventSummaryCard(event: TimePointEntity, count: Int, onReach: () -> Unit, onAdd: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        shape = TaskDockShapes.HeroShape,
        color = MaterialTheme.colorScheme.tertiaryContainer,
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(event.title ?: "未命名事件", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    Text(if (event.reachedAt == null) "未到达 · $count 个安排" else "已到达 · $count 个安排", color = MaterialTheme.colorScheme.onTertiaryContainer)
                }
                Icon(Icons.Default.Event, null, tint = MaterialTheme.colorScheme.onTertiaryContainer)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (event.reachedAt == null) {
                    FilledTonalButton(onClick = onReach, shape = TaskDockShapes.FullPill) {
                        Icon(Icons.Default.Check, null)
                        Spacer(Modifier.width(6.dp))
                        Text("标记到达")
                    }
                }
                OutlinedButton(onClick = onAdd, shape = TaskDockShapes.FullPill) {
                    Icon(Icons.Default.Add, null)
                    Spacer(Modifier.width(6.dp))
                    Text("添加任务")
                }
            }
        }
    }
}

@Composable
private fun PlacementOrderButtons(
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 2.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        IconButton(onClick = onMoveUp, enabled = canMoveUp, modifier = Modifier.size(40.dp)) {
            Icon(Icons.Default.KeyboardArrowUp, "安排上移")
        }
        IconButton(onClick = onMoveDown, enabled = canMoveDown, modifier = Modifier.size(40.dp)) {
            Icon(Icons.Default.KeyboardArrowDown, "安排下移")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskPickerDialog(
    title: String,
    tasks: List<TaskEntity>,
    onDismiss: () -> Unit,
    onConfirm: (List<String>) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val selected = remember { mutableStateListOf<String>() }
    val visibleTasks = remember(tasks, query) {
        val normalized = query.trim()
        tasks.filter {
            normalized.isEmpty() ||
                it.title.contains(normalized, ignoreCase = true) ||
                it.referenceId?.contains(normalized, ignoreCase = true) == true
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (tasks.isEmpty()) {
                    Text("没有可添加的任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("搜索任务") },
                        trailingIcon = {
                            if (query.isNotEmpty()) {
                                IconButton(onClick = { query = "" }) {
                                    Icon(Icons.Default.Close, "清除搜索")
                                }
                            }
                        },
                    )
                    if (visibleTasks.isEmpty()) {
                        Text("没有匹配的任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        LazyColumn(Modifier.heightIn(max = 360.dp)) {
                            items(visibleTasks, key = { it.id }) { task ->
                                val checked = task.id in selected
                                Row(
                                    modifier = Modifier.fillMaxWidth().clickable {
                                        if (checked) selected.remove(task.id) else selected.add(task.id)
                                    }.padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Checkbox(checked = checked, onCheckedChange = null)
                                    Spacer(Modifier.width(8.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(task.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        if (task.status == TaskStatus.DONE) {
                                            Text("已完成", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(selected.toList()) }, enabled = selected.isNotEmpty(), shape = TaskDockShapes.FullPill) {
                Text("添加 ${selected.size} 项")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EventNameDialog(
    title: String,
    initialValue: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var value by rememberSaveable(title, initialValue) { mutableStateOf(initialValue) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("事件名称") },
                supportingText = { Text("最多 200 个字符") },
            )
        },
        confirmButton = {
            Button(onClick = { onConfirm(value) }, enabled = value.trim().isNotEmpty(), shape = TaskDockShapes.FullPill) {
                Text(confirmLabel)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlacementTargetDialog(
    placement: PlacementEntity,
    copy: Boolean,
    excludeTimePointId: String?,
    viewModel: MainViewModel,
    onDismiss: () -> Unit,
) {
    val points by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val timezone = settings?.timezone ?: "Asia/Shanghai"
    val events = points.filter { it.type == TimePointType.EVENT && it.id != excludeTimePointId }
    var mode by rememberSaveable { mutableStateOf("DATE") }
    var date by rememberSaveable { mutableStateOf(currentLocalDate(timezone)) }
    var selectedEventId by rememberSaveable { mutableStateOf<String?>(null) }
    var showDatePicker by rememberSaveable { mutableStateOf(false) }
    var showCreateEvent by rememberSaveable { mutableStateOf(false) }
    val picker = rememberDatePickerState()
    val actionTitle = if (copy) "复制安排" else "移动安排"

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(actionTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = mode == "DATE", onClick = { mode = "DATE" }, label = { Text("日期") })
                    FilterChip(selected = mode == "EVENT", onClick = { mode = "EVENT" }, label = { Text("事件") })
                }
                if (mode == "DATE") {
                    OutlinedButton(onClick = { showDatePicker = true }, modifier = Modifier.fillMaxWidth(), shape = TaskDockShapes.FullPill) {
                        Icon(Icons.Default.CalendarToday, null)
                        Spacer(Modifier.width(8.dp))
                        Text(formatLocalDate(date, timezone))
                    }
                } else if (events.isEmpty()) {
                    Text("暂无其他事件，请先创建事件。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(
                        onClick = { showCreateEvent = true },
                        modifier = Modifier.fillMaxWidth(),
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Icon(Icons.Default.Add, null)
                        Spacer(Modifier.width(6.dp))
                        Text("新建事件")
                    }
                } else {
                    LazyColumn(Modifier.heightIn(max = 260.dp)) {
                        items(events, key = { it.id }) { event ->
                            val selected = selectedEventId == event.id
                            ListItem(
                                headlineContent = { Text(event.title ?: "未命名事件") },
                                supportingContent = { Text(if (event.reachedAt == null) "未到达" else "已到达") },
                                leadingContent = { RadioButton(selected = selected, onClick = { selectedEventId = event.id }) },
                                modifier = Modifier.clickable { selectedEventId = event.id },
                            )
                        }
                    }
                    OutlinedButton(
                        onClick = { showCreateEvent = true },
                        modifier = Modifier.fillMaxWidth(),
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Icon(Icons.Default.Add, null)
                        Spacer(Modifier.width(6.dp))
                        Text("新建事件")
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (mode == "DATE") viewModel.movePlacementToDate(placement, date, copy) { if (it) onDismiss() }
                    else selectedEventId?.let { id -> viewModel.movePlacementToTimePoint(placement, id, copy) { if (it) onDismiss() } }
                },
                enabled = mode == "DATE" || selectedEventId != null,
                shape = TaskDockShapes.FullPill,
            ) { Text(actionTitle) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    enabled = picker.selectedDateMillis != null,
                    onClick = {
                        picker.selectedDateMillis?.let {
                            date = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(it))
                        }
                        showDatePicker = false
                    },
                ) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("取消") } },
        ) { DatePicker(picker) }
    }
    if (showCreateEvent) {
        EventNameDialog(
            title = "创建目标事件",
            initialValue = "",
            confirmLabel = "创建",
            onDismiss = { showCreateEvent = false },
            onConfirm = { name ->
                viewModel.createEvent(name) { id ->
                    if (id != null) {
                        selectedEventId = id
                        mode = "EVENT"
                        showCreateEvent = false
                    }
                }
            },
        )
    }
}

private data class CalendarCell(
    val localDate: String?,
    val day: Int?,
    val month: Int,
)

private fun monthCells(year: Int, month: Int, weekStartsOn: Int): List<CalendarCell> {
    val first = Calendar.getInstance(Locale.ROOT).apply {
        clear()
        set(year, month, 1)
    }
    val firstDayOfWeek = if (weekStartsOn == 0) Calendar.SUNDAY else Calendar.MONDAY
    val offset = (first.get(Calendar.DAY_OF_WEEK) - firstDayOfWeek + 7) % 7
    val daysInMonth = first.getActualMaximum(Calendar.DAY_OF_MONTH)
    val total = ((offset + daysInMonth + 6) / 7) * 7
    return (0 until total).map { index ->
        val dayIndex = index - offset + 1
        if (dayIndex !in 1..daysInMonth) {
            val adjacent = Calendar.getInstance(Locale.ROOT).apply {
                clear()
                set(year, month, 1)
                add(Calendar.DAY_OF_MONTH, dayIndex - 1)
            }
            CalendarCell(localDate = localDateString(adjacent), day = adjacent.get(Calendar.DAY_OF_MONTH), month = adjacent.get(Calendar.MONTH))
        } else {
            CalendarCell(
                localDate = "%04d-%02d-%02d".format(Locale.ROOT, year, month + 1, dayIndex),
                day = dayIndex,
                month = month,
            )
        }
    }
}

private fun weekdayLabels(weekStartsOn: Int): List<String> {
    val names = listOf("日", "一", "二", "三", "四", "五", "六")
    return if (weekStartsOn == 0) names else names.drop(1) + names.first()
}

private fun localDateParts(localDate: String): Pair<Int, Int> {
    val pieces = localDate.split('-')
    return (pieces.getOrNull(0)?.toIntOrNull() ?: 1970) to ((pieces.getOrNull(1)?.toIntOrNull() ?: 1) - 1)
}

private fun localDateString(calendar: Calendar): String =
    "%04d-%02d-%02d".format(
        Locale.ROOT,
        calendar.get(Calendar.YEAR),
        calendar.get(Calendar.MONTH) + 1,
        calendar.get(Calendar.DAY_OF_MONTH),
    )

private fun <T> List<T>.moveItem(from: Int, to: Int): List<T> {
    if (from !in indices || to !in indices) return this
    return toMutableList().also { items ->
        val item = items.removeAt(from)
        items.add(to, item)
    }
}
