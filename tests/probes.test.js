'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

test('screen / win / cpu / scrollbar 取真实值', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.screen), { w: 1920, h: 1080, aw: 1920, ah: 1040, dpr: 1.25, depth: 24 });
  assert.deepStrictEqual(plain(e.cli.win), { iw: 1920, ih: 1040, ow: 1920, oh: 1080 });
  assert.strictEqual(e.cli.cpu, 8);
  assert.strictEqual(e.cli.mem, 8);
  assert.strictEqual(e.cli.scrollbar, 15);
  assert.strictEqual(plain(e.cli.touch).points, 0);
});

test('tz / langs / locale 来自 Intl 与 navigator', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.match(e.cli.tz, /^[A-Za-z]+\/[A-Za-z_+-]+$|^UTC$/);
  assert.deepStrictEqual(plain(e.cli.langs), ['zh-CN', 'zh']);
  assert.strictEqual(typeof e.cli.locale, 'string');
  // hour 承诺的是 hourCycle（12/24 小时制），不再是「当前几点」
  assert.strictEqual(typeof e.cli.hour, 'object');
  assert.ok(['h11', 'h12', 'h23', 'h24'].indexOf(e.cli.hour.cycle) >= 0 || e.cli.hour.cycle === null);
  assert.strictEqual(typeof e.cli.fmt, 'string');
});

test('没跑过的项标 not_run（不是 denied），且不主动请求授权', async () => {
  const env = fakeEnv();
  let asked = false;
  env.navigator.geolocation = { getCurrentPosition() { asked = true; } };
  env.navigator.getGamepads = () => [];
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  // 从未请求过权限的项是「没跑」，写 denied 会把「未运行」和「用户拒绝」混为一谈
  assert.deepStrictEqual(plain(e.cli.geoloc), { $: 'not_run' });
  assert.deepStrictEqual(plain(e.cli.sensors), { $: 'not_run' });
  assert.deepStrictEqual(plain(e.cli.trackers), { $: 'not_run' });
  assert.deepStrictEqual(plain(e.cli.extwar), { $: 'not_run' });
  // gamepad 有 API 就能数出已连接个数，不需要权限
  assert.deepStrictEqual(plain(e.cli.gamepad), { connected: 0 });
  assert.strictEqual(asked, false, '不应触发 geolocation 授权');
});

test('UA 派生项：os / browser / form / arch / engine', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.match(e.cli.os, /Windows/);
  assert.match(e.cli.browser, /Chrome 141/);
  assert.strictEqual(e.cli.form, 'Desktop');
  assert.strictEqual(e.cli.arch, 'x86/64');
  assert.strictEqual(e.cli.engine, 'blink');
  assert.match(String(e.cli.engver), /^141(\.|$)/);
});

test('复合项形状符合契约（决定后台能不能出分布图）', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(Object.keys(e.cli.keys).sort(), ['css', 'html', 'window']);
  assert.deepStrictEqual(Object.keys(e.cli.timer).sort(), ['jitter', 'now', 'res']);
  assert.deepStrictEqual(Object.keys(e.cli.shield).sort(), ['brave', 'noise']);
  assert.deepStrictEqual(Object.keys(e.cli.rand), ['same']);
  assert.deepStrictEqual(Object.keys(e.cli.gamut).sort(), ['dynamic', 'gamut']);
  assert.deepStrictEqual(Object.keys(e.cli.a11y).sort(), ['contrast', 'forced']);
  assert.deepStrictEqual(Object.keys(e.cli.dnt).sort(), ['dnt', 'gpc']);
  // skew 现在拆成秒与小时两份，外加系统 offset（分钟）
  assert.deepStrictEqual(Object.keys(e.cli.clock).sort(), ['off', 'offset_min', 'skew_h', 'skew_s']);
  assert.deepStrictEqual(Object.keys(e.cli.idstr).sort(), ['plugins', 'productSub', 'vendor']);
  assert.ok(Array.isArray(e.cli.lies));
  assert.ok(Array.isArray(e.cli.auto));
  assert.ok(Array.isArray(e.cli.ext));
  assert.strictEqual(typeof e.cli.fpid, 'string');
  assert.match(e.cli.fpid, /^(sha256:[0-9a-f]+|fnv:[0-9a-f]+)$/);
  assert.strictEqual(typeof e.cli.hwid, 'string');
  assert.strictEqual(typeof e.cli.pdf, 'boolean');
});

test('adblock 用诱饵元素判断', async () => {
  const blocked = await loadCollector(fakeEnv({ baitHidden: true })).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(blocked.cli.adblock, true);
  const open = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(open.cli.adblock, false);
});

test('时钟偏移量用 trace 的服务器时间算', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.ok(Math.abs(e.cli.clock.skew_h) < 0.1, '本地与服务器时间差应接近 0，实际 ' + e.cli.clock.skew_h);
});

test('stack 测的是 IPv4/IPv6 双栈，不是 HTTP/TLS', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({
    json: (url) => Promise.resolve(String(url).indexOf('api4.') >= 0 ? { ip: '1.2.3.4' } : { $: 'unreadable' })
  });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.stack), { v4: { ok: true, ip: '1.2.3.4' }, v6: { ok: false, state: 'unreadable' }, dual: false });
});

