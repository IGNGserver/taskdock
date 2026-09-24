# Android M3E VM Evidence — Round 2

验收日期：2026-09-24。对照文档：`docs/ANDROID_M3E_DIRECTORY_CONCEPT.md`；视觉参照：`docs/design/taskdock-m3e-home.png`、`taskdock-m3e-folder.png`、`taskdock-m3e-schedule.png`。

## 设备与安全边界

- API 35：AVD `taskdock_api35_review`，Android 15，1080×2400、420 dpi。基线为手势导航、字体比例 1.0、浅色系统模式。
- API 36：AVD `taskdock_api36_review`，Android 16，1080×2400、420 dpi。完整测试类运行时在线，之后一次过滤复跑中设备断连。
- 测试只使用 Room fixture 与本地假 session；未连接真实 Hub，未输入真实凭据。
- API 35 的尺寸、密度、字体、夜间模式、旋转、手势导航覆盖层和动画比例已恢复原值；恢复后读回 1080×2400、420 dpi、font scale 1.0、navigation mode 2、Night=no、gestural overlay enabled、window/transition scale 1.0。AVD 已关闭。

## 截图来源

- 测试目录中以 `*.png` 保存的页面图，均由 `WorkspaceScreenTest.screenshot()` 调用 `UiAutomation.takeScreenshot()` 生成，是**设备整屏截图**，包含 Android 状态栏与系统导航区；没有用 Compose root capture 代替系统栏截图。
- `api35-stable-pages/three-button-nav/device-system-ui.png` 是额外的 `adb exec-out screencap` 原始设备截图。它记录三键导航已切换时的系统桌面，用来验证 overlay 状态；页面验收用的是同目录的 `three-button-nav-actual/today.png`。
- `api35-full-rerun/device-full-class.mp4`、`api36-full-rerun/device-full-class.mp4` 是 Android VM 全屏录屏。`api35-zero-animation/nav-round2-final-device.mp4` 是导航用例期间的录屏，但不按视频时间给其中每个瞬时帧分配页面名。
- `api35-zero-animation/live-screencaps/` 是在零动画导航序列中围绕截图文件写入时取的 ADB 全屏帧。它们显示路由画面仍在推进，只用于定位截图时序，不是静止页面证据。

## 运行结果

- 最新完整 `:app:connectedDebugAndroidTest`：API 35 与 API 36 各 18/18 通过。主日志为 `api35-api36-full-rerun.log`；JUnit XML/HTML 保存在 `gradle-report-latest/`。完整运行的页面文件在 `api35-full-rerun/device-files/ui-evidence/`。
- 后续 API 35 单页复跑：目录/搜索、Today、Schedule、Workflow、Settings light、三键 Today 均各 1/1 通过。`api35-zero-animation.log` 中零动画的集成导航也通过 1/1。
- 720×1280 override + 200% 字体的目录 smoke 未通过可见性门槛：`ComposeTimeoutException: Condition still not satisfied after 10000 ms`，定位 `WorkspaceScreenTest.kt:227` 的 `waitForText("IGNG站点")`。`快捷视图` 已出现；未执行滚动，未产出截图。因此只证明首个目录名当时不在可见节点中，不证明滚动后不可达。XML 已复制为 `api35-stable-pages/short-200-failure.xml`。
- 后续过滤复跑 API 36 时曾报告 `Starting 0 tests`，随后 `emulator-5556` 断连；这不是页面断言失败。对应日志：`nav-recapture-latest.log`。不以该次运行推翻此前 API 36 的完整类 18/18 结果。

## 当前轮逐页证据

| 页面/状态                   | 证据                                                                  | 观察                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首页（暗色，根列表）        | `api35-stable-pages/alltasks-test/r2-capture-search/tasks-home.png`   | 根页、四个快捷视图、目录、顶部设置/搜索与新增任务主操作均呈现；截图顶部和底部系统区域可见。列表视口底边有下一行被截断，需结合最大滚动位置确认最后一行是否完全露出。                                    |
| 目录内部（暗色）            | `api35-stable-pages/alltasks-test/r2-capture-search/tasks-folder.png` | 目录返回、标题、摘要、状态分组、任务状态控件与新增操作均可见；列表视口下缘也截到下一行。                                                                                                               |
| Today（浅色）               | `api35-stable-pages/today-test/today.png`                             | 空状态，日期正确；状态栏、返回箭头、FAB 与手势区均在。                                                                                                                                                 |
| Schedule（浅色，独立空态）  | `api35-stable-pages/schedule-test/schedule.png`                       | 页面结构、返回、日历入口、日期选择操作和系统区可见；该独立测试没有注入日程任务。集成 fixture 的日期任务在 `api35-full-rerun/device-files/ui-evidence/app-schedule.png`。                               |
| Workflows（浅色，独立空态） | `api35-stable-pages/workflows-test/workflows.png`                     | 页面结构、返回、新建流程操作和系统区可见；该独立测试没有流程 fixture。集成 fixture 有 1 个阶段和关联任务，见 `api35-full-rerun/device-files/ui-evidence/app-workflow-detail.png`。                     |
| Settings（浅色，独立屏幕）  | `api35-stable-pages/settings-test/settings-light.png`                 | 账户摘要和设置内容正确，状态栏/手势区可见。测试直接实例化 SettingsScreen 且没有传 `onBack`，不能用此图验收导航路由的返回箭头。                                                                         |
| Today（三键导航）           | `api35-stable-pages/three-button-nav-actual/today.png`                | 实际系统三键导航条可见，FAB 位于系统导航条上方。只改 `navigation_mode=0` 没有切换导航样式；启用 `com.android.internal.systemui.navbar.threebutton` overlay 后才得到该图，随后已恢复 gestural overlay。 |
| All Tasks（未通过截图门槛） | `api35-stable-pages/alltasks-test/r2-capture-search/tasks-search.png` | 文件实际仍是目录首页，不能作为 All Tasks 页面证据。                                                                                                                                                    |

集成导航截图 `api35-full-rerun/device-files/ui-evidence/app-all-tasks.png` 和 `app-settings.png` 也显示目录首页；同一用例等待目标语义节点后仍取得旧帧。关闭窗口/转场动画后仍复现。随后独立测试的 Tree→AllTasks 状态切换图 `tasks-search.png` 仍是根页，而 Settings 独立页图正确。综合判定为 screenshot 与 Compose 状态更新/帧提交不同步，尚无证据证明 All Tasks 或 Settings 的产品路由持续停在目录页。截图 helper 目前只做 Compose/UiAutomation idle 等待，目标节点曾出现不等于截图像素同帧对应。

## 覆盖限制

- 已有浅色和暗色静态画面；相关测试固定 `dynamicColor=false`，没有实际验收 dynamic color=true 的根页/设置页。
- 搜索测试执行了 `performTextInput`，但本轮没有键盘展开状态的可信整屏截图。IME 避让仍未验证。
- TalkBack、本轮横屏、API 36 的新一轮页面截图未覆盖。
- 200% 字体与短屏变体因用例在首次目录可见性等待处超时，没有滚动后验收或对应页面截图。
