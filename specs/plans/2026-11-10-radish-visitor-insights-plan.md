# 博客访客信息采集（采集端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitHub Pages 博客里注入一段零依赖的采集脚本，把 who.1ms.dog 那 124 项里的 93 项纯浏览器探测读全，打成一条 ≤48 KiB 的 JSON，用 beacon 发到 `https://radishcloud.072120.xyz/v1/collect`。

**Architecture:** 单个浏览器脚本 `static/radish-collect.js`（无构建、无依赖、`defer` 加载），内部是一个探针注册表 + 一个信封构造器 + 一个预算裁剪器；通过 `config.json` 的 `allHead` 注入每页。测试用 Node 24 的 `node:test` + `node:vm` 在假浏览器环境里跑，不需要浏览器也不需要构建步骤。

**Tech Stack:** ES2020 浏览器 JS（IIFE，挂 `window.__radish`）；Node 24 + `node:test` + `node:vm`；Gmeek 的 `static/` → `docs/` 复制机制。

**Spec:** `specs/2026-11-10-radish-visitor-insights-design.md`（本计划只覆盖采集端；RadishCloud 源站由另一个 agent 按 spec §8/§10 实现）

## Global Constraints

- 顶层请求体只有 7 个键：`v`、`id`、`ts`、`session`、`page`、`cli`、`meta`。**没有 `srv`**——`srv` 由源站从请求头还原（spec §8.2）。
- `v` 恒为 `1`；`meta.collector` 恒为 `"radish-1.0.0"`。
- 采集地址：`https://radishcloud.072120.xyz/v1/collect`；辅助地址：`https://radishcloud.072120.xyz/cdn-cgi/trace`、`https://radishcloud.072120.xyz/v1/hints`（spec §7、§8.9）。
- 单项超时 `3000 ms`；整体预算 `8000 ms`（从 idle 回调起算）；`pagehide` 时提前发（spec §4、§9）。
- 客户端体积预算 `48 * 1024` 字节；裁剪优先级：`fonts`（保留前 300）→ `voices` → `codecs`/`rtccodecs`/`recmime` → `icu`（spec §9）。
- 缺失标记只有这 5 种对象形态：`{"$":"unsupported"}`、`{"$":"denied"}`、`{"$":"timeout"}`、`{"$":"error"}`、`{"$":"truncated","n":<原长度>}`（spec §10）。
- `cli` 的键名必须是 spec 附录 A 的 id 原文，不改名、不加前缀。
- 每会话只发一次：`sessionStorage['radish.sent']`；隐私模式抛错时退化为内存标记。
- `navigator.globalPrivacyControl === true` 或 `navigator.doNotTrack === '1'` → `cli` 为空对象、`meta.privacy.optout === true`（spec §11.4）。
- 不读 Cookie、不写 `localStorage`、不改 DOM、不上报异常（spec §9）。
- 不照抄 who.1ms.dog 的代码与文案；只按附录 A 的 124 个 id 与「机制」列自己实现。

## Review Focus

1. **每项探测独立失败** —— 页面在跨源 iframe 里、`canvas.toDataURL` 抛 SecurityError、`WebGL` 上下文拿不到，任何一项抛错都不能影响其余；任何情况下 `cli` 里 124 个 id 对应的键必须齐全（缺的用标记）。
2. **1 秒内关页** —— 用户刚打开就关，idle 回调可能还没跑；`pagehide` 时必须仍发出（这是最容易静默丢数据的一类）。
3. **`sessionStorage` 不可用** —— Safari 隐私模式 / 禁用存储时 `setItem` 抛错；门控必须退化为内存标记，采集照常。
4. **DNT / GPC 开启** —— 必须 `cli` 为空且 `optout=true`，不得"顺手"采指纹。
5. **设备时钟错乱** —— `tz` 是 `UTC`、系统年份 1970 时，`ts` 仍必须是 `new Date().toISOString()` 的真实值，不得由其它数据拼出来。

## 文件结构

