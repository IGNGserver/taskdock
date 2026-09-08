# Changelog

## 0.1.0 · 2026-09-05

- 建立 Task 与 Placement 分离的 DevTodo V1 工程。
- 增加 Owner bootstrap、Argon2id 登录、refresh rotation、设备撤销和统一错误码。
- 增加项目/任务/Note/日期/Event/Placement API、归档恢复、复制/移动/批量 rollover。
- 增加 PostgreSQL migration、增量 change feed、幂等 mutation receipt 和 Dexie 离线 outbox。
- 增加 React/PWA Web UI、Electron 安全壳和 Capacitor Android 工程；生成 Linux Electron 目录包和 Android 未签名 release APK。
- 增加稳定 keyset 列表游标、Web 分页聚合、同步 cursor 原子推进、失败重试退避和冲突保留。
- 增加 ADR 记录 Store 全量持久化边界，以及 Electron builder、桌面拖拽/键盘替代和移动端 Bottom Sheet 取舍。
- 记录当前已通过的自动化门禁，以及尚未具备 Docker/PostgreSQL、Windows、Android 真机、iOS WebKit 和备份恢复条件的门禁。
