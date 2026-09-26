package com.devtodo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.theme.TaskDockMotion
import com.devtodo.app.ui.theme.TaskDockShapes

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
) {
    val haptics = LocalHapticFeedback.current
    val isDone = task.status == TaskStatus.DONE
    val isInProgress = task.status == TaskStatus.IN_PROGRESS

    val metadata = buildList {
        if (showStatus) add(taskStatusLabel(task.status))
        projectName?.takeIf(String::isNotBlank)?.let(::add)
        dateBadge?.takeIf(String::isNotBlank)?.let(::add)
    }

    val targetContainerColor = when {
        highlighted -> MaterialTheme.colorScheme.secondaryContainer
        containerColorOverride != null -> containerColorOverride
        isDone -> MaterialTheme.colorScheme.surfaceContainerLowest.copy(alpha = 0.6f)
        isInProgress -> MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f)
        else -> MaterialTheme.colorScheme.surfaceContainerLow
    }

    val containerColor by animateColorAsState(
        targetValue = targetContainerColor,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "expressiveTaskContainerColor",
    )

    val shape = if (highlighted) TaskDockShapes.TaskRowSelectedShape else TaskDockShapes.TaskRowShape

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(shape)
            .clickable(onClickLabel = "查看任务详情", onClick = onClick),
        shape = shape,
        color = containerColor,
        tonalElevation = if (highlighted) 4.dp else if (isDone) 0.dp else 1.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 8.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Expressive Spring Bounce Checkbox Control
            ExpressiveCheckbox(
                checked = isDone,
                onCheckedChange = { checked ->
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onStatusToggle(if (checked) TaskStatus.DONE else TaskStatus.TODO)
                },
                taskTitle = task.title,
                status = task.status,
            )

            Spacer(Modifier.width(8.dp))

            // Task Content
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 2.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = task.title,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (isInProgress) FontWeight.SemiBold else FontWeight.Medium,
                    color = if (isDone) {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f)
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    textDecoration = if (isDone) TextDecoration.LineThrough else TextDecoration.None,
                )

                if (metadata.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (isInProgress) {
                            Surface(
                                shape = TaskDockShapes.FullPill,
                                color = MaterialTheme.colorScheme.primary,
                            ) {
                                Text(
                                    text = "进行中",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onPrimary,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                        }

                        Text(
                            text = metadata.joinToString(" · "),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Trailing Actions Menu
            if (actions.isNotEmpty()) {
                ActionMenu(label = "${task.title}，更多操作", actions = actions)
            }
        }
    }
}

/**
 * Animated Checkbox button with M3 Expressive bouncy bounce feedback
 */
@Composable
fun ExpressiveCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    taskTitle: String,
    status: TaskStatus,
    modifier: Modifier = Modifier,
) {
    val checkScale by animateFloatAsState(
        targetValue = if (checked) 1f else 0.85f,
        animationSpec = TaskDockMotion.springBouncy(),
        label = "checkboxScale",
    )

    val boxColor by animateColorAsState(
        targetValue = if (checked) MaterialTheme.colorScheme.primary else Color.Transparent,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "checkboxBoxColor",
    )

    val borderColor by animateColorAsState(
        targetValue = if (checked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "checkboxBorderColor",
    )

    Box(
        modifier = modifier
            .size(48.dp)
            .toggleable(
                value = checked,
                role = Role.Checkbox,
                onValueChange = onCheckedChange,
            )
            .semantics {
                contentDescription = "$taskTitle，完成状态"
                stateDescription = taskStatusLabel(status)
            },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier
                .size(24.dp)
                .scale(checkScale),
            shape = TaskDockShapes.Small,
            color = boxColor,
            border = if (!checked) androidx.compose.foundation.BorderStroke(2.dp, borderColor) else null,
        ) {
            if (checked) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Default.Check,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier
                            .size(16.dp)
                            .clearAndSetSemantics {},
                    )
                }
            }
        }
    }
}
