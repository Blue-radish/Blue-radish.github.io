# 博客访客信息采集与统计（RadishCloud）

日期：2026-11-10　状态：待批准

## 1. 意图与为什么

青萝卜菜の博客跑在 GitHub Pages 上（Gmeek 生成），现在对访客一无所知。要做的是：访客打开任意页面时，把 who.1ms.dog 公开的那套 124 个探测项尽量全地读一遍，**一次访问写一条 JSON**，落到自己服务器上的 RadishCloud；然后在后台看访客分布（浏览器、系统、屏幕、显卡、时区、语言、网络、是否挂代理），需要时能逐条翻看某次访问读到了什么。

为什么要这么多项：设备分布靠的就是这些维度，而指纹类项决定了"同一台机器来两次能不能看出来"，也决定了识别伪装（VPN/代理/改 UA）的可能性。

## 2. 目标

- 采集：附录 A 的 124 项中覆盖 118 项（6 项架构上拿不到，见 §6）
- 一条访问 = 一条 JSON = RadishCloud 里一行
- 后台能看到每一项的取值分布（Top N + 占比 + 计数），可按时间范围切换
- 后台能逐条翻看原始 JSON，能按 IP / 指纹 / 路径过滤
- 采集对博客透明：异步、不阻塞渲染、失败静默、不改动任何页面功能

## 3. 非目标

- 不做跨站跟踪、不设第三方 Cookie、不跨会话识别"同一个人"
- 不做点击热图、录屏、A/B
- 不公开任何原始记录（RadishCloud 不对外提供读接口）
- v1 不做 JA4 / JA4T / HTTP2 / QUIC 指纹
- 不做需要用户手势的探测（定位、运动传感器、手柄、追踪器实测），只记录"可探测到但未请求"

## 4. 反目标（做出来也算失败）

- 让博客变慢：制造 >50ms 的长任务，或从 idle 回调触发到 beacon 发出超过 8s（`pagehide` 时提前发）
- 采集失败影响到页面任何功能
- 数据被搜索引擎或第三方看到
- 采集接口被刷，把源站或隧道打挂
- 后台需要自己维护一套账号密码体系

## 5. 约束（都是核实过的，不是假设）

1. **GitHub Pages 纯静态**，没有任何服务端存储。`docs/` 每次构建被 `shutil.rmtree` 重建（`Gmeek.py:69-72`），手放进去的文件会消失。可用的注入路径只有两条：`static/*` 会被复制到站点根（`Gmeek.py:77-87`），`config.json` 的 `allHead` 会进 `templates/base.html` 的 `<head>`（`base.html:8`，每页都有）。
2. **RadishCloud 在 Cloudflare Tunnel 后面**：访客的 TCP/TLS 连接终结在 CF 边缘，`cloudflared` 转给源站的是普通 HTTP，源站 socket 地址永远是本机。`request.cf`（geo、坐标、ASN、colo、TLS 版本/套件、clientTcpRtt、tlsClientExtensionsSha1、httpProtocol）**只在 Worker / Pages Function 里可读**，裸源站拿不到。
3. 所以 CF 侧字段只能靠**边缘规则**（Transform Rule 把位置写进请求头）交给隧道；
   Worker 也能做，但 v1 不用它（付款墙 + 多一个组件），只在二期需要 `proto`/`tlsfp` 时才加。
4. **不照抄 who.1ms.dog 的实现**：它的 JS 与中英文案有版权。只采用其公开的项清单（124 个 id 与探测含义），探测逻辑与文案全部自己写。
5. 访客数据是个人信息：不公开、设保留期、给访客一页说明。
6. **账号有付款墙**：Zero Trust → Access 建应用时会要求付款方式，博主无法提供。所以 v1 不用 Cloudflare Access，也不新增需要单独部署的 Worker——只依赖 zone 上本来就免费的 Transform Rules 与 Rate Limiting。

## 6. 方案

| | 做法 | 覆盖 | 结论 |
|---|---|---|---|
| A | 裸入口自己解析 TLS ClientHello / SYN，另开 probe 子服务 | 124/124 | **排除**：隧道下客户端连接终结在 CF，拿不到；要做只能把机器直接暴露公网，最招扫描 |
| B | Cloudflare Worker 读 `request.cf` → 隧道 | 120/124 | **二期可选**：多一个要部署的组件，还要绕开面板的付款墙；只换来 `proto` `tlsfp` 两项 |
| C | 只做前端 + IP/UA/Referer | ~102/124 | **排除**：地理、ASN、colo 全丢，识别代理无从谈起 |
| **D** | **CF 免费的托管转换把访客位置写进请求头 → 隧道 → 源站自己补 ASN/PTR** | **118/124** | **采用** |

