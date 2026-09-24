# Round 3 Review — Android M3E Directory

## 结论

Round3 的最终视觉签收被模拟器系统启动/ADB 状态阻塞。API35 的最新 All Tasks 测试报告 `Starting 0 tests`，设备 API 被 ddmlib 误读为 1，APK 未安装；之后 framework service 又消失。API36 曾出现 system_server Watchdog 重启，API30 出现 `Lost network stack` fatal。以上是环境阻塞，不是应用测试失败。

从本轮仍有效的 API35 根目录整屏证据看，首页的信息结构与概念图一致，末项可以滚动到完整露出并位于新建操作之上。没有新的、已证实的材料性设计问题需要源码修改；但因 All Tasks/folder/路由等最新 APK 截图没有成功重采，本轮不能宣布整套 UI 已完成最终签收。

## PASS / FAIL / BLOCKED

- **PASS — 根目录快捷视图结构**：`api35-directory-method-v2/device-files/ui-evidence/tasks-home.png` 中四个快捷视图位于目录之前，入口与参考图信息顺序一致。
- **PASS — 根目录末项与创建操作避让**：`.../tasks-home-last-row.png` 显示末项标题、状态与行内菜单完整可见，固定创建按钮没有压住该行。
- **BLOCKED — 最新 APK All Tasks**：`api35-alltasks-install-failure.txt`，0 tests，ddmlib API level=1；没有最新有效截图。
- **BLOCKED — API35 框架稳定性**：`sys.boot_completed` 未置位，framework 服务反复变成 not found。没有因这次状态报告应用行为失败。
- **BLOCKED — API36/API30 补充验证**：API36 system_server Watchdog，API30 `Lost network stack`；不得用这些设备异常图作为产品 UI 缺陷。
- **NOT COVERED — 本轮变体**：浅色当前版本首页、动态色、短屏/200% 字体、横屏、IME 展开、TalkBack。Round2 既有对应限制仍适用。
- **INVALID — 旧 All Tasks 图**：`api35-targeted/device-files/ui-evidence/all-tasks.png` 被系统“不响应”对话框遮挡；即便底层页面标题是“全部任务”，也不作为页面视觉验收通过证据。

## 后续复测建议

等同一 API35 AVD 能稳定达到 `sys.boot_completed=1` 且 package/activity/window 服务稳定后，直接重跑 `allTasksScreenShowsSearchAndRootTask` 与 `directoryDrillDownAndSearchKeepTaskReachable`，检查截图文件内容与目标页面同帧对应；如通过，再跑全类与动态色/短屏变体。不要把本轮 API level=1 安装失败计为 UI 回归。

## Addendum — Round 1 Compose All Tasks capture

Reviewed `../round-1/compose-captures/ui-evidence/app-all-tasks.png` (1080×2400). It is genuinely the All Tasks page, not an ANR dialog or a misrouted directory page: the frame shows the “全部任务” top bar with back affordance, search field and search hint, status filter chips, “任务列表 / 26 项”, and multiple task rows with status and overflow controls. Its page structure matches the concept contract for All Tasks: the existing searchable/filterable task list is a direct smart-view destination, with a way back to the directory. The current `AllTasksV2Screen` in `apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TreeScreen.kt` still contains those same structural elements (search by title/reference ID, status chips, visible result count, task list, and `onBack`).

The lower snackbar in this old capture reads “暂时无法恢复中枢连接，登录状态已保留” and overlays at least part of a visible lower task row. Round 1’s README identifies the capture as a Compose root `captureToImage()` and traces that snackbar to the navigation fixture’s unreachable test Hub. Treat this as a capture-fixture artifact to suppress/settle before screenshots, not as an All Tasks layout redesign request. The screenshot is useful for component-level structure and typography review, but its PNG alone does not establish which exact source revision produced it; it is not evidence that the current APK was visually captured.

**Design feedback from this component image: no material All Tasks structure change requested.** Search/filter/list hierarchy, page identity, and back affordance are present. The snackbar should be absent from review captures so it does not hide a task. Because this is a Compose-only image, it provides no evidence about Android status/navigation bars, edge-to-edge background continuity, safe insets, or device-level taps; those current-source/full-screen checks remain uncovered as stated above.
