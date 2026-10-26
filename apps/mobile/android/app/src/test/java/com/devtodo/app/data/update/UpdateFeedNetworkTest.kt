package com.devtodo.app.data.update

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class UpdateFeedNetworkTest {
    private val feed = """{"schemaVersion":1,"repository":"IGNGserver/taskdock","generatedAt":"2026-10-25T00:00:00Z","releases":[]}"""

    @Test fun etagCacheIsReusedAfterRestartAndManualRequestsAreThrottled() = runBlocking {
        val directory = Files.createTempDirectory("taskdock-updates").toFile()
        val server = MockWebServer()
        server.start()
        try {
            var now = 1_000_000L
            fun source() = GitHubReleaseSource(OkHttpClient(), releasesUrl = server.url("/updates.json").toString(),
                cacheDirectory = directory, clock = { now }, jitter = { 0 })
            val current = requireNotNull(SemanticVersion.parse("2.0.0"))
            server.enqueue(MockResponse().setBody(feed).setHeader("ETag", "v1"))
            assertNull(source().latestUpdate(current, UpdateChannel.STABLE))
            assertNull(server.takeRequest().getHeader("If-None-Match"))
            val restored = source()
            val rejected = runCatching { restored.latestUpdate(current, UpdateChannel.STABLE) }.exceptionOrNull()
            assertTrue(rejected is UpdateException)
            assertEquals(1, server.requestCount)
            now += 60_000
            server.enqueue(MockResponse().setResponseCode(304))
            assertNull(restored.latestUpdate(current, UpdateChannel.STABLE))
            assertEquals("v1", server.takeRequest().getHeader("If-None-Match"))
            assertNull(source().latestUpdate(current, UpdateChannel.STABLE, automatic = true))
            assertEquals(2, server.requestCount)
        } finally { server.shutdown(); directory.deleteRecursively() }
    }

    @Test fun rateLimitCooldownPersistsAcrossRestarts() = runBlocking {
        val directory = Files.createTempDirectory("taskdock-limited").toFile()
        val server = MockWebServer()
        server.start()
        try {
            var now = 1_000_000L
            fun source() = GitHubReleaseSource(OkHttpClient(), releasesUrl = server.url("/updates.json").toString(),
                cacheDirectory = directory, clock = { now })
            val current = requireNotNull(SemanticVersion.parse("2.0.0"))
            server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "600"))
            assertTrue(runCatching { source().latestUpdate(current, UpdateChannel.STABLE) }.isFailure)
            now += 60_000
            assertTrue(runCatching { source().latestUpdate(current, UpdateChannel.STABLE) }.isFailure)
            assertEquals(1, server.requestCount)
        } finally { server.shutdown(); directory.deleteRecursively() }
    }
    @Test fun channelSwitchDuringCooldownUsesCacheAndInstallationRejectsStalePreview() = runBlocking {
        val directory = Files.createTempDirectory("taskdock-channel").toFile()
        val server = MockWebServer()
        server.start()
        try {
            val body = """{"schemaVersion":1,"repository":"IGNGserver/taskdock","generatedAt":"2026-10-25T00:00:00Z","releases":[{"tag_name":"v2.1.0-rc.1","prerelease":true,"assets":[{"name":"TaskDock-2.1.0-rc.1-android.apk","size":100,"state":"uploaded","digest":"sha256:${"a".repeat(64)}","browser_download_url":"https://github.com/IGNGserver/taskdock/releases/download/v2.1.0-rc.1/TaskDock-2.1.0-rc.1-android.apk"}]}]}"""
            val source = GitHubReleaseSource(OkHttpClient(), releasesUrl = server.url("/updates.json").toString(),
                cacheDirectory = directory, clock = { 1_000_000L })
            server.enqueue(MockResponse().setBody(body))
            val current = requireNotNull(SemanticVersion.parse("2.0.0"))
            val preview = requireNotNull(source.latestUpdate(current, UpdateChannel.PRERELEASE))
            assertNull(source.cachedUpdate(current, UpdateChannel.STABLE, 1))
            assertFalse(updateAllowed(preview, "2.0.0", UpdateChannel.STABLE))
            assertTrue(updateAllowed(preview, "2.0.0", UpdateChannel.PRERELEASE))
            assertEquals(1, server.requestCount)
        } finally { server.shutdown(); directory.deleteRecursively() }
    }}