# RadishCloud 契约：博客访客数据接收、存储与后台

> 这份文档自包含。你不需要读博客端的设计文档，也不需要看采集脚本的源码，按这份实现即可。
> 甲方（博客侧）已完成的部分：前端采集脚本、Cloudflare 隧道、域名。你要做的是源站服务 + 后台 WebUI。

## 0. 一句话

接收浏览器发来的一条 JSON（一次访问一条），从 HTTP 请求头补上「服务器才能看到」的字段，拆成可统计的维度写进 SQLite，然后提供一个只在 `127.0.0.1` 能打开的后台 WebUI，用来看访客设备分布和逐条明细。

## 1. 部署事实（都是已确认的，不要自行改）

| 事 | 值 |
|---|---|
| 源站机器 | Windows Server 2022（另一台机器，不是博客所在机） |
| 监听 | **只监听 `127.0.0.1:11451`**，不绑 `0.0.0.0` |
| 对外入口 | `https://radishcloud.072120.xyz` → Cloudflare 隧道 → `127.0.0.1:11451` |
| `/admin` | **隧道侧已把 `^/admin.*` 挡成 404**，外网访问不到；只能在那台机器本机浏览器打开 `http://127.0.0.1:11451/admin` |
| 数据目录 | `C:\ProgramData\RadishCloud\`（SQLite 放 `data.db`） |
| 进程 | 注册成 Windows 服务（WinSW 或 NSSM），不要留一个命令窗口常驻 |
| 定时任务 | 每日 04:00 的保留期清理，用任务计划程序调用服务的子命令（如 `radishcloud.exe prune`），不要依赖服务内部计时器 |
| 日志 | 按天滚动写文件，别只写 stdout |

## 2. 你怎么拿到「服务器才能看到」的字段

请求经 Cloudflare 隧道到达你时，`127.0.0.1` 那头永远是本地 `cloudflared`，**真实 IP 只能从请求头读**。

| payload 字段 | 来源 | 缺失时 |
|---|---|---|
| `srv.ip` | `CF-Connecting-IP`（没有则 `X-Forwarded-For` 第一个） | 置 `null` |
| `srv.ipv` | 按 `srv.ip` 判断 `4`/`6` | `null` |
| `srv.loc.country` `region` `regionCode` `city` `postalCode` `latitude` `longitude` `timezone` `continent` | `CF-IPCountry` `CF-Region` `CF-Region-Code` `CF-IPCity` `CF-Postal-Code` `CF-IPLatitude` `CF-IPLongitude` `CF-Timezone` `CF-IPContinent` | 全部置 `null` 后**回落到本地 IP 库**（见下） |
| `srv.colo` | `CF-Ray` 的末三位（如 `a585fd61-LAX` → `LAX`） | `null` |
| `srv.h.user-agent` `accept-language` `sec-ch-ua` `sec-ch-ua-platform` `accept-encoding` `dnt` `sec-gpc` `referer` | 同名请求头原样转发 | `null` |
| `srv.asn.asn` `org` `country` | 源站查 Team Cymru：对 `<reversed-ip>.origin.asn.cymru.com` 发 TXT 查询（DNS，免费，无需 key），响应形如 `40676 | 108.181.5.0/24 | US | arin | 2011-05-10 | PSYCHZ NETWORKS, US` | `null` |
| `srv.ptr` | 源站对 `srv.ip` 做 PTR 反查 | `null` |

**本地 IP 库回落**：CF 位置头一个都没有时（这种部署可能存在），用离线库自己算 `geo`/`coords`/`tzip`/`isp`。推荐 `DB-IP Lite City`（免账号、每月更新）或 `ip2region`（免账号、中文友好）。库文件放 `C:\ProgramData\RadishCloud\geo\`，随服务启动加载进内存。

**高熵 Client Hints**：源站必须在自己所有 `/v1/*` 响应里带

```
Accept-CH: Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors
```

浏览器下次访问同源就会带上这些头，`ch` 这项才有值。首次访问拿不到是正常的。

## 3. HTTP 接口

### 3.1 `POST /v1/collect`

请求体（`Content-Type: text/plain`，`sendBeacon` 发出，**不要要求 JSON content-type**）：

```json
{
  "v": 1,
  "id": "018f2c6e-6a1b-7c3d-9e4f-5a6b7c8d9e0f",
  "ts": "2026-11-10T23:20:31.412+08:00",
  "session": "b3d1f0c2e5",
  "page": { "path": "/post/TSAD.html", "title": "TSAD", "lang": "zh-CN", "ref": "https://www.google.com/", "nav": "navigate" },
  "cli": { "langs": ["zh-CN","zh"], "tz": "Asia/Shanghai", "screen": { "w": 2560, "h": 1440, "aw": 2560, "ah": 1400, "dpr": 1.25, "depth": 24 }, "fonts": ["Arial"], "fpid": "sha256:71ab…" },
  "meta": { "dur_ms": 812, "stuck": ["webgpu"], "privacy": { "dnt": false, "gpc": false, "optout": false }, "collector": "radish-1.0.0" }
}
```

**顶层只有这 7 个键，没有 `srv`。** `srv` 由你按 §2 从请求头还原后合并进落库记录。

响应：

| 情况 | 状态码 | body |
|---|---|---|
| 收下 | 204 | 空 |
| body 不是合法 JSON，或 `v !== 1` | 400 | `{"error":"bad_body"}` |
| `Origin` 不在白名单 | 403 | `{"error":"bad_origin"}` |
| `ts` 与服务器时间差 > 10 分钟 | 400 | `{"error":"stale"}` |
| body > 96 KiB | 413 | `{"error":"too_large"}` |
| `id` 已存在 | 204 | 空（幂等，不重写、不报错） |
| 限流命中 | 429 | `{"error":"rate"}` + `Retry-After` |

浏览器不读响应，所以这些 body 只给调试和后台计数用。

### 3.2 `GET /v1/hints`

把请求里所有 `Sec-CH-UA-*` 原样回显成 JSON：`{"h": {"sec-ch-ua": "…", "sec-ch-ua-platform": "…"}}`。没有任何 hint 时返回 `{"h": {}}`。必须带 `Cache-Control: no-store` 和 §2 的 `Accept-CH`。

```
Access-Control-Allow-Origin: <回显请求的 Origin，仅限白名单里的两个源>
Access-Control-Allow-Headers: Content-Type, If-None-Match
Vary: Origin
```

**这条的 CORS 不能省**：它是浏览器用 `fetch` 跨域读的，没有 `Access-Control-Allow-Origin` 就读不到，`cli.ch` 会整项缺失。白名单与 §3.1 相同：`https://blog.072120.xyz` 和 `https://blue-radish.github.io` 都要回显，`OPTIONS` 预检直接 204。

### 3.3 `GET /v1/etag`

对应 `etag` 探测项：`ETag: "r-<32 位 hex>"`（由 `ip + user-agent + accept-language` 哈希而来）、`X-Etag-Seen: 1|0`（该组合 30 天内是否见过）、`Cache-Control: max-age=0, must-revalidate`。这条只进聚合计数，不写 `visit`。

### 3.4 后台接口（只服务本机 `/admin`，见 §5）

| 接口 | 说明 |
|---|---|
| `GET /admin/api/overview?from=&to=` | `{visits, uniq_fp, uniq_ip, dropped:{rate,oversize,bad_body}, top:{country:[],browser:[],os:[],gpu:[],tz:[]}, days:[[date,count]]}` |
| `GET /admin/api/facets?from=&to=&group=&mode=visits\|count&n=10` | `[{k, total, values:[[value,count]]}]`，按附录 A 的组过滤 |
| `GET /admin/api/facet/:k?from=&to=&mode=&cursor=` | 单维度完整取值列表（分页，每页 100） |
| `GET /admin/api/visits?from=&to=&cursor=&ip=&fpid=&path=` | `{items:[{id,ts,ip,country,ua_brief,fpid8,path,optout}], next_cursor}`，按 `ts desc` |
| `GET /admin/api/visit/:id` | `{record: <落库完整 JSON>, facets:[{k,v}]}` |
| `DELETE /admin/api/visit/:id` | 204 |
| `DELETE /admin/api/visits?from=&to=` | `{deleted:n}` |
| `GET /admin/api/visit/:id/export` | `Content-Disposition: attachment`，单条 JSON |

时间参数一律 `YYYY-MM-DD`（按 `Asia/Shanghai` 归档）；分页游标用不透明字符串（`ts|id` 的 base64）。

## 4. 存储

```sql
CREATE TABLE visit (
  id         TEXT PRIMARY KEY,      -- 客户端 UUID，幂等键
  ts         TEXT NOT NULL,         -- ISO8601，含时区
  ts_day     TEXT NOT NULL,         -- YYYY-MM-DD（Asia/Shanghai）
  session    TEXT,
  path       TEXT, ref TEXT,
  ip         TEXT, ipv INTEGER,
  country    TEXT, region TEXT, city TEXT,
  asn        INTEGER, as_org TEXT,
  colo       TEXT, ptr TEXT,
  ua         TEXT, ua_browser TEXT, ua_os TEXT,
  tz         TEXT, tz_ip TEXT, lang TEXT,
  screen     TEXT, dpr REAL, gpu TEXT, cores INTEGER, mem REAL, touch INTEGER,
  fpid       TEXT, hwid TEXT,
  privacy_optout INTEGER NOT NULL DEFAULT 0,
  raw        TEXT NOT NULL          -- 合并 srv 之后的完整 JSON，后台「逐条」看的就是它
);

CREATE TABLE facet (               -- 一个访问的一项可以有多行（复合项展开）
  visit_id TEXT NOT NULL,
  k        TEXT NOT NULL,           -- 附录 A 的 id，或展开后的子维度如 screen.dpr
  v        TEXT NOT NULL,
  PRIMARY KEY (visit_id, k, v)
);

CREATE TABLE facet_daily (         -- 删原始记录前的 rollup，永久保留
  ts_day TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
  visits INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (ts_day, k, v)
);

CREATE INDEX visit_day ON visit(ts_day);
CREATE INDEX visit_fpid ON visit(fpid);
CREATE INDEX visit_ip ON visit(ip);
CREATE INDEX visit_path ON visit(path);
CREATE INDEX facet_kv ON facet(k, v);
CREATE INDEX facet_visit ON facet(visit_id);
```

### 4.1 归一化（写进代码里，不要散落）

字符串原样；数字最多 4 位小数（去掉尾部零）；布尔 `true`/`false`；`null` → `null`；缺失标记对象取 `$` 的值（`unsupported`/`denied`/`timeout`/`error`/`truncated`）。**不要把整个对象塞进一个 `v`。**

### 4.2 复合项展开规则（决定分布图有没有意义）

| 值的形状 | 展开 | 例 |
|---|---|---|
| 标量 | 1 行，`k` = id | `tz` = `Asia/Shanghai` |
| 数组 | 每元素 1 行，去重排序，上限 64，超出写一行 `k="<id>:trunc"` | `fonts` 每个字体一行 |
| 对象 | 每个标量成员 1 行，`k` = `<id>.<成员名>`，只展开一层 | `gpu.vendor`、`screen.dpr` |
| 对象里的数组 | 每元素 1 行，`k` = `<id>.<成员名>` | `gpulim.features` 每特性一行 |
| 缺失标记 | 1 行，`v` = `$` 的值 | `webgpu` = `unsupported` |

`raw` 永远保留完整嵌套结构，`facet` 只是查询投影，两者对不上时可以从 `raw` 重建。

多值项有两种口径，后台都要能切：**按访问计**（`count(distinct visit_id)`）与**按出现次数计**（`count(*)`）。

## 5. 后台 WebUI 的功能规范

样式、组件库、交互细节由实现方定；下面只规定「必须有什么、数据从哪来」。

**入口**：`http://127.0.0.1:11451/admin`，服务端渲染或前后端分离都行。不做登录（外网已经访问不到），但要拒绝非 `127.0.0.1`/`::1` 来源的请求（双保险）。默认时间范围「今天」，右上角可切 今天 / 7 天 / 30 天 / 全部。

### 5.1 总览页

- 四个数字卡：访问数、唯一指纹数（`distinct fpid`）、唯一 IP 数、被丢弃请求数（限流/超限/坏包）
- 四条 Top 5 榜单，带占比条：国家、浏览器、系统、显卡
- 一条按天访问量趋势（至少近 7 天）
- 一行提示：「原始记录保留 90 天，聚合数据永久」

### 5.2 分布页（核心）

按附录 A 的 7 个组分栏：**服务器看到的 / 出口 / 请求头 / 语言和地区 / 指纹 / 设备 / 浏览器设置**，组名和组内顺序照附录 A。

- 每项一张卡：卡头是中文名 + `id` + 已收样本数；卡身是 Top 10 取值，每个值带计数与占比条
- 复合项的子维度（`screen.dpr`、`gpu.vendor`、单个字体…）各自一张卡，与父项并列
- 每张卡可切「按访问计 / 按出现次数计」
- 点卡片进入该维度的完整取值列表，可搜索、可翻页
- 缺失标记（`unsupported`/`denied`/`timeout`/`error`/`truncated`）作为一个普通取值展示，别过滤掉——它本身就是重要信息（哪个浏览器缺什么 API）

### 5.3 单条页

- 表格：时间、国家、IP、UA 摘要、指纹前 8 位、路径、是否 optout；点行开右侧抽屉
- 抽屉：左栏是按 7 组分组的可读字段表，右栏是格式化后的完整 `raw` JSON；有「复制」「下载 .json」「删除」三个按钮
- 顶部筛选：IP、`fpid`、`hwid`、路径精确匹配；可勾「只看 optout」「只看带 stuck 的」

### 5.4 维护页

- 库体积、当前记录数、最早/最晚记录时间
- 保留期设置（默认 90 天，改完写进配置文件）
- 按日期范围批量删除（二次确认）
- 被丢弃请求计数（限流 / 超限 / 坏包），能看到最近一小时

### 5.5 性能底线

1 万条记录内，任一页面首屏 < 1 秒；列表分页 50 条；分布查询走 `facet`，不要在 `raw` 上现场解析。

## 6. 防护与限流

- `Origin` 白名单：**必须同时接受两个源**——博客的真实域名是 `https://blog.072120.xyz`（GitHub Pages 绑了自定义域），`https://blue-radish.github.io` 只是它的别名（会 302 到前者）。浏览器实际发出的 `Origin` 是 `https://blog.072120.xyz`，只放前者会 403。其余源 403
- 体积上限 96 KiB；`v` 必须为 1；`id` 幂等
- `ts` 与服务器时间差 > 10 分钟 → 400 `stale`
- 限流 key 用 `HMAC(ip + UA)`（不要用纯 IP：校园网/公司 NAT 后几十台机器同时打开是常态，纯 IP 会静默丢记录）；阈值：同一 key 60 次/分钟，全局 600 次/分钟；命中 429，并把计数暴露到维护页
- 这是公开接口，目标不是防伪造，而是别被灌死、别被灌垃圾

## 7. 保留期

- 原始记录 90 天；每天 04:00 先 rollup 进 `facet_daily`，再删 `ts_day < today-90` 的 `visit` 与 `facet`
- 聚合数据永久保留
- 保留期、限流阈值放配置文件，不硬编码

## 8. 验收清单

- [ ] `curl -X POST http://127.0.0.1:11451/v1/collect -H 'Origin: https://blog.072120.xyz' -H 'CF-Connecting-IP: 1.2.3.4' -H 'CF-IPCountry: CN' --data-binary @sample.json` 返回 **204**（这是真实访客的源，最容易漏）
- [ ] `curl -X POST http://127.0.0.1:11451/v1/collect -H 'Origin: https://blue-radish.github.io' -H 'CF-Connecting-IP: 1.2.3.4' -H 'CF-IPCountry: US' --data-binary @sample.json` 返回 204，`data.db` 里多一行，`facet` 里多若干行
- [ ] 同一个 `id` 再发一次：仍 204，`visit` 仍然只有一行
- [ ] 不带 `Origin` 或换成别的域：403
- [ ] body 塞到 100 KiB：413，且不落库
- [ ] 浏览器打开 `http://127.0.0.1:11451/admin`：总览有数、分布页 7 组都在、点开一条能看到完整 JSON
- [ ] 外网 `https://radishcloud.072120.xyz/admin`：404（隧道已挡）
- [ ] 外网 `https://radishcloud.072120.xyz/v1/hints`：200，且响应头含 `Accept-CH`
- [ ] 手动跑一次 `prune` 子命令：删掉 91 天前的记录，`facet_daily` 里有对应聚合
- [ ] 把服务重启：数据还在，监听仍是 `127.0.0.1`（`netstat -ano | findstr 11451`）

## 9. 不做的事

- 不做用户账号/登录体系；不对外提供任何读接口（除了 `/v1/etag`）
- 不做导出整库的接口
- 不做跨站跟踪、不做第三方 Cookie
- 不主动请求浏览器权限（定位、传感器）——采集端根本不会发这些
- 不加 Cloudflare Worker（v1 不引入额外组件）

## 附录 A：124 个探测项 id（`facet.k` 的取值空间）

id 就是采集端发来的 `cli` 的键，**不得改名、不得加前缀**。

采集端实发 **105 个键**（`C` + `C*` 全部，加 `edge`、`ch`、`proto` 三项——它们由客户端从 `/cdn-cgi/trace` 与 `/v1/hints` 读回，源站若从请求头也能拿到同一信息，以源站为准）。`E` 组的 `ip` `geo` `coords` `tzip` `h_*` 不会出现在 `cli` 里，`O` 组的 `isp` `ptr` `etag` 由源站自己算。`X` 组 5 项的 `k` 永远没有数据（原 `proto` 已由客户端读到）。

**高基数项提示**：`fpid` `hwid` `canvas` `audio` `mathfp` `fontfp` `domrect` `svgrect` `textm` `glimg` `ip` `ptr` `etag` `ex_*` 的取值几乎每访问一个值，在分布页里会变成一堆计数为 1 的卡片。建议后台支持「隐藏维度」或把这类项折叠到一个「指纹/单值」分区；`fpid`/`hwid` 更适合当筛选与去重口径（`distinct fpid` 已用于总览）。

`ch` 是数组（最多 8 个 `sec-ch-ua-*=值` 字符串），`meta.truncated` 记录被裁剪掉的长尾项（`[{id,n}]`，`n` 是裁剪前长度）。组名与组内顺序构成后台「分布」页的分栏。提供方列里：`C` 客户端探测（在 `cli` 里）、`C*` 客户端但依赖跨域读（可能缺失）、`E` Cloudflare 请求头（你从头部还原）、`O` 源站自算、`X` v1 采集端不会发送（这些 `k` 永远没有数据，后台仍要展示该名字并标「未采集」）。

### net · 服务器看到的（20 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `ip` | IP 地址 | CF-Connecting-IP | E |
| `geo` | 位置 | `CF-IPCountry` + `CF-IPCity` + `CF-Region`（§2） | E |
| `coords` | 坐标 | `CF-IPLatitude` + `CF-IPLongitude`（§2） | E |
| `isp` | 网络（ASN） | 源站查 Team Cymru（§2） | O |
| `dns` | DNS 服务器 | edns.ip-api.com | C* |
| `tzip` | IP 所在时区 | `CF-Timezone`（§2） | E |
| `ptr` | 反向解析 | DNS PTR | O |
| `edge` | 最近的数据中心 | `CF-Ray` 末三位（§2） | E |
| `proto` | HTTP 和 TLS | `/cdn-cgi/trace` 的 `http` + `tls`（浏览器直连边缘那次请求） | C* |
| `kex` | 密钥交换 | /cdn-cgi/trace · kex, sni | C* |
| `warp` | Cloudflare WARP | /cdn-cgi/trace · warp | C* |
| `tlsfp` | TLS 指纹 | TLS ClientHello | X |
| `tcpfp` | TCP/IP 指纹 | probe.1ms.dog · TCP SYN | X |
| `ja4` | TLS 指纹（JA4） | probe.1ms.dog · JA4 | X |
| `h2fp` | HTTP/2 指纹 | probe.1ms.dog · HTTP/2 SETTINGS | X |
| `quicfp` | QUIC 指纹（HTTP/3） | probe.1ms.dog · HTTP/3 · QUIC JA4 | X |
| `clock` | 你的时钟 | Date.now() | C |
| `webrtc` | WebRTC 地址 | RTCPeerConnection · STUN | C |
| `lan` | 局域网地址 | WebRTC host candidate | C |
| `v6mac` | IPv6 泄露网卡 MAC | IPv6 EUI-64 (ff:fe) | C |

### exit · 出口（6 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `ex_cn` | 国内网站 | myip.ipip.net | C* |
| `ex_intl` | 国外 IP 服务 | api.ip.sb | C* |
| `ex_gpt` | ChatGPT | chatgpt.com/cdn-cgi/trace | C* |
| `ex_claude` | Claude | claude.ai/cdn-cgi/trace | C* |
| `ex_cf` | Cloudflare | www.cloudflare.com/cdn-cgi/trace | C* |
| `stack` | IPv4 和 IPv6 | Cloudflare Radar · IPv4 / IPv6 | C* |

### hdr · 请求头（8 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `h_ua` | User-Agent | User-Agent | E |
| `h_lang` | 语言 | Accept-Language | E |
| `h_chua` | 浏览器品牌 | Sec-CH-UA | E |
| `h_plat` | 平台 | Sec-CH-UA-Platform | E |
| `ch` | Client Hints | Sec-CH-UA-* (Accept-CH) | O |
| `h_enc` | 压缩方式 | Accept-Encoding | E |
| `h_dnt` | 请勿追踪（DNT） | DNT · Sec-GPC | E |
| `h_ref` | 来源页面 | Referer · document.referrer | E |

### loc · 语言和地区（9 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `langs` | 浏览器语言 | navigator.languages | C |
| `locale` | 区域设置 | Intl.DateTimeFormat | C |
| `tz` | 系统时区 | Intl …timeZone | C |
| `hour` | 时钟格式 | Intl …hourCycle | C |
| `week` | 一周从哪天开始 | Intl.Locale weekInfo | C |
| `fmt` | 数字和日期格式 | Intl.NumberFormat | C |
| `icu` | ICU 数据 | Intl.supportedValuesOf | C |
| `kbd` | 键盘布局 | navigator.keyboard | C |
| `voices` | 朗读语音 | speechSynthesis | C |

### fp · 指纹（23 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `engine` | JS 引擎 | Error.message | C |
| `engver` | 引擎真实版本 | JS feature probes | C |
| `lies` | 谎言检测 | Function.prototype.toString · iframe | C |
| `cssv` | CSS 特性版本 | CSS.supports | C |
| `smooth` | 字体平滑 | canvas text antialiasing | C |
| `canvas` | Canvas | canvas.toDataURL | C |
| `webgl` | WebGL | WebGL getParameter | C |
| `audio` | 音频 | OfflineAudioContext | C |
| `mathfp` | 数学函数指纹 | Math.* → SHA-256 | C |
| `emoji` | 系统 Emoji 版本 | emoji measureText | C |
| `fontfp` | 字体列表 | fonts → SHA-256 | C |
| `domrect` | 元素尺寸（DOMRect） | getClientRects · Range | C |
| `svgrect` | SVG 文字尺寸 | SVG getBBox · getComputedTextLength | C |
| `textm` | 文字度量 | measureText actualBoundingBox | C |
| `glimg` | WebGL 渲染图像 | WebGL readPixels | C |
| `keys` | 引擎接口数 | window · HTMLElement · CSS keys | C |
| `timer` | 计时精度 | performance.now() resolution | C |
| `callstack` | 调用栈深度 | recursion depth | C |
| `fpid` | 综合指纹 | SHA-256 | C |
| `hwid` | 硬件编号（跨浏览器） | screen · cores · GPU · fonts → SHA-256 | C |
| `etag` | 缓存编号（ETag） | HTTP cache · ETag / If-None-Match | O |
| `rand` | 防指纹 | canvas × 2 | C |
| `shield` | 防护是谁 | navigator.brave · noise · lies | C |

### dev · 设备（34 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `os` | 操作系统 | userAgentData | C |
| `browser` | 浏览器 | userAgentData.brands | C |
| `arch` | CPU 架构 | …architecture · bitness | C |
| `form` | 设备形态 | userAgentData formFactors | C |
| `model` | 设备型号 | screen · GPU · Client Hints model | C |
| `screen` | 屏幕 | screen · devicePixelRatio | C |
| `hz` | 刷新率 | requestAnimationFrame | C |
| `screens` | 显示器数量 | screen.isExtended · screenX | C |
| `win` | 窗口 | innerWidth · availHeight | C |
| `scrollbar` | 滚动条宽度 | offsetWidth − clientWidth | C |
| `gpu` | 显卡 | WebGL RENDERER | C |
| `webgpu` | WebGPU | navigator.gpu adapter.info | C |
| `gpulim` | WebGPU 能力 | GPUAdapter limits · features | C |
| `glx` | WebGL 能力 | WebGL2 · MAX_TEXTURE_SIZE | C |
| `cpu` | CPU 线程 | hardwareConcurrency | C |
| `mem` | 内存 | navigator.deviceMemory | C |
| `heap` | JS 内存上限 | performance.memory | C |
| `touch` | 触控和指针 | maxTouchPoints · pointer | C |
| `battery` | 电池 | navigator.getBattery | C |
| `geoloc` | 精确定位（需授权） | geolocation (on request) | C |
| `sensors` | 运动传感器（需授权） | devicemotion (on request) | C |
| `conn` | 网络连接 | navigator.connection | C |
| `media` | 摄像头和麦克风 | enumerateDevices | C |
| `audiohw` | 音频硬件 | AudioContext.sampleRate | C |
| `bio` | 生物识别 | PublicKeyCredential | C |
| `bt` | 蓝牙 | bluetooth.getAvailability | C |
| `gamepad` | 游戏手柄 | getGamepads (on request) | C |
| `xr` | VR / AR | navigator.xr.isSessionSupported | C |
| `codecs` | 视频编码格式 | MediaSource.isTypeSupported | C |
| `rtccodecs` | WebRTC 编解码器 | RTCRtpSender.getCapabilities | C |
| `recmime` | 录制格式 | MediaRecorder.isTypeSupported | C |
| `hwdec` | 视频硬件解码 | mediaCapabilities.decodingInfo | C |
| `drm` | DRM | requestMediaKeySystemAccess | C |
| `storage` | 存储配额 | storage.estimate | C |

### brw · 浏览器设置（24 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `scheme` | 深浅色 | prefers-color-scheme | C |
| `motion` | 动画效果 | prefers-reduced-motion | C |
| `gamut` | 屏幕色域 | color-gamut · dynamic-range | C |
| `a11y` | 辅助功能 | prefers-contrast · forced-colors | C |
| `sysui` | 默认字号和强调色 | font-size: medium · AccentColor | C |
| `display` | 打开方式 | display-mode | C |
| `dnt` | 隐私信号 | doNotTrack · GPC | C |
| `cookies` | Cookie | navigator.cookieEnabled | C |
| `perms` | 权限 | permissions.query | C |
| `apis` | 敏感接口 | usb · serial · hid · IdleDetector … | C |
| `pdf` | PDF 阅读器 | pdfViewerEnabled | C |
| `ai` | 浏览器内置 AI | LanguageModel · Translator.availability | C |
| `webdriver` | 自动化 | navigator.webdriver | C |
| `auto` | 自动化痕迹 | headless · CDP · Electron traces | C |
| `idstr` | 身份字符串 | navigator.vendor · productSub · plugins | C |
| `agent` | 操作方式 | mousemove → pointerdown · isTrusted | C |
| `worker` | Worker 里的 navigator | Worker · navigator | C |
| `adblock` | 广告拦截 | bait element | C |
| `trackers` | 追踪拦截实测 | 7 tracker scripts (on request) | C |
| `ext` | 浏览器扩展 | window.ethereum · DOM marks | C |
| `extwar` | 扩展扫描 | chrome-extension:// files | C |
| `history` | 本标签页历史 | history.length | C |
| `traces` | 存储留痕 | localStorage · IndexedDB · Cache · window.name | C |
| `fonts` | 已装字体 | canvas measureText | C |

提供方图例：`C` 客户端探测 · `C*` 客户端探测但依赖跨域读（可能缺失） · `E` 从请求头还原 · `O` 源站自算 · `X` v1 不会发送（后台仍要展示该名字并标「未采集」）

合计 124 项：E 12 · O 4 · C* 9 · X 6 · C 93

