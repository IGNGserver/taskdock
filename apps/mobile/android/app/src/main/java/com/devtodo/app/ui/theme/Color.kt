package com.devtodo.app.ui.theme

import androidx.compose.ui.graphics.Color

/*
 * Material 3 Expressive colour roles for the light scheme.
 *
 * This file is a hand-maintained mirror of the semantic colour tokens in
 * `packages/ui/src/tokens.css` (the canonical source). Keep the two in sync:
 * never hardcode a hex value in a composable, always reference these roles.
 */

// Primary ------------------------------------------------------------------
val M3LightPrimary = Color(0xFF4F5F90)
val M3LightOnPrimary = Color(0xFFFFFFFF)
val M3LightPrimaryContainer = Color(0xFFDCE2FF)
val M3LightOnPrimaryContainer = Color(0xFF081943)
val M3LightPrimaryFixed = Color(0xFFDCE2FF)
val M3LightPrimaryFixedDim = Color(0xFFB6C4F8)
val M3LightOnPrimaryFixed = Color(0xFF081943)
val M3LightOnPrimaryFixedVariant = Color(0xFF374777)

// Secondary ----------------------------------------------------------------
val M3LightSecondary = Color(0xFF5A5F71)
val M3LightOnSecondary = Color(0xFFFFFFFF)
val M3LightSecondaryContainer = Color(0xFFDEE2F3)
val M3LightOnSecondaryContainer = Color(0xFF171B2C)
val M3LightSecondaryFixed = Color(0xFFDEE2F3)
val M3LightSecondaryFixedDim = Color(0xFFC2C6DA)
val M3LightOnSecondaryFixed = Color(0xFF171B2C)
val M3LightOnSecondaryFixedVariant = Color(0xFF414659)

// Tertiary -----------------------------------------------------------------
val M3LightTertiary = Color(0xFF76546F)
val M3LightOnTertiary = Color(0xFFFFFFFF)
val M3LightTertiaryContainer = Color(0xFFFFD7F5)
val M3LightOnTertiaryContainer = Color(0xFF2D122A)
val M3LightTertiaryFixed = Color(0xFFFFD7F5)
val M3LightTertiaryFixedDim = Color(0xFFE6B9DC)
val M3LightOnTertiaryFixed = Color(0xFF2D122A)
val M3LightOnTertiaryFixedVariant = Color(0xFF5B3C55)

// Surface & background -----------------------------------------------------
val M3LightBackground = Color(0xFFFBF8FF)
val M3LightOnBackground = Color(0xFF1A1B20)
val M3LightSurface = Color(0xFFFBF8FF)
val M3LightOnSurface = Color(0xFF1A1B20)
val M3LightSurfaceVariant = Color(0xFFE3E1E8)
val M3LightOnSurfaceVariant = Color(0xFF45464F)
val M3LightSurfaceContainerLowest = Color(0xFFFFFFFF)
val M3LightSurfaceContainerLow = Color(0xFFF5F2F9)
val M3LightSurfaceContainer = Color(0xFFEFEDF4)
val M3LightSurfaceContainerHigh = Color(0xFFE9E7EE)
val M3LightSurfaceContainerHighest = Color(0xFFE3E1E8)
val M3LightSurfaceDim = Color(0xFFDBD9E0)
val M3LightSurfaceBright = Color(0xFFFBF8FF)
val M3LightInverseSurface = Color(0xFF2F3036)
val M3LightInverseOnSurface = Color(0xFFF1EFF7)
val M3LightInversePrimary = Color(0xFFB9C5FF)
val M3LightSurfaceTint = M3LightPrimary

// Outline ------------------------------------------------------------------
val M3LightOutline = Color(0xFF767780)
val M3LightOutlineVariant = Color(0xFFC6C6D0)

// Error --------------------------------------------------------------------
val M3LightError = Color(0xFFBA1A1A)
val M3LightOnError = Color(0xFFFFFFFF)
val M3LightErrorContainer = Color(0xFFFFDAD6)
val M3LightOnErrorContainer = Color(0xFF410002)

// Success / warning — TaskDock domain status roles (M3 has no such role) ---
val M3LightSuccess = Color(0xFF356A4B)
val M3LightOnSuccess = Color(0xFFFFFFFF)
val M3LightSuccessContainer = Color(0xFFB9F1C9)
val M3LightOnSuccessContainer = Color(0xFF00210E)
val M3LightWarning = Color(0xFF765900)
val M3LightOnWarning = Color(0xFFFFFFFF)
val M3LightWarningContainer = Color(0xFFFFE08A)
val M3LightOnWarningContainer = Color(0xFF251A00)

