package com.devtodo.app.ui.theme

import androidx.compose.ui.unit.dp

/**
 * Shared layout rhythm for the native client.
 *
 * M3 Expressive uses contrast in scale and containment, not arbitrary spacing
 * on every screen. Keeping the common values here makes compact and expanded
 * layouts predictable while still allowing a page to opt into a deliberate
 * exception.
 */
object TaskDockSpacing {
    val Page = 16.dp
    val PageWide = 24.dp
    val Section = 24.dp
    val Group = 16.dp
    val Row = 12.dp
    val Compact = 8.dp
    val Control = 48.dp
    val IconTile = 40.dp
    val SmallIconTile = 32.dp
    val BottomAction = 12.dp
}
