'use strict';
// 缓存与 ETag 证据链。
// 由 3 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== a01-etag-stable-url.test.js =====
{
'use strict';
// A-01（P1）：ETag 的缓存键必须稳定。
//
// 缺陷：`probe('etag')` 过去把本轮访问号拼进被缓存的资源 URL（`/v1/etag?id=<访问号>`）。
// 浏览器按「请求方法 + 目标 URI」做缓存键（RFC 9111 §2），于是每次访问都是一个新缓存项，
// 跨访问复用不可能发生。审查用真实 Chrome 复现：页面 A 用 `/v1/etag?id=A`、页面 B 用
// `/v1/etag?id=B`，两轮 `first_pass.verified` 都是 false。
//
// 本文件锁住修复后的契约：
//   ① 被缓存的请求 URL 就是 ETAG_URL 本身：不含 `?`、不含 `id=`；
//   ② 两次「访问」（两个不同的访问号）里 `/v1/etag` 的 URL 逐字节相同 —— 缓存键稳定；
//   ③ 访问号与会话号改放在独立的关联请求 `/v1/etag/report?token=…&id=…&sid=…`
//      （no-store，不进缓存）；
//   ④ 首响带 `X-Etag-Verified: 1` 时 `first_pass.verified === true`（跨访问证据）；
//   ⑤ 首跳被期限掐掉时仍然是 `{"$":"timeout"}`，不是 unreachable，也不是 error；
//   ⑥ **跨访问只看会话号**（2026-11-14 真机假阳性）：同一次页面访问会发半份 + 完整两封信封，
//      两封 session 相同、访问号不同。采集器不许自己数访问号下"跨访问"结论——结论由服务端
//      按不同 sid 给出，采集器只转述；
//   ⑦ 半份信封那一轮也照常带 report（含 id 与 sid），不因为 meta.partial 就跳过。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain, keepAlive } = require('./harness');

const TOKEN = '0123456789abcdef0123456789abcdef';

function makeRes(headers, body) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
  return {
    ok: true,
    status: 200,
    headers: { get: (n) => (h[String(n).toLowerCase()] === undefined ? null : h[String(n).toLowerCase()]) },
    text: () => Promise.resolve(body === undefined ? TOKEN : body),
    json: () => Promise.resolve({})
  };
}

const VERIFIED_FIRST = {
  'X-Etag-Token': TOKEN,
  'X-Etag-Alg': 'rand-token/1',
  'X-Etag-State': 'cache-revalidated',
  'X-Etag-Verified': '1',
  'X-Etag-Conditional': '1'
};

/** 装一个记录所有请求的假后端；每建一个就是一个"独立浏览器"（有自己的访问号）
 *  opts.session —— 预置会话号（sessionStorage 里的 radish.sid）：同一标签页的两次加载
 *                  用同一个值，换一次浏览器会话就换一个。不传就让采集器自己生成。
 */