/*
 * Material 3 Expressive colour roles for the dark scheme.
 */

// Primary ------------------------------------------------------------------
val M3DarkPrimary = Color(0xFFB9C5FF)
val M3DarkOnPrimary = Color(0xFF1F2F60)
val M3DarkPrimaryContainer = Color(0xFF374777)
val M3DarkOnPrimaryContainer = Color(0xFFDCE2FF)
val M3DarkPrimaryFixed = Color(0xFFDCE2FF)
val M3DarkPrimaryFixedDim = Color(0xFFB6C4F8)
val M3DarkOnPrimaryFixed = Color(0xFF081943)
val M3DarkOnPrimaryFixedVariant = Color(0xFF374777)

// Secondary ----------------------------------------------------------------
val M3DarkSecondary = Color(0xFFC2C6DA)
val M3DarkOnSecondary = Color(0xFF2B2F40)
val M3DarkSecondaryContainer = Color(0xFF414659)
val M3DarkOnSecondaryContainer = Color(0xFFDEE2F3)
val M3DarkSecondaryFixed = Color(0xFFDEE2F3)
val M3DarkSecondaryFixedDim = Color(0xFFC2C6DA)
val M3DarkOnSecondaryFixed = Color(0xFF171B2C)
val M3DarkOnSecondaryFixedVariant = Color(0xFF414659)

// Tertiary -----------------------------------------------------------------
val M3DarkTertiary = Color(0xFFE6B9DC)
val M3DarkOnTertiary = Color(0xFF43263F)
val M3DarkTertiaryContainer = Color(0xFF5B3C55)
val M3DarkOnTertiaryContainer = Color(0xFFFFD7F5)
val M3DarkTertiaryFixed = Color(0xFFFFD7F5)
val M3DarkTertiaryFixedDim = Color(0xFFE6B9DC)
val M3DarkOnTertiaryFixed = Color(0xFF2D122A)
val M3DarkOnTertiaryFixedVariant = Color(0xFF5B3C55)

// Surface & background -----------------------------------------------------
val M3DarkBackground = Color(0xFF121318)
val M3DarkOnBackground = Color(0xFFE3E1E8)
val M3DarkSurface = Color(0xFF121318)
val M3DarkOnSurface = Color(0xFFE3E1E8)
val M3DarkSurfaceVariant = Color(0xFF45464F)
val M3DarkOnSurfaceVariant = Color(0xFFC6C6D0)
val M3DarkSurfaceContainerLowest = Color(0xFF0D0E13)
val M3DarkSurfaceContainerLow = Color(0xFF1A1B20)
val M3DarkSurfaceContainer = Color(0xFF1E1F25)
val M3DarkSurfaceContainerHigh = Color(0xFF292A2F)
val M3DarkSurfaceContainerHighest = Color(0xFF34343A)
val M3DarkSurfaceDim = Color(0xFF121318)
val M3DarkSurfaceBright = Color(0xFF38393F)
val M3DarkInverseSurface = Color(0xFFE3E1E8)
val M3DarkInverseOnSurface = Color(0xFF2F3036)
val M3DarkInversePrimary = Color(0xFF4F5F90)
val M3DarkSurfaceTint = M3DarkPrimary

// Outline ------------------------------------------------------------------
val M3DarkOutline = Color(0xFF90909A)
val M3DarkOutlineVariant = Color(0xFF45464F)

// Error --------------------------------------------------------------------
val M3DarkError = Color(0xFFFFB4AB)
val M3DarkOnError = Color(0xFF690005)
val M3DarkErrorContainer = Color(0xFF93000A)
val M3DarkOnErrorContainer = Color(0xFFFFDAD6)

// Success / warning — TaskDock domain status roles (M3 has no such role) ---
val M3DarkSuccess = Color(0xFF9ED5AD)
val M3DarkOnSuccess = Color(0xFF0B3920)
val M3DarkSuccessContainer = Color(0xFF205332)
val M3DarkOnSuccessContainer = Color(0xFFB9F1C9)
val M3DarkWarning = Color(0xFFE7C34F)
val M3DarkOnWarning = Color(0xFF3C2F00)
val M3DarkWarningContainer = Color(0xFF574500)
val M3DarkOnWarningContainer = Color(0xFFFFE08A)
