# TaskDock Material 3 Expressive 迁移清单

> **实施状态（已落地）：** 本清单已全部执行完毕。设计决策与取舍记录在 [ADR 0003](adr/0003-material-3-expressive.md)。仍在环境上无法运行的门禁（WebKit、Android 真机、Electron GUI）与迁移前一致，见 [STATUS.md](STATUS.md)。
>
> 落地后的实际形态与清单的差异只有两处，均已记录在 ADR 中：
>
> - Android 受 Compose material3 版本限制，`Shapes` 只有 5 个槽位、`ColorScheme` 没有 `*Fixed` 角色参数；完整 M3E 标尺保存在 `Color.kt` 常量并注释指向 `tokens.css`。
> - 移动端 E2E 断言从「模态创建动作表」改为「FAB menu」，因为 M3E 明确用 FAB menu 取代 speed dial 与动作表。

> 目标：在**不改动 Task/Placement 领域语义、离线同步行为、CSP 与可访问性门禁**的前提下，把 TaskDock 现有界面从「Material 3 基础配色 + 手写 CSS」升级为 **Material 3 Expressive（M3E）**，覆盖外观语言、页面结构、组件、交互、动效、适配六个维度。
>
> 本文是**全量修改清单**：逐文件、逐区块列出需要改什么、改成什么、以及验收依据。
>
> 相关文档：[UI_REDESIGN_MATERIAL3.md](UI_REDESIGN_MATERIAL3.md)（上一轮 M3 改造说明）、[DARK_MODE.md](DARK_MODE.md)（主题数据边界）、[STATUS.md](STATUS.md)、[TEST_REPORT.md](TEST_REPORT.md)。

---

## 0. 结论摘要

| 项       | 现状                                                                                         | M3E 目标                                                                        | 影响面                                    |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| 设计令牌 | 6 级圆角、3 个时长、单一 `--m3-state-*` 叠加色                                               | 10 级圆角 + 弹簧动效令牌 + 类型标尺令牌 + 6 级高度令牌                          | `packages/ui/src/tokens.css`、`tokens.ts` |
| 颜色角色 | 只有 M3 基础角色，`tertiary` 几乎未用                                                        | 补全角色 + fixed 角色 + 按角色计算的 state layer + 对比度档位                   | `tokens.css`、全站 CSS                    |
| 组件     | 5 个手写 M3 组件，全站 8 处 `className="...-button"` 混用                                    | M3E 组件底座（ButtonGroup/SplitButton/FABMenu/LoadingIndicator/Toolbar/Sheet…） | `components/m3.tsx` → 新 `m3e/`           |
| 页面结构 | 侧栏 256px + 顶栏 + 底部导航(4/5 列冲突)                                                     | 抽屉/导航栏/导航轨 + Top App Bar 三档 + docked/floating toolbar                 | `App.tsx`、`styles.css`                   |
| 交互     | 40px 控件、focus ring 部分丢失、无手势                                                       | 48dp 触控目标、完整 state layer、手势与触觉反馈                                 | 全站                                      |
| 动效     | 20 条 transition、11 个 keyframes、单一 cubic-bezier                                         | 弹簧物理令牌（spatial/effects × fast/default/slow）                             | 全站                                      |
| 适配     | 767/768/1100/720 四个断点、无窗口尺寸类                                                      | M3E 窗口尺寸类 + 双栏 + 平板/折叠屏                                             | 全站响应式                                |
| 遗留债   | 约 54 个未使用选择器、`--dt-*` 400 处、102 个 `!important`、v2 区块 9 处未定义变量与硬编码色 | 收敛为单一令牌体系                                                              | `styles.css` 4711 行重构                  |

---

## 1. 现状基线（改造前证据）

### 1.1 代码规模

| 文件                                                     | 行数      | 说明                                          |
| -------------------------------------------------------- | --------- | --------------------------------------------- |
| `apps/web/src/styles.css`                                | 4711      | 全站唯一样式表，无分层                        |
| `apps/web/src/App.tsx`                                   | 4360      | 主壳 + 全部页面 + 弹窗                        |
| `apps/web/src/TreePage.tsx`                              | 1618      | v2 目录/流程/所有任务 + 任务详情浮层          |
| `apps/web/src/components/m3.tsx`                         | 196       | 5 个 M3 组件                                  |
| `packages/ui/src/tokens.css`                             | 197       | 颜色/shape/motion 令牌                        |
| `apps/web/src/theme.ts`                                  | 83        | 主题解析 + `theme-color`                      |
| `apps/mobile/android/.../ui/theme/{Color,Type,Theme}.kt` | 63/81/122 | Android Compose 主题                          |
| `apps/desktop/src/main.ts`                               | 703       | 窗口背景/标题栏主题（86–95、122、126）        |
| `apps/web/public/theme-preload.js`                       | 21        | 首屏主题脚本（19 行硬编码主题色）             |
| `apps/web/index.html`                                    | 21        | 第 6 行硬编码 `theme-color`                   |
| `apps/web/vite.config.ts`                                | 52        | 23–24 行 PWA `theme_color`/`background_color` |

### 1.2 `styles.css` 的四个时间层（改造的根本难点）

| 层             | 行范围    | 行数 | `--dt-*` 引用 | `--m3-*` 引用 | 问题                                                                                                                               |
| -------------- | --------- | ---- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 遗留层         | 1–2686    | 2686 | 378           | 12            | 68 处 `1px solid`、124 处 `font-size`、63 处 `border-radius`、`--dt-text` **未定义**                                               |
| M3 覆盖层      | 2833–4018 | 1187 | 9             | 254           | 与遗留层声明同名规则反复覆盖（`.task-row` 声明 2 次、`.m3-segmented-control` 5 次）                                                |
| 硬化层         | 4019–4293 | 275  | 1             | 17            | `!important` 密集（全文件 102 处）                                                                                                 |
| v2 目录/流程层 | 4346–4711 | 367  | **0**         | **0**         | 使用 `--outline/--surface/--muted/--accent/--ink/--focus`，这些变量**全项目未定义**，实际落到 9 处 fallback 十六进制色；无深色适配 |

### 1.3 令牌现状

- 颜色角色：`tokens.css` 10–50（浅色）、112–155（深色），角色齐全但 `tertiary` 仅 1 处使用。
- Shape（52–57）：`xs 4 / sm 8 / md 12 / lg 16 / xl 28 / full 999`，**缺 large-increased、extra-large-increased、extra-extra-large**。
- Motion（58–60）：`short 120ms / medium 220ms / long 360ms`，全站实际另有 8 处 `0.12s–0.2s ease` 与 4 处 `cubic-bezier(0.22,1,0.36,1)` 未走令牌。
- State layer（46–50）：`--m3-state-hover/focus/pressed/dragged` 全部由 **primary 色** 写死；`pressed`/`dragged` 使用 0 次。
- 无类型令牌、无高度（elevation）令牌。
- 遗留别名：`--dt-*` 400 处引用（47 处 `--dt-accent`、43 处 `--dt-muted`、43 处 `--dt-line`）。

### 1.4 组件与页面基线

