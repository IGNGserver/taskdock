package com.devtodo.app.ui

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
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
import java.io.File
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
            null,
            "整理发布清单",
            TaskStatus.TODO,
            TaskCategory.MISC,
            TaskPriority.NONE,
            "1024",
            1,
            null,
            now,
            now,
            parentFolderId = "fixture-folder",
        )

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
                    listOf(
                        FolderEntity(
                            "fixture-folder",
                            "fixture-owner",
                            null,
                            "产品开发",
                            "1024",
                            1,
                            null,
                            createdAt = now,
                            updatedAt = now,
                        )
                    )
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
            DevTodoTheme(dynamicColor = false) { TreeScreen(vm, { opened = it }) }
        }
        waitForText("产品开发")
        screenshot("tasks-folders")
        compose.onNodeWithText("产品开发").performClick()
        waitForText("整理发布清单")
        compose.onNodeWithText("整理发布清单").performClick()
        compose.runOnIdle { assertEquals(task.id, opened) }
        compose.onNodeWithContentDescription("返回上级目录").performClick()
        compose.onNodeWithText("全部任务").performClick()
        compose.onNodeWithText("搜索任务").performTextInput("不存在")
        compose.onNodeWithText("没有匹配的任务").assertExists()
        compose.onNodeWithText("搜索任务").performTextClearance()
        waitForText("整理发布清单")
        screenshot("tasks-search")
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
            runBlocking { db.taskDao().getAllTreeTasks("fixture-owner").first().title == "准备发布" }
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
        compose.onNodeWithText("整理发布清单").assertDoesNotExist()
    }
}
