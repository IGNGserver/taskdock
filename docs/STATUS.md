# DevTodo 实施状态

更新时间：2026-09-18

总体发布状态：**FAIL（v2 完成定义未满足，但阻断项已全部关闭）**。本轮已关闭全部已知 P0/P1 源码缺陷，并补齐归档中心、v2 rollover、V2 restore 策略、离线删除 fail-closed、Folder-first 迁移分层、Android 同步恢复等此前遗留项。所有本地门禁、真实 PostgreSQL migration/integration/runtime 门禁与三浏览器 E2E 均为 PASS。

仍未运行、因而继续阻断正式发布的门禁只有环境类项：WebKit、Android 真机/仪器、Electron GUI、Docker Compose 与长期双端离线矩阵。这些是环境缺失，不是已知实现缺陷。

## TaskDock v2 当前状态（2026-09-18，未发布）

v2 代码已落地到 contracts/domain、PostgreSQL migrations/adapter、Fastify `/api/v2`、Dexie、Android Room/Compose、React Web 目录树与流程/归档页面。

本轮验证命令与结果：

```text
pnpm format:check                                                 PASS
pnpm lint                                                         PASS（0 warning）
pnpm typecheck                                                    PASS（workspace build + Web build + noEmit）
pnpm test                                                         PASS（15 files / 131 tests）
pnpm openapi:check                                                PASS（99 paths）
pnpm desktop:test                                                 PASS（Electron 静态安全）
pnpm test:e2e --projects=chromium,mobile,firefox                   PASS（21 passed / 3 skipped 真实后端按设计跳过）
./gradlew :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin PASS
DATABASE_URL=... pnpm db:migrate（连续两次）                        PASS（幂等）
DATABASE_URL=... pnpm test:integration                             PASS（含 v2 PostgresTreeStore 与 Folder-first 断言）
DATABASE_URL=... PG_CTL=... pnpm test:pg-runtime                    PASS（真实 /api/v2 + v2 WebSocket + PG 重启恢复）
```

未运行门禁（环境缺失，非实现缺陷）：

```text
WebKit E2E                                                         NOT RUN（当前 Linux 缺少 WebKit 图形依赖）
Android 真机 / 仪器测试                                             NOT RUN（无 adb 设备/AVD）
Electron GUI 启动验收                                               NOT RUN（chrome-sandbox 非 root-owned 4755，不用 --no-sandbox 绕过）
Docker Compose build/up/重启/卷恢复                                 NOT RUN（当前环境无 Docker）
长期双端离线/冲突/响应丢失矩阵                                       NOT RUN
```

线上只读检查（`http://47.95.17.77:48731`）仍返回 `syncProtocolVersion: 1` 且 `/api/v2/sync/snapshot` 为 404，说明**线上尚未部署本轮 v2 服务**。源码 PASS 不等于线上同步已完成。

## 本轮关闭的缺陷