- M3 组件使用量：`M3Button` 16 处（全在 `App.tsx`）、`M3IconButton` 2 处、`M3SegmentedControl` 1 处、`M3Chip` 2 处、`M3Select` 4 处；**`TreePage.tsx` 与 `auth.tsx` 为 0**。
- 页面仍在用非 M3 类名：`secondary-button` 25 处、`icon-button` 24 处、`text-button` 13 处、`primary-button` 13 处、`danger-button` 3 处。
- 登录/中枢/初始化页（`App.tsx` 193–500、818–910）整体使用遗留类，未接入 M3 组件。
- `packages/ui/src/index.ts` 仍导出一份与 `tokens.css` 平行的十六进制 `designTokens` 常量（1–13 行），与 CSS 令牌存在漂移风险。

### 1.5 已存在的缺陷（迁移必须一并修掉）

| #   | 缺陷                                                                                                                   | 位置                                                                        | 后果                                |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| D1  | `--dt-text` 未定义                                                                                                     | `styles.css:1441`                                                           | 颜色回退为继承值                    |
| D2  | v2 层使用 6 个未定义变量                                                                                               | `styles.css:4346–4711`                                                      | 该区域永远走 fallback，深色模式失效 |
| D3  | 移动底部导航列数冲突（基规则 4 列，后规则 5 列）                                                                       | `styles.css:2584` vs `3976`                                                 | 依赖后定义覆盖，脆弱                |
| D4  | TSX 使用但 CSS 未定义：`error-banner`、`page-subtitle`、`page-section`、`tree-move-sheet`、`status-icon`、`form-input` | `TreePage.tsx:816` 等                                                       | 无样式                              |
| D5  | 约 54 个未使用选择器（`detail-panel` 等 v1 遗留）                                                                      | `styles.css:1585–1866`、`1649–1709`、`1153–1228`、`1119`、`886–903`、`2014` | 体积与维护成本                      |
| D6  | 403 处小字号（`12px` 44 处、`10px` 36 处、`11px` 33 处），非标准字重 560/620/650/680/720/750/760                       | `styles.css`                                                                | 不构成 M3 类型标尺                  |
| D7  | 32px 遗留 `icon-button`（223、547、2481、3202 行）与 44px `task-status-button`                                         | `styles.css`                                                                | 低于 48dp 触控目标                  |
| D8  | 内联样式绕过令牌（含 `#eee`、`#666`）                                                                                  | `App.tsx:3202/3229/3231/3232/4190`、`TreePage.tsx:1300/1302/1327/1333/1338` | 主题无法统一                        |
| D9  | 品牌色 `#142238` 硬编码两份                                                                                            | `styles.css:229`、`2880`                                                    | 不随主题                            |

---

## 2. 目标设计语言：TaskDock Expressive Developer Workbench

M3E 官方定位：**expressive 方案用于消费级场景，standard 方案 + 克制形状用于生产力/密集数据界面**（见参考资料）。TaskDock 是开发者任务工作台，因此采取：

- **组件层用满 M3E**（ButtonGroup、SplitButton、FAB Menu、Loading Indicator、Toolbar、Bottom Sheet）；
- **动效默认走 standard 弹簧方案**，仅在「完成一个任务」「打开快速捕获」「切换视图」等关键瞬间使用 expressive 弹簧（允许轻微过冲）；
- **形状允许表达但不可预测**：可点击区域永远保持可预测的圆角矩形/胶囊，非矩形 expressive 形状只用于头像、空状态插画、加载指示器。

### 2.1 三维设计原则在本项目的映射

| M3E 原则    | 本项目的具体含义                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Personal    | 保留系统主题跟随；新增品牌种子动态配色与对比度档位（不写入账号设置，见 [DARK_MODE.md](DARK_MODE.md) 数据边界） |
| Adaptive    | 用窗口尺寸类替代四个魔法断点；桌面双栏、平板导航轨、手机底部导航栏                                             |
| Expressive  | 强调 = 重要性：主操作（快速捕获/完成）才获得形状变形与弹簧过冲；危险操作保持稳定形状                           |
| Consistency | 所有颜色/形状/动效/类型只能来自 `tokens.css`；禁止页面级硬编码                                                 |

---

## 3. 维度一：外观语言（Color / Shape / Type / Elevation / Iconography）

### 3.1 颜色角色

| #   | 修改点                     | 现状                                                                                                                                   | 目标                                                                                                                                                          |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 补全角色                   | `tokens.css:6–50` 只有基础角色                                                                                                         | 增加 `surface-container-*` 已存在；新增 `primary/secondary/tertiary-fixed`、`-fixed-dim`、`-on-fixed`、`-on-fixed-variant`（用于 FAB Menu 项、Toast、选中态） |
| C2  | `tertiary` 启用            | 全站仅 1 处                                                                                                                            | 用于 expressive 强调时刻：今日进度环、到达事件、FAB Menu 图标的第二色                                                                                         |
| C3  | state layer 改为按角色计算 | `--m3-state-hover` 等 4 个变量用 primary 写死（`tokens.css:46–49`）                                                                    | 改为 `color-mix(in srgb, currentColor X%, transparent)` 或按角色的 `--m3-state-*-on-primary/-on-error/...`，修复"红色按钮 hover 出现蓝色叠加"                 |
| C4  | 补齐状态层用量             | `pressed`/`dragged` 使用 0 次                                                                                                          | 所有可交互组件必须区分 hover/focus/pressed/dragged/disabled                                                                                                   |
| C5  | 提高 tonal 对比            | 现状层级主要靠 1px 边框（97 处）                                                                                                       | 用 `surface-container-lowest→highest` 阶梯表达层级（M3E 明确要求 expressive 提高质感对比）                                                                    |
| C6  | 对比度档位                 | 无                                                                                                                                     | 提供 standard/medium/high 三档（跟随系统 `prefers-contrast`），至少保证 high 档可读                                                                           |
| C7  | 清理硬编码色               | `styles.css:229/2880` 品牌色、v2 层 9 处 fallback、`App.tsx:3206` `#eee`、`TreePage.tsx:1338` `#666`                                   | 全部替换为角色令牌                                                                                                                                            |
| C8  | 同步原生主题色             | `theme.ts:31`、`theme-preload.js:19`、`index.html:6`、`vite.config.ts:23–24`、`desktop/src/main.ts:86–95`、Android `values/colors.xml` | 与新调色板一次性对齐（切换时四处必须同时改）                                                                                                                  |

### 3.2 形状

| #   | 修改点               | 现状                                                                                            | 目标                                                                                                                   |
| --- | -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S1  | 扩展圆角标尺         | `tokens.css:52–57` 6 级                                                                         | 新增 `--m3-shape-lg-increased: 20px`、`--m3-shape-xl-increased: 32px`、`--m3-shape-xxl: 48px`；保留原 6 个键名避免破坏 |
| S2  | 按组件重映射         | 现状硬编码 27 种圆角值（`8px`12 处、`9px`11 处、`6px`7 处、`10px`6 处、`7px`5 处、`13px`4 处…） | chips→sm、卡片/列表→md、抽屉/FAB→lg、Bottom Sheet/对话框→xl(28)、全屏 Sheet/Hero 容器→xl-increased(32)                 |
| S3  | 按钮形状             | 已统一 `full`（`styles.css:3023`）                                                              | 保留胶囊；新增 square 变体与**按下形状变形**（square↔round）                                                           |
| S4  | expressive 形状库    | 无                                                                                              | 仅在头像（`.avatar`）、空状态图标（`.empty-icon`）、Loading Indicator 上使用非矩形形状                                 |
| S5  | 形状变形作为状态信号 | 现状只有 `transform: scale()`（0.94–0.998，7 处）                                               | 选中/激活改成形状+尺寸变形并走 spatial 弹簧                                                                            |
| S6  | 圆角继承链           | `.brand-mark` 手写 `13px`/`--m3-shape-sm`（2875–2891）                                          | 统一为 `--m3-shape-md`（图标底）                                                                                       |

