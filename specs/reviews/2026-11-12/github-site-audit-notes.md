# 博客仓库只读审查笔记

审查日期为 2026-11-12。工作树起点为 `9d76f94`，审查前 `git status --short` 为空。仓库根目录为 `D:\Users\Ray\Desktop\project\Blue-radish.github.io`。递归查找没有发现实体 `AGENTS.md`，遵循会话中的简体中文要求。

本次仅创建本审查笔记。未修复产品代码，未提交，未操作线上接口。系统性调试技能用于追踪输入、边界和最小复现。后续计划属于给开发 agent 的建议。

## 当前结构与已有能力

| 位置 | 职责与现状 |
| --- | --- |
| `static/radish-collect.js` | 1362 行无外部运行依赖的浏览器 IIFE，版本 1.0.4，约 66 KB。包含探针注册、哈希、网络辅助、16 路执行、超时、信封、预算、会话去重、Beacon 与 fetch 回退。对外暴露 `window.__radish` |
| `docs/radish-collect.js` | 本地已生成发布产物快照，版本 1.0.3，包含旧 waitIdle。与上项不一致。主 agent 实测线上自定义域脚本已是1.0.4 |
| `config.json` | Gmeek 配置，经 allHead 向所有页面注入采集器及外部插件，GMEEK_VERSION 为 last |
| `.github/workflows/Gmeek.yml` | owner issue、main push 和每日定时触发。克隆 Gmeek、安装 Python 依赖、生成 HTML、自动提交、上传 docs、部署 Pages |
| `docs/*.html`、`docs/post/*.html` | 已生成博客页面。没有访客诊断界面，没有用户可见的诊断卡、来源、解释、可信度或主动运行入口 |
| `backup/`、`blogBase.json`、`docs/postList.json` | Markdown 内容备份与生成数据，应继续交给既有生成链维护 |
| `specs/radishcloud-contract.md` | 跨仓库 HTTP、字段、存储与后台契约 |
| `specs/2026-11-11-visitor-mirror.md` | 中文画像规则，输入为已落库 record，输出拟由 RadishCloud admin API 提供 |
| `tests/harness.js`、三个 test.js、`tests/ids.json` | Node VM 模拟环境的 23 个测试及 124 项目录。只载入 static 采集器，未执行真实 DOM、布局、GPU、网络 CORS、后台或 Pages 构建 |

已有优点包括顶层七字段信封、版本号、幂等 id、无服务端字段伪装、DNT/GPC 时 cli 为空、缺失标记、探针异常隔离、单项与整体耗时限制、Blob text/plain、keepalive 回退、可追踪的 stuck/truncated 元数据。

实测 `RC.probes.length` 为 100。非 optout 且 hints 可读时，另由 trace/hints 派生 kex、warp、proto、edge、ch，得到 105 个 cli 键。ch 不可读时可能只有104个键。124为跨客户端、边缘头、源站计算和不可观测项的目录总数，不代表124个已实现且有效的测量能力。

其中 geoloc、sensors、trackers、extwar 四项固定返回 denied，根本没有执行相应实验；gamepad 在API存在时也直接 denied，否则 unsupported。timer.jitter 固定为0；screens.n 只会返回1或2；shield.noise 使用随机数是否相等的弱代理。上述有键或有值都不能视为能力验收通过。现有模拟环境构造的一次信封有59项 value、42项 unsupported、4项 denied，该比例只描述测试桩，不能当作真实浏览器成功率。

契约由博客向 `POST /v1/collect` 单向发送七字段信封。RadishCloud 补齐 srv、落库、facet、管理后台和画像。客户端还读取 `/cdn-cgi/trace` 与 `/v1/hints`。该仓库没有后台实现，不能从这里证明监听地址、admin 访问控制、SQL 参数化、限流、清理或代理头信任已经正确。

## 已执行验证

