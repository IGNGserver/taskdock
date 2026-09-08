# API 契约

Base URL：`/api/v1`。完整路径清单在 [openapi.json](openapi.json)。JSON 使用 camelCase；PostgreSQL BIGINT 的 `rank` 和同步 `seq` 使用十进制字符串。

## 认证

首次部署使用 `POST /bootstrap`，令牌来自 `BOOTSTRAP_TOKEN`，成功后永久关闭。`POST /auth/login` 返回短时 access token；Web refresh token 是 `HttpOnly`、`SameSite=Lax` Cookie：使用 HTTPS 时还会带有 `Secure` 属性，使用 HTTP 时为了让 HTTP 外网地址可用而不带 `Secure`，但密码和会话信息会明文传输，页面会显示安全警告。原生容器应通过平台安全存储持有 refresh token。每次 refresh 都轮换 token，旧链重放会撤销该设备会话链。

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
