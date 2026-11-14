'use strict';
// 探针类读数。
// 由 4 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== beacon.test.js =====
{
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx } = require('./harness');

function bodyOf(env, i) {
  const b = env.__sent[i || 0].blob;
  return b.text ? b.text() : Promise.resolve(String(b));
}

test('每会话只发一次：第二次 run 直接返回 already', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  assert.strictEqual(await RC.run(env, { endpoint: 'https://x/v1/collect' }), 'sent');
  assert.strictEqual(await RC.run(env, { endpoint: 'https://x/v1/collect' }), 'already');
  assert.strictEqual(env.__sent.length, 1);
  assert.strictEqual(env.__sent[0].url, 'https://x/v1/collect');
});

test('sessionStorage 抛错时退化为内存标记，仍然只发一次', async () => {
  const env = fakeEnv({ sessionStorageThrows: true });
  const RC = loadCollector(env);
  assert.strictEqual(await RC.run(env, { endpoint: 'https://x/v1/collect' }), 'sent');
  assert.strictEqual(await RC.run(env, { endpoint: 'https://x/v1/collect' }), 'already');
  assert.strictEqual(env.__sent.length, 1);
});

test('body 是合法 JSON，7 个顶层键，字节数 ≤ 48 KiB', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  await RC.run(env, { endpoint: 'https://x/v1/collect' });
  const raw = await bodyOf(env);
  const body = JSON.parse(raw);
  assert.deepStrictEqual(Object.keys(body).sort(), ['cli', 'id', 'meta', 'page', 'session', 'ts', 'v']);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 48 * 1024, 'bytes=' + Buffer.byteLength(raw, 'utf8'));
  assert.strictEqual(body.page.path, '/post/x.html');
});

test('DNT 开启时发出的 body 里 cli 为空', async () => {
  const env = fakeEnv({ dnt: '1' });
  const RC = loadCollector(env);
  await RC.run(env, { endpoint: 'https://x/v1/collect' });
  const body = JSON.parse(await bodyOf(env));
  assert.deepStrictEqual(body.cli, {});
  assert.strictEqual(body.meta.privacy.optout, true);
});

test('pagehide 早于 idle 时仍然立刻发出去（不等 4 秒兜底）', async () => {
  const env = fakeEnv({ idleNeverFires: true });
  const listeners = [];
  env.addEventListener = (name, fn) => { if (name === 'pagehide') listeners.push(fn); };
  const RC = loadCollector(env);
  const t0 = Date.now();
  const p = RC.run(env, { endpoint: 'https://x/v1/collect' });
  await new Promise(r => setTimeout(r, 20));
  listeners.forEach(fn => fn());
  assert.strictEqual(await p, 'sent');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, 'pagehide 后应立即发送，实际耗时 ' + ms + 'ms');
  // 半份先走（离页排队长态），探针跑完再补一份完整的：后端按 id 归并成一条记录，
  // PV 只计一次、缺项被补齐（B-07）。旧实现用 markSent 把整次访问关掉，完整信封
  // 永远发不出去，DNS 这类慢项因此从来没进过库。
  assert.strictEqual(env.__sent.length, 2, '实际发了 ' + env.__sent.length + ' 封');
});

test('pagehide 半份与随后完整信封共用同一个 id 与会话', async () => {
  const env = fakeEnv({ idleNeverFires: true });
  const listeners = [];
  env.addEventListener = (name, fn) => { if (name === 'pagehide') listeners.push(fn); };
  const bodies = [];
  env.navigator.sendBeacon = (url, blob) => {
    if (blob && typeof blob.text === 'function') blob.text().then((t) => bodies.push(JSON.parse(t)));
    return true;
  };
  const RC = loadCollector(env);
  const p = RC.run(env, { endpoint: 'https://x/v1/collect' });
  await new Promise(r => setTimeout(r, 20));
  listeners.forEach(fn => fn());
  await p;
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(bodies.length, 2, '两封都要记下来');
  assert.strictEqual(bodies[0].id, bodies[1].id, '同一次访问必须同一个 id');
  assert.strictEqual(bodies[0].session, bodies[1].session, '会话也要一致');
  assert.strictEqual(bodies[0].meta.partial, true, '第一封是半份');
  assert.strictEqual(bodies[1].meta.partial, false, '第二封必须是完整信封');
});

test('sendBeacon 返回 false 时退回 fetch', async () => {
  const env = fakeEnv();
  env.navigator.sendBeacon = () => false;
  let fetched = null;
  env.fetch = (url, init) => { fetched = { url, init }; return Promise.resolve({ ok: true, status: 204 }); };
  const RC = loadCollector(env);
  assert.strictEqual(await RC.run(env, { endpoint: 'https://x/v1/collect' }), 'sent');
  assert.ok(fetched, '应退回 fetch');
  assert.strictEqual(fetched.init.method, 'POST');
  assert.strictEqual(fetched.init.body.slice(0, 1), '{');
});

test('G05：并发两次 run 只产生一次发送、一个 id', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  const r = await Promise.all([RC.run(env, { endpoint: 'http://x/c' }), RC.run(env, { endpoint: 'http://x/c' })]);
  assert.strictEqual(env.__sent.length, 1, '实际发送 ' + env.__sent.length + ' 次');
  const bodies = [JSON.parse(await env.__sent[0].blob.text())];
  assert.strictEqual(new Set(bodies.map(b => b.id)).size, 1);
  assert.deepStrictEqual(r, ['sent', 'sent']);
});

