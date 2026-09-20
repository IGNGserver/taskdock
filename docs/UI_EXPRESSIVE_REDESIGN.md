# TaskDock Material 3 Expressive 重构说明

这次改造把 Material 3 Expressive 当作产品的交互与布局系统，而不是一组颜色和圆角。官方 Expressive 的核心维度是 color、shape、size、motion、containment；它强调用可理解的视觉强调帮助用户聚焦，同时仍然保持上下文、熟悉的操作范式与可访问性。

参考：

- [Material 3 Expressive](https://m3.material.io/)
- [Material 3 canonical adaptive layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)
- [Google Design: Expressive Material Design](https://design.google/library/expressive-material-design-google-research)

## 现状审查结论

旧 UI 已经有一部分 M3 token 和组件，但主工作流仍然是“侧栏 + 顶栏 + 大进度卡 + 一堆任务卡片”：

- 页面信息层级没有把“定位今天、捕获、执行、回顾”串成连续工作区；
- 进度、上下文、捕获、任务列表都是平行块，缺少 supporting-pane 关系；
- 快速添加、搜索、连接状态分别散落在顶栏，桌面和移动端的操作密度不一致；
- 空状态仍用拖拽虚线表达主要语义，任务行的 loading/dragging 反馈不足；
- Android 与 Web 的 Today 工作流结构不同，原生端仍以对话框为主。

## 六个方面的落地

### 形

- `packages/ui/src/tokens.css` 增加统一 spacing、touch target、content measure 和 expressive blob token。
- Today 主进度使用 primary container；上下文使用 surface container；捕获使用 lowest surface，层级由 tonal surface 和少量 elevation 表达，不再让每个元素都成为浮动卡片。
- 日期标记和任务状态指标使用可连续变形的 shape；状态完成时从圆形向圆角方形过渡，形状承担状态语义。
- Web/Android 继续使用语义 color role；Android 保留 dynamic color、深浅色与纯黑模式。

### 构

- Today 重排为 `定位 → 捕获 → 执行 → 回顾`：进度主区域与上下文 supporting pane 并列，捕获区连接到任务工作区，已完成任务成为侧边回顾区。
- 桌面使用 supporting-pane 布局；中等宽度自动收为单列；紧凑宽度使用单列和底部导航。
- 桌面顶栏把搜索、连接状态、快速添加收进 floating toolbar；快速添加使用 split button 保留主动作与次级入口。
- Android Today 使用 TopAppBar、summary surface、任务列表和 Extended FAB；创建任务由 AlertDialog 改为 ModalBottomSheet，让输入动作与页面空间连续。

### 件

- 使用现有 M3E `Toolbar`、`SplitButton`、`LinearProgress`、`Button`、`FilledTonalButton`、`NavigationBar`、`NavigationRail`、`Surface` 等组件语义。
- 进度使用真正的 `role=progressbar` / Compose `LinearProgressIndicator`，而不是装饰性宽度条。
- 空状态变为 surface + icon + action；拖拽提示只在拖拽状态出现，避免把“可放置区域”误解成页面空状态。

### 交

- 任务行保留 `Task` 与 `Placement` 的业务边界：Today 创建 Task 后自动创建今天的 Placement；事件状态与任务状态仍然独立。
- Web 任务行补齐 hover、focus-within、pressed、dragging、busy/error 反馈；状态按钮和排序按钮保持可访问名称及 48px 触控目标。
- Android 状态切换保留触觉反馈；底部导航/导航栏使用 primary-container selected indicator，当前页面关系清晰。
- 快速捕获、任务库加入、滚动列表、重排和创建失败仍沿用原有数据接口及错误恢复路径。

### 动

- Web 使用已有 M3E spatial/effects spring token：容器位移与 shape morph 使用 spatial spring，颜色/阴影/透明度使用 effects transition。
- Today 列表和已完成列表使用有节制的 stagger；拖拽时升高 elevation 并降低 opacity；状态按钮在完成时 morph。
- Android 依赖 Compose Material motion/ripple，并让状态 indicator 的 shape 随状态连续过渡。
- `prefers-reduced-motion` 下保留状态可见性，去除位移和 overshoot，改为短淡入淡出。

### 适

- Web 遵循 compact `<600px`、medium `600–839px`、expanded `≥840px` 的窗口分级；compact 使用 NavigationBar，medium 使用 NavigationRail，expanded 使用 NavigationDrawer。
- Today 在紧凑宽度自动收为单列，操作区变为全宽堆叠；桌面主区与 supporting pane 使用可伸缩 measure，避免宽屏空洞。
- 触控入口不依赖 hover；移动端保留底部导航和 FAB；键盘焦点、语义 heading、progressbar、状态 busy 和 reduced motion 均保留。
- Android 使用 Material 3 dynamic color（系统支持时）、深浅色主题和既有 pure-black 设置；Web 继续由统一 token 驱动主题。

## 业务语义边界

本次重构没有改变以下契约：

1. `Task` 是可复用实体，`Placement` 负责它在日期/事件/流程中的安排；
2. Today 捕获先创建 Task，再为当前日期创建 Placement；
3. 完成状态属于 Task，不属于时间点；
4. 重排只提交 Placement 顺序，状态切换只提交 Task 状态；
5. 原有导航目标、任务详情、目录定位、撤销 rollover 和错误重试仍可达。

## 验证边界

代码级验证必须和真实端到端验收分开记录：Web 类型检查、生产构建、Playwright smoke/a11y、Android 编译、真实 Android 设备和真实 Hub/provider 数据分别报告，不能互相替代。
