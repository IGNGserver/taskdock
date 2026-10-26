# 官网定位与范围（SITE）

> 本文为后续开发者（含 AI 会话）提供站点上下文。范围或技术决策变化时同步更新本文件。

## 是什么

TaskDock 的产品官网：介绍产品、提供下载与部署入口和文档链接，并作为搜索引擎与 AI 工具的可引用入口。
站点源码位于产品仓库的 `website/`：

| 事项                                | 归属                                                |
| ----------------------------------- | --------------------------------------------------- |
| 产品功能、版本、发布资产、产品文档  | 产品仓库 `IGNGserver/taskdock`（默认分支 `master`） |
| 页面、样式、静态资源、SEO、站点文案 | `IGNGserver/taskdock/website/`                      |

产品定位（以产品仓库 `README.md` 为准）：面向个人开发者的离线优先、自托管任务工作台，单用户使用；
数据存放在用户自己的服务器与 PostgreSQL 数据库。当前活动客户端是响应式 Web/PWA 与原生 Android；
桌面客户端已停止维护（产品 `CHANGELOG.md`，2.0.0-rc.37 起），站点不再介绍。
中枢以 Docker 镜像发布在 GitHub Container Registry（GHCR）。

## 当前状态（2026-10-25）

- 首页、下载与部署页、404 页已实现；
- 已部署到 Cloudflare Pages 项目 `taskdock-website`，正式地址为 <https://taskdock.igng.net/>（默认别名
  <https://taskdock-website.pages.dev/>）；
- `.github/workflows/website.yml` 在 `master` 和正式发版后自动构建并部署；线上版本来自最新发布
  （当前 2.0.0-rc.59）；
- 旧的独立仓库 `IGNGserver/taskdock-website` 已归档，代码与历史以产品仓库为准。

## 已定案的决策

| 事项                    | 决定                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 技术栈                  | 零依赖静态站点：`website/site/` 下手写 HTML + CSS + 原生 ES 模块 JS；无框架、无 `package.json`；部署前由 Node 标准库脚本 `website/scripts/build-site.mjs` 注入最新发布并生成 `dist/` |
| 页面                    | `index.html`（首页）、`download.html`（下载与部署）、`404.html`；文档入口链接到产品仓库 `docs/`，不在本站复制文档                                                                    |
| 语言                    | 简体中文单语（与产品文档一致）；`<html lang="zh-CN">`                                                                                                                                |
| 视觉方向                | 见下文“设计系统”                                                                                                                                                                     |
| Cloudflare Pages 与地址 | 项目 `taskdock-website`；正式地址 `https://taskdock.igng.net/`，默认别名 `https://taskdock-website.pages.dev/`，见 `docs/HOSTING.md`                                                 |

## 目录结构

```text
website/
  site/
    index.html          首页
    download.html       下载与部署
    404.html            未找到页（资源使用根路径）
    _headers            Cloudflare 响应头（CSP、缓存）
    robots.txt
    assets/css/site.css 全站样式与设计令牌
    assets/js/          ES 模块，按页面动态加载
      main.js           入口：顶栏、入场动效、复制、按页面加载交互模块
      spring.js         弹簧积分器与动画循环
      hero-field.js     首屏“散落 → 归位”物理场
      dimensions.js     “一个任务，四个维度”视图切换
      timeline.js       日期与时间点拖放演示
      sync-demo.js      离线同步与冲突演示
      release.js        最新版本读取（GitHub 公共 API，带兜底）
      rail.js           下载页部署步骤进度
      lost.js           404 卡片
    assets/img/         品牌图标的缩放派生图
  scripts/build-site.mjs  注入最新发布并生成 dist/
  scripts/check-site.mjs  站点静态检查（本地与 CI 共用）
```

## 设计系统

**艺术方向：夜港（Night Harbor）。** 核心概念是“混乱的任务逐渐归位”：首屏散落漂浮的任务卡随滚动被磁吸进目录面板，
按状态分组归位；卡片可拖动，散落时可以甩开，归位后可以在组内重排，点状态圆圈会移动到对应分组。