- `node --version` 返回 `v22.21.0`。
- `node --test tests/*.test.js` 完成，23 通过、0 失败，测试报告总耗时约 6.9 秒。
- `node --check static/radish-collect.js` 与 `node --check docs/radish-collect.js` 均通过语法检查。
- `git diff --no-index -- static/radish-collect.js docs/radish-collect.js` 确认版本和 waitIdle 不一致。
- 两个文件 SHA-256 分别为 `C4ABA6F9EB3859C4C412C84A41C68A2BEA0C8D56BF1357DECDD8CC6C0228260A` 与 `635B6D537DBC883FE58378204D6DAE789B823FB073B3818AB6550743431734DC`。
- 使用现有 harness 的一次性 Node stdin 脚本进行了以下复现。没有新增测试文件，没有发出真实网络请求，所有 fetch 为模拟实现。

主 agent 另行进行经审批的公开 HTTP GET，并向本审查传回结果。`https://blog.072120.xyz/radish-collect.js` 返回200、VERSION1.0.4、64901字节、Cache-Control max-age14400。因此本地 docs 的1.0.3只是工作树产物滞后，不能推断线上仍是1.0.3。`https://blue-radish.github.io` 的客户端请求异常，未完成验证。RadishCloud `/admin` 返回404；`/v1/hints` 返回200，ACAO为 `https://blog.072120.xyz` 且 no-store；trace 返回200且 ACAO为 `*`。这些是主 agent 的检查结果，本子 agent 未自行访问线上。没有调用 collect。

| 复现 | 实际结果 |
| --- | --- |
| 对同一个 env 同时 `Promise.all([RC.run(env), RC.run(env)])` | 两个结果均为 sent，Beacon 数为 2 |
| Beacon 返回 false，fetch reject，再运行一次 | 结果为 `[failed, already]` |
| ICE candidate 为 `candidate:123456 1 udp 2113937151 192.168.1.8 54321 typ host` | `lan={ips:[],mdns_only:true}` |
| trace 在 100ms 后返回有效 ts/http/tls，走正常 RC.run | clock.skew_h 为 null，proto 正常有 HTTP/2 与 TLSv1.3 |
| DNT=1，fetch spy | 仍请求 trace 和 hints 两个接口 |
| 40 个 voice，每个字符串 20000 字符后 applyBudget | 最终 183757 字节，预算 49152 字节 |
| 同一 env 仅将 screen.availHeight 从 1040 改为 900 | hwid 变化 |

XSS 使用 `node:vm` 从实际 `docs/tag.html` 提取 `updateShowTag`、`setClassDisplay`、`searchShow` 原函数，模拟 document 并记录 innerHTML setter。输入为 URL hash 编码后的 `<img src=x onerror=globalThis.__auditFlag=1>`。观察到三个 sink 原样收到含事件属性的 HTML，依次为 Tag 标题、Search 标题和 Not Find。受控复现未执行事件处理器，也未在用户浏览器或线上站点注入。

PowerShell 每次启动都有文件系统驱动初始化提示。login=true 还遇到 conda profile 错误，后续使用 login=false，Node 命令和结果不受该提示影响。

## 发现清单

### G01 · P1 · 搜索页 URL hash 可进入 innerHTML，形成 DOM XSS

- 证据位于 `docs/tag.html:144`、`:238`、`:266`、`:278`。初始化将 `decodeURI(location.hash.slice(1))` 直接交给 setClassDisplay，再进入多个 innerHTML。搜索框也是同一不可信来源。
- 触发条件是打开带 HTML 的 tag.html hash。无需修改文章或拥有仓库权限。VM 已验证完整源到 sink 路径。
- 影响是攻击者控制的 HTML 进入博客源。浏览器可执行事件属性，继而读取该源可访问的数据、伪造界面或发起请求。真实浏览器的事件执行与线上 CSP 仍需开发验收时确认。
- 最小修复是在生成模板中对纯文本使用 textContent，取消标签 onclick 字符串拼接。当前模板来自 Gmeek 外部源码，因此只改 docs 产物会在下次生成被覆盖。需要固定生成器版本并提供本地模板覆盖或受版本控制的生成后变换，确保所有同类 sink 一并处理。
- 验收要求是无害 img/onerror 字符串在 hash、搜索框、文章标题和标签中均显示为文本，DOM 不生成 img。重跑完整博客生成后仍成立。不要仅验证补丁后的单个 docs 文件。

### G02 · P2 · 测试源文件与部署文件漂移，CI 没有测试门禁