选 D 的理由：不新增要部署的组件、不碰付款墙。源站拿到的 `CF-Connecting-IP`、`CF-IPCountry/City/Latitude/Longitude/Timezone/Postal-Code/Region`、`CF-Ray`（末三位就是 colo）加上访客原始请求头，已经覆盖 12 项边缘字段；`isp`（ASN）用 Team Cymru 的 DNS 查询（`<ip>.origin.asn.cymru.com` 的 TXT）在源站免费拿到，不需要 GeoIP 账号。

v1 拿不到 6 项：`tcpfp` `ja4` `h2fp` `quicfp`（要裸入口解握手，A 案）、`proto` `tlsfp`（要 Worker 的 `request.cf`，二期 B 案）。

## 7. 架构与数据流

```
访客浏览器
  │ 1. GET 页面（GitHub Pages 静态）
  │ 2. /radish-collect.js（static/ 里，被 allHead 注入）跑 93 项客户端探测
  │ 3. GET /cdn-cgi/trace、GET /v1/hints（各 2s 超时，失败不影响下一步）
  │ 4. navigator.sendBeacon POST text/plain → https://radishcloud.072120.xyz/v1/collect
  ▼
Cloudflare 边缘（该 zone，全部走免费规则）
  │ · Transform Rule：把访客位置写进请求头
  │   CF-IPCountry / CF-IPCity / CF-IPLatitude / CF-IPLongitude /
  │   CF-Timezone / CF-Postal-Code / CF-Region / CF-IPContinent
  │ · 本来就有：CF-Connecting-IP、CF-Ray（末三位 = colo）、原始请求头
  │ · /cdn-cgi/trace 由边缘直接答（Transform Rule 补 CORS 头，见 §8.9）
  ▼  cloudflared 隧道
RadishCloud 源站（Windows Server 2022，只监听 127.0.0.1:11451）
  │ · 校验 Origin / 体积 / v / 幂等 → 落库
  │ · PTR 反查、ASN 查询（Team Cymru DNS）
  │ · facet 拆维 → SQLite
  ▼
/admin 只有本机可达（cloudflared 把 /admin* 直接挡成 404）
```

博客本体不动，仍然在 GitHub Pages（不上 Cloudflare）。没有 Worker 的代价是 `proto`/`tlsfp` 两项读不到，二期想要再按 B 案加。

三种落地档次，取决于你还能在这个 zone 上改多少：

| 档次 | 需要的动作 | 覆盖 |
|---|---|---|
| **D1（现在就能做）** | 规则 → 设置 → **托管转换** → 开「添加访客位置标头」（可选）；`Accept-CH` 由源站自己在响应里发 | **118/124** |
| **D2** | 连托管转换都开不了：源站用本地 IP 库（`DB-IP Lite` 或 `ip2region`，都免账号）自算 geo/ASN | 115/124 |
| **D1+（不需要了）** | 原以为要给 `/cdn-cgi/trace` 加 CORS；实测边缘自带 `ACAO: *` | 118/124 已达成 |
| B（二期） | 加一个 Worker | 120/124（多 `proto` `tlsfp`） |

**代码不区分档次**：源站一律先读 `CF-IP*` 请求头，读到就用、读不到就用本地 IP 库补；采集端对 `kex`/`warp`/`ch` 一律尝试，失败标 `unsupported`。所以托管转换那个开关是"随时可加"——开了立刻多 `geo`/`coords`/`tzip`，不开就本地库补，两种都不改代码、不重新部署。

## 8. 契约（这一段是给 RadishCloud 那个 agent 的，必须逐字对齐）

### 8.1 字段由谁提供