test('G04：发送失败后可以重试，成功后仍只留一条', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  let online = false;
  env.navigator.sendBeacon = (url, blob) => { if (!online) return false; env.__sent.push({ url, blob }); return true; };
  const a = await RC.run(env, { endpoint: 'http://x/c' });
  assert.strictEqual(a, 'failed');
  online = true;
  const b = await RC.run(env, { endpoint: 'http://x/c' });
  assert.strictEqual(b, 'sent');
  assert.strictEqual(env.__sent.length, 1);
  const c = await RC.run(env, { endpoint: 'http://x/c' });
  assert.strictEqual(c, 'already');
});

test('G03：pagehide 时在处理函数内就排队，不等探针', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  const listeners = {};
  env.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
  env.fetch = () => new Promise(() => { });          // 模拟永不返回的探针网络
  const p = RC.run(env, { endpoint: 'http://x/c', trace: 'http://t/t', hints: 'http://h/h' });
  await new Promise(r => setTimeout(r, 50));
  (listeners.pagehide || []).forEach(f => f());
  assert.strictEqual(env.__sent.length, 1, 'pagehide 处理函数返回前就应该入队');
  const body = JSON.parse(await env.__sent[0].blob.text());
  assert.strictEqual(body.meta.partial, true);
  await Promise.race([p, new Promise(r => setTimeout(r, 2000))]);
  assert.strictEqual(env.__sent.length, 1, '后续完成路径不能重复发送');
});

test('G15：DNT/GPC 下只发那一条上报，不做任何诊断请求', async () => {
  for (const over of [{ dnt: '1' }, { gpc: true }]) {
    const env = fakeEnv(over);
    const RC = loadCollector(env);
    const seen = [];
    const bodies = [];
    env.fetch = (u, init) => {
      seen.push(String(u));
      if (init && init.method === 'POST') bodies.push(String(init.body));
      return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
    };
    assert.strictEqual(await RC.run(env, { endpoint: 'http://x/c', trace: 'http://t/t', hints: 'http://h/h' }), 'sent');
    assert.deepStrictEqual(seen, ['http://x/c'], '只应有那一条上报');
    assert.strictEqual(bodies.length, 1);
    assert.deepStrictEqual(JSON.parse(bodies[0]).cli, {});
  }
});

test('BLOG-11：只有读到 204 才算送达；非 2xx 一律算失败并可重试', async () => {
  for (const pair of [[204, 'sent'], [429, 'failed'], [500, 'failed']]) {
    const status = pair[0], expect = pair[1];
    const env = fakeEnv();
    const RC = loadCollector(env);
    let calls = 0;
    env.fetch = (u, init) => {
      if (init && init.method === 'POST') calls++;      // 只数上报，不数诊断请求
      return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
    };
    assert.strictEqual(await RC.run(env, { endpoint: 'http://x/c' }), expect, 'status ' + status);
    assert.strictEqual(calls, 1);
  }
});

test('BLOG-10.3：超预算的体一律不发', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  const bodies = [];
  env.fetch = (u, init) => { bodies.push(String(init.body)); return Promise.resolve({ ok: true, status: 204 }); };
  const huge = [];
  for (let i = 0; i < 60; i++) huge.push({ name: 'V' + i + '-' + 'x'.repeat(30000), lang: 'en', default: i === 0, localService: true, voiceURI: 'v' + i });
  env.speechSynthesis = { getVoices: () => huge, addEventListener() { }, removeEventListener() { } };
  await RC.run(env, { endpoint: 'http://x/c', limit: 2000 });
  for (const b of bodies) {
    assert.ok(Buffer.byteLength(b, 'utf8') <= 2000, '发出去了超预算的体 ' + Buffer.byteLength(b, 'utf8'));
  }
});

test('G17：traces 只读自己写的标记，不统计别人的键', async () => {
  const env = fakeEnv();
  env.sessionStorage.setItem('radish.sid', 'abc');
  env.sessionStorage.setItem('radish.sent', '1');
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const first = e.cli.traces;
  assert.match(String(first.alg), /^storage-tag/);
  assert.strictEqual(first.first, true, '别人的键不该被当成"我们上一轮的标记"');
  // 站点自己的键再多，也不改变读数：我们只认 __radish_trace
  env.sessionStorage.setItem('visitor.thing', '1');
  env.sessionStorage.setItem('a', '1');
  env.sessionStorage.setItem('b', '1');
  const e2 = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const second = e2.cli.traces;
  assert.strictEqual(second.first, false, '这一次才轮到我们自己写的标记');
  assert.ok(second.kept.indexOf('sessionStorage') >= 0, 'sessionStorage 应该留住了标记，实际 ' + JSON.stringify(second.kept));
});

