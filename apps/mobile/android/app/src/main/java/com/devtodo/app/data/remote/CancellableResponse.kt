package com.devtodo.app.data.remote

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import kotlin.coroutines.resumeWithException

/** Keep cancellation attached until the body, not merely its headers, arrives. */
internal suspend fun Call.awaitBufferedResponse(
    finished: () -> Unit = {},
    measured: (Long, Long) -> Unit = { _, _ -> },
): Response = suspendCancellableCoroutine { continuation ->
    val started = System.nanoTime()
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
            finished()
            if (continuation.isActive) continuation.resumeWithException(error)
        }

        override fun onResponse(call: Call, response: Response) {
            try {
                // Every ApiClient endpoint decodes a complete JSON body. Reading
                // it on OkHttp's callback thread leaves the suspension cancellable
                // during blackholes/throttled transfers and releases the socket.
                val buffered = response.use {
                    val body = it.body
                    val type = body?.contentType()
                    val bytes = body?.bytes() ?: ByteArray(0)
                    measured((System.nanoTime() - started) / 1_000_000, bytes.size.toLong())
                    it.newBuilder().body(bytes.toResponseBody(type)).build()
                }
                continuation.resume(buffered, onCancellation = { _, value, _ -> value.close() })
            } catch (error: Exception) {
                if (continuation.isActive) continuation.resumeWithException(error)
            } finally {
                finished()
            }
        }
    })
}