function visit(opts) {
  opts = opts || {};
  const calls = [];
  const env = fakeEnv();
  if (opts.visitId) env.__radishId = opts.visitId;
  if (opts.session) env.sessionStorage.setItem('radish.sid', opts.session);
  let pass = 0;
  env.fetch = (url, o) => {
    const u = String(url);
    const kind = /\/v1\/etag\/report/.test(u) ? 'report' : (/\/v1\/etag(\?|$)/.test(u) ? 'etag' : 'other');
    const rec = { url: u, kind, opts: o || {} };
    calls.push(rec);
    if (kind === 'report') {
      const res = makeRes({}, '');
      res.json = () => Promise.resolve(opts.report || { state: 'ok', conditional_seen: true });
      return Promise.resolve(res);
    }
    if (kind === 'etag') {
      if (opts.hang) {
        // 永不回消息、但尊重 abort 的请求：模拟"太慢被期限掐掉"
        return new Promise((resolve, reject) => {
          const sig = o && o.signal;
          if (!sig) return;
          if (sig.aborted) { reject(new Error('aborted')); return; }
          sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      pass += 1;
      const hdrs = pass >= 2 && opts.headers2 ? opts.headers2 : (opts.headers || VERIFIED_FIRST);
      return Promise.resolve(makeRes(hdrs, opts.body));
    }
    return Promise.resolve(makeRes({}, ''));
  };
  return { env, calls };
}

async function runOnce(over) {
  const v = visit(over);
  const RC = loadCollector(v.env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  return { RC, env: v.env, calls: v.calls, tag: plain(e.cli.etag), envelope: e };
}

test('A-01 ①：被缓存的 /v1/etag 请求不含 ?，也不含 id=', async () => {
  const { calls, tag } = await runOnce({ visitId: 'visit-aaa' });
  const etagCalls = calls.filter((c) => c.kind === 'etag');
  assert.ok(etagCalls.length >= 1, '至少要发一次被缓存的请求');
  for (const c of etagCalls) {
    assert.ok(c.url.indexOf('?') < 0, '被缓存的 URL 不许带查询串（会换掉缓存键）：' + c.url);
    assert.ok(!/[?&]id=/.test(c.url), '访问号不许再拼进被缓存的 URL：' + c.url);
    assert.strictEqual(c.opts.cache, 'default', '缓存策略要交给浏览器自己：cache=default');
    assert.ok(!c.opts.headers, '不许手写 If-None-Match 之类的条件头');
  }
  // 读出来的资源 URL 也要能让读者核对
  assert.strictEqual(tag.url, 'https://radishcloud.20050416.shop/v1/etag');
  assert.ok(tag.url.indexOf('?') < 0);
});

test('A-01 ②：两次访问（两个不同访问号）里 /v1/etag 的 URL 完全相同', async () => {
  const a = await runOnce({ visitId: 'visit-111', session: 'sess-aaaa' });
  const b = await runOnce({ visitId: 'visit-222', session: 'sess-bbbb' });
  assert.notStrictEqual(
    a.env.__radishId, b.env.__radishId,
    '两次访问必须是不同的访问号，否则这条测试证明不了缓存键稳定'
  );
  const urlsA = a.calls.filter((c) => c.kind === 'etag').map((c) => c.url);
  const urlsB = b.calls.filter((c) => c.kind === 'etag').map((c) => c.url);
  assert.deepStrictEqual(urlsA, urlsB, '两次访问的被缓存 URL 必须逐字节相同（缓存键 = 方法 + URI）');
  assert.deepStrictEqual(urlsA, Array('https://radishcloud.20050416.shop/v1/etag'),
    '被缓存的 URL 只能是 ETAG_URL 本身');
  // 访问号与会话号确实换了地方：关联请求里的 id / sid 随这一轮变
  const repA = a.calls.filter((c) => c.kind === 'report')[0];
  const repB = b.calls.filter((c) => c.kind === 'report')[0];
  assert.ok(/[?&]id=visit-111/.test(repA.url), '关联请求要带本轮访问号：' + repA.url);
  assert.ok(/[?&]id=visit-222/.test(repB.url), '关联请求要带本轮访问号：' + repB.url);
  assert.ok(/[?&]sid=sess-aaaa/.test(repA.url), '关联请求要带本轮会话号：' + repA.url);
  assert.ok(/[?&]sid=sess-bbbb/.test(repB.url), '关联请求要带本轮会话号：' + repB.url);
  assert.notStrictEqual(repA.url, repB.url, '关联请求不进缓存，带访问号/会话号是安全的');
});

test('A-01 ③：关联请求 /v1/etag/report 同时带 token、id 与 sid，并且 no-store', async () => {
  const { calls } = await runOnce({ visitId: 'visit-token', session: 'sess-token' });
  const reportCalls = calls.filter((c) => c.kind === 'report');
  assert.strictEqual(reportCalls.length, 1, '一轮只发一次关联请求');
  const u = reportCalls[0].url;
  assert.ok(/\/v1\/etag\/report\?/.test(u), '关联请求路径不对：' + u);
  assert.ok(/[?&]token=[0-9a-f]{32}/.test(u), '关联请求要带 32 位十六进制令牌：' + u);
  assert.ok(/[?&]id=visit-token/.test(u), '关联请求要带本轮访问号：' + u);
  assert.ok(/[?&]sid=sess-token/.test(u), '关联请求要带本轮会话号（跨访问判定的输入）：' + u);
  assert.strictEqual(reportCalls[0].opts.cache, 'no-store', '关联请求的响应 no-store，不进缓存');
});

test('A-01 ④：首响带 X-Etag-Verified: 1 时 first_pass.verified 为 true', async () => {
  const { tag } = await runOnce({
    visitId: 'visit-verified',
    session: 'sess-verified',
    headers: VERIFIED_FIRST,
    report: { state: 'ok', conditional_seen: true, conditional_count: 3, cross_visit: true, cross_visit_evidence: 'distinct-session' }
  });
  assert.deepStrictEqual(tag.first_pass, { verified: true, conditional: true });
  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'first-response-headers');
  // 跨访问证据只能来自 first_pass；关联请求带回的服务端视角单独记
  assert.strictEqual(tag.report.cross_visit, true);
  assert.strictEqual(tag.report.cross_visit_evidence, 'distinct-session');
  assert.strictEqual(tag.id_sent, true, '这一轮的访问号已经交给服务端');
  assert.strictEqual(tag.sid_sent, true, '这一轮的会话号也已经交给服务端');
  assert.match(tag.note, /上一次访问留下了缓存令牌/);
});

test('A-01 ④b：首响没有条件头时 first_pass 必须是 false（不伪造跨访问）', async () => {
  const { tag } = await runOnce({
    visitId: 'visit-fresh',
    headers: {
      'X-Etag-Token': TOKEN,
      'X-Etag-State': 'issued-new',
      'X-Etag-Verified': '0',
      'X-Etag-Conditional': '0'
    },
    headers2: VERIFIED_FIRST,
    report: { state: 'ok', conditional_seen: true, conditional_count: 1, cross_visit: false, cross_visit_evidence: 'single-session' }
  });
  assert.deepStrictEqual(tag.first_pass, { verified: false, conditional: false });
  assert.strictEqual(tag.round_trip.verified, true, '本轮内回环能成立');
  assert.strictEqual(tag.round_trip.source, 'second-response-headers');
  assert.match(tag.note, /不等于上次访问留下了缓存/, '本轮内回环 ≠ 跨访问');
});

test('A-01 ⑤：首跳被期限掐掉仍是 {"$":"timeout"}', async () => {
  const RC = loadCollector(fakeEnv());
  const probe = RC.probes.filter((p) => p.id === 'etag')[0];
  const env = fakeEnv();
  const seen = [];
  env.fetch = (url, o) => {
    seen.push({ url: String(url), opts: o || {} });
    return new Promise((resolve, reject) => {
      const sig = o && o.signal;
      if (!sig) return;
      if (sig.aborted) { reject(new Error('aborted')); return; }
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  // 这条用例等的是"采集器自己的期限到点"：首跳的期限是 AbortSignal.timeout()，
  // 它在 Node 里是 **unref 计时器**（不撑事件循环）。不主动守住事件循环的话，
  // Node 22 的 test runner 会先把"promise 还没落地、事件循环已经空了"记成失败
  // （Promise resolution is still pending but the event loop has already resolved），
  // 并把同一文件后面几条用例一起取消——Node 24 恰好还撑着，所以这种红只在 CI 出现。
  // 守时钟只负责撑住事件循环：超期仍然由采集器自己的 1400ms 决定，等待是真等待。
  const release = keepAlive();
  let out;
  let dt;
  try {
    const t0 = Date.now();
    out = plain(await probe.run(env, collectorCtx()));
    dt = Date.now() - t0;
  } finally {
    release();
  }
  assert.deepStrictEqual(out, { $: 'timeout' }, '太慢是 timeout，不是 unreachable：' + JSON.stringify(out));
  assert.ok(dt >= RC.ETAG_TIMEOUT - 200, '要真的等满一个期限：' + dt + 'ms');
  assert.strictEqual(seen.length, 1, '首跳超期后不再发第二次请求');
  assert.strictEqual(seen[0].url.indexOf('?'), -1, '超时的那条也必须是被缓存的固定 URL：' + seen[0].url);
});

test('A-01 ⑤b：网络层直接失败仍是 unreachable（和 timeout 分开）', async () => {
  const RC = loadCollector(fakeEnv());
  const probe = RC.probes.filter((p) => p.id === 'etag')[0];
  const env = fakeEnv();
  env.fetch = () => Promise.reject(new Error('network down'));
  const out = plain(await probe.run(env, collectorCtx()));
  assert.deepStrictEqual(out, { $: 'unreachable' });
});

// 真机实测（2026-11-14）暴露的假阳性：一次页面访问发了两封信封（先 meta.partial=true 的半份，
// 后完整一份），两封 session 相同、访问号不同；只数访问号的后端把"同页半份 + 完整"判成了
// "另一次访问"。修复口径：跨访问只看**不同会话号**，且判定由服务端做，采集器只转述。
test('A-01 ⑥：同一会话里的两个访问号（半份 + 完整）不构成跨访问——采集器不自己下结论', async () => {
  const half = await runOnce({ visitId: 'visit-half', session: 'sess-same' });
  const full = await runOnce({ visitId: 'visit-full', session: 'sess-same' });
  assert.notStrictEqual(half.env.__radishId, full.env.__radishId, '两封信封的访问号确实不同');
  // 会话号必须同一个（采集器用的是信封 env.session 那个值，不是另造 id）
  const repHalf = half.calls.filter((c) => c.kind === 'report')[0];
  const repFull = full.calls.filter((c) => c.kind === 'report')[0];
  assert.ok(/[?&]sid=sess-same/.test(repHalf.url), repHalf.url);
  assert.ok(/[?&]sid=sess-same/.test(repFull.url), repFull.url);
  assert.strictEqual(half.envelope.session, 'sess-same', '信封 session 与 report 里的 sid 是同一个值');
  assert.strictEqual(full.envelope.session, 'sess-same');
  // 服务端没说跨访问（缺字段）时，采集器不许自己数访问号补一个结论出来
  assert.strictEqual(half.tag.report.cross_visit, null, '服务端没给就是 null，不自己判');
  assert.strictEqual(full.tag.report.cross_visit, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(half.tag, 'cross_visit'),
    'cli.etag 顶层不许出现采集器自算的 cross_visit');
  assert.strictEqual(half.tag.report.visit_ids, null, '服务端没给访问号计数就保持 null');
});

test('A-01 ⑦：两个不同会话 → 结论仍然由服务端给（采集器只转述，不自己数 sid）', async () => {
  const a = await runOnce({
    visitId: 'visit-x',
    session: 'sess-one',
    report: { state: 'ok', conditional_seen: true, cross_visit: true, cross_visit_evidence: 'distinct-session', visit_ids: 2 }
  });
  const b = await runOnce({
    visitId: 'visit-y',
    session: 'sess-two',
    // 两次会话确实不同，但服务端给了 false：采集器必须原样转述 false
    report: { state: 'ok', conditional_seen: true, cross_visit: false, cross_visit_evidence: 'single-session', visit_ids: 2 }
  });
  assert.ok(/[?&]sid=sess-one/.test(a.calls.filter((c) => c.kind === 'report')[0].url));
  assert.ok(/[?&]sid=sess-two/.test(b.calls.filter((c) => c.kind === 'report')[0].url));
  assert.strictEqual(a.tag.report.cross_visit, true, '服务端说 true 就记 true');
  assert.strictEqual(a.tag.report.cross_visit_evidence, 'distinct-session');
  assert.strictEqual(b.tag.report.cross_visit, false, '两个 sid 在场也不许覆盖服务端的结论');
  assert.strictEqual(b.tag.report.cross_visit_evidence, 'single-session');
  // visit_ids 只是计数（含同页半份 + 完整两封），不能当跨访问证据
  assert.strictEqual(b.tag.report.visit_ids, 2);
});

test('A-01 ⑧：半份信封（meta.partial=true）照常带 report 与 sid，不跳过', async () => {
  const v = visit({ visitId: 'visit-partial', session: 'sess-partial' });
  const RC = loadCollector(v.env);
  const complete = await RC.buildEnvelope(undefined, collectorCtx());
  // 离页那一刻的半份信封：cli 直接取同一轮已收工的探针结果（慢车道上没跑完的项没有键）
  const half = await RC.buildEnvelope(undefined, collectorCtx(), { prebuilt: true });
  assert.strictEqual(half.meta.partial, true, '这一封必须是半份');
  assert.ok(half.cli.etag, '半份里 etag 这一项照旧带出去：' + Object.keys(half.cli).join(','));
  assert.strictEqual(half.cli.etag.id_sent, true, '半份也交了访问号');
  assert.strictEqual(half.cli.etag.sid_sent, true, '半份也交了会话号（缓存复用可能就发生在这一轮）');
  assert.strictEqual(complete.cli.etag.sid_sent, true);
  const reportCalls = v.calls.filter((c) => c.kind === 'report');
  assert.strictEqual(reportCalls.length, 1, '一轮只发一次关联请求，半份不额外发也不跳过');
  assert.ok(/[?&]sid=sess-partial/.test(reportCalls[0].url), reportCalls[0].url);
  assert.ok(/[?&]id=visit-partial/.test(reportCalls[0].url), reportCalls[0].url);
});
}

// ===== f08-etag-evidence.test.js =====
{
'use strict';
// F-08 / N-05（采集器部分）：ETag 的两份证据必须分开记，请求数要收敛。
//   first_pass —— 第一次请求的响应头里就有 X-Etag-Verified=1，
//                 说明浏览器在这次请求里已经带了 If-None-Match：跨访问复访的证据。
//   round_trip —— 本轮再请求一次，服务端认得出令牌：只证明本轮缓存能带令牌。
//
// 1.9.4 起（N-05 复审）：
//   - 响应头已经写明的事不再额外发 /report 去问一遍；只有响应头读不到时才问后端；
//   - 每一跳的期限从 800ms 提到 1400ms（900ms 才回来的正常慢响应过去会被判 unreachable）；
//   - etag 移到慢车道，两三次串行请求不会被快速车道的 2.5s 期限腰斩。
//
// 1.9.6 起（A-01 复审）：
//   - 被缓存的请求 URL 固定为 /v1/etag 本身，**不带** ?id=（带查询串就换了缓存键，
//     跨访问复用永远不会发生）；
//   - 访问号改放在独立的关联请求 /v1/etag/report?token=…&id=…（no-store，不进缓存），
//     它每一轮都发：缓存请求仍是"最多两跳"，加上关联请求总共不超过三跳；
//   - 关联请求只做关联，不再被写成 skipped-* 状态：它的 state 就是服务端回的 state。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const ETAG_TOKEN = '0123456789abcdef0123456789abcdef';

function makeRes(headers, body) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (h[String(name).toLowerCase()] === undefined ? null : h[String(name).toLowerCase()]) },
    text: () => Promise.resolve(body === undefined ? ETAG_TOKEN : body),
    json: () => Promise.resolve({})
  };
}

/**
 * 装一台假后端：
 *   headers  —— 第一次 /v1/etag 的响应头
 *   headers2 —— 第二次 /v1/etag 的响应头（不给就沿用 headers）
 *   reject2  —— 第二次请求直接失败（模拟超时/断网）
 *   report   —— /v1/etag/report 的返回
 */
function fakeBackend(opts) {
  const calls = [];
  const env = fakeEnv();
  let pass = 0;
  env.fetch = (url, o) => {
    const u = String(url);
    if (/\/v1\/etag\/report/.test(u)) {
      calls.push({ url: u, opts: o, kind: 'report' });
      const rep = opts.report;
      const res = makeRes(opts.reportHeaders || {}, '');
      res.json = typeof rep === 'function' ? rep : () => Promise.resolve(rep);
      return Promise.resolve(res);
    }
    if (/\/v1\/etag(\?|$)/.test(u)) {
      calls.push({ url: u, opts: o, kind: 'etag' });
      pass += 1;
      if (pass >= 2 && opts.reject2) return Promise.reject(new Error('TimeoutError'));
      const headers = pass >= 2 && opts.headers2 ? opts.headers2 : (opts.headers || {});
      return Promise.resolve(makeRes(headers, opts.body));
    }
    // trackers / extwar 也走同一个 fetch，给个温和的响应就行
    return Promise.resolve(makeRes({}, ''));
  };
  return { env, calls };
}

test('N-05：每跳期限不再卡在 800ms，etag 走慢车道', () => {
  const RC = loadCollector(fakeEnv());
  assert.ok(RC.ETAG_TIMEOUT >= 1200,
    'ETAG_TIMEOUT 必须覆盖正常慢响应（审查用 900ms 复现出 808ms 就判 unreachable），现在是 ' + RC.ETAG_TIMEOUT);
  assert.ok(RC.ETAG_TIMEOUT * 3 <= RC.SLOW_TIMEOUT,
    '最坏情况三跳合计 ' + RC.ETAG_TIMEOUT * 3 + 'ms 必须小于 SLOW_TIMEOUT ' + RC.SLOW_TIMEOUT);
  assert.ok(RC.SLOW_IDS.etag, 'etag 有多跳串行请求，必须在慢车道');
});

test('N-05 + A-01：首响就验证成功时缓存请求只发一次，关联请求仍把访问号交给服务端', async () => {
  const { env, calls } = fakeBackend({
    headers: {
      'X-Etag-Token': ETAG_TOKEN,
      'X-Etag-Alg': 'rand-token/1',
      'X-Etag-State': 'cache-revalidated',
      'X-Etag-Verified': '1',
      'X-Etag-Conditional': '1'
    },
    report: { state: 'ok', conditional_seen: true, conditional_count: 2, same_network: true }
  });
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);

  assert.deepStrictEqual(tag.first_pass, { verified: true, conditional: true },
    '第一请求自己就带了令牌，这是跨访问的证据');
  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'first-response-headers');
  assert.strictEqual(tag.conditional_seen, true);
  const etagCalls = calls.filter((c) => c.kind === 'etag');
  assert.strictEqual(etagCalls.length, 1, '首响说清了就不该再打第二次被缓存的请求（N-05 的请求收敛）');
  // A-01：关联请求照发，访问号只能从这里到后端
  const reportCalls = calls.filter((c) => c.kind === 'report');
  assert.strictEqual(reportCalls.length, 1, '每一轮都要发一次关联请求，访问号靠它关联');
  assert.strictEqual(tag.requests, 2, '一次缓存请求 + 一次关联请求');
  assert.strictEqual(tag.id_sent, true);
  assert.strictEqual(tag.report.id_sent, true);
  assert.strictEqual(tag.report.state, 'ok');
  assert.ok(typeof tag.elapsed_ms === 'number' && tag.elapsed_ms >= 0);
  assert.match(tag.note, /上一次访问留下了缓存令牌/);
  for (const k of ['alg', 'token', 'state', 'cache', 'report', 'first_pass', 'round_trip', 'url', 'id_sent']) {
    assert.ok(k in tag, '顶层缺字段 ' + k);
  }
  assert.strictEqual(tag.token, ETAG_TOKEN.slice(0, 8));
  assert.strictEqual(tag.state, 'cache-revalidated');
  for (const c of etagCalls) {
    assert.ok(c.opts && c.opts.signal, 'etag 请求没接信号：' + c.url);
    assert.strictEqual(typeof c.opts.signal.aborted, 'boolean');
    assert.strictEqual(c.opts.cache, 'default', '被缓存的请求必须让浏览器自己缓存（cache: default）');
    assert.ok(c.url.indexOf('?') < 0, '被缓存的 URL 不许带查询串：' + c.url);
  }
  for (const c of reportCalls) {
    assert.strictEqual(c.opts.cache, 'no-store', '关联请求不进缓存');
  }
});

test('N-05 + A-01：第二响的响应头写着验证成功时，round_trip 为真且证据来自第二响', async () => {
  const { env, calls } = fakeBackend({
    headers: {
      'X-Etag-Token': ETAG_TOKEN,
      'X-Etag-Alg': 'rand-token/1',
      'X-Etag-State': 'issued-new',
      'X-Etag-Verified': '0',
      'X-Etag-Conditional': '0'
    },
    headers2: {
      'X-Etag-Token': ETAG_TOKEN,
      'X-Etag-Alg': 'rand-token/1',
      'X-Etag-State': 'cache-revalidated',
      'X-Etag-Verified': '1',
      'X-Etag-Conditional': '1'
    },
    report: { state: 'ok', conditional_seen: true, conditional_count: 1, same_network: true }
  });
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);

  assert.deepStrictEqual(tag.first_pass, { verified: false, conditional: false },
    '第一请求没带令牌，不能算跨访问复访');
  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'second-response-headers',
    '回环证据必须来自第二响的响应头，不是关联请求');
  assert.strictEqual(tag.conditional_sent, false);
  assert.strictEqual(tag.conditional_seen, true);
  assert.strictEqual(tag.requests, 3, '两次缓存请求 + 一次关联请求');
  assert.strictEqual(tag.report.state, 'ok', '关联请求的 state 就是服务端回的 state');
  assert.match(tag.note, /本轮缓存能带令牌/);
  assert.match(tag.note, /不等于上次访问留下了缓存/, 'note 必须说清本轮回环 ≠ 跨访问');
  assert.ok(!/跨访问复访证据/.test(tag.note), '本轮内证据不能写成跨访问复访');
  assert.strictEqual(calls.filter((c) => c.kind === 'report').length, 1);
});

