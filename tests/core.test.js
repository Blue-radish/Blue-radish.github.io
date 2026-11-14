'use strict';
// 信封结构与主流程。
// 由 3 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== envelope.test.js =====
{
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');
const IDS = require('./ids.json');

// proto 已是 C*（来自 trace），因此由上面的分组循环带出；只剩两个跨组键要补。
const CLIENT_FILLED_EXTRA = ['edge', 'ch']; // edge 来自 trace 的 colo、ch 来自 hints

function expectedClientIds() {
  const out = [];
  for (const rows of Object.values(IDS.groups)) {
    for (const r of rows) if (r.prov === 'C' || r.prov === 'C*') out.push(r.id);
  }
  return out.concat(CLIENT_FILLED_EXTRA);
}

test('信封只有 7 个顶层键，没有 srv，v=1', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(Object.keys(e).sort(), ['cli', 'id', 'meta', 'page', 'session', 'ts', 'v']);
  assert.strictEqual(e.v, 1);
  assert.strictEqual(e.meta.collector, RC.VERSION);
  assert.ok(!('srv' in e), '请求体不应包含 srv');
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(e.id, /^[0-9a-f-]{30,}$|^r[0-9a-f]+$/);
});

// 版本标记不是测量项：它们只说明"这串摘要是用哪代算法算的"，
// 不占 127 项里的任何一项（占位会让完成度虚增）。
const META_KEYS = ['fpid_alg', 'hwid_alg'];

test('cli 覆盖全部客户端项（107 个），清单共 127 项，且没有不认识的多余键', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const expected = expectedClientIds();
  const lack = expected.filter(id => !(id in e.cli));
  const unknown = Object.keys(e.cli).filter(id => !IDS.all.includes(id) && !META_KEYS.includes(id));
  assert.deepStrictEqual(lack, [], '缺少的探测项');
  assert.deepStrictEqual(unknown, [], '不在 127 项清单里的键');
  assert.strictEqual(IDS.all.length, 127, 'id 清单总数');
  assert.strictEqual(new Set(expected).size, 106);
  assert.strictEqual(Object.keys(e.cli).length, 107 + META_KEYS.length);
});

test('没有任何一项是 undefined 或裸 null（一律用缺失标记）', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  for (const [k, v] of Object.entries(e.cli)) {
    assert.notStrictEqual(v, undefined, k + ' 是 undefined');
    assert.notStrictEqual(v, null, k + ' 是 null（null 无法区分"读不到"）');
  }
});

test('normalize 固定格式，供服务端 facet 直接使用', () => {
  const RC = loadCollector(fakeEnv());
  assert.strictEqual(RC.normalize('UTC+8'), 'UTC+8');
  assert.strictEqual(RC.normalize(1.23456789), '1.2346');
  assert.strictEqual(RC.normalize(true), 'true');
  assert.strictEqual(RC.normalize(RC.M('unsupported')), 'unsupported');
  assert.strictEqual(RC.normalize(plain(['b', 'a', 'b'])), 'a|b');
  assert.strictEqual(RC.normalize(plain({ b: 2, a: 1 })), 'a:1|b:2');
});

test('超预算时按优先级截断长尾数组，且字节数达标', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  e.cli.fonts = Array.from({ length: 900 }, (_, i) => 'Font' + i + 'x'.repeat(40));
  e.cli.voices = Array.from({ length: 900 }, (_, i) => 'Voice' + i + 'y'.repeat(40));
  const out = RC.applyBudget(e, 48 * 1024);
  const bytes = Buffer.byteLength(JSON.stringify(out.envelope), 'utf8');
  assert.ok(bytes <= 48 * 1024, 'bytes=' + bytes);
  assert.strictEqual(out.envelope.cli.fonts.length, 300);
  assert.deepStrictEqual(plain(out.dropped.map(d => d.id)).sort(), ['fonts', 'voices']);
  assert.deepStrictEqual(plain(out.envelope.meta.truncated.map(d => d.n)), [900, 900]);
});

