'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');
const IDS = require('./ids.json');

const CLIENT_FILLED_EXTRA = ['edge', 'ch', 'proto']; // edge 来自 trace 的 colo、ch 来自 hints、proto 来自 trace 的 http/tls

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
  assert.strictEqual(e.meta.collector, 'radish-1.0.1');
  assert.ok(!('srv' in e), '请求体不应包含 srv');
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(e.id, /^[0-9a-f-]{30,}$|^r[0-9a-f]+$/);
});

test('cli 覆盖全部客户端项（105 个），且没有不认识的多余键', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const expected = expectedClientIds();
  const lack = expected.filter(id => !(id in e.cli));
  const unknown = Object.keys(e.cli).filter(id => !IDS.all.includes(id));
  assert.deepStrictEqual(lack, [], '缺少的探测项');
  assert.deepStrictEqual(unknown, [], '不在 124 项清单里的键');
  assert.strictEqual(new Set(expected).size, 105);
  assert.strictEqual(Object.keys(e.cli).length, 105);
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
  assert.strictEqual(Object.keys(e.cli).length, 105);
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
  assert.strictEqual(e.cli.kex, 'X25519MLKEM768');
  assert.strictEqual(e.cli.warp, 'off');
  assert.strictEqual(e.cli.edge, 'LAX');
  assert.deepStrictEqual(plain(e.cli.proto), { http: 'HTTP/2', tls: 'TLSv1.3' });
  assert.ok(Array.isArray(e.cli.ch));
  assert.match(plain(e.cli.ch).join('&'), /sec-ch-ua=/);

  const e2 = await RC.buildEnvelope(undefined, collectorCtx({ trace: {}, hints: { h: {} } }));
  assert.deepStrictEqual(plain(e2.cli.kex), { $: 'unsupported' });
  assert.deepStrictEqual(plain(e2.cli.proto), { $: 'unsupported' });
  assert.ok(!('ch' in e2.cli), '没有 hints 时 ch 不出现，由源站标记');
});
