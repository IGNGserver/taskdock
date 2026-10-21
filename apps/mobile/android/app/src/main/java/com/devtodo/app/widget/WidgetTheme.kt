package com.devtodo.app.widget

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.glance.GlanceTheme
import androidx.glance.color.ColorProviders
import androidx.glance.material3.ColorProviders as Material3ColorProviders
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.ui.theme.DevTodoDarkColorScheme
import com.devtodo.app.ui.theme.DevTodoLightColorScheme

data class WidgetAppearance(
    val colors: ColorProviders,
    val isDark: Boolean,
)

/**
 * The app owns the theme setting, but a widget is rendered while the activity
 * is absent. Resolve the same SYSTEM/LIGHT/DARK choice, dynamic colour toggle
 * and AMOLED preference from the plain preference store used by the app.
 *
 * A single resolved scheme is passed to Glance as both light and dark so the
 * launcher's own night mode cannot silently override an explicit app theme.
 */
fun resolveWidgetAppearance(context: Context): WidgetAppearance {
    val auth = SecureAuthManager(context)
    val systemDark = (context.resources.configuration.uiMode and
        Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val isDark = when (auth.themeMode) {
        "LIGHT" -> false
        "DARK" -> true
        else -> systemDark
    }
    val useDynamic = auth.dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val base: ColorScheme = when {
        useDynamic -> if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        isDark -> DevTodoDarkColorScheme
        else -> DevTodoLightColorScheme
    }
    val scheme = if (isDark && auth.pureBlack) {
        base.copy(
            background = Color.Black,
            surface = Color.Black,
            surfaceContainerLowest = Color.Black,
        )
    } else {
        base
    }
    return WidgetAppearance(
        colors = Material3ColorProviders(scheme),
        isDark = isDark,
    )
}

@androidx.compose.runtime.Composable
internal fun WidgetTheme(
    appearance: WidgetAppearance,
    content: @androidx.compose.runtime.Composable () -> Unit,
) {
    GlanceTheme(colors = appearance.colors) {
        content()
    }
}
