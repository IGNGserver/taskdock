# 测试报告

更新时间：2026-09-18

总体结论：**PASS（本轮全部已运行的自动化门禁通过）/ NOT RUN（环境类门禁）**。本轮关闭了此前报告中的全部已知 P0/P1 缺陷，并补齐了新功能测试。真实 PostgreSQL migration、integration 与 v2 runtime 门禁本轮**已实际运行并通过**（此前报告标记为 NOT RUN）。

## 本轮自动化门禁（2026-09-18）

| 门禁                          | 状态 | 证据                                                                                                                                            |
| ----------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | PASS | `All matched files use Prettier code style!`                                                                                                    |
| `pnpm lint`                   | PASS | `eslint . --max-warnings 0`，0 error / 0 warning                                                                                                |
| `pnpm typecheck`              | PASS | 全部 workspace build + Web production build + noEmit typecheck                                                                                  |
| `pnpm test`                   | PASS | 15 test files / 131 tests                                                                                                                       |
| `pnpm openapi:check`          | PASS | OpenAPI 3.1.0，99 paths 与服务端路由一致                                                                                                        |
| `pnpm desktop:test`           | PASS | Electron 静态安全：node integration off、context isolation/sandbox/web security on、navigation gated                                            |
| `pnpm test:e2e`（3 浏览器）   | PASS | chromium + mobile + firefox：21 passed / 3 skipped（3 项真实后端仅 `E2E_REAL=1` 运行）                                                          |
| Android JVM 单测 + 仪器编译   | PASS | `:app:testDebugUnitTest :app:compileDebugAndroidTestKotlin` BUILD SUCCESSFUL                                                                    |
| `pnpm db:migrate`（连续两次） | PASS | 真实 PostgreSQL 18：两次执行均 `migrations applied and schema_migrations is current`，checksum 机制生效                                         |
| `pnpm test:integration`       | PASS | 真实 PostgreSQL：migration、owner 隔离、双进程并发、幂等、回滚、重启、多 Placement、v2 `PostgresTreeStore` 删除预览/整树删除、Folder-first 断言 |
| `pnpm test:pg-runtime`        | PASS | 真实 PostgreSQL + 真实 `/api/v2` HTTP：cookie refresh、v2 WebSocket `sync.required`、幂等重放、API 重启游标连续、PostgreSQL 重启恢复            |

## 本轮新增/修复的测试证据

| 缺陷/功能                           | 测试                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| 归档中心按操作分组 + 保留后代语义   | `apps/api/test/v2.test.ts` 2 项；`apps/web/e2e/v2-features.spec.ts` 归档中心 e2e       |
| 恢复已归档操作后不再列出（默认）    | `apps/api/test/v2.test.ts` `does not list a restored archive operation by default`     |
| v2 rollover（跳过 DONE、可撤销）    | `apps/api/test/v2.test.ts` `rolls an active date forward through v2 and undoes it`     |
| 离线整树删除 fail-closed            | `apps/web/test/offline-tree-delete.test.ts` 2 tests                                    |
| V2 `resolveConflict('restore')`     | `packages/sync-client/test/v2-migration.test.ts` 2 tests（含不支持类型时拒绝）         |
| V2 `applyChanges` 旧版本守卫        | `packages/sync-client/test/v2-migration.test.ts`（移除守卫后该测试失败，已做变异验证） |
| V2 快照清理遗留 `projects`          | `packages/sync-client/test/v2-migration.test.ts`（断言快照前 1、快照后 0）             |
| "最近有效目录"契约                  | `apps/web/test/folder-preference.test.ts` 7 tests                                      |
| Folder-first 迁移分层               | `scripts/integration-smoke.ts` 同级 Folder/Task 顺序断言（真实 PG）                    |
| Room v3→v6 迁移 + `weekStartsOn` 列 | `AppDatabaseMigrationTest`（androidTest，覆盖到 v6）                                   |

## 未运行门禁（环境缺失，非实现缺陷）

| 门禁                            | 状态    | 原因                                                                        |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| WebKit E2E                      | NOT RUN | 当前 Linux 缺少 WebKit 专用图形依赖                                         |
| Android 真机 / 仪器测试         | NOT RUN | 无在线 adb 设备或 AVD                                                       |
| Electron GUI 启动               | NOT RUN | `chrome-sandbox` 非 root-owned 4755；不用 `--no-sandbox` 绕过               |
| Electron Windows NSIS           | NOT RUN | 当前为 Linux 主机，无 Wine / Windows runner                                 |
| Docker Compose build/up/重启/卷 | NOT RUN | 当前环境无 Docker                                                           |
| 长期双端离线/冲突/响应丢失矩阵  | NOT RUN | 需真实多设备与长时间运行环境                                                |
| 线上部署验证                    | NOT RUN | 未部署；线上仍为 `syncProtocolVersion: 1`，`/api/v2/sync/snapshot` 返回 404 |

## 发行与验收限制

- 本轮全部 PASS 均为本地构建、单元/集成测试与真实独立 PostgreSQL 实例；**不包含部署、打标签或 Release**。
- 真实 PostgreSQL 证据来自本机用户态 PostgreSQL 18（`127.0.0.1:55432`）的一次性数据库，测试后已删除。
- 浏览器 E2E 使用 Playwright 内置 mock 后端；真实后端路径仅由 `E2E_REAL=1` 与 `pg-runtime-smoke` 覆盖。
- 在上述 NOT RUN 门禁完成前，不得据此宣布 v2 可发布；它们记录为环境缺失，而非已知实现缺陷。