- 证据位于 `static/radish-collect.js:10` 为 1.0.4，`docs/radish-collect.js:10` 为 1.0.3。waitIdle 位于 static 的 `:1268`，docs 中仍为等待 load 的旧逻辑。`tests/harness.js:6` 固定读取 static。`.github/workflows/Gmeek.yml:70` 发布 docs，工作流没有 Node 测试步骤。
- 影响是本地全部测试通过仍无法证明最终上传的采集器通过了同样测试。该快照证明本地生成副本滞后，主 agent 的线上 GET 则确认自定义域实际已运行1.0.4。当前证据不支持“线上部署旧采集器”的结论。
- 最小修复是规定 static 为唯一来源，构建时显式复制并比较产物，然后对最终发布文件运行同一组测试，完成后才上传 Pages artifact。
- 验收要求是干净工作树构建后两个文件逐字节相同，测试实际加载待部署 artifact，故意造成副本不一致或测试失败会阻止 deploy。

### G03 · P2 · pagehide 只解除 idle 等待，没有立即发送已采集结果

- 证据位于 `static/radish-collect.js:1287` 至 `:1304`。pagehide 的 resolve 只参与 waitIdle 的 Promise.race，此后仍等待 buildEnvelope、探针超时和 ctx.ready。
- 在正常用户先停留数百毫秒再离开的路径里，race 早已完成，pagehide 不再影响发送时刻。移动端关闭页面或浏览器冻结页面时，异步工作可能无法继续，导致短访问系统性丢失。
- 现有测试 `tests/beacon.test.js` 的 pagehide 用例只证明总耗时小于三秒，其约 1.25 秒结果支持“继续等待探针”，未证明在离开事件中同步排队 Beacon。
- 最小修复是使用一个运行状态保存已完成字段，pagehide 或合适的 hidden 生命周期在有未发送结果时立即组装部分信封并排队 Beacon，随后常规完成路径共享同一发送闸门。
- 验收要求是将一个探针永久挂起，在 pagehide 处理器返回前已观察到 Beacon 入队，剩余字段有清晰未完成状态，正常完成与离开事件并发也仅发送一次。

### G04 · P2 · 发送完全失败仍标记 sent，阻止会话内恢复

- 证据位于 `static/radish-collect.js:1324`，markSent 无条件执行。
- Beacon 返回 false 且 fetch reject 时，本次返回 failed，下一次返回 already。一次暂时离线会让该标签页后续所有文章失去采集机会。
- 最小修复是区分正在发送、已排队成功和失败，只有实际成功排队才保存 sent。失败时保留同一 id 的有限重试机会以使用后端幂等。
- 验收要求是模拟首次离线随后恢复，第二次运行可以发送，最终只保存一条记录。Beacon 返回 true 的含义应在状态命名中保留为已排队，不能当作服务器确认落库。

### G05 · P2 · 并发 run 绕过去重

- 证据位于 `static/radish-collect.js:1283` 与 `:1324`。只有结束后才设置标记，没有 in-flight 保护。
- 相同 env 同时调用两次 run 已复现发送两条，各自生成不同 id，因此后端 id 幂等也无法去重。当前正常自动启动为一次，但诊断 UI、手动重试或外部调用已暴露的 RC.run 会触发。
- 最小修复是每个运行上下文保存一个正在执行的 Promise，让并发调用复用它，生命周期发送也复用状态。
- 验收要求是自动启动、用户手动运行与 pagehide 交错时，一次采集生成一个 id 且最多一次发送。明确重测行为另行决定，不要沿用隐藏会话去重。

### G06 · P2 · ICE 地址解析读到 candidate foundation

- 证据位于 `static/radish-collect.js:99` 至 `:102`。正则匹配第一个三位以上十六进制片段，合法 candidate 中这通常是 foundation，并非第五个地址字段。
- 已复现带明确 `192.168.1.8` 的 host candidate 最终 ips 为空，错误标记为 mdns_only。IPv6 同样可能丢失。`iceServers:[]` 也意味着当前只收集 host，不能据此证明公网 WebRTC 出口。
- 最小修复是优先使用 RTCIceCandidate.address 和 type，兼容时按 candidate 语法解析地址字段，分别记录无候选、mDNS、IPv4 和 IPv6，完成或超时时 close PeerConnection。
- 验收要求覆盖数字 foundation、mDNS、IPv4、IPv6、空候选和构造失败，不能把空结果标成确认只有 mDNS。硬件 MAC 泄露判断需要使用已规范化的 IPv6，而不是原始字符串局部搜索。

