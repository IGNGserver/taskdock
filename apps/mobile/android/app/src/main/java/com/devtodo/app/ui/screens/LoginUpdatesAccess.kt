package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.update.AppUpdateState
import com.devtodo.app.data.update.UpdateChannel

/** Local update access stays on the login destination, independent of Hub credentials. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginUpdatesAccess(
    state: AppUpdateState,
    onOpen: () -> Unit,
    onCheck: () -> Unit,
    onChannelChange: (UpdateChannel) -> Unit,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    var opened by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    TextButton(onClick = {
        focus.clearFocus()
        opened = true
        onOpen()
    }, modifier = Modifier.fillMaxWidth()) { Text("关于与更新") }
    if (opened) {
        ModalBottomSheet(
            onDismissRequest = { opened = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) {
                AppUpdateSettingsSection(state, onCheck, onDownload, onCancelDownload, onInstall, onChannelChange)
            }
        }
    }
}