test('自动启动：RC.run() 不传 env 也必须真的发出去（1.1.0 的致命回归）', async () => {
  const env = fakeEnv();
  delete env.__radishManual;               // 打开自动启动
  env.document.readyState = 'complete';    // 模拟 defer 脚本执行时的状态
  loadCollector(env);
  for (let i = 0; i < 60 && env.__sent.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(env.__sent.length, 1, '自动启动没有发送任何记录');
  const body = JSON.parse(await env.__sent[0].blob.text());
  assert.ok(body.id, 'id 不能为空');
  assert.ok(Object.keys(body.cli).length > 20, 'cli 不该是空的');
});

test('自动启动：run() 传 undefined 也不能抛（alreadySent 的兜底）', async () => {
  const env = fakeEnv();
  delete env.__radishManual;
  env.document.readyState = 'complete';
  const RC = loadCollector(env);
  await new Promise(r => setTimeout(r, 50));
  // 传 undefined 时既不能抛，也不能发出第二条（复用同一次运行）
  const again = await RC.run(undefined, { endpoint: 'http://x/c' });
  assert.ok(['sent', 'already'].indexOf(again) >= 0, '实际 ' + again);
  for (let i = 0; i < 60 && env.__sent.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(env.__sent.length, 1, '不该有第二条记录');
});
}

// ===== dns.test.js =====
{
'use strict';
// 2026-11-13 审查执行文档（02-博客开发执行文档）的回归测试：
//   B1–B3 DNS 期限与结构 · B4 首批正确性 · B5 共享采样
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const GL_CANVAS = {
  measureText: (s) => ({ width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  fillRect() { }, fillText() { }, createLinearGradient: () => ({ addColorStop() { } }),
  beginPath() { }, arc() { }, fill() { },
  getExtension: () => null,
  getParameter: (p) => 'param-' + p,
  getSupportedExtensions: () => ['EXT_a', 'EXT_b']
};

/** 记账用的环境：数一数 canvas 上下文和 measureText 被建了几次（B5 的度量） */
function countingEnv(over) {
  const env = fakeEnv(over);
  const counts = { glContexts: 0, measure: 0 };
  env.document.createElement = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    className: '',
    offsetWidth: 100, clientWidth: 85, offsetHeight: 250, clientHeight: 250,
    setAttribute(k, v) { this[k] = v; },
    appendChild() { }, removeChild() { },
    getContext(kind) {
      if (/webgl/i.test(String(kind))) counts.glContexts++;
      return {
        ...GL_CANVAS,
        measureText: () => { counts.measure++; return { width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; }
      };
    },
    getBoundingClientRect: () => ({ width: 137.5, height: 43.25, x: 1.5, top: 2.5 }),
    getClientRects: () => [{}, {}],
    toDataURL: () => 'data:image/png;base64,AAA'
  });
  return { env, counts };
}

function highEntropyEnv(over) {
  const calls = [];
  const env = fakeEnv(over);
  env.navigator.userAgentData = {
    platform: (over && over.platform) || 'Windows',
    mobile: false,
    brands: [
      { brand: 'Not_A Brand', version: '24' },
      { brand: 'Chromium', version: '141.0.7390.122' },
      { brand: 'Google Chrome', version: '141.0.7390.122' }
    ],
    getHighEntropyValues(keys) {
      calls.push(keys.slice ? keys.slice() : keys);
      return Promise.resolve({
        architecture: 'x86', bitness: '64', model: '',
        platformVersion: '19.0.0',
        fullVersionList: [
          { brand: 'Chromium', version: '141.0.7390.122' },
          { brand: 'Google Chrome', version: '141.0.7390.122' },
          { brand: 'Not_A Brand', version: '24.0.0.0' }
        ]
      });
    }
  };
  return { env, calls };
}

// ---------------------------- B1–B3 DNS ----------------------------

test('B1：三层期限的关系是 单项 2.5s < 慢项 10s < 整轮 12s', () => {
  const RC = loadCollector(fakeEnv());
  assert.strictEqual(RC.PROBE_TIMEOUT, 2500);
  assert.strictEqual(RC.SLOW_TIMEOUT, 10000);
  assert.strictEqual(RC.DEADLINE, 12000);
  assert.strictEqual(RC.SLOW_IDS.dns, 1);
  assert.ok(RC.SLOW_TIMEOUT < RC.DEADLINE, 'DNS 的额度必须小于整轮死线，否则外层先掐');
  assert.ok(RC.PROBE_TIMEOUT < RC.SLOW_TIMEOUT);
});

test('B1：DNS 比普通探针慢也照样拿到读数（超过旧的 2.5 秒上限）', async () => {
  const RC = loadCollector(fakeEnv());
  const seen = [];
  const ctx = collectorCtx({
    json: (url) => {
      if (String(url).indexOf('edns.ip-api.com') >= 0) seen.push(String(url));
      return new Promise((resolve) => setTimeout(() => resolve({
        dns: { ip: '219.144.80.146', geo: 'China - CHINANET SHAANXI province Cloud Base network' }
      }), 3200));
    }
  });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.strictEqual(seen.length, 1, 'DNS 请求次数：' + seen.length);
  assert.strictEqual(plain(e.cli.dns).resolver_ip, '219.144.80.146', '慢响应也必须留在信封里');
  assert.ok(!e.meta.stuck.includes('dns'), '不该把慢但成功的 DNS 记成超时');
});

test('B2：DNS 用查询串 nonce 绕过缓存（随机子域形式实测 404）', async () => {
  const RC = loadCollector(fakeEnv());
  const seen = [];
  const ctx = collectorCtx({
    json: (url) => {
      if (String(url).indexOf('edns.ip-api.com') >= 0) seen.push(String(url));
      return Promise.resolve({ dns: { ip: '1.2.3.4', geo: 'Japan - Example' } });
    }
  });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.strictEqual(seen.length, 1, 'DNS 只该请求一次');
  assert.match(seen[0], /^https:\/\/edns\.ip-api\.com\/json\?nonce=[0-9a-z]+$/, '实际 URL：' + seen[0]);
  assert.strictEqual(plain(e.cli.dns).method, 'edns-ip-api-query-nonce');
});

test('B2：DNS 结构是规范形状，国家名与组织分开，family 保留', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({
    json: () => Promise.resolve({ dns: { ip: '2001:470:1f0b::2', geo: 'United States - Psychz Networks' } })
  });
  const e = await RC.buildEnvelope(undefined, ctx);
  const dns = plain(e.cli.dns);
  assert.deepStrictEqual(Object.keys(dns).sort(),
    ['at', 'country', 'country_raw', 'country_state', 'ecs', 'family', 'fields', 'geo', 'inner_ms',
      'method', 'method_version', 'ms', 'organization', 'outer_ms', 'resolver_ip', 'scope', 'waited_ms']);
  // 方法可复核：这个服务只给 dns.ip 与 dns.geo，没有 ECS，也不能当成"访客的解析路径"
  assert.strictEqual(dns.method, 'edns-ip-api-query-nonce');
  assert.strictEqual(dns.method_version, 'edns-ip-api/2');
  assert.deepStrictEqual(dns.fields, ['dns.ip', 'dns.geo']);
  assert.deepStrictEqual(dns.ecs, { $: 'unreadable' });
  assert.strictEqual(dns.scope, 'service-reported');
  assert.strictEqual(typeof dns.waited_ms, 'number');
  assert.ok(dns.outer_ms > dns.inner_ms, '整轮额度必须大于单项');
  assert.strictEqual(dns.resolver_ip, '2001:470:1f0b::2');
  assert.strictEqual(dns.family, 6);
  // B2：country 是校验过的地区代码，原始名字进 country_raw，换取可复核
  assert.strictEqual(dns.country, 'US');
  assert.strictEqual(dns.country_raw, 'United States');
  assert.strictEqual(dns.country_state, null);
  assert.strictEqual(dns.organization, 'Psychz Networks');
  assert.strictEqual(dns.geo, 'United States - Psychz Networks');
  assert.match(dns.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(typeof dns.ms, 'number');
});

test('B2：状态标记优先读，不会被解析成空对象或空成功', async () => {
  const RC = loadCollector(fakeEnv());
  for (const marker of ['timeout', 'unreadable', 'unsupported']) {
    const ctx = collectorCtx({ json: () => Promise.resolve({ $: marker }) });
    const e = await RC.buildEnvelope(undefined, ctx);
    assert.deepStrictEqual(plain(e.cli.dns), { $: marker }, marker + ' 必须原样保留');
  }
});

test('B2：DNS 返回里没有 dns 字段或没有 ip/geo 时是 unreadable，不是空成功', async () => {
  const RC = loadCollector(fakeEnv());
  for (const payload of [{}, { dns: {} }, { dns: { ip: null, geo: null } }]) {
    const ctx = collectorCtx({ json: () => Promise.resolve(payload) });
    const e = await RC.buildEnvelope(undefined, ctx);
    assert.deepStrictEqual(plain(e.cli.dns), { $: 'unreadable' }, JSON.stringify(payload));
  }
});

// ---------------------------- B4 出口与识别 ----------------------------

test('B4：trace 没有 ip 的拦截页不算出口观测', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({ text: () => Promise.resolve('fl=abc\nh=www.cloudflare.com\nts=1\n') });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.ex_gpt), { $: 'unreadable' });
  assert.deepStrictEqual(plain(e.cli.ex_cf), { $: 'unreadable' });
});

