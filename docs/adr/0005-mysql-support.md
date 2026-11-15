# ADR 0005：双引擎数据库支持（PostgreSQL / MySQL）

状态：接受（PostgreSQL 仍是默认；MySQL 8.4 一等支持，存在明确的能力差异）

## 背景

中枢默认只支持 PostgreSQL。部署者的实际环境里，MySQL 8.4 往往已经作为共享数据库服务存在（NAS、云数据库、其它应用已在用），再为 TaskDock 单独维护一套 PostgreSQL 是额外的运维负担。要求是：用户能自己选引擎，MySQL 也允许使用外部服务器。

现有存储层是 3000 余行手写 SQL，包含大量 PostgreSQL 专有写法（`RETURNING`、`jsonb_to_recordset`、`jsonb_agg`、`FILTER` 聚合、部分唯一索引、`LISTEN/NOTIFY`、`pg_trgm`、advisory lock），并且这些查询是为了高延迟远端库做过往返次数优化的。

## 决策

1. **只保留一份 SQL 与一份存储实现**，不为 MySQL 复制适配器，也不引入 ORM 重写。`PostgresStore`/`PostgresTreeStore` 改名为 `SqlStore`/`SqlTreeStore`，接收 `SqlDatabase` 抽象。
2. **方言差异集中在 `@devtodo/database`**：
   - `$n` 占位符由方言层翻译（MySQL 重排为 `?`，支持参数重复使用）；
   - `::type` 对 MySQL 剥离（PostgreSQL 需要它做类型推断）；
   - `ILIKE` 翻译为 `LIKE`（MySQL 默认排序规则大小写不敏感）；
   - `rank`/`cursor` 是 MySQL 保留字，方言层自动加反引号，PostgreSQL 保持原文。
3. **只有少数语句保留两份拼写**（`apps/api/src/sql-statements.ts`）：owner 快照聚合、sync pull、目录分页、文件夹路径。它们依赖 JSON 聚合、`MATERIALIZED` 或递归 CTE 的引擎差异，硬凑成一份 SQL 反而更难维护。
4. **`RETURNING` 用同事务回查模拟**：语句执行后按已知主键读回。MySQL 的 `sync_changes.seq` 用 `insertId + affectedRows` 得到批内最大游标。
5. **部分唯一索引改为生成列**：`IF(deleted_at IS NULL, 1, NULL)` 的 STORED 生成列加入唯一键，MySQL 允许多个 NULL，墓碑因此可以并存。部分普通索引退化为全量索引。
6. **MySQL schema 从合并基线开始**：`migrations/mysql/0013_baseline.sql` 等价于 PostgreSQL `0001..0013`，编号对齐；此后每个变更两边各一个同版本文件，并有测试保证版本集合一致。MySQL 的 DDL 隐式提交，迁移 runner 改为逐文件提交 + `GET_LOCK` 串行。
7. **通知降级**：进程内在 COMMIT 后直接 fan-out；跨实例实时推送在 MySQL 下需要 Redis pub/sub，否则靠客户端轮询。`DB_LISTEN_ENABLED` 对 MySQL 恒为 false。

## 代价与边界

- 搜索：MySQL 没有 `pg_trgm` 等价索引，`LIKE '%term%'` 在 owner 范围内扫描；大数据集需要额外方案。
- 语句级超时：MySQL 的 `max_execution_time` 只作用于 SELECT；写入靠 `innodb_lock_wait_timeout`，无法被强杀。
- 硬删除：MySQL 基线里子外键全部级联，删除 Owner 是一步操作；应用本身仍然只做软删除。
- 自引用外键 `refresh_sessions(owner_id, replaced_by_id)` 在 MySQL 中被省略：复合键含 NOT NULL 列时无法 `SET NULL`，自级联又会删掉被轮换的会话。
- 不做 PostgreSQL → MySQL 的存量数据搬迁；换引擎等于新建中枢，数据通过客户端同步协议重新灌入。
- 不支持 MariaDB（`RETURNING`、部分索引、JSON 语义均不同）。