### G07 · P2 · clock 与异步 trace 存在确定性时序缺陷

- 证据位于 `static/radish-collect.js:77`、`:1297`、`:1174` 至 `:1177`。clock 为队列首项，在 trace/hints ready 之前执行；其他 trace 派生字段则在 ready 之后生成。
- 正常异步 fetch 延迟 100ms 的复现得到 clock.skew_h=null，proto 正常。测试使用预填 collectorCtx，绕过了该生产时序。
- 最小修复是把依赖 trace 的时钟偏移与 proto 一起在 ready 后计算，并保留网络往返时间导致的估计误差。与服务器差值不足 0.1 小时时不应提前四舍五入成零来支持精确结论。
- 验收要求是正常 RC.run 和延迟 trace 下能得到偏差，trace 无法读取则明确无数据，人工错钟 30 分钟、2 小时和未知时区均有稳定输出。

### G08 · P2 · 多项字段名、契约说明与实际测量对象错位

| id | 代码证据 | 契约语义 | 当前实际 |
| --- | --- | --- | --- |
| hour | `static/radish-collect.js:191` | 时钟格式 hourCycle | 当前小时 0 至 23 |
| week | `:192` | 一周从哪天开始 weekInfo | 当前星期几的本地化文本 |
| engver | `:464` | JS feature probes 推断引擎真实版本 | UA 文本正则提取 major |
| gpulim | `:704` 至 `:707` | GPUAdapter limits/features | WebGL MAX_TEXTURE_SIZE 与扩展 |
| media | `:755` | enumerateDevices 摄像头与麦克风 | CPU/MediaSource/HTMLMediaElement 存在性 |
| audiohw | `:763` 至 `:764` | AudioContext.sampleRate | 媒体输入输出设备数量 |
| agent | `:983` 至 `:992` | pointer/mouse/isTrusted 操作方式 | UA-CH 品牌和 UA 一致性 |
| stack | `:147` 至 `:160` | IPv4 与 IPv6 | 普通 hostname 的 HTTP/TLS trace |
| screens | `:658` | 显示器数量 | isExtended 为 true 时直接写死 2 |
| bt | `:778` | 蓝牙可用性 | navigator.bluetooth API 是否存在 |

- 契约证据分别见 `specs/radishcloud-contract.md:315` 的 hour、`:316` 的 week、`:327` 的 engver、`:366` 的 gpulim、`:376` 至 `:379` 的 media/audiohw/bio/bt、`:408` 的 agent、`:293` 的 stack。
- 影响是接口有值且测试通过，却会让后台和中文画像声称测量了没有测量的事实。三屏设备会被显示为双屏，禁用的蓝牙会被显示为可用，时钟与语言设置被误读。
- 最小修复是逐项决定“实现已承诺测量”或“把现有观察改名并降为线索”。保持旧 v1 数据可读，为历史错误字段标注 collector 版本。不要追求 124 项有值率而制造肯定结果。
- 验收要求是每个字段明确值类型、测量对象、方法、缺失状态和样例。对 12/24 小时格式、三屏、Firefox、无摄像头、有 MediaSource、WebGPU 关闭、双栈/单栈环境做语义断言。

### G09 · P2 · hwid 含浏览器相关量，不能承担跨浏览器硬件身份

- 证据位于 `static/radish-collect.js:51` 至 `:63` 与 `:529` 至 `:541`，硬件哈希包含 available screen、DPR、deviceMemory、navigator.platform/vendor、字体测量及 GPU 驱动字符串。
- 同一设备仅 availHeight 改变即改变 hwid 已复现。Chrome 与 Firefox 的 vendor/deviceMemory 可见性差异也会改变输入。综合 fpid 只哈希少量 tmpl 属性，没有汇入其他 canvas/audio/fonts 结果。
- 影响是跨浏览器合并与唯一访客统计产生虚假的分裂和合并。SHA-256 只编码输入，不提高识别准确性。
- 最小修复是把两者描述为特定算法版本的环境摘要，避免输出“硬件编号”“同一台硬件已确认”等结论。是否调整输入另设版本，后台同时保留旧摘要可解释性。
- 验收要求是同机双浏览器、系统缩放/任务栏变化、两台同配置设备的样例能够明确说明碰撞和漂移，不把精确匹配当作身份事实。