| 文件 | 责任 |
|---|---|
| `static/radish-collect.js` | 采集脚本全部实现（注册表、信封、预算、发送）。Gmeek 会自动把它复制到站点根 `/radish-collect.js` |
| `tests/harness.js` | `loadCollector(fakeGlobals)`：用 `node:vm` 在假环境里加载采集脚本，返回 `window.__radish` |
| `tests/envelope.test.js` | Task 1、2 的测试 |
| `tests/probes-loc-fp.test.js` | Task 3 的测试 |
| `tests/probes-dev.test.js` | Task 4 的测试 |
| `tests/probes-brw.test.js` | Task 5 的测试 |
| `tests/beacon.test.js` | Task 6 的测试 |
| `config.json` | 在 `allHead` 里追加一行 `<script src="/radish-collect.js" defer></script>` |
| `specs/radishcloud-contract.md` | Task 8 产出：给 RadishCloud agent 的独立契约 |

---

### Task 1: 测试脚手架 + 探针注册表 + 请求信封

**Files:**
- Create: `static/radish-collect.js`
- Create: `tests/harness.js`
- Test: `tests/envelope.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `window.__radish.VERSION: string`（`'radish-1.0.0'`）
  - `window.__radish.ID_SET: { C: string[], C_STAR: string[], E: string[], O: string[], X: string[] }` —— 分别 93/9/12/4/6 项，取自 spec §8.1
  - `window.__radish.M(kind: 'unsupported'|'denied'|'timeout'|'error', n?: number) => { $: string } | { $: 'truncated', n: number }`
  - `window.__radish.buildEnvelope(env: FakeEnv): { v: 1, id: string, ts: string, session: string, page: object, cli: object, meta: object }`
  - `window.__radish.probes: Array<{ id: string, run: (env: FakeEnv) => any }>`（Task 3–5 往里加）

- [ ] **Step 1: 写失败测试**

```js
// tests/envelope.test.js
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv } = require('./harness');

test('信封只有 7 个顶层键，且没有 srv', () => {
  const RC = loadCollector(fakeEnv());
  const e = RC.buildEnvelope();
  assert.deepStrictEqual(Object.keys(e).sort(), ['cli', 'id', 'meta', 'page', 'session', 'ts', 'v']);
  assert.strictEqual(e.v, 1);
  assert.strictEqual(e.meta.collector, 'radish-1.0.0');
});

