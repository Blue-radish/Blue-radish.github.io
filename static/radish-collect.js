/*!
 * radish-collect — 博客访客信息采集（版本号只有一处：下面的 VERSION 常量，文件头不再写死）
 * 说明见仓库 tests/ 目录；实现细节都在本文件里，不依赖任何外部文档。
 * 不读 Cookie / 不写 localStorage / 不上报异常；每标签页会话最多成功上报一次。
 * 启动时机：文档已经 complete/interactive 就立刻跑，否则等 DOMContentLoaded；
 * 不再"等 load"或"固定空等 1.2s"（只有 waitIdle 那一层最长等 1.5s）。
 * 并发：16 路快速车道跑小探针；dns / ai / trackers / etag / quicfp 走慢车道，各自另有额度。
 */
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__radish) return;

  var VERSION = 'radish-2.0.0';
  // 上报地址内置默认值；换机或本地调试时改 script 标签上的 data-base，
  // 例如 <script src='/radish-collect.js' data-base='http://127.0.0.1:11451'>
  // 页面里不再需要写任何全局变量。
  var CLOUD = {};
  try {
    var _cs = (typeof document !== 'undefined' && document.currentScript) || null;
    var _ds = (_cs && _cs.dataset) || {};
    if (_ds.base) CLOUD.base = _ds.base;
    if (_ds.endpoint) CLOUD.endpoint = _ds.endpoint;
    if (_ds.dnsMs) CLOUD.dnsMs = _ds.dnsMs;
    if (_ds.stun) CLOUD.stun = _ds.stun.split(',');
  } catch (e) { }
  var CLOUD_BASE = String((CLOUD && CLOUD.base) || 'https://radishcloud.20050416.shop').replace(/\/+$/, '').replace(/\s+$/, '');
  var ENDPOINT = (CLOUD && CLOUD.endpoint) || (CLOUD_BASE + '/v1/collect');
  var TRACE_URL = (CLOUD && CLOUD.trace) || (CLOUD_BASE + '/cdn-cgi/trace');
  var HINTS_URL = (CLOUD && CLOUD.hints) || (CLOUD_BASE + '/v1/hints');
var ETAG_URL = (CLOUD && CLOUD.etag) || (CLOUD_BASE + '/v1/etag');
  // ETag 探针一轮要发三次请求（拿令牌 → 触发校验 → 问 report），每次各有期限，
  // 三次加起来必须小于 PROBE_TIMEOUT，否则这项自己先被整轮掐掉。
  // 每一次 etag 请求自己的期限。800ms 太短：审查用 900ms 才返回的正常响应复现出
  // 808ms 就判 unreachable（N-05）。这里按实测的链路 RTT 留余量，并且 etag 归到
  // 慢车道（SLOW_IDS），两三次串行请求才不会被 2.5s 的快速车道期限腰斩。
  var ETAG_TIMEOUT = 1400;
var FP_URL = (CLOUD && CLOUD.fp) || (CLOUD_BASE + '/v1/fp');
  // 生产保持空字符串：不配置外部探针服务时，下面 5 个探针项根本不发请求
  var PROBE_URL = '';
  var BUDGET = 48 * 1024;
  var PROBE_TIMEOUT = 2500;
  // 本脚本自己的 URL：adblock 的"同源对照"要一个**一定取得到**的同源静态资源，
  // 最稳的就是已经加载完的这个脚本本身。currentScript 只在脚本执行期间有值，
  // 所以在这里（IIFE 顶层，同步）抓一次存档，探针跑的时候再用。
  var SELF_SRC = '';
  try {
    SELF_SRC = String((typeof document !== 'undefined' && document.currentScript &&
      document.currentScript.src) || '');
  } catch (e) { SELF_SRC = ''; }

// WebAssembly 特性探针（wasm/2）：每个特性一个最小模块，交给引擎校验。
// 模块字节来自 wasm-feature-detect 1.10.0 的夹具（Apache-2.0，GoogleChromeLabs），
// 与参考实现（who-are-you 的 src/wasm.mjs）用的是同一套字节，不在本地重新手写——
// 手写字节只要有一个字节不对，这项就会永远读成"不支持"，那是假读数。
// 每行是 [特性名, 来源, 字节]：
//   validate       = 引擎接受这串字节，即该特性可用；拒绝即不可用
//   api-existence  = 没有模块可校验的特性（JSPI），只看 API 对象在不在
// 判定顺序与语义写在附录 K.1：先跑 control（空模块）证明 validate 这条路本身通，
// control 不过就整项记 unreadable，绝不把"读不到"说成"没有这些特性"。
var WASM_CASES = [
  ['simd', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]],
  ['threads', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]],
  ['exceptions', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]],
  ['tail-call', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]],
  ['reference-types', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 7, 1, 5, 0, 208, 112, 26, 11]],
  ['bulk-memory', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11]],
  ['multi-value', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 0, 2, 127, 127, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 65, 0, 11]],
  ['mutable-globals', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 97, 1, 98, 3, 127, 1, 6, 6, 1, 127, 1, 65, 0, 11, 7, 5, 1, 1, 97, 3, 1]],
  ['sign-ext', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 192, 26, 11]],
  ['sat-float-int', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 12, 1, 10, 0, 67, 0, 0, 0, 0, 252, 0, 26, 11]],
  ['extended-const', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 11, 9, 1, 0, 65, 1, 65, 2, 106, 11, 0]],
  ['relaxed-simd', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]],
  ['gc', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0]],
  ['memory64', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]],
  ['multi-memory', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 2, 0, 0, 0, 0]],
  ['wide-arithmetic', 'validate', [0, 97, 115, 109, 1, 0, 0, 0, 1, 10, 1, 96, 4, 126, 126, 126, 126, 2, 126, 126, 3, 2, 1, 0, 10, 14, 1, 12, 0, 32, 0, 32, 1, 32, 2, 32, 3, 252, 19, 11]],
  // JSPI 没有自己的模块：只看 API 对象在不在（参考实现同样做法）
  ['jspi', 'api-existence', null]
];
// control：一个空模块。它必须校验通过，否则说明 validate 这条路本身不可信
// （被拦、被桩掉、字节构造失败），那时整项记 unreadable，而不是 17 个 false。
var WASM_CONTROL = [0, 97, 115, 109, 1, 0, 0, 0];

// JS 特性 → [最低 Chromium 主版本, 首次可用年份]。11 条与参考清单一致
// （who-are-you src/infer.mjs 的 FEATURES），版本号是各家发布说明里的首个支持版本，
// Chrome 的发布节奏：97=2022-01、98=2022-02、117=2023-09、119=2023-10、121=2024-01、
// 122=2024-02、128=2024-08、129=2024-09、134=2025-03、135=2025-04、136=2025-05。
// 下限（floor）= 已支持特性里最高的那个版本；上限（ceiling）= 未支持特性里最低的版本减一。
var JS_FEATURES = [
  ['findLast', 97, 2022, function (env) { return typeof [].findLast === 'function'; }],
  ['structuredClone', 98, 2022, function (env) { return typeof env.structuredClone === 'function'; }],
  ['groupBy', 117, 2023, function (env) { return typeof Object.groupBy === 'function'; }],
  ['withResolvers', 119, 2023, function (env) { return typeof env.Promise === 'function' && typeof env.Promise.withResolvers === 'function'; }],
  ['fromAsync', 121, 2024, function (env) { return typeof env.Array === 'function' && typeof env.Array.fromAsync === 'function'; }],
  ['set-union', 122, 2024, function (env) { return typeof env.Set === 'function' && typeof env.Set.prototype.union === 'function'; }],
  ['promise-try', 128, 2024, function (env) { return typeof env.Promise === 'function' && typeof env.Promise['try'] === 'function'; }],
  ['duration-format', 129, 2024, function (env) { return typeof env.Intl === 'object' && typeof env.Intl.DurationFormat === 'function'; }],
  ['error-iserror', 134, 2025, function (env) { return typeof env.Error === 'function' && typeof env.Error.isError === 'function'; }],
  ['float16array', 135, 2025, function (env) { return typeof env.Float16Array === 'function'; }],
  ['regexp-escape', 136, 2025, function (env) { return typeof env.RegExp === 'function' && typeof env.RegExp.escape === 'function'; }]
];

// CSS 特性 → [Chromium 首版, 年份, 测法, 探针参数]。
// 年份是 Chromium 的发布日期档：57=2017-03、76=2019-07、88=2021-01、99=2022-03、
// 105=2022-09、111=2023-03、112=2023-04、114=2023-05、115=2023-07、117=2023-09、
// 125=2024-05（依据：Chrome 平台状态 / MDN 基线，2024-11 核对）。
// 测法两路：supports = CSS.supports 直接问；parse = 塞一条规则进样式表再数 cssRules，
// 因为 @layer 与嵌套选择器 CSS.supports 问不出来（那是 at-rule 与选择器语法，不是声明）。
var CSSV_FEATURES = [
  ['grid', 57, 2017, 'supports', 'display:grid'],
  ['backdrop-filter', 76, 2019, 'supports', 'backdrop-filter:blur(2px)'],
  ['aspect-ratio', 88, 2021, 'supports', 'aspect-ratio:1/1'],
  ['layer', 99, 2022, 'parse', '@layer csa{color:red}'],
  ['has', 105, 2022, 'supports', 'selector(:has(*))'],
  ['container-queries', 105, 2022, 'supports', 'container-type:size'],
  ['color-mix', 111, 2023, 'supports', 'color:color-mix(in srgb, red, blue)'],
  ['oklch', 111, 2023, 'supports', 'color:oklch(70% 0.1 200)'],
  ['view-transitions', 111, 2023, 'supports', 'view-transition-name:--csa'],
  ['nesting', 112, 2023, 'parse', '.csa{&.b{color:red}}'],
  ['text-wrap-balance', 114, 2023, 'supports', 'text-wrap:balance'],
  ['scroll-driven', 115, 2023, 'supports', 'animation-timeline:scroll()'],
  ['subgrid', 117, 2023, 'supports', 'grid-template-columns:subgrid'],
  ['anchor-positioning', 125, 2024, 'supports', 'anchor-name:--csa']
];

// 摘要口径常量（附录 K.12）：版本号只有这两个常量一处，标签由 digestLabel() 拼，
// 不许在别处写死 'tmpl-2' / 'hw-2'。输入清单同样只有一处，测试按它逐项验"真进了摘要"。
var FP_ALG_VERSION = 'tmpl-2';
var HW_ALG_VERSION = 'hw-2';
var FP_INPUTS = ['ua', 'langs', 'screen', 'tz', 'hc', 'mem', 'touch', 'plat', 'vendor',
  'canvas', 'fonts', 'mathfp', 'engver', 'wasm', 'gl'];
var HW_INPUTS = ['screen', 'dpr', 'depth', 'hc', 'mem', 'touch', 'plat', 'vendor',
  'gl-vendor', 'gl-renderer', 'fonts', 'fonts-hits', 'heap-limit'];
  var PROBE_FETCH_TIMEOUT = 1200;   // 探针服务自身的超时，比整体死线短
  // A-08：H3 升级补测的边界（只在已配置探针且第一次 /fp 报的是非 H3 协议时才跑）。
  // 三次重试 + 每次间隔 700ms + 每次最多 2s，但整体只给 4500ms：预算用完就放弃，
  // 不复用也不延长整轮死线 DEADLINE（12s）。
  var H3_RETRY_MAX = 3;
  var H3_RETRY_GAP = 700;
  var H3_RETRY_TIMEOUT = 2000;
  var H3_RETRY_BUDGET = 4500;
  // DNS 要跨境问一次递归解析器，实测 2.5–5.5 秒；它单独有 10 秒额度，整轮死线必须
  // 比它长，否则外层先收工，DNS 永远拿不到读数（1.3.3 的 6 秒死线就是这么吃掉它的）。
  // trackers 也在这条慢车道上：对照请求和 7 个目标各有自己的期限（1.2s + 1.5s），
  // 加起来会超过 PROBE_TIMEOUT，放在快速车道上会被整轮先掐掉。
  // etag 三次串行请求（首响 → 再校验 → 关联 report）、quicfp 的 H3 升级补测同理，
  // 都在慢车道，单项额度 10s 才装得下。
  var SLOW_TIMEOUT = 10000;          // 慢探针（dns / ai / trackers / etag / quicfp）的单项期限
  var SLOW_IDS = { dns: 1, ai: 1, trackers: 1, etag: 1, quicfp: 1 };
  var DEADLINE = 12000;              // 整轮上限，必须 ≥ SLOW_TIMEOUT

  // ---------- 基础工具 ----------
  function M(kind, n) { return n === undefined ? { $: kind } : { $: 'truncated', n: n }; }
  // 单项自限：到点先收工，落 fallback（多数情况是 null／状态标记），不阻塞整轮
  function within(p, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(fallback);
      }, ms);
      Promise.resolve(p).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(fallback);
      });
    });
  }
  function isMissing(v) { return v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ === 'string'; }
  function safe(fn, fallback) { try { var r = fn(); return r === undefined ? fallback : r; } catch (e) { return fallback; } }

  // ---------- 取消与期限 ----------
  // 一个请求要能因为两件事停下：它自己的期限到期，或者它属于的那一轮探针被取消
  // （单项超时、整轮死线、本次探针已经收工）。旧实现只做了前一半，而且 token 化以后
  // 每个探针各抄一份合并逻辑，容易漏接一个源。这里抽成一份，ctx.text/ctx.json/
  // trackers/etag 全部共用。
  // AbortSignal.any 在 Safari 17.4 之前与旧 Firefox 没有：那时自己合成一个控制器，
  // 两个源谁先 abort 就把合并控制器 abort 掉，别让整轮信号盖掉请求自己的短期限。
  function signalFor(env, ms, ac) {
    var AB = safe(function () { return (env && env.AbortSignal) || (typeof AbortSignal !== 'undefined' ? AbortSignal : null); }, null);
    var own = AB && AB.timeout ? safe(function () { return AB.timeout(ms || PROBE_TIMEOUT); }, null) : null;
    var run = ac ? safe(function () { return ac.signal; }, null) : null;
    if (!own) return run || null;
    if (!run) return own;
    var any = safe(function () { return AB.any; }, null);
    if (any) {
      var merged = safe(function () { return any.call(AB, [run, own]); }, null);
      if (merged) return merged;
    }
    var Ctor = safe(function () { return (env && env.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : null); }, null);
    if (!Ctor) return own;             // 连控制器都没有，至少保住请求自己的期限
    var ctl = new Ctor();
    var fired = false;
    function fire() { if (fired) return; fired = true; try { ctl.abort(); } catch (e) { } }
    function relay(sig) {
      if (!sig) return;
      if (sig.aborted) { fire(); return; }
      try { sig.addEventListener('abort', fire, { once: true }); } catch (e) { }
    }
    relay(run); relay(own);
    return ctl.signal;
  }
  // 探针里取信号：ctx 可能是 makeCtx 造的真对象（带 signalFor），也可能是测试/内嵌
  // 环境给的桩；两条路都要能拿到"自己的期限 + 本轮取消"，拿不到就退回自己一个源。
  function requestSignal(env, ctx, ms) {
    if (ctx && typeof ctx.signalFor === 'function') {
      var viaCtx = safe(function () { return ctx.signalFor(ms); }, null);
      if (viaCtx) return viaCtx;
    }
    return safe(function () { return signalFor(env, ms, ctx && ctx.__ac ? ctx.__ac : null); }, null);
  }
  function num(v, d) { v = +v; return isFinite(v) ? Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0) : null; }

  // ---------- 一轮内共享的采样 ----------
  // 字体扫描、WebGL 上下文、高熵 Client Hints、WebGPU 适配器这些都很贵，旧实现每个
  // 用到它的探针各跑一遍（字体 3 次、GL 6 次、高熵 3 次）。同一轮只采样一次，几处
  // 读到的还是同一份原值，后端拿到的线索不会自相矛盾。
  var MEMO = typeof WeakMap === 'function' ? new WeakMap() : null;
  function memoStore(env) {
    if (!env || (typeof env !== 'object' && typeof env !== 'function')) return {};
    if (!MEMO) { env.__radishMemo = env.__radishMemo || {}; return env.__radishMemo; }
    var store = MEMO.get(env);
    if (!store) { store = {}; MEMO.set(env, store); }
    return store;
  }
  function memo(env, key, make) {
    var store = memoStore(env);
    if (!(key in store)) store[key] = make();
    return store[key];
  }

  var STR_CAP = 300;   // 仅当整体超预算时才启用的单字符串上限
  function capStrings(v, cap, was, id) {
    if (typeof v === 'string') {
      if (v.length > cap) { was[id] = was[id] || v.length; return v.slice(0, cap); }
      return v;
    }
    if (Array.isArray(v)) { var arr = []; for (var i = 0; i < v.length; i++) arr.push(capStrings(v[i], cap, was, id)); return arr; }
    if (v && typeof v === 'object' && typeof v.$ !== 'string') { var o = {}; for (var k in v) o[k] = capStrings(v[k], cap, was, id); return o; }
    return v;
  }

  var OWN_KEYS = ['radish.sid', 'radish.sent'];
  // traces 用的存储读写：读不到就抛，让调用方标 blocked
function storageIo(store) {
  if (!store || typeof store.getItem !== 'function') return null;
  return {
    get: function () { return store.getItem('__radish_trace'); },
    set: function (v) { store.setItem('__radish_trace', v); },
    del: function () { try { store.removeItem('__radish_trace'); } catch (e) { } }
  };
}