| 提供方 | 数量 | 项 |
|---|---|---|
| `C` 客户端 JS | 93 | 语言地区 9、指纹 22、设备 34、浏览器设置 24、`clock`/`webrtc`/`lan`/`v6mac` |
| `C*` 客户端 JS + 跨域读 | 9 | 出口 6 项、`dns`（`edns.ip-api.com`）、`kex`/`warp`（`/cdn-cgi/trace`） |
| `E` CF 边缘请求头 | 12 | `ip` `geo` `coords` `tzip` `edge` `h_ua` `h_lang` `h_chua` `h_plat` `h_enc` `h_dnt` `h_ref` |
| `O` 源站自算 | 4 | `isp`（Team Cymru ASN）、`ch`（回显 `Sec-CH-UA-*`）、`ptr`（PTR 反查）、`etag`（`GET /v1/etag`） |
| `X` v1 不做 | 6 | `tcpfp` `ja4` `h2fp` `quicfp` `proto` `tlsfp` |

`E` 里那 7 个 `h_*` 本来就是访客的原始请求头，隧道会原样带过来，不需要任何配置；另外 5 项（`ip` `geo` `coords` `tzip` `edge`）靠托管转换写进来的访客位置头和 `CF-Ray`；`ch` 由源站自己在 `/v1/*` 响应里发 `Accept-CH` 拿到，不需要面板。

`C*` 的 9 项依赖跨域读，读不到就按 §10 标 `unsupported`，不影响其他项。降到 D2 时：`geo`/`coords`/`tzip`/`isp` 由源站用本地 IP 库自算（从 `E` 挪到 `O`），`ch` `kex` `warp` 标 `unsupported`。

### 8.2 `POST /v1/collect` 请求体

```json
{
  "v": 1,
  "id": "018f2c6e-6a1b-7c3d-9e4f-5a6b7c8d9e0f",
  "ts": "2026-11-10T23:20:31.412+08:00",
  "session": "b3d1f0c2e5",
  "page": {
    "path": "/post/TSAD.html",
    "title": "TSAD",
    "lang": "zh-CN",
    "ref": "https://www.google.com/",
    "nav": "navigate"
  },
  "srv": {
    "ip": "1.2.3.4",
    "ipv": 4,
    "loc": {
      "country": "US", "region": "California", "regionCode": "CA", "city": "Los Angeles",
      "postalCode": "90013", "latitude": "34.05223", "longitude": "-118.24368",
      "timezone": "America/Los_Angeles", "continent": "NA"
    },
    "asn": { "asn": 40676, "org": "Psychz Networks", "country": "US", "source": "cymru" },
    "colo": "LAX",
    "h": {
      "user-agent": "Mozilla/5.0 …",
      "accept-language": "zh-CN,zh;q=0.9",
      "sec-ch-ua": "\"Chromium\";v=\"141\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "accept-encoding": "gzip, br",
      "dnt": "1",
      "sec-gpc": "1",
      "referer": "https://www.google.com/"
    }
  },
  "cli": {
    "langs": ["zh-CN", "zh"],
    "tz": "Asia/Shanghai",
    "screen": { "w": 2560, "h": 1440, "aw": 2560, "ah": 1400, "dpr": 1.25, "depth": 24 },
    "gpu": { "vendor": "Google Inc. (NVIDIA)", "renderer": "ANGLE (NVIDIA, GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)", "unmasked": "NVIDIA GeForce RTX 3060/PCIe/SSE2" },
    "canvas": { "h": "sha256:9f2c…", "len": 4128 },
    "fpid": "sha256:71ab…",
    "hwid": "sha256:c4d0…"
  },
  "meta": {
    "dur_ms": 812,
    "stuck": ["webgpu", "bt"],
    "privacy": { "dnt": false, "gpc": false, "optout": false },
    "collector": "radish-1.0.0"
  }
}
```

- `cli` 的键 = 附录 A 的 id，值 = §10 原值或缺失标记。RadishCloud **不假设**任何键一定存在。
- `srv` 全部来自请求头：`ip` = `CF-Connecting-IP`，`loc` = `CF-IP*`（Transform Rule 写入），`colo` = `CF-Ray` 末三位，`h` = 访客原始请求头，`asn` = 源站查 Team Cymru。缺哪个就 `null`，不要编。
- 访客的 TLS 版本、加密套件、TLS 扩展指纹都不在 `srv` 里——v1 读不到（`proto`/`tlsfp` 属 §8.1 的 `X`）。源站自己的 HTTP 版本与访客无关，不写进 payload。
- `id` 由客户端生成（UUIDv7），RadishCloud 以它做幂等键。
- `session` 是 sessionStorage 里的随机串，只用于去重同一会话的多条，不用于识别个人。
- **请求体没有 `srv`**：客户端不知道自己的 IP、地理和请求头。上面那段 JSON 是**落库后的完整记录**形态；真实请求体只有 `v` `id` `ts` `session` `page` `cli` `meta` 七个顶层键，`srv` 由源站从请求头还原后合并进 `raw`。

