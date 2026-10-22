package com.devtodo.app.ui.theme

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveLayoutTest {
    @Test
    fun compactPhonePortraitStaysSingleColumnWithoutNavigationRail() {
        val info = calculateAdaptiveInfo(widthDp = 390, heightDp = 844, isLandscape = false)

        assertEquals(WindowWidthClass.COMPACT, info.widthClass)
        assertEquals(WindowHeightClass.MEDIUM, info.heightClass)
        assertFalse(info.isLandscape)
        assertFalse(info.useNavigationRail)
        assertFalse(info.useTwoPane)
        assertFalse(info.isCompactLandscape)
        assertFalse(info.isTablet)
        assertEquals(TaskDockSpacing.Page, info.pageHorizontalPadding)
        assertEquals(TaskDockSpacing.MaxSinglePaneWidth, info.scaffoldMaxWidth)
    }

    @Test
    fun compactPhoneLandscapeEnablesNavigationRailAndTwoPaneWithCompactVerticalChrome() {
        val info = calculateAdaptiveInfo(widthDp = 800, heightDp = 390, isLandscape = true)

        assertEquals(WindowWidthClass.MEDIUM, info.widthClass)
        assertEquals(WindowHeightClass.COMPACT, info.heightClass)
        assertTrue(info.isLandscape)
        assertTrue(info.useNavigationRail)
        assertTrue(info.useTwoPane)
        assertTrue(info.isCompactLandscape)
        assertFalse(info.isTablet)
        assertEquals(TaskDockSpacing.PageWide, info.pageHorizontalPadding)
    }

    @Test
    fun tabletLandscapeUnlocksExpandedTwoPaneAndWideMaxWidth() {
        val info = calculateAdaptiveInfo(widthDp = 1280, heightDp = 800, isLandscape = true)

        assertEquals(WindowWidthClass.EXPANDED, info.widthClass)
        assertEquals(WindowHeightClass.MEDIUM, info.heightClass)
        assertTrue(info.isLandscape)
        assertTrue(info.useNavigationRail)
        assertTrue(info.useTwoPane)
        assertFalse(info.isCompactLandscape)
        assertTrue(info.isTablet)
        assertEquals(TaskDockSpacing.PageExpanded, info.pageHorizontalPadding)
        assertEquals(TaskDockSpacing.PaneGapExpanded, info.paneSpacing)
        assertEquals(TaskDockSpacing.MaxTwoPaneWidth, info.scaffoldMaxWidth)
        assertEquals(0.42f, info.primaryPaneWeight, 0.001f)
        assertEquals(0.58f, info.secondaryPaneWeight, 0.001f)
    }

    @Test
    fun tabletPortraitUsesNavigationRailWhileKeepingSingleColumnBelow840dp() {
        val info = calculateAdaptiveInfo(widthDp = 768, heightDp = 1024, isLandscape = false)

        assertEquals(WindowWidthClass.MEDIUM, info.widthClass)
        assertEquals(WindowHeightClass.EXPANDED, info.heightClass)
        assertFalse(info.isLandscape)
        assertTrue(info.useNavigationRail)
        assertFalse(info.useTwoPane)
        assertTrue(info.isTablet)
        assertEquals(960.dp, info.scaffoldMaxWidth)
    }
}