test('cli 覆盖 124 个 id，且 C/C*/E/O/X 数量符合 spec §8.1', () => {
  const RC = loadCollector(fakeEnv());
  const { C, C_STAR, E, O, X } = RC.ID_SET;
  assert.deepStrictEqual([C.length, C_STAR.length, E.length, O.length, X.length], [93, 9, 12, 4, 6]);
  const ids = new Set([...C, ...C_STAR, ...E, ...O, ...X]);
  assert.strictEqual(ids.size, 124);
  const e = RC.buildEnvelope();
  for (const id of [...RC.ID_SET.C, ...RC.ID_SET.C_STAR]) {
    assert.ok(id in e.cli, 'missing cli id: ' + id);
  }
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/envelope.test.js`
Expected: FAIL，`Cannot find module './harness'`

- [ ] **Step 3: 写 `tests/harness.js`**

`loadCollector(globals)` 用 `node:vm.createContext` 建上下文，把 `window`、`document`、`navigator`、`screen`、`location`、`performance`、`speechSynthesis` 塞进去（`window` 同时作为全局对象，`window.__radish` 由脚本写入），然后 `vm.runInContext(fs.readFileSync('static/radish-collect.js','utf8'), ctx)`。`fakeEnv(overrides)` 返回一份最小可用的假浏览器环境：`navigator = { userAgent: 'test-ua', languages: ['zh-CN','zh'], language: 'zh-CN', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0 }`、`screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 }`、`devicePixelRatio: 1.25`、`location = { href: 'https://blue-radish.github.io/post/x.html', pathname: '/post/x.html' }`、`document.referrer = ''`、`storage: new Map()`（给假 `sessionStorage` 用）。`overrides` 深合并覆盖。

- [ ] **Step 4: 写 `static/radish-collect.js` 的骨架**

IIFE，`const RC = { VERSION: 'radish-1.0.0' }`；`ID_SET` 里的 `C`、`C_STAR`、`E`、`O`、`X` 五个数组**照 spec 附录 A 的提供方列抄**（C 93 项、C* 9 项即附录里的 `C*`，E 12、O 4 里属于客户端的只有 `ch` 不用抄进来、`X` 6 项照抄）；`M(kind, n)` 返回 `{ $: kind }` 或 `{ $: 'truncated', n }`；`buildEnvelope(env = globalThis)` 组装 7 个顶层键，其中 `id` 用 `crypto.randomUUID()`（缺失时退化为 `Date.now()+Math.random()` 的 32 位 hex），`ts` 用 `new Date().toISOString()`，`session` 从 `getSession()` 取（Task 6 实现前，本步先返回内存随机串），`page` 为 `{ path, title, lang, ref, nav }`，`cli` 由 `probes` 顺序执行后填入（本步 `probes` 为空数组），`meta` 为 `{ dur_ms, stuck: [], privacy: { dnt, gpc, optout }, collector }`。末尾 `window.__radish = RC`。

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test tests/envelope.test.js`
Expected: PASS（2 tests）

- [ ] **Step 6: 提交**

```bash
git add static/radish-collect.js tests/harness.js tests/envelope.test.js
git commit -m "feat(collector): envelope skeleton, id registry and vm test harness"
```

---

### Task 2: 值归一化与 48 KiB 预算裁剪

**Files:**
- Modify: `static/radish-collect.js`
- Test: `tests/envelope.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `M`、`buildEnvelope`
- Produces:
  - `window.__radish.normalize(v: any) => string`
  - `window.__radish.applyBudget(envelope: object, limit: number) => { envelope: object, dropped: Array<{ id: string, n: number }> }`

- [ ] **Step 1: 写失败测试**

```js
test('normalize 固定格式，供服务端 facet 直接使用', () => {
  const RC = loadCollector(fakeEnv());
  assert.strictEqual(RC.normalize('UTC+8'), 'UTC+8');
  assert.strictEqual(RC.normalize(1.23456789), '1.2346');
  assert.strictEqual(RC.normalize(true), 'true');
  assert.strictEqual(RC.normalize({ $: 'unsupported' }), 'unsupported');
  assert.strictEqual(RC.normalize(['b', 'a']), 'a|b');
});

test('超预算时按优先级截断 long lists，而不是整条丢弃', () => {
  const RC = loadCollector(fakeEnv());
  const e = RC.buildEnvelope();
  e.cli.fonts = Array.from({ length: 900 }, (_, i) => 'Font' + i + 'x'.repeat(40));
  e.cli.voices = Array.from({ length: 900 }, (_, i) => 'Voice' + i);
  e.cli.icu = Array.from({ length: 900 }, (_, i) => 'Unit' + i);
  const out = RC.applyBudget(e, 48 * 1024);
  const bytes = Buffer.byteLength(JSON.stringify(out.envelope), 'utf8');
  assert.ok(bytes <= 48 * 1024, 'bytes=' + bytes);
  assert.deepStrictEqual(out.envelope.cli.fonts.length, 300);
  assert.deepStrictEqual(out.envelope.cli.fonts.$ , 'truncated');
  assert.ok(out.dropped.some(d => d.id === 'voices'));
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/envelope.test.js`
Expected: FAIL，`RC.normalize is not a function`

- [ ] **Step 3: 实现 `normalize` 与 `applyBudget`**

`normalize`：字符串原样；数字 `Number.toFixed(4)` 后去掉尾部零；布尔 `'true'`/`'false'`；`null` 返回 `'null'`；缺失标记对象返回 `v.$`；数组去重排序后 `join('|')`；其它对象取键排序后的稳定 JSON。`applyBudget`：`JSON.stringify` 测字节，超限时按 `['fonts','voices','codecs','rtccodecs','recmime','icu']` 顺序，把数组项截到前 300（`fonts`）或前 64（其余）并在该项上写 `$: 'truncated'` + `n: 原长度`（数组用 `Object.defineProperty` 挂属性，序列化时不可见，因此改为把该 id 的值替换成 `{ list: [...], $: 'truncated', n }`）；每轮重测字节，直到 ≤ limit 或列表全部被压到最小值；`srv`、`page`、`meta`、`cli.fpid`、`cli.hwid` 永不裁剪。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test tests/envelope.test.js`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add static/radish-collect.js tests/envelope.test.js
git commit -m "feat(collector): facet-friendly normalization and 48KiB budget trimming"
```

---

### Task 3: `loc` 9 项 + `fp` 22 项客户端探测

**Files:**
- Modify: `static/radish-collect.js`
- Test: `tests/probes-loc-fp.test.js`

**Interfaces:**
- Consumes: Task 1 的 `probes` 数组、`M`
- Produces: 往 `probes` 里追加 `id` 为 spec 附录 A `loc`·`fp` 组中提供方为 `C` 的 31 个 id；每项 `run(env)` 返回下表形状，或 `M(...)`

非标量项的形状（其余为标量 `string|number|boolean`）：

| id | 形状 |
|---|---|
| `langs` `voices` `fonts` `lies` | `string[]` |
| `canvas` | `{ h: string, len: number }`（`h` 为 `sha256:<hex>`） |
| `webgl` | `{ vendor: string, renderer: string, unmaskedVendor: string, unmaskedRenderer: string, version: string, sl: string, ext: number }` |
| `audio` `mathfp` `fontfp` `domrect` `svgrect` `textm` `glimg` `fpid` `hwid` | `string`（形如 `sha256:<hex>` 或可读描述串） |
| `keys` | `{ window: number, html: number, css: number }` |
| `timer` | `{ res: number, now: number }` |
| `callstack` | `number` |
| `emoji` | `string`（如 `15.1` 或 `unknown`） |
| `rand` | `{ same: boolean }`（两次 canvas 结果是否一致） |
| `shield` | `{ brave: boolean, noise: boolean }` |
| `smooth` | `string`（`on`/`off`/`unknown`） |

- [ ] **Step 1: 写失败测试**

```js
test('loc 组全部就位，且 tz 读的是 Intl 时区', () => {
  const env = fakeEnv({ intlTimeZone: 'Asia/Shanghai' });
  const RC = loadCollector(env);
  const e = RC.buildEnvelope();
  for (const id of ['langs','locale','tz','hour','week','fmt','icu','kbd','voices']) {
    assert.ok(id in e.cli, 'missing ' + id);
  }
  assert.strictEqual(e.cli.tz, 'Asia/Shanghai');
});

test('canvas/webgl 抛错时只标记该项，其余项照常', () => {
  const env = fakeEnv({ throwOnCanvas: true });
  const RC = loadCollector(env);
  const e = RC.buildEnvelope();
  assert.deepStrictEqual(e.cli.canvas, { $: 'error' });
  assert.ok('tz' in e.cli && e.cli.tz);
});

test('不支持的 API 标 unsupported 而不是 undefined', () => {
  const RC = loadCollector(fakeEnv({ noSpeech: true }));
  const e = RC.buildEnvelope();
  assert.deepStrictEqual(e.cli.voices, { $: 'unsupported' });
  assert.strictEqual(Object.values(e.cli).filter(v => v === undefined).length, 0);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/probes-loc-fp.test.js`
Expected: FAIL，缺 `tz`/`canvas` 键

- [ ] **Step 3: 实现 31 项**

每个探针写成 `{ id, run(env) }` 推进 `probes` 数组；`buildEnvelope` 里对每项包一层 `try/catch` + `Promise.race` 3 秒超时（同步项直接 try/catch），异常记 `M('error')`、超时记 `M('timeout')` 并 push 进 `meta.stuck`、API 不存在记 `M('unsupported')`。每项的读取方式按 spec 附录 A 的「机制」列实现：`engine` 用 `new Error().stack` 首行、`engver` 用特性探测表、`lies` 用 `Function.prototype.toString` 在 iframe 里比对、`cssv` 用 `CSS.supports` 探测年份、`mathfp` 对一组 `Math.*` 结果拼接后 SHA-256、`fontfp`/`fonts` 用 canvas `measureText` 逐个字体比对基准宽度、`domrect` 用 `getClientRects`、`svgrect` 用 `getBBox`、`textm` 用 `actualBoundingBox*`、`glimg` 用 `readPixels` 后 SHA-256、`keys` 统计 `Object.keys(window|HTMLElement.prototype|CSS)` 长度、`timer` 用 `performance.now()` 最小非零增量、`callstack` 用递归爆栈计数、`fpid` 对 `tmpl+langs+screen+tz+canvas+webgl+audio+fonts` 拼接后 SHA-256、`hwid` 对 `screen+cores+gpu+fonts` 拼接后 SHA-256、`rand` 连续两次画 canvas 比对、`shield` 检 `navigator.brave` 与 `Math.random` 噪声、`smooth` 用 canvas 抗锯齿特征、`emoji` 用 `measureText` 宽度判断 Emoji 版本。哈希统一走 `crypto.subtle.digest('SHA-256', ...)`，不可用时退回 `M('unsupported')`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test tests/probes-loc-fp.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add static/radish-collect.js tests/probes-loc-fp.test.js
git commit -m "feat(collector): loc and fingerprint probes"
```

---

### Task 4: `dev` 34 项

**Files:**
- Modify: `static/radish-collect.js`
- Test: `tests/probes-dev.test.js`

**Interfaces:**
- Consumes: Task 1 的 `probes`、`M`
- Produces: `dev` 组 34 个 id 的探针，形状如下表；`geoloc`/`sensors`/`gamepad` 恒返回 `M('denied')`（spec §3：不做需要手势的探测）

| id | 形状 |
|---|---|
| `screen` | `{ w, h, aw, ah, dpr, depth }` |
| `win` | `{ iw, ih, ow, oh }` |
| `gpu` | `{ vendor, renderer, unmasked }` |
| `webgpu` | `{ vendor, arch, device, desc }` 或 `M(...)` |
| `gpulim` | `{ maxTexDim: number, features: string[] }` |
| `glx` | `{ maxTexture, maxRenderbuffer, maxViewport: [number, number], ext: number }` |
| `screens` | `{ n: number, ext: boolean }` |
| `touch` | `{ points: number, pointer: string, hover: boolean }` |
| `battery` | `{ level: number, charging: boolean }` |
| `conn` | `{ eff: string, rtt: number, down: number, save: boolean }` |
| `media` | `{ audio: number, video: number }` |
| `codecs` `recmime` `hwdec` `drm` | `{ [key: string]: boolean }` |
| `rtccodecs` | `{ audio: string[], video: string[] }` |
| `storage` | `{ quota: number, usage: number }` |
| `xr` | `{ vr: boolean, ar: boolean }` |
| `arch` `form` `model` `os` `browser` `hz` `scrollbar` `cpu` `mem` `heap` `audiohw` `bio` `bt` `geoloc` `sensors` `gamepad` | 标量（后三项为标记） |

- [ ] **Step 1: 写失败测试**

```js
test('dev 组 34 项齐全，screen 取真实值', () => {
  const RC = loadCollector(fakeEnv());
  const e = RC.buildEnvelope();
  assert.deepStrictEqual(e.cli.screen, { w: 1920, h: 1080, aw: 1920, ah: 1040, dpr: 1.25, depth: 24 });
  assert.strictEqual(e.cli.cpu, 8);
  assert.deepStrictEqual(e.cli.geoloc, { $: 'denied' });
});

test('需要授权与不支持的项都用标记，且不请求授权', () => {
  const env = fakeEnv();
  let asked = false;
  env.navigator.geolocation = { getCurrentPosition: () => { asked = true; } };
  const RC = loadCollector(env);
  const e = RC.buildEnvelope();
  assert.deepStrictEqual(e.cli.sensors, { $: 'denied' });
  assert.strictEqual(asked, false);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/probes-dev.test.js`
Expected: FAIL，`screen` 不存在

- [ ] **Step 3: 实现 34 项**

按 spec 附录 A 「机制」列实现。`codecs` 用 `MediaSource.isTypeSupported` 遍历一张固定清单（`h264`/`hev1`/`vp9`/`av01`/`opus`/`flac` 等 12 项），`recmime` 用 `MediaRecorder.isTypeSupported`（同理 10 项），`hwdec` 用 `mediaCapabilities.decodingInfo`，`drm` 用 `requestMediaKeySystemAccess`（`widevine`/`playready`/`fairplay`）。`screen`/`win` 直接读 `screen.*` 与 `innerWidth` 等；`screens` 用 `screen.isExtended`；`scrollbar` 用一次隐藏 div 的 `offsetWidth - clientWidth`；`hz` 用两次 `requestAnimationFrame` 间隔换算；`webgpu`/`gpulim` 异步取 adapter，失败 `M('unsupported')`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test tests/probes-dev.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add static/radish-collect.js tests/probes-dev.test.js
git commit -m "feat(collector): device probes"
```

---

### Task 5: `brw` 24 项

**Files:**
- Modify: `static/radish-collect.js`
- Test: `tests/probes-brw.test.js`

**Interfaces:**
- Consumes: Task 1 的 `probes`、`M`
- Produces: `brw` 组 24 个 id；形状如下表；`trackers` 恒 `M('denied')`、`extwar` 恒 `M('denied')`（spec §3 不做主动实测）

| id | 形状 |
|---|---|
| `gamut` | `{ gamut: string, dynamic: string }` |
| `a11y` | `{ contrast: string, forced: boolean }` |
| `sysui` | `{ fontSize: number, accent: string }` |
| `dnt` | `{ dnt: string, gpc: boolean }` |
| `perms` | `{ [name: string]: string }`（`permissions.query` 状态串） |
| `apis` | `{ [name: string]: boolean }`（`usb`/`serial`/`hid`/`idle`/`nfc` 等） |
| `ai` | `{ [name: string]: string }`（`LanguageModel`/`Translator` availability） |
| `auto` | `string[]`（命中 headless/CDP/Electron 线索的名字） |
| `idstr` | `{ vendor: string, productSub: string, plugins: string[] }` |
| `agent` | `{ type: string, trusted: boolean }` |
| `worker` | `{ ok: boolean, uaSame: boolean }` |
| `traces` | `{ [name: string]: boolean }`（localStorage/IndexedDB/Cache/window.name 是否有痕） |
| `fonts` | `string[]`（与 Task 3 的字体探测共用结果） |
| `scheme` `motion` `display` `pdf` `webdriver` `adblock` `history` `cookies` `ext` | 标量 / `string[]`（`ext`、`auto` 为数组） |

- [ ] **Step 1: 写失败测试**

```js
test('brw 组就位，webdriver 为布尔', () => {
  const RC = loadCollector(fakeEnv());
  const e = RC.buildEnvelope();
  assert.strictEqual(typeof e.cli.webdriver, 'boolean');
  assert.deepStrictEqual(e.cli.trackers, { $: 'denied' });
  assert.ok('perms' in e.cli && 'apis' in e.cli);
});

test('adblock 用诱饵元素判断，不访问网络', () => {
  const env = fakeEnv({ baitHidden: true });
  const RC = loadCollector(env);
  assert.strictEqual(RC.buildEnvelope().cli.adblock, true);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/probes-brw.test.js`
Expected: FAIL，缺 `webdriver`

- [ ] **Step 3: 实现 24 项**

按 spec 附录 A「机制」列：`scheme`/`motion`/`gamut`/`a11y`/`sysui`/`display` 全走 `matchMedia`；`dnt` 读 `navigator.doNotTrack` 与 `navigator.globalPrivacyControl`；`perms` 遍历 9 个权限名用 `permissions.query`（**只查状态，不请求**）；`apis` 检 `navigator.usb` 等构造函数是否存在；`ai` 检 `LanguageModel`/`Translator` 的 `availability()`；`worker` 起一个 `Blob` Worker 读 `navigator.userAgent` 与主线程比对；`traces` 检 `localStorage`/`indexedDB.databases`/`caches`/`window.name`（**只读不写**）；`fonts` 复用 Task 3 结果；`ext` 检 `window.ethereum` 等 DOM 标记；`history` 读 `history.length`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test tests/probes-brw.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add static/radish-collect.js tests/probes-brw.test.js
git commit -m "feat(collector): browser-setting probes"
```

---

### Task 6: 三段式发送、会话门控与隐私信号

**Files:**
- Modify: `static/radish-collect.js`
- Test: `tests/beacon.test.js`

**Interfaces:**
- Consumes: Task 1–5 的 `probes`、`buildEnvelope`、`applyBudget`
- Produces:
  - `window.__radish.run(env?: object, opts?: { endpoint: string, trace: string, hints: string, limit: number, deadline: number }): Promise<void>`
  - 发送顺序固定：`GET {trace}` → `GET {hints}` → `POST {endpoint}`；前三者各有 2s 超时
  - `window.__radish.getSession(): string`（`sessionStorage['radish.sid']`，不可用时内存标记）

- [ ] **Step 1: 写失败测试**

```js
test('每会话只发一次', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  await RC.run(env);
  await RC.run(env);
  assert.strictEqual(env.sent.length, 1);
});

test('sessionStorage 抛错时退化为内存标记，仍然发出', async () => {
  const env = fakeEnv({ sessionStorageThrows: true });
  const RC = loadCollector(env);
  await RC.run(env);
  await RC.run(env);
  assert.strictEqual(env.sent.length, 1);
});

test('DNT 开启时 cli 为空且 optout 为 true', async () => {
  const env = fakeEnv({ dnt: '1' });
  const RC = loadCollector(env);
  await RC.run(env);
  const body = JSON.parse(env.sent[0]);
  assert.deepStrictEqual(body.cli, {});
  assert.strictEqual(body.meta.privacy.optout, true);
});

test('pagehide 早于 idle 时仍发出', async () => {
  const env = fakeEnv({ idleNeverFires: true });
  const RC = loadCollector(env);
  const p = RC.run(env);
  env.dispatch('pagehide');
  await p;
  assert.strictEqual(env.sent.length, 1);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test tests/beacon.test.js`
Expected: FAIL，`RC.run is not a function`

- [ ] **Step 3: 实现 `run`**

`run` 的流程：`if (alreadySent()) return`；`await ready`（`DOMContentLoaded` 后 `requestIdleCallback`，回退 `setTimeout(1500)`；`idleNeverFires` 时靠 `pagehide` 唤醒）；`t0 = performance.now()`；并发拉 `trace` 与 `hints`（各 `AbortSignal.timeout(2000)`，失败记 `M('unsupported')` 到对应项）；`env = 当前全局`；构造信封（DNT/GPC 时 `cli = {}`、`optout = true`、`meta.note = 'optout'`）；`applyBudget(48*1024)`；`JSON.stringify` 后按字节数写 `meta.dur_ms`；用 `navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))` 发送，返回 false 时退化为 `fetch(endpoint, { method: 'POST', body, keepalive: true, mode: 'no-cors' })`；无论成败都 `markSent()`。整体 `Promise.race` 8000ms 兜底。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test tests/beacon.test.js`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add static/radish-collect.js tests/beacon.test.js
git commit -m "feat(collector): beacon pipeline with session, privacy and pagehide gates"
```

---

### Task 7: 注入博客 + 本地自测

**Files:**
- Modify: `config.json`
- Test: 手工核对清单（无自动化测试；Gmeek 构建行为已在 spec §5 核实）

**Interfaces:**
- Consumes: Task 1–6 的 `static/radish-collect.js`
- Produces: 每页 `<head>` 里出现 `<script src='/radish-collect.js' defer></script>`

- [ ] **Step 1: 改 `config.json` 的 `allHead`**

把 `"allHead": "<script src='https://blog.meekdai.com/Gmeek/plugins/GmeekBSZ.js'></script>"` 改成在末尾追加 `"<script src='/radish-collect.js' defer></script>"`（原有的 `GmeekBSZ.js` 保留，顺序在前）。

- [ ] **Step 2: 本地起服务手工验证**

Run: `node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{const u=q.url==='/'?'/index.html':q.url;const fp=p.join('docs',u);f.readFile(fp,(e,d)=>{if(e){s.writeHead(404);s.end('nf')}else{s.writeHead(200,{'content-type':fp.endsWith('.js')?'text/javascript':'text/html'});s.end(d)}})}).listen(8080,'127.0.0.1',()=>console.log('http://127.0.0.1:8080'))"`
Expected: 打开 `http://127.0.0.1:8080` 后，DevTools → Network 里能看到 `radish-collect.js` 200，且**没有**发往 `/v1/collect` 的请求（源站还没上线，失败静默）。

- [ ] **Step 3: 用假的 endpoint 端到端验证**

Run: `node .tmp/fake-endpoint.js`（20 行本地服务，监听 11451，打印收到的 body 长度与 `cli` 键数）

把临时 `endpoint` 指向 `http://127.0.0.1:11451/v1/collect`（DevTools Console 里调 `__radish.run(window, { endpoint: 'http://127.0.0.1:11451/v1/collect' })`），确认：收到 1 条、`Object.keys(cli).length === 124`、字节数 ≤ 48*1024、`v === 1`、无 `srv` 键。

- [ ] **Step 4: 提交**

```bash
git add config.json
git commit -m "feat(blog): inject visitor collector into every page via allHead"
```

---

### Task 8: 抽出给 RadishCloud agent 的独立契约

**Files:**
- Create: `specs/radishcloud-contract.md`

**Interfaces:**
- Consumes: spec §8、§10、附录 A、§9 的客户端行为
- Produces: 一份自包含文档，另一个 agent 不读设计正文也能开工

- [ ] **Step 1: 抽取**

从 spec 复制这几块，逐字不改：§8.2（请求体形态 + 7 个顶层键 + 无 `srv`）、§8.3（状态码表）、§8.4（防护）、§8.5 + §8.5.1（两张表与展开规则）、§8.6（后台）、§8.7（`/v1/etag`）、§8.8（保留期）、§8.9（trace/hints 与 `Accept-CH` 由源站发）、§8.10（部署事实与 `/admin` 方案 1）、§10（缺失标记）、附录 A（124 项 id、提供方列）。

- [ ] **Step 2: 补一段「本契约的输入从哪来」**

写清：采集端固定发送 7 个键，`srv` 全部由源站从请求头还原（`CF-Connecting-IP`、`CF-IPCountry/City/Latitude/Longitude/Timezone/Postal-Code/Region`、`CF-Ray` 末三位、原始请求头 `user-agent`/`accept-language`/`sec-ch-ua*`/`accept-encoding`/`dnt`/`sec-gpc`/`referer`），`asn` 自己查 Team Cymru，`ptr` 自己反查；`cli` 的键在 124 项里可能缺项（DNT/GPC 时为空），一律按 §10 处理。

- [ ] **Step 3: 自查**

逐条核对：契约里每个出现的 id 都在附录 A 中；每个状态码都有触发条件；`facet` 的 `PRIMARY KEY (visit_id, k, v)` 与 §8.5.1 的展开规则一致；没有引用设计文档里没被复制过来的章节号。

- [ ] **Step 4: 提交**

```bash
git add specs/radishcloud-contract.md
git commit -m "docs: standalone contract for the RadishCloud server agent"
```


## 实施记录（2026-11-11，实现完成后补）

计划与实现的差异，都是实现时才发现的事实，按实际落地写在这里：

1. **`buildEnvelope` 是异步的**（`await` 返回 payload），因为 WebGPU、Battery、Storage、ICE、MediaCapabilities 这批探测本身就是 Promise。测试全部用 `await`。
2. **多了一个 Task 3 没列的分组**：`net`/`exit` 组里客户端可读的 10 项（`clock` `webrtc` `lan` `v6mac` `dns` + 出口 6 项）。`cli` 实际发 **105 个键** = `C` 93 + `C*` 9 + `edge` `ch` `proto`。
3. **`proto` 从不采集变成可采集**：`/cdn-cgi/trace` 的响应里有 `http=`/`tls=`，客户端直连边缘就能读到，所以 119/124 而不是 118。`kex`/`warp` 同理（实测该 zone 的 trace 自带 `Access-Control-Allow-Origin: *`，不需要任何 Transform Rule）。
4. **`ID_SET` 没有进产物**：改成 `tests/ids.json`（从 spec 附录 A 生成）做外部校验，断言 `cli` 的键集合与附录 A 完全一致——比我手抄一份数组更能防拼错。
5. **预算裁剪不改变数组形态**：`applyBudget` 只把 `fonts`/`voices`/`icu` 截短（300/300/24），裁剪记录写进 `meta.truncated: [{id, n}]`。理由：给数组挂 `$.n` 属性在 JSON 序列化时会丢，而换成对象又会破坏服务端的 facet 展开规则。
6. **`pagehide` 会给等待加分赛跑**：`run()` 里 `waitIdle` 与 `pagehide` 的 Promise 赛跑，用户 1 秒内关页也能立刻发（测试里有 3 秒内的耗时断言）。
7. **自动启动**：脚本在页面 `load` 后 1.2s 自己调 `run()`；测试环境用 `window.__radishManual = true` 关掉，避免异步活动污染断言。
8. **测试不能用 `node --test`**：本机沙箱禁止派生子进程（`spawn EPERM`），改成逐个文件 `node tests/xxx.test.js` 在进程内跑。22 个测试全过（envelope 9 / probes 7 / beacon 6）。
9. **实测通过**：105 键 payload（3873 字节）POST 真实源站返回 204；契约自测 11 项全对（204/幂等 204/403/400/413/400，`/v1/hints` 带 `Accept-CH`，`/v1/etag` 带 ETag，外网 `/admin` 404）。
