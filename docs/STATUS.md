# DevTodo 实施状态

更新时间：2026-09-08

总体发布状态：**FAIL**。当前源码、构建、用户态 PostgreSQL、独立 dump/restore、基础真实 API cross-context E2E 和可用环境中的自动化门禁已通过；Docker Compose build/up/重启链、Electron GUI、Windows、Android 真机、iOS/WebKit，以及双客户端长期离线、冲突和响应丢失恢复验收仍为 `NOT RUN`，因此不能宣称正式发布完成。最新统一 release gate 的 `format` 已为 `PASS`；未运行的目标环境门禁仍然阻断正式发布。

## 阶段

| 阶段                    | 状态                                                                           | 当前证据与边界                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 工程基线             | PASS                                                                           | pnpm workspace、Node 24、strict TypeScript、ESLint、Prettier、Vitest、Playwright、四个 app 入口和 CI 配置已落盘；`pnpm build` 通过。                                                                                                                                                                                                             |
| M1 领域/数据库/认证/API | PASS（代码+单测+服务 smoke+真实 PG）                                           | Task/Note/TimePoint/Placement/Project、Owner 限定、版本冲突、幂等、认证轮换、SQL repository、迁移和 OpenAPI 已实现；6 个 test files / 44 项单测、正式构建 API smoke 和 44 条 OpenAPI 路由通过；真实 PostgreSQL migration、约束、owner isolation、并发、幂等、事务回滚、重启和多 Placement integration 通过。                                     |
| M2 Web 核心工作流       | PASS（构建+浏览器核心 smoke+基础真实 API）/NOT RUN（真实 API 完整矩阵/WebKit） | 今日、任务、项目、全局杂项、归档、设置、详情、Markdown、搜索、命令面板和响应式 shell 已实现；本轮 release gate 的 Chromium、Firefox、移动 Chromium 共 12 项通过；显式真实 API E2E 的内存后端 Chromium/mobile 8/8、Firefox 4/4，临时 PostgreSQL `devtodo_e2e_20260907` 后端 Chromium/mobile 8/8；WebKit 和真实 API 离线/冲突/响应丢失矩阵未运行。 |
| M3 时间点/Placement     | PASS（代码+单测+核心浏览器 smoke）/NOT RUN（真实多端验收）                     | DATE/EVENT、到达/归档、加入/复制/移动/移除/排序、rollover/undo、同一 Task 多 Placement 已实现；桌面拖拽、键盘动作和移动端 Bottom Sheet 代码路径已提供，设备触摸验收未运行。                                                                                                                                                                      |
| M4 离线同步/PWA         | PASS（代码+单测+构建）/NOT RUN（双端真实网络切换）                             | Dexie、原子 outbox、严格 FIFO、push/pull、游标过期快照、冲突合并/恢复、失败重试/退避和 WebSocket 失效通知已实现；基础真实 API cross-context 读取已通过，但真实双浏览器 API 离线恢复、响应丢失、冲突矩阵和 iOS WebKit 未运行。                                                                                                                    |
| M5 Electron             | PASS（Linux 目录包+静态安全 smoke）/NOT RUN（GUI/Windows）                     | ESM 路径、Hub 配置 IPC、凭据边界、单实例、窗口状态和导航 allowlist 已实现；Linux x64 目录包及校验和生成，静态安全 smoke 通过；GUI launch 因 `chrome-sandbox` 不是 root-owned `4755` 而未运行，不能通过 `--no-sandbox` 绕过；Windows NSIS 安装/升级/卸载需要 Windows runner 或 Wine。                                                             |
| M6 Capacitor Android    | PASS（release 构建）/NOT RUN（真机）                                           | Capacitor Android 工程、HTTPS/混合内容限制、Secure Storage、生命周期/网络/返回键适配已实现；已签名 release APK 已构建并通过 apksigner、aapt2 包信息检查；无连接的 adb 设备，真机安装、离线恢复和长按交互未运行。                                                                                                                                 |
| M7 生产化/文档          | PASS（静态配置+文档+PG migration/独立备份恢复/容量）/NOT RUN（Docker Compose） | Compose、Caddy、Dockerfile、migration job、健康检查、备份恢复和安全文档已提供；PostgreSQL migration、独立 `pg_dump -Fc`/`pg_restore` 和隔离库容量门禁已通过，恢复计数为 `users=1/tasks=3/placements=3/notes=3/schema_migrations=4`，当前无 Docker，Compose build/up、真实 HTTPS、重启和容器卷恢复仍未运行。                                      |

## 已执行门禁

