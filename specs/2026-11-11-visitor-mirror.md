# 「网站眼里的你」文案生成规格（v1，给 RadishCloud 服务端）

> 目标：给**每一次访问**自动生成一段中文说明，把这个访客「在网站眼里长什么样」讲清楚。
> 纯规则拼装，**不调 LLM、不联网**，同一份记录必须永远生成同一段文字（可复现、可测试）。
> 输入只有已经落库的那条 record，不需要新增采集项。

---

## 1. 一句话原则

**能说就说具体的，不能确定就说大概，读不到就整句省略——绝不允许写「未知」「N/A」或者编。**

每条断言都要能追到 record 里的某个字段；追不到的不写。缺失的项不是错误，是信息（说明对方在保护自己）。

---

## 2. 输入

`record = { v, id, ts, session, page, cli, meta, srv }`，字段口径见 `specs/radishcloud-contract.md` 附录 A。

服务端只需要再加一个查询：**这个 `fpid` / `hwid` 在本库出现过几次**（用于「唯一性」和「回访」两句）。

---

## 3. 派生字段（服务端算，不进 `visit` 表，随请求实时算或落一列 `mirror` 缓存）

| 派生字段 | 来源 | 规则 |
|---|---|---|
| `device_class` | `cli.form` `cli.touch` `cli.screen` `meta.ua` | `form=Mobile` 且 `screen.w<900` → `手机`；`form=Tablet` 或（`touch.points>0` 且 `screen.w≥1000`）→ `平板/触屏电脑`；否则 `桌面机` |
| `os_name` | `meta.ua` + `srv.h['sec-ch-ua-platform']` + `srv.h['sec-ch-ua-platform-version']` | `Windows NT 10.0` + platformVersion `19.0.0`→`Windows 11`，`10.0.0/14/15`→`Windows 10`；`Mac OS X 10_15_7`→`macOS`；`Android 14`→`Android 14`；`iPhone OS 18_1`→`iOS 18.1` |
| `browser_name` / `browser_ver` | `cli.browser` `cli.engine` `cli.engver` `cli.agent` | 直接用 `cli.browser`（已含版本）；`agent.consistent=false` 时改说「浏览器自称是 X，但 UA 和其他信号对不上」 |
| `gpu_name` | `cli.webgl.unmaskedRenderer` | 正则 `ANGLE \((.+?), (.+?) Direct3D` 取第二段，再删掉 `(0x…)`、` vs_5_0`、` ps_5_0`、` D3D11` |
| `gpu_arch` | `cli.webgpu.arch` | 有就用（`turing`→`Turing 架构`） |
| `screen_phys` / `screen_scale` | `cli.screen` | `w×h`；缩放 = `round(dpr*100)%`，`dpr=1` 时不提缩放 |
| `monitors` | `cli.screens.n` | ≥2 才提「接了 N 块显示器」 |
| `input_class` | `cli.touch` | `points>0 && hover` → `带触屏、也有鼠标`；`points>0 && !hover` → `触屏为主`；`points=0` → `鼠标键盘` |
| `utc_offset` | `cli.clock.off` | 已经是小时偏差，`+8` → `UTC+8` |
| `local_hour` | `cli.hour` | 直接说「你那会儿是 21 点」；`0-5` → 「凌晨」 |
| `lang_primary` / `lang_more` | `cli.langs` `cli.locale` | 第一项为主；`langs[1..]` 去重去同前缀后最多提 2 个 |
| `net_kind` | `cli.ex_intl.isp` `srv.asn.org` `srv.ptr` | 命中机房关键字表 → `机房/云主机`；含 `telecom/unicom/mobile/chinanet/ctcc/cucc/chinabank` → `家宽/移动网络`；否则 `商用线路` |
| `geo_text` | `srv.loc` | `country/region/city` 拼「美国 加利福尼亚州 洛杉矶」；只有国家就只说国家 |
| `geo_conflict` | `utc_offset` 与 `srv.loc.country` | 时区对应的国家 ≠ IP 国家 → 加一句「时区和出口 IP 不在同一个国家」 |
| `fp_seen` / `hw_seen` | DB 计数 | `fpid` 出现次数、`hwid` 出现次数 |
| `bot_hint` | `cli.auto` `cli.webdriver` `meta.ua` | `auto` 非空或 `webdriver=true` 或 UA 含 `Headless` → 「像自动化工具/脚本」 |

**机房关键字表**（`net_kind` 用，命中即机房）：
`psychz, digitalocean, ovh, hetzner, contabo, vultr, linode, akamai, aws, amazon, google cloud, microsoft azure, aliyun, alibaba, tencent, huawei cloud, oracle, hosthatch, bandwagonhost, hostinger, cloudflare, leaseweb, m247, datacamp, colocation, hosting, server, vps`

