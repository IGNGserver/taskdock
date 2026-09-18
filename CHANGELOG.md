# Changelog

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