test('B4：出口探针的失败标记直通，不会被解析成全 null 对象', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({ json: () => Promise.resolve({ $: 'unreadable' }), text: () => Promise.resolve(null) });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.ex_intl), { $: 'unreadable' });
  assert.deepStrictEqual(plain(e.cli.ex_cn), { $: 'unreadable' });
});

test('B4：ex_intl / ex_cn 读到 JSON 但没有 IP 时是 unreadable', async () => {
  const RC = loadCollector(fakeEnv());
  const intl = await RC.buildEnvelope(undefined, collectorCtx({ json: () => Promise.resolve({ country_code: 'US' }) }));
  assert.deepStrictEqual(plain(intl.cli.ex_intl), { $: 'unreadable' });
  const cn = await RC.buildEnvelope(undefined, collectorCtx({
    text: () => Promise.resolve(JSON.stringify({ ret: 'ok', data: {} }))
  }));
  assert.deepStrictEqual(plain(cn.cli.ex_cn), { $: 'unreadable' });
});

test('B4：安卓 Edge 不再被说成 Chrome，品牌优先于 UA 顺序', async () => {
  const android = fakeEnv();
  android.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0';
  const e1 = await loadCollector(android).buildEnvelope(undefined, collectorCtx());
  assert.match(e1.cli.browser, /^Edge 141/, '实际 ' + e1.cli.browser);

  const ios = fakeEnv();
  ios.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/141.0 Mobile/15E148 Safari/604.1';
  const e2 = await loadCollector(ios).buildEnvelope(undefined, collectorCtx());
  assert.match(e2.cli.browser, /^Edge 141/, '实际 ' + e2.cli.browser);

  // UA 自称 Chrome、Client Hints 品牌说 Edge → 以品牌为准
  const { env } = highEntropyEnv();
  env.navigator.brands = [{ brand: 'Microsoft Edge', version: '141.0.0.0' }];
  env.navigator.userAgentData.brands = [
    { brand: 'Not_A Brand', version: '24' },
    { brand: 'Chromium', version: '141.0.0.0' },
    { brand: 'Microsoft Edge', version: '141.0.0.0' }
  ];
  const e3 = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.match(e3.cli.browser, /^Edge 141/, '实际 ' + e3.cli.browser);
});

