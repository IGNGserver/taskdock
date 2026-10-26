package com.devtodo.app.data.update

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Pure scheduling policy; callers persist all fields, including the server cooldown. */
internal data class UpdateFetchPolicy(
    val lastAttempt: Long = 0,
    val nextAutomatic: Long = 0,
    val retryAt: Long = 0,
    val failures: Int = 0,
) {
    fun allowedAt(automatic: Boolean): Long = maxOf(
        retryAt,
        if (lastAttempt > 0) lastAttempt + 60_000 else 0,
        if (automatic) nextAutomatic else 0,
    )

    fun attempted(now: Long) = copy(lastAttempt = now)

    fun succeeded(now: Long, jitter: Long) = copy(
        nextAutomatic = now + 6 * 60 * 60_000 + jitter.coerceIn(0, 15 * 60_000),
        retryAt = 0,
        failures = 0,
    )

    fun failed(now: Long, retryAfter: String? = null, reset: String? = null): UpdateFetchPolicy {
        val count = (failures + 1).coerceAtMost(16)
        val backoff = (60_000L * (1L shl (count - 1))).coerceAtMost(6 * 60 * 60_000L)
        val after = retryAfter?.toLongOrNull()?.takeIf { it >= 0 }?.let { now + it.coerceAtMost(604800) * 1000 }
            ?: retryAfter?.let { value -> runCatching {
                SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("GMT")
                }.parse(value)?.time
            }.getOrNull() }
        val resetAt = reset?.toLongOrNull()?.takeIf { it in 0..Long.MAX_VALUE / 1000 }?.times(1000)
        return copy(retryAt = maxOf(now + backoff, after ?: 0, resetAt ?: 0), failures = count)
    }
}