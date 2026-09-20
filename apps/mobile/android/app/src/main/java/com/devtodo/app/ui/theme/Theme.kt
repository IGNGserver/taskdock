package com.devtodo.app.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

private val LightColorScheme =
    lightColorScheme(
        primary = M3LightPrimary,
        onPrimary = M3LightOnPrimary,
        primaryContainer = M3LightPrimaryContainer,
        onPrimaryContainer = M3LightOnPrimaryContainer,
        inversePrimary = M3LightInversePrimary,
        secondary = M3LightSecondary,
        onSecondary = M3LightOnSecondary,
        secondaryContainer = M3LightSecondaryContainer,
        onSecondaryContainer = M3LightOnSecondaryContainer,
        tertiary = M3LightTertiary,
        onTertiary = M3LightOnTertiary,
        tertiaryContainer = M3LightTertiaryContainer,
        onTertiaryContainer = M3LightOnTertiaryContainer,
        background = M3LightBackground,
        onBackground = M3LightOnBackground,
        surface = M3LightSurface,
        onSurface = M3LightOnSurface,
        surfaceVariant = M3LightSurfaceVariant,
        onSurfaceVariant = M3LightOnSurfaceVariant,
        surfaceTint = M3LightSurfaceTint,
        inverseSurface = M3LightInverseSurface,
        inverseOnSurface = M3LightInverseOnSurface,
        surfaceDim = M3LightSurfaceDim,
        surfaceBright = M3LightSurfaceBright,
        surfaceContainerLowest = M3LightSurfaceContainerLowest,
        surfaceContainerLow = M3LightSurfaceContainerLow,
        surfaceContainer = M3LightSurfaceContainer,
        surfaceContainerHigh = M3LightSurfaceContainerHigh,
        surfaceContainerHighest = M3LightSurfaceContainerHighest,
        outline = M3LightOutline,
        outlineVariant = M3LightOutlineVariant,
        error = M3LightError,
        onError = M3LightOnError,
        errorContainer = M3LightErrorContainer,
        onErrorContainer = M3LightOnErrorContainer,
    )

private val DarkColorScheme =
    darkColorScheme(
        primary = M3DarkPrimary,
        onPrimary = M3DarkOnPrimary,
        primaryContainer = M3DarkPrimaryContainer,
        onPrimaryContainer = M3DarkOnPrimaryContainer,
        inversePrimary = M3DarkInversePrimary,
        secondary = M3DarkSecondary,
        onSecondary = M3DarkOnSecondary,
        secondaryContainer = M3DarkSecondaryContainer,
        onSecondaryContainer = M3DarkOnSecondaryContainer,
        tertiary = M3DarkTertiary,
        onTertiary = M3DarkOnTertiary,
        tertiaryContainer = M3DarkTertiaryContainer,
        onTertiaryContainer = M3DarkOnTertiaryContainer,
        background = M3DarkBackground,
        onBackground = M3DarkOnBackground,
        surface = M3DarkSurface,
        onSurface = M3DarkOnSurface,
        surfaceVariant = M3DarkSurfaceVariant,
        onSurfaceVariant = M3DarkOnSurfaceVariant,
        surfaceTint = M3DarkSurfaceTint,
        inverseSurface = M3DarkInverseSurface,
        inverseOnSurface = M3DarkInverseOnSurface,
        surfaceDim = M3DarkSurfaceDim,
        surfaceBright = M3DarkSurfaceBright,
        surfaceContainerLowest = M3DarkSurfaceContainerLowest,
        surfaceContainerLow = M3DarkSurfaceContainerLow,
        surfaceContainer = M3DarkSurfaceContainer,
        surfaceContainerHigh = M3DarkSurfaceContainerHigh,
        surfaceContainerHighest = M3DarkSurfaceContainerHighest,
        outline = M3DarkOutline,
        outlineVariant = M3DarkOutlineVariant,
        error = M3DarkError,
        onError = M3DarkOnError,
        errorContainer = M3DarkErrorContainer,
        onErrorContainer = M3DarkOnErrorContainer,
    )

/*
 * Material 3 Expressive corner scale.
 *
 * The full M3E scale (none/xs/sm/md/lg/lg-increased/xl/xl-increased/xxl)
 * lives in `packages/ui/src/tokens.css`; it is the canonical source. Compose's
 * `Shapes` class only exposes five slots (extraSmall, small, medium, large,
 * extraLarge), so the increased/xxl steps cannot be expressed here without
 * subclassing — the nearest M3E step is mapped into each available slot.
 */
private val DevTodoShapes =
    Shapes(
        extraSmall = RoundedCornerShape(4.dp),
        small = RoundedCornerShape(8.dp),
        medium = RoundedCornerShape(12.dp),
        large = RoundedCornerShape(16.dp),
        extraLarge = RoundedCornerShape(28.dp),
    )

enum class ThemeMode {
    SYSTEM,
    LIGHT,
    DARK,
}

@Composable
fun DevTodoTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = true,
    pureBlack: Boolean = false,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val systemDark = isSystemInDarkTheme()
    val isDark =
        when (themeMode) {
            ThemeMode.SYSTEM -> systemDark
            ThemeMode.LIGHT -> false
            ThemeMode.DARK -> true
        }

    val baseScheme: ColorScheme =
        when {
            dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            }
            isDark -> DarkColorScheme
            else -> LightColorScheme
        }

    val finalScheme =
        if (isDark && pureBlack) {
            baseScheme.copy(surface = Color.Black, background = Color.Black)
        } else {
            baseScheme
        }

    val view = LocalView.current
    SideEffect {
        if (!view.isInEditMode) {
            context.findActivity()?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !isDark
                    isAppearanceLightNavigationBars = !isDark
                }
            }
        }
    }
    MaterialTheme(
        colorScheme = finalScheme,
        typography = DevTodoTypography,
        shapes = DevTodoShapes,
        content = content,
    )
}

private fun Context.findActivity(): Activity? =
    when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