test('数据极端大时逐级压缩，绝不超 48 KiB', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  e.cli.fonts = Array.from({ length: 400 }, (_, i) => 'Long Font Family ' + i + ' ' + 'x'.repeat(120));
  e.cli.voices = Array.from({ length: 400 }, (_, i) => 'Voice ' + i + ' ' + 'y'.repeat(120));
  const out = RC.applyBudget(e, 48 * 1024);
  const bytes = Buffer.byteLength(JSON.stringify(out.envelope), 'utf8');
  assert.ok(bytes <= 48 * 1024, 'bytes=' + bytes);
  assert.ok(out.envelope.cli.fonts.length < 300, '应压到 300 以下，实际 ' + out.envelope.cli.fonts.length);
  assert.ok(out.envelope.cli.fonts.length >= 9, '不应压到 9 以下');
  assert.deepStrictEqual(plain(out.envelope.meta.truncated.map(d => d.n)), [400, 400]);
});

test('DNT/GPC 开启时 cli 为空且 optout=true', async () => {
  const RC = loadCollector(fakeEnv({ dnt: '1' }));
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli), {});
  assert.strictEqual(e.meta.privacy.optout, true);
  assert.strictEqual(e.meta.privacy.dnt, true);

  const RC2 = loadCollector(fakeEnv({ gpc: true }));
  const e2 = await RC2.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e2.cli), {});
  assert.strictEqual(e2.meta.privacy.optout, true);
});

test('canvas 抛 SecurityError 时只标记该项，其余项照常', async () => {
  const RC = loadCollector(fakeEnv({ throwOnContext: true }));
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const marked = ['canvas', 'webgl', 'fontfp', 'gpu', 'textm'];
  for (const id of marked) {
    assert.deepStrictEqual(plain(e.cli[id]), { $: 'error' }, id + ' 应为 error 标记');
  }
  assert.strictEqual(typeof e.cli.tz, 'string');
  assert.strictEqual(typeof e.cli.cpu, 'number');
  assert.strictEqual(Object.keys(e.cli).length, 107 + META_KEYS.length);
});

test('不支持的 API 标 unsupported 而不是抛错', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.canvas), { $: 'unsupported' });
  assert.deepStrictEqual(plain(e.cli.voices), { $: 'unsupported' });
  assert.deepStrictEqual(plain(e.cli.webgpu), { $: 'unsupported' });
  assert.deepStrictEqual(plain(e.cli.battery), { $: 'unsupported' });
});

test('trace 派生的 kex/warp/edge/proto 与 hints 派生的 ch', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  // fakeEnv 的 trace 带 sni=plaintext：kex 必须把这条观测留住
  assert.deepStrictEqual(plain(e.cli.kex), { group: 'X25519MLKEM768', sni: 'plaintext', src: 'trace' });
  assert.deepStrictEqual(plain(e.cli.warp), { state: 'off', gateway: null, src: 'trace' });
  assert.strictEqual(e.cli.edge, 'LAX');
  assert.deepStrictEqual(plain(e.cli.proto), { http: 'HTTP/2', tls: 'TLSv1.3' });
  // 回显头进 srv 分区，浏览器自报的分区不被覆盖
  assert.ok(e.cli.ch && typeof e.cli.ch === 'object');
  assert.match(JSON.stringify(plain(e.cli.ch.srv)), /sec-ch-ua/);

  const e2 = await RC.buildEnvelope(undefined, collectorCtx({ trace: {}, hints: { h: {} } }));
  assert.deepStrictEqual(plain(e2.cli.kex), { $: 'unsupported' });
  assert.deepStrictEqual(plain(e2.cli.proto), { $: 'unsupported' });
  // 没有回显头时不能凭空造 srv 分区；浏览器不支持 UA-CH 就是 unsupported
  assert.ok(!e2.cli.ch || !e2.cli.ch.srv, '没有 hints 时不该有 srv 分区');
});

test('G10：40 个 20000 字符的 voice 也不能撑破 48 KiB', async () => {
  const RC = loadCollector(fakeEnv());
  const big = Array.from({ length: 40 }, (_, i) => 'V' + i + '-' + 'x'.repeat(20000));
  const stub = { v: 1, id: 'a', ts: 'b', session: 'c', page: {}, cli: { voices: big, fonts: [] }, meta: {} };
  const r = RC.applyBudget(stub, 49152);
  const body = JSON.stringify(r.envelope);
  assert.ok(Buffer.byteLength(body, 'utf8') <= 49152, '实际 ' + Buffer.byteLength(body, 'utf8') + ' B');
  assert.ok(r.ok, '应该报告预算已满足');
  assert.ok(r.dropped.some(d => d.id === 'voices'), '裁剪要记账');
});