### 8.3 响应

| 情况 | 状态码 | 响应 |
|---|---|---|
| 收下 | 204 | 空 |
| JSON 坏 / `v` 不支持 | 400 | `{"error":"bad_body"}` |
| `Origin` 不在白名单 | 403 | `{"error":"bad_origin"}` |
| 时间戳与服务器差 > 10 分钟 | 400 | `{"error":"stale"}` |
| body > 96 KiB | 413 | `{"error":"too_large"}` |
| 同一个 `id` 重复 | 204 | 空（不重复写，不报错） |
| 限流命中 | 429 | `{"error":"rate"}`, `Retry-After` |

浏览器端不读响应（`sendBeacon`），所以响应体只对调试和后台有用。

### 8.4 鉴权与防护

采集接口是公开的（任何 analytics 接口都一样），所以目标不是"防伪造"，而是"别被灌死、别被灌垃圾"：

- `Origin` 白名单：`https://blog.072120.xyz`（真实域名）与 `https://blue-radish.github.io`（Pages 别名）都放，其余 403。挡不住 curl，但挡掉别的页面误发。**实测教训**：只放别名时，真实访客的 beacon 会被 403 —— 别名只在直接访问时出现，卡在自定义域上时浏览器发的 Origin 是自定义域。
- 体积 ≤ 96 KiB → 413；`v` 必须为 1；`id` 重复则直接 204 不重写（幂等）。
- 时间戳与服务器差 > 10 分钟 → 400 `stale`（时钟离谱的记录本来也没有统计价值）。
- 限流：边缘 CF Rate Limiting 规则（同一 key 120 次/分钟）+ 源站内存令牌桶（同一 key 60/min，全局 600/min）。key 用 `HMAC(ip + UA)` 而不是纯 IP——校园网/公司/运营商 NAT 后面 40 个浏览器同一分钟打开是常态，纯 IP 限流会静默丢记录，而客户端读不到 429。被限掉的请求要在 `/admin` 有个计数器。
- 可选加固：采集 JS 里带一个公开常量 `t=`，源站比对。它挡不住读源码的人，**不是密钥**，只挡随手打的脚本——别当安全边界用。
- 源站只监听 `127.0.0.1:11451`，外部唯一入口是隧道；`/admin*` 在 cloudflared 里直接挡成 404（§8.10）。
- `/v1/etag` 是唯一的公网读接口，返回只有 `ETag` 头和 `X-Etag-Seen`，无个人信息。

### 8.5 存储 schema（SQLite）

```sql
CREATE TABLE visit (
  id         TEXT PRIMARY KEY,      -- 客户端 UUID，幂等键
  ts         TEXT NOT NULL,         -- ISO8601，含时区
  ts_day     TEXT NOT NULL,         -- YYYY-MM-DD，按 Asia/Shanghai 归档
  session    TEXT,
  path       TEXT,
  ref        TEXT,
  ip         TEXT,
  ipv        INTEGER,
  country    TEXT, region TEXT, city TEXT,
  asn        INTEGER, as_org TEXT,
  colo       TEXT, http_proto TEXT, tls_ver TEXT, tls_cipher TEXT,
  ptr        TEXT,
  ua         TEXT, ua_browser TEXT, ua_os TEXT,
  tz         TEXT, tz_ip TEXT, lang TEXT,
  screen     TEXT, dpr REAL, gpu TEXT, cores INTEGER, mem REAL, touch INTEGER,
  fpid       TEXT, hwid TEXT,
  privacy_optout INTEGER NOT NULL DEFAULT 0,
  raw        TEXT NOT NULL          -- 完整 JSON，后台逐条看的就是它
);

-- 每个（访问 × 维度 × 取值）一行；复合项按 §8.5.1 展开后一个访问的一项可以有多行
CREATE TABLE facet (
  visit_id TEXT NOT NULL,
  k        TEXT NOT NULL,           -- 附录 A 的 id，或展开后的子维度，如 screen.dpr
  v        TEXT NOT NULL,           -- 归一化后的字符串值
  PRIMARY KEY (visit_id, k, v)
);

CREATE INDEX visit_day   ON visit(ts_day);
CREATE INDEX visit_fpid  ON visit(fpid);
CREATE INDEX visit_ip    ON visit(ip);
CREATE INDEX visit_path  ON visit(path);
CREATE INDEX facet_kv    ON facet(k, v);
CREATE INDEX facet_visit ON facet(visit_id);
```

