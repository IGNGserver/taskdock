package com.devtodo.app.ui

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.devtodo.app.data.local.*
import com.devtodo.app.data.model.*
import com.devtodo.app.data.remote.ApiClient
import com.devtodo.app.data.security.SecureAuthManager
import com.devtodo.app.data.sync.SyncEngine
import com.devtodo.app.ui.screens.*
import com.devtodo.app.ui.theme.*
import java.text.SimpleDateFormat
import java.io.File
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceScreenTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var db: AppDatabase
    private lateinit var vm: MainViewModel
    private val store = ViewModelStore()
    private val now = "2026-09-20T10:00:00Z"
    private val task =
        TaskEntity(
            "fixture-task",
            "fixture-owner",
            null,
            "ISC-1",
            "管理层权限重构（Ip数据库）",
            TaskStatus.TODO,
            TaskCategory.MISC,
            TaskPriority.NONE,
            "8192",
            1,
            null,
            now,
            now,
        )
    private val folderSpecs =
        listOf(
            "IGNG站点" to 16,
            "插件开发" to 2,
            "视频剪辑" to 2,
            "IGNGbot" to 0,
            "IGNGmc插件" to 2,
            "to_do" to 1,
            "tokenmonitor" to 2,
        )
    private val folderIds = folderSpecs.indices.map { "fixture-folder-$it" }
    private val drillDownTaskId = "fixture-folder-0-task-0"

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = "ui-test-${UUID.randomUUID()}-"
        val isolated =
            object : ContextWrapper(context) {
                override fun getApplicationContext(): Context = this

                override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                    super.getSharedPreferences(prefix + name, mode)
            }
        val auth = SecureAuthManager(isolated)
        auth.ownerId = "fixture-owner"
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        runBlocking {
            db.folderDao()
                .upsertAll(
                    folderSpecs.mapIndexed { index, (title, _) ->
                        FolderEntity(
                            id = folderIds[index],
                            ownerId = "fixture-owner",
                            parentFolderId = null,
                            title = title,
                            rank = ((index + 1) * 1024).toString(),
                            version = 1,
                            archivedAt = null,
                            createdAt = now,
                            updatedAt = now,
                        )
                    },
                )
            db.taskDao().upsertTasks(
                folderSpecs.flatMapIndexed { index, (folderName, count) ->
                    (0 until count).map { taskIndex ->
                        TaskEntity(
                            id = "${folderIds[index]}-task-$taskIndex",
                            ownerId = "fixture-owner",
                            projectId = null,
                            referenceId = null,
                            title =
                                if (index == 0 && taskIndex == 0) "站点发布检查"
                                else "$folderName 待办 ${taskIndex + 1}",
                            status = TaskStatus.TODO,
                            category = TaskCategory.MISC,
                            priority = TaskPriority.NONE,
                            rank = ((taskIndex + 1) * 1024).toString(),
                            version = 1,
                            archivedAt = null,
                            createdAt = now,
                            updatedAt = now,
                            parentFolderId = folderIds[index],
                        )
                    }
                }
            )
            db.taskDao().upsertTask(task)
            db.noteDao()
                .upsertNote(
                    NoteEntity("fixture-note", "fixture-owner", task.id, "保留原始备注", 1, now, now)
                )
        }
        compose.runOnUiThread {
            val api = ApiClient(auth)
            val engine = SyncEngine(db, api, auth)
            engine.setNetworkAvailable(false)
            vm = MainViewModel(db, engine, auth, api)
            store.put("ui", vm)
        }
    }

    @After
    fun tearDown() {
        compose.runOnUiThread {
            vm.onLoggedOut()
            store.clear()
        }
        db.close()
    }

    private fun waitForText(text: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun timePoint(
        id: String,
        type: TimePointType,
        localDate: String?,
        title: String? = null,
    ) =
        TimePointEntity(
            id = id,
            ownerId = "fixture-owner",
            type = type,
            localDate = localDate,
            title = title,
            rank = "1024",
            version = 1,
            reachedAt = null,
            archivedAt = null,
            createdAt = now,
            updatedAt = now,
        )

    private fun screenshot(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "ui-evidence").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose
                .onRoot()
                .captureToImage()
                .asAndroidBitmap()
                .compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test
    fun directoryDrillDownAndSearchKeepTaskReachable() {
        var opened: String? = null
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                TreeScreen(vm, { opened = it })
            }
        }
        waitForText("IGNG站点")
        screenshot("tasks-folders")
        compose.onNodeWithText("IGNG站点").performClick()
        waitForText("站点发布检查")
        compose.onNodeWithText("站点发布检查").performClick()
        compose.runOnIdle { assertEquals(drillDownTaskId, opened) }
        compose.onNodeWithContentDescription("返回上级目录").performClick()
        compose.onNodeWithText("全部任务").performClick()
        compose.onNodeWithText("搜索任务").performTextInput("不存在")
        compose.onNodeWithText("没有匹配的任务").assertExists()
        compose.onNodeWithText("搜索任务").performTextClearance()
        waitForText("站点发布检查")
        screenshot("tasks-search")
    }

    @Test
    fun settingsChoicesRemainSelectableInGroupedLayout() {
        var selectedTheme = ThemeMode.DARK
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                SettingsScreen(
                    viewModel = vm,
                    onThemeModeChange = { selectedTheme = it },
                    onDynamicColorChange = {},
                    onPureBlackChange = {},
                    onNavigateToArchived = {},
                    onLogout = {},
                )
            }
        }
        waitForText("TaskDock 账户")
        screenshot("settings-dark")
        compose.onNodeWithText("浅色").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(ThemeMode.LIGHT, selectedTheme) }
    }

    @Test
    fun settingsLightModeKeepsAccountSummaryVisible() {
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                SettingsScreen(
                    viewModel = vm,
                    onThemeModeChange = {},
                    onDynamicColorChange = {},
                    onPureBlackChange = {},
                    onNavigateToArchived = {},
                    onLogout = {},
                )
            }
        }
        waitForText("TaskDock 账户")
        screenshot("settings-light")
    }

    @Test
    fun plannerShowsTodayEventsAndKeepsOlderEmptyDatesReachable() {
        val zone = TimeZone.getTimeZone("Asia/Shanghai")
        val calendar = Calendar.getInstance(zone, Locale.ROOT).apply { time = Date() }
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { timeZone = zone }
        val today = formatter.format(calendar.time)
        val future = formatter.format(calendar.apply { add(Calendar.DAY_OF_YEAR, 1) }.time)
        val olderEmpty = formatter.format(calendar.apply { add(Calendar.DAY_OF_YEAR, -3) }.time)
        val todayPoint = timePoint("today", TimePointType.DATE, today)
        val futurePoint = timePoint("future", TimePointType.DATE, future)
        val oldPoint = timePoint("older-empty", TimePointType.DATE, olderEmpty)
        val eventPoint = timePoint("event", TimePointType.EVENT, null, "Launch review")
        val displayTheme = mutableStateOf(ThemeMode.DARK)
        runBlocking {
            db.timePointDao().upsertTimePoints(listOf(todayPoint, futurePoint, oldPoint, eventPoint))
            db.placementDao().upsertPlacement(
                PlacementEntity(
                    id = "fixture-placement",
                    ownerId = "fixture-owner",
                    taskId = task.id,
                    timePointId = futurePoint.id,
                    rank = "1024",
                    version = 1,
                    createdAt = now,
                    updatedAt = now,
                )
            )
        }
        compose.setContent {
            DevTodoTheme(themeMode = displayTheme.value, dynamicColor = false) {
                TimeScreen(vm, onNavigateToDetail = {}, onNavigateToTree = { _, _ -> })
            }
        }
        waitForText("今天")
        waitForText(task.title)
        screenshot("planning-dark")
        compose.runOnIdle { displayTheme.value = ThemeMode.LIGHT }
        waitForText("今天")
        screenshot("planning-light")
        compose.onNodeWithTag("planner-timepoints")
            .performScrollToNode(hasText("更早的空日期 · 1"))
        compose.onNodeWithText("更早的空日期 · 1").assertExists()
        compose.onNodeWithText("查看全部").performScrollTo().performClick()
        compose.onNodeWithText(formatLocalDate(olderEmpty, "Asia/Shanghai")).performScrollTo().assertExists()
        compose.onNodeWithTag("planner-timepoints")
            .performScrollToNode(hasText("Launch review"))
        waitForText("Launch review")
    }

    @Test
    fun detailProtectsDraftAcrossTabsAndBackAndSavesToRoom() {
        var backs = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                TaskDetailScreen(task.id, vm, { backs++ })
            }
        }
        waitForText("保留原始备注")
        compose.onNodeWithText("任务标题").performTextReplacement("准备发布")
        compose.onNodeWithText("步骤", useUnmergedTree = true).performClick()
        compose.onNodeWithText("内容", useUnmergedTree = true).performClick()
        compose.onNodeWithText("准备发布").assertExists()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("放弃未保存的更改？").assertExists()
        compose.runOnIdle { assertEquals(0, backs) }
        compose.onNodeWithText("继续编辑").performClick()
        screenshot("detail-dark")
        compose.onNodeWithText("保存").performClick()
        compose.waitUntil(10_000) {
            runBlocking {
                db.taskDao().getAllTreeTasks("fixture-owner")
                    .first { it.id == task.id }.title == "准备发布"
            }
        }
        assertEquals(
            "保留原始备注",
            runBlocking { db.noteDao().getNoteByTaskId(task.id, "fixture-owner") }?.contentMarkdown,
        )
    }

    @Test
    fun deletedArchivedTaskIsExcludedFromArchiveQuery() {
        runBlocking { db.taskDao().upsertTask(task.copy(archivedAt = now, deletedAt = now)) }
        compose.setContent { DevTodoTheme(dynamicColor = false) { ArchiveCenterV2Screen(vm, {}) } }
        waitForText("没有归档内容")
        compose.onNodeWithText("管理层权限重构（Ip数据库）").assertDoesNotExist()
    }
}