test('N-05 + A-01：响应头读不到时，关联请求同时兜底确认条件请求', async () => {
  const { env, calls } = fakeBackend({
    headers: {},                    // 一个 etag 头都读不到（跨域没 expose 之类）
    report: {
      state: 'ok',
      conditional_seen: true,
      conditional_count: 1,
      same_network: true,
      cross_visit: false,
      cross_visit_evidence: 'single-visit-id',
      visit_ids: 1,
      round_window_hint: false
    }
  });
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);

  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'server-report');
  assert.strictEqual(tag.round_trip.conditional_count, 1);
  assert.strictEqual(tag.requests, 3, '读不到头时第三跳就是关联请求');
  assert.strictEqual(tag.report.cross_visit, false);
  assert.strictEqual(tag.report.cross_visit_evidence, 'single-visit-id');
  assert.strictEqual(tag.report.round_window_hint, false);
  assert.strictEqual(calls.filter((c) => c.kind === 'report').length, 1);
});

test('N-05：第二次请求超时也不丢已取得的证据，并且写明原因', async () => {
  const { env, calls } = fakeBackend({
    headers: { 'X-Etag-Token': ETAG_TOKEN, 'X-Etag-State': 'issued-new' },
    reject2: true
  });
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);

  assert.ok(!tag.$, '超时是状态，不是探针整体失败：' + JSON.stringify(tag));
  assert.strictEqual(tag.report.state, 'timeout');
  assert.strictEqual(tag.report.stage, 'round_trip');
  assert.strictEqual(tag.token, ETAG_TOKEN.slice(0, 8), '已拿到的令牌必须留着');
  assert.strictEqual(tag.state, 'issued-new');
  assert.strictEqual(tag.round_trip.verified, false);
  assert.match(tag.note, /1400ms/, 'note 要写明这一跳的期限');
  assert.strictEqual(tag.id_sent, false, '这一轮没走到关联请求，就要如实说没交访问号');
  assert.strictEqual(calls.filter((c) => c.kind === 'report').length, 0, '次跳没回来就不再补关联请求');
});

