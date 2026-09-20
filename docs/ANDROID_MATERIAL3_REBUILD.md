# Android Material 3 重构

## 范围与仓库审计

Android 是 `apps/mobile/android` 内的原生 Compose 客户端，Room/Outbox 是离线写入入口，OkHttp/SyncEngine 与 Fastify 的 v2 协议同步。Web/Electron 使用 React/Dexie，服务端使用 PostgreSQL change feed；本次不迁移持久化 schema、不更改 Task/Placement/Workflow 的含义。

源码审计覆盖客户端入口、全部可达页面、主题、组件、ViewModel、DAO、认证、同步，以及仓库架构、共享 contracts/domain、API 和迁移边界。历史 V1 页面不作为新界面的基础。

发现：六项底部导航过密；目录/流程操作平铺溢出；今日重复统计且暴露协议术语；所有任务没有检索；详情长表单、返回丢草稿；目录定位参数被丢弃；选择器不滚动；登录输入每次按键写服务器配置；设置保存服务器后缺少会话切换反馈；颜色/字体虽使用 M3 API，但页面层级未形成统一系统。

## 六个设计维度

| 维度     | 实施规则                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视觉结构 | 原生 MaterialTheme 语义色、完整默认 M3 字阶、标准形状；保留动态配色/系统/深浅/纯黑设置；列表使用 surface，容器色表达层级，不将每行包装为卡片。                                                       |
| 页面结构 | 四个一级目的地：今日、任务、计划、设置。任务包含目录与全部任务，计划包含日期/事件与流程；详情是独立目的地。                                                                                          |
| 组件     | 官方 NavigationSuiteScaffold（NavigationBar/Rail）、TopAppBar、Tab、ListItem、Checkbox、FilterChip、FAB、ModalBottomSheet、DatePicker、AlertDialog、Snackbar。共享页面框架、空态、输入和上下文菜单。 |
| 交互逻辑 | 点击行打开内容；复选框完成/撤销完成，进行中通过明确状态菜单设置；低频操作进入菜单；永久删除确认；返回保护未保存输入；搜索和过滤不写业务数据。                                                        |
| 动效     | 页面进入/返回使用短距离位移与淡入淡出，一级目的地淡入淡出；内容展开使用 Compose 尺寸动画；交互反馈由原生组件提供，遵循系统动画缩放。                                                                 |
| 适配     | 通过官方自适应信息选择底部导航/侧栏，考虑紧凑窗口高度与折叠姿态；内容最大宽度限制；窗口 Insets 明确归属；表单支持键盘、滚动及大字体；长列表/选择器按需滚动；图标具有可读操作名称。                   |

## 保留的业务能力

今日创建并安排；目录层级/混合排序/移动/递归归档与删除预览；全任务浏览；流程/阶段创建、命名、归档、删除、排序、成员增删移动；任务标题/备注/独立步骤；日期安排的移动与复制；归档恢复；登录/离线同步/待提交项与冲突信息；主题设置。

## 验证边界

必须执行 Kotlin 编译、Android 单元测试和 lint；针对新交互增加 Compose 设备测试。无设备时不能将编译或测试 APK 生成等同于 UI 验收。另需真机验证：系统返回/旋转、IME、TalkBack、200% 字体、分屏/折叠、浅深主题、离线到在线及真实 Hub 同步。本次不发布或部署。

## 官方依据

- https://developer.android.com/develop/ui/compose/designsystems/material3
- https://developer.android.com/develop/ui/compose/layouts/adaptive
- https://developer.android.com/develop/ui/compose/layouts/adaptive/build-adaptive-navigation
- https://m3.material.io/

## 实施补充

- 删除不再可达的 V1 Inbox/Projects/Tasks/Today/ArchivedTasks 和旧快速捕获 UI，避免再次接入旧项目/优先级语义。
- 修正归档 DAO 排除 tombstone；恢复任务统一清除 `archivedByOperationId`，保留目录批量恢复边界。
- 日期查询同时包含 DATE/EVENT，计划页可创建指定日期任务；事件管理仍保持既有服务端/Web 能力边界。
- 设置更换中枢前校验纯 origin、检查待提交操作并确认重新登录；输入过程不写配置，不把旧账户 token 带入新中枢。
- 用户强制深浅主题时，同步调整系统状态栏/导航栏图标明暗。

## 本次验证结果

| 验证层                  | 结果           | 证据与边界                                                                               |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| Kotlin 与 APK 构建      | PASS           | `:app:assembleDebug`、`:app:assembleDebugAndroidTest` 成功。                             |
| Android JVM 单元测试    | PASS           | 5 项，0 失败；包含新增的中枢地址规范化与拒绝凭证/路径测试。                              |
| Android Lint            | PASS（有警告） | 0 errors、34 warnings、2 hints；未将已有资源/依赖/安全存储风格警告宣称为零。             |
| 共享业务回归            | PASS           | domain rules 与 v2 migration 共 16 项测试。                                              |
| 主题/动效令牌           | PASS           | `pnpm tokens:check`。                                                                    |
| 调试 APK 签名           | PASS           | apksigner 验证成功；这是 `.debug` 应用包，不是正式发布包。                               |
| Compose 设备交互        | NOT RUN        | 测试 APK 已编译；当前用户无 KVM 权限，软件模拟出现系统服务反复重启，重试后仍无稳定设备。 |
| 视觉/适配/无障碍验收    | NOT PROVEN     | 没有有效截图；真机字体缩放、IME、TalkBack、分屏与折叠姿态需实际检查。                    |
| 真实 Hub 同步与覆盖升级 | NOT RUN        | 本次未连接生产 Hub，未执行正式签名包覆盖升级。                                           |

调试包：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

SHA-256：`7d1a4817e233c0579c73be5bc2a135585f728cb267641c9a7cc0ddc92296022b`

设备准备好后执行：

```bash
cd apps/mobile/android
./gradlew :app:connectedDebugAndroidTest
```

新增设备测试覆盖：完成控件与详情点击隔离、显式状态菜单、输入草稿取消保护、紧凑宽度触摸目标、目录进入/搜索、详情切页和返回草稿保护、Room 保存、已删除归档任务排除。不能将这些测试的编译成功写成执行通过。

重构实现已经落地，但完整产品验收尚未闭环；没有推送、发布或部署。