test('G06：ICE 解析取 candidate.address，不抓 foundation', async () => {
  const env = fakeEnv();
  class PC {
    constructor() { this.onicecandidate = null; }
    createDataChannel() { }
    createOffer() {
      setTimeout(() => {
        this.onicecandidate({ candidate: { candidate: 'candidate:123456 1 udp 2113937151 192.168.1.8 54321 typ host', address: '192.168.1.8', type: 'host' } });
        this.onicecandidate({ candidate: null });
      }, 5);
      return Promise.resolve({});
    }
    setLocalDescription() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  env.RTCPeerConnection = PC;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.lan.ips), ['192.168.1.8']);
  // mDNS 与真实地址没有同时出现时，mdns_only 明确为 false（不是 undefined）
  assert.strictEqual(e.cli.lan.mdns_only, false);
  assert.strictEqual(e.cli.lan.candidate_types.host, 1);
});

test('G07：trace 晚到时 clock.skew_h 也要算出来', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  let n = 0;
  const bodies = [];
  env.fetch = (u, init) => new Promise(r => setTimeout(() => {
    n++;
    if (init && init.method === 'POST') bodies.push(String(init.body));
    const ts = (Date.now() / 1000) + 7200;   // 服务器比本地快 2 小时
    r({ ok: true, status: init && init.method === 'POST' ? 204 : 200, text: () => Promise.resolve('ts=' + ts + '\nhttp=HTTP/2\ntls=TLSv1.3\ncolo=LAX\n'), json: () => Promise.resolve({ h: {} }) });
  }, 120));
  await RC.run(env, { endpoint: 'http://x/c', trace: 'http://t/t', hints: 'http://h/h' });
  assert.strictEqual(bodies.length, 1, '应该有且只有一条上报');
  const body = JSON.parse(bodies[0]);
  // 符号约定：正数 = 服务器比本地快（旧实现方向相反）
  assert.ok(Math.abs(body.cli.clock.skew_s - 7200) < 5, '实际 ' + body.cli.clock.skew_s);
  assert.ok(Math.abs(body.cli.clock.skew_h - 2) < 0.05, '实际 ' + body.cli.clock.skew_h);
  assert.ok(typeof body.cli.clock.rtt_ms === 'number', '要带 RTT 一起报，秒差里含一半往返');
});
}

// ===== features16.test.js =====
{
'use strict';
// 1.6.0：把参考实现里"真去试一下"的四项落下来——wasm 真编译、smooth 看像素、
// traces 写标记读回来、engver 用 JS 特性给下限，另外补上后端已有的 /v1/etag。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function memStore(over) {
  const data = over || {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    get length() { return Object.keys(data).length; }
  };
}

function ctxStub(pixels) {
  return {
    fillStyle: '#000',
    font: '16px sans-serif',
    fillRect() {},
    fillText() {},
    getImageData() { return { data: pixels }; }
  };
}

function canvasEnv(env, pixels) {
  env.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext() { return ctxStub(pixels); }
  });
  return env;
}

test('wasm：真的把用特性的最小模块交给引擎校验', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const w = plain(e.cli.wasm);
  // G 127·fp 批：从 6 项扩到参考站的 17 项，alg 一并升到 wasm/2
  assert.strictEqual(w.alg, 'wasm/2');
  assert.strictEqual(w.total, 17);
  assert.ok(w.supported >= 13, 'Node 的 V8 支持绝大多数特性，读到 ' + w.supported);
  assert.ok(w.has.indexOf('sign-ext') >= 0);
  assert.strictEqual(w.has.concat(w.missing).length, w.total);
  assert.strictEqual(Object.keys(w.items).length, 17, '逐特性真值表要覆盖全部 17 项');
});

test('wasm：没有 WebAssembly 时是 unsupported，不是 0 项', async () => {
  const env = fakeEnv();
  env.WebAssembly = null;
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.wasm), { $: 'unsupported' });
});

test('smooth：彩色像素多说明在做次像素抗锯齿', async () => {
  const pixels = new Uint8ClampedArray(140 * 30 * 4);
  for (let i = 0; i < 40; i++) {
    pixels[i * 4] = 200; pixels[i * 4 + 1] = 40; pixels[i * 4 + 2] = 90; // 明显彩色
  }
  const RC = loadCollector(canvasEnv(fakeEnv(), pixels));
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const s = plain(e.cli.smooth);
  assert.strictEqual(s.alg, 'aa-pixels');
  assert.strictEqual(s.verdict, 'subpixel');
  assert.strictEqual(s.color, 40);
});

