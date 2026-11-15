# 外部数据库与共享数据库服务器

本文说明如何让 TaskDock 连接**外部 PostgreSQL 或 MySQL**，以及如何在一个数据库服务器上安全地运行多个使用数据库的自托管应用。

引擎在启动时确定：`DATABASE_URL` 的 scheme 是 `postgres://` / `postgresql://` 就是 PostgreSQL，`mysql://` 就是 MySQL；只给离散变量时，出现 `MYSQL_*` 即 MySQL，否则按 PostgreSQL 处理。也可以用 `DB_DIALECT=postgres|mysql` 显式指定。

## 1. 边界：共享服务器，不共享 database

推荐拓扑（两种引擎一致）：

```text
db.example.lan
├─ taskdock_home      ← 中枢 A
├─ taskdock_office    ← 中枢 B
├─ other_app_prod     ← 另一个应用
└─ other_app_staging  ← 另一个应用
```

每个 TaskDock 中枢使用**独立 database**。不要多个中枢共用一个 database，原因：

- `hub_identity` 是单例表，一个 database 只能有一个 Hub 身份。
- `users.username` 全局唯一，第二个中枢无法创建同名 Owner。
- `sync_changes.seq` 是全局序列，`oldestCursor` 按全局序列计算；多个中枢共用会让游标过期判断互相影响。
- `schema_migrations` 全局唯一，不同版本的中枢共用 database 会互相阻止迁移。
- 备份、恢复、升级和故障隔离都会变得不可控。

需要"一个 database 多中枢"时，得引入 `hub_id` 租户列、复合唯一键、按 hub 的迁移和游标，属于独立的大迁移，当前不支持。

## 2. 创建 database 与角色

两种引擎都建议拆两个角色：迁移角色有 DDL 权限，只给迁移 job 用；应用角色只有业务表 DML 权限，给 API 用。

### PostgreSQL

```sql
CREATE ROLE taskdock_migrator LOGIN PASSWORD 'replace-me';
CREATE ROLE taskdock_app LOGIN PASSWORD 'replace-me';

CREATE DATABASE taskdock_home OWNER taskdock_migrator;

\connect taskdock_home

GRANT CONNECT ON DATABASE taskdock_home TO taskdock_app;
GRANT USAGE ON SCHEMA public TO taskdock_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskdock_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskdock_app;
ALTER DEFAULT PRIVILEGES FOR ROLE taskdock_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taskdock_app;
```

### MySQL

```sql
CREATE DATABASE taskdock_home CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'taskdock_migrator'@'%' IDENTIFIED BY 'replace-me';
CREATE USER 'taskdock_app'@'%' IDENTIFIED BY 'replace-me';

GRANT ALL PRIVILEGES ON taskdock_home.* TO 'taskdock_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON taskdock_home.* TO 'taskdock_app'@'%';
FLUSH PRIVILEGES;
```

迁移完成后，应用角色不应拥有 `CREATE`/`ALTER`/`DROP`。MySQL 的 DDL 会隐式提交，所以迁移中途失败不会自动回滚；失败后处理见第 9 节。

## 3. 配置

### 外部 database（推荐）

使用 `compose.external-db.yaml`，它只接受 URL，两种引擎通用：

```dotenv
APP_VERSION=2.0.0
APP_ORIGIN=https://tasks.example.com
# PostgreSQL
DATABASE_URL=postgres://taskdock_app:replace-me@db.example.lan:5432/taskdock_home
MIGRATION_DATABASE_URL=postgres://taskdock_migrator:replace-me@db.example.lan:5432/taskdock_home
# MySQL（二选一，改 scheme 即可）
# DATABASE_URL=mysql://taskdock_app:replace-me@db.example.lan:3306/taskdock_home
# MIGRATION_DATABASE_URL=mysql://taskdock_migrator:replace-me@db.example.lan:3306/taskdock_home
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CA=/run/secrets/db-ca.pem
DB_POOL_MAX=5
DB_POOL_WARM=2
DB_IDLE_TIMEOUT_MS=300000
DB_APPLICATION_NAME=taskdock-home
```

密码包含 `@`、`:`、`/`、`#` 时必须 URL 编码。不想编码时改用离散变量：

```dotenv
# PostgreSQL
PGHOST=db.example.lan
PGPORT=5432
PGUSER=taskdock_app
PGPASSWORD=replace-me
PGDATABASE=taskdock_home

# 或 MySQL
MYSQL_HOST=db.example.lan
MYSQL_PORT=3306
MYSQL_USER=taskdock_app
MYSQL_PASSWORD=replace-me
MYSQL_DATABASE=taskdock_home
```

内置 Compose 已经使用离散变量，因此内置密码不需要 URL 编码。

### 内置 database

- PostgreSQL（默认）：`compose.yaml` + `POSTGRES_*`，应用通过 `PGHOST=postgres` 连接。
- MySQL：`compose.mysql.yaml` + `MYSQL_*`，应用通过 `MYSQL_HOST=mysql` 连接。

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
- `app` 启动时会再次核对 migration checksum；schema 不齐会重试到 `DB_STARTUP_MAX_WAIT_MS`，然后失败退出。
- `/health/live` 只代表进程存活；`/health/ready` 才代表数据库可用。

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
- MySQL 驱动通过 `checkServerIdentity` 实现 `verify-ca`；如果目标环境不接受该实现，就只用 `disable` / `require` / `verify-full`。