test('B4：空插件列表不再是自动化证据，只有和内置 PDF 声明矛盾才提示', async () => {
  const androidEmpty = fakeEnv();
  androidEmpty.navigator.plugins = [];
  androidEmpty.navigator.pdfViewerEnabled = false;
  androidEmpty.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  // 替身环境为了算 UTF-8 字节数塞了 Node 的 Buffer；真安卓 Chrome 的 window 上没有它，
  // 别让替身自己的工具痕迹被 auto 记成 node-buffer 证据。
  delete androidEmpty.Buffer;
  const e1 = await loadCollector(androidEmpty).buildEnvelope(undefined, collectorCtx());
  // G 127（J 项）：auto 的命中清单在 signals 里（不再是裸数组）
  assert.ok(!plain(e1.cli.auto).signals.some((x) => /plugins/.test(x)), '安卓正常浏览器不能报 plugins：' + JSON.stringify(e1.cli.auto));
  assert.deepStrictEqual(plain(e1.cli.auto).combos, [], '零插件 + 无其他弱信号时不该凑出组合：' + JSON.stringify(e1.cli.auto));
  assert.strictEqual(plain(e1.cli.auto).level, 'none');
  assert.ok(!plain(e1.cli.lies).list.some((x) => /plugins/.test(x)), '安卓正常浏览器不能报 plugins：' + JSON.stringify(e1.cli.lies));

  const contradiction = fakeEnv();          // 自带 pdfViewerEnabled: true 且 plugins 为空
  const e2 = await loadCollector(contradiction).buildEnvelope(undefined, collectorCtx());
  assert.ok(plain(e2.cli.auto).signals.includes('plugins-empty-pdf-conflict'), JSON.stringify(e2.cli.auto));
  assert.ok(plain(e2.cli.lies).list.includes('plugins-empty-pdf-conflict'), JSON.stringify(e2.cli.lies));
});

test('B4：键盘布局读不到就报 unreadable，不再拼出 "undefined|undefined"', async () => {
  const missing = fakeEnv();
  missing.navigator.keyboard = { getLayoutMap: () => Promise.resolve(new Map()) };
  const e1 = await loadCollector(missing).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e1.cli.kbd), { $: 'unreadable' });

  const half = fakeEnv();
  half.navigator.keyboard = { getLayoutMap: () => Promise.resolve(new Map([['KeyY', 'z'], ['KeyQ', 'a']])) };
  const e2 = await loadCollector(half).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(e2.cli.kbd, 'z|a');
});

test('B4：系统版本用高熵 platformVersion，UA 冻结的 10 不再冒充真实版本', async () => {
  const { env } = highEntropyEnv({ platform: 'Windows' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(e.cli.os, 'Windows 11', 'platformVersion 19.x 是 Windows 11');

  const android = highEntropyEnv({ platform: 'Android' });
  android.env.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  android.env.navigator.userAgentData.getHighEntropyValues = () => Promise.resolve({ platformVersion: '14.0.0', architecture: 'arm', bitness: '64' });
  const e2 = await loadCollector(android.env).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(e2.cli.os, 'Android 14', '安卓 UA 被冻结成 10，必须用高熵版本');
});

// ---------------------------- B5 共享采样 ----------------------------

test('B5：高熵字段只问一次，engver / arch / model 共用同一份', async () => {
  const { env, calls } = highEntropyEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(calls.length, 1, '应该只有一次 getHighEntropyValues，实际 ' + calls.length);
  assert.ok(calls[0].includes('platformVersion') && calls[0].includes('fullVersionList'));
  // 1.6.0 起 engver 是结构：声明版本放在 declared，特性下限另算
  assert.strictEqual(plain(e.cli.engver).declared, '141.0.7390.122');
  assert.strictEqual(e.cli.arch, 'x86/64');
  assert.strictEqual(plain(e.cli.model).$, 'unsupported', '桌面返回空 model 属于「这平台没有」，不是读数');
});

test('B5：字体扫描与 WebGL 上下文一轮只建一次', async () => {
  const { env, counts } = countingEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const fonts = plain(e.cli.fonts);
  assert.ok(Array.isArray(fonts.list), 'fonts 应该有读数');
  // webgl / gpu / glx / gpulim / hwid 都用同一份 GL 上下文：WEBGL 上下文只该建一次
  assert.strictEqual(counts.glContexts, 1, 'WebGL 上下文建了 ' + counts.glContexts + ' 次，应该共享');
  // 单次字体扫描 = 3 个基准族 + 45 个字体的最多 3 次比较
  assert.ok(counts.measure < 200, 'measureText 调了 ' + counts.measure + ' 次，应该只扫一遍');
  assert.ok(counts.measure >= 138, '字体扫描本身还是要跑完，实际 ' + counts.measure);
});

test('B5：同一轮里两次取字体结果一致，跨轮次互不影响', async () => {
  const { env } = countingEnv();
  const RC = loadCollector(env);
  const a = await RC.buildEnvelope(undefined, collectorCtx());
  const b = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(a.cli.fonts), plain(b.cli.fonts));   // 同一轮扫描结果稳定
  assert.deepStrictEqual(plain(a.cli.webgl), plain(b.cli.webgl));
});
}

