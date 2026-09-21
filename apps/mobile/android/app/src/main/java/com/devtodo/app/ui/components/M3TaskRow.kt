package com.devtodo.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus

fun taskStatusLabel(status: TaskStatus): String =
    when (status) {
        TaskStatus.TODO -> "待办"
        TaskStatus.IN_PROGRESS -> "进行中"
        TaskStatus.DONE -> "已完成"
    }

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
) {
    ListItem(
        modifier = modifier.fillMaxWidth().clickable(onClickLabel = "打开任务", onClick = onClick),
        colors =
            ListItemDefaults.colors(
                containerColor =
                    if (highlighted) MaterialTheme.colorScheme.secondaryContainer
                    else MaterialTheme.colorScheme.surface
            ),
        headlineContent = {
            Text(
                task.title,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                textDecoration =
                    if (task.status == TaskStatus.DONE) TextDecoration.LineThrough
                    else TextDecoration.None,
            )
        },
        supportingContent = {
            Text(
                listOfNotNull(
                        taskStatusLabel(task.status),
                        projectName,
                        dateBadge,
                        task.referenceId,
                    )
                    .joinToString(" · "),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        },
        leadingContent = {
            Box(
                modifier = Modifier
                    .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                    .toggleable(
                        value = task.status == TaskStatus.DONE,
                        role = Role.Checkbox,
                        onValueChange = { checked ->
                            onStatusToggle(
                                if (checked) TaskStatus.DONE else TaskStatus.TODO,
                            )
                        },
                    )
                    .semantics {
                        contentDescription = "${task.title}，完成状态"
                        stateDescription = taskStatusLabel(task.status)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Checkbox(
                    checked = task.status == TaskStatus.DONE,
                    onCheckedChange = null,
                    modifier = Modifier.clearAndSetSemantics {},
                )
            }
        },
        trailingContent = {
            ActionMenu(
                "${task.title}，更多操作",
                TaskStatus.entries
                    .filter { it != task.status }
                    .map { status ->
                        RowAction("标记为${taskStatusLabel(status)}") { onStatusToggle(status) }
                    } + actions,
            )
        },
    )
}
