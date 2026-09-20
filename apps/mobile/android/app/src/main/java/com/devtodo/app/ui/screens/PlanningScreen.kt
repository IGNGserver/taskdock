package com.devtodo.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import com.devtodo.app.ui.components.WorkspaceTabs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanningScreen(
    viewModel: MainViewModel,
    onNavigateToDetail: (String) -> Unit,
    onNavigateToTree: (String?, String?) -> Unit,
) {
    val tabState = rememberSaveableStateHolder()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("计划") }, windowInsets = WindowInsets(0, 0, 0, 0))
        WorkspaceTabs(listOf("日期与事件", "流程"), tab) { tab = it }
        Box(Modifier.weight(1f)) {
            tabState.SaveableStateProvider(tab) {
                if (tab == 0) TimeScreen(viewModel, onNavigateToDetail, onNavigateToTree)
                else WorkflowsV2Screen(viewModel, onNavigateToDetail)
            }
        }
    }
}
