package com.devtodo.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.FontWeight

// Keep the Material 3 type scale and system font fallback, then give page and
// row titles a little more hierarchy without reducing body text or font scaling.
private val BaseTypography = Typography()

val DevTodoTypography =
    BaseTypography.copy(
        headlineSmall = BaseTypography.headlineSmall.copy(fontWeight = FontWeight.Medium),
        titleLarge = BaseTypography.titleLarge.copy(fontWeight = FontWeight.Medium),
        titleMedium = BaseTypography.titleMedium.copy(fontWeight = FontWeight.Medium),
        titleSmall = BaseTypography.titleSmall.copy(fontWeight = FontWeight.Medium),
    )
