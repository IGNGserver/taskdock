# 工作区、分支与构建区

官网源码已经并入产品仓库的 `website/`，不再有独立的站点仓库。Git 纪律、worktree 路径与生命周期
以仓库根目录 `AGENTS.md` 和设备级规范为准；本文只记录站点相关的差异。

## 目录布局

```text
~/项目/todo-list工具/                  # 产品仓库锚点，不用于开发（产品默认分支 master）
~/项目/.wt/todo-list工具/<task-slug>/  # 任务 worktree，唯一开发位置
  └─ website/                          # 官网源码
      ├─ site/                         # 静态源文件
      ├─ scripts/build-site.mjs        # 注入最新发布并生成 dist/
      ├─ scripts/check-site.mjs        # 静态检查
      └─ docs/                         # 站点文档
```

所有改动都从 `origin/master` 建 worktree，不在主目录改文件或建提交。

## 创建任务 worktree

```bash
REPO=~/项目/todo-list工具
git -C "$REPO" fetch origin --prune
BASE=$(git -C "$REPO" symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|^origin/||')
test "$BASE" = master
PATH="$HOME/.local/bin:$PATH" wt new todo-list工具 taskdock-site
```

`wt` 不可用时的等价命令：

```bash
git -C "$REPO" worktree add ~/项目/.wt/todo-list工具/taskdock-site -b agent/taskdock-site origin/master
```

使用等价命令时也必须确认 worktree 的 `HEAD` 与创建时的 `origin/master` 一致。

## 构建与检查

站点没有 npm 依赖；`build-site.mjs` 只用 Node 标准库。构建与检查在本机盘 scratch 里做，
避免把 `dist/` 写回 NAS 项目卷：

```bash
WT=~/项目/.wt/todo-list工具/<task-slug>
SCR=${BUILD_SCRATCH_ROOT:-$HOME/.build}/todo-list工具/<task-slug>
mkdir -p "$SCR"
rsync -a --delete --exclude dist "$WT/website/" "$SCR/"
cd "$SCR" && GITHUB_TOKEN="$(gh auth token)" node scripts/build-site.mjs
node scripts/check-site.mjs dist
```

- `dist/` 是不可提交的构建产物，已在 `website/.gitignore` 与根 `.gitignore` 中忽略；
- 版本/日期/渠道/APK 名称由构建脚本从 GitHub Releases 注入；浏览器端 `release.js` 仍会刷新一次；
- 避免在本机卷上运行产品根的 `pnpm install` 来构建站点；站点不依赖产品 workspace。

## 收尾

```bash
cd ~/项目/.wt/todo-list工具/<task-slug>
git status --short
git diff --check
node website/scripts/check-site.mjs website/site
git push -u origin agent/<task-slug>
PATH="$HOME/.local/bin:$PATH" wt done todo-list工具 <task-slug>
```

`wt done` 遇到未提交或未推送内容会保护性停止；清理前必须确认没有未提交改动。

## 集成与部署

产品默认分支是 `master`；`main` 不是基线。站点改动由 `.github/workflows/website.yml` 在合并后自动构建并
部署到 Cloudflare Pages，不再手动上传 artifact。部署与回滚细节见 [`HOSTING.md`](HOSTING.md)。
