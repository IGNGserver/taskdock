package com.devtodo.app.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.ui.components.*
import com.devtodo.app.ui.theme.TaskDockShapes

/**
 * Material 3 Expressive Archive Center Screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveCenterV2Screen(viewModel: MainViewModel, onBack: () -> Unit) {
    val operations by viewModel.archiveOperationsV2.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val archivedTasks by viewModel.archivedTasks.collectAsStateWithLifecycle()
    val standalone = archivedTasks.filter { it.archivedByOperationId == null }

    PredictiveBackContainer(
        enabled = true,
        onBack = onBack,
    ) {
        WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("归档中心", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            if (operations.isEmpty() && standalone.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.Default.Archive,
                        title = "暂无归档内容",
                        description = "被归档的目录树与任务将收录在此处，支持随时一键无损恢复。",
                    )
                }
            }

            if (operations.isNotEmpty()) {
                item { SectionHeading("目录归档记录") }
                items(operations, key = { "operation:${it.id}" }) { operation ->
                    val folderName = folders.find { it.id == operation.rootFolderId }?.title ?: "已归档目录"
                    val isRestored = operation.restoredAt != null

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        shape = TaskDockShapes.Large,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                modifier = Modifier.weight(1f),
                            ) {
                                Surface(
                                    shape = TaskDockShapes.Medium,
                                    color = MaterialTheme.colorScheme.secondaryContainer,
                                    modifier = Modifier.size(40.dp),
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Icon(
                                            imageVector = Icons.Default.Folder,
                                            contentDescription = null,
                                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                                            modifier = Modifier.size(20.dp),
                                        )
                                    }
                                }

                                Column {
                                    Text(
                                        text = folderName,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        text = "${operation.folderCount} 个目录 · ${operation.taskCount} 项任务" + if (isRestored) " · 已恢复" else "",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }

                            if (!isRestored) {
                                FilledTonalButton(
                                    onClick = { viewModel.restoreFolderTreeV2(operation) },
                                    shape = TaskDockShapes.FullPill,
                                ) {
                                    Icon(Icons.Default.Restore, null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text("恢复")
                                }
                            }
                        }
                    }
                }
            }

            if (standalone.isNotEmpty()) {
                item { SectionHeading("独立任务归档") }
                items(standalone, key = { "task:${it.id}" }) { task ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        shape = TaskDockShapes.Large,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = task.title,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.weight(1f),
                            )

                            FilledTonalButton(
                                onClick = { viewModel.restoreTask(task) },
                                shape = TaskDockShapes.FullPill,
                            ) {
                                Icon(Icons.Default.Restore, null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("恢复")
                            }
                        }
                    }
                }
            }
        }
    }
    }
}
