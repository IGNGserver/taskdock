# ADR 0001：V1 Store 持久化边界

状态：接受（PostgreSQL 权威存储）

## 背景

开发计划要求领域规则集中、每次写入和 change feed 原子提交，同时支持没有 PostgreSQL 的本地领域测试与 Compose 生产部署。生产中不能依赖进程内快照作为状态源，也不能通过全表重写来模拟持久化。

## 决策

`MemoryStore` 仅作为单元测试和无数据库测试替身；它不代表生产持久化语义。

`PostgresStore` 将 PostgreSQL 作为唯一权威业务状态源：

- 读路径使用 owner-scoped SQL 查询、索引、keyset 分页和受控的 repeatable-read snapshot，不在启动时把业务表全量加载到内存。
- 写路径使用真实 SQL 的行级 `INSERT`、`UPDATE`、`DELETE`/墓碑更新，并通过数据库唯一约束、版本条件、行锁或原子语句保证 Owner 隔离、编号分配、幂等和并发正确性。
- 每个 mutation 在一个 PostgreSQL 事务内完成领域写入、版本递增、change feed 和 mutation receipt；事务失败时这些结果一起回滚。
- `LISTEN/NOTIFY` 只用于跨进程发出同步失效提示；pull cursor 和数据库记录仍是权威，通知丢失不会改变正确性。
- migration 由显式 job 执行；迁移按版本排序、校验 checksum 并在事务中应用，应用进程不会静默修改 schema。

同步协议仍可返回带一致性 cursor 的完整 Owner snapshot，以保证本地替换和 cursor 推进的原子边界。普通 REST 列表使用分页查询；snapshot 的容量上限和后续分页升级条件由同步协议及容量测试决定。

## 代价与边界

- 生产路径需要可用且已完成 migration 的 PostgreSQL；没有数据库时只能运行明确标注为测试替身的 MemoryStore。
- 已在隔离的用户态 PostgreSQL 18 环境完成 migration、双进程并发、事务故障回滚、重启保持、多 Placement 和 50,000 Task / 250,000 Placement 容量门禁；这些证据不替代 Docker Compose、生产卷备份/恢复和真实部署演练，后者在当前环境仍为 `NOT RUN`。
- 通知连接断开时由重连、轮询、focus、online 和前台生命周期兜底；通知不是提交确认。
- 完整 snapshot 在达到规划容量基线前必须有真实性能数据；若容量或延迟不满足预算，应在保持契约的前提下引入分页/分片 snapshot，而不是恢复内存全量镜像。

## 验收要求

必须在独立 PostgreSQL 环境证明：

1. mutation 不执行全表 `TRUNCATE` 或全状态重写。
2. 两个独立 API 进程并发修改同一 Owner 时无丢失更新，重复 mutation 只产生一次效果。
3. 注入事务失败后，业务表、版本、change feed 和 receipt 没有部分提交。
4. API 重启后状态、版本、cursor 和幂等回执保持一致。
5. 50,000 Task / 250,000 Placement 下的列表、搜索、pull、写入和启动时间满足 `DEVELOPMENT_PLAN.md` 第 14 节预算。