### G10 · P2 · applyBudget 不保证预算成立

- 证据位于 `static/radish-collect.js:1234` 至 `:1262`。只裁三个数组且最低仍保留九项，最后没有强制上限或失败返回。所有其他字符串没有统一上限。
- 已复现 183757 字节输出，超过 48 KiB 客户端预算和 96 KiB 契约服务端上限，也可能超过浏览器 keepalive 队列空间。
- 最小修复是限定单项字符串和数组长度，最终序列化后做硬预算检查，按明确规则替换超大项并记录 truncated。仍无法满足则返回可识别失败状态，不能尝试发送无界 body。
- 验收要求覆盖多字节文字、极长语音名称、多个超大非长尾字段、仅 metadata 超预算以及裁剪元数据本身增加大小的情况。最终 body 字节数必须小于等于预算。

### G11 · P2 · 缺失原因与否定结论混在一起

- 证据位于 `static/radish-collect.js:1073` 至 `:1075` 将网络超时、HTTP 错误、CORS 和解析错误吞成 null，调用方统一写 unsupported。`:742`、`:743`、`:744`、`:1028`、`:1029` 对从未询问的能力硬编码 denied。rand 在 `:255` 的 canvasData 全为 null 时也可返回 same=false，shield `:520` 用随机数相等推断防指纹噪声。
- 影响是人类可读诊断把“该环境读不到”“尚未运行”“用户拒绝”“测量为否”混为一谈，后台缺失分布也失真。旧记录已包含错误语义，需要按 collector 版本解释。
- 最小修复是先定义有限且有中文说明的状态模型，至少区分未运行、不支持、权限拒绝、超时、网络不可读、错误和成功。检测不到保护应显示未检测到线索，不能证明没有保护。CORS 与网络错误浏览器通常无法精确区分时保留合并状态。
- 验收要求是禁用 API、拒绝权限、未主动运行、网络离线、HTTP 403、超时、正常空集合与明确 false 均可区分。对遗留 denied 给出“旧采集器未运行”的兼容解释。

### G12 · P2 · 发布链自动跟随上游版本，且权限范围过大

- 证据位于 `config.json:5` 的 last、`.github/workflows/Gmeek.yml:18` 的 write-all、`:42` 至 `:50` 的动态 tag checkout 与未锁定 pip 安装、`:56` 在执行上游代码时传入 GITHUB_TOKEN、`:65` 的 git add .。
- 影响是每日生成可以在本仓库没有代码改动时改变模板、依赖和执行逻辑，上游依赖失陷将获得广泛仓库写权限。不是本次发现了已泄露 token。
- 最小修复是固定经过审核的 Gmeek commit/tag 与依赖版本，build 权限缩到实际需要的 contents/issues 等范围，deploy 保留 pages/id-token，提交明确生成文件，测试通过后才发布。保留上游升级为显式小型变更。
- 验收要求是相同源和依赖产生相同采集器与模板，依赖版本在评审中可见，工作流没有无用途写权限。

### G13 · P2 · 博客主题控件无法通过键盘操作，移动宽度溢出

- 证据位于 `docs/index.html:77` 和 `docs/tag.html:67` 的无 href、无 tabindex 的 onclick a。浏览器键盘 Tab 不会把它视为可聚焦链接。`docs/index.html:37` 的 `.SideNav{min-width:360px}` 在 320px viewport 加左右 padding 后必然产生横向溢出。
- 最小修复是在生成模板使用原生 button、明确可访问名称，并让导航列表宽度服从容器。所有页面共用模板应一次修复生成来源。
- 验收要求是纯键盘完成主题切换，焦点清晰，状态可读。320px/375px 及 200% 缩放时内容和控件可用，无无意义横向滚动。

