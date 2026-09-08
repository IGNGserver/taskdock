# TaskDock Android Release 签名

本目录用于保存 TaskDock Android Release 的长期签名材料。

- `taskdock-release.keystore`：Release 私钥文件，请妥善备份，不要删除。
- `taskdock-release.properties`：本地 Gradle 构建配置，包含签名密码。
- `taskdock-release.secret`：用于配置 GitHub Actions Secrets 的备份文本。

这些文件已加入 Git 忽略规则，不会提交到公开仓库。发布前需要把同一把密钥配置到 GitHub Actions：

- `TASKDOCK_ANDROID_KEYSTORE_BASE64`
- `TASKDOCK_ANDROID_KEYSTORE_PASSWORD`
- `TASKDOCK_ANDROID_KEY_ALIAS`
- `TASKDOCK_ANDROID_KEY_PASSWORD`

如果更换签名密钥，已安装旧版本的 Android 用户将无法直接覆盖升级，必须先卸载旧版本；因此后续发布必须持续使用同一把密钥。
