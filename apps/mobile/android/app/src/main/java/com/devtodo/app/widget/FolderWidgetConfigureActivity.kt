package com.devtodo.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.ui.theme.DevTodoTheme
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.ThemeMode
import kotlinx.coroutines.launch

/**
 * Mandatory configuration activity for the folder widget. It writes the
 * selected folder key per widget instance, then returns RESULT_OK with the
 * widget id so the launcher completes the add flow.
 */
class FolderWidgetConfigureActivity : ComponentActivity() {
    private val appWidgetId: Int by lazy {
        intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val manager = AppWidgetManager.getInstance(applicationContext)
        val existing = manager.getAppWidgetInfo(appWidgetId)
        val expected = ComponentName(this, FolderWidgetReceiver::class.java)
        if (existing != null && existing.provider != expected) {
            finish()
            return
        }
        setResult(
            RESULT_CANCELED,
            Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        )
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
                ConfigureScreen(
                    appWidgetId = appWidgetId,
                    initialKey = FolderWidgetStore.read(applicationContext, appWidgetId),
                    onCancel = { finish() },
                    onSave = { key ->
                        FolderWidgetStore.write(applicationContext, appWidgetId, key)
                        setResult(
                            RESULT_OK,
                            Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        )
                        lifecycleScope.launch {
                            runCatching {
                                val glanceId = androidx.glance.appwidget.GlanceAppWidgetManager(applicationContext)
                                    .getGlanceIdBy(appWidgetId)
                                FolderWidget().update(applicationContext, glanceId)
                            }
                            finish()
                        }
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
private fun ConfigureScreen(
    appWidgetId: Int,
    initialKey: String?,
    onCancel: () -> Unit,
    onSave: (String) -> Unit,
) {
    val context = LocalContext.current
    var options by remember { mutableStateOf<List<WidgetFolderOption>?>(null) }
    var selectedKey by rememberSaveable { mutableStateOf(initialKey) }

    LaunchedEffect(appWidgetId) {
        options = WidgetRepository(context).loadFolderOptions()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("选择目录") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                    }
                },
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 3.dp,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
            ) {
                Box(Modifier.fillMaxWidth().padding(16.dp)) {
                    Button(
                        onClick = { selectedKey?.let(onSave) },
                        enabled = selectedKey != null,
                        modifier = Modifier.fillMaxWidth(),
                        shape = TaskDockShapes.FullPill,
                    ) {
                        Text("保存")
                    }
                }
            }
        },
    ) { padding ->
        val loaded = options
        if (loaded == null) {
            Box(
                Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
            return@Scaffold
        }
        if (loaded.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("还没有可选择的目录", style = MaterialTheme.typography.titleMedium)
                Text(
                    "请先在 TaskDock 登录并同步目录，再回来添加组件。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp, bottom = 16.dp),
                )
                Button(
                    onClick = {
                        context.startActivity(WidgetIntents.openToday(context))
                    },
                    shape = TaskDockShapes.FullPill,
                ) { Text("打开 TaskDock") }
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = 12.dp,
                bottom = 24.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(loaded, key = { it.id ?: FolderWidgetStore.ROOT }) { option ->
                val key = option.id ?: FolderWidgetStore.ROOT
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = TaskDockShapes.Large,
                    color = if (selectedKey == key) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceContainerLow
                    },
                    onClick = { selectedKey = key },
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = selectedKey == key,
                            onClick = { selectedKey = key },
                        )
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(
                                text = option.title,
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = "${option.path} · ${option.openCount} 项待办",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