## 6. 连接预算

多个应用共用一个数据库时，连接数按总预算计算：

```text
总连接数 ≈ Σ(每个 app 的 DB_POOL_MAX + LISTEN 连接)
          + migrate/bootstrap 临时连接
          + 管理/监控连接
```

- `DB_POOL_MAX` 默认 10；多应用共享时通常 3–5 就够。
- PostgreSQL：使用 PgBouncer `pool_mode=transaction` 复用连接。transaction mode **不能可靠保持 `LISTEN`**，设置 `DB_LISTEN_ENABLED=false`，或让 API 直连建立专用 LISTEN 连接。
- MySQL：LISTEN 不存在，连接池本身即复用；注意 `max_connections`（默认 151）和每连接内存。MySQL 只允许 SELECT 使用 `max_execution_time`，写入的超时靠 `innodb_lock_wait_timeout`（由 `DB_LOCK_TIMEOUT_MS` 换算）。
- 迁移 job 建议直连，不经连接池中间层，因为迁移包含长事务、锁和 DDL。
- 监控 `pg_stat_activity` / `performance_schema`、PgBouncer `SHOW POOLS` 和 API 的 pool wait 指标。

## 7. 与 PostgreSQL 的行为差异

引擎切换后，下面这些能力会被明确降级或改变，配置前应确认可以接受：

| 能力           | PostgreSQL                   | MySQL                                          |
| -------------- | ---------------------------- | ---------------------------------------------- |
| 跨实例实时推送 | `LISTEN/NOTIFY` 即时唤醒     | 进程内通知；多实例靠客户端轮询或 Redis pub/sub |
| 搜索           | `pg_trgm` GIN 索引           | `LIKE '%term%'` 扫描（owner 范围内）           |
| 语句级超时     | `statement_timeout` 覆盖读写 | `max_execution_time` 只作用于 SELECT           |
| 部分唯一索引   | 原生 `WHERE` 谓词            | 生成列 + 唯一索引（NULL 不冲突）               |
| `RETURNING`    | 单语句返回                   | 先写后按主键回查（同一事务）                   |
| 迁移原子性     | 整个迁移集一个事务           | DDL 隐式提交，逐文件记录                       |
| 时区           | `timestamptz`                | `DATETIME(6)` 存 UTC，会话固定 `+00:00`        |

## 8. 备份与恢复

PostgreSQL 用 `pg_dump` / `pg_restore`；MySQL 用 `mysqldump` / `mysql`。完整命令、演练流程和恢复后的 `migrate` 步骤见 [备份与恢复](BACKUP_RESTORE.md)。

## 9. 迁移失败后的处理

- PostgreSQL：迁移在事务里执行，失败自动回滚，修好后直接重跑 `migrate`。
- MySQL：每个文件成功后才写 `schema_migrations`。中途失败时，已成功的文件保留记录，失败文件可能留下部分对象。处理顺序是：先看错误定位语句 → 手动补完或删除该文件已创建的对象 → 确认 `schema_migrations` 没有该版本 → 重跑 `migrate`。不要删除整库，也不要把已成功的版本一起回退。

## 10. 可选 Redis

Redis 不是权威存储，只用于：

- 多 API 副本共享登录限流计数；
- 多副本冷启动时共享 Owner 投影快照（TTL 缓存）；
- MySQL 多实例部署时广播 `sync.required`。

配置：

```dotenv
CACHE_URL=redis://redis.example.lan:6379/0
CACHE_KEY_PREFIX=taskdock-home
CACHE_SNAPSHOT_TTL_SECONDS=60
CACHE_REQUIRED=false
```

- Redis 故障时，若配置了 `CACHE_URL`，认证请求必须 fail-closed；投影缓存等非权威能力可以回退数据库。`/health/ready` 会报告 `cache: degraded`。
- 不要用 Redis 存实体、mutation receipt 或 sync cursor。
- 多个中枢共享 Redis 时必须给每个中枢不同的 `CACHE_KEY_PREFIX`。

## 11. 验收清单

- [ ] 每个中枢使用独立 database。
- [ ] 应用和迁移使用不同角色。
- [ ] 外部库使用 TLS，CA 通过 secret 挂载。
- [ ] `DB_POOL_MAX` × 应用数 + listener < 数据库 `max_connections`。
- [ ] PostgreSQL + PgBouncer 场景设置 `DB_LISTEN_ENABLED=false` 或使用直连 listener。
- [ ] `migrate` 在 `app` 之前成功执行。
- [ ] 备份/恢复在独立临时库演练通过（`pg_dump`/`pg_restore` 或 `mysqldump`）。
- [ ] Redis 断开时写入、登录和同步仍可用。
- [ ] `/health/ready` 在数据库断开时 503、恢复后 200。
