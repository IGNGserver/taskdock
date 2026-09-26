# Changelog

## 2.0.0-rc.24 · 2026-09-26

### 新增

- 目录页任务左侧的状态圆圈改为三态循环：一次点击按「待开始 → 进行中 → 已完成」推进，提示语直接说明会切换到哪个状态，不再只有完成/未完成两态。
- 「任务库」页面统一改名为「目录」，页面标题、侧边导航、移动底部导航与面包屑同步更新。

### 修复

- 修复在目录页点击状态圆圈后任务立刻跳走的问题：状态改动只就地更新圆圈，分组与行位置保持不变，直到用户下次进入该目录（或主动重试、移动、新建）时才按最新状态重新分组。此前 `/tree/children` 按状态分桶返回顺序，且同步引擎在每次变更后额外广播一次数据事件，导致单次点击就会让任务在手指下换组、换行。
- 修复任务详情标题输入框文字不居中且可以横向滚动的问题，并移除与顶部操作重复的「复制任务」按钮。
- 修复「安排任务」弹窗选中任务后没有确认入口的问题：底栏固定显示已选择数量、清空选择和「加入日程（N）」；标签页、搜索框与面包屑改为随内容一起滚动，小屏设备上不再出现只有约一半高度可滚动的情况。
- 重构流程页面：阶段以看板列展示并带任务计数，每个阶段和每条任务的操作统一收敛到溢出菜单（跨阶段移动、阶段内排序、移除、重命名、归档），新增「添加任务」弹窗支持搜索与多选；移动端阶段改为单列堆叠，桌面与移动端均无横向溢出。

## 2.0.0-rc.18 · 2026-09-25

### 修复

- 修复原生客户端重启后丢失登录凭据：Android `ApiClient.refreshSession`、桌面 `main.ts:nativeRefresh` 与 Web `refreshAccessToken` 此前把 `/auth/refresh` 的**任何** 401 都当作会话撤销并删除本地 refresh token，而一次性挑战过期/被消费同样返回 401（`AUTH_REQUIRED`）。现在只有 `AUTH_SESSION_REVOKED`/`AUTH_INVALID_CREDENTIALS` 才清除凭证，中枢侧把这类失败改判为 `AUTH_CHALLENGE_INVALID`（403）。
- 修复「中枢已轮转、客户端没收到响应」导致下次启动重放废 token 并撤销整条会话链：客户端在请求前先生成并落盘后继 refresh token（Android `pending_refresh_token`、桌面 `pendingRefreshToken`、Capacitor `pending-refresh-token`），中枢 `AuthService.refresh` 接受客户端提供的 `nextRefreshToken` 并在识别到同一后继时幂等重发，不引入时间宽限期，重放检测对第三方仍然有效。
- 修复 Android 冷启动读不到 Keystore 就被判定未登录：`SecureTokenStore` 的主存储句柄改为可按需重开，refresh/access/pending token 同时写入 AndroidX 加密文件与 Keystore 副本并互相修复（单份文件损坏或暂时不可读不再等于丢失登录）；`MainViewModel` 不再缓存登录态快照，启动时会延迟重读一次存储，`TaskDockApp` 统一负责登录页与工作区之间的双向跳转。
- 修复桌面端在系统钥匙环尚未就绪（Linux 重启后常见）时被登出：`readSecureRefreshToken` 拆分 missing/unavailable/corrupt 三态，不可读视为可重试的 `AUTH_STORAGE_UNAVAILABLE`（503）而不是会话撤销，文件不再被删除。
- 强制重新登录时不再清空账号名，登录页预填上次用户名；`docs/SECURITY.md` 补充原生端会话持久化契约。

## 2.0.0-rc.5 · 2026-09-20

### 修复

- 校准 Web 顶栏、页面容器和内容栏的 Material 3 层级、间距、表面与响应式行为，减少搜索栏、导航抽屉和主体内容之间的视觉断层。
- 重整目录与流程页面的创建表单、列表操作菜单、空状态和标题层级，补齐移动端与宽屏布局下的可达操作。
- 修复 Today 空数据时显示 `0%` 进度的问题，并统一页面文案、主题令牌和深色画布对比度。

## Unreleased · 2026-09-19

### 新增

