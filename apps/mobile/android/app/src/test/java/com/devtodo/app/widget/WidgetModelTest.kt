package com.devtodo.app.widget

import com.devtodo.app.data.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetModelTest {
    @Test
    fun todayProgressUsesRealCountsOnly() {
        val state = TodayWidgetState(signedIn = true, total = 5, done = 2)
        assertEquals(3, state.remaining)
        assertEquals(0.4f, state.progress, 0.0001f)

        val empty = TodayWidgetState(signedIn = true)
        assertEquals(0, empty.remaining)
        assertEquals(0f, empty.progress, 0.0001f)
    }

    @Test
    fun taskFlagsFollowTheSharedStatusEnum() {
        assertTrue(WidgetTask("1", "进行中", TaskStatus.IN_PROGRESS).isInProgress)
        assertFalse(WidgetTask("2", "待办", TaskStatus.TODO).isDone)
        assertTrue(WidgetTask("3", "完成", TaskStatus.DONE).isDone)
    }

    @Test
    fun widgetTextCollapsesWhitespaceAndTruncatesForRemoteViews() {
        assertEquals("把小组件方案发到群里", "把小组件方案发到群里".widgetText(20))
        assertEquals("第一行 第二行", "第一行\n第二行".widgetText(20))
        val truncated = "这是一个很长很长的任务标题".widgetText(10)
        assertEquals(10, truncated.length)
        assertTrue(truncated.endsWith("…"))
    }

    @Test
    fun openStateKeepsTheRepositoryProvidedCount() {
        val state = OpenWidgetState(
            signedIn = true,
            total = 12,
            tasks = listOf(WidgetTask("1", "A", TaskStatus.TODO)),
        )
        assertEquals(12, state.total)
        assertEquals(1, state.tasks.size)
    }
}