---

## 4. 文案结构（5～6 句，用「你」称呼，口语）

| 句 | 内容 | 生成条件 | 缺失时 |
|---|---|---|---|
| 1 | 位置 + 出口网络 + 是不是机房 | 有 `srv.loc` | 整句降级为「我看不到你的位置，只能看到你的出口 IP」 |
| 2 | 设备类型 + 关键硬件（核心数/内存/显卡） | 至少有 `device_class` | 只说设备类型 |
| 3 | 浏览器 + 内核版本 + 语言 + 时区 + 当前时间 | 有 `cli.browser` | 只说 `meta.ua` 里的浏览器名 |
| 4 | 屏幕 + 缩放 + 多屏 + 输入方式 | 有 `cli.screen` | 省略 |
| 5 | 指纹唯一性 / 是不是回头客 | 有 `fp_seen` | 省略 |
| 6（可选） | 一个「有意思的细节」：语音包数量、字体数量、编码器支持、拦截器、隐私开关 | 见 §6 挑一个 | 省略 |

**硬约束**

- 折叠态 ≤ **160 字**，展开态 ≤ 400 字。
- 不用感叹号，不评判（不写「安全性差」「你在裸奔」这类），不写营销词。
- 数字必须带单位（`32 GB`、`2560×1440`、`UTC+8`、`AS40676`）。
- 不确定用「大概/看起来/更像是」，确定才用「是」。
- 句子之间用中文标点，不用 emoji（后台表格里会乱）。

---

## 5. 逐句示例（用真实记录，2026-11-11 那条 Edge + RTX 2080 Ti）

输入摘要：`srv.loc = US/California/Los Angeles`、`srv.asn = 40676 Psychz Networks`、`srv.ptr = unassigned.psychz.net`、`cli.cpu=20`、`cli.mem=32`、`webgl.unmaskedRenderer = ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti (0x00001E04) Direct3D11 vs_5_0 ps_5_0, D3D11)`、`browser=Edge 157`、`langs=[zh-CN,ru,ru-RU]`、`tz=Asia/Hong_Kong`、`clock.off=8`、`screen=2560×1440 dpr 1.1`、`screens.n=2`、`touch.points=10 hover=true`、`voices=250 条`、`fonts=31 种`。

**期望输出（折叠态，约 150 字）：**

> 你从**美国 加利福尼亚州 洛杉矶**连过来，出口 IP 108.181.5.1，走 **Psychz Networks** 的线路（AS40676，反查域名 `unassigned.psychz.net`）——这是台机房机器，所以我能看到的只是它的落地点，不是你真人坐在哪儿。
> 设备是一台**高配 Windows 台式机**：20 个逻辑核心、32 GB 内存，显卡 **NVIDIA GeForce RTX 2080 Ti**（Turing 架构）。
> 浏览器是 **Microsoft Edge 157**（Blink 157），界面语言 `zh-CN`，另外还接受 `ru`、`ru-RU`；系统时区 **Asia/Hong_Kong（UTC+8）**，访问时是本地 21 点。
> 屏幕 **2560×1440**、缩放 110%、**接了 2 块显示器**，还有一块 10 点触控屏——是台带触屏的工作站。
> 你的浏览器指纹 `sha256:a3f2adb0…` 在本站 **1234 次访问里只出现过 1 次**，我认得出来是你。

**展开态额外一句（§6 挑项）：**

> 顺带一提：你机器上装了 **250 个语音包**（中文、日文、英文都有）、**31 种字体**，H.264/HEVC/AV1 都能硬解，混合内容拦掉了 0 个。

---

## 6. 「有意思的细节」挑一个（按优先级，只取第一个命中的）

1. `voices` 数量 ≥ 50 → 「装了 N 个语音包」；`meta.truncated` 里 `voices.n` 才是真实总数。
2. `fonts` ≥ 25 → 「装了 N 种字体」。
3. `codecs` 里 `av01 && hevc` 都 true → 「新一代编码器（HEVC / AV1）都能硬解」。
4. `drm.widevine && drm.playready` → 「DRM 组件齐全，能播正版流媒体」。
5. `adblock=true` → 「装了广告拦截」；`trackers` 被拒 → 「拦了追踪器」。
6. `privacy.dnt || privacy.gpc` → 换成整段隐私声明，不出文案（见 §7）。

---

## 7. 边界情况

