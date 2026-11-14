'use strict';
// A-09 · 跨仓契约夹具生成器（**单仓可跑**，不依赖兄弟目录）
//
// 跑法（在博客仓库根目录，不需要 RadishCloud 在旁边）：
//   node tests\make-contract.js
// 产物：tests\contract\blog-cli-contract.json
//
// 为什么要有这个东西（复审 A-09 原文）：
//   契约测试原来靠两仓并排（tests/w08-handoff.test.js 在 RadishCloud 兄弟目录缺失时
//   跳过），单仓 CI 等于没验。这里把**契约本身**放进本仓库的版本化夹具：顶层 cli 键
//   清单、每个键的递归形状骨架、缺失标记集合、每个字段的一句话人工语义，再加一颗
//   sha256 摘要。后端仓库拿同一份文件（字节复制）就能在自己的单仓 CI 里验证自己那一侧
//   的消费者；跨仓字节一致另算一条集成验收，不是任何一方单仓的强制依赖。
//
// 确定性（关键）：同一份采集器代码重跑两次，**契约部分**必须字节相同。
// 为此所有每次都会变的值（id / session / ts / meta.dur_ms / cli.timer.now /
// cli.hz / cli.callstack.depth / 各类摘要哈希 / meta.h3.elapsed_ms …）都在
// canonicalize() 里换成固定占位；这些路径登记在 VOLATILE_* 里，shape 上标
// `volatile: true`（不钉区间——区间会随运行时刻变），样本里换成固定值。
// 另有一类值是**运行采集器的 JS 引擎 / ICU** 决定的（engver / wasm.supported /
// icu 各类计数）：那是宿主泄漏，不是采集器的口径，登记在 HOST_NUMBER 里，
// shape 上标 `number<host>`（只钉类型、不钉取值），见夹具的 host_numbers 一段。
// 验证方法：
//   node tests\make-contract.js; Get-FileHash tests\contract\blog-cli-contract.json
//   node tests\make-contract.js; Get-FileHash tests\contract\blog-cli-contract.json  ← 两次必须一样
//
// 语义（semantics）是**人工写**的：一句话说清"这个字段测的是什么"，不复制键名。
// 复审专门点了"agent 同名但测量不同"这类漂移，只比键集合是抓不到的；所以语义写在这
// 份源码里（单一来源），夹具是它的产物，摘要把两者绑在一起——改了夹具没重算摘要，
// 博客侧 tests/a09-contract.test.js 会红。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCollector, fakeEnv, collectorCtx } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const COLLECTOR_SRC = path.join(ROOT, 'static', 'radish-collect.js');
const OUT_DIR = path.join(__dirname, 'contract');
const OUT_NAME = 'blog-cli-contract.json';
const OUT = path.join(OUT_DIR, OUT_NAME);

const ALG = 'blog-cli-contract/1';
const GENERATED_BY = 'tests/make-contract.js';

// 一次访问一个 id：四份样本统一成同一个固定值，重跑可逐字节 diff
const FIXED_ID = '018f2c6e-6a1b-7c3d-9e4f-5a6b7c8d9e0f';
const FIXED_SESSION = 'a1b2c3d4e5';
const FIXED_TS = '2026-11-13T08:00:00.940+08:00';
// 探针地址用 RFC 5737 文档地址：任何真实解析/查询都碰不到别人家
const PROBE_URL = 'https://192.0.2.10';

// 慢车道（采集器 SLOW_IDS）：离页半份时它们通常还没回来
const SLOW_IDS = ['ai', 'dns', 'etag', 'quicfp', 'trackers'];

// 只有探针应答时才会出现的顶层键（契约附录 G / H）：正常运行（不配探针）的
// 109 键里没有它们，但它们同样是 cli 的顶层契约，语义也要写清楚。
const PROBE_ONLY = ['h2fp', 'ja4', 'quicfp', 'tcp_reason', 'tcpfp', 'tlsfp'];

// 探针 GET /fp 的应答：抓包不可用（缺 Npcap），TLS/H2 正常（附录 G 的 (b) 情形）
const FP_RESPONSE = {
  proto: 'h2',
  tcp: { $: 'not_configured' },
  tcp_reason: 'npcap-not-installed',
  tls: { ja4: 't13d1516h2_8daaf6152771_02713d6af862', ja3n: 'ja3n-documentation' },
  http2: { fp: 'm,a,s,p' }
};
// H3 补测的应答：第二次起探针报 h3 → meta.h3.state = "upgraded"，cli.quicfp 拿到 ja4
// （附录 H 的形状）
const H3_RESPONSE = {
  proto: 'h3',
  tls: { ja4: 't13d1516h3_8daaf6152771_02713d6af862' }
};

// ---------------------------------------------------------------------------
// 易变值：这些路径上的值每次跑都不一样，必须换固定占位
// ---------------------------------------------------------------------------
const VOLATILE_NUMBER = [
  /^meta\.dur_ms$/,
  /^meta\.h3\.(elapsed_ms|retries|attempts|answered)$/,
  /^cli\.timer\.(now|res|samples|jitter|minPositiveMs|maxPositiveMs)$/,
  /^cli\.hz$/,
  /^cli\.callstack\.depth$/,
  /^cli\.clock\.(skew_s|skew_h|rtt_ms)$/,
  /^cli\.agent\.input\.windowMs$/,
  /^cli\.gamepad\.windowMs$/,
  /^cli\.adblock\.[A-Za-z]+\.ms$/,
  /^cli\.etag\..*\.ms$/,
  /^cli\.conn\.(rtt|downlink)$/
];
const VOLATILE_STRING = [/^id$/, /^ts$/, /^session$/, /^cli\.rand\.(value|h)$/];

// 易变数值在样本里换成**像读数**的固定值（不是 0）：这些样本要喂进后端做端到端渲染，
// 全 0 会让画像/读数页读到"分辨率 0、刷新率 0"这种不合理组合，掩盖渲染缺陷。
const PLACEHOLDER = [
  [/^meta\.dur_ms$/, 940],
  [/^meta\.h3\.elapsed_ms$/, 2138],
  [/^meta\.h3\.(retries|attempts|answered)$/, 1],
  [/^cli\.timer\.now$/, 1234.5],
  [/^cli\.timer\.res$/, 0.5],
  [/^cli\.timer\.samples$/, 64],
  [/^cli\.timer\.(jitter|maxPositiveMs)$/, 0.5],
  [/^cli\.timer\.minPositiveMs$/, 0.5],
  [/^cli\.hz$/, 60],
  [/^cli\.callstack\.depth$/, 12000],
  [/^cli\.clock\.(skew_s|skew_h)$/, 0],
  [/^cli\.clock\.rtt_ms$/, 12],
  [/^cli\.agent\.input\.windowMs$/, 0],
  [/^cli\.adblock\.[A-Za-z]+\.ms$/, 18],
  [/^cli\.etag\..*\.ms$/, 42],
  [/^cli\.conn\.rtt$/, 50],
  [/^cli\.conn\.downlink$/, 10]
];

function placeholderFor(p) {
  for (let i = 0; i < PLACEHOLDER.length; i++) {
    if (PLACEHOLDER[i][0].test(p)) return PLACEHOLDER[i][1];
  }
  return 0;
}

function isVolatileNumber(p) {
  return VOLATILE_NUMBER.some((re) => re.test(p));
}
function isVolatileString(p) {
  return VOLATILE_STRING.some((re) => re.test(p));
}

