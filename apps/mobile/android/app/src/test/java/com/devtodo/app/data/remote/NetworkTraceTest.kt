package com.devtodo.app.data.remote

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import okio.Buffer
import okio.GzipSink
import okio.buffer

class NetworkTraceTest {
    @Test fun transparentGzipReportsWireBytesRatherThanDecodedCharacters() {
        val server = MockWebServer()
        val events = mutableListOf<String>()
        val client = OkHttpClient.Builder().eventListenerFactory { NetworkTrace { events.add(it) } }.build()
        try {
            server.start()
            val text = "x".repeat(5000)
            val encoded = Buffer()
            GzipSink(encoded).buffer().use { it.writeUtf8(text) }
            val size = encoded.size
            server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody(encoded))
            client.newCall(Request.Builder().url(server.url("/api/v2/sync/pull")).build()).execute().use {
                assertEquals(text, it.body!!.string())
            }
            assertTrue(events.single().contains("encoding=gzip"))
            assertTrue(events.single().contains("wireBytes=$size"))
            assertTrue(size < text.length)
        } finally {
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
            server.shutdown()
        }
    }

    @Test fun traceHasStagesAndByteCountsButNeverUrlsOrHeaders() {
        val server = MockWebServer()
        val events = mutableListOf<String>()
        val client = OkHttpClient.Builder().eventListenerFactory { NetworkTrace { events.add(it) } }.build()
        try {
            server.start()
            server.enqueue(MockResponse().setBody("sensitive body").setHeader("X-Request-Id", "request-42"))
            val request = Request.Builder().url(server.url("/api/v2/tasks/private-id?private=query"))
                .header("Authorization", "Bearer private-token").build()
            client.newCall(request).execute().use { it.body!!.string() }
            val event = events.single()
            assertTrue(event.contains("route=task"))
            assertTrue(event.contains("wireBytes=14"))
            assertTrue(event.contains("requestId=request-42"))
            assertTrue(event.contains("dnsMs="))
            assertFalse(event.contains("private"))
            assertFalse(event.contains("sensitive"))
            assertFalse(event.contains(server.hostName))
        } finally {
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
            server.shutdown()
        }
    }
}
