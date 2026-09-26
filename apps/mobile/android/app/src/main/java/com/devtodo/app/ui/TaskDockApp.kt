package com.devtodo.app.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.*
import androidx.navigation.navArgument
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
    val snackbar = remember { SnackbarHostState() }
    var locateFolder by rememberSaveable { mutableStateOf<String?>(null) }
    var locateTask by rememberSaveable { mutableStateOf<String?>(null) }
    var locateRequest by rememberSaveable { mutableIntStateOf(0) }

    fun navigateShortcut(route: String) {
        if (currentRoute == route) return
        navController.navigate(route) { launchSingleTop = true }
    }

    fun returnToDirectory() {
        if (currentRoute != Screen.Tree.route) {
            val returned = navController.popBackStack(Screen.Tree.route, inclusive = false)
            if (!returned) {
                val routeToReplace = currentRoute ?: return
                navController.navigate(Screen.Tree.route) {
                    popUpTo(routeToReplace) { inclusive = true }
                    launchSingleTop = true
                }
            }
        }
    }

    fun locate(folder: String?, task: String?) {
        locateFolder = folder
        locateTask = task
        locateRequest++
        if (!navController.popBackStack(Screen.Tree.route, inclusive = false)) {
            val routeToReplace = currentRoute
            if (routeToReplace == null) {
                navController.navigate(Screen.Tree.route) { launchSingleTop = true }
            } else {
                navController.navigate(Screen.Tree.route) {
                    popUpTo(routeToReplace) { inclusive = true }
                    launchSingleTop = true
                }
            }
        }
    }

    LaunchedEffect(viewModel) { viewModel.messages.collect { snackbar.showSnackbar(it) } }

    LaunchedEffect(loggedIn, currentRoute) {
        if (currentRoute == null) return@LaunchedEffect
        if (loggedIn && currentRoute == Screen.Login.route) {
            navController.navigate(Screen.Tree.route) { popUpTo(0) { inclusive = true } }
        } else if (!loggedIn && currentRoute != Screen.Login.route) {
            navController.navigate(Screen.Login.route) { popUpTo(0) { inclusive = true } }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = MaterialTheme.colorScheme.surface,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            snackbarHost = {
                SnackbarHost(
                    snackbar,
                    modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBars),
                )
            },
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = if (loggedIn) Screen.Tree.route else Screen.Login.route,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding),
                // Material 3 Expressive Spring Motion Physics transitions
                enterTransition = {
                    fadeIn(
                        animationSpec = TaskDockMotion.springSpatialFast()
                    ) + slideInHorizontally(
                        animationSpec = TaskDockMotion.springSpatial(),
                        initialOffsetX = { fullWidth -> (fullWidth * 0.15f).toInt() }
                    )
                },
                exitTransition = {
                    fadeOut(animationSpec = TaskDockMotion.springSpatialFast())
                },
                popEnterTransition = {
                    fadeIn(animationSpec = TaskDockMotion.springSpatialFast())
                },
                popExitTransition = {
                    fadeOut(animationSpec = TaskDockMotion.springSpatialFast()) +
                        slideOutHorizontally(
                            animationSpec = TaskDockMotion.springSpatial(),
                            targetOffsetX = { fullWidth -> (fullWidth * 0.15f).toInt() }
                        )
                },
            ) {
                composable(Screen.Login.route) {
                    LoginScreen(
                        viewModel = viewModel,
                        onLoginSuccess = { viewModel.onAuthenticated() },
                    )
                }

                composable(Screen.Tree.route) {
                    TreeScreen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        initialFolderId = locateFolder,
                        highlightedTaskId = locateTask,
                        locateRequest = locateRequest,
                        onNavigateToShortcut = ::navigateShortcut,
                        onOpenSettings = { navigateShortcut(Screen.More.route) },
                        onOpenSearch = { navigateShortcut(Screen.AllTasks.route) },
                    )
                }

                composable(Screen.Today.route) {
                    TodayV2Screen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onNavigateToTree = ::locate,
                        onBack = ::returnToDirectory,
                    )
                }

                composable(Screen.Time.route) {
                    TimeScreen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onNavigateToTree = ::locate,
                        onBack = ::returnToDirectory,
                    )
                }

                composable(Screen.Workflows.route) {
                    WorkflowsV2Screen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onBack = ::returnToDirectory,
                    )
                }

                composable(Screen.AllTasks.route) {
                    AllTasksV2Screen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        onBack = { navController.popBackStack() },
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
                        onBack = { navController.popBackStack() },
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
