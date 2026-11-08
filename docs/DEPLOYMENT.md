# 部署

TaskDock 的生产部署使用 GitHub Container Registry 中已经构建好的 Docker 镜像。生产服务器不需要下载源代码，也不需要在服务器上重新编译项目。

## 准备

复制 `.env.example` 为 `.env`，为以下秘密分别生成至少 32 字节随机值：

```bash
openssl rand -base64 48
```

填写真实 HTTP 或 HTTPS `APP_ORIGIN`、数据库密码和显式 `CORS_ALLOWED_ORIGINS`。默认应用容器端口为 `48731`，可通过 `TASKDOCK_PORT` 修改；Compose 默认只绑定宿主机 `127.0.0.1`，避免绕过反向代理直接暴露。实际秘密不进入 Git、镜像或日志。

生产环境必须设置 `DEV_MEMORY_STORE=false`（Compose 已设置），并使用随机的 `BOOTSTRAP_TOKEN`、`ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_PEPPER`。`APP_ORIGIN` 与允许的 CORS origin 必须是完整的 HTTP 或 HTTPS 地址；公网必须使用 HTTPS。需要 Caddy 反向代理时使用 `--profile gateway`，由 Caddy 发布公开入口；只有明确接受明文 HTTP 风险时，才设置 `TASKDOCK_BIND_ADDRESS=0.0.0.0` 直接发布应用端口。使用网关时不要同时让两个服务占用同一个宿主机端口。

Web 端同时提供 PWA manifest、Service Worker 和离线更新提示。浏览器只有在 HTTPS（或本机 `localhost`）安全上下文中才会启用 Service Worker 和安装能力；因此可信局域网可以继续用 HTTP 访问，但要安装 PWA 或离线打开，需让 `APP_ORIGIN` 使用 HTTPS，并通过反向代理提供有效证书。HTTP 部署不会再把页面资源强制升级到 HTTPS。

TaskDock 允许至少 6 位的密码，6 位纯数字也可以，没有额外的字符种类限制。`BOOTSTRAP_TOKEN` 只在部署中枢时使用，客户端不会显示或要求填写初始化令牌。

## 首次部署

从 GitHub 仓库取得 `compose.yaml` 和 `.env.example` 后，在服务器上执行：

> **数据库卷提示：** 当前 Compose 使用 PostgreSQL 18 的 `/var/lib/postgresql` 数据卷布局。若旧部署使用过早期 Compose 文件，请先完成数据库备份，再按 [备份与恢复](BACKUP_RESTORE.md) 恢复到新的数据库卷；不要直接删除旧卷。

```bash
cp .env.example .env
# 编辑 .env，填入真实配置

export APP_VERSION=0.1.0
# 必须使用不可变的发布版本；不要使用 latest

docker compose pull
docker compose up -d postgres app
curl -fsS http://your-host.example:48731/health/ready  # 使用 HTTPS 或自定义端口时按 APP_ORIGIN 修改
```

Compose 使用的应用镜像默认为：

```text
ghcr.io/igngserver/taskdock:${APP_VERSION}
```

如果需要使用其他镜像仓库，可以设置 `TASKDOCK_IMAGE`。不要把生产 Compose 改回 `build:`，也不要在生产服务器上执行 `git pull` 后从源代码构建。

默认应用端口仅绑定 `127.0.0.1:48731`；直接提供 HTTP 服务时必须显式设置 `TASKDOCK_BIND_ADDRESS=0.0.0.0`，公网仍应改用 HTTPS 网关。使用 HTTP 时页面会显示安全警告，密码和会话信息会明文传输。PostgreSQL 没有宿主机端口。在 `.env` 中填写 `OWNER_USERNAME`、`OWNER_PASSWORD`，然后由部署中枢执行一次 Owner 初始化：

```bash
docker compose --profile operations run --rm migrate
docker compose --profile operations run --rm bootstrap
docker compose up -d app
```

初始化命令会读取部署环境中的 `BOOTSTRAP_TOKEN`，不会把令牌交给 Web、桌面或手机客户端。初始化成功后，建议从 `.env` 中删除 `OWNER_PASSWORD`，并轮换或移除 `BOOTSTRAP_TOKEN`。`app` 依赖迁移 job 成功后才会进入 ready；`/health/live` 只证明进程存活，不能替代迁移和数据库就绪检查。

## 外部 PostgreSQL / 共享数据库服务器

如果 PostgreSQL 已经运行在 NAS、共享服务器或托管服务上，不要使用 `compose.yaml` 的内置数据库，改用 `compose.external-db.yaml`。每个 TaskDock 中枢必须使用独立 database；多个应用可以共用同一台 PostgreSQL 服务器。

```bash
cp .env.example .env
# 填写 DATABASE_URL、MIGRATION_DATABASE_URL、APP_ORIGIN 和密钥
docker compose -f compose.external-db.yaml pull
docker compose -f compose.external-db.yaml run --rm migrate
docker compose -f compose.external-db.yaml --profile operations run --rm bootstrap
docker compose -f compose.external-db.yaml up -d app
curl -fsS http://your-host.example:48731/health/ready
```

外部库建议使用 `DATABASE_SSL_MODE=verify-full` 和 CA secret；应用角色与迁移角色分开。连接池、PgBouncer、TLS、备份和“一个服务器多个 database”的完整说明见 [外部 PostgreSQL 与共享数据库服务器](EXTERNAL_DATABASE.md)。

可选 Redis 用于共享认证限流和多副本冷启动缓存。内置 Compose 可使用 `--profile cache`，外部 Redis 通过 `CACHE_URL` 指向；多副本必须配置同一个高可用 Redis。生产环境中只要配置了 `CACHE_URL`，Redis 故障就始终使认证请求 fail-closed，而不是退回各副本独立的本地计数；Compose 还默认设置 `AUTH_RATE_LIMIT_REQUIRE_SHARED=true`，该变量可在非生产环境强制同样行为。未配置 Redis 时使用本地限流，只适合单进程部署。权威任务写入、同步和冷启动投影缓存回退均不依赖 Redis 可用性。

## 升级/回滚

升级前先按 [BACKUP_RESTORE.md](BACKUP_RESTORE.md) 生成并校验备份，再把 `.env` 中的 `APP_VERSION` 改为目标版本：

```bash
export APP_VERSION=0.2.0
docker compose pull
docker compose up -d app
curl -fsS http://your-host.example:48731/health/ready  # 使用 HTTPS 或自定义端口时按 APP_ORIGIN 修改
```

迁移 job 成功后再切换 app；`/health/live` 只证明进程存活，`/health/ready` 才用于确认 PostgreSQL schema 已就绪。迁移失败时不要替换正在运行的 app；不兼容 schema 按恢复文档在新卷恢复旧备份。

预发布版本也可以部署，但必须使用它自己的版本号，例如 `APP_VERSION=0.2.0-rc.1`。预发布镜像不会使用 `latest` 标签；升级后应检查 `/version` 的 `appVersion` 与 `.env` 中的 `APP_VERSION` 一致，避免旧镜像或旧 Service Worker 继续提供旧版资源。