```text
pnpm install --frozen-lockfile PASS
pnpm format:check          PASS
pnpm lint                  PASS
pnpm typecheck             PASS（包含各包 build 与 noEmit typecheck）
pnpm test -- --reporter=dot PASS（6 files / 44 tests）
DATABASE_URL=... pnpm test:integration PASS（真实 PostgreSQL 18）
pnpm build                 PASS
pnpm server:smoke          PASS（正式构建 API 进程、SPA fallback、API 404、/me 脱敏）
pnpm openapi:check         PASS（44 paths）
pnpm test:e2e              PARTIAL（默认 mock/core：Chromium/Firefox/mobile 9 passed；3 项真实 API skipped；完整 WebKit NOT RUN）
E2E_REAL=1 ... pnpm test:e2e PASS（内存 Chromium/mobile 8/8、Firefox 4/4；临时 PostgreSQL `devtodo_e2e_20260907` Chromium/mobile 8/8）
pnpm a11y                  PASS（Chromium axe：1 suite）
pnpm desktop:test          PASS
pnpm desktop:package       PASS（Linux dir/package）；NOT RUN（真实 Electron launch、Windows NSIS）
pnpm android:assembleRelease PASS（已签名 APK，SHA-256 见下）
DATABASE_URL=... pnpm db:migrate PASS（真实 PostgreSQL 18）
独立 pg_dump -Fc / pg_restore PASS（MISC-1；备注 version=2；恢复计数见上）
pnpm compose:smoke         NOT RUN（当前环境无 Docker）
DATABASE_URL=... pnpm perf:capacity PASS（50k Task / 5k TimePoint / 250k Placement；隔离临时库，已清理）
pnpm release:gate          FAIL（2026-09-08：`format`、lint、typecheck、unit、OpenAPI、integration、capacity、build、built-server-process、a11y、desktop security、Android release 均 PASS；`browser-e2e`、Compose restart/backup、desktop-package-and-launch 为 NOT RUN，阻断正式发布）
```

## 产物

- Electron Linux x64 目录包：`apps/desktop/release/linux-unpacked/`；可执行文件 SHA-256：`1ddc392c64e401f3e8e3682a12af14da5b23c8ff91349d33eea4642ef620f982`。
- Android release：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`；本地验证 SHA-256：`b480d30c3e005ca877096d020dd4f6111f96bb448672ce81b813fe971006817a`。
- APK 本地检查：包名 `com.devtodo.app`、min SDK 24、target/compile SDK 36、`allowBackup=false`、`usesCleartextTraffic=false`，且包含当前 Web 资源；已通过 APK Signature Scheme v2 签名验证，可以作为安装包分发。

## 当前实现边界

- PostgreSQL 是生产路径的权威状态源。`PostgresStore` 通过 owner-scoped SQL 读取，使用行级更新、数据库约束/锁和事务内的领域写入、版本递增、change feed 与 mutation receipt；不再启动时全量载入或通过 `TRUNCATE` 重写业务表。真实 PostgreSQL integration、migration、多进程并发和 50k/250k 容量门禁已通过；Compose/备份恢复仍未运行，详见 [ADR 0001](adr/0001-store-persistence.md)。
- Electron 使用 electron-builder；桌面安排使用原生 HTML5 拖拽，同时提供键盘上移/下移和明确菜单；移动端使用 Bottom Sheet 等价路径。取舍记录于 [ADR 0002](adr/0002-client-packaging-and-placement-interactions.md)。
- 当前 E2E 是核心 smoke，不是完整第 9.7/15 节实机验收。本轮 release gate 的 Chromium/Firefox/mobile 共 12 项通过，WebKit 因当前用户态依赖环境无法被 Playwright 正常启动以 exit 2 标记 `NOT RUN`；显式 `E2E_REAL=1` 的内存后端 Chromium/mobile 为 8/8、Firefox 为 4/4，临时 PostgreSQL `devtodo_e2e_20260907` 后端 Chromium/mobile 为 8/8。基础 cross-context 读取已通过，但真实 API/PG 双客户端长期离线、冲突、响应丢失恢复，桌面 GUI、Windows、Android 真机、iOS PWA/WebKit 和长时间稳定性仍未完成；容量 p95 门禁已通过。`scripts/e2e-real-server.ts` 已修复 shutdown 等待、幂等清理和提前 fixture 清理；Linux Electron 目录包与静态安全 smoke 为 PASS，GUI launch 因 `chrome-sandbox` 不是 root-owned `4755` 而为 `NOT RUN`。release gate 使用的 `devtodo_release_20260908_205701_17223` 结束后核对为 `users=0/tasks=0/time_points=0/placements=0/notes=0/schema_migrations=4`，测试 Owner 已清理。