- Material 3 → Material 3 Expressive 迁移，覆盖外观语言、页面结构、组件、交互、动效、适配六个维度；决策与取舍记录在 `docs/adr/0003-material-3-expressive.md`，清单见 `docs/UI_EXPRESSIVE_MIGRATION.md`。
- 新增 30 个 M3E 组件（`apps/web/src/components/m3e/`，另有 `ChevronGlyph`/`CloseGlyph`/`CheckGlyph`/`ChevronDown`/`joinClasses` 等工具导出）：Button、IconButton、ButtonGroup、SplitButton、Menu、Fab、FabMenu、TextField、TextArea、Select、Chip、Switch、Card、List、ListItem、Badge、LinearProgress、LoadingIndicator、Snackbar、Dialog、ConfirmDialog、BottomSheet、SideSheet、Tooltip、Toolbar、NavigationBar、NavigationRail、NavigationDrawer、TopAppBar、SearchBar。
- 新增 `scripts/motion-tokens.ts`：把 M3E 弹簧物理（阻尼比 + 刚度）采样为 CSS `linear()` 缓动写入 `tokens.css`；`pnpm tokens:motion` 在漂移时失败。
- 新增 `scripts/theme-tokens.ts`：从 `tokens.css` 派生并校验六处硬编码主题色（HTML meta、theme-preload、theme.ts、PWA manifest、Electron、Android 资源）；`pnpm tokens:theme` 在漂移时失败。两者接入 `pnpm build` 与 `pnpm tokens:check`。
- 新增样式分层：`styles/{type,base,tasks,pages,motion,responsive}.css` 取代 4711 行的单文件 `styles.css`，导入顺序即层叠契约。
- 新增 M3 窗口尺寸类（compact/medium/expanded/large/xlarge）：compact 用导航栏 + FAB menu，medium 用导航轨，expanded 及以上用常驻导航抽屉。
- 新增 `apps/web/test/m3e-behavior.test.ts` 与 `apps/web/e2e/a11y.spec.ts` 覆盖的令牌/尺寸类契约测试。

### 变更

- 圆角标尺由 6 级扩展为 10 级；动效由「时长 + 缓动」改为 spatial/effects × fast/default/slow 弹簧令牌；类型建立 15 个角色 + emphasized 变体；新增高度 0–5 令牌。
- 状态层改为按角色计算（`on-surface` / `on-primary` / `on-error`），修复「危险按钮 hover 出现蓝色叠加」。
- 任务详情从 `position: fixed` 的自制浮层改为 M3E sheet：展开宽度用 side sheet，compact/medium 用 bottom sheet，获得焦点陷阱、presence 动效与深色适配。
- 移动端创建入口从模态动作表改为 M3E FAB menu。
- 导航目的地改为真实链接（router `NavLink`），修复丢失中键点击与「在新标签页打开」，并消除 `aria-required-parent` 违规。
- `usePresence` 的退出时长改为从弹簧令牌读取，避免组件在关闭动画结束前卸载。
- 减弱动效降级保留语义：spatial 弹簧变短淡入淡出、去掉位移与过冲，不再全局 `0.01ms` 一刀切。

### 修复

- 删除 v2 目录/流程层使用的 6 个从未定义的 CSS 变量（`--outline/--surface/--muted/--accent/--ink/--focus`），该区域此前永远走 fallback 色且深色模式失效。
- 补齐 TSX 使用但 CSS 缺失的类：`error-banner`、`page-subtitle`、`page-section`、`tree-move-sheet`、`status-icon`、`form-input`。
- 删除约 54 个未使用选择器与重复覆盖声明；`!important` 由 102 处降至 1 处（仅保留减弱动效下的 `scroll-behavior: auto` 强制覆盖，见 `styles/motion.css`）。
- 修复 `--dt-text` 未定义导致颜色回退。
- 修复移动底部导航列数冲突（4 列 vs 5 列规则互相覆盖）。
- 修复 `today-overview-label` 对比度 4.29:1，低于 WCAG AA 4.5:1（axe 门禁曾失败）。
- 修复紧凑外壳 `.app-frame` 为 `flex-direction: row` 导致底部导航覆盖内容并拦截点击。
- 修复导航抽屉关闭依赖 `transitionend` 偶发不触发，改为显式 presence 生命周期。
- 修复 `IconButton` 显式传入的 `aria-label` 被 `label` 属性覆盖，导致转换后的调用点丢失可访问名称。
- 修复 FAB menu 关闭时其容器拦截整片区域的指针事件。
- 修复触摸设备上仍显示 ↵ 键盘提示。
- Android：补齐 M3E 颜色角色常量（含 fixed 组与 success/warning），修正 background 为 `#FBF8FF` / `#121318`；`Shapes` 的 `extraLarge` 由 24dp 调整为 28dp。

### 验证

- 本地门禁：`format:check`、`lint`（0 warning）、`typecheck`、`test`（18 files / 154 tests）、`tokens:check`、`desktop:test`、Playwright E2E（chromium/firefox/mobile 51 passed / 15 skipped）、Android `testDebugUnitTest` + `compileDebugAndroidTestKotlin` 全部 PASS。
- WebKit E2E 仍为 NOT RUN（当前 Linux 缺少 WebKit 图形依赖）；已在迁移前的基线上复现同样失败，确认为环境缺失而非本次改动引入。

## Unreleased · 2026-09-18

### 新增