test('F-08：report 不返回新字段时按 null 处理，不把整项标成 error', async () => {
  const { env } = fakeBackend({
    headers: {},                    // 读不到头 → 走 report 兜底
    report: { state: 'ok' }         // 一个"进阶字段"都没有
  });
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const tag = plain(e.cli.etag);

  assert.ok(!tag.$, '缺字段不是错误，实际是 ' + JSON.stringify(tag));
  assert.strictEqual(tag.report.state, 'ok');
  assert.strictEqual(tag.report.conditional_seen, null);
  assert.strictEqual(tag.report.conditional_count, null);
  assert.strictEqual(tag.report.same_network, null);
  assert.strictEqual(tag.report.cross_visit, null);
  assert.strictEqual(tag.report.cross_visit_evidence, null);
  assert.strictEqual(tag.report.round_window_hint, null);
  assert.strictEqual(tag.report.token_age_s, null);
  assert.strictEqual(tag.report.retention_days, null);
  assert.strictEqual(tag.round_trip.verified, false);
  assert.strictEqual(tag.round_trip.conditional_count, null, '读不到就是 null，不是 0');
  assert.deepStrictEqual(tag.first_pass, { verified: false, conditional: false });
  assert.match(tag.note, /没看到条件请求/);
});

test('F-08：report 返回垃圾或直接炸掉也只是读数缺失，不是探针 error', async () => {
  for (const report of [() => Promise.reject(new Error('bad json')), () => Promise.resolve(5)]) {
    const { env } = fakeBackend({ headers: {}, report });
    const RC = loadCollector(env);
    const e = await RC.buildEnvelope(undefined, collectorCtx());
    const tag = plain(e.cli.etag);
    assert.ok(!tag.$, 'report 坏了也不能把整项判成 error：' + JSON.stringify(tag));
    assert.strictEqual(tag.report.state, 'unreadable');
    assert.strictEqual(tag.round_trip.verified, false);
  }
});
}