test('smooth：只有灰度中间值说明只做灰度平滑', async () => {
  const pixels = new Uint8ClampedArray(140 * 30 * 4);
  for (let i = 0; i < 40; i++) {
    pixels[i * 4] = 128; pixels[i * 4 + 1] = 128; pixels[i * 4 + 2] = 128;
  }
  const RC = loadCollector(canvasEnv(fakeEnv(), pixels));
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const s = plain(e.cli.smooth);
  assert.strictEqual(s.verdict, 'grayscale');
  assert.strictEqual(s.gray, 40);
});

test('traces：第一次来没有旧标记，写入后标记留在各存储里', async () => {
  const env = fakeEnv();
  env.localStorage = memStore();
  env.sessionStorage = memStore();
  env.document.cookie = '';
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.match(t.alg, /^storage-tag/);
  assert.strictEqual(t.first, true);
  assert.deepStrictEqual(t.kept, []);
  assert.deepStrictEqual(t.blocked, []);
  // 写进去的东西下一轮才用来判断"留不留得住"
  assert.ok(env.localStorage.getItem('__radish_trace'));
  assert.match(env.localStorage.getItem('__radish_trace'), /"t":"[0-9a-f]{8,}"/);
});

test('traces：上一轮的标记还在，就说明这个存储留得住', async () => {
  const env = fakeEnv();
  const tag = JSON.stringify({ t: 'abcdef0123456789', at: Date.now() });
  env.localStorage = memStore({ __radish_trace: tag });
  env.sessionStorage = memStore();
  env.document.cookie = '';
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.first, false);
  assert.deepStrictEqual(t.kept, ['localStorage']);
  assert.ok(t.lost.indexOf('sessionStorage') >= 0 || t.lost.indexOf('cookie') >= 0);
});

test('traces：尊重不追踪，直接标 not_run 且不写任何存储', async () => {
  const env = fakeEnv();
  env.navigator.doNotTrack = '1';
  env.localStorage = memStore();
  env.sessionStorage = memStore();
  env.document.cookie = '';
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  // 不追踪时整项被跳过（键不出现），或明确标 not_run；两种都不写存储
  const skipped = !('traces' in e.cli);
  const marked = skipped ? null : e.cli.traces.$;
  assert.ok(skipped || marked === 'not_run',
    'DNT 下 traces 只能是缺省或 not_run，读到 ' + (skipped ? '缺省' : String(marked)));
  assert.strictEqual(env.localStorage.getItem('__radish_trace'), null);
});

test('traces：读不出来的存储标 blocked，不冒充"没留住"', async () => {
  const env = fakeEnv();
  env.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() {},
    length: 0
  };
  env.sessionStorage = memStore();
  env.document.cookie = '';
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.traces).blocked, ['localStorage']);
});

