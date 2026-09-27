# todo-list工具（TaskDock / taskdock）· 项目 Agent 规范
> 只写本仓库与设备级规范的差异。Git 纪律、worktree、冲突处理见 `~/.qoder/coder-rules/global-rules.md`。

Collaboration: solo
Default branch: **master**（不是 main，新任务基线是 `origin/master`）
Integration: direct-after-validation
Release: tag + Actions（`.github/workflows/` 2 个）
Worktree: `~/项目/.wt/todo-list工具/<slug>`

## 这是什么
pnpm monorepo 的待办工具（`apps/api` 等），含 Web 与移动端体验。

## 验证命令（package.json 实测存在）
- `pnpm lint`、`pnpm typecheck`、`pnpm test`
- 集成测试：`pnpm test:integration`、`pnpm test:pg-runtime`（需要数据库，跑不动要报告而不是跳过）
- 设计令牌与品牌：`pnpm tokens:check`、`pnpm brand:sync`（改 UI 令牌时必须跑）

## 项目特殊限制
- `apps/api/src/auth.ts`、`apps/api/src/bootstrap-owner.ts` 经手凭据引导：真实口令与密钥只能走环境变量，不得写进源码、测试夹具或提交信息。
- 数据库结构变更必须带 migration，并说明存量数据如何迁移。
- 工作区当前干净（0 个未提交）：保持这个状态，新任务一律走 worktree，不要在主目录切分支。

## 集成
- 集成前 `git fetch origin --prune`；`origin/master` 前进时 `rebase origin/master` 并重跑验证。禁止 `git pull`、`git push --force`。