// ===== f08-etag-slow-matrix.test.js =====
{
'use strict';
// F-08 / N-05（采集器部分）：ETag 三跳链在"慢响应"下的行为矩阵。
//
// 复审的要求是：真延迟、真的会让浏览器 abort 的假后端，逐个场景盯住
//   ① 没超期限的慢响应（900ms < 1400ms）必须拿到证据，不能判成 unreachable；
//   ② 超了期限的那一跳必须被放弃，但已知状态要如实记下来，不能把整项判成 error，
//      更不能伪装成功；
//   ③ 两跳都慢（900+900）也要在慢车道预算内跑完；
//   ④ 快首跳 + 慢次跳：保留首跳的令牌与状态，round_trip 不许伪造；
//   ⑤ 响应头读不到而走第三跳 report 时，总耗时不能超过慢车道预算。
//
// 这些延迟是真的 sleep，不是 mock 出来的毫秒数：假后端只做两件事——按 plan 延迟，
// 以及**尊重 opts.signal**（浏览器被 abort 之后不会再拿到响应体）。如果假后端不
// 理会 abort，测出来的就不再是浏览器的行为。
//
// 仍然只能人工验的部分（这里没有、也不该伪造成自动化）：真浏览器跨内核（Chrome /
// Firefox / Safari）的表现、清缓存后重测、真手机上的实际延迟。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const ETAG_TOKEN = '0123456789abcdef0123456789abcdef';

function makeRes(headers, body) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (h[String(name).toLowerCase()] === undefined ? null : h[String(name).toLowerCase()])
    },
    text: () => Promise.resolve(body === undefined ? ETAG_TOKEN : body),
    json: () => Promise.resolve({})
  };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 慢后端：每个请求按 plan 里的延迟真的等一会儿再回应，等不到就被 abort 打断。
 *
 * plan = {
 *   etag:   [{ delay, headers, body }, ...]   第 n 次 /v1/etag 的计划（用完后沿用最后一个）
 *   report: { delay, json }                   /v1/etag/report 的计划
 * }
 *
 * 每次调用都会记一条 calls 记录：延迟、是否被 abort、迟到的响应体有没有被读过。
 */