分布查询就是 `SELECT k, v, count(DISTINCT visit_id) AS visits, count(*) AS n FROM facet WHERE k IN (…) GROUP BY k, v ORDER BY visits DESC`，124 项全部通吃（`visits` 与 `n` 分别对应 §8.5.1 的两种口径）。`v` 的归一化（写进 RadishCloud 的代码里，别散落）：字符串原样；数字最多 4 位小数；布尔 `true`/`false`；缺失标记取 `$` 的值（`unsupported` / `denied` / `timeout` / `error` / `truncated`，见 §10）；复合值的拆分见 §8.5.1，不要把整个对象塞进一个 `v`。

### 8.5.1 facet 展开规则

一半的项是对象或长数组（`screen` `win` `gpu` `webgl` `codecs` `rtccodecs` `icu` `perms` `apis` `gpulim` `fonts` `voices` `media` `conn` `webrtc`）。整包压成一个字符串存，每张分布卡的取值都是 1 次，等于没有分布。所以写入 `facet` 时按下面的规则展开（RadishCloud 实现，采集端不管）：

| 值的形状 | 展开方式 | 例子 |
|---|---|---|
| 标量（字符串/数字/布尔） | 1 行，`k` = 项 id | `tz` = `Asia/Shanghai` |
| 数组 | 每元素 1 行，去重排序，上限 64 个，超出截断并写一行 `k="…:trunc"` | `fonts` 每个字体一行 |
| 对象 | 每个标量成员 1 行，`k` = `id.成员名`，只展开一层 | `gpu.vendor`、`screen.dpr` |
| 对象里的数组 | 每元素 1 行，`k` = `id.成员名` | `gpulim.features` 每个特性一行 |
| 缺失标记 `{"$":"…"}` | 1 行，`v` = `$` 的值 | `webgpu` = `unsupported` |

`raw` 永远保留完整嵌套结构，`facet` 只是查询用的投影——两者对不上时可以随时从 `raw` 重建 `facet`。多值项的"取值分布"因此有两种口径，后台都要能切换：**按访问计**（该访问出现这个值就算一次）与**按出现次数计**（一个访问装 300 个字体就贡献 300 次，用来看字体流行度）。两种都从 `facet` 算，不需要额外表。

### 8.6 后台页面（`/admin`）

- **总览**：今日 / 7 天 / 30 天 / 全量的访问数、唯一指纹数、唯一 IP 数、国家 Top 5、浏览器 Top 5、设备形态占比
- **分布**：按附录 A 的 7 个组分栏（服务器看到的 / 出口 / 请求头 / 语言和地区 / 指纹 / 设备 / 浏览器设置），每组把该组全部项列成卡片，每卡 = 该项的 Top 10 取值 + 计数 + 占比条；复合项（§8.5.1 展开出的 `screen.dpr`、`gpu.vendor`、单个字体…）各自一张卡，与父项并列；每张卡可切「按访问计 / 按出现次数计」；时间范围可切；点卡片进该维度的完整取值列表（分页）
- **单条**：按时间倒序的访问列表（时间、国家、IP、UA 摘要、指纹前 8 位），点开抽屉显示格式化 `raw` JSON，可复制、可下载单条 `.json`
- **筛选**：按 IP、`fpid`、`hwid`、`path` 精确过滤；按 `privacy_optout`、`country`、`stuck` 过滤
- **删除**：单条删除；按日期范围批量删除；显示当前库体积
- 服务端渲染 + 少量原生 JS 即可，不引入前端框架（这台机器还要跑别的）

### 8.7 `GET /v1/etag`

对应 `etag` 探测项：返回 `ETag: "r-<32 hex>"`（由 IP + UA + `Accept-Language` 哈希而来）+ `X-Etag-Seen: 1|0`（该组合 30 天内是否见过）+ `Cache-Control: max-age=0, must-revalidate`。目的是复刻"缓存编号能跨浏览器认人"的观测能力，同时这条记录只进聚合计数，不进 `visit.raw`。