// ===== probes.test.js =====
{
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

test('ICE 默认带公共 STUN，候选类型与作用域留在读数里', async () => {
  const env = fakeEnv();
  const seen = [];
  class PC {
    constructor(opts) { seen.push(opts); this.onicecandidate = null; }
    createDataChannel() { }
    createOffer() {
      setTimeout(() => {
        this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.8 5000 typ host', address: '192.168.1.8', type: 'host' } });
        this.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 1 203.0.113.9 5001 typ srflx', address: '203.0.113.9', type: 'srflx' } });
        this.onicecandidate({ candidate: null });
      }, 5);
      return Promise.resolve({});
    }
    setLocalDescription() { return Promise.resolve(); }
    close() { }
  }
  env.RTCPeerConnection = PC;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  // stun:host:port 才是浏览器认的形状：旧正则要求 stun://，默认清单被整条过滤，
  // servers 恒为 0，永远只有 host 候选（线上实测发现）
  assert.ok(seen.length >= 1, '应该建过 RTCPeerConnection');
  assert.ok(seen[0].iceServers && seen[0].iceServers.length > 0, '默认 STUN 不该被过滤掉');
  const w = plain(e.cli.webrtc);
  assert.strictEqual(w.servers > 0, true);
  assert.strictEqual(w.public_n, 1, 'srflx 候选要算公网');
  assert.strictEqual(w.scope, 'public+local');
  assert.ok(w.candidates.some((c) => c.type === 'srflx' && c.scope === 'public'));
});

test('mDNS 伪装地址要认出来：mdns_only 而不是"没有候选"', async () => {
  const env = fakeEnv();
  class PC {
    constructor() { this.onicecandidate = null; }
    createDataChannel() { }
    createOffer() {
      setTimeout(() => {
        // 真实浏览器给的是 `e63dff68-...uuid.local`，点前不是空格
        this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 e63dff68-70c6-4ba6-90e6-7944e515e772.local 5000 typ host', address: 'e63dff68-70c6-4ba6-90e6-7944e515e772.local', type: 'host' } });
        this.onicecandidate({ candidate: null });
      }, 5);
      return Promise.resolve({});
    }
    setLocalDescription() { return Promise.resolve(); }
    close() { }
  }
  env.RTCPeerConnection = PC;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const w = plain(e.cli.webrtc);
  const lan = plain(e.cli.lan);
  assert.strictEqual(w.mdns, true, 'webrtc.mdns 要认出 .local 后缀');
  assert.deepStrictEqual(w.candidates.map((c) => c.address), ['mdns.local']);
  assert.strictEqual(lan.mdns, true);
  assert.strictEqual(lan.mdns_only, true);
  assert.deepStrictEqual(lan.ips, []);
  assert.strictEqual(lan.reason, 'mdns_only');
  assert.strictEqual(w.scope, 'local');
  assert.strictEqual(w.public_n, 0);
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
  // trackers / extwar 现在真去试：默认 fakeEnv 没有可用 fetch，拿不到结论就是状态标记，
  // 绝不能反过来写成"没装 / 没被拦截"
  const trackers = plain(e.cli.trackers);
  assert.ok(trackers.$ || trackers.verdict, 'trackers 不能是空对象');
  assert.strictEqual(asked, false, '不应触发 geolocation 授权');
  // gamepad 有 API 就能数出已连接个数，不需要权限；G 127 起多了"输入后重读"这一维，
  // 替身环境没有真实输入，所以 needsInteraction 应为 true（这是"没等到"，不是"没手柄"）
  assert.strictEqual(plain(e.cli.gamepad).atLoad, 0);
  assert.strictEqual(plain(e.cli.gamepad).afterInput, null);
  assert.strictEqual(plain(e.cli.gamepad).needsInteraction, true);
  assert.strictEqual(asked, false, '不应触发 geolocation 授权');
});

test('UA 派生项：os / browser / form / arch / engine', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.match(e.cli.os, /Windows/);
  assert.match(e.cli.browser, /Chrome 141/);
  // G 127（B 项）：form 不再是裸字符串，而是 {kind, basis, formFactors, source}
  assert.strictEqual(plain(e.cli.form).kind, 'Desktop');
  assert.strictEqual(plain(e.cli.form).basis, 'ua-mobile');
  assert.strictEqual(e.cli.arch, 'x86/64');
  // engine 现在是两件事：JS 引擎实测措辞 + 渲染内核推断（1.5.0 起）
  assert.strictEqual(e.cli.engine.render, 'Blink');
  assert.strictEqual(e.cli.engine.js, 'v8');
  assert.ok(e.cli.engine.basis);
  // 1.6.0 起 engver 带声明版与特性下限两层；这个 env 没有高熵接口，声明版只能是 UA 里的主版本
  assert.strictEqual(plain(e.cli.engver).declared, '141');
});

