# 外部 PostgreSQL 与共享数据库服务器

本文说明如何让 TaskDock 连接**外部 PostgreSQL**，以及如何在一个 PostgreSQL 服务器上安全地运行多个使用数据库的自托管应用。

## 1. 边界：共享服务器，不共享 database

推荐拓扑：

```text
postgres.example.lan:5432
├─ taskdock_home      ← 中枢 A
├─ taskdock_office    ← 中枢 B
├─ other_app_prod     ← 另一个应用
└─ other_app_staging  ← 另一个应用
```

每个 TaskDock 中枢使用**独立 database**。不要多个中枢共用一个 database，原因：

- `hub_identity` 是单例表（`singleton boolean PRIMARY KEY`），一个 database 只能有一个 Hub 身份。
- `users.username` 全局唯一，第二个中枢无法创建同名 Owner。
- `sync_changes.seq` 是全局 identity，`oldestCursor` 按全局序列计算；多个中枢共用会让游标过期判断互相影响。
- `schema_migrations` 全局唯一，不同版本的中枢共用 database 会互相阻止迁移。
- 备份、恢复、升级和故障隔离都会变得不可控。

如果确实需要“一个 database 多中枢”，需要引入 `hub_id` 租户列、复合唯一键、按 hub 的迁移和游标，这是一次独立的大迁移，不在当前支持范围内。

## 2. 创建 database 与角色

建议拆分两个角色：

- `taskdock_migrator`：拥有 DDL 权限，只给迁移 job 使用。
- `taskdock_app`：只有业务表 DML 权限，给 API 使用。

示例（在 PostgreSQL 服务器上以管理员执行；请替换密码和库名）：

```sql
CREATE ROLE taskdock_migrator LOGIN PASSWORD 'replace-me';
CREATE ROLE taskdock_app LOGIN PASSWORD 'replace-me';

CREATE DATABASE taskdock_home OWNER taskdock_migrator;

\connect taskdock_home

GRANT CONNECT ON DATABASE taskdock_home TO taskdock_app;
GRANT USAGE ON SCHEMA public TO taskdock_app;

-- 迁移角色创建的表，默认给应用角色 DML 权限。
ALTER DEFAULT PRIVILEGES FOR ROLE taskdock_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskdock_app;
ALTER DEFAULT PRIVILEGES FOR ROLE taskdock_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taskdock_app;
```

迁移完成后，`taskdock_app` 不应拥有 `CREATE`/`ALTER`/`DROP` 权限。这样即使 API 凭据泄露，也不能改 schema。

## 3. 配置

### 外部 database（推荐）

使用 `compose.external-db.yaml`：

```dotenv
APP_VERSION=2.0.0
APP_ORIGIN=https://tasks.example.com
DATABASE_URL=postgres://taskdock_app:replace-me@db.example.lan:5432/taskdock_home
MIGRATION_DATABASE_URL=postgres://taskdock_migrator:replace-me@db.example.lan:5432/taskdock_home
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CA=/run/secrets/db-ca.pem
DB_POOL_MAX=5
DB_POOL_WARM=2
DB_IDLE_TIMEOUT_MS=300000
DB_APPLICATION_NAME=taskdock-home
```

如果密码包含 `@`、`:`、`/`、`#`，必须做 URL 编码；更稳妥的方式是改用离散变量：

```dotenv
PGHOST=db.example.lan
PGPORT=5432
PGUSER=taskdock_app
PGPASSWORD=replace-me
PGDATABASE=taskdock_home
```

内置 `compose.yaml` 已经使用离散 `PG*` 变量，因此内置密码不需要 URL 编码。

### 内置 database

保留 `compose.yaml` 和 `POSTGRES_*` 即可。应用通过 `PGHOST=postgres` 连接，不会把密码拼进 URL。

## 4. 启动顺序

```bash
docker compose -f compose.external-db.yaml pull
docker compose -f compose.external-db.yaml run --rm migrate
docker compose -f compose.external-db.yaml --profile operations run --rm bootstrap
docker compose -f compose.external-db.yaml up -d app
curl -fsS https://tasks.example.com/health/ready
```

