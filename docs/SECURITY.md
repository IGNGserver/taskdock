# 安全说明

- 密码使用 Argon2id；access token 只在内存，refresh token 只保存哈希或平台安全存储。
- Web 使用 HttpOnly refresh Cookie、显式 CORS、CSP/安全响应头、请求体限制和 Owner 范围查询。支持 HTTP 或 HTTPS 入口；HTTP 登录页会显示安全警告，但密码和会话信息仍会明文传输，公网应使用 HTTPS。
- 所有 REST/WebSocket 输入通过 Zod 或显式参数校验；写入要求 Idempotency-Key，更新要求 baseVersion。
- Markdown 原始 HTML、脚本、事件属性和危险 URL scheme 禁止；预览再次 sanitize，外链强制安全打开。
- Electron 关闭 nodeIntegration，开启 contextIsolation、sandbox、webSecurity；preload 不暴露原始 ipcRenderer，窗口导航和外链使用 allowlist。
- Android 生产实现必须接入 Keystore 支持的 Secure Storage；不能写 Web localStorage、普通 Preferences、日志或截图报告。

威胁边界：V1 不是端到端加密，拥有服务器/数据库卷权限的管理员可以读取 Note；IndexedDB 不加密。部署者负责主机磁盘、备份介质、代理证书和卷权限。安全问题请先提供最小复现、版本、请求 ID 和日志脱敏片段，不要上传 token/密码/Note 全文。
