package com.devtodo.app.data.remote

/** No device-type guesses: require repeated observed slow transfers to downshift. */
internal class NetworkQuality {
    private var slowSamples = 0
    @get:Synchronized val constrained: Boolean get() = slowSamples >= 2

    @Synchronized fun record(milliseconds: Long, bytes: Long) {
        if (bytes <= 0) return
        val slow = milliseconds > 1500 && (bytes < 16_384 || bytes * 1000 / milliseconds < 65_536)
        slowSamples = if (slow) (slowSamples + 1).coerceAtMost(3) else (slowSamples - 1).coerceAtLeast(0)
    }
}
