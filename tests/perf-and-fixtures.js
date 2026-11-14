'use strict';
// 真浏览器：四类移动端 + 桌面，各跑若干轮，收集
//   1) 整轮采集时长（buildEnvelope 返回值里的 meta.elapsed_ms 与本脚本计的时间）
//   2) 最长主线程任务、外部请求数与失败数
//   3) 脱敏信封夹具（真 Client Hints，不是假环境凑出来的）
// 用 CDP 直连，无第三方依赖：Node 22+ 自带 WebSocket 与 fetch。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const PAGE = process.env.PERF_PAGE || 'https://blog.072120.xyz/';
const LOCAL = process.env.PERF_LOCAL === '1';
const RUNS = Number(process.env.RUNS || 3);
const OUT_DIR = path.join(__dirname, 'fixtures', 'envelopes');
let BROWSER_VERSION = 'unknown';
const PROCESS_OS = os.platform() + ' ' + os.release();
const PERF_FILE = path.join(__dirname, '..', 'specs', 'reviews', '2026-11-13-source', 'perf-latest.json');

const PROFILES = {
  androidChrome: {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    meta: { platform: 'Android', platformVersion: '15.0.0', architecture: 'arm', model: 'Pixel 7', mobile: true, brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }], fullVersionList: [{ brand: 'Chromium', version: '141.0.7341.0' }, { brand: 'Google Chrome', version: '141.0.7341.0' }] },
    view: { width: 412, height: 829, dpr: 2.625, mobile: true, screenWidth: 412, screenHeight: 915 }, touch: true
  },
  firefoxAndroid: {
    ua: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    meta: null,
    view: { width: 412, height: 829, dpr: 1.75, mobile: true, screenWidth: 412, screenHeight: 915 }, touch: true
  },
  iosSafari: {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    meta: null,
    view: { width: 393, height: 659, dpr: 3, mobile: true, screenWidth: 393, screenHeight: 852 }, touch: true
  },
  desktopSiteMode: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    meta: { platform: 'Android', platformVersion: '15.0.0', architecture: '', model: '', mobile: true, brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }] },
    view: { width: 412, height: 829, dpr: 2.625, mobile: true, screenWidth: 412, screenHeight: 915 }, touch: true
  },
  desktopChrome: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    meta: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false, brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }] },
    view: { width: 1512, height: 860, dpr: 1.25, mobile: false, screenWidth: 1920, screenHeight: 1080 }, touch: false
  }
};

const HOOKS = `
window.__radishManual = true;
window.__perf = { lt: [], req: 0, fail: 0 };
try {
  new PerformanceObserver(function (l) {
    l.getEntries().forEach(function (e) { window.__perf.lt.push(Math.round(e.duration)); });
  }).observe({ type: 'longtask', buffered: true });
} catch (e) {}
try {
  var of = window.fetch;
  window.fetch = function () { window.__perf.req++; return of.apply(this, arguments); };
} catch (e) {}
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { }
    await sleep(250);
  }
  throw new Error('等待 CDP 超时：' + url);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiting.has(msg.id)) {
        const { res, rej } = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); rej(new Error('CDP 超时：' + method)); } }, 60000);
    });
  }
  takeEvents(method) {
    const hit = this.events.filter(e => e.method === method);
    this.events = this.events.filter(e => e.method !== method);
    return hit;
  }
}

// B-01：夹具必须自带来源说明。这五个夹具全部来自同一个桌面 Chrome 进程，
// 用 CDP 覆盖 UA 与屏幕参数得到——它证明"桌面 Chromium 在模拟参数下采集器的行为"，
// 不能证明 Gecko、JavaScriptCore、Android 系统接口、真实传感器与驱动也这样。
function provenance(name, profile) {
  return {
    kind: 'chrome-emulated',
    real_device: false,
    engine: 'blink',
    browser: BROWSER_VERSION,
    process_os: PROCESS_OS,
    // 夹具页是本地服起还是线上：线上被 Cloudflare 缓存时拿到旧脚本，本地则一定是仓库里这一份
    page: LOCAL ? 'http://127.0.0.1:8099/ (仓库内静态页)' : PAGE,
    collector: null, // 由 sanitize 从 meta.collector 填入
    emulated: {
      userAgent: profile.ua,
      userAgentMetadata: profile.meta,
      deviceMetrics: profile.view,
      touch: !!profile.touch
    },
    proves: '桌面 Chromium 在给定 UA/屏幕参数下，采集器产生什么形状的信封',
    cannot_prove: [
      'Firefox/Gecko 与 iOS/JavaScriptCore 的真实行为（UA 改了，引擎没变）',
      'Android 系统接口、真实传感器读数、GPU 驱动与字体枚举',
      '真实触屏、软键盘、屏幕旋转与省电策略下的读数'
    ]
  };
}

function sanitize(env, profile, name) {
  const clean = JSON.parse(JSON.stringify(env));
  clean.id = '<uuid>';
  clean.session = '<session>';
  clean.ts = '2026-11-13T00:00:00.000Z';
  clean.page = Object.assign({}, clean.page, { path: '/fixture', title: '夹具页', ref: '' });
  if (clean.srv && clean.srv.h) {
    const h = clean.srv.h;
    ['cf-connecting-ip', 'x-forwarded-for', 'cf-ray'].forEach(k => { if (k in h) h[k] = '<redacted>'; });
  }
  const c = clean.cli || {};
  ['fpid', 'hwid'].forEach(k => { if (c[k]) c[k] = 'sha256:<redacted>'; });
  if (c.canvas) c.canvas = { h: 'sha256:<redacted>', len: c.canvas.len };
  ['fontfp', 'domrect', 'svgrect', 'textm', 'glimg'].forEach(k => {
    if (typeof c[k] === 'string') c[k] = 'sha256:<redacted>';
  });
  if (c.mathfp && typeof c.mathfp === 'object') c.mathfp = Object.assign({}, c.mathfp, { h: 'sha256:<redacted>' });
  if (c.audio && typeof c.audio === 'object') c.audio = Object.assign({}, c.audio, { sum: '<redacted>' });
  if (Array.isArray(c.voices)) c.voices = ['<voice>'];
  if (clean.meta) clean.meta = Object.assign({}, clean.meta, { profile });
  // 放进 meta.provenance：信封顶层仍然是 fixed 的七个键
  var prov = provenance(name, profile);
  prov.collector = (clean.meta && clean.meta.collector) || null;
  clean.meta = Object.assign({}, clean.meta, { provenance: prov });
  return clean;
}

function startLocalServer() {
  const http = require('node:http');
  const root = path.join(__dirname, '..');
  const page = `<!doctype html><meta charset="utf-8"><title>perf</title>
