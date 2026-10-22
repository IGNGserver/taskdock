package com.devtodo.app.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Screen(val route: String, val title: String, val icon: ImageVector? = null) {
    data object Today : Screen("today", "今日", Icons.Default.CalendarToday)

    data object Tree : Screen("tree", "任务", Icons.Default.Folder)

    /** A single directory page; folders are real destinations so back follows the tree. */
    data object TreeFolder : Screen("tree/folder/{folderId}", "目录") {
        fun createRoute(folderId: String) = "tree/folder/$folderId"
    }

    /** Kept as `time` for existing internal links; the screen is now the calendar. */
    data object Time : Screen("time", "日历", Icons.Default.DateRange)

    data object DaySchedule : Screen("time/day/{localDate}", "当天日程") {
        fun createRoute(localDate: String) = "time/day/$localDate"
    }

    data object Events : Screen("events", "事件", Icons.Default.Event)

    data object EventDetail : Screen("event/{eventId}", "事件详情") {
        fun createRoute(eventId: String) = "event/$eventId"
    }

    data object Workflows : Screen("workflows", "流程", Icons.Default.AccountTree)

    data object More : Screen("more", "设置", Icons.Default.Settings)

    data object TaskDetail : Screen("task_detail/{taskId}", "任务详情") {
        fun createRoute(taskId: String) = "task_detail/$taskId"
    }

    data object ArchivedTasks : Screen("archived_tasks", "已归档任务")

    data object Login : Screen("login", "登录")
}
