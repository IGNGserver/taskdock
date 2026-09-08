# TaskDock 发布规范

本文档规定 TaskDock 的版本、GitHub Release、客户端安装包和 Docker 镜像如何发布。

## 一、发布原则

1. **默认发布为预发布版本。** 不要因为版本构建成功就直接发布为稳定版。
2. **只有明确要求正式发布时，才能发布正式 Release。** GitHub Actions 的 `发布类型` 必须明确选择 `正式发布`。
3. **发布说明必须使用中文。** 每次发布都要说明：本次更新了什么、是否有不兼容变化、已知问题，以及哪些平台安装包已经提供。
4. **Docker 发布的是镜像，不是源代码。** 用户部署时使用版本号标签或 `latest` 标签，不在生产服务器上拉取仓库代码并重新构建。
5. **稳定版和预发布版严格区分。** 预发布版不能移动 `latest` 标签。
6. **正式发布前必须确认回滚路径。** 至少保留上一个可用版本的 Docker 镜像和数据库备份。

## 二、版本号

使用语义化版本号：

```text
正式版本：主版本.次版本.修订版本
示例：0.1.0、0.2.0、1.0.0

预发布版本：主版本.次版本.修订版本-阶段.序号
示例：0.2.0-rc.1、0.2.0-beta.2
```

版本输入不带 `v`，Git 标签和 GitHub Release 标签由 Workflow 自动生成：

```text
输入：0.2.0-rc.1
标签：v0.2.0-rc.1
```

版本号一旦发布不得复用。发现问题时发布新的修订版本或新的预发布序号。

## 三、如何发版

1. 确认目标提交已经合并到默认分支。
2. 确认 CI 通过，至少包括格式检查、Lint、类型检查、单元测试、集成测试和构建。
3. 打开 GitHub Actions，选择 **发布 TaskDock** Workflow，点击 **Run workflow**。
4. 填写版本号，例如 `0.2.0-rc.1`。
5. `发布类型` 保持默认的 **预发布**，除非本次明确要求稳定版。
6. 在 `中文更新说明` 中写清楚本次更新。不得填写空白、只有英文或类似“若干修复”的无效说明。
7. Workflow 会构建并上传：
   - Windows 桌面安装程序；
   - Linux 桌面客户端压缩包；
   - Android APK；
   - GHCR Docker 镜像。
8. Workflow 完成后，在 GitHub Release 页面检查发布说明和附件，再对外通知用户。

## 四、Docker 镜像标签

镜像地址：

```text
ghcr.io/igngserver/taskdock
```

每次发布都会生成版本号标签：

```text
ghcr.io/igngserver/taskdock:0.2.0-rc.1
ghcr.io/igngserver/taskdock:v0.2.0-rc.1
```

只有正式稳定版会额外更新：

```text
ghcr.io/igngserver/taskdock:0.2.0
ghcr.io/igngserver/taskdock:latest
```

建议生产环境使用具体版本号：

```bash
APP_VERSION=0.2.0 docker compose pull
```

`latest` 只适合希望自动跟随最新稳定版本、并且愿意自行承担升级风险的用户。预发布版本永远使用自己的版本号标签，不会覆盖 `latest`。

## 五、发布说明模板

每次 Release 的说明至少包含以下内容：

```markdown
## 本次更新

- 用用户能看懂的话说明新增或改进的功能。
- 用用户能看懂的话说明修复的问题。

## 使用注意

- 是否需要执行数据库迁移。
- 是否存在不兼容变化或升级前备份要求。

## 已知问题

- 当前版本仍存在的问题；没有则填写“暂无已知问题”。

## 安装包

- Windows：已提供 / 未提供，原因：
- Linux：已提供 / 未提供，原因：
- Android：已提供 / 未提供，原因：
- Docker：`ghcr.io/igngserver/taskdock:<版本号>`
```

## 六、发布后检查

发布完成后应检查：

- GitHub Release 的预发布/正式状态是否正确；
- Release 说明是否为中文且准确描述本次更新；
- Windows、Linux、Android 附件是否存在；
- Docker 镜像的版本号标签是否可以拉取；
- 正式版本的 `latest` 是否指向本次稳定版本；
- Docker 部署使用的是镜像标签，而不是仓库源代码；
- 生产升级前是否已经完成数据库备份。
