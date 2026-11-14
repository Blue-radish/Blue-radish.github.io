'use strict';
// 生成四类设备的脱敏信封夹具：Android Chrome、Firefox Android、iOS Safari、桌面站点模式。
// 用 tests/harness.js 的假环境跑真实采集器，只改设备相关字段，不编造读数：
// 假环境读不到的项自然会给 unsupported / not_run 状态，这正是夹具要保留的真实形状。
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector, fakeEnv, collectorCtx } = require('./harness.js');

const OUT = path.join(__dirname, 'fixtures', 'envelopes');
fs.mkdirSync(OUT, { recursive: true });

const BASE = {
  androidChrome: {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    nav: { maxTouchPoints: 5, deviceMemory: 8, hardwareConcurrency: 8, platform: 'Linux armv81', vendor: 'Google Inc.' },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, isExtended: false },
    view: { innerWidth: 412, innerHeight: 829, outerWidth: 412, outerHeight: 915, devicePixelRatio: 2.625 },
    hints: {
      'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="24"',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-model': '"Pixel 7"',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua-mobile': '?1'
    },
    touch: 5
  },
  firefoxAndroid: {
    ua: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    nav: { maxTouchPoints: 5, deviceMemory: undefined, hardwareConcurrency: 4, platform: 'Linux armv81', vendor: '' },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, isExtended: false },
    view: { innerWidth: 412, innerHeight: 829, outerWidth: 412, outerHeight: 915, devicePixelRatio: 1.75 },
    hints: {},
    touch: 5
  },
  iosSafari: {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    nav: { maxTouchPoints: 5, deviceMemory: undefined, hardwareConcurrency: 6, platform: 'iPhone', vendor: 'Apple Computer, Inc.' },
    screen: { width: 393, height: 852, availWidth: 393, availHeight: 852, colorDepth: 24, isExtended: false },
    view: { innerWidth: 393, innerHeight: 659, outerWidth: 393, outerHeight: 852, devicePixelRatio: 3 },
    hints: {},
    touch: 5
  },
  desktopSiteMode: {
    // 手机开"桌面版网站"：UA 是桌面，但屏幕、触点、DPR 仍是手机
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    nav: { maxTouchPoints: 5, deviceMemory: 8, hardwareConcurrency: 8, platform: 'Win32', vendor: 'Google Inc.' },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, isExtended: false },
    view: { innerWidth: 412, innerHeight: 829, outerWidth: 412, outerHeight: 915, devicePixelRatio: 2.625 },
    hints: {
      'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="24"',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-mobile': '?1'
    },
    touch: 5
  }
};

async function build(name, spec) {
  const over = {};
  const env = fakeEnv(over);
  env.navigator.userAgent = spec.ua;
  Object.assign(env.navigator, spec.nav);
  env.screen = spec.screen;
  Object.assign(env, spec.view);
  delete env.Buffer;           // 真浏览器没有 node Buffer，不留在夹具里
  const test = loadCollector(env);
  const ctx = collectorCtx({
    hints: { h: spec.hints },
    trace: Object.assign({}, collectorCtx().trace),
    // 夹具不发网络请求：DNS 保持未执行，和真实"短访问"一致
    text: () => Promise.resolve(null),
    json: () => Promise.resolve(null)
  });
  const envelope = await test.buildEnvelope(undefined, ctx);
  const clean = JSON.parse(JSON.stringify(envelope));
  // 脱敏：抹掉本机可识别量，保留形状与状态
  clean.id = '<uuid>';
  clean.session = '<session>';
  clean.ts = '2026-11-13T00:00:00.000Z';
  if (clean.cli) {
    if (clean.cli.fpid) clean.cli.fpid = 'sha256:<redacted>';
    if (clean.cli.hwid) clean.cli.hwid = 'sha256:<redacted>';
    if (clean.cli.canvas) clean.cli.canvas = { h: 'sha256:<redacted>', len: clean.cli.canvas.len };
    ['fontfp', 'domrect', 'svgrect', 'textm', 'glimg', 'mathfp'].forEach(k => {
      if (typeof clean.cli[k] === 'string') clean.cli[k] = 'sha256:<redacted>';
    });
    if (clean.cli.audio && typeof clean.cli.audio === 'object') {
      clean.cli.audio = Object.assign({}, clean.cli.audio, { sum: '<redacted>' });
    }
    if (clean.cli.voices) clean.cli.voices = ['<voice>'];
  }
  const file = path.join(OUT, name + '.json');
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return { name, ids: Object.keys(clean.cli || {}).length, bytes: fs.statSync(file).size };
}

(async () => {
  const results = [];
  for (const name of Object.keys(BASE)) {
    results.push(await build(name, BASE[name]));
  }
  results.forEach(r => console.log(`${r.name}: ${r.ids} 个 cli 字段, ${r.bytes} 字节`));
})().catch(err => { console.error('生成失败：', err && err.message); process.exit(1); });