// cookie 同一站点才读得到；跨站读不到不算受限
function cookieIo(doc) {
  if (!doc || typeof doc.cookie !== 'string') return null;
  return {
    get: function () {
      var m = String(doc.cookie).match(/(?:^|;\s*)__radish_trace=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    },
    set: function (v) {
      doc.cookie = '__radish_trace=' + encodeURIComponent(v) + '; path=/; max-age=' + (30 * 86400) + '; SameSite=Lax';
    },
    del: function () { doc.cookie = '__radish_trace=; path=/; max-age=0'; }
  };
}

// 标记本身是随机串，和身份无关；只取里面的 t 字段与写入时间
function parseTag(raw) {
  if (!raw) return null;
  try {
    var o = JSON.parse(raw);
    if (o && typeof o.t === 'string' && o.t.length >= 8) {
      var at = typeof o.at === 'number' ? o.at : 0;
      if (at && Date.now() - at > 30 * 86400 * 1000) return null;   // 过期就不算留得住
      return o.t;
    }
  } catch (e) { }
  return null;
}

function randTag(env) {
  var out = '', i;
  try {
    var cr = env.crypto && env.crypto.getRandomValues;
    var U = env.Uint8Array || (typeof Uint8Array !== 'undefined' ? Uint8Array : null);
    if (cr && U) {
      var a = new U(8);
      cr.call(env.crypto, a);
      for (i = 0; i < 8; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    }
  } catch (e) { }
  for (i = 0; i < 16; i++) out += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
  return out;
}

function foreignKeys(s) {
    if (!s) return null;
    var mine = 0;
    for (var i = 0; i < OWN_KEYS.length; i++) { try { if (s.getItem(OWN_KEYS[i]) !== null) mine++; } catch (e) { } }
    try {
      if (typeof s.key === 'function') {
        var n = 0;
        for (var j = 0; j < s.length; j++) { var k = s.key(j); if (k && OWN_KEYS.indexOf(k) < 0) n++; }
        return n;
      }
    } catch (e) { return null; }
    return Math.max(0, (s.length || 0) - mine);
  }

  function sha(str) {
    try {
      var d = crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
      return d.then(function (buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
        return 'sha256:' + s;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function shaSync(str) { // 同步兜底（crypto.subtle 不可用时）：FNV-1a 64 位，只用于区分，不用于安全
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9, s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = (h1 * 16777619) >>> 0;
      h2 = ((h2 ^ c) * 2246822519 + i) >>> 0;
    }
    return 'fnv:' + ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function hash(str) {
    var s = sha(str);
    return s && s.then ? s.then(function (v) { return v || shaSync(str); }) : Promise.resolve(shaSync(str));
  }

  // 摘要算法标签（N-04）：标签必须跟着**实际**算出来的那串值走，不能写死成 sha256。
  // 算法前缀是 hash() 自己加的，看前缀就能确定真正用的是哪条路径：
  // crypto.subtle 通了是 `sha256:`，被浏览器禁用/拦下而走 shaSync 时是 `fnv:`。
  // 版本号跟着输入清单走（tmpl-1 环境模板 / hw-1 设备特征），降级再加 -fallback，
  // 于是 `sha256/tmpl-1` 与 `fnv/tmpl-1-fallback` 看一眼就知道算法、版本与是否降级。
  function digestAlg(value) {
    var s = typeof value === 'string' ? value : '';
    if (s.indexOf('sha256:') === 0) return 'sha256';
    if (s.indexOf('fnv:') === 0) return 'fnv';
    return null;   // 缺项或标记对象：没有摘要就没有标签，不编一个出来
  }
  function digestLabel(value, version) {
    var alg = digestAlg(value);
    if (!alg) return null;
    return alg === 'fnv' ? 'fnv/' + version + '-fallback' : 'sha256/' + version;
  }

  function tmpl(env) {
    var nav = env.navigator || {}, scr = env.screen || {};
    var ua = safe(function () { return nav.userAgent; }, '');
    var langs = safe(function () { return (nav.languages || [nav.language]).join(','); }, '');
    return {
      ua: ua, langs: langs,
      screen: safe(function () { return [scr.width, scr.height, scr.availWidth, scr.availHeight, env.devicePixelRatio, scr.colorDepth].join('x'); }, ''),
      tz: safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, ''),
      hc: safe(function () { return nav.hardwareConcurrency; }, ''),
      mem: safe(function () { return nav.deviceMemory; }, ''),
      touch: safe(function () { return nav.maxTouchPoints; }, ''),
      plat: safe(function () { return nav.platform; }, ''),
      vendor: safe(function () { return nav.vendor; }, '')
    };
  }
  // 旧的 tmplStr()（一份模板串直接进摘要）已被 fpBits() 取代：输入范围要逐项可核对、
  // 能逐项验证"真的进了摘要"，拼在一起的一整串做不到这件事（附录 K.12）。

  // ---------- 探针注册 ----------
  var PROBES = [], MAP = {};
  function probe(id, fn) { if (MAP[id]) return; MAP[id] = true; PROBES.push({ id: id, run: fn }); }
  // 探针主动「不参与本轮」：没配置探针服务、或服务返回里没有这一项时用它，
  // 让 runProbes 跳过这个键，而不是写成 unsupported（那会把「没跑」说成「不支持」）
  var SKIP = { __radishSkip: true };

  // ============ net · 客户端可读部分 ============
  probe('clock', function (env) {
    // 只报本地读数。skew 依赖 trace，统一在 derive() 里算——探针与 trace 并发时
    // 这里读 ctx.trace 一定是空的（旧实现因此永远 skew_h=null）。
    return { off: num(-new Date().getTimezoneOffset() / 60, 2), offset_min: new Date().getTimezoneOffset(), __t: Date.now() / 1000 };
  });

  // 一次 ICE 收集，供 webrtc / lan / v6mac 共用。
  // 旧实现 iceServers 恒为空数组，只能拿到 host / mDNS，永远没有公网候选；
  // 现在用公共 STUN（只为换 srflx，不中继流量），并把候选的类型与作用域都留下。
  // 缓存挂在 ctx.cache 上：每轮一份，重试时不会拿到上一轮的旧候选。
  function stunServers() {
    var raw = (CLOUD && CLOUD.stun) || null;
    if (!raw || !raw.length) raw = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
    var out = [];
    for (var i = 0; i < raw.length && out.length < 3; i++) {
      var one = String(raw[i] || '').trim();
      // 实测：`stun:stun.cloudflare.com:3478` 才是浏览器认的形状，
      // 旧正则要求 `stun://`，于是默认清单被整条过滤掉，servers 恒为 0。
      if (/^stuns?:[^\s]+$/i.test(one)) out.push({ urls: one });
    }
    return out;
  }
  function ice(ctx, env) {
    var cache = (ctx && ctx.cache) || {};
    if (cache.ice) return cache.ice;
    cache.ice = new Promise(function (resolve) {
      var RTC = safe(function () { return env.RTCPeerConnection || env.webkitRTCPeerConnection; }, null);
      if (!RTC) { resolve(M('unsupported')); return; }
      var cands = [], done = false, pc = null, timer = null;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (pc && pc.close) pc.close(); } catch (e) { }
        resolve(cands);
      }
      // 地址取 RTCIceCandidate.address；老实现按 candidate 语法取第 5 段。
      // 旧代码用 /([0-9a-fA-F.:]{3,})\s/ 抓到的是 foundation（"123456"），不是地址。
      function addrOf(cand) {
        var a = null;
        if (cand && typeof cand.address === 'string' && cand.address) a = cand.address;
        if (!a && cand && typeof cand.candidate === 'string') {
          var parts = cand.candidate.split(/\s+/);
          if (parts.length >= 8 && /^candidate:/.test(parts[0])) a = parts[4];
        }
        if (!a) return null;
        // mDNS 伪装地址形如 `e63dff68-...-7944e515e772.local`：只看后缀，
        // 旧正则要求点前是空格，永远匹配不上，于是 mdns 一直是 false。
        return /\.local$/i.test(a) ? 'mdns.local' : a;
      }
      function typeOf(cand) {
        if (cand && typeof cand.type === 'string' && cand.type) return cand.type;
        var m = cand && typeof cand.candidate === 'string' ? cand.candidate.match(/ typ (\w+)/) : null;
        return m ? m[1] : null;
      }
      var servers = stunServers();
      try {
        pc = new RTC({ iceServers: servers, iceCandidatePoolSize: 0 });
        // 1600 ms：有 STUN 时 host+srflx 通常 1 秒内到齐；STUN 被墙时也不能把
        // 整个探针拖到单项额度（2.5s）才收尾——线上实测 2500 会让 webrtc/lan/v6mac
        // 三项一起变成 timeout。
        timer = setTimeout(function () { finish(); }, 1600);
        pc.onicecandidate = function (e) {
          if (!e || !e.candidate) { finish(); return; }
          var address = addrOf(e.candidate);
          var type = typeOf(e.candidate) || 'host';
          if (!address) return;
          var family = address === 'mdns.local' ? null : (address.indexOf(':') >= 0 ? 6 : 4);
          // 作用域按类型判：mdns 与 host 是本机的，srflx 是公网映射，relay 是经中继的
          var scope = address === 'mdns.local' ? 'local'
            : (type === 'srflx' || type === 'prflx') ? 'public'
              : type === 'relay' ? 'relay' : 'local';
          var key = type + '|' + address;
          for (var k = 0; k < cands.length; k++) {
            if (cands[k].key === key) return;
          }
          cands.push({ key: key, address: address, type: type, family: family, scope: scope });
        };
        pc.createDataChannel('r');
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { finish(); });
      } catch (e) { resolve(M('error')); }
    });
    return cache.ice;
  }
  function addrsOf(cands) {
    var out = [];
    for (var i = 0; i < cands.length; i++) {
      if (out.indexOf(cands[i].address) < 0) out.push(cands[i].address);
    }
    return out;
  }
  probe('webrtc', function (env, ctx) {
    return ice(ctx, env).then(function (cands) {
      if (isMissing(cands)) return cands;
      var a = addrsOf(cands);
      var srflx = cands.filter(function (c) { return c.scope === 'public'; }).length;
      var hasMc = a.indexOf('mdns.local') >= 0;
      return {
        api: true,
        servers: stunServers().length,
        // 地址一起留下：srflx 的公网地址就是访客自己的出口地址，服务端本来也知道，
        // 但它必须挂在候选结构里，不能混进 lan 的"局域网地址"
        candidates: cands.map(function (c) {
          return { type: c.type, family: c.family, scope: c.scope, address: c.address };
        }).slice(0, 8),
        n: a.length,
        public_n: srflx,
        mdns: hasMc,
        // 只有拿到 srflx 才是公网候选；否则仍如实说只看到本机候选
        scope: srflx > 0 ? 'public+local' : 'local'
      };
    });
  });
  probe('lan', function (env, ctx) {
    return ice(ctx, env).then(function (cands) {
      if (isMissing(cands)) return cands;
      var a = addrsOf(cands);
      var mdns = a.indexOf('mdns.local') >= 0;
      var types = {};
      var publicCount = 0;
      var localAddrs = [];
      cands.forEach(function (c) {
        types[c.type] = (types[c.type] || 0) + 1;
        if (c.scope === 'public' || c.scope === 'relay') { publicCount++; return; }
        if (c.address === 'mdns.local') return;
        if (localAddrs.indexOf(c.address) < 0) localAddrs.push(c.address);
      });
      // lan 只表示本机可直连的读数：srflx/relay 候选属于公网侧，留给 webrtc.candidates
      var ipv4 = localAddrs.filter(function (x) { return /^\d+\.\d+\.\d+\.\d+$/.test(x); });
      var v6 = localAddrs.filter(function (x) { return x.indexOf(':') >= 0; });
      var excluded = publicCount;
      if (!ipv4.length && !v6.length) {
        return {
          scope: 'local', ips: [], v6: [], mdns: mdns,
          mdns_only: mdns, candidate_types: types, excluded_public: excluded,
          reason: mdns ? 'mdns_only' : 'no_candidate'
        };
      }
      // mDNS 与真实地址同时出现时不能再写 mdns_only
      return {
        scope: 'local', ips: ipv4.slice(0, 8), v6: v6.slice(0, 4),
        mdns: mdns, mdns_only: false, candidate_types: types,
        // 被排除掉的公网/中继候选数量：不静默丢，让下游知道 lan 为什么"没有"这些地址
        excluded_public: excluded
      };
    });
  });
  // EUI-64 的判法：IID 中间必须是 ff:fe，命中后再翻 U/L 位还原 MAC。
  // 旧实现只做 /ff:fe/ 正则，`2001:db8::ff:fe00:1` 这种也算命中，会误报。
  function macFromV6(addr) {
    var s = String(addr || '').replace(/^\[|\]$/g, '').split('%')[0].trim();
    if (s.indexOf(':') < 0) return null;
    var groups = s.split(':');
    if (groups.length < 8) {
      var at = s.indexOf('::');
      if (at < 0) return null;
      var head = s.slice(0, at).split(':').filter(Boolean);
      var tail = s.slice(at + 2).split(':').filter(Boolean);
      var fill = 8 - head.length - tail.length;
      if (fill < 0) return null;
      groups = head.concat(new Array(fill).fill('0'), tail);
    }
    if (groups.length !== 8) return null;
    var bytes = [];
    for (var i = 0; i < 8; i++) {
      var g = ('0000' + String(groups[i])).slice(-4);
      var hi = parseInt(g.slice(0, 2), 16), lo = parseInt(g.slice(2, 4), 16);
      if (isNaN(hi) || isNaN(lo)) return null;
      bytes.push(hi, lo);
    }
    if (bytes[11] !== 0xff || bytes[12] !== 0xfe) return null;
    var mac = [bytes[8] ^ 0x02, bytes[9], bytes[10], bytes[13], bytes[14], bytes[15]];
    return mac.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(':');
  }
  probe('v6mac', function (env, ctx) {
    // 本轮先只看 ICE：trace 与出口回显可能还没回来，derive() 里再合并多来源
    return ice(ctx, env).then(function (cands) {
      if (isMissing(cands)) return cands;
      var v6 = addrsOf(cands).filter(function (x) { return x.indexOf(':') > 0; });
      var mac = null;
      for (var i = 0; i < v6.length; i++) {
        mac = macFromV6(v6[i]);
        if (mac) break;
      }
      return {
        addresses: v6.slice(0, 6),
        has_v6: v6.length > 0,
        eui64: !!mac,
        mac: mac,
        basis: 'eui64-iid',
        sources: ['ice']
      };
    });
  });

  // ============ probe · 可选探针服务（PROBE_URL 为空时不发任何请求） ============
  function probeUrlOf(ctx) { return (ctx && ctx.probeUrl) || PROBE_URL; }
  function probeH3(fp) {
    return /^(h3|http\/3|quic)/.test(String(fp.proto || '').toLowerCase());
  }
  // 5 项共用一次 /fp 请求；结果挂在 ctx.cache 上：同一轮共享，不同 ctx（不同轮次）互不串味。
  // 探针拿到的是本轮 ctx 的门面对象，缓存对象必须放在原型链上一层的 ctx.cache 里才真的共享。
  // 探针地址可以放在后端：一次发现请求换一处可换地址，博客侧不需要重新部署。
  function discoverProbe(ctx, cache) {
    if (cache.__radishProbeUrl) return cache.__radishProbeUrl;
    var p = ctx.json(FP_URL, PROBE_FETCH_TIMEOUT, M('unreachable')).then(function (r) {
      if (!r || isMissing(r) || r.available !== true || !r.url) return '';
      return String(r.url).replace(/\/+$/, '');
    }).catch(function () { return ''; });
    cache.__radishProbeUrl = p;
    return p;
  }
  function probeFp(ctx) {
    var cache = ctx.cache || (ctx.cache = {});
    if (cache.__radishProbe) return cache.__radishProbe;
    var base = probeUrlOf(ctx);
    if (!base) {
      // 没有配置就地发现；后端说没有探针时这五项保持"未配置"（不进 cli），不伪造读数
      cache.__radishProbe = discoverProbe(ctx, cache).then(function (found) {
        if (!found) return SKIP;
        return fetchFp(ctx, found);
      });
      return cache.__radishProbe;
    }
    cache.__radishProbe = fetchFp(ctx, base);
    return cache.__radishProbe;
  }
  function fetchFp(ctx, base) {
    var url = String(base).replace(/\/+$/, '') + '/fp';
    // 补测要复用同一个 /fp 地址（quicfp 的慢车道补测拿不到 base 就退不出来），
    // 所以把**解析后**的地址记在共享缓存上，而不是再读一次 PROBE_URL。
    if (ctx && ctx.cache) ctx.cache.__radishProbeBase = base;
    var p;
    try {
      p = ctx.json(url, PROBE_FETCH_TIMEOUT, M('unreachable'));
    } catch (e) { p = Promise.resolve(M('unreachable')); }
    // 失败统一成 unreachable：说明「配置了探针但读不到」，不是「浏览器不支持」
    return Promise.resolve(p).then(function (fp) {
      return (fp && !isMissing(fp)) ? fp : M('unreachable');
    }, function () { return M('unreachable'); });
  }
  function probeField(id, pick) {
    probe(id, function (env, ctx) {
      var p = probeFp(ctx);
      if (!p) return SKIP;
      return p.then(function (fp) {
        if (fp === SKIP) return SKIP;
        if (isMissing(fp)) return fp;
        var v = safe(function () { return pick(fp, ctx); }, undefined);
        return v === undefined || v === null ? SKIP : v;
      });
    });
  }
  // 抓包失败原因（契约附录 G「协议探针的失败原因」）：``tcp`` 的单键缺失标记形状不变
  // ``{"$": "<状态>"}``，原因走旁路元数据 ``cli.tcp_reason``。只收探针自己给的、机器可读的
  // 短横线原因码；形状不对就当没给——绝不替探针编一个原因。
  function probeReason(fp) {
    var r = fp && fp.tcp_reason;
    return typeof r === 'string' && r.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r) ? r : '';
  }
  probeField('tcpfp', function (fp, ctx) {
    // 探针没接（PROBE_URL 为空、后端也没给地址）时这一项根本不执行，这里不会写 reason。
    // 只有 tcp 是缺失标记时才有原因可讲：读数正常时探针也不发原因，收到也丢掉。
    var reason = isMissing(fp.tcp) ? probeReason(fp) : '';
    var cache = ctx && ctx.cache;
    if (reason && cache) cache.tcpReason = reason;
    return fp.tcp;
  });
  probeField('ja4', function (fp) { return fp.tls && fp.tls.ja4; });
  probeField('tlsfp', function (fp) { return fp.tls && (fp.tls.ja3n || fp.tls.ja3); });
  probeField('h2fp', function (fp) { return fp.http2; });
  // ---------- quicfp：H3 升级后的有限补测（A-08） ----------
  // 五项共用第一次 /fp（首连通常是 TCP/H2；浏览器要收到 Alt-Svc 之后的**后续连接**才
  // 可能升级到 H3），所以第一次样本里几乎总是拿不到 quicfp。做法：
  //   1) 第一次样本原样不动，它永远是 tcpfp / ja4 / tlsfp / h2fp 的来源；
  //   2) quicfp 单独走慢车道做有限补测：最多 H3_RETRY_MAX 次、每次之间隔 H3_RETRY_GAP，
  //      每次请求有自己的期限，总耗时受 H3_RETRY_BUDGET 约束；预算不够就不再多试，
  //      如实记 timeout，**不**延长整封上传（整轮死线 DEADLINE 一个字都没动）；
  //   3) 补测样本只用来取 quicfp，绝不回填另外四项（那份读数属于首跳那条连接）。
  // 结果写在 meta.h3（cli 的形状不变：拿到 H3 的 ja4 时是字符串，否则这一项不出现），
  // state 能区分四种情形 + 两种"不知道"：
  //   h3-first    首连就已经是 H3
  //   upgraded    补测里有一次回的是 H3 连接
  //   tcp-only    补测有响应、但都不是 H3：浏览器没升级 / 一直走 TCP
  //               （防火墙丢 UDP 也落在这里，单看响应分不开，所以不写成"UDP 不通"）
  //   udp-blocked 首样本正常，而补测一个响应都没回来：探针的 H3 路径根本连不上
  //   timeout     预算用完还没结果：未知，不写成"没升级"
  //   proto-unknown 探针没报 proto：没有"升级与否"的判据，不猜
  function h3Note(state, info) {
    if (state === 'h3-first') return '第一次 /fp 就是 HTTP/3 连接，不需要补测';
    if (state === 'upgraded') return '补测第 ' + info.retries + ' 次拿到了 HTTP/3 样本；首跳的 tcpfp/ja4/h2fp 保持原样，没有被覆盖';
    if (state === 'tcp-only') return '补测 ' + info.retries + ' 次都有响应，但都不是 HTTP/3：浏览器没升级或一直走 TCP（UDP 被丢弃也落在这里，客户端分不开）';
    if (state === 'udp-blocked') return '补测 ' + info.retries + ' 次一个响应都没回来（首样本是好的）：H3 路径不可达';
    if (state === 'timeout') return '补测预算 ' + H3_RETRY_BUDGET + 'ms 用完仍无结果：未知，不写成"没升级"';
    return '探针没报 proto，无法判断能不能升级到 H3';
  }
  probe('quicfp', function (env, ctx) {
    var p = probeFp(ctx);
    if (!p) return SKIP;
    return Promise.resolve(p).then(function (fp) {
      if (fp === SKIP) return SKIP;
      // 探针没接 / 不可达：五项共用一个状态标记（和别的探针项一样）
      if (isMissing(fp)) return fp;
      var firstJa4 = (fp.tls && fp.tls.ja4) ? fp.tls.ja4 : null;
      var firstProto = typeof fp.proto === 'string' && fp.proto ? fp.proto : null;
      var t0 = Date.now();
      function record(state, extra) {
        var info = {
          alg: 'h3-retry/1',
          state: state,
          first_proto: firstProto,
          h3_proto: (extra && extra.h3Proto) || null,
          ja4: (extra && extra.ja4) || null,
          retries: (extra && extra.retries) | 0,
          attempts: (extra && extra.attempts) | 0,
          answered: (extra && extra.answered) | 0,
          max_retries: H3_RETRY_MAX,
          gap_ms: H3_RETRY_GAP,
          request_ms: H3_RETRY_TIMEOUT,
          budget_ms: H3_RETRY_BUDGET,
          elapsed_ms: Date.now() - t0,
          budget_exhausted: !!(extra && extra.budgetExhausted)
        };
        info.note = h3Note(state, info);
        // 诊断走 meta.h3（和 meta.timeouts 同一套做法）：cli.quicfp 的形状不变
        var cache = ctx && ctx.cache;
        if (cache && typeof cache === 'object') cache.h3 = info;
        return info;
      }
      // 首连就是 H3：不用补测，ja4 就是 QUIC 的
      if (probeH3(fp)) {
        record('h3-first', { retries: 0, attempts: 0, h3Proto: firstProto, ja4: firstJa4 });
        return firstJa4;
      }
      // 探针没报 proto：连"这次走的是不是 TCP"都没有依据，补测也不知道往哪儿判
      if (!firstProto) {
        record('proto-unknown', { retries: 0, attempts: 0 });
        return SKIP;
      }
      var base = (ctx && ctx.cache && ctx.cache.__radishProbeBase) || probeUrlOf(ctx);
      var url = String(base || '').replace(/\/+$/, '') + '/fp';
      if (!base) {
        record('proto-unknown', { retries: 0, attempts: 0 });
        return SKIP;
      }
      var tries = 0, answered = 0, h3 = null, budgetExhausted = false;
      function gapThenAttempt() {
        if (tries >= H3_RETRY_MAX) return Promise.resolve();
        // 先算预算：留不出"间隔 + 一次最短期请求"的余量就别再试，别把这一项拖到额度尽头
        if (H3_RETRY_BUDGET - (Date.now() - t0) < H3_RETRY_GAP + 200) {
          budgetExhausted = tries > 0;
          return Promise.resolve();
        }
        return new Promise(function (r) { setTimeout(r, H3_RETRY_GAP); }).then(function () {
          var left = H3_RETRY_BUDGET - (Date.now() - t0);
          if (left < 200) { budgetExhausted = true; return; }
          tries += 1;
          var ms = Math.min(H3_RETRY_TIMEOUT, Math.max(200, left));
          return Promise.resolve()
            .then(function () { return ctx.json(url, ms, M('timeout')); })
            .then(function (j) {
              if (j && !isMissing(j) && typeof j === 'object') {
                answered += 1;
                if (probeH3(j)) h3 = j;
              }
              if (h3) return;
              return gapThenAttempt();
            }, function () { return gapThenAttempt(); });
        });
      }
      return gapThenAttempt().then(function () {
        var h3Ja4 = h3 && h3.tls && h3.tls.ja4 ? h3.tls.ja4 : null;
        var extra = {
          retries: tries,
          attempts: tries,
          answered: answered,
          h3Proto: h3 ? String(h3.proto || '') : null,
          ja4: h3Ja4,
          budgetExhausted: budgetExhausted
        };
        if (h3) {
          record('upgraded', extra);
          return h3Ja4 || SKIP;          // H3 但没有 ja4：状态记在 meta.h3，cli 不编值
        }
        if (answered > 0) { record('tcp-only', extra); return SKIP; }
        // 一个响应都没回来时还要看预算：预算是在补测途中用完的，就只能说"不知道"；
        // 三次补测都按时被拒（预算没用完）才是"H3 路径根本连不上"。
        if (budgetExhausted) { record('timeout', extra); return SKIP; }
        if (tries > 0) { record('udp-blocked', extra); return SKIP; }
        record('timeout', extra);
        return SKIP;
      });
    });
  });

  // DNS 解析器：唯一能说明"解析请求从哪儿出去"的读数，所以保留，并给它更长的等待。
  // 实测这条接口 2.5–5.5 秒（隧道/代理更慢），1.3.3 的 3.6 秒单项期限 + 6 秒整轮
  // 死线让它基本拿不到值。现在单项 10 秒、整轮 12 秒，并且它单独起跑、不排在池子后面。
  // 随机子域形式（https://<nonce>.edns.ip-api.com/json）实测返回 404，不能用；
  // 查询串 nonce 可以强制绕过缓存，所以方法名记作 query-nonce。
  function dnsNonce(env) {
    var bytes = new Uint8Array(8);
    try {
      (env.crypto || crypto).getRandomValues(bytes);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
      return hex;
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }
  // 期限可配置：script 标签上写 data-dns-ms 可以再放宽，但内层永远比整轮短，
  // 超时时把"哪一层先到点"一起记下来，别让人以为一定是探针自己超时。
  function dnsBudget() {
    var inner = SLOW_TIMEOUT - 400;
    var wanted = Number(CLOUD && CLOUD.dnsMs);
    if (isFinite(wanted) && wanted >= 1000) inner = Math.min(wanted, DEADLINE - 800);
    return { inner: inner, outer: DEADLINE };
  }
  probe('dns', function (env, ctx) {
    var t0 = Date.now();
    var budget = dnsBudget();
    var url = 'https://edns.ip-api.com/json?nonce=' + dnsNonce(env);
    // 期限比单项额度略短，让 withTimeout 之前先自己收尾，能保留自己记的耗时
    // B2：country 要存校验过的地区代码，原始名字留在 geo 与 country_raw；
    // 转换不出来的就写 unknown 状态，别把名字塞进 country 冒充代码。
    var DNS_COUNTRIES = {
      'china': 'CN', 'hong kong': 'HK', 'hong kong sar': 'HK', 'macao': 'MO', 'macau': 'MO',
      'taiwan': 'TW', 'united states': 'US', 'usa': 'US', 'japan': 'JP', 'singapore': 'SG',
      'south korea': 'KR', 'korea': 'KR', 'germany': 'DE', 'united kingdom': 'GB', 'france': 'FR',
      'india': 'IN', 'brazil': 'BR', 'australia': 'AU', 'canada': 'CA', 'russia': 'RU',
      'netherlands': 'NL', 'vietnam': 'VN', 'thailand': 'TH', 'malaysia': 'MY', 'indonesia': 'ID',
      'philippines': 'PH', 'turkey': 'TR', 'mexico': 'MX', 'spain': 'ES', 'italy': 'IT',
      'poland': 'PL', 'sweden': 'SE', 'switzerland': 'CH', 'united arab emirates': 'AE'
    };
    function dnsCountry(raw) {
      if (!raw) return { code: null, state: M('unreadable') };
      var key = String(raw).trim().toLowerCase();
      if (DNS_COUNTRIES[key]) return { code: DNS_COUNTRIES[key], state: null };
      // 服务偶尔直接给两字母代码
      if (/^[a-z]{2}$/.test(key)) return { code: key.toUpperCase(), state: null };
      return { code: null, state: M('unreadable') };
    }
    return ctx.json(url, budget.inner, M('timeout')).then(function (j) {
      if (isMissing(j)) {
        // 标记必须是纯状态（{"$":"timeout"}），额度与耗时另挂 meta.timeouts：
        // 单项 10 秒、整轮 12 秒的关系要看得见，但不能污染状态本身。
        var waited = Date.now() - t0;
        ctx.cache = ctx.cache || {};
        ctx.cache.timeouts = ctx.cache.timeouts || {};
        ctx.cache.timeouts.dns = {
          state: (j && j.$) || 'timeout',
          waited_ms: waited,
          inner_ms: budget.inner,
          outer_ms: budget.outer,
          layer: waited >= budget.outer - 200 ? 'round' : 'item'
        };
        return j;
      }
      var d = j && j.dns;
      if (!d || (!d.ip && !d.geo)) return M('unreadable');
      var geo = d.geo ? String(d.geo) : null;
      var parts = geo ? geo.split(' - ') : [];
      var rawCountry = parts.length ? parts[0].trim() : null;
      var cc = dnsCountry(rawCountry);
      return {
        resolver_ip: d.ip || null,
        family: famOf(d.ip),
        country: cc.code,                       // 校验过的代码，可能是 null
        country_raw: rawCountry,                // 服务原值，转换失败时靠它复核
        country_state: cc.state,                // 转换失败时为 unreadable 标记
        organization: parts.length > 1 ? parts.slice(1).join(' - ').trim() : null,
        geo: geo,
        // 方法说明（2026-11-13 实测）：
        //   - 响应只有 dns.ip 与 dns.geo 两个字段，没有 ECS、没有国家代码；
        //   - 随机子域 https://<nonce>.edns.ip-api.com/json 返回 404，用不了；
        //   - 同一台机器连续请求，解析器 IP 会在同一 /24 内变化（219.144.80.146/.148），
        //     说明这个值是服务每次自己解析出来的，不是缓存下来的常量；
        //   - 但它测的是"这个服务看到的解析器"，不等于访客访问本站时的解析路径。
        method: 'edns-ip-api-query-nonce',
        method_version: 'edns-ip-api/2',
        fields: ['dns.ip', 'dns.geo'],
        ecs: M('unreadable'),                   // 该服务不提供 ECS，别编一个出来
        scope: 'service-reported',              // 只能表述为"该服务报告的解析器"
        waited_ms: Date.now() - t0,
        inner_ms: budget.inner,
        outer_ms: budget.outer,
        at: new Date().toISOString(),
        ms: Date.now() - t0
      };
    });
  });

  // ============ exit · 出口 ============
  function famOf(ip) { return !ip ? null : (String(ip).indexOf(':') >= 0 ? 6 : 4); }
  function exitTrace(host) {
    return function (env, ctx) {
      var t0 = Date.now();
      return ctx.text('https://' + host + '/cdn-cgi/trace', 1800, M('unreadable')).then(function (t) {
        if (isMissing(t)) return t;            // 传输层已经给了状态，别往下解析
        if (!t) return M('unreadable');
        var kv = ctx.parseTrace(t);
        // 没有 ip 就不是一次成功的出口观测（被拦截页、门户页都会 200 但没 trace）
        if (!kv.ip) return M('unreadable');
        // 老实现把 ip 丢了，后端拿不到"目的地看到的出口 IP"就没法做分流比较
        return {
          dest: host,
          ip: kv.ip || null,
          fam: famOf(kv.ip),
          loc: kv.loc || null,
          colo: kv.colo || null,
          http: kv.http || null,
          tls: kv.tls || null,
          ms: Date.now() - t0
        };
      });
    };
  }
  probe('ex_gpt', exitTrace('chatgpt.com'));
  probe('ex_claude', exitTrace('claude.ai'));
  probe('ex_cf', exitTrace('www.cloudflare.com'));
  // stack：契约承诺的是 IPv4 / IPv6 双栈，所以分别打 v4-only 与 v6-only 目标
  // （旧实现打的是普通 hostname 的 trace，测出来的是 HTTP/TLS，跟 stack 的名字无关）
  probe('stack', function (env, ctx) {
    function one(url) {
      return ctx.json(url, 2000, M('unreadable')).then(function (j) {
        if (!j || isMissing(j)) return { ok: false, state: 'unreadable' };
        return j.ip ? { ok: true, ip: j.ip } : { ok: false, state: 'no_ip' };
      });
    }
    return Promise.all([one('https://api4.ipify.org?format=json'), one('https://api6.ipify.org?format=json')]).then(function (r) {
      // dual 是三态：两条腿都读到了才谈得上"有没有 v6"；有一条读不出来就是未知，
      // 旧实现把它写成 false，等于把"没测到"说成"没有 IPv6"。
      var dual = null;
      if (r[0].ok && r[1].ok) dual = true;
      else if (r[0].ok && r[1].state === 'no_ip') dual = false;
      else if (r[1].ok && r[0].state === 'no_ip') dual = false;
      return { v4: r[0], v6: r[1], dual: dual };
    });
  });
  probe('ex_intl', function (env, ctx) {
    return ctx.json('https://api.ip.sb/geoip', 2000, M('unreadable')).then(function (j) {
      if (isMissing(j)) return j;
      if (!j) return M('unreadable');
      if (!j.ip) return M('unreadable');       // 只有地理字段、没有 IP 不算观测到出口
      return {
        ip: j.ip || null, fam: famOf(j.ip),
        country: j.country_code || j.country || null,
        isp: j.isp || j.organization || null,
        asn: j.asn || null
      };
    });
  });
  probe('ex_cn', function (env, ctx) {
    // 现在的返回是 {"ret":"ok","data":{"ip":"…","location":["中国","陕西","西安","","电信"]}}
    // 老格式是 {data:{country,province,city,isp}}，两种都要认
    return ctx.text('https://myip.ipip.net/json', 2200, M('unreadable')).then(function (t) {
      if (!t) return M('unreadable');
      var j = null; try { j = JSON.parse(t); } catch (e) { return M('unreadable'); }
      var d = (j && (j.data || j)) || {};
      var loc = Array.isArray(d.location) ? d.location : [];
      var o = {
        ip: d.ip || null, fam: famOf(d.ip),
        country: d.country || loc[0] || null,
        province: d.province || loc[1] || null,
        city: d.city || loc[2] || null,
        isp: d.isp || loc[4] || null
      };
      if (!o.ip) return M('unreadable');
      return o;
    });
  });

  // ============ loc · 9 项 ============
  probe('langs', function (env) { return safe(function () { return (env.navigator.languages || [env.navigator.language]).slice(0, 12); }, M('unsupported')); });
  probe('locale', function (env) { return safe(function () { return Intl.DateTimeFormat().resolvedOptions().locale; }, M('unsupported')); });
  probe('tz', function (env) { return safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, M('unsupported')); });
  probe('hour', function () {
    return safe(function () {
      var o = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
      return { cycle: o.hourCycle || null, h12: o.hour12 === undefined ? null : !!o.hour12 };
    }, M('unsupported'));
  });
  probe('week', function (env) {
    return safe(function () {
      var L = new Intl.Locale(env.navigator.language || 'en');
      var wi = L.weekInfo || (L.getWeekInfo ? L.getWeekInfo() : null);
      if (!wi) return M('unsupported');
      // 字段名改过一次：早期规范是 minimalDays，现行规范（Chrome/Safari/Firefox 这一代）
      // 叫 minDays。只读旧名会在新引擎上恒为 null（读数丢了一半还看不出来），
      // 所以两个名字都认；都读不到才是 null。
      var md = wi.minDays;
      if (md === undefined) md = wi.minimalDays;
      return { firstDay: wi.firstDay, weekend: wi.weekend || null, minDays: md === undefined ? null : md };
    }, M('unsupported'));
  });
  probe('fmt', function (env) {
    return safe(function () {
      var d = new Date(2024, 0, 2, 15, 4, 5);
      return new Intl.DateTimeFormat().format(d) + '|' + new Intl.NumberFormat().format(1234567.891) + '|' + (1234.5).toLocaleString();
    }, M('unsupported'));
  });
  probe('icu', function (env) {
    // 上游量的是 ICU 数据面：supportedValuesOf 能列出多少种日历／排序／货币／
    // 数字系统／时区／单位。原来这里测的是 Segmenter 分词和几个 format 调用，
    // 名字叫 icu 但量的不是 ICU 数据版本，换掉。
    return safe(function () {
      if (!env.Intl || !env.Intl.supportedValuesOf) return M('unsupported');
      var kinds = ['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone', 'unit'];
      // 计数平铺在顶层：后端的 facet 只展开两层，嵌在 counts 里就取不到了
      var out = { alg: 'supported-values-of' };
      for (var i = 0; i < kinds.length; i++) {
        (function (kind) {
          try { out[kind] = env.Intl.supportedValuesOf(kind).length; }
          catch (e) { out[kind] = M('unsupported'); }
        })(kinds[i]);
      }
      // 中文分词能力单独留一个布尔，不再混进计数里
      out.segmenter = env.Intl.Segmenter ? true : false;
      return out;
    }, M('unsupported'));
  });
  probe('kbd', function (env) {
    // 旧实现直接拼 m.get(...)：布局表里没有这两个键时拼出字符串 "undefined|undefined"，
    // 看着像读数。现在取不到就是 unreadable，取到哪个报哪个。
    return safe(function () {
      var kb = env.navigator && env.navigator.keyboard;
      if (!kb || !kb.getLayoutMap) return M('unsupported');
      return kb.getLayoutMap().then(function (map) {
        var y = map.get('KeyY'), q = map.get('KeyQ');
        if (y === undefined && q === undefined) return M('unreadable');
        return (y === undefined ? '?' : y) + '|' + (q === undefined ? '?' : q);
      }).catch(function () { return M('unreadable'); });
    }, M('unsupported'));
  });
  // voices（loc）：这一项以前无条件裁到 32 条（applyBudget 的 HARD 表），信封其实还有
  // 很大余量时也在少报，读的人看不出"少报了"。现在拆成两件事：
  //   ① 探针这边只做**解析上限**（VOICE_POOL），把采集到的原始总数如实记进 total；
  //   ② 发送条数由 applyBudget() 按**剩余预算**决定（见 voiceTrim）：预算够就整份发，
  //      预算紧才裁，并且 cut=true、meta.truncated 记真实总数。
  var VOICE_POOL = 300;
  probe('voices', function (env) {
    return safe(function () {
      var ss = env.speechSynthesis;
      if (!ss || !ss.getVoices) return M('unsupported');
      var pack = function (vs) {
        var list = [], total = vs.length;
        for (var i = 0; i < vs.length && i < VOICE_POOL; i++) {
          var v = vs[i] || {};
          // 旧实现把每条压成 "lang/name" 字符串，localService（本机合成还是云端）
          // 与 default（是否默认音）这两个能用的字段全丢了。
          list.push({
            name: v.name || '',
            lang: v.lang || '',
            localService: typeof v.localService === 'boolean' ? v.localService : null,
            default: typeof v.default === 'boolean' ? v.default : null
          });
        }
        return {
          alg: 'voices/2',
          total: total,               // 采集到的原始总数（真实条数，不随裁剪变）
          shown: list.length,         // 这一份里带出去几条
          cut: list.length < total,   // 只在这一份真的少报时为 true
          list: list,
          source: 'speechSynthesis.getVoices'
        };
      };
      var read = function () {
        var vs = ss.getVoices ? ss.getVoices() : [];
        return vs && vs.length ? pack(vs) : null;
      };
      var now = read();
      if (now) return now;
      // 用事件监听而不是覆盖 onvoiceschanged：后者会顶掉页面自己的处理函数
      return new Promise(function (res) {
        var done = false;
        var finish = function (v) { if (done) return; done = true; clearTimeout(t); try { ss.removeEventListener('voiceschanged', finish2); } catch (e) { } res(v); };
        var finish2 = function () { finish(read() || M('unsupported')); };
        var t = setTimeout(function () { finish(read() || M('unsupported')); }, 1500);
        try { ss.addEventListener('voiceschanged', finish2); } catch (e) { finish(read() || M('unsupported')); }
      });
    }, M('unsupported'));
  });

  // ============ fp · 22 项 ============
  function canvasData(env, txt) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    c.width = 320; c.height = 70;
    var x = c.getContext('2d');
    if (!x) return null;
    x.textBaseline = 'top';
    x.font = '16px "Arial"';
    x.fillStyle = '#f60'; x.fillRect(0, 0, 320, 70);
    x.fillStyle = '#069'; x.fillText(txt || 'Radish 指纹 Cwm fjordbank 😃 0123', 4, 4);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Radish 指纹 Cwm fjordbank 😃 0123', 8, 24);
    var g = x.createLinearGradient(0, 0, 320, 0);
    g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f');
    x.fillStyle = g; x.fillRect(0, 50, 320, 20);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = 'rgba(0,255,255,0.5)'; x.beginPath(); x.arc(180, 35, 24, 0, Math.PI * 2); x.fill();
    return c.toDataURL();
  }
  probe('canvas', function (env) {
    try { var d = canvasData(env); if (!d) return M('unsupported'); return hash(d).then(function (h) { return { h: h, len: d.length }; }); }
    catch (e) { return M('error'); }
  });
  probe('rand', function (env) {
    try {
      var a = canvasData(env, 'rand-A'), b = canvasData(env, 'rand-A'), c = canvasData(env, 'rand-B');
      // 三次绘制有一次没成，就没有"重复性"可言，不能硬报 same=false
      if (!a || !b || !c) return M('unreadable');
      return { same: a === b && a !== c };
    } catch (e) { return M('error'); }
  });
  function glInfoRaw(env) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return null;
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gl: gl,
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      sl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      ext: (gl.getSupportedExtensions() || []).length
    };
  }
  // webgl / gpu / glx / gpulim / hwid 都用这一份：一个页面里反复建上下文既慢，
  // 也可能拿到不同上下文导致前后读数不一致。
  // 抛错也要记住：这一轮后面再问就不再重试，但仍然把错误抛出去，
  // 让每个用到它的探针各自记 error（而不是被吞成 unsupported）。
  function memoThrow(env, key, raw) {
    var store = memoStore(env);
    if (key in store) {
      if (store[key] instanceof Error) throw store[key];
      return store[key];
    }
    try { return (store[key] = raw()); }
    catch (e) {
      store[key] = e instanceof Error ? e : new Error(String(e));
      throw store[key];
    }
  }
  function glInfo(env) { return memoThrow(env, 'gl', function () { return glInfoRaw(env); }); }
  probe('webgl', function (env) {
    try {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      return { vendor: i.vendor, renderer: i.renderer, unmaskedVendor: i.unmaskedVendor, unmaskedRenderer: i.unmaskedRenderer, version: i.version, sl: i.sl, ext: i.ext };
    } catch (e) { return M('error'); }
  });
  probe('audio', function (env) {
    // audio/2：保住压缩器指纹摘要（sum），另加一组**物理量交叉核对**：
    // 声明的采样率/帧数/声道数，与 OfflineAudioContext 真渲染出来的缓冲区是否自洽；
    // 实时 AudioContext 的状态、延迟、声道上限是不是在物理范围内。
    // 不一致项点名列出——那是"被改过或被模拟"的弱证据，但这里不下"是否伪装"的结论。
    var rt = null;
    try {
      var AC = env.OfflineAudioContext || env.webkitOfflineAudioContext;
      if (!AC) return M('unsupported');
      // 参数写死在 alg 里：振荡器类型、频率、是否过压缩器、采样率、帧数、取样步长，
      // 这样"数值变了"能分清是设备不同还是算法改了
      var RATE = 44100, STEP = 97, FREQ = 10000, FRAMES = 4500;   // 4500/44100 = 0.102s
      var off = new AC(1, FRAMES, RATE);
      var o = off.createOscillator(); o.type = 'triangle'; o.frequency.value = FREQ;
      var comp = off.createDynamicsCompressor();
      o.connect(comp); comp.connect(off.destination); o.start(0);
      // 实时上下文只用来读状态/延迟/声道上限（不播放、不采集声音），读完立刻 close。
      // 这些读数在**同步**阶段取完：finally 会先于 startRendering() 的 then 收尾。
      var RTA = env.AudioContext || env.webkitAudioContext;
      rt = RTA ? safe(function () { return new RTA(); }, null) : null;
      var rtChecks = [], offLat = safe(function () { return typeof off.baseLatency === 'number' ? off.baseLatency : null; }, null);
      rtChecks.push({ name: 'offlineBaseLatency', expected: null, actual: offLat, ok: offLat === null });
      if (rt) {
        var state = safe(function () { return rt.state; }, null);
        rtChecks.push({ name: 'realtimeState', expected: 'suspended|running|closed', actual: state, ok: state === 'suspended' || state === 'running' || state === 'closed' });
        var sr = safe(function () { return rt.sampleRate; }, null);
        rtChecks.push({ name: 'realtimeSampleRate', expected: '8000..384000', actual: sr, ok: typeof sr === 'number' && sr >= 8000 && sr <= 384000 });
        var bl = safe(function () { return typeof rt.baseLatency === 'number' ? num(rt.baseLatency, 6) : null; }, null);
        rtChecks.push({ name: 'baseLatency', expected: '0..1(s)', actual: bl, ok: typeof bl === 'number' && bl >= 0 && bl < 1 });
        var ol = safe(function () { return typeof rt.outputLatency === 'number' ? num(rt.outputLatency, 6) : null; }, null);
        // outputLatency 在没有出声时可能读不到：读不到不算不一致
        rtChecks.push({ name: 'outputLatency', expected: '0..2(s) or unread', actual: ol, ok: ol === null || (ol >= 0 && ol < 2) });
        var maxCh = safe(function () { return rt.destination && rt.destination.maxChannelCount; }, null);
        rtChecks.push({ name: 'maxChannelCount', expected: '>=1', actual: maxCh, ok: typeof maxCh === 'number' ? maxCh >= 1 : null });
      }
      return off.startRendering().then(function (buf) {
        var d = buf.getChannelData(0), s = 0, n = 0;
        for (var i = 0; i < d.length; i += STEP) { s += Math.abs(d[i]); n++; }
        var checks = [];
        function add(name, expected, actual, ok) { checks.push({ name: name, expected: expected, actual: actual, ok: ok }); }
        // 1) 声明的采样率是否就是渲染出来的采样率
        add('sampleRate', RATE, safe(function () { return buf.sampleRate; }, null), safe(function () { return buf.sampleRate === RATE; }, false));
        // 2) 帧数：长度必须是声明的帧数，duration 必须等于 frames/rate
        add('frames', FRAMES, safe(function () { return buf.length; }, null), safe(function () { return buf.length === FRAMES; }, false));
        add('duration', num(FRAMES / RATE, 6), safe(function () { return typeof buf.duration === 'number' ? num(buf.duration, 6) : null; }, null),
          safe(function () { return Math.abs(buf.duration - FRAMES / RATE) < 1e-3; }, false));
        // 3) 声道：单声道请求必须单声道渲染，数据长度必须 = 帧数
        add('channels', 1, safe(function () { return buf.numberOfChannels; }, null), safe(function () { return buf.numberOfChannels === 1; }, false));
        add('dataLength', FRAMES, safe(function () { return d.length; }, null), safe(function () { return d.length === FRAMES; }, false));
        for (var c = 0; c < rtChecks.length; c++) checks.push(rtChecks[c]);
        var mism = [];
        for (var k = 0; k < checks.length; k++) if (checks[k].ok === false) mism.push(checks[k].name);
        return {
          alg: 'audio/2', sum: num(s, 6), rate: RATE, freq: FREQ, step: STEP, frames: FRAMES, samples: n,
          checks: checks, mismatches: mism,
          scope: 'offline-triangle-comp + 采样率/帧数/声道/延迟 交叉核对；不一致不等于伪装'
        };
      });
    } catch (e) { return M('error'); }
    finally {
      // 释放实时音频上下文（不 close 会一直占着一个音频线程）
      try { if (rt && rt.state !== 'closed' && typeof rt.close === 'function') { var pr = rt.close(); if (pr && pr.catch) pr.catch(function () { }); } } catch (e1) { }
    }
  });
  // 每个函数按自己的签名取参数：atan2 要两个参数、pow 要底数和指数，
  // 之前一律塞 0.123456789，atan2 的第二参数变成 NaN，读数就没了意义。
  var MATH_CASES = [
    ['sin', 0.123456789], ['cos', 0.123456789], ['tan', 0.123456789],
    ['asin', 0.123456789], ['acos', 0.123456789], ['atan', 0.123456789],
    ['atan2', 1, 3], ['pow', 2, 0.5], ['exp', 0.123456789], ['log', 0.123456789],
    ['sqrt', 2], ['sinh', 0.123456789], ['cosh', 0.123456789], ['tanh', 0.123456789],
    ['expm1', 0.123456789], ['log1p', 0.123456789], ['cbrt', 2], ['atanh', 0.123456789]
  ];
  probe('mathfp', function (env) {
    try {
      var out = [];
      for (var i = 0; i < MATH_CASES.length; i++) {
        var c = MATH_CASES[i], f = Math[c[0]];
        out.push(c[0] + '(' + c.slice(1).join(',') + '):' + safe(function () { return f.apply(Math, c.slice(1)); }, '?'));
      }
      out.push('h32:' + Math.fround(1.1) + ':' + (0.1 + 0.2) + ':' + Math.hypot(3, 4) + ':' + Math.imul(0xffffffff, 5));
      // 有 NaN/Infinity 就说明输入或实现有问题，不当成正常指纹
      var joined = out.join('|');
      if (/NaN|Infinity/.test(joined)) return { alg: 'mathfp-2', bad: true, h: 'sha256:improper' };
      return hash(joined).then(function (h) { return { alg: 'mathfp-2', cases: MATH_CASES.length, h: h }; });
    } catch (e) { return M('error'); }
  });
  var FONT_PROBE = 'mmmmmmmmmmlli1|WQ@#ä';
  var FONT_BASE = ['monospace', 'sans-serif', 'serif'];
  var FONT_LIST = ['Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Meiryo', 'Microsoft YaHei', 'Microsoft JhengHei', 'MS Gothic', 'Palatino Linotype', 'Segoe UI', 'SimSun', 'NSimSun', 'SimHei', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Wingdings', 'Noto Sans', 'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans', 'Helvetica Neue', 'Roboto', 'Ubuntu', 'Cantarell', 'DejaVu Sans', 'Liberation Sans', 'Fira Sans', 'Menlo', 'Monaco', 'Consolas UI'];
  function fontDetectRaw(env) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    var x = c.getContext('2d');
    if (!x) return null;
    var base = {};
    for (var b = 0; b < FONT_BASE.length; b++) { x.font = '72px ' + FONT_BASE[b]; base[FONT_BASE[b]] = x.measureText(FONT_PROBE).width; }
    var found = [];
    for (var i = 0; i < FONT_LIST.length; i++) {
      for (var j = 0; j < FONT_BASE.length; j++) {
        x.font = '72px "' + FONT_LIST[i] + '",' + FONT_BASE[j];
        if (x.measureText(FONT_PROBE).width !== base[FONT_BASE[j]]) { found.push(FONT_LIST[i]); break; }
      }
    }
    return found;
  }
  // fontfp / fonts / hwid 共用一次扫描（45 个字体 × 3 个基准族）
  function fontDetect(env) { return memoThrow(env, 'fonts', function () { return fontDetectRaw(env); }); }
  probe('fontfp', function (env) { try { var f = fontDetect(env); return f ? hash(f.join(',')) : M('unsupported'); } catch (e) { return M('error'); } });
  probe('fonts', function (env) {
    // 命中数只有放在"测了多少种候选"旁边才有意义：样本命中不等于系统装了多少字体。
    try {
      var f = fontDetect(env);
      if (!f) return M('unsupported');
      return {
        list: f.slice(0, 200),
        hits: f.length,
        tested: FONT_LIST.length,
        truncated: f.length > 200,
        scope: '固定候选名单（' + FONT_LIST.length + ' 种）命中 ' + f.length + ' 种，不代表系统全部字体'
      };
    } catch (e) { return M('error'); }
  });
  probe('emoji', function (env) {
    // 原来把"能画出第几版 emoji"当成 emoji 字体版本号返回，那是个伪造的版本；
    // 现在只报能验证的东西：拿缺字符（U+FFFF）和确定存在的 CJK 字做双重基线，
    // 逐个判定这些码位是被彩色字体画出、被普通字体画出、还是豆腐块。
    try {
      var doc = env.document, c = doc.createElement('canvas'), x = c.getContext('2d');
      if (!x) return M('unsupported');
      var FONT = '32px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      x.font = FONT;
      var missing = x.measureText('\uFFFF').width;
      var cjk = x.measureText('\u4e2d').width;
      if (!missing && !cjk) return M('unreadable');
      var marks = { '13.0': '\u{1F972}', '14.0': '\u{1FAE0}', '15.0': '\u{1FAF8}', '15.1': '\u{1F34B}\u200D\u{1F7E9}', '16.0': '\u{1FABE}' };
      var drawn = [], tofu = [];
      for (var k in marks) {
        var w = x.measureText(marks[k]).width;
        if (!w) continue;
        if (Math.abs(w - missing) < 0.01 && Math.abs(missing - cjk) > 0.01) tofu.push(k);
        else if (w > 0) drawn.push(k);
      }
      return { alg: 'glyph-multibaseline', ref: { missing: num(missing, 2), cjk: num(cjk, 2) }, drawn: drawn, tofu: tofu };
    } catch (e) { return M('error'); }
  });
  // ---------- 临时 DOM 的统一清理 ----------
  // 复审要求：新增的 DOM 在异常路径上也不能留在文档里。所有临时元素都走 drop()，
  // 且调用点一律写在 finally 里。先试 remove()（现代 API），再试 body.removeChild()
  // （老实现与替身环境），两条都失败也不抛——清理失败不能反过来把整项读成 error。
  function drop(env, el) {
    if (!el) return;
    try { if (typeof el.remove === 'function') { el.remove(); } } catch (e) { }
    try { if (env && env.document && env.document.body) env.document.body.removeChild(el); } catch (e2) { }
  }
  function mount(env, el) {
    try { env.document.body.appendChild(el); } catch (e) { }
    return el;
  }
  function rectOf(r) {
    if (!r) return null;
    var x = r.x !== undefined ? r.x : r.left, y = r.y !== undefined ? r.y : r.top;
    return { w: num(r.width, 4), h: num(r.height, 4), x: num(x, 4), y: num(y, 4) };
  }

  // domrect/2：多种变换各取一组 rect，另加 Range 的 rects（参考实现同样用 Range 与多变换）
  var DOMRECT_TRANSFORMS = [
    ['rotate', 'transform:rotate(7.3deg)'],
    ['scale', 'transform:scale(1.137)'],
    ['skew', 'transform:skewX(3deg) skewY(-1.7deg)'],
    ['matrix3d', 'transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,11.5,3.25,0,1)']
  ];
  probe('domrect', function (env) {
    // 接口不在 → unsupported；接口在但读的时候抛错 → error。两条不能混
    var doc = env.document;
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return M('unsupported');
    try {
      var base = 'position:absolute;left:-9999px;top:0;width:137.5px;height:43.25px;border:1px solid #000;padding:2.5px;';
      var items = {}, parts = [], ranges = M('unsupported');
      {
        for (var i = 0; i < DOMRECT_TRANSFORMS.length; i++) {
          var d = mount(env, doc.createElement('div'));
          try {
            d.style.cssText = base + DOMRECT_TRANSFORMS[i][1];
            var r = rectOf(d.getBoundingClientRect());
            var rs = d.getClientRects ? d.getClientRects() : null;
            var one = { w: r ? r.w : null, h: r ? r.h : null, x: r ? r.x : null, y: r ? r.y : null, rects: rs ? rs.length : null };
            items[DOMRECT_TRANSFORMS[i][0]] = one;
            parts.push([one.w, one.h, one.x, one.y, one.rects].join(','));
          } finally { drop(env, d); }
        }
        // Range 是另一条取几何的路：选择一段文字（含中文与 emoji），它的 rects 与元素的不一定相同
        var rg = null;
        if (typeof doc.createRange === 'function') {
          var host = mount(env, doc.createElement('div'));
          try {
            host.style.cssText = base + 'width:max-content;font:16px serif;';
            try { host.textContent = 'Cwm fjordbank 你是谁 \u{1F603}'; } catch (e0) { }
            rg = doc.createRange();
            try { rg.selectNodeContents(host); } catch (e1) { }
            var rr = rectOf(rg.getBoundingClientRect());
            var rl = rg.getClientRects ? rg.getClientRects() : null;
            ranges = {
              w: rr ? rr.w : null, h: rr ? rr.h : null,
              rects: rl ? rl.length : null,
              text: safe(function () { return String(host.textContent || '').length; }, null)
            };
            parts.push([ranges.w, ranges.h, ranges.rects].join(','));
          } finally { drop(env, host); }
        }
        var text = parts.join('|');
        return hash(text).then(function (h) {
          return {
            alg: 'domrect/2', h: h, items: items, ranges: ranges,
            scope: 'absolute off-screen, 137.5x43.25 + 2.5px padding + 1px border, 四种 transform 各一组'
          };
        });
      }
    } catch (e) { return M('error'); }
  });
  // svgrect/2：SVG 例外地放进离屏容器（position:absolute;left:-9999px、宽高 0、裁剪），
  // 既不进正常流也不影响页面布局；同时取 getBBox() 与 getComputedTextLength()。
  probe('svgrect', function (env) {
    var doc = env.document;
    if (!doc || !doc.body || typeof doc.createElementNS !== 'function') return M('unsupported');
    var NS = 'http://www.w3.org/2000/svg';
    var wrap = null;
    try {
      wrap = mount(env, doc.createElement('div'));
      wrap.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;';
      var svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('width', '137.5'); svg.setAttribute('height', '43.25');
      var t = doc.createElementNS(NS, 'text');
      t.setAttribute('x', '3.25'); t.setAttribute('y', '17.75');
      t.setAttribute('font-size', '13.5');
      try { t.textContent = 'Radish 指纹 Cwm fjordbank'; } catch (e0) { t.setAttribute('text', 'x'); }
      try { svg.appendChild(t); wrap.appendChild(svg); } catch (e1) { }
      var b = safe(function () { return t.getBBox(); }, null);
      var box = b ? { x: num(b.x, 4), y: num(b.y, 4), w: num(b.width, 4), h: num(b.height, 4) } : null;
      var len = safe(function () { return num(t.getComputedTextLength(), 4); }, null);
      var chars = safe(function () { return typeof t.getNumberOfChars === 'function' ? t.getNumberOfChars() : null; }, null);
      var sub = safe(function () { return typeof t.getSubStringLength === 'function' ? num(t.getSubStringLength(0, 10), 4) : null; }, null);
      var vr = rectOf(safe(function () { return svg.getBoundingClientRect(); }, null));
      var parts = [box ? [box.x, box.y, box.w, box.h].join(',') : 'na', len, chars, sub, vr ? [vr.w, vr.h].join(',') : 'na'].join('|');
      return hash(parts).then(function (h) {
        return {
          alg: 'svgrect/2', h: h,
          box: box, textLength: len, chars: chars, subLength: sub,
          viewport: vr ? { w: vr.w, h: vr.h } : null,
          scope: 'off-screen zero-size wrapper; fontSize 13.5; 同一段文字一次取全'
        };
      });
    } catch (e) { return M('error'); }
    finally { drop(env, wrap); }
  });
  // textm/2：多字体 × 多字符串，取 measureText 的宽度与四边包围盒，并给出跨字体差分。
  var TEXTM_FONTS = ['17.5px Arial', '17.5px monospace', '17.5px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'];
  var TEXTM_STRINGS = ['Cwm fjordbank glyphs vext quiz', '0123456789 1ms Wi-Fi', '博客指纹 你好世界 \u{1F603}'];
  probe('textm', function (env) {
    var doc = env.document;
    if (!doc || typeof doc.createElement !== 'function') return M('unsupported');
    try {
      var c = doc.createElement('canvas'), x = c.getContext ? c.getContext('2d') : null;
      if (!x || typeof x.measureText !== 'function') return M('unsupported');
      var items = {}, parts = [], perFont = [];
      for (var i = 0; i < TEXTM_FONTS.length; i++) {
        var font = TEXTM_FONTS[i], rows = {}, sum = 0, got = 0;
        for (var j = 0; j < TEXTM_STRINGS.length; j++) {
          x.font = font;
          var m = null;
          try { m = x.measureText(TEXTM_STRINGS[j]); } catch (e) { m = null; }
          if (!m) continue;
          var row = {
            w: num(m.width, 3),
            ascent: num(m.actualBoundingBoxAscent, 3),
            descent: num(m.actualBoundingBoxDescent, 3),
            left: num(m.actualBoundingBoxLeft, 3),
            right: num(m.actualBoundingBoxRight, 3)
          };
          rows['s' + (j + 1)] = row;
          parts.push([font, row.w, row.ascent, row.descent, row.left, row.right].join(','));
          if (row.w !== null) { sum += row.w; got++; }
        }
        items[font] = rows;
        perFont.push({ font: font, meanW: got ? num(sum / got, 3) : null, n: got });
      }
      // 跨字体差分：同一串文字在不同字体族下的宽度差，比单个绝对值更能分开系统
      var diff = [];
      if (perFont.length > 1 && perFont[0].meanW !== null && perFont[perFont.length - 1].meanW !== null) {
        diff.push(num(perFont[0].meanW - perFont[perFont.length - 1].meanW, 3));
      }
      if (!parts.length) return M('unreadable');
      return hash(parts.join('|')).then(function (h) {
        return {
          alg: 'textm/2', h: h,
          items: items, fonts: perFont, diff: diff,
          scope: '3 个字体族 × 3 个字符串；width 与 actualBoundingBox 四边；diff=各族平均宽之差'
        };
      });
    } catch (e) { return M('error'); }
  });
  // glimg/2：片元按坐标出非恒定图案，采样区按设备上限取（≥32×32，优先 64×64），
  // 所有 GPU 资源在 finally 里释放（含 WEBGL_lose_context）。
  probe('glimg', function (env) {
    var gl = null, pr = null, vs = null, fs = null, buf = null, lost = null;
    try {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      gl = i.gl;
      var MAXD = safe(function () { return gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || gl.getParameter(gl.MAX_TEXTURE_SIZE); }, 0) || 0;
      var side = MAXD && MAXD < 64 ? (MAXD >= 32 ? 32 : 16) : 64;   // 设备上限小就退到 32/16，并如实记录
      gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}');
      gl.compileShader(vs);
      fs = gl.createShader(gl.FRAGMENT_SHADER);
      // 非恒定：坐标进正弦与 fract，每条像素都不一样，压缩/降精度/舍入差都留得下痕迹
      gl.shaderSource(fs, 'precision mediump float;varying vec2 v;void main(){gl_FragColor=vec4(sin(v.x*9.7)*.5+.5,cos(v.y*7.3)*.5+.5,fract(v.x*v.y*37.1),1.);}');
      gl.compileShader(fs);
      pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return M('unsupported');
      gl.useProgram(pr);
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.8, 0.85, -0.7, -0.1, 0.95]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var px = new Uint8Array(side * side * 4);
      gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var sum = 0, nonzero = 0;
      for (var k = 0; k < px.length; k++) { sum += px[k]; if (px[k]) nonzero++; }
      var vals = [];
      for (var q = 0; q < px.length; q++) vals.push(px[q]);
      return hash(vals.join(',')).then(function (h) {
        return { alg: 'glimg/2', h: h, side: side, bytes: px.length, sum: sum, nonzero: nonzero, scope: 'coordinate-driven fragment, square read-back from origin' };
      });
    } catch (e) { return M('error'); }
    finally {
      // 释放顺序按依赖关系：程序 → 着色器 → 缓冲 → 上下文；lose_context 放最后
      try { if (gl && pr) gl.deleteProgram(pr); } catch (e1) { }
      try { if (gl && vs) gl.deleteShader(vs); } catch (e2) { }
      try { if (gl && fs) gl.deleteShader(fs); } catch (e3) { }
      try { if (gl && buf) gl.deleteBuffer(buf); } catch (e4) { }
      try { lost = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context'); if (lost && lost.loseContext) lost.loseContext(); } catch (e5) { }
    }
  });
  probe('keys', function (env) {
    // 引擎接口数（keys/2）：四/五种**不同含义**的计数各归各。旧实现把
    // Object.keys(window)（可枚举全局，含站点脚本自己加的键）与
    // getComputedStyle().length（CSS 属性条数）并排返回，名字却像同一件事，
    // 谁也没法核对。现在每一项都带"范围"与取法，旧字段 window/html/css 语义不动。
    return safe(function () {
      var out = { window: Object.keys(env).length, scope: 'globals-enumerable' };
      var items = {
        'enumerable-globals': { n: out.window, how: 'Object.keys(window)', note: '含站点脚本自己加的键，风格线索不是版本读数' }
      };
      items['own-property-names'] = {
        n: safe(function () { return Object.getOwnPropertyNames(env).length; }, null),
        how: 'Object.getOwnPropertyNames(window)',
        note: '含不可枚举的内建接口（WebGL2RenderingContext 之类），与可枚举计数不可互换'
      };
      try { out.html = Object.keys(env.HTMLElement.prototype).length; } catch (e) { out.html = null; }
      items['HTMLElement.prototype'] = {
        n: safe(function () { return Object.getOwnPropertyNames(env.HTMLElement.prototype).length; }, null),
        how: 'Object.getOwnPropertyNames(HTMLElement.prototype)',
        note: '元素接口的方法与访问器；旧 html 字段是可枚举子集'
      };
      items['CSS'] = {
        n: safe(function () { return env.CSS ? Object.getOwnPropertyNames(env.CSS).length : null; }, null),
        how: 'Object.getOwnPropertyNames(CSS)',
        note: 'CSS 命名空间对象（supports/escape/…），不是 CSS 属性条数'
      };
      try { out.css = env.CSS && env.CSS.supports ? 1 : 0; } catch (e) { out.css = null; }
      // 旧 css 的真实语义：一张元素上 getComputedStyle 的属性条数。单独记，别和上面混。
      try {
        var doc = env.document;
        if (doc && typeof doc.createElement === 'function') {
          var d = mount(env, doc.createElement('div'));
          try {
            var cs = env.getComputedStyle ? env.getComputedStyle(d) : null;
            out.css = cs ? cs.length : out.css;
          } finally { drop(env, d); }
        }
      } catch (e) { }
      items['computed-style-properties'] = { n: typeof out.css === 'number' ? out.css : null, how: 'getComputedStyle(div).length', note: '旧 css 字段就是这一项' };
      out.alg = 'keys/2';
      out.items = items;
      return out;
    }, M('unsupported'));
  });
  probe('timer', function (env) {
    try {
      var p = env.performance;
      if (!p || !p.now) return M('unsupported');
      var best = 1, seen = 0;
      for (var i = 0; i < 20000 && seen < 64; i++) {
        var a = p.now(), b = p.now();
        if (b > a) { var d = b - a; if (d > 0 && d < best) best = d; seen++; }
      }
      var nowc = p.now();
      if (!seen) {
        return {
          res: M('unreadable'), now: num(nowc, 3),
          jitter: null, minPositiveMs: null, maxPositiveMs: null, samples: 0
        };
      }
      // A-11：连续两次读数的正间隔分两个字段记，名字和统计量必须对得上。
      // 旧实现取的是**最小**正间隔，注释却写成"最大间隔"，读的人会按上限理解。
      // 现在 minPositiveMs / maxPositiveMs 各是各的；jitter 保留给 1.8.x 的消费者，
      // 它就是 maxPositiveMs（与旧注释声称的语义一致）。测不到就给 null，不写假的 0。
      var last = null, minGap = null, maxGap = null;
      for (var j = 0; j < 2000; j++) {
        var v = p.now();
        if (last !== null) {
          var gap = v - last;
          if (gap > 0) {
            if (minGap === null || gap < minGap) minGap = gap;
            if (maxGap === null || gap > maxGap) maxGap = gap;
          }
        }
        last = v;
      }
      return {
        res: num(best, 6),
        now: num(nowc, 3),
        jitter: maxGap === null ? null : num(maxGap, 6),        // = maxPositiveMs（兼容字段）
        minPositiveMs: minGap === null ? null : num(minGap, 6),
        maxPositiveMs: maxGap === null ? null : num(maxGap, 6),
        samples: seen
      };
    } catch (e) { return M('error'); }
  });
  var CALLSTACK_LIMIT = 30000;
  probe('callstack', function () {
    // 返回对象而不是裸数字：达到上限时那是个被截断的值，不能当成引擎上限读数
    try {
      var n = 0;
      function r() { n++; if (n < CALLSTACK_LIMIT) r(); }
      try { r(); } catch (e) { }
      return { depth: n, limit: CALLSTACK_LIMIT, truncated: n >= CALLSTACK_LIMIT };
    } catch (e) { return M('error'); }
  });
  probe('engine', function (env) {
    // 两件事分开记：JS 引擎用异常措辞实测（上游方法），渲染内核只能从品牌／UA 推。
    // 原来只有后半句，名字叫 engine 却没有一句实测证据。
    return safe(function () {
      var js = 'unknown';
      try { null.x; } catch (e) {
        var msg = String(e && e.message || '');
        if (/Cannot read propert/.test(msg)) js = 'v8';
        else if (/has no properties|is null/.test(msg)) js = 'spidermonkey';
        else if (/null is not an object|undefined is not an object/.test(msg)) js = 'javascriptcore';
      }
      if (js === 'unknown') {
        // 兜底：换一种写法再问一次（不同引擎措辞不同）
        try { (void 0).x; } catch (e2) {
          var m2 = String(e2 && e2.message || '');
          if (/Cannot read propert/.test(m2)) js = 'v8';
          else if (/has no properties/.test(m2)) js = 'spidermonkey';
          else if (/not an object/.test(m2)) js = 'javascriptcore';
        }
      }
      var ua = env.navigator.userAgent || '';
      var render = 'unknown';
      if (/Firefox|FxiOS/.test(ua)) render = 'Gecko';
      else if (/Edg|EdgiOS|EdgA|Chrome|CriOS|Chromium/.test(ua)) render = 'Blink';
      else if (/Safari/.test(ua)) render = 'WebKit';
      if (js === 'unknown' && render === 'unknown') return M('unreadable');
      return { js: js, render: render, basis: 'error-message+ua' };
    }, M('unsupported'));
  });
