package com.devtodo.app

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.devtodo.app.ui.TaskDockApp
import com.devtodo.app.ui.screens.MainViewModel
import com.devtodo.app.ui.screens.MainViewModelFactory
import com.devtodo.app.ui.theme.DevTodoTheme
import com.devtodo.app.widget.WidgetIntents
import com.devtodo.app.widget.WidgetNavigation
import com.devtodo.app.widget.WidgetPreviewPublisher
import com.devtodo.app.widget.WidgetScheduler
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels {
        MainViewModelFactory(applicationContext)
    }
    private val widgetNavigation = MutableStateFlow<WidgetNavigation?>(null)
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        splashScreen.setOnExitAnimationListener { splashScreenView ->
            // Android owns the launch surface; only soften the hand-off to the
            // first Compose frame. The full brand artwork is intentionally not
            // part of this transition.
            splashScreenView.view
                .animate()
                .alpha(0f)
                .setDuration(160L)
                .withEndAction { splashScreenView.remove() }
                .start()
        }
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        registerNetworkCallback()
        publishWidgetNavigation(intent)
        setContent {
            val themeMode by viewModel.themeMode.collectAsState()
            val dynamicColor by viewModel.dynamicColor.collectAsState()
            val pureBlack by viewModel.pureBlack.collectAsState()
            DevTodoTheme(
                themeMode = themeMode,
                dynamicColor = dynamicColor,
                pureBlack = pureBlack
            ) {
                TaskDockApp(
                    viewModel = viewModel,
                    widgetNavigation = widgetNavigation,
                    onWidgetNavigationHandled = { widgetNavigation.value = null },
                )
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.updateInstallEvents.collect { uri -> launchUpdateInstaller(uri) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        publishWidgetNavigation(intent)
    }

    private fun publishWidgetNavigation(intent: Intent?) {
        val navigation = WidgetIntents.navigationFrom(intent) ?: return
        // Consume the action so an activity recreation for a configuration
        // change does not replay a widget navigation the user already saw.
        intent?.action = null
        widgetNavigation.value = navigation
    }

    override fun onStart() {
        super.onStart()
        viewModel.onAppForeground()
        lifecycleScope.launch {
            WidgetScheduler.ensureScheduled(applicationContext)
            WidgetPreviewPublisher.publishIfDue(applicationContext)
        }
    }

    override fun onDestroy() {
        networkCallback?.let { callback ->
            runCatching { connectivityManager.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
        super.onDestroy()
    }

    override fun onStop() {
        viewModel.onAppBackground()
        super.onStop()
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

    private fun launchUpdateInstaller(uriString: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            Toast.makeText(
                this,
                "请允许 TaskDock 安装未知应用，返回后再点「安装更新」",
                Toast.LENGTH_LONG,
            ).show()
            val settingsIntent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:$packageName"),
            )
            runCatching { startActivity(settingsIntent) }
                .onFailure {
                    Toast.makeText(
                        this,
                        "无法打开安装权限设置，请在系统设置中允许安装未知应用",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            return
        }

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(uriString), "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { startActivity(intent) }
            .onFailure {
                Toast.makeText(
                    this,
                    "无法打开系统安装器：${it.message ?: "未知错误"}",
                    Toast.LENGTH_LONG,
                ).show()
            }
    }
}