test('screens 不再把「扩展屏幕」硬说成 2 块', async () => {
  const env = fakeEnv();
  env.screen.isExtended = true;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.screens), { n: null, ext: true, basis: 'isExtended' });
});

test('网络读不到标 unreadable，不是 unsupported', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({ text: () => Promise.resolve(null), json: () => Promise.resolve(null) });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.ex_cf), { $: 'unreadable' });
  assert.deepStrictEqual(plain(e.cli.dns), { $: 'unreadable' });
});

test('wasm and chargingTime are collected', async () => {
  const env = fakeEnv();
  env.WebAssembly = { validate: () => true };
  env.navigator.getBattery = () => Promise.resolve({
    level: 0.61, charging: false, chargingTime: 5400
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.wasm), { supported: true });
  assert.strictEqual(e.cli.battery.chargingTime, 5400);
});

test('wasm 没有 API 时仍是 {supported:false}，不是缺失标记', async () => {
  const env = fakeEnv();
  env.WebAssembly = undefined;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.wasm), { supported: false });
});

test('chargingTime 只接受有限非负数，其余一律 null 且属性保留', async () => {
  for (const raw of [Infinity, -Infinity, NaN, -1, undefined, null, 'abc']) {
    const env = fakeEnv();
    env.navigator.getBattery = () => Promise.resolve({ level: 0.5, charging: true, chargingTime: raw });
    const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
    assert.deepStrictEqual(Object.keys(e.cli.battery).sort(), ['charging', 'chargingTime', 'level']);
    assert.strictEqual(e.cli.battery.chargingTime, null, 'chargingTime=' + String(raw));
  }
  for (const raw of [0, 5400, 1.5]) {
    const env = fakeEnv();
    env.navigator.getBattery = () => Promise.resolve({ level: 0.5, charging: true, chargingTime: raw });
    const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
    assert.strictEqual(e.cli.battery.chargingTime, raw);
  }
});

test('probe is skipped when PROBE_URL is empty', async () => {
  const ctx = collectorCtx({ probeUrl: '' });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.strictEqual(e.cli.tcpfp, undefined);
  assert.strictEqual(collectorCtx().probeUrl, '');
});

test('生产常量 PROBE_URL 保持空字符串', () => {
  const RC = loadCollector(fakeEnv());
  assert.strictEqual(RC.PROBE_URL, '');
});

test('probe maps /fp fields when configured', async () => {
  let fpCalls = 0;
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: (url) => {
      if (String(url).endsWith('/fp')) fpCalls++;
      return Promise.resolve(String(url).endsWith('/fp')
        ? { tcp: { os: 'windows', mtu: 1500 }, tls: { ja4: 't13d...' }, http2: { fp: 'm,a,s,p' } }
        : { family: 4 });
    }
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.strictEqual(e.cli.tcpfp.os, 'windows');
  assert.strictEqual(e.cli.ja4, 't13d...');
  assert.strictEqual(e.cli.h2fp.fp, 'm,a,s,p');
  assert.strictEqual(fpCalls, 1, '5 个探针项共用一次 /fp 请求');
});

test('tlsfp 回落 ja3，quicfp 只在 HTTP/3 时出现', async () => {
  const h2 = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.resolve({ tls: { ja3n: 'ja3n-x', ja4: 'ja4-x' }, proto: 'h2' })
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, h2);
  assert.strictEqual(e.cli.tlsfp, 'ja3n-x');
  assert.strictEqual(e.cli.quicfp, undefined);

  const h3 = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.resolve({ tls: { ja3: 'ja3-y', ja4: 'ja4-y' }, proto: 'h3' })
  });
  const e3 = await loadCollector(fakeEnv()).buildEnvelope(undefined, h3);
  assert.strictEqual(e3.cli.tlsfp, 'ja3-y');
  assert.strictEqual(e3.cli.quicfp, 'ja4-y');
});

test('探针失败标 unreachable，不抛错也不阻塞信封', async () => {
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.reject(new Error('offline'))
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'unreachable' });
  assert.deepStrictEqual(plain(e.cli.quicfp), { $: 'unreachable' });
  assert.strictEqual(typeof e.meta.collector, 'string');
});

test('探针字段照常参与预算，不会撑破 48 KiB', async () => {
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.resolve({
      tcp: { os: 'windows', mtu: 1500 },
      tls: { ja4: 't13d...', ja3n: 'ja3n...' },
      http2: { fp: 'm,a,s,p' },
      proto: 'h3'
    })
  });
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.strictEqual(e.cli.tcpfp.os, 'windows');
  e.cli.fonts = Array.from({ length: 900 }, (_, i) => 'Font' + i + 'x'.repeat(40));
  e.cli.voices = Array.from({ length: 900 }, (_, i) => 'Voice' + i + 'y'.repeat(40));
  const out = RC.applyBudget(e, 48 * 1024);
  const bytes = Buffer.byteLength(JSON.stringify(out.envelope), 'utf8');
  assert.ok(bytes <= 48 * 1024, 'bytes=' + bytes);
  assert.strictEqual(out.envelope.cli.tcpfp.os, 'windows');
});
