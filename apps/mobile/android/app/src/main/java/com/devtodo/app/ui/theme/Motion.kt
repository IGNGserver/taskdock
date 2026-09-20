package com.devtodo.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing

/** M3 standard easing and duration roles. Compose observes system duration scale. */
object TaskDockMotion {
    const val EnterMillis = 300
    const val ExitMillis = 200
    const val NavigationMillis = 200
    val Standard = CubicBezierEasing(0.2f, 0f, 0f, 1f)
}
