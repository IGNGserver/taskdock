package com.devtodo.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.devtodo.app.data.update.AndroidUpdate
import com.devtodo.app.data.update.AppUpdateState
import com.devtodo.app.data.update.UpdateChannel
import com.devtodo.app.ui.screens.AppUpdateSettingsSection
import com.devtodo.app.ui.screens.LoginUpdatesAccess
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppUpdateSettingsTest {

    @get:Rule
    val compose = createComposeRule()

    private fun update() = AndroidUpdate(
        version = "2.0.0-rc.54",
        tag = "v2.0.0-rc.54",
        publishedAt = "2026-10-22T08:00:00Z",
        notes = "修复同步横幅和安装更新流程。",
        releaseUrl = "https://github.com/IGNGserver/taskdock/releases/tag/v2.0.0-rc.54",
        assetName = "TaskDock-2.0.0-rc.54-android.apk",
        assetUrl = "https://github.com/IGNGserver/taskdock/releases/download/v2.0.0-rc.54/TaskDock-2.0.0-rc.54-android.apk",
        assetSize = 24_450_967L,
        sha256 = "a".repeat(64),
        prerelease = true,
    )

    private fun state(update: AndroidUpdate? = null) = AppUpdateState(
        currentVersion = "2.0.0-rc.53",
        currentChannel = UpdateChannel.PRERELEASE,
        update = update,
        lastCheckedAt = 0L,
    )

    @Test
    fun showsAvailableUpdateAndTriggersDownload() {
        var downloads = 0
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state(update()),
                    onCheck = {},
                    onDownload = { downloads++ },
                    onCancelDownload = {},
                    onInstall = {},
                )
            }
        }

        compose.onNodeWithText("发现新版本 v2.0.0-rc.54").assertExists()
        compose.onNodeWithText("下载并安装").performClick()
        compose.runOnIdle { assertEquals(1, downloads) }
    }

    @Test
    fun showsCheckingState() {
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state().copy(checking = true),
                    onCheck = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onInstall = {},
                )
            }
        }

        compose.onNodeWithText("检查中").assertExists()
        compose.onNodeWithText("正在检查仓库更新…").assertExists()
    }

    @Test
    fun showsDownloadProgressAndCancelAction() {
        var cancels = 0
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state(update()).copy(
                        downloading = true,
                        progress = 0.42f,
                        downloadedBytes = 10_000_000L,
                        totalBytes = 24_450_967L,
                    ),
                    onCheck = {},
                    onDownload = {},
                    onCancelDownload = { cancels++ },
                    onInstall = {},
                )
            }
        }

        compose.onNodeWithText("42%", substring = true).assertExists()
        compose.onNodeWithText("取消下载").performClick()
        compose.runOnIdle { assertEquals(1, cancels) }
    }

    @Test
    fun showsInstallActionAfterVerifiedDownload() {
        var installs = 0
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state(update()).copy(
                        downloadedApkUri = "content://com.devtodo.app.fileprovider/app_updates/update.apk",
                    ),
                    onCheck = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onInstall = { installs++ },
                )
            }
        }

        compose.onNodeWithText("安装更新").performClick()
        compose.runOnIdle { assertEquals(1, installs) }
    }

    @Test
    fun explainsWhyDebugBuildsCannotUpdate() {
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state().copy(isDebuggable = true),
                    onCheck = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onInstall = {},
                )
            }
        }

        compose.onNodeWithText("开发版不提供应用内更新。请安装正式签名版后使用。").assertExists()
    }

    @Test
    fun showsCheckFailureWithReleasePageFallback() {
        compose.setContent {
            MaterialTheme {
                AppUpdateSettingsSection(
                    state = state().copy(error = "无法连接 GitHub，请检查网络"),
                    onCheck = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onInstall = {},
                )
            }
        }

        compose.onNodeWithText("无法连接 GitHub，请检查网络").assertExists()
        compose.onNodeWithText("打开发布页").assertExists()
    }
    @Test
    fun loginUpdateEntryWorksWithoutHubFieldsOrAuthentication() {
        var opens = 0
        var checks = 0
        var selected: UpdateChannel? = null
        var downloads = 0
        compose.setContent {
            MaterialTheme {
                LoginUpdatesAccess(
                    state = state(update()),
                    onOpen = { opens++ }, onCheck = { checks++ },
                    onChannelChange = { selected = it },
                    onDownload = { downloads++ }, onCancelDownload = {}, onInstall = {},
                )
            }
        }
        compose.onNodeWithText("关于与更新").performClick()
        compose.onNodeWithText("重新检查").performClick()
        compose.onNodeWithText("下载并安装").performClick()
        compose.onNodeWithText("正式通道").performClick()
        compose.runOnIdle {
            assertEquals(1, opens)
            assertEquals(1, checks)
            assertEquals(UpdateChannel.STABLE, selected)
            assertEquals(1, downloads)
        }
    }}
