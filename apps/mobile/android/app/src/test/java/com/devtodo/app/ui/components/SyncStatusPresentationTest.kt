package com.devtodo.app.ui.components

import com.devtodo.app.data.sync.LoadProgress
import com.devtodo.app.data.sync.SyncState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncStatusPresentationTest {
    private val checked = "上次核验 10-21 14:32"

    private fun resolve(
        state: SyncState = SyncState.IDLE,
        progress: LoadProgress = LoadProgress("ready", complete = true),
        cached: Boolean = true,
        recent: Boolean = true,
        checking: Boolean = false,
        pageError: String? = null,
        pendingCount: Int = 0,
        lastSyncError: String? = null,
        pageVerified: Boolean = false,
    ) = resolveSyncBanner(
        state = state,
        progress = progress,
        cached = cached,
        recent = recent,
        checking = checking,
        pageError = pageError,
        pendingCount = pendingCount,
        lastSyncError = lastSyncError,
        checkedLabel = checked,
        pageVerified = pageVerified,
    )

    @Test
    fun freshDataWhileCheckingNeverClaimsCache() {
        val content = resolve(state = SyncState.SYNCING, checking = true)

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertTrue(content.message.contains("上次核验"))
        assertFalse(content.message.contains("缓存"))
        assertTrue(content.showProgress)
        assertFalse(content.showRetry)
    }

    @Test
    fun freshIdleCollapsesToLastCheck() {
        val content = resolve()

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertEquals(checked, content.message)
        assertFalse(content.showProgress)
    }

    @Test
    fun staleDataWhileCheckingIsDescribedAsCache() {
        val content = resolve(state = SyncState.SYNCING, recent = false, checking = true)

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertEquals("显示缓存 · 正在检查中枢更新", content.message)
        assertTrue(content.showProgress)
        assertFalse(content.showRetry)
    }

    @Test
    fun staleIdleOffersRetry() {
        val content = resolve(recent = false)

        assertEquals(SyncBannerMode.WARNING, content.mode)
        assertEquals("数据尚未核验 · 当前内容可能不是最新", content.message)
        assertTrue(content.showRetry)
    }

    @Test
    fun offlineStillUsesErrorBanner() {
        val content = resolve(state = SyncState.OFFLINE, recent = false)

        assertEquals(SyncBannerMode.ERROR, content.mode)
        assertEquals("离线 · 显示本地缓存", content.message)
        assertTrue(content.showRetry)
    }

    @Test
    fun bootstrapProgressTakesPrecedence() {
        val content = resolve(
            progress = LoadProgress("bootstrap", completedPages = 1, totalPages = 3),
            recent = false,
        )

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertEquals("后台加载 1/3 批 · 已有数据可用", content.message)
        assertTrue(content.showProgress)
        assertFalse(content.showRetry)
    }

    @Test
    fun pendingWorkStaysVisibleWithoutHidingFreshness() {
        val content = resolve(pendingCount = 2)

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertEquals("$checked · 2 项待同步", content.message)
        assertFalse(content.showRetry)
    }

    @Test
    fun pageFailureIsIgnoredWhileGlobalDataIsFresh() {
        val content = resolve(pageError = "preview failed")

        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertFalse(content.message.contains("更新失败"))
    }

    @Test
    fun pageFailureIsShownWhenGlobalDataIsStale() {
        val content = resolve(recent = false, pageError = "preview failed")

        assertEquals(SyncBannerMode.WARNING, content.mode)
        assertEquals("当前页面更新失败 · 已保留缓存", content.message)
        assertTrue(content.showRetry)
    }

    @Test
    fun emptyCacheCheckingSaysLoadingInsteadOfCache() {
        val content = resolve(cached = false, recent = false, checking = true)

        assertEquals(SyncBannerMode.WARNING, content.mode)
        assertEquals("正在加载中枢数据…", content.message)
        assertTrue(content.showProgress)
    }

    @Test
    fun emptyCacheIdleAsksForRetry() {
        val content = resolve(cached = false, recent = false)

        assertEquals(SyncBannerMode.WARNING, content.mode)
        assertEquals("尚未加载中枢数据", content.message)
        assertTrue(content.showRetry)
    }

    @Test
    fun incompleteProgressIsNotProofOfFreshness() {
        val content = resolve(progress = LoadProgress("cache", complete = false))

        assertEquals(SyncBannerMode.WARNING, content.mode)
        assertEquals("数据尚未核验 · 当前内容可能不是最新", content.message)
    }

    @Test
    fun lastSyncErrorBecomesAnErrorEvenWhenStateIsIdle() {
        val content = resolve(lastSyncError = "hub rejected")

        assertEquals(SyncBannerMode.ERROR, content.mode)
        assertEquals("更新失败 · 已保留缓存，稍后自动重试", content.message)
    }

    @Test
    fun verifiedPageDoesNotWaitForEntireAccountToBecomeFresh() {
        val content = resolve(recent = false, progress = LoadProgress("cache"), pageVerified = true)
        assertEquals(SyncBannerMode.COMPACT, content.mode)
        assertFalse(content.message.contains("尚未核验"))
    }

    @Test
    fun verifiedPageNeverHidesAuthenticationFailure() {
        assertEquals(SyncBannerMode.ERROR, resolve(state = SyncState.AUTH_REQUIRED, pageVerified = true).mode)
    }
}
