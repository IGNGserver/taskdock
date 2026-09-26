package com.devtodo.app.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.*

/**
 * Material 3 Expressive Time & Schedule Screen.
 * Visual parity with Web Schedule / Placements, expressive date pills,
 * fluid task rows and bottom Floating Action Island for rapid planning.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: ((String) -> Unit)? = null,
    onNavigateToTree: ((String?, String?) -> Unit)? = null,
    onBack: (() -> Unit)? = null,
) {
    val points by viewModel.activeTimePoints.collectAsStateWithLifecycle()
    val placements by viewModel.activeTimePointPlacements.collectAsStateWithLifecycle()
    val tasks by viewModel.treeTasksV2.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val timezone = settings?.timezone ?: "Asia/Shanghai"

    val today = currentLocalDate(timezone)
    val taskById = remember(tasks) { tasks.associateBy { it.id } }
    val placementsByPoint = remember(placements) { placements.groupBy { it.timePointId } }
    val tasksByPoint = remember(points, taskById, placementsByPoint) {
        points.associate { point ->
            val visible = placementsByPoint[point.id].orEmpty().mapNotNull { placement ->
                taskById[placement.taskId]?.takeIf {
                    it.archivedAt == null && it.deletedAt == null
                }
            }
            point.id to visible
        }
    }
    val taskCountByPoint = remember(tasksByPoint) { tasksByPoint.mapValues { it.value.size } }
    val groups = remember(points, taskCountByPoint, today) {
        groupTimePoints(points, taskCountByPoint, today)
    }

    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedDate by rememberSaveable { mutableStateOf<String?>(null) }
    var datePicker by rememberSaveable { mutableStateOf(false) }
    var showOlderDates by rememberSaveable { mutableStateOf(false) }
    val dateState = rememberDatePickerState()
    val hasTodayPoint = groups.todayAndUpcoming.any { it.localDate == today }

    PredictiveBackContainer(
        enabled = onBack != null,
        onBack = { onBack?.invoke() },
    ) {
        WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("日程与安排", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回目录")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { datePicker = true }) {
                        Icon(Icons.Default.DateRange, "选择日期")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        },
        bottomBar = {
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                FloatingActionIsland(
                    onQuickCreate = { title ->
                        // Automatically schedule for today or picked date
                        viewModel.createTreeTaskV2AtTimePoint(
                            title,
                            selectedDate ?: today,
                            true,
                        )
                    },
                    placeholder = "在选定日期/今天安排任务…",
                    primaryLabel = "安排新任务",
                )
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .testTag("planner-timepoints"),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            if (!hasTodayPoint) {
                item(key = "today-prompt") {
                    TodayPlanningPrompt(timezone, today) { selectedDate = today }
                }
            }

            if (groups.todayAndUpcoming.isNotEmpty()) {
                item(key = "upcoming-heading") {
                    SectionHeading("今天与接下来")
                }
                timePointItems(
                    points = groups.todayAndUpcoming,
                    tasksByPoint = tasksByPoint,
                    timezone = timezone,
                    today = today,
                    onAdd = { selectedId = it.id },
                    onStatusToggle = { task, status -> viewModel.updateTaskStatus(task, status) },
                    onNavigateToDetail = { onNavigateToDetail?.invoke(it.id) },
                    onNavigateToTree = { task ->
                        onNavigateToTree?.invoke(task.parentFolderId, task.id)
                    },
                )
            }

            if (groups.pastWithTasks.isNotEmpty()) {
                item(key = "past-active-heading") {
                    SectionHeading("有任务的过往日期")
                }
                timePointItems(
                    points = groups.pastWithTasks,
                    tasksByPoint = tasksByPoint,
                    timezone = timezone,
                    today = today,
                    onAdd = { selectedId = it.id },
                    onStatusToggle = { task, status -> viewModel.updateTaskStatus(task, status) },
                    onNavigateToDetail = { onNavigateToDetail?.invoke(it.id) },
                    onNavigateToTree = { task ->
                        onNavigateToTree?.invoke(task.parentFolderId, task.id)
                    },
                )
            }

            if (groups.olderEmptyDates.isNotEmpty()) {
                item(key = "older-dates-heading") {
                    OlderDatesHeader(
                        count = groups.olderEmptyDates.size,
                        expanded = showOlderDates,
                        onToggle = { showOlderDates = !showOlderDates },
                    )
                }
                if (showOlderDates) {
                    timePointItems(
                        points = groups.olderEmptyDates,
                        tasksByPoint = tasksByPoint,
                        timezone = timezone,
                        today = today,
                        onAdd = { selectedId = it.id },
                        onStatusToggle = { task, status -> viewModel.updateTaskStatus(task, status) },
                        onNavigateToDetail = { onNavigateToDetail?.invoke(it.id) },
                        onNavigateToTree = { task ->
                            onNavigateToTree?.invoke(task.parentFolderId, task.id)
                        },
                    )
                }
            }

            if (groups.otherDates.isNotEmpty()) {
                item(key = "other-dates-heading") { SectionHeading("其他日期") }
                timePointItems(
                    points = groups.otherDates,
                    tasksByPoint = tasksByPoint,
                    timezone = timezone,
                    today = today,
                    onAdd = { selectedId = it.id },
                    onStatusToggle = { task, status -> viewModel.updateTaskStatus(task, status) },
                    onNavigateToDetail = { onNavigateToDetail?.invoke(it.id) },
                    onNavigateToTree = { task ->
                        onNavigateToTree?.invoke(task.parentFolderId, task.id)
                    },
                )
            }

            if (groups.events.isNotEmpty()) {
                item(key = "events-heading") { SectionHeading("事件里程碑") }
                timePointItems(
                    points = groups.events,
                    tasksByPoint = tasksByPoint,
                    timezone = timezone,
                    today = today,
                    onAdd = { selectedId = it.id },
                    onStatusToggle = { task, status -> viewModel.updateTaskStatus(task, status) },
                    onNavigateToDetail = { onNavigateToDetail?.invoke(it.id) },
                    onNavigateToTree = { task ->
                        onNavigateToTree?.invoke(task.parentFolderId, task.id)
                    },
                )
            }

            if (points.isEmpty()) {
                item(key = "time-empty-state") {
                    EmptyState(
                        icon = Icons.Default.CalendarToday,
                        title = "日程安排空空如也",
                        description = "选择右上角日期或通过底部操作安排任务。",
                        action = {
                            FilledTonalButton(
                                onClick = { datePicker = true },
                                shape = TaskDockShapes.FullPill,
                            ) {
                                Icon(Icons.Default.DateRange, null)
                                Spacer(Modifier.width(8.dp))
                                Text("选择日期")
                            }
                        }
                    )
                }
            }
        }
    }

    if (datePicker) {
        DatePickerDialog(
            onDismissRequest = { datePicker = false },
            confirmButton = {
                TextButton(
                    enabled = dateState.selectedDateMillis != null,
                    onClick = {
                        selectedDate = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
                            timeZone = TimeZone.getTimeZone("UTC")
                        }.format(Date(dateState.selectedDateMillis!!))
                        datePicker = false
                    },
                ) { Text("确认安排") }
            },
            dismissButton = { TextButton(onClick = { datePicker = false }) { Text("取消") } },
        ) { DatePicker(dateState) }
    }

    if (selectedId != null || selectedDate != null) {
        CaptureSheet(
            title = "在此日期添加任务",
            onDismiss = {
                selectedId = null
                selectedDate = null
            },
        ) {
            viewModel.createTreeTaskV2AtTimePoint(
                it,
                selectedDate ?: selectedId!!,
                selectedDate != null,
            )
        }
    }
    }
}

@Composable
private fun TodayPlanningPrompt(timezone: String, today: String, onAdd: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(TaskDockShapes.LargeIncreased)
            .clickable(onClick = onAdd),
        shape = TaskDockShapes.LargeIncreased,
        color = colors.primaryContainer,
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Surface(
                    shape = TaskDockShapes.Medium,
                    color = colors.primary,
                    modifier = Modifier.size(42.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Default.CalendarToday,
                            contentDescription = null,
                            tint = colors.onPrimary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "今天尚未安排任务",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = colors.onPrimaryContainer,
                    )
                    Text(
                        text = formatLocalDate(today, timezone),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onPrimaryContainer.copy(alpha = 0.8f),
                    )
                }
            }

            IconButton(onClick = onAdd) {
                Icon(Icons.Default.Add, "在今天安排任务", tint = colors.onPrimaryContainer)
            }
        }
    }
}

@Composable
private fun OlderDatesHeader(count: Int, expanded: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, top = 16.dp, end = 16.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "过往未安排日期 ($count)",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onToggle) {
            Text(if (expanded) "收起" else "查看全部")
        }
    }
}

private fun LazyListScope.timePointItems(
    points: List<TimePointEntity>,
    tasksByPoint: Map<String, List<TaskEntity>>,
    timezone: String,
    today: String,
    onAdd: (TimePointEntity) -> Unit,
    onStatusToggle: (TaskEntity, TaskStatus) -> Unit,
    onNavigateToDetail: (TaskEntity) -> Unit,
    onNavigateToTree: (TaskEntity) -> Unit,
) {
    points.forEach { point ->
        val tasks = tasksByPoint[point.id].orEmpty()
        item(key = "time-point:${point.id}") {
            TimePointRow(
                point = point,
                taskCount = tasks.size,
                timezone = timezone,
                today = today,
                onAdd = { onAdd(point) },
            )
        }
        items(tasks, key = { "${point.id}:task:${it.id}" }) { task ->
            ExpressiveTaskCard(
                task = task,
                onClick = { onNavigateToDetail(task) },
                onStatusToggle = { onStatusToggle(task, it) },
                actions = listOf(RowAction("在目录中定位") { onNavigateToTree(task) }),
            )
        }
    }
}

@Composable
private fun TimePointRow(
    point: TimePointEntity,
    taskCount: Int,
    timezone: String,
    today: String,
    onAdd: () -> Unit,
) {
    val isDate = point.type == TimePointType.DATE
    val isToday = isDate && point.localDate == today
    val title = when {
        isToday -> "今天"
        isDate -> formatLocalDate(point.localDate, timezone)
        else -> point.title?.takeIf(String::isNotBlank) ?: "未命名事件"
    }

    val subtitle = when {
        isDate && isToday -> if (taskCount == 0) "今天未安排" else "$taskCount 个安排任务"
        isDate && taskCount == 0 -> "暂无任务"
        isDate -> "$taskCount 个安排任务"
        point.reachedAt != null -> "已到达 · $taskCount 个任务"
        else -> "未到达 · $taskCount 个任务"
    }

    val colors = MaterialTheme.colorScheme
    val (iconBg, iconTint) = when {
        isToday -> colors.primaryContainer to colors.onPrimaryContainer
        !isDate -> colors.tertiaryContainer to colors.onTertiaryContainer
        else -> colors.secondaryContainer to colors.onSecondaryContainer
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        shape = TaskDockShapes.Large,
        color = if (isToday) colors.surfaceContainerHigh else colors.surfaceContainerLow,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                shape = TaskDockShapes.Small,
                color = iconBg,
                modifier = Modifier.size(36.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = if (isDate) Icons.Default.CalendarToday else Icons.Default.Event,
                        contentDescription = null,
                        tint = iconTint,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            Spacer(Modifier.width(12.dp))

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (isToday) FontWeight.Bold else FontWeight.SemiBold,
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                )
            }

            IconButton(onClick = onAdd) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = "安排任务",
                    tint = colors.onSurfaceVariant,
                )
            }
        }
    }
}
