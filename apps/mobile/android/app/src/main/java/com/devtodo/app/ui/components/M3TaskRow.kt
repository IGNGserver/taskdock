package com.devtodo.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.theme.*

@Composable
fun M3TaskRow(
    task: TaskEntity,
    projectName: String? = null,
    dateBadge: String? = null,
    onClick: () -> Unit,
    onStatusToggle: (TaskStatus) -> Unit,
    modifier: Modifier = Modifier
) {
    val haptic = LocalHapticFeedback.current
    val nextStatus = when (task.status) {
        TaskStatus.TODO -> TaskStatus.IN_PROGRESS
        TaskStatus.IN_PROGRESS -> TaskStatus.DONE
        TaskStatus.DONE -> TaskStatus.TODO
    }

    val isDone = task.status == TaskStatus.DONE

    Surface(
        onClick = {
            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            onClick()
        },
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .clickable {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onStatusToggle(nextStatus)
                    }
            ) {
                when (task.status) {
                    TaskStatus.DONE -> {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Check,
                                contentDescription = "Done",
                                tint = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(16.dp)
                            )
                        }
                    }
                    TaskStatus.IN_PROGRESS -> {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.tertiaryContainer)
                        ) {
                            Icon(
                                imageVector = Icons.Default.HourglassTop,
                                contentDescription = "In Progress",
                                tint = MaterialTheme.colorScheme.onTertiaryContainer,
                                modifier = Modifier.size(14.dp)
                            )
                        }
                    }
                    TaskStatus.TODO -> {
                        Box(
                            modifier = Modifier
                                .size(22.dp)
                                .clip(CircleShape)
                                .background(Color.Transparent)
                                .padding(2.dp)
                        ) {
                            Surface(
                                shape = CircleShape,
                                color = Color.Transparent,
                                border = androidx.compose.foundation.BorderStroke(
                                    2.dp,
                                    MaterialTheme.colorScheme.outline
                                ),
                                modifier = Modifier.fillMaxSize()
                            ) {}
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.width(10.dp))

            Column(
                modifier = Modifier.weight(1f)
            ) {
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.bodyLarge.copy(
                        fontWeight = if (isDone) FontWeight.Normal else FontWeight.Medium,
                        textDecoration = if (isDone) TextDecoration.LineThrough else TextDecoration.None
                    ),
                    color = if (isDone) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                            else MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )

                if (!projectName.isNullOrEmpty() || !dateBadge.isNullOrEmpty() || task.priority != TaskPriority.NONE) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        task.referenceId?.let { ref ->
                            Text(
                                text = ref,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f))
                                    .padding(horizontal = 4.dp, vertical = 2.dp)
                            )
                        }

                        if (!projectName.isNullOrEmpty()) {
                            Text(
                                text = projectName,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant)
                                    .padding(horizontal = 4.dp, vertical = 2.dp)
                            )
                        }

                        if (!dateBadge.isNullOrEmpty()) {
                            Text(
                                text = dateBadge,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.secondary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.7f))
                                    .padding(horizontal = 4.dp, vertical = 2.dp)
                            )
                        }

                        if (task.priority != TaskPriority.NONE) {
                            val (priorityColor, priorityText) = when (task.priority) {
                                TaskPriority.HIGH -> PriorityHigh to "高"
                                TaskPriority.MEDIUM -> PriorityMedium to "中"
                                TaskPriority.LOW -> PriorityLow to "低"
                                TaskPriority.NONE -> PriorityNone to ""
                            }
                            Text(
                                text = priorityText,
                                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                                color = priorityColor,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(priorityColor.copy(alpha = 0.15f))
                                    .padding(horizontal = 4.dp, vertical = 2.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}