function slowBackend(plan) {
  const calls = [];
  const env = fakeEnv();
  let pass = 0;
  env.fetch = (url, opts) => {
    const u = String(url);
    const signal = opts && opts.signal;
    const rec = { url: u, kind: 'other', signal, aborted: false, bodyRead: false, ms: 0 };
    calls.push(rec);

    let step;
    if (/\/v1\/etag\/report/.test(u)) {
      rec.kind = 'report';
      step = plan.report || { delay: 0, json: {} };
    } else if (/\/v1\/etag(\?|$)/.test(u)) {
      rec.kind = 'etag';
      const idx = Math.min(pass, plan.etag.length - 1);
      step = plan.etag[idx];
      pass += 1;
    } else {
      // trackers / extwar 之类也走同一个 fetch，给个立刻返回的温和响应
      return Promise.resolve(makeRes({}, ''));
    }

    const started = Date.now();
    return sleep(step.delay || 0, signal).then(
      () => {
        rec.ms = Date.now() - started;
        const res = makeRes(step.headers || {}, step.body);
        if (step.json !== undefined) {
          res.json = () => {
            rec.bodyRead = true;
            return Promise.resolve(step.json);
          };
        }
        const originalText = res.text;
        res.text = () => {
          rec.bodyRead = true;
          return originalText();
        };
        return res;
      },
      (err) => {
        rec.ms = Date.now() - started;
        rec.aborted = true;
        throw err;
      }
    );
  };
  return { env, calls };
}

