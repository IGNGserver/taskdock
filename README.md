# TaskDock

TaskDock 是一个为个人开发者准备的任务工作台。

它适合记录“想做什么”、安排“什么时候做”，也适合保存任务相关的开发笔记。TaskDock 可以自己部署在家里的 NAS、服务器或云主机上；网络暂时不可用时，已经打开过的数据仍然可以查看和编辑，网络恢复后会自动同步。

> **当前定位：** 单用户、自托管、离线优先。
>
> **当前状态：** 项目仍在早期版本阶段。请在正式使用前先备份数据，并根据发布页的说明选择稳定版或预览版。

## TaskDock 能做什么

- **快速记下任务**：先把想法记下来，不需要一开始就填写复杂表单。
- **按日期或事件安排**：同一个任务可以安排到今天、某个日期，或“额度重置后”“上线前”这类自定义事件中。
- **项目和全局任务统一管理**：项目功能、项目杂项和不属于任何项目的事情可以放在一起管理。
- **开发备注**：每个任务都可以保存 Markdown 笔记，适合记录思路、命令、链接和处理过程。
- **离线优先**：中枢暂时不可用时，客户端仍可继续处理本地已有内容；恢复连接后再同步。
- **多端使用**：同一套数据可通过浏览器、桌面客户端和 Android 客户端访问。
- **自己掌握数据**：数据存放在你自己的服务器和 PostgreSQL 数据库中，不依赖第三方任务平台。

## 下载客户端

