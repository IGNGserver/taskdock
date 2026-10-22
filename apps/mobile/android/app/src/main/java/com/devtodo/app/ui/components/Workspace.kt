package com.devtodo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.devtodo.app.ui.theme.LocalAdaptiveInfo
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.TaskDockSpacing
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Supplied by the app shell; each destination renders it below its own safe top bar. */
val LocalSyncStatus = staticCompositionLocalOf<@Composable () -> Unit> { {} }

/** Each page scaffold owns safe-area padding while its surface draws edge to edge. */
@Composable
fun WorkspaceScaffold(
    topBar: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    floatingActionButtonPosition: FabPosition = FabPosition.End,
    snackbarHost: @Composable () -> Unit = {},
    contentWindowInsets: WindowInsets = WindowInsets.safeDrawing,
    maxContentWidth: Dp? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    val adaptive = LocalAdaptiveInfo.current
    val resolvedMaxWidth = maxContentWidth ?: adaptive.scaffoldMaxWidth
    val resolvedInsets =
        if (adaptive.useNavigationRail) {
            contentWindowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Bottom + WindowInsetsSides.End)
        } else {
            contentWindowInsets
        }
    Scaffold(
        contentWindowInsets = resolvedInsets,
        topBar = { Column { topBar(); LocalSyncStatus.current() } },
        bottomBar = bottomBar,
        floatingActionButton = floatingActionButton,
        floatingActionButtonPosition = floatingActionButtonPosition,
        snackbarHost = snackbarHost,
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
            contentAlignment = Alignment.TopCenter,
        ) {
            Box(Modifier.widthIn(max = resolvedMaxWidth).fillMaxSize()) { content(PaddingValues(0.dp)) }
        }
    }
}

/**
 * Shared two-pane container for tablet and landscape master-detail views.
 * Both panes keep independent scroll states and M3 Expressive surface containment.
 */
@Composable
fun AdaptiveTwoPaneLayout(
    primaryPane: @Composable BoxScope.() -> Unit,
    secondaryPane: @Composable BoxScope.() -> Unit,
    modifier: Modifier = Modifier,
    primaryWeight: Float = LocalAdaptiveInfo.current.primaryPaneWeight,
    secondaryWeight: Float = LocalAdaptiveInfo.current.secondaryPaneWeight,
    paneSpacing: Dp = LocalAdaptiveInfo.current.paneSpacing,
) {
    val adaptive = LocalAdaptiveInfo.current
    Row(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = adaptive.pageHorizontalPadding, vertical = if (adaptive.isCompactLandscape) 4.dp else 8.dp),
        horizontalArrangement = Arrangement.spacedBy(paneSpacing),
    ) {
        Box(
            modifier = Modifier
                .weight(primaryWeight)
                .fillMaxHeight(),
            content = primaryPane,
        )
        Surface(
            modifier = Modifier
                .weight(secondaryWeight)
                .fillMaxHeight(),
            shape = TaskDockShapes.LargeIncreased,
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
            tonalElevation = 1.dp,
        ) {
            Box(
                modifier = Modifier.fillMaxSize(),
                content = secondaryPane,
            )
        }
    }
}

@Composable
fun SectionHeading(title: String, modifier: Modifier = Modifier) {
    val adaptive = LocalAdaptiveInfo.current
    Text(
        title,
        modifier.padding(
                start = TaskDockSpacing.Page,
                top = if (adaptive.isCompactLandscape) TaskDockSpacing.SectionCompact else TaskDockSpacing.Section,
                end = TaskDockSpacing.Page,
                bottom = TaskDockSpacing.Compact,
            )
            .semantics { heading() },
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurface,
    )
}

@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    description: String,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(shape = TaskDockShapes.HeroShape, color = MaterialTheme.colorScheme.surfaceContainerHighest) {
            Icon(icon, null, Modifier.padding(20.dp).size(28.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(
            description,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        action?.invoke()
    }
}

data class RowAction(
    val label: String,
    val enabled: Boolean = true,
    val destructive: Boolean = false,
    val onClick: () -> Unit,
)

@Composable
fun ActionMenu(label: String, actions: List<RowAction>) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(
            onClick = { expanded = true },
            modifier = Modifier.size(48.dp),
        ) {
            Icon(Icons.Default.MoreVert, label)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            actions.forEach { action ->
                DropdownMenuItem(
                    text = {
                        Text(
                            action.label,
                            color =
                                if (action.destructive && action.enabled)
                                    MaterialTheme.colorScheme.error
                                else LocalContentColor.current,
                        )
                    },
                    enabled = action.enabled,
                    onClick = {
                        expanded = false
                        action.onClick()
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureSheet(
    title: String,
    label: String = "任务标题",
    initialValue: String = "",
    confirmLabel: String = "创建",
    onDismiss: () -> Unit,
    onCreate: (String) -> Unit,
) {
    var value by rememberSaveable(initialValue) { mutableStateOf(initialValue) }
    var discard by remember { mutableStateOf(false) }
    val isDirty = value != initialValue
    fun dismiss() {
        if (!isDirty || value.isBlank()) onDismiss() else discard = true
    }
    ModalBottomSheet(
        onDismissRequest = ::dismiss,
        sheetState =
            rememberModalBottomSheetState(
                skipPartiallyExpanded = true,
                confirmValueChange = { next ->
                    if (next == SheetValue.Hidden && isDirty && value.isNotBlank()) {
                        discard = true
                        false
                    } else true
                },
            ),
    ) {
        Column(
            Modifier.fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            OutlinedTextField(
                value,
                { value = it },
                Modifier.fillMaxWidth(),
                label = { Text(label) },
                minLines = 1,
                maxLines = 4,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = ::dismiss) { Text("取消") }
                Button(
                    onClick = {
                        onCreate(value.trim())
                        onDismiss()
                    },
                    enabled = value.isNotBlank(),
                ) {
                    Text(confirmLabel)
                }
            }
        }
    }
    if (discard)
        AlertDialog(
            onDismissRequest = { discard = false },
            title = { Text(if (initialValue.isBlank()) "放弃这条草稿？" else "放弃更改？") },
            text = { Text(if (initialValue.isBlank()) "输入的内容尚未创建。" else "输入的内容尚未保存。") },
            confirmButton = { TextButton(onClick = onDismiss) { Text("放弃") } },
            dismissButton = { TextButton(onClick = { discard = false }) { Text("继续编辑") } },
        )
}

@Composable
fun WorkspaceTabs(labels: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            labels.forEachIndexed { index, label ->
                val isSelected = selected == index
                val containerColor by
                    animateColorAsState(
                        if (isSelected) MaterialTheme.colorScheme.secondaryContainer
                        else MaterialTheme.colorScheme.surfaceContainerLow,
                        label = "workspaceTabContainer",
                    )
                val contentColor by
                    animateColorAsState(
                        if (isSelected) MaterialTheme.colorScheme.onSecondaryContainer
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                        label = "workspaceTabContent",
                    )
                Box(
                    Modifier.defaultMinSize(minWidth = 72.dp, minHeight = 48.dp)
                        .background(containerColor, MaterialTheme.shapes.medium)
                        .selectable(
                            selected = isSelected,
                            role = Role.Tab,
                            onClick = { onSelect(index) },
                        )
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                        color = contentColor,
                    )
                }
            }
        }
    }
}
