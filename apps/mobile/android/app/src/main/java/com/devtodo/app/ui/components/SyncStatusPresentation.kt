package com.devtodo.app.ui.components

import com.devtodo.app.data.sync.LoadProgress
import com.devtodo.app.data.sync.SyncState

internal enum class SyncBannerMode { ERROR, WARNING, COMPACT }

internal data class SyncBannerContent(
    val mode: SyncBannerMode,
    val message: String,
    val detail: String?,
    val showRetry: Boolean = false,
    val showProgress: Boolean = false,
)

/**
 * A background verification is not evidence that the visible cache is stale.
 * Only describe the data as cache while the confirmed cursor is actually old,
 * a page read failed, or the first load has not completed yet.
 */
internal fun resolveSyncBanner(
    state: SyncState,
    progress: LoadProgress,
    cached: Boolean,
    recent: Boolean,
    checking: Boolean,
    pageError: String?,
    pendingCount: Int,
    lastSyncError: String?,
    checkedLabel: String,
    pageVerified: Boolean = false,
): SyncBannerContent {
    val fresh = pageVerified || (recent && progress.complete)

    fun compact(message: String, progress: Boolean = false) = SyncBannerContent(
        mode = SyncBannerMode.COMPACT, message = message, detail = null, showProgress = progress,
    )

    fun error(message: String) = SyncBannerContent(
        mode = SyncBannerMode.ERROR,
        message = message,
        detail = checkedLabel,
        showRetry = true,
    )

    fun warning(
        message: String,
        retry: Boolean = false,
        showProgress: Boolean = false,
    ) = SyncBannerContent(
        mode = SyncBannerMode.WARNING,
        message = message,
        detail = checkedLabel,
        showRetry = retry,
        showProgress = showProgress,
    )

    return when {
        state == SyncState.OFFLINE ->
            error(if (cached) "离线 · 显示本地缓存" else "离线 · 暂无本地缓存")

        state == SyncState.AUTH_REQUIRED -> error("登录需要恢复 · 本地缓存已保留")
        state == SyncState.INCOMPATIBLE -> error("中枢协议不兼容 · 本地缓存已保留")
        state == SyncState.SERVER_UNAVAILABLE -> error("中枢服务暂不可用 · 已保留缓存")
        state == SyncState.ERROR ->
            error(if (cached) "更新失败 · 已保留缓存，稍后自动重试" else "首次加载失败 · 稍后自动重试")

        lastSyncError != null ->
            error(if (cached) "更新失败 · 已保留缓存，稍后自动重试" else "首次加载失败 · 稍后自动重试")

        pageError != null && !fresh ->
            warning("当前页面更新失败 · 已保留缓存", retry = !checking)

        progress.totalPages > 0 ->
            if (cached || pageVerified) compact(
                "后台加载 ${progress.completedPages}/${progress.totalPages} 批 · 已有数据可用",
                progress = true,
            ) else warning("正在加载中枢数据…", showProgress = true)

        !fresh && checking ->
            if (cached) compact("显示缓存 · 正在检查中枢更新", progress = true)
            else warning("正在加载中枢数据…", showProgress = true)

        !fresh ->
            warning(
                if (cached) "数据尚未核验 · 当前内容可能不是最新" else "尚未加载中枢数据",
                retry = !checking,
                showProgress = !cached,
            )

        pendingCount > 0 ->
            compact("$checkedLabel · $pendingCount 项待同步", progress = checking)

        else -> SyncBannerContent(
            mode = SyncBannerMode.COMPACT,
            message = if (checking) "$checkedLabel · 正在检查" else checkedLabel,
            detail = null,
            showProgress = checking,
        )
    }
}
