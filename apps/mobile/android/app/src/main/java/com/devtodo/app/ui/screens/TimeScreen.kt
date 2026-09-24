package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TimePointType
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.components.CaptureSheet
import com.devtodo.app.ui.components.EmptyState
import com.devtodo.app.ui.components.M3TaskRow
import com.devtodo.app.ui.components.RowAction
import com.devtodo.app.ui.components.SectionHeading
import com.devtodo.app.ui.components.WorkspaceScaffold
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

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
    val useInlineDateAction =
        LocalDensity.current.fontScale >= 1.3f || LocalConfiguration.current.screenHeightDp < 480
    val today = currentLocalDate(timezone)
    val taskById = remember(tasks) { tasks.associateBy { it.id } }
    val placementsByPoint = remember(placements) { placements.groupBy { it.timePointId } }
    val tasksByPoint = remember(points, taskById, placementsByPoint) {
        points.associate { point ->
            val visible =
                placementsByPoint[point.id].orEmpty().mapNotNull { placement ->
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

    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("日程") },
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
            )
        },
        floatingActionButton = {
            if (!useInlineDateAction) {
                ExtendedFloatingActionButton(
                    onClick = { datePicker = true },
                    icon = { Icon(Icons.Default.Add, null) },
                    text = { Text("选择日期") },
                )
            }
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).testTag("planner-timepoints"),
            contentPadding = PaddingValues(bottom = 120.dp),
        ) {
            if (!hasTodayPoint) {
                item(key = "today-prompt") {
                    TodayPlanningPrompt(timezone, today) { selectedDate = today }
                }
            }

            if (useInlineDateAction) {
                item(key = "inline-planner-action") {
                    Button(
                        onClick = { datePicker = true },
                        modifier =
                            Modifier.fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp)
                                .sizeIn(minHeight = 56.dp),
                    ) {
                        Icon(Icons.Default.Add, null)
                        Spacer(Modifier.width(8.dp))
                        Text("选择日期安排")
                    }
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
                item(key = "events-heading") { SectionHeading("事件") }
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
                        Icons.Default.CalendarToday,
                        "还没有日期或事件",
                        "先选择日期安排任务；已有事件会在同步后显示。",
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
                        selectedDate =
                            SimpleDateFormat("yyyy-MM-dd", Locale.ROOT)
                                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                                .format(Date(dateState.selectedDateMillis!!))
                        datePicker = false
                    },
                ) { Text("选择日期") }
            },
            dismissButton = { TextButton(onClick = { datePicker = false }) { Text("取消") } },
        ) { DatePicker(dateState) }
    }

    if (selectedId != null || selectedDate != null) {
        CaptureSheet(
            "新建安排",
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

@Composable
private fun TodayPlanningPrompt(timezone: String, today: String, onAdd: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        shape = MaterialTheme.shapes.extraLarge,
        color = colors.primaryContainer,
    ) {
        ListItem(
            headlineContent = {
                Text("今天", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            },
            supportingContent = {
                Text("${formatLocalDate(today, timezone)} · 今天还没有日期安排")
            },
            leadingContent = {
                Icon(Icons.Default.CalendarToday, null, tint = colors.onPrimaryContainer)
            },
            trailingContent = {
                IconButton(onClick = onAdd, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Default.Add, "在今天安排任务")
                }
            },
            colors =
                ListItemDefaults.colors(
                    containerColor = colors.primaryContainer,
                    headlineColor = colors.onPrimaryContainer,
                    supportingColor = colors.onPrimaryContainer,
                ),
        )
    }
}

@Composable
private fun OlderDatesHeader(count: Int, expanded: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, top = 16.dp, end = 12.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "更早的空日期 · $count",
            Modifier.weight(1f),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        TextButton(onClick = onToggle, modifier = Modifier.sizeIn(minHeight = 48.dp)) {
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
        item(key = "time-point:${point.id}") {
            TimePointRow(
                point = point,
                taskCount = tasksByPoint[point.id].orEmpty().size,
                timezone = timezone,
                today = today,
                onAdd = { onAdd(point) },
            )
        }
        items(tasksByPoint[point.id].orEmpty(), key = { "${point.id}:task:${it.id}" }) { task ->
            M3TaskRow(
                task,
                onClick = { onNavigateToDetail(task) },
                onStatusToggle = { onStatusToggle(task, it) },
                actions = listOf(RowAction("在目录中显示") { onNavigateToTree(task) }),
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
    val title =
        when {
            isToday -> "今天"
            isDate -> formatLocalDate(point.localDate, timezone)
            else -> point.title?.takeIf(String::isNotBlank) ?: "未命名事件"
        }
    val context =
        when {
            isDate && isToday ->
                "${formatLocalDate(point.localDate, timezone)} · ${if (taskCount == 0) "还没有安排任务" else "$taskCount 个任务"}"
            isDate && taskCount == 0 -> "没有安排任务 · 仍可添加"
            isDate -> "$taskCount 个任务"
            point.reachedAt != null -> "已到达 · $taskCount 个任务"
            else -> "未到达 · $taskCount 个任务"
        }
    val colors = MaterialTheme.colorScheme
    val containerColor =
        when {
            isToday -> colors.primaryContainer
            taskCount > 0 -> colors.surfaceContainer
            else -> colors.surfaceContainerLow
        }
    val iconColor =
        when {
            isToday -> colors.onPrimaryContainer
            !isDate -> colors.onTertiaryContainer
            else -> colors.onSecondaryContainer
        }
    val iconContainer =
        when {
            isToday -> colors.primaryContainer
            !isDate -> colors.tertiaryContainer
            else -> colors.secondaryContainer
        }
    ListItem(
        headlineContent = {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium)
        },
        supportingContent = {
            Text(context, color = colors.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        },
        leadingContent = {
            Surface(shape = MaterialTheme.shapes.medium, color = iconContainer) {
                Icon(
                    if (isDate) Icons.Default.CalendarToday else Icons.Default.Event,
                    null,
                    modifier = Modifier.padding(10.dp).size(22.dp),
                    tint = iconColor,
                )
            }
        },
        trailingContent = {
            IconButton(
                onClick = onAdd,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Default.Add,
                    if (isDate) "在此日期安排任务" else "在此事件安排任务",
                    tint = colors.onSurfaceVariant,
                )
            }
        },
        colors = ListItemDefaults.colors(containerColor = containerColor),
    )
}
