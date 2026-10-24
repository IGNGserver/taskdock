package com.devtodo.app.data.sync

import org.junit.Assert.*
import org.junit.Test

class FreshnessTest {
    @Test fun cachedOrFutureTimestampIsNotProofOfFreshness() {
        assertFalse(isRecentlyConfirmed(0, 100_000))
        assertFalse(isRecentlyConfirmed(100_000, 99_000))
        assertFalse(isRecentlyConfirmed(1_000, 121_000))
        assertTrue(isRecentlyConfirmed(1_000, 120_999))
    }
    @Test fun constrainedVerificationDoesNotOscillateBeforeTheNextScheduledCheck() {
        assertTrue(isRecentlyConfirmed(1_000, 181_000, windowMs = 360_000))
        assertFalse(isRecentlyConfirmed(1_000, 361_000, windowMs = 360_000))
    }
}
