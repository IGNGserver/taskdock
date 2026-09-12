package com.devtodo.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import com.devtodo.app.ui.TaskDockApp
import com.devtodo.app.ui.screens.MainViewModel
import com.devtodo.app.ui.screens.MainViewModelFactory
import com.devtodo.app.ui.theme.DevTodoTheme

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels {
        MainViewModelFactory(applicationContext)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            val themeMode by viewModel.themeMode.collectAsState()
            val dynamicColor by viewModel.dynamicColor.collectAsState()
            val pureBlack by viewModel.pureBlack.collectAsState()
            DevTodoTheme(
                themeMode = themeMode,
                dynamicColor = dynamicColor,
                pureBlack = pureBlack
            ) {
                TaskDockApp(viewModel = viewModel)
            }
        }
    }
}