function declaredVersion(env) {
  function fromUa() {
    var ua = env.navigator.userAgent || '', m;
    for (var i = 0; i < BROWSER_RULES.length; i++) {
      m = ua.match(BROWSER_RULES[i][0]);
      if (m) return m[1];                     // 这里要的是版本号，不是名字
    }
    return M('unsupported');
  }
  var uad = uaData(env);
  if (!uad || !uad.getHighEntropyValues) return safe(fromUa, M('unsupported'));
  return chHigh(env).then(function (v) {
    var list = (v && v.fullVersionList) || [];
    var brand = brandOf(env);
    var prefer = brand ? { Edge: /Microsoft Edge/i, Opera: /Opera/i, Chrome: /Google Chrome|Chromium/i }[brand.name] : null;
    for (var i = 0; i < list.length; i++) {
      var b = String((list[i] || {}).brand || '');
      if (prefer && prefer.test(b) && list[i].version) return list[i].version;
    }
    for (var j = 0; j < list.length; j++) {
      if (/Chromium|Google Chrome|Microsoft Edge|Firefox/.test(String((list[j] || {}).brand || '')) && list[j].version) return list[j].version;
    }
    return fromUa();
  }).catch(function () { return safe(fromUa, M('unsupported')); });
}

  // 一次特性扫描，engver / fpid / shield 都用这一份（一轮只读一遍引擎特性）
  function engineFeatures(env) {
    return memo(env, 'jsfeat', function () {
      var items = {}, supported = [], missing = [], floor = null, ceil = null, newest = null, oldest = null, years = {};
      for (var i = 0; i < JS_FEATURES.length; i++) {
        var row = JS_FEATURES[i], ok = false;
        try {
          ok = !!row[3](env);
        } catch (e) {
          ok = false;
        }
        items[row[0]] = { ok: ok, min: row[1], year: row[2] };
        if (ok) {
          supported.push(row[0]);
          if (floor === null || row[1] > floor) { floor = row[1]; newest = row[0]; }
          if (oldest === null || row[1] < oldest) oldest = row[1];
        } else {
          missing.push(row[0]);
          // 上限 = 未支持特性里最低的版本减一（参考实现的 hi）；全都支持时没有上限
          if (ceil === null || row[1] - 1 < ceil) ceil = row[1] - 1;
        }
      }
      years = { floor: floor === null ? null : supportedYear(items, floor), ceiling: ceil === null ? null : supportedYear(items, ceil, true) };
      return {
        items: items, supported: supported, missing: missing,
        floor: floor, ceiling: ceil === null ? null : ceil, newest: newest, oldest: oldest, year: years
      };
    });
  }
  function supportedYear(items, version, nearest) {
    // 把"版本"翻译成年份：同一版本档里取该特性的 year；nearest 时取 <= version 的最大档（上限可能落在两条之间）
    var best = null;
    for (var k in items) {
      var row = items[k];
      if (nearest) { if (row.min <= version && (best === null || row.year > best)) best = row.year; }
      else if (row.min === version) best = best === null ? row.year : Math.max(best, row.year);
    }
    return best;
  }

  probe('engver', function (env) {
    // 两层：声明版本（UA／高熵品牌，能被改写）+ 特性区间（引擎跑得了什么，改不了）。
    // 区间是两头：下限 = 已支持特性里最高的版本，上限 = 未支持特性里最低的版本减一。
    // 只有下限时那是"至少这么新"；上限 < 下限本身也是矛盾信号（引擎特性不该这么组合）。
    return safe(function () {
      function build(declared) {
        var fx = engineFeatures(env);
        return {
          alg: 'feature-floor/2',
          declared: typeof declared === 'string' && declared ? declared : null,
          supported: fx.supported.length,
          total: JS_FEATURES.length,
          floor_chromium: fx.floor,
          ceiling_chromium: fx.ceiling,
          floor_year: fx.year.floor,
          ceiling_year: fx.year.ceiling,
          newest: fx.newest,
          items: fx.items,
          basis: 'feature-min-chromium+ceiling-from-missing'
        };
      }
      var declared = safe(function () { return declaredVersion(env); }, null);
      if (declared && typeof declared.then === 'function') {
        return declared.then(build).catch(function () { return build(null); });
      }
      return build(declared);
    }, M('unsupported'));
  });
  // lies/2：本页 + 一个离屏、同源、没有脚本的干净 iframe 的**跨上下文**对照。
  // 改写只发生在页面里的脚本不会动到新开文档的原生函数，所以两边的字符串一旦不同，
  // 就是"本页被改过"的直接证据；两边都还说 [native code] 时不能凭"读不到"下结论。
  // 同样重要的是 getter/prototype：原生访问器没有自己的 prototype，且拒绝陌生 this。
  var LIE_FNS = [
    ['Function.prototype.toString', function (env) { return Function.prototype.toString; }],
    ['fetch', function (env) { return env.fetch || (typeof fetch === 'function' ? fetch : null); }],
    ['setTimeout', function (env) { return env.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null); }],
    ['HTMLCanvasElement.prototype.toDataURL', function (env) { return pick(env, 'HTMLCanvasElement', 'toDataURL'); }],
    ['CanvasRenderingContext2D.prototype.getImageData', function (env) { return pick(env, 'CanvasRenderingContext2D', 'getImageData'); }],
    ['CanvasRenderingContext2D.prototype.measureText', function (env) { return pick(env, 'CanvasRenderingContext2D', 'measureText'); }],
    ['WebGLRenderingContext.prototype.getParameter', function (env) { return pick(env, 'WebGLRenderingContext', 'getParameter'); }],
    ['WebGLRenderingContext.prototype.readPixels', function (env) { return pick(env, 'WebGLRenderingContext', 'readPixels'); }],
    ['AudioBuffer.prototype.getChannelData', function (env) { return pick(env, 'AudioBuffer', 'getChannelData'); }],
    ['OfflineAudioContext.prototype.startRendering', function (env) { return pick(env, 'OfflineAudioContext', 'startRendering'); }],
    ['Date.prototype.getTimezoneOffset', function (env) { return Date.prototype.getTimezoneOffset; }],
    ['Math.random', function (env) { return Math.random; }],
    ['Element.prototype.getBoundingClientRect', function (env) { return pick(env, 'Element', 'getBoundingClientRect'); }],
    ['Range.prototype.getClientRects', function (env) { return pick(env, 'Range', 'getClientRects'); }]
  ];
  var LIE_GETTERS = [['userAgent'], ['platform'], ['languages'], ['hardwareConcurrency'],
    ['deviceMemory'], ['webdriver'], ['plugins'], ['vendor']];
  function pick(env, holder, prop) {
    return safe(function () {
      var o = env[holder];
      if (!o || !o.prototype) return null;
      var d = Object.getOwnPropertyDescriptor(o.prototype, prop);
      return d && typeof d.value === 'function' ? d.value : null;
    }, null);
  }
  probe('lies', function (env) {
    return safe(function () {
      var doc = env.document, nav = env.navigator || {};
      var pageFn = Function.prototype.toString;
      var NATIVE = /\{\s*\[native code\]\s*\}\s*$/;
      var list = [], items = [], readings = [];
      var ctxState = 'unsupported', ctxWhy = 'no-document', frameWin = null, frame = null, frameSrc = null;

      // 一个空 iframe：同源、没有 srcdoc 也没有任何脚本，用完就摘掉
      try {
        if (doc && typeof doc.createElement === 'function') {
          frame = doc.createElement('iframe');
          if (frame) {
            try {
              frame.setAttribute('aria-hidden', 'true');
              frame.setAttribute('tabindex', '-1');
              frame.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden';
            } catch (e0) { }
            mount(env, frame);
            frameWin = safe(function () { return frame.contentWindow; }, null);
            var cand = safe(function () { return frameWin && frameWin.Function && frameWin.Function.prototype.toString; }, null);
            if (typeof cand === 'function') { frameSrc = cand; ctxState = 'iframe'; ctxWhy = 'same-origin-blank'; }
            // 有 iframe 但没有可用的同源窗口（跨源、CSP 拦下、或这环境根本没有 iframe）：
            // 如实记 unsupported，绝不因此判成"被篡改"
            else { ctxState = 'unsupported'; ctxWhy = frameWin ? 'no-frame-realm' : 'no-contentWindow'; }
          } else { ctxWhy = 'no-iframe-element'; }
        }
      } catch (e1) { ctxState = 'unsupported'; ctxWhy = 'iframe-threw'; }

      function scrub(fn) {
        var page = null, inFrame = null;
        try { page = String(pageFn.call(fn)); } catch (e) { page = null; }
        // 跨 realm 的函数用**对方的**toString 检查：本页的 toString 本身可能就是被改的那个
        try { if (frameSrc) inFrame = String(frameSrc.call(fn)); } catch (e2) { inFrame = null; }
        return { page: page, frame: inFrame };
      }
      function addOne(k, fn) {
        if (typeof fn !== 'function') return;
        var s = scrub(fn);
        var pageOk = s.page === null ? null : NATIVE.test(s.page);
        var frameOk = s.frame === null ? null : NATIVE.test(s.frame);
        var same = (s.page !== null && s.frame !== null) ? (s.page === s.frame) : null;
        var ownProto = safe(function () { return Object.prototype.hasOwnProperty.call(fn, 'prototype'); }, null);
        items.push({ k: k, page: pageOk, frame: frameOk, same: same, proto: ownProto });
        if (pageOk === false) list.push(k);
        else if (pageOk === true && frameOk === true && same === false) list.push(k + ':page≠frame');
        if (ownProto === true) list.push(k + ':own-prototype');
      }
      try {
        for (var i = 0; i < LIE_FNS.length; i++) {
          var getFn = LIE_FNS[i][1];
          addOne(LIE_FNS[i][0], safe(function () { return getFn(env); }, null));
        }
      } catch (e3) { }
      // Function.prototype.toString.toString() 被改时，上面那条 also 会红；这里单独留一条读数
      items.push({ k: 'toString.toString', page: safe(function () { return NATIVE.test(String(pageFn.call(pageFn))); }, null), frame: null, same: null, proto: null });

      // getter：字符串要是 [native code]、没有自己的 prototype、且拒绝陌生 this
      var navProto = safe(function () { return Object.getPrototypeOf(nav); }, null);
      var getterRows = [];
      for (var g = 0; g < LIE_GETTERS.length; g++) {
        var prop = LIE_GETTERS[g][0];
        var d = safe(function () { return navProto ? Object.getOwnPropertyDescriptor(navProto, prop) : null; }, null);
        if (!d || typeof d.get !== 'function') { getterRows.push({ k: 'navigator.' + prop, state: 'absent' }); continue; }
        var gs = scrub(d.get);
        var gPage = gs.page === null ? null : NATIVE.test(gs.page);
        var gFrame = gs.frame === null ? null : NATIVE.test(gs.frame);
        var refuses = safe(function () { try { d.get.call(Object.create(navProto)); return false; } catch (e) { return true; } }, null);
        getterRows.push({
          k: 'navigator.' + prop, get: gPage, frame: gFrame,
          same: (gs.page !== null && gs.frame !== null) ? gs.page === gs.frame : null,
          stranger: refuses
        });
        if (gPage === false) list.push('navigator.' + prop + ':getter');
        if (refuses === false) list.push('navigator.' + prop + ':accepts-stranger');
      }

      // 读数对照：本页说一套、同源空 iframe 说另一套，就是改写
      if (ctxState === 'iframe' && frameWin) {
        var pairs = [
          ['userAgent', function (w) { return w.navigator && w.navigator.userAgent; }],
          ['platform', function (w) { return w.navigator && w.navigator.platform; }],
          ['languages', function (w) { return w.navigator && (w.navigator.languages || []).join(','); }],
          ['hardwareConcurrency', function (w) { return w.navigator && w.navigator.hardwareConcurrency; }],
          ['deviceMemory', function (w) { return w.navigator && w.navigator.deviceMemory; }],
          ['screen', function (w) { return w.screen && (w.screen.width + 'x' + w.screen.height); }],
          ['timeZone', function (w) { return safe(function () { return w.Intl.DateTimeFormat().resolvedOptions().timeZone; }, null); }],
          ['timezoneOffset', function (w) { return safe(function () { return new w.Date().getTimezoneOffset(); }, null); }]
        ];
        for (var p = 0; p < pairs.length; p++) {
          var readIt = pairs[p][1];
          var a = safe(function () { return readIt(env); }, null);
          var b = safe(function () { return readIt(frameWin); }, null);
          var ok = (a === undefined || a === null || b === undefined || b === null) ? null : String(a) === String(b);
          readings.push({ k: pairs[p][0], page: cap1(a), frame: cap1(b), same: ok });
          if (ok === false) list.push('frame≠' + pairs[p][0]);
        }
        // navigator 上的自有属性名集合：Chrome 有一批 [LegacyUnforgeable] 属性本来就在实例上，
        // 所以不比"有没有"，只比两边的**集合是否一致**——本页多出一个/少一个才是改写。
        var ownA = safe(function () { return Object.getOwnPropertyNames(env.navigator).sort().join(','); }, null);
        var ownB = safe(function () { return Object.getOwnPropertyNames(frameWin.navigator).sort().join(','); }, null);
        if (ownA !== null && ownB !== null) {
          readings.push({ k: 'navigator.own', page: ownA.split(',').length, frame: ownB.split(',').length, same: ownA === ownB });
          if (ownA !== ownB) list.push('frame≠navigator.own');
        }
      }
      drop(env, frame);        // 先摘掉 iframe，再做下面的本页检查（顺序无关，但别把窗口留着）

      // 本页自身的几条结构线索（与上面跨上下文检查互不替代）
      try { if (pluginsContradiction(env)) list.push('plugins-empty-pdf-conflict'); } catch (e4) { }
      try { if (nav.webdriver === true) list.push('webdriver-true'); } catch (e5) { }
      try { if (!('languages' in nav) || !Object.getOwnPropertyDescriptor(navProto || {}, 'languages')) list.push('languages-missing'); } catch (e6) { }

      var uniq = [];
      for (var u = 0; u < list.length; u++) if (uniq.indexOf(list[u]) < 0) uniq.push(list[u]);
      return {
        alg: 'lies/2', ctx: ctxState, why: ctxWhy, n: items.length,
        list: uniq.slice(0, 40),
        items: items, getters: getterRows, readings: readings,
        basis: 'native-code+own-prototype+stranger-getter; page vs clean iframe',
        scope: ctxState === 'iframe' ? '本页 + 同源空 iframe（无脚本）' : '只有本页（iframe 不可用，跨上下文部分记 unsupported）'
      };
    }, M('unsupported'));
  });
  function cap1(v) {
    if (v === null || v === undefined) return null;
    var s = String(v);
    return s.length > 40 ? s.slice(0, 40) : s;
  }
  // cssv/2：逐特性真值 + 该特性首次可用的版本/年份。CSS.supports 只答"这条声明认不认"，
  // @layer 与嵌套是 at-rule/选择器语法，得塞进样式表再数 cssRules，两种测法分开记。
  function cssSheetRules(env, text) {
    var doc = env.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    var st = null;
    try {
      st = mount(env, doc.createElement('style'));
      st.textContent = text;
      var sheet = st.sheet || st.styleSheet || null;
      if (!sheet) return null;
      var rules = sheet.cssRules || sheet.rules || null;
      if (!rules) return null;
      var top = rules.length;
      var nested = 0;
      if (top && rules[0] && rules[0].cssRules) nested = rules[0].cssRules.length;
      return { top: top, nested: nested };
    } catch (e) { return null; } finally { drop(env, st); }
  }
  probe('cssv', function (env) {
    return safe(function () {
      var NS = env.CSS || null, S = NS && NS.supports;
      if (typeof S !== 'function') return M('unsupported');
      var items = {}, supported = [], missing = [], unreadable = [], newestYear = null, newest = null;
      for (var i = 0; i < CSSV_FEATURES.length; i++) {
        var row = CSSV_FEATURES[i], ok = null, q = row[4];
        if (row[3] === 'parse') {
          // @layer / 嵌套选择器：CSS.supports 问不出来，塞进样式表数 cssRules
          var sh = cssSheetRules(env, q);
          if (sh !== null) ok = row[0] === 'nesting' ? sh.nested > 0 : sh.top > 0;
        } else {
          // 单参形式 CSS.supports('display:grid')；问不出来（抛错）记 null，不记 false
          ok = safe(function () { return !!S.call(NS, q); }, null);
        }
        if (ok === null) { unreadable.push(row[0]); items[row[0]] = { supported: null, sinceYear: row[2], min: row[1] }; continue; }
        items[row[0]] = { supported: !!ok, sinceYear: row[2], min: row[1] };
        if (ok) {
          supported.push(row[0]);
          if (newestYear === null || row[2] > newestYear) { newestYear = row[2]; newest = row[0]; }
        } else missing.push(row[0]);
      }
      return {
        alg: 'cssv/2',
        items: items,
        supported: supported.length,
        total: CSSV_FEATURES.length,
        newestYear: newestYear, newest: newest,
        missing: missing, unreadable: unreadable,
        basis: 'CSS.supports + stylesheet-parse; 版本/年份来自 Chromium 发布档（Chrome 平台状态 / MDN 基线，2024-11 核对）'
      };
    }, M('unsupported'));
  });
  probe('smooth', function (env) {
    // 参考实现的语义：一段文字画进画布，数灰度像素与彩色像素——彩色说明系统在做
    // 次像素抗锯齿，纯灰度说明只做灰度平滑，全黑全白说明根本没用字体平滑。
    // 旧实现返回的 measureText 宽度是排版度量，和"平滑"没有关系。
    return safe(function () {
      var doc = env.document;
      if (!doc || typeof doc.createElement !== 'function') return M('unsupported');
      var c = doc.createElement('canvas');
      c.width = 140;
      c.height = 30;
      var x = c.getContext && c.getContext('2d', { alpha: false });
      if (!x || typeof x.getImageData !== 'function') return M('unsupported');
      x.fillStyle = '#fff';
      x.fillRect(0, 0, 140, 30);
      x.fillStyle = '#000';
      x.font = '16px sans-serif';
      x.fillText('Wwg ii 你好 Ma', 2, 21);
      var d = x.getImageData(0, 0, 140, 30).data;
      var gray = 0, color = 0;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 8) color++;
        else if (r > 0 && r < 255) gray++;
      }
      return {
        alg: 'aa-pixels',
        gray: gray,
        color: color,
        verdict: color > 10 ? 'subpixel' : (gray > 10 ? 'grayscale' : 'none')
      };
    }, M('unsupported'));
  });
  // 一小批确定性数学结果，供 mathfp 与 shield 共用（不进 hash 时直接比字符串）
  function mathRaw() {
    return [Math.tan(1e300), Math.sin(1e300), Math.cos(1e10), Math.exp(100 / 3), Math.atanh(0.5),
      Math.cbrt(Math.PI), Math.expm1(1), Math.log1p(10), Math.sinh(1), Math.cosh(10),
      Math.pow(Math.PI, -100), Math.fround(1.1), Math.hypot(3, 4), Math.imul(0xffffffff, 5)].join(',');
  }
  function nativeSrcOk(fn, nat) {
    return safe(function () { return nat.test(String(Function.prototype.toString.call(fn))); }, null);
  }
  probe('shield', function (env) {
    // shield/2：不再猜"Math.random 三次不相等"。四个维度各是各的证据，判定写清楚依据：
    //   canvasStable       同一段绘制跑两遍是否一致（canvas 加噪的直接证据）
    //   mathStable         同一批数学结果跑两遍是否一致（Math 被扰动）
    //   nativeToStringIntact  原生函数字符串是否还完整（扩展改写函数的直接证据）
    // verdict 只有四态，且是**弱证据的汇总**，不是"是否伪装"的结论。
    return safe(function () {
      var nav = env.navigator || {};
      var brave = !!(nav.brave || /Brave/.test(nav.userAgent || ''));
      var c1 = safe(function () { return canvasData(env, 'shield-X'); }, null);
      var c2 = safe(function () { return canvasData(env, 'shield-X'); }, null);
      var canvasStable = (c1 && c2) ? (c1 === c2) : null;
      var m1 = safe(mathRaw, null), m2 = safe(mathRaw, null);
      var mathStable = (m1 && m2) ? (m1 === m2) : null;
      var NAT = /\{\s*\[native code\]\s*\}\s*$/;
      var intact = null;
      try {
        var fns = [Function.prototype.toString, Math.random, Date.prototype.getTimezoneOffset];
        if (env.fetch) fns.push(env.fetch);
        if (env.setTimeout) fns.push(env.setTimeout);
        intact = true;
        for (var i = 0; i < fns.length; i++) { if (nativeSrcOk(fns[i], NAT) === false) { intact = false; break; } }
      } catch (e) { intact = null; }
      var noise = canvasStable === null ? null : !canvasStable;
      var verdict = 'unknown';
      if (brave && (noise === true || mathStable === false)) verdict = 'likely-privacy-browser';
      else if (brave) verdict = 'likely-privacy-browser';
      else if (noise === true) verdict = 'canvas-noise';
      else if (noise === false && mathStable === true && intact === true) verdict = 'clean';
      var basis = canvasStable === null ? 'canvas_unmeasured' : 'canvas_repeat+math_repeat+native-toString';
      var note = '弱证据汇总，不判断是否伪装；canvasStable=null 表示两次绘制没做成（不能当成"没有噪声"）';
      return {
        alg: 'shield/2', brave: brave, noise: noise,
        canvasStable: canvasStable, mathStable: mathStable, nativeToStringIntact: intact,
        verdict: verdict, basis: basis, note: note
      };
    }, M('unsupported'));
  });
  probe('wasm', function (env) {
    // wasm/2：17 个特性逐个给真值，并写明每一项靠什么判的（validate / api-existence）。
    // 先跑 control（空模块）：它都过不了，说明 validate 这条路本身不可信（被拦、被桩掉），
    // 那时整项记 unreadable，而不是 17 个 false。
    return safe(function () {
      var W = env.WebAssembly;
      if (!W || typeof W.validate !== 'function') return M('unsupported');
      var U = env.Uint8Array || (typeof Uint8Array !== 'undefined' ? Uint8Array : null);
      if (!U) return M('unsupported');
      var control = false;
      try { control = !!W.validate(U.from(WASM_CONTROL)); } catch (e) { control = false; }
      if (!control) return M('unreadable');
      var items = {}, has = [], missing = [], unreadable = [];
      var sources = { validate: 0, 'api-existence': 0 };
      for (var i = 0; i < WASM_CASES.length; i++) {
        var name = WASM_CASES[i][0], source = WASM_CASES[i][1], bytes = WASM_CASES[i][2];
        var ok = false, broke = false;
        if (source === 'api-existence') {
          // JSPI 没有自己的模块：只看 API 对象在不在（参考实现同样做法）
          ok = safe(function () { return typeof W.Suspending === 'function' && typeof W.promising === 'function'; }, false);
        } else {
          try { ok = !!W.validate(U.from(bytes)); } catch (e) { ok = false; broke = true; }
        }
        sources[source] = (sources[source] || 0) + 1;
        items[name] = broke ? { ok: false, source: source, unreadable: true } : { ok: ok, source: source };
        if (broke) unreadable.push(name);
        else (ok ? has : missing).push(name);
      }
      return {
        alg: 'wasm/2',
        supported: has.length,
        total: WASM_CASES.length,
        has: has,
        missing: missing,
        unreadable: unreadable,
        items: items,
        sources: sources,
        src: 'wasm-feature-detect-1.10.0',
        control: 'valid'
      };
    }, M('unsupported'));
  });
  // 摘要输入（附录 K.12）：任何一项变了摘要就得变，测试逐项验；清单本身是常量 FP_INPUTS。
  function fpBits(env) {
    var t = tmpl(env), out = [];
    out.push('ua:' + t.ua);
    out.push('langs:' + t.langs);
    out.push('screen:' + t.screen);
    out.push('tz:' + t.tz);
    out.push('hc:' + t.hc);
    out.push('mem:' + t.mem);
    out.push('touch:' + t.touch);
    out.push('plat:' + t.plat);
    out.push('vendor:' + t.vendor);
    out.push('canvas:' + safe(function () {
      var d = canvasData(env, 'fpid-X');
      return d ? d.length + ':' + d.slice(-48) : 'na';
    }, 'na'));
    out.push('fonts:' + safe(function () { var f = fontDetect(env); return f ? f.join(',') : 'na'; }, 'na'));
    out.push('mathfp:' + safe(mathRaw, 'na'));
    out.push('engver:' + safe(function () { var fx = engineFeatures(env); return fx.supported + '@' + fx.floor; }, 'na'));
    out.push('wasm:' + safe(function () { return (env.WebAssembly && env.WebAssembly.validate) ? 'present' : 'absent'; }, 'na'));
    out.push('gl:' + safe(function () {
      var i = glInfo(env);
      return i ? (i.unmaskedVendor || '') + '/' + (i.unmaskedRenderer || '') : 'na';
    }, 'na'));
    return out;
  }
  function hwBits(env) {
    var t = tmpl(env), scr = env.screen || {}, out = [];
    out.push('screen:' + t.screen);
    out.push('dpr:' + safe(function () { return env.devicePixelRatio; }, ''));
    out.push('depth:' + safe(function () { return scr.colorDepth; }, ''));
    out.push('hc:' + t.hc);
    out.push('mem:' + t.mem);
    out.push('touch:' + t.touch);
    out.push('plat:' + t.plat);
    out.push('vendor:' + t.vendor);
    out.push('gl-vendor:' + safe(function () { var i = glInfo(env); return i ? (i.unmaskedVendor || '') : 'na'; }, 'na'));
    out.push('gl-renderer:' + safe(function () { var i = glInfo(env); return i ? (i.unmaskedRenderer || '') : 'na'; }, 'na'));
    out.push('fonts:' + safe(function () { var f = fontDetect(env); return f ? f.slice(0, 8).join(',') : 'na'; }, 'na'));
    out.push('fonts-hits:' + safe(function () { var f = fontDetect(env); return f ? f.length : 'na'; }, 'na'));
    out.push('heap-limit:' + safe(function () { return env.performance.memory.jsHeapSizeLimit; }, 'na'));
    return out;
  }
  probe('fpid', function (env) {
    // 输入范围见 FP_INPUTS（附录 K.12）：环境模板 + 渲染（canvas/GL）+ 字体 + 数学 + 引擎特性。
    // 值仍是**标量摘要字符串**（后端 visit.fpid 是 TEXT、identity_text 只吃标量），
    // 版本只靠 fpid_alg 标签区分，历史行按标签分档。
    return hash(fpBits(env).join('|')).then(function (h) { return h; });
  });
  probe('hwid', function (env) {
    // 输入范围见 HW_INPUTS：屏幕/核心数/内存/触控/平台/GPU/字体命中/堆上限。
    // 同样保持标量形状（后端 hwid 列是 TEXT），版本靠 hwid_alg。
    return hash(hwBits(env).join('|'));
  });

  // ============ dev · 34 项 ============
  function uaData(env) { return safe(function () { return env.navigator.userAgentData || null; }, null); }
  // 高熵字段一次问全，三个探针（engver/arch/model）共用同一个 Promise：
  // 旧实现各问一次，既多花时间，也可能因为降级参数不同拿到不一致的版本。
  function chHigh(env) {
    return memo(env, 'chHigh', function () {
      var uad = uaData(env);
      if (!uad || !uad.getHighEntropyValues) return Promise.resolve(null);
      var full = ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList',
        'formFactors', 'wow64'];
      var low = ['architecture', 'bitness', 'model'];
      return safe(function () {
        return uad.getHighEntropyValues(full).catch(function () {
          return uad.getHighEntropyValues(low).catch(function () { return null; });
        });
      }, Promise.resolve(null)) || Promise.resolve(null);
    });
  }
  // 高熵字段以前只被 os/model 派生用掉，原始结果没留；derive 又把 cli.ch 写成回显头列表，
  // 于是谁也核对不了浏览器到底自己报了什么版本。现在分区保留：jsLow 是低熵品牌、
  // jsHigh 是高熵结果、srv 留给服务端回显头（后端填，采集器不写）。
  probe('ch', function (env) {
    return safe(function () {
      var uad = uaData(env);
      if (!uad) return M('unsupported');
      var low = {
        brands: uad.brands || null,
        mobile: typeof uad.mobile === 'boolean' ? uad.mobile : null,
        platform: uad.platform || null
      };
      return chHigh(env).then(function (v) {
        if (!v) return { alg: 'ch/1', jsLow: low, jsHigh: M('error') };
        var fields = ['architecture', 'bitness', 'model', 'platformVersion',
          'fullVersionList', 'formFactors', 'wow64'];
        var high = {}, missing = [], blank = [];
        fields.forEach(function (key) {
          var value = v[key];
          if (value === undefined || value === null) { missing.push(key); return; }
          if (value === '' || (Array.isArray(value) && !value.length)) {
            // 空值是浏览器亲口说的"没有"，保留原样，另记一笔
            blank.push(key);
            high[key] = value;
            return;
          }
          high[key] = value;
        });
        var out = { alg: 'ch/1', jsLow: low, jsHigh: high };
        if (missing.length) out.missing = missing;
        if (blank.length) out.empty = blank;
        return out;
      }).catch(function () { return { alg: 'ch/1', jsLow: low, jsHigh: M('error') }; });
    }, M('error'));
  });
  probe('os', function (env) {
    var fromUa = function () {
      var ua = env.navigator.userAgent || '', m;
      if ((m = ua.match(/Windows NT 10\.0/))) return 'Windows';
      if (/Android/.test(ua)) { m = ua.match(/Android ([\d.]+)/); return 'Android ' + (m ? m[1] : ''); }
      if (/iPhone|iPad|iPod/.test(ua)) { m = ua.match(/OS ([\d_]+)/); return 'iOS ' + (m ? m[1].replace(/_/g, '.') : ''); }
      if (/Mac OS X/.test(ua)) { m = ua.match(/Mac OS X ([\d_.]+)/); return 'macOS ' + (m ? m[1].replace(/_/g, '.') : ''); }
      if (/CrOS/.test(ua)) return 'ChromeOS';
      if (/Linux/.test(ua)) return 'Linux';
      return 'unknown';
    };
    var uad = uaData(env);
    if (!uad || !uad.platform) return safe(fromUa, M('unsupported'));
    // UA 里的 Android 版本在安卓被冻结成 10、Windows NT 永远是 10.0，
    // 所以有 platformVersion 就以它为准，没有才回落到 UA。
    return chHigh(env).then(function (v) {
      var version = v && v.platformVersion ? String(v.platformVersion).split('.')[0] : null;
      if (!version) return uad.platform;
      if (/Android/i.test(uad.platform)) return 'Android ' + version;
      if (/Windows/i.test(uad.platform)) return Number(version) >= 13 ? 'Windows 11' : 'Windows 10';
      if (/macOS|Mac OS/i.test(uad.platform)) return 'macOS ' + version;
      if (/Chrome OS|ChromeOS/i.test(uad.platform)) return 'ChromeOS';
      return uad.platform;
    }).catch(function () { return safe(fromUa, M('unsupported')); });
  });
  // Edge 在桌面是 Edg/，Android 是 EdgA/，iOS 是 EdgiOS/；旧实现只认 Edg/，于是安卓
  // 和 iOS 上的 Edge 都被说成 Chrome。CriOS/FxiOS/OPiOS 同理。UA 令牌只说明"它自称是
  // 谁"，Client Hints 的品牌（Sec-CH-UA）才是浏览器自报的名字，两者都有时以品牌为准。
  var BROWSER_RULES = [
    [/EdgiOS\/(\d+)/, 'Edge'], [/EdgA\/(\d+)/, 'Edge'], [/Edg\/(\d+)/, 'Edge'],
    [/OPiOS\/(\d+)/, 'Opera'], [/OPR\/(\d+)/, 'Opera'],
    [/FxiOS\/(\d+)/, 'Firefox'], [/Firefox\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'], [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari']
  ];
  // 品牌列表里 Chromium 一定存在，所以不能"碰到第一个认识的就用"：先找派生品牌
  // （Edge / Opera），找不到才退回 Chrome / Chromium。
  var BRAND_PRIORITY = [
    [/Microsoft Edge/i, 'Edge'],
    [/Opera|OPR/i, 'Opera'],
    [/Google Chrome/i, 'Chrome'],
    [/Chromium/i, 'Chromium']
  ];
  function brandOf(env) {
    var uad = uaData(env);
    if (!uad || !uad.brands) return null;
    for (var p = 0; p < BRAND_PRIORITY.length; p++) {
      for (var i = 0; i < uad.brands.length; i++) {
        var item = uad.brands[i] || {};
        var b = String(item.brand || '');
        if (!b || /Not.?A.?Brand/i.test(b)) continue;
        if (BRAND_PRIORITY[p][0].test(b)) return { name: BRAND_PRIORITY[p][1], version: item.version };
      }
    }
    return null;
  }
  probe('browser', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '', m, name = 'unknown', ver = null;
      for (var i = 0; i < BROWSER_RULES.length; i++) {
        m = ua.match(BROWSER_RULES[i][0]);
        if (m) { name = BROWSER_RULES[i][1]; ver = m[1]; break; }
      }
      var brand = brandOf(env);
      if (brand) {
        name = brand.name;
        ver = String(brand.version || '').split('.')[0] || ver;
      }
      return name === 'unknown' ? 'unknown' : name + (ver ? ' ' + ver : '');
    }, M('unsupported'));
  });
  probe('arch', function (env) {
    return safe(function () {
      var uad = uaData(env);
      if (uad && uad.getHighEntropyValues) {
        return chHigh(env).then(function (v) {
          if (!v || !v.architecture) return archFromUa(env);
          return v.architecture + (v.bitness ? '/' + v.bitness : '');
        }).catch(function () { return archFromUa(env); });
      }
      return archFromUa(env);
    }, M('unsupported'));
    function archFromUa(env) {
      var ua = env.navigator.userAgent || '';
      if (/aarch64|arm64|arm/i.test(ua)) return 'arm';
      if (/WOW64|Win64|x64|x86_64/.test(ua)) return 'x86/64';
      return 'unknown';
    }
  });
  // 设备形态（form）：高熵 formFactors 是浏览器**亲口说的**形态，能拿到就用它；
  // 拿不到才退回粗分，并且必须把依据（basis）写清，别让"推断"看起来像"读数"。
  //   ua-ch-form-factors  高熵 Sec-CH-UA-Form-Factors（Desktop/Mobile/Tablet/Automotive/XR…）
  //   ua-mobile           低熵 userAgentData.mobile，或 UA 里的 Mobile/Tablet 标记
  //   touch-heuristic     触屏点 + 屏幕宽度 + Macintosh（iPadOS 桌面模式）推断
  var FORM_KINDS = {
    desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', automotive: 'Automotive',
    xr: 'XR', eink: 'EInk', watch: 'Watch'
  };
  function formKindOf(list) {
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] || '');
      var known = FORM_KINDS[raw.toLowerCase()];
      if (known) return known;
      if (raw) return raw;                 // 表外的新形态原样保留，不硬套成已知值
    }
    return 'unknown';
  }
  probe('form', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '';
      function rough() {
        var uad = uaData(env);
        if (uad && typeof uad.mobile === 'boolean') {
          return { kind: uad.mobile ? 'Mobile' : 'Desktop', basis: 'ua-mobile', formFactors: [], source: 'navigator.userAgentData.mobile' };
        }
        if (/iPad|Tablet/i.test(ua)) return { kind: 'Tablet', basis: 'ua-mobile', formFactors: [], source: 'navigator.userAgent' };
        if (/Mobi|Android.*Mobile/i.test(ua)) return { kind: 'Mobile', basis: 'ua-mobile', formFactors: [], source: 'navigator.userAgent' };
        var touch = (env.navigator.maxTouchPoints || 0) > 0;
        if (touch && (env.screen ? env.screen.width >= 768 : false) && /Macintosh/.test(ua)) {
          return { kind: 'Tablet', basis: 'touch-heuristic', formFactors: [], source: 'navigator.maxTouchPoints' };
        }
        return { kind: 'Desktop', basis: 'ua-mobile', formFactors: [], source: 'navigator.userAgent' };
      }
      var uad = uaData(env);
      if (!uad || !uad.getHighEntropyValues) return rough();
      return chHigh(env).then(function (v) {
        var ff = v && v.formFactors;
        if (Array.isArray(ff) && ff.length) {
          return { kind: formKindOf(ff), basis: 'ua-ch-form-factors', formFactors: ff.slice(0, 8), source: 'sec-ch-ua-form-factors' };
        }
        return rough();      // 高熵里没有 formFactors：退回粗分，basis 说清是哪一种
      }).catch(function () { return rough(); });
    }, M('unsupported'));
  });
  // 机型映射（model）。参考站做两件事，这里跟着做：
  //   ① Android：高熵 Sec-CH-UA-Model 给的常常是**代码名**（panther / SM-G991B），
  //      配一张有限的"代码名 → 市场名"表来翻。表必须有 mapVersion 与 source，
  //      只收确知且能注来源的条目；表外的一律 decoded:null，绝不猜。
  //   ② Apple：iOS/iPadOS 没有机型字段（UA 与 CH 都不给），只能用「屏幕逻辑尺寸 +
  //      devicePixelRatio + GPU renderer」给出**候选**，永不输出唯一结论。
  var MODEL_MAP_VERSION = 'android-codenames-2024a';
  var MODEL_MAP_SOURCE = 'AOSP 设备代码名 + 厂商官方机型列表（2024-11 核对）';
  // [代码名, 市场名, 条目来源]
  var MODEL_CODES = [
    ['tokay', 'Pixel 9', 'aosp-pixel'], ['caiman', 'Pixel 9 Pro', 'aosp-pixel'],
    ['komodo', 'Pixel 9 Pro XL', 'aosp-pixel'], ['comet', 'Pixel 9 Pro Fold', 'aosp-pixel'],
    ['shiba', 'Pixel 8', 'aosp-pixel'], ['husky', 'Pixel 8 Pro', 'aosp-pixel'],
    ['akita', 'Pixel 8a', 'aosp-pixel'],
    ['panther', 'Pixel 7', 'aosp-pixel'], ['cheetah', 'Pixel 7 Pro', 'aosp-pixel'],
    ['lynx', 'Pixel 7a', 'aosp-pixel'],
    ['oriole', 'Pixel 6', 'aosp-pixel'], ['raven', 'Pixel 6 Pro', 'aosp-pixel'],
    ['bluejay', 'Pixel 6a', 'aosp-pixel'],
    ['redfin', 'Pixel 5', 'aosp-pixel'], ['barbet', 'Pixel 5a', 'aosp-pixel'],
    ['sunfish', 'Pixel 4a', 'aosp-pixel'], ['flame', 'Pixel 4', 'aosp-pixel'],
    ['coral', 'Pixel 4 XL', 'aosp-pixel'], ['blueline', 'Pixel 3', 'aosp-pixel'],
    ['crosshatch', 'Pixel 3 XL', 'aosp-pixel'], ['walleye', 'Pixel 2', 'aosp-pixel'],
    ['taimen', 'Pixel 2 XL', 'aosp-pixel'], ['felix', 'Pixel Fold', 'aosp-pixel'],
    ['tangorpro', 'Pixel Tablet', 'aosp-pixel'],
    ['bullhead', 'Nexus 5X', 'aosp-nexus'], ['angler', 'Nexus 6P', 'aosp-nexus'],
    ['SM-G991B', 'Galaxy S21 5G', 'samsung-model-code'],
    ['SM-G996B', 'Galaxy S21+ 5G', 'samsung-model-code'],
    ['SM-G998B', 'Galaxy S21 Ultra 5G', 'samsung-model-code'],
    ['SM-S911B', 'Galaxy S23', 'samsung-model-code']
  ];
  var APPLE_MAP_VERSION = 'ios-screen-2024a';
  var APPLE_MAP_SOURCE = 'iPhone/iPad 各型号的逻辑分辨率与 DPR（厂商规格 + iOS Safari viewport 实测）';
  // [候选机型, 短边 CSS px, 长边 CSS px, devicePixelRatio]
  // 同一组尺寸本来就被多代机型共用，所以这里天然是"候选"而不是"结论"。
  var APPLE_MODELS = [
    ['iPhone SE (2nd/3rd gen)', 375, 667, 2],
    ['iPhone X / XS / 11 Pro', 375, 812, 3],
    ['iPhone 12 mini / 13 mini', 375, 812, 3],
    ['iPhone 12 / 12 Pro / 13 / 13 Pro / 14 / 16', 390, 844, 3],
    ['iPhone 14 Pro / 15 / 15 Pro', 393, 852, 3],
    ['iPhone XR / 11', 414, 896, 2],
    ['iPhone XS Max / 11 Pro Max', 414, 896, 3],
    ['iPhone 12 Pro Max / 13 Pro Max / 14 Pro Max', 428, 926, 3],
    ['iPhone 14 Plus', 428, 926, 3],
    ['iPhone 15 Plus / 16 Plus', 430, 932, 3],
    ['iPhone 16 Pro', 402, 874, 3],
    ['iPhone 16 Pro Max', 440, 956, 3],
    ['iPad 10.2" (7/8/9 gen)', 810, 1080, 2],
    ['iPad Air 10.9"', 820, 1180, 2],
    ['iPad Pro 11"', 834, 1194, 2],
    ['iPad mini 6', 744, 1133, 2]
  ];
  function decodeModelCode(raw) {
    if (!raw) return null;
    var t = String(raw).trim();
    if (!t) return null;
    for (var i = 0; i < MODEL_CODES.length; i++) {
      if (String(MODEL_CODES[i][0]).toLowerCase() === t.toLowerCase()) {
        return { name: MODEL_CODES[i][1], matched: MODEL_CODES[i][0], entrySource: MODEL_CODES[i][2], exact: true };
      }
      // 高熵有时直接给市场名：这时不需要翻译，但可以确认"表里有这一条"
      if (String(MODEL_CODES[i][1]).toLowerCase() === t.toLowerCase()) {
        return { name: MODEL_CODES[i][1], matched: MODEL_CODES[i][0], entrySource: MODEL_CODES[i][2], exact: true };
      }
    }
    return null;
  }
  // Apple 候选推断：置信度只表达"在这几条候选里排第几档"，不是"就是这台机器"。
  //   0.55 基础分（屏幕逻辑尺寸 + DPR 完全匹配）
  //   +0.10 UA 设备族一致（iPhone/iPad 前缀对得上）
  //   +0.15 GPU renderer 里出现该型号的 GPU 家族标记（iOS 多数读不到，能读到就加分）
  //   ÷ 同尺寸同 DPR 的候选数（重叠越多，单台的可分辨度越低）
  // 上限 0.8；候选不足 2 条时也照实记一条，但 confidence 压到 0.5 以下并在 note 里说明。
  function appleCandidates(env, ua) {
    var scr = env.screen || {};
    var w = +scr.width, h = +scr.height;
    if (!(isFinite(w) && isFinite(h) && w > 0 && h > 0)) return null;
    var sw = Math.min(w, h), sh = Math.max(w, h);
    var dpr = num(env.devicePixelRatio, 2);
    if (!dpr) return null;
    var renderer = '';
    try {
      var i = glInfo(env);
      renderer = String((i && (i.unmaskedRenderer || i.renderer)) || '');
    } catch (e) { renderer = ''; }
    var family = /iPad|iPod/.test(ua) ? 'iPad' : (/iPhone/.test(ua) ? 'iPhone' : null);
    var hits = [], i2;
    for (i2 = 0; i2 < APPLE_MODELS.length; i2++) {
      var row = APPLE_MODELS[i2];
      if (row[1] !== sw || row[2] !== sh || row[3] !== dpr) continue;
      hits.push(row[0]);
    }
    if (!hits.length) return { candidates: [], renderer: renderer || null, basis: 'screen-gpu-candidate' };
    var score = 0.55;
    if (family) score += 0.1;
    if (renderer && /apple/i.test(renderer)) score += 0.05;         // 只证明"是 Apple GPU"，不区分型号
    var each = Math.min(0.8, score / hits.length);
    var out = [];
    for (i2 = 0; i2 < hits.length && i2 < 4; i2++) {
      out.push({ name: hits[i2], confidence: Math.round(each * 100) / 100, basis: 'screen+dpr' + (renderer ? '+gpu' : '') });
    }
    return {
      candidates: out,
      renderer: renderer || null,
      matchedBy: { w: sw, h: sh, dpr: dpr },
      basis: 'screen-gpu-candidate'
    };
  }
  probe('model', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '';
      var uad = uaData(env);
      var finish = function (raw) {
        var dec = decodeModelCode(raw);
        var out = {
          alg: 'model/2',
          raw: raw || null,
          decoded: dec ? dec.name : null,
          candidates: [],
          basis: dec ? 'ua-ch-model+map' : (raw ? 'ua-ch-model-unmapped' : 'no-model-field'),
          mapVersion: MODEL_MAP_VERSION,
          source: MODEL_MAP_SOURCE
        };
        if (dec) {
          out.matched = dec.matched;
          out.entrySource = dec.entrySource;
          out.candidates = [{ name: dec.name, confidence: 1, basis: 'codename-table' }];
          return out;
        }
        // 没有高熵 model 的 Apple 设备：给候选，不给结论
        if (!raw) {
          var ap = appleCandidates(env, ua);
          if (ap && ap.candidates.length) {
            out.candidates = ap.candidates;
            out.basis = 'screen-gpu-candidate';
            out.mapVersion = APPLE_MAP_VERSION;
            out.source = APPLE_MAP_SOURCE;
            out.matchedBy = ap.matchedBy;
            out.renderer = ap.renderer;
            if (ap.candidates.length < 2) out.note = '同一组屏幕尺寸只有一个候选，仍然只是候选，不能当唯一结论';
            return out;
          }
          // 桌面/未知设备本来就没有机型字段：这是"这平台没有"，不是"采集失败"
          return M('unsupported');
        }
        // 有原始值但表里没有：如实说"解不出"，不编一个名字出来
        return out;
      };
      if (uad && uad.getHighEntropyValues) {
        return chHigh(env).then(function (v) { return finish(v && v.model ? String(v.model) : ''); })
          .catch(function () { return finish(''); });
      }
      return finish('');
    }, M('unsupported'));
  });
  probe('screen', function (env) {
    return safe(function () {
      var s = env.screen;
      return { w: s.width, h: s.height, aw: s.availWidth, ah: s.availHeight, dpr: num(env.devicePixelRatio, 3), depth: s.colorDepth };
    }, M('unsupported'));
  });
  probe('hz', function (env) {
    var doc = env.document || {};
    return new Promise(function (resolve) {
      var raf = env.requestAnimationFrame;
      if (!raf) { resolve(M('unsupported')); return; }
      var settled = false;
      var guard = setTimeout(function () { done(M('unsupported')); }, 4500);
      function done(v) { if (settled) return; settled = true; clearTimeout(guard); resolve(v); }
      // 后台标签页 rAF 会被暂停，等页面可见再测
      if (doc.visibilityState === 'hidden') {
        if (!env.addEventListener) { done(M('unsupported')); return; }
        env.addEventListener('visibilitychange', function () {
          if (doc.visibilityState !== 'hidden') measure();
        }, { once: true });
        return;
      }
      measure();
      function measure() {
        var times = [];
        var stop = setTimeout(finish, 1200);
        function finish() {
          clearTimeout(stop);
          if (times.length < 3) { done(M('unsupported')); return; }
          var deltas = [];
          for (var i = 1; i < times.length; i++) { var d = times[i] - times[i - 1]; if (d > 0) deltas.push(d); }
          if (!deltas.length) { done(M('unsupported')); return; }
          deltas.sort(function (a, b) { return a - b; });
          done(num(1000 / deltas[Math.floor(deltas.length / 2)], 0));
        }
        function step(ts) {
          times.push(ts || 0);
          if (times.length >= 30) { finish(); return; }
          raf.call(env, step);
        }
        raf.call(env, step);
      }
    });
  });
  probe('screens', function (env) {
    // isExtended 只能说明「不止一块」，数不出具体几个（旧代码硬写 2，三屏会被说成双屏）。
    // A-05：先确认它是**布尔值**再下结论——
    //   true      → 多屏，但块数未知：n 留 null，绝不编数字
    //   false     → 单屏
    //   undefined / 非布尔（浏览器没提供这个接口）→ unsupported，不是"单屏"
    //   读的时候抛错 → unreadable，也不是"单屏"
    // 详细的多屏枚举（window.getScreenDetails）需要访客授权（user-activation + 权限弹窗），
    // 而本项目不许改页面外观、也不主动弹权限框，所以这一轮只报"多屏/单屏/未知"，
    // 屏幕位置读数独立走 win 那一项（见下），不因为这里未知就一起丢掉。
    return safe(function () {
      var s = env.screen;
      if (!s) return M('unsupported');
      var ext;
      try {
        ext = s.isExtended;
      } catch (e) {
        return M('unreadable');            // 读得到接口、读不出值：未知，不当 false
      }
      if (ext === true) return { n: null, ext: true, basis: 'isExtended' };
      if (ext === false) return { n: 1, ext: false, basis: 'isExtended' };
      // 既不是 true 也不是 false：没有任何依据说这是单屏
      return M('unsupported');
    }, M('unsupported'));
  });
  probe('win', function (env) {
    return safe(function () {
      var o = { iw: env.innerWidth || 0, ih: env.innerHeight || 0 };
      var ow = env.outerWidth || 0, oh = env.outerHeight || 0;
      // 只在合理时给外框尺寸，否则宁可不发（最小化 / 无边框窗口会给出 160×28 这种垃圾值）
      if (ow > 0 && ow >= o.iw && oh >= o.ih) { o.ow = ow; o.oh = oh; }
      // A-05：窗口/屏幕位置读数各自独立上报——它们和 screens.isExtended 是否可读无关，
      // 是"这块屏幕放在哪里"的旁证（多屏、外接屏、RDP 会话都会体现在这里）。
      // 0 是合法值（主屏左上角），所以只按"是不是有限数字"取舍，不按真假。
      function put(key, v) { if (typeof v === 'number' && isFinite(v)) o[key] = Math.round(v); }
      put('sx', env.screenX);
      put('sy', env.screenY);
      try {
        var s = env.screen || {};
        put('al', s.availLeft);            // Firefox/Safari 有，Chrome 多数为 undefined
        put('at', s.availTop);
      } catch (e) { }
      return o;
    }, M('unsupported'));
  });
  probe('scrollbar', function (env) {
    return safe(function () {
      var doc = env.document, d = doc.createElement('div');
      d.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
      doc.body.appendChild(d);
      var w = d.offsetWidth - d.clientWidth;
      doc.body.removeChild(d);
      return w;
    }, M('unsupported'));
  });
  probe('gpu', function (env) {
    return safe(function () {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      return { vendor: i.vendor, renderer: i.renderer, unmasked: i.unmaskedRenderer };
    }, M('error'));
  });
  // 不同 powerPreference 可能拿到不同适配器（笔记本双显卡），必须分开问、分开缓存。
  // D：webgpu 与 gpulim 现在共用**同一份** requestAdapter 结果——每个 powerPreference
  // 一轮只请求一次，谁都不许再为"想看 limits"重复请求同一个适配器。
  function gpuAdapterRaw(env, pref) {
    return memo(env, 'gpuraw:' + (pref || 'default'), function () {
      var g = env.navigator && env.navigator.gpu;
      if (!g || !g.requestAdapter) return Promise.resolve(null);
      var opts = pref ? { powerPreference: pref } : undefined;
      return safe(function () {
        return Promise.resolve(g.requestAdapter(opts)).catch(function () { return null; });
      }, Promise.resolve(null));
    });
  }
  function gpuAdapterInfo(a) {
    var info = a && a.info;
    if (info) return { vendor: info.vendor || null, arch: info.architecture || null, device: info.device || null, desc: info.description || null };
    if (a && a.requestAdapterInfo) {
      return a.requestAdapterInfo().then(function (i2) {
        return { vendor: i2.vendor || null, arch: i2.architecture || null, device: i2.device || null, desc: i2.description || null };
      });
    }
    return null;
  }
  function gpuAdapter(env, pref) {
    return gpuAdapterRaw(env, pref).then(function (a) {
      if (!a) return null;
      var info = gpuAdapterInfo(a);
      return Promise.resolve(info).then(function (i) {
        var out = i || {};
        out.pref = pref || 'default';
        out.hasFallback = !!a.isFallbackAdapter;
        return out;
      });
    });
  }
  // GPUAdapter.limits 的字段是挂在原型上的 getter：Object.keys 拿不到，必须 for..in
  // （或退一步读原型上的属性名）。只要有一边能列出字段就够；读单个字段抛错就跳过它。
  function gpuLimits(a) {
    var L = a && a.limits;
    if (!L) return null;
    var out = {}, n = 0;
    function take(k) {
      if (n >= 64 || typeof k !== 'string' || !k || k.charAt(0) === '_') return;
      var v;
      try { v = L[k]; } catch (e) { return; }
      if (typeof v === 'number' && isFinite(v)) { out[k] = v; n++; return; }
      if (typeof v === 'boolean') { out[k] = v; n++; }
    }
    try { for (var k in L) take(k); } catch (e) { }
    if (!n) {
      try {
        var proto = Object.getPrototypeOf ? Object.getPrototypeOf(L) : null;
        var names = proto ? Object.getOwnPropertyNames(proto) : [];
        for (var i = 0; i < names.length; i++) take(names[i]);
      } catch (e2) { }
    }
    if (!n) return null;
    // 键序固定成字典序：同一台设备两次采集落到同一个 facet 取值上
    var keys = Object.keys(out).sort(), stable = {};
    for (var j = 0; j < keys.length; j++) stable[keys[j]] = out[keys[j]];
    return stable;
  }
  function gpuFeatures(a) {
    var feats = [];
    try { if (a && a.features && a.features.forEach) a.features.forEach(function (f) { feats.push(String(f)); }); } catch (e) { }
    return feats;
  }
  // WebGL 侧的读数单独一份、单独标源：它不是 WebGPU limits 的一部分，绝不混算。
  function webglSide(env) {
    try {
      var i = glInfo(env);
      if (!i) return null;
      var gl = i.gl;
      var vp = safe(function () { return gl.getParameter(gl.MAX_VIEWPORT_DIMS); }, null);
      return {
        src: 'webgl',
        maxTexDim: safe(function () { return gl.getParameter(gl.MAX_TEXTURE_SIZE); }, null),
        maxViewport: vp ? [vp[0], vp[1]] : null,
        extCount: i.ext,
        note: 'WebGL 侧读数另标来源，不与 WebGPU limits 合并计算'
      };
    } catch (e) { return null; }
  }
  probe('webgpu', function (env) {
    return Promise.all([gpuAdapter(env, 'high-performance'), gpuAdapter(env, 'low-power')]).then(function (list) {
      var usable = list.filter(function (x) { return x && (x.vendor || x.desc || x.device); });
      if (!usable.length) return M('unsupported');
      var out = { adapters: usable };
      if (usable.length === 1) {
        for (var k in usable[0]) if (k !== 'pref' && k !== 'hasFallback') out[k] = usable[0][k];
      }
      return out;
    }).catch(function () { return M('unreadable'); });
  });
  // gpulim（dev）：WebGPU 能力的**完整**读数。
  //   - limits：枚举 adapter.limits 的全部标量字段（不再只有 maxTextureDimension2D）
  //   - features：全量特性清单（上限 64 只为防病态环境）
  //   - adapter：high-performance / low-power 各一份，**复用** webgpu 那一项的请求
  //   - webglFallback：WebGL 侧能力另标来源，不与 WebGPU 混算成同一份读数
  // 拿不到适配器时退回 src:'webgl'（老形状），features 就是 WebGL 扩展名。
  probe('gpulim', function (env) {
    function fromGl(why) {
      var i = null;
      try { i = glInfo(env); } catch (e) { i = null; }
      if (!i) return M('unsupported');
      var gl = i.gl;
      var maxTex = safe(function () { return gl.getParameter(gl.MAX_TEXTURE_SIZE); }, null);
      return {
        alg: 'gpulim/2',
        src: 'webgl',
        maxTexDim: maxTex,
        features: safe(function () { return (gl.getSupportedExtensions() || []).slice(0, 40); }, []),
        adapter: null,
        webglFallback: webglSide(env),
        note: why || 'webgpu-adapter-unavailable'
      };
    }
    return Promise.all([gpuAdapterRaw(env, 'high-performance'), gpuAdapterRaw(env, 'low-power')]).then(function (pair) {
      var hi = pair[0], lo = pair[1];
      if (!hi && !lo) return fromGl();
      function pack(a, pref) {
        if (!a) return null;
        var limits = gpuLimits(a);
        var feats = gpuFeatures(a);
        var info = safe(function () { return gpuAdapterInfo(a); }, null);
        return {
          pref: pref,
          fallback: !!a.isFallbackAdapter,
          limits: limits,
          fields: limits ? Object.keys(limits).length : 0,
          features: feats.slice(0, 64),
          featuresCount: feats.length,
          vendor: (info && info.vendor) || null,
          device: (info && info.device) || null
        };
      }
      var mainPref = hi ? 'high-performance' : 'low-power';
      var main = pack(hi || lo, mainPref);
      return {
        alg: 'gpulim/2',
        src: 'webgpu',
        limits: main.limits,
        limitsSrc: mainPref,
        fields: main.fields,
        maxTexDim: main.limits ? (main.limits.maxTextureDimension2D || null) : null,
        features: main.features,
        featuresCount: main.featuresCount,
        adapter: {
          'high-performance': pack(hi, 'high-performance'),
          'low-power': pack(lo, 'low-power')
        },
        webglFallback: webglSide(env)
      };
    }).catch(function () { return fromGl(); });
  });
  // glx（dev）：WebGL 能力补全。保留既有的纹理/缓冲/viewport 字段，另加
  //   - shaderPrecision：getShaderPrecisionFormat 的 vertex/fragment 精度与取值范围
  //   - version / sl：GL 版本与着色语言版本
  //   - extNames：完整扩展名清单（ext 仍是数量，兼容老消费者）
  function shaderPrec(gl) {
    if (!gl || typeof gl.getShaderPrecisionFormat !== 'function') return null;
    function one(shaderType) {
      var r = safe(function () { return gl.getShaderPrecisionFormat(shaderType, gl.HIGH_FLOAT); }, null);
      if (!r) return null;
      return {
        precision: typeof r.precision === 'number' ? r.precision : null,
        rangeMin: typeof r.rangeMin === 'number' ? r.rangeMin : null,
        rangeMax: typeof r.rangeMax === 'number' ? r.rangeMax : null,
        type: 'high_float'
      };
    }
    var v = one(gl.VERTEX_SHADER), f = one(gl.FRAGMENT_SHADER);
    if (!v && !f) return null;
    return { vertex: v, fragment: f };
  }
  probe('glx', function (env) {
    return safe(function () {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      var gl = i.gl;
      var vp = safe(function () { return gl.getParameter(gl.MAX_VIEWPORT_DIMS); }, null);
      var names = safe(function () { return gl.getSupportedExtensions() || []; }, []);
      return {
        alg: 'glx/2',
        maxTexture: safe(function () { return gl.getParameter(gl.MAX_TEXTURE_SIZE); }, null),
        maxRenderbuffer: safe(function () { return gl.getParameter(gl.MAX_RENDERBUFFER_SIZE); }, null),
        maxViewport: vp ? [vp[0], vp[1]] : null,
        version: safe(function () { return gl.getParameter(gl.VERSION); }, null),
        sl: safe(function () { return gl.getParameter(gl.SHADING_LANGUAGE_VERSION); }, null),
        shaderPrecision: shaderPrec(gl),
        ext: i.ext,
        extNames: names.slice(0, 64)
      };
    }, M('unsupported'));
  });
  probe('cpu', function (env) { return safe(function () { return env.navigator.hardwareConcurrency || null; }, M('unsupported')); });
  probe('mem', function (env) { return safe(function () { return env.navigator.deviceMemory || null; }, M('unsupported')); });
  probe('heap', function (env) {
    return safe(function () {
      var m = env.performance && env.performance.memory;
      if (!m) return M('unsupported');
      return Math.round(m.jsHeapSizeLimit / 1048576);
    }, M('unsupported'));
  });
  probe('touch', function (env) {
    return safe(function () {
      var nav = env.navigator;
      function mq(q) {
        try { return env.matchMedia ? env.matchMedia(q).matches === true : null; } catch (e) { return null; }
      }
      function kind(fine, coarse) {
        if (fine === true) return 'fine';
        if (coarse === true) return 'coarse';
        return null;
      }
      return {
        points: nav.maxTouchPoints || 0,
        pointer: kind(mq('(pointer: fine)'), mq('(pointer: coarse)'))
          || (nav.pointerEnabled === false ? 'no' : null),
        anyPointer: kind(mq('(any-pointer: fine)'), mq('(any-pointer: coarse)')),
        hover: mq('(hover: hover)'),
        anyHover: mq('(any-hover: hover)'),
        pointerEvents: env.PointerEvent ? true : false
      };
    }, M('unsupported'));
  });
  probe('battery', function (env) {
    return new Promise(function (resolve) {
      try {
        var n = env.navigator;
        if (!n.getBattery) { resolve(M('unsupported')); return; }
        n.getBattery().then(function (b) {
          // chargingTime 只接受有限的非负数；Infinity（正在充电）/ NaN / 负数 / 缺失都记 null，
          // 但属性必须保留——后台要能区分「没有电池」和「老版本没采」
          var ct = (b.chargingTime === null || b.chargingTime === undefined || b.chargingTime === '')
            ? null : +b.chargingTime;
          if (!(isFinite(ct) && ct >= 0)) ct = null;
          resolve({ level: num(b.level, 2), charging: !!b.charging, chargingTime: ct });
        }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  // 这三项当前不主动请求权限，所以是「没跑」而不是「被拒绝」
  probe('geoloc', function () { return M('not_run'); });
  // 传感器：安卓 Chrome 的 devicemotion 不需要任何授权（accelerometer／gyroscope 的
  // Permissions Policy 对顶层页默认 self）；桌面没有传感器、iOS 必须由手势调
  // requestPermission()，所以那两种情况下一个事件都不会来——我们不弹任何框，
  // 有事件就报采样率与三轴噪声，没有就保持"这一轮没运行"。
  var SENSOR_WAIT = 1500;
  var SENSOR_MIN = 24;             // 攒够这么多样本再报采样率与噪声
  var sensorState = null;
  function spread(a) {
    if (!a || a.length < 2) return null;
    var i, s = 0;
    for (i = 0; i < a.length; i++) s += a[i];
    var mean = s / a.length, v = 0;
    for (i = 0; i < a.length; i++) v += (a[i] - mean) * (a[i] - mean);
    return Math.sqrt(v / (a.length - 1));
  }
  function sensorWatch(env) {
    // 采样结束会摘掉监听（别让手机一直读传感器），所以每一轮都要能重新挂上；
    // 重新挂的时候把计数清零，免得上一轮的样本算进这一轮。
    if (!sensorState) {
      sensorState = { n: 0, first: 0, last: 0, x: [], y: [], z: [], rot: false, interval: null, attached: false, off: null, handler: null };
    }
    var st = sensorState;
    if (st.attached) return st;
    st.n = 0;
    st.first = 0;
    st.last = 0;
    st.x.length = 0;
    st.y.length = 0;
    st.z.length = 0;
    st.rot = false;
    st.interval = null;
    try {
      if (!env.addEventListener) return st;
      st.handler = function (e) {
        var now = Date.now();
        if (!st.first) st.first = now;
        st.last = now;
        st.n++;
        var a = e && (e.accelerationIncludingGravity || e.acceleration);
        if (a && typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number') {
          if (st.x.length < 400) { st.x.push(a.x); st.y.push(a.y); st.z.push(a.z); }
        }
        var r = e && e.rotationRate;
        if (r && (typeof r.alpha === 'number' || typeof r.beta === 'number' || typeof r.gamma === 'number')) st.rot = true;
        if (e && typeof e.interval === 'number' && e.interval > 0) st.interval = e.interval;
      };
      env.addEventListener('devicemotion', st.handler, { passive: true });
      st.attached = true;
      st.off = function () {
        try { if (env.removeEventListener && st.handler) env.removeEventListener('devicemotion', st.handler); } catch (e) { }
        st.attached = false;
      };
    } catch (e) { }
    return st;
  }
  probe('sensors', function (env) {
    if (optedOut(env)) return SKIP;          // 明确拒绝跟踪的访客，连传感器都不碰
    var st = sensorWatch(env);
    var round = function (v) { return v === null ? null : Math.round(v * 1000) / 1000; };
    return new Promise(function (resolve) {
      var started = Date.now();
      var finish = function (value) { if (st.off) st.off(); resolve(value); };
      // 两三个样本算不出采样率和噪声，容易得出 111 Hz 这种假读数，所以先攒够样本；
      // 攒不够就在窗口结束时按已有的报，一个都没有才是 not_run。
      var value = function () {
        var secs = (st.last - st.first) / 1000;
        var hz = secs > 0 ? (st.n - 1) / secs : null;
        var noise = [spread(st.x), spread(st.y), spread(st.z)];
        var any = noise.some(function (v) { return v !== null; });
        return {
          alg: 'devicemotion-passive',
          n: st.n,
          hz: hz === null ? null : Math.round(hz * 10) / 10,
          noise: any ? noise.map(round) : null,
          rot: st.rot,
          interval_ms: st.interval
        };
      };
      var tick = function () {
        if (st.n >= SENSOR_MIN) return finish(value());
        if (Date.now() - started >= SENSOR_WAIT) return finish(st.n >= 2 ? value() : M('not_run'));
        setTimeout(tick, 60);
      };
      tick();
    });
  });
  // ---------- 输入观测（gamepad / agent 共用） ----------
  // 关于"别新增全局捕获器"：这里只挂**一次性的被动监听**（passive、非 capture、
  // 不 preventDefault、不改页面行为）。页面自己没有任何可复用的输入监听——
  // 采集器唯一挂过的监听是 devicemotion（传感器），它拿不到指针/键盘事件。
  // 四个类型挂一次、由两项共用，采集结束就摘掉（不常驻、不抢占页面的事件处理）。
  var INPUT_TYPES = ['pointerdown', 'mousemove', 'keydown', 'touchstart'];
  var INPUT_TRACK_MAX = 20000;     // 页面挂太久就不再累计，避免长期页面无限增长
  // 观测窗口必须**短于整轮里最慢的网络项**：那样它就藏在慢车道后面，不改变信封上传时刻。
  // 有 navigator.userActivation 且已经有过真实手势时直接不等待（见 uaActive）。
  var AGENT_WAIT_DEFAULT = 600;    // agent 的观测窗口上限
  var GAMEPAD_WAIT_DEFAULT = 400;  // gamepad 等真实手势的上限
  var inputState = null;
  // 浏览器自己已经记录过真实用户手势时，不需要再等：activation 已经是既定事实。
  // 这一条把"等待"降级成"立刻重读"，在常见情形下本项不产生任何额外延迟。
  function uaActive(env) {
    var u = safe(function () { return env.navigator && env.navigator.userActivation; }, null);
    return !!(u && u.hasBeenActive === true);
  }
  // 测试/体检工具可以缩短观测窗口（和 __radishManual 一样是**工具钩子**，生产不设）。
  function inputWaitMs(env, dflt) {
    var o = env && env.__radishInputWait;
    if (typeof o === 'number' && isFinite(o) && o >= 0) return Math.min(o, dflt);
    return dflt;
  }
  function inputWatch(env) {
    if (!inputState) {
      inputState = {
        counts: {}, trusted: {}, untrusted: 0, total: 0,
        firstAt: 0, lastAt: 0, t0: Date.now(), attached: false, off: null, handlers: []
      };
    }
    var st = inputState;
    for (var i = 0; i < INPUT_TYPES.length; i++) {
      if (st.counts[INPUT_TYPES[i]] === undefined) st.counts[INPUT_TYPES[i]] = 0;
      if (st.trusted[INPUT_TYPES[i]] === undefined) st.trusted[INPUT_TYPES[i]] = 0;
    }
    if (st.attached) return st;
    function mk(type) {
      return function (e) {
        var now = Date.now();
        st.total++;
        st.counts[type] = (st.counts[type] || 0) + 1;
        if (e && e.isTrusted === true) st.trusted[type] = (st.trusted[type] || 0) + 1;
        else st.untrusted++;
        if (!st.firstAt) st.firstAt = now;
        st.lastAt = now;
        if (st.total >= INPUT_TRACK_MAX && st.off) st.off();
      };
    }
    st.handlers = [];
    try {
      if (!env || !env.addEventListener) return st;
      for (var j = 0; j < INPUT_TYPES.length; j++) {
        var h = mk(INPUT_TYPES[j]);
        st.handlers.push([INPUT_TYPES[j], h]);
        env.addEventListener(INPUT_TYPES[j], h, { passive: true });
      }
      st.attached = true;
      st.off = function () {
        try {
          if (env.removeEventListener) {
            for (var k = 0; k < st.handlers.length; k++) env.removeEventListener(st.handlers[k][0], st.handlers[k][1]);
          }
        } catch (e) { }
        st.handlers = [];
        st.attached = false;
      };
    } catch (e) { }
    return st;
  }
  // 整轮收工就摘掉监听：不常驻、不长期占着页面的事件通道
  function inputStop() {
    try { if (inputState && inputState.off) inputState.off(); } catch (e) { }
  }
  // 等一次"够格的输入"。已经有输入就立刻返回，没输入才等（最多 ms 毫秒）。
  function inputWait(env, ms, pred) {
    var st = inputWatch(env);
    if (pred(st) || !st.attached || ms <= 0) return Promise.resolve(st);
    return new Promise(function (resolve) {
      var started = Date.now();
      var timer = null;
      function tick() {
        if (pred(st) || Date.now() - started >= ms) { if (timer) clearTimeout(timer); resolve(st); return; }
        timer = setTimeout(tick, 50);
      }
      tick();
    });
  }
  function inputActivated(st) {
    return (st.counts.pointerdown || 0) + (st.counts.keydown || 0) + (st.counts.touchstart || 0) > 0;
  }
  function inputAny(st) { return st.total > 0; }

  // gamepad（dev）：先读一次（passive），再在**一次真实用户输入之后**重读。
  // Firefox 在用户手势之前 getGamepads() 可能一律返回空，所以"加载时 0 个"不等于没手柄；
  // needsInteraction=true 只说明这一轮没等到输入，不下"没有手柄"的结论。
  probe('gamepad', function (env) {
    return safe(function () {
      var f = env.navigator && env.navigator.getGamepads;
      if (!f) return M('unsupported');
      function read() {
        var list;
        try { list = f.call(env.navigator) || []; } catch (e) { return null; }
        var pads = [];
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!p) continue;
          pads.push({
            index: typeof p.index === 'number' ? p.index : i,
            id: String(p.id || '').slice(0, 120),
            mapping: p.mapping || null,
            buttons: p.buttons && typeof p.buttons.length === 'number' ? p.buttons.length : 0,
            axes: p.axes && typeof p.axes.length === 'number' ? p.axes.length : 0,
            connected: p.connected === undefined ? null : !!p.connected
          });
        }
        return pads;
      }
      var atLoad = read();
      if (!atLoad) return M('unreadable');
      // 已经有真实手势时不用等：直接重读，windowMs 记 0 并在 basis 里说明来源
      var activated = uaActive(env);
      var waitMs = activated ? 0 : inputWaitMs(env, GAMEPAD_WAIT_DEFAULT);
      function pack(after, needs, basis) {
        var pads = after || atLoad;
        return {
          alg: 'gamepad/2',
          atLoad: atLoad.length,
          afterInput: after ? after.length : null,
          needsInteraction: !!needs,
          pads: pads.slice(0, 8),
          windowMs: waitMs,
          basis: basis,
          source: 'navigator.getGamepads'
        };
      }
      if (activated) return pack(read(), false, 'userActivation');
      return inputWait(env, waitMs, inputActivated).then(function (st) {
        if (!inputActivated(st)) return pack(null, true, 'no-user-activation');
        return pack(read(), false, 'observed-pointerdown');
      });
    }, M('unsupported'));
  });
  probe('conn', function (env) {
    return safe(function () {
      var c = env.navigator.connection || env.navigator.mozConnection || env.navigator.webkitConnection;
      if (!c) return M('unsupported');
      return { eff: c.effectiveType || null, rtt: c.rtt === undefined ? null : c.rtt, down: c.downlink === undefined ? null : c.downlink, save: !!c.saveData };
    }, M('unsupported'));
  });
  // media：媒体输入输出设备（契约原意就是 enumerateDevices 的摄像头/麦克风）
  probe('media', function (env) {
    return new Promise(function (resolve) {
      try {
        var md = env.navigator && env.navigator.mediaDevices;
        if (!md || !md.enumerateDevices) { resolve(M('unsupported')); return; }
        md.enumerateDevices().then(function (d) {
          d = d || [];
          resolve({
            total: d.length,
            audioinput: d.filter(function (x) { return x.kind === 'audioinput'; }).length,
            audiooutput: d.filter(function (x) { return x.kind === 'audiooutput'; }).length,
            videoinput: d.filter(function (x) { return x.kind === 'videoinput'; }).length,
            // 未授权时浏览器只给空标签，数量仍是可见数量，不代表真实硬件数
            labels: d.filter(function (x) { return !!x.label; }).length
          });
        }).catch(function () { resolve(M('unreadable')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  // audiohw：音频硬件的实际采样率与延迟（契约原意是 AudioContext.sampleRate）
  probe('audiohw', function (env) {
    return safe(function () {
      var A = env.AudioContext || env.webkitAudioContext || (env.window && env.window.AudioContext);
      if (!A) return M('unsupported');
      var a = new A();
      var out = {
        rate: a.sampleRate || null,
        base: a.baseLatency === undefined ? null : a.baseLatency,
        output: a.outputLatency === undefined ? null : a.outputLatency,
        channels: (a.destination && typeof a.destination.maxChannelCount === 'number')
          ? a.destination.maxChannelCount : null
      };
      try { if (a.close) a.close(); } catch (e) { }
      return out;
    }, M('unsupported'));
  });
  // bio（dev）：通行密钥能力。
  // 老浏览器只有 isUVPAA（"有没有平台验证器"），参考站还读 getClientCapabilities()
  // 的逐项能力（条件获取/创建、混合传输、passkey 平台验证器、related origins 等）。
  // 有 getClientCapabilities 就用它并逐项记真值；没有就把 basis 写成 isUVPAA，
  // 绝不把"接口不在"说成"能力为 false"。
  var BIO_CAPS = ['conditionalGet', 'conditionalCreate', 'hybridTransport',
    'passkeyPlatformAuthenticator', 'relatedOrigins', 'signalAllAcceptedCredentials',
    'signalUnknownCredential', 'userVerifyingPlatformAuthenticator'];
  probe('bio', function (env) {
    return new Promise(function (resolve) {
      try {
        var p = env.PublicKeyCredential;
        if (!p) { resolve(M('unsupported')); return; }
        var uvpP = (typeof p.isUserVerifyingPlatformAuthenticatorAvailable === 'function')
          ? Promise.resolve().then(function () { return p.isUserVerifyingPlatformAuthenticatorAvailable(); })
            .then(function (v) { return !!v; }, function () { return null; })
          : Promise.resolve(null);
        // 有的实现里 getClientCapabilities 是同步返回对象的，所以统一 then 一次
        var capP = (typeof p.getClientCapabilities === 'function')
          ? Promise.resolve().then(function () { return p.getClientCapabilities(); })
            .then(function (v) { return (v && typeof v === 'object') ? v : null; }, function () { return null; })
          : Promise.resolve(null);
        Promise.all([uvpP, capP]).then(function (r) {
          var uvpVal = r[0], capRaw = r[1];
          var uvp = { isUVPAA: uvpVal === null || uvpVal === undefined ? null : !!uvpVal, source: 'isUserVerifyingPlatformAuthenticatorAvailable' };
          var caps = null;
          if (capRaw) {
            caps = {};
            var n = 0, i, k;
            for (i = 0; i < BIO_CAPS.length; i++) {
              k = BIO_CAPS[i];
              if (!(k in capRaw)) continue;
              caps[k] = capRaw[k] === true;
              n++;
            }
            // 浏览器额外返回的布尔项也留着（上限 16 个），但不认识的对象不往里塞
            for (k in capRaw) {
              if (n >= 16) break;
              if (k.charAt(0) === '_') continue;
              if (typeof capRaw[k] !== 'boolean') continue;
              if (Object.prototype.hasOwnProperty.call(caps, k)) continue;
              caps[k] = capRaw[k] === true;
              n++;
            }
            if (!n) caps = null;
          }
          if (!caps && uvp.isUVPAA === null) { resolve(M('unsupported')); return; }
          resolve({
            alg: 'pk-capabilities/1',
            uvp: uvp,
            capabilities: caps,
            basis: caps ? 'getClientCapabilities' : 'isUVPAA'
          });
        }, function () { resolve(M('unreadable')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  // 有的实现 getAvailability() 既不回也不报错，所以这一项自己限时：1.5 秒没答案就
  // 落成 timeout（状态，不是 false），也不再拖到整轮期限里去占 meta.stuck。
  probe('bt', function (env) {
    try {
      var b = env.navigator && env.navigator.bluetooth;
      if (!b) return M('unsupported');
      if (!b.getAvailability) return { api: true, available: null };
      // 三种结局要分开：回了 true/false、报错（没读到）、压根不回答（timeout）
      var silence = { silent: true };
      var asked = Promise.resolve().then(function () { return b.getAvailability(); })
        .catch(function () { return null; });
      return within(asked, 1500, silence).then(function (v) {
        if (v === silence) return M('timeout');
        if (v === null) return { api: true, available: null };
        return { api: true, available: !!v };
      });
    } catch (e) { return M('unsupported'); }
  });
  probe('xr', function (env) {
    return new Promise(function (resolve) {
      try {
        var x = env.navigator.xr;
        if (!x || !x.isSessionSupported) { resolve(M('unsupported')); return; }
        // 查询失败返回 null：那一路是"没读到"，不能变成 false
        Promise.all([x.isSessionSupported('immersive-vr').catch(function () { return null; }), x.isSessionSupported('immersive-ar').catch(function () { return null; })]).then(function (r) {
          var out = { vr: r[0] === null ? null : !!r[0], ar: r[1] === null ? null : !!r[1] };
          if (out.vr === null && out.ar === null) return resolve(M('unreadable'));
          resolve(out);
        });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  var CODECS = {
    h264: 'video/mp4; codecs="avc1.42E01E"',
    hev1: 'video/mp4; codecs="hev1.1.6.L93.B0"',
    vp8: 'video/webm; codecs="vp8"',
    vp9: 'video/webm; codecs="vp9"',
    av01: 'video/mp4; codecs="av01.0.05M.08"',
    opus: 'audio/webm; codecs="opus"',
    flac: 'audio/ogg; codecs="flac"',
    mp3: 'audio/mpeg',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    alac: 'audio/mp4; codecs="alac"'
  };
  probe('codecs', function (env) {
    return safe(function () {
      var MS = env.MediaSource;
      if (!MS || !MS.isTypeSupported) return M('unsupported');
      var out = {};
      for (var k in CODECS) out[k] = !!MS.isTypeSupported(CODECS[k]);
      return out;
    }, M('unsupported'));
  });
  probe('rtccodecs', function (env) {
    return safe(function () {
      // 注意：静态 getCapabilities 挂在 RTCRtpSender / RTCRtpReceiver 上，RTCPeerConnection 没有
      var S = env.RTCRtpSender, R = env.RTCRtpReceiver;
      if (!(S && S.getCapabilities) && !(R && R.getCapabilities)) return M('unsupported');
      var get = function (kind) { return (S && S.getCapabilities) ? S.getCapabilities(kind) : R.getCapabilities(kind); };
      var a = safe(function () { return get('audio').codecs.map(function (c) { return c.mimeType; }); }, []);
      var v = safe(function () { return get('video').codecs.map(function (c) { return c.mimeType; }); }, []);
      if (!a.length && !v.length) return M('unsupported');
      return {
        audio: a.slice(0, 12), video: v.slice(0, 16),
        audioTotal: a.length, videoTotal: v.length,
        truncated: a.length > 12 || v.length > 16
      };
    }, M('unsupported'));
  });
  probe('recmime', function (env) {
    return safe(function () {
      var MR = env.MediaRecorder;
      if (!MR || !MR.isTypeSupported) return M('unsupported');
      var list = ['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'video/mp4'];
      // 报告里仍用短名，但探测时给完整编码串，否则 Chrome 会在控制台抱怨"有歧义"
      var full = { 'video/webm;codecs=vp9': 'video/webm;codecs="vp09.00.10.08"' };
      var out = {};
      for (var i = 0; i < list.length; i++) {
        // 单条写法非法时 Chrome 会抛错，不能让整项变成 unsupported
        (function (key) {
          try { out[key] = !!MR.isTypeSupported(full[key] || key); }
          catch (e) { out[key] = M('error'); }
        })(list[i]);
      }
      return out;
    }, M('unsupported'));
  });
  probe('hwdec', function (env) {
    return new Promise(function (resolve) {
      try {
        var mc = env.navigator.mediaCapabilities;
        if (!mc || !mc.decodingInfo) { resolve(M('unsupported')); return; }
        var cfgs = {
          h2648: { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          hevc: { type: 'file', video: { contentType: 'video/mp4; codecs="hev1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          av1: { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          vp9: { type: 'file', video: { contentType: 'video/webm; codecs="vp09.00.10.08"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } }
        };
        var keys = Object.keys(cfgs), out = {};
        Promise.all(keys.map(function (k) {
          return mc.decodingInfo(cfgs[k]).then(function (r) {
            // 只报 powerEfficient 会让"能解但费电"看起来像"不能解"，三项都留下
            out[k] = { supported: !!r.supported, smooth: !!r.smooth, powerEfficient: !!r.powerEfficient };
          }).catch(function () { out[k] = M('unreadable'); });
        })).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('drm', function (env) {
    return new Promise(function (resolve) {
      try {
        var n = env.navigator;
        if (!n.requestMediaKeySystemAccess) { resolve(M('unsupported')); return; }
        // Firefox 的 EME 只在内容解密的上下文里给结果，这里问只会得到假的"不支持"
        if (/Firefox|FxiOS/.test(n.userAgent || '')) { resolve(M('not_run')); return; }
        // robustness 不写，Chrome 会在控制台抱怨；写死了也不影响"能不能放"的判断
        var sets = {
          widevine: ['com.widevine.alpha', 'SW_SECURE_CRYPTO'],
          playready: ['com.microsoft.playready', 'SW_SECURE_DECODE'],
          fairplay: ['com.apple.fps.1_0', null],
          clearkey: ['org.w3.clearkey', null]
        };
        var keys = Object.keys(sets), out = {};
        Promise.all(keys.map(function (k) {
          var vcap = { contentType: 'video/mp4; codecs="avc1.42E01E"' };
          if (sets[k][1]) vcap.robustness = sets[k][1];
          var cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [vcap] }];
          return n.requestMediaKeySystemAccess(sets[k][0], cfg).then(function () { out[k] = true; }).catch(function () { out[k] = false; });
        })).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('storage', function (env) {
    return new Promise(function (resolve) {
      try {
        var sm = env.navigator.storage;
        if (!sm || !sm.estimate) { resolve(M('unsupported')); return; }
        sm.estimate().then(function (e) {
          // usage 为 0、quota 为 0 都是合法读数（新配额策略、隐私模式），用 || 会把它们变成 null
          resolve({
            quota: typeof e.quota === 'number' ? e.quota : null,
            usage: typeof e.usage === 'number' ? e.usage : null,
            details: e.usageDetails && typeof e.usageDetails === 'object' ? Object.keys(e.usageDetails).length : null
          });
        }).catch(function () { resolve(M('unreadable')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });

  // ============ brw · 24 项 ============
  // 媒体查询"不匹配"和"不认识这个查询"是两件事：不认识的查询返回 media === 'not all'。
  // 只读 matches 会把"浏览器不支持"说成"用户没选这个偏好"。
  function mqRaw(env, q) {
    try {
      if (!env.matchMedia) return null;
      var m = env.matchMedia(q);
      if (!m) return null;
      if (m.media === 'not all' && !m.matches) return { supported: false, matches: null };
      return { supported: true, matches: !!m.matches };
    } catch (e) { return null; }
  }
  function mq(env, q) { var r = mqRaw(env, q); return r && r.supported ? r.matches : null; }
  probe('scheme', function (env) {
    return safe(function () {
      var d = mqRaw(env, '(prefers-color-scheme: dark)');
      if (!d) return M('unsupported');
      if (!d.supported) return M('unreadable');
      return d.matches ? 'dark' : 'light';
    }, M('unsupported'));
  });
  probe('motion', function (env) {
    return safe(function () {
      var r = mqRaw(env, '(prefers-reduced-motion: reduce)');
      if (!r) return M('unsupported');
      if (!r.supported) return M('unreadable');
      return r.matches ? 'reduce' : 'no-preference';
    }, M('unsupported'));
  });
  probe('gamut', function (env) {
    return safe(function () {
      var r20 = mqRaw(env, '(color-gamut: rec2020)'), p3 = mqRaw(env, '(color-gamut: p3)'), srgb = mqRaw(env, '(color-gamut: srgb)');
      if (!srgb || !srgb.supported) return M('unreadable');
      var g = (r20 && r20.matches) ? 'rec2020' : (p3 && p3.matches) ? 'p3' : 'srgb';
      var dr = mqRaw(env, '(dynamic-range: high)');
      return { gamut: g, dynamic: !dr || !dr.supported ? null : (dr.matches ? 'high' : 'standard') };
    }, M('unsupported'));
  });
  probe('a11y', function (env) {
    return safe(function () {
      var more = mqRaw(env, '(prefers-contrast: more)'), less = mqRaw(env, '(prefers-contrast: less)'), custom = mqRaw(env, '(prefers-contrast: custom)');
      var any = more && more.supported ? more : (less && less.supported ? less : custom);
      if (!any) return M('unreadable');
      var c = (more && more.matches) ? 'more' : (less && less.matches) ? 'less' : (custom && custom.matches) ? 'custom' : 'no-preference';
      var forced = mqRaw(env, '(forced-colors: active)');
      return { contrast: c, forced: !forced || !forced.supported ? null : !!forced.matches };
    }, M('unsupported'));
  });
  probe('sysui', function (env) {
    // 量的是"系统默认字号与系统色"。元素要被隔离（all:initial + 显式 medium 字号），
    // 否则读到的是本站 CSS 的结果，不是系统设置。
    return safe(function () {
      var doc = env.document;
      if (!doc || !doc.body || !env.getComputedStyle) return M('unsupported');
      var d = doc.createElement('div');
      d.setAttribute('style', 'all:initial;position:absolute;left:-9999px;top:0;font-size:medium;color:CanvasText;background-color:Canvas;accent-color:AccentColor');
      doc.body.appendChild(d);
      var cs = env.getComputedStyle(d);
      var out = {
        alg: 'isolated-medium',
        fontSize: cs ? parseFloat(cs.fontSize) || null : null,
        color: cs ? (cs.color || null) : null,
        background: cs ? (cs.backgroundColor || null) : null,
        accent: cs ? (cs.accentColor || null) : null
      };
      doc.body.removeChild(d);
      // 系统色解析不出具体颜色（返回原关键字）时，这一项就是没读到
      if (out.accent && !/^rgb|^#/.test(out.accent)) out.accent = null;
      if (out.fontSize === null && out.accent === null) return M('unreadable');
      return out;
    }, M('unsupported'));
  });
  probe('display', function (env) {
    return safe(function () {
      var modes = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay', 'tabbed'];
      var known = false;
      for (var i = 0; i < modes.length; i++) {
        var r = mqRaw(env, '(display-mode: ' + modes[i] + ')');
        if (!r || !r.supported) continue;
        known = true;
        if (r.matches) return modes[i];
      }
      var browser = mqRaw(env, '(display-mode: browser)');
      if (!known || (browser && browser.supported && !browser.matches)) return M('unreadable');
      return 'browser';
    }, M('unsupported'));
  });
  probe('dnt', function (env) {
    return safe(function () {
      var n = env.navigator;
      var raw = n.doNotTrack;
      var dnt = (raw === undefined || raw === null || raw === '') ? null : String(raw);
      return { dnt: dnt, gpc: n.globalPrivacyControl === true };
    }, M('unsupported'));
  });
  probe('cookies', function (env) { return safe(function () { return env.navigator.cookieEnabled === undefined ? null : !!env.navigator.cookieEnabled; }, M('unsupported')); });
  // perms（brw）：权限查询范围扩到参考站量级。
  // 逐项保留五种结果，**绝不把"查询失败"当成"没有权限"**：
  //   granted / denied / prompt      浏览器答了这三种之一
  //   unsupported                    答了别的（或这个版本没有该权限的描述符）
  //   unsupported-name               这个名字被 query 直接拒（例如 camera / microphone
  //                                  在 Chrome 里不是合法权限名，会抛 TypeError）——
  //                                  这是"名字不被接受"，不是"没有权限"，也不是"提示中"
  //   error                          查询报错或在自己期限内没答上来（没读到，不是结论）
  var PERM_NAMES = [
    'geolocation', 'notifications', 'midi', 'camera', 'microphone',
    'background-sync', 'local-fonts', 'persistent-storage', 'ambient-light-sensor',
    'accelerometer', 'gyroscope', 'magnetometer', 'screen-wake-lock',
    'window-management', 'storage-access', 'top-level-storage-access',
    'display-capture', 'capture-controller', 'clipboard-read', 'clipboard-write',
    'idle-detection'
  ];
  var PERM_TIMEOUT = 1000;
  probe('perms', function (env) {
    return new Promise(function (resolve) {
      var p = null;
      try { p = env.navigator && env.navigator.permissions; } catch (e) { p = null; }
      if (!p || typeof p.query !== 'function') { resolve(M('unsupported')); return; }
      var items = {};
      var jobs = PERM_NAMES.map(function (name) {
        var asked;
        // ① 同步抛：名字本身不被接受
        try { asked = p.query({ name: name }); }
        catch (e) { items[name] = 'unsupported-name'; return Promise.resolve(); }
        return within(Promise.resolve(asked).then(function (r) {
          var s = r && typeof r.state === 'string' ? r.state : '';
          if (s === 'granted' || s === 'denied' || s === 'prompt') items[name] = s;
          else items[name] = 'unsupported';
        }, function (e) {
          var nm = e && e.name ? String(e.name) : '';
          items[name] = (nm === 'TypeError' || nm === 'NotSupportedError') ? 'unsupported-name' : 'error';
        }), PERM_TIMEOUT, null).then(function (viaTimeout) {
          if (viaTimeout === null && items[name] === undefined) items[name] = 'error';
        });
      });
      Promise.all(jobs).then(function () {
        var counts = { granted: 0, denied: 0, prompt: 0, unsupported: 0, 'unsupported-name': 0, error: 0 };
        for (var i = 0; i < PERM_NAMES.length; i++) {
          var s = items[PERM_NAMES[i]] || 'error';
          counts[s] = (counts[s] || 0) + 1;
        }
        counts.total = PERM_NAMES.length;
        resolve({ alg: 'permissions-query/2', items: items, counts: counts, basis: 'permissions.query', queryTimeoutMs: PERM_TIMEOUT });
      });
    });
  });
  probe('apis', function (env) {
    // 有些 API 根本不挂在 navigator 上：Web NFC 是 NDEFReader 构造函数，
    // Idle Detection 是 IdleDetector。原来查 n.nfc / n.idle 永远 false。
    // I：第二批把参考站的敏感接口补齐。全部只记**接口存在性**（构造函数/方法在不在），
    // 不代表用户授权过、也不代表真能用。既有布尔清单一个字都不动，新项追加在后面。
    return safe(function () {
      var n = env.navigator || {}, w = env.window || env, out = {};
      var list = ['usb', 'serial', 'hid', 'share', 'clipboard', 'wakeLock', 'credentials', 'serviceWorker', 'gpu', 'bluetooth', 'storage', 'presentation', 'contacts'];
      for (var i = 0; i < list.length; i++) out[list[i]] = !!n[list[i]];
      out.nfc = !!(env.NDEFReader || (env.window && env.window.NDEFReader));
      out.idle = !!(env.IdleDetector || (env.window && env.window.IdleDetector));
      out.serialBasis = n.serial ? 'navigator.serial' : null;
      out.alg = 'apis/2';
      out.pressure = !!(env.PressureObserver || w.PressureObserver);                       // Compute Pressure
      out.localFonts = typeof n.queryLocalFonts === 'function';                            // Local Font Access
      out.screenDetails = typeof n.getScreenDetails === 'function';                         // Window Management
      out.midi = typeof n.requestMIDIAccess === 'function';                                 // Web MIDI
      out.filePicker = typeof w.showOpenFilePicker === 'function';                          // File System Access
      out.idleDetector = !!(env.IdleDetector || w.IdleDetector);                            // Idle Detection
      out.contactsManager = !!(env.ContactsManager || w.ContactsManager);                   // Contact Picker
      // Translator / LanguageModel 的 availability 已经在 ai 那一项扫过，这里只留"接口在不在"，
      // 不重复探测（重复扫 19 种语言在低端机上就是白花主线程时间）。
      out.translator = !!(env.Translator || w.Translator);
      out.languageModel = !!(env.LanguageModel || w.LanguageModel);
      out.aiBasis = 'presence-only';
      out.eyeDropper = !!(env.EyeDropper || w.EyeDropper);
      out.webTransport = !!(env.WebTransport || w.WebTransport);
      out.fedcm = !!(env.IdentityCredential || w.IdentityCredential);
      // Digital Credentials：真正的入口是 navigator.credentials.get({digital:…})，
      // 不弹框就没法探测，所以只记构造函数的存不存在，别声称"能取到证件"。
      out.digitalCredential = !!(env.DigitalCredential || w.DigitalCredential);
      out.digitalCredentialsBasis = 'constructor-presence';
      return out;
    }, M('unsupported'));
  });
  // 浏览器自带的模型：只问 availability()，不触发下载。翻译能力必须带
  // {sourceLanguage, targetLanguage} 才会回答——不传参数的旧写法在新版 Chrome 直接抛错，
  // 所以以前读不到不是"不支持"，是问法不对。
  var AI_LANGS = ['zh', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar',
    'hi', 'it', 'vi', 'th', 'id', 'tr', 'pl', 'nl', 'uk'];
  var AI_WAIT = 2000;
  function aiAsk(fn) {
    return within(Promise.resolve().then(fn), AI_WAIT, null);
  }
  probe('ai', function (env) {
    try {
      var w = env.window || env;
      var LM = env.LanguageModel || w.LanguageModel || env.Summarizer || w.Summarizer;
      var TR = env.Translator || w.Translator;
      if (!LM && !TR) return M('unsupported');
      var out = { basis: 'availability-sweep' };
      var jobs = [];
      if (LM && LM.availability) {
        jobs.push(aiAsk(function () { return LM.availability(); }).then(function (v) {
          out.model = v === null ? null : String(v);
        }));
      }
      if (TR && TR.availability) {
        jobs.push(Promise.all(AI_LANGS.map(function (l) {
          return aiAsk(function () { return TR.availability({ sourceLanguage: 'en', targetLanguage: l }); })
            .then(function (v) { return [l, v === null ? null : String(v)]; });
        })).then(function (rows) {
          // 一种都没答上来 ≠ 一种语言都没装：这两种情况不能混成 langs: []
          out.translator_answered = rows.some(function (r) { return r[1] !== null; });
          out.langs = rows.filter(function (r) { return r[1] === 'available'; }).map(function (r) { return r[0]; });
          out.langs_total = AI_LANGS.length;
        }));
      }
      if (!jobs.length) return { api: true, basis: 'availability-no-reader' };
      return Promise.all(jobs).then(function () {
        if (out.model === null && out.translator_answered !== true) return M('unreadable');
        return out;
      });
    } catch (e) { return M('unsupported'); }
  });
  probe('webdriver', function (env) { return safe(function () { return env.navigator.webdriver === true; }, M('unsupported')); });
  probe('pdf', function (env) {
    return safe(function () {
      var n = env.navigator;
      if (n.pdfViewerEnabled !== undefined) return !!n.pdfViewerEnabled;
      if (n.plugins) for (var i = 0; i < n.plugins.length; i++) if (/pdf/i.test(n.plugins[i].name || '')) return true;
      return M('unsupported');
    }, M('unsupported'));
  });
  // 空插件列表不是自动化证据：Android Chrome、iOS 上的浏览器、以及关掉内置 PDF 的
  // 桌面 Chrome 都能合法返回 0 个插件（旧实现在安卓上把正常浏览器报成 plugins-empty）。
  // 只有"自己声明内置 PDF 可用、却一个插件都没有"这种自相矛盾才算痕迹，而且只是提示。
  function pluginsContradiction(env) {
    var n = (env && env.navigator) || {};
    if (!n.plugins || n.plugins.length !== 0) return false;
    if (n.pdfViewerEnabled !== true) return false;
    return /Chrome|Chromium/i.test(n.userAgent || '');
  }
  // J：常见驱动/自动化框架建立的全名。命中要**逐条记名字**，不合并成一个布尔。
  var DRIVER_GLOBALS = [
    '__nightmare', '_phantom', 'callPhantom', '__selenium_unwrapped', '__selenium_evaluate',
    '__webdriver_evaluate', '__driver_evaluate', '__fxdriver_evaluate',
    '_Selenium_IDE_Recorder', '__lastWatirAlert', '__lastWatirConfirm', '__lastWatirPrompt',
    'domAutomation', 'domAutomationController',
    '$cdc_asdjflasutopfhvcZLmcfl_', 'cdc_adoQpoasnfa76pfcZLmcfl_', '$wdc_', '_WEBDRIVER_ELEM_CACHE'
  ];
  var DRIVER_PREFIX = ['__playwright', '__puppeteer', '__nightmare'];
  probe('auto', function (env) {
    return safe(function () {
      var out = [], w = env, n = env.navigator || {};
      if (n.webdriver === true) out.push('webdriver');
      if (w.callPhantom) out.push('phantom');
      if (w._phantom) out.push('_phantom');
      if (w.__nightmare) out.push('__nightmare');
      if (w.Buffer) out.push('node-buffer');
      if (w.process && w.process.versions && w.process.versions.node) out.push('node-process');
      if (w.emit) out.push('node-emit');
      if (w.domAutomation) out.push('domAutomation');
      if (w.domAutomationController) out.push('domAutomationController');
      if (n.userAgent && /HeadlessChrome/.test(n.userAgent)) out.push('headless-ua');
      if (w.external && w.external.toString && /Sequentum|Selenium/.test(String(w.external)))
        out.push('external');
      if (pluginsContradiction(env)) out.push('plugins-empty-pdf-conflict');
      // 逐条记驱动全局名（命中哪个记哪个）
      for (var i = 0; i < DRIVER_GLOBALS.length; i++) {
        var name = DRIVER_GLOBALS[i], hit = false;
        try { hit = typeof w[name] !== 'undefined'; } catch (e) { hit = false; }
        if (hit && out.indexOf(name) < 0) out.push(name);
      }
      // 前缀族（__playwright / __puppeteer 的变体）：记下**真实键名**，不猜具体版本
      try {
        var keys = Object.keys(w);
        for (var j = 0; j < keys.length && out.length < 24; j++) {
          var k = keys[j];
          for (var p = 0; p < DRIVER_PREFIX.length; p++) {
            if (k.indexOf(DRIVER_PREFIX[p]) === 0 && out.indexOf(k) < 0) { out.push(k); break; }
          }
        }
      } catch (e2) { }
      // 组合弱信号：单独一条不足以说自动化，凑在一起才有意义。
      // 空插件列表**本身不是证据**（安卓 Chrome / iOS 浏览器 / 关掉内置 PDF 的桌面 Chrome
      // 都会合法返回 0 个插件），所以它只作为"组合里的一票"。
      var combos = [];
      var pluginCount = (n.plugins && typeof n.plugins.length === 'number') ? n.plugins.length : null;
      var langs = n.languages ? Array.prototype.slice.call(n.languages, 0, 12) : null;
      var langsOdd = !langs || !langs.length;
      var headless = !!(n.userAgent && /HeadlessChrome/.test(n.userAgent));
      var driverHit = false;
      for (var d = 0; d < out.length; d++) {
        if (DRIVER_GLOBALS.indexOf(out[d]) >= 0) { driverHit = true; break; }
        if (out[d].indexOf('__playwright') === 0 || out[d].indexOf('__puppeteer') === 0) { driverHit = true; break; }
      }
      if (n.webdriver === true && pluginCount === 0) combos.push('webdriver+empty-plugins');
      if (n.webdriver === true && langsOdd) combos.push('webdriver+languages-anomaly');
      if (headless && pluginCount === 0) combos.push('headless-ua+empty-plugins');
      if (driverHit && pluginCount === 0) combos.push('driver-global+empty-plugins');
      // level 只说"这一轮看到的痕迹强度"，不是"是不是机器人"
      var strong = false;
      for (var s2 = 0; s2 < out.length; s2++) if (out[s2] !== 'plugins-empty-pdf-conflict') { strong = true; break; }
      var level = strong ? 'strong' : ((out.length || combos.length) ? 'weak' : 'none');
      return {
        alg: 'auto/2',
        signals: out,
        combos: combos,
        comboCount: combos.length,
        level: level,
        note: '空插件列表本身不是证据：安卓 Chrome、iOS 浏览器、关掉内置 PDF 的桌面 Chrome 都能合法返回 0 个插件'
      };
    }, M('unsupported'));
  });
  probe('idstr', function (env) {
    return safe(function () {
      var n = env.navigator, plugins = [];
      if (n.plugins) for (var i = 0; i < Math.min(n.plugins.length, 20); i++) plugins.push(n.plugins[i].name || '');
      return { vendor: n.vendor || null, productSub: n.productSub || null, plugins: plugins };
    }, M('unsupported'));
  });
  // agent（brw）：原来只测"UA 与 Client Hints 品牌版本是否自相矛盾"，名字却像行为分析。
  // K：补上行为维度——观测窗口内的输入事件计数与 isTrusted。口径必须写死：
  //   - 没有输入 → level 'insufficient-observation'，**不判自动化**（短访问本来就没交互）
  //   - 有输入但混着 isTrusted=false → 'untrusted-input'（脚本合成事件的迹象，只是迹象）
  //   - 有输入且全部 isTrusted → 'trusted-input'
  // 观测用的是与 gamepad 共用的一次性被动监听（非 capture、不拦默认行为），
  // 窗口上限 1200ms 且与慢车道并行，不延长整轮死信。
  probe('agent', function (env) {
    return safe(function () {
      var uad = uaData(env), ua = env.navigator.userAgent || '';
      var kind = 'unknown', consistent = null;
      if (uad && uad.brands) {
        kind = uad.brands.map(function (b) { return b.brand; }).join(',');
        var major = uad.brands.filter(function (b) { return !/Not/.test(b.brand); }).map(function (b) { return b.version; })[0];
        var m = ua.match(/Chrome\/(\d+)/);
        consistent = !!(major && m && String(major).split('.')[0] === m[1]);
      } else if (/Firefox/.test(ua)) { kind = 'Firefox'; consistent = true; }
      else if (/Safari/.test(ua) && /Version/.test(ua)) { kind = 'Safari'; consistent = true; }
      var uaCh = { kind: kind, consistent: consistent, alg: 'ua-ch-brand-consistency', basis: 'ua-ch-vs-ua' };
      var activated = uaActive(env);
      var waitMs = activated ? 0 : inputWaitMs(env, AGENT_WAIT_DEFAULT);
      return inputWait(env, waitMs, inputAny).then(function (st) {
        var total = st.total || 0;
        var input = {
          pointerdown: st.counts.pointerdown || 0,
          mousemove: st.counts.mousemove || 0,
          keydown: st.counts.keydown || 0,
          touchstart: st.counts.touchstart || 0,
          total: total,
          // 一个事件都没观测到时不是"全部可信"，是"没有证据"：留 null
          trustedAll: total ? st.untrusted === 0 : null,
          untrusted: st.untrusted || 0,
          windowMs: Math.max(0, (st.lastAt || Date.now()) - st.t0)
        };
        var level;
        if (!total) level = 'insufficient-observation';
        else if (st.untrusted > 0) level = 'untrusted-input';
        else level = 'trusted-input';
        return {
          alg: 'agent/2', uaCh: uaCh, input: input, level: level,
          waitMs: waitMs, userActivation: activated,
          basis: activated ? 'userActivation' : (total ? 'observed-input' : 'observation-window-expired')
        };
      });
    }, M('unsupported'));
  });
  probe('worker', function (env) {
    // A-06：这一项的每条结束路径（成功 / 沉默超时 / onerror / 构造抛错 / postMessage 抛错）
    // 都必须走同一个幂等的 finish()：清定时器、摘事件、terminate()、revokeObjectURL()。
    // 旧实现只有 onmessage 成功那条做了清理，超时路径（审查用永不回消息的替身复现）
    // 返回 timeout 时 terminate/revoke 计数都是 0——Worker 和 blob URL 就这么漏在那儿。
    return new Promise(function (resolve) {
      var W = null, B = null, U = null, url = null, w = null, t = null;
      var finished = false;
      function finish(v) {
        if (finished) return v;            // 幂等：重复调用不会二次 terminate / revoke
        finished = true;
        if (t !== null) { try { clearTimeout(t); } catch (e) { } t = null; }
        if (w) {
          try { w.onmessage = null; } catch (e) { }
          try { w.onerror = null; } catch (e) { }
          try { w.terminate(); } catch (e) { }
          w = null;
        }
        if (url && U) { try { U.revokeObjectURL(url); } catch (e) { } url = null; }
        resolve(v);
        return v;
      }
      try {
        W = env.Worker; B = env.Blob; U = env.URL;
        if (!W || !B || !U || !U.createObjectURL) return finish(M('unsupported'));
      } catch (e) { return finish(M('unsupported')); }
      // Worker 里读 与 主线程 同名的四项（参考站也是比这四项）：UA、语言、平台、时区。
      // 用 ES5 写（老 Safari 的 Worker 也一样跑），postMessage 回一个对象。
      var src = 'self.onmessage=function(){' +
        'var n=self.navigator||{};' +
        'var tz=null;try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||null}catch(e){}' +
        'var lg=null;try{lg=n.languages?Array.prototype.slice.call(n.languages,0,12):null}catch(e){}' +
        'self.postMessage({ua:n.userAgent||null,langs:lg,platform:n.platform||null,tz:tz})}';
      try {
        url = U.createObjectURL(new B([src], { type: 'text/javascript' }));
      } catch (e) { return finish(M('unsupported')); }
      try {
        w = new W(url);
      } catch (e) { return finish(M('unsupported')); }     // CSP/沙箱拒绝构造：清掉 blob URL
      function mainValue(fn) { return safe(fn, null); }
      var mainUa = mainValue(function () { return env.navigator ? env.navigator.userAgent : null; });
      var mainLangs = mainValue(function () { return env.navigator && env.navigator.languages ? Array.prototype.slice.call(env.navigator.languages, 0, 12) : null; });
      var mainPlatform = mainValue(function () { return env.navigator ? env.navigator.platform : null; });
      var mainTz = mainValue(function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } });
      function sameOf(main, inner) {
        if (main === null || inner === null || inner === undefined) return null;   // 有一边没读到就不知道
        if (Object.prototype.toString.call(main) === '[object Array]' || Object.prototype.toString.call(inner) === '[object Array]') {
          var a = main || [], b = inner || [];
          if (a.length !== b.length) return false;
          for (var i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
          return true;
        }
        return String(main) === String(inner);
      }
      try {
        t = setTimeout(function () { finish(M('timeout')); }, 2000);
        w.onmessage = function (e) {
          var d = e && e.data;
          // 老替身可能只回一个字符串（UA）：也认，只是另三项没法比
          var got = (d && typeof d === 'object') ? d : { ua: typeof d === 'string' ? d : null, langs: null, platform: null, tz: null };
          finish({
            ok: true,
            uaSame: got.ua === null || got.ua === undefined ? null : got.ua === mainUa,
            langsSame: sameOf(mainLangs, got.langs),
            platformSame: sameOf(mainPlatform, got.platform),
            tzSame: sameOf(mainTz, got.tz),
            // 原始读数各留一份：主线程值与 Worker 内值，免得只有"一致/不一致"这一个布尔
            main: { langs: mainLangs, platform: mainPlatform, tz: mainTz },
            worker: { langs: got.langs === undefined ? null : got.langs, platform: got.platform || null, tz: got.tz || null },
            basis: 'worker-vs-main'
          });
        };
        w.onerror = function () { finish(M('error')); };    // 脚本本身跑不起来：收尾并如实记 error
        w.postMessage(1);
      } catch (e) { return finish(M('error')); }            // postMessage 抛错（已被终止等）
    });
  });
  // adblock（brw）：① DOM 诱饵元素（cosmetic 规则会把它隐藏）+ ② 一个已知广告脚本 URL
  // 的 no-cors 请求 + ③ 一个**同源静态资源**对照。
  // 读法（口径写死）：对照取不到 → verdict 'unknown'，任何"被拦截"的结论都不成立；
  // 对照通、广告 URL 取不到 → 'blocked'（no-cors 只能说明"没取到"，拦截是主要但非唯一原因）；
  // 两条都通 → 'reachable'。广告 URL 用 no-cors 发，响应是 opaque，证明不了状态码与脚本内容。
  var AD_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  var AD_TIMEOUT = 800;
  probe('adblock', function (env, ctx) {
    return safe(function () {
      var doc = env.document;
      var baitP = new Promise(function (res) {
        try {
          var d = doc.createElement('div');
          d.className = 'adsbox ad-banner adsbygoogle pub_300x250';
          d.style.cssText = 'position:absolute;left:-9999px;width:300px;height:250px';
          doc.body.appendChild(d);
          setTimeout(function () {
            var hidden = d.offsetHeight === 0 || d.clientHeight === 0 ||
              !!(env.getComputedStyle && env.getComputedStyle(d).display === 'none');
            try { doc.body.removeChild(d); } catch (e) { }
            res({ hidden: !!hidden, waitMs: 120 });
          }, 120);
        } catch (e) { res({ hidden: null, waitMs: null }); }
      });
      // 对照用**本脚本自己的 URL**：它一定存在（页面刚加载过它），也不再额外打第三方。
      var controlUrl = SELF_SRC || safe(function () {
        return String((env.location && env.location.origin) || '') + '/static/radish-collect.js';
      }, '');
      var f = env.fetch;
      function probeUrl(url, ms) {
        if (typeof f !== 'function' || !url) return Promise.resolve({ url: url || null, state: 'unsupported', ms: null });
        var started = Date.now();
        var opts = { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
        var sig = requestSignal(env, ctx, ms);
        if (sig) opts.signal = sig;
        return within(
          Promise.resolve().then(function () { return f(url, opts); })
            .then(function () { return 'reachable'; }, function () { return 'unreachable'; }),
          ms, 'timeout'
        ).then(function (state) { return { url: url, state: state, ms: Date.now() - started }; });
      }
      return Promise.all([baitP, probeUrl(AD_URL, AD_TIMEOUT), probeUrl(controlUrl, AD_TIMEOUT)]).then(function (r) {
        var bait = r[0], ad = r[1], control = r[2];
        var out = {
          alg: 'adblock/2',
          bait: bait,
          adUrl: ad,
          control: control,
          verdict: 'unknown',
          basis: '',
          deadlineMs: AD_TIMEOUT
        };
        if (control.state !== 'reachable') {
          out.verdict = 'unknown';
          out.basis = 'control-' + control.state;
          out.note = '同源对照没取到：分不清是网络不通还是请求被挡，广告 URL 的结果一律不算数';
        } else if (ad.state !== 'reachable') {
          out.verdict = 'blocked';
          out.basis = 'ad-url-' + ad.state;
          out.note = '广告 URL 没取到、同源对照正常；no-cors 证明不了状态码，拦截只是最可能的原因之一';
        } else if (bait.hidden === true) {
          out.verdict = 'blocked';
          out.basis = 'bait-hidden-network-reachable';
          out.note = '广告 URL 取得到，但诱饵元素被隐藏：更像只做了外观过滤（cosmetic filtering）';
        } else {
          out.verdict = 'reachable';
          out.basis = 'ad-url+control-reachable';
          out.note = '广告 URL 与同源对照都取得到；opaque 响应只说明请求走完了网络栈';
        }
        return out;
      });
    }, M('error'));
  });
  // 第三方请求测试：7 个常见追踪域名 + 1 个对照请求（有限常量清单，不按环境动态生成）。
  // 读数范围只到"该目标 URL 在本网络是否可达"：
  //   - 目标用 no-cors 发，拿回来的响应是 opaque，只能说明请求走完了网络栈，
  //     证明不了状态码、响应头，更证明不了脚本内容有没有真的加载；
  //   - 失败既可能是被扩展/拦截器挡掉，也可能是本网络取不到该域名，单看这一轮分不开。
  // 所以先看对照请求：对照不通，这一轮的目标失败一律不算数（verdict=unknown）；
  // 对照通而目标失败，也只记"这次没取到"，不写成"被拦截"。
  var TRACKER_CONTROL_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
  var TRACKER_TARGETS = [
    { id: 'google-analytics', url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST' },
    { id: 'googletagmanager', url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST' },
    { id: 'doubleclick', url: 'https://static.doubleclick.net/instream/ad_status.js' },
    { id: 'facebook', url: 'https://connect.facebook.net/en_US/fbevents.js' },
    { id: 'hotjar', url: 'https://static.hotjar.com/c/hotjar-1.js' },
    { id: 'segment', url: 'https://cdn.segment.com/analytics.js/v1/analytics.min.js' },
    { id: 'criteo', url: 'https://static.criteo.net/js/ld/publishertag.js' }
  ];
  // 期限各自一份：对照有自己的，每个目标也有自己的（F-07）。先跑对照，
  // 它不通就只剩这一个请求出去；两个期限之和必须小于本项的单项额度，
  // 所以 trackers 记在 SLOW_IDS 里（1.2s + 1.5s 会超过 PROBE_TIMEOUT 的 2.5s）。
  // 线上实测：从国内网络请求对照（cloudflare.com）第一次就 1.3 秒，1200ms 的期限
  // 直接把它判成"没通"，于是每一条记录都只能记 unknown —— 等于这个探针白跑。
  // 放宽到 2.5s 一项（对照 + 目标共 5s，仍在慢车道 10s 之内）。
  // 对照比目标更紧一点：它只回答"这条路本身通不通"，不需要给慢目标那么多时间。
  var TRACKER_CONTROL_TIMEOUT = 2500;
  var TRACKER_TARGET_TIMEOUT = 3000;
  probe('trackers', function (env, ctx) {
    return safe(function () {
      var f = env.fetch;
      if (typeof f !== 'function') return M('unsupported');
      if (optedOut(env)) return M('not_run');
      var t0 = Date.now();
      var issued = 0, waits = [];
      // 每次请求都带"自己的期限 + 本轮探针的取消信号"，到点就 abort 底层 fetch，
      // 不是只把等待结束掉——旧实现里 within 收工后请求还在飞。
      function timed(url, opts, ms, ok) {
        issued++;
        var started = Date.now();
        var sig = requestSignal(env, ctx, ms);
        if (sig) opts.signal = sig;
        return within(
          Promise.resolve().then(function () { return f(url, opts); }).then(ok, function () { return false; }),
          ms,
          false
        ).then(function (v) { waits.push(Date.now() - started); return v; });
      }
      function controlOk(r) { return !!(r && r.ok); }
      function reachable() { return true; }    // opaque 响应：只能记"取到了"
      function summarize(control, oks, skipped) {
        var blocked = [], reachableList = [];
        for (var i = 0; i < TRACKER_TARGETS.length; i++) {
          if (skipped) break;
          (oks[i] ? reachableList : blocked).push(TRACKER_TARGETS[i].id);
        }
        var longest = 0;
        for (var w = 0; w < waits.length; w++) if (waits[w] > longest) longest = waits[w];
        return {
          control_ok: control,
          control_ms: waits.length ? waits[0] : null,
          targets: TRACKER_TARGETS.length,
          probed_targets: skipped ? 0 : TRACKER_TARGETS.length,
          skipped: !!skipped,
          reachable: reachableList,
          // 名字必须诚实：失败只说明"取不到"，拦截只是其中一种可能
          unreachable: blocked,
          // 对照不通时全部失败都不算数
          verdict: !control ? 'unknown' : (blocked.length ? 'some_unreachable' : 'all_reachable'),
          // 读数的范围：只说"这个 URL 在本网络通不通"，不是"有没有加载追踪脚本"
          scope: 'network-reachability',
          // 期限与资源记账（F-07 第 4 条）：实际发出去的请求数、这一轮最长一次等待、
          // 这一项自己的耗时。探针收工时没跑完的请求由 runProbes 统一 abort。
          requests: { control: waits.length ? 1 : 0, targets: skipped ? 0 : TRACKER_TARGETS.length, total: issued },
          deadlines: { control_ms: TRACKER_CONTROL_TIMEOUT, target_ms: TRACKER_TARGET_TIMEOUT },
          max_wait_ms: longest,
          elapsed_ms: Date.now() - t0,
          note: !control
            ? '对照请求在自己的期限内没通，这一轮没再去试 7 个目标：分不清是被拦还是网络不通，全部失败都不可信，只能记"本轮没测到"'
            : (blocked.length
              ? '对照请求（cloudflare.com）通，但失败的目标既可能是被扩展/拦截器挡掉，也可能是本网络取不到该域名；单看这一轮无法区分，只能记"取不到"。目标用 no-cors 发，成功的那些也只说明"可达"，证明不了状态码或脚本内容'
              : '对照与全部目标都取得到，这一轮没有观察到拦截迹象。注意目标用 no-cors 发，opaque 响应只说明请求走完了网络栈，证明不了响应状态，也证明不了脚本内容真的加载了')
        };
      }
      return timed(
        TRACKER_CONTROL_URL,
        { mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' },
        TRACKER_CONTROL_TIMEOUT, controlOk
      ).then(function (control) {
        // 对照都不通：不再去打扰 7 个第三方域名。去了也判不出"被拦"还是"网络不通"，
        // 把结果写成一排"不可达"反而给了不该有的读数（F-07 第 3 条）。
        if (!control) return summarize(control, [], true);
        return Promise.all(TRACKER_TARGETS.map(function (t) {
          return timed(
            t.url,
            { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' },
            TRACKER_TARGET_TIMEOUT, reachable
          );
        })).then(function (oks) { return summarize(control, oks, false); });
      });
    }, M('error'));
  });
  // ============ 扩展痕迹 ============
  // A-07 第一半：`ext` 只看"只有扩展才建立"的全局量。
  // 下面这些名字**可以由站点自己的脚本建立**（Next.js 的 __NEXT_DATA__、Vue/React/Redux
  // 的 devtools 钩子、GTM/GA 的 gtag/ga/dataLayer/_gaGlobal、Meta 像素的 fbq、
  // passiveEye 这类站点自己嵌的脚本），把它们算进"扩展证据"就是拿站点自身痕迹冒充扩展。
  // 因此它们被移出 ext 判定，单独列在这里备查，**不参与** cli.ext 的结果：
  // 这份清单的语义是"页面自身也能产生，不构成扩展证据"。
  var SITE_GLOBALS = [
    '__NEXT_DATA__', '__VUE__', '__VUE_DEVTOOLS_GLOBAL_HOOK__', '__REACT_DEVTOOLS_GLOBAL_HOOK__',
    '__REDUX_DEVTOOLS_EXTENSION__', 'gtag', 'ga', 'dataLayer', '_gaGlobal', 'fbq', 'passiveEye'
  ];
  // 只有扩展注入才会建立的名字：`window.ethereum` 是钱包扩展的注入点，
  // grammarly 一族是 Grammarly 扩展的注入点（这两个保留在扩展判定里）。
  var EXT_MARKS = ['ethereum', 'grammarly', 'Grammarly', '__grammarly'];
  // 扩展公开资源（web_accessible_resources）探针。
  // A-07 第二半：目标表改成结构化有限表——扩展名 + 扩展 ID + 候选资源路径 + 版本 + 验证日期。
  //   version / verified_at 只写**实测验证过**的：没验证的一律 null，不编版本号。
  //   paths 允许一个目标多条候选路径（不同版本把资源放在不同位置），命中任意一条即为命中。
  // 口径（必须一起读）：浏览器拒绝读取该文件**不能**说明扩展没装——扩展没声明这个资源、
  // 声明了但只对特定 origin 开放、或浏览器的 chrome-extension:// 访问策略变了，都会是拒绝。
  // 所以 hits 只能读成"这些目标的公开资源里命中了几条"，未命中 ≠ 未安装。
  var EXT_TARGETS = [
    {
      extension: 'MetaMask', id: 'nkbihfbeogaeaoehlefnkodbefgpgknn',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['manifest.json']
    },
    {
      extension: 'LastPass', id: 'hdokiejnpimakedhajhdlcegeplioahd',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['manifest.json']
    },
    {
      extension: '1Password', id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['manifest.json']
    },
    {
      extension: 'uBlock Origin', id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['web_accessible_resources/noop.txt', 'manifest.json']
    },
    {
      extension: 'AdBlock', id: 'gighmmpiobklfepjocnamgkkbiglidom',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['manifest.json']
    },
    {
      extension: 'React DevTools', id: 'fmkadmapgofadopljbjfkapdkoienihi',
      version: null, verified_at: null, basis: 'web-accessible-resource',
      paths: ['manifest.json']
    }
  ];
  var EXT_PATH_TIMEOUT = 1200;    // 每个候选路径自己的期限（同一目标的多条路径串行试）
  probe('extwar', function (env, ctx) {
    return safe(function () {
      var f = env.fetch;
      if (typeof f !== 'function') return M('unsupported');
      if (optedOut(env)) return M('not_run');
      function tryPath(t, path) {
        var url = 'chrome-extension://' + t.id + '/' + path;
        var opts = { cache: 'no-store', credentials: 'omit' };
        // 同样的资源释放问题：到点要 abort，否则 within 收工后请求还在飞
        var sig = requestSignal(env, ctx, EXT_PATH_TIMEOUT);
        if (sig) opts.signal = sig;
        return within(
          Promise.resolve().then(function () { return f(url, opts); })
            // 只有 2xx 才算命中：status 0 / opaque 拿不到内容，核对不了，就不能记成"命中"
            .then(function (r) { return !!(r && r.ok === true); })
            .catch(function () { return false; }),
          EXT_PATH_TIMEOUT,
          false
        );
      }
      function probeOne(t) {
        var i = 0;
        function next() {
          if (i >= t.paths.length) return Promise.resolve(null);
          var path = t.paths[i++];
          return tryPath(t, path).then(function (ok) { return ok ? path : next(); });
        }
        return next();
      }
      return Promise.all(EXT_TARGETS.map(probeOne)).then(function (matched) {
        var hits = [], matchedList = [];
        for (var i = 0; i < EXT_TARGETS.length; i++) {
          if (!matched[i]) continue;
          hits.push(EXT_TARGETS[i].extension);
          matchedList.push({
            extension: EXT_TARGETS[i].extension,
            id: EXT_TARGETS[i].id,
            path: matched[i],
            version: EXT_TARGETS[i].version,
            verified_at: EXT_TARGETS[i].verified_at
          });
        }
        return {
          tested: EXT_TARGETS.length,
          hits: hits,
          matched: matchedList,
          // 把表本身也随读数走：读者要能核对"到底试了谁、试了哪条路径、版本验没验"
          targets: EXT_TARGETS.map(function (t) {
            return {
              extension: t.extension, id: t.id, paths: t.paths.slice(0),
              version: t.version, verified_at: t.verified_at, basis: t.basis
            };
          }),
          // 只能证明"这些目标的公开资源里命中几条"，证明不了"装了/没装什么扩展"
          scope: '限量清单（' + EXT_TARGETS.length + ' 个常见扩展的公开资源路径），命中不代表全部，未命中不代表没装',
          note: '浏览器拒绝读取该文件不等于扩展没安装：扩展没声明这个 web_accessible_resource、只对特定 origin 开放、或访问策略变化都会是拒绝'
        };
      });
    }, M('error'));
  });
  probe('ext', function (env) {
    return safe(function () {
      var w = env, out = [];
      // 站点自身也能建立的全局量（SITE_GLOBALS）不参与这里：它们不是扩展证据（A-07）
      for (var i = 0; i < EXT_MARKS.length; i++) if (typeof w[EXT_MARKS[i]] !== 'undefined') out.push(EXT_MARKS[i]);
      try {
        var uad = env.navigator.userAgentData;
        if (uad && uad.brands) for (var j = 0; j < uad.brands.length; j++) if (!/Not|Chromium|Google Chrome|Microsoft Edge/.test(uad.brands[j].brand)) out.push('brand:' + uad.brands[j].brand);
      } catch (e) { }
      return out;
    }, M('unsupported'));
  });
  probe('history', function (env) { return safe(function () { return env.history ? env.history.length : null; }, M('unsupported')); });
  probe('etag', function (env, ctx) {
    // 后端 /v1/etag 发随机令牌（rand-token/1），用浏览器自己的条件请求证明缓存。
    // 证据要分两份记，别混成一份（F-08）：
    //   first_pass —— 第一次请求（拿到响应的那次）服务端就回了 X-Etag-Verified: 1 或
    //                 X-Etag-Conditional: 1，说明浏览器在这次请求里已经带上 If-None-Match。
    //                 那是上一次访问留下来的缓存令牌，才算跨访问复访的证据。
    //   round_trip —— 同一轮里再请求一次、再问 /report，服务端认得出那个令牌。
    //                 这只说明本轮缓存能带令牌，不等于上次访问留下了缓存。
    // 旧实现把两者都塞进 conditional_seen，读的人分不清，1.9.0 起分开记。
    //
    // A-01（跨访问 ETag）：被缓存的请求 URL **必须是固定的** `ETAG_URL`，一个查询串都不带。
    // 浏览器按"请求方法 + 目标 URI"做缓存键（RFC 9111 §2），旧实现把本轮访问号拼成
    // /v1/etag?id=A、/v1/etag?id=B，于是每次访问都是一个新缓存项，跨访问复用根本不可能发生
    // （真实 Chrome 实测两轮 first_pass.verified 都是 false）。现在：
    //   - 被缓存的请求只有 ETAG_URL 本身，不带 ?id=，也不手写 If-None-Match——
    //     条件头交给浏览器自己发，缓存证据才成立；
    //   - 访问号（id）与会话号（sid）改放在**独立的关联请求**
    //     /v1/etag/report?token=<token>&id=<访问号>&sid=<会话号>，
    //     该响应 no-store，不进缓存，只负责把"本轮访问号 / 会话号 ↔ 这个令牌"关联起来；
    //   - 关联请求每一轮都发（有令牌就发），半份信封那一轮也照发（缓存复用可能就发生在
    //     半份那一轮，跳过它等于丢掉那一刻的证据）；
    //   - **跨访问只看会话号**（真机实测暴露过的一个假阳性）：一次页面访问会发两封信封
    //     （先 meta.partial=true 的半份，后补一份完整的），两封 session 相同但访问号不同。
    //     只数访问号的话，"同一页里的半份 + 完整"就会被误判成"另一次访问"。访问号只做
    //     记录关联，跨访问判定由服务端按**不同 session**数给出（distinct-session）；
    //     采集器不自己下这个结论，只把服务端回报的 cross_visit 原样带回来。
    //     缓存请求仍然最多两跳（首响、必要时再校验一次），总计不超过三跳。
    return safe(function () {
      var f = env.fetch;
      if (typeof f !== 'function') return M('unsupported');
      function head(r, name) {
        try {
          return (r.headers && typeof r.headers.get === 'function' && r.headers.get(name)) || null;
        } catch (e) {
          return null;
        }
      }
      function flag(r, name) { return head(r, name) === '1'; }
      // 每次请求都有自己的期限（ETAG_TIMEOUT），并接本轮探针的取消信号：
      // 三跳加起来必须小于 SLOW_TIMEOUT（etag 在慢车道上），探针收工时 runProbes
      // 会把没跑完的请求 abort 掉。
      // lastSig 记的是最近一次请求自己的 signal：fetch 被 AbortController 掐掉和网络层直接
      // 失败都会走到"没拿到响应"，但那是两件事——前者是太慢（timeout），后者是根本没连上
      // （unreachable）。两者在画像里的读法不同，不能都写 unreachable。
      var lastSig = null;
      // 被缓存的请求一律 cache:'default'（让浏览器自己存、自己发条件头）；
      // 关联请求必须 no-store，否则它自己会变成新的缓存项，和被缓存的那条搅在一起。
      function get(url, cacheMode) {
        var opts = { cache: cacheMode || 'default', credentials: 'omit', referrerPolicy: 'no-referrer' };
        var sig = requestSignal(env, ctx, ETAG_TIMEOUT);
        lastSig = sig || null;
        if (sig) opts.signal = sig;
        return f(url, opts);
      }
      function lastTimedOut() { return !!(lastSig && lastSig.aborted === true); }
      // 后端 report 本轮还在加字段：认得的按类型读，给 null 或干脆没给就保持 null，
      // 认不得的忽略。缺字段不是错误——绝不能因为读不到新字段把整项判成 error。
      function readReport(j) {
        if (!j || typeof j !== 'object') return { state: 'unreadable' };
        function b(k) { return typeof j[k] === 'boolean' ? j[k] : null; }
        function n(k) { return typeof j[k] === 'number' && isFinite(j[k]) ? j[k] : null; }
        return {
          state: typeof j.state === 'string' ? j.state : null,
          conditional_seen: b('conditional_seen'),
          conditional_count: n('conditional_count'),
          same_network: b('same_network'),
          // 下面几项是给后端预留的：给了就收，没给是 null，不影响别的字段
          cross_visit: b('cross_visit'),
          // 跨访问的证据级别：server 按"**两次不同的会话号**用过同一个令牌"判
          // （distinct-session / single-session），老采集器没交会话号时是 no-session-id。
          // 采集器自己不算这个结论——只转述服务端给的。
          cross_visit_evidence: typeof j.cross_visit_evidence === 'string' ? j.cross_visit_evidence : null,
          // 同一个令牌被几个访问号用过。**不是**跨访问证据：同一次页面访问会发
          // 半份 + 完整两封信封，两封的访问号不同但 session 相同，所以这个数
          // 常态就是 2。要判"另一次访问"只看会话号（cross_visit / cross_visit_evidence）。
          visit_ids: n('visit_ids'),
          // 时间窗旁证：同页重试也能满足，不能当成跨访问
          round_window_hint: b('round_window_hint'),
          token_age_s: n('token_age_s'),
          retention_days: n('retention_days')
        };
      }
      var CAVEAT = '本轮内第二次请求成功只说明本轮缓存能带令牌，不等于上次访问留下了缓存';
      // 访问号：只做记录关联（服务端拿它串起同一次访问的多封信封）。它**不再**是
      // 跨访问证据——同一页的半份 + 完整两封信封访问号不同、session 相同（真机实测的
      // 假阳性就是从这里来的）。idOf() 惰性生成，和信封里那个 id 是同一个。
      // A-01：它**只**进关联请求（/v1/etag/report），绝不进被缓存的 /v1/etag 的 URL——
      // 否则浏览器会把每次访问当成一个新缓存项，跨访问复用永远不会发生。
      var vid = safe(function () { return idOf(env); }, '') || '';
      // 会话号：跨访问判定的输入。用采集器**已有的** session 值（信封 env.session 用的
      // 同一个 getSession(env)：sessionStorage 里的 radish.sid），不另造 id。
      // 同一次页面访问的半份与完整两份信封共用它；换一次页面会话就换一个。
      var sid = safe(function () { return getSession(env); }, '') || '';
      function reportUrl(token) {
        var q = '?token=' + encodeURIComponent(token);
        if (vid) q += '&id=' + encodeURIComponent(vid);
        if (sid) q += '&sid=' + encodeURIComponent(sid);
        return ETAG_URL + '/report' + q;
      }
      function headersReadable(r) {
        return head(r, 'X-Etag-State') !== null || head(r, 'X-Etag-Token') !== null;
      }
      var started = Date.now();
      var requests = 0;
      // 第一次：拿令牌。响应是 private+must-revalidate，浏览器会存但立刻过期。
      // URL 固定为 ETAG_URL：下一次访问的第一次请求要命中同一个缓存项，才可能带上条件头。
      return get(ETAG_URL).then(function (r) {
        requests++;
        // 首跳被掐：1400ms 内没回来记 timeout（画像里读作"太慢，本轮内放弃"），
        // 其它失败才是 unreachable（没连上）。这一跳的取舍都写进 meta.stuck。
        if (!r) return M(lastTimedOut() ? 'timeout' : 'unreachable');
        if (!r.ok) return M('error');
        return r.text().then(function (body) {
          var token = head(r, 'X-Etag-Token') || String(body || '').replace(/[^0-9a-f]/g, '');
          var alg = head(r, 'X-Etag-Alg') || 'rand-token/1';
          var verifiedFirst = flag(r, 'X-Etag-Verified');
          var conditionalFirst = flag(r, 'X-Etag-Conditional');
          var out = {
            alg: alg,
            token: token ? token.slice(0, 8) : null,
            state: head(r, 'X-Etag-State'),
            // 辅助头：跨域时后端要在 Access-Control-Expose-Headers 里列出来才读得到，
            // 读不到就是 null，不带任何缓存结论
            net_seen: head(r, 'X-Net-Seen') === null ? null : head(r, 'X-Net-Seen') === '1',
            net_scope: head(r, 'X-Net-Scope'),
            cache: 'private, must-revalidate',
            // 被缓存的资源 URL：读的人能直接核对"这条缓存键里有没有访问号"（A-01）
            url: ETAG_URL,
            // 跨访问复访的证据：第一次请求就带了 If-None-Match
            first_pass: { verified: verifiedFirst, conditional: conditionalFirst },
            // 本轮内回环：第二次请求被认作条件请求 + 后端 report 的确认
            round_trip: { verified: false, conditional_seen: null, conditional_count: null, same_network: null },
            report: { state: 'not_attempted' },
            // 关联请求有没有把本轮访问号 / 会话号交给服务端（A-01）：
            // id_sent 只说明记录关联这一环通了；跨访问结论看服务端回的
            // report.cross_visit（按不同会话号判），sid_sent 才是它的输入。
            id_sent: false,
            sid_sent: false,
            // 旧字段名留一份，语义分别对应上面两份证据（1.8.x 的消费者还在读）
            conditional_sent: conditionalFirst,
            conditional_seen: false,
            note: ''
          };
          function finish() {
            out.requests = requests;
            out.budget_ms = ETAG_TIMEOUT;
            out.elapsed_ms = Date.now() - started;
            var lead;
            if (out.first_pass.verified || out.first_pass.conditional) {
              lead = '第一次请求服务端就回了 X-Etag-Verified/Conditional=1：浏览器在这次请求里带了 If-None-Match，说明上一次访问留下了缓存令牌（跨访问复访证据）';
            } else if (out.round_trip.verified) {
              lead = '同一轮里第二次请求被服务端认作条件请求（依据=' + (out.round_trip.source || 'headers') + '）';
            } else if (out.report && out.report.state === 'timeout') {
              lead = '这一轮第二次请求没在 ' + ETAG_TIMEOUT + 'ms 内回来（阶段=' +
                (out.report.stage || 'round_trip') + '），本轮内回环未确认；上面已有的读数照旧保留';
            } else {
              lead = '这一轮没看到条件请求：没有跨访问复访的证据，本轮内回环也没被认出来';
            }
            out.note = lead + '；' + CAVEAT;
            return out;
          }
          // 关联请求：/v1/etag/report?token=…&id=…&sid=…，no-store，不进缓存（A-01）。
          // useForEvidence=true 时才把它当作"本轮内回环"的证据（响应头读不到时的兜底）；
          // 其余情况它只负责关联访问号 / 会话号 + 带回 cross_visit 这些服务端视角字段。
          // 半份信封这一轮同样走这里：它照常带 id 与 sid，不因为 meta.partial 就跳过。
          function associate(useForEvidence) {
            if (!token) { out.report = { state: 'no_token' }; return Promise.resolve(finish()); }
            return get(reportUrl(token), 'no-store').then(function (rep) {
              requests++;
              if (!rep) {
                // 关联请求没回来：回环结论按 useForEvidence 决定有没有被打断
                out.report = { state: lastTimedOut() ? 'timeout' : 'unreachable', stage: 'report' };
                return finish();
              }
              if (!rep.ok) { out.report = { state: 'error', stage: 'report' }; return finish(); }
              return rep.json().then(function (j) {
                var rep2 = readReport(j);
                rep2.id_sent = !!vid;
                rep2.sid_sent = !!sid;
                out.id_sent = !!vid;
                out.sid_sent = !!sid;
                out.report = rep2;
                if (useForEvidence) {
                  out.round_trip = {
                    verified: rep2.conditional_seen === true,
                    conditional_seen: rep2.conditional_seen,
                    conditional_count: rep2.conditional_count,
                    same_network: rep2.same_network,
                    source: 'server-report'
                  };
                  out.conditional_seen = out.round_trip.verified;
                }
                return finish();
              }).catch(function () {
                out.report = { state: 'unreadable', stage: 'report' };
                return finish();
              });
            }).catch(function () {
              out.report = { state: lastTimedOut() ? 'timeout' : 'unreachable', stage: 'report' };
              return finish();
            });
          }
          if (!token) { out.report = { state: 'no_token' }; return finish(); }
          if (out.first_pass.verified) {
            // 首响的响应头已经说清了：浏览器在这次请求里带回了上次的令牌。
            // 这本身就是条件请求的证据——不必再打一次同一个 URL（N-05 的请求收敛）。
            // 但关联请求照发：访问号只能从这里到达服务端，跨访问靠它才能算（A-01）。
            out.round_trip = {
              verified: true, conditional_seen: true, conditional_count: null,
              same_network: null, source: 'first-response-headers'
            };
            out.conditional_seen = true;
            return associate(false);
          }
          // 第二次：同一个固定 URL。max-age=0 让浏览器必须校验，于是带上 If-None-Match。
          return get(ETAG_URL).then(function (r2) {
            requests++;
            // 次跳没回来：这一跳就是结论，不再多发关联请求（本轮的令牌与状态照旧保留）
            if (!r2) { out.report = { state: 'timeout', stage: 'round_trip' }; return finish(); }
            if (headersReadable(r2)) {
              // 响应头自己就写着答案：回环证据不再问后端（省掉一次串行往返），
              // 关联请求仍然只负责把访问号交给服务端。
              var verified2 = flag(r2, 'X-Etag-Verified');
              var conditional2 = flag(r2, 'X-Etag-Conditional');
              out.round_trip = {
                verified: verified2,
                conditional_seen: verified2,
                conditional_count: null,
                same_network: null,
                source: 'second-response-headers'
              };
              out.conditional_seen = verified2;
              if (conditional2 && !verified2) out.round_trip.note = '浏览器带了条件请求，但服务端没认出这个令牌';
              return associate(false);
            }
            // 兜底：响应头读不到（跨域没 expose、被中间层抹掉）时，
            // 关联请求同时承担"问后端有没有收到带这个令牌的条件请求"。
            return associate(true);
          }).catch(function () { out.report = { state: 'timeout', stage: 'round_trip' }; return finish(); });
        });
      // fetch 被掐（AbortController 到期）走的是异常路径，不是"拿到 null"那条：
      // 这里也要分开记，否则首跳超期会被写成 unreachable。
      }).catch(function () { return M(lastTimedOut() ? 'timeout' : 'unreachable'); });
    }, M('error'));
  });
  // traces（brw）：往各浏览器存储写一枚自有随机标记 → **读回核验** → 清理。
  // M：补上 IndexedDB 与 Cache Storage，并且每一项都有独立状态，不再只有聚合的
  // kept/lost/blocked 三个数组：
  //   unsupported  这个存储接口不在（例如隐私模式把 indexedDB/caches 整个拿掉）
  //   blocked      写（或读）当场抛错——**写失败直接记 blocked**，不等下一次访问才推断
  //   written      写入成功、但读回没做成（超时/读抛错）
  //   readback     写入成功后立刻读回来，值与写入值一致（可写 + 可读）
  //   lost         写入成功但读回来对不上（或读到了旧值）
  //   timeout      自己的期限内没答复（没读到 ≠ 读不到）
  // kept/lost 两个数组仍按**跨访问**语义：上一轮留下的标记这一轮还读得到才算 kept。
  var TRACE_TTL_DAYS = 30;
  var TRACE_ASYNC_TIMEOUT = 1200;
  var TRACE_CACHE_KEY = '__radish_trace';

  // IndexedDB 的读写：open → 事务 → 读/写/删，每一步失败都当 blocked 的来源。
  function idbIo(env) {
    var idb = safe(function () { return env.indexedDB || (env.window && env.window.indexedDB) || null; }, null);
    if (!idb || typeof idb.open !== 'function') return null;
    var DB = 'radish-trace', STORE = 'tag';
    function openDb() {
      return new Promise(function (res, rej) {
        var req = idb.open(DB, 1);
        req.onupgradeneeded = function () {
          try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); } catch (e) { }
        };
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || new Error('idb-open')); };
        req.onblocked = function () { rej(new Error('idb-blocked')); };
      });
    }
    function tx(mode, fn) {
      return openDb().then(function (db) {
        return new Promise(function (res, rej) {
          var t, s, req;
          try {
            t = db.transaction(STORE, mode);
            s = t.objectStore(STORE);
            req = fn(s);
          } catch (e) { try { db.close(); } catch (e2) { } rej(e); return; }
          t.oncomplete = function () {
            var out = req && req.result !== undefined ? req.result : null;
            try { db.close(); } catch (e) { }
            res(out === undefined ? null : out);
          };
          t.onerror = function () { try { db.close(); } catch (e) { } rej(t.error || new Error('idb-tx')); };
          t.onabort = function () { try { db.close(); } catch (e) { } rej(t.error || new Error('idb-abort')); };
        });
      });
    }
    return {
      name: 'indexDB',
      read: function () { return tx('readonly', function (s) { return s.get(TRACE_CACHE_KEY); }); },
      write: function (v) { return tx('readwrite', function (s) { return s.put(v, TRACE_CACHE_KEY); }); },
      clear: function () { return tx('readwrite', function (s) { return s.delete(TRACE_CACHE_KEY); }); }
    };
  }

  // Cache Storage 的读写：caches.open → put → match → caches.delete（整块清掉，那个缓存是我们的）
  function cacheIo(env) {
    var c = safe(function () { return env.caches || (env.window && env.window.caches) || null; }, null);
    if (!c || typeof c.open !== 'function') return null;
    var R = safe(function () { return env.Response || (typeof Response !== 'undefined' ? Response : null); }, null);
    var CACHE = 'radish-trace';
    var URL_ = '/__radish_trace__';
    return {
      name: 'cacheStorage',
      read: function () {
        return c.open(CACHE).then(function (k) { return k.match(URL_); })
          .then(function (r) { return r ? r.text() : null; });
      },
      write: function (v) {
        if (!R) return Promise.reject(new Error('no-response-ctor'));
        return c.open(CACHE).then(function (k) { return k.put(URL_, new R(v, { headers: { 'content-type': 'application/json' } })); });
      },
      clear: function () { return c.delete(CACHE); }
    };
  }

  // 同步存储（localStorage / sessionStorage / cookie / window.name）：写→读回→不清理。
  // 不清理是刻意的：跨访问复用正是它的用途（参考实现也是这样留着）。
  function traceSyncRound(io, raw, tag) {
    var rec = { state: 'unsupported', prev: false, wrote: false, readback: null };
    if (!io) return { rec: rec, prevTag: null };
    var prevTag;
    try { prevTag = parseTag(io.get()); }
    catch (e) { rec.state = 'blocked'; return { rec: rec, prevTag: null }; }
    rec.prev = !!prevTag;
    try { io.set(raw); rec.wrote = true; }
    catch (e2) { rec.state = 'blocked'; return { rec: rec, prevTag: prevTag || null }; }
    try {
      var back = parseTag(io.get());
      rec.readback = back === tag ? 'ok' : 'mismatch';
      rec.state = back === tag ? 'readback' : 'lost';
    } catch (e3) { rec.readback = 'error'; rec.state = 'written'; }
    return { rec: rec, prevTag: prevTag || null };
  }

  // 异步存储（IndexedDB / Cache Storage）：读旧值 → 写 → 读回核验 → 清理。
  // 每一步都有自己的期限（TRACE_ASYNC_TIMEOUT），读不到就是"没读到"，不当成"读不到"。
  function traceAsyncRound(store, raw, tag) {
    var rec = { state: 'unsupported', prev: false, wrote: false, readback: null };
    if (!store) return Promise.resolve(rec);
    function readStep() {
      return within(
        Promise.resolve().then(function () { return store.read(); })
          .then(function (v) { return { v: v }; }, function () { return { err: true }; }),
        TRACE_ASYNC_TIMEOUT, { timeout: true }
      );
    }
    function stop() {
      // 读回核验完就删掉自己的标记，别在访客设备上留痕
      return within(
        Promise.resolve().then(function () { return store.clear ? store.clear() : null; }),
        TRACE_ASYNC_TIMEOUT, false
      ).then(function () { return rec; });
    }
    return readStep().then(function (r) {
      if (r && r.err) { rec.state = 'blocked'; return stop(); }
      if (r && r.timeout) { rec.state = 'timeout'; return stop(); }
      rec.prev = !!parseTag(r.v);
      return within(
        Promise.resolve().then(function () { return store.write(raw); })
          .then(function () { return 'ok'; }, function () { return 'error'; }),
        TRACE_ASYNC_TIMEOUT, 'timeout'
      ).then(function (w) {
        if (w !== 'ok') { rec.state = w === 'timeout' ? 'timeout' : 'blocked'; rec.wrote = false; return stop(); }
        rec.wrote = true;
        rec.state = 'written';
        return readStep().then(function (r2) {
          if (r2 && r2.err) { rec.state = 'blocked'; rec.readback = 'error'; return stop(); }
          if (r2 && r2.timeout) { rec.state = 'timeout'; return stop(); }
          var back = parseTag(r2.v);
          rec.readback = back === tag ? 'ok' : 'mismatch';
          rec.state = back === tag ? 'readback' : 'lost';
          return stop();
        });
      });
    });
  }

  probe('traces', function (env) {
    // 参考实现的语义：往几个浏览器存储各放一枚随机标记，下次访问读回来比对——
    // 留得住的说明这个存储对追踪有效，被清掉的说明留不住，"写不进去"是受限。
    // 旧实现数的是"存储里本来有几个键"，那是别人的数据，不是这台浏览器的行为。
    return safe(function () {
      if (optedOut(env)) return M('not_run');
      var now = Date.now(), tag = randTag(env);
      var raw = JSON.stringify({ t: tag, at: now });
      var win = env;
      var stores = [
        { name: 'localStorage', io: storageIo(env.localStorage) },
        { name: 'sessionStorage', io: storageIo(env.sessionStorage) },
        { name: 'cookie', io: cookieIo(env.document) },
        {
          name: 'windowName', io: (win && typeof win.name === 'string')
            ? {
              get: function () { return win.name || ''; },
              set: function (v) { win.name = v; },
              del: function () { win.name = ''; }
            }
            : null
        }
      ];
      var items = {}, tags = {}, blocked = [], i;
      for (i = 0; i < stores.length; i++) {
        var r = traceSyncRound(stores[i].io, raw, tag);
        items[stores[i].name] = r.rec;
        tags[stores[i].name] = r.prevTag;
        if (r.rec.state === 'blocked') blocked.push(stores[i].name);
      }
      // 跨访问判定：谁读到了上一轮的标记
      var prevTag = null;
      for (var k in tags) { if (tags[k]) { prevTag = tags[k]; break; } }
      var kept = [], lost = [];
      if (prevTag) {
        for (var k2 in tags) {
          if (items[k2].state === 'blocked') continue;
          (tags[k2] === prevTag ? kept : lost).push(k2);
        }
      }
      items.indexDB = { state: 'unsupported', prev: false, wrote: false, readback: null };
      items.cacheStorage = { state: 'unsupported', prev: false, wrote: false, readback: null };
      return Promise.all([
        traceAsyncRound(idbIo(env), raw, tag).then(function (rec) { items.indexDB = rec; if (rec.state === 'blocked') blocked.push('indexDB'); }),
        traceAsyncRound(cacheIo(env), raw, tag).then(function (rec) { items.cacheStorage = rec; if (rec.state === 'blocked') blocked.push('cacheStorage'); })
      ]).then(function () {
        return {
          alg: 'storage-tag/2',
          first: !prevTag,
          kept: kept,
          lost: lost,
          blocked: blocked,
          ttl_days: TRACE_TTL_DAYS,
          items: items,
          // 口径写死：这一项量的是"本机存储能不能被写入并读回"，不是"这台浏览器有没有被我们追踪"
          scope: 'write-readback-per-store'
        };
      });
    }, M('unsupported'));
  });

  // ============ 网络辅助（trace / hints） ============
  function parseTrace(t) {
    var kv = {};
    String(t).split('\n').forEach(function (l) { var i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return kv;
  }

  function makeCtx(env) {
    var ctx = { trace: {}, hints: {}, cache: {} };
    ctx.parseTrace = parseTrace;
    // 探针门面（pctx）沿原型链拿到这个方法，this.__ac 就是这一项自己的取消开关
    ctx.signalFor = function (ms) {
      return signalFor(env, ms, this && this.__ac ? this.__ac : null);
    };
    ctx.text = function (url, ms, miss) {
      try {
        var opts = { mode: 'cors', credentials: 'omit', cache: 'no-store' };
        // 两个取消源合并：单个请求自己的期限 + 本轮探针的取消（超时/整轮死线/已收工）
        var sig = signalFor(env, ms || 2500, this && this.__ac ? this.__ac : null);
        if (sig) opts.signal = sig;
        // 用 env 上的 fetch（浏览器里就是全局 fetch；测试与内嵌环境也能替身）
        var doFetch = (env && env.fetch) || fetch;
        return doFetch(url, opts)
          .then(function (r) { return r.ok ? r.text() : null; })
          .catch(function () { return null; })
          .then(function (v) { return v === null && miss ? miss : v; });
      } catch (e) { return Promise.resolve(miss || null); }
    };
    ctx.json = function (url, ms, miss) {
      // 走 this.text 而不是闭包里的 ctx.text：探针拿到的门面对象（pctx）沿原型链
      // 拿到 json，但只有走 this 才能把 pctx.__ac（本项取消开关）传进 text。
      var self = this && typeof this.text === 'function' ? this : ctx;
      return self.text(url, ms, miss).then(function (t) {
        if (!t) return miss || null;
        try { return JSON.parse(t); } catch (e) { return miss || null; }
      });
    };
    ctx.trace = {};
    return ctx;
  }

  // 并发调度（A-11：这里写的就是实际行为）：慢车道的项先起跑、各占一个 lane；
  // 其余小探针走 16 路快速车道。整轮有全局死线，到点就收工，没跑完的记 timeout 并记进
  // meta.stuck。三层期限的关系必须是 单项 < 整轮：慢探针单独用 SLOW_TIMEOUT（10s），
  // 整轮 DEADLINE 是 12s；旧代码把每项都压到 PROBE_TIMEOUT（2.5s）而且整轮只有 6s，
  // DNS 必然被切。
  async function runProbes(env, ctx, state, budgetMs) {
    var cli = state.cli, stuck = state.stuck;
    var deadline = Date.now() + (budgetMs || DEADLINE);
    // 探针拿到的是本轮 ctx 的门面对象（为了各自能被取消），共享缓存必须挂在真正的
    // ctx 上，门面对象沿原型链读它——这里先保证它存在。
    if (!ctx.cache) ctx.cache = {};
    var slow = [], fast = [];
    for (var i = 0; i < PROBES.length; i++) (SLOW_IDS[PROBES[i].id] ? slow : fast).push(PROBES[i]);

    async function runOne(p) {
      var left = deadline - Date.now();
      if (left <= 0) { cli[p.id] = M('timeout'); stuck.push(p.id); return; }
      // 每个探针自己的取消开关：超时之后把还在飞的请求掐掉，别让它们占着连接和主线程
      var ctl = safe(function () { return env.AbortController ? new env.AbortController() : null; }, null);
      var pctx = Object.create(ctx);
      pctx.__ac = ctl;
      var cap = SLOW_IDS[p.id] ? SLOW_TIMEOUT : PROBE_TIMEOUT;
      var v = await withTimeout(
        Promise.resolve().then(function () { return p.run(env, pctx); }).catch(function () { return { __error: true }; }),
        Math.min(cap, Math.max(200, left)),
        p.id
      );
      // 探针一收工就掐掉这一项还在飞的请求：超时、正常返回、中途放弃都一样。
      // 旧实现只在超时分支 abort，正常收工时 within 已经不再等、底层 fetch 却还在跑
      // （F-07：等待结束了不等于请求结束了）。
      if (ctl) safe(function () { ctl.abort(); }, null);
      if (v === SKIP) return;     // 这一项本轮不参与，别写成 unsupported
      if (v && v.__timeout) { cli[p.id] = M('timeout'); stuck.push(p.id); }
      else if (v && v.__error) { cli[p.id] = M('error'); }
      else if (v === undefined || v === null) { cli[p.id] = M('unsupported'); }
      else cli[p.id] = v;
    }

    // 慢探针先起跑，不等 16 路池子排队：DNS 的 10 秒额度从 t=0 开始算
    var lanes = slow.map(runOne);
    var next = 0;
    async function worker() {
      while (true) {
        var index = next++;
        if (index >= fast.length) return;
        await runOne(fast[index]);
      }
    }
    for (var k = 0; k < 16; k++) lanes.push(worker());
    await Promise.all(lanes);
    // 输入观测（gamepad / agent）只用这一次：整轮收工就摘掉监听，不常驻页面
    inputStop();
  }

  // ---------- 信封 ----------
  function uuid(env) {
    try { if (env.crypto && env.crypto.randomUUID) return env.crypto.randomUUID(); } catch (e) { }
    try {
      var b = new Uint8Array(16);
      (env.crypto || crypto).getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = ''; for (var i = 0; i < 16; i++) h += ('0' + b[i].toString(16)).slice(-2);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      return 'r' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    }
  }

  function store(env) {
    return safe(function () { return env.sessionStorage; }, null);
  }
  function getSession(env) {
    var s = store(env);
    if (s) {
      var v = safe(function () { return s.getItem('radish.sid'); }, null);
      if (v) return v;
      var nv = Math.random().toString(16).slice(2, 12);
      safe(function () { s.setItem('radish.sid', nv); }, null);
      return nv;
    }
    env.__radishSid = env.__radishSid || Math.random().toString(16).slice(2, 12);
    return env.__radishSid;
  }
  function alreadySent(env) {
    if (!env) return false;                    // 自动启动会不带参数调用，别在这里抛
    var s = store(env);
    var v = s ? safe(function () { return s.getItem('radish.sent'); }, null) : null;
    // 只有完整信封确认送达才算"这次访问已经上报过"。
    // 'queued' 是离页半份的排队长态，不能拿它把后续补全堵死（B-07）。
    return env.__radishSent === true || v === '1' || v === 'confirmed';
  }
  function markSent(env, kind) {
    env.__radishSent = true;
    var s = store(env);
    // 'confirmed' = 读到了服务端 204；'queued' = 只确认浏览器已接受（离页路径）
    if (s) safe(function () { s.setItem('radish.sent', kind === 'queued' ? 'queued' : 'confirmed'); }, null);
  }

  function optedOut(env) {
    var n = env.navigator || {};
    return n.globalPrivacyControl === true || String(n.doNotTrack) === '1';
  }

  function withTimeout(p, ms, id) {
    if (!p || typeof p.then !== 'function') return Promise.resolve(p);
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve({ __timeout: true }); } }, ms);
      p.then(function (v) { if (done) return; done = true; clearTimeout(t); resolve(v); },
        function () { if (done) return; done = true; clearTimeout(t); resolve({ __error: true }); });
    });
  }

  // trace 派生项 + 时钟偏移：必须在 ctx.ready 之后算（G07）
  function derive(env, ctx, cli, stuck) {
    var tr = ctx.trace || {};
    // 抓包失败原因是旁路元数据（附录 G）：tcpfp 的标记形状不变，原因单独写 cli.tcp_reason。
    // 探针没接时这一轮不会有这个键，所以画像能分清"没配探针"和"探针说了原因"。
    var tcpReason = ctx && ctx.cache && ctx.cache.tcpReason;
    if (tcpReason) cli['tcp_reason'] = tcpReason;
    // 摘要算法版本（F-09/B-06 · N-04 · K.12）：fpid/hwid 是哈希，换了输入清单或换了算法
    // 就是另一串值，不标版本的话分布页会把两代结果混在一个分布里比较。
    // 版本号只在 FP_ALG_VERSION / HW_ALG_VERSION 两个常量里，这里是唯一拼接处：
    // crypto.subtle 可用时是 sha256/tmpl-2、sha256/hw-2；降级到 shaSync 的 FNV-1a 时
    // 写 fnv/tmpl-2-fallback、fnv/hw-2-fallback，不许把降级结果冒充成 SHA256。
    // 老记录没有这两个字段，后端把它们单列成 unlabeled 一档：能解释来源，
    // 但不与已标版本的计数合并（identity_counts 现在按标签分组统计）。
    var fpAlgLabel = digestLabel(cli['fpid'], FP_ALG_VERSION);
    if (fpAlgLabel) cli['fpid_alg'] = fpAlgLabel;
    var hwAlgLabel = digestLabel(cli['hwid'], HW_ALG_VERSION);
    if (hwAlgLabel) cli['hwid_alg'] = hwAlgLabel;
    // kex：trace 里的 kex 之外还要留 sni。探针 tls.sni 只是布尔存在性，
    // 不能代替 trace 对 ECH 的观测，所以两处分开写、别互相冒充。
    cli['kex'] = (tr.kex || tr.sni !== undefined)
      ? { group: tr.kex || null, sni: tr.sni === undefined ? null : tr.sni, src: 'trace' }
      : M('unsupported');
    // warp：状态与 gateway 一起留，gateway 是"经哪个网关出去"的唯一线索
    cli['warp'] = (tr.warp || tr.gateway)
      ? { state: tr.warp || null, gateway: tr.gateway || null, src: 'trace' }
      : M('unsupported');
    cli['proto'] = (tr.http || tr.tls) ? { http: tr.http || null, tls: tr.tls || null } : M('unsupported');
    cli['edge'] = tr.colo || M('unsupported');
    var h = ctx.hints && ctx.hints.h ? ctx.hints.h : null;
    if (h && Object.keys(h).length) {
      // 回显头单独放 srv 分区，不再覆盖浏览器自报的高熵结果（以前这里一覆盖，
      // 原始高熵版本就整份丢了，谁也没法核对）。
      var srvHints = {}, srvCount = 0;
      for (var k in h) {
        if (srvCount >= 12) break;
        srvHints[k] = h[k];
        srvCount++;
      }
      var ownCh = cli['ch'];
      if (ownCh && typeof ownCh === 'object' && typeof ownCh.$ !== 'string') {
        ownCh.srv = srvHints;
      } else {
        cli['ch'] = { alg: 'ch/srv-only', srv: srvHints };
      }
    }
    // v6mac：旧实现只扫 ICE 候选，漏掉本站 trace 与出口回显给的 IPv6。
    // 这里把几条来源合起来再判 EUI-64，每个地址留来源，判不出来就照实说没有。
    try {
      var seen = [], sources = {};
      function push6(from, addr) {
        if (!addr || typeof addr !== 'string') return;
        var text = addr.trim();
        if (text.indexOf(':') < 0 || text === 'mdns.local') return;
        sources[from] = true;
        for (var k = 0; k < seen.length; k++) if (seen[k] === text) return;
        seen.push(text);
      }
      var own6 = cli['v6mac'];
      if (own6 && typeof own6 === 'object' && own6.addresses && own6.addresses.length) {
        own6.addresses.forEach(function (a) { push6('ice', a); });
      }
      push6('trace', tr.ip);
      ['ex_cn', 'ex_intl', 'ex_gpt', 'ex_claude', 'ex_cf'].forEach(function (id) {
        var v = cli[id];
        if (v && typeof v === 'object' && typeof v.$ !== 'string') push6(id, v.ip);
      });
      if (seen.length) {
        var hitMac = null;
        for (var vi = 0; vi < seen.length; vi++) {
          hitMac = macFromV6(seen[vi]);
          if (hitMac) break;
        }
        cli['v6mac'] = {
          addresses: seen.slice(0, 6),
          has_v6: true,
          eui64: !!hitMac,
          mac: hitMac,
          basis: 'eui64-iid',
          sources: Object.keys(sources)
        };
      }
    } catch (e) { }
    var clk = cli['clock'];
    if (clk && typeof clk === 'object' && typeof clk.$ !== 'string') {
      var ts = tr.ts ? parseFloat(tr.ts) : NaN;
      var tm = ctx && ctx.traceMeta;
      var mid = tm && tm.t0 && tm.t1 ? (tm.t0 + tm.t1) / 2 : (clk.__t || null);
      if (mid && isFinite(ts)) {
        var skewS = num(ts - mid, 2);          // 正数=服务器比本地快（旧实现方向相反）
        clk.skew_s = skewS;
        clk.skew_h = num(skewS / 3600, 3);
        clk.rtt_ms = tm && tm.t0 && tm.t1 ? Math.round((tm.t1 - tm.t0) * 1000) : null;
      } else { clk.skew_s = null; clk.skew_h = null; clk.rtt_ms = null; }
      delete clk.__t;
    }
  }

  function idOf(env) {
    if (!env.__radishId) env.__radishId = uuid(env);
    return env.__radishId;   // 失败重试沿用同一个 id，后端按 id 幂等
  }

  // 纯同步组装（pagehide 要在事件处理函数内就发出去）
  function buildPlain(env, ctx, cli, stuck, partial) {
    var nav = env.navigator || {};
    var envOut = {
      v: 1,
      id: idOf(env),
      ts: new Date().toISOString(),
      session: getSession(env),
      page: {
        path: safe(function () { return env.location.pathname; }, ''),
        title: safe(function () { return String(env.document.title || '').slice(0, 120); }, ''),
        lang: safe(function () { return env.document.documentElement.lang || nav.language || ''; }, ''),
        ref: safe(function () { return String(env.document.referrer || '').slice(0, 300); }, ''),
        nav: 'navigate'
      },
      cli: cli,
      meta: {
        dur_ms: Date.now() - (env.__radishT0 || Date.now()),
        stuck: stuck,
        truncated: [],
        partial: !!partial,
        privacy: { dnt: String(nav.doNotTrack) === '1', gpc: nav.globalPrivacyControl === true, optout: optedOut(env) },
        collector: VERSION,
        ua: safe(function () { return nav.userAgent; }, '')
      }
    };
    // 探针自报的额度信息（例如 DNS 的单项/整轮期限与超时层级）挂 meta.timeouts，
    // 不塞进状态标记里——{"$":"timeout"} 必须保持是纯状态。
    var budget = ctx && ctx.cache && ctx.cache.timeouts;
    if (budget && typeof budget === 'object' && Object.keys(budget).length) {
      envOut.meta.timeouts = budget;
    }
    // H3 升级补测的记账（A-08）：补测次数、预算、结果分类都在这里，cli.quicfp 保持
    // "有 ja4 才是字符串、否则不出现"的老形状。没配探针时这一段根本不产生这块。
    var h3 = ctx && ctx.cache && ctx.cache.h3;
    if (h3 && typeof h3 === 'object' && Object.keys(h3).length) {
      envOut.meta.h3 = h3;
    }
    return envOut;

  }

  async function buildEnvelope(env, ctx, pre) {
    env = env || (typeof globalThis !== 'undefined' ? globalThis : this);
    ctx = ctx || makeCtx(env);
    var state = stateOf(env);
    if (!(pre && pre.prebuilt)) {
      state.cli = {};
      state.stuck = [];
      if (!optedOut(env)) {
        await runProbes(env, ctx, state, DEADLINE);
        if (ctx.ready) { try { await ctx.ready; } catch (e) { } }
        derive(env, ctx, state.cli, state.stuck);
      } else {
        // 隐私分支：不跑探针，只保留服务端可见的基础访问字段
        state.cli = {};
      }
    }
    return buildPlain(env, ctx, state.cli, state.stuck, !!(pre && pre.prebuilt));
  }

  // ---------- 归一化与预算 ----------
  function normalize(v) {
    if (v === null || v === undefined) return 'null';
    if (isMissing(v)) return v.$;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(num(v, 4));
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) {
      var a = v.map(function (x) { return typeof x === 'object' && x ? JSON.stringify(x) : String(x); });
      a = a.filter(function (x, i) { return a.indexOf(x) === i; }).sort();
      return a.join('|');
    }
    var keys = Object.keys(v).sort(), out = [];
    for (var i = 0; i < keys.length; i++) out.push(keys[i] + ':' + normalize(v[keys[i]]));
    return out.join('|');
  }

  // 只裁数组型长尾项；逐级压缩直到塞进预算，被裁的项目记在 meta.truncated 里
  var TRIM_ORDER = ['fonts', 'voices', 'icu'];
  var TRIM_LEVELS = [300, 150, 75, 37, 18, 9];

  // voices 的发送条数由**剩余预算**决定（A 项）：先看整份装不装得下，装得下就一条不裁；
  // 装不下才二分出"还能塞进去几条"，并且 total 仍然是采集到的原始总数、cut=true。
  // 旧实现无条件裁到 32 条，信封还有 30 KiB 余量时也在少报。
  function voiceObj(v) {
    if (!v) return null;
    // 兼容第一代数组形状（老记录、以及直接往信封里塞数组的工具）：内部统一成对象，
    // 这样"总数/实发/是否少报"三件事永远一起发。
    if (Array.isArray(v)) {
      return { alg: 'voices/2', total: v.length, shown: v.length, cut: false, list: v, source: 'array' };
    }
    if (typeof v !== 'object' || typeof v.$ === 'string' || !Array.isArray(v.list)) return null;
    if (typeof v.total !== 'number') v.total = v.list.length;
    if (typeof v.shown !== 'number') v.shown = v.list.length;
    return v;
  }
  function voiceTrim(envelope, limit, bytes, was) {
    var v = voiceObj(envelope.cli && envelope.cli.voices);
    if (!v) return false;
    var all = v.list;
    if (all.length < 2 || bytes() <= limit) return false;
    function fit(n) { v.list = all.slice(0, n); v.shown = n; return bytes() <= limit; }
    var lo = 1, hi = all.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (fit(mid)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!best) best = 1;                    // 一条都装不下也留一条：交给后面的压缩/降级去处理
    v.list = all.slice(0, best);
    v.shown = best;
    v.cut = best < v.total;
    was.voices = was.voices || v.total;
    envelope.cli.voices = v;
    return true;
  }

  function applyBudget(envelope, limit) {
    limit = limit || BUDGET;
    var was = {}, dropped = [];
    var bytes = function () {
      var s = JSON.stringify(envelope);
      return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length;
    };
    // 这里只剩"解析上限"：fonts 的候选集本身有界，icu 是计数对象。voices 不再写死条数。
    var HARD = { fonts: 300, icu: 24 };
    for (var hid in HARD) {
      var hv = envelope.cli[hid];
      if (Array.isArray(hv) && hv.length > HARD[hid]) { was[hid] = hv.length; envelope.cli[hid] = hv.slice(0, HARD[hid]); }
    }
    for (var L = 0; L < TRIM_LEVELS.length && bytes() > limit; L++) {
      var cap = TRIM_LEVELS[L];
      for (var i = 0; i < TRIM_ORDER.length; i++) {
        if (bytes() <= limit) break;
        var id = TRIM_ORDER[i], v = envelope.cli[id];
        if (!Array.isArray(v) || v.length <= cap) continue;
        was[id] = was[id] || v.length;
        envelope.cli[id] = v.slice(0, cap);
      }
    }
    // A：剩下的缺口优先由 voices 按预算补上（它是最长的长尾，且能如实记"少报了多少条"）
    if (bytes() > limit) voiceTrim(envelope, limit, bytes, was);
    // 仍然超预算：单个字符串本身太长（例如 40 × 20000 字符的语音名）
    if (bytes() > limit) {
      for (var sid in envelope.cli) envelope.cli[sid] = capStrings(envelope.cli[sid], STR_CAP, was, sid);
    }
    var KEEP = { clock: 1, screen: 1, gpu: 1, hwid: 1, fpid: 1, tz: 1, langs: 1, agent: 1, wgl: 1, webgl: 1, traces: 1 };
    var degraded = null;
    if (bytes() > limit) {
      // 只留诊断必需项，其余整体丢弃并记账（不静默）
      var kept = {}, all = 0;
      for (var kid in envelope.cli) {
        all++;
        if (KEEP[kid]) kept[kid] = envelope.cli[kid];
        else was[kid] = was[kid] || 1;
      }
      envelope.cli = kept;
      degraded = { level: 'whitelist', dropped: all - Object.keys(kept).length };
    }
    for (var k in was) dropped.push({ id: k, n: was[k] });

    // meta.truncated/degraded 本身也占字节：先写入再核验，超了继续砍到装得下为止。
    // 旧实现先算 ok 再写 meta，实测 33×1529 的 voices 会得到 ok=true 而实际 49171 B > 49152。
    envelope.meta = envelope.meta || {};
    var droppedN = dropped.length;
    for (var round = 0; round < 8; round++) {
      if (dropped.length) envelope.meta.truncated = dropped;
      else { try { delete envelope.meta.truncated; } catch (e) { } if (droppedN) envelope.meta.truncatedN = droppedN; }
      if (degraded) envelope.meta.degraded = degraded; else { try { delete envelope.meta.degraded; } catch (e) { } }
      if (bytes() <= limit) break;
      if (dropped.length > 1) { dropped = dropped.slice(0, 1); continue; }   // 先缩裁剪明细
      var cut = false;
      for (var id2 in envelope.cli) {
        var v2 = envelope.cli[id2];
        if (Array.isArray(v2) && v2.length > 1) { was[id2] = was[id2] || v2.length; envelope.cli[id2] = v2.slice(0, 1); cut = true; continue; }
        // voices 的对象形状也要能被这条兜底路径砍到 1 条（total 保住，shown 跟着变）
        var vo = voiceObj(v2);
        if (vo && vo.list.length > 1) {
          vo.list = vo.list.slice(0, 1); vo.shown = 1; vo.cut = 1 < vo.total;
          was[id2] = was[id2] || vo.total; envelope.cli[id2] = vo; cut = true;
        }
      }
      if (cut) continue;
      if (!degraded) {
        var kept2 = {}, all2 = 0;
        for (var kid2 in envelope.cli) { all2++; if (KEEP[kid2]) kept2[kid2] = envelope.cli[kid2]; }
        envelope.cli = kept2;
        degraded = { level: 'whitelist', dropped: all2 - Object.keys(kept2).length };
        continue;
      }
      if (degraded.level !== 'empty') { degraded = { level: 'empty', dropped: Object.keys(envelope.cli).length }; envelope.cli = {}; continue; }
      // 连骨架都塞不下：page 收窄到最少，再退一步只留 id/ts
      if (envelope.page && Object.keys(envelope.page).length) { envelope.page = { path: envelope.page.path || null }; continue; }
      if (envelope.meta) { envelope.meta = { collector: envelope.meta.collector, degraded: { level: 'empty', dropped: 0 } }; continue; }
      break;
    }
    return { envelope: envelope, dropped: dropped, bytes: bytes(), ok: bytes() <= limit };
  }

  // ---------- 发送 ----------
  function endpointOf(opts) { return (opts && opts.endpoint) || ENDPOINT; }

  function waitIdle(env) {
    // 只让一小会儿给首屏资源，绝不等 load 事件（那要等图片/字体，慢链路上能差好几秒）
    return new Promise(function (resolve) {
      var w = env, done = false;
      function go() { if (done) return; done = true; resolve(); }
      try {
        if (w.requestIdleCallback) { w.requestIdleCallback(go, { timeout: 300 }); setTimeout(go, 400); }
        else setTimeout(go, 300);
      } catch (e) { go(); }
    });
  }

  // 页面存活时用可读响应的 CORS 请求：能真正确认 204，而不是"已排队"（BLOG-11）
  function corsPost(url, body) {
    var f = typeof fetch === 'function' ? fetch : null;
    if (!f) return null;
    try {
      return f(url, {
        method: 'POST', body: body, mode: 'cors', credentials: 'omit',
        headers: { 'content-type': 'text/plain;charset=UTF-8' }
      }).then(function (r) {
        if (r && (r.status === 204 || (r.status >= 200 && r.status < 300))) return 'confirmed';
        return 'failed';      // 400/403/429/5xx 都算没落库；同 id 重发是安全的
      }, function () { return 'failed'; });
    } catch (e) { return null; }
  }

  // 离页或没有 fetch 时只能排队：sendBeacon/keepalive 的 true 不代表服务端收到
  function queuePost(env, url, body) {
    try {
      if (env.navigator && typeof env.navigator.sendBeacon === 'function') {
        if (env.navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return 'queued';
      }
    } catch (e) { }
    try {
      var f = typeof fetch === 'function' ? fetch : null;
      if (!f) return 'failed';
      f(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'content-type': 'text/plain' } })
        .catch(function () { });
      return 'queued';
    } catch (e) { return 'failed'; }
  }

  // 返回 'confirmed' | 'queued' | 'failed'
  function sendNow(env, url, body, opts) {
    if (!(opts && opts.queued)) {
      var p = corsPost(url, body);
      if (p) return p;
    }
    return Promise.resolve(queuePost(env, url, body));
  }

  function stateOf(env) {
    if (!env.__radishSt) env.__radishSt = { cli: {}, stuck: [], sent: false, partial: false };
    return env.__radishSt;
  }

  var INFLIGHT = null;   // 单次运行：并发调用复用同一次（G05）

  function run(env, opts) {
    // 自动启动调用的是 run()，没有参数：先落成全局对象，再往下走
    env = env || (typeof globalThis !== 'undefined' ? globalThis : this);
    if (alreadySent(env)) return Promise.resolve('already');
    if (INFLIGHT) return INFLIGHT;
    INFLIGHT = runInner(env, opts).then(function (r) {
      if (r !== 'sent' && r !== 'already') INFLIGHT = null;   // 失败可重试（G04）
      return r;
    }, function (e) { INFLIGHT = null; throw e; });
    return INFLIGHT;
  }

  async function runInner(env, opts) {
    env = env || (typeof globalThis !== 'undefined' ? globalThis : this);
    opts = opts || {};
    if (alreadySent(env)) return 'already';
    env.__radishT0 = Date.now();
    var limit = opts.limit || BUDGET;
    var url = endpointOf(opts);
    var ctx = makeCtx(env);
    var state = stateOf(env);
    var sentBody = null;

    function flush(partial) {
      var env2 = partial ? buildPlain(env, ctx, state.cli, state.stuck, true) : null;
      return env2;
    }
    function beacon(obj, opts) {
      var res = applyBudget(obj, limit);
      if (!res.ok) return Promise.resolve('failed');      // 超预算的体一律不发（BLOG-10.3）
      var body;
      try { body = JSON.stringify(res.envelope); } catch (e) { return Promise.resolve('failed'); }
      return sendNow(env, url, body, opts).then(function (st) {
        if (st === 'confirmed' || st === 'queued') sentBody = body;   // 只在真的送出去之后才记账
        return st;
      });
    }

    // 离页：在事件处理函数里同步组装并排队，不等探针（G03）
    var hideSent = false, hideBound = false;
    function onHide() {
      if (hideSent || state.sent) return;
      hideSent = true;
      var obj;
      try { obj = flush(true); } catch (e) { return; }
      beacon(obj, { queued: true }).then(function (st) {
        if (st === 'queued' || st === 'confirmed') {
          // 只记"半份已经排上队"。不能写 markSent：那会把整次访问关掉，
          // 探针跑完之后那份完整信封就再也发不出去了（B-07 的后端归并就是为它准备的）。
          state.partial = true;
          state.partialSent = true;
          env.__radishPartialSent = true;
        } else {
          hideSent = false;
          state.partial = true;
        }
      });
    }
    try { if (env.addEventListener) { env.addEventListener('pagehide', onHide, { once: true }); hideBound = true; } } catch (e) { }
    function offHide() {
      if (!hideBound) return;
      hideBound = false;
      try { if (env.removeEventListener) env.removeEventListener('pagehide', onHide); } catch (e) { }
    }

    await Promise.race([waitIdle(env), new Promise(function (r) { setTimeout(r, 1500); })]);

    // 隐私分支：不发任何诊断网络请求（G15）
    if (!optedOut(env)) {
      ctx.ready = Promise.race([
        Promise.all([
          (function () {
            var t0 = Date.now() / 1000;
            return ctx.text(opts.trace || TRACE_URL, 2500).then(function (t) {
              if (!t) return;
              ctx.trace = parseTrace(t);
              // 钟差要么用请求中点估计，要么不算：直接用"发出时刻"会混进一半 RTT
              ctx.traceMeta = { t0: t0, t1: Date.now() / 1000 };
            });
          })(),
          ctx.json(opts.hints || HINTS_URL, 2500).then(function (j) { if (j) ctx.hints = j; })
        ]),
        new Promise(function (r) { setTimeout(r, 2500); })
      ]);
    }

    var env2 = await buildEnvelope(env, ctx);
    if (state.sent) { offHide(); return 'sent'; }        // 已经确认送达完整信封
    // 离页时先发过半份：现在探针跑完了，补一份完整的，后端按 id 归并（B-07）
    var st = await beacon(env2);
    if (st === 'confirmed' || st === 'queued') {
      markSent(env, st);                                  // 正常完成后就不再留离页监听（BLOG-12）
      offHide();
      return 'sent';
    }
    state.partial = true;
    return 'failed';                                      // 不写 sent 标记，允许重试
  }

  var RC = {
    VERSION: VERSION,
    ENDPOINT: ENDPOINT,
    TRACE_URL: TRACE_URL,
    HINTS_URL: HINTS_URL,
    PROBE_URL: PROBE_URL,
    BUDGET: BUDGET,
    PROBE_TIMEOUT: PROBE_TIMEOUT,
    SLOW_TIMEOUT: SLOW_TIMEOUT,
    SLOW_IDS: SLOW_IDS,
    DEADLINE: DEADLINE,
    // F-07 / F-08 的期限与有限清单：给测试与体检工具读，生产逻辑不依赖外面改它
    TRACKER_CONTROL_URL: TRACKER_CONTROL_URL,
    TRACKER_TARGETS: TRACKER_TARGETS,
    TRACKER_CONTROL_TIMEOUT: TRACKER_CONTROL_TIMEOUT,
    TRACKER_TARGET_TIMEOUT: TRACKER_TARGET_TIMEOUT,
    ETAG_TIMEOUT: ETAG_TIMEOUT,
    // A-01 / A-06 / A-07 / A-08 的常量与有限清单：同样只给测试与体检工具读
    ETAG_URL: ETAG_URL,
    H3_RETRY_MAX: H3_RETRY_MAX,
    H3_RETRY_GAP: H3_RETRY_GAP,
    H3_RETRY_TIMEOUT: H3_RETRY_TIMEOUT,
    H3_RETRY_BUDGET: H3_RETRY_BUDGET,
    EXT_TARGETS: EXT_TARGETS,
    EXT_MARKS: EXT_MARKS,
    SITE_GLOBALS: SITE_GLOBALS,
    EXT_PATH_TIMEOUT: EXT_PATH_TIMEOUT,
    // G 127：第一批新增的有限表与期限，同样只给测试与体检工具读
    MODEL_CODES: MODEL_CODES,
    MODEL_MAP_VERSION: MODEL_MAP_VERSION,
    MODEL_MAP_SOURCE: MODEL_MAP_SOURCE,
    APPLE_MODELS: APPLE_MODELS,
    APPLE_MAP_VERSION: APPLE_MAP_VERSION,
    APPLE_MAP_SOURCE: APPLE_MAP_SOURCE,
    FORM_KINDS: FORM_KINDS,
    DRIVER_GLOBALS: DRIVER_GLOBALS,
    DRIVER_PREFIX: DRIVER_PREFIX,
    PERM_NAMES: PERM_NAMES,
    PERM_TIMEOUT: PERM_TIMEOUT,
    BIO_CAPS: BIO_CAPS,
    INPUT_TYPES: INPUT_TYPES,
    AGENT_WAIT_DEFAULT: AGENT_WAIT_DEFAULT,
    GAMEPAD_WAIT_DEFAULT: GAMEPAD_WAIT_DEFAULT,
    AD_URL: AD_URL,
    AD_TIMEOUT: AD_TIMEOUT,
    VOICE_POOL: VOICE_POOL,
    TRACE_TTL_DAYS: TRACE_TTL_DAYS,
    TRACE_ASYNC_TIMEOUT: TRACE_ASYNC_TIMEOUT,
    // G 127 · fp 批（附录 K）：有限表与摘要口径常量，只给测试与文档核对用
    WASM_CASES: WASM_CASES,
    WASM_CONTROL: WASM_CONTROL,
    JS_FEATURES: JS_FEATURES,
    CSSV_FEATURES: CSSV_FEATURES,
    FP_ALG_VERSION: FP_ALG_VERSION,
    HW_ALG_VERSION: HW_ALG_VERSION,
    FP_INPUTS: FP_INPUTS,
    HW_INPUTS: HW_INPUTS,
    normalize: normalize,
    applyBudget: applyBudget,
    buildEnvelope: buildEnvelope,
    parseTrace: parseTrace,
    M: M,
    probes: PROBES,
    run: run,
    getSession: getSession,
    optedOut: optedOut
  };

  if (typeof window !== 'undefined') {
    window.__radish = RC;
    // 自动启动（A-11：注释按实际行为写）：文档已经 complete/interactive 就立刻跑，
    // 否则等 DOMContentLoaded 再跑。不"等 load"、也没有固定的 1.2s 空等。
    // 测试/内嵌环境用 window.__radishManual = true 关掉自动启动，手动调 run()。
    if (!window.__radishManual) {
      try {
        var kick = function () { try { RC.run(); } catch (e) { } };
        var doc = typeof document !== 'undefined' ? document : null;
        if (!doc) kick();
        else if (doc.readyState === 'complete' || doc.readyState === 'interactive') kick();
        else if (doc.addEventListener) doc.addEventListener('DOMContentLoaded', kick, { once: true });
        else if (window.addEventListener) window.addEventListener('load', kick, { once: true });
      } catch (e) { }
    }
  }
  if (typeof globalThis !== 'undefined') globalThis.__radish = RC;
  if (typeof module !== 'undefined' && module.exports) module.exports = RC;
})();