test('etag：随机令牌 + 条件请求证明，而不是"服务器见过相同配置"', async () => {
  const env = fakeEnv();
  const calls = [];
  let pass = 0;
  env.fetch = (url) => {
    // 只记 etag 自己的请求：trackers/extwar 也会走同一个 fetch
    // （注意 googletagmanager 的域名里也有 "etag"，只能按路径匹配）
    if (/\/v1\/etag/.test(url)) calls.push(url);
    const isEtag = /\/v1\/etag(\?|$)/.test(url);
    if (isEtag) pass += 1;
    if (isEtag && pass >= 2) {
      // 第二响一个 etag 头都读不到：新流程这时才去问 /report（N-05）
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('0123456789abcdef0123456789abcdef'),
        json: () => Promise.resolve({})
      });
    }
    if (/\/v1\/etag\/report/.test(url)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({
          alg: 'rand-token/1',
          state: 'ok',
          conditional_seen: true,
          conditional_count: 1,
          same_network: true
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (/^etag$/i.test(name)) return '"r-0123456789abcdef0123456789abcdef"';
          if (/^x-etag-token$/i.test(name)) return '0123456789abcdef0123456789abcdef';
          if (/^x-etag-conditional$/i.test(name)) return '0';
          if (/^x-etag-verified$/i.test(name)) return '0';
          if (/^x-etag-state$/i.test(name)) return 'issued-new';
          if (/^x-etag-alg$/i.test(name)) return 'rand-token/1';
          if (/^x-net-seen$/i.test(name)) return '1';
          if (/^x-net-scope$/i.test(name)) return 'exit+ua+lang/30d';
          return null;
        }
      },
      text: () => Promise.resolve('0123456789abcdef0123456789abcdef'),
      json: () => Promise.resolve({})
    });
  };
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);
  assert.strictEqual(tag.alg, 'rand-token/1');
  assert.strictEqual(tag.token, '01234567');
  assert.strictEqual(tag.state, 'issued-new');
  // 同一网络配置被服务器见过，单独一个字段，不是缓存证据
  assert.strictEqual(tag.net_seen, true);
  assert.strictEqual(tag.net_scope, 'exit+ua+lang/30d');
  // 服务端确实收到了带这个令牌的条件请求
  assert.strictEqual(tag.conditional_seen, true);
  assert.strictEqual(tag.report.conditional_count, 1);
  // 三跳：拿令牌 → 同 URL 再请求触发校验 → 响应头读不到才问 report。
  // 读得到响应头时第三跳会被省掉（N-05），所以这里先让第二响的头读不到。
  assert.strictEqual(calls.length, 3, '只发了 ' + calls.length + ' 次请求');
  for (let i = 0; i < calls.length - 1; i++) {
    assert.ok(!/\/report\?/.test(calls[i]), 'report 必须是最后一次请求');
    assert.match(calls[i], /\/v1\/etag(\?|$)/);
  }
  assert.ok(/\/report\?token=/.test(calls[calls.length - 1]));
  // A-01：被缓存的请求 URL 固定，不带访问号；访问号只在关联请求（report）里
  assert.ok(!/[?&]id=/.test(calls[0]), '被缓存的 /v1/etag 不许带 ?id=（会换掉缓存键）：' + calls[0]);
  assert.ok(!calls[0].includes('?'), '被缓存的 /v1/etag 连查询串都不该有：' + calls[0]);
  assert.match(calls[calls.length - 1], /[?&]id=/, '关联请求要带访问号');
});

test('etag：report 说没收到条件请求时不冒充缓存命中', async () => {
  const env = fakeEnv();
  let pass = 0;
  env.fetch = (url) => {
    const isEtag = /\/v1\/etag(\?|$)/.test(url);
    if (isEtag) pass += 1;
    const readable = isEtag && pass === 1;
    return Promise.resolve({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (!readable) return null;   // 第二跳读不到头 → 走 report 兜底
        if (/^x-etag-token$/i.test(name)) return 'fedcba9876543210fedcba9876543210';
        if (/^x-etag-state$/i.test(name)) return 'issued-new';
        return null;
      }
    },
    text: () => Promise.resolve('fedcba9876543210fedcba9876543210'),
    json: () => Promise.resolve({ alg: 'rand-token/1', state: 'ok', conditional_seen: false, conditional_count: 0 })
    });
  };
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);
  assert.strictEqual(tag.conditional_sent, false);
  assert.strictEqual(tag.conditional_seen, false);
  assert.strictEqual(tag.report.conditional_count, 0);
});

test('etag：后端不通标 unreachable', async () => {
  const env = fakeEnv();
  env.fetch = () => Promise.reject(new Error('network'));
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.etag), { $: 'unreachable' });
});

test('engver：用特性下限说话，别只看声明版本', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.engver);
  // G 127·fp 批：特性清单从 7 条校准到参考站的 11 条，alg 升到 feature-floor/2
  assert.strictEqual(v.alg, 'feature-floor/2');
  assert.strictEqual(v.total, 11);
  assert.ok(v.floor_chromium === null || v.floor_chromium >= 97);
});

test('engver：下限取"已支持特性里最高的那个版本"，不是声明版', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.engver);
  const FLOORS = {
    findLast: 97, structuredClone: 98, groupBy: 117,
    withResolvers: 119, fromAsync: 121, 'set-union': 122,
    'promise-try': 128, 'duration-format': 129, 'error-iserror': 134,
    float16array: 135, 'regexp-escape': 136
  };
  assert.strictEqual(Object.keys(FLOORS).length, v.total, '版本表必须覆盖清单里每一条');
  if (v.newest === null) {
    assert.strictEqual(v.supported, 0);
    assert.strictEqual(v.floor_chromium, null);
  } else {
    assert.strictEqual(v.floor_chromium, FLOORS[v.newest], '下限应等于最新特性的最低版本');
    assert.strictEqual(v.supported, v.supported | 0);
  }
});

