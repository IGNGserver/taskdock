package com.devtodo.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.devtodo.app.data.local.TaskEntity
import com.devtodo.app.data.model.*
import com.devtodo.app.ui.components.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MaterialWorkspaceTest {
    @get:Rule val compose = createComposeRule()

    private fun task() =
        TaskEntity(
            "task",
            "owner",
            null,
            null,
            "检查任务",
            TaskStatus.TODO,
            TaskCategory.MISC,
            TaskPriority.NONE,
            "1024",
            1,
            null,
            "2026-09-20",
            "2026-09-20",
        )

    @Test
    fun statusCircleCyclesThreeStatesWithoutOpeningDetailAndMenuSelectsDirectly() {
        var selected: TaskStatus? = null
        var opens = 0
        compose.setContent {
            var current by remember { mutableStateOf(task()) }
            MaterialTheme {
                M3TaskRow(
                    current,
                    { opens++ },
                    {
                        selected = it
                        current = current.copy(status = it)
                    },
                )
            }
        }
        compose.onNodeWithContentDescription("检查任务，状态").performClick()
        compose.runOnIdle {
            assertEquals(TaskStatus.IN_PROGRESS, selected)
            assertEquals(0, opens)
        }
        compose.onNodeWithContentDescription("检查任务，状态").performClick()
        compose.runOnIdle {
            assertEquals(TaskStatus.DONE, selected)
            assertEquals(0, opens)
        }
        compose.onNodeWithContentDescription("检查任务，状态").performClick()
        compose.runOnIdle {
            assertEquals(TaskStatus.TODO, selected)
            assertEquals(0, opens)
        }
        compose.onNodeWithContentDescription("检查任务，更多操作").performClick()
        compose.onNodeWithText("标记为进行中").performClick()
        compose.runOnIdle {
            assertEquals(TaskStatus.IN_PROGRESS, selected)
            assertEquals(0, opens)
        }
        compose.onNodeWithText("检查任务").performClick()
        compose.runOnIdle { assertEquals(1, opens) }
    }

    @Test
    fun captureProtectsDraftAndTrimsOnlyOnCreate() {
        var created: String? = null
        var dismissed = false
        compose.setContent {
            MaterialTheme {
                CaptureSheet("新建任务", onDismiss = { dismissed = true }, onCreate = { created = it })
            }
        }
        compose.onNodeWithText("创建").assertIsNotEnabled()
        compose.onNodeWithText("任务标题").performTextInput("  保留草稿  ")
        compose.onNodeWithText("取消").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("放弃这条草稿？").assertExists()
        compose.runOnIdle {
            assertFalse(dismissed)
            assertNull(created)
        }
        compose.onNodeWithText("继续编辑").performClick()
        compose.onNodeWithText("创建").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("保留草稿", created)
            assertTrue(dismissed)
        }
    }

    @Test
    fun longTaskKeepsBothActionsAvailableInCompactWidth() {
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    M3TaskRow(task().copy(title = "一个需要在小屏幕中保持可读并且仍然能够执行完成操作的长标题"), {}, {})
                }
            }
        }
        compose
            .onNode(hasContentDescription("完成状态", substring = true))
            .assertIsDisplayed()
            .assertHeightIsAtLeast(48.dp)
        compose
            .onNode(hasContentDescription("更多操作", substring = true))
            .assertIsDisplayed()
            .assertWidthIsAtLeast(48.dp)
    }
    @Test
    fun quickCaptureFocusesKeepsFailureDraftAndWaitsForAcknowledgement() {
        var savedTitle: String? = null
        var acknowledge: ((String?) -> Unit)? = null
        compose.setContent {
            MaterialTheme {
                FloatingActionIsland(onQuickCreate = { title, result -> savedTitle = title; acknowledge = result })
            }
        }
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assertIsFocused().performTextInput("  先写下来  ")
        compose.onNodeWithTag("capture-save").performScrollTo().performClick()
        compose.onNodeWithTag("capture-save").assertIsNotEnabled()
        compose.onNodeWithContentDescription("收起并保留草稿").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals("先写下来", savedTitle)
            acknowledge!!("保存失败，请重试")
        }
        compose.onNodeWithTag("capture-title").assertTextContains("  先写下来  ")
        compose.onNodeWithTag("capture-error").assertTextEquals("保存失败，请重试")
        compose.onNodeWithContentDescription("收起并保留草稿").performScrollTo().performClick()
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assertTextContains("  先写下来  ")
        compose.onNodeWithTag("capture-save").performScrollTo().performClick()
        compose.runOnIdle { acknowledge!!(null) }
        compose.onNodeWithTag("capture-title").assertDoesNotExist()
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").assert(SemanticsMatcher.expectValue(
            SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString(""),
        ))
        compose.onNodeWithTag("capture-save").assertIsNotEnabled()
    }

    @Test
    fun continuousCaptureKeepsSheetAndClearsOnlySavedTitle() {
        var acknowledge: ((String?) -> Unit)? = null
        compose.setContent {
            MaterialTheme { FloatingActionIsland(onQuickCreate = { _, result -> acknowledge = result }) }
        }
        compose.onNodeWithTag("tree-create-action").performClick()
        compose.onNodeWithTag("capture-title").performTextInput("第一件事")
        compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)).performScrollTo().performClick()
        compose.onNodeWithTag("capture-save").performScrollTo().performClick()
        compose.runOnIdle { acknowledge!!(null) }
        compose.onNodeWithTag("capture-title").assertExists().assertIsFocused().assertIsDisplayed()
        compose.onNodeWithTag("capture-title").assert(SemanticsMatcher.expectValue(
            SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString(""),
        ))
        compose.onNodeWithTag("capture-save").assertIsNotEnabled()
        compose.onNodeWithText("已保存，继续记录下一件").assertExists()
        compose.onNodeWithTag("capture-title").performTextInput("第二件事")
        compose.onNodeWithTag("capture-save").assertIsEnabled()
    }

    @Test
    fun largeTextPreservesIndependentTaskActions() {
        var opens = 0
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                MaterialTheme {
                    Box(Modifier.width(320.dp)) {
                        M3TaskRow(task().copy(title = "大字体下也可以轻松阅读的待办事项"), { opens++ }, {})
                    }
                }
            }
        }
        compose.onNode(hasContentDescription("状态", substring = true)).assertIsDisplayed().assertWidthIsAtLeast(48.dp)
        compose.onNode(hasContentDescription("更多操作", substring = true)).assertIsDisplayed().assertWidthIsAtLeast(48.dp)
        compose.onNode(hasContentDescription("状态", substring = true)).performClick()
        compose.runOnIdle { assertEquals(0, opens) }
    }

}
