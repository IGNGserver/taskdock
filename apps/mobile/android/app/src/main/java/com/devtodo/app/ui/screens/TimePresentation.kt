package com.devtodo.app.ui.screens

import com.devtodo.app.data.local.TimePointEntity
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType
import java.text.DateFormat
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One status section of a scheduled list; sections render in this order. */
internal data class ScheduledStatusGroup<T>(
    val status: TaskStatus,
    val items: List<T>,
)

/** Presentation-only grouping: the stored rank order inside each group stays untouched. */
internal fun <T> groupScheduledByStatus(
    items: List<T>,
    statusOf: (T) -> TaskStatus,
): List<ScheduledStatusGroup<T>> =
    listOf(TaskStatus.IN_PROGRESS, TaskStatus.TODO, TaskStatus.DONE).map { status ->
        ScheduledStatusGroup(status, items.filter { statusOf(it) == status })
    }

/**
 * Swap one entry with its nearest same-status sibling. Status-grouped lists
 * only ever move a row inside its own group, but the reorder mutation must
 * carry every placement of the time point, so the full order is returned.
 */
internal fun <T> moveWithinTaskStatus(
    items: List<T>,
    index: Int,
    direction: Int,
    statusOf: (T) -> TaskStatus,
): List<T>? {
    if (index !in items.indices) return null
    val status = statusOf(items[index])
    var target = index + direction
    while (target in items.indices && statusOf(items[target]) != status) target += direction
    if (target !in items.indices) return null
    val next = items.toMutableList()
    val moved = next[index]
    next[index] = next[target]
    next[target] = moved
    return next
}

/** Presentation-only groups. The original TimePoint rows and their rank stay untouched. */
internal data class TimePointGroups(
    val todayAndUpcoming: List<TimePointEntity>,
    val pastWithTasks: List<TimePointEntity>,
    val olderEmptyDates: List<TimePointEntity>,
    val otherDates: List<TimePointEntity>,
    val events: List<TimePointEntity>,
)

internal fun groupTimePoints(
    points: List<TimePointEntity>,
    visibleTaskCountByPoint: Map<String, Int>,
    todayLocalDate: String,
): TimePointGroups {
    val dates = points.filter { it.type == TimePointType.DATE }
    val validDates = dates.filter { parseLocalDate(it.localDate, "UTC") != null }
    val otherDates = dates.filterNot { parseLocalDate(it.localDate, "UTC") != null }

    fun byDateThenRank(values: List<TimePointEntity>) =
        values.sortedWith(
            compareBy<TimePointEntity>({ it.localDate.orEmpty() }, { it.rank.toLongOrNull() ?: Long.MAX_VALUE })
        )
    fun pastDateThenRank(values: List<TimePointEntity>) =
        values.sortedWith(
            compareByDescending<TimePointEntity> { it.localDate.orEmpty() }
                .thenBy { it.rank.toLongOrNull() ?: Long.MAX_VALUE }
        )

    val todayAndUpcoming =
        byDateThenRank(validDates.filter { it.localDate.orEmpty() >= todayLocalDate })
    val pastDates = validDates.filter { it.localDate.orEmpty() < todayLocalDate }
    val pastWithTasks = pastDateThenRank(
        pastDates.filter { (visibleTaskCountByPoint[it.id] ?: 0) > 0 }
    )
    val olderEmptyDates = pastDateThenRank(
        pastDates.filter { (visibleTaskCountByPoint[it.id] ?: 0) == 0 }
    )

    return TimePointGroups(
        todayAndUpcoming = todayAndUpcoming,
        pastWithTasks = pastWithTasks,
        olderEmptyDates = olderEmptyDates,
        otherDates = byDateThenRank(otherDates),
        events = points.filter { it.type == TimePointType.EVENT },
    )
}

internal fun currentLocalDate(
    timezoneId: String,
    instant: Date = Date(),
): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone(timezoneId)
    }.format(instant)

/** Format an ISO calendar date in its configured zone without interpreting it as a UTC instant. */
internal fun formatLocalDate(
    localDate: String?,
    timezoneId: String,
    locale: Locale = Locale.getDefault(),
): String {
    val parsed = parseLocalDate(localDate, timezoneId) ?: return localDate ?: "未设置日期"
    return DateFormat.getDateInstance(DateFormat.FULL, locale)
        .apply { timeZone = TimeZone.getTimeZone(timezoneId) }
        .format(parsed)
}

private fun parseLocalDate(localDate: String?, timezoneId: String): Date? {
    if (localDate == null || !ISO_LOCAL_DATE.matches(localDate)) return null
    val parser =
        SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone(timezoneId)
        }
    val position = ParsePosition(0)
    val parsed = parser.parse(localDate, position) ?: return null
    return parsed.takeIf { position.index == localDate.length }
}

private val ISO_LOCAL_DATE = Regex("\\d{4}-\\d{2}-\\d{2}")
