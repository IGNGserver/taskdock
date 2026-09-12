package com.devtodo.app.ui

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.devtodo.app.ui.navigation.BottomNavScreens
import com.devtodo.app.ui.navigation.Screen
import com.devtodo.app.ui.screens.InboxScreen
import com.devtodo.app.ui.screens.LoginScreen
import com.devtodo.app.ui.screens.MainViewModel
import com.devtodo.app.ui.screens.ArchivedTasksScreen
import com.devtodo.app.ui.screens.ProjectsScreen
import com.devtodo.app.ui.screens.SettingsScreen
import com.devtodo.app.ui.screens.TaskDetailScreen
import com.devtodo.app.ui.screens.TasksScreen
import com.devtodo.app.ui.screens.TimeScreen
import com.devtodo.app.ui.screens.TodayScreen
import kotlinx.coroutines.flow.collectLatest

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDockApp(
    viewModel: MainViewModel,
    navController: NavHostController = rememberNavController()
) {
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val isLoggedIn = viewModel.authManager.isLoggedIn
    val isMainDestination = BottomNavScreens.any { it.route == currentRoute }
    val snackbarHostState = remember { SnackbarHostState() }

    BoxWithConstraints {
        val useNavigationRail = maxWidth >= 600.dp

        LaunchedEffect(viewModel) {
            viewModel.messages.collectLatest { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        Scaffold(
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                if (isLoggedIn && isMainDestination && !useNavigationRail) {
                    NavigationBar {
                        BottomNavScreens.forEach { screen ->
                            NavigationBarItem(
                                icon = {
                                    screen.icon?.let {
                                        Icon(it, contentDescription = screen.title)
                                    }
                                },
                                label = { Text(screen.title) },
                                selected = currentRoute == screen.route,
                                onClick = {
                                    navController.navigate(screen.route) {
                                        popUpTo(navController.graph.findStartDestination().id) {
                                            saveState = true
                                        }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                }
                            )
                        }
                    }
                }
            }
        ) { padding ->
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                if (isLoggedIn && isMainDestination && useNavigationRail) {
                    NavigationRail {
                        BottomNavScreens.forEach { screen ->
                            NavigationRailItem(
                                icon = {
                                    screen.icon?.let {
                                        Icon(it, contentDescription = screen.title)
                                    }
                                },
                                label = { Text(screen.title) },
                                selected = currentRoute == screen.route,
                                onClick = {
                                    navController.navigate(screen.route) {
                                        popUpTo(navController.graph.findStartDestination().id) {
                                            saveState = true
                                        }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                }
                            )
                        }
                    }
                }

                NavHost(
                    navController = navController,
                    startDestination = if (isLoggedIn) {
                        Screen.Today.route
                    } else {
                        Screen.Login.route
                    },
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                ) {
                    composable(Screen.Login.route) {
                        LoginScreen(
                            viewModel = viewModel,
                            onLoginSuccess = {
                                viewModel.onAuthenticated()
                                navController.navigate(Screen.Today.route) {
                                    popUpTo(Screen.Login.route) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(Screen.Today.route) {
                        TodayScreen(
                            viewModel = viewModel,
                            onNavigateToDetail = { taskId ->
                                navController.navigate(Screen.TaskDetail.createRoute(taskId))
                            }
                        )
                    }

                    composable(Screen.Inbox.route) {
                        InboxScreen(
                            viewModel = viewModel,
                            onNavigateToDetail = { taskId ->
                                navController.navigate(Screen.TaskDetail.createRoute(taskId))
                            }
                        )
                    }

                    composable(Screen.Tasks.route) {
                        TasksScreen(
                            viewModel = viewModel,
                            onNavigateToDetail = { taskId ->
                                navController.navigate(Screen.TaskDetail.createRoute(taskId))
                            },
                            onNavigateToProjects = {
                                navController.navigate(Screen.Projects.route)
                            }
                        )
                    }

                    composable(Screen.Time.route) {
                        TimeScreen(viewModel = viewModel)
                    }

                    composable(Screen.More.route) {
                        SettingsScreen(
                            viewModel = viewModel,
                            onThemeModeChange = viewModel::setThemeMode,
                            onDynamicColorChange = viewModel::setDynamicColor,
                            onPureBlackChange = viewModel::setPureBlack,
                            onNavigateToArchived = {
                                navController.navigate(Screen.ArchivedTasks.route)
                            },
                            onLogout = {
                                viewModel.onLoggedOut()
                                viewModel.authManager.clearSession()
                                navController.navigate(Screen.Login.route) {
                                    popUpTo(0) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(Screen.ArchivedTasks.route) {
                        ArchivedTasksScreen(
                            viewModel = viewModel,
                            onBack = { navController.popBackStack() }
                        )
                    }

                    composable(Screen.Projects.route) {
                        ProjectsScreen(
                            viewModel = viewModel,
                            onBack = { navController.popBackStack() }
                        )
                    }

                    composable(
                        route = Screen.TaskDetail.route,
                        arguments = listOf(
                            navArgument("taskId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val taskId = backStackEntry.arguments?.getString("taskId") ?: ""
                        TaskDetailScreen(
                            taskId = taskId,
                            viewModel = viewModel,
                            onBack = { navController.popBackStack() }
                        )
                    }
                }
            }
        }
    }
}