### G14 · P3 · 标签颜色和动效未照顾可访问性设置

- 证据位于 `docs/index.html:172`、`:227` 的白字搭配浅黄色 `#e4e669`，以及 `:30` 至 `:31` 的 hover 旋转未根据 prefers-reduced-motion 关闭。
- 最小修复是按标签背景选取满足对比要求的前景色，在共用模板为 reduced-motion 关闭非必要 transition/transform。
- 验收要求是实际渲染下所有标签文字达到对应 WCAG 对比阈值，操作系统减少动画时头像不旋转。

### G15 · P3 · DNT/GPC 已跳过探针，但仍启动两个网络辅助请求

- 证据位于 `static/radish-collect.js:1297` 至 `:1303` 在 optedOut 之前无条件发 trace 和 hints，optout 检查在 buildEnvelope `:1171`。
- spy 已确认 DNT=1 仍请求这两个地址。它们与 collect 同一服务来源，此发现不是新第三方泄露结论，问题是隐私分支仍做了没有用处的诊断网络请求。
- 最小修复是运行入口先判断隐私分支，直接构建最小访问记录，跳过 trace/hints 和全部探针。
- 验收要求是 DNT/GPC 下仅出现需求明确允许的最小 collect，不出现 trace、hints、第三方出口等探测请求。后台同时审查 optout 是否仍做指纹派生和画像。

### G16 · P3 · 临时资源与页面全局状态没有对称清理

- 证据位于 `static/radish-collect.js:93` 的 ICE finish 没有 pc.close，`:1003` Worker 超时未 terminate/revokeObjectURL，`:225` 覆盖 speechSynthesis.onvoiceschanged，`:628` 的 visibilitychange 只在触发时 once 移除。
- 一次匿名采集的影响相对有限。引入手动重测后会放大，可能残留 Worker、对象 URL 或覆盖页面原有语音事件处理器。
- 最小修复是每个创建临时资源的探针在成功、失败、超时和取消路径共享简单的本地清理函数，事件采用 addEventListener 并移除。
- 验收要求是连续十次主动重测，Worker、PeerConnection、事件监听和对象 URL 数量回归起点，页面原有语音事件仍运行。

### G17 · P3 · 存储留痕探针会观测到采集器自身产生的数据

- 证据位于 `static/radish-collect.js:1047`，只要 sessionStorage.length>0 就报告留痕。buildEnvelope `:1196` 调用 getSession，`:1134` 写 radish.sid，发送后还写 radish.sent。
- 第一次探测后 getSession 会污染同源存储。后续页面或重测时 traces.sessionStorage=true 无法区分访客原有数据与采集器写入。`:1049` 只看 caches API 存在性也无法表示实际缓存留痕。
- 最小修复是排除采集器自己使用的 key，把“API 可用”与“已有条目”分开。若没有用户需求，直接从人类可读摘要省略这一低价值解释。
- 验收要求是干净页面首次和第二次运行不会把自身 radish key 报告成外部留痕。CacheStorage 实际为空与已有缓存应可区分。

## 进一步需要核验的跨仓库问题

1. `/v1/etag` 在当前采集器内没有调用。契约虽然定义 ETag/If-None-Match 行为，但仅由服务器给 collect 派生一个值不能证明浏览器缓存识别已被测量。需要查 RadishCloud 当前实现和诊断目标后决定实现真实实验或删除该承诺。
2. `ex_gpt`、`ex_claude`、`ex_cf` 返回 loc/colo，丢弃 trace 的 ip。ex_cn/ex_intl 也没有返回出口 IP。它们只能提供地区或运营商线索，不能可靠地画出“各目的地用了哪个出口 IP”的对比。新增字段之前应先核实真实跨域可读性和用户是否需要多出口诊断。
3. `/v1/hints` 的 Accept-CH、CORS 与跨源高熵 hints 是否有浏览器端实际效果尚未在真实 Chrome/Firefox/Safari 验证。当前本地 uaData 请求只取 architecture/bitness/model，`__radishHints` 写后无读，不能据契约文字推断其余高熵字段已采集。
4. 契约有数量与来源说明漂移。正文明确不可见五项，附录总计仍写 X6，C*9，且 ch 在不同段落中被描述为源站和客户端回显。tests/ids.json 与探针目录、backend registry 需要比对，不应继续人工三处维护。
5. 契约列表接口没有列 hwid/optout/stuck 过滤参数，后台功能要求却写了这些筛选。需由 RadishCloud 审查 agent 确认实际实现后补齐统一文档。
6. 本仓库所有博客页从外部域加载 Gmeek 插件，未做完整性固定。需要在锁定生成链时同时决定是否将已使用插件快照放入 static，避免运行时代码悄然变化。

