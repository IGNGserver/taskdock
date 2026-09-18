package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveCenterV2Screen(viewModel: MainViewModel, onBack: () -> Unit) {
    val operations by viewModel.archiveOperationsV2.collectAsState()
    val folders by viewModel.foldersV2.collectAsState()
    val archivedTasks by viewModel.archivedTasks.collectAsState()
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text("归档中心") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        if (operations.isEmpty() && archivedTasks.isEmpty()) {
            Text("暂无归档内容", modifier = Modifier.padding(padding).padding(24.dp))
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (operations.isNotEmpty()) {
                    item {
                        Text("目录树批量归档", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    }
                    items(operations, key = { it.id }) { operation ->
                        val rootTitle = folders.firstOrNull { it.id == operation.rootFolderId }?.title ?: "已删除目录"
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(rootTitle, style = MaterialTheme.typography.titleMedium)
                                Text("${operation.folderCount} 个文件夹 · ${operation.taskCount} 个任务")
                                Text(if (operation.restoredAt == null) "未恢复" else "已恢复")
                            }
                            if (operation.restoredAt == null) {
                                TextButton(onClick = { viewModel.restoreFolderTreeV2(operation) }) { Text("恢复") }
                            }
                        }
                    }
                }
                if (archivedTasks.isNotEmpty()) {
                    item {
                        Text("独立归档任务", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                    }
                    items(archivedTasks, key = { it.id }) { task ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(task.title, style = MaterialTheme.typography.bodyLarge)
                                Text(task.referenceId ?: task.id.take(8), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                            }
                            TextButton(onClick = { viewModel.restoreTask(task) }) { Text("恢复任务") }
                        }
                    }
                }
            }
        }
    }
}