| 情况 | 处理 |
|---|---|
| `meta.privacy.optout = true`（DNT/GPC） | **不生成任何画像文案**，只显示一句：「你开了「禁止跟踪」，所以这次我只记了一条访问记录，什么都没分析。」 |
| `bot_hint` 命中 | 文案开头加一行：「这一条看起来是自动化工具访问的（信号：headless-ua / webdriver），下面这些可能不是真人。」**不要**直接判定为机器人 |
| `geo_conflict` | 加一句「时区（UTC+8）和出口 IP（美国）不在同一个国家，多半是代理或 VPN」 |
| `srv.loc` 只有国家 | 说「从 X 连过来」，不提省份城市 |
| `fpid` 为空（老版本采集端） | 省略唯一性那句 |
| 字段整块缺失 | 对应句子整句删掉，不要留空句、不要写「未知」 |

---

## 7.5 代理判定，以及「连接端系统」永久不可见（2026-11-12 定案）

### 7.5.1 这个站看不到访客的 TCP 握手，是架构决定的

访客的 TCP/TLS 在两个地方就终止了，两个地方都不属于我们：

```
访客 ──TCP/TLS──> Fastly（GitHub Pages 承载博客）   ← 不提供任何服务端数据，连 IP 都没有
访客 ──TCP/TLS──> Cloudflare 边缘 ──隧道──> 本机     ← 只给 HTTP 头，不给 SYN
```

所以要拿 p0f 那套（初始 TTL、TCP options 顺序、MSS、window scale）必须有一台**自己接住访客 TCP 连接**的机器：公网 IP + 开放端口 + 不套橙云。现状是那台 Windows Server 没有公网入口（装 cloudflared 就是为了绕开这一点），也没有额外 VPS，所以：

> **`tcpfp` / `ja4` / `h2fp` / `quicfp` / `tlsfp` 这 5 项是架构性不可见，不是待办、不是 bug、不会"以后补上"。**

除非将来出现「公网直连入口」这个前提变了，否则不要为这 5 项写任何代码或承诺。

第三方公共探针（`tls.peet.ws`、`tls.browserleaks.com`）技术上能返回 TTL/MSS/JA3/JA4，但都不给本域 `Access-Control-Allow-Origin`，浏览器读不到；而且等于把访客 IP 交给第三方，与「自己后台看统计」的定位冲突。**已排除，不要再评估。**

### 7.5.2 文案里这句必须写实

当画像需要提「连接端系统」时，固定用这个说法（不要留空、不要写"未知"）：

> 连接你的是哪台机器、什么系统，我看不到——TCP 握手在你到 Cloudflare 那一段就结束了，只有 Cloudflare 知道我连的是 Windows 还是 Linux。我能确认的只有：你这个出口是机房线路。

### 7.5.3 代理/机房判定用加权分数（没有 SYN 也能判强弱）

| 信号 | 取值 | 权重 |
|---|---|---|
| 出口 ASN 命中机房关键字表（§3 `net_kind`） | 是 | +40 |
| `srv.ptr` 含 hosting / server / vps / unassigned / cloud / colo | 是 | +20 |
| 时区国家 / 语言 与 `srv.loc.country` 不一致 | 每个 | +15 |
| `ex_cf` / `ex_gpt` / `ex_claude` / `stack` 的 `colo` 不完全一致 | 是 | +10 |
| `webrtc.mdns = true` 且 `lan.ips` 为空（拿不到内网） | 是 | +5 |
| `auto` 非空 / `webdriver=true` / UA 含 Headless | 是 | +30（同时走 §7 的自动化提示行） |
| UA 与 `srv.ch` / `agent.kind` 完全一致 | 是 | −15 |
| 时区与出口国一致 且 `conn.rtt` 正常 | 是 | −10 |

结论分档（写进文案的措辞）：

| 分数 | 措辞 |
|---|---|
| ≥ 60 | 「你这个出口几乎肯定是机房或代理线路」 |
| 30–59 | 「看起来像挂了代理或走了中转」 |
| < 30 | 「看不出明显的代理痕迹」 |

分数与明细都要存进 `parts`（`{key:'proxy', score, hits:[...]}`），方便以后调权重，也方便你自己在后台核对。

---

## 8. 展示与接口

- 列表页：每行一个 60 字以内的一句话版（例：「洛杉矶 · 机房 IP · Windows/Edge 桌面机 · 指纹首次出现」）。
- 单条抽屉：顶部一段折叠态文案（≤160 字）+「展开看全部」。
- 新增接口：`GET /admin/api/visit/:id/mirror` → `{short, full, parts:[{key,sentence}]}`，`parts` 便于前端逐句高亮/单测断言。
- 文案函数必须是**纯函数**：`renderMirror(record, counts) -> {short, full, parts}`，同一输入永远同一输出，方便快照测试。