## 可维护性与奥卡姆剃刀

- 首先保留单个静态采集器发布入口与既有 Gmeek 生成链。这个规模没有证据支持微服务、消息队列、插件运行时、大型状态管理库或整体重写。
- 124 项目录可以集中成一份被构建与测试读取的轻量 registry，包含 id、分组、中文名、测量对象、来源和状态解释。探针执行、后台投影与前端展示不必通过三份人工列表同步。
- 同样的 WebGL 上下文在 webgl、gpu、hwid、gpulim、glx 多次创建，同样的字体列表在 fontfp、fonts、hwid 多次测量。适合一次运行内记忆化共享观测，防止重复负载和结果不一致，避免引入全局永久缓存污染重测。
- `has` 位于 `static/radish-collect.js:22`，未见调用。`:551` 的 v 变量恒为问号且未用，`:555` 的三元分支恒为 Windows，`:577` 的 __radishHints 写后无读，exitTrace 的 field 参数没有调用方传值。这些是具体可清理点。
- normalize 只对外导出并被测试使用，内部发送路径不调用，而后端契约规定数组与对象展开成多行 facet。不要把这个管道拼接字符串函数误用成后端投影规范。若外部没有已知调用方可删除，或明确仅作调试格式化。
- 注释已与代码不符。文件头写不改 DOM，但多个探针临时插入节点；执行池注释写 8 路，实际是 16；自动启动注释写 load 后1.2s，实际已改为 DOMContentLoaded/idle；文件头版本写1.0.0，VERSION写1.0.4。减少重复注释并描述当前约束即可。
- docs 作为生成产物与源的双份存在本身可以保留，真正需要的是确定性生成和测试产物门禁。

## 给开发 agent 的最小执行次序

1. 先修 G01 的源模板 HTML sink，并建立一次完整生成后的 XSS 回归。同步锁定 Gmeek 来源，确保下次生成不会覆盖修复。
2. 建立 static 到最终 artifact 的确定性复制、单元测试和产物一致性门禁，给当前23测试补充已经证明漏掉的并发、失败恢复、延迟 trace、真实 candidate 和硬预算回归。
3. 把运行状态收敛到一个简单上下文，统一正常完成、pagehide、发送失败、重试与取消，保持信封兼容性与同一次运行 id 稳定。
4. 核对字段语义，优先修正 hour/week/gpulim/media/audiohw/agent/stack/screens。新旧数据按 collector 版本保留可解释性。建立最小状态目录，避免用 denied 代替未运行。
5. 在正确采集结果上添加用户可见的静态诊断页。页面优先呈现网络出口、浏览器与系统、屏幕与硬件、隐私设置的中文结果，允许查看方法、来源、时间与原始值。区分直接观察、推断和不可观测。将需主动运行的网络/权限探测放到明确动作入口，先完成已有结果的可读性。
6. 在真实 Chromium、Firefox、WebKit 与移动尺寸上验证正常入口。覆盖离线、跨域不可读、后台切换、快速离开、DNT/GPC、存储禁用、相同设备多浏览器。后端联调另由其仓库验证记录幂等、来源、大小和隐私分支。
7. 最后按真实使用的频率合并重复测量、删除死代码与过时说明。每阶段保留一个可部署成果，避免扩大成整站重构。

当前缺少真实浏览器执行。主 agent 的 HTTP GET 已补充部分线上状态与响应头事实，但无法代替浏览器 CORS 和 Client Hints 实验。本笔记中 VM 结果证明函数数据流和状态缺陷，无法代替布局、真实硬件 API 和页面生命周期的浏览器验收。