<script src="/docs/radish-collect.js" data-base="https://radishcloud.20050416.shop"></script>`;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    const file = path.join(root, decodeURIComponent(url));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'text/javascript' : 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(8099, '127.0.0.1', () => resolve(server)));
}

(async () => {
  let localServer = null;
  if (LOCAL) { localServer = await startLocalServer(); console.log('本地夹具页：http://127.0.0.1:8099/'); }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radish-perf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
    '--window-size=1512,860', 'about:blank'
  ], { stdio: 'ignore' });

  const cleanups = [];
  try {
    const version = await waitJson('http://127.0.0.1:' + PORT + '/json/version');
  BROWSER_VERSION = version.Browser || 'unknown';
    console.log('浏览器：' + version.Browser);
    const target = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    cleanups.push(() => cdp.ws.close());

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOKS });

    const perf = {};
    for (const name of Object.keys(PROFILES)) {
      const p = PROFILES[name];
      await cdp.send('Emulation.setUserAgentOverride', p.meta
        ? { userAgent: p.ua, acceptLanguage: 'zh-CN,zh', platform: p.meta.platform, userAgentMetadata: p.meta }
        : { userAgent: p.ua, acceptLanguage: 'zh-CN,zh', platform: name === 'iosSafari' ? 'iPhone' : 'Linux' });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: p.view.width, height: p.view.height, deviceScaleFactor: p.view.dpr, mobile: p.view.mobile,
        screenWidth: p.view.screenWidth, screenHeight: p.view.screenHeight
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', p.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });

      const rounds = [];
      let fixture = null;
      for (let i = 0; i < RUNS; i++) {
        cdp.events = [];
        await cdp.send('Page.navigate', { url: (LOCAL ? 'http://127.0.0.1:8099/' : PAGE) + '?perf=' + Date.now() + '-' + i });
        await sleep(2500);
        // 页面可能还没把 __radish 挂上
        let ready = false;
        for (let k = 0; k < 20 && !ready; k++) {
          const probe = await cdp.send('Runtime.evaluate', { expression: '!!(window.__radish && window.__radish.buildEnvelope)', returnByValue: true });
          ready = probe.result && probe.result.value === true;
          if (!ready) await sleep(500);
        }
        if (!ready) throw new Error(name + ' 上没有找到 __radish.buildEnvelope');
        const expr = `(async () => {
          const t0 = performance.now();
          const env = await window.__radish.buildEnvelope(undefined);
          const wall = performance.now() - t0;
          return JSON.stringify({ wall: Math.round(wall), elapsed: (env.meta && env.meta.dur_ms) || null, env: env, lt: window.__perf.lt.slice(), req: window.__perf.req });
        })()`;
        const res = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) throw new Error('执行失败：' + JSON.stringify(res.exceptionDetails).slice(0, 300));
        const out = JSON.parse(res.result.value);
        const net = cdp.takeEvents('Network.requestWillBeSent').length;
        const failed = cdp.takeEvents('Network.loadingFailed').length;
        rounds.push({
          wall_ms: out.wall,
          dur_ms: out.elapsed,
          longest_task_ms: out.lt.length ? Math.max.apply(null, out.lt) : 0,
          long_tasks: out.lt.length,
          requests: net,
          failures: failed,
          collected: Object.keys((out.env.cli) || {}).length,
          stuck: (out.env.meta && out.env.meta.stuck) || []
        });
        if (i === 0) fixture = sanitize(out.env, PROFILES[name], name);
        await sleep(500);
      }
      perf[name] = rounds;
      if (fixture) {
        fs.writeFileSync(path.join(OUT_DIR, name + '.json'), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
      }
      const walls = rounds.map(r => r.wall_ms).sort((a, b) => a - b);
      const med = walls[Math.floor(walls.length / 2)];
      const p95 = walls[Math.min(walls.length - 1, Math.ceil(walls.length * 0.95) - 1)];
      console.log(`${name}: 轮次 ${rounds.length}，P50 ${med} ms，P95 ${p95} ms，最长任务 ${Math.max.apply(null, rounds.map(r => r.longest_task_ms))} ms，请求 ${rounds[0].requests}，失败 ${rounds[0].failures}，字段 ${rounds[0].collected}`);
    }
    fs.writeFileSync(PERF_FILE, JSON.stringify({ browser: version.Browser, page: PAGE, runs: RUNS, at: new Date().toISOString(), perf }, null, 2) + '\n', 'utf8');
    console.log('性能数据写入：' + PERF_FILE);
  } finally {
    cleanups.forEach(fn => { try { fn(); } catch (e) { } });
    if (localServer) { try { localServer.close(); } catch (e) { } }
    try { chrome.kill(); } catch (e) { }
  }
})().catch(err => { console.error('失败：' + (err && err.message)); process.exit(1); });