- **颜色**：深墨蓝底（`--ink-*`）与鼠尾草绿（`--sage`）取自品牌图标。绿色只表示“已归位 / 已完成 / 已同步”，
  琥珀（`--amber`）只表示“进行中 / 待同步 / 事件”，玫瑰色（`--rose`）只表示“离线 / 冲突”。只有深色主题。
- **字体**：系统字体栈（PingFang SC / 微软雅黑 / Noto Sans SC 等），等宽字体用于编号、命令与元信息；不加载网络字体。
- **物件**：任务卡（`.tcard`）与三态状态圆圈（`.status`：待开始 → 进行中 → 已完成）是全站共用的视觉单元，
  与产品目录页的三态循环一致。
- **动效**：位移类动画用 `spring.js` 的弹簧积分；CSS 过渡使用由阻尼弹簧采样得到的 `linear()` 曲线
  （`--spring-snappy` / `--spring-soft`）。视图切换用 View Transitions（同文档与跨文档），不支持的浏览器直接切换。
  所有动效遵循 `prefers-reduced-motion`：减弱动效时首屏直接呈现归位状态，小屏只保留文案。
- **背景**：极淡的蓝图网格，作为“秩序”的底纹。

## 内容原则与事实来源

- 只陈述产品仓库当前支持的事实，不编造路线图；版本与平台矩阵以产品仓库 `README.md` 与 Releases 为准；
- 产品当前发布均为 `2.0.0-rc.*` 预览版（pre-release），站点不得把预览版描述为稳定版；
- 下载链接指向产品仓库的 Releases，不在本仓库托管安装包；
- 品牌名统一使用 “TaskDock”。

站点上的产品事实与出处（改文案前先核对产品仓库当前版本）：

| 站点内容                                                                       | 产品仓库出处                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 目录树、日期与时间点、流程、执行步骤四个维度；文件夹状态推导；一个任务多处安排 | `docs/V2_TREE_WORKFLOW_DEVELOPMENT.md`、`docs/ARCHITECTURE.md`（不变量） |
| 顺延只复制未完成的安排、可撤销、离线拒绝；事件到达不改任务                     | `docs/API.md`、`docs/ARCHITECTURE.md`                                    |
| 先读本地、待同步队列、按顺序推送、冲突保留双方、WebSocket 只发信号             | `docs/SYNC_PROTOCOL.md`                                                  |
| Docker 部署步骤、`.env` 变量、端口 48731、Owner 初始化、升级与回滚             | `README.md`、`docs/DEPLOYMENT.md`、`compose.yaml`                        |
| PWA 安装与离线打开需要 HTTPS                                                   | `docs/DEPLOYMENT.md`                                                     |
| 命令面板（⌘K / Ctrl K）、移动端右滑完成与左滑菜单、三态状态圆圈                | `apps/web/src/App.tsx`、`CHANGELOG.md`（rc.24、rc.28）                   |
| 版本规则（预发布默认、`latest` 只指向正式版）                                  | `README.md`、`docs/RELEASING.md`                                         |

## 维护

- **版本兜底**：部署前 `scripts/build-site.mjs` 从 GitHub Releases 取最新发布，注入 `site/index.html`、
  `site/download.html` 与 `site/assets/js/release.js` 的 `FALLBACK`；页面加载后 `release.js` 仍会向
  GitHub 刷新一次。无需手工改版本号（搜索 `2.0.0-rc.` 只用于排查残留）。
- **品牌图标**：`site/assets/img/taskdock-icon-*.png` 由产品仓库 `assets/branding/taskdock-icon.png` 缩放得到，
  不得重绘。重新生成（macOS）：`sips -s format png -z <N> <N> taskdock-icon.png --out taskdock-icon-<N>.png`，N 取 32 / 96 / 180 / 192。
- **社交分享图**：域名未定，`og:image` 需要绝对地址，暂未提供；定域名时补上。
