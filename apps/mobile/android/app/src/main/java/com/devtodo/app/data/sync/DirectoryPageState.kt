package com.devtodo.app.data.sync

import com.devtodo.app.data.model.DirectoryPageDto
import com.devtodo.app.data.model.FolderAggregateDto

/** Query membership is not a snapshot and never authorizes deleting cached rows. */
data class DirectoryPageState(
    val initialized: Boolean = false,
    val taskIds: Set<String> = emptySet(),
    val folderIds: Set<String> = emptySet(),
    val aggregates: Map<String, FolderAggregateDto> = emptyMap(),
    val nextCursor: String? = null,
    val retainedTaskIds: Set<String> = emptySet(),
    val retainedFolderIds: Set<String> = emptySet(),
) {
    internal fun merge(page: DirectoryPageDto, append: Boolean): DirectoryPageState {
        val previous = if (append) this else DirectoryPageState()
        return DirectoryPageState(
            initialized = true,
            taskIds = previous.taskIds + retainedTaskIds + page.items.mapNotNull { it.task?.id },
            folderIds = previous.folderIds + retainedFolderIds + page.items.mapNotNull { it.folder?.id },
            aggregates = previous.aggregates + page.items.mapNotNull { item ->
                item.folder?.id?.let { id -> item.aggregate?.let { id to it } }
            }.toMap(),
            nextCursor = page.nextCursor,
            retainedTaskIds = retainedTaskIds,
            retainedFolderIds = retainedFolderIds,
        )
    }
}
