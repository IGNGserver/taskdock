package com.devtodo.app.data.sync

import com.devtodo.app.data.local.OutboxEntity
import com.devtodo.app.data.local.SyncGuardEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class MutationGuardsTest {
    private fun item(id: String, order: Long) = OutboxEntity(
        id = order,
        mutationId = id,
        clientId = "client",
        ownerId = "owner",
        command = "task.update",
        entityId = id,
        baseVersion = null,
        occurredAt = "2026-01-01T00:00:00Z",
        payloadJson = "{}",
    )

    @Test
    fun rejectedMutationClosureIncludesTransitiveDependantsOnly() {
        val items = listOf(item("create", 1), item("edit", 2), item("note", 3), item("unrelated", 4))
        val guards = listOf(
            SyncGuardEntity("create", "task", "task-1"),
            SyncGuardEntity("edit", "task", "task-1"),
            SyncGuardEntity("edit", "note", "note-1"),
            SyncGuardEntity("note", "note", "note-1"),
            SyncGuardEntity("unrelated", "task", "task-2"),
        )

        assertEquals(
            setOf("create", "edit", "note"),
            mutationClosure(items, guards, setOf("create")),
        )
    }

    @Test
    fun rejectedMutationWithoutDependantsDoesNotBlockOtherEntities() {
        val items = listOf(item("rejected", 1), item("other", 2))
        val guards = listOf(
            SyncGuardEntity("rejected", "task", "task-1"),
            SyncGuardEntity("other", "task", "task-2"),
        )
        assertEquals(setOf("rejected"), mutationClosure(items, guards, setOf("rejected")))
    }

    @Test
    fun rejectedMutationDoesNotDiscardEarlierMutationOnSameEntity() {
        val items = listOf(item("create", 1), item("edit", 2), item("note", 3))
        val guards = listOf(
            SyncGuardEntity("create", "task", "task-1"),
            SyncGuardEntity("edit", "task", "task-1"),
            SyncGuardEntity("edit", "note", "note-1"),
            SyncGuardEntity("note", "note", "note-1"),
        )
        assertEquals(setOf("edit", "note"), mutationClosure(items, guards, setOf("edit")))
    }

    @Test
    fun dependencyDiscoveredLaterDoesNotFlowBackwards() {
        val items = listOf(item("rejected", 1), item("middle", 2), item("later", 3))
        val guards = listOf(
            SyncGuardEntity("rejected", "task", "task-1"),
            SyncGuardEntity("middle", "note", "note-1"),
            SyncGuardEntity("later", "task", "task-1"),
            SyncGuardEntity("later", "note", "note-1"),
        )
        assertEquals(setOf("rejected", "later"), mutationClosure(items, guards, setOf("rejected")))
    }
}
