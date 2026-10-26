package com.devtodo.app.data.update

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException

internal const val MAX_UPDATE_FEED_BYTES = 4L * 1024 * 1024

/** Bound network and cached input before decoding it; Content-Length alone is not trusted. */
internal fun readUpdateFeed(input: InputStream, size: Long = -1): String {
    if (size > MAX_UPDATE_FEED_BYTES) throw IOException("更新清单过大")
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        total += count
        if (total > MAX_UPDATE_FEED_BYTES) throw IOException("更新清单过大")
        output.write(buffer, 0, count)
    }
    return output.toString("UTF-8")
}
/** RFC 3339 timestamp validation without java.time (TaskDock supports Android API 24). */
internal fun validGeneratedAt(value: String): Boolean {
    val pattern = Regex("""^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$""")
    if (!pattern.matches(value)) return false
    return runCatching {
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply {
            isLenient = false
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.parse(value.substring(0, 19)) != null
    }.getOrDefault(false)
}