- 增加 TaskDock v2 Folder 目录树、混合子项排序、派生聚合状态、循环保护、目录移动和面包屑导航。
- 增加按 operationId 逐项递归归档/精确恢复、带 fingerprint/token 的整树删除预览、关联实体 tombstone 和审计保留。
- 增加独立 TaskStep、可多流程归属的 Workflow/Stage/Membership、日期/Event/Placement v2 路由与同步命令。
- 增加 `/api/v2`、v2 snapshot/push/pull/status/WebSocket、PostgreSQL 0005–0009 migration、Dexie v3 和 Android Room v6 无损迁移链。
- 增加 React Web 目录/流程界面和原生 Android Compose 目录/流程/步骤/归档/在线删除预览界面；全局快速创建入口限定为 Task。
- 增加 `/api/v2/archive-operations`（归档中心按顶层归档操作分组，含后代计数与保留状态明细）与 `/api/v2/dates/{date}/rollover`、`/api/v2/rollovers/undo`。

### 修复

- 归档中心不再平铺归档后代，改为按顶层归档操作展示 Folder/Task 计数、嵌套明细与"原本已归档、恢复时保留"状态。
- 修复归档中心对无 `archivedByOperationId` 的文件夹发送 `{}` 恢复请求导致必然 400；现在禁用该入口并给出明确说明。
- 修复离线整树删除的 fail-closed 保护不可达：`delete-preview` 现在返回结构化 `OFFLINE_TREE_DELETE_FORBIDDEN`/`ARCHIVE_INSTEAD`，用户看到归档建议而非通用网络错误。
- 修复 V2 `resolveConflict` 缺少 `restore` 策略（UI 已暴露但静默降级为重试）；现按 task/timePoint/workflow 实现恢复后应用本地意图。
- 修复 V2 `applyChanges` 缺少旧版本守卫，重复或乱序的 pull 响应会把较新的本地行回滚。
- 修复 v1 rollover 只写 v1 change feed 导致 v2 客户端永不收敛；rollover 现为 v2 命令，离线时 fail-closed。
- 修复 `convertV1OutboxForV2` 类型化升级队列返回值被丢弃；队列现持久化并在设置页可查看、导出。
- 修复 Dexie v2 快照不清理遗留 `projects` 表，陈旧项目行可通过 v1 兼容读取泄漏。
- 修复 Android 同步：`SYNC_CURSOR_EXPIRED` 现触发重新 snapshot；workflow/stage/membership 删除不再伪造空名桩行；推送成功后清除 `pendingSync`。
- 修复 Android Room schema JSON 未纳入版本控制、`androidTest` 未接 `schemas` assets，导致迁移测试无法在干净检出上运行。
- 修复"最近有效目录"契约：`last-folder-id` 以前只读不写，日期/事件页新建任务恒落根目录并忽略 `defaultCaptureTarget`。
- 修复 0006 backfill 承诺的 Folder-first 初始排序未实现（新增 0009 迁移对同级重新分层）。
- 修复移动端固定 FAB 永久遮挡页面最后一行可交互元素。
- 修复 `useReloadable` 后台刷新时把可交互内容替换为骨架屏，导致点击目标中途消失。
- 清理 `apps/web/src/api.ts` 无引用的 v1 默认 base 与死代码别名。

### 验证

- 本地门禁：`format:check`、`lint`、`typecheck`、`test`（15 files / 131 tests）、`openapi:check`（99 paths）、`desktop:test`、Playwright E2E（chromium/mobile/firefox 21 passed）、Android `testDebugUnitTest`/`compileDebugAndroidTestKotlin` 全部 PASS。
- 真实 PostgreSQL：migration 连续执行幂等、`integration-smoke`（含 v2 `PostgresTreeStore` 重启/pull/删除预览与 Folder-first 断言）、`pg-runtime-smoke`（真实 `/api/v2` HTTP、v2 WebSocket 通知、API 重启游标连续、PostgreSQL 重启恢复）均 PASS。
- 未部署、未打标签、未发布。WebKit、Android 真机/仪器、Electron GUI、Docker Compose 与长期双端离线矩阵仍未运行，详见 `docs/TEST_REPORT.md`。

## 0.1.0 · 2026-09-05

- 建立 Task 与 Placement 分离的 DevTodo V1 工程。
- 增加 Owner bootstrap、Argon2id 登录、refresh rotation、设备撤销和统一错误码。
- 增加项目/任务/Note/日期/Event/Placement API、归档恢复、复制/移动/批量 rollover。
- 增加 PostgreSQL migration、增量 change feed、幂等 mutation receipt 和 Dexie 离线 outbox。
- 增加 React/PWA Web UI、Electron 安全壳和 Capacitor Android 工程；生成 Linux Electron 目录包和 Android 未签名 release APK。
- 增加稳定 keyset 列表游标、Web 分页聚合、同步 cursor 原子推进、失败重试退避和冲突保留。
- 增加 ADR 记录 Store 全量持久化边界，以及 Electron builder、桌面拖拽/键盘替代和移动端 Bottom Sheet 取舍。
- 记录当前已通过的自动化门禁，以及尚未具备 Docker/PostgreSQL、Windows、Android 真机、iOS WebKit 和备份恢复条件的门禁。
