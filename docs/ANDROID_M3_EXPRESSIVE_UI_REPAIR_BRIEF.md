# 安卓原生客户端 M3 Expressive 视觉修复指导

**2026-09-24 更新：**用户已明确要求目录树作为首页、快捷视图置顶、设置从顶栏进入，并移除手机底部四栏 Dock。导航结构和系统栏处理请以 [新概念图与实施说明](ANDROID_M3E_DIRECTORY_CONCEPT.md) 为准；本文件保留上一轮截图问题及视觉修复依据。

状态：设计与代码审阅文档，2026-09-23。交给后续负责实现的 AI 使用；本文件不代表客户端已经修复或通过真机验收。

## 目标与证据边界

目标是让 TaskDock 的原生 Compose 界面具有图 5—9 所展示的清晰层级、柔和的容器关系、适度的形状变化和有意义的交互反馈，同时保持任务工具的高效与数据语义。交付物应是重新组织信息、状态和交互的界面，而非单纯换色、统一加大圆角或把每一行包成卡片。

- 图 1—4 是本项目当前深色界面的静态截图：更多、任务库、全部任务、计划。图 5—9 是用户提供的审美参考，分别展示了分组设置、账户面板、天气详情菜单、天气概览和搜索空态。参考图属于其他产品，不能据此断言其每个组件都符合官方 M3 Expressive，也不应照搬天气图表、背景渐变或相册插画。
- 静态截图可以确认视觉层级、密度、文案和遮挡；不能证明动画、触控、TalkBack、浅色模式或不同屏宽的表现。以下“根因”均以当前源码定位；修复后仍须真机复核。
- 当前工作区的 Web 文件已有未提交改动。本任务只针对 apps/mobile/android 的原生 UI；不应把 Web 的改动作为安卓截图的原因，也不应重置这些改动。

图片索引（同用户消息顺序）：

| 图  | 内容               | 原图路径                                                                                                                     |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | TaskDock 更多      | /home/lvziw/.codex/attachments/7434aab1-e4e5-474a-90bc-ee5ab3768de2/codex-clipboard-1a1f961e-c1a7-4c4f-aa07-29d2d86ab616.jpg |
| 2   | TaskDock 任务库    | /home/lvziw/.codex/attachments/52358ab8-02dc-4a5b-b1ac-5eaea5d02852/codex-clipboard-49a5cf04-9792-431a-925a-5029b0412491.jpg |
| 3   | TaskDock 全部任务  | /home/lvziw/.codex/attachments/ac959937-b00c-4459-885d-974a7f3aeffd/codex-clipboard-50044a74-8601-4064-a887-e49b61c71bb4.jpg |
| 4   | TaskDock 计划      | /home/lvziw/.codex/attachments/60c3be6c-3b98-47e9-93a9-4541d5d8ed9f/codex-clipboard-5759403c-b523-47c7-a5a7-ddb9fe93a0ef.jpg |
| 5   | 参考：分组设置     | /home/lvziw/.codex/attachments/0d10cebc-a7e7-4b07-b0a0-ad0faad4029a/codex-clipboard-8aaa384a-0859-4bcb-80dc-bfc9210f1b42.jpg |
| 6   | 参考：账户面板     | /home/lvziw/.codex/attachments/e4033b13-e2fa-4dbe-9ba8-657f8729b6f8/codex-clipboard-956cfc75-6238-4c64-b666-4be0732034a8.jpg |
| 7   | 参考：天气详情菜单 | /home/lvziw/.codex/attachments/e9b1c2a5-93c8-4b45-b154-597268e8e451/codex-clipboard-6af6b6eb-8366-4e4f-a4b8-2928bee6d7f9.jpg |
| 8   | 参考：天气概览     | /home/lvziw/.codex/attachments/03de75c3-700e-4b71-881f-2cd5b89fe990/codex-clipboard-d7ef05d4-2c0e-494e-8ceb-75d26f042341.jpg |
| 9   | 参考：搜索空态     | /home/lvziw/.codex/attachments/37b4b810-5994-464d-9ecb-3fb84f0a26ee/codex-clipboard-21211934-5364-475d-875d-0781e8188aeb.jpg |

