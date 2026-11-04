# ADR 0004：外部数据库、共享 PostgreSQL 与可选缓存

状态：接受（外部 PostgreSQL 一等支持；Redis 可选、fail-open）

## 背景

TaskDock 默认用 Compose 启动一个 PostgreSQL。实际自托管环境里，用户可能在 NAS 或一台服务器上运行多个需要数据库的应用，希望复用同一个 PostgreSQL 服务器，并让 TaskDock 连接局域网或公网上的数据库。远端数据库的 RTT 可能远高于容器内 localhost，因此 v2 的每次请求和每个 mutation 的往返次数必须可控。

## 决策

1. **每个 TaskDock 中枢使用独立 database**。可以共享 PostgreSQL 服务器，但不共享 database；`hub_identity`、`users.username`、`sync_changes.seq`、`schema_migrations` 都是 database 级全局的。
2. `DATABASE_URL` 是外部库的标准入口；同时支持离散 `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`，避免密码 URL 编码问题。
3. 应用连接与迁移连接分离：`MIGRATION_DATABASE_URL` 可使用 DDL 角色，API 使用 DML 角色。
4. 连接池、SSL、应用名、超时和 LISTEN 开关都可配置；高延迟远端库默认使用更长的 idle timeout，并支持启动重试和 PgBouncer transaction mode。
5. v2 投影缓存优先使用进程内数据；跨副本通过 `sync_changes` 增量追赶；Redis 仅用于共享限流和多副本冷启动快照，故障时回退到数据库/进程内缓存。

## 代价与边界

- 共享 database 多中枢仍不支持；需要 `hub_id` 租户模型和一次独立迁移。
- 远端库的延迟不能靠缓存完全消除：写入、幂等回执和 change feed 必须经过数据库事务。
- Redis 不是权威存储；不保存实体、receipt 或 sync cursor。`CACHE_REQUIRED=false` 时 Redis 故障不影响可用性。
- PgBouncer transaction mode 不能保持 `LISTEN` 会话；需要 `DB_LISTEN_ENABLED=false` 或直连监听连接。

## 验收

- 外部 PostgreSQL + TLS 连接、迁移、bootstrap、登录和 v2 同步通过。
- 两个中枢各自独立 database，互不影响。
- 远端延迟注入下，普通读、mutation、pull、push 的往返次数有界。
- Redis 停止/恢复时 API 写入和同步仍可用，`/health/ready` 仅把 cache 标记为 degraded。