### 3.3 类型（Typography）

| #   | 修改点           | 现状                                                          | 目标                                                                                           |
| --- | ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T1  | 建立类型标尺令牌 | 无；124 处 `font-size` 直接写像素                             | 在 `tokens.css` 增加 `--m3-type-{display                                                       | headline | title | body | label}-{s | m   | l}` 的 size/line-height/weight/letter-spacing |
| T2  | 映射到组件       | Body 基线被压到 12/13px（44 处 12px、33 处 11px、36 处 10px） | Body Large 16/24 作为正文基线；Label Large 14/medium 用于按钮；`eyebrow` 用 Label Small + 字距 |
| T3  | 字重收敛         | 560/620/650/680/720/750/760/800 共 8 种非标字重               | 收敛到 400/500/600/700 + M3E **emphasized** 变体（用于页面大标题、今日进度数字）               |
| T4  | 大标题弹性       | `.page-header h1` 用 `clamp(30px,4vw,42px)`（3000）           | 使用 M3E headline-large/emphasized + 支持滚动折叠（见 4.2）                                    |
| T5  | 等宽字体         | `--dt-font-mono` 仅 23 处                                     | 保留给 referenceId/code，纳入令牌命名 `--m3-type-mono`                                         |
| T6  | Android 类型     | `Type.kt` 手写一套（81 行）                                   | 与 Web 令牌同表生成，避免两端漂移                                                              |

### 3.4 高度（Elevation）

| #   | 修改点         | 现状                                                                 | 目标                                                                                  |
| --- | -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| E1  | 高度令牌       | 无；9 处 `box-shadow` + `--dt-shadow-*`                              | 定义 `--m3-elevation-0..5`（0/1/3/6/8/12），同时给出 shadow 与 tonal overlay 两套表达 |
| E2  | 深色优先 tonal | 深色下仍用阴影（`--dt-shadow-popover` 等）                           | 深色模式优先用 surface 阶梯 + 1dp 阴影，避免大黑影                                    |
| E3  | 弹层高度统一   | `.modal`/`.command-panel`/`.row-menu`/`.mobile-sidebar` 各写一套阴影 | 统一：Menu level 2、Dialog level 3、Drawer level 1、FAB level 3                       |

### 3.5 图标（Iconography）

| #   | 修改点           | 现状                                                          | 目标                                                                                           |
| --- | ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| I1  | 尺寸收敛         | 使用 13/14/15/16/17/18/19/20/22/23 共 10 种（`lucide-react`） | 收敛为 4 档：16（内联/标签）、20（控件与按钮）、22–24（导航与 FAB）、32（Hero）                |
| I2  | 选中态图标       | 全部线性                                                      | lucide 无 filled 变体；改用「选中指示器 + 图标 1.08× 弹性放大 + 文本加重」表达选中态（已实现） |
| I3  | 图标按钮视觉尺寸 | 40px 视觉 / 48px 触控                                         | 视觉可小于触控：`--m3-icon-button-size: 40px` + `min-height/min-width: 48px`                   |

---

## 4. 维度二：页面结构（Layout / IA / Scaffold）

### 4.1 应用外壳

| #   | 修改点            | 现状                                                                                                                           | 目标                                                                                                                                |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| L1  | 桌面侧栏          | 固定 256px `.sidebar`（`styles.css:2850–2861`）+ `.main-shell { margin-left: 256px }`                                          | 按窗口尺寸类切换：compact→底部 Navigation Bar；medium→Navigation Rail（80px）；expanded→Navigation Drawer（256–360px，含 M3E 圆角） |
| L2  | 顶栏              | 自定义 `.topbar`（2952，高 64px）+ 面包屑 + 搜索按钮 + M3Button                                                                | 改为 **Top App Bar**：compact 用 small，medium/large 用 Top App Bar with flexible/large title；面包屑降级为 secondary line          |
| L3  | 搜索入口          | `.command-trigger`（`App.tsx:619–627`）+ `CommandPalette`（1612）                                                              | M3E **Docked Search Bar / Search View**；保留 ⌘K 与 Esc 行为                                                                        |
| L4  | 底部导航          | `.mobile-bottom-nav`（2584 vs 3976 列数冲突），5 个目的地                                                                      | M3E **Navigation Bar**，固定 5 项 + 选中 pill 指示器 + 图标 filled/outlined 切换；修正列数冲突                                      |
| L5  | FAB               | `.mobile-fab`（3883）单一"打开创建菜单"                                                                                        | M3E **FAB Menu**（2–6 项）；当前只有 1 个动作（新建任务），需先决定是保留 FAB 还是在动作 >1 时启用菜单                              |
| L6  | 底部 App Bar 弃用 | 无，但移动底栏接近该模式                                                                                                       | 若新增全局上下文操作，用 **docked toolbar / floating toolbar**，不回退 bottom app bar                                               |
| L7  | 内容容器          | `.page { width: min(960px, 100% - 48px) }`（564）+ M3 层 `.page/.narrow-page { width: min(100% - 64px, 1080px) }`（2974–2979） | 改为响应式内容窗格 + 尺寸类断点；expanded 下支持 list-detail 双栏                                                                   |
| L8  | 页面头部          | `PageHeader` 组件（`App.tsx:1214`）：eyebrow + h1 + p + action                                                                 | 拆为 Top App Bar（标题）+ 内容区 Headline；`eyebrow` 只保留给 detail/sub-section                                                    |

### 4.2 逐路由结构改造

