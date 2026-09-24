# Round 2 Review — Android M3E Directory

## 结论

全量 UI 测试在 API 35/36 都通过，但截图验收未完全通过。此轮确认一个页面取图门槛问题、一个列表末端视觉风险和一个短屏大字可见性风险。没有证据证明截图中错页是稳定的导航产品故障；零动画录屏/设备帧表明页面在继续切换，且独立 Settings 页面截图正确。

## 修改意见

### P1 — 首页/目录的固定创建区前，列表仍显示被底边截断的行

证据：

- 首页：[tasks-home.png](api35-stable-pages/alltasks-test/r2-capture-search/tasks-home.png)
- 目录内部：[tasks-folder.png](api35-stable-pages/alltasks-test/r2-capture-search/tasks-folder.png)

两张 1080×2400、420 dpi 的整屏图里，固定“新建任务”区紧接在列表视口下方；视口最后一行只露出上半部，目录图也截到下一条待办。截图是在列表顶部，当前没有滚到列表末端，所以不能据此宣称数据库最后一行不可达；但首页/目录首屏确实把一条可操作行切在页底，且文档要求创建操作不盖住任务行。请在 `apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TreeScreen.kt:207-254` 核对 Scaffold 底栏预留和列表底部 padding；复测时滚到真正末项，证明末项标题、状态控件和菜单全部在固定创建操作上方完整可见，并补短屏/大字结果。

### P1 — All Tasks 与 Settings 的命名截图未证明该页像素已稳定呈现

证据：

- 集成流：[app-all-tasks.png](api35-full-rerun/device-files/ui-evidence/app-all-tasks.png)、[app-settings.png](api35-full-rerun/device-files/ui-evidence/app-settings.png) 实际画面均为目录首页。
- 独立状态切换流：[tasks-search.png](api35-stable-pages/alltasks-test/r2-capture-search/tasks-search.png) 仍是目录首页；相邻 `tasks-home.png`、`tasks-folder.png` 正常。
- 零动画诊断见 `api35-zero-animation/live-screencaps/`；页面截图名和设备实际帧存在时间偏移。Today/Schedule/Workflows/Settings 独立页面截图则正确。

这证明当前 screenshot helper/状态门槛不可靠，不证明用户手动导航后会持续停在目录页。`WorkspaceScreenTest.kt:191-202` 在 Compose/UiAutomation idle 后立即抓全屏；`waitForText` 只证明 Compose 语义节点出现过。请为 All Tasks 做直接静态屏幕截图用例（避免同帧换状态/紧接着继续导航），并在截图前加入明确稳定帧策略；Settings 集成图需断言设置页标题/返回按钮与该整屏像素同帧一致。截图门槛通过后再评估页面设计。

### P2 — 短屏 + 200% 字体首屏没有可见根目录入口

设备设为 720×1280 override、font scale 2.0、手势导航后，`directoryDrillDownAndSearchKeepTaskReachable` 在 `WorkspaceScreenTest.kt:227` 等待首个目录名 `IGNG站点` 超时 10 秒；上一门槛 `快捷视图` 可见。失败原文保存在 `api35-stable-pages/short-200-failure.xml`。该用例没有执行滚动，因此尚不能判断目录可滚动可达，也没有可靠 screenshot。

请在短屏/大字下用实际手势或 `performScrollTo()` 验证首个目录、任务和状态操作仍可达；同时检查快捷视图增长后目录主体是否被推得过深。可视首屏中目录入口暂时不可见，属于需验证的响应式风险。

## 已确认通过

- API 35 与 API 36 最新完整 `WorkspaceScreenTest` 各 18/18 通过；API 35 零动画集成导航用例 1/1 通过。
- Today、Schedule、Workflows 独立稳定页截图的状态栏图标、应用背景、返回箭头完整；目录内部也能看到系统状态栏与返回箭头。集成页缺失状态图标/返回箭头的帧不作为系统栏故障结论。
- API 35 真实三键导航已覆盖，Today 的 FAB 位于系统导航控件上方；baseline 手势模式同样采集过页面整屏图。
- 测试截图是 `UiAutomation.takeScreenshot()` 的设备整屏，不是 Compose root 截图。最新完整流没有看到离线 Snackbar 挡住页面控件。
- 集成 fixture 截图中 Today 有真实日期任务，Schedule 有日期任务，Workflow detail 显示 1 个阶段与关联任务；任务详情图与用例的详情语义门槛一致。All Tasks/Settings 的集成截图因错帧不签收。

## 未覆盖与复测边界

- Dynamic color=true、IME 展开时的实际键盘截图、TalkBack、横屏未覆盖。
- 独立 Schedule/Workflow 测试没有注入内容数据；内容对照使用集成 fixture 图，系统栏对照使用单屏稳定图。
- 三键导航的系统 overlay 与设置已恢复；AVD 已关闭。短屏/200% 失败后没有验证滚动可达。下一轮应先解决同帧截图门槛并复测列表最大滚动位置，然后补短屏/大字、dynamic color、IME 与 TalkBack 的可行项。
