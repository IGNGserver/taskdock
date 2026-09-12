package com.devtodo.app.data.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ContractsTest {
    private val json = Json {
        ignoreUnknownKeys = true
    }

    @Test
    fun pullResponseUsesServerNextCursor() {
        val result = json.decodeFromString<PullResult>(
            """{"nextCursor":"42","changes":[],"hasMore":false}"""
        )

        assertEquals("42", result.cursor)
        assertEquals(false, result.hasMore)
    }

    @Test
    fun pushResponseKeepsAppliedResult() {
        val result = json.decodeFromString<PushResult>(
            """{"results":[{"mutationId":"m1","status":"applied","result":{"id":"t1"}}]}"""
        )

        assertEquals("t1", result.results.single().result?.jsonObject?.get("id")?.toString()?.trim('"'))
    }
}
