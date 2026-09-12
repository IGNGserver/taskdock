package com.devtodo.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.ProjectEntity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickCaptureBottomSheet(
    onDismiss: () -> Unit,
    projects: List<ProjectEntity>,
    onSave: (title: String, projectId: String?, scheduleToday: Boolean) -> Unit
) {
    var title by remember { mutableStateOf("") }
    var selectedProjectId by remember { mutableStateOf<String?>(null) }
    var scheduleToday by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
                .navigationBarsPadding()
                .imePadding()
        ) {
            Text(
                text = "快速捕获任务",
                style = MaterialTheme.typography.titleMedium
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                placeholder = { Text("输入任务标题，支持秒级创建…") },
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    if (title.isNotBlank()) {
                        onSave(title.trim(), selectedProjectId, scheduleToday)
                    }
                }),
                shape = RoundedCornerShape(12.dp)
            )

            LaunchedEffect(Unit) {
                focusRequester.requestFocus()
            }

            Spacer(modifier = Modifier.height(16.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                FilterChip(
                    selected = scheduleToday,
                    onClick = { scheduleToday = !scheduleToday },
                    label = { Text("今日焦点") },
                    leadingIcon = {
                        Icon(Icons.Default.CalendarToday, contentDescription = null, modifier = Modifier.size(16.dp))
                    }
                )

                if (projects.isNotEmpty()) {
                    var projectMenuOpen by remember { mutableStateOf(false) }
                    Box {
                        AssistChip(
                            onClick = { projectMenuOpen = true },
                            label = {
                                Text(projects.find { it.id == selectedProjectId }?.name ?: "无项目 (收集箱)")
                            }
                        )
                        DropdownMenu(
                            expanded = projectMenuOpen,
                            onDismissRequest = { projectMenuOpen = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("无项目 (收集箱)") },
                                onClick = {
                                    selectedProjectId = null
                                    projectMenuOpen = false
                                }
                            )
                            projects.forEach { p ->
                                DropdownMenuItem(
                                    text = { Text(p.name) },
                                    onClick = {
                                        selectedProjectId = p.id
                                        projectMenuOpen = false
                                    }
                                )
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(20.dp))

            Button(
                onClick = {
                    if (title.isNotBlank()) {
                        onSave(title.trim(), selectedProjectId, scheduleToday)
                    }
                },
                enabled = title.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("创建任务")
            }
            Spacer(modifier = Modifier.height(12.dp))
        }
    }
}
