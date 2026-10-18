package com.devtodo.app.data.sync

import org.junit.Assert.*
import org.junit.Test

class FreshnessTest {
    @Test fun cachedOrFutureTimestampIsNotProofOfFreshness() {
        assertFalse(isRecentlyConfirmed(0, 100_000))
        assertFalse(isRecentlyConfirmed(100_000, 99_000))
        assertFalse(isRecentlyConfirmed(1_000, 61_000))
        assertTrue(isRecentlyConfirmed(1_000, 60_999))
    }
}
