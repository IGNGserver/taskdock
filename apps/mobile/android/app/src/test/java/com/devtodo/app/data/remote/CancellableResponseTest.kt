package com.devtodo.app.data.remote

import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class CancellableResponseTest {
    @Test fun timeoutAfterHeadersCancelsTheBodyTransfer() = runBlocking {
        val server = MockWebServer()
        server.start()
        val client = OkHttpClient()
        try {
            server.enqueue(MockResponse().setBody("{\"ok\":true}").setBodyDelay(5, TimeUnit.SECONDS))
            val call = client.newCall(Request.Builder().url(server.url("/")).build())
            val finished = AtomicBoolean(false)
            val result = withTimeoutOrNull(500) { call.awaitBufferedResponse(finished = { finished.set(true) }) }
            result?.close()
            assertNull(result)
            assertTrue(call.isCanceled())
            withTimeout(2000) { while (!finished.get()) delay(10) }
        } finally {
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
            server.shutdown()
        }
    }
}