### 8.8 保留期与聚合

- 原始记录保留 **90 天**；每日 04:00 定时任务删 `ts_day < today-90` 的行（`visit` 与 `facet` 一起）
- 聚合计数（`k, v, ts_day, count`）永久保留在一张 `facet_daily` 汇总表里，删原始记录前先 rollup
- 保留期、限流阈值、`secret` 走配置文件，不硬编码

### 8.9 边缘 trace 与 Client Hints（`kex` `warp` `ch` 的前提）

`kex`/`warp` 只能用**浏览器直连 CF 边缘**的那次请求读出来；源站、Worker、任何服务端代理读到的都是它自己的连接。所以：

1. 采集 JS 直接 `fetch('https://radishcloud.072120.xyz/cdn-cgi/trace')` 读 `kex=` 与 `warp=`。**实测 2026-11-11：该 zone 的 `/cdn-cgi/trace` 自带 `Access-Control-Allow-Origin: *`，不需要任何 Transform Rule**，所以这两项 v1 就能读到。
2. `Accept-CH` **由 RadishCloud 自己在 `/v1/*` 的响应头里发**（不依赖面板）：`Accept-CH: Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors`；`GET /v1/hints` 把请求里的 `Sec-CH-UA-*` 原样回显。首次访问（此前没被送过 `Accept-CH`）`ch` 必然是 `unsupported`，第二次起才有值。
3. 采集顺序：trace → hints → beacon（§9）。前两步失败就把对应项标 `unsupported`，beacon 照发。
4. 托管转换开不了（D2）→ `geo`/`coords`/`tzip` 由源站本地 IP 库补，覆盖 118 不变（DB-IP Lite 已实测可用）。**任何一项读不到就标 `unsupported`，不允许拿常量或猜测值冒充访客数据。**

### 8.10 部署事实、权限依赖与 `/admin` 的保护

已确认的事实：

| 事 | 值 |
|---|---|
| 采集入口 | `https://radishcloud.072120.xyz/v1/collect`（CF 边缘加头 → 隧道，无 Worker） |
| 源站 | `radishcloud.072120.xyz` → cloudflared 隧道 → `127.0.0.1:11451` |
| 源站系统 | Windows Server 2022（另一台机器，不是博客所在机） |
| 博客 | GitHub Pages，不经过 Cloudflare |
| zone | `072120.xyz`，控制台可登录；Zero Trust 团队域 `mujica.cloudflareaccess.com` |
| 付款 | **账号有付款墙**：Zero Trust → Access 建应用会要求付款方式。所以 v1 不用 Access，也不新增 Worker |

权限 → 用途 → 没有时的降级：

| 权限 | 用途 | 没有的话 |
|---|---|---|
| 规则 → 设置 → 托管转换（免费） | 访客位置头（`geo` `coords` `tzip`） | 降级 D2：源站本地 IP 库自算 geo/ASN（115/124） |
| Transform Rules | 原计划给 `/cdn-cgi/trace` 加 CORS | **不需要**：实测边缘已返回 `Access-Control-Allow-Origin: *` |
| zone 面板 → Rate Limiting（免费版 1 条） | 边缘限流 | 只剩源站限流（够用，但源站要先扛住流量） |
| Zero Trust → Access | 保护 `/admin` | **不用**（付款墙），走下面的方案 1 |

`/admin` 三选一：

| | 做法 | 你要维护什么 | 强度 |
|---|---|---|---|
| **1. 隧道挡掉 + 本机看（采用）** | cloudflared 的 ingress 里给 `^/admin.*` 配 `http_status:404`，外网永远 404；你远程桌面连那台 Windows，本机浏览器开 `http://127.0.0.1:11451/admin` | 一条 YAML 配置 | 最高（外网没有入口）；代价：手机上看看不到 |
| 2. 源站单密码登录 | RadishCloud 内置：一个密码（Argon2/bcrypt）、签名 Cookie 会话、失败按 IP 退避 | 一个密码 | 高；漏洞面只在 `/admin` |
| 3. URL token | `?t=<64 位随机>` | token 泄露即失守，且留在浏览器历史与日志 | 弱，不推荐 |

cloudflared 配置片段（贴进 `config.yml`，ingress 自上而下匹配，顺序不能反）：

