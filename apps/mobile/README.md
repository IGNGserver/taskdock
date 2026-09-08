# Android / Capacitor

`apps/mobile` 只保存 Capacitor 配置与平台适配边界，界面和领域逻辑来自 `apps/web`。Capacitor Android 工程已纳入仓库；每次构建前由根脚本重新同步 Web 资源和插件：

```bash
pnpm android:assembleRelease
```

## Release 签名

Android Release APK 必须签名才能正常安装。项目使用工作区中的长期签名材料：

```text
apps/mobile/android/signing/taskdock-release.keystore
apps/mobile/android/signing/taskdock-release.properties
apps/mobile/android/signing/taskdock-release.secret
```

上述文件已加入 Git 忽略规则，不会提交到公开仓库，但会保留在本地工作区用于后续构建。请额外备份整个 `signing` 目录；如果丢失签名密钥，后续版本无法覆盖安装在设备上的旧版本。

GitHub Actions 发布流程使用同一把密钥对应的 Secrets：`TASKDOCK_ANDROID_KEYSTORE_BASE64`、`TASKDOCK_ANDROID_KEYSTORE_PASSWORD`、`TASKDOCK_ANDROID_KEY_ALIAS` 和 `TASKDOCK_ANDROID_KEY_PASSWORD`。工作流会验证 APK 签名后，才会把安装包放入 Release。

如果没有 Android SDK、Java、Gradle 或签名材料，根命令会明确报告 `NOT RUN` 或失败，不会再生成容易被误认为可安装包的未签名 APK。`src/adapter.ts` 已接入 Capacitor App、Network、Browser 和 `@aparajita/capacitor-secure-storage`：refresh token 只经 Keystore 支持的 Secure Storage 保存，不写入 localStorage 或普通 Preferences。还需在真实 Android 设备验收返回键、网络恢复、离线 outbox 和 HTTP/HTTPS 中枢连接。