// ---------------------------------------------------------------------------
// 宿主泄漏：这些数值不是采集器写死的，而是**运行采集器的那个 JS 引擎 / ICU 数据面**
// 决定的读数。假浏览器沙箱的全局对象就是 vm 的 global，所以：
//   cli.engver.*          ← 宿主 V8 支持哪几条 JS 特性（Node 22 偏少、Node 24 偏多）
//   cli.wasm.supported    ← 宿主 V8 的 WebAssembly 特性面（validate 真去校验字节）
//   cli.icu.<各类计数>     ← 宿主 ICU 数据版本（numberingSystem 22 是 77、24 是 78）
// 真浏览器上这些数字来自浏览器本身，不会因为"构建机装了哪个 Node"变。所以它们
// **不进契约的数值比较**：形状上记 {"type":"number","host":true}（读作 number<host>），
// 只钉"这里是数值"这一层，值交给运行时。
//
// 与之相对，采集器自己写死的数值（屏幕数、请求次数、接口数…）照旧钉区间：
// 那些才是"采集器换了口径"的信号。清单见 VALUE_SENSITIVE_EXAMPLES。
// ---------------------------------------------------------------------------
const HOST_NUMBER = [
  /^cli\.engver\.(floor_chromium|floor_year|ceiling_chromium|ceiling_year|supported)$/,
  /^cli\.wasm\.supported$/,
  /^cli\.icu\.(calendar|collation|currency|numberingSystem|timeZone|unit)$/
];

/** 值敏感键（举例）：这些数字由采集器/沙箱自己写死，仍然逐值比较。 */
const VALUE_SENSITIVE_EXAMPLES = [
  'cli.screens.n',                               // 采集器数 document 里的屏幕结论，写死 1
  'cli.keys.window',                             // 假 window 上可枚举全局的条数（沙箱定义）
  'cli.keys.css',                                // 沙箱 getComputedStyle(div).length
  'cli.keys.items.computed-style-properties.n',
  'cli.wasm.total',                              // WASM_CASES 的长度（常量）
  'cli.wasm.sources.validate',                   // 走 validate 这一路的条目数（常量）
  'cli.engver.total'                             // JS_FEATURES 的长度（常量）
];

function isHostNumber(p) {
  return HOST_NUMBER.some((re) => re.test(p));
}

// 摘要类字符串换成统一占位（保留"这是一枚摘要"这件事，不保留值）
const DIGEST_RE = /^(sha256|fnv):[0-9a-f]{8,}$/;
const DIGEST_PLACEHOLDER = 'sha256:<redacted>';

// ---------------------------------------------------------------------------
// 形状骨架
//
// 记法（比"键集合"多一层，正是复审要的）：
//   {"type":"object","props":{...}}     对象，props 的键**有序**（字典序）
//   {"type":"array","of":<骨架|null>}   数组，of 是元素骨架并集（空数组为 null）
//   {"type":"string","enum":[...]}      字符串，闭词表给出取值集合
//   {"type":"string","format":"..."}    字符串，只保证格式（如 sha256:[0-9a-f]{64}）
//   {"type":"string","volatile":true}   字符串，每次跑都变（不钉取值）
//   {"type":"number","range":[min,max]} 数值，只给区间（样本观测到的上下界）
//   {"type":"number","volatile":true}   数值，每次跑都变（不钉区间）
//   {"type":"number","host":true}       数值，由宿主的 JS 引擎/ICU 决定（只钉类型，见 HOST_NUMBER）
//   {"type":"boolean"} {"type":"null"}
//   {"type":"marker"}                   缺失标记 {"$": "<状态>"}（不是读数，见 markers）
//   {"type":"union","of":[...]}         不同场景下形状不同（按 type 排序）
const DIGEST_FORMAT = 'identity-digest';

