# API 契约

兼容 API Base URL：`/api/v1`；TaskDock v2 Base URL：`/api/v2`。完整路径清单在 [openapi.json](openapi.json)。JSON 使用 camelCase；PostgreSQL BIGINT 的 `rank` 和同步 `seq` 使用十进制字符串。

## v2 资源

v2 不再把 Project/Inbox/category/priority 作为产品模型。`GET /api/v2/tree/children` 返回 Folder 与 Task 的混合直接子项；Folder 的 `aggregate` 由后代 Task 派生，状态顺序为 `IN_PROGRESS → TODO → DONE`。`POST /api/v2/tree/items/move` 使用 `baseVersion`、状态快照和前后锚点保护循环、已归档目标以及并发排序冲突。

目录归档使用 `POST /api/v2/folders/:id/archive-tree`，响应 `ArchiveOperation`；恢复使用原 operationId，保证逐项精确恢复。归档中心通过 `GET /api/v2/archive-operations` 按顶层归档操作分组返回（含 `rootFolderTitle`、后代 Folder/Task 计数、原本已归档而恢复时需保留的计数，以及可展开的嵌套 Folder 列表）；`?includeRestored=true` 才包含已恢复操作，`GET /api/v2/archive-operations/:id` 额外返回该操作的归档 Task 明细与独立归档 Task。整树删除必须先 `POST /api/v2/folders/:id/delete-preview`，再把短时 `confirmationToken` 发送到 `DELETE /api/v2/folders/:id/tree`；预览 fingerprint 变化或令牌过期时拒绝，不物理删除关联 Note、TaskStep、Placement、Workflow Membership 或父级引用。整树删除必须在线执行；离线客户端 fail-closed 并返回 `OFFLINE_TREE_DELETE_FORBIDDEN` 与归档建议，不允许排队执行不可恢复的删除。

批量顺延使用 `POST /api/v2/dates/:localDate/rollover`，只把该日期仍处于活动状态的 Placement 复制到次日，跳过已完成或已归档任务；响应 `{ createdIds, skippedTaskIds, targetDate }`。撤销使用 `POST /api/v2/rollovers/undo`，body 传 `{ placementIds }`。该操作无服务端状态，可跨进程与重启使用；离线时不排队，直接 fail-closed。

`GET /api/v2/tasks?archived=false&q=...` 支持按任务标题、引用 ID 或备注内容搜索。Task 详情通过 `GET /api/v2/tasks/:id` 聚合 Note、独立 TaskStep、Placement、Workflow Membership 和 Folder path；每个 Placement 同时返回可直接展示的 `timePoint` 日期/事件信息。日期与 Event/Placement 使用 `/time-points`、`/placements` v2 路由；Workflow、Stage、Membership 使用 `/workflows`、`/workflow-stages` 和 `/workflow-memberships`。同一 Task 可以加入多个 Workflow，但同一 Workflow 只能有一个活动 Membership。

v2 设置通过 `/api/v2/settings` 保存 `ROOT/RECENT_FOLDER` 目标；`GET /api/v2/status` 返回 `schemaVersion: 2`、支持的 API/sync 版本和 `minClientVersion`。v2 写入继续要求 `Idempotency-Key`、`X-Client-Id` 和适用的 `baseVersion`。

## 认证

首次部署由部署中枢执行 `docker compose --profile operations run --rm bootstrap`，服务端内部仍使用 `POST /bootstrap` 和 `BOOTSTRAP_TOKEN`，成功后永久关闭；Web、桌面和手机客户端不提供初始化令牌输入。`POST /auth/login` 返回短时 access token；Web refresh token 是 `HttpOnly`、`SameSite=Lax` Cookie：使用 HTTPS 时还会带有 `Secure` 属性，使用 HTTP 时为了让 HTTP 外网地址可用而不带 `Secure`，但密码和会话信息会明文传输，页面会显示安全警告。原生容器应通过平台安全存储持有 refresh token。每次 refresh 都轮换 token，旧链重放会撤销该设备会话链。

## 写入约定

所有写请求需要合法 UUID `Idempotency-Key` 和 `X-Client-Id`。更新/归档/恢复需要 body 中的 `baseVersion`。服务端重复接收相同 mutation 返回第一次结果，不重复创建 Task 或 Placement。冲突 HTTP 409，错误体固定为：

```json
{
  "code": "VERSION_CONFLICT",
  "message": "实体版本已变化",
  "requestId": "uuid",
  "details": { "server": {} }
}
```

程序只能依据稳定 `code` 分支，不能匹配 message。

## 关键语义

- `POST /placements`、`/placements/:id/copy` 和 rollover 只增加安排关系。
- `/placements/:id/move` 在一个 mutation 中建立目标并软删除来源。
- `/tasks/:id/duplicate` 才创建新的 Task、Note 和引用 ID。
- `POST /time-points/date` 对同一 Owner/localDate 幂等返回同一 Date TimePoint。
- Task status 全局生效，Event 的 `reachedAt/archivedAt` 独立。
- 普通列表默认排除归档和 tombstone；`/search/tasks?includeArchived=true` 可搜索归档任务。

## 列表与分页

`GET /projects`、`GET /tasks`、`GET /time-points` 和
`GET /time-points/:id/placements` 返回统一形状：

```json
{
  "items": [],
  "nextCursor": "opaque-or-null"
}
```

`limit` 默认为 100，允许 1 至 500；传入 `cursor` 时服务端使用稳定的 keyset 顺序继续返回，不使用页码。游标是服务端生成的不透明 Base64URL 值，客户端不得解析或自行计算。Web repository 的 `requestAll()` 会按游标聚合页面，因此页面组件不会因 API 分页而丢失实体；离线读取直接使用本地完整缓存。

`GET /search/tasks` 仍是有结果上限的搜索接口（`limit` 默认为 100、最大 500），不提供跨请求的搜索游标。

`GET /sync/snapshot` 与列表接口不同：V1 返回一次数据库一致性快照和对应游标，客户端在一个 IndexedDB 事务中替换/合并本地实体。当前实现针对单 Owner V1 使用有界的完整快照；高容量分页快照属于 ADR 0001 记录的升级边界，不得用普通列表分页响应冒充同步快照。