- `migrate` 使用 `MIGRATION_DATABASE_URL`（为空时回退 `DATABASE_URL`）。
- `bootstrap` 使用 `DATABASE_URL`，只创建 Owner。
- `app` 启动时会再次检查 migration checksum；schema 不齐会重试到 `DB_STARTUP_MAX_WAIT_MS`，然后失败退出。
- `/health/live` 只代表进程存活；`/health/ready` 才代表 PostgreSQL 可用。

## 5. TLS

- 生产外部库建议 `DATABASE_SSL_MODE=verify-full`，并通过 Docker secret 挂载 CA：
  ```yaml
  services:
    app:
      volumes:
        - ./secrets/db-ca.pem:/run/secrets/db-ca.pem:ro
  ```
- `require` 会加密但不校验证书，只适合可信内网。
- 不要把 CA、证书或密码写进镜像、Compose 文件或 Git。

## 6. PgBouncer 与连接预算

多个应用共用一个 PostgreSQL 时，连接数要按总预算计算：

```text
总连接数 ≈ Σ(每个 app 的 DB_POOL_MAX + LISTEN 连接)
          + migrate/bootstrap 临时连接
          + 管理/监控连接
```

建议：

- `DB_POOL_MAX` 默认 10；多应用共享时通常 3–5 就够。
- 使用 PgBouncer `pool_mode=transaction` 复用连接。
- PgBouncer transaction mode **不能可靠保持 `LISTEN`**。设置 `DB_LISTEN_ENABLED=false`，让客户端依赖 pull/轮询；或让 API 直连 PostgreSQL 建立一条专用 LISTEN 连接。
- 迁移 job 建议直连 PostgreSQL，不经 PgBouncer，因为迁移包含长事务、advisory lock 和 DDL。
- 监控 `pg_stat_activity`、PgBouncer `SHOW POOLS` 和 API 的 pool wait 指标。

## 7. 备份与恢复

外部库直接用 `pg_dump` / `pg_restore`：

```bash
pg_dump --format=custom --no-owner --no-acl \
  --dbname="postgres://taskdock_migrator:...@db.example.lan:5432/taskdock_home" \
  --file=taskdock_home.dump

pg_restore --no-owner --no-acl \
  --dbname="postgres://taskdock_migrator:...@db.example.lan:5432/taskdock_home_restore" \
  taskdock_home.dump
```

恢复后先跑 `migrate`，再启动 `app`，最后用 `/health/ready` 和一次真实登录/同步验证。

## 8. 可选 Redis

Redis 不是权威存储，只用于：

- 多 API 副本共享登录限流计数；
- 多副本冷启动时共享 Owner 投影快照（TTL 缓存）。

配置：

```dotenv
CACHE_URL=redis://redis.example.lan:6379/0
CACHE_KEY_PREFIX=taskdock-home
CACHE_SNAPSHOT_TTL_SECONDS=60
CACHE_REQUIRED=false
```

规则：

- Redis 故障必须 fail-open：回退到进程内缓存/数据库，`/health/ready` 报告 `cache: degraded` 但仍返回 200。
- 不要用 Redis 存实体、mutation receipt 或 sync cursor。
- 多个中枢共享 Redis 时必须给每个中枢不同的 `CACHE_KEY_PREFIX`。
- 内置 `compose.yaml` 的 Redis 是可选 profile：`docker compose --profile cache up -d`，并设置 `CACHE_URL=redis://redis:6379/0`。

## 9. 验收清单

- [ ] 每个中枢使用独立 database。
- [ ] 应用和迁移使用不同角色。
- [ ] 外部库使用 TLS，CA 通过 secret 挂载。
- [ ] `DB_POOL_MAX` × 应用数 + listener < PostgreSQL `max_connections`。
- [ ] PgBouncer 场景设置 `DB_LISTEN_ENABLED=false` 或使用直连 listener。
- [ ] `migrate` 在 `app` 之前成功执行。
- [ ] `pg_dump`/`pg_restore` 在独立临时库演练通过。
- [ ] Redis 断开时写入、登录和同步仍可用。
- [ ] `/health/ready` 在数据库断开时 503、恢复后 200。
