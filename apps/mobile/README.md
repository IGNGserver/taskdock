# Android / Capacitor

`apps/mobile` 只保存 Capacitor 配置与平台适配边界，界面和领域逻辑来自 `apps/web`。Capacitor Android 工程已纳入仓库；每次构建前由根脚本重新同步 Web 资源和插件：

```bash
pnpm android:assembleRelease
```

Release 构建需要 Android SDK、Java/Gradle；当前脚本产出的是未签名 `app-release-unsigned.apk`，正式发布还必须注入部署者的签名配置。缺少构建条件时根命令会明确报告 `NOT RUN`，不会伪造 APK。`src/adapter.ts` 已接入 Capacitor App、Network、Browser 和 `@aparajita/capacitor-secure-storage`：refresh token 只经 Keystore 支持的 Secure Storage 保存，不写入 localStorage 或普通 Preferences。还需在真实 Android 设备验收返回键、网络恢复、离线 outbox 和 HTTPS 中枢连接。
