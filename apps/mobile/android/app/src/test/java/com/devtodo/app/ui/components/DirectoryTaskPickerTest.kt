package com.devtodo.app.ui.components

import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskCategory
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class DirectoryTaskPickerTest {

    private fun folder(id: String, title: String, parentId: String? = null) = FolderEntity(
        id = id,
        ownerId = "owner",
        parentFolderId = parentId,
        title = title,
        rank = "1000",
        version = 1,
        archivedAt = null,
        deletedAt = null,
        createdAt = "2026-10-01T00:00:00Z",
        updatedAt = "2026-10-01T00:00:00Z",
    )

    private fun task(id: String, title: String, parentFolderId: String? = null, refId: String? = null) = TaskEntity(
        id = id,
        ownerId = "owner",
        projectId = null,
        referenceId = refId,
        title = title,
        status = TaskStatus.TODO,
        category = TaskCategory.MISC,
        priority = TaskPriority.NONE,
        rank = "1000",
        version = 1,
        archivedAt = null,
        deletedAt = null,
        createdAt = "2026-10-01T00:00:00Z",
        updatedAt = "2026-10-01T00:00:00Z",
        parentFolderId = parentFolderId,
    )

    @Test
    fun breadcrumbsChainFromRootToTarget() {
        val f1 = folder("f1", "一级目录", null)
        val f2 = folder("f2", "二级目录", "f1")
        val f3 = folder("f3", "三级目录", "f2")
        val allFolders = listOf(f1, f2, f3)

        assertEquals(emptyList<FolderEntity>(), buildFolderBreadcrumbs(null, allFolders))
        assertEquals(listOf("一级目录"), buildFolderBreadcrumbs("f1", allFolders).map { it.title })
        assertEquals(listOf("一级目录", "二级目录"), buildFolderBreadcrumbs("f2", allFolders).map { it.title })
        assertEquals(listOf("一级目录", "二级目录", "三级目录"), buildFolderBreadcrumbs("f3", allFolders).map { it.title })
    }

    @Test
    fun filterMatchingTasksMatchesTitleRefAndFolder() {
        val f1 = folder("f1", "工作计划", null)
        val f2 = folder("f2", "安卓开发", "f1")
        val allFolders = listOf(f1, f2)

        val t1 = task("t1", "实现树形选择器", "f2", "DEV-101")
        val t2 = task("t2", "日常站会", "f1", null)
        val t3 = task("t3", "买牛奶", null, null)
        val allTasks = listOf(t1, t2, t3)

        // Empty query
        assertEquals(emptyList<TaskEntity>(), filterMatchingTasks(allTasks, "", allFolders))

        // Match title
        val matchTitle = filterMatchingTasks(allTasks, "树形", allFolders)
        assertEquals(listOf("t1"), matchTitle.map { it.id })

        // Match reference ID
        val matchRef = filterMatchingTasks(allTasks, "101", allFolders)
        assertEquals(listOf("t1"), matchRef.map { it.id })

        // Match folder title
        val matchFolder = filterMatchingTasks(allTasks, "安卓开发", allFolders)
        assertEquals(listOf("t1"), matchFolder.map { it.id })

        val matchParentFolder = filterMatchingTasks(allTasks, "工作计划", allFolders)
        assertEquals(listOf("t1", "t2"), matchParentFolder.map { it.id })
    }
}
