package com.devtodo.app.data.update

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class UpdateFeedInputTest {
    @Test fun refusesOversizedDeclaredAndChunkedBodies() {
        assertThrows(IOException::class.java) { readUpdateFeed(ByteArrayInputStream(byteArrayOf()), MAX_UPDATE_FEED_BYTES + 1) }
        assertThrows(IOException::class.java) { readUpdateFeed(ByteArrayInputStream(ByteArray((MAX_UPDATE_FEED_BYTES + 1).toInt()))) }
        assertEquals("{}", readUpdateFeed(ByteArrayInputStream("{}".toByteArray())))
    }
    @Test fun validatesPublisherTimestampsWithoutAndroid26Apis() {
        assertTrue(validGeneratedAt("2026-10-25T00:00:00Z"))
        assertTrue(validGeneratedAt("2026-10-25T00:00:00.123456+00:00"))
        assertFalse(validGeneratedAt("2026-02-30T00:00:00Z"))
        assertFalse(validGeneratedAt("2026-10-25T25:00:00Z"))
        assertFalse(validGeneratedAt("2026-10-25T00:00:00+25:00"))
        assertFalse(validGeneratedAt("2026-10-25"))
    }}