---

## 9. 顺带要修的数据问题（这次审计发现的，不影响主流程）

1. `srv.loc.regionCode` / `timezone` / `postalCode` 全是 `null`：DB-IP Lite 有 subdivision 的 ISO 码，别丢；`timezone` 可以用「国家 + 省市 → 时区」映射表兜（`Asia/Shanghai`、`Asia/Hong_Kong`…），或者干脆在文案里不提 IP 时区。
2. `srv.asn.country` 是 `null`：Team Cymru 的 TXT 第一段就是国家码，解析时别丢。
3. `cli.ex_gpt` / `ex_claude` / `ex_cf` / `stack` 四项几乎永远是同一组 `loc/colo`：后台**只展示一项**，其余当一致性校验，别出 4 张一样的卡片。
4. `cli.voices` 会到 250 条（十几 KB），展示价值极低：客户端从 v1.0.2 起硬砍到 32 条，**真实数量在 `meta.truncated` 里**（`{id:'voices', n:250}`）。后台展示数量请读 `n`。
5. `dropped` 里的 4 要保留分母说明，否则「丢弃率」会被误读成 100%。

---

## 9.5 1.1.0 带来的解释口径变化（2026-11-12）

- `geoloc / sensors / trackers / extwar` 现在是 `not_run`：文案写「这一项我没有问你的浏览器」，
  不要写「你拒绝了」，更不要写「不支持」。
- `dns / ex_* / stack` 的 `unreadable`：写「这次没读到」，不要写「不可用」。
- `screens.n = null` 且 `ext = true`：写「检测到扩展屏幕」，不要编具体块数。
- `bt.available = false` 才是「蓝牙关了」；`available = null` 只能写「有接口但读不到开关状态」。
- `audiohw.rate` 是采样率读数，不是"音频设备数量"；设备数量看 `media`。
- `stack` 现在给的是 `{v4, v6, dual}`：可以写双栈/单栈结论，不再拿它当 HTTP/TLS 来源。
- `clock.skew_s` 用秒表达，比旧的 `skew_h` 精确，文案里说「差 N 秒」更可信。
- `meta.partial = true` 的记录：开头加一句「这次只采到一部分（页面提前关闭）」。

## 10. 客户端版本口径变化（已上线，服务端按这个对齐）

| 项 | 变化 | 对服务端的影响 |
|---|---|---|
| `cli.voices` | 最多 32 项，超出的记进 `meta.truncated[{id:'voices',n}]` | 数量要用 `n`，别用 `length` |
| `cli.win` | 可能只有 `iw`/`ih`（外框尺寸不可靠时不给 `ow`/`oh`） | facet 展开时允许 `win.ow` 缺失 |
| `cli.rtccodecs` | 之前恒为 `unsupported`（用错了 API），现在有 `{audio:[], video:[]}` | 可进分布图 |
| `cli.ex_cn` | 之前恒为 `unsupported`（上游返回格式变了），现在有 `{country,province,city,isp}` | 中国访客的城市/运营商可用了 |
| `cli.dns` / `cli.stack` | 之前常为 `unsupported`（超时/主机选错），现在有值 | 可展示 |
| `cli.auto` | 不再误判真 Chrome/Edge（去掉了 `chrome-no-runtime` 这条恒假判据） | 别再据此判机器人 |
| `cli.hz` | 页面在后台时会等可见后再测，超时才 `unsupported` | 缺失不代表低端设备 |

---

## 11. 验收清单

- [ ] 用 §5 那条真实记录调 `renderMirror`，输出与期望文案**逐句一致**（写进快照测试）
- [ ] `optout=true` 的记录 → 只有隐私声明一句，`parts` 长度为 1
- [ ] 构造 `HeadlessChrome` 记录 → 开头有自动化提示行
- [ ] 构造「中国移动 4G + 手机 UA + screen 390×844」记录 → 不出现「显示器」「显卡」字样
- [ ] 构造 `srv.loc` 只有国家的记录 → 不出现省市
- [ ] 同一条记录连调两次，输出字节完全相同
- [ ] 折叠态字数 ≤160，无「未知」「N/A」「null」「undefined」字样
- [ ] 机房 IP + 时区不一致的记录 → `parts` 里有 `proxy`，score ≥ 60，措辞是「几乎肯定是机房或代理线路」
- [ ] 家宽 IP + 时区语言都对得上的记录 → score < 30，措辞是「看不出明显的代理痕迹」
- [ ] 任何记录都不出现「连接端系统：Linux」这类推断（该信息本架构不可见，只能用 §7.5.2 的固定说法）