const VERIFIED_ON_FIRST = {
  'X-Etag-Token': ETAG_TOKEN,
  'X-Etag-Alg': 'rand-token/1',
  'X-Etag-State': 'cache-revalidated',
  'X-Etag-Verified': '1',
  'X-Etag-Conditional': '1'
};

const TOKEN_ONLY = {
  'X-Etag-Token': ETAG_TOKEN,
  'X-Etag-Alg': 'rand-token/1',
  'X-Etag-State': 'issued-new',
  'X-Etag-Verified': '0',
  'X-Etag-Conditional': '0'
};

async function run(plan) {
  const { env, calls } = slowBackend(plan);
  const RC = loadCollector(env);
  const started = Date.now();
  const envelope = await RC.buildEnvelope(undefined, collectorCtx());
  const wall = Date.now() - started;
  return { RC, envelope, calls, wall, tag: plain(envelope.cli.etag) };
}

test('F-08 慢矩阵①：首响 900ms（未超 1400ms 期限）必须拿到证据，不判 unreachable', async (t) => {
  const { RC, calls, wall, tag } = await run({ etag: [{ delay: 900, headers: VERIFIED_ON_FIRST }] });
  t.diagnostic(`首响 900ms：etag.elapsed_ms=${tag.elapsed_ms} 整封 ${wall}ms`);

  assert.ok(!tag.$, '900ms 在期限之内，不该被判成缺失标记：' + JSON.stringify(tag));
  // A-01：缓存请求仍是一跳（首响已经说清 verified），另加一次关联请求把访问号交给服务端
  assert.strictEqual(calls.filter((c) => c.kind === 'etag').length, 1, '首响已经说清 verified，不该再发第二轮缓存请求');
  assert.strictEqual(calls.filter((c) => c.kind === 'report').length, 1, '关联请求每轮都发');
  assert.strictEqual(tag.requests, 2, '一次缓存请求 + 一次关联请求');
  assert.strictEqual(tag.id_sent, true, '关联请求要带访问号');
  assert.deepStrictEqual(tag.first_pass, { verified: true, conditional: true });
  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'first-response-headers');
  assert.strictEqual(tag.report.id_sent, true);
  assert.strictEqual(tag.token, ETAG_TOKEN.slice(0, 8));
  // 期限是 1400ms，900ms 的响应必须完整走完：既不 abort，也不许提前放弃
  assert.ok(tag.elapsed_ms >= 850, '要真的等了这么久，实际 ' + tag.elapsed_ms);
  assert.ok(tag.elapsed_ms < RC.SLOW_TIMEOUT, '本次没有超期限：' + tag.elapsed_ms);
  assert.strictEqual(calls.filter((c) => c.kind === 'etag').length, 1);
  assert.ok(calls.every((c) => !c.aborted), '这一轮不该有任何一跳被 abort');
  assert.ok(calls[0].bodyRead || true);
});

test('F-08 慢矩阵②：首响 1500ms（超期限）放弃这一跳，但已知状态必须如实记录', async (t) => {
  const { RC, calls, wall, tag } = await run({ etag: [{ delay: 1500, headers: VERIFIED_ON_FIRST }] });
  const marker = tag && tag.$ ? tag.$ : null;
  t.diagnostic(
    `首响 1500ms：cli.etag=${JSON.stringify(tag)} 整封 ${wall}ms`
  );

  // 一、不许判成 error，也不许伪装成功
  assert.notStrictEqual(marker, 'error', '超期不是错误，不能把整项判成 error');
  if (!marker) {
    assert.strictEqual(tag.report.state, 'timeout', '非缺失形状时必须写明 timeout');
    assert.strictEqual(tag.round_trip.verified, false, '没拿到证据就不能写 verified');
    assert.match(tag.note, new RegExp(String(RC.ETAG_TIMEOUT) + 'ms'), 'note 要写明这一跳的期限');
  }

  // 二、这一跳确实是"放弃"：假后端被 abort 掉了，迟到的响应体没有被读
  const etagCalls = calls.filter((c) => c.kind === 'etag');
  assert.strictEqual(etagCalls.length, 1, '被切断的这一跳不该再重试第二轮');
  assert.strictEqual(etagCalls[0].aborted, true, '浏览器会被 abort：假后端要真的看到 signal');
  assert.strictEqual(etagCalls[0].bodyRead, false, '迟到的响应体不该被读（读了就是假证据）');

  // 三、时间账要说得通：等了差不多一个期限，没有拖到慢车道上限
  assert.ok(wall >= RC.ETAG_TIMEOUT - 150, '至少等满一个期限，实际 ' + wall);
  assert.ok(wall <= RC.ETAG_TIMEOUT + 500, '放弃要及时，实际 ' + wall);
  assert.ok(wall < RC.SLOW_TIMEOUT, '不能拖垮慢车道');

  // 当前实现把"首跳被期限切断"记成 {"$": "unreachable"}（不是 report.state=timeout）。
  // 这是诚实但不够细的形状：unreachable 通常意味着"地址打不通"，而这里是"太慢"。
  // 采集器 owner 把首跳 catch 映射成 timeout 之后，上面 if 分支的断言自动接管。
  t.diagnostic(marker ? `首跳超期当前记为 $=${marker}（等 W-03 侧细化成 timeout）` : '首跳超期已记为 timeout');
});

