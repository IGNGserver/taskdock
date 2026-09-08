# DevTodo 开发完成度审计与续做基线

审计日期：2026-09-08  
审计对象：`/home/lvziw/项目/todo-list工具` 当前工作区  
审计方式：需求对照、源码复核、自动化门禁复跑、正式构建产物 smoke 与真实环境边界核对  
本轮复核边界：在上一轮修复基础上同步当前实现状态；保留 2026-09-05 历史审计全文，不把未运行环境门禁记为通过

## 0. 2026-09-08 状态复核

**当前结论：FAIL — 代码级阻断项大部分已修复，自动化门禁大部分通过，但正式发布仍被真实环境验收缺失阻断。**

本轮复核确认，上一轮审计指出的正式 API 启动、Electron ESM 路径、`/me` 敏感字段泄漏、PostgreSQL 全量快照写回、同步 FIFO/回滚、今日 Placement、移动端入口、备注合并、WebSocket 鉴权、原生认证挑战、Electron Hub 配置、迁移发现和 receipt retention 等问题，当前源码已完成对应修复或已建立代码级防护。`pnpm test -- --reporter=dot` 当前为 6 个测试文件、44 项通过；正式构建 API 的 server smoke、构建、lint、格式、类型、OpenAPI、桌面安全 smoke、axe 无障碍 smoke 和 Android release 构建均已通过。本轮统一 release gate 使用 PostgreSQL 18 用户态实例 `127.0.0.1:55432`、数据库 `devtodo_release_20260908_205701_17223`，`integration-postgres` 与 `capacity-postgres` 均已实际运行并通过；`scripts/e2e-real-server.ts` 的 shutdown 等待、幂等清理和提前 fixture 清理已修复，release gate 的数据库生命周期也已修复为容量 fixture 先运行、浏览器 E2E 使用唯一 Owner、结束后显式删除测试 Owner。

这不等于项目已经完成 `DEVELOPMENT_PLAN.md` 的 Definition of Done。Compose build/up、Compose 数据卷重启/备份恢复链、Electron GUI、Windows、Android 真机、iOS/WebKit、双客户端长期离线/冲突/响应丢失恢复以及长时间稳定性验收仍未运行，因此总体状态必须继续为 `FAIL`。

### 本轮新增真实 API E2E 与数据库证据

- 内存后端真实 API：Chromium/移动 Chromium 8/8 通过，Firefox 4/4 通过。
- PostgreSQL 后端真实 API：使用临时用户态 PostgreSQL 18 数据库 `devtodo_e2e_20260907`，执行 `E2E_REAL=1 E2E_DATABASE_URL=... E2E_BOOTSTRAP_TOKEN=... pnpm test:e2e -- --project=chromium --project=mobile`，Chromium/移动 Chromium 8/8 通过；覆盖初始化/登录、今日任务创建、第二浏览器 context 读取同一任务、移动导航可见性、核心 smoke 与 axe。
- 删除临时库前核对计数为 `users=1`、`tasks=2`、`placements=2`，随后安全删除；该结果证明的是临时 PostgreSQL-backed 基础链路，不等于 Docker Compose、生产部署、长时间离线、响应丢失恢复或冲突矩阵验收。
- 独立 PostgreSQL 备份恢复验收：以 `MISC-1` 为稳定任务引用，确认恢复后的备注 `version=2` 且内容包含“备份恢复验收”；`pg_dump --format=custom` / `pg_restore` 后计数为 `users=1`、`tasks=3`、`placements=3`、`notes=3`、`schema_migrations=4`。该证据证明 PostgreSQL dump/restore 的业务不变量，不替代 Docker Compose build/up、重启和容器卷验收。
- 本轮 release gate 数据库 `devtodo_release_20260908_205701_17223` 在所有检查结束后核对为 `users=0`、`tasks=0`、`time_points=0`、`placements=0`、`notes=0`、`schema_migrations=4`；浏览器 E2E fixture cleanup 为 PASS，未把测试 Owner 留在后续门禁中。

### 当前问题复核表

| 项目                          | 当前复核结论                                                   | 证据与边界                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 正式 API/SPA 启动       | PASS（代码 + server smoke）                                    | 静态资源与 SPA fallback 已采用不冲突的路由策略；正式构建进程、健康检查、API 404 和页面 fallback 已通过。                                                                                                                                                                                                                                           |
| P0-02 Electron 启动与打包路径 | PASS（代码 + package）/NOT RUN（GUI）                          | 已改用 ESM 安全路径解析，并加入 Hub 配置、单实例、窗口状态和安全 preload；当前无图形显示或 `xvfb-run`，真实窗口启动未运行。                                                                                                                                                                                                                        |
| P0-03 `/me` 脱敏              | PASS（测试 + server smoke）                                    | 使用公开用户 DTO allowlist；负向测试和正式 server smoke 均确认响应不含 `passwordHash` 等服务端字段。                                                                                                                                                                                                                                               |
| P0-04 PostgreSQL 权威存储     | PASS（代码 + 真实 PG integration）                             | 生产路径已改为 owner-scoped SQL、行级更新、事务内领域写入/version/change/receipt；`pnpm test:integration` 在 PostgreSQL 18 上通过 migration、owner isolation、双进程并发、幂等、回滚、重启和多 Placement。                                                                                                                                         |
| P1-01 至 P1-09                | PASS（代码/单测/基础真实 API E2E）/NOT RUN（离线冲突矩阵）     | 退出状态、outbox 严格 FIFO、乐观状态 reconciliation、今日 Task+Placement、移动底栏/FAB/Bottom Sheet、备注 merge/recovery、WebSocket 首消息认证、一次性 native challenge、Electron 配置与生命周期均已有实现；基础真实 API E2E 已覆盖登录、今日创建和第二 context 读取，双浏览器离线/冲突、设备和 GUI 验收未运行。                                   |
| P2-01 迁移执行器              | PASS（代码 + 单测 + 真实 PG migration）                        | 已支持自动发现、数字排序、checksum 不可变保护和事务回滚；`pnpm db:migrate` 已在 PostgreSQL 18 上通过。                                                                                                                                                                                                                                             |
| P2-02 receipt retention       | PASS（代码 + 单测）                                            | retention 配置已接入过期读取与清理路径；真实长期离线窗口与生产数据量验证未运行。                                                                                                                                                                                                                                                                   |
| P2-03 测试门禁诚实性          | PARTIAL                                                        | 主要脚本已区分 `PASS`、`FAIL`、`NOT RUN`；真实 API E2E、Compose、设备和 GUI 缺失时 release gate 仍为 `FAIL`。                                                                                                                                                                                                                                      |
| P2-04 Compose、备份恢复与升级 | PARTIAL（migration、独立 PG 备份恢复 PASS）/NOT RUN（Compose） | `DATABASE_URL=... pnpm db:migrate` 已在 PostgreSQL 18 上通过；独立用户态 PostgreSQL 已完成 `pg_dump -Fc` / `pg_restore` 并核对 `users=1/tasks=3/placements=3/notes=3/schema_migrations=4`；当前环境无 Docker，未执行 Compose build/up、重启和容器卷恢复。                                                                                          |
| P2-05 版本历史与 CI 回执      | FAIL                                                           | 当前仓库没有 commit，文件仍全部为 untracked，无法提供可核验提交历史或 CI run。                                                                                                                                                                                                                                                                     |
| P2-06 性能、容量与完整无障碍  | PARTIAL（容量 PASS）/NOT RUN（完整客户端无障碍）               | 隔离 PostgreSQL 库完成 50,000 Task、5,000 TimePoint、250,000 Placement；失败率为 0，`tasks.first-page` p95 2.20ms、`time-points.date-page` 4.84ms、`placements.page-with-task-join` 3.97ms、`search.owner-scoped` 61.25ms、`sync.pull` 1.60ms、`task.write.transaction` 4.98ms，均低于 250ms 阈值。完整 WebKit、屏幕阅读器和低端设备验收仍未运行。 |

