package com.devtodo.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus

fun taskStatusLabel(status: TaskStatus): String = when (status) {
    TaskStatus.TODO -> "待办"
    TaskStatus.IN_PROGRESS -> "进行中"
    TaskStatus.DONE -> "已完成"
}

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