test('复合项形状符合契约（决定后台能不能出分布图）', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  // G 127·fp 批：keys 多了"范围"明细（alg=keys/2），旧 window/html/css 字段语义不变
  assert.deepStrictEqual(Object.keys(e.cli.keys).sort(), ['alg', 'css', 'html', 'items', 'scope', 'window']);
  assert.deepStrictEqual(
    Object.keys(e.cli.keys.items).sort(),
    ['CSS', 'HTMLElement.prototype', 'computed-style-properties', 'enumerable-globals', 'own-property-names']
  );
  // A-11：连续读数的正间隔分成 min/max 两个字段（名字与统计量一致），
  // jitter 作为兼容字段等于 maxPositiveMs。
  assert.deepStrictEqual(
    Object.keys(e.cli.timer).sort(),
    ['jitter', 'maxPositiveMs', 'minPositiveMs', 'now', 'res', 'samples']
  );
  if (e.cli.timer.maxPositiveMs !== null) {
    assert.strictEqual(e.cli.timer.jitter, e.cli.timer.maxPositiveMs, 'jitter 必须就是最大正间隔');
  }
  if (e.cli.timer.minPositiveMs !== null && e.cli.timer.maxPositiveMs !== null) {
    assert.ok(e.cli.timer.minPositiveMs <= e.cli.timer.maxPositiveMs, '最小值不可能大于最大值');
  }
  // G 127·fp 批：shield 从 {brave,noise,basis} 升到 shield/2（多了 canvasStable/mathStable/
  // nativeToStringIntact/verdict/note），判定依据仍是实测的 canvas 重复性，不是 Math.random 猜
  assert.deepStrictEqual(
    Object.keys(e.cli.shield).sort(),
    ['alg', 'basis', 'brave', 'canvasStable', 'mathStable', 'nativeToStringIntact', 'noise', 'note', 'verdict']
  );
  assert.ok(['canvas_repeat+math_repeat+native-toString', 'canvas_unmeasured'].indexOf(e.cli.shield.basis) >= 0, '噪声要有实际依据，不能是 Math.random 猜的');
  assert.ok(['likely-privacy-browser', 'canvas-noise', 'clean', 'unknown'].indexOf(e.cli.shield.verdict) >= 0, '实际 ' + e.cli.shield.verdict);
  // 假 canvas 画不出东西时必须给缺状态，而不是硬报 same=false
  assert.ok(e.cli.rand.$ === 'unreadable' || typeof e.cli.rand.same === 'boolean');
  assert.deepStrictEqual(Object.keys(e.cli.gamut).sort(), ['dynamic', 'gamut']);
  assert.deepStrictEqual(Object.keys(e.cli.a11y).sort(), ['contrast', 'forced']);
  assert.deepStrictEqual(Object.keys(e.cli.dnt).sort(), ['dnt', 'gpc']);
  // skew 现在拆成秒与小时两份，外加系统 offset（分钟）
  assert.deepStrictEqual(Object.keys(e.cli.clock).sort(), ['off', 'offset_min', 'rtt_ms', 'skew_h', 'skew_s']);
  assert.deepStrictEqual(Object.keys(e.cli.idstr).sort(), ['plugins', 'productSub', 'vendor']);
  // G 127·fp 批：lies 从裸数组改成 lies/2（逐项"本页/iframe/是否一致"），可疑项清单在 list 里
  assert.strictEqual(plain(e.cli.lies).alg, 'lies/2');
  assert.ok(Array.isArray(plain(e.cli.lies).list));
  assert.ok(Array.isArray(plain(e.cli.lies).items));
  // G 127（J 项）：auto 从裸数组改成 {alg, signals, combos, level}，命中逐条记名字
  assert.ok(Array.isArray(plain(e.cli.auto).signals));
  assert.ok(Array.isArray(plain(e.cli.auto).combos));
  assert.ok(['none', 'weak', 'strong'].indexOf(plain(e.cli.auto).level) >= 0);
  assert.ok(Array.isArray(e.cli.ext));
  assert.strictEqual(typeof e.cli.fpid, 'string');
  // 摘要算法版本要和哈希一起发：换了输入清单或换了算法就是另一串值，分布不能混着比。
  // 这个 harness 没给 crypto.subtle，hash() 走 shaSync 的 FNV-1a，所以标签必须是
  // 降级形态；sha256 那条路径见 n04-identity-alg.test.js（N-04）。
  assert.strictEqual(e.cli.fpid_alg, 'fnv/tmpl-2-fallback');
  assert.strictEqual(e.cli.hwid_alg, 'fnv/hw-2-fallback');
  assert.match(e.cli.fpid, /^(sha256:[0-9a-f]+|fnv:[0-9a-f]+)$/);
  assert.strictEqual(typeof e.cli.hwid, 'string');
  assert.strictEqual(typeof e.cli.pdf, 'boolean');
});

test('adblock 用诱饵元素判断（L 项起只是三个证据之一，详情见 g127-l-adblock.test.js）', async () => {
  // 替身环境没有 fetch：对照与广告 URL 都记 unsupported，按新口径就是 unknown，
  // 不能凭"诱饵被隐藏"单独下 blocked（那条只在对照通的时候才成立）。
  const blocked = await loadCollector(fakeEnv({ baitHidden: true })).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(plain(blocked.cli.adblock).verdict, 'unknown');
  assert.strictEqual(plain(blocked.cli.adblock).bait.hidden, true);
  const open = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(plain(open.cli.adblock).bait.hidden, false);
  assert.strictEqual(plain(open.cli.adblock).verdict, 'unknown');
});

test('时钟偏移量用 trace 的服务器时间算', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.ok(Math.abs(e.cli.clock.skew_h) < 0.1, '本地与服务器时间差应接近 0，实际 ' + e.cli.clock.skew_h);
});

test('stack 测的是 IPv4/IPv6 双栈，不是 HTTP/TLS', async () => {
  const RC = loadCollector(fakeEnv());
  const ctx = collectorCtx({
    json: (url) => Promise.resolve(String(url).indexOf('api4.') >= 0 ? { ip: '1.2.3.4' } : { ip: '2001:db8::1' })
  });
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.stack), {
    v4: { ok: true, ip: '1.2.3.4' }, v6: { ok: true, ip: '2001:db8::1' }, dual: true
  });
});

test('stack 的 dual 是三态：读不出来的腿不能说成「没有 IPv6」', async () => {
  const RC = loadCollector(fakeEnv());
  const unreadable = collectorCtx({
    json: (url) => Promise.resolve(String(url).indexOf('api4.') >= 0 ? { ip: '1.2.3.4' } : { $: 'unreadable' })
  });
  const e = await RC.buildEnvelope(undefined, unreadable);
  assert.strictEqual(e.cli.stack.dual, null, '没测到就是未知，不是 false');

  // 另一条腿读到了、但没有 IP：这才是有意义的负结果
  const noV6 = collectorCtx({
    json: (url) => Promise.resolve(String(url).indexOf('api4.') >= 0 ? { ip: '1.2.3.4' } : {})
  });
  const e2 = await RC.buildEnvelope(undefined, noV6);
  assert.strictEqual(e2.cli.stack.dual, false);
  assert.strictEqual(e2.cli.stack.v6.state, 'no_ip');
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
  const wasm = plain(e.cli.wasm);
  // 1.6.0：真去编译特性模块，桩 validate 恒真时 validate 类全过。
  // G 127·fp 批：清单扩到 17 项，其中 JSPI 只按 API 存在性判（桩没有 Suspending）→ 16/17
  assert.strictEqual(wasm.alg, 'wasm/2');
  assert.strictEqual(wasm.total, 17);
  assert.strictEqual(wasm.supported, 16);
  assert.deepStrictEqual(wasm.missing, ['jspi']);
  assert.strictEqual(wasm.items.jspi.source, 'api-existence');
  assert.strictEqual(e.cli.battery.chargingTime, 5400);
});

