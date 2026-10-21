package com.devtodo.app.widget

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.ui.theme.DevTodoTheme
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.ThemeMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A tiny, keyboard-first capture surface launched directly from the widget.
 * It deliberately does not host the full app shell; recording one task should
 * cost one tap, one sentence and one confirmation.
 */
class CaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val folderId = intent.getStringExtra(WidgetIntents.EXTRA_FOLDER_ID)
        val localDate = intent.getStringExtra(WidgetIntents.EXTRA_CAPTURE_DATE)
        setContent {
            val auth = remember { SecureAuthManager(applicationContext) }
            val themeMode = remember(auth.themeMode) {
                ThemeMode.values().firstOrNull { it.name == auth.themeMode } ?: ThemeMode.SYSTEM
            }
            DevTodoTheme(
                themeMode = themeMode,
                dynamicColor = auth.dynamicColor,
                pureBlack = auth.pureBlack,
            ) {
                CaptureDialog(
                    folderId = folderId,
                    localDate = localDate,
                    onSaved = {
                        Toast.makeText(applicationContext, "已记下，稍后同步", Toast.LENGTH_SHORT).show()
                        finish()
                    },
                    onCancel = { finish() },
                )
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun CaptureDialog(
    folderId: String?,
    localDate: String?,
    onSaved: () -> Unit,
    onCancel: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var title by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        delay(180)
        focusRequester.requestFocus()
        keyboard?.show()
    }

    fun save() {
        val normalized = title.trim()
        if (normalized.isEmpty() || saving) return
        saving = true
        error = null
        scope.launch {
            val result = WidgetTaskCommands(context).capture(
                title = normalized,
                parentFolderId = folderId,
                localDate = localDate,
            )
            saving = false
            result.fold(
                onSuccess = { onSaved() },
                onFailure = { error = it.message ?: "保存失败，请稍后重试" },
            )
        }
    }

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            modifier = Modifier.fillMaxSize().imePadding().navigationBarsPadding().padding(12.dp),
            contentAlignment = Alignment.BottomCenter,
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = TaskDockShapes.BottomSheetShape,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                tonalElevation = 3.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "记一件事",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        text = when {
                            localDate != null -> "存入今天 · 先保存在本地"
                            folderId != null -> "存入当前目录 · 先保存在本地"
                            else -> "存入收件箱 · 先保存在本地"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextField(
                        value = title,
                        onValueChange = { if (it.length <= 240) title = it },
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focusRequester)
                            .testTag("widget-capture-field"),
                        placeholder = { Text("例如：把小组件方案发到群里") },
                        singleLine = false,
                        maxLines = 4,
                        shape = TaskDockShapes.ExtraLarge,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                        ),
                        leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { save() }),
                    )
                    error?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TextButton(onClick = onCancel, enabled = !saving) { Text("取消") }
                        Button(onClick = { save() }, enabled = title.isNotBlank() && !saving) {
                            if (saving) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onPrimary,
                                )
                            } else {
                                Text("记下")
                            }
                        }
                    }
                }
            }
        }
    }
}
