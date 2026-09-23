package com.devtodo.app.ui.screens

import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TimePointType
import java.time.Instant
import java.util.Date
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TimePresentationTest {
    @Test
    fun groupsDatesForDisplayAndKeepsRankOrderWithinEachDate() {
        val points =
            listOf(
                date("past-empty", "2026-09-20", "1024"),
                date("future-later", "2026-09-25", "1024"),
                date("past-active", "2026-09-22", "1024"),
                date("today-late", "2026-09-23", "2048"),
                date("today-early", "2026-09-23", "1024"),
                event("event"),
            )

        val groups =
            groupTimePoints(
                points,
                visibleTaskCountByPoint = mapOf("past-active" to 1, "today-early" to 2),
                todayLocalDate = "2026-09-23",
            )

        assertEquals(listOf("today-early", "today-late", "future-later"), groups.todayAndUpcoming.map { it.id })
        assertEquals(listOf("past-active"), groups.pastWithTasks.map { it.id })
        assertEquals(listOf("past-empty"), groups.olderEmptyDates.map { it.id })
        assertEquals(listOf("event"), groups.events.map { it.id })
    }

    @Test
    fun calendarDateFormattingUsesConfiguredZoneWithoutShiftingTheDate() {
        val rendered = formatLocalDate("2026-09-23", "America/Los_Angeles", Locale.US)

        assertTrue(rendered.contains("Wednesday"))
        assertTrue(rendered.contains("September 23"))
        val instant = Date.from(Instant.parse("2026-09-23T01:00:00Z"))
        assertEquals("2026-09-23", currentLocalDate("Asia/Shanghai", instant))
        assertEquals("2026-09-22", currentLocalDate("America/Los_Angeles", instant))
    }

    private fun date(id: String, localDate: String, rank: String) =
        TimePointEntity(
            id = id,
            ownerId = "owner",
            type = TimePointType.DATE,
            localDate = localDate,
            title = null,
            rank = rank,
            version = 1,
            reachedAt = null,
            archivedAt = null,
            createdAt = "2026-09-20T00:00:00Z",
            updatedAt = "2026-09-20T00:00:00Z",
        )

    private fun event(id: String) =
        TimePointEntity(
            id = id,
            ownerId = "owner",
            type = TimePointType.EVENT,
            localDate = null,
            title = "Launch checkpoint",
            rank = "1024",
            version = 1,
            reachedAt = null,
            archivedAt = null,
            createdAt = "2026-09-20T00:00:00Z",
            updatedAt = "2026-09-20T00:00:00Z",
        )
}
