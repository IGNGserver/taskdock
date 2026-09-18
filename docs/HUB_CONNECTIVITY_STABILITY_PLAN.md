# 中枢连接稳定性与外网 HTTP 可用性开发计划

审计日期：2026-09-15  
审计范围：中枢 API、PostgreSQL 适配层、Web/Electron、Android 移动端、WebSocket、Docker Compose/Caddy，以及外网 HTTP 连接链路。  
文档用途：交给后续开发任务执行。本次审计只新增本计划文档，没有修改业务代码、配置或数据库。

## 1. 结论

当前项目不能宣称已经满足“中枢长期运行、桌面端和移动端在外网 HTTP 下稳定连接”的要求。问题分为两类：

1. **已经确认的协议阻断**：当前公网中枢仍返回 syncProtocolVersion 为 1，/api/v2/status 返回 404；而当前源码的 Web、部分 Electron renderer 和 Android 同步流程已经使用 v2。客户端会把 v2 404 或协议不匹配进一步表现为登录失败、同步失败或“中枢离线”。
2. **已经能从源码确认、但尚未完成长时间实证的稳定性风险**：生产 PostgreSQL 适配器的 v2 change feed/cursor 仍主要存在进程内存中，变更列表没有保留上限；进程重启或多实例后游标可能断裂并漏同步，持续写入还可能造成内存线性增长。数据库黑洞、OOM、重启恢复和真实设备验收目前均未被证明。

当前外网 HTTP 探测结果是“服务可达但版本/契约不对”，不是单纯的网络不通：

| 探测                     | 当前结果                           | 含义                               |
| ------------------------ | ---------------------------------- | ---------------------------------- |
| /health/live             | 200，status: ok                    | 进程能响应                         |
| /health/ready            | 200，status: ready                 | 当前探测时数据库就绪               |
| /version                 | 0.1.5-rc.1，syncProtocolVersion: 1 | 公网部署明显落后于当前 v2 源码契约 |
| /api/v2/status           | 404                                | 当前公网实例不能提供 v2            |
| /api/v1/bootstrap/status | 200                                | 旧 v1 基础认证端点仍可用           |

因此优先级不是先扩大客户端重试，而是先统一“部署版本、API 版本、认证路径、同步游标和就绪状态”的单一契约。

## 2. 问题清单与证据边界

### P0：当前已经会阻断正常连接

#### P0-1：公网部署仍是 v1，当前客户端已依赖 v2

- 证据：
  - 公网 /version 返回 syncProtocolVersion: 1。
  - 公网 /api/v2/status 返回 404。
  - Android ApiClient 的 snapshot/push/pull 使用 v2。
  - Web 主界面大量使用 requestV2/mutationV2。
- 影响：
  - 登录可能成功，但首次 v2 snapshot、push 或 pull 失败。
  - Android SyncEngine 对 v2 IOException 直接设置 SyncState.OFFLINE，因此协议缺失会被误报成中枢离线。
  - 旧镜像继续运行时，即使网络、端口和数据库健康，客户端也无法完成当前同步契约。
- 完成条件：
  - 部署后 /version 与源码发布版本一致，且 syncProtocolVersion 为 2。
  - 已认证的 /api/v2/status、snapshot、pull、push 均按当前契约返回。
  - 部署脚本必须在启动后校验版本和 v2 探针，不允许只看 HTTP 200。

#### P0-2：Web/Electron renderer 的认证路径默认打到 v2，但服务端认证仍在 v1

- 证据：
  - apps/web/src/api.ts 的通用 request 默认基址是 /api/v2。
  - apps/web/src/auth.tsx 用通用 request 调用 /bootstrap/status、/auth/login、/auth/logout、/me。
  - 服务端这些认证路由当前位于 apps/api/src/server.ts 的 /api/v1 路由组。
  - Electron main 进程使用 v1 完成 native login/refresh，但 renderer 登录完成后仍用通用 /me，存在“main 认证成功、renderer 初始化 404”的断点。
  - rollover/undo 等剩余 v1 路由也被部分 Web 调用以 v2 默认基址访问。
