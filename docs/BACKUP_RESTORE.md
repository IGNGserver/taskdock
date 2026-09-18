# 备份与恢复

以下命令在部署主机执行。备份目录只允许部署账户访问；不要把数据库密码、`DATABASE_URL` 或备份文件提交到 Git。

## 备份与校验

TaskDock v2 数据升级前必须先完成 PostgreSQL custom dump；本轮新增 migration `0005_v2_structure.sql`、`0006_v2_backfill.sql`、`0007_v2_constraints.sql`。升级顺序是先备份，再让新代码读取旧/新结构，执行 backfill 和约束校验；禁止用 `TRUNCATE`、重建业务表或 destructive migration 替代。必须核对 Project→Folder、Task `reference_id`、Note、Placement、归档边界和用户设置计数后再继续。

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
  postgres:18.0-alpine \
  pg_restore --list "/backups/$(basename "$BACKUP_FILE")" \
  > "$BACKUP_FILE.list"
chmod 600 "$BACKUP_FILE.list"
```

升级前必须执行一次上述备份并保留 `pg_restore --list` 输出。生产环境至少保留 7 个日备份和 4 个周备份；部署者可设置更长的保留周期。

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
  -v "$RESTORE_VOLUME:/var/lib/postgresql/data" \
  postgres:18.0-alpine

until docker exec "$RESTORE_CONTAINER" pg_isready -U devtodo -d devtodo; do sleep 1; done
docker cp "$BACKUP_FILE" "$RESTORE_CONTAINER:/tmp/restore.dump"
docker exec "$RESTORE_CONTAINER" \
  pg_restore --clean --if-exists --no-owner --no-acl -U devtodo -d devtodo /tmp/restore.dump
docker exec "$RESTORE_CONTAINER" psql -U devtodo -d devtodo -c \
  "SELECT count(*) AS users FROM users; SELECT count(*) AS projects FROM projects; SELECT count(*) AS tasks FROM tasks; SELECT count(*) AS notes FROM notes; SELECT count(*) AS time_points FROM time_points; SELECT count(*) AS placements FROM placements;"
```

将恢复后的用户、项目代号、Task `reference_id`、Note 抽样、日期/Event 和 Placement 数量与备份前记录比较；还应执行应用的 ready health 和只读 smoke test。演练结束后清理临时资源：

```bash
docker rm -f "$RESTORE_CONTAINER"
docker volume rm "$RESTORE_VOLUME"
```

生产回滚先停止新版本并保留原卷，再按新卷恢复流程恢复到单独卷，核对数据不变量后切换 Compose 配置。不要在生产卷上执行 `pg_restore --clean` 或删除卷。

客户端迁移同样是原地、可重试边界：Dexie v3 从 projects 复制 Folder 并保留旧 stores 直到 v1 outbox 已逐项转换或标记为 `CLIENT_UPGRADE_REQUIRED`；Room v4 使用完整 `MIGRATION_3_4`，不允许 `fallbackToDestructiveMigration`。回滚客户端时不得删除本地 outbox、conflict、deferred change 或 v2 tombstone。
