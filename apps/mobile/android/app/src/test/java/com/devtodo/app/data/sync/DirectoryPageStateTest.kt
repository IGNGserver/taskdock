package com.devtodo.app.data.sync

import com.devtodo.app.data.model.*
import org.junit.Assert.*
import org.junit.Test

class DirectoryPageStateTest {
    private fun page(vararg ids: String, next: String? = null) = DirectoryPageDto(
        items = ids.map { TreeItemDto("TASK", task = TreeTaskDto(it, referenceId = "TEST-1", title = "task", rank = "1024")) },
        nextCursor = next,
    )

    @Test fun nextPageDeduplicatesAndKeepsPreviousMembership() {
        val first = DirectoryPageState().merge(page("one", "two", next = "cursor"), false)
        val next = first.merge(page("two", "three"), true)
        assertEquals(setOf("one", "two", "three"), next.taskIds)
        assertNull(next.nextCursor)
        assertTrue(next.initialized)
    }

    @Test fun refreshedFirstPageReplacesAnExpiredChainIncludingEmptyResults() {
        val first = DirectoryPageState().merge(page("old", next = "expired"), false)
        val restarted = first.merge(page("new"), false)
        assertEquals(setOf("new"), restarted.taskIds)
        val empty = restarted.merge(page(), false)
        assertTrue(empty.initialized)
        assertTrue(empty.taskIds.isEmpty())
        assertNull(empty.nextCursor)
    }

    @Test fun lateFirstPageCannotHideLocallyAcceptedOrNewlyReceivedRows() {
        val state = DirectoryPageState(taskIds = setOf("local"), retainedTaskIds = setOf("local"))
        assertEquals(setOf("local", "server"), state.merge(page("server"), false).taskIds)
    }
}
