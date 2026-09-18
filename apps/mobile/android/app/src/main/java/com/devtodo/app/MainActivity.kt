package com.devtodo.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        registerNetworkCallback()
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

    override fun onStart() {
        super.onStart()
        viewModel.onAppForeground()
    }

    override fun onDestroy() {
        networkCallback?.let { callback ->
            runCatching { connectivityManager.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
        super.onDestroy()
    }

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // The callback is for the system's default route. Do not wait
                // for validation: a reachable private/public HTTP Hub may be
                // usable before Android reports validation.
                viewModel.onNetworkStateChanged(true)
            }

            override fun onLost(network: Network) {
                viewModel.onNetworkStateChanged(hasUsableNetwork())
            }
        }
        networkCallback = callback
        runCatching {
            connectivityManager.registerDefaultNetworkCallback(callback)
        }.onFailure {
            // The sync engine still has its own request failure/retry path if
            // an OEM rejects callback registration.
        }
        viewModel.onNetworkStateChanged(hasUsableNetwork())
    }

    private fun hasUsableNetwork(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        // Do not require NET_CAPABILITY_VALIDATED: a reachable LAN/public HTTP
        // Hub can be usable even when Android has not validated the network.
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
