package com.devtodo.app.ui.screens

import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.TaskCategory
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The directory pins a status edit in place until the folder is opened again
 * (web `TreePage.tsx` parity). These tests drive the pure ordering helper so
 * the contract is validated without an emulator.
 */
class TreeRowPinsTest {
    private fun task(id: String, status: TaskStatus, rank: Long) = TreeRow(
        kind = "TASK",
        id = id,
        task = TaskEntity(
            id = id,
            ownerId = "owner",
            projectId = null,
            referenceId = null,
            title = id,
            status = status,
            category = TaskCategory.MISC,
            priority = TaskPriority.NONE,
            rank = rank.toString(),
            version = 1,
            archivedAt = null,
            createdAt = "2026-10-01T00:00:00Z",
            updatedAt = "2026-10-01T00:00:00Z",
        ),
        status = status,
        version = 1,
        rank = rank.toString(),
    )

    @Test
    fun defaultOrderGroupsByStatusThenRank() {
        val rows = listOf(
            task("a", TaskStatus.TODO, 1024),
            task("b", TaskStatus.DONE, 512),
            task("c", TaskStatus.IN_PROGRESS, 2048),
        )
        val resolved = resolveTreeRows(rows, emptyMap(), null)
        assertEquals(listOf("c", "a", "b"), resolved.map { it.id })
    }

    @Test
    fun statusEditKeepsGroupAndSlotUntilTheDirectoryIsReopened() {
        val before = listOf(
            task("a", TaskStatus.TODO, 1024),
            task("b", TaskStatus.TODO, 2048),
            task("c", TaskStatus.IN_PROGRESS, 512),
        )
        val initial = resolveTreeRows(before, emptyMap(), null)
        assertEquals(listOf("c", "a", "b"), initial.map { it.id })

        // The user marks "a" done: the database now reports DONE, but the
        // directory pins it to TODO and locks the order it was loaded with.
        val after = listOf(
            task("a", TaskStatus.DONE, 1024),
            task("b", TaskStatus.TODO, 2048),
            task("c", TaskStatus.IN_PROGRESS, 512),
        )
        val pins = mapOf("a" to TaskStatus.TODO)
        val lock = initial.map { "${it.kind}:${it.id}" }
        val pinned = resolveTreeRows(after, pins, lock)
        assertEquals(listOf("c", "a", "b"), pinned.map { it.id })
        val pinnedA = pinned.first { it.id == "a" }
        assertEquals(TaskStatus.TODO, treeGroupingStatus(pinnedA, pins))

        // Re-entering the directory drops the pins and shows the fresh grouping.
        val reopened = resolveTreeRows(after, emptyMap(), null)
        assertEquals(listOf("c", "b", "a"), reopened.map { it.id })
        assertEquals(TaskStatus.DONE, treeGroupingStatus(reopened.first { it.id == "a" }, emptyMap()))
    }

    @Test
    fun rowsCreatedAfterTheLockAreAppended() {
        val before = listOf(
            task("a", TaskStatus.TODO, 1024),
            task("b", TaskStatus.TODO, 2048),
        )
        val lock = before.map { "${it.kind}:${it.id}" }
        val after = before + task("new", TaskStatus.IN_PROGRESS, 4096)
        val resolved = resolveTreeRows(after, emptyMap(), lock)
        assertEquals(listOf("a", "b", "new"), resolved.map { it.id })
    }
}
