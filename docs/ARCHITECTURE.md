# 架构

## 拓扑

Web/PWA 与 Electron 加载 React Web 产物；Android 使用独立 Jetpack Compose 原生 UI、Room、OkHttp 和同一 v2 API/同步协议。Web 通过 Dexie 读本地数据，Electron 复用 Web 数据层并由安全 preload 提供桌面能力，Android 通过 Room 读本地数据。所有客户端通过 Fastify REST 推送/拉取；WebSocket 只发送认证后的 `sync.required` 失效通知。生产入口是 Caddy → Fastify → PostgreSQL，数据库没有宿主机端口映射。

## 包边界

- `packages/contracts`：Zod 输入、DTO、枚举和 UUIDv7。
- `packages/domain`：无 UI 的状态机、日期、rank、引用 ID、Markdown 安全渲染规则。
- `packages/database`：Drizzle 描述、显式 SQL migration、连接池和 ready 检查。
- `apps/api`：认证、Owner 限定的资源端点、同步协议和 PostgreSQL adapter。
- `packages/sync-client`：IndexedDB/Dexie v2 schema、v1 outbox 转换、push/pull、冲突记录、tombstone 和重同步。
- `apps/web`：React/PWA 目录树、混合排序、工作流、步骤、日期/Placement 和删除预览界面。
- `apps/desktop`：安全 BrowserWindow/preload、平台安全存储、桌面中枢地址隔离和全局快捷键。
- `apps/mobile`：Capacitor 工程与 `apps/mobile/android` 原生 Compose/Room 客户端；原生客户端不依赖 React 页面来满足 v2 功能。
- `apps/api/src/tree-store.ts`：Owner-scoped v2 目录树、归档操作、Workflow、TaskStep、时间点/Placement 以及内存迁移投影。
- `apps/api/src/postgres-tree-store.ts`：PostgreSQL v2 projection 的加载、事务持久化和 v2 change feed 适配。
- 主题：Web 使用 `prefers-color-scheme`，Electron 使用 `nativeTheme`，Android 使用 `Configuration.uiMode` 同步系统栏并向 WebView 派发主题事件；主题是设备运行时状态，不进入账号同步设置。

路由只做解析、认证和响应映射；Task 与 Placement 语义集中在 Store 调用的领域函数中。所有资源取值先检查 `ownerId`，随机 UUID 不能代替授权检查。

## 不变量

1. Task 只保存一个真实状态；目录、日期和多个 Workflow Membership/Placement 都只引用同一 `taskId`。
2. `(task_id, time_point_id)` 的活动 Placement 使用部分唯一索引。
3. Task 完成不改变 Placement 或 Event 状态；Event 到达不改变 Task。
4. v2 Task 只有一个 `parentFolderId`；旧 `projectId/category/priority` 仅在兼容存储/迁移边界保留，不进入 v2 DTO/UI。
5. 每次版本更新都检查 `baseVersion`；失败返回 `VERSION_CONFLICT` 和服务器快照。
6. mutation receipt、领域写入、版本递增和 change feed 在同一 Store mutation 中提交。
7. Folder 归档为一次有 operationId 的逐实体写入；恢复只恢复该 operationId 写入的边界，不误恢复此前已归档的后代。删除预览的 fingerprint/token 过期或变化时 fail-closed，并为 Folder、Task、Note、Step、Placement、Membership 产生 tombstone。
8. Folder aggregate/status 是由未归档、未删除后代 Task 迭代派生的只读结果，不进入持久化状态或 change feed。
9. 同一 Task 可进入多个 Workflow；同一 Workflow 内活动 Membership 唯一。TaskStep 的状态和 completedAt 独立于 Task.status。

## ADR

- [0001 Store persistence](adr/0001-store-persistence.md)：说明 PostgreSQL 权威存储、owner-scoped SQL、事务内 change/receipt 和容量升级边界。
- [0002 Client packaging and placement interactions](adr/0002-client-packaging-and-placement-interactions.md)：说明 Electron builder、原生桌面拖拽、键盘等价操作和移动端 Bottom Sheet 的 V1 取舍。
- [深色模式](DARK_MODE.md)：说明三端系统主题读取、共享颜色令牌和验收边界。
