package com.devtodo.app.ui.components

import androidx.compose.animation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.TaskDockSpacing

/**
 * Builds the folder breadcrumb path list from root to [currentFolderId].
 */
fun buildFolderBreadcrumbs(
    currentFolderId: String?,
    allFolders: List<FolderEntity>,
): List<FolderEntity> {
    if (currentFolderId == null) return emptyList()
    val byId = allFolders.associateBy { it.id }
    val result = mutableListOf<FolderEntity>()
    val visited = mutableSetOf<String>()
    var curr: String? = currentFolderId
    while (curr != null && visited.add(curr)) {
        val folder = byId[curr] ?: break
        result.add(folder)
        curr = folder.parentFolderId
    }
    return result.reversed()
}

/**
 * Pure filter logic for search matching in DirectoryTaskPickerDialog.
 */
fun filterMatchingTasks(
    tasks: List<TaskEntity>,
    query: String,
    allFolders: List<FolderEntity>,
): List<TaskEntity> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    return tasks.filter { task ->
        task.deletedAt == null && task.archivedAt == null && (
            task.title.contains(needle, ignoreCase = true) ||
                task.referenceId?.contains(needle, ignoreCase = true) == true ||
                folderPath(task.parentFolderId, allFolders).contains(needle, ignoreCase = true)
        )
    }
}

