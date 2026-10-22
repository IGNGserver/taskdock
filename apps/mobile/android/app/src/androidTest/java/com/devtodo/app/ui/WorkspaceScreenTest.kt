package com.devtodo.app.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.graphics.toPixelMap

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.devtodo.app.ui.components.LocalSyncStatus
import com.devtodo.app.ui.components.SyncStatusBanner
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
import com.devtodo.app.ui.navigation.Screen
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
    private var navigationVm: MainViewModel? = null
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
            navigationVm?.onLoggedOut()
            navigationVm = null
            vm.onLoggedOut()
            store.clear()
        }
        db.close()
    }

    private fun waitForText(text: String, substring: Boolean = false) {
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithText(text, substring = substring).assertIsDisplayed()
                true
            }.getOrDefault(false)
        }
    }

    private fun waitForDescription(description: String) {
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithContentDescription(description).assertIsDisplayed()
                true
            }.getOrDefault(false)
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
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val uiAutomation = instrumentation.uiAutomation
        uiAutomation.waitForIdle(500L, 10_000L)
        // Compose semantics can update before the emulator presents the matching frame.
        // Keep the test on this page until the system compositor has time to catch up.
        SystemClock.sleep(750L)
        instrumentation.waitForIdleSync()
        uiAutomation.waitForIdle(250L, 10_000L)
        val bitmap =
            uiAutomation.takeScreenshot()
                ?: error("Unable to capture device screenshot: $name")
        File(directory, "$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test
    fun calendarScreenShowsMonthInsteadOfAllTasksSearch() {
        var backCount = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                CalendarScreen(
                    viewModel = vm,
                    onNavigateToDay = {},
                    onNavigateToEvents = {},
                    onBack = { backCount++ },
                )
            }
        }
        waitForText("日历")
        waitForText("点击日期查看当天安排")
        compose.onNodeWithTag("calendar-month").assertIsDisplayed()
        compose.onNodeWithText("搜索任务").assertDoesNotExist()
        compose.onNodeWithText("全部任务").assertDoesNotExist()
        screenshot("calendar-month")
        compose.onNodeWithContentDescription("返回目录").performClick()
        compose.runOnIdle { assertEquals(1, backCount) }
    }

    @Test
    fun directoryDrillDownKeepsTaskReachable() {
        var opened: String? = null
        var shortcut: String? = null
        var settingsOpened = false
        val openFolder = mutableStateOf<String?>(null)
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                TreeScreen(
                    vm,
                    { opened = it },
                    folderId = openFolder.value,
                    onOpenFolder = { openFolder.value = it },
                    onBack = { openFolder.value = null },
                    onNavigateToShortcut = { shortcut = it },
                    onOpenSettings = { settingsOpened = true },
                )
            }
        }
        waitForText("快捷视图")
        screenshot("tasks-home")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("tokenmonitor"))
        waitForText("tokenmonitor")
        compose.onNodeWithText("tokenmonitor").assertIsDisplayed()
        compose.onNodeWithContentDescription("tokenmonitor，更多操作").assertIsDisplayed()
        compose.onNodeWithTag("tree-create-action").assertIsDisplayed()
        screenshot("tasks-home-last-directory")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText(task.title))
        waitForText(task.title)
        compose.onNodeWithContentDescription("${task.title}，状态").assertIsDisplayed()
        compose.onNodeWithContentDescription("${task.title}，更多操作").assertIsDisplayed()
        compose.onNodeWithTag("tree-create-action").assertIsDisplayed()
        val lastRootRowBounds =
            compose.onNodeWithTag("tree-row-${task.id}").fetchSemanticsNode().boundsInRoot
        val rootCreateBounds =
            compose.onNodeWithTag(
                "tree-create-action",
            ).fetchSemanticsNode().boundsInRoot
        assertTrue(
            "The final root task row must clear the create action: $lastRootRowBounds / $rootCreateBounds",
            lastRootRowBounds.bottom <= rootCreateBounds.top,
        )
        screenshot("tasks-home-last-row")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("IGNG站点"))
        waitForText("IGNG站点")
        screenshot("tasks-home-first-directory")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("快捷视图"))
        waitForText("快捷视图")
        compose.onNodeWithText("今天").performClick()
        compose.runOnIdle { assertEquals(Screen.Today.route, shortcut) }
        compose.onNodeWithText("流程").performClick()
        compose.runOnIdle { assertEquals(Screen.Workflows.route, shortcut) }
        compose.onNodeWithContentDescription("设置").performClick()
        compose.runOnIdle { assertTrue(settingsOpened) }
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("IGNG站点"))
        compose.onNodeWithText("IGNG站点").performClick()
        waitForText("站点发布检查")
        screenshot("tasks-folder")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("IGNG站点 待办 16"))
        waitForText("IGNG站点 待办 16")
        compose.onNodeWithText("IGNG站点 待办 16").assertIsDisplayed()
        compose.onNodeWithContentDescription("IGNG站点 待办 16，状态").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "待开始"))
        compose.onNodeWithContentDescription("IGNG站点 待办 16，更多操作").assertIsDisplayed()
        compose.onNodeWithTag("tree-create-action").assertIsDisplayed()
        val lastTaskBounds =
            compose.onNodeWithTag("tree-row-${folderIds[0]}-task-15").fetchSemanticsNode().boundsInRoot
        val folderCreateBounds =
            compose.onNodeWithTag(
                "tree-create-action",
            ).fetchSemanticsNode().boundsInRoot
        assertTrue(
            "The last folder task must clear the create action: $lastTaskBounds / $folderCreateBounds",
            lastTaskBounds.bottom <= folderCreateBounds.top,
        )
        screenshot("tasks-folder-last-task")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("站点发布检查"))
        compose.onNodeWithText("站点发布检查").performClick()
        compose.runOnIdle { assertEquals(drillDownTaskId, opened) }
        compose.onNodeWithContentDescription("返回上级目录").performClick()
        waitForText("快捷视图")
        compose.onNodeWithText("事件").performClick()
        compose.runOnIdle { assertEquals(Screen.Events.route, shortcut) }
    }

    @Test
    fun statusEditStaysInPlaceUntilTheDirectoryIsReopened() {
        val openFolder = mutableStateOf<String?>(folderIds[0])
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                key(openFolder.value) {
                    TreeScreen(
                        vm,
                        onNavigateToDetail = {},
                        folderId = openFolder.value,
                        onOpenFolder = { openFolder.value = it },
                        onBack = { openFolder.value = null },
                    )
                }
            }
        }
        waitForText("当前目录")
        val rowTag = "tree-row-${folderIds[0]}-task-0"
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithTag(rowTag).assertIsDisplayed(); true }.getOrDefault(false)
        }
        val before = compose.onNodeWithTag(rowTag).fetchSemanticsNode().boundsInRoot
        compose.onNodeWithContentDescription("站点发布检查，状态").performClick()
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithContentDescription("站点发布检查，状态")
                    .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "进行中"))
                true
            }.getOrDefault(false)
        }
        // The circle answers immediately, but the row keeps its group and slot
        // until the directory is opened again.
        val after = compose.onNodeWithTag(rowTag).fetchSemanticsNode().boundsInRoot
        assertEquals(before, after)
        compose.onNodeWithText("待开始 · 16").assertExists()
        compose.onNodeWithText("进行中 · 1").assertDoesNotExist()
        screenshot("status-pinned")
        compose.runOnIdle { openFolder.value = null }
        waitForText("快捷视图")
        compose.runOnIdle { openFolder.value = folderIds[0] }
        waitForText("当前目录")
        waitForText("进行中 · 1")
        waitForText("待开始 · 15")
    }

    @Test
    fun todayScreenReturnsToDirectory() {
        var backCount = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                TodayV2Screen(vm, onNavigateToDetail = {}, onBack = { backCount++ })
            }
        }
        waitForText("今天")
        screenshot("today")
        compose.onNodeWithContentDescription("返回目录").performClick()
        compose.runOnIdle { assertEquals(1, backCount) }
    }

    @Test
    fun calendarScreenReturnsToDirectory() {
        var backCount = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                CalendarScreen(
                    viewModel = vm,
                    onNavigateToDay = {},
                    onNavigateToEvents = {},
                    onBack = { backCount++ },
                )
            }
        }
        waitForDescription("返回目录")
        screenshot("schedule")
        compose.onNodeWithContentDescription("返回目录").performClick()
        compose.runOnIdle { assertEquals(1, backCount) }
    }

    @Test
    fun workflowsScreenReturnsToDirectory() {
        var backCount = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                WorkflowsV2Screen(vm, onNavigateToDetail = {}, onBack = { backCount++ })
            }
        }
        waitForText("流程看板")
        screenshot("workflows")
        compose.onNodeWithContentDescription("返回目录").performClick()
        compose.runOnIdle { assertEquals(1, backCount) }
    }

    @Test
    fun appStartsInDirectoryAndSmartViewsReturnToIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = "navigation-test-${UUID.randomUUID()}-"
        val isolated =
            object : ContextWrapper(context) {
                override fun getApplicationContext(): Context = this

                override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                    super.getSharedPreferences(prefix + name, mode)
            }
        val auth = SecureAuthManager(isolated).apply {
            ownerId = "fixture-owner"
            username = "UI fixture"
            val payload = Base64.encodeToString(
                "{\"exp\":${System.currentTimeMillis() / 1000L + 3600L}}".toByteArray(),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
            accessToken = "fixture.$payload.signature"
        }
        val todayDate =
            SimpleDateFormat("yyyy-MM-dd", Locale.ROOT)
                .apply { timeZone = TimeZone.getTimeZone("Asia/Shanghai") }
                .format(Date())
        val todayPoint = timePoint("navigation-today", TimePointType.DATE, todayDate)
        val workflow =
            WorkflowEntity(
                id = "navigation-workflow",
                ownerId = "fixture-owner",
                name = "站点发布流程",
                rank = "1024",
                version = 1,
                archivedAt = null,
                createdAt = now,
                updatedAt = now,
            )
        val workflowStage =
            WorkflowStageEntity(
                id = "navigation-workflow-stage",
                ownerId = "fixture-owner",
                workflowId = workflow.id,
                name = "发布准备",
                rank = "1024",
                version = 1,
                createdAt = now,
                updatedAt = now,
            )
        runBlocking {
            db.timePointDao().upsertTimePoint(todayPoint)
            db.placementDao().upsertPlacement(
                PlacementEntity(
                    id = "navigation-today-placement",
                    ownerId = "fixture-owner",
                    taskId = task.id,
                    timePointId = todayPoint.id,
                    rank = "1024",
                    version = 1,
                    createdAt = now,
                    updatedAt = now,
                ),
            )
            db.workflowDao().upsertWorkflow(workflow)
            db.workflowDao().upsertStages(listOf(workflowStage))
            db.workflowDao().upsertMemberships(
                listOf(
                    WorkflowTaskMembershipEntity(
                        id = "navigation-workflow-membership",
                        ownerId = "fixture-owner",
                        workflowId = workflow.id,
                        stageId = workflowStage.id,
                        taskId = task.id,
                        rank = "1024",
                        version = 1,
                        createdAt = now,
                        updatedAt = now,
                    ),
                ),
            )
        }
        val api = ApiClient(auth)
        val engine = SyncEngine(db, api, auth).apply { setNetworkAvailable(false) }
        navigationVm = MainViewModel(db, engine, auth, api)

        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                TaskDockApp(navigationVm!!)
            }
        }
        waitForText("快捷视图")
        compose.waitUntil(10_000) { navigationVm!!.foldersV2.value.size == 7 }
        // The chosen compact layout must expose actual directories without an initial scroll.
        compose.onNodeWithText("IGNG站点").assertIsDisplayed()
        compose.onNodeWithText("插件开发").assertIsDisplayed()
        val secondFolder = compose.onNodeWithTag("tree-row-${folderIds[1]}").fetchSemanticsNode().boundsInRoot
        val createAction = compose.onNodeWithTag("tree-create-action").fetchSemanticsNode().boundsInRoot
        assertTrue("The second directory must clear the capture action on the initial screen", secondFolder.bottom <= createAction.top)
        screenshot("app-directory-initial")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("IGNG站点"))
        waitForText("IGNG站点")
        compose.onNodeWithText("任务库").assertDoesNotExist()
        compose.onNodeWithText("计划").assertDoesNotExist()
        screenshot("app-directory")
        compose.onNodeWithTag("directory-tree-list")
            .performScrollToNode(hasText("快捷视图"))

        compose.onNodeWithText("今天").performClick()
        waitForDescription("返回目录")
        waitForText("已完成 0 / 1")
        waitForText(task.title)
        screenshot("app-today")
        compose.onNodeWithContentDescription("返回目录").performClick()
        waitForText("快捷视图")

        compose.onNodeWithText("日历").performClick()
        waitForDescription("返回目录")
        waitForText("点击日期查看当天安排")
        screenshot("app-schedule")
        compose.onNodeWithContentDescription("返回目录").performClick()
        waitForText("快捷视图")

        compose.onNodeWithText("流程").performClick()
        waitForText(workflow.name)
        screenshot("app-workflows")
        compose.onNodeWithText(workflow.name).performClick()
        waitForText(workflowStage.name)
        waitForText("1 个阶段", substring = true)
        waitForText(task.title)
        screenshot("app-workflow-detail")
        compose.onNodeWithContentDescription("返回流程列表").performClick()
        waitForText(workflow.name)
        compose.onNodeWithContentDescription("返回目录").performClick()
        waitForText("快捷视图")

        compose.onNodeWithContentDescription("设置").performClick()
        waitForText("设置")
        waitForText("UI fixture")
        compose.onNodeWithText("快捷视图").assertDoesNotExist()
        screenshot("app-settings")
        compose.onNodeWithContentDescription("返回").performClick()
        waitForText("快捷视图")

        compose.onNodeWithText("IGNG站点").performScrollTo().performClick()
        waitForText("站点发布检查")
        waitForText("当前目录")
        screenshot("app-folder")
        compose.onNodeWithText("站点发布检查").performClick()
        waitForText("任务详情")
        compose.onNodeWithContentDescription("返回").performClick()
        waitForText("IGNG站点")
        compose.onNodeWithContentDescription("返回上级目录").performClick()
        waitForText("快捷视图")
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
                    onLogout = {},
                    onBack = {},
                )
            }
        }
        waitForText("当前账户")
        screenshot("settings-dark")
        compose.onNodeWithText("已登录设备").assertDoesNotExist()
        compose.onNodeWithText("添加到桌面").assertDoesNotExist()
        compose.onNodeWithText("隐藏任务标题").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Material You 动态配色").performScrollTo()
        compose.onNodeWithText("浅色").performScrollTo().assertIsDisplayed().performClick()
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
                    onLogout = {},
                    onBack = {},
                )
            }
        }
        waitForText("当前账户")
        screenshot("settings-light")
    }

    @Test
    fun directoryKeepsStructureWithDynamicColor() {
        var settings = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = true) {
                TreeScreen(vm, onNavigateToDetail = {}, onOpenSettings = { settings++ })
            }
        }
        waitForText("快捷视图")
        val rootBounds = compose.onRoot().fetchSemanticsNode().boundsInRoot
        for (description in listOf("设置")) {
            val action = compose.onNodeWithContentDescription(description).assertIsDisplayed()
            val bounds = action.fetchSemanticsNode().boundsInRoot
            assertTrue("$description must be fully inside the screen: $bounds / $rootBounds",
                bounds.left >= rootBounds.left && bounds.right <= rootBounds.right &&
                bounds.top >= rootBounds.top && bounds.bottom <= rootBounds.bottom)
            val pixels = action.captureToImage().toPixelMap()
            val background = pixels[0, 0]
            val iconVisible = (0 until pixels.width).any { x ->
                (0 until pixels.height).any { y ->
                    val color = pixels[x, y]
                    kotlin.math.abs(color.red - background.red) +
                        kotlin.math.abs(color.green - background.green) +
                        kotlin.math.abs(color.blue - background.blue) > 0.3f
                }
            }
            assertTrue("$description must have a visible icon", iconVisible)
            action.performClick()
        }
        compose.runOnIdle { assertEquals(1, settings) }
        compose.onNodeWithContentDescription("搜索全部任务").assertDoesNotExist()
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText("我的目录"))
        waitForText("我的目录")
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText("快捷视图"))
        compose.onNodeWithText("快捷视图").assertIsDisplayed()
        screenshot("directory-dynamic-color")
    }

    @Test
    fun calendarOpensASelectedDateAndShowsEventEntryPoint() {
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
        var selectedDate: String? = null
        var eventsOpened = 0
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
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                CalendarScreen(
                    viewModel = vm,
                    onNavigateToDay = { selectedDate = it },
                    onNavigateToEvents = { eventsOpened++ },
                )
            }
        }
        waitForText("日历")
        compose.onNodeWithTag("calendar-day-$today").performClick()
        compose.runOnIdle { assertEquals(today, selectedDate) }
        compose.onNodeWithContentDescription("事件").performClick()
        compose.runOnIdle { assertEquals(1, eventsOpened) }
        screenshot("calendar-event-entry")
    }

    @Test
    fun staleNoticeRemainsBelowTheToolbarWithLargeText() {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(density.density, 2f),
                LocalSyncStatus provides { SyncStatusBanner(vm, "today") },
            ) {
                DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                    Box(Modifier.width(320.dp)) { TodayV2Screen(vm, {}) }
                }
            }
        }
        compose.onNodeWithTag("sync-status-banner").assertIsDisplayed()
        compose.onNodeWithText("重试").assertIsDisplayed()
        val title = compose.onNodeWithText("今天").fetchSemanticsNode().boundsInRoot
        val banner = compose.onNodeWithTag("sync-status-banner").fetchSemanticsNode().boundsInRoot
        assertTrue("notice overlaps the toolbar", banner.top >= title.bottom)
        screenshot("stale-notice-large-text")
    }

    @Test
    fun remoteRevisionsUpdateUntouchedDetailsButPreserveDrafts() {
        compose.setContent { DevTodoTheme(dynamicColor = false) { TaskDetailScreen(task.id, vm, {}) } }
        waitForText("保留原始备注")
        runBlocking {
            db.taskDao().upsertTask(task.copy(title = "远端新版标题", version = 2))
            db.noteDao().upsertNote(NoteEntity("fixture-note", "fixture-owner", task.id, "远端新版备注", 2, now, now))
        }
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithText("远端新版备注").assertExists(); true }.getOrDefault(false) }
        compose.onNodeWithText("任务标题").performScrollTo().performTextReplacement("我的未保存草稿")
        runBlocking { db.taskDao().upsertTask(task.copy(title = "另一设备的修改", version = 3)) }
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithText("中枢内容已变化，已保留你的未保存编辑。请核对后再保存。").assertExists(); true }.getOrDefault(false) }
        compose.onNodeWithText("我的未保存草稿").assertExists()
        screenshot("detail-remote-draft-conflict")
        // Reverting the draft to its old baseline must reveal the newer remote
        // value even if no further DB invalidation or network response arrives.
        compose.onNodeWithText("任务标题").performScrollTo().performTextReplacement("远端新版标题")
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithText("另一设备的修改").assertExists(); true }.getOrDefault(false) }
    }

    @Test
    fun uncachedTodayDoesNotClaimAnAuthoritativeEmptyState() {
        compose.setContent { DevTodoTheme(dynamicColor = false) { TodayV2Screen(vm, {}) } }
        compose.onNodeWithText("今日安排尚未加载完整，请查看顶部更新状态。").assertExists()
        compose.onNodeWithText("今天还没有安排").assertDoesNotExist()
    }

    @Test
    fun detailProtectsDraftAcrossTabsAndBackAndSavesToRoom() {
        var backs = 0
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.DARK, dynamicColor = false) {
                TaskDetailScreen(task.id, vm, { backs++ })
            }
        }
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithText("保留原始备注").assertExists(); true }.getOrDefault(false)
        }
        compose.onNodeWithText("保留原始备注").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("任务标题").performScrollTo().assertIsDisplayed().performTextReplacement("准备发布")
        compose.onNodeWithText("任务标题").assertIsDisplayed()
        compose.onNodeWithTag("detail-tab-1").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithTag("detail-tab-0").performScrollTo().assertIsDisplayed().performClick()
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
        waitForText("暂无归档内容")
        compose.onNodeWithText("管理层权限重构（Ip数据库）").assertDoesNotExist()
    }
    @Test
    fun directoryCaptureKeepsContextDraftAndSavesToRoom() {
        val capturedTitle = "整理发布资料"
        val openFolder = mutableStateOf<String?>(null)
        compose.setContent {
            DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                TreeScreen(
                    vm,
                    onNavigateToDetail = {},
                    folderId = openFolder.value,
                    onOpenFolder = { openFolder.value = it },
                    onBack = { openFolder.value = null },
                )
            }
        }
        waitForText("快捷视图")
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText("IGNG站点"))
        compose.onNodeWithText("IGNG站点").performClick()
        waitForText("当前目录")
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assertIsFocused().performTextInput("  $capturedTitle  ")
        compose.onNodeWithText("存入 · IGNG站点").performScrollTo().assertIsDisplayed()
        screenshot("capture-folder-draft")
        compose.onNodeWithContentDescription("收起并保留草稿").performScrollTo().performClick()
        compose.onNodeWithContentDescription("返回上级目录").performClick()
        waitForText("TaskDock")
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assert(SemanticsMatcher.expectValue(
            SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString(""),
        ))
        compose.onNodeWithContentDescription("收起并保留草稿").performScrollTo().performClick()
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText("IGNG站点"))
        compose.onNodeWithText("IGNG站点").performClick()
        waitForText("当前目录")
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assertTextContains("  $capturedTitle  ")
        screenshot("capture-folder-resumed")
        compose.onNodeWithText("存入 · IGNG站点").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("安排 · 暂不安排").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("今天").assertIsDisplayed().performClick()
        compose.onNodeWithText("安排 · 今天").performScrollTo().assertIsDisplayed()
        screenshot("capture-folder-today")
        compose.onNodeWithTag("capture-save").performScrollTo().assertIsDisplayed().performClick()
        compose.waitUntil(10_000) {
            runBlocking { db.taskDao().getAllTreeTasks("fixture-owner").any { it.title == capturedTitle } }
        }
        val created = runBlocking { db.taskDao().getAllTreeTasks("fixture-owner").single { it.title == capturedTitle } }
        assertEquals(folderIds[0], created.parentFolderId)
        assertEquals(TaskStatus.TODO, created.status)
        val placement = runBlocking {
            db.placementDao().getPlacementsByTaskIdForOwner("fixture-owner", created.id).single()
        }
        val expectedDate = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
            timeZone = TimeZone.getTimeZone("Asia/Shanghai")
        }.format(Date())
        assertEquals(expectedDate, runBlocking {
            db.timePointDao().getTimePointById(placement.timePointId, "fixture-owner")?.localDate
        })
        assertNotNull(runBlocking { db.noteDao().getNoteByTaskId(created.id, "fixture-owner") })
        assertTrue(runBlocking { db.outboxDao().getPendingItems("fixture-owner").any {
            it.command == "task.create" && it.entityId == created.id
        } })
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithTag("capture-title").assertDoesNotExist(); true }.getOrDefault(false)
        }
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText(capturedTitle))
        waitForText(capturedTitle)
        screenshot("capture-folder-saved")
    }

    @Test
    fun tabletLandscapeShowsTwoPaneDirectoryAndInlineTaskDetailWithoutLosingListContext() {
        val tabletInfo = calculateAdaptiveInfo(widthDp = 1280, heightDp = 800, isLandscape = true)
        var navigatedAwayTaskId: String? = null
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density * 0.25f, density.fontScale)) {
                DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                    CompositionLocalProvider(LocalAdaptiveInfo provides tabletInfo) {
                        TreeScreen(
                            viewModel = vm,
                            onNavigateToDetail = { navigatedAwayTaskId = it },
                        )
                    }
                }
            }
        }
        waitForText("快捷视图")
        // Before selecting a task, the right pane displays the directory placeholder.
        compose.onNodeWithTag("directory-detail-placeholder").assertIsDisplayed()
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText(task.title))
        waitForText(task.title)
        compose.onNodeWithText(task.title).performClick()
        // In tablet two-pane mode, tapping a task opens the inline detail pane on the right
        // without navigating away from the directory list.
        compose.runOnIdle { assertNull(navigatedAwayTaskId) }
        compose.onNodeWithTag("embedded-task-detail-pane").assertIsDisplayed()
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithText("保留原始备注").assertExists(); true }.getOrDefault(false)
        }
        compose.onNodeWithTag("directory-tree-list").performScrollToNode(hasText("IGNG站点"))
        waitForText("IGNG站点")
        compose.onNodeWithContentDescription("关闭详情").performClick()
        compose.onNodeWithTag("directory-detail-placeholder").assertIsDisplayed()
    }

    @Test
    fun tabletLandscapeCalendarShowsSplitDayScheduleInline() {
        val zone = TimeZone.getTimeZone("Asia/Shanghai")
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { timeZone = zone }
        val today = formatter.format(Date())
        val todayPoint = timePoint("tablet-today", TimePointType.DATE, today)
        runBlocking {
            db.timePointDao().upsertTimePoint(todayPoint)
            db.placementDao().upsertPlacement(
                PlacementEntity(
                    id = "tablet-today-placement",
                    ownerId = "fixture-owner",
                    taskId = task.id,
                    timePointId = todayPoint.id,
                    rank = "1024",
                    version = 1,
                    createdAt = now,
                    updatedAt = now,
                ),
            )
        }
        val tabletInfo = calculateAdaptiveInfo(widthDp = 1280, heightDp = 800, isLandscape = true)
        var fullScreenNavigatedDate: String? = null
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density * 0.25f, density.fontScale)) {
                DevTodoTheme(themeMode = ThemeMode.LIGHT, dynamicColor = false) {
                    CompositionLocalProvider(LocalAdaptiveInfo provides tabletInfo) {
                        CalendarScreen(
                            viewModel = vm,
                            onNavigateToDay = { fullScreenNavigatedDate = it },
                            onNavigateToEvents = {},
                            onNavigateToDetail = {},
                            onNavigateToTree = { _, _ -> },
                        )
                    }
                }
            }
        }
        waitForText("日历")
        // Both the monthly calendar grid and today's day schedule pane exist side-by-side.
        compose.onNodeWithTag("calendar-month").assertIsDisplayed()
        compose.onNodeWithTag("day-schedule-$today").assertIsDisplayed()
        waitForText(task.title)
        compose.onNodeWithTag("calendar-day-$today").performClick()
        compose.runOnIdle { assertNull(fullScreenNavigatedDate) }
    }

}
