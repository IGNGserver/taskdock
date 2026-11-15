# 备份与恢复

以下命令在部署主机执行。备份目录只允许部署账户访问；不要把数据库密码、`DATABASE_URL` 或备份文件提交到 Git。

## 备份与校验（PostgreSQL）

TaskDock v2 数据升级前必须先完成 PostgreSQL custom dump；本轮新增 migration `0005_v2_structure.sql`、`0006_v2_backfill.sql`、`0007_v2_constraints.sql`。升级顺序是先备份，再让新代码读取旧/新结构，执行 backfill 和约束校验；禁止用 `TRUNCATE`、重建业务表或 destructive migration 替代。必须核对 Project→Folder、Task `reference_id`、Note、Placement、删除边界（tombstone）和用户设置计数后再继续。

```bash
BACKUP_DIR="$PWD/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/devtodo-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
docker compose exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$BACKUP_FILE"
test -s "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

docker run --rm \
  --mount "type=bind,src=$BACKUP_DIR,dst=/backups,readonly" \
  postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2 \
  pg_restore --list "/backups/$(basename "$BACKUP_FILE")" \
  > "$BACKUP_FILE.list"
chmod 600 "$BACKUP_FILE.list"
```

升级前必须执行一次上述备份并保留 `pg_restore --list` 输出。生产环境至少保留 7 个日备份和 4 个周备份；部署者可设置更长的保留周期。

## 备份与校验（MySQL）

使用 `compose.mysql.yaml` 或外部 MySQL 时，用 `mysqldump` 做一致性备份。`--single-transaction` 对 InnoDB 表提供一致性快照，不需要停服；`--routines --triggers` 保证对象齐全（当前 schema 没有存储过程，保留是为了以后）。

```bash
BACKUP_DIR="$PWD/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/taskdock-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
docker compose -f compose.mysql.yaml exec -T mysql sh -c \
  'exec mysqldump --single-transaction --quick --routines --triggers --no-tablespaces \
     -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  | gzip -9 > "$BACKUP_FILE"
test -s "$BACKUP_FILE"
gzip -t "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
```

外部 MySQL 把 `docker compose exec` 换成在数据库主机上执行同样的 `mysqldump`，密码通过 `MYSQL_PWD` 或登录路径提供，不要写进命令行历史。

### 恢复演练（MySQL）

恢复始终指向新建的临时 database，绝不覆盖生产库。下面用 `docker compose exec -e` 把目标库名传进容器，避免嵌套引号：

```bash
MYSQL_RESTORE_DB="taskdock_restore_$(date +%Y%m%d%H%M%S)"

echo "CREATE DATABASE \`$MYSQL_RESTORE_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" \
  | docker compose -f compose.mysql.yaml exec -T mysql \
      sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD"'

gzip -dc "$BACKUP_FILE" \
  | docker compose -f compose.mysql.yaml exec -T -e TARGET_DB="$MYSQL_RESTORE_DB" mysql \
      sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$TARGET_DB"'
```

恢复后核对 `schema_migrations` 的版本与 checksum 是否和镜像一致，再以 `mysql://.../$MYSQL_RESTORE_DB` 跑一次 `migrate` 和 `app`，确认 `/health/ready` 与一次真实登录。演练完成后删除临时 database。

## 新卷恢复演练

当前仓库只提供可执行的恢复流程；是否通过恢复演练必须以真实 PostgreSQL/Docker 输出为准，不能由内存 smoke 或构建结果代替。恢复演练始终使用独立临时卷，不覆盖生产卷。

恢复演练使用独立临时卷，绝不覆盖生产卷：

```bash
BACKUP_FILE="$PWD/backups/devtodo-YYYYMMDD-HHMMSS.dump"
RESTORE_VOLUME="devtodo-restore-$(date +%Y%m%d-%H%M%S)"
RESTORE_CONTAINER="devtodo-restore-db-$(date +%s)"

docker volume create "$RESTORE_VOLUME"
docker run -d --name "$RESTORE_CONTAINER" \
  -e POSTGRES_DB=devtodo \
  -e POSTGRES_USER=devtodo \
  -e POSTGRES_PASSWORD=temporary-only \
  -v "$RESTORE_VOLUME:/var/lib/postgresql" \
  postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2

until docker exec "$RESTORE_CONTAINER" pg_isready -U devtodo -d devtodo; do sleep 1; done
docker cp "$BACKUP_FILE" "$RESTORE_CONTAINER:/tmp/restore.dump"
docker exec "$RESTORE_CONTAINER" \
  pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl -U devtodo -d devtodo /tmp/restore.dump
docker exec "$RESTORE_CONTAINER" psql -U devtodo -d devtodo -c \
  "SELECT count(*) AS users FROM users; SELECT count(*) AS projects FROM projects; SELECT count(*) AS tasks FROM tasks; SELECT count(*) AS notes FROM notes; SELECT count(*) AS time_points FROM time_points; SELECT count(*) AS placements FROM placements;"
```

将恢复后的用户、项目代号、Task `reference_id`、Note 抽样、日期/Event 和 Placement 数量与备份前记录比较；还应执行应用的 ready health 和只读 smoke test。演练结束后清理临时资源：

```bash
docker rm -f "$RESTORE_CONTAINER"
docker volume rm "$RESTORE_VOLUME"
```

生产回滚先停止新版本并保留原卷，再按新卷恢复流程恢复到单独卷，核对数据不变量后切换 Compose 配置。不要在生产卷上执行 `pg_restore --clean` 或删除卷。

## 外部 PostgreSQL

使用 `compose.external-db.yaml` 时，备份命令不经过内置 `postgres` 容器，直接指向外部库：

```bash
BACKUP_FILE="$PWD/backups/taskdock-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-acl \
  --dbname="$MIGRATION_DATABASE_URL" \
  --file="$BACKUP_FILE"
test -s "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.list"
```

恢复到独立临时 database 后，必须显式把 **DATABASE_URL 和 MIGRATION_DATABASE_URL 同时指向临时库** 再执行迁移；不要让命令继承 `.env` 中的生产地址：

```bash
RESTORE_DATABASE_URL='postgres://taskdock_migrator:临时密码@db.example.lan:5432/taskdock_home_restore'
DATABASE_URL="$RESTORE_DATABASE_URL" \
MIGRATION_DATABASE_URL="$RESTORE_DATABASE_URL" \
  docker compose -f compose.external-db.yaml run --rm migrate
DATABASE_URL="$RESTORE_DATABASE_URL" \
MIGRATION_DATABASE_URL="$RESTORE_DATABASE_URL" \
  docker compose -f compose.external-db.yaml up -d app
```

启动后检查该临时实例的 `/health/ready`。每个 TaskDock 中枢使用独立 database，因此可以按 database 单独备份/恢复，不会影响同一服务器上的其他应用。Redis 是可丢弃缓存，不需要备份。

客户端迁移同样是原地、可重试边界：Dexie v3 从 projects 复制 Folder 并保留旧 stores 直到 v1 outbox 已逐项转换或标记为 `CLIENT_UPGRADE_REQUIRED`；Room v4 使用完整 `MIGRATION_3_4`，不允许 `fallbackToDestructiveMigration`。回滚客户端时不得删除本地 outbox、conflict、deferred change 或 v2 tombstone。