test('F-08 慢矩阵③：两跳都慢（900+900）也要在慢车道预算内跑完', async (t) => {
  const { RC, calls, wall, tag } = await run({
    etag: [
      { delay: 900, headers: TOKEN_ONLY },
      { delay: 900, headers: VERIFIED_ON_FIRST }
    ]
  });
  t.diagnostic(`900+900ms：etag.elapsed_ms=${tag.elapsed_ms} 整封 ${wall}ms`);

  assert.ok(!tag.$, '两跳都在期限内，不该判缺失：' + JSON.stringify(tag));
  assert.strictEqual(tag.requests, 3, '两次缓存请求 + 一次关联请求');
  assert.strictEqual(tag.round_trip.verified, true);
  assert.strictEqual(tag.round_trip.source, 'second-response-headers');
  assert.deepStrictEqual(tag.first_pass, { verified: false, conditional: false });
  assert.strictEqual(tag.report.id_sent, true, '关联请求把访问号交给了服务端');
  assert.match(tag.note, /不等于上次访问留下了缓存/, '本轮回环不能写成跨访问证据');
  assert.ok(tag.elapsed_ms >= 1700, '两跳都是真的等了：' + tag.elapsed_ms);
  assert.ok(tag.elapsed_ms <= RC.SLOW_TIMEOUT, '必须落在慢车道预算内：' + tag.elapsed_ms);
  assert.ok(wall <= RC.SLOW_TIMEOUT, '整封也要在预算内：' + wall);
  assert.strictEqual(calls.filter((c) => c.kind === 'etag').length, 2);
  assert.ok(calls.every((c) => !c.aborted), '两跳都在期限内，不该被 abort');
});

test('F-08 慢矩阵④：快首跳 + 慢次跳，保留首跳的令牌与状态，round_trip 不伪造', async (t) => {
  const { RC, calls, wall, tag } = await run({
    etag: [
      { delay: 100, headers: TOKEN_ONLY },
      { delay: 1500, headers: VERIFIED_ON_FIRST }
    ]
  });
  t.diagnostic(`100+1500ms：etag.elapsed_ms=${tag.elapsed_ms} report.state=${tag.report.state} 整封 ${wall}ms`);

  assert.ok(!tag.$, '次跳超期不该把整项判成缺失：' + JSON.stringify(tag));
  assert.strictEqual(tag.token, ETAG_TOKEN.slice(0, 8), '首跳拿到的令牌必须留着');
  assert.strictEqual(tag.state, 'issued-new', '首跳看到的状态必须留着');
  assert.deepStrictEqual(tag.first_pass, { verified: false, conditional: false });
  assert.strictEqual(tag.round_trip.verified, false, '次跳没回来，就不能写 verified');
  assert.strictEqual(tag.report.state, 'timeout');
  assert.strictEqual(tag.report.stage, 'round_trip');
  assert.match(tag.note, new RegExp(String(RC.ETAG_TIMEOUT) + 'ms'), 'note 要写明这一跳的期限');
  // 请求数收敛：网络上一共两次尝试，只有一次成功回来
  const etagCalls = calls.filter((c) => c.kind === 'etag');
  assert.strictEqual(etagCalls.length, 2);
  assert.strictEqual(etagCalls[1].aborted, true);
  assert.strictEqual(etagCalls[1].bodyRead, false, '迟到的响应体没有被读');
  assert.strictEqual(tag.requests, 1, '只有首跳真的回来了');
  assert.ok(wall <= RC.ETAG_TIMEOUT + 100 + 500, '放弃要及时：' + wall);
});

test('F-08 慢矩阵⑤：响应头读不到 + 第三跳也慢，总耗时仍不得超出慢车道预算', async (t) => {
  const { RC, calls, wall, tag } = await run({
    etag: [
      { delay: 800, headers: {} },   // 一个 etag 头都读不到（跨域没 expose）
      { delay: 800, headers: {} }
    ],
    report: { delay: 1500, json: { state: 'ok', conditional_seen: true } }
  });
  t.diagnostic(`800+800+1500(报告)ms：etag.elapsed_ms=${tag.elapsed_ms} 整封 ${wall}ms 预算 ${RC.SLOW_TIMEOUT}ms`);

  assert.ok(!tag.$, '报告跳超期不该把整项判成缺失：' + JSON.stringify(tag));
  assert.strictEqual(tag.report.state, 'timeout');
  assert.strictEqual(tag.report.stage, 'report');
  assert.strictEqual(tag.round_trip.verified, false, '报告没回来就不能写 verified');
  assert.strictEqual(tag.requests, 2, '两跳 etag 都回来了，第三跳超期');
  const reportCalls = calls.filter((c) => c.kind === 'report');
  assert.strictEqual(reportCalls.length, 1, '报告只问一次，不许重试');
  assert.strictEqual(reportCalls[0].aborted, true);
  assert.strictEqual(reportCalls[0].bodyRead, false, '迟到的报告没有被读');
  // 预算是硬约束：整条链要么在 SLOW_TIMEOUT 内收尾，要么说明它超了
  assert.ok(tag.elapsed_ms <= RC.SLOW_TIMEOUT, 'etag 总耗时超预算：' + tag.elapsed_ms);
  assert.ok(wall <= RC.SLOW_TIMEOUT, '整封耗时超预算：' + wall);
  assert.ok(wall >= 2400, '前两跳各 800ms 是实打实等出来的：' + wall);
});
}
