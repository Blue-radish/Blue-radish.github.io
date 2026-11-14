'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 默认跑源文件；CI 用 SITE_SRC=docs/radish-collect.js 让行为测试跑在待发布产物上
const SRC_PATH = process.env.SITE_SRC
  ? path.resolve(process.cwd(), process.env.SITE_SRC)
  : path.join(__dirname, '..', 'static', 'radish-collect.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function fakeElement(tag, over) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: '',
    offsetWidth: 100,
    clientWidth: 85,
    offsetHeight: over.baitHidden ? 0 : 250,
    clientHeight: over.baitHidden ? 0 : 250,
    setAttribute(k, v) { this[k] = v; },
    appendChild() { },
    removeChild() { },
    getContext(kind) {
      if (over.throwOnContext) throw new Error('SecurityError: cannot read canvas');
      return null;
    },
    getBoundingClientRect() { return { width: 137.5, height: 43.25, x: 1.5, top: 2.5 }; },
    getClientRects() { return [{}, {}]; },
    toDataURL() { return 'data:image/png;base64,AAA'; },
    measureText() {
      return {
        width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: 100,
        fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3
      };
    }
  };
  return el;
}

function fakeEnv(over) {
  over = over || {};
  const store = new Map();
  const sent = [];

  const navigator = {
    userAgent: UA,
    languages: ['zh-CN', 'zh'],
    language: 'zh-CN',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    platform: 'Win32',
    vendor: 'Google Inc.',
    productSub: '20030107',
    cookieEnabled: true,
    webdriver: false,
    pdfViewerEnabled: true,
    plugins: [],
    sendBeacon(url, blob) { sent.push({ url, blob }); return true; }
  };
  if (over.dnt) navigator.doNotTrack = over.dnt;
  if (over.gpc) navigator.globalPrivacyControl = true;

  const env = {
    __radishManual: true, // 关掉采集脚本的自动启动，测试里手动调 run()
    innerWidth: 1920,
    innerHeight: 1040,
    outerWidth: 1920,
    outerHeight: 1080,
    devicePixelRatio: 1.25,
    name: '',
    history: { length: 3 },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, isExtended: false },
    location: { pathname: '/post/x.html', href: 'https://blue-radish.github.io/post/x.html', origin: 'https://blue-radish.github.io' },
    document: {
      readyState: over.idleNeverFires ? 'loading' : 'complete',      title: '测试页',
      referrer: '',
      documentElement: { lang: 'zh-CN' },
      body: { appendChild() { }, removeChild() { } },
      createElement(tag) { return fakeElement(tag, over); },
      createElementNS() {
        return {
          setAttribute() { }, appendChild() { },
          getBBox() { return { x: 1.5, y: 2.5, width: 3.5, height: 4.5 }; },
          getBoundingClientRect() { return { width: 137.5, height: 43.25 }; }
        };
      }
    },
    navigator,
    performance: { now: () => Date.now() },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ fontSize: '16px', accentColor: 'rgb(0, 0, 0)', display: 'block', length: 320 }),
    requestIdleCallback: over.idleNeverFires ? function () { } : function (cb) { setTimeout(cb, 0); },
    requestAnimationFrame: over.idleNeverFires ? function () { } : function (cb) { setTimeout(() => cb(Date.now()), 0); },
    addEventListener() { }, removeEventListener() { },
    __sent: sent
  };

  if (over.sessionStorageThrows) {
    env.sessionStorage = {
      getItem() { throw new Error('SecurityError: storage disabled'); },
      setItem() { throw new Error('SecurityError: storage disabled'); },
      get length() { throw new Error('SecurityError'); }
    };
  } else {
    env.sessionStorage = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      get length() { return store.size; }
    };
  }
  env.localStorage = { length: 0 };
  env.Buffer = Buffer;
  env.TextEncoder = TextEncoder;
  env.TextDecoder = TextDecoder;
  env.URL = URL;
  env.Blob = Blob;
  env.AbortSignal = AbortSignal;
  env.AbortController = AbortController;
  env.setTimeout = setTimeout;
  env.clearTimeout = clearTimeout;
  env.setInterval = setInterval;
  env.clearInterval = clearInterval;
  env.queueMicrotask = queueMicrotask;
  env.console = console;
  // 输入观测（gamepad / agent）默认把观测窗口压到 0：替身环境里不会有人点鼠标，
  // 每个用例白等 1.2 秒没有意义。需要验"等输入 / 重读"的用例自己设这个值，
  // 并用 eventEnv() 派发事件。
  env.__radishInputWait = 0;
  return env;
}

