package com.devtodo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes

/** The status, content and menu have separate touch targets, including in large text. */
@Composable
fun ExpressiveTaskCard(
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
    rowShape: Shape = TaskDockShapes.TaskRowShape,
) {
    val isDone = task.status == TaskStatus.DONE
    val metadata = buildList {
        if (showStatus && task.status == TaskStatus.IN_PROGRESS) add("进行中")
        projectName?.takeIf(String::isNotBlank)?.let(::add)
        dateBadge?.takeIf(String::isNotBlank)?.let(::add)
    }
    val containerColor by animateColorAsState(
        targetValue = when {
            highlighted -> MaterialTheme.colorScheme.secondaryContainer
            containerColorOverride != null -> containerColorOverride
            else -> MaterialTheme.colorScheme.surfaceContainerLow
        },
        animationSpec = TaskDockMotion.springEffectsFast(),
        label = "taskSurface",
    )
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
        shape = rowShape,
        color = containerColor,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ExpressiveCheckbox(
                checked = isDone,
                onCheckedChange = { onStatusToggle(if (it) TaskStatus.DONE else TaskStatus.TODO) },
                taskTitle = task.title,
                status = task.status,
            )
            Column(
                Modifier.weight(1f).clip(TaskDockShapes.Small)
                    .clickable(onClickLabel = "查看任务详情", onClick = onClick)
                    .heightIn(min = 60.dp)
                    .padding(start = 4.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
            ) {
                Text(
                    task.title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (isDone) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    textDecoration = if (isDone) TextDecoration.LineThrough else TextDecoration.None,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
                if (metadata.isNotEmpty()) {
                    Text(
                        metadata.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            ActionMenu(
                label = "${task.title}，更多操作",
                actions = TaskStatus.entries.filter { it != task.status }.map { status ->
                    RowAction("标记为${taskStatusLabel(status)}") { onStatusToggle(status) }
                } + actions,
            )
        }
    }
}

/** A calm circle with a dot for in-progress and a check for done. */
@Composable
fun ExpressiveCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    taskTitle: String,
    status: TaskStatus,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    val scale by animateFloatAsState(
        if (checked) 1f else 0.92f,
        animationSpec = TaskDockMotion.springBouncy(), label = "statusCircleScale",
    )
    val color by animateColorAsState(
        if (checked) MaterialTheme.colorScheme.primary else Color.Transparent,
        animationSpec = TaskDockMotion.springEffectsFast(), label = "statusCircleColor",
    )
    Box(
        modifier.size(48.dp).clip(CircleShape)
            .toggleable(value = checked, role = Role.Checkbox, onValueChange = {
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                onCheckedChange(it)
            })
            .semantics {
                contentDescription = "$taskTitle，完成状态"
                stateDescription = taskStatusLabel(status)
            },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            Modifier.size(26.dp).scale(scale).clearAndSetSemantics {},
            shape = CircleShape,
            color = color,
            border = if (checked) null else BorderStroke(2.dp,
                if (status == TaskStatus.IN_PROGRESS) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.outline),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (checked) {
                    Icon(Icons.Default.Check, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onPrimary)
                } else if (status == TaskStatus.IN_PROGRESS) {
                    Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                }
            }
        }
    }
}