| 路由                               | 组件（位置）                                                                                                                     | 需要的结构改造                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/today`                           | `TodayPage`（`App.tsx:1784`）                                                                                                    | 今日进度卡（`3591`，3 列 grid）→ M3E 强调卡片 + 形状化的 wavy 进度；「今天要做/已完成」两个 section 改为 **grouped list（带间隙的分组列表）**；行内捕获（`QuickCapture` 1320）改为内嵌 SearchBar 形态                                    |
| `/tree`、`/tree/:folderId`         | `TreePage`（`TreePage.tsx:44`）                                                                                                  | 目录树 + 面包屑（`4596+`）→ 层级列表 + M3E breadcrumb bar；行内捕获表单（`4521+`）→ outlined TextField                                                                                                                                   |
| `/tasks`                           | `AllTasksV2Page`（`TreePage.tsx:1549`）                                                                                          | 状态 chip（`4494+`）→ M3E Filter Chips + segmented button                                                                                                                                                                                |
| `/workflows`                       | `WorkflowsPage`（`TreePage.tsx:1038`）                                                                                           | 流程卡片（`4560+`）→ M3E **outlined card** + 阶段内分组列表；内联重命名输入 → TextField                                                                                                                                                  |
| `/time`                            | `TimeHubPage`（`App.tsx:1106`）                                                                                                  | `.more-grid` 入口卡（594）→ M3E list item（带 leading/trailing icon）                                                                                                                                                                    |
| `/time/calendar/:date`             | `CalendarPage`（`App.tsx:3304`）                                                                                                 | 7 列日历（`1340`）→ M3E Date Picker 视觉；选中日 `selected`（1368）→ 形状变形选中态；右侧详情面板在 expanded 下保持双栏，compact 下改为 Bottom Sheet                                                                                     |
| `/time/events`、`/time/events/:id` | `EventsPage`（2048）、`EventPage`（2328）                                                                                        | 时间线（`1232–1290`）→ M3E 带间隙列表 + Badge；`.event-state`（1303）→ Assist Chip                                                                                                                                                       |
| `/archive`                         | `ArchivePage`（3508）                                                                                                            | 三个分区 + 恢复按钮 → grouped list + SplitButton（恢复 / 恢复选项）                                                                                                                                                                      |
| `/settings`                        | `SettingsPage`（3784）                                                                                                           | `.settings-section`（1452）→ M3E 卡片分组；`field`/`select`（1462–1490）→ outlined TextField + Exposed Dropdown；冲突收件箱（3995）→ 对话框 + 合并编辑器                                                                                 |
| `/more`                            | `MorePage`（1142）                                                                                                               | `.more-link-card`（597）→ M3E list item                                                                                                                                                                                                  |
| 登录/中枢/初始化                   | `LoginScreen`(730)、`HubSetupScreen`(338)、`HubWaitingScreen`(454)、`DesktopStartup`(225)、`DesktopBridgeUnavailableScreen`(191) | `.auth-page` 2 列（2244）→ M3E 自适应：compact 单列 + 大标题；`auth-aside`（2309）在 compact 隐藏或转为底部说明卡；按钮/输入切到 M3E 组件                                                                                                |
| 任务详情                           | `TaskDetailV2Overlay`/`TaskDetailV2`（`TreePage.tsx:554/596`，样式 `4521+`）                                                     | 当前是 `position: fixed; inset: 10% 4% auto auto` 的自制浮层（**未走 Modal，无焦点陷阱、无 presence 动效、无深色适配**）→ 改为 M3E **Modal Bottom Sheet（手机）/ Side Sheet（展开宽度）**，复用 `Modal`(1451) 的焦点陷阱与 `usePresence` |
| 命令面板                           | `CommandPalette`（1612）                                                                                                         | → M3E Search View（全屏搜索 + 建议列表）                                                                                                                                                                                                 |

### 4.3 样式架构重建（`styles.css` 4711 行）

| #   | 修改点            | 目标                                                                                                                                                       |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 分层拆分          | 拆为 `styles/tokens-bridge.css`（`--dt-*`→`--m3-*` 兼容别名）、`styles/base.css`、`styles/components/*.css`、`styles/pages/*.css`、`styles/responsive.css` |
| A2  | 删除死代码        | 移除 D5 列出的约 54 个未使用选择器（尤其 `detail-panel` 1585–1866、`note-editor`/`editor-tabs`/`markdown-preview` 1649–1709、`project-*` 1153–1228）       |
| A3  | 消除重复覆盖      | 合并 `.task-row`(797/3374)、`.m3-segmented-control`(2014/3232) 等重复声明，按 DOM 顺序单次定义                                                             |
| A4  | `!important` 收敛 | 102 处降为 0（除 `native-mobile-shell` 少数 WebView 边界，需逐条给出理由注释）                                                                             |
| A5  | 内联样式清零      | `App.tsx` 6 处、`TreePage.tsx` 4 处内联 style 全部转为 class                                                                                               |
| A6  | 修复未定义变量/类 | D1、D2、D4 全部补齐或删除引用                                                                                                                              |

---

## 5. 维度三：组件

### 5.1 组件底座重建

把 `apps/web/src/components/m3.tsx`（196 行）升级为 `components/m3e/` 目录，按 M3E 规范实现：

| 组件                          | 现状                                                                                                    | M3E 目标规格                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Button                        | `M3Button` 3 尺寸 × 4 变体（`m3.tsx:27–55`）                                                            | 5 尺寸（XS 32 / S 40 / M 40–56 / L / XL 96）× 5 样式（elevated/filled/tonal/outlined/text）+ 圆角/方形两态 + 按下形状变形 |
| IconButton                    | `M3IconButton` 4 变体（`57–83`）                                                                        | 标准/filled/tonal/outlined + **selected 切换态**；触控 48 / 视觉 40                                                       |
| ButtonGroup                   | 无                                                                                                      | 新组件，承载 segmented 动作与筛选行；子按钮按方向协调形状与动画                                                           |
| SplitButton                   | 无                                                                                                      | 新组件：主操作 + 尾部菜单按钮（触发时旋转/变形）；用于 `/archive` 恢复、`/today`"安排到明天"                              |
| FAB / FABMenu                 | `.mobile-fab` 单按钮（`App.tsx:685`）                                                                   | FAB（56/40/96+）+ FABMenu（2–6 项，交错 50ms 入场，关闭按钮高对比）                                                       |
| SegmentedButton               | `M3SegmentedControl`（`85–165`）替代 `.filter-tabs`/`.project-tabs`/`.editor-tabs`/`.segmented-control` | 单选/多选两态；保留现有方向键/Home/End roving tabindex（`104–157`），补 `aria-orientation`                                |
| Chip                          | `M3Chip`（`167–196`）                                                                                   | 4 类：assist / filter / input / suggestion；filter chip 带勾选动画                                                        |
| TextField                     | 原生 `input` + `.field`                                                                                 | filled / outlined 两态，支持 leading/trailing 图标、helper、error、字符计数                                               |
| Select                        | `M3Select`（`14–25`）                                                                                   | Exposed Dropdown Menu（Menu 锚定），保留原生 fallback 供 E2E                                                              |
| Card                          | `.project-card`/`.more-link-card`/`.workflow-card` 各写一套                                             | elevated / filled / outlined 三态统一                                                                                     |
| ListItem                      | `.task-row`/`.timeline-item`/`.picker-item`/`.device-row` 各写一套                                      | 统一 ListItem（leading/trailing/支持 1–3 行文本/支持分组间隙）                                                            |
| Dialog                        | `Modal`（`App.tsx:1451`）+ `ConfirmDialog`（1551）                                                      | basic / full-screen 两态；保留现有焦点陷阱（1470–1507）与 `modal-open` 滚动锁                                             |
| BottomSheet                   | 无（仅 `MobileActionSheet` 复用 Modal）                                                                 | 标准/模态两种；支持拖拽把手、swipe-to-dismiss、内容滚动                                                                   |
| SideSheet / Drawer            | `.mobile-sidebar`（`App.tsx:972`）                                                                      | 标准/模态，宽 256–400                                                                                                     |
| NavigationBar / Rail / Drawer | `.mobile-bottom-nav` + `.sidebar`                                                                       | 三档导航组件共用一套选中指示器                                                                                            |
| TopAppBar                     | `.topbar` + `PageHeader`                                                                                | small / medium / large-flexible 三态                                                                                      |
| Toolbar                       | 无                                                                                                      | docked / floating；承载页面级上下文动作                                                                                   |
| Badge                         | `.count`/`.m3-segment-count`/`.tree-count`                                                              | 小/大两尺寸，支持 dot                                                                                                     |
| ProgressIndicator             | `.today-progress`（Homey 自制，`3620`）                                                                 | linear + circular + **wavy**（M3E 新增）；保留 `role="progressbar"` 与 `aria-valuenow`                                    |
| LoadingIndicator              | `.spin` + `.skeleton-list`（`App.tsx:2037`）                                                            | 形状变形的加载指示器，**仅用于 <5s**；长任务仍用确定型进度                                                                |
| Snackbar                      | `.undo-banner`（`App.tsx:1917`，样式 `styles.css:3837`）                                                | 统一 Snackbar：支持 action（撤销）、超时、队列                                                                            |
| Tooltip                       | 仅 `title` 属性                                                                                         | 标准 Tooltip（键盘可达）                                                                                                  |
| SearchBar                     | `.command-trigger`/`.more-search-button`                                                                | docked / view 两态                                                                                                        |

### 5.2 组件接入点清单

| #   | 位置                                                                                                                | 现状                                        | 改为                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| K1  | `App.tsx:629–639` 快速添加                                                                                          | `M3Button` filled                           | Button（filled, L）或 FAB，按尺寸类切换               |
| K2  | `App.tsx:1595–1605`                                                                                                 | `M3Button variant="text"` + filled          | Dialog 的 text/filled 按钮对                          |
| K3  | `App.tsx:1880–1895`（Today 头部）                                                                                   | `M3Button` tonal/outlined                   | ButtonGroup 或 SplitButton（"加入任务 / 安排到明天"） |
| K4  | `App.tsx:2153/2213/2482`                                                                                            | filled 带 leadingIcon                       | Extended FAB 或 filled Button                         |
| K5  | `App.tsx:2420–2469`（Events 头部）                                                                                  | 多个 M3Button                               | Top App Bar action + overflow Menu                    |
| K6  | `App.tsx:2955–2962`、`TreePage`                                                                                     | M3Button                                    | 统一 Button API                                       |
| K7  | `App.tsx:2896–2903`                                                                                                 | `M3Select`                                  | Exposed Dropdown                                      |
| K8  | `App.tsx:3037`                                                                                                      | `M3SegmentedControl`                        | SegmentedButton（含 ButtonGroup 视觉）                |
| K9  | `App.tsx:1540` Modal 关闭按钮                                                                                       | `.icon-button`（32px）                      | IconButton（48 触控）                                 |
| K10 | `App.tsx:601–605` 用户 chip                                                                                         | `.user-chip`                                | ListItem + trailing IconButton                        |
| K11 | 全站 24 处 `.icon-button`、25 处 `.secondary-button`、13 处 `.primary-button`/`.text-button`、3 处 `.danger-button` | 遗留类                                      | 全部替换为 M3E 组件，替换后删除遗留 CSS               |
| K12 | `auth.tsx`（530 行）                                                                                                | 无任何 M3 组件                              | 接入 TextField / Button / Snackbar                    |
| K13 | `pwa.tsx`                                                                                                           | `.pwa-notice` 自定义                        | Snackbar                                              |
| K14 | `packages/ui/src/index.ts:1–13`                                                                                     | 十六进制 `designTokens` 常量（与 CSS 漂移） | 改为从 `tokens.css` 生成或删除                        |
| K15 | `TreePage.tsx:787–1035` 任务详情                                                                                    | 自制浮层，无焦点陷阱                        | 接入 Sheet/Dialog 组件（复用 `Modal` 的焦点管理）     |
| K16 | `TreePage.tsx:1300–1345` 内联样式块（含 `#666`）                                                                    | 内联布局                                    | 改为 ListItem + 类型令牌                              |

---

## 6. 维度四：交互（State / Input / Feedback）

### 6.1 状态层与焦点

| #   | 修改点                      | 现状                                               | 目标                                                                                                      |
| --- | --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| X1  | hover/focus/pressed/dragged | 仅 hover 14 处、focus 3 处；pressed/dragged 0 处   | 每个可交互组件实现完整 5 态；state layer 透明度按 M3E（hover 8% / focus 10% / pressed 10% / dragged 16%） |
| X2  | 焦点可见性                  | 仅 6 条 `focus-visible`，但 8 处 `outline: 0/none` | 所有可聚焦元素 `:focus-visible` 有 3px ring + 2px offset；删除无替代的 `outline: 0`                       |
| X3  | 禁用态                      | `.m3-button:disabled` 等零散定义                   | 统一 disabled：opacity 38% + 去掉 state layer + `cursor: not-allowed`                                     |
| X4  | 选中态                      | `.selected` 用背景色                               | 改为"形状/指示器 + 图标填充 + 文本加粗"三重表达                                                           |

### 6.2 触控与指针

| #   | 修改点   | 现状                                                                             | 目标                                                                                 |
| --- | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| X5  | 触控目标 | 32px `icon-button`（223/547/2481/3202）、32–40px 按钮、44px `task-status-button` | 全部 ≥48dp 命中区（视觉可小，用伪元素扩展）                                          |
| X6  | 间距     | 按钮组 2–8px                                                                     | 触控目标间 ≥8dp                                                                      |
| X7  | 拖拽     | 原生 HTML5 DnD（`.task-row[draggable]`，3399）+ 上下移动按钮                     | 保留键盘等价路径（ADR 0002 要求）；新增 M3E 拖拽把手与抬升态；移动端继续避免触摸拖拽 |
| X8  | 长按     | `App.tsx:2568` 长按菜单                                                          | 按 M3E 改为行内 trailing 菜单 + 触觉反馈                                             |

### 6.3 反馈与状态

| #   | 修改点             | 现状                                                            | 目标                                                                                                                               |
| --- | ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| X9  | 错误反馈           | `.inline-error`/`.form-error`/`.error-banner`（后者**无样式**） | 统一 Snackbar（瞬时）+ Inline error（表单字段）+ ErrorState（整页）三种                                                            |
| X10 | 撤销               | `.undo-banner` 单例（Today rollover）                           | Snackbar + action，支持队列与超时                                                                                                  |
| X11 | 加载               | `.spin` + `.skeleton-list` shimmer（`@keyframes shimmer` 1045） | LoadingIndicator（<5s）+ 骨架屏保留给首屏 >5s 场景；不得在后台刷新时替换可交互内容（已有回归测试：`useReloadable.initialLoading`） |
| X12 | 冲突/拒绝 mutation | `.conflict-*`/`.rejected-*` 内嵌设置页                          | 提升为可发现的入口（顶栏 Badge + Bottom Sheet），保持"同步可解释"语义不变                                                          |
| X13 | 触觉反馈           | 无                                                              | Web 端可选 `navigator.vibrate`；Capacitor 端接入 Haptics；Android Compose 已可 `performHapticFeedback`                             |
| X14 | 键盘快捷键         | ⌘K（`App.tsx:518`）、Esc、原生 back（547–559）                  | 补齐快捷键提示（Tooltip/Menu 右侧 kbd）、为 FABMenu/ButtonGroup 实现 roving tabindex                                               |

---

## 7. 维度五：动效（Motion）

### 7.1 令牌体系替换

| #   | 修改点       | 现状                                                           | 目标                                                                                                                                    |
| --- | ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | 弹簧令牌     | `--m3-motion-short/medium/long` 三个时长（`tokens.css:58–60`） | 新增两族 × 三速：`--m3-spring-spatial-{fast,default,slow}`（允许过冲）、`--m3-spring-effects-{fast,default,slow}`（临界阻尼，绝不过冲） |
| M2  | CSS 实现方式 | 单一时长 + `ease`                                              | 用 `linear()` 采样弹簧（Chrome 113+/Safari 17.2+/Firefox 112+），不支持时回退到既有 cubic-bezier；不使用真实弹簧库以保持零依赖          |
| M3  | 旧令牌保留   | `--m3-motion-*` 被 `--dt-*` 间接引用                           | 保留为 standard 方案别名，标记 deprecated                                                                                               |
| M4  | 删除散落时长 | 8 处 `0.12s–0.2s ease`、4 处 `cubic-bezier(0.22,1,0.36,1)`     | 全部走令牌                                                                                                                              |

### 7.2 动画改造清单

| #   | 现有 keyframes / 交互       | 位置                                                                                                           | 目标                                                                                                                |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| M5  | `dt-modal-in/out`           | `styles.css:1952/1962`                                                                                         | spatial 弹簧 scale+fade 入场；退场走 effects 快速淡出                                                               |
| M6  | `dt-detail-in/out`          | 1916/1926                                                                                                      | 改为 Sheet 上滑（spatial default），退场加速                                                                        |
| M7  | `dt-backdrop-in/out`        | 1936/1944                                                                                                      | 纯 effects 淡入淡出                                                                                                 |
| M8  | `dt-drawer-in/out`          | 2403/2413                                                                                                      | spatial default + 手势速度接管                                                                                      |
| M9  | `dt-sheet-in/out`           | 2801/2811                                                                                                      | spatial slow（大表面），支持中途反向                                                                                |
| M10 | `shimmer`                   | 1045                                                                                                           | 保留（确定性加载），但改用 M3E tonal 色带                                                                           |
| M11 | `spin`                      | 1057                                                                                                           | 被 LoadingIndicator 取代；仅在 >5s 确定/不确定圆形进度保留                                                          |
| M12 | `transform: scale()` 位移态 | 0.94/0.95/0.98/0.985/0.998（7 处）                                                                             | 改为按组件形状变形 + 弹簧，不再是等比缩放                                                                           |
| M13 | 列表入场                    | 无                                                                                                             | 任务行/时间点行做交错入场（≤50ms 间隔，仅首屏，重排不重播）                                                         |
| M14 | 选中/置位                   | 直接切换背景                                                                                                   | SegmentedButton/FilterChip 的选中指示器位移用 spatial fast 弹簧                                                     |
| M15 | 完成状态切换                | `.task-status-button` 圆点                                                                                     | 形状变形（圆形→勾选）+ 轻微过冲（expressive 时刻）                                                                  |
| M16 | 导航切换                    | 无转场                                                                                                         | 同级用 shared-axis X，跨层级用 shared-axis Z                                                                        |
| M17 | JS 与 CSS 同步              | `usePresence(open, exitDuration=220)`（`App.tsx:100`）写死 220ms；`setTimeout(180/150/2200)`（1658/3183/3806） | 退出时长必须从令牌读取（`getComputedStyle` 或 TS 常量表）；防止"动画未完成就卸载/界面早已静止"的错位                |
| M18 | 减弱动效                    | `styles.css:2822–2831` 全局 0.01ms 一刀切；`usePresence` 单独判断（108–111）                                   | 改为 standard 方案降级：spatial→淡入淡出/位移缩短，effects 保留；形状变形→交叉淡入；`usePresence` 与 CSS 取同一来源 |

---

## 8. 维度六：适配（Adaptation / A11y / Platform）

### 8.1 尺寸类与断点

| #   | 修改点           | 现状                                                                                 | 目标                                                                                                     |
| --- | ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| R1  | 断点收敛         | `767`(×4)、`768`、`1100`、`720` 散落 13 处                                           | 收敛为 M3E 窗口尺寸类：compact <600、medium 600–839、expanded 840–1199、large 1200–1599、xlarge ≥1600    |
| R2  | 移动端巨型覆盖块 | `2438–2800`（≈360 行）与 `3890–4010`、`4009–4018`、`4252–4293`、`4300–4345` 反复覆盖 | 合并为单一 `responsive.css`，每个断点只声明一次                                                          |
| R3  | 双栏             | `.calendar-layout` 在 1100 以下折叠（2430–2436）                                     | expanded 保持 list-detail 双栏，compact 用 Sheet                                                         |
| R4  | 导航形态         | 固定侧栏                                                                             | compact 底部导航 / medium 导航轨 / expanded 抽屉                                                         |
| R5  | 平板与折叠屏     | 无差别处理                                                                           | 折叠屏展开态走 medium+；横竖屏切换不丢失滚动位置与选中项                                                 |
| R6  | 安全区           | 已有 `--dt-safe-*`（6–10）                                                           | 保留并覆盖新增的 bottom sheet / navigation bar / toolbar                                                 |
| R7  | 文本放大         | 未见验证                                                                             | 1.3×/1.5× 字体缩放下不截断按钮与列表标题                                                                 |
| R8  | RTL              | 未见验证                                                                             | M3E 要求支持；若要支持需把 `left/right` 改为逻辑属性（`inset-inline`、`margin-inline`、`border-inline`） |

### 8.2 主题与平台

| #   | 修改点            | 现状                                                                                        | 目标                                                                          |
| --- | ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R9  | Web 动态配色      | 固定静态方案                                                                                | 从品牌种子生成 light/dark 方案（可用 Material Color Utilities），保留静态兜底 |
| R10 | Android 动态配色  | `Theme.kt:100–101` 已支持 `dynamicLight/DarkColorScheme`；`Shapes` 为 4/8/12/16/24（72–78） | 更新为新形状标尺；动态色与静态方案的角色必须补齐 fixed 角色                   |
| R11 | Android 系统栏    | `styles.xml` 状态栏/导航栏透明 + `windowLightStatusBar`                                     | edge-to-edge + M3E 系统栏对比，随动态色更新                                   |
| R12 | Android 主题色    | `values/colors.xml` `#F5F2F9` / `values-night` `#0D0E13`                                    | 与新调色板同步                                                                |
| R13 | Electron 窗口     | `desktop/src/main.ts:86–95/122/126` 硬编码 `#0d0e13`/`#f5f2f9`/`#171b23`                    | 与新调色板同步；Windows 标题栏 overlay 同步                                   |
| R14 | PWA 主题色        | `index.html:6`、`theme-preload.js:19`、`theme.ts:31`、`vite.config.ts:23–24`                | 四处同源；建议由构建脚本从令牌生成，避免再次漂移                              |
| R15 | 桌面 QA 类        | `.desktop-app-shell`（134–160）                                                             | 保留，但补 M3E 窗口控制条与拖拽区视觉                                         |
| R16 | 原生 WebView 分支 | `html.native-mobile-shell` 27 条规则（含 `!important`）                                     | 逐条复核是否仍需要；能由尺寸类表达的一律删除                                  |

### 8.3 可访问性与门禁

| #   | 修改点         | 现状                                                                                                               | 目标                                                                                              |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| R17 | axe 门禁       | `apps/web/e2e/a11y.spec.ts`（登录页 + 已登录壳）                                                                   | 扩到主要路由（today/tree/tasks/workflows/time/archive/settings）+ 弹窗/Sheet 打开态               |
| R18 | 对比度         | M3 角色默认达标，但 state layer 叠加后未验证                                                                       | 每档对比度（standard/medium/high）跑 axe，正文 ≥4.5:1                                             |
| R19 | 屏幕阅读器     | 已有 `aria-label` 34+38 处                                                                                         | Sheet/FABMenu/SegmentedButton 补 `aria-expanded`/`aria-controls`/`aria-orientation`/`role="menu"` |
| R20 | 主题断言       | `theme.spec.ts` 断言 `rgb(245,242,249)`/`rgb(13,14,19)`；`theme.test.ts` 断言 `#f5f2f9`/`#0d0e13`                  | 改调色板时**必须同步这两个测试**，否则门禁失败                                                    |
| R21 | 类名耦合的 E2E | `.quick-capture kbd`、`.workflow-task`、`.focused-highlight`（`smoke.spec.ts:213`、`v2-features.spec.ts:257/268`） | 组件重构时保留这些类名或同步更新测试选择器                                                        |
| R22 | 减少动效验证   | 无自动化                                                                                                           | 增加 `prefers-reduced-motion` 下的截图/属性断言                                                   |

---

## 9. 全量文件级修改清单

### 9.1 必改文件

| 文件                                                               | 改造内容                                                                                                        | 规模                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| `packages/ui/src/tokens.css`                                       | 全量重写：角色补齐、shape 10 级、motion 弹簧令牌、类型标尺、elevation 0–5、对比度档位、`--dt-*` 兼容层保留      | 197 → 约 400 行      |
| `packages/ui/src/index.ts`                                         | 删除或改为从令牌派生的常量导出                                                                                  | 15 行                |
| `packages/ui/package.json`                                         | 若新增 `tokens.ts`/生成脚本需补 exports                                                                         | 小                   |
| `apps/web/src/styles.css`                                          | 拆分 + 重写（见 A1–A6），4711 行 → 多文件                                                                       | 最大工作量           |
| `apps/web/src/components/m3.tsx`                                   | 升级为 `components/m3e/`（约 20 个组件）                                                                        | 196 → 约 1500+ 行    |
| `apps/web/src/App.tsx`                                             | 外壳结构、Top App Bar、Navigation、FAB Menu、Button/Sheet/Snackbar 接入、内联样式清零、`usePresence` 时长令牌化 | 4360 行，约 40% 触碰 |
| `apps/web/src/TreePage.tsx`                                        | 目录/流程/所有任务结构、任务详情改造为 Sheet、内联样式与硬编码色清零、接入 M3E 组件                             | 1618 行，约 50% 触碰 |
| `apps/web/src/auth.tsx`                                            | 登录/中枢流程接入 M3E 表单组件                                                                                  | 530 行               |
| `apps/web/src/pwa.tsx`                                             | PWA 提示改为 Snackbar                                                                                           | 34 行                |
| `apps/web/src/theme.ts`                                            | `#f5f2f9`/`#0d0e13` 改由令牌/常量提供                                                                           | 83 行                |
| `apps/web/index.html`                                              | `theme-color` 与令牌同步；`color-scheme` 保持                                                                   | 21 行                |
| `apps/web/public/theme-preload.js`                                 | 主题色同步（注意 CSP：保持外链脚本，勿改内联）                                                                  | 21 行                |
| `apps/web/vite.config.ts`                                          | PWA `theme_color`/`background_color` 同步                                                                       | 52 行                |
| `apps/desktop/src/main.ts`                                         | 窗口背景、Windows 标题栏、`nativeTheme` 颜色同步                                                                | 86–130 行段          |
| `apps/mobile/.../ui/theme/Color.kt`                                | 补充 fixed 角色与新增 surface 角色                                                                              | 63 行                |
| `apps/mobile/.../ui/theme/Type.kt`                                 | 对齐 Web 类型令牌                                                                                               | 81 行                |
| `apps/mobile/.../ui/theme/Theme.kt`                                | `Shapes`（72–78）更新为新标尺；接入 M3E `MotionScheme`（material3 1.4+）                                        | 122 行               |
| `apps/mobile/.../res/values/colors.xml`、`values-night/colors.xml` | 主题色同步                                                                                                      | 小                   |
| `apps/web/test/theme.test.ts`                                      | 断言值同步                                                                                                      | 4 处                 |
| `apps/web/e2e/theme.spec.ts`                                       | 断言值同步                                                                                                      | 2 处                 |
| `apps/web/e2e/a11y.spec.ts`                                        | 路由覆盖扩展                                                                                                    | 73 行                |
| `docs/DARK_MODE.md`                                                | 更新令牌清单与新增对比度档位说明                                                                                | 中                   |
| `docs/STATUS.md`、`docs/TEST_REPORT.md`、`CHANGELOG.md`            | 迁移完成后补状态与证据                                                                                          | 中                   |

### 9.2 新增文件

| 文件                                                                  | 用途                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web/src/components/m3e/{button,field,container,navigation}.tsx` | M3E 组件实现（36 个导出）                                               |
| `apps/web/src/components/m3e/*.css`                                   | 组件样式（每个组件自带）                                                |
| `apps/web/src/styles/*.css`                                           | 样式分层：`type` / `base` / `tasks` / `pages` / `motion` / `responsive` |
| `apps/web/src/components/m3e/behavior.ts`                             | 尺寸类、presence、焦点陷阱、滚动锁、触觉反馈                            |
| `scripts/motion-tokens.ts`                                            | 从弹簧物理生成 `linear()` 令牌（`--check`/`--write`）                   |
| `scripts/theme-tokens.ts`                                             | 派生并校验六处主题色与 `@devtodo/ui` 令牌镜像                           |
| `docs/adr/0003-material-3-expressive.md`                              | 记录本决策（形状/动效/组件取舍与不做的部分）                            |
| `apps/web/test/m3e-tokens.test.ts`                                    | 令牌契约单测（弹簧峰值、圆角标尺、类型角色、高度、画布）                |
| `apps/web/test/m3e-behavior.test.ts`                                  | 尺寸类断点与弹簧时长单测                                                |
| `apps/web/e2e/motion.spec.ts`                                         | 减弱动效降级与弹簧过冲的浏览器断言                                      |

### 9.3 明确不改

- Task / Placement / Folder / Workflow / TaskStep 的数据模型与同步协议。
- 离线 fail-closed、冲突合并、拒绝 mutation 的可见性与文案语义。
- `packages/config`、`packages/contracts`、`packages/domain`、`packages/database`、`apps/api` 的任何行为。
- 主题不在 `SettingsDto` 落库（[DARK_MODE.md](DARK_MODE.md) 的数据边界）。
- CSP：`theme-preload.js` 必须保持外链脚本，不得改回内联。
- 原生拖拽之外的键盘等价路径（ADR 0002 要求）。

---

## 10. 分阶段落地计划

| 阶段          | 内容                                                                                                                                                      | 交付物                       | 退出条件                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| P0 令牌与骨架 | `tokens.css` 重写、`motion.ts`、`tokens.ts`、样式分层空壳、`tokens-sync.ts`、ADR                                                                          | 令牌文件 + 同步脚本          | `pnpm typecheck`、`theme.test.ts`、`theme.spec.ts`（更新断言后）PASS |
| P1 组件底座   | Button/IconButton/ButtonGroup/SplitButton/Chip/Segmented/TextField/Card/ListItem/Dialog/Sheet/Nav/AppBar/Toolbar/Badge/Progress/LoadingIndicator/Snackbar | `components/m3e/` + 组件样式 | 组件级单测（行为纯函数）+ axe 在组件展示页 PASS                      |
| P2 外壳与导航 | Top App Bar、Navigation Bar/Rail/Drawer、尺寸类、FAB Menu、Search View、Toolbar                                                                           | `App.tsx` 外壳重写           | `smoke.spec.ts` 全绿（chromium/mobile/firefox）                      |
| P3 核心页面   | Today、目录树、所有任务、流程、任务详情 Sheet                                                                                                             | 页面结构完成                 | `v2-features.spec.ts`、`archive-picker.spec.ts` 全绿                 |
| P4 外围页面   | 日历、时间点、归档、设置、更多、登录/中枢/初始化、冲突收件箱                                                                                              | 页面结构完成                 | 全量 E2E + 新增 a11y 路由覆盖 PASS                                   |
| P5 动效与适配 | 弹簧令牌全域替换、形状变形、交错入场、减弱动效降级、双栏/导航轨/平板                                                                                      | 动效与响应式完成             | 视觉 spec + `prefers-reduced-motion` 断言 PASS                       |
| P6 平台同步   | PWA/Electron/Android 主题色与形状/类型同步、系统栏、触觉反馈                                                                                              | 三端一致                     | `desktop:test`、Android 编译 + 单测、`format:check`/`lint` PASS      |
| P7 清理与文档 | 删除死 CSS、`!important` 收敛至 1 处、`--dt-*` 收敛、文档与 CHANGELOG                                                                                     | 收尾                         | 全量门禁 + `openapi:check` 不变                                      |

---

## 11. 验收门禁与回归风险

### 11.1 必须保持绿色的现有门禁

```text
pnpm format:check        # 新增 doc/组件后格式
pnpm lint                # 0 warning
pnpm typecheck           # workspace build + Web build + noEmit
pnpm test                # 15 files / 131 tests（含 theme.test.ts）
pnpm test:e2e --projects=chromium,mobile,firefox
pnpm a11y                # axe（覆盖范围将扩大）
pnpm desktop:test        # Electron 静态安全
./gradlew :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin
```

### 11.2 新增门禁建议

- 组件行为纯函数单测（roving tabindex、disclosure、排序等价路径）。
- `prefers-reduced-motion` 与三档对比度的自动化断言。
- PWA/Electron/Android 主题色与 `tokens.css` 一致性检查（由 `tokens-sync.ts` 提供 `--check` 模式）。

### 11.3 高风险点

| 风险                      | 说明                                                         | 缓解                                                              |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| 焦点管理回归              | 任务详情从自制浮层改为 Sheet 时最易丢失焦点陷阱与 Esc/back   | 复用 `Modal`（`App.tsx:1451`）已审计的焦点逻辑，不重写            |
| E2E 选择器破裂            | `.quick-capture kbd`、`.workflow-task`、`.focused-highlight` | 组件重构时保留语义类名，或同 PR 更新测试                          |
| 主题断言破裂              | `theme.spec.ts`/`theme.test.ts` 硬编码颜色                   | 调色板变更与断言更新必须同一提交                                  |
| 移动端底栏高度与 FAB 遮挡 | 曾有"FAB 永久遮挡最后一行"缺陷（见 STATUS）                  | 新 Navigation Bar + FAB Menu 后重新核对 `padding-bottom` 与安全区 |
| 后台刷新替换可交互内容    | 已有 `useReloadable.initialLoading` 回归测试                 | 组件重写不得回退该行为                                            |
| 动效性能                  | 弹簧 + 形状变形在低端 Android WebView                        | 只用 transform/opacity；列表入场仅首屏；真机单独验收              |
| `linear()` 兼容性         | WebKit/Firefox 旧版本                                        | 保留 cubic-bezier 回退路径                                        |

---

## 12. 参考资料

- [Material 3 Expressive（m3.material.io）](https://m3.material.io/blog/building-with-m3-expressive)
- [M3 形状圆角标尺](https://m3.material.io/styles/shape/corner-radius-scale)
- [M3 动效规范](https://m3.material.io/styles/motion/overview/specs)
- [M3 类型标尺令牌](https://m3.material.io/styles/typography/type-scale-tokens)
- [M3 & M3 Expressive 设计语言整理（含迁移清单）](https://github.com/HalidSaglam/saglitzdesign-mcp/blob/0977d6d2deb9d04b7ef67e5c84d13c6ec6912960/knowledge/design-languages/material-3.md)
- [M3 Expressive 组件实现参考（FAB Menu / Loading Indicator / Split Button）](https://github.com/thejaustin/AppManager/blob/master/M3_EXPRESSIVE_SUMMARY.md)

> 注：M3E 的 shape/motion/typography **具体数值必须取自官方 token 导出**（Compose `material3` 1.4+、Material Web、Figma tokens）。本文给出的标尺用于定义改造范围与命名，落地时以官方 token 为准，不得凭印象填值。

---

## 附录 A：现状量化命令

```bash
# 圆角/字号/字重分布
grep -o "border-radius: [^;]*" apps/web/src/styles.css | sort | uniq -c | sort -rn
grep -o "font-size: [^;]*"   apps/web/src/styles.css | sort | uniq -c | sort -rn
grep -o "font-weight: [^;]*" apps/web/src/styles.css | sort | uniq -c | sort -rn

# 令牌债务
grep -c -- "--dt-" apps/web/src/styles.css          # 400
grep -c -- "--m3-" apps/web/src/styles.css          # 283
grep -c "!important" apps/web/src/styles.css        # 102
grep -c "color-mix" apps/web/src/styles.css         # 33

# 动效债务
grep -n "@keyframes" apps/web/src/styles.css
grep -o "[0-9.]*s ease\b" apps/web/src/styles.css | sort | uniq -c

# 生命周期层边界
grep -n "^/\*" apps/web/src/styles.css              # 2686 / 2833 / 4019 / 4294 / 4346
```

## 附录 B：未定义变量与缺失类

- 未定义变量（仅出现在 v2 层）：`--outline`、`--surface`、`--muted`、`--accent`、`--ink`、`--focus` → 证据 `apps/web/src/styles.css:4364/4366/4375/4391/4400/4490/4522/4548`。
- 未定义变量（单点）：`--dt-text` → `apps/web/src/styles.css:1441`。
- TSX 使用但 CSS 未定义：`error-banner`（`TreePage.tsx:816`）、`page-subtitle`、`page-section`、`tree-move-sheet`、`status-icon`、`form-input`（`App.tsx:3245`）。
- 未使用选择器（抽样，共约 54 个）：`.detail-panel`（1585）、`.note-editor`（1649）、`.editor-tabs`（1655）、`.markdown-preview`（1684）、`.project-grid`（1153）、`.project-card`（1162）、`.filter-tabs`（1119）、`.priority-*`（886–903）、`.segmented-control`（2014）、`.task-library-summary`（3641）、`.nav-create`（327）。
