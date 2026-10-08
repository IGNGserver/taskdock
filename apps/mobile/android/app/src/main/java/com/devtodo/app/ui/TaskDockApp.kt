package com.devtodo.app.ui

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.*
import androidx.navigation.navArgument
import com.devtodo.app.ui.components.taskStatusLabel
import com.devtodo.app.ui.navigation.Screen
import com.devtodo.app.ui.screens.*
import com.devtodo.app.ui.theme.TaskDockMotion
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest

@Composable
fun TaskDockApp(
    viewModel: MainViewModel,
    navController: NavHostController = rememberNavController(),
) {
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val loggedIn by viewModel.authenticated.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
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

    /** Root-first ancestor chain of a folder, so locate rebuilds the real hierarchy. */
    fun folderChain(folderId: String): List<String> {
        val folders = viewModel.foldersV2.value
        val chain = ArrayDeque<String>()
        var current = folders.find { it.id == folderId }
        while (current != null) {
            chain.addFirst(current.id)
            current = current.parentFolderId?.let { parent -> folders.find { it.id == parent } }
        }
        return chain.toList()
    }

    fun locate(folder: String?, task: String?) {
        locateTask = task
        locateRequest++
        if (!navController.popBackStack(Screen.Tree.route, inclusive = false)) {
            navController.navigate(Screen.Tree.route) { launchSingleTop = true }
        }
        // Push every ancestor so swiping back walks the hierarchy folder by
        // folder instead of dropping the user at the root.
        val chain = folder?.let { folderChain(it) }.orEmpty().ifEmpty {
            listOfNotNull(folder)
        }
        chain.forEach { id ->
            navController.navigate(Screen.TreeFolder.createRoute(id)) { launchSingleTop = true }
        }
    }

    LaunchedEffect(viewModel) { viewModel.messages.collect { snackbar.showSnackbar(it) } }

    LaunchedEffect(viewModel) {
        viewModel.statusChanges.collectLatest { change ->
            if (viewModel.authManager.ownerId != change.ownerId) return@collectLatest
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(
                message = "${taskStatusLabel(change.after)} · ${change.title}",
                actionLabel = "撤销", duration = SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed) viewModel.undoTaskStatus(change)
        }
    }

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
                    modifier = Modifier
                        .windowInsetsPadding(WindowInsets.navigationBars)
                        .padding(horizontal = 16.dp, vertical = 8.dp),
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
                // Material 3 Expressive motion. Forward navigation is a shared
                // axis slide + fade; the back stack uses the M3 full-screen
                // surface spec (exit 100% -> 90%, enter 110% -> 100%), which
                // Navigation Compose 2.8 also drives directly from the
                // predictive back gesture.
                enterTransition = {
                    slideInHorizontally(
                        animationSpec = TaskDockMotion.springSpatial(),
                        initialOffsetX = { fullWidth -> (fullWidth * 0.3f).toInt() },
                    ) + fadeIn(animationSpec = TaskDockMotion.springEffects())
                },
                exitTransition = {
                    slideOutHorizontally(
                        animationSpec = TaskDockMotion.springSpatial(),
                        targetOffsetX = { fullWidth -> -(fullWidth * 0.3f).toInt() },
                    ) + fadeOut(animationSpec = TaskDockMotion.springEffects())
                },
                popEnterTransition = {
                    scaleIn(
                        animationSpec = TaskDockMotion.springSpatial(),
                        initialScale = 1.1f,
                        transformOrigin = TransformOrigin.Center,
                    ) + fadeIn(animationSpec = TaskDockMotion.springEffects())
                },
                popExitTransition = {
                    scaleOut(
                        animationSpec = TaskDockMotion.springSpatial(),
                        targetScale = 0.9f,
                        transformOrigin = TransformOrigin.Center,
                    ) + fadeOut(animationSpec = TaskDockMotion.springEffects())
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
                        folderId = null,
                        onOpenFolder = { folderId ->
                            navController.navigate(Screen.TreeFolder.createRoute(folderId))
                        },
                        onBack = null,
                        highlightedTaskId = locateTask,
                        locateRequest = locateRequest,
                        onNavigateToShortcut = ::navigateShortcut,
                        onOpenSettings = { navigateShortcut(Screen.More.route) },
                        onOpenSearch = { navigateShortcut(Screen.AllTasks.route) },
                    )
                }

                composable(
                    route = Screen.TreeFolder.route,
                    arguments = listOf(navArgument("folderId") { type = NavType.StringType }),
                ) { backStackEntry ->
                    val folderId = backStackEntry.arguments?.getString("folderId") ?: return@composable
                    TreeScreen(
                        viewModel = viewModel,
                        onNavigateToDetail = { taskId ->
                            navController.navigate(Screen.TaskDetail.createRoute(taskId))
                        },
                        folderId = folderId,
                        onOpenFolder = { childId ->
                            navController.navigate(Screen.TreeFolder.createRoute(childId))
                        },
                        onBack = { navController.popBackStack() },
                        highlightedTaskId = locateTask,
                        locateRequest = locateRequest,
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
