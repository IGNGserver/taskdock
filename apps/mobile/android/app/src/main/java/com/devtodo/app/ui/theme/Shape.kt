package com.devtodo.app.ui.theme

import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * Material 3 Expressive corner shape scale mirroring packages/ui/src/tokens.css:
 * - none: 0dp
 * - xs: 4dp
 * - sm: 8dp
 * - md: 12dp
 * - lg: 16dp
 * - lgIncreased: 20dp
 * - xl: 28dp
 * - xlIncreased: 32dp
 * - xxl: 48dp
 * - full: 999dp (pill)
 */
object TaskDockShapes {
    val None: CornerBasedShape = RoundedCornerShape(0.dp)
    val ExtraSmall: CornerBasedShape = RoundedCornerShape(4.dp)
    val Small: CornerBasedShape = RoundedCornerShape(8.dp)
    val Medium: CornerBasedShape = RoundedCornerShape(12.dp)
    val Large: CornerBasedShape = RoundedCornerShape(16.dp)
    val LargeIncreased: CornerBasedShape = RoundedCornerShape(20.dp)
    val ExtraLarge: CornerBasedShape = RoundedCornerShape(28.dp)
    val ExtraLargeIncreased: CornerBasedShape = RoundedCornerShape(32.dp)
    val ExtraExtraLarge: CornerBasedShape = RoundedCornerShape(48.dp)
    val FullPill: CornerBasedShape = RoundedCornerShape(999.dp)

    // Expressive asymmetric shapes for cards, badges and status chips
    val AsymmetricStartPill: CornerBasedShape =
        RoundedCornerShape(topStart = 20.dp, bottomStart = 20.dp, topEnd = 8.dp, bottomEnd = 8.dp)
    val AsymmetricEndPill: CornerBasedShape =
        RoundedCornerShape(topStart = 8.dp, bottomStart = 8.dp, topEnd = 20.dp, bottomEnd = 20.dp)
    val SmartCardShape: CornerBasedShape = RoundedCornerShape(22.dp)
    val TaskRowShape: CornerBasedShape = RoundedCornerShape(16.dp)
    val TaskRowSelectedShape: CornerBasedShape = RoundedCornerShape(20.dp)
    val FloatingBarShape: CornerBasedShape = RoundedCornerShape(28.dp)
    val BottomSheetShape: CornerBasedShape =
        RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
}

val DevTodoMaterialShapes =
    Shapes(
        extraSmall = TaskDockShapes.ExtraSmall,
        small = TaskDockShapes.Small,
        medium = TaskDockShapes.Medium,
        large = TaskDockShapes.Large,
        extraLarge = TaskDockShapes.ExtraLarge,
    )
