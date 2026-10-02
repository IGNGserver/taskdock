package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.ui.screens.MainViewModel
import com.devtodo.app.ui.theme.TaskDockShapes
import java.text.SimpleDateFormat
import java.util.*

/** Each directory/date keeps its own draft and explicit destination. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskCaptureIsland(
    viewModel: MainViewModel,
    modifier: Modifier = Modifier,
    initialFolderId: String? = null,
    initialDate: String? = null,
    primaryLabel: String = "记一件事",
    eventId: String? = null,
    eventTitle: String? = null,
    openRequest: Int = 0,
    useCapturePreference: Boolean = false,
) {
    val folders by viewModel.foldersV2.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    var handledRequest by rememberSaveable { mutableIntStateOf(0) }
    val holder = rememberSaveableStateHolder()
    holder.SaveableStateProvider("${initialFolderId ?: "root"}/${eventId ?: initialDate ?: "unscheduled"}") {
        var folderId by rememberSaveable { mutableStateOf(initialFolderId) }
        var date by rememberSaveable { mutableStateOf(initialDate) }
        var folderPicker by remember { mutableStateOf(false) }
        var datePicker by remember { mutableStateOf(false) }
        val activeFolders = folders.filter { it.archivedAt == null && it.deletedAt == null }
        val path = folderPath(folderId, folders)
        val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val today = Calendar.getInstance(TimeZone.getTimeZone(settings?.timezone ?: "Asia/Shanghai"))
        val todayDate = dateFormat.apply { timeZone = today.timeZone }.format(today.time)
        val tomorrowDate = dateFormat.format((today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }.time)

        FloatingActionIsland(
            modifier = modifier,
            onQuickCreate = { title, result -> viewModel.captureTaskV2(folderId, title, date, result, eventId = eventId) },
            primaryLabel = primaryLabel,
            openRequest = if (openRequest > handledRequest) openRequest else 0,
            onOpenRequestHandled = { handledRequest = openRequest },
            onOpen = { hasDraft ->
                if (!hasDraft) {
                    folderId = initialFolderId ?: if (useCapturePreference && settings?.defaultCaptureTarget == "RECENT_FOLDER")
                        activeFolders.maxByOrNull { it.updatedAt }?.id else null
                }
            },
            contextFields = { saving ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { folderPicker = true }, enabled = !saving,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = TaskDockShapes.FullPill,
                    ) {
                        Icon(Icons.Default.FolderOpen, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("存入 · $path", maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    OutlinedButton(
                        onClick = { datePicker = true }, enabled = !saving && eventId == null,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = TaskDockShapes.FullPill,
                    ) {
                        Icon(Icons.Default.Event, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(if (eventId != null) "关联事件 · ${eventTitle ?: "所选事件"}" else "安排 · ${if (date == todayDate) "今天" else date ?: "暂不安排"}")
                    }
                }
            },
        )
        if (folderPicker) {
            AlertDialog(
                onDismissRequest = { folderPicker = false },
                title = { Text("保存到目录") },
                text = {
                    LazyColumn(Modifier.heightIn(max = 360.dp)) {
                        item {
                            TextButton(onClick = { folderId = null; folderPicker = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                Text("根目录")
                            }
                        }
                        items(activeFolders.sortedBy { folderPath(it.id, folders) }, key = { it.id }) { folder ->
                            TextButton(onClick = { folderId = folder.id; folderPicker = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                Text(folderPath(folder.id, folders))
                            }
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { folderPicker = false }) { Text("返回") } },
            )
        }
        if (datePicker) {
            val utcFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val picker = rememberDatePickerState(initialSelectedDateMillis = date?.let { utcFormat.parse(it)?.time })
            DatePickerDialog(
                onDismissRequest = { datePicker = false },
                confirmButton = { TextButton(enabled = picker.selectedDateMillis != null, onClick = {
                    date = picker.selectedDateMillis?.let { utcFormat.format(Date(it)) }
                    datePicker = false
                }) { Text("确定") } },
                dismissButton = { TextButton(onClick = { datePicker = false }) { Text("返回") } },
            ) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = { date = null; datePicker = false }) { Text("暂不安排") }
                    TextButton(onClick = { date = todayDate; datePicker = false }) { Text("今天") }
                    TextButton(onClick = { date = tomorrowDate; datePicker = false }) { Text("明天") }
                }
                DatePicker(picker)
            }
        }
    }
}

internal fun folderPath(folderId: String?, folders: List<FolderEntity>): String {
    if (folderId == null) return "根目录"
    val byId = folders.associateBy { it.id }
    val titles = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    var id: String? = folderId
    while (id != null && seen.add(id)) {
        val folder = byId[id] ?: return "目录已不可用，请重新选择"
        titles.add(folder.title)
        id = folder.parentFolderId
    }
    return titles.reversed().joinToString(" / ")
}
