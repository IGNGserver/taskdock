package com.devtodo.app.ui.components

import com.devtodo.app.data.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/** The circle contract must stay identical to the web `nextTaskStatus`. */
class TaskStatusCycleTest {
    @Test
    fun circleAdvancesThroughThreeStates() {
        assertEquals(TaskStatus.IN_PROGRESS, nextTaskStatus(TaskStatus.TODO))
        assertEquals(TaskStatus.DONE, nextTaskStatus(TaskStatus.IN_PROGRESS))
        assertEquals(TaskStatus.TODO, nextTaskStatus(TaskStatus.DONE))
    }

    @Test
    fun labelsAndActionLabelsMatchTheWebContract() {
        assertEquals("待开始", taskStatusLabel(TaskStatus.TODO))
        assertEquals("进行中", taskStatusLabel(TaskStatus.IN_PROGRESS))
        assertEquals("已完成", taskStatusLabel(TaskStatus.DONE))
        assertEquals("标记为进行中", taskStatusActionLabel(TaskStatus.TODO))
        assertEquals("标记为已完成", taskStatusActionLabel(TaskStatus.IN_PROGRESS))
        assertEquals("标记为待开始", taskStatusActionLabel(TaskStatus.DONE))
    }
}