## 核心判断

当前界面已经使用 NavigationBar、TopAppBar、ListItem、FilterChip、FAB 等 M3 组件，但视觉上主要依赖组件默认值。页面没有稳定的“主信息—次信息—操作”层级，背景与行容器大多同色；同样的列表行、页签、蓝色 FAB 反复出现。因此组件名是 M3，整页感受仍像未完成的功能原型。参考图的优势不是用了更多卡片，而是每屏有明确焦点、成组容器、恰当的留白和状态变化。

代码定位（行号对应本次审阅的当前版本；后续实现前请重新核对）：

| 确认的表现                                                                                 | 源码位置                                                                                                                                                                                                   | 对观感的影响                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 完整色板已定义，静态深色 surface/background 均为 #121318；动态取色默认开启，可覆盖静态色板 | [Color.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/theme/Color.kt#L116), [Theme.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/theme/Theme.kt#L142)                   | 色值本身并非唯一问题；页面未充分使用容器色形成层级。单张截图不能判定当时是否启用动态色。 |
| 字体直接使用默认 Typography()；Shape 只映射五个基础圆角槽                                  | [Type.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/theme/Type.kt#L5), [Theme.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/theme/Theme.kt#L102)                       | 缺少 TaskDock 自己的标题、数字、辅助信息与容器形状规则。                                 |
| 页面框架只限制最大宽度；各页自行组织标题、分组和间距                                       | [Workspace.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/components/Workspace.kt#L18)                                                                                                    | 同一界面的留白与容器节奏没有统一语法。                                                   |
| 两个二级页面都套同一个等分 TabRow；导航和 FAB 用默认组件                                   | [Workspace.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/components/Workspace.kt#L181), [TaskDockApp.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/TaskDockApp.kt#L62) | 图 2—4 出现宽大的空标题区、长横线页签与持续占位的悬浮操作。                              |
| 任务行背景几乎总是 surface，并把状态、目录、日期、参考编号接成一行辅助文字                 | [M3TaskRow.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/components/M3TaskRow.kt#L39)                                                                                                    | 所有任务看起来同权；状态重复、编号显眼，形成“数据库列表”观感。                           |
| 动效令牌主要是 200/300ms 时长；导航有淡入/短位移，任务状态和列表没有专属视觉过渡           | [Motion.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/theme/Motion.kt#L5), [TaskDockApp.kt](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/TaskDockApp.kt#L95)              | 源码表明缺少贯穿状态变化的动效方案；实际流畅度仍需录屏判断。                             |
| Compose BOM 固定为 2024.12.01                                                              | [variables.gradle](../apps/mobile/android/variables.gradle#L14), [app/build.gradle](../apps/mobile/android/app/build.gradle#L104)                                                                          | 采用新的 Expressive 专用 API 前要核对当前依赖可用性和稳定性，不能只照抄最新版示例。      |

## 修复规范

### 1. 建立适用于任务工具的视觉语法

以 MaterialTheme 的语义角色组织页面：全屏背景用 surface；页首摘要或重要状态选用 primaryContainer/secondaryContainer；成组设置和检索区选用 surfaceContainerLow/High；内部行可共用一个容器，通过适度的行距或细分隔建立关系。不要在深色模式里用发光边框和高饱和霓虹色营造“科技感”，也不要把全部内容变成独立浮卡。动态色开启和关闭都应成立；文字必须使用对应的 on* 颜色角色。

建立少量可复用的排版角色，而不是全局缩小字体：页面标题/摘要、分组标题、行主标题、辅助说明、技术元数据至少有清楚的权重与字号差。任务标题和日期应先被读到；参考编号、完整服务器地址只能作为次级信息。大标题可用一次，列表内部保持紧凑。以 16dp 页面边距、约 24dp 分组间隔、16—20dp 组内边距作为首版标尺，再用真机截图调整；不要直接按截图像素换算 dp。

形状用于表达关系和状态：页首摘要比内部控件更宽松，组容器与内层按钮的圆角有差异；选中与未选中控件形状/色调有明确联系。统一设计图标底板、行高、分组间距、FAB 与底栏间隙。整体应保留列表的快速扫描能力，不能把七个文件夹排成七张巨大的卡。

动画只服务状态理解：页签/筛选切换、完成任务、展开同步详情、FAB 展开/收起有短促且可中断的反馈；普通列表滚动、每个设置项不做持续弹跳。尊重系统动画缩放和无障碍设置。静态截图无法验证这一点，必须提供操作录屏。

### 2. 图 1：更多/设置

**问题。** 账户、服务器、队列都以同等权重的 ListItem 平铺，原始 URL 直接成为首页辅助文案；“同步”“更改”“查看”在右侧机械重复。下方靠 HorizontalDivider 把大段纯文字隔开，时区说明和默认位置说明占据与设置项相近的注意力。选项芯片有选中态，却缺少与所在设置组的容器关系。图 5—6 中的分组层级与账户摘要是可借鉴的关键。

**代码。** [SettingsScreen.kt:48-209](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/SettingsScreen.kt#L48) 连续渲染 ListItem/HorizontalDivider/FilterChip；[SettingsScreen.kt:358-376](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/SettingsScreen.kt#L358) 提供同步与时区文案。

**方案。**

1. 页首设置一个账户与同步摘要：用户名、可理解的同步状态、待提交/冲突数，主操作为同步。显示“空闲”时不得凭空宣称“已同步”；若要显示最后同步时间，先确认有真实数据来源。离线/冲突/认证失败应有区分清楚的色彩与行动入口。
2. “服务器连接”保留入口，但首页显示易读的主机摘要和连接说明；完整 URL 仍能在详情/编辑弹层查看与复制。保留切换服务器的待提交保护和重新登录流程。
3. 将“日期与安排”“外观”“数据”做成少量成组容器，每组内保留列表行和必要的分隔；周起始日、默认位置、主题选择采用明显的单选组合，解释文案贴近对应控件。归档中心与退出登录仍易找。
4. 一级入口若主要承载设置，建议将导航文案“更多”改为“设置”，保持原路由和功能，不制造新的信息架构层级。若仍保留“更多”，页首必须能让人一眼看出这是账户与设置页。

**验收。** 首屏无需读原始地址即可判断账户/同步状况；设置组一眼可分；更改服务器、离线、待提交和冲突的操作路径仍完整。浅/深/动态色均可读。

### 3. 图 2：任务库目录视图

**问题。** 连续文件夹由相同蓝色图标、同样字号、同样的“待办 · N 个任务”组成；视觉上无法迅速区分重要目录、空目录、进行中目录和真实任务。右侧每行的三个点形成一列噪声。标题“任务库”和紧随的“任务库”页签重复；大面积平坦背景削弱内容主体。图 5—6 的成组容器可以借鉴，图 9 的明确焦点也值得借鉴。

**代码。** [TreeScreen.kt:123-229](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TreeScreen.kt#L123) 控制标题、TabRow、扩展 FAB 和混合行；[TreeScreen.kt:439-477](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TreeScreen.kt#L439) 定义了按状态与 rank 的顺序。不能为了美观改乱这个排序契约。

**方案。**

1. 页首提供当前目录语境与轻量摘要，例如文件夹数、待处理任务数；进入子目录时有清楚的返回/层级线索。避免标题与页签同词、同权重复。
2. 文件夹行使用统一的柔和组容器或连续列表；图标可放入低对比度的小形状底板。标题为主、任务数为辅，状态用简短且有语义的提示。空目录不应与有待办目录完全同样显眼。任务行继续使用复选框，目录行继续使用文件夹符号，两类内容一眼可辨。
3. 保留行级菜单中的移动、排序、归档/删除能力，但在视觉上弱化频繁重复的三个点；保证菜单仍有可发现的触点和无障碍名称。新建文件夹目前藏在页首菜单，可给它更明确的可发现入口，且不能抢夺“新建任务”的主操作。
4. FAB 根据滚动和页面状态选择扩展/紧凑形态，列表末尾必须能完全滚出 FAB 的遮挡区域。不能仅靠添加底部 padding 掩盖不合适的尺寸。

**验收。** 使用截图中的七个目录与一个任务复测，不改变列表顺序；一眼能识别目录、任务、当前目录和主要创建入口；每行菜单仍可完成原有操作。

### 4. 图 3：全部任务

**问题。** 全宽直角感较强的搜索框、横向整排描边 FilterChip、无层次的任务行叠加在一起，像调试管理页。每条辅助文字都以“待办 · 编号”结尾；当前筛选为“全部”时尚可理解，切到“待办”时会反复重复状态。扩展 FAB 与最后几行竞争空间。参考图 9 的搜索主体、快捷分组及图 7 的清晰选中态可借鉴。

**代码。** [TreeScreen.kt:370-423](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TreeScreen.kt#L370) 是搜索/筛选/列表；[M3TaskRow.kt:47-69](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/components/M3TaskRow.kt#L47) 固定拼接状态、目录、日期、referenceId。

**方案。**

1. 将搜索与状态筛选形成一个可识别的检索区，突出搜索输入与当前选中状态；给出结果数或当前筛选语境。搜索进入输入态时保持可见的清空和退出路径，键盘弹出后不遮挡结果与操作。
2. 任务行依据场景决定辅助信息：全部任务可显示有意义的目录/日期/状态；已按状态过滤时减少重复状态；referenceId 保留在搜索、详情或低权重辅助位置，不能成为每条任务的第一视觉焦点。长标题和混合语言必须能稳定折行。
3. 用行间节奏、少量状态强调与分组背景提升可扫描性；完成状态应有清楚但克制的反馈，不能只用颜色。不要为每条任务做大卡片。
4. 空结果、无任务与正在输入搜索词是不同状态；空态文案和操作需对应。FAB 不覆盖最后一条任务或行菜单。

**验收。** 对图中含英文编号、中文标题的真实列表复测；任务标题优先，状态可读，编号仍可搜索/查看；筛选切换、任务完成/撤销及打开详情无回归。

### 5. 图 4：计划 / 日期与事件

**问题。** 多个过去日期与当天日期都显示“0 个任务”，占满首屏；DATE 与 EVENT 用同一日历图标、同样的行式样，原始 ISO 日期和英文事件标题并排出现却没有类别语境。页面很难回答“接下来要做什么”。右侧每行加号和右下角“安排任务”重复。图 8 的概览焦点、分层卡片可借鉴，但这里的主体应是日期、事件和任务。

**代码。** [PlanningScreen.kt:18-29](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/PlanningScreen.kt#L18) 放置页签；[TimeScreen.kt:27-108](../apps/mobile/android/app/src/main/java/com/devtodo/app/ui/screens/TimeScreen.kt#L27) 将所有活动 TimePoint 原样扁平渲染；[Daos.kt:213-222](../apps/mobile/android/app/src/main/java/com/devtodo/app/data/local/Daos.kt#L213) 目前按 type、localDate、rank 返回。TimePoint 与 Placement 有独立业务含义，不能因当前为空而删除数据。

**方案。**

1. 在展示层按“今天/接下来”“较早日期”“事件”建立可理解的组。优先展示有任务或接近今天的日期；历史空日期可折叠到“其他日期/查看全部”，保持可到达和可添加任务。不要静默删掉 TimePoint，也不要改变保存的 rank。
2. DATE 的 localDate 是日历日期，只按系统语言格式化为可读日期与星期，不要先转成 UTC 时间戳而产生跨日；设置时区用于判断“今天/过去/将来”，原 localDate 不变。EVENT 显示真实标题与“已到达/未到达”状态，使用区别于日期的图标/容器。截图里的英文短语可能是用户输入的事件标题，不能擅自翻译或覆写。
3. 日期或事件有任务时突出任务数量与下一步行动；零任务时文案更轻，行内加号可作为明确的就地创建入口。页级 FAB 负责“选择日期安排”；两者语义不同，应在文案与布局上明确，并验证不会重复造成误触。
4. 日期/事件下的任务仍引用同一个 Task；安排、新建、跳转目录、状态修改等已有路径保留。折叠和重新排序只作用于展示，不改数据关系。

**验收。** 以图中的过去空日期、当天空日期、英文事件名、未来有任务日期和已到达事件复测；首屏能找到“今天/下一步”，所有原 TimePoint 仍可访问；跨时区、跨月和大字体不截断。

## 建议的实施次序

1. 先做视觉基线：在当前机型保存图 1—4 对应的数据状态、深色/动态色开关、字体缩放、屏幕尺寸；同时拍浅色版。用 Figma 或 Compose Preview 先给出四屏静态稿和组件规则，确认标题、容器、间距、字阶、选中态，再进入代码。
2. 先改共享视觉基座：Theme/Type、页面标题与分组容器、页签/筛选外观、任务行元数据规则、FAB 的停靠与收起逻辑。不要把 Web 的 tokens.css 当成 Android 组件布局的唯一来源。
3. 再按图 1→图 2/3→图 4 落地页面；针对今日、流程、详情、归档做共享组件回归，避免只修截图页面却使其他原生页风格断裂。
4. 动效最后与实际交互一起调。当前 BOM 与新 Expressive API 的兼容性须先核对 [Compose Material 3 发布记录](https://developer.android.com/jetpack/androidx/releases/compose-material3)；优先使用项目能稳定构建的官方组件和 Compose 动画。不要为了一个新组件名贸然引入预览依赖。

## 给修复 AI 的硬性验收清单

- 提交同数据、同机型、同主题的图 1—4 前后对照，并补充浅色、动态色开启/关闭、200% 字体、窄屏/横屏截图。对照须显示页面首屏和列表底部，不能只展示空态或裁掉底栏。
- 提供简短真机录屏：切换任务库/全部任务、搜索与筛选、完成/撤销任务、展开同步详情、日期创建与滚动到末尾。逐项说明动效是否有明确状态反馈，系统动画缩放关闭时是否仍可用。
- 保证所有操作触点至少 48dp，TalkBack 可读出选中、完成、同步异常和菜单动作；检查标题换行、中文/英文混排、系统大字体、IME 与底部导航/FAB 的遮挡。
- 运行 Android 编译、lint、现有单元/Compose 设备测试；新增测试只覆盖有回归风险的交互与数据展示逻辑。编译成功不能代替真机视觉和操作验收。
- 保持 Task/Folder/TimePoint/Placement/Workflow、referenceId、离线与同步协议的含义及原有操作能力。视觉重组如需改查询排序，应证明只是展示排序，旧数据、任务定位及创建目标仍正确。
- 最终说明每处变更对应本文件哪条问题、提供代码差异和测试证据；未跑的设备、主题或无障碍场景明确标为未验证。

## 官方依据与本项目既有约束

- [Android：Material 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3)：主题由色彩、字阶与形状共同组成；容器色、语义色对与组件定制有明确用途。
- [Android：Material 3 组件发布记录](https://developer.android.com/jetpack/androidx/releases/compose-material3)：检查具体 Expressive API 与本项目依赖的兼容性。
- [Android：Compose 动画](https://developer.android.com/develop/ui/compose/animation/introduction) 与 [无障碍触点](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)：动效要传达状态，交互目标至少 48dp。
- 仓库 [ANDROID_MATERIAL3_REBUILD.md](ANDROID_MATERIAL3_REBUILD.md#L13) 要求保持四个一级目的地、任务/目录/日期/流程语义、离线能力和设备验收；[ADR 0003](adr/0003-material-3-expressive.md#L19) 是已有 Expressive 迁移决定，但其中的 Compose API 限制属于当时版本结论，实施前应按当前依赖复核。
