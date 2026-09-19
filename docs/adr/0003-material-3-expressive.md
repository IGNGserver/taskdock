# ADR 0003：Material 3 → Material 3 Expressive 迁移

## 状态

已接受，适用于 V1。取代 [UI_REDESIGN_MATERIAL3.md](../UI_REDESIGN_MATERIAL3.md) 中的 M3 视觉基线，不取代其产品语义决策。

## 背景

上一轮改造把界面从页面级颜色收敛到 M3 语义令牌，但只完成了「基础 M3」：圆角只有 6 级、动效只有 3 个时长、组件底座只有 5 个手写组件，且 `styles.css` 累积成 4711 行、四个互相覆盖的时间层。

Material 3 Expressive（M3E，2025 发布）改变了三件事：

1. **动效从「时长 + 缓动」变成弹簧物理**，并区分 spatial（允许过冲）与 effects（临界阻尼、绝不反弹）两族。
2. **形状成为状态信号**，圆角标尺扩展到 10 级，并引入形状变形。
3. **新增组件**：button group、FAB menu、loading indicator、split button、docked/floating toolbar，底部 app bar 被弃用。

这些是设计语言的替换，不是主题换色，因此需要一次结构化迁移。

## 决策

1. **组件层用满 M3E，动效默认走 standard 弹簧方案，仅在关键瞬间使用 expressive 弹簧。** M3E 官方定位是：消费级场景用 expressive 方案，生产力/密集数据界面用 standard 方案并克制形状。TaskDock 是开发者任务工作台，因此「完成一个任务」「打开快速捕获」「切换视图」等少数时刻获得过冲，其余走 standard。

2. **弹簧令牌由脚本生成，不手写。** CSS 没有弹簧原语，`scripts/motion-tokens.ts` 把每个弹簧（阻尼比 + 刚度）采样成 `linear()` 缓动，写入 `packages/ui/src/tokens.css` 的标记块。`pnpm tokens:motion` 在令牌与物理参数漂移时失败，所以数值不能被悄悄手调。

3. **调色板只有一个来源。** M3E 要求「角色，而非十六进制」。调色板此前散落在 HTML meta、`theme-preload.js`、`theme.ts`、PWA manifest、Electron 主进程和 Android 资源六处，现由 `scripts/theme-tokens.ts` 从 `tokens.css` 派生并校验（`pnpm tokens:theme`）。

4. **样式按层拆分，删除遗留时间层。** 4711 行的 `styles.css` 拆为 `tokens → 组件 → 页面 → 动效 → 响应式`，导入顺序即层叠契约。删除死选择器、把 `!important` 从 102 处降到 1 处（仅保留减弱动效所需的 `scroll-behavior` 强制覆盖）、消除重复覆盖。v2 目录/流程层使用的一批从未定义过的变量（`--outline/--surface/--muted/--accent/--ink/--focus`）改为令牌或显式别名。

5. **导航目的地是真链接。** 新增的 navigation bar / rail / drawer 需要 `role="tab"` 语义时会产生 `aria-required-parent` 违规，且按钮会丢失中键点击与「在新标签页打开」。因此组件通过 `linkAs` 注入路由的 `NavLink`，基元保持与路由解耦。

6. **紧凑外壳的结构由 CSS 断点决定，行为由尺寸类决定。** `useWindowSizeClass()` 提供 M3 窗口尺寸类（compact/medium/expanded/large/xlarge）用于选择导航形态；`.app-frame` 在 compact 下由 `flex-direction: column` 让底部导航栏参与布局。此前它曾是固定定位，覆盖了页面内容并拦截点击。

7. **任务详情改用 sheet。** 原实现是 `position: fixed` 的自制浮层，没有焦点陷阱、没有 presence 动效、没有深色适配。现按 M3E：展开宽度用 side sheet，compact/medium 用 bottom sheet，复用同一套焦点与滚动锁。

8. **减弱动效保留语义。** 不再用 `animation-duration: 0.01ms` 一刀切。spatial 弹簧降级为短淡入淡出、去掉位移与过冲，effects 保留；形状变形改为交叉淡入；`usePresence` 的退出时长与 CSS 从同一令牌取值，避免组件在动画结束前卸载。

## 后果

- 三条新门禁：`pnpm tokens:motion`、`pnpm tokens:theme`、`pnpm tokens:check`，并接入 `build`。
- `apps/web/e2e/smoke.spec.ts` 的移动端断言从「模态创建动作表」改为「FAB menu」，因为 M3E 用 FAB menu 取代了 speed dial 与动作表。
- `apps/web/e2e/theme.spec.ts` 与 `apps/web/test/theme.test.ts` 断言主题色；调色板变更必须与断言在同一提交内更新（由 `tokens:theme` 提示）。
- Android 侧受 Compose material3 版本限制：`Shapes` 只有 5 个槽位（没有 `extraLargeIncreased`/`extraExtraLarge`），`ColorScheme` 没有 `*Fixed` 角色参数。因此 M3E 完整圆角标尺与 fixed 角色以 `Color.kt` 常量形式存在并注释指向 `tokens.css`，未接入 scheme 构造器（接入会编译失败）。
- 原生触摸拖拽仍不引入（沿用 [ADR 0002](0002-client-packaging-and-placement-interactions.md)）；所有排序都有键盘等价路径。
- 主题仍不写入 `SettingsDto`，不进入同步协议（沿用 [DARK_MODE.md](../DARK_MODE.md) 的数据边界）。
- M3E 的对比度档位通过 `prefers-contrast: more` 令牌覆盖实现，不新增独立样式表。

## 未做

- 不引入第三方组件库或 CSS 框架。M3E 落在现有 React/CSS 结构上。
- 不做动态取色（Material Color Utilities）。保留静态品牌方案；Android Compose 侧继续支持系统动态色。
- 不引入真实弹簧动画运行时（如 motion/rive）。用 `linear()` 采样保持零新增依赖。
- 不拆分 JS chunk。构建体积警告是既有状况，不属于本次设计迁移范围。