- 影响：
  - 浏览器或桌面端可能在认证流程中看到 404、登录失败或被清空为未登录。
  - 现有 E2E 主要 mock /api/v1/**，无法发现 renderer 实际发出的 v2 错误请求，形成假绿。
- 完成条件：
  - 明确并冻结认证、数据和遗留功能各自的 API 版本。
  - 所有调用点使用显式 requestV1 或 requestV2，禁止依赖模糊的默认基址。
  - 增加 URL 级契约测试，逐一断言 bootstrap/login/refresh/logout/me、rollover、snapshot、pull、push 的真实路径。
  - refresh cookie 的 Path、Secure、SameSite 和公开访问 scheme 与实际认证路径保持一致。

### P0/P1：中枢长期运行或重启后可能导致漏同步、失联

#### P0-3：v2 PostgreSQL 适配器使用进程内 change feed/cursor，存在重启漏同步和无界内存增长

- 证据：
  - apps/api/src/tree-store.ts 的 MemoryTreeStore 保存 changes 数组和进程内 cursor。
  - 每次 mutation 都向该数组追加变更，没有 retention、最大长度或按数据库游标清理。
  - PostgresTreeStore 启动时加载 owner 实体，但没有把 sync_changes 和数据库序列恢复到同一游标。
  - PostgreSQL 适配器会持久化实体并另写数据库 change row，但内存游标与数据库序列是两套来源。
- 影响：
  - 长时间持续写入可能造成进程内存线性增长，最终 OOM 或被系统杀死。
  - API 重启后，客户端保存的旧 cursor 可能大于新进程内存 cursor；后续 pull 可能返回空结果，导致已提交变更永久漏同步。
  - 多实例部署时不同实例的内存游标和 change list 不一致，客户端命中不同实例会出现随机漏数据。
- 完成条件：
  - PostgreSQL 的 sync_changes/数据库序列成为 v2 status、snapshot、pull 的唯一权威游标。
  - mutation、变更记录和游标推进在同一数据库事务内完成；listener/NOTIFY 只作为唤醒提示，不作为数据来源。
  - full snapshot、增量 pull 和 cursor 过期策略在重启、重复请求、并发请求、多实例下保持一致。
  - 对 owner、cursor、mutation id 和错误回滚建立唯一约束及可观测指标。
  - 通过真实 PostgreSQL 的“写入 A → 记录 cursor → 重启 API → 写入 B → 旧客户端 pull 到 B”测试。

#### P1-1：PostgresTreeStore 的数据库失败回滚不能完整恢复进程内状态

- 证据：
  - PostgresTreeStore.applyMutationIdempotent 在父类内存 mutation 成功后再执行实体持久化和变更写入。
  - 数据库写入失败时只重新加载实体 map，未完整恢复内存 changes、cursor、receipts 和 delete token 等状态。
- 影响：
  - 数据库事务回滚后，进程内可能残留不存在于数据库的变更或幂等收据。
  - 客户端可能收到无法由数据库重放的 cursor，重试可能重复写入或漏同步。
- 完成条件：
  - 事务失败时所有内存投影、游标、receipt、删除 token 与数据库状态一致；更推荐让 PostgreSQL 路径不再依赖这套可回滚的进程内 feed。
  - 增加失败注入测试：实体 upsert 失败、change insert 失败、commit 失败、重试同一 mutation。

#### P1-2：每次 mutation 全量持久化 owner，可能造成请求变慢、连接池耗尽并被客户端判为离线

- 证据：
  - apps/api/src/postgres-tree-store.ts 的 persistOwner 会遍历并 upsert owner 的多个实体集合。
  - /api/v2/sync/push 最多连续处理 500 个 mutation，每个 mutation 都可能触发一次全量持久化。
  - snapshot 也会返回完整 owner 数据，没有分页、大小上限或分片策略。
- 影响：
  - 数据量或 outbox 增长后，请求耗时会按实体量和批次数放大。
  - 慢请求占用 PostgreSQL pool，进一步导致新请求排队、超时、桌面端/移动端显示中枢离线。
  - 大型 full snapshot 可能造成 Node 堆内存峰值或代理超时。
- 完成条件：
  - 改为按 mutation 做最小增量 SQL，或明确采用批量事务/批量 upsert；禁止每个 mutation 全量 dump owner。
  - 对 snapshot、push、pull 设置最大响应/批大小和分页或分片协议。
  - 用不同 owner 数据规模测量 p50/p95/p99、数据库语句数、pool 等待时间和 Node heap。

### P1：数据库、进程和部署链路风险

#### P1-3：PostgreSQL pool、连接、查询和事务没有明确超时

- 证据：
  - packages/database/src/index.ts 的 pool 只配置了连接串、最大连接数和 maxUses。
  - databaseReady、checkReady、pool.connect()、事务 query 没有统一的 connect/query/statement/lock/transaction timeout。
  - listener 重连循环可能在半开网络中长期等待；pool error 只记录日志并标记未 ready。
- 影响：
  - 数据库黑洞、半开 TCP 或锁等待时，进程仍存活但请求不返回，连接池最终耗尽，外部表现为中枢离线。
  - 启动可能卡在数据库检查，端口迟迟不监听；或 live 仍为 200 而业务请求全部超时。
- 完成条件：
  - 为 pool connect、query、statement、lock、transaction 设置可配置且有上限的超时和 TCP keepalive。
  - ready 检查失败时稳定返回 503，并包含可观测的内部原因；live 只代表进程，不冒充业务可用。
  - listener 采用有上限的指数退避、健康恢复探测和指标，避免每秒无限重连。
  - 增加数据库停止、恢复、黑洞、慢查询、锁等待、连接池耗尽测试。

#### P1-4：生产 Compose 的 migration 和 health gate 不足

- 证据：
  - compose.yaml 的 migrate 是 operations profile，app 只依赖 PostgreSQL healthy。
  - app healthcheck 只探测 /health/live，gateway 依赖 app healthy；这允许 live 但未 ready 的 app 被网关接收。
  - docs/DEPLOYMENT.md 要求迁移先于应用，但生产 Compose 没有强制表达该条件。
- 影响：
  - 新环境或升级时忘记单独运行 migrate，应用会启动失败并重启；或者 gateway 把未就绪实例当成健康后端。
  - 外网访问得到 502/503/超时，被客户端显示为中枢离线。
- 完成条件：
  - 生产部署脚本明确执行并等待 migrate 成功，再启动 app/gateway；或者使用等价的强制依赖机制。
  - app/gateway 健康检查至少区分 live 和 ready，网关只把 ready 实例加入可用后端。
  - 验证首次部署、升级、迁移失败、应用重启、数据库重启和回滚。

#### P1-5：HTTP/HTTPS、HSTS、Cookie 和 CORS 的公开访问契约不一致

- 证据：
  - 文档允许外网 HTTP；Caddy 当前固定发送 HSTS；服务端 cookie 的 secure 又依赖静态 APP_ORIGIN。
  - 如果公开访问 scheme 与 APP_ORIGIN 不一致，refresh cookie 可能在 HTTP 下不发送，或浏览器被既有 HSTS 规则升级到 HTTPS。
  - CORS 探测当前对若干 origin 能返回允许值，但仍缺少浏览器真实登录/刷新验收。
- 影响：
  - 登录初次成功，刷新或重新打开后失效；用户看到“中枢离线”或反复登录。
  - HTTP 直连、HTTPS 代理和 Electron custom scheme 的行为不一致。
- 完成条件：
  - 明确支持矩阵：外网 HTTP 必须可用；生产推荐 HTTPS；若不支持某种组合，客户端要显示明确的配置错误。
  - Caddy 只在 HTTPS 公开入口发送 HSTS，并验证 Host、Origin、X-Forwarded-Proto。
  - cookie 的 Path、Secure、SameSite、Domain 与实际 v1/v2 auth 路径和公开 scheme 一致。
  - 用真实浏览器、Electron 和移动端分别验证 HTTP 与 HTTPS 的登录、refresh、重启后恢复。

#### P1-6：镜像标签允许旧版本继续运行，当前公网已出现部署漂移

- 证据：
  - compose.yaml 默认镜像标签为 latest。
  - 当前公网 /version 返回旧的 0.1.5-rc.1/local 信息，而源码已经包含 v2 路径。
- 影响：
  - 源码修复后部署仍可能拉到旧镜像，造成“代码已修复但外网仍离线”的误判。
  - gateway、桌面端、移动端和 API 实际运行的协议版本不可确认。
- 完成条件：
  - 使用不可变版本或 digest，部署记录 image digest、commitSha、buildTime。
  - 部署后自动校验 /version、/health/ready、v2 探针和一条已认证同步链路。
  - 任何版本校验失败都阻止宣称发布完成。

### P1/P2：客户端错误分类与连接恢复

#### P1-7：Android 把协议错误、认证错误和服务端错误统称为 OFFLINE

- 证据：
  - getSnapshotV2 对所有非 2xx 主要转成 IOException。
  - SyncEngine 对 IOException 直接进入 SyncState.OFFLINE。
  - Android 还保留调用 /api/v1/hub/status 的定义，但服务端当前提供的是 /api/v1/bootstrap/status；该调用目前未发现有效调用点，属于潜在死路径。
  - Android 默认中枢地址硬编码为 http://47.95.17.77:48731，部署地址变化时新设备会继续访问旧地址。
- 影响：
  - 404、401/403、协议版本不支持、5xx、数据库未 ready 都显示为网络离线，排障方向错误。
  - 网络恢复后可能没有针对协议/认证错误的明确动作；默认地址过期时所有新设备直接失败。
- 完成条件：
  - 仅真实连接失败、DNS/TCP/TLS 超时和明确的网络不可达进入 OFFLINE。
  - 401/403 进入 AUTH_REQUIRED，404/协议不支持进入 INCOMPATIBLE，5xx/503 进入 SERVER_UNAVAILABLE，并展示可操作原因。
  - 删除或修正 /api/v1/hub/status 死路径；首次配置、远程配置或版本化默认地址可更新。
  - 保存 outbox，不因暂时断线或协议错误丢失本地变更。

#### P2-1：WebSocket 缺少全局限流、连接上限、心跳和背压保护

- 证据：
  - v2 WebSocket 有认证超时和 close 清理，但没有明确的每 IP/Origin 连接上限、idle/ping 超时、消息背压和完整 error handler。
  - Web 端 socket 断开后主要依赖轮询、focus/online 事件和 30 秒 fallback，缺少有上限的重连状态机；message JSON.parse 也未完全隔离异常输入。
  - Android SyncEngine 的 WebSocket 重连存在，但 engine scope 在 stop 时没有取消，反复创建可能泄漏。
- 影响：
  - 半开连接或大量连接会积压资源，推送异常可能放大为 API 进程不稳定。
  - 实时通道断开时 UI 状态可能长期过期；重复创建移动端 engine 会逐渐增加后台任务。
- 完成条件：
  - 服务端加入 per-IP/Origin 限流、连接上限、ping/pong、idle timeout、send error/backpressure 处理和指标。
  - Web/Android 使用带抖动、上限和取消机制的重连；非 JSON 消息不能破坏客户端状态机。
  - 通过大量连接、半开连接、慢客户端和反复登录/退出 soak 测试。

#### P2-2：native challenge 清理存在请求内无界删除风险

- 证据：
  - native challenge 创建接口没有看到对应的限流。
  - mutation 事务中对过期 challenge 使用无 LIMIT 的删除；同一事务还执行其他清理。
- 影响：
  - 大量过期 challenge 会让一次普通 mutation 执行长时间清理，增加锁和数据库负载，最终表现为请求超时或中枢离线。
- 完成条件：
  - challenge 创建按 IP、设备和账号限流。
  - 清理改为独立、可观测、分批的后台任务或明确的单批上限；增加索引和积压指标。
  - 请求事务内不执行无界维护操作。

#### P2-3：进程退出和 HTTP socket 的外部兜底不完整

- 证据：
  - apps/api/src/main.ts 主要处理 SIGTERM/SIGINT，没有完整的 fatal error/unhandled rejection 记录、优雅 drain 和 supervisor 约束。
  - Compose 有 restart: unless-stopped，但无法修复卡死、半开连接或错误 healthcheck；裸 node/systemd 场景也没有等价兜底。
  - Fastify 初始化未明确设置 request/socket/keep-alive timeout。
- 影响：
  - 真正 OOM/fatal 时可能没有足够诊断；卡死进程可能继续占端口但无法服务。
  - 发布或重启期间旧连接拖住资源，客户端误判为持续离线。
- 完成条件：
  - 由 systemd/Docker/平台 supervisor 负责自动拉起、启动限时、退出码和日志留存。
  - 加入 uncaught/unhandled 的结构化日志并在不可恢复状态下快速退出，让 supervisor 接管。
  - 设置有依据的 request、headers、keep-alive、graceful shutdown/drain timeout，并进行重启期间客户端验收。

## 3. 推荐实施顺序

### 阶段 0：冻结契约并建立基线

1. 在新任务开始时先记录 git status --short，保留当前工作树已有修改；不要 reset、clean 或覆盖用户文件。
2. 冻结 API 版本职责：
   - v1：bootstrap、login、refresh、logout、me、native challenge，以及暂时保留的 rollover/undo。
   - v2：tree、task、workflow、snapshot、pull、push、status、WebSocket。
   - 如果决定把认证整体迁移到 v2，必须一次性同步服务端、Web、Electron、Android、cookie、CORS 和 OpenAPI，不允许只移动一部分。
3. 增加契约测试，要求每个客户端调用点显式声明 v1/v2，并在测试中断言最终 URL、状态码、错误类型和响应 schema。
4. 先补齐真实 PostgreSQL、迁移、重启、并发和网络故障的测试夹具；不要把内存 store、mock fetch 或静态 build 当成完整验收。

### 阶段 1：修复 v2 持久化与游标一致性

1. 以 PostgreSQL sync_changes 和数据库序列为 v2 增量同步权威来源。
2. 让 mutation、业务行、change row、幂等 mutation receipt 在同一事务内提交或全部回滚。
3. 重写 PostgresTreeStore 的 v2 路径为增量 SQL/批量 SQL；去除每个 mutation 的全量 owner dump。
4. 明确 cursor 过期、全量 snapshot、重复 pull、重复 push、并发 push、多实例和 API 重启语义。
5. 为 snapshot、push、pull 增加分页/批次/响应大小上限；监控响应大小和耗时。
6. 审计 v2 持久化对旧 v1 字段的写入，避免为了兼容而把 project/category/priority 等字段覆盖为空或默认值。

### 阶段 2：修复数据库和中枢生命周期

1. 为 PostgreSQL pool 配置 connect、idle、query、statement、lock、transaction 超时、keepalive 和连接生命周期。
2. 对 ready 检查、迁移未完成、数据库不可达、数据库恢复分别定义 HTTP 状态、响应体和日志/指标。
3. listener 重连采用指数退避和上限；NOTIFY 断开不影响数据库 change log 的可恢复性。
4. 把 challenge、sync_changes、client_mutations 等清理改成有上限的后台/批处理任务，并增加索引与积压告警。
5. 增加进程 supervisor、结构化 fatal 日志、优雅 drain、HTTP request/socket timeout、WebSocket 限流和心跳。

### 阶段 3：统一 Web、Electron、Android 连接语义

1. Web 和 Electron renderer 显式使用 v1 auth helper 与 v2 data/sync helper，修复 /me、refresh、rollover/undo 等路径。
2. 统一 cookie Path 和公开 scheme；覆盖直接 HTTP、反向代理 HTTPS、Electron custom scheme 三种场景。
3. Android 修正 status endpoint、去除不可更新的硬编码地址，保留本地 outbox，并实现网络/认证/协议/服务端错误分类。
4. 为 Web、Electron、Android 增加有上限、可取消、带抖动的重连；WebSocket 解析错误不能破坏整个同步状态机。
5. 客户端 UI 只有在真正网络不可达或超时才显示 OFFLINE；协议不兼容和认证过期必须给出不同提示。

### 阶段 4：修复生产部署与外网 HTTP 链路

1. 生产部署必须先成功执行 migration，再启动 app 和 gateway；gateway 只路由到 ready 后端。
2. 使用不可变 image tag/digest，启动后校验 /version 的 commit、build time 和 sync protocol。
3. 调整 Caddy HSTS，使其只作用于 HTTPS 入口；明确 HTTP 仍可用但不具备传输加密，生产环境推荐 HTTPS。
4. 检查反向代理的 Host、Origin、X-Forwarded-Proto、WebSocket Upgrade、超时和大响应配置。
5. 升级当前公网实例到与源码一致的 v2 版本，并完成一条真实认证同步闭环后，才可关闭本项。

### 阶段 5：长时间和真实环境验收

按下列顺序执行，结果必须记录为 PASS、FAIL、NOT RUN 或 NOT PROVEN，不能把未执行写成通过：

1. **本地门禁**：pnpm test、workspace typecheck、lint、OpenAPI route check；修复当前已知失败后重新运行。
2. **真实 PostgreSQL**：全新迁移、升级迁移、回滚/失败迁移、并发 mutation、幂等重试、API 重启后 cursor 延续。
3. **长时间 soak**：至少 6 小时，最好 24 小时；持续写入、pull、push、WebSocket 连接和多客户端操作，记录 RSS/heap、event loop lag、FD、pool 使用率、p95/p99、错误率。验收重点是内存不随 change 数量线性增长，不能以“进程尚未退出”作为唯一通过条件。
4. **数据库故障**：停止/恢复 PostgreSQL、阻断连接、制造慢查询/锁等待、耗尽 pool；确认 live、ready、API 超时和恢复行为符合定义。
5. **部署故障**：首次部署、漏跑 migration、应用重启、数据库重启、gateway 重启、旧镜像误部署、升级和回滚；确认版本探针能阻止错误发布。
6. **真实外网 HTTP**：在非同机网络验证 live、ready、version、v2 status、登录、refresh、snapshot、push、pull 和 WebSocket；验证 NAT/公网端口/代理超时。
7. **桌面端**：Electron 在 HTTP 和 HTTPS 下登录、退出、refresh、重启恢复、网络断开/恢复、API 重启期间同步。
8. **移动端**：真实 Android 设备验证 HTTP 和 HTTPS 登录、首次 snapshot、push/pull、杀进程重启、切换网络、飞行模式恢复，以及 401/404/503 的提示分类。
9. **多实例可选验收**：两个 API 实例轮询或负载均衡，验证任意实例都能用数据库 cursor 完成 pull 和 WebSocket 唤醒。

## 4. 最终验收门槛

以下任一项未通过，都不能宣称“中枢连接稳定”：

- 长时间 soak 没有无界内存增长、OOM、FD 泄漏、event loop 长阻塞或持续 pool 饥饿。
- 数据库不可用时 ready 正确失败、请求有界超时；数据库恢复后服务能自动恢复，不需要客户端删除本地数据。
- API 重启、实例切换后，旧 cursor 不会静默漏变更；重复 mutation 不会重复落库。
- 公网 /version、/health/ready、v2 status 和已认证 v2 sync 均与当前源码版本一致。
- Web、Electron、Android 在外网 HTTP 下均能完成 login、refresh、snapshot、push、pull；HTTPS 场景也有明确且一致的行为。
- 真实网络不可达才显示 OFFLINE；404、401/403、协议不兼容、503 和 5xx 不得伪装成网络离线。
- 本地测试、typecheck、lint、OpenAPI、真实 PostgreSQL、真实浏览器/桌面端、真实 Android、外网和长时间运行的证据分别记录，不能用其中一类替代另一类。

## 5. 迁移、发布与回滚约束

- 任何数据库 schema 或 sync cursor 改动前先备份 PostgreSQL，并记录数据库版本、迁移版本、image digest 和当前最大 change sequence。
- 先部署兼容旧数据的 reader/adapter，再执行可逆或可验证的写入迁移；不得直接删除旧表、旧 cursor 或客户端 outbox。
- 发布前保存 /version、ready 状态、关键表行数和抽样 hash；升级后逐项比对。
- 应用回滚必须明确 schema 向后兼容窗口；若不兼容，先停止流量并恢复兼容版本，不要用清库解决连接问题。
- 只有在上述验收证据齐全并得到明确发布授权后，才进行正式外网部署、镜像推送或打 tag。

## 6. 交给下一个任务的一句话提示词

请严格按 docs/HUB_CONNECTIVITY_STABILITY_PLAN.md 在保留当前脏工作树的前提下实施并验证中枢长期稳定性、v1/v2 契约统一、PostgreSQL 持久化游标、外网 HTTP、Web/Electron/Android 连接与错误分类，优先修复 P0/P1，完成真实 PostgreSQL、重启/故障注入、外网、桌面端、Android 和长时间 soak 验收，并逐项报告 PASS/FAIL/NOT RUN/NOT PROVEN，未经明确授权不要发布或打 tag。
