'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'static', 'radish-collect.js');
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
    location: { pathname: '/post/x.html', href: 'https://blue-radish.github.io/post/x.html' },
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
  return env;
}

/** 把 vm 里造出来的对象转成本 realm 的普通对象，便于 deepStrictEqual 比较 */
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

function loadCollector(env) {
  env = env || fakeEnv();
  const ctx = vm.createContext(env);
  env.window = env;
  env.globalThis = env;
  vm.runInContext(SRC, ctx, { filename: 'radish-collect.js' });
  if (!env.window.__radish) throw new Error('collector 未挂载到 window.__radish');
  return env.window.__radish;
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

module.exports = { loadCollector, fakeEnv, collectorCtx, plain, UA, SRC_PATH };
