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
  assert.strictEqual(env.__sent.length, 1);
});

test('sendBeacon 返回 false 时退回 fetch', async () => {
  const env = fakeEnv();
  env.navigator.sendBeacon = () => false;
  let fetched = null;
  env.fetch = (url, init) => { fetched = { url, init }; return Promise.resolve({ ok: true }); };
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

test('G15：DNT/GPC 下不发任何诊断网络请求', async () => {
  for (const over of [{ dnt: '1' }, { gpc: true }]) {
    const env = fakeEnv(over);
    const RC = loadCollector(env);
    const seen = [];
    env.fetch = (u) => { seen.push(String(u)); return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve(''), json: () => Promise.resolve({}) }); };
    await RC.run(env, { endpoint: 'http://x/c', trace: 'http://t/t', hints: 'http://h/h' });
    assert.deepStrictEqual(seen, [], '不该出现 ' + seen.join(','));
    const body = JSON.parse(await env.__sent[0].blob.text());
    assert.deepStrictEqual(body.cli, {});
  }
});

test('G17：不会把自己写的 radish key 当成访客存储留痕', async () => {
  const env = fakeEnv();
  env.sessionStorage.setItem('radish.sid', 'abc');
  env.sessionStorage.setItem('radish.sent', '1');
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(e.cli.traces.sessionStorage, false);
  assert.strictEqual(e.cli.traces.sessionKeys, 0);
  env.sessionStorage.setItem('visitor.thing', '1');
  const e2 = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.strictEqual(e2.cli.traces.sessionStorage, true);
  assert.strictEqual(e2.cli.traces.sessionKeys, 1);
});