test('wasm 没有 API 时用 unsupported 标记（浏览器没这能力，不是没跑）', async () => {
  const env = fakeEnv();
  env.WebAssembly = null;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.wasm), { $: 'unsupported' });
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
  let fpCalls = 0;
  const h2 = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => { fpCalls++; return Promise.resolve({ tls: { ja3n: 'ja3n-x', ja4: 'ja4-x' }, proto: 'h2' }); }
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, h2);
  assert.strictEqual(e.cli.tlsfp, 'ja3n-x');
  assert.strictEqual(e.cli.quicfp, undefined);
  // A-08：始终 TCP 的情形要能在结果里读出来，而不是只有"没有 quicfp"
  assert.strictEqual(e.meta.h3.state, 'tcp-only');
  assert.strictEqual(e.meta.h3.attempts, 3, '补测次数要写明（上限 3 次）');
  assert.strictEqual(e.meta.h3.first_proto, 'h2');
  assert.ok(fpCalls >= 2, '首样本 + 至少一次补测，实际 ' + fpCalls);

  const h3 = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.resolve({ tls: { ja3: 'ja3-y', ja4: 'ja4-y' }, proto: 'h3' })
  });
  const e3 = await loadCollector(fakeEnv()).buildEnvelope(undefined, h3);
  assert.strictEqual(e3.cli.tlsfp, 'ja3-y');
  assert.strictEqual(e3.cli.quicfp, 'ja4-y');
  assert.strictEqual(e3.meta.h3.state, 'h3-first', '首连就是 H3，不用补测');
  assert.strictEqual(e3.meta.h3.attempts, 0);
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

test('BLOG-09：hwdec 保留 supported/smooth/powerEfficient 三项，别把费电当成不支持', async () => {
  const env = fakeEnv();
  env.navigator.mediaCapabilities = {
    decodingInfo: (cfg) => Promise.resolve({ supported: true, smooth: cfg.video.contentType.indexOf('hev1') < 0, powerEfficient: false })
  };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const h = plain(e.cli.hwdec);
  assert.deepStrictEqual(Object.keys(h).sort(), ['av1', 'h2648', 'hevc', 'vp9']);
  for (const k of ['h2648', 'av1', 'vp9']) {
    assert.strictEqual(h[k].supported, true, k + ' 应能解');
    assert.strictEqual(h[k].powerEfficient, false, k + ' 只是不省电');
  }
  assert.strictEqual(h.hevc.smooth, false);
});
}

// ===== sensors.test.js =====
{
'use strict';
// 1.7.2：sensors 从"恒 not_run"改成被动采样——安卓 Chrome 的 devicemotion 不需要
// 任何授权，有事件就报采样率与三轴噪声，没有事件仍然保持 not_run；明确拒绝跟踪的
// 访客（GPC／DNT）连监听都不挂。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function motionEnv(events, opts) {
  const env = fakeEnv();
  const handlers = {};
  env.addEventListener = (type, fn) => { handlers[type] = fn; };
  env.removeEventListener = (type) => { delete handlers[type]; };
  env.DeviceMotionEvent = function DeviceMotionEvent() { };
  const schedule = (events || []).map((e, i) => setTimeout(() => {
    const fn = handlers.devicemotion;
    if (fn) fn(e);
  }, 10 + i * 10));
  env.__pending = schedule;
  env.__handlers = handlers;
  Object.assign(env, opts || {});
  return env;
}

function sample(i) {
  return {
    interval: 16,
    accelerationIncludingGravity: { x: 0.01 * i, y: 9.8 + 0.02 * i, z: 0.03 * i },
    rotationRate: { alpha: 0.1, beta: 0.2, gamma: 0.3 }
  };
}

test('sensors：有 devicemotion 事件时报采样率与三轴噪声，不弹任何权限', async () => {
  const many = Array.from({ length: 30 }, (_, i) => sample(i % 7));
  const env = motionEnv(many);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const s = plain(e.cli.sensors);
  assert.strictEqual(s.alg, 'devicemotion-passive');
  assert.ok(s.n >= 24, '攒够样本就收工，实际拿到 ' + s.n);
  assert.strictEqual(typeof s.hz, 'number');
  assert.strictEqual(s.rot, true);
  assert.strictEqual(s.interval_ms, 16);
  assert.strictEqual(s.noise.length, 3);
  assert.ok(s.noise.every((v) => typeof v === 'number' && v > 0));
  // 采样结束后要把监听摘掉，别让手机一直读传感器
  assert.ok(!env.__handlers.devicemotion, '采样完应该移除 devicemotion 监听');
});

test('sensors：没有旋转速率时 rot 是 false，不是编造', async () => {
  const env = motionEnv([sample(1), sample(2), sample(3)].map((e) => {
    const c = { ...e };
    delete c.rotationRate;
    return c;
  }));
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const s = plain(e.cli.sensors);
  assert.strictEqual(s.rot, false);
});

test('sensors：一个事件都没来时仍是 not_run（桌面／iOS 就是这种情况）', async () => {
  const env = motionEnv([]);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.sensors), { $: 'not_run' });
});

test('sensors：GPC／DNT 访客连监听都不挂，这项整个不出现', async () => {
  const env = motionEnv([sample(1), sample(2), sample(3)], { navigator: Object.assign({}, fakeEnv().navigator, { globalPrivacyControl: true }) });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.ok(!('sensors' in e.cli), '明确拒绝跟踪时不该有 sensors 读数');
  assert.ok(!env.__handlers.devicemotion, '也不该挂监听');
});
}
