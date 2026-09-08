# 同步协议

协议版本：`1`。客户端按 `hub origin + owner id` 建立 Dexie 数据库，stores 为 projects、tasks、notes、timePoints、placements、settings、outbox、conflicts、syncMeta。

## 启动与写入

UI 先读本地表，不等待网络；网络恢复时按客户端顺序 push outbox，再从确认的 cursor pull。实体写入和 outbox 入队应位于同一个 IndexedDB 事务；提交后 UI 标记“待同步”。网络错误使用带抖动指数退避，认证错误暂停并要求重新登录，验证错误留在可见失败队列。

## Push

`POST /sync/push` 包含 `protocolVersion`、稳定 `clientId` 和最多 500 个 mutation。每条 mutation 有 `mutationId`、`command`、`entityId`、`baseVersion`、`occurredAt`、`payload`。服务器逐条返回 `applied`、`conflict` 或 `rejected`。同一 mutation 重试只读取 receipt。

## Pull/snapshot

cursor 是不透明十进制字符串。Pull 返回完整实体快照或 tombstone，客户端在事务成功后才推进 cursor。过期 cursor 返回 `SYNC_CURSOR_EXPIRED`；客户端保留 outbox/conflicts，下载一致 snapshot，再按原顺序重放未确认 mutation。

普通 REST 列表使用独立的不透明 keyset 游标（默认 100、最大 500），由 Web repository 聚合；同步 cursor 只用于 change feed，二者不能互换。V1 snapshot 是一次性、带一致性游标的完整 Owner 快照，不拆成普通列表页，以保证替换本地数据与游标推进的原子边界。完整快照的容量上限和后续分页升级条件见 [ADR 0001](adr/0001-store-persistence.md)。

## 冲突

版本不匹配时保留本地意图和服务端快照，不静默覆盖。Note UI 应提供采用本地、采用服务器、合并后保存；Task/Project/TimePoint 展示冲突字段。活动 Placement 重复视为幂等成功；被归档/删除实体上的更新需由用户选择恢复应用或丢弃。

WebSocket `/api/v1/ws` 认证后只发送 `{ "type": "sync.required", "cursor": "..." }`，不传业务正文。断线时由 30 秒轮询、focus、online 和移动端回前台兜底。
