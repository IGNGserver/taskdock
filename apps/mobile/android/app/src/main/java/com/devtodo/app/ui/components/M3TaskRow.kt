package com.devtodo.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus

fun taskStatusLabel(status: TaskStatus): String = when (status) {
    TaskStatus.TODO -> "待开始"
    TaskStatus.IN_PROGRESS -> "进行中"
    TaskStatus.DONE -> "已完成"
}

/**
 * The circle advances through the three states in order, so a single tap always
 * moves a task forward instead of only flipping it open or closed. This mirrors
 * the web contract in `apps/web/src/task-behavior.ts`.
 */
fun nextTaskStatus(status: TaskStatus): TaskStatus = when (status) {
    TaskStatus.TODO -> TaskStatus.IN_PROGRESS
    TaskStatus.IN_PROGRESS -> TaskStatus.DONE
    TaskStatus.DONE -> TaskStatus.TODO
}

fun taskStatusActionLabel(status: TaskStatus): String =
    "标记为${taskStatusLabel(nextTaskStatus(status))}"

/** Legacy call sites use the same controls and hierarchy as directory tasks. */
@Composable
fun M3TaskRow(
    task: TaskEntity,
    onClick: () -> Unit,
    onStatusToggle: (TaskStatus) -> Unit,
    modifier: Modifier = Modifier,
    projectName: String? = null,
    dateBadge: String? = null,
    actions: List<RowAction> = emptyList(),
    highlighted: Boolean = false,
    showStatus: Boolean = true,
    containerColorOverride: Color? = null,
) = ExpressiveTaskCard(task, onClick, onStatusToggle, modifier, projectName, dateBadge,
    actions, highlighted, showStatus, containerColorOverride)
