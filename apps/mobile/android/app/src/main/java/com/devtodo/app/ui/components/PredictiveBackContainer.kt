package com.devtodo.app.ui.components

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import com.devtodo.app.ui.theme.TaskDockMotion
import kotlinx.coroutines.flow.Flow

/**
 * Material 3 Expressive Predictive Back Container.
 * Intercepts back gesture with live physical scale, rounded corner morph, and alpha fade.
 *
 * @param enabled Whether predictive back intercept is active
 * @param onBack Callback triggered when the back gesture completes
 * @param content The screen content wrapped inside the predictive back surface
 */
@Composable
fun PredictiveBackContainer(
    enabled: Boolean = true,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    containerColor: Color = MaterialTheme.colorScheme.surface,
    content: @Composable () -> Unit,
) {
    var backProgress by remember { mutableFloatStateOf(0f) }
    var isPredictingBack by remember { mutableStateOf(false) }

    PredictiveBackHandler(enabled = enabled) { progress: Flow<BackEventCompat> ->
        try {
            isPredictingBack = true
            progress.collect { backEvent ->
                // Exponential or linear gesture progress
                backProgress = backEvent.progress
            }
            // Gesture successfully completed (swiped far enough)
            isPredictingBack = false
            backProgress = 0f
            onBack()
        } catch (e: Exception) {
            // Gesture cancelled
            isPredictingBack = false
            backProgress = 0f
        }
    }

    val animatedScale by animateFloatAsState(
        targetValue = if (isPredictingBack) 1f - (backProgress * 0.08f) else 1f,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "predictiveBackScale",
    )

    val animatedAlpha by animateFloatAsState(
        targetValue = if (isPredictingBack) 1f - (backProgress * 0.15f) else 1f,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "predictiveBackAlpha",
    )

    val animatedCornerRadius by animateFloatAsState(
        targetValue = if (isPredictingBack) backProgress * 28f else 0f,
        animationSpec = TaskDockMotion.springSpatialFast(),
        label = "predictiveBackCorners",
    )

    val shape = remember(animatedCornerRadius) {
        if (animatedCornerRadius > 0.5f) RoundedCornerShape(animatedCornerRadius.dp) else RoundedCornerShape(0.dp)
    }

    Surface(
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer {
                scaleX = animatedScale
                scaleY = animatedScale
                alpha = animatedAlpha
            }
            .clip(shape),
        shape = shape,
        color = containerColor,
    ) {
        content()
    }
}
