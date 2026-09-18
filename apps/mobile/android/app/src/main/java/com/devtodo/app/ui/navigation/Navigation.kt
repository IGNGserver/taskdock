package com.devtodo.app.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Screen(val route: String, val title: String, val icon: ImageVector? = null) {
    data object Today : Screen("today", "今日", Icons.Default.CalendarToday)
    data object Tree : Screen("tree", "目录", Icons.Default.Folder)
    data object AllTasks : Screen("all_tasks", "所有任务", Icons.AutoMirrored.Filled.List)
    data object Workflows : Screen("workflows", "流程", Icons.Default.AccountTree)
    data object Time : Screen("time", "时间节点", Icons.Default.DateRange)
    data object More : Screen("more", "更多", Icons.Default.MoreHoriz)
    
    data object TaskDetail : Screen("task_detail/{taskId}", "任务详情") {
        fun createRoute(taskId: String) = "task_detail/$taskId"
    }
    data object ArchivedTasks : Screen("archived_tasks", "已归档任务")
    data object Projects : Screen("projects", "项目管理")
    data object Login : Screen("login", "登录")
    data object Settings : Screen("settings", "系统设置")
    data object Calendar : Screen("calendar", "日历视图")
}

val BottomNavScreens = listOf(
    Screen.Today,
    Screen.Tree,
    Screen.AllTasks,
    Screen.Workflows,
    Screen.Time,
    Screen.More
)
