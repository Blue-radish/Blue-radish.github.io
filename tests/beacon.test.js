'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv } = require('./harness');

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