### 当前自动化门禁摘要

```text
format / lint / typecheck / unit / build / OpenAPI       PASS
unit                                                     PASS（6 files / 44 tests）
server smoke                                             PASS
desktop security / Linux package                         PASS
Android release build                                   PASS（unsigned）
real PostgreSQL / integration / migration                PASS
capacity-postgres                                        PASS（50k Task / 5k TimePoint / 250k Placement）
独立 PostgreSQL backup/restore                             PASS（业务计数与 MISC-1 备注版本已核对）
Compose restart/backup chain                              NOT RUN
Electron GUI / Windows / Android device / iOS WebKit    NOT RUN
real API basic cross-context E2E                          PASS（Chromium/mobile + 临时 PG）
real API offline/conflict dual-client sync                NOT RUN
release gate                                             FAIL（未运行项阻断正式发布）
```

统一 release gate 的当前判定仍为 `FAIL`：最新 `pnpm release:gate`（2026-09-08）使用 `DATABASE_URL=postgres://lvziw@127.0.0.1:55432/devtodo_release_20260908_205701_17223 E2E_REAL=1 E2E_DATABASE_URL=postgres://lvziw@127.0.0.1:55432/devtodo_release_20260908_205701_17223 PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`，`format`、`lint`、`typecheck`、`unit`、`openapi`、`integration-postgres`、`capacity-postgres`、`build`、`built-server-process`、`browser-a11y`、`desktop-security` 和 `android-release` 为 PASS；`browser-e2e`、`compose-restart-backup`、`desktop-package-and-launch` 为 `NOT RUN`（exit 2）。浏览器 E2E 中 Chromium、Firefox、移动 Chromium 共 12 项通过，WebKit 因当前用户态依赖环境无法被 Playwright 正常启动而未运行；Linux Electron 目录包已生成，Electron 静态安全 smoke 为 PASS，但 GUI launch 因 `chrome-sandbox` 不是 root-owned `4755` 而未运行；当前环境也无 Docker。Windows NSIS、Android 真机、iOS WebKit/PWA、双客户端长期离线/冲突/响应丢失恢复和长时间稳定性仍为 `NOT RUN`。当前 Android unsigned APK SHA-256 为 `d585aca82b899e5277b7cefa72eff44fc5e3b75bb5afbd84a277069b0f35d367`。

### 当前复核的发布判断

当前可以宣称“代码级修复、基础真实 API E2E 和可用环境自动化门禁大部分通过”，不能宣称“正式开发完成”或“可发布”。下一步必须在具备 Docker、PostgreSQL、图形显示、Windows、Android 真机和 iOS/WebKit 的环境中执行第 10 节与 `DEVELOPMENT_PLAN.md` 的真实验收；在此之前，所有对应范围保持 `NOT RUN`。

---

## 历史审计记录（2026-09-05，原文保留）

以下内容是 2026-09-05 修复前的审计记录，保留其问题证据、影响、验收标准和续做顺序，用于追踪本轮修复前后的差异；其中的“当前状态”不应覆盖上面的 2026-09-08 复核。

# DevTodo 开发完成度审计与续做基线

审计日期：2026-09-05  
审计对象：`/home/lvziw/项目/todo-list工具` 当前工作区  
审计方式：需求对照、源码审查、现有测试复跑、真实构建产物启动、浏览器运行验证与定向故障复现  
本轮变更边界：只新增本审计文档，不修改业务代码、测试代码、构建配置或原有状态文档

## 0. 最终结论

**结论：FAIL — 开发没有完成，当前版本不可部署、不可发布，也不能宣称达到 `DEVELOPMENT_PLAN.md` 的 Definition of Done。**

当前工作区已经形成一套可继续开发的产品骨架，基础模型、内存实现、主要页面、离线队列雏形和多端包装工程均已存在；部分静态门禁、单元测试和模拟浏览器测试也能通过。但“能编译”和“模拟测试通过”尚未转化为真实可运行、可持久化、可安全同步、可安装交付的产品。

本次审计确认了四类发布阻断事实：

1. 构建后的 Hub/API 在包含 Web 静态资源时无法启动；Docker 正式运行路径会直接崩溃。
2. 新打包的 Electron Linux 应用无法启动；普通桌面用户也没有可用的 Hub 首次配置流程。
3. API 会向已登录客户端返回密码哈希，且原生客户端判定、WebSocket 鉴权存在令牌泄露风险。
4. PostgreSQL 实现不是逐行数据库存储，而是进程内全量快照加每次写入 `TRUNCATE`/全表重插，无法满足数据正确性、多进程安全和规划中的容量目标。

此外，离线队列存在乱序和幽灵数据问题，明确退出登录后会自动重新进入工作区，“今日”行内创建不会出现在今日，移动端信息架构与原始需求不一致，备注冲突也没有合并与恢复流程。

因此，后续执行者必须以本文件作为修复与验收清单，不得把现有 `PASS` 的编译、内存测试、静态检查或模拟 E2E 当作正式完成证据。

