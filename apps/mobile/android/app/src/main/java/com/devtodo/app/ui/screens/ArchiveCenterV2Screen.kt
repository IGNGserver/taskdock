package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.ui.components.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveCenterV2Screen(viewModel: MainViewModel, onBack: () -> Unit) {
    val operations by viewModel.archiveOperationsV2.collectAsStateWithLifecycle()
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val archivedTasks by viewModel.archivedTasks.collectAsStateWithLifecycle()
    val standalone = archivedTasks.filter { it.archivedByOperationId == null }
    WorkspaceScaffold(
        topBar = {
            TopAppBar(
                title = { Text("归档中心") },
                windowInsets = WindowInsets(0, 0, 0, 0),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                },
            )
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            if (operations.isEmpty() && standalone.isEmpty())
                item { EmptyState(Icons.Default.Archive, "没有归档内容", "归档后的目录与任务可以在这里恢复。") }
            if (operations.isNotEmpty()) {
                item { SectionHeading("目录归档记录") }
                items(operations, key = { "operation:${it.id}" }) { operation ->
                    ListItem(
                        headlineContent = {
                            Text(folders.find { it.id == operation.rootFolderId }?.title ?: "已删除目录")
                        },
                        supportingContent = {
                            Text(
                                "${operation.folderCount} 个目录 · ${operation.taskCount} 个任务${if (operation.restoredAt != null) " · 已恢复" else ""}"
                            )
                        },
                        trailingContent = {
                            if (operation.restoredAt == null)
                                TextButton(onClick = { viewModel.restoreFolderTreeV2(operation) }) {
                                    Text("恢复")
                                }
                        },
                    )
                }
            }
            if (standalone.isNotEmpty()) {
                item { SectionHeading("单独归档的任务") }
                items(standalone, key = { "task:${it.id}" }) { task ->
                    ListItem(
                        headlineContent = { Text(task.title) },
                        trailingContent = {
                            TextButton(onClick = { viewModel.restoreTask(task) }) { Text("恢复") }
                        },
                    )
                }
            }
        }
    }
}