const FORMATS = [
  [/^sha256:[0-9a-f]{64}$/, 'sha256:[0-9a-f]{64}'],
  [/^fnv:[0-9a-f]{16}$/, 'fnv:[0-9a-f]{16}'],
  [/^sha256:[0-9a-f]+$/, 'sha256:<hex>'],
  [/^t\d{2}d\d{4}h[23]_[0-9a-f]{12}_[0-9a-f]{12}$/, 'ja4'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid'],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'iso8601'],
  [/^https?:\/\//, 'url'],
  [/^rgba?\(/, 'css-color'],
  [/^[a-z]+\/[a-z0-9.+-]+$/i, 'mime'],
  [/^\d+(\.\d+)*$/, 'version']
];

function formatOf(value) {
  for (let i = 0; i < FORMATS.length; i++) {
    if (FORMATS[i][0].test(value)) return FORMATS[i][1];
  }
  return null;
}

// 闭词表（人工，来自契约附录 G/H/I/J/K，不随抽样环境变）。
// 出现词表外的取值会**当场抛错**——这正是"采集器换了口径"的漂移信号。
const NO_STORE = ['unsupported', 'blocked', 'written', 'readback', 'lost', 'timeout'];
const ENUMS = [
  [/^cli\.perms\.items\.[a-z0-9-]+$/,
    ['granted', 'denied', 'prompt', 'unsupported', 'unsupported-name', 'error']],
  [/^cli\.traces\.items\.[A-Za-z]+\.state$/, NO_STORE],
  [/^cli\.screens\.basis$/, ['isExtended']],
  [/^cli\.worker\.basis$/, ['worker-vs-main']],
  [/^cli\.lies\.ctx$/, ['iframe', 'unsupported']],
  [/^cli\.lies\.why$/,
    ['same-origin-blank', 'no-contentWindow', 'no-frame-realm',
      'no-iframe-element', 'iframe-threw', 'no-document']],
  [/^cli\.form\.kind$/, ['Desktop', 'Mobile', 'Tablet', 'Unknown']],
  [/^cli\.form\.basis$/, ['ua-ch-form-factors', 'ua-mobile', 'touch-heuristic']],
  [/^cli\.shield\.verdict$/, ['likely-privacy-browser', 'canvas-noise', 'clean', 'unknown']],
  [/^cli\.adblock\.verdict$/, ['unknown', 'blocked', 'reachable']],
  [/^cli\.agent\.level$/, ['insufficient-observation', 'trusted-input', 'untrusted-input']],
  [/^cli\.model\.basis$/, ['ua-ch-model+map', 'ua-ch-model-unmapped', 'screen-gpu-candidate']],
  [/^cli\.auto\.level$/, ['none', 'weak', 'strong']],
  // alg 版本号：附录 I/J/K 冻结的"换形状必带 alg"，跌回上一代要能被看见
  [/^cli\.voices\.alg$/, ['voices/2']],
  [/^cli\.wasm\.alg$/, ['wasm/2']],
  [/^cli\.engver\.alg$/, ['feature-floor/2']],
  [/^cli\.lies\.alg$/, ['lies/2']],
  [/^cli\.cssv\.alg$/, ['cssv/2']],
  [/^cli\.domrect\.alg$/, ['domrect/2']],
  [/^cli\.svgrect\.alg$/, ['svgrect/2']],
  [/^cli\.textm\.alg$/, ['textm/2']],
  [/^cli\.glimg\.alg$/, ['glimg/2']],
  [/^cli\.keys\.alg$/, ['keys/2']],
  [/^cli\.audio\.alg$/, ['audio/2']],
  [/^cli\.shield\.alg$/, ['shield/2']],
  [/^cli\.model\.alg$/, ['model/2']],
  [/^cli\.gpulim\.alg$/, ['gpulim/2']],
  [/^cli\.glx\.alg$/, ['glx/2']],
  [/^cli\.bio\.alg$/, ['pk-capabilities/1']],
  [/^cli\.gamepad\.alg$/, ['gamepad/2']],
  [/^cli\.perms\.alg$/, ['permissions-query/2']],
  [/^cli\.apis\.alg$/, ['apis/2']],
  [/^cli\.auto\.alg$/, ['auto/2']],
  [/^cli\.agent\.alg$/, ['agent/2']],
  [/^cli\.adblock\.alg$/, ['adblock/2']],
  [/^cli\.traces\.alg$/, ['storage-tag/2']],
  [/^cli\.mathfp\.alg$/, ['mathfp-2']],
  [/^cli\.icu\.alg$/, ['supported-values-of']],
  [/^cli\.sysui\.alg$/, ['isolated-medium']],
  // ch 的算法标记随环境两态（服务端回显头在不在），两种都算合规
  [/^cli\.ch\.alg$/, ['ch/merged', 'ch/srv-only']],
  // 摘要算法降级到 FNV 必须自报，不许冒充 SHA256
  [/^cli\.fpid_alg$/, ['sha256/tmpl-2', 'fnv/tmpl-2-fallback']],
  [/^cli\.hwid_alg$/, ['sha256/hw-2', 'fnv/hw-2-fallback']]
];

function enumFor(p) {
  for (let i = 0; i < ENUMS.length; i++) {
    if (ENUMS[i][0].test(p)) return ENUMS[i][1];
  }
  return null;
}

function shapeOf(p, v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (Array.isArray(v)) {
    if (!v.length) return { type: 'array', of: null };
    let of = null;
    v.forEach((item) => { of = mergeShape(of, shapeOf(p, item)); });
    return { type: 'array', of: of };
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$' && typeof v.$ === 'string') {
      return { type: 'marker' };
    }
    const props = {};
    keys.sort().forEach((k) => { props[k] = shapeOf(p + '.' + k, v[k]); });
    return { type: 'object', props: props };
  }
  if (typeof v === 'string') {
    if (v === DIGEST_PLACEHOLDER) return { type: 'string', format: DIGEST_FORMAT };
    if (v === '<volatile>') return { type: 'string', volatile: true };
    const allowed = enumFor(p);
    if (allowed) {
      if (allowed.indexOf(v) === -1) {
        throw new Error(
          '闭词表漂移：' + p + ' 的取值 ' + JSON.stringify(v) +
          ' 不在契约词表 [' + allowed.join(', ') + '] 里'
        );
      }
      return { type: 'string', enum: allowed.slice() };
    }
    const fmt = formatOf(v);
    return fmt ? { type: 'string', format: fmt } : { type: 'string' };
  }
  if (typeof v === 'number') {
    if (isVolatileNumber(p)) return { type: 'number', volatile: true };
    // 宿主决定的数值只钉类型（见 HOST_NUMBER）：把 Node 22/24 的读数差异写成
    // 契约漂移，等于让夹具跟构建机的 Node 版本耦合。
    if (isHostNumber(p)) return { type: 'number', host: true };
    return { type: 'number', range: [v, v] };
  }
  if (typeof v === 'boolean') return { type: 'boolean' };
  return { type: typeof v };
}

function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function mergeShape(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if (canon(a) === canon(b)) return a;
  if (a.type === 'object' && b.type === 'object') {
    const props = {};
    const keys = Object.keys(a.props).concat(Object.keys(b.props))
      .filter((k, i, all) => all.indexOf(k) === i).sort();
    keys.forEach((k) => {
      props[k] = mergeShape(
        Object.prototype.hasOwnProperty.call(a.props, k) ? a.props[k] : null,
        Object.prototype.hasOwnProperty.call(b.props, k) ? b.props[k] : null
      );
    });
    return { type: 'object', props: props };
  }
  if (a.type === 'array' && b.type === 'array') {
    return { type: 'array', of: mergeShape(a.of || null, b.of || null) };
  }
  if (a.type === 'number' && b.type === 'number') {
    if (a.host || b.host) return { type: 'number', host: true };
    if (a.volatile || b.volatile) return { type: 'number', volatile: true };
    return {
      type: 'number',
      range: [Math.min(a.range[0], b.range[0]), Math.max(a.range[1], b.range[1])]
    };
  }
  if (a.type === 'string' && b.type === 'string') {
    if (a.volatile || b.volatile) return { type: 'string', volatile: true };
    if (a.format && a.format === b.format) return { type: 'string', format: a.format };
    if (a.enum && b.enum) return { type: 'string', enum: a.enum.slice() };
    return { type: 'string' };
  }
  const parts = [];
  const push = (item) => {
    const list = item.type === 'union' ? item.of : [item];
    list.forEach((one) => {
      if (!parts.some((x) => canon(x) === canon(one))) parts.push(one);
    });
  };
  push(a);
  push(b);
  parts.sort((x, y) => (x.type === y.type ? (canon(x) < canon(y) ? -1 : 1) : (x.type < y.type ? -1 : 1)));
  return { type: 'union', of: parts };
}

// ---------------------------------------------------------------------------
// 规范化：把易变值换成固定占位（形状不变，值不再变）
// ---------------------------------------------------------------------------
function canonicalize(node, p) {
  if (Array.isArray(node)) return node.map((item) => canonicalize(item, p));
  if (node && typeof node === 'object') {
    const out = {};
    Object.keys(node).sort().forEach((k) => {
      out[k] = canonicalize(node[k], p ? p + '.' + k : k);
    });
    return out;
  }
  if (typeof node === 'string') {
    if (DIGEST_RE.test(node)) return DIGEST_PLACEHOLDER;
    if (isVolatileString(p)) return '<volatile>';
    return node;
  }
  if (typeof node === 'number') return isVolatileNumber(p) ? placeholderFor(p) : node;
  if (typeof node === 'boolean') return isVolatileString(p) ? false : node;
  return node;
}

// meta 单独规范化：只保留契约里写明的键，且易变值换成固定值
function canonicalMeta(meta) {
  const out = {
    dur_ms: placeholderFor('meta.dur_ms'),
    stuck: (meta.stuck || []).slice().sort(),
    truncated: [],
    partial: !!meta.partial,
    privacy: {
      dnt: !!(meta.privacy && meta.privacy.dnt),
      gpc: !!(meta.privacy && meta.privacy.gpc),
      optout: !!(meta.privacy && meta.privacy.optout)
    },
    collector: meta.collector,
    ua: meta.ua
  };
  if (meta.timeouts) out.timeouts = canonicalize(meta.timeouts, 'meta.timeouts');
  if (meta.h3) out.h3 = canonicalize(meta.h3, 'meta.h3');
  return out;
}

// ---------------------------------------------------------------------------
// 四个场景：普通 / 离页半份 / 退出收集 / 探针缺驱动（H3 补测成功）
// ---------------------------------------------------------------------------
// 确定性的时钟替身：真浏览器里 timer 的分辨率／正间隔与 hz 的 rAF 时间戳每次都不同，
// 直接跑假环境会让「数字」和「null／标记」在同一份代码上随机互换（形状都定不下来）。
// 这里把 performance.now 换成固定步进、rAF 时间戳换成固定帧长——**只**为了让产物可复现，
// 真机读数当然还是各自的；这两项在 shape 上仍标 volatile。
function deterministicClock(env) {
  let tick = 0;
  let frame = 0;
  env.performance = { now: () => (tick += 0.5), timing: { navigationStart: 0 } };
  env.requestAnimationFrame = (cb) => setTimeout(() => cb(frame += 16), 0);
  return env;
}

function harnessPair(over) {
  const env = deterministicClock(fakeEnv(over));
  env.__radishId = FIXED_ID;
  env.__radishT0 = Date.now() - 940;
  return { env: env, RC: loadCollector(env) };
}

function quietCtx(extra) {
  // 夹具不发网络请求：DNS / 探针 / trackers 保持"没跑到"，这就是短访问的真实形状
  return collectorCtx(Object.assign({
    text: () => Promise.resolve(null),
    json: () => Promise.resolve(null)
  }, extra || {}));
}

function normalizeEnvelope(envelope, name, kind, note) {
  const payload = {
    v: 1,
    id: FIXED_ID,
    ts: FIXED_TS,
    session: FIXED_SESSION,
    page: canonicalize(envelope.page || {}, 'page'),
    cli: canonicalize(envelope.cli || {}, 'cli'),
    meta: canonicalMeta(envelope.meta || {})
  };
  return { name: name, kind: kind, note: note, envelope: payload };
}

async function scenarioNormal() {
  const pair = harnessPair();
  const envelope = await pair.RC.buildEnvelope(undefined, quietCtx());
  return normalizeEnvelope(
    envelope, 'normal', 'normal',
    '普通一次上报：完整 cli（不配探针时 109 键），meta.partial=false'
  );
}

async function scenarioPartial() {
  const pair = harnessPair();
  const complete = await pair.RC.buildEnvelope(undefined, quietCtx());
  // 离页：慢车道那几项还在飞，cli 里**没有它们的键**（不是 {"$":"timeout"}）
  const state = pair.env.__radishSt;
  SLOW_IDS.forEach((id) => {
    if (Object.prototype.hasOwnProperty.call(state.cli, id)) delete state.cli[id];
  });
  pair.env.__radishT0 = Date.now() - 420;
  const half = await pair.RC.buildEnvelope(undefined, quietCtx(), { prebuilt: true });
  const sample = normalizeEnvelope(
    half, 'partial', 'partial',
    '离页半份：慢车道 ' + SLOW_IDS.join('/') + ' 还没有键，meta.partial=true'
  );
  sample.envelope.meta.partial = true;
  // 半份是离页那一刻发出的，耗时读数必然比补全小（固定值，重跑不变）
  sample.envelope.meta.dur_ms = 420;
  return { sample: sample, complete: complete };
}

async function scenarioOptout() {
  const pair = harnessPair({ dnt: '1' });
  const envelope = await pair.RC.buildEnvelope(undefined, quietCtx());
  const sample = normalizeEnvelope(
    envelope, 'optout', 'optout',
    'DNT/GPC 退出收集：整块 cli 为空，meta.privacy.optout=true'
  );
  sample.envelope.meta.privacy = { dnt: true, gpc: false, optout: true };
  return sample;
}

async function scenarioProbe() {
  const pair = harnessPair();
  let fpCalls = 0;
  const ctx = quietCtx({
    probeUrl: PROBE_URL,
    json: (url) => {
      const target = String(url);
      if (!target.endsWith('/fp')) return Promise.resolve(null);
      fpCalls += 1;
      // 首跳是 TCP/H2（tcp 缺驱动）→ 补测回 h3：meta.h3.state = "upgraded"
      return Promise.resolve(fpCalls === 1 ? FP_RESPONSE : H3_RESPONSE);
    }
  });
  const envelope = await pair.RC.buildEnvelope(undefined, ctx);
  const sample = normalizeEnvelope(
    envelope, 'probe', 'probe',
    '探针应答但抓包不可用：tcpfp 是单键标记 + 旁路原因 tcp_reason；TLS/H2 读数保留；' +
    'H3 补测拿到 h3 样本（meta.h3.state="upgraded"，cli.quicfp 有值）'
  );
  return sample;
}

async function collectSamples() {
  const normal = await scenarioNormal();
  const pair = await scenarioPartial();
  const optout = await scenarioOptout();
  const probe = await scenarioProbe();
  return {
    samples: [normal, pair.sample, optout, probe],
    complete: pair.complete
  };
}

// ---------------------------------------------------------------------------
// 缺失标记：从采集器**实际能产生**的集合里取
//   - 源码里 M('…') 的实参（采集器自己造的标记）
//   - 样本里观测到的 {"$": …}（含探针转交的 not_configured、meta 里的 truncated）
// ---------------------------------------------------------------------------
function collectMarkers(sourceText, payloads) {
  const found = {};
  const re = /\bM\('([a-z_]+)'/g;
  let hit = re.exec(sourceText);
  while (hit) {
    found[hit[1]] = true;
    hit = re.exec(sourceText);
  }
  // M(kind, n) 的长度版：{"$":"truncated","n":…}
  if (/\$\s*:\s*'truncated'/.test(sourceText)) found.truncated = true;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    const keys = Object.keys(node);
    if (keys.length >= 1 && typeof node.$ === 'string' && /^[a-z_]+$/.test(node.$)) {
      found[node.$] = true;
    }
    keys.forEach((k) => walk(node[k], depth + 1));
  };
  payloads.forEach((payload) => walk(payload.cli, 0));
  return Object.keys(found).sort();
}

// ---------------------------------------------------------------------------
// 人工语义：字段路径 → 一句话（覆盖全部顶层键 + 附录 G/H/I/J/K 的重要子字段）
//
// 写的是"测的是什么、依据是什么"，不是键名的中文翻译：
// 复审的担心正是"同名但测量不同"，所以每条都要能用来判断"读到的位置对不对"。
// ---------------------------------------------------------------------------
const SEMANTICS = {
  // ---- 采集端 127 项的顶层键（109 个：107 项 + fpid_alg / hwid_alg）----
  a11y: '系统辅助功能偏好：prefers-contrast 与 forced-colors 的实际取值，不是"是否装了读屏软件"',
  adblock: '广告拦截实测：广告 URL、同源对照、诱饵元素三路取证后给出的判定（verdict）与依据',
  agent: '本轮观测窗口内收到的输入事件计数、isTrusted 比例，以及 UA 与 Client Hints 的品牌一致性',
  ai: '浏览器内置 AI 能力（Translator / LanguageModel）的 availability 查询结果（慢车道跨域读）',
  apis: '敏感 Web 接口的存在性清单：只记接口在不在，不调用、不弹权限框、不发请求',
  arch: 'CPU 架构字符串：优先取高熵 sec-ch-ua-arch，读不到才从 UA／平台推断',
  audio: '音频指纹摘要，外加采样率、帧数、声道与延迟的物理量交叉核对结果',
  audiohw: '音频硬件读数：输出设备数、采样率与最大声道数（AudioContext 侧）',
  auto: '自动化痕迹逐条清单（webdriver、驱动全局名、空插件与 PDF 冲突等）与组合弱信号分级',
  battery: '电池状态：电量、是否在充电、充电与放电的剩余时间',
  bio: '生物识别／通行密钥能力：getClientCapabilities 的逐项真值，缺该接口时退回 isUVPAA 单一读数',
  browser: '浏览器名与版本：UA 与高熵品牌交叉判定（安卓 Edge 不许写成 Chrome）',
  bt: '蓝牙接口可用性：navigator.bluetooth 是否存在（只看存在性）',
  callstack: '抛错后记录到的最大调用栈帧数、上限以及是否被截断，用来分辨引擎差异与调试器介入',
  canvas: 'Canvas 2D 同一段绘制的摘要哈希与采样数据长度（渲染栈指纹）',
  ch: 'Client Hints 两个来源并列：浏览器 JS 侧的低熵／高熵值与服务器实际收到的回显头',
  clock: '本地时制与 UTC 偏移，以及和服务端时间的偏差（偏差由 trace 时间反推，不写在标记里）',
  codecs: '视频编码格式支持矩阵：canPlayType 对每种格式给出的结果',
  conn: 'Network Information 读数：有效连接类型、下行带宽估算与 RTT（浏览器近似值）',
  cookies: 'Cookie 是否可用（navigator.cookieEnabled 的布尔值）',
  cpu: '逻辑核心数（navigator.hardwareConcurrency）',
  cssv: 'CSS 特性逐条真值：supports 直问与样式表解析两条路径，并附首用版本与年份',
  display: '打开方式／显示模式（浏览器标签、standalone、全屏等）',
  dns: '经第三方解析回显服务看到的 DNS 解析出口（解析器 IP／ASN），慢车道单独起跑',
  dnt: '隐私信号原始值：DNT 头与 Sec-GPC（或对应的 navigator 属性），原样上报不做解释',
  domrect: '四种 CSS 变换下元素盒子的几何读数，外加 Range 选中文本的盒子与条数',
  drm: 'DRM 支持情况：逐个 key system 探测可用性',
  edge: '离浏览器最近的 Cloudflare 边缘节点代码（来自页面侧 /cdn-cgi/trace）',
  emoji: '能否画出彩色 emoji：用缺字符与 CJK 双重基线判定，不报伪造的版本号',
  engine: 'JS 引擎名（异常措辞实测）与渲染内核（品牌／UA 推断），两者各带依据',
  engver: '引擎真实版本的特性区间：声明版本 + 已支持特性的下限与未支持特性的上限',
  etag: '浏览器 HTTP 缓存的 ETag 令牌，以及首访（first_pass）与本轮回环（round_trip）两类条件请求证据；' +
    '跨访问结论只由服务端按不同会话号给出（慢车道）',
  ex_cf: '对 Cloudflare 回显服务测得的出口 IP 与位置',
  ex_claude: '对 claude.ai 回显服务测得的出口 IP 与位置（用于分流对照）',
  ex_cn: '对国内回显服务测得的出口 IP、位置与运营商',
  ex_gpt: '对 ChatGPT 回显服务测得的出口 IP 与位置（用于分流对照）',
  ex_intl: '对国际 IP 查询服务测得的出口 IP 与位置',
  ext: '只有扩展才会建立的全局量（钱包注入点、Grammarly 等）的命中名单',
  extwar: '扩展 web_accessible_resources 扫描：有限目标表、命中项，以及每个目标的版本与验证日期',
  fmt: '数字与日期格式样例：实测拼出日期、千分位与小数分隔符的样子',
  fontfp: '候选字体命中名单的摘要哈希（名单本身在 fonts 里）',
  fonts: '固定候选字体名单的命中情况（命中数、候选总数、名单与来源），不是"已安装字体清单"',
  form: '设备形态（Desktop／Mobile／Tablet／Unknown）与判定依据（高熵 form factors、UA-mobile、触屏启发）',
  fpid: '环境模板摘要：UA、语言、屏幕、canvas、字体、引擎特性等输入算出的哈希（标量字符串）',
  fpid_alg: 'fpid 的摘要算法与输入清单版本（tmpl-2；算不了 SHA256 时前缀 fnv，绝不冒充）',
  gamepad: '手柄读数：加载时数量、真实输入后重读的数量，以及是否还在等交互',
  gamut: '屏幕色域与动态范围偏好（prefers-color-gamut / prefers-dynamic-range）',
  geoloc: '精确定位读数（getCurrentPosition 结果）；需要访客授权，未参与本轮就记 not_run',
  glimg: 'WebGL 片元着色器按坐标出图案后的像素回读摘要与统计（非恒定图案才留得下痕迹）',
  glx: 'WebGL 能力：各项上限、着色器精度、版本串与扩展全名清单',
  gpu: '显卡厂商与渲染器原始字符串（优先 unmaskedRenderer，不截断成厂商名）',
  gpulim: 'WebGPU 能力：适配器 limits 标量、全量 features，以及两个 powerPreference 的对照',
  heap: 'JS 堆上限档位（performance.memory.jsHeapSizeLimit）',
  history: '本标签页的 history.length，即同一标签页内已发生的导航次数',
  hour: '时制（12／24 小时）与本轮本地小时读数',
  hwdec: '视频硬件解码能力：MediaCapabilities 对每种编码的判定',
  hwid: '硬件面摘要：屏幕、DPR、色深、核心数、内存、触控、GPU、字体命中与堆上限算出的哈希',
  hwid_alg: 'hwid 的摘要算法与输入清单版本（hw-2；算不了 SHA256 时前缀 fnv，绝不冒充）',
  hz: '屏幕刷新率：用 requestAnimationFrame 的间隔实测并取中位（每台机器都不同）',
  icu: 'ICU 数据面规模：supportedValuesOf 各类别（日历、排序、货币、时区等）能列出多少种值',
  idstr: 'navigator 的身份性字符串：vendor、productSub 与插件名单（不含 UA）',
  kbd: '键盘布局：navigator.keyboard.getLayoutMap 的按键映射结果',
  kex: 'TLS 密钥交换组与 SNI 是否明文（来自 trace，不是本地推断）',
  keys: '引擎接口数：可枚举全局、自有属性名、HTMLElement.prototype、CSS 命名空间与计算样式属性数（五种范围各归各）',
  lan: '局域网地址：WebRTC ICE 候选里的私网地址',
  langs: 'navigator.languages 的前若干项，第一项当主语言',
  lies: '本页与同源空 iframe 的跨上下文对照：原生函数字符串、自有 prototype、陌生 this 的 getter 证据',
  locale: 'Intl 解析出的区域设置（resolvedOptions().locale）',
  mathfp: '一组数学函数（三角函数、幂运算等）逐项输出结果的指纹摘要，用来分辨引擎的数值实现',
  media: '摄像头与麦克风的设备枚举结果（需要权限才列得出设备名）',
  mem: '内存档位（navigator.deviceMemory，浏览器给的近似值）',
  model: '设备型号：Android 用代码名查表得市场名，Apple 只给带置信度的候选，不编唯一结论',
  motion: '减少动画偏好（prefers-reduced-motion）',
  os: '操作系统名与版本：UA 与高熵平台版本交叉，缩减 UA 里的 "Android 10" 不当真实版本',
  pdf: '内置 PDF 阅读器是否可用（navigator.pdfViewerEnabled）',
  perms: '21 个权限名逐个 query() 的结果与计数：不合法名字、超时、异常各自分开记',
  proto: '本次连接的应用层协议与 TLS 版本（来自 trace）',
  rand: '同一段 canvas 绘制跑两遍是否一致，外加一枚随机值，用来识别加噪保护',
  recmime: 'MediaRecorder 支持的录制容器与编码格式',
  rtccodecs: 'WebRTC 可用的音视频编解码器（RTCRtpSender.getCapabilities）',
  scheme: '深浅色偏好（prefers-color-scheme）',
  screen: '主屏的 CSS 尺寸、可用区、设备像素比与色深',
  screens: '显示器数量结论：只有 isExtended 是布尔值时才给 n／ext，否则整项记缺失标记（不下"单屏"结论）',
  scrollbar: '滚动条宽度（离屏 div 的 offsetWidth 与 clientWidth 之差）',
  sensors: '运动与方向传感器读数；需要访客授权，未参与本轮就记 not_run',
  shield: '反指纹保护的四维弱证据（canvas 稳定性、数学稳定性、原生字符串完整性、隐私浏览器特征）与判定',
  smooth: '字体平滑方式：canvas 灰度／彩色像素比推断是否做次像素抗锯齿',
  stack: 'IPv4 / IPv6 双栈可达性：分别打 v4-only 与 v6-only 目标',
  storage: '存储配额（navigator.storage.estimate 的 quota／usage）',
  svgrect: 'SVG 文字的 getBBox 与 getComputedTextLength 等排版读数',
  sysui: '系统字号与强调色等界面读数（隔离容器里读计算样式）',
  textm: '3 个字体族 × 3 个字符串的 measureText 宽度与包围盒，附族间平均宽之差',
  timer: '计时精度：分辨率、当前时刻、样本数，以及连续读数的最小／最大正间隔与抖动',
  touch: '触控与指针能力：触点数、pointer／hover 媒体查询结果与 PointerEvent 存在性',
  traces: '存储留痕：六种存储各写一次并立刻读回核验，附跨访问留下的 kept／lost／blocked',
  trackers: '追踪拦截实测：第三方请求被拦的对照结果（慢车道）',
  tz: 'Intl.DateTimeFormat 解析出的系统时区名（不是 IP 归属地时区，后者在 tzip）',
  v6mac: 'IPv6 泄露的网卡 MAC：ICE 候选里的链路本地硬件地址',
  voices: '朗读语音：真实总数、这一份实际带出的条数与名单，以及是否被裁剪',
  warp: 'Cloudflare WARP 状态与网关（来自 trace）',
  wasm: '17 项 WebAssembly 特性的逐项真值、每一项的判法来源，以及 control 基线',
  webdriver: 'navigator.webdriver 是否为真：自动化提示，只作线索不改评分',
  webgl: 'WebGL 厂商与渲染器字符串，以及支持的扩展数量',
  webgpu: 'WebGPU 适配器描述与偏好（arch／architecture 等来自 adapter info）',
  webrtc: 'WebRTC ICE 候选汇总（本地与公网候选地址）',
  week: '日历周设置：一周起始日、周末是星期几与最少天数',
  win: '窗口内外尺寸，以及窗口在屏幕上的位置（screenX／screenY、可用区左上角）',
  worker: '在 Worker 里复算 navigator 的五项读数，并逐项与主线程比对是否一致',
  xr: 'VR／AR 能力：navigator.xr.isSessionSupported 的结果',

  // ---- 只有探针应答时才出现的顶层键（附录 G / H）----
  tcpfp: '探针抓到的 TCP/IP 指纹；抓不了包时是单键缺失标记，原因在 tcp_reason（不进标记里）',
  tlsfp: '探针抓到的 TLS 指纹（ja3n，老探针给 ja3）',
  ja4: '探针抓到的 JA4 TLS 指纹（由服务端直连连接算出）',
  h2fp: '探针抓到的 HTTP/2 帧序列指纹',
  quicfp: 'H3 补测样本的 JA4；缺这个键时**必须**看 meta.h3.state 才知道是没升级还是没测到',
  tcp_reason: '抓包失败的原因码（旁路元数据）：只在 tcpfp 是缺失标记时出现，不参与 127 项计数',

  // ---- 附录 I：1.9.6 的读数口径变化 ----
  'etag.url': '被缓存的那个请求 URL（固定为 ETAG_URL，不含任何查询串）：读的人可直接核对缓存键里没有访问号',
  'etag.first_pass': '第一次请求就带回了此前签发的令牌（服务端在首响头里认出来的），这才是跨访问复访证据',
  'etag.round_trip': '同一轮里第二次请求被认作条件请求：只说明本轮缓存能带令牌，不等于上次访问留下过缓存',
  'etag.id_sent': '这一轮有没有把访问号交给服务端；访问号只做记录关联（把同一次访问的多封信封串起来）',
  'etag.sid_sent': '这一轮有没有把会话号交给服务端；会话号是跨访问判定的输入，没交时服务端只能说不知道',
  'etag.report.cross_visit': '服务端按"两次不同会话（sid）用过同一个令牌"给的跨访问结论；' +
    'false／null 都不许说成"缓存认出了这台浏览器"',
  'etag.report.cross_visit_evidence': '上面那个结论的证据级别：distinct-session／single-session／' +
    'no-session-id（老采集器没交会话号，宁可说不知道）',
  'etag.report.visit_ids': '用过这个令牌的访问号个数：含同一次页面访问的半份 + 完整两封信封，' +
    '只做记录关联，不构成跨访问证据',
  'worker.ok': 'Worker 是否真的跑起来并回了消息（false 时其余读数没有意义）',
  'worker.uaSame': '主线程与 Worker 里的 navigator.userAgent 是否同一串（null = 有一边没读到，不许当一致）',
  'worker.langsSame': '主线程与 Worker 里的 navigator.languages 是否一致（三态：true／false／null）',
  'worker.platformSame': '主线程与 Worker 里的 navigator.platform 是否一致（三态）',
  'worker.tzSame': '主线程与 Worker 里 Intl 解析出的时区是否一致（三态）',
  'worker.main': '主线程侧的原始读数（languages／platform／timeZone），供逐项对照',
  'worker.worker': 'Worker 侧的原始读数，与主线程那一份并列保留',
  'worker.basis': '这一份一致性的比对口径标记（当前固定 worker-vs-main）',
  'screens.n': '显示器数量；只有 isExtended 为 true 时允许为 null（知道不止一块但数不出来）',
  'screens.ext': '是否不止一块显示器（isExtended 的布尔值直接转写）',
  'screens.basis': '这一份屏幕数量结论的依据（isExtended 表示来自该属性，不是猜的）',
  'win.sx': '窗口左上角的 screenX；只有有限数值才写，读不到就没有这个键',
  'win.sy': '窗口左上角的 screenY；只有有限数值才写',
  'win.al': '屏幕可用区左上角的 availLeft（部分浏览器才给）',
  'win.at': '屏幕可用区左上角的 availTop（部分浏览器才给）',
  'extwar.targets': '扫描目标有限表：每项给扩展名、id、资源路径、版本与验证日期（没验证过的写 null）',
  'extwar.matched': 'HTTP 2xx 才算命中；status 0 与 opaque 不算命中',
  'extwar.hits': '命中的扩展名数组（未命中 ≠ 未安装，文案不许由它推出结论）',
  'timer.minPositiveMs': '连续两次读数里最小的正间隔（没有正间隔时为 null，不写假的 0）',
  'timer.maxPositiveMs': '连续两次读数里最大的正间隔（有分辨率下限的设备上通常等于分辨率）',
  'timer.jitter': '兼容字段，数值等于 maxPositiveMs（旧注释说最大值、旧代码取最小值的那处已改）',

  // ---- 附录 J：1.9.6 第一批补测 ----
  'voices.total': 'getVoices() 的真实条数，裁剪不改它',
  'voices.shown': '这一份信封实际带出去的条数，等于 list.length',
  'voices.cut': '只有在 shown < total 时才为 true（余量充足时一条都不裁）',
  'voices.list': '带出去的语音条目：name／lang／localService／default',
  'voices.source': '名单来源（speechSynthesis.getVoices 或老形状被包装时的 array）',
  'form.formFactors': '高熵 Sec-CH-UA-Form-Factors 的原始数组（降级到 UA 判定时为空）',
  'model.raw': '高熵 model 的原始代码名（表里没有也照留，不猜市场名）',
  'model.decoded': '查表得到的市场名；表外或 Apple 候选情形为 null',
  'model.candidates': 'Apple 的候选机型：name／confidence（排序分，封顶 0.8）／basis',
  'model.entrySource': '命中项在有限表里的来源（aosp-pixel、aosp-nexus、samsung-model-code）',
  'gpulim.limits': '适配器 limits 里的标量字段（数值／布尔），键序按字典序',
  'gpulim.adapter': '两个 powerPreference 各请求一次的适配器读数（与 webgpu 那一项共享同一次 requestAdapter）',
  'gpulim.features': '适配器支持的全部 feature 名称',
  'gpulim.webglFallback': 'WebGL 侧的兜底读数，单独一块，禁止与 WebGPU limits 合并',
  'glx.shaderPrecision': 'getShaderPrecisionFormat 的顶点／片元高精度读数；读不出为 null，不写 0',
  'glx.extNames': '扩展全名清单（ext 仍是数量，供老消费者）',
  'bio.capabilities': 'getClientCapabilities 逐项真值：只写浏览器真的给了的键，不补齐、不默认 false',
  'gamepad.atLoad': '加载时读到的个数（Firefox 在手势前可能恒为 0）',
  'gamepad.afterInput': '真实输入（pointerdown／keydown／touchstart）之后重读的个数；没等到输入为 null',
  'gamepad.needsInteraction': 'true 表示这一轮没等到输入，不等于没有手柄',
  'gamepad.windowMs': '观测窗口长度；hasBeenActive 为真时是 0（不等待）',
  'perms.items': '21 个权限名逐个 query() 的结果（granted／denied／prompt／unsupported／unsupported-name／error）',
  'perms.counts': '上面结果的计数汇总，total 是名单长度',
  'apis.pressure': 'ComputePressure 接口是否存在（只看存在性，不调用）',
  'apis.localFonts': 'queryLocalFonts 是否存在（真正的本地字体清单需要访客授权，这里不调用）',
  'apis.screenDetails': 'getScreenDetails 是否存在（详细多屏枚举要授权）',
  'apis.aiBasis': '内置 AI 相关字段的判法（presence-only 表示只看接口存在）',
  'apis.digitalCredentialsBasis': 'DigitalCredential 的判法标记',
  'auto.signals': '命中的自动化痕迹名字清单（空插件列表本身不算证据）',
  'auto.combos': '同时成立的组合弱信号（如 webdriver+empty-plugins）',
  'auto.level': '分级：none（无信号）／weak（只有单条弱信号）／strong（webdriver 或驱动全局名等强痕迹）',
  'agent.input': '本轮观测窗口内的输入事件计数、isTrusted 统计与真实窗口长度',
  'agent.uaCh': 'UA 与高熵品牌是否自相矛盾这一维度（挪进来的既有读数，字段不变）',
  'agent.level': '判定：insufficient-observation（没观测到输入，不判自动化）／trusted-input／untrusted-input',
  'agent.waitMs': '这一项愿意等多久（不是实际等到的窗口长度）',
  'adblock.bait': '诱饵元素是否被隐藏（只看 cosmetic 过滤那一路）',
  'adblock.adUrl': '广告 URL 的 no-cors 请求结果与耗时（opaque 证明不了状态码）',
  'adblock.control': '同源对照 URL 的结果：对照取不到时整项 verdict 只能是 unknown',
  'adblock.basis': '这一份判定依据（如 ad-url-unreachable、control-<state>）',
  'traces.items': '六种存储各自的写入与读回结果（state 六态见 markers／附录 J.13）',
  'traces.kept': '跨访问语义：上一轮留下的标记这一轮还读得到才算 kept',
  'traces.lost': '写进去却没读回来、或读回值对不上的存储名清单',
  'traces.blocked': '写入当场抛错的存储名清单（写失败直接记 blocked，不等下一次访问推断）',
  'traces.first': 'true 表示本轮没有任何旧标记（第一次来）',

  // ---- 附录 K：1.9.6 第二批补测（fp 组）----
  'wasm.items': '17 项特性逐项的 {ok, source}；source 写明靠 validate 还是只看 API 存在性',
  'wasm.has': '引擎接受的特性清单（与 missing 并起来恰好是全部 17 项，unreadable 的项不在其中）',
  'wasm.missing': '引擎 validate 拒绝的特性清单（与 has 互补）',
  'wasm.unreadable': 'validate 当场抛错的特性（此时 ok 为 false，且不进 has／missing）',
  'wasm.sources': '两种判法各判了几项，用来核对清单没被悄悄换掉',
  'wasm.control': '空模块能否通过 validate：为 valid 才说明 validate 这条路本身可信',
  'engver.declared': 'UA／高熵品牌自报的版本（能被改写），与特性区间分属两层，不许互相顶替',
  'engver.floor_chromium': '已支持特性里最高的最低版本，即"至少这么新"',
  'engver.ceiling_chromium': '未支持特性里最低的版本减一，即"至多这么新"；全支持时为 null',
  'engver.floor_year': '下限版本（floor_chromium）那一档对应的发布年份',
  'engver.ceiling_year': '上限版本档对应的年份（落在两档之间时取不高于它的最近一档）',
  'engver.items': '11 条特性逐项的 {ok, min, year}',
  'lies.items': '本页与 iframe 两侧的 native code 判定、是否同一串、是否有自有 prototype',
  'lies.getters': '把 Object.create(原型) 当 this 调 getter 的结果（原生访问器拒绝陌生 this）',
  'lies.readings': '本页 vs iframe 的 8 项读数对照；拿不到同源窗口时为空',
  'lies.list': '可疑项清单（老消费者按数组读它，键名与语义不变）',
  'cssv.items': '14 条特性逐项的 supported（三态）与首用版本／年份',
  'cssv.newest': '只由已支持特性算出的最新特性名，不是清单里的最大值',
  'domrect.items': '四种变换（rotate／scale／skew／matrix3d）各一组的盒子与 rects 条数',
  'domrect.ranges': 'Range 选中中文与 emoji 文本后的盒子与条数；没有 createRange 时为缺失标记',
  'svgrect.box': 'SVG 文字 getBBox 的盒子读数（x／y／宽／高）',
  'svgrect.textLength': 'getComputedTextLength 的排版宽度（与 canvas 的 measureText 不是一回事）',
  'textm.fonts': '各族平均宽度与样本数（单个绝对值跨机器不可比）',
  'textm.diff': '第一个族与最后一个族的平均宽之差（族间差分才分得开系统）',
  'glimg.side': '实际采样边长（上限不足时退到 32／16，如实记下）',
  'glimg.nonzero': '非零字节数（非恒定图案应接近满值）',
  'keys.items': '五项计数的范围说明：可枚举全局、自有属性名、HTMLElement.prototype、CSS 接口数、计算样式属性数',
  'keys.window': '可枚举全局计数（含站点脚本自己加的键），与自有属性名不可互换',
  'keys.html': 'HTMLElement.prototype 的可枚举子集（旧字段，语义未变）',
  'keys.css': 'getComputedStyle(div).length，即计算样式属性条数（不是 CSS 接口数）',
  'audio.checks': '物理量交叉核对逐项结果：{name, expected, actual, ok}',
  'audio.mismatches': '不一致项的名字清单；不一致只是弱证据，不等于伪装',
  'shield.verdict': '四态判定：likely-privacy-browser／canvas-noise／clean／unknown',
  'shield.basis': '判定依据；canvas_unmeasured 表示没画成，绝不当成"没有噪声"',
  'shield.canvasStable': '同一段绘制跑两遍是否一致（与 rand.same 说的是同一件事）',
  'shield.nativeToStringIntact': '原生函数字符串是否还完整（被改过就轮不到 clean）',

  // ---- 其它常用复合子字段 ----
  'ch.jsLow': '浏览器 JS 侧读到的低熵 Client Hints（brands／mobile／platform）',
  'ch.jsHigh': '浏览器 JS 侧读到的高熵 Client Hints（model、platformVersion、formFactors 等）',
  'ch.srv': '服务器实际收到的 sec-ch-ua* 回显头',
  'stack.v4': 'IPv4-only 目标的可达性读数',
  'stack.v6': 'IPv6-only 目标的可达性读数',
  'stack.dual': '两侧都可达时的双栈结论（读不全时为 null，不当成单栈）',
  'clock.offset_min': '本地时区相对 UTC 的偏移分钟数',
  'clock.off': '本地时制与偏移的合并读数（小时口径）',
  'dnt.dnt': 'DNT 头的原值（没有这个头就是 null，不是 false）',
  'dnt.gpc': 'Sec-GPC 是否开启（布尔）',
  'screen.w': '主屏 CSS 宽度像素（screen.width，不是窗口宽度）',
  'screen.dpr': '主屏设备像素比（CSS 像素到物理像素的倍率）',
  'meta.h3.state': 'H3 补测的结论态：h3-first／upgraded／tcp-only／udp-blocked／timeout／proto-unknown',
  'meta.h3.first_proto': '首跳 /fp 报的协议（补测不覆盖它）',
  'meta.h3.ja4': '拿到 H3 样本时它的 JA4（与 cli.quicfp 同值）',
  'meta.h3.budget_exhausted': '补测途中预算用完（说明没跑满上限，"没升级"这个结论不成立）',
  'meta.h3.note': '给人看的中文短句：只解释这一项发生了什么，不做结论外推'
};

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------
function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalJson(value) {
  return canon(value);
}

function digestOf(parts) {
  return sha256(canonicalJson({
    cli_keys: parts.cli_keys,
    shapes: parts.shapes,
    markers: parts.markers,
    semantics: parts.semantics
  }));
}

async function buildContract(opts) {
  opts = opts || {};
  const sourceText = fs.readFileSync(COLLECTOR_SRC, 'utf8');
  const collected = await collectSamples();
  const samples = collected.samples;
  const byName = {};
  samples.forEach((sample) => { byName[sample.name] = sample; });

  const normalCli = byName.normal.envelope.cli;
  const cliKeys = Object.keys(normalCli).sort();
  const probeKeys = Object.keys(byName.probe.envelope.cli)
    .filter((key) => cliKeys.indexOf(key) === -1).sort();
  if (canon(probeKeys) !== canon(PROBE_ONLY)) {
    throw new Error(
      '探针专属键漂移：期望 ' + PROBE_ONLY.join(',') + '，实际 ' + probeKeys.join(',') +
      '\n（若采集器确实改了这组键，请同步本文件的 PROBE_ONLY 与语义表）'
    );
  }

  const shapeKeys = cliKeys.concat(probeKeys);
  const shapes = {};
  shapeKeys.forEach((key) => { shapes[key] = null; });
  samples.forEach((sample) => {
    const cli = sample.envelope.cli;
    Object.keys(cli).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(shapes, key)) return;
      shapes[key] = mergeShape(shapes[key], shapeOf('cli.' + key, cli[key]));
    });
  });
  // 某键在所有样本里都没出现（例如只存在于别的场景）时留 null，别假装有形状
  Object.keys(shapes).forEach((key) => {
    if (shapes[key] === null) throw new Error('键 ' + key + ' 在所有场景里都没出现，形状无从谈起');
  });

  const markers = collectMarkers(sourceText, samples.map((s) => s.envelope));
  const collector = byName.normal.envelope.meta.collector;

  // 形状里真正被标成 number<host> 的路径：从产物里走出来，随形状一起自证
  const hostPaths = [];
  function walkHost(node, p) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'number' && node.host) { hostPaths.push(p); return; }
    if (node.type === 'object') {
      Object.keys(node.props || {}).forEach((k) => walkHost(node.props[k], p + '.' + k));
      return;
    }
    if (node.type === 'array') walkHost(node.of, p + '[]');
    if (node.type === 'union') (node.of || []).forEach((one) => walkHost(one, p));
  }
  Object.keys(shapes).sort().forEach((key) => walkHost(shapes[key], 'cli.' + key));
  hostPaths.sort();

  const semanticsKeys = Object.keys(SEMANTICS);
  // 顶层语义必须与 cli 顶层键**恰好**对齐（不多不少）：漏写等于没写，多写等于说谎
  const wantedTop = cliKeys.concat(probeKeys).sort();
  const semanticTop = semanticsKeys.filter((k) => k.indexOf('.') === -1).sort();
  if (canon(wantedTop) !== canon(semanticTop)) {
    const missing = wantedTop.filter((k) => semanticTop.indexOf(k) === -1);
    const extra = semanticTop.filter((k) => wantedTop.indexOf(k) === -1);
    throw new Error(
      '语义表与 cli 顶层键不对齐：缺 ' + (missing.join(',') || '无') +
      ' / 多 ' + (extra.join(',') || '无')
    );
  }

  const parts = {
    cli_keys: cliKeys,
    shapes: shapes,
    markers: markers,
    semantics: SEMANTICS
  };
  const digest = digestOf(parts);

  const doc = {
    $doc: '博客采集器 → 后端的 cli 契约夹具（A-09）。由 tests/make-contract.js 生成，' +
      '不要手改：改了要重跑生成器，摘要会跟着变。',
    alg: ALG,
    collector: collector,
    generated_by: GENERATED_BY,
    source: 'static/radish-collect.js',
    regenerate: 'node tests\\make-contract.js（在博客仓库根目录；不需要 RadishCloud 在旁边）',
    deterministic:
      '同一份采集器代码重跑两次必须字节相同：id/session/ts、meta.dur_ms、' +
      'cli.timer.now、cli.hz、cli.callstack.depth、各类摘要哈希、meta.h3.elapsed_ms 等' +
      '易变值都换成了固定占位（见 volatile_paths），所以文件里没有生成时间。',
    shape_note:
      '数值只保留区间、字符串只保留枚举或格式；标记型的 {"$": 状态} 单独记成 marker；' +
      '同一键在不同场景下形状不同就合成 union。volatile 的数值/字符串不钉取值——' +
      '钉住一个每次都会变的数等于伪造确定性。number<host>（{"type":"number","host":true}）' +
      '是不钉值的另一类：值由运行采集器的 JS 引擎/ICU 决定，见 host_numbers。',
    host_numbers: {
      why:
        '假浏览器沙箱的全局对象就是 vm 的 global，所以引擎能力面（engver）、WebAssembly ' +
        '特性面（wasm.supported）与 ICU 数据规模（icu 各类计数）量到的是**宿主 Node 的 ' +
        'V8 / ICU**：Node 22 与 Node 24 天然不同（例如 engver.supported 5 vs 9、' +
        'wasm.supported 15 vs 16、icu.numberingSystem 77 vs 78）。真浏览器上这些数字来自' +
        '浏览器本身。把宿主读数写进契约 = 夹具与构建机的 Node 版本耦合，所以这些路径只钉' +
        '类型（number<host>），不钉取值；换 Node 时形状必须照样逐键相同。',
      patterns: HOST_NUMBER.map((re) => re.source),
      paths: hostPaths,
      not_host:
        '其余数值仍然逐值比较（区间必须一致）：它们由采集器或沙箱自己写死，' +
        '变了就是"采集器换了口径"。例如 ' + VALUE_SENSITIVE_EXAMPLES.join('、') + '。'
    },
    value_sensitive_keys: VALUE_SENSITIVE_EXAMPLES,
    samples_note:
      '样本是**某一次真实运行的读数快照**（生成这台的 Node 上跑出来的），用来喂后端的' +
      '整条渲染链，不参与 digest，也不与"当前采集器重算的样本"比对。所以样本里 ' +
      'host_numbers.paths 那些读数（以及 engver/wasm 的逐项 ok 布尔）会随生成机的引擎变；' +
      '契约部分（cli_keys / shapes / markers / semantics / digest）不随 Node 版本变。',
    volatile_paths: {
      number: VOLATILE_NUMBER.map((re) => re.source),
      string: VOLATILE_STRING.map((re) => re.source)
    },
    cli_key_count: cliKeys.length,
    cli_keys: cliKeys,
    cli_keys_probe_only: probeKeys,
    shapes: shapes,
    markers: markers,
    markers_note:
      '这些是采集器实际会写进 {"$": …} 的缺失标记。后端 normalize.MISSING_MARKERS 是' +
      '更宽的集合（多一个 denied：那是权限查询的结果值，不是标记），读写两侧都只把' +
      '标记当"缺失"，绝不当取值。',
    semantics: SEMANTICS,
    samples: samples,
    digest_scope:
      'sha256 of canonical JSON（对象键排序、无空格）of {cli_keys, shapes, markers, semantics}',
    digest: digest
  };

  if (opts.write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const body = JSON.stringify(doc, null, 2) + '\n';
    fs.writeFileSync(OUT, body, 'utf8');
  }
  return doc;
}

async function main() {
  const doc = await buildContract({ write: true });
  const stat = fs.statSync(OUT);
  console.log('产物：' + OUT);
  console.log(
    '采集器 ' + doc.collector + '，cli ' + doc.cli_key_count + ' 键（另加探针专属 ' +
    doc.cli_keys_probe_only.length + ' 键）'
  );
  console.log(
    '样本 ' + doc.samples.length + ' 份：' + doc.samples.map((s) => s.name).join(', ') +
    '；标记 ' + doc.markers.length + ' 种：' + doc.markers.join(', ')
  );
  console.log('语义条目 ' + Object.keys(doc.semantics).length + '，摘要 ' + doc.digest);
  console.log('大小 ' + stat.size + ' 字节');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('生成失败：', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  buildContract,
  digestOf,
  canonicalJson,
  sha256,
  HOST_NUMBER,
  VALUE_SENSITIVE_EXAMPLES,
  OUT,
  OUT_NAME,
  ALG,
  SEMANTICS,
  PROBE_ONLY,
  SLOW_IDS
};
