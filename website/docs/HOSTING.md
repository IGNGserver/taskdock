# 托管与部署（Cloudflare Pages）

> 正式站点：<https://taskdock.igng.net/>。站点源码在产品仓库 `taskdock/website/`，部署由
> `.github/workflows/website.yml` 完成。旧的独立仓库 `IGNGserver/taskdock-website` 已归档。

## 当前配置

| 项         | 值                                                               |
| ---------- | ---------------------------------------------------------------- |
| Pages 项目 | `taskdock-website`（Direct Upload）                              |
| 部署来源   | `IGNGserver/taskdock` 的 `website/`                              |
| 部署工作流 | `.github/workflows/website.yml`                                  |
| 生产分支   | `master`（产品仓库默认分支）                                     |
| 构建命令   | `node scripts/build-site.mjs`（在 `website/` 下，无 npm 依赖）   |
| 发布目录   | `website/dist/`                                                  |
| 自定义域名 | `https://taskdock.igng.net/`（zone `igng.net`）                  |
| 默认别名   | `https://taskdock-website.pages.dev/`（保留）                    |
| DNS        | proxied CNAME `taskdock.igng.net` → `taskdock-website.pages.dev` |

`build-site.mjs` 从 GitHub Releases 取最新发布，注入版本、发布日期、渠道（预览版/正式版）和 APK 名称；
`check-site.mjs` 检查元信息、站内链接与锚点、外部资源、脚本语法与体积预算。两者都在部署前运行。
`taskdock.pages.dev` 是产品站地址，不属于本官网项目。

## 自动部署

`website.yml` 在这些时机运行：

- `push` 到 `master` 且改动涉及 `website/**`：构建并部署；
- `Release` 工作流创建完 GitHub Release 后发送 `repository_dispatch`（`release-published`）：
  重新注入版本与 APK 信息并部署；
- `pull_request`：只构建 + 检查，不部署；
- `workflow_dispatch`：手动构建与部署。

`release: published` 不能用于这条链路：Release 由 `GITHUB_TOKEN` 创建时，GitHub 不会为它触发新的工作流；
`repository_dispatch` 是例外。

需要两个 repository secrets：

| Secret                  | 用途                                       |
| ----------------------- | ------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | 最小权限 token，仅需 Cloudflare Pages:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID                         |

凭据只放 GitHub Actions Secrets，不写进仓库、文档、日志或前端产物。继续复用现有 Direct Upload 项目，
不要新建项目或改成 Git 集成。

## 构建参数

| 项         | 值                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------- |
| 运行时     | Node.js ≥ 22（内置 `fetch` 与 `fs.cp`）                                                            |
| 站点源目录 | `website/site/`                                                                                    |
| 生成目录   | `website/dist/`（不入库）                                                                          |
| 响应头     | `website/site/_headers`：CSP、`nosniff`、`frame-ancestors 'none'`、静态资源缓存                    |
| 404        | `website/site/404.html`，资源使用根路径                                                            |
| 外部请求   | 浏览器读取 `https://api.github.com/repos/IGNGserver/taskdock/releases`（CSP `connect-src` 已放行） |

## 发布与回滚

- 正常发布：合并到 `master` 或发布新 Release，工作流自动部署；
- 回滚：Cloudflare Pages 项目 → Deployments 选择上一个成功部署恢复；
- 迁移前生产部署：`15870b27-a30d-4965-a570-4569c8e2edfe`（2026-10-17，提交 `364bc72`）；
  回滚点：`ac9ea14c-e293-46d2-a07b-e9e50bd80e50`（提交 `3f07f6f`）；
- 迁移后的首次自动部署 ID 在部署记录里补记，并以它作为新的回滚点；
- 域名变更：修改 DNS 前记录原值；当前是 proxied CNAME `taskdock.igng.net` → `taskdock-website.pages.dev`，
  改动必须同步 Pages 自定义域名。

## 搜索收录

- Bing Webmaster Tools：站点 `https://taskdock.igng.net/` 已验证所有权（2026-10-17），首页
  `<meta name="msvalidate.01" content="B411826ACAE5C5CD20EA5574C3F8A6E4">` 不能删除；`/sitemap.xml`
  （2 条 URL）与 `/`、`/download` 已提交。
- Google Search Console：域名资源 `sc-domain:igng.net` 已覆盖；`website/site/sitemap.xml` 与 canonical
  一律使用干净地址（Pages 会把 `/download.html` 308 到 `/download`）。
- GSC 的 sitemap 提交与 Request Indexing 只能在控制台 UI 做。

## 历史

- 2026-10-15：首版站点上线 Cloudflare Pages，项目 `taskdock-website`。
- 2026-10-17：绑定 `taskdock.igng.net`，手动 Direct Upload 生产部署 `15870b27`。
- 2026-10-25：站点代码并入产品仓库 `website/`，改为 GitHub Actions 自动部署；独立仓库归档。
