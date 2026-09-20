package com.devtodo.app.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.*
import androidx.navigation.navArgument
import com.devtodo.app.ui.navigation.BottomNavScreens
import com.devtodo.app.ui.navigation.Screen
import com.devtodo.app.ui.screens.*
import com.devtodo.app.ui.theme.TaskDockMotion
import kotlinx.coroutines.flow.collect

@Composable
fun TaskDockApp(
    viewModel: MainViewModel,
    navController: NavHostController = rememberNavController(),
) {
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val loggedIn by viewModel.authenticated.collectAsStateWithLifecycle()
    val primary = loggedIn && BottomNavScreens.any { it.route == currentRoute }
    val snackbar = remember { SnackbarHostState() }
    var locateFolder by rememberSaveable { mutableStateOf<String?>(null) }
    var locateTask by rememberSaveable { mutableStateOf<String?>(null) }
    var locateRequest by rememberSaveable { mutableIntStateOf(0) }
    fun navigatePrimary(route: String) {
        navController.navigate(route) {
            popUpTo(Screen.Today.route) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }
    fun locate(folder: String?, task: String?) {
        locateFolder = folder
        locateTask = task
        locateRequest++
        navigatePrimary(Screen.Tree.route)
    }
    LaunchedEffect(viewModel) { viewModel.messages.collect { snackbar.showSnackbar(it) } }
    LaunchedEffect(loggedIn, currentRoute) {
        if (!loggedIn && currentRoute != null && currentRoute != Screen.Login.route) {
            navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
        }
    }
    val adaptiveInfo = currentWindowAdaptiveInfo()
    NavigationSuiteScaffold(
        modifier =
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .windowInsetsPadding(WindowInsets.safeDrawing),
        layoutType =
            if (primary) NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(adaptiveInfo)
            else NavigationSuiteType.None,
        navigationSuiteItems = {
            BottomNavScreens.forEach { screen ->
                item(
                    selected = currentRoute == screen.route,
                    onClick = { navigatePrimary(screen.route) },
                    icon = { screen.icon?.let { Icon(it, null) } },
                    label = { Text(screen.title) },
                )
            }
        },
    ) {
        Scaffold(
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = if (loggedIn) Screen.Today.route else Screen.Login.route,
                modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
                enterTransition = {
                    if (BottomNavScreens.any { it.route == targetState.destination.route })
                        fadeIn(
                            tween(TaskDockMotion.NavigationMillis, easing = TaskDockMotion.Standard)
                        )
                    else
                        fadeIn(
                            tween(TaskDockMotion.EnterMillis, easing = TaskDockMotion.Standard)
                        ) +
                            slideInHorizontally(
                                tween(TaskDockMotion.EnterMillis, easing = TaskDockMotion.Standard)
                            ) {
                                it / 12
                            }
                },
                exitTransition = {
                    fadeOut(tween(TaskDockMotion.ExitMillis, easing = TaskDockMotion.Standard))
                },
                popEnterTransition = {
                    fadeIn(tween(TaskDockMotion.EnterMillis, easing = TaskDockMotion.Standard))
                },
                popExitTransition = {
                    fadeOut(tween(TaskDockMotion.ExitMillis, easing = TaskDockMotion.Standard)) +
                        slideOutHorizontally(
                            tween(TaskDockMotion.ExitMillis, easing = TaskDockMotion.Standard)
                        ) {
                            it / 12
                        }
                },
            ) {
                composable(Screen.Login.route) {
                    LoginScreen(
                        viewModel = viewModel,
                        onLoginSuccess = {
                            viewModel.onAuthenticated()
                            navController.navigate(Screen.Today.route) {
                                popUpTo(Screen.Login.route) { inclusive = true }
                            }
                        },
                    )
                }

                composable(Screen.Today.route) {
                    TodayV2Screen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onNavigateToTree = ::locate,
                    )
                }

                composable(Screen.Tree.route) {
                    TreeScreen(
                        viewModel = viewModel,
                        initialFolderId = locateFolder,
                        highlightedTaskId = locateTask,
                        locateRequest = locateRequest,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                    )
                }

                composable(Screen.Time.route) {
                    PlanningScreen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onNavigateToTree = ::locate,
                    )
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
                        },
                    )
                }

                composable(Screen.ArchivedTasks.route) {
                    ArchiveCenterV2Screen(
                        viewModel = viewModel,
                        onBack = { navController.popBackStack() },
                    )
                }

                composable(
                    route = Screen.TaskDetail.route,
                    arguments = listOf(navArgument("taskId") { type = NavType.StringType }),
                ) { backStackEntry ->
                    val taskId = backStackEntry.arguments?.getString("taskId") ?: ""
                    TaskDetailScreen(
                        taskId = taskId,
                        viewModel = viewModel,
                        onBack = { navController.popBackStack() },
                    )
                }
            }
        }
    }
}
