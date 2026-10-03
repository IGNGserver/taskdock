package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import com.devtodo.app.ui.theme.TaskDockMotion
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.devtodo.app.ui.theme.TaskDockShapes

/** Local drafts survive dismissal; only an acknowledged save clears the input. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FloatingActionIsland(
    onQuickCreate: (String, (String?) -> Unit) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "想做的下一件事",
    primaryLabel: String = "记一件事",
    fieldLabel: String = "任务标题",
    supportingText: String = "先记下来，稍后再整理",
    openRequest: Int = 0,
    onOpen: (Boolean) -> Unit = {},
    onOpenRequestHandled: () -> Unit = {},
    contextFields: @Composable (Boolean) -> Unit = {},
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var title by rememberSaveable { mutableStateOf("") }
    var continuous by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    val inputVisibility = remember { BringIntoViewRequester() }
    var focusRequest by remember { mutableIntStateOf(0) }
    LaunchedEffect(openRequest) {
        if (openRequest > 0) { onOpen(title.isNotBlank()); expanded = true; onOpenRequestHandled() }
    }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val corner by animateDpAsState(if (pressed) 16.dp else 28.dp,
        animationSpec = TaskDockMotion.springBouncy(), label = "captureButtonShape")

    fun submit() {
        if (title.isBlank() || saving) return
        saving = true
        error = null
        saved = false
        onQuickCreate(title.trim()) { failure ->
            saving = false
            error = failure
            if (failure == null) {
                title = ""
                saved = true
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                if (!continuous) {
                    keyboard?.hide()
                    expanded = false
                } else {
                    focusRequest++
                }
            }
        }
    }
    Box(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(12.dp), contentAlignment = Alignment.Center) {
        Button(
            onClick = { onOpen(title.isNotBlank()); expanded = true },
            shape = RoundedCornerShape(corner),
            interactionSource = interaction,
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 16.dp),
            elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp),
            modifier = Modifier.testTag("tree-create-action").heightIn(min = 56.dp),
        ) {
            Icon(Icons.Default.Add, null, Modifier.size(22.dp))
            Spacer(Modifier.width(10.dp))
            Text(if (title.isBlank()) primaryLabel else "继续记录")
        }
    }
    if (expanded) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
            confirmValueChange = { !saving || it != SheetValue.Hidden })
        ModalBottomSheet(
            onDismissRequest = { if (!saving) expanded = false },
            sheetState = sheetState,
            shape = TaskDockShapes.BottomSheetShape,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            LaunchedEffect(focusRequest) {
                withFrameNanos { }
                focus.requestFocus()
                keyboard?.show()
                inputVisibility.bringIntoView()
            }
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(primaryLabel, style = MaterialTheme.typography.titleLarge)
                        Text(supportingText, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { expanded = false }, enabled = !saving, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Default.Close, "收起并保留草稿")
                    }
                }
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it; error = null; saved = false },
                    enabled = !saving,
                    label = { Text(fieldLabel) },
                    placeholder = { Text(placeholder) },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).bringIntoViewRequester(inputVisibility).testTag("capture-title"),
                    singleLine = true,
                    isError = error != null,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    shape = TaskDockShapes.Large,
                )
                contextFields(saving)
                if (error != null) {
                    Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("capture-error"))
                } else if (saved) {
                    Text("已保存，继续记录下一件", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("连续记录", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Switch(checked = continuous, onCheckedChange = { continuous = it }, enabled = !saving)
                }
                Button(
                    onClick = ::submit,
                    enabled = title.isNotBlank() && !saving,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("capture-save"),
                    shape = TaskDockShapes.FullPill,
                ) {
                    if (saving) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (saving) "保存中…" else "保存")
                }
                Text("收起后会保留未保存的内容", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