```yaml
ingress:
  - hostname: radishcloud.072120.xyz
    path: ^/admin.*
    service: http_status:404
  - hostname: radishcloud.072120.xyz
    service: http://127.0.0.1:11451
  - service: http_status:404
```

## 9. 采集端行为规格（`static/radish-collect.js`）

- 单文件、无依赖、约 30–50 KB、`defer`，由 `config.json` 的 `allHead` 注入（保留现有 `GmeekBSZ.js`）
- 触发：`DOMContentLoaded` → `requestIdleCallback`（回退 `setTimeout(…, 1500)`）
- **每会话一次**：`sessionStorage['radish.sent']` 存在就跳过；`path` 只记触发那一页
- 隐私信号：`navigator.globalPrivacyControl === true` 或 `doNotTrack === '1'` → 只发 `srv` + `page`，`cli` 为空、`privacy.optout = true`
- 每项超时 3s；整体 8s 到点用目前拿到的值发送；超时项记进 `meta.stuck`。8s 是从 idle 回调触发起算，不是从 navigation 起算
- **体积预算 48 KiB**（`sendBeacon` 硬上限约 64 KB，要给 `srv`/`meta` 留位置）：超了按固定优先级截断——先砍 `fonts`（≤300）、`voices`、`codecs`/`rtccodecs`/`recmime`、`icu` 这些长列表，各自记 `{"$":"truncated","n":原长度}`；`srv`、`page`、`meta` 永不截断。绝不因为超限整条不发
- 发送顺序：`GET /cdn-cgi/trace` → `GET /v1/hints` → beacon `POST /v1/collect`（见 §8.9）；前两步失败不影响 beacon
- 发送：`navigator.sendBeacon(url, new Blob([json], {type:'text/plain'}))`（简单请求，无预检）；回退 `fetch(url, {method:'POST', body, keepalive:true, mode:'no-cors'})`
- 不读 Cookie、不写 localStorage、不动页面 DOM、捕获所有异常并静默
- 探测脚本内部不得引用 who.1ms.dog 的代码或文案；每一项的取值算法见附录 A 的「机制」列

## 10. 字段缺失约定（两侧都要按这个认）

| 标记 | 含义 |
|---|---|
| 原值 | 读到了 |
| `null` | 读到但浏览器返回空 |
| `{"$":"unsupported"}` | 这个浏览器没有该 API |
| `{"$":"denied"}` | 有 API，需要授权，v1 不请求 |
| `{"$":"timeout"}` | 3s 内没返回 |
| `{"$":"error"}` | 抛异常 |

与 who.1ms.dog 的对应：他们的 `v_unsup` / `v_fail` / `v_none` 分别等价于 `unsupported` / `error` / `null`。

## 11. 我替你定的（不同意就说，这几条我按常理拍的）

1. **保留期 90 天原始 + 永久聚合** —— 你要的是分布，90 天足够看出季节性；再长的原始记录只会放大泄露面。
2. **每会话一条，不是每页一条** —— 博客页面多，每页一条会把"设备分布"灌成"页面浏览日志"，还把量放大十几倍。真要页面级行为，那是另一个项目。
3. **IP 原样存，不哈希** —— 因为你要 PTR 反查、要按 IP 翻单条；后台只有你能进。若你更在意最小化，可改成存 /24 与末位掩码，我按你的意思改。
4. **DNT / GPC 时只存服务端字段** —— 人家明确说了别追踪，那就只留 IP/网络/UA 这类"不发信号也能看到"的，指纹一项不采。
5. **客户端唯一 ID 用随机 UUID，不用指纹** —— `fpid`/`hwid` 只当分布维度，不当访客主键，避免变成跨会话追踪。
6. **后台不自建登录** —— 默认走 §8.10 方案 1：隧道把 `/admin*` 挡成 404，只在那台机器本机看。哪天你要手机上看，再谈方案 2（RadishCloud 内置单密码）。
7. **设计文档放 `specs/`，不放 `docs/superpowers/specs/`** —— `docs/` 是 Gmeek 的构建产物，每次构建被删，放进去等于没放。
8. **复合项展开成子维度**（§8.5.1）：屏幕按 `w×h` 与 `dpr` 分开、显卡按厂商与型号分开、字体与编解码器按单项计次。整包压成一个字符串的话每张卡都是"取值 1 次"，分布图没有意义。
9. **单条上限 96 KiB、客户端预算 48 KiB**，超了按优先级截断而不是整条丢弃——客户端读不到 413，丢一条就是静默丢一条，而且永远不会知道。
10. **限流按 `HMAC(ip+UA)` 而不是纯 IP**，阈值提高，且后台要显示被限流/被丢弃的计数。
11. **`kex`/`warp` 走浏览器直连 `/cdn-cgi/trace`**（§8.9）——实测边缘自带 `ACAO: *`，直接可读，覆盖率 118/124。不接受拿常量或猜的值冒充访客数据。
12. **v1 不写 Worker**：Worker 只多换 `proto`/`tlsfp` 两项，却要再部署一个组件、还要绕开付款墙。RadishCloud 单独仓库、由另一个 agent 按 §8 实现，必须逐条对齐 §8 与 §10。
13. **`/admin` 走「隧道挡掉 + 本机看」（§8.10 方案 1）**：cloudflared 里给 `^/admin.*` 配 `http_status:404`，后台只在那台机器上用远程桌面打开 `127.0.0.1:11451/admin` 看。哪天拿到付款方式、或愿意让 RadishCloud 内置密码登录，再换方案 2。

