package com.devtodo.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.devtodo.app.data.local.ConflictEntity
import com.devtodo.app.ui.theme.TaskDockShapes

@Composable
fun ConflictResolutionDialog(
    conflict: ConflictEntity,
    onDismiss: () -> Unit,
    onResolve: (strategy: String, mergedPayloadJson: String?) -> Unit,
) {
    var mergedJson by rememberSaveable(conflict.id) {
        mutableStateOf(conflict.localJson)
    }
    var showEditMerge by rememberSaveable(conflict.id) {
        mutableStateOf(false)
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.95f)
                .fillMaxHeight(0.88f),
            shape = TaskDockShapes.LargeIncreased,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 6.dp,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Header
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "版本冲突解决",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = "命令: ${conflict.command ?: conflict.entityType} · 实体ID: ${conflict.entityId.take(12)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // Comparison Views (Local vs Server)
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // Local intent card
                    Surface(
                        shape = TaskDockShapes.Medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                text = "本地意图 (Local Payload)",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(
                                        MaterialTheme.colorScheme.surface,
                                        TaskDockShapes.Small,
                                    )
                                    .padding(8.dp)
                                    .horizontalScroll(rememberScrollState()),
                            ) {
                                Text(
                                    text = conflict.localJson,
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                )
                            }
                        }
                    }

                    // Server version card
                    Surface(
                        shape = TaskDockShapes.Medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                text = "服务器版本 (Server Error/State)",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.tertiary,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(
                                        MaterialTheme.colorScheme.surface,
                                        TaskDockShapes.Small,
                                    )
                                    .padding(8.dp)
                                    .horizontalScroll(rememberScrollState()),
                            ) {
                                Text(
                                    text = conflict.serverJson,
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                )
                            }
                        }
                    }

                    if (showEditMerge) {
                        Surface(
                            shape = TaskDockShapes.Medium,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    text = "合并后的 Payload JSON",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.secondary,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                OutlinedTextField(
                                    value = mergedJson,
                                    onValueChange = { mergedJson = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    minLines = 4,
                                    maxLines = 8,
                                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                    shape = TaskDockShapes.Small,
                                )
                            }
                        }
                    }
                }

                // Action Bar
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        FilledTonalButton(
                            onClick = { onResolve("server", null) },
                            modifier = Modifier.weight(1f),
                            shape = TaskDockShapes.FullPill,
                        ) {
                            Text("采纳服务端版本")
                        }
                        FilledTonalButton(
                            onClick = { onResolve("local", null) },
                            modifier = Modifier.weight(1f),
                            shape = TaskDockShapes.FullPill,
                        ) {
                            Text("保留本地并重试")
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (!showEditMerge) {
                            OutlinedButton(
                                onClick = { showEditMerge = true },
                                modifier = Modifier.weight(1f),
                                shape = TaskDockShapes.FullPill,
                            ) {
                                Text("编辑合并版本")
                            }
                        } else {
                            Button(
                                onClick = { onResolve("merged", mergedJson) },
                                modifier = Modifier.weight(1f),
                                shape = TaskDockShapes.FullPill,
                            ) {
                                Text("提交合并结果")
                            }
                        }
                        OutlinedButton(
                            onClick = { onResolve("discard", null) },
                            modifier = Modifier.weight(1f),
                            shape = TaskDockShapes.FullPill,
                        ) {
                            Text("放弃本次操作")
                        }
                    }

                    TextButton(
                        onClick = onDismiss,
                        modifier = Modifier.align(Alignment.CenterHorizontally),
                    ) {
                        Text("稍后处理")
                    }
                }
            }
        }
    }
}
