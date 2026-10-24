package com.devtodo.app.data.sync

/**
 * Two foreground verification intervals. A single slow round must not make
 * fresh data look stale while the next incremental pull is still running.
 */
const val FRESHNESS_WINDOW_MS = 120_000L

/** A preview is useful content, never proof that the entire cache is current. */
data class PageLoadState(
    val loading: Boolean = false,
    val loadedAt: Long = 0,
    val error: String? = null,
)

fun isRecentlyConfirmed(confirmedAt: Long, now: Long, windowMs: Long = FRESHNESS_WINDOW_MS): Boolean =
    confirmedAt > 0 && now >= confirmedAt && now - confirmedAt < windowMs