// 探针走的是 ctx.json（harness 默认返回 null），所以这里替身 ctx.json 而不是 env.fetch
function fpCtx(payloadFor, over) {
  return collectorCtx(Object.assign({
    json: (url) => Promise.resolve(payloadFor(String(url)))
  }, over || {}));
}

const FP_PAYLOAD = {
  ip: '203.0.113.5',
  proto: 'HTTP/2.0',
  tcp: { os: 'windows', initial_ttl: 128, mss: 1460 },
  tls: { ja4: 't13d1516h2_8daaf6152771_02713d6af862', ja3: '771,4865' },
  http2: { pseudo: 'm,a,s,p', settings: [1, 131072] }
};

test('协议指纹：后端说有探针就去取，四项落到 cli 里', async () => {
  const ctx = fpCtx((url) => {
    if (url.endsWith('/v1/fp')) return { available: true, url: 'https://probe.test' };
    if (url.endsWith('/fp')) return FP_PAYLOAD;
    return null;
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { os: 'windows', initial_ttl: 128, mss: 1460 });
  assert.match(plain(e.cli.ja4), /^t13d/);
  assert.strictEqual(plain(e.cli.h2fp).pseudo, 'm,a,s,p');
  assert.strictEqual(plain(e.cli.tlsfp), '771,4865');
  // HTTP/2 连接上没有 QUIC 指纹，不能拿 TLS 的顶替
  assert.ok(!('quicfp' in e.cli));
});

test('协议指纹：后端说没配置探针，这五项就不进 cli（不伪造）', async () => {
  const ctx = fpCtx((url) => (url.endsWith('/v1/fp')
    ? { available: false, url: null, reason: 'probe-not-configured' }
    : null), { probeUrl: '' });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  for (const id of ['tcpfp', 'ja4', 'tlsfp', 'h2fp', 'quicfp']) {
    assert.ok(!(id in e.cli), id + ' 不该在没有探针时出现');
  }
});

test('协议指纹：探针取不到时是 unreachable，不是 unsupported', async () => {
  const ctx = fpCtx((url) => (url.endsWith('/fp') ? null : null), { probeUrl: 'https://probe.test' });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'unreachable' });
});

function iceEnv(candidates) {
  const env = fakeEnv();
  function PC() {
    this.onicecandidate = null;
    this.createDataChannel = () => ({});
    this.createOffer = () => Promise.resolve({ type: 'offer', sdp: 'v=0' });
    this.setLocalDescription = () => {
      setTimeout(() => {
        for (const c of candidates) this.onicecandidate({ candidate: { candidate: c, address: c.split(' ')[4], type: 'host' } });
        this.onicecandidate({ candidate: null });
      }, 0);
      return Promise.resolve();
    };
    this.close = () => {};
  }
  env.RTCPeerConnection = PC;
  return env;
}

test('v6mac：EUI-64 要按 IID 结构判断，并还原出 MAC', async () => {
  const env = iceEnv([
    'candidate:1 1 udp 2113937151 fe80::0211:22ff:fe33:4455 5000 typ host',
    'candidate:2 1 udp 2113937151 192.168.1.8 5001 typ host'
  ]);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.v6mac);
  assert.strictEqual(v.eui64, true);
  assert.strictEqual(v.mac, '00:11:22:33:44:55');   // U/L 位翻回去
  assert.strictEqual(v.basis, 'eui64-iid');
  assert.ok(v.addresses.indexOf('fe80::0211:22ff:fe33:4455') >= 0);
  assert.deepStrictEqual(v.sources, ['ice']);
});

test('v6mac：只有 ff 没有 fe 的 IID 不算 EUI-64', async () => {
  // 2001:db8::ff:0:0 的 IID 是 0000:00ff:0000:0000，第 3、4 字节不是 ff:fe
  const env = iceEnv(['candidate:1 1 udp 2113937151 2001:db8::ff:0:0 5000 typ host']);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.v6mac);
  assert.strictEqual(v.has_v6, true);
  assert.strictEqual(v.eui64, false);
  assert.strictEqual(v.mac, null);
});
}

