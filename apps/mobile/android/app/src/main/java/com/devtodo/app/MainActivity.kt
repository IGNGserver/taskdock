package com.devtodo.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.devtodo.app.ui.TaskDockApp
import com.devtodo.app.ui.screens.MainViewModel
import com.devtodo.app.ui.screens.MainViewModelFactory
import com.devtodo.app.ui.theme.DevTodoTheme

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels {
        MainViewModelFactory(applicationContext)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            DevTodoTheme {
                TaskDockApp(viewModel = viewModel)
            }
        }
    }
}
