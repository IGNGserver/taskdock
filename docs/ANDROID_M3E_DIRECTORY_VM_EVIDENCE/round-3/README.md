# Android M3E VM Evidence — Round 3

日期：2026-09-24。设计对照：`docs/ANDROID_M3E_DIRECTORY_CONCEPT.md` 与 `docs/design/taskdock-m3e-{home,folder,schedule}.png`。

## 结果摘要

本轮最新 APK 的 All Tasks 单测未进入 instrumentation：Gradle 报告设备 API level 为 1 并拒绝安装 APK，而同一时刻 Android 属性读回 API 35。随后 package/activity/window 服务又从可用回退到 `not found`，`sys.boot_completed` 一直为空。此结果是 AVD/ADB 框架启动故障，不是应用测试断言失败。按约定没有继续重启 AVD。

没有获得本轮最新 APK 的 All Tasks、目录 drill-down、集成导航或完整 instrumentation 新截图；旧图不可冒充本轮结果。

## 设备与日志

- 最终尝试：`taskdock_api35_review`，Android 15 / API 35，1080×2400、420 dpi，TCG 软件模拟（`-accel off`）。当时 `ro.build.version.sdk=35`，但 `sys.boot_completed` 为空；设备框架服务反复不可用。
- 最新 All Tasks 尝试的 Gradle 输出摘要：`api35-boot-diagnostics/api35-alltasks-install-failure.txt`。instrumentation 报告 `Starting 0 tests`，因此本次不计作产品测试失败或通过。
- API35 启动过程：`api35-boot-diagnostics/api35-extended-attempt-progress.txt`、`api35-extended-attempt-final.txt`、`api35-after-alltasks-failure.txt`、`api35-final-api-level1-tail.txt`。
- 其他系统阻塞：API36 system_server Watchdog/restart 记录在 `api36-boot-diagnostics/logcat-reboot-loop-tail.txt`；API30 两次 `Lost network stack` 记录在 `api30-layout-only/`。API30 曾准备 connected 测试，但 OS 服务先崩溃，没有开始测试。
- 收尾执行 `adb emu kill` 后，`adb devices -l` 无在线设备。Round3 未改动 AVD 显示、字体、主题、导航等系统设置。

## 可采信的页面证据边界

以下是本轮较早的 API35 全设备截图（`UiAutomation.takeScreenshot()`，含状态栏和系统导航区），不是当前未启动成功的测试结果：

| 页面                  | 截图                                                                         | 实际观察                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根目录首屏            | `api35-directory-method-v2/device-files/ui-evidence/tasks-home.png`          | 暗色根页显示标题、搜索/设置、Today/日程/流程/全部任务四个快捷入口、目录和新建任务操作。信息顺序与首页参考图相符；参考图为浅色，故颜色对照需与浅色同状态截图完成。 |
| 根目录最末项          | `api35-directory-method-v2/device-files/ui-evidence/tasks-home-last-row.png` | 末尾任务的标题、状态和行内菜单完整落在固定新建操作上方，触点未被创建区覆盖；底部手势区可见。该帧支持“末项可达且不被 FAB 遮挡”。                                   |
| All Tasks（诊断旧图） | `api35-targeted/device-files/ui-evidence/all-tasks.png`                      | 图像确有“全部任务”标题与搜索/状态筛选，但中央被 Android System 的“不响应”系统弹窗遮挡；标记为**无效验收截图**，不得用于完成度签收，也不是本次最新单测产物。       |

根目录的有效暗色全屏图可见系统状态栏，应用内容延伸至系统区域背景，手势条位于创建操作下方。当前可用截图没有足够证据确认本轮最新代码在所有路由上的状态栏/返回按钮同帧正确性。

## 覆盖与限制

- 当前轮最新源码/测试 APK：All Tasks 单测仅尝试安装，0 tests；目录、folder、today/schedule/workflows/settings 集成流、动态色和完整测试类均未运行。
- 720×1280 + 字体 200%、横屏、IME 实际展开、TalkBack / 无障碍服务均未在本轮覆盖。Round2 记录的短屏/大字首个目录可见性超时仍是旧版测试结果，不能当成最新 APK 的结论。
- Round2 API35/API36 完整类各 18/18、Round2 API35 三键导航/稳定页面截图仍可作历史依据，不能替代 Round3 最新源码复跑。
- 未连接真实 Hub，未使用真实凭据。
