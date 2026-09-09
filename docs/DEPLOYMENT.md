# 部署

TaskDock 的生产部署使用 GitHub Container Registry 中已经构建好的 Docker 镜像。生产服务器不需要下载源代码，也不需要在服务器上重新编译项目。

## 准备

复制 `.env.example` 为 `.env`，为以下秘密分别生成至少 32 字节随机值：

```bash
openssl rand -base64 48
```

填写真实 HTTP 或 HTTPS `APP_ORIGIN`、数据库密码和显式 `CORS_ALLOWED_ORIGINS`。默认 Docker 对外 HTTP 端口是 `48731`，可通过 `TASKDOCK_PORT` 改成其他五位端口。实际秘密不进入 Git、镜像或日志。

生产环境必须设置 `DEV_MEMORY_STORE=false`（Compose 已设置），并使用随机的 `BOOTSTRAP_TOKEN`、`ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_PEPPER`。`APP_ORIGIN` 与允许的 CORS origin 必须是完整的 HTTP 或 HTTPS 地址；使用 HTTP 时页面会显示安全警告，密码和会话信息会明文传输，公网环境建议使用 HTTPS。默认部署直接由 TaskDock 应用提供 HTTP 服务，公开入口是 `TASKDOCK_PORT`（默认 `48731`）；PostgreSQL 不发布到宿主机。需要 Caddy 反向代理时，再使用 `--profile gateway`，不要同时让两个服务占用同一个宿主机端口。

## 首次部署

从 GitHub 仓库取得 `compose.yaml` 和 `.env.example` 后，在服务器上执行：

> **数据库卷提示：** 当前 Compose 使用 PostgreSQL 18 的 `/var/lib/postgresql` 数据卷布局。若旧部署使用过早期 Compose 文件，请先完成数据库备份，再按 [备份与恢复](BACKUP_RESTORE.md) 恢复到新的数据库卷；不要直接删除旧卷。

```bash
cp .env.example .env
# 编辑 .env，填入真实配置

export APP_VERSION=0.1.0
# 也可以使用 APP_VERSION=latest，但生产环境更建议固定版本号

docker compose pull
docker compose --profile operations run --rm migrate
docker compose up -d postgres app
curl -fsS http://your-host.example:48731/health/ready  # 使用 HTTPS 或自定义端口时按 APP_ORIGIN 修改
```

Compose 使用的应用镜像默认为：

```text
ghcr.io/igngserver/taskdock:${APP_VERSION}
```

如果需要使用其他镜像仓库，可以设置 `TASKDOCK_IMAGE`。不要把生产 Compose 改回 `build:`，也不要在生产服务器上执行 `git pull` 后从源代码构建。

默认情况下 app 发布 `48731:3000`，直接提供 HTTP 服务；使用 HTTP 时页面会显示安全警告，密码和会话信息会明文传输，公网环境建议使用 HTTPS。PostgreSQL 没有宿主机端口。访问 Web 后使用 bootstrap token 初始化一次 Owner，随后轮换或移除 `BOOTSTRAP_TOKEN`。

## 升级/回滚

升级前先按 [BACKUP_RESTORE.md](BACKUP_RESTORE.md) 生成并校验备份，再把 `.env` 中的 `APP_VERSION` 改为目标版本：

```bash
export APP_VERSION=0.2.0
docker compose pull
docker compose --profile operations run --rm migrate
docker compose up -d app
curl -fsS http://your-host.example:48731/health/ready  # 使用 HTTPS 或自定义端口时按 APP_ORIGIN 修改
```

迁移 job 成功后再切换 app；`/health/live` 只证明进程存活，`/health/ready` 才用于确认 PostgreSQL schema 已就绪。迁移失败时不要替换正在运行的 app；不兼容 schema 按恢复文档在新卷恢复旧备份。

预发布版本也可以部署，但必须使用它自己的版本号，例如 `APP_VERSION=0.2.0-rc.1`。预发布镜像不会使用 `latest` 标签。
