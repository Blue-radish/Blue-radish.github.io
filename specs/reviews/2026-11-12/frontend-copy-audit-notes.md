# RadishCloud 前端与画像文案审查笔记

审查时间为 2026-11-12。源码根目录为 `D:/Users/Ray/Desktop/project/RadishCloud`。此笔记供主审合并进远端开发 agent 的一次性交接报告。未修改产品源码、未安装依赖、未访问生产数据库。

## 已执行的验证与边界

- 静态逐行检查 `frontend/src`、`src/radishcloud/mirror.py` 和相关 API、计数、删除实现。
- 使用现有 Python 3.12 运行纯函数合成输入。解释器为 `C:/Users/Ray/AppData/Local/Programs/Python/Python312/python.exe`，以 `-B -` 从标准输入执行。脚本将 `RadishCloud/src` 和 `.venv/Lib/site-packages` 加入 `sys.path`。没有加载应用和数据库。
- 使用现有 Node.js 和 TypeScript 的 `transpileModule`，在内存 VM 中提取并运行 SFC 的原始脚本，mock Vue 的 ref/computed、路由和 API，控制 Promise 返回顺序。确认 MirrorView、VisitDrawer 旧响应覆盖新响应。此验证属于函数级运行验证，未进行真实浏览器挂载或网络请求。
- 尝试只读类型检查 `node node_modules/vue-tsc/bin/vue-tsc.js --project tsconfig.app.json --noEmit --incremental false`，现有 node_modules 缺少 `@volar/typescript/lib/quickstart/runTsc`，工具启动失败。未完成类型检查，不应将该结果写成类型错误或编译通过。
- CSS 数字来自只读脚本扫描，未执行浏览器缩放、键盘、屏幕阅读器或新截图验收。

## P1 先修复真实错误

### F01 隐私记录的画像响应缺少必填 counts

位置为 `src/radishcloud/mirror.py:921–930`、`src/radishcloud/app.py:416–424`、`frontend/src/types.ts:133`、`frontend/src/views/MirrorView.vue:346–357`。

触发条件是任一 `meta.privacy.optout=true` 的记录。后端直接返回隐私分支对象，未补齐 `counts`，前端随即求值 `mirror.counts.total_visits` 等表达式。纯函数运行已确认返回对象中 `counts` 为缺失。模板抛错属于静态确定结果，尚未真实挂载页面。

最小修复是统一响应形状，决定隐私状态下计数的显示政策，并让 UI 对明确的隐私状态隐藏计数区域。避免拿虚构零值冒充已计算统计。验收需通过正常 API 入口打开一条隐私记录，显示隐私说明且无渲染异常，响应形状与 TS 声明一致。

### F02 画像与详情异步响应可以串记录，删除目标随 props 漂移

位置为 `MirrorView.vue:159–176,179–211`、`VisitDrawer.vue:105–125,152–179`、`api.ts:40–57`。

函数级运行验证中，先请求 A 后请求 B，让 B 先返回，最后页面状态被 A 覆盖。MirrorView 最终 `mirror.short='A'`，VisitDrawer 最终 `visitId='B'` 而 `detail.record.id='A'`。真实 UI 中标题 ID、下载链接、当前选中项来自 B，正文来自 A。删除处理始终读取 `props.visitId`，因此用户可能依据 A 的正文删除 B。DELETE 完成后第 159 行再次读取 props，若此时切换为 C 或关闭抽屉，父级收到的 deleted 事件又会是 C 或 null。

最小修复是在各请求入口捕获不可变的 request id/query snapshot，用递增 token 或 Vue watch cleanup 判断响应仍对应当前选择。仅当前请求允许提交 data/error/loading/finally 状态。DELETE 在确认弹窗打开时固定待删除 ID，提交和完成事件使用同一值。详情未成功载入且与当前 ID 一致时，删除入口应禁用。

验收使用 mock A=200ms、B=20ms，以及请求中关闭、切换、删除三种情况。任何响应都不能改变其他记录的数据或 loading。删除请求 URL 与确认框里的 ID、deleted 事件必须完全相同。无需引入通用缓存框架或复杂全局状态机。

### F03 从画像点击“原始记录”无法打开同一条详情

位置为 `MirrorView.vue:336–343`、`VisitsView.vue:171–179,188–194,205–210`。

“原始记录”链接跳到同一个 VisitsView 实例并修改 query，`tab` watcher 会清空 selectedId。读取 `focus` 的 `maybeOpenFocus()` 仅在 onMounted 中运行，已有实例不会重新挂载，因此 focus 留在地址栏，抽屉未打开。类似的同组件 query 导航也不会重新执行 `applyRouteFilters()`，因为其仅在第 206 行执行。当前代码仅 watch tab，未 watch focus 或查询过滤字段。

