package com.devtodo.app.data.update

import org.junit.Assert.*
import org.junit.Test

class UpdateFetchPolicyTest {
    @Test fun automaticTtlAndManualDebounceAreIndependent() {
        val state = UpdateFetchPolicy().attempted(1_000).succeeded(1_000, 900_000)
        assertEquals(61_000L, state.allowedAt(false))
        assertEquals(1_000L + 6 * 60 * 60_000 + 900_000, state.allowedAt(true))
    }
    @Test fun retryHeadersAndRepeatedFailuresSurviveStateRecreation() {
        val state = UpdateFetchPolicy().attempted(1_000).failed(1_000, "180", "300")
        assertEquals(300_000L, state.retryAt)
        assertEquals(300_000L, state.allowedAt(false))
        val restored = UpdateFetchPolicy(state.lastAttempt, state.nextAutomatic, state.retryAt, state.failures)
        assertEquals(420_000L, restored.attempted(300_000).failed(300_000).retryAt)
        assertEquals(0, restored.succeeded(300_000, 0).failures)
    }
    @Test fun retryAfterHttpDateIsRespected() {
        val state = UpdateFetchPolicy().failed(0, "Thu, 01 Jan 1970 00:05:00 GMT")
        assertEquals(300_000L, state.retryAt)
    }
}