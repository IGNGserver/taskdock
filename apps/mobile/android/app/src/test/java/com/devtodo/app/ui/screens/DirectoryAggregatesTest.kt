package com.devtodo.app.ui.screens

import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.TaskStatus
import org.junit.Assert.*
import org.junit.Test

class DirectoryAggregatesTest {
    private fun folder(id: String, parent: String? = null, status: TaskStatus = TaskStatus.TODO) =
        FolderEntity(id, "owner", parent, id, "1024", 1, null, null, "now", "now", status = status)
    @Test fun aggregatesNestedFoldersInOnePass() {
        val result = directoryAggregates(listOf(folder("root", status = TaskStatus.IN_PROGRESS), folder("child", "root", status = TaskStatus.DONE)), listOf(
            TaskLocation("root", TaskStatus.TODO), TaskLocation("child", TaskStatus.DONE)))
        assertEquals(TaskStatus.IN_PROGRESS to 2, result["root"])
        assertEquals(TaskStatus.DONE to 1, result["child"])
    }
    @Test fun corruptParentCycleTerminatesAndCountsOnlyOnce() {
        val result = directoryAggregates(listOf(folder("a", "b"), folder("b", "a")), listOf(TaskLocation("a", TaskStatus.TODO)))
        assertEquals(TaskStatus.TODO to 1, result["a"])
        assertEquals(TaskStatus.TODO to 1, result["b"])
    }
    @Test fun deepDirectoryTreeDoesNotOverflowStackOrWalkEachTaskAncestry() {
        val folders = (0 until 10_000).map { folder("$it", if (it == 0) null else "${it - 1}") }
        val tasks = (0 until 10_000).map { TaskLocation("$it", TaskStatus.DONE) }
        val result = directoryAggregates(folders, tasks)
        assertEquals(TaskStatus.TODO to 10_000, result["0"])
        assertEquals(TaskStatus.TODO to 1, result["9999"])
    }
}