最小修复是由 route query 驱动 tab、focus、筛选，在对应 watcher 中统一解析并加载，避免另维护一份不自动同步的 route 状态。验收必须覆盖画像→原始记录、同页面变更 focus、同页面变更 ip/fpid 查询、回退导航和直接粘贴 URL，记录与筛选始终匹配 URL。MirrorView 还需 watch `route.query.id`，现有第 231 行仅 watch 日期，外部修改 id 不会更新选中画像。

### F04 列表刷新、分页、切换筛选的响应会混在一起

位置为 `VisitsView.vue:74–101,197–202`、`MirrorView.vue:179–211`、`FacetDetailView.vue:63–105,146–153`、`DistributionView.vue:156–188`。

这些入口均无失效守卫。典型触发为加载第 2 页时更改日期/搜索条件，旧分页结果随后追加到新列表。VisitsView 的自动刷新只检查 `loading`，没有检查 `loadingMore`，第一屏有 50 条且分页中，5 秒 tick 可同时 reset，导致列表/游标顺序取决于返回时序。FacetDetailView 的搜索防抖只减少请求次数，不处理已发出请求的返回顺序。分布页切换单卡口径后立刻改变标签，失败时旧数据仍显示在新口径下，且旧单卡请求可返回到另一个分组。

最小修复为每次 reset 增加查询 generation，分页绑定同一份已提交查询快照和 cursor，旧 generation 全部丢弃。分页期间暂停自动刷新。口径标签和数据一起提交或失败回滚。清理卸载时的搜索 timer。验收采用受控延迟，覆盖搜索 A→B、时间范围改变、分页→重置、分组→口径改变，保证列表无混入、无重复，标签始终对应实际数据。

### F05 缺失输入被写成确定的“鼠标键盘”“无差异”

位置为 `mirror.py:228–242,249–265,716–725`、`MirrorView.vue:109–112`。

纯函数验证中，空 record 返回 `input_class='鼠标键盘'`、`geo_conflict=false`。原因是 `_touch_info()` 将缺失数据归零，`conflict is False` 又把 unknown 归为 false。只有 `{screen:{w:390,h:844,dpr:3}}` 的记录会生成“设备是桌面机”和“输入是鼠标键盘”，这是没有依据的肯定陈述。

最小修复是保留 touch/hover/geo comparison 的三态值，缺失时派生字段为 null，并省略该句或显示未取得信息。仅宽度不足以定为桌面机，缺少 form/可靠 UA 时使用“设备形态未知”。验收用空 record、screen-only、unsupported/denied、明确 touch=0、有触控但无 hover，逐一确认未知不会变成否定或默认设备类型。

### F06 codec 名称出现就声称硬解，负面值同样命中

位置为 `mirror.py:680–687` 和 `tests/test_mirror.py:37,71–103`。

纯函数验证输入 `{'cli':{'codecs':{'hevc':False,'av01':False}}}`，输出“HEVC / AV1 都能硬解”。当前做法只将所有键值串起来搜索名称，既没检查成功值，也没有硬件解码证据。

最小修复是按实际 collector 合同解释明确的成功值，将普通播放能力写成“报告支持 HEVC / AV1 播放”。只有采集到可解释的硬件/功耗效率信息时才使用限定文案。验收应包含 false/空字符串/unsupported、只支持一种、列表式旧记录和含完整 MIME 类型的记录。现有测试和快照也需纠正，避免继续固化误述。

### F07 显卡泛化 renderer 被当作硬件型号

位置为 `mirror.py:335–361,823–825`、`MirrorView.vue:73–74,98–104`。

纯函数验证 `webgl.renderer='WebKit WebGL'` 会生成“显卡 WebKit WebGL”。`WebGL renderer`、`unmaskedRenderer`、`WebGPU architecture` 的来源和可靠性在派生结果中丢失，软件渲染器与泛化字符串均可能被写成显卡硬件。

最小修复是在既有派生结构中保留最小的来源/状态信息，明确区分“浏览器报告的图形渲染器”和“可能的 GPU 型号”，识别已知泛化、软件 renderer。不能根据缺少硬件型号直接断言无显卡。验收输入 ANGLE NVIDIA、Apple、Mesa、SwiftShader、WebKit WebGL、缺 WebGL 但有 WebGPU、两者矛盾，确认正文保留原始可核对字符串并使用适当限定语。

### F08 指纹总次数被写成访问序号及真人回头客

位置为 `mirror.py:894–902,968–971`、`db.py:638–654`。

`identity_counts` 统计当前全部保留 visit 行，没有按这条记录的时间截断。因此打开任一旧记录得到的 N 是当前库中相同值的总数，无法作为这条记录的“第 N 次出现”。相同 fpid 多次也不足以断言“属于回头客”。“硬件号”本身仍是浏览器采集值，不具备物理硬件唯一性证明。

