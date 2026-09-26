package com.devtodo.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween

/**
 * Material 3 Expressive motion tokens & physics specifications.
 * Mirrored from packages/ui/src/tokens.css and scripts/motion-tokens.ts.
 */
object TaskDockMotion {
    // Legacy / Tween timings
    const val Short1 = 50
    const val Short2 = 100
    const val Short3 = 150
    const val Short4 = 200
    const val Medium1 = 250
    const val Medium2 = 300
    const val Medium3 = 350
    const val Medium4 = 400
    const val Long1 = 450
    const val Long2 = 500

    const val EnterMillis = 300
    const val ExitMillis = 200
    const val NavigationMillis = 250

    // Easings
    val Standard = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val StandardDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val StandardAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    // Material 3 Expressive Spring Physics Specs
    // Spatial Fast: crisp UI feedback (toggles, chips, checkboxes)
    fun <T> springSpatialFast() = spring<T>(
        dampingRatio = 0.85f,
        stiffness = 1200f
    )

    // Spatial Regular: container transformations, sheet dismiss, navigation cards
    fun <T> springSpatial() = spring<T>(
        dampingRatio = 0.82f,
        stiffness = 650f
    )

    // Spatial Expressive Bouncy: items appearing, playful FAB interactions (Immich / Breezy feel)
    fun <T> springBouncy() = spring<T>(
        dampingRatio = Spring.DampingRatioLowBouncy,
        stiffness = Spring.StiffnessMediumLow
    )

    // Gentle fluid morph: expanding/collapsing sheets and pills
    fun <T> springFluid() = spring<T>(
        dampingRatio = Spring.DampingRatioNoBouncy,
        stiffness = Spring.StiffnessLow
    )

    // Stagger item enter animation with expressive slight bounce
    fun <T> springStagger() = spring<T>(
        dampingRatio = 0.8f,
        stiffness = 800f
    )

    // Standard tweens for fallback transitions
    fun <T> tweenEnter() = tween<T>(EnterMillis, easing = StandardDecelerate)
    fun <T> tweenExit() = tween<T>(ExitMillis, easing = StandardAccelerate)
}