## 1. 审计口径与需求优先级

发生冲突时，以以下顺序解释需求：

1. 用户在原始《Todo应用方案建议》对话中明确表达的真实使用需求；
2. 工作区根目录 `DEVELOPMENT_PLAN.md` 中已经固化的功能、架构、里程碑和验收条件；
3. 当前源码、README、`docs/STATUS.md`、`docs/TEST_REPORT.md` 和 ADR 所描述的实现状态。

ADR 可以记录实现选择，但不能单方面缩减已经确认的需求。例如，ADR 接受“内存状态 + PostgreSQL 全量快照持久化”不能替代规划要求的 PostgreSQL 行级事务实现；静态页面或模拟设备截图也不能替代真实 Windows、Android 和 iOS 验收。

原始需求与规划中的关键不可变约束如下：

- Hub 必须能通过 Docker Compose 自托管，并以 PostgreSQL 作为可靠持久化存储。
- 产品必须提供 WebUI/PWA、Electron 桌面端和 Android 包装端；iOS 至少以可安装 PWA 形态可用。
- Task 是唯一任务正文；Placement 只负责把同一 Task 放进日期或自定义时间点。
- “复制到明天”必须新增 Placement，不能复制 Task；任何位置完成 Task 后都应全局反映完成状态。
- TimePoint 有独立生命周期，不能用标签或日期字段临时代替。
- 需要离线优先、可靠重试、幂等同步、冲突处理、跨客户端最终一致。
- 桌面端采用侧栏、内容区和详情区；移动端底栏必须是“今日 / 项目 / 时间 / 更多”，并有右下角 FAB，而不是缩小桌面侧栏或依赖汉堡菜单。
- 项目内至少有“功能”和“杂项”分类；任务备注可编辑。
- 正式完成必须以真实运行、真实数据库、真实安装/设备和恢复演练为证据；未执行项只能标记 `NOT RUN`。

## 2. 当前已有的有效成果

以下成果真实存在，可以保留并在其上继续工作：

- pnpm monorepo 已建立，包含 API、Web、Electron、Capacitor Android、contracts、database、domain、sync-client 和 UI 包。
- 数据模型已区分 Task、Placement、TimePoint、Project、Note、Change 和 Mutation Receipt。
- 内存 Store 中已实现一批任务/放置/时间点规则，现有单元测试覆盖了部分核心状态转换。
- API 路由和 OpenAPI 文档已达到较大范围，`openapi:check` 当前可通过。
- Web 页面已有登录、今日、任务、项目、日历、时间点、搜索、归档和设置等主要界面骨架。
- Dexie 本地库、outbox、pull/push、冲突记录和 Markdown 清洗器均已有初始实现。
- PWA、Electron 和 Android 的构建骨架已经存在。
- 当前桌面浏览器界面的安静、简洁视觉方向基本符合用户审美目标。
- 项目文档已经记录了不少 `NOT RUN` 项，没有必要推倒重写文档体系。

这些成果证明项目已完成“原型和基础设施搭建”的相当一部分，但不能证明产品完成。

## 3. 本次门禁结果

### 3.1 环境事实

| 项目             | 本次观测                                                          |
| ---------------- | ----------------------------------------------------------------- |
| Node.js          | `v24.18.0`                                                        |
| pnpm             | `11.18.0`                                                         |
| Java             | `21.0.12`                                                         |
| Docker / Compose | 当前环境不可用                                                    |
| PostgreSQL CLI   | 当前环境不可用                                                    |
| Android 设备     | `adb devices` 无设备                                              |
| Git              | 仓库无任何 commit，全部项目文件为 untracked，未发现可核验 CI 历史 |

### 3.2 自动化与真实运行门禁