/** 装一个可以派发事件的 env（输入观测用）：__dispatch(type, ev) 调所有该类型监听 */
function eventEnv(over) {
  const env = fakeEnv(over);
  const map = new Map();
  env.addEventListener = (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  env.removeEventListener = (type, fn) => {
    const arr = map.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  env.__dispatch = (type, ev) => {
    (map.get(type) || []).slice().forEach((fn) => fn(Object.assign({ type, isTrusted: true }, ev || {})));
  };
  env.__listeners = (type) => (map.get(type) || []).length;
  return env;
}

/** 把 vm 里造出来的对象转成本 realm 的普通对象，便于 deepStrictEqual 比较 */
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------------------------------------------------------------------
// 确定性沙箱（一）：冻结假 window 的全局集合
//
// 假 env 就是 vm 的全局对象，所以采集器的「数 window 自有属性名」（cli.keys）量到的
// 其实是**宿主 Node 的 V8 内建全局**：Node 22.21 有 63 个名字，Node 24.21 多出
// AsyncDisposableStack / DisposableStack / Float16Array / SuppressedError 四个。
// 真浏览器上这些名字来自浏览器自己，不会随"构建机装了哪个 Node"变；这里同理：
// 按下面这份**显式清单**冻结（清单外的删掉），让 keys/2 的计数与 CI 的 Node 版本无关。
//
// 只删不加：给沙箱补一个假 API 会让"引擎能力"类读数（engver / wasm / icu）说谎，
// 那几项就是宿主的引擎与 ICU 数据面，仍然随 Node 变——它们不进契约的数值比较，
// 见 tests/make-contract.js 的 HOST_NUMBER（形状上记 number<host>）。
const FROZEN_GLOBALS = [
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array',
  'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError',
  'FinalizationRegistry', 'Float32Array', 'Float64Array', 'Function', 'Infinity',
  'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math',
  'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
  'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError',
  'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray',
  'WeakMap', 'WeakRef', 'WeakSet', 'WebAssembly', 'console', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'globalThis',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'
];

/** 删掉清单外的全局（以及清单外、假 env 自己也没定义的名字）。返回被删掉的名字。 */
function freezeGlobals(ctx, env) {
  const allowed = FROZEN_GLOBALS.concat(Object.getOwnPropertyNames(env));
  const code = '(function (allowed) {' +
    'var dropped = [];' +
    'Object.getOwnPropertyNames(globalThis).forEach(function (n) {' +
    '  if (allowed.indexOf(n) !== -1) return;' +
    '  var d = Object.getOwnPropertyDescriptor(globalThis, n);' +
    '  if (!d || !d.configurable) return;' +
    '  try { delete globalThis[n]; dropped.push(n); } catch (e) { }' +
    '});' +
    'return dropped;' +
    '})(' + JSON.stringify(allowed) + ')';
  return vm.runInContext(code, ctx, { filename: 'harness-freeze-globals.js' });
}

// 确定性沙箱（二）：Intl.Locale 的周起始读数
//
// 「一年第一周最少几天」这个字段在规范里改过名：早期是 minimalDays，现行规范是 minDays。
// 采集器现在两个都认（1.9.7 起）。真假浏览器的差别在这里必须由**夹具**决定，不能由宿主的
// Node/V8 决定——同一份采集器不能因为构建机换了 Node 就读出不同的周信息。所以假 window 按
// 现行规范给形状：
//   {firstDay, weekend, minDays}  ← 现行规范字段
// 真 Chrome 157 实测更极端：weekInfo 只有 {firstDay, weekend}，两个名字都没有（所以真机上
// minDays 如实为 null）。本夹具给 1，是为了让"读到新名字"这条路有测试覆盖，
// 不代表真浏览器一定给这个值。
const FAKE_WEEK_INFO = { firstDay: 1, weekend: [6, 7], minDays: 1 };

function patchIntlLocale(ctx, info) {
  info = info === undefined ? FAKE_WEEK_INFO : info;
  const code = '(function (info) {' +
    'if (!Intl || typeof Intl.Locale !== "function") return "no-locale";' +
    'function Locale(tag, opts) {' +
    '  if (!(this instanceof Locale)) return new Locale(tag, opts);' +
    '  this.tag = String(tag === undefined || tag === null ? "en" : tag);' +
    '}' +
    'Object.defineProperty(Locale.prototype, "toString", {' +
    '  value: function () { return this.tag; }, configurable: true' +
    '});' +
    // 原样透传 info 上的字段（含名字差异：现行规范 minDays、早期规范 minimalDays），
    // 这样测试既能验"读新名字"，也能验"退回旧名字"，不必再改这里。
    'if (info !== "absent") {' +
    'Object.defineProperty(Locale.prototype, "weekInfo", {' +
    '  get: function () {' +
    '    var o = {};' +
    '    for (var k in info) { o[k] = info[k]; }' +
    '    if (o.weekend && o.weekend.slice) { o.weekend = o.weekend.slice(); }' +
    '    return o;' +
    '  }, configurable: true' +
    '});' +
    '}' +
    'Object.defineProperty(Intl, "Locale", {' +
    '  value: Locale, writable: true, enumerable: false, configurable: true' +
    '});' +
    'return "patched";' +
    '})(' + JSON.stringify(info) + ')';
  return vm.runInContext(code, ctx, { filename: 'harness-intl-locale.js' });
}

// 确定性沙箱（三）：时区
//
// `clock` 探针读 `new Date().getTimezoneOffset()`，`tz` 探针读
// `Intl.DateTimeFormat().resolvedOptions().timeZone`，`fpid` 又把 `tz` 算进摘要。
// 这三样在真浏览器里由**用户系统时区**决定，在测试里却由**跑测试的机器/CI 容器**决定：
// 本机是 Asia/Hong_Kong（-480），CI 容器是 UTC（0），于是同一份采集器在两边读出不同
// 的时钟偏移，契约夹具也跟着漂。假 window 既然声称自己是某台机器，就把这台机器的时区
// 钉死（UTC+8）——这是夹具的设定，不是替采集器圆场。
const FIXED_TZ = 'Asia/Shanghai';
const FIXED_OFFSET_MIN = -480;   // 东八区：getTimezoneOffset() 返回 UTC-本地，故为负

function pinClock(ctx) {
  const code = '(function (tz, off) {' +
    'var DTF = Intl.DateTimeFormat;' +
    'function wrap(locales, options) {' +
    '  var o = {};' +
    '  if (options) { for (var k in options) { o[k] = options[k]; } }' +
    '  if (o.timeZone === undefined) { o.timeZone = tz; }' +
    '  return new DTF(locales, o);' +
    '}' +
    'wrap.prototype = DTF.prototype;' +
    'if (DTF.supportedLocalesOf) {' +
    '  wrap.supportedLocalesOf = function (l, o) { return DTF.supportedLocalesOf(l, o); };' +
    '}' +
    'Object.defineProperty(Intl, "DateTimeFormat", {' +
    '  value: wrap, writable: true, enumerable: false, configurable: true' +
    '});' +
    'Object.defineProperty(Date.prototype, "getTimezoneOffset", {' +
    '  value: function () { return off; }, writable: true, enumerable: false, configurable: true' +
    '});' +
    'return "pinned";' +
    '})(' + JSON.stringify(FIXED_TZ) + ', ' + FIXED_OFFSET_MIN + ')';
  return vm.runInContext(code, ctx, { filename: 'harness-pin-clock.js' });
}

function loadCollector(env, opts) {
  env = env || fakeEnv();
  opts = opts || {};
  const ctx = vm.createContext(env);
  freezeGlobals(ctx, env);
  // weekInfo: 不传 → 用默认形状；传 null → 不注入（该引擎就没有 weekInfo）；
  //           传对象 → 按对象给的字段注入（用来验字段改名后的回落）。
  if (opts.weekInfo !== null) patchIntlLocale(ctx, opts.weekInfo);
  if (opts.pinClock !== false) pinClock(ctx);
  env.window = env;
  env.globalThis = env;
  vm.runInContext(SRC, ctx, { filename: 'radish-collect.js' });
  if (!env.window.__radish) throw new Error('collector 未挂载到 window.__radish');
  return env.window.__radish;
}

/** 等一个只由 **unref 计时器**驱动的 promise 时撑住事件循环。
 *
 *  Node 的 AbortSignal.timeout() 内部计时器是 unref 的（不撑事件循环）。测试里
 *  "假 fetch 挂住、等采集器自己超期"这种用例，事件循环会先空：Node 22 的 test runner
 *  把那记成 "Promise resolution is still pending but the event loop has already
 *  resolved"，并且把同一个文件剩下的用例一起取消（Node 24 恰好还撑着，所以只在 CI 红）。
 *  用法：const release = keepAlive(); try { await p } finally { release(); }
 */
function keepAlive(ms) {
  const t = setInterval(() => { }, ms || 25);
  return () => clearInterval(t);
}

/** 预置好 trace / hints 的上下文，跳过网络请求 */
function collectorCtx(over) {
  const trace = {
    kex: 'X25519MLKEM768', warp: 'off', colo: 'LAX', http: 'HTTP/2', tls: 'TLSv1.3',
    ts: String(Date.now() / 1000), loc: 'US', sni: 'plaintext'
  };
  return Object.assign({
    trace: trace,
    hints: { h: { 'sec-ch-ua': '"Chromium";v="141"', 'sec-ch-ua-platform': '"Windows"' } },
    // 生产 PROBE_URL 是空字符串；测试用 collectorCtx({ probeUrl }) 覆盖这一项
    probeUrl: '',
    parseTrace(t) {
      const out = {};
      String(t).split('\n').forEach(l => {
        const i = l.indexOf('=');
        if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      });
      return out;
    },
    text: () => Promise.resolve(null),
    json: () => Promise.resolve(null)
  }, over || {});
}

module.exports = {
  loadCollector, fakeEnv, eventEnv, collectorCtx, plain, keepAlive, UA, SRC_PATH,
  FROZEN_GLOBALS, FAKE_WEEK_INFO, FIXED_TZ, FIXED_OFFSET_MIN
};
