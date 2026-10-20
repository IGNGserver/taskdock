package com.devtodo.app.data.remote

import org.junit.Assert.*
import org.junit.Test

class NetworkQualityTest {
    @Test fun repeatedSlowTransfersDownshiftAndFastTransfersRecover() {
        val quality = NetworkQuality()
        quality.record(3000, 1000)
        assertFalse(quality.constrained)
        quality.record(4000, 100_000)
        assertTrue(quality.constrained)
        quality.record(100, 100_000)
        assertFalse(quality.constrained)
    }

    @Test fun largeFastTransfersDoNotCountAsWeakNetwork() {
        val quality = NetworkQuality()
        repeat(5) { quality.record(2000, 1_000_000) }
        assertFalse(quality.constrained)
    }
}