/**
 * Material 3 Expressive Directory Task Picker Dialog.
 *
 * Aligns with the web AddTaskModal and mobile TreeScreen hierarchy:
 * - Breadcrumb navigation across nested folders
 * - Subfolders display with task count and aggregate status
 * - Tasks in current folder can be checked / multi-selected
 * - Tasks already in schedule are clearly marked and disabled
 * - Full-text and folder-aware search across all tasks
 * - Selections are preserved across directory navigations
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DirectoryTaskPickerDialog(
    title: String,
    allFolders: List<FolderEntity>,
    allTasks: List<TaskEntity>,
    folderAggregates: Map<String, Pair<TaskStatus, Int>> = emptyMap(),
    alreadyScheduledTaskIds: Set<String> = emptySet(),
    onDismiss: () -> Unit,
    onConfirm: (List<String>) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var currentFolderId by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedTaskIds = remember { mutableStateListOf<String>() }

    val activeFolders = remember(allFolders) {
        allFolders.filter { it.deletedAt == null && it.archivedAt == null }
    }
    val activeTasks = remember(allTasks) {
        allTasks.filter { it.deletedAt == null && it.archivedAt == null }
    }

    // Breadcrumb path from root to currentFolderId
    val breadcrumbs = remember(currentFolderId, activeFolders) {
        buildFolderBreadcrumbs(currentFolderId, activeFolders)
    }

    // Children folders in current view
    val currentSubFolders = remember(currentFolderId, activeFolders) {
        activeFolders
            .filter { it.parentFolderId == currentFolderId }
            .sortedWith(
                compareBy<FolderEntity>(
                    { it.rank.toLongOrNull() ?: 0L },
                    { it.id },
                )
            )
    }

    // Tasks in current folder
    val currentTasks = remember(currentFolderId, activeTasks) {
        activeTasks
            .filter { it.parentFolderId == currentFolderId }
            .sortedWith(
                compareBy<TaskEntity>(
                    { it.status == TaskStatus.DONE },
                    { it.rank.toLongOrNull() ?: 0L },
                    { it.id },
                )
            )
    }

    // Matching tasks for search mode
    val searchResults = remember(query, activeTasks, activeFolders) {
        filterMatchingTasks(activeTasks, query, activeFolders)
    }

    val isSearchMode = query.trim().isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.fillMaxWidth().testTag("directory-task-picker-dialog"),
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "关闭")
                }
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 280.dp, max = 520.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Search bar
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().testTag("picker-search-field"),
                    singleLine = true,
                    label = { Text("搜索任务或目录") },
                    placeholder = { Text("输入标题、引用 ID 或目录") },
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = {
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { query = "" }) {
                                Icon(Icons.Default.Close, "清除搜索")
                            }
                        }
                    },
                    shape = TaskDockShapes.FullPill,
                )

                if (isSearchMode) {
                    // Search results view
                    if (searchResults.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "没有匹配的任务",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                                .testTag("picker-search-results"),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            items(searchResults, key = { it.id }) { task ->
                                val alreadyScheduled = task.id in alreadyScheduledTaskIds
                                val isSelected = task.id in selectedTaskIds
                                PickerTaskRow(
                                    task = task,
                                    subtitle = folderPath(task.parentFolderId, activeFolders),
                                    isSelected = isSelected,
                                    alreadyScheduled = alreadyScheduled,
                                    onToggle = {
                                        if (!alreadyScheduled) {
                                            if (isSelected) selectedTaskIds.remove(task.id)
                                            else selectedTaskIds.add(task.id)
                                        }
                                    },
                                )
                            }
                        }
                    }
                } else {
                    // Directory tree navigation view
                    // Breadcrumb navigation bar
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        FilterChip(
                            selected = currentFolderId == null,
                            onClick = { currentFolderId = null },
                            label = { Text("根目录") },
                            leadingIcon = {
                                Icon(Icons.Default.Folder, null, modifier = Modifier.size(16.dp))
                            },
                        )
                        breadcrumbs.forEach { crumb ->
                            Icon(
                                Icons.Default.ChevronRight,
                                null,
                                modifier = Modifier.padding(horizontal = 2.dp).size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            FilterChip(
                                selected = currentFolderId == crumb.id,
                                onClick = { currentFolderId = crumb.id },
                                label = { Text(crumb.title) },
                            )
                        }
                    }

                    // Content list (Subfolders + Tasks in current folder)
                    if (currentSubFolders.isEmpty() && currentTasks.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (currentFolderId == null) "根目录下没有任务或目录" else "当前目录暂无任务或子目录",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                                .testTag("picker-directory-list"),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            // Subfolders section
                            if (currentSubFolders.isNotEmpty()) {
                                item(key = "subfolders-header") {
                                    Text(
                                        "子目录 (${currentSubFolders.size})",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
                                    )
                                }
                                items(currentSubFolders, key = { "folder-${it.id}" }) { folder ->
                                    val count = folderAggregates[folder.id]?.second ?: 0
                                    ExpressiveFolderCard(
                                        folder = folder,
                                        itemCount = count,
                                        onClick = { currentFolderId = folder.id },
                                    )
                                }
                            }

                            // Tasks section
                            if (currentTasks.isNotEmpty()) {
                                item(key = "tasks-header") {
                                    Text(
                                        "任务 (${currentTasks.size})",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                                    )
                                }
                                items(currentTasks, key = { "task-${it.id}" }) { task ->
                                    val alreadyScheduled = task.id in alreadyScheduledTaskIds
                                    val isSelected = task.id in selectedTaskIds
                                    PickerTaskRow(
                                        task = task,
                                        subtitle = null,
                                        isSelected = isSelected,
                                        alreadyScheduled = alreadyScheduled,
                                        onToggle = {
                                            if (!alreadyScheduled) {
                                                if (isSelected) selectedTaskIds.remove(task.id)
                                                else selectedTaskIds.add(task.id)
                                            }
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(selectedTaskIds.toList()) },
                enabled = selectedTaskIds.isNotEmpty(),
                shape = TaskDockShapes.FullPill,
            ) {
                Text(if (selectedTaskIds.isEmpty()) "加入安排" else "加入安排 (${selectedTaskIds.size})")
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (selectedTaskIds.isNotEmpty()) {
                    TextButton(onClick = { selectedTaskIds.clear() }) {
                        Text("清空选择")
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("取消")
                }
            }
        },
    )
}

@Composable
private fun PickerTaskRow(
    task: TaskEntity,
    subtitle: String?,
    isSelected: Boolean,
    alreadyScheduled: Boolean,
    onToggle: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !alreadyScheduled, onClick = onToggle),
        shape = TaskDockShapes.TaskRowShape,
        color = if (alreadyScheduled) {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        } else if (isSelected) {
            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)
        } else {
            MaterialTheme.colorScheme.surfaceContainerLow
        },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Checkbox(
                checked = isSelected || alreadyScheduled,
                onCheckedChange = if (alreadyScheduled) null else { _ -> onToggle() },
                enabled = !alreadyScheduled,
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = if (alreadyScheduled) {
                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (alreadyScheduled) {
                Surface(
                    shape = TaskDockShapes.FullPill,
                    color = MaterialTheme.colorScheme.surfaceContainerHighest,
                ) {
                    Text(
                        text = "已加入",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            } else if (task.status == TaskStatus.DONE) {
                Surface(
                    shape = TaskDockShapes.FullPill,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(
                        text = "已完成",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
        }
    }
}
