package com.devtodo.app.data.sync

const val FRESHNESS_WINDOW_MS = 60_000L

/** A preview is useful content, never proof that the entire cache is current. */
data class PageLoadState(
    val loading: Boolean = false,
    val loadedAt: Long = 0,
    val error: String? = null,
)

fun isRecentlyConfirmed(confirmedAt: Long, now: Long): Boolean =
    confirmedAt > 0 && now >= confirmedAt && now - confirmedAt < FRESHNESS_WINDOW_MS