| 范围                                    | 结果   | 证据                                                                                                                                                        |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 归档中心按顶层归档操作分组              | 已实现 | `GET /api/v2/archive-operations`、`/archive-operations/{id}`；`apps/api/src/tree-store.ts` `listArchiveOperations`/`getArchiveOperation`；Web `ArchivePage` |
| 无 `archivedByOperationId` 的恢复 400   | 已修复 | Web 侧禁用该入口并给出说明，不再发送 `{}`                                                                                                                   |
| 离线删除 fail-closed 不可达             | 已修复 | `local.ts` 为 `delete-preview` 增加 `OFFLINE_TREE_DELETE_FORBIDDEN`；`apps/web/test/offline-tree-delete.test.ts` 2 tests                                    |
| V2 `resolveConflict('restore')` 缺失    | 已实现 | `packages/sync-client/src/index.ts` `resolveArchivedConflictV2`；回归测试断言 restore→retry 顺序与 baseVersion                                              |
| V2 `applyChanges` 无旧版本守卫          | 已修复 | 版本守卫 + `v2-migration.test.ts` 陈旧 change 回归测试（去掉守卫即失败）                                                                                    |
| v1 rollover 不写 v2 change feed         | 已修复 | 新增 `rollover.create`/`rollover.undo` v2 命令与路由；离线 fail-closed                                                                                      |
| 类型化升级队列返回值被丢弃              | 已修复 | `readUpgradePending` + syncMeta 持久化 + 设置页展示/导出                                                                                                    |
| Dexie 遗留 `projects` 陈旧行            | 已修复 | `applySnapshot` 清理该表；回归测试断言快照后计数为 0                                                                                                        |
| Android `SYNC_CURSOR_EXPIRED` 无恢复    | 已修复 | 新增 `ApiFailureCategory.CURSOR_EXPIRED`，触发重新 snapshot                                                                                                 |
| Android workflow 删除伪造空桩行         | 已修复 | 改为 tombstone 真实行；新增按 id 的 DAO 查询                                                                                                                |
| Android `pendingSync` 单向标志          | 已修复 | 新增 9 个 `markSynced` DAO，推送 applied 后清除                                                                                                             |
| Room schema 未入库 / androidTest 未接线 | 已修复 | `schemas/` 已 `git add`；`build.gradle` 增加 `androidTest.assets.srcDirs`；迁移测试覆盖到 v6                                                                |
| "最近有效目录"契约                      | 已修复 | 新增 `folder-preference.ts`，记录并解析最近目录、遵循 `defaultCaptureTarget`；日期/事件页传入目标目录；7 tests                                              |
| Folder-first 初始排序未实现             | 已修复 | 新增 `0009_v2_folder_first_rank.sql`；真实 PG 验证 Folder 排在同状态 Task 之前                                                                              |
| 移动端 FAB 遮挡最后一行                 | 已修复 | 移动端 `.page` 底部留白提升至 160px（含 native shell `!important` 规则）                                                                                    |
| 后台刷新替换可交互内容                  | 已修复 | `useReloadable` 增加 `initialLoading`，归档页仅在首次加载显示骨架屏                                                                                         |

## 历史 v1 阶段快照（保留参考）

| 阶段                    | 状态                                                       | 边界                                                              |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| M0 工程基线             | PASS                                                       | pnpm workspace、Node 24、strict TS、ESLint、Prettier、Vitest、CI  |
| M1 领域/数据库/认证/API | PASS（含真实 PG）                                          | Task/Note/TimePoint/Placement、Owner 限定、幂等、迁移、OpenAPI    |
| M2 Web 核心工作流       | PASS（构建 + 三浏览器 E2E）/NOT RUN（WebKit）              | 今日、目录、任务、归档、设置、详情、搜索、命令面板                |
| M3 时间点/Placement     | PASS（代码+单测+核心浏览器 smoke）/NOT RUN（真实多端）     | DATE/EVENT、到达/归档、复制/移动/移除/排序、rollover/undo         |
| M4 离线同步/PWA         | PASS（代码+单测+构建）/NOT RUN（双端真实网络切换）         | Dexie、原子 outbox、push/pull、冲突合并、退避重连、v2 协议        |
| M5 Electron             | PASS（Linux 目录包+静态安全）/NOT RUN（GUI/Windows）       | Hub IPC、凭据边界、单实例、导航 allowlist                         |
| M6 Android              | PASS（编译+JVM 单测+instrumentation 编译）/NOT RUN（真机） | Room v6 迁移链、Compose 目录/流程/归档、Keystore token 迁移       |
| M7 生产化/文档          | PASS（静态配置+文档+PG migration/容量）/NOT RUN（Docker）  | Compose、Caddy、Dockerfile、migration job、健康检查、备份恢复文档 |

## 当前实现边界

- PostgreSQL 是生产路径的权威状态源。`PostgresTreeStore` 使用 owner 级 `pg_advisory_xact_lock`、数据库持久化 cursor/change/receipt、跨进程 `LISTEN/NOTIFY`，删除预览令牌为 HMAC 无状态签名（跨进程与重启可用）。
- 删除预览与执行之间内容或版本变化时返回 `SUBTREE_CHANGED`；离线整树删除与离线 rollover 均 fail-closed。
- 遗留 `projects` 表仍存在于 Dexie schema（v1 SyncEngine 类仍引用它），但 v2 快照会清空其数据；v1 产品写入在服务端已全部返回 `CLIENT_UPGRADE_REQUIRED`，仅保留 auth/bootstrap/device 兼容面。
- 真实 Electron GUI、Windows NSIS、Android 真机、iOS WebKit、Docker Compose 和长期离线矩阵仍未运行，不构成"已通过"。