| 门禁                                | 结果         | 审计解释                                                                                              |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`    | PASS         | 依赖可按锁文件安装                                                                                    |
| `pnpm format:check`                 | PASS         | 格式检查通过                                                                                          |
| `pnpm lint`                         | PASS         | ESLint 通过                                                                                           |
| `pnpm typecheck`                    | PASS         | 类型检查及其前置构建通过                                                                              |
| `pnpm test`                         | PASS         | 4 个测试文件、21 个测试通过；主要证明内存实现和局部逻辑                                               |
| `pnpm build`                        | PASS         | 全仓构建通过；Web 主 JS chunk 约 566.49 kB，并有体积警告                                              |
| `pnpm openapi:check`                | PASS         | 43 个路径通过静态 OpenAPI 检查                                                                        |
| `pnpm test:integration`             | PARTIAL PASS | 输出明确是 memory API smoke，不是正式 PostgreSQL 集成测试                                             |
| `pnpm test:e2e`                     | PARTIAL PASS | 4/4 通过，但 API 全部被 mock，覆盖范围仅登录、初始化、快速创建和导航                                  |
| `pnpm desktop:test`                 | PARTIAL PASS | 只是源码标记字符串检查，没有启动打包应用                                                              |
| `pnpm desktop:package`              | PARTIAL PASS | Linux 目录包可生成；Windows 本轮 `NOT RUN`                                                            |
| 新打包 Linux Electron 实际启动      | **FAIL**     | `ReferenceError: __dirname is not defined`，应用捕获错误后退出                                        |
| 构建后的 API + Web 静态资源实际启动 | **FAIL**     | Fastify 报 `FST_ERR_DUPLICATED_ROUTE`，重复声明 `GET /*`                                              |
| `pnpm android:assembleRelease`      | PARTIAL PASS | 生成 unsigned APK；本轮 SHA-256 为 `3174088586447a51e09d89d12831803f8065373e9bacb22393f7daea04bbeb53` |
| Android 真机安装与功能验收          | NOT RUN      | 没有连接设备，且当前 APK 未签名                                                                       |
| `pnpm compose:smoke`                | NOT RUN      | 无 Docker；脚本自身在跳过时仍以 0 退出，并且即使执行也只检查 Compose 配置                             |
| PostgreSQL 迁移/并发/重启验证       | NOT RUN      | 当前环境无 PostgreSQL；源码审查已确认存储架构不符合规划                                               |
| 备份与恢复演练                      | NOT RUN      | 无真实数据库/容器运行证据                                                                             |
| Windows 安装、启动和升级            | NOT RUN      | 没有本轮可信产物与实际运行证据                                                                        |
| iOS PWA 安装和离线使用              | NOT RUN      | 未在 WebKit/iPhone/iPad 上验证                                                                        |
| 无障碍、性能和容量门禁              | NOT RUN      | 未运行 axe、长任务、5 万 Task/25 万 Placement 等验收                                                  |

### 3.3 门禁结论

静态和内存门禁通过，不能抵消两个真实启动门禁的失败，也不能抵消数据库、跨客户端同步和目标设备验收缺失。当前总体状态必须记为 `FAIL`，而不是“完成但尚未验收”。

## 4. 真实需求覆盖矩阵

| 需求域                            | 当前状态                                                                | 结论              |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------- |
| Docker Compose 自托管 Hub         | 配置文件存在，但构建后 API 会因重复通配路由崩溃；未真实 `up`            | FAIL              |
| PostgreSQL 可靠持久化             | 迁移和表存在，但应用采用内存快照并在每次写入时全表清空重插              | FAIL              |
| WebUI                             | 页面骨架和主要路由存在；若以分离开发服务运行可操作，但正式 Hub 启动失败 | PARTIAL           |
| PWA / iOS                         | manifest/service worker 构建骨架存在；无 WebKit、安装、离线恢复验收     | PARTIAL / NOT RUN |
| Electron 桌面端                   | 可打包但新产物实际启动失败；缺少正常首启 Hub 配置                       | FAIL              |
| Android                           | Capacitor 工程和 unsigned APK 存在；无签名与真机验收                    | PARTIAL / NOT RUN |
| Task / Placement / TimePoint 模型 | 内存实现的核心模型基本成立                                              | PARTIAL           |
| “复制到次日”不复制 Task           | 局部领域逻辑与测试有所覆盖；未完成真实多端 E2E                          | PARTIAL           |
| 今日直接创建                      | UI 只创建 Task，不创建今日 Placement；任务立即从今日视图消失            | FAIL              |
| 项目及功能/杂项分类               | 数据/UI 骨架存在；缺少完整浏览器/真实 DB 验收                           | PARTIAL           |
| 可编辑备注                        | 基本编辑存在；冲突时没有合并编辑和删除/归档恢复                         | PARTIAL           |
| 离线优先与可靠同步                | outbox 存在，但会在重试后越过前序 mutation，丢弃冲突会留下幽灵状态      | FAIL              |
| 多客户端最终一致                  | 没有双浏览器真实 API 验收，已发现顺序与 reconciliation 缺陷             | FAIL              |
| 明确退出登录                      | 退出后刷新会根据本地 owner 标记重新打开工作区                           | FAIL              |
| 移动端导航与交互                  | 当前为“今日/任务/日历/时间点”并使用汉堡菜单、顶部小按钮                 | FAIL              |
| 安全边界                          | 密码哈希响应、WebSocket query token、可伪造原生头均未关闭               | FAIL              |
| 备份/恢复/升级                    | 文档存在，无真实执行证据                                                | NOT RUN           |

## 5. 发布阻断问题

以下每一项都必须由后续执行者修复，并按“验收标准”留下新的运行证据。不能只改 `docs/STATUS.md` 或给出方案。

### P0-01：正式 Hub/API 无法启动

**证据**

- `apps/api/src/server.ts:127-130` 注册 `@fastify/static`，默认提供通配静态路由。
- `apps/api/src/server.ts:785-786` 又注册一个 `GET /*` 作为 SPA fallback。
- 在 Web 已构建的真实路径启动 `node apps/api/dist/main.js`，Fastify 立即抛出 `FST_ERR_DUPLICATED_ROUTE: Method 'GET' already declared for route '/*'`。
- 单元测试通常没有传入存在的 `webRoot`，因此没有覆盖正式运行分支。

**影响**

Docker 镜像和正式单进程 Hub 会直接退出，WebUI、API、同步和部署全部不可用。

**必须修复**

- 静态资源和 SPA fallback 只能由一个明确的路由策略负责。
- 保证 `/api/*`、`/health*`、WebSocket 与静态资源不会被 SPA fallback 截获。
- 增加“先构建 Web，再以正式配置启动 API”的进程级测试。

**验收标准**

- 正式构建进程持续运行而不是启动后退出。
- `GET /health/live`、`GET /health/ready`、`GET /`、`GET /today` 和至少一个受保护 API 分别返回正确内容/状态。
- 未知 `/api/*` 返回 API 404，而不是 `index.html`。
- 回归测试在 CI 中真实走有 `webRoot` 的分支。

### P0-02：Electron 新打包产物无法启动

**证据**

- `apps/desktop/package.json` 使用 ESM。
- `apps/desktop/src/main.ts:20-22` 与 `:35-36` 直接使用 CommonJS 全局变量 `__dirname`。
- 本轮对新生成的 Linux unpacked 可执行文件运行约 8 秒，日志出现 `ReferenceError: __dirname is not defined`，随后应用退出。
- `desktop:test` 只搜索安全配置标记，`desktop:package` 只确认打包命令完成，因此均未捕获此问题。

**影响**

桌面端当前不存在可交付、可打开的运行产物。

**必须修复**

- 用 `fileURLToPath(import.meta.url)` 等 ESM 安全方式解析模块目录。
- 添加实际启动打包产物的 smoke，不允许通过捕获致命异常后以 0 退出来伪装成功。
- 验证 preload、renderer、图标和静态资源在打包路径下均可解析。

**验收标准**

- 新构建的 Linux 产物启动后能到达 `app.whenReady`、创建窗口并保持运行。
- smoke 在发现 fatal 日志、窗口未创建、过早退出或非零退出时失败。
- Windows 正式产物还需在真实 Windows 上完成安装、首次启动、登录、升级和卸载验收。

### P0-03：`/me` 向客户端泄露密码哈希

**证据**

- `apps/api/src/store.ts:29-34` 的内部 `UserRecord` 包含 `passwordHash` 等服务端字段。
- `apps/api/src/store.ts:191-195` 的 `getUser` 返回内部记录。
- `apps/api/src/server.ts:230-233` 把该对象直接放进 `/me` 响应。
- 本轮真实 API 注入请求确认 `user` 包含 `passwordHash`，值以 `$argon2id$` 开头，同时还暴露内部计数等字段。

**影响**

任何已登录会话均可取得账号密码哈希，扩大离线破解和凭据泄露风险；这违反最小披露和项目安全要求。

**必须修复**

- 为所有用户响应定义显式 `PublicUserDto`，使用 allowlist 映射，禁止直接序列化 Store record。
- 为响应添加 schema，并审计登录、刷新、bootstrap、日志和错误上下文是否存在同类泄漏。
- 添加负向测试，递归检查响应中不存在 `passwordHash`、refresh session secret、内部计数和其他服务端私有字段。

**验收标准**

- `/me` 只返回客户端业务必需字段。
- 自动化测试明确断言敏感字段不存在。
- 开发与正式日志抽查不包含密码哈希或令牌。

### P0-04：PostgreSQL 适配器不满足可靠持久化要求

**证据**

- `apps/api/src/postgres-store.ts:20-30` 仍以单进程内存状态和 Promise 锁作为真实状态中心。
- `apps/api/src/postgres-store.ts:55-74` 每次 mutation 先克隆全部内存状态，完成后持久化整份状态。
- `apps/api/src/postgres-store.ts:78-97` 启动时把全部表加载回内存。
- `apps/api/src/postgres-store.ts:277-283` 每次持久化都执行多表 `TRUNCATE ... RESTART IDENTITY CASCADE`。
- `apps/api/src/postgres-store.ts:284-595` 随后逐表重插全部记录。
- 文件尾部注释仍把“row-level persistence”描述为将来工作。

**影响**

- 两个 API 进程各自持有过期快照，会覆盖彼此写入并导致丢数据。
- 登录、刷新、日期视图等普通操作也可能触发全库重写。
- 数据量增长后写放大、锁表、序列重置和故障恢复风险不可接受。
- 无法达到规划中的 5 万 Task、25 万 Placement 容量目标，也不具备滚动升级或多进程扩展的正确性。
- 当前 PostgreSQL smoke 即使通过，也只能证明全量快照能落库，不能证明架构满足需求。

**必须修复**

- 把 PostgreSQL 作为权威状态，不再把完整业务状态常驻并覆盖式写回。
- 为各业务命令实现真实异步 SQL repository/application service。
- 在单个数据库事务内原子完成领域写入、版本推进、change feed 和 mutation receipt。
- 对编号分配、版本更新、幂等键使用数据库唯一约束、行锁或原子语句，不依赖进程锁。
- 读路径必须按 owner、索引、游标和分页查询，不允许启动时全量加载所有用户数据。
- 保留内存 Store 只能作为明确标注的测试替身，不得作为生产 PostgreSQL 的状态源。

**验收标准**

- mutation 不再包含全表 `TRUNCATE` 或全状态重写。
- 两个独立 API 进程并发修改同一账号时无丢失更新，幂等 mutation 只产生一次效果。
- 任意事务失败后，业务表、版本、change feed 和 receipt 同时回滚。
- API 重启后状态、版本、cursor 和 outbox 确认结果保持一致。
- PostgreSQL 集成测试使用真实数据库，不允许 fallback 到 memory。
- 完成规划中基准数据规模的读写性能测试并记录机器、数据量、p50/p95 和失败率。

## 6. 其余高优先级正确性与安全问题

### P1-01：明确退出登录后会自动重新进入工作区

**证据**

- `apps/web/src/auth.tsx:65-80` 持久保存 owner marker。
- `apps/web/src/auth.tsx:113-170` 在刷新失败时信任 marker 和本地缓存恢复用户，包括服务端明确拒绝会话的情况。
- `apps/web/src/auth.tsx:243-272` 退出时没有清除/锁定 owner marker。
- 本轮真实 Chromium + IndexedDB 验证：退出前后的 owner marker 相同；刷新后仍显示快速创建和 `/today`，登录页不显示。

**影响**

用户点击退出不能建立可靠的本地访问边界，共用设备上会重新暴露离线任务数据。

**必须修复与验收**

- 区分“网络不可达”和“服务器返回 401/会话撤销”；只有明确的离线恢复策略可以进入离线工作区。
- 退出时清理认证材料并锁定本地 owner；不能为了解决问题而静默删除尚未同步的 outbox。
- 明确 unsynced 数据的退出策略：阻止退出、加密保留并锁定、或经用户确认导出/丢弃。
- 增加在线退出、离线退出、会话被服务端撤销、刷新时断网和重新登录另一账号的浏览器测试。

### P1-02：outbox 重试会越过前序 mutation，破坏依赖顺序

**证据**

- `packages/sync-client/src/index.ts:249-275` 从“当前到期”的 mutation 中选取下一条；前序 mutation 延迟重试时，后序 mutation 可先发送。
- 定向复现：先入队 `task.create`，再入队 `task.update`；create 遇到网络错误并设置下次重试时间后，下一轮先发送 update，服务端返回 `ENTITY_NOT_FOUND`。

**影响**

创建项目后创建任务、创建 Task 后编辑/Placement 等常见离线操作会被永久拒绝或进入错误冲突状态。

**必须修复与验收**

- 对同一 owner 至少保证严格 head-of-line FIFO，或实现经过证明的依赖图调度；不能只按 `nextAttemptAt` 跳过队首。
- 覆盖 project→task→date→placement、task create→edit、请求已到服务端但响应丢失、应用重启后继续同步等序列。
- 只有明确独立且协议允许重排的 mutation 才能并行。

### P1-03：丢弃被拒 mutation 后保留幽灵乐观数据

**证据**

- `packages/sync-client/src/index.ts:244-247` 的 discard 仅删除 outbox 条目。
- `applyChanges` 在实体仍被标记 pending 时跳过服务端 change，却可能继续推进 cursor。
- 本轮定向复现：丢弃后 outbox 已为 0，但本地 task 仍存在且 `pendingSync=true`。

**影响**

UI 显示服务端从未接受且以后也不会自动修复的数据；客户端状态与服务端永久分叉。

**必须修复与验收**

- 为乐观变更保存可验证 before-image/补偿动作，或在丢弃时进行不破坏其他 pending mutation 的完整 reconciliation。
- 丢弃后清除对应 pending 标记，并恢复服务端权威状态。
- 覆盖多个 mutation 叠加、相邻实体依赖、删除/归档以及 pull cursor 已推进的情况。

### P1-04：“今日”行内创建没有创建今日 Placement

**证据**

- `apps/web/src/App.tsx:627-648` 的 `QuickCapture` 只调用 create Task。
- `apps/web/src/App.tsx:1241-1248` 的今日列表只显示当日 Placement。
- `apps/web/src/App.tsx:1357` 在今日页复用相同 QuickCapture，没有追加 Placement。
- 本轮真实 Chromium + Memory API 操作后，新任务能在任务库找到，但今日列表找不到。

**影响**

用户在“今日”输入任务后任务立即消失，直接破坏最核心的每日工作流。

**必须修复与验收**

- 今日行内创建必须创建一个 Task 和指向今日的 Placement；二者需具备离线依赖顺序和失败恢复。
- 今日页提供“从任务库加入”的直接入口，加入只创建 Placement，不复制 Task。
- E2E 断言：创建后立即显示、刷新后仍显示、另一个客户端同步后显示；完成状态在所有 Placement 一致。

### P1-05：移动端信息架构和交互不符合原始需求

**证据**

- `apps/web/src/App.tsx:141-147`、`:236-247` 当前底栏是“今日 / 任务 / 日历 / 时间点”。
- `apps/web/src/App.tsx:152-196` 与 `apps/web/src/styles.css:1847-1901` 在移动端仍使用汉堡菜单和抽屉侧栏。
- 快速创建是顶部约 34×34 的按钮，不是右下角 FAB。
- 未发现长按手势；行操作主要通过普通点击菜单。
- 本轮移动视口截图确认上述实际呈现。

**影响**

这不是用户要求的移动端产品结构，且部分触控目标小于 44×44。

**必须修复与验收**

- 底栏精确实现“今日 / 项目 / 时间 / 更多”。
- “时间”承载日期/日历和 TimePoint 的移动聚合入口；“更多”承载任务库、搜索、归档、设置等次级功能。
- 加入固定右下角 FAB，并用适合移动端的 action sheet/bottom sheet 选择创建类型。
- 任务行提供可发现的点击操作和经过无障碍设计的长按/底部菜单；不能让长按成为唯一入口。
- 所有主要触控目标至少 44×44 CSS px，并在窄屏、键盘弹出、安全区域下验证。
- 在真实 Android 设备和 iOS Safari/PWA 上完成导航、创建、编辑、离线和恢复验收。

### P1-06：备注冲突缺少“合并”和删除/归档恢复流程

**证据**

- `apps/web/src/App.tsx:3167-3233` 与 `:3564-3595` 的冲突 UI 只提供接受服务器版或保留本地版。
- `packages/sync-client/src/index.ts:193-232` 的冲突解决接口只接受 `server | local`。
- 没有可编辑合并内容，也没有对服务端已删除/归档实体执行“恢复后应用”或明确丢弃的流程。

**影响**

两端同时编辑备注时只能整份覆盖，容易丢失开发记录；墓碑实体上的本地修改无法安全处理。

**必须修复与验收**

- 冲突 UI 同时展示 server/local 内容并提供可编辑 merged 内容。
- 保存 merged 结果必须产生带当前 base version 的新 mutation，而不是直接篡改本地数据库。
- 对 archived/deleted 实体明确提供恢复再应用或丢弃本地修改的语义。
- 以两个独立浏览器上下文覆盖备注冲突、删除冲突、归档冲突、离线重连和再次冲突。

### P1-07：WebSocket 把 access token 放在 URL query

**证据**

- `apps/web/src/api.ts:374-378` 把 access token 拼入 WebSocket URL。
- `apps/api/src/server.ts:766-770` 从 query 读取 token。
- `apps/api/src/server.ts:93-96` 开启 Fastify logger；浏览器历史、代理、网关和错误日志也可能记录完整 URL。

**影响**

令牌可能进入日志、监控、代理和诊断信息，违反项目“不在日志中出现 token”的要求。

**必须修复与验收**

- 改为短时一次性 WebSocket ticket、连接后首消息认证或其他不会把长期 access token 放入 URL 的协议。
- 对 HTTP/WebSocket 日志启用明确 redaction。
- 自动化检查客户端构造的 URL、服务端访问日志和代理样例中不存在 token。

### P1-08：可伪造的客户端头可以把 HttpOnly refresh token 取回 JSON

**证据**

- `apps/api/src/server.ts:1039-1042` 仅依据 `X-Client-Platform` 判断 native client。
- 登录/刷新路径在该头声明 Electron/Capacitor 时返回 refresh token JSON。
- 本轮验证：普通 Web 登录不返回 refresh token；同一浏览器带 HttpOnly cookie 调刷新接口并附加 `X-Client-Platform: electron` 后，响应返回长期 refresh token。

**影响**

浏览器脚本可伪装原生端，绕过 HttpOnly 的主要保护。若出现同源 XSS，攻击者可以直接导出长期刷新凭据。

**必须修复与验收**

- 不能再把可由任意 HTTP 客户端设置的 header 当作可信原生身份。
- 设计独立的原生凭据交换通道，并绑定受控 origin/自定义协议、一次性挑战或设备密钥；浏览器同源请求必须无法取得 JSON refresh token。
- Electron renderer 不能直接持有长期凭据；由 main/preload 的窄 IPC 能力管理安全存储和刷新。
- 添加恶意浏览器 header、跨源请求、同源 XSS 假设下的负向测试。

此项安全协议选择需要方案复核，但“继续信任请求头”不是可接受选项。

### P1-09：Electron 缺少普通用户可用的 Hub 配置和生命周期能力

**证据**

- `apps/desktop/src/main.ts:14-16`、`:57-62` 要求通过进程环境变量 `DEVTODO_APP_ORIGIN` 提供 Hub 地址。
- 登录页的 Hub 地址 UI 只在 native mobile 条件下展示；打包后的普通 Electron 用户无法完成首次配置。
- 未实现单实例锁、窗口状态恢复和明确的托盘/退出流程；关闭全部窗口后当前逻辑可能保留不可见进程。

**影响**

即使修复 `__dirname`，双击安装应用的用户仍无法可靠连接自己的 Hub，也无法获得规划要求的桌面生命周期体验。

**必须修复与验收**

- 添加首次启动 Hub 配置、连接测试、持久化和后续修改入口。
- 正式模式默认要求 HTTPS；开发模式例外必须清晰隔离。
- 验证自定义协议 origin 与 CORS，不能只允许 `https://` 而让 `devtodo://app` 无法访问 Hub。
- 实现单实例、窗口状态恢复和一致的关闭/退出行为。
- 在打包产物中覆盖首次配置、错误证书、离线启动、重新连接和升级后配置保留。

## 7. 中优先级工程与运维缺口

### P2-01：迁移执行器只硬编码 `0001_init.sql`

`packages/database/src/index.ts:14-50` 只认识一个固定迁移，ready 检查也只验证该版本。后续 schema 演进没有按序发现、不可变校验、失败恢复或 drift 检测。

必须实现：按版本排序的迁移发现、已应用记录、checksum/不可变保护、事务语义、从旧版本升级测试和新库全量测试。

### P2-02：mutation receipt retention 配置未真正生效

`apps/api/src/store.ts:1232-1260` 保存 expiry，但没有清理或在读取时忽略过期 receipt；`.env.example` 中的 `MUTATION_RECEIPT_RETENTION_DAYS` 也没有完整接入 Store 配置。

必须实现：过期读取语义、批量清理策略、指标/日志和重启后的幂等边界测试。清理不能破坏仍在客户端最大离线窗口内的幂等保证。

### P2-03：现有测试门禁会把跳过或静态检查伪装成成功

- `scripts/compose-smoke.ts` 无 Docker 时以 0 退出；有 Docker 时也只运行 `docker compose config --quiet`。
- `scripts/desktop-security-smoke.ts` 只做源码字符串检查。
- `scripts/desktop-package.ts` 不启动产物，Windows 未执行也不使正式交付门禁失败。
- Playwright 只配置 Chromium 桌面和 Chromium 移动视口，没有 Firefox/WebKit。
- E2E 全部 mock API，没有覆盖正式服务、IndexedDB、WebSocket 或双客户端同步。

必须把脚本区分为 `PASS / FAIL / NOT RUN`，正式 release gate 遇到目标平台 `NOT RUN` 时必须阻止“发布完成”声明。

### P2-04：Compose 镜像和恢复链未形成可复现发布基线

当前镜像使用普通 tag，未锁定 digest；没有本轮真实 build/up、健康检查、数据写入、进程重启、PostgreSQL 重启、备份、清空和恢复证据。

必须锁定支持的 PostgreSQL 18 patch 和镜像 digest，并在干净环境完整演练。不要仅运行 `docker compose config`。

### P2-05：当前仓库没有版本历史或可核验 CI

Git 显示 `No commits yet on master`，所有项目文件均为 untracked。即使 `.github/workflows/ci.yml` 存在，也没有 commit、远端或运行回执能够证明 CI 曾执行。

在不覆盖用户工作且确认版本边界后，建立可审查提交历史；正式交付应记录 commit SHA、构建环境、产物哈希和 CI run。任何旧的 ignored release 文件都不能作为本轮可信产物。

### P2-06：性能、容量与无障碍完全未验证

Web 构建已提示主 chunk 约 566.49 kB，但没有加载性能证据；规划中的 5 万 Task/25 万 Placement 数据规模、同步积压、低端 Android、键盘操作、焦点管理和 axe 扫描均未运行。

必须先建立可重复数据集和预算，再优化并保存可比较报告。不能以开发机“看起来流畅”替代结果。

## 8. 建议续做顺序

后续执行者应按依赖顺序完成，避免先做视觉润色后再次推翻底层。

### 阶段 A：关闭立即安全与启动阻断

1. 修复 `/me` 及所有响应的敏感字段泄漏，建立 DTO allowlist 和负向测试。
2. 修复 WebSocket query token；完成原生 refresh token 通道方案复核并实施。
3. 修复 Fastify 静态路由冲突，加入正式构建进程级 smoke。
4. 修复 Electron ESM 路径和真实启动 smoke。
5. 完成 Electron 首次 Hub 配置、CORS/协议、单实例和退出生命周期。

阶段 A 完成条件：正式 Hub 能持续启动，浏览器可加载 SPA/API；打包 Electron 能打开并配置 Hub；敏感数据/URL/日志中无密码哈希或长期令牌。

### 阶段 B：把 PostgreSQL 改为权威存储

1. 固化 repository/application service 边界和异步事务接口。
2. 逐个迁移认证、项目、Task、Note、DateBucket、TimePoint、Placement、change feed 和 receipt 写路径。
3. 实现数据库约束、owner 隔离、乐观版本、行锁/原子计数和分页读。
4. 删除生产路径的全状态 load/clone/TRUNCATE/reinsert。
5. 建立真实 PostgreSQL 单进程、双进程、故障回滚、重启和容量测试。

阶段 B 完成条件：数据库是唯一权威状态；两进程并发无丢失更新；核心 mutation 的领域写、版本、change 与 receipt 同事务；达到规划容量基线。

### 阶段 C：修复离线同步和认证状态机

1. 解决 outbox FIFO/依赖排序。
2. 为 reject/discard 实现 rollback 或 reconciliation。
3. 修复 logout、401、离线恢复和账号切换边界。
4. 完成重连、WebSocket 提示后 pull、cursor 过期与 full resync。
5. 使用两个真实浏览器上下文和真实 API/PostgreSQL 运行规划中的同步矩阵。

阶段 C 完成条件：离线创建/编辑/放置不乱序；响应丢失后幂等恢复；丢弃后无幽灵数据；退出不会自动重开；双客户端最终一致。

### 阶段 D：完成核心用户工作流与移动端重构

1. 修复今日创建 Task + 今日 Placement，并加入任务库选择器。
2. 验证同一 Task 多 Placement 和全局完成语义。
3. 完成项目“功能/杂项”、备注编辑、搜索、归档和 TimePoint 全生命周期 E2E。
4. 实现可编辑备注 merge 和 deleted/archived recovery。
5. 按原始需求重构移动底栏、时间聚合页、更多页、FAB、bottom sheet 和触摸目标。

阶段 D 完成条件：所有核心工作流在桌面浏览器和移动视口通过真实 API E2E；冲突不静默丢内容；移动端结构与用户确认的四入口一致。

### 阶段 E：部署、恢复和平台交付

1. 完成通用迁移执行器和升级测试。
2. 锁定 Compose 镜像，真实 build/up 并验证 bootstrap、读写、重启和健康检查。
3. 做带校验值的 PostgreSQL 备份，清空目标后恢复，并核对账号、Task、Placement、版本和 change cursor。
4. 建立 HTTPS 反代、安全 header、日志 redaction、速率限制和密钥轮换证据。
5. Windows 安装/升级/卸载；Android 签名/真机；iOS PWA/WebKit 安装与离线验收。
6. 完成无障碍、性能、容量和长时间同步测试。

阶段 E 完成条件：所有目标环境门禁具有可复现命令、日期、环境、commit、产物哈希和结果；无法执行的门禁保持 `NOT RUN`，不得宣称正式发布。

## 9. 必须新增或扩展的自动化验收

### 9.1 API 与安全

- 正式 webRoot 下进程启动和 SPA/API 路由分流。
- 所有公开 user DTO 的敏感字段负向测试。
- owner A 无法读取/猜测/修改 owner B 的所有资源。
- access/refresh token 不出现在 URL、日志、错误体或普通浏览器 JSON。
- refresh rotation、重放、撤销、过期、登出和密码变更场景。

### 9.2 PostgreSQL

- 干净库迁移、旧版本升级、重复执行和迁移 checksum 变化失败。
- 两个独立 API 进程并发写同一账号。
- transaction 中途注入失败，验证无部分业务行/change/receipt。
- 相同 mutation ID 重试只生效一次。
- 5 万 Task、25 万 Placement 下的列表、搜索、pull、写入和启动时间。

### 9.3 同步

- project create→task create→date ensure→placement create 严格顺序。
- task create→多次 edit；首次请求成功但客户端丢失响应。
- 一个客户端离线、两个客户端并发编辑、冲突合并、删除和归档恢复。
- cursor 过期后 full resync，同时保留合法 pending outbox。
- discard rejected mutation 后本地状态与服务端一致。
- 应用/浏览器/Hub/PostgreSQL 分别重启后的续传。

### 9.4 Web 与移动

- 今日行内创建与从任务库加入。
- 一个 Task 在多个日期/TimePoint 中显示并共享完成状态。
- 项目、功能/杂项、备注、搜索、归档、恢复和 TimePoint 生命周期。
- 真实 API 的桌面 Chromium、Firefox、WebKit；两个浏览器 context 的同步。
- 移动底栏四入口、FAB、安全区、软键盘、44×44 触控目标和屏幕阅读器标签。

### 9.5 桌面与设备

- Electron 打包产物真实启动、窗口创建、preload 能力边界、首启 Hub 配置和离线重开。
- Windows 安装、快捷方式、单实例、窗口恢复、自动更新策略和卸载。
- Android signed APK/AAB 真机安装、冷启动、后台恢复、离线编辑、网络切换和系统返回键。
- iOS Safari 添加到主屏幕、standalone、离线启动、升级 service worker 和数据恢复。

## 10. 正式完成门禁

修复后至少需要重新执行并记录以下门禁。命令存在不代表门禁充分；需要按上文补齐测试内容。

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm openapi:check
pnpm build
pnpm test:e2e
pnpm compose:smoke
pnpm desktop:test
pnpm desktop:package
pnpm android:assembleRelease
```

还必须有当前脚本尚不能代替的真实验收：

- 正式 API/Web 进程启动 smoke；
- Docker Compose build/up、健康、真实 PostgreSQL、重启；
- 备份→清空→恢复→业务不变量核对；
- 双浏览器、真实 API、真实 PostgreSQL 离线/重连/冲突矩阵；
- 新打包 Electron 进程启动及 GUI 工作流；
- 真实 Windows、Android 和 iOS/PWA 验收；
- axe、键盘、屏幕阅读器抽查、容量和性能报告。

每个门禁只能报告：

- `PASS`：本轮在声明环境真实执行并满足断言，附命令/版本/结果；
- `FAIL`：已执行但未满足，必须保留错误证据；
- `NOT RUN`：环境或授权不足，不能用构建、模拟器、静态检查或旧产物替代。

## 11. 需要用户或方案负责人明确的事项

只有以下事项可能需要额外决策；其余问题均可由后续执行者直接修复，不应以“等待确认”为由停工：

1. **退出登录时尚有未同步数据**：选择“阻止并提示同步/导出”“本地加密锁定并允许退出”或“二次确认后丢弃”。默认不得静默丢数据，也不得退出后自动打开。
2. **原生 refresh token 安全通道**：需确认 Electron/Capacitor 的可信 origin、main-process 安全存储和设备绑定方案。默认不得继续信任 `X-Client-Platform`。
3. **正式签名材料和设备权限**：Windows 代码签名、Android keystore、Apple/iOS 设备需要用户提供或授权；在此之前保持 `NOT RUN`。
4. **正式域名、TLS 和反代环境**：可先在本地完成容器和自签/测试证书验收，最终公网域名验收需用户提供目标环境。

## 12. 交给下一位 AI 的执行指令

1. 先完整阅读原始对话、`DEVELOPMENT_PLAN.md` 和本文件，不要只阅读 README/STATUS。
2. 先复现对应问题，再修改代码；每个问题都要补自动化回归测试。
3. 按阶段 A→B→C→D→E 推进；若一次对话无法全部完成，必须留下代码可运行的中间状态和更新后的精确门禁表。
4. 不得以 ADR 降低用户需求；若必须改变产品/安全协议，只把确实需要决策的内容写入方案复核区。
5. 不得通过删除测试、放宽断言、把错误 catch 后以 0 退出、或把 `NOT RUN` 计作 `PASS` 来关闭问题。
6. 不得只修改状态文档。修复必须落到真实调用链，并由测试和运行证据共同证明。
7. 保留用户当前工作，不要 reset/clean/checkout 或覆盖无关文件。当前仓库尚无提交，建立提交前先核对全部文件归属。
8. 正式交付时给出 commit SHA、依赖/工具版本、构建命令、目标平台、产物路径和 SHA-256。

## 13. 可宣称“开发完成”的最终条件

只有同时满足以下条件，才可把总体状态从 `FAIL` 改为 `PASS`：

- P0 和 P1 问题全部由代码修复并有回归测试；没有通过文档降级关闭。
- Hub 在 Docker Compose 中以真实 PostgreSQL 持续运行，数据跨重启保留，多进程并发无丢失更新。
- Task/Placement/TimePoint、项目分类、备注、今日、搜索、归档和冲突工作流全部通过真实 API E2E。
- 离线 mutation 严格可靠、幂等、可恢复，两个客户端最终一致。
- 明确退出、本地缓存和令牌行为符合安全边界；响应和日志没有敏感数据。
- Web/PWA、Electron、Android 均有目标环境运行证据；Windows、Android、iOS 未执行时不得宣称对应平台完成。
- 移动端实现“今日 / 项目 / 时间 / 更多”底栏、FAB 和合格触控交互。
- 迁移、备份、清空恢复和升级路径均完成真实演练。
- 无障碍、性能和规划容量门禁通过。
- `docs/STATUS.md`、`docs/TEST_REPORT.md` 与真实门禁一致，所有剩余 `NOT RUN` 都明确阻止相应范围的发布声明。

在上述条件达成前，正确的项目状态是：**基础原型已建立，但正式开发未完成，发布被阻断。**