## 12. 留给 builder 的

**范围**：本计划只做采集端（`static/radish-collect.js`）+ 三条 CF 免费规则的写法 + 把 §8 契约交给 RadishCloud 那一侧；RadishCloud 内部怎么实现由它自己定，但它必须逐条实现 §8 与 §10。两边可以并行，契约先冻结。

- RadishCloud 的语言/框架（默认：单进程 + SQLite 足够，不要引入需要额外运维的组件）
- 三条 CF 免费规则的具体写法（访客位置头；`/cdn-cgi/trace` 的 CORS + `Accept-CH`；Rate Limiting）；Worker 只在二期做
- 采集脚本里每一项的具体实现细节（附录 A 的机制列是规格，算法自选，注意别被指纹防护噪声坑到，`rand` 项要做两次 canvas 比对）
- 后台的具体视觉、是否要导出 CSV、聚合口径（按天/UTC 偏移）
- 部署顺序与回滚（先 `/v1/collect` 落库通了，再接前端）
- Windows Server 2022 上的落地细节：进程用 WinSW/NSSM 注册成服务（别留一个命令窗口常驻）；SQLite 放 `C:\ProgramData\RadishCloud\data.db`；04:00 的保留期清理用任务计划程序；日志按天滚动写文件

## 附录 A：124 项清单与提供方

### net · 服务器看到的（20 项）

| id | 探测项 | 机制/来源 | 提供方 |
|---|---|---|---|
| `ip` | IP 地址 | CF-Connecting-IP | E |
| `geo` | 位置 | request.cf.city | E |
| `coords` | 坐标 | request.cf.latitude | E |
| `isp` | 网络（ASN） | request.cf.asOrganization | O |
| `dns` | DNS 服务器 | edns.ip-api.com | C* |
| `tzip` | IP 所在时区 | request.cf.timezone | E |
| `ptr` | 反向解析 | DNS PTR | O |
| `edge` | 最近的数据中心 | request.cf.colo | E |
| `proto` | HTTP 和 TLS | request.cf.tlsVersion | X |
| `kex` | 密钥交换 | /cdn-cgi/trace · kex, sni | C* |
| `warp` | Cloudflare WARP | /cdn-cgi/trace · warp | C* |
| `tlsfp` | TLS 指纹 | TLS ClientHello | X |
| `tcpfp` | TCP/IP 指纹 | probe.1ms.dog · TCP SYN | X |
| `ja4` | TLS 指纹（JA4） | probe.1ms.dog · JA4 | X |
| `h2fp` | HTTP/2 指纹 | probe.1ms.dog · HTTP/2 SETTINGS | X |
| `quicfp` | QUIC 指纹（HTTP/3） | probe.1ms.dog · HTTP/3 · QUIC JA4 | X |
| `clock` | 时钟 | Date.now() | C |
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

提供方图例：`C` 客户端 JS · `C*` 客户端 JS 但依赖跨域读（第三方接口或边缘 trace） · `E` CF 边缘请求头 · `O` 源站自算 · `X` v1 不做

合计 124 项：E 12 · O 4 · C* 9 · X 6 · C 93