请前往 GitHub 的 [Releases](https://github.com/IGNGserver/taskdock/releases) 页面下载客户端安装包。

每个版本会尽量提供当前已支持平台的安装包：

- **Windows**：安装程序（`.exe`）
- **Linux**：桌面客户端压缩包（`.tar.gz`）
- **Android**：APK 安装包（`.apk`）
- **Docker**：服务器镜像，可用于部署 TaskDock 中枢

macOS 和 iOS 客户端尚未作为正式安装包发布。不要把“构建成功”理解为已经完成真实设备验收；请以每个版本发布说明中的平台状态为准。

## 最简单的使用方式：直接部署 Docker

Docker 部署不需要从仓库下载源代码，也不需要在服务器上安装 Node.js。发布版本会生成 Docker 镜像，镜像发布在 GitHub Container Registry（GHCR）。

### 1. 准备文件

在服务器上建立一个空目录，下载以下两个文件：

- [`compose.yaml`](https://github.com/IGNGserver/taskdock/blob/master/compose.yaml)
- [`.env.example`](https://github.com/IGNGserver/taskdock/blob/master/.env.example)

然后复制环境变量文件：

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

- `TASKDOCK_PORT`：TaskDock 默认对外 HTTP 端口，默认是 `48731`；如果 NAS 上该端口已被占用，可以改成其他五位端口
- `APP_ORIGIN`：用户访问 TaskDock 的 HTTP 或 HTTPS 地址，例如 `https://tasks.example.com` 或 `http://192.168.1.10:48731`。使用 HTTP 时页面会显示安全警告，公网环境建议使用 HTTPS
- `POSTGRES_PASSWORD`：数据库密码
- `BOOTSTRAP_TOKEN`：部署中枢首次初始化 Owner 时使用的一次性令牌，客户端不会要求填写
- `OWNER_USERNAME` / `OWNER_PASSWORD`：部署中枢首次初始化 Owner 时使用；密码至少 6 位，6 位纯数字也可以
- `ACCESS_TOKEN_SECRET`：访问令牌密钥
- `REFRESH_TOKEN_PEPPER`：刷新令牌保护密钥
- `CORS_ALLOWED_ORIGINS`：允许访问的前端地址，通常与 `APP_ORIGIN` 相同

首次初始化 Owner 时，用户密码至少 6 位，不限制数字、字母或其他字符，也没有最大长度限制。

随机密钥可以用下面的命令生成：

```bash
openssl rand -base64 48
```

### 2. 选择版本并启动

推荐使用明确的版本号，方便升级和回滚：

```bash
export APP_VERSION=0.1.0

docker compose pull
docker compose --profile operations run --rm migrate
docker compose up -d
```

也可以使用 `latest`：

```bash
export APP_VERSION=latest

docker compose pull
docker compose --profile operations run --rm migrate
docker compose up -d
```

TaskDock 的 Docker 部署使用已经构建好的版本镜像，不会在服务器上拉取仓库最新代码，也不会在服务器上重新编译项目。生产环境建议固定具体版本号；只有你明确接受自动跟随最新稳定版本时，才使用 `latest`。

> **数据库卷提示：** 当前 Docker 镜像使用 PostgreSQL 18 的标准数据目录。若你曾经使用早期版本的 `compose.yaml` 创建过数据库卷，升级前请先按 [备份与恢复](docs/BACKUP_RESTORE.md) 完成备份，并使用备份恢复到新的数据库卷；不要直接删除旧卷。

默认 Docker 部署会直接通过 `TASKDOCK_PORT` 提供 HTTP 服务，默认访问地址是 `http://服务器地址:48731`。首次部署时，在 `.env` 中填写 Owner 用户名和密码，并执行 `docker compose --profile operations run --rm bootstrap` 完成初始化；客户端不会显示初始化令牌输入框。初始化成功后，应从 `.env` 中删除 `OWNER_PASSWORD`，并删除或轮换 `BOOTSTRAP_TOKEN`。

### 3. 升级

升级前先备份数据库，然后修改 `.env` 中的 `APP_VERSION`：

```bash
# 例如从 0.1.0 升级到 0.2.0
export APP_VERSION=0.2.0

docker compose pull
docker compose --profile operations run --rm migrate
docker compose up -d
```

如果升级后出现问题，可以把 `APP_VERSION` 改回上一个版本，并根据备份恢复文档处理数据库：

- [部署说明](docs/DEPLOYMENT.md)
- [备份与恢复](docs/BACKUP_RESTORE.md)

## 浏览器和本地开发

如果你只是想试用界面，可以在本机运行开发模式：

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

然后打开 <http://localhost:5173>。

开发模式默认使用本地内存数据，适合体验界面和功能；需要长期保存数据时，请使用 Docker + PostgreSQL 部署方式。

## 数据和隐私

TaskDock 的设计目标是让用户自己掌握数据：

- 任务、安排和笔记保存在自托管中枢的 PostgreSQL 中；
- 客户端会保存必要的本地缓存和待同步操作；
- Docker Compose 默认不会把 PostgreSQL 端口暴露到公网；TaskDock 默认通过 `48731` 提供 HTTP 访问；
- 访问令牌、数据库密码和其他密钥不应提交到 GitHub；
- 生产环境建议使用 HTTPS，并定期执行备份和恢复演练。TaskDock 也支持 HTTP 外网地址，但会显示安全警告；HTTP 会明文传输密码和会话信息，请仅在可信内网或测试环境使用。

请阅读 [安全说明](docs/SECURITY.md) 和 [备份与恢复](docs/BACKUP_RESTORE.md) 后再用于重要数据。

## 版本规则

TaskDock 的版本采用语义化版本号，例如 `0.1.0`、`0.2.0-rc.1`。

- 普通发布默认是 **预发布版本**，例如 `0.2.0-rc.1`；
- 只有明确选择“正式发布”时，才会生成正式 Release，例如 `0.2.0`；
- `latest` 只指向正式稳定版本，不会指向预发布版本；
- 预发布版本始终可以通过自己的版本号镜像标签使用，例如 `0.2.0-rc.1`；
- 每次发布都必须在 GitHub Release 中用中文说明本次更新内容、已知问题和平台安装包状态。

详细规则见 [发布规范](docs/RELEASING.md)。

## 项目文档

- [部署说明](docs/DEPLOYMENT.md)
- [备份与恢复](docs/BACKUP_RESTORE.md)
- [安全说明](docs/SECURITY.md)
- [同步说明](docs/SYNC_PROTOCOL.md)
- [当前状态](docs/STATUS.md)
- [发布规范](docs/RELEASING.md)

## 许可证

当前仓库尚未确定最终开源许可证。正式对外分发前，请先补充许可证文件。