最小修复只改文案为“当前保留记录中，相同指纹出现 N 次”，把 hwid 展示为“设备特征标识”并保留技术键用于核对。需要真正的历史序号时再扩展查询，本轮无需为文案另建身份系统。验收同时打开同一 fpid 的早晚两条记录，两处均陈述总计口径，并在删除/保留期清理后正确说明统计范围。

## P2 按实际证据修正文案

### F09 屏幕与 DPR 名称超出字段含义

位置为 `mirror.py:710–743,867–886`、`MirrorView.vue:75–76`。`screen_phys` 直接拼上报的 screen.w/h，DPR 直接乘 100 写为“缩放”。纯函数 screen-only 案例已确认产生 390×844、300%。对接 collector 需确认 w/h 的单位，若为 screen.width/height，则标签应为 CSS 像素屏幕尺寸。DPR 应写设备像素比，不能直接当浏览器或系统缩放百分比。保留历史 API 键也可先修显示名，避免无必要的兼容迁移。验收覆盖 DPR=1/1.25/2/3 和页面缩放，不声称量出物理尺寸或真实显示器像素。

### F10 macOS 标准 UA 解析遗漏与 Client Hints Windows 映射

位置为 `mirror.py:268–301`。纯函数验证标准大写 `Macintosh; Intel Mac OS X ...` UA 且无 cli.os 时 os_name 为 null，原因是第 285 行在原始 ua_text 中使用小写匹配。统一小写后解析即可。Windows 第 280–283 行只将 major 19 写 11，却将 14/15 写 10。该版本阈值须按当前官方 UA-CH 文档重新核验，不能凭旧映射继续推断。验收含标准 macOS UA 与 platform-version 的版本边界，以及 client 声明和 UA/CH 不一致的输入。

### F11 代理“可能性较高”由关键词直接产生

位置为 `mirror.py:19–63,381–395,547–559,640–658`、`MirrorView.vue:393–399`。当前只要 ASN/PTR/部分出口 ISP 中包含关键词即 strong，并直接输出代理或 VPN 可能性较高。未知文本默认成“商用线路”。语言映射把全部 zh 归 CN，zh-TW/zh-HK 在其惯常地区也可成为弱信号。时区和语言同时偏离即 medium，缺少对独立性和概率的证明。

最小修复是保留可解释事实“出口所属网络含某关键词”“系统时区与出口国有差异”，将未知网络类型留空，避免把启发式等级写成经过标定的概率。若保留语言提示应处理具体语言地区并避免直接计入代理判断。验收含台湾 zh-TW、香港 zh-HK、海外中文用户、企业云桌面、缺 ASN、关键词只在无关字段出现、分流与 IPv4/IPv6 差异。TLS/JA4 不可见的说明宜简短且对应实际服务端采集能力。

### F12 来源名、摘要、时间与缺失状态仍有事实偏差

- `MirrorView.vue:122–124` 将 ASN 固定标为 Team Cymru，但 `collector.py:127–129` 优先使用 DB-IP 的 ASN。应显示真实来源或只标 ASN 数据，验收两条不同来源记录。
- `VisitDrawer.vue:257–258` 将 IP 地理时区优先显示为“时区”，系统时区被遮蔽。分开标为出口地理时区和浏览器系统时区，验收二者不同时均能读出。
- `mirror.py:210–225,747` 无 offset/tz 时回退 ts.hour 并称“本地时间”。纯函数仅有 UTC ts 会得到 local_hour='中午 12 点'。未知客户端时区应返回 null，验收仅 srv.ts 的记录无本地时间推断。
- `VisitDrawer.vue:375` 声称“聚合表 facet_daily 不受影响”，但 `db.py:783–793` 确实扣减并清理聚合。应与实际删除语义一致。
- `MirrorView.vue:408` 固定“六句话”，后端还可包含 bot/privacy，数量不固定。直接改为“访问解读”并移除装饰编号。
- `mirror.py:993–1003` 将 full 限制在 400 字并跳过整句，而 UI `MirrorView.vue:329,334`、`VisitDrawer.vue:299` 称“完整叙述/复制文案”。保留现有 API 长度合同的最小修复是改称“短文案”，另让 parts 显示所有事实，避免承诺完整。
- `App.vue:119–138` 服务运行、127.0.0.1:11451、仅回环、默认 total=124 均硬编码，meta 请求失败也看起来正常。`App.vue:61` 吞掉 meta 错误，分布页 `DistributionView.vue:210–216` 又以“parent handled”吞掉错误，可能长时间显示空分组和假默认值。至少展示元信息加载失败与重试，把未知状态显示为未知，标题使用动态探测项数。
- 电池在 `registry.py:129` 已定义，mirror.py 完全未消费 battery。应先确认 collector 历史数据形状，再将电量/充电状态/不支持/拒绝等转为人类可读条目。不要从无 battery 字段推断台式机，充电或电池缺失均不足以确定设备形态。

