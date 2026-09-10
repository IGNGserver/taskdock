# 架构

## 拓扑

Browser、iOS PWA、Electron 和 Capacitor 都加载同一份 React Web 产物。前台 UI 通过 Dexie 读本地数据，通过 Fastify REST 推送/拉取；WebSocket 只发送 `sync.required` 失效通知。生产入口是 Caddy → Fastify → PostgreSQL，数据库没有宿主机端口映射。

## 包边界

- `packages/contracts`：Zod 输入、DTO、枚举和 UUIDv7。
- `packages/domain`：无 UI 的状态机、日期、rank、引用 ID、Markdown 安全渲染规则。
- `packages/database`：Drizzle 描述、显式 SQL migration、连接池和 ready 检查。
- `apps/api`：认证、Owner 限定的资源端点、同步协议和 PostgreSQL adapter。
- `packages/sync-client`：IndexedDB/Dexie schema、outbox、push/pull、冲突记录和重同步。
- `apps/web`：唯一产品界面和 PWA 应用壳。
- `apps/desktop`：安全 BrowserWindow/preload、平台安全存储、桌面中枢地址隔离和全局快捷键。
- `apps/mobile`：Capacitor 配置与生命周期/安全存储接口边界。
- 主题：Web 使用 `prefers-color-scheme`，Electron 使用 `nativeTheme`，Android 使用 `Configuration.uiMode` 同步系统栏并向 WebView 派发主题事件；主题是设备运行时状态，不进入账号同步设置。

路由只做解析、认证和响应映射；Task 与 Placement 语义集中在 Store 调用的领域函数中。所有资源取值先检查 `ownerId`，随机 UUID 不能代替授权检查。

## 不变量

1. Task 只保存一个真实状态；多个 Placement 只引用同一 `taskId`。
2. `(task_id, time_point_id)` 的活动 Placement 使用部分唯一索引。
3. Task 完成不改变 Placement 或 Event 状态；Event 到达不改变 Task。
4. 全局任务只能是 `projectId = null` 且 `category = MISC`。
5. 每次版本更新都检查 `baseVersion`；失败返回 `VERSION_CONFLICT` 和服务器快照。
6. mutation receipt、领域写入、版本递增和 change feed 在同一 Store mutation 中提交。
7. 归档是可见性字段；恢复不会丢 Note、安排或引用。

## ADR

- [0001 Store persistence](adr/0001-store-persistence.md)：说明 PostgreSQL 权威存储、owner-scoped SQL、事务内 change/receipt 和容量升级边界。
- [0002 Client packaging and placement interactions](adr/0002-client-packaging-and-placement-interactions.md)：说明 Electron builder、原生桌面拖拽、键盘等价操作和移动端 Bottom Sheet 的 V1 取舍。
- [深色模式](DARK_MODE.md)：说明三端系统主题读取、共享颜色令牌和验收边界。
