'use strict';
// 用 CDP 的传感器注入在真浏览器里验证 sensors 被动采样：
// 注入 accelerometer／gyroscope → devicemotion 是否真的触发 → 采集器是否读成
// {alg:'devicemotion-passive', n, hz, noise, rot}。（读数是合成的，链路是真的。）
//   node tests/sensor-cdp.js            默认 headless
//   HEADFUL=1 node tests/sensor-cdp.js  开窗口跑（headless 有时不投递传感器事件）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const URL_UNDER_TEST = process.env.URL_UNDER_TEST || 'https://blog.072120.xyz/';
const HEADFUL = process.env.HEADFUL === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radish-sensor-'));
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu'];
  if (HEADFUL) args.push('--window-position=-32000,-32000', '--window-size=1200,900');
  else args.push('--headless=new');
  args.push('about:blank');

  const chrome = spawn(CHROME, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome 没起来');
  console.log('Chrome ' + version.Browser);

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  // 注入必须在导航之前打开，否则页面起来时传感器还是关的
  for (const type of ['accelerometer', 'gyroscope']) {
    await send('Emulation.setSensorOverrideEnabled', { enabled: true, type });
  }
  await send('Page.navigate', { url: URL_UNDER_TEST });
  for (let i = 0; i < 80; i++) {
    const st = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (st.result.value === 'complete') break;
    await sleep(250);
  }
  await sleep(500);

  const has = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({collector: !!window.__radish, dme: typeof DeviceMotionEvent, v: (window.__radish||{}).VERSION})',
    returnByValue: true
  });
  console.log('页面状态：' + has.result.value);

  await send('Runtime.evaluate', {
    expression: "window.__dmCount = 0; window.addEventListener('devicemotion', function(){ window.__dmCount++; }, {passive:true}); 'ok'",
    returnByValue: true
  });

  const feed = (async () => {
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 2500) {
      const t = 1e9 + i * 16e6;
      await send('Emulation.setSensorOverrideReadings', {
        type: 'accelerometer',
        reading: { xyz: { x: 0.02 * (i % 20), y: 9.81, z: 0.05 * (i % 20) }, timestamp: t }
      });
      await send('Emulation.setSensorOverrideReadings', {
        type: 'gyroscope',
        reading: { xyz: { x: 0.01 * (i % 20), y: 0.02 * (i % 20), z: 0.03 * (i % 20) }, timestamp: t }
      });
      i++;
      await sleep(16);
    }
    return i;
  })();

  const built = await send('Runtime.evaluate', {
    expression: `(async () => {
      const e = await window.__radish.buildEnvelope();
      return JSON.stringify({ sensors: e.cli.sensors, ver: window.__radish.VERSION, keys: Object.keys(e.cli).length });
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const fed = await feed;
  const raw = await send('Runtime.evaluate', { expression: 'String(window.__dmCount)', returnByValue: true });
  console.log('注入读数次数：' + fed + '；页面收到的 devicemotion 事件数：' + raw.result.value);
  console.log('采集结果：' + built.result.value);

  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
}

main().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
