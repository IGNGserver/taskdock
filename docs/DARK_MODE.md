# 深色模式

## 设计原则

- Web、PWA、Electron 和 Capacitor Android 继续共用同一份 React UI。
- 第一版只跟随设备系统主题，不增加账号级的主题字段，也不修改同步协议。
- 页面使用语义化 CSS 令牌，不使用全局反色或 WebView 强制反色。
- 主题切换必须覆盖首屏、弹窗、抽屉、状态提示、移动底栏和原生窗口/系统栏。

## 主题来源

| 客户端       | 读取方式                                            | 变化监听                                                                                             |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 浏览器 / PWA | `window.matchMedia('(prefers-color-scheme: dark)')` | `MediaQueryList.change`                                                                              |
| Electron     | 主进程 `nativeTheme.shouldUseDarkColors`            | `nativeTheme.updated`，经 preload 类型化桥接                                                         |
| Android      | `Configuration.uiMode & UI_MODE_NIGHT_MASK`         | `onCreate`、`onConfigurationChanged`、`onResume`；原生向 WebView 派发 `devtodo:native-theme-changed` |

主题控制器将结果归一为 `light` 或 `dark`，写入 `<html data-theme="…">` 和 `color-scheme`。`index.html` 在 React 启动前先执行一次轻量判断，避免首屏闪烁。

首屏判断脚本位于 `apps/web/public/theme-preload.js`，通过外部静态资源加载，以兼容 API 服务的严格 `script-src 'self'` CSP；不要把主题初始化改回内联脚本。Android 同时设置系统栏颜色和图标明暗，并通过原生事件更新 WebView，避免仅依赖 WebView 对 `prefers-color-scheme` 的实现差异。

## 颜色令牌

共享令牌位于 `packages/ui/src/tokens.css`。浅色和深色都定义以下语义类别：画布、表面、悬停表面、文字、边框、强调色、状态色、焦点环、遮罩、代码块和阴影。业务 CSS 不应新增页面级硬编码颜色。

## 数据边界

颜色主题是设备运行时状态，不写入 `SettingsDto`、PostgreSQL、IndexedDB outbox 或同步 change feed。未来如需手动覆盖系统主题，应使用设备本地偏好，并将解析结果继续留在客户端。

## 验收

- 浏览器和 PWA：启动时正确显示，系统主题运行中切换后页面立即更新。
- Electron：页面、窗口背景和 Windows 标题栏按钮颜色一致。
- Android：冷启动、前后台恢复和系统主题变化后，页面、状态栏和导航栏一致。
- 自动化证据：主题单测、Chromium 深色/浅色 E2E、Electron 静态安全门禁、Android Release 编译。
- 真机或真实桌面环境仍需单独记录，不能用构建成功替代运行时验收。