## P2 可读性、可访问性与 CSS 的最小改造

### F13 信息密度与截断妨碍读取核心证据

`styles.css` 有 5,182 行，扫描到 232 处固定 px 字号，其中 200 处不超过 12px。画像区第 2362–3037 行有 35 处固定 px 字号，31 处不超过 12px，23 处低于 10px。主标题另用 22–31px 的 clamp，见 2589–2595 行。与之相邻的正文 11px（2602）、叙述 11.5px（2882）、依据 7.5px（2897/2906）、派生标签 7.5px（2941）、派生值 9.5px（2948）、技术键 6.5px（2959），比例失衡。

`proxy-signal-body > strong` 第 2779–2784 行和 `.derived-item > strong` 第 2944–2951 行固定单行省略，模板第 387、446 行没有 title 或展开入口。显卡型号、ASN/PTR、多出口值最容易变成用户无法完整读出的关键证据。

最小改造是在既有 MirrorView 中保留简短标题与一段摘要，按网络/设备/浏览器/隐私分节显示事实，技术证据通过原生 details 展开。让主正文和数值采用明确一致的可读字号，证据与长字符串允许换行。删除重复出现的同一设备/GPU/计数，不再同时维护大标题拼串、summary、full、parts、平铺 derived 五种同屏叙述。

验收用现有 profile 场景和极长 GPU/PTR，在 1440/1024/390px、浏览器 200% 缩放下完整读取主要信息，无横向溢出。新增或调整字号的具体基准属于设计决策，应由开发在交付时明确说明。

### F14 对比度与键盘操作

CSS 变量浅色 `--faint=#929292` 位于第 26 行，白色 surface 下计算对比度约 3.11，surface-2 下约 2.90。深色 `--faint=#6f6f6f`（第 56 行）、surface=#0e0e0e（第 50 行）约 3.84。画像标签/证据大多采用 faint 且字体远低于大字标准。这里是代码色值计算，尚未实际取屏渲染像素。

`VisitDrawer.vue:194`、`AppModal.vue:55` 声明 aria-modal，却没有入场焦点、焦点约束、背景 inert、关闭后焦点归还。键盘可留在背景；AppModal busy 时仍能 Escape、蒙层或右上角关闭（29/54/61），与禁用取消按钮行为不一致。VisitDrawer 的 deleteOpen 也不随 visitId=null 清除，关闭抽屉后确认框仍可能存在。

`VisitsView.vue:229–249`、`DistributionView.vue:262–278` 使用 tab 角色但没有方向键、Home/End、tabindex 管理、tabpanel 关联。`VisitsView.vue:292–299` 和 `FacetDetailView.vue:255–259` 的搜索 label 没有有效文字，图标/占位文字未提供稳定命名。RangePicker、统计模式、自动刷新按钮缺少可访问的 pressed/checked 状态。`TrendChart.vue:125–128` 只有泛化 aria-label，逐日数值仅鼠标悬停可读。

最小修复采用一处共享弹窗焦点逻辑，统一 drawer/modal 的焦点生命周期和关闭政策。简单双按钮切换可改用 group+aria-pressed，避免假 tab 语义。搜索补明确 label。图表补可展开数据表或文字列表。验收全程仅键盘，焦点可见、顺序稳定，确认框打开时背景不可操作，关闭返回触发位置，屏幕阅读器可读搜索名称及当前选中状态。

### F15 控制改造范围，避免为了拆分而拆分

静态扫描未发现大量同选择器互相覆盖的追加补丁。顶层精确重复主要为 `.mirror-missing`（2819、2964）和 `.system-card`（4108、4441），分别声明 padding 与 margin，当前均为互补样式。因此不能以“CSS 大量重复覆盖”为既成事实要求全盘重写。

可复用处应只做有明确收益的提取。`VisitDrawer.vue:71–94` 每个 group/row 重复 flatMap/find 定义，已有 `stores/meta.ts:10–20,46–54` 的索引与 facetDef/groupOf 可复用。画像区样式第 2362–3037 行可迁入画像组件附近，并复用已有 card、标题、按钮、字段容器。优先修复请求生命周期和路由状态单一来源，再根据新的事实分节结果提取一个仅展示的画像组件，供抽屉与画像页复用。保留 API 模块和现有 Vue/Router 技术栈，避免额外引入全局缓存、规则插件系统、复杂 schema 渲染器或设计系统工程。

建议远端执行顺序为 F01–F04 保证正确记录与交互，F05–F12 修正事实和文案，F13–F14 完成可读性与键盘验收，最后仅做 F15 中直接降低重复维护成本的整理。类型检查与真实浏览器验收仍需在依赖完整的远端环境完成。
