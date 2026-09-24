package com.devtodo.app.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Screen(val route: String, val title: String, val icon: ImageVector? = null) {
    data object Today : Screen("today", "今日", Icons.Default.CalendarToday)

    data object Tree : Screen("tree", "任务", Icons.Default.Folder)

    data object Time : Screen("time", "日程", Icons.Default.DateRange)

    data object Workflows : Screen("workflows", "流程")

    data object AllTasks : Screen("all_tasks", "全部任务")

    data object More : Screen("more", "设置", Icons.Default.Settings)

    data object TaskDetail : Screen("task_detail/{taskId}", "任务详情") {
        fun createRoute(taskId: String) = "task_detail/$taskId"
    }

    data object ArchivedTasks : Screen("archived_tasks", "已归档任务")

    data object Login : Screen("login", "登录")
}
