# TaskDock 官网 · TaskDock Website

TaskDock 的产品官网与下载入口，源码位于产品仓库的 `website/`：

- 产品仓库（唯一事实来源）：<https://github.com/IGNGserver/taskdock>（默认分支 `master`）
- 正式站点：<https://taskdock.igng.net/>（Cloudflare Pages 项目 `taskdock-website`）
- 部署：`.github/workflows/website.yml` 在 `master` 和正式发版后自动构建并上传 `dist/`

站点是零依赖静态页面：`site/` 下是源文件，`scripts/build-site.mjs` 从 GitHub Releases 取最新发布，
注入版本、日期、渠道和 APK 名称到 `dist/`，再由 Cloudflare Pages 发布。浏览器端 `release.js`
仍会在页面加载后刷新一次版本信息。

## 目录结构

| 路径                     | 内容                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `site/`                  | 站点源文件：首页、下载/部署页、404、`assets/`、`_headers`、`sitemap.xml`、`robots.txt` |
| `scripts/build-site.mjs` | 生成 `dist/`，注入最新发布版本/日期/渠道/APK 名称                                      |
| `scripts/check-site.mjs` | 静态检查：元信息、站内链接与锚点、外部资源、脚本语法、体积预算                         |
| `docs/SITE.md`           | 官网定位、设计系统、内容事实来源与维护                                                 |
| `docs/HOSTING.md`        | Cloudflare 托管、自动部署与回滚                                                        |
| `docs/WORKSPACE.md`      | 本机 worktree 与验证约定                                                               |

## 开发

```bash
cd website
GITHUB_TOKEN="$(gh auth token)" node scripts/build-site.mjs
node scripts/check-site.mjs dist
python3 -m http.server -d dist 8765
```

站点没有前端依赖，构建脚本只用 Node 标准库。`package.json` 只用于把 npm 的包边界固定在 `website/`，
避免部署工具向上读到产品根的 Node 引擎约束；不要在这里添加前端依赖。`dist/` 是生成产物，不提交。
构建与检查的 scratch 步骤见 [`docs/WORKSPACE.md`](docs/WORKSPACE.md)。

## 许可

[MIT](../LICENSE)
