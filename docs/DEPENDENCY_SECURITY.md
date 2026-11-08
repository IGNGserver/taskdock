# 依赖安全审计

## 门禁

使用 npm 官方审计端点；镜像端点可能不存在或延迟同步元数据：

```bash
corepack pnpm audit --audit-level=high --registry=https://registry.npmjs.org
```

发布前必须确认没有 high/critical 告警。不要用忽略告警代替可达性分析。生产镜像只安装生产依赖，但 Web PWA 构建工具仍会在 CI 构建阶段执行，因此构建链也纳入检查。

## 已修复

- DOMPurify 3.4.17+、sanitize-html 2.18+：不可信 Markdown/HTML 清洗。
- Fastify 5.12.5+、@fastify/static 10.1.2+：HTTP 与静态文件路径处理。
- Zod 4.6.6+、Drizzle ORM 0.45.2+：请求校验与 SQL 标识符处理。
- Vitest 4.1.12+、Tinypool 2.1.2+：测试执行器与 worker 参数处理。
- Vite 7.3.7+，以及 brace-expansion、fast-uri、source-map-js、serialize-javascript 的修复版本。
- glob/minimatch 只覆盖到兼容当前 Node 24 工具链的版本，并通过完整 lint、测试和构建验证，不能机械地对所有主版本做 override。

## 剩余告警与可达性（2026-11-08）

`pnpm audit` 仍报告两个没有兼容升级路径的告警：

1. **moderate — uuid 7.0.3（GHSA-w5hq-g745-h8pq）**：仅由 `apps/mobile` 开发依赖 `@capacitor/cli -> xcode` 引入，不进入 API、Web 或 Android 运行产物。公告影响调用 `v3/v5/v6` 且显式传入 `buf` 的用法；本仓库不直接调用这些 API。Capacitor/Xcode 上游未提供兼容 UUID 11 的依赖组合，禁止用主版本 override 破坏原生工程生成。
2. **low — deepmerge 4.3.1（GHSA-gcqx-w48m-w2h4）**：仅由构建期 `vite-plugin-pwa -> workbox-build -> @rollup/plugin-node-resolve` 引入。输入是仓库内受信任的静态构建配置，不合并网络或用户提供的对象。审计公告给出的 4.3.2 在检查时未由 npm registry 发布，不能生成不可复现的 override。

每次上游更新后重新运行审计；一旦上游发布兼容修复，应移除本节的临时结论并升级。任何把这些构建工具改为处理不可信配置的改动，都必须先重新评估上述风险。
