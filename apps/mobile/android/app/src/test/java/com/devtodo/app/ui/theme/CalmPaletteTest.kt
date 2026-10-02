package com.devtodo.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test

class CalmPaletteTest {
    private fun contrast(first: Color, second: Color): Float {
        val a = first.luminance(); val b = second.luminance()
        return (maxOf(a, b) + 0.05f) / (minOf(a, b) + 0.05f)
    }

    @Test fun fallbackTextAndStatusControlsKeepTheirContrastInBothSchemes() {
        val texts = listOf(
            M3LightOnSurface to M3LightSurface,
            M3LightOnSurfaceVariant to M3LightSurfaceContainerLow,
            M3LightOnPrimary to M3LightPrimary,
            M3LightOnPrimaryContainer to M3LightPrimaryContainer,
            M3DarkOnSurface to M3DarkSurface,
            M3DarkOnSurfaceVariant to M3DarkSurfaceContainerLow,
            M3DarkOnPrimary to M3DarkPrimary,
            M3DarkOnPrimaryContainer to M3DarkPrimaryContainer,
        )
        texts.forEach { (foreground, background) -> assertTrue("text contrast", contrast(foreground, background) >= 4.5f) }
        listOf(
            M3LightOutline to M3LightSurfaceContainerLow,
            M3LightPrimary to M3LightSurfaceContainerLow,
            M3DarkOutline to M3DarkSurfaceContainerLow,
            M3DarkPrimary to M3DarkSurfaceContainerLow,
        ).forEach { (foreground, background) -> assertTrue("status circle contrast", contrast(foreground, background) >= 3f) }
    }
}
