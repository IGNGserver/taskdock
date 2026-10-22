package com.devtodo.app.ui.theme

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Material 3 adaptive window width classes.
 * - COMPACT: < 600.dp (phones in portrait)
 * - MEDIUM: 600.dp .. 839.dp (tablets in portrait, large foldables, phones in landscape)
 * - EXPANDED: >= 840.dp (tablets in landscape, desktop windows)
 */
enum class WindowWidthClass {
    COMPACT,
    MEDIUM,
    EXPANDED,
}

/**
 * Material 3 adaptive window height classes.
 * - COMPACT: < 480.dp (phones in landscape)
 * - MEDIUM: 480.dp .. 899.dp (phones in portrait, tablets in landscape)
 * - EXPANDED: >= 900.dp (tablets in portrait)
 */
enum class WindowHeightClass {
    COMPACT,
    MEDIUM,
    EXPANDED,
}

/**
 * Adaptive layout metrics and posture decisions shared across the Android client.
 *
 * Portrait compact phones preserve 100% of the existing single-column flow, while
 * landscape phones and tablets unlock NavigationRail, list-detail two-pane splits,
 * horizontal Kanban lanes, and compact vertical chrome.
 */
@Immutable
data class TaskDockAdaptiveInfo(
    val widthDp: Int,
    val heightDp: Int,
    val widthClass: WindowWidthClass,
    val heightClass: WindowHeightClass,
    val isLandscape: Boolean,
) {
    /** Show a persistent left NavigationRail on wide screens (>= 600dp) to save vertical space. */
    val useNavigationRail: Boolean
        get() = widthClass != WindowWidthClass.COMPACT

    /** Phone in landscape: wide enough for side-by-side panes, but tight on vertical height. */
    val isCompactLandscape: Boolean
        get() = isLandscape && heightClass == WindowHeightClass.COMPACT

    /** Tablet / unfolded posture with both horizontal and vertical breathing room. */
    val isTablet: Boolean
        get() = widthDp >= 600 && heightDp >= 480

    /**
     * Enable list-detail or master-detail two-pane layout when horizontal width
     * can comfortably host two columns (>= 720dp, or >= 600dp in landscape).
     */
    val useTwoPane: Boolean
        get() = widthDp >= 840 || (isLandscape && widthDp >= 640)

    /** Outer horizontal padding for page content. */
    val pageHorizontalPadding: Dp
        get() = when {
            widthClass == WindowWidthClass.EXPANDED -> TaskDockSpacing.PageExpanded
            widthClass == WindowWidthClass.MEDIUM -> TaskDockSpacing.PageWide
            else -> TaskDockSpacing.Page
        }

    /** Gap between left and right panes in a two-pane split. */
    val paneSpacing: Dp
        get() = when (widthClass) {
            WindowWidthClass.EXPANDED -> TaskDockSpacing.PaneGapExpanded
            WindowWidthClass.MEDIUM -> TaskDockSpacing.PaneGapMedium
            WindowWidthClass.COMPACT -> TaskDockSpacing.Group
        }

    /** Max container width inside WorkspaceScaffold. */
    val scaffoldMaxWidth: Dp
        get() = when {
            useTwoPane -> TaskDockSpacing.MaxTwoPaneWidth
            widthClass == WindowWidthClass.MEDIUM -> 960.dp
            else -> TaskDockSpacing.MaxSinglePaneWidth
        }

    /** Fraction of width allocated to the primary/list pane in two-pane mode. */
    val primaryPaneWeight: Float
        get() = when {
            widthDp >= 1040 -> 0.42f
            widthDp >= 840 -> 0.45f
            else -> 0.46f
        }

    val secondaryPaneWeight: Float
        get() = 1f - primaryPaneWeight
}

/** Pure calculation helper so unit tests can verify breakpoints without an Android Configuration. */
fun calculateAdaptiveInfo(
    widthDp: Int,
    heightDp: Int,
    isLandscape: Boolean = widthDp > heightDp,
): TaskDockAdaptiveInfo {
    val widthClass = when {
        widthDp < 600 -> WindowWidthClass.COMPACT
        widthDp < 840 -> WindowWidthClass.MEDIUM
        else -> WindowWidthClass.EXPANDED
    }
    val heightClass = when {
        heightDp < 480 -> WindowHeightClass.COMPACT
        heightDp < 900 -> WindowHeightClass.MEDIUM
        else -> WindowHeightClass.EXPANDED
    }
    return TaskDockAdaptiveInfo(
        widthDp = widthDp,
        heightDp = heightDp,
        widthClass = widthClass,
        heightClass = heightClass,
        isLandscape = isLandscape,
    )
}

val LocalAdaptiveInfo = staticCompositionLocalOf {
    calculateAdaptiveInfo(widthDp = 390, heightDp = 844, isLandscape = false)
}

@Composable
fun rememberTaskDockAdaptiveInfo(): TaskDockAdaptiveInfo {
    val configuration = LocalConfiguration.current
    val widthDp = configuration.screenWidthDp
    val heightDp = configuration.screenHeightDp
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE || widthDp > heightDp
    return remember(widthDp, heightDp, isLandscape) {
        calculateAdaptiveInfo(widthDp = widthDp, heightDp = heightDp, isLandscape = isLandscape)
    }
}