// ===== features17.test.js =====
{
'use strict';
// 1.7.1：把 bt 与 ai 改成参考实现的口径——bt 自己限时收工，ai 按目标语言扫一遍
// availability()，只问不下载。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const LANGS_TOTAL = 19;

async function build(env) {
  return loadCollector(env).buildEnvelope(undefined, collectorCtx());
}

// ---------- ai ----------

test('ai：模型状态 + 已下载的翻译语言，都从 availability() 来', async () => {
  const env = fakeEnv();
  const asked = [];
  env.LanguageModel = { availability: () => Promise.resolve('downloadable') };
  env.Translator = {
    availability(opt) {
      asked.push(opt.targetLanguage);
      return Promise.resolve(opt.targetLanguage === 'ja' || opt.targetLanguage === 'fr' ? 'available' : 'unavailable');
    }
  };
  const ai = plain((await build(env)).cli.ai);
  assert.strictEqual(ai.model, 'downloadable');
  assert.strictEqual(ai.basis, 'availability-sweep');
  assert.deepStrictEqual(ai.langs, ['ja', 'fr']);
  assert.strictEqual(ai.langs_total, LANGS_TOTAL);
  assert.strictEqual(ai.translator_answered, true);
  // 语言必须带 sourceLanguage/targetLanguage 问，否则新版 Chrome 直接抛错
  assert.strictEqual(asked.length, LANGS_TOTAL);
});

test('ai：翻译接口全问不出来时，不能被写成"一种语言都没装"', async () => {
  const env = fakeEnv();
  env.LanguageModel = { availability: () => Promise.resolve('available') };
  env.Translator = { availability: () => Promise.reject(new Error('needs targetLanguage')) };
  const ai = plain((await build(env)).cli.ai);
  assert.strictEqual(ai.model, 'available');
  assert.deepStrictEqual(ai.langs, []);
  assert.strictEqual(ai.translator_answered, false);
});

test('ai：两个接口都问不出来时是 unreadable（状态，不是空读数）', async () => {
  const env = fakeEnv();
  env.LanguageModel = { availability: () => Promise.reject(new Error('nope')) };
  const ai = plain((await build(env)).cli.ai);
  assert.deepStrictEqual(ai, { $: 'unreadable' });
});

test('ai：浏览器没有内置模型接口时是 unsupported', async () => {
  const env = fakeEnv();
  delete env.LanguageModel;
  delete env.Translator;
  delete env.Summarizer;
  const ai = plain((await build(env)).cli.ai);
  assert.deepStrictEqual(ai, { $: 'unsupported' });
});

test('ai：Summarizer 也算内置模型（Edge 上就是它）', async () => {
  const env = fakeEnv();
  env.Summarizer = { availability: () => Promise.resolve('downloading') };
  const ai = plain((await build(env)).cli.ai);
  assert.strictEqual(ai.model, 'downloading');
});

// ---------- bt ----------

test('bt：适配器可用性是 true/false 的原样读数', async () => {
  const env = fakeEnv();
  env.navigator.bluetooth = { getAvailability: () => Promise.resolve(false) };
  const bt = plain((await build(env)).cli.bt);
  assert.deepStrictEqual(bt, { api: true, available: false });
});

test('bt：接口在但 getAvailability 不回答时，1.5 秒后落 timeout，且不进 meta.stuck', async () => {
  const env = fakeEnv();
  env.navigator.bluetooth = { getAvailability: () => new Promise(() => { }) };
  const e = await build(env);
  assert.deepStrictEqual(plain(e.cli.bt), { $: 'timeout' });
  assert.ok(!(e.meta.stuck || []).includes('bt'), 'bt 自己限时收工，不该记进 stuck');
});

test('bt：查询报错时是 available:null（没读到），不是 false', async () => {
  const env = fakeEnv();
  env.navigator.bluetooth = { getAvailability: () => Promise.reject(new Error('gatt')) };
  const bt = plain((await build(env)).cli.bt);
  assert.deepStrictEqual(bt, { api: true, available: null });
});

test('bt：浏览器根本没有蓝牙接口时是 unsupported', async () => {
  const env = fakeEnv();
  delete env.navigator.bluetooth;
  const bt = plain((await build(env)).cli.bt);
  assert.deepStrictEqual(bt, { $: 'unsupported' });
});
}
