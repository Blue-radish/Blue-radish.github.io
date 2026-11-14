'use strict';
// 行为护栏（版本、注入、释放、降级）。
// 由 11 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== a05-screens-isextended.test.js =====
{
'use strict';
// A-05（P2）：`screen.isExtended` 缺失被当成单屏。
//
// 缺陷：旧代码 `if (s.isExtended) {...} return {n:1, ext:false}`，于是一个连这个属性都没有的
// `screen = {}` 和明确 `isExtended: false` 得到完全相同的结论 —— 这是没有依据的单屏结论。
//
// 修后的口径（只按"这个属性是不是布尔值"下结论）：
//   true            → 多屏（块数未知，n 留 null，不编数字）
//   false           → 单屏
//   undefined/非布尔 → {"$":"unsupported"}（浏览器没提供这个接口），不是单屏
//   读取抛错         → {"$":"unreadable"}（有接口、读不出来），也不是单屏
// 另外，窗口/屏幕位置读数（screenX / screenY / screen.availLeft / availTop）独立上报，
// 不因为 isExtended 未知就一起丢掉。
//
// 详细的多屏枚举需要访客授权（window.getScreenDetails 的权限弹窗），不在本次范围。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function build(mutate) {
  const env = fakeEnv();
  if (mutate) mutate(env);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return plain(e.cli);
}

test('A-05：isExtended 为 true 时是多屏，但块数未知就留 null', async () => {
  const cli = await build((env) => { env.screen.isExtended = true; });
  assert.deepStrictEqual(cli.screens, { n: null, ext: true, basis: 'isExtended' });
});

test('A-05：isExtended 为 false 时才是单屏', async () => {
  const cli = await build((env) => { env.screen.isExtended = false; });
  assert.deepStrictEqual(cli.screens, { n: 1, ext: false, basis: 'isExtended' });
});

test('A-05：screen 上根本没有 isExtended 时是 unknown，不是单屏', async () => {
  const cli = await build((env) => {
    env.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 };
  });
  assert.deepStrictEqual(cli.screens, { $: 'unsupported' },
    '缺属性不能推出 ext=false / n=1：' + JSON.stringify(cli.screens));
});

test('A-05：isExtended 是非布尔值（null / 0 / "x"）时同样是 unknown', async () => {
  for (const raw of [null, 0, 'yes', {}, []]) {
    const cli = await build((env) => { env.screen.isExtended = raw; });
    assert.deepStrictEqual(cli.screens, { $: 'unsupported' }, 'isExtended=' + JSON.stringify(raw));
  }
});

test('A-05：读 isExtended 抛错时是 unreadable，不当成 false', async () => {
  const cli = await build((env) => {
    env.screen = { width: 1920, height: 1080 };
    Object.defineProperty(env.screen, 'isExtended', {
      get() { throw new Error('SecurityError: not allowed'); }
    });
  });
  assert.deepStrictEqual(cli.screens, { $: 'unreadable' },
    '读取失败是 unreadable，不是单屏：' + JSON.stringify(cli.screens));
});

test('A-05：窗口位置读数独立上报，isExtended 未知也不丢', async () => {
  const cli = await build((env) => {
    env.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 };
    env.screenX = 1920;     // 副屏：主屏右侧
    env.screenY = 0;        // 0 是合法值，必须保留
  });
  assert.deepStrictEqual(cli.screens, { $: 'unsupported' });
  assert.strictEqual(cli.win.sx, 1920, 'screenX 要独立上报：' + JSON.stringify(cli.win));
  assert.strictEqual(cli.win.sy, 0, '0 是合法读数，不能被当成"没读到"');
  // 窗口自身的读数照旧
  assert.strictEqual(cli.win.iw, 1920);
  assert.strictEqual(cli.win.ow, 1920);
});

test('A-05：availLeft / availTop 有就给（Firefox/Safari），没有就不编', async () => {
  const withAvail = await build((env) => {
    env.screen.availLeft = -1920;
    env.screen.availTop = 27;
    env.screenX = -1920;
  });
  assert.strictEqual(withAvail.win.al, -1920);
  assert.strictEqual(withAvail.win.at, 27);

  const withoutAvail = await build();
  assert.ok(!('al' in withoutAvail.win), '没有这个属性就别写一个 0 出来');
  assert.ok(!('at' in withoutAvail.win));
});

test('A-05：没有 screen 对象时整项是 unsupported，win 仍照常报', async () => {
  const cli = await build((env) => { delete env.screen; });
  assert.deepStrictEqual(cli.screens, { $: 'unsupported' });
  assert.strictEqual(cli.win.iw, 1920);
});
}

// ===== a06-worker-finish.test.js =====
{
'use strict';
// A-06（P2）：Worker 超时与错误路径不释放资源。
//
// 缺陷：旧实现只有 onmessage 成功路径做 `terminate()` / `revokeObjectURL()`。用永不回消息的
// Worker 替身复现：2 秒后结果是 timeout，但 terminate 与 revokeObjectURL 两项计数都是 0
// —— Worker 线程和 blob URL 就这么漏着。构造抛错、postMessage 抛错、onerror 也都没有收尾。
//
// 修法：一个幂等的 finish()（清定时器 → 摘事件 → terminate() → revokeObjectURL()），
// 五条路径全部走它，重复调用不产生第二次副作用。
//
// 已知范围：`new Worker(url)` 抛错这条路径只有 blob URL 已经建出来了，没有 Worker 实例可
// terminate（terminate 计数必然是 0，物理上不存在实例）。所以那条路径断言 revoke ≥ 1、
// terminate = 0，并要求重复收尾不双计；其余四条断言 terminate 与 revoke 都 ≥ 1。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

/** 假 Worker：行为由 plan 决定，同时记录 terminate / revoke 次数 */
function workerEnv(plan) {
  plan = plan || {};
  const stats = { created: 0, terminate: 0, post: 0, revoke: 0, revokedUrls: [], last: null };
  const env = fakeEnv();
  env.Blob = function FakeBlob(parts, opts) { this.parts = parts; this.type = opts && opts.type; };
  env.URL = {
    createObjectURL() { stats.created += 1; return 'blob:radish-' + stats.created; },
    revokeObjectURL(u) { stats.revoke += 1; stats.revokedUrls.push(u); }
  };
  env.Worker = function FakeWorker(url) {
    stats.url = url;
    stats.last = this;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    if (plan.throwOnConstruct) throw new Error('SecurityError: blocked by CSP');
    stats.instance = this;
  };
  env.Worker.prototype.terminate = function () {
    stats.terminate += 1;
    this.terminated = true;
  };
  env.Worker.prototype.postMessage = function (v) {
    stats.post += 1;
    if (plan.throwOnPost) throw new Error('InvalidStateError: worker is gone');
    if (plan.onPost) plan.onPost(stats.instance, stats, env);
    return undefined;
  };
  return { env, stats };
}

async function runWorker(plan) {
  const { env, stats } = workerEnv(plan);
  const RC = loadCollector(env);
  const probe = RC.probes.filter((p) => p.id === 'worker')[0];
  assert.ok(probe, 'worker 探针必须存在');
  const t0 = Date.now();
  const out = plain(await probe.run(env, collectorCtx()));
  return { RC, env, stats, out, dt: Date.now() - t0 };
}

test('A-06 ①：成功路径 terminate 与 revokeObjectURL 各一次', async () => {
  const { env, stats, out } = await runWorker({
    onPost: (w, s, e) => {
      w.onmessage({
        data: {
          ua: e.navigator.userAgent,
          langs: e.navigator.languages.slice(),
          platform: e.navigator.platform,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null
        }
      });
    }
  });
  assert.strictEqual(stats.terminate, 1, 'terminate 必须被调用一次');
  assert.strictEqual(stats.revoke, 1, 'blob URL 必须被释放一次');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.uaSame, true);
  // A-06 顺带补的四项：主线程与 Worker 内各记一份，并给出是否一致
  assert.strictEqual(out.basis, 'worker-vs-main');
  assert.strictEqual(out.langsSame, true);
  assert.strictEqual(out.platformSame, true);
  assert.ok(typeof out.tzSame === 'boolean', '时区一致性要能读：' + JSON.stringify(out));
  assert.deepStrictEqual(out.main.langs, env.navigator.languages.slice());
  assert.deepStrictEqual(out.worker.langs, env.navigator.languages.slice());
});

test('A-06 ②：Worker 永不回消息 → 2s 后 timeout，但两项清理计数都不为 0', async () => {
  const { RC, stats, out, dt } = await runWorker({ onPost: () => { } });
  assert.deepStrictEqual(out, { $: 'timeout' });
  assert.ok(dt >= 1800 && dt < 4000, '按自己的 2s 期限收工，实际 ' + dt + 'ms');
  assert.strictEqual(stats.terminate, 1, '超时路径必须 terminate，不能是 0');
  assert.strictEqual(stats.revoke, 1, '超时路径必须 revokeObjectURL，不能是 0');
  assert.ok(RC.PROBE_TIMEOUT > 2000, '这一项的 2s 期限要短于快速车道的整体期限');
});

test('A-06 ③：onerror → error，并且同样收尾', async () => {
  const { stats, out } = await runWorker({
    onPost: (w) => { if (w.onerror) w.onerror(new Error('worker script failed')); }
  });
  assert.deepStrictEqual(out, { $: 'error' });
  assert.strictEqual(stats.terminate, 1);
  assert.strictEqual(stats.revoke, 1);
});

test('A-06 ④：new Worker 抛错 → unreachable 之外的状态，blob URL 仍要释放', async () => {
  const { stats, out } = await runWorker({ throwOnConstruct: true });
  assert.deepStrictEqual(out, { $: 'unsupported' });
  assert.strictEqual(stats.created, 1, 'blob URL 已经建出来了，就必须有对应的 revoke');
  assert.strictEqual(stats.revoke, 1, '构造失败也要释放 blob URL（这是漏得最隐蔽的一条）');
  // 没有 Worker 实例可 terminate：这条路径 terminate 必然是 0，文档里写清
  assert.strictEqual(stats.terminate, 0);
});

test('A-06 ⑤：postMessage 抛错 → error，并且同样收尾', async () => {
  const { stats, out } = await runWorker({ throwOnPost: true });
  assert.deepStrictEqual(out, { $: 'error' });
  assert.strictEqual(stats.terminate, 1);
  assert.strictEqual(stats.revoke, 1);
});

test('A-06 ⑥：finish 幂等 —— 迟到的回调不会把 terminate/revoke 记两次', async () => {
  // 先超时收尾，再让 Worker 迟到地回消息：第二遍必须什么都做不了
  const { stats } = await runWorker({
    onPost: (w, s) => {
      setTimeout(() => {
        if (w.onmessage) w.onmessage({ data: { ua: 'late', langs: [], platform: null, tz: null } });
        s.afterTimeout = true;
      }, 2300);
    }
  });
  // 探针 2s 已经 resolve（timeout），这里等迟到的回调真的跑过
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(stats.terminate, 1, '重复 finish 不许二次 terminate，实际 ' + stats.terminate);
  assert.strictEqual(stats.revoke, 1, '重复 finish 不许二次 revoke，实际 ' + stats.revoke);
});

test('A-06 ⑦：Worker 里的语言/平台与主线程不一致时要如实报 false', async () => {
  const { out } = await runWorker({
    onPost: (w) => {
      w.onmessage({ data: { ua: 'Mozilla/5.0 (X11; Linux x86_64)', langs: ['en-US'], platform: 'Linux x86_64', tz: 'UTC' } });
    }
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.uaSame, false, 'UA 不一致就是 false（不是"未知"）');
  assert.strictEqual(out.langsSame, false);
  assert.strictEqual(out.platformSame, false);
  assert.deepStrictEqual(out.worker.langs, ['en-US']);
});

test('A-06 ⑧：Worker/blob/URL 缺任一项 → unsupported，且不发请求也不报错', async () => {
  const env = fakeEnv();          // harness 的 fakeEnv 没有 Worker
  const RC = loadCollector(env);
  const probe = RC.probes.filter((p) => p.id === 'worker')[0];
  const out = plain(await probe.run(env, collectorCtx()));
  assert.deepStrictEqual(out, { $: 'unsupported' });
});
}

// ===== a07-ext-marks.test.js =====
{
'use strict';
// A-07（P2）：把站点自身的全局量从"扩展证据"里拿出去，并把扩展资源表做成可核对的有限表。
//
// 缺陷一：`ext` 把 `__NEXT_DATA__`（Next.js 自己就写）、`gtag` / `ga` / `dataLayer`（GTM/GA）、
// `__VUE__` / React/Redux devtools 钩子、`fbq`（Meta 像素）这些都算成"装了扩展"。
// 站点自己的脚本产生的痕迹不是扩展证据。
//
// 缺陷二：`extwar` 的目标表原来是裸字符串数组，既没有扩展名、也没有候选路径、也没有版本与
// 验证日期，读者没法核对"这些命中到底是谁、验过没有"。
//
// 口径（两边都要一起读）：`chrome-extension://` 读不到**不等于**扩展没装。
// 未命中 ≠ 未安装，这个注释必须留在结果里。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function build(mutate, ctxOver) {
  const env = fakeEnv();
  if (mutate) mutate(env);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx(ctxOver));
  return plain(e.cli);
}

test('A-07：站点自己也建立的名字不算扩展证据（gtag / __NEXT_DATA__ / dataLayer / fbq）', async () => {
  const cli = await build((env) => {
    // 全部是"站点自身脚本也会建立"的全局量
    env.__NEXT_DATA__ = { props: {} };
    env.gtag = function () { };
    env.ga = function () { };
    env.dataLayer = [];
    env._gaGlobal = {};
    env.fbq = function () { };
    env.__VUE__ = {};
    env.__VUE_DEVTOOLS_GLOBAL_HOOK__ = {};
    env.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    env.__REDUX_DEVTOOLS_EXTENSION__ = {};
    env.passiveEye = {};
  });
  for (const name of ['__NEXT_DATA__', 'gtag', 'ga', 'dataLayer', '_gaGlobal', 'fbq',
    '__VUE__', '__VUE_DEVTOOLS_GLOBAL_HOOK__', '__REACT_DEVTOOLS_GLOBAL_HOOK__',
    '__REDUX_DEVTOOLS_EXTENSION__', 'passiveEye']) {
    assert.ok(cli.ext.indexOf(name) < 0, name + ' 不该出现在扩展证据里：' + JSON.stringify(cli.ext));
  }
  assert.deepStrictEqual(cli.ext, [], '一个只有扩展才建立的量都没有时，ext 必须为空数组');
});

test('A-07：只有扩展才建立的量仍然算（ethereum / grammarly 一族）', async () => {
  const cli = await build((env) => {
    env.ethereum = { isMetaMask: true };
    env.grammarly = {};
  });
  assert.ok(cli.ext.indexOf('ethereum') >= 0, 'window.ethereum 是钱包扩展注入点：' + JSON.stringify(cli.ext));
  assert.ok(cli.ext.indexOf('grammarly') >= 0);
  assert.deepStrictEqual(cli.ext.sort(), ['ethereum', 'grammarly']);
});

test('A-07：两份清单不许重叠（站点痕迹 vs 扩展痕迹）', () => {
  const RC = loadCollector(fakeEnv());
  assert.ok(RC.SITE_GLOBALS.length >= 10, '站点自身可建立的名字要单独列出来备查');
  assert.ok(RC.EXT_MARKS.length >= 2);
  for (const name of RC.EXT_MARKS) {
    assert.strictEqual(RC.SITE_GLOBALS.indexOf(name), -1,
      name + ' 同时出现在两份清单里：读者没法判断它算不算扩展证据');
  }
  assert.ok(RC.SITE_GLOBALS.indexOf('gtag') >= 0);
  assert.ok(RC.SITE_GLOBALS.indexOf('__NEXT_DATA__') >= 0);
});

test('A-07：EXT_TARGETS 是结构化的有限表（扩展名 + id + 候选路径 + 版本 + 验证日期）', () => {
  const RC = loadCollector(fakeEnv());
  assert.ok(Array.isArray(RC.EXT_TARGETS));
  assert.ok(RC.EXT_TARGETS.length > 0 && RC.EXT_TARGETS.length <= 20, '必须是有界清单');
  for (const t of RC.EXT_TARGETS) {
    assert.strictEqual(typeof t, 'object', '目标不能是裸字符串：' + JSON.stringify(t));
    assert.strictEqual(typeof t.extension, 'string', '缺扩展名：' + JSON.stringify(t));
    assert.match(t.id, /^[a-p]{32}$/, '扩展 ID 必须是 32 位 a–p：' + String(t.id));
    assert.ok(Array.isArray(t.paths) && t.paths.length >= 1, '至少一条候选路径：' + JSON.stringify(t));
    for (const p of t.paths) assert.match(p, /^[A-Za-z0-9._\-\/]+$/, '路径不许带协议或查询串：' + p);
    assert.ok('version' in t && 'verified_at' in t, '版本与验证日期必须显式写出来（没验就是 null）');
    assert.strictEqual(t.basis, 'web-accessible-resource');
    if (t.version !== null) assert.match(String(t.verified_at), /^\d{4}-\d{2}-\d{2}$/,
      '写了版本就必须有验证日期：' + JSON.stringify(t));
    if (t.version === null) assert.strictEqual(t.verified_at, null, '没验证过就两个都 null，别编一个日期');
  }
});

test('A-07：extwar 命中时给出可核对的 matched，并且未验版本仍是 null', async () => {
  const seen = [];
  const cli = await build((env) => {
    // 只有 MetaMask 的 manifest 能读到，其它路径一律拒绝（这就是"未命中"）
    env.fetch = (url, opts) => {
      seen.push({ url: String(url), opts: opts || {} });
      const ok = /^chrome-extension:\/\/nkbihfbeogaeaoehlefnkodbefgpgknn\/manifest\.json$/.test(String(url));
      return Promise.resolve(ok ? { ok: true, status: 200, text: () => Promise.resolve('{}') } : { ok: false, status: 0 });
    };
  });
  const w = cli.extwar;
  assert.ok(w && !w.$, 'extwar 该给出结论：' + JSON.stringify(w));
  assert.strictEqual(w.tested, 6, 'tests 要写明试了几个目标');
  assert.deepStrictEqual(w.hits, ['MetaMask']);
  assert.strictEqual(w.matched.length, 1);
  assert.strictEqual(w.matched[0].extension, 'MetaMask');
  assert.strictEqual(w.matched[0].version, null, '没实测验证过版本就必须是 null');
  assert.strictEqual(w.matched[0].verified_at, null);
  assert.strictEqual(w.matched[0].path, 'manifest.json');
  // 表本身随读数走，读者能核对试了谁、试了哪些路径
  assert.strictEqual(w.targets.length, 6);
  for (const t of w.targets) {
    assert.ok(Array.isArray(t.paths) && t.paths.length >= 1);
    assert.ok('version' in t && 'verified_at' in t);
  }
  // 口径注释必须还在
  assert.match(w.note, /拒绝读取该文件不等于扩展没安装/);
  assert.match(w.scope, /未命中不代表没装/);
  // 请求只能打 chrome-extension:// 上的候选路径，不许顺手打别的 origin
  const extCalls = seen.filter((s) => s.url.indexOf('chrome-extension://') === 0);
  assert.ok(extCalls.length >= 6, '每个目标至少试一条路径，实际 ' + extCalls.length);
  for (const s of extCalls) {
    assert.match(s.url, /^chrome-extension:\/\/[a-p]{32}\//, '越界请求：' + s.url);
    assert.strictEqual(s.opts.cache, 'no-store');
  }
});

test('A-07：全部未命中时只报"0 条命中"，不反过来说"没装扩展"', async () => {
  const cli = await build((env) => {
    env.fetch = () => Promise.resolve({ ok: false, status: 0 });
  });
  const w = cli.extwar;
  assert.ok(!w.$, '读不到不是错误，是"0 条命中"：' + JSON.stringify(w));
  assert.deepStrictEqual(w.hits, []);
  assert.deepStrictEqual(w.matched, []);
  assert.strictEqual(w.tested, 6);
  assert.match(w.scope, /命中不代表全部/);
  assert.ok(!('installed' in w) && !('absent' in w), '不许出现"装了/没装"这种读法');
});

test('A-07：没有 fetch 时 extwar 是 unsupported，ext 仍照常给', async () => {
  const cli = await build((env) => { delete env.fetch; });
  assert.deepStrictEqual(cli.extwar, { $: 'unsupported' });
  assert.ok(Array.isArray(cli.ext));
});
}

// ===== a08-h3-retry.test.js =====
{
'use strict';
// A-08（P2）：quicfp 永远拿不到 —— 没有慢车道补测，也没有四种结果的区分。
//
// 缺陷：五项（tcpfp/ja4/tlsfp/h2fp/quicfp）共用第一次 `/fp`。首连通常是 TCP/H2，浏览器要收到
// Alt-Svc 之后的**后续连接**才可能升级到 H3，所以第一次样本里几乎永远没有 quicfp，
// 也分不清"浏览器没升级"、"UDP 被丢"、"其实升级成功了只是首连没赶上"。
//
// 修后口径：
//   - 首样本原样保留，永远是 tcpfp / ja4 / tlsfp / h2fp 的来源（绝不回填）；
//   - quicfp 单独补测：≤ H3_RETRY_MAX（3）次、间隔 H3_RETRY_GAP（700ms），
//     总耗时受 H3_RETRY_BUDGET（4500ms）约束，整封上传的期限一个字没动；
//   - 结果写在 meta.h3，state 区分四态：tcp-only / upgraded / h3-first / udp-blocked，
//     另外 timeout（预算用完，未知）与 proto-unknown（探针没报 proto）两种"不知道"。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const FIRST_FP = {
  proto: 'HTTP/2.0',
  tcp: { os: 'windows', mtu: 1500 },
  tls: { ja4: 'ja4-first', ja3n: 'ja3n-first' },
  http2: { fp: 'm,a,s,p' }
};
const H3_FP = {
  proto: 'HTTP/3.0',
  tcp: { os: 'windows' },
  tls: { ja4: 'ja4-quic', ja3n: 'ja3n-quic' },
  http2: { fp: 'shard-1' }
};

/** 让第一次 /fp 回 first，补测按 plan 依次回（或拒） */
function fpBackend(first, plan) {
  let call = 0;
  const seen = [];
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: (url, ms, fallback) => {
      call += 1;
      seen.push({ url: String(url), ms: ms, fallback: fallback });
      if (call === 1) return Promise.resolve(first);
      const step = plan[Math.min(call - 2, plan.length - 1)];
      return step(url, ms, fallback);
    }
  });
  return { ctx, seen };
}

async function runProbe(plan, first) {
  const { ctx, seen } = fpBackend(first || FIRST_FP, plan);
  const RC = loadCollector(fakeEnv());
  const probe = RC.probes.filter((p) => p.id === 'quicfp')[0];
  assert.ok(probe, 'quicfp 探针必须存在');
  const env = fakeEnv();
  const t0 = Date.now();
  const raw = await probe.run(env, ctx);
  const dt = Date.now() - t0;
  // SKIP（这一项不出现）在信封里是"没有这个键"，测试里也按 null 读
  const value = raw && raw.__radishSkip ? null : (raw === undefined ? null : plain({ v: raw }).v);
  return { RC, value, h3: ctx.cache && ctx.cache.h3, h3p: plain({ v: ctx.cache && ctx.cache.h3 }).v, dt, seen };
}

const reply = (payload) => () => Promise.resolve(payload);
const rejectOnce = () => Promise.reject(new Error('net'));

test('A-08 ①：首连就是 H3 → h3-first，不补测', async () => {
  const { RC, value, h3, seen } = await runProbe([reply(H3_FP)], H3_FP);
  assert.strictEqual(value, 'ja4-quic', 'H3 首样本的 ja4 就是 QUIC 的 ja4');
  assert.strictEqual(h3.state, 'h3-first');
  assert.strictEqual(h3.attempts, 0);
  assert.strictEqual(h3.retries, 0);
  assert.strictEqual(seen.length, 1, '首连是 H3 就不该补测');
  assert.strictEqual(h3.budget_ms, RC.H3_RETRY_BUDGET);
  assert.ok(h3.elapsed_ms <= RC.H3_RETRY_BUDGET);
});

test('A-08 ②：始终 TCP → tcp-only，补测次数与预算都写清楚', async () => {
  const { RC, value, h3, dt } = await runProbe([reply(FIRST_FP)]);
  assert.strictEqual(value, null, '没有 H3 就没有 quicfp（cli 形状不变）');
  assert.strictEqual(h3.state, 'tcp-only');
  assert.strictEqual(h3.attempts, RC.H3_RETRY_MAX, '补测次数要写明');
  assert.ok(h3.attempts <= 3, '不许超过 3 次');
  assert.strictEqual(h3.answered, RC.H3_RETRY_MAX);
  assert.strictEqual(h3.first_proto, 'HTTP/2.0');
  assert.strictEqual(h3.ja4, null);
  assert.ok(h3.elapsed_ms <= RC.H3_RETRY_BUDGET, '整项不许超出补测预算：' + h3.elapsed_ms);
  assert.ok(dt <= RC.H3_RETRY_BUDGET + 800, '实际耗时也要在预算内：' + dt);
  assert.match(h3.note, /都不是 HTTP\/3/);
});

test('A-08 ③：补测中途拿到 H3 → upgraded，且首跳四项不被覆盖', async () => {
  const { RC, value, h3 } = await runProbe([rejectOnce, reply(H3_FP)]);
  assert.strictEqual(value, 'ja4-quic');
  assert.strictEqual(h3.state, 'upgraded');
  assert.strictEqual(h3.attempts, 2);
  assert.strictEqual(h3.answered, 1);
  assert.strictEqual(h3.h3_proto, 'HTTP/3.0');
  assert.strictEqual(h3.first_proto, 'HTTP/2.0', '首跳的 proto 也要留着，便于核对');
  assert.ok(h3.elapsed_ms <= RC.H3_RETRY_BUDGET);
  assert.match(h3.note, /没有被覆盖/);
});

test('A-08 ③b：补测拿到 H3 但信封里首跳的 tcpfp/ja4/h2fp 必须原样', async () => {
  const { ctx } = fpBackend(FIRST_FP, [reply(H3_FP)]);
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.strictEqual(e.cli.tcpfp.os, 'windows');
  assert.strictEqual(e.cli.ja4, 'ja4-first', 'ja4 是首跳那条连接的读数，不能被补测改掉');
  assert.strictEqual(e.cli.tlsfp, 'ja3n-first');
  assert.deepStrictEqual(plain(e.cli.h2fp), { fp: 'm,a,s,p' });
  assert.strictEqual(e.cli.quicfp, 'ja4-quic', '只有 quicfp 来自补测样本');
  assert.strictEqual(e.meta.h3.state, 'upgraded');
});

test('A-08 ④：补测一个响应都收不到 → udp-blocked（H3 路径不可达）', async () => {
  const { RC, value, h3 } = await runProbe([() => Promise.reject(new Error('udp blocked'))]);
  assert.strictEqual(value, null);
  assert.strictEqual(h3.state, 'udp-blocked');
  assert.strictEqual(h3.answered, 0);
  assert.strictEqual(h3.attempts, RC.H3_RETRY_MAX, '三次都试过才下这个结论');
  assert.strictEqual(h3.budget_exhausted, false);
  assert.match(h3.note, /一个响应都没回来/);
});

test('A-08 ⑤：预算是硬约束 —— 用完就收工并如实记 timeout，不拖长整封', async () => {
  // 每次补测都慢到用满自己的期限（这里的替身尊重传进来的 ms，和真 ctx.json 一样）
  const clipped = [];
  const slowUntilDeadline = (url, ms) => {
    clipped.push(ms);
    return new Promise((r) => setTimeout(() => r({ $: 'timeout' }), Math.min(2400, ms)));
  };
  const { RC, value, h3, dt } = await runProbe([slowUntilDeadline]);
  assert.strictEqual(value, null);
  assert.strictEqual(h3.state, 'timeout', '预算用完就是未知，不写成"没升级"');
  assert.strictEqual(h3.budget_exhausted, true);
  assert.strictEqual(h3.answered, 0);
  assert.ok(h3.attempts < RC.H3_RETRY_MAX, '预算不够就不该硬凑满 3 次：' + h3.attempts);
  assert.ok(h3.elapsed_ms <= RC.H3_RETRY_BUDGET + 300, '不许超出补测预算：' + h3.elapsed_ms);
  assert.ok(dt <= RC.H3_RETRY_BUDGET + 600, '整项实际耗时：' + dt);
  // 关键：越到后面，单次期限越是按"预算剩多少"裁剪，而不是固定 2000ms 硬打
  assert.ok(clipped.length >= 2, '至少两次补测：' + JSON.stringify(clipped));
  assert.ok(clipped[clipped.length - 1] < RC.H3_RETRY_TIMEOUT,
    '最后一次补测的期限必须被预算裁剪：' + JSON.stringify(clipped));
  assert.match(h3.note, /未知/);
});

test('A-08 ⑥：探针没报 proto → proto-unknown，不猜也不补测', async () => {
  const noProto = { tcp: { os: 'windows' }, tls: { ja4: 'ja4-first' }, http2: { fp: 'm,a,s,p' } };
  const { RC, value, h3, seen } = await runProbe([reply(H3_FP)], noProto);
  assert.strictEqual(value, null);
  assert.strictEqual(h3.state, 'proto-unknown');
  assert.strictEqual(h3.attempts, 0);
  assert.strictEqual(seen.length, 1);
  assert.ok(RC.H3_RETRY_BUDGET > 0);
});

test('A-08 ⑦：探针整体不可达时 quicfp 仍是共用标记，不写 meta.h3', async () => {
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.reject(new Error('offline'))
  });
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.quicfp), { $: 'unreachable' });
  assert.strictEqual(e.meta.h3, undefined, '连不上是另一件事，不要在这里编 h3 结论');
});

test('A-08 ⑧：补测请求数受上限约束（首样本 + ≤3 次）', async () => {
  const { RC, seen } = await runProbe([reply(FIRST_FP)]);
  assert.strictEqual(seen.length, 1 + RC.H3_RETRY_MAX, '总 /fp 次数 = 首样本 + 补测上限');
  // 第一次是五项共用的首样本（fallback 是 unreachable），补测的 fallback 是 timeout
  for (const s of seen.slice(1)) {
    assert.match(s.url, /\/fp$/, '补测也必须打在 /fp 上：' + s.url);
    assert.ok(s.ms > 0 && s.ms <= RC.H3_RETRY_TIMEOUT, '每次补测都要有自己的期限：' + s.ms);
    assert.deepStrictEqual(plain({ v: s.fallback }), { v: { $: 'timeout' } },
      '补测失败要落成 timeout 标记（和别的探针项一致）');
  }
  assert.deepStrictEqual(plain({ v: seen[0].fallback }), { v: { $: 'unreachable' } },
    '首样本的 fallback 保持原样，没被这一项改过');
});
}

// ===== a11-comment-code-agree.test.js =====
{
'use strict';
// A-11（P3）：代码与注释打架的几处清理。
//
// ① timer 的抖动统计：旧代码取的是**最小**正间隔（`gap < jitter`），注释和字段名却写着
//    "最大间隔"。读的人会按上限理解，后台做分布图也会照注释画。现在两个统计量各给一个
//    名字（minPositiveMs / maxPositiveMs），jitter 保留为兼容字段并真的等于最大值。
// ② 文件头版本号写死成 1.3.3，和 VERSION 常量对不上：现在头注释不写版本号，只说
//    "版本号只有一处：VERSION 常量"。
// ③ 「启动时机 / 并发」注释写的是旧行为（等 load、固定空等 1.2s、每项 2.5s）：现在按
//    实际行为写（文档就绪就跑；16 路快速车道 + 慢车道）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadCollector, fakeEnv, collectorCtx, plain, SRC_PATH } = require('./harness');

const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/** 让 performance.now 按固定步长走：方便断言 min/max 到底取了哪个 */
function steppingEnv() {
  const env = fakeEnv();
  let t = 1000, i = 0;
  env.performance = {
    now() {
      i += 1;
      t += (i % 2 === 0) ? 7 : 1;      // 连续差值是 1 和 7 交替出现
      return t;
    }
  };
  return env;
}

async function timerOf(env) {
  const RC = loadCollector(env);
  const probe = RC.probes.filter((p) => p.id === 'timer')[0];
  assert.ok(probe, 'timer 探针必须存在');
  return plain(await probe.run(env, collectorCtx()));
}

test('A-11 ①：jitter 真的等于最大正间隔（旧实现取的是最小值，和注释相反）', async () => {
  const t = await timerOf(steppingEnv());
  assert.deepStrictEqual(Object.keys(t).sort(),
    ['jitter', 'maxPositiveMs', 'minPositiveMs', 'now', 'res', 'samples']);
  assert.strictEqual(t.minPositiveMs, 1, '最小正间隔是 1ms：' + JSON.stringify(t));
  assert.strictEqual(t.maxPositiveMs, 7, '最大正间隔是 7ms：' + JSON.stringify(t));
  assert.strictEqual(t.jitter, t.maxPositiveMs, '兼容字段 jitter 必须等于最大值，不是最小值');
  assert.strictEqual(t.jitter, 7, '旧实现这里会是 1 —— 那才是缺陷');
  assert.strictEqual(t.samples, 64);
  assert.ok(t.res > 0, '分辨率读数仍是正数：' + t.res);
});

test('A-11 ①b：读不出间隔时三个字段都是 null，不写假的 0', async () => {
  const env = fakeEnv();
  env.performance = { now: () => 1234 };      // 永远不动
  const t = await timerOf(env);
  assert.deepStrictEqual(t.res, { $: 'unreadable' });
  assert.strictEqual(t.jitter, null);
  assert.strictEqual(t.minPositiveMs, null);
  assert.strictEqual(t.maxPositiveMs, null);
  assert.strictEqual(t.samples, 0);
});

test('A-11 ②：文件头不再写死版本号，版本号只有 VERSION 一处', () => {
  const RC = loadCollector(fakeEnv());
  assert.match(RC.VERSION, /^radish-\d+\.\d+\.\d+$/, 'VERSION 应是 radish-x.y.z：' + RC.VERSION);
  const head = SRC.slice(0, 4000);
  // 头注释里不许再出现"radish-collect <版本号>"这种写死的版本
  const hard = head.match(/radish-collect\s+v?\d+\.\d+\.\d+/);
  assert.strictEqual(hard, null, '头注释里还写死着版本号：' + (hard && hard[0]));
  assert.match(head, /VERSION/, '头注释要指明版本号只有 VERSION 常量这一处');
  // 除 VERSION 常量本身外，源码里不许再出现一个"看起来像采集器版本"的字符串常量
  const declared = SRC.match(/var VERSION = '([^']+)'/);
  assert.ok(declared, '找不到 VERSION 常量定义');
  assert.strictEqual(declared[1], RC.VERSION);
});

test('A-11 ③：启动时机与并发的说明和实际行为一致', () => {
  // 实际行为：文档已就绪立刻跑，否则等 DOMContentLoaded；不再"等 load"，也没有 1.2s 空等
  assert.ok(/DOMContentLoaded/.test(SRC));
  assert.ok(!/页面 load 后 1\.2s 开始/.test(SRC), '旧的"load 后 1.2s 开始"注释必须改掉');
  const head = SRC.slice(0, 4000);
  assert.match(head, /DOMContentLoaded/, '头注释要写清实际的启动时机');
  // 并发说明：16 路快速车道 + 慢车道（dns/ai/trackers/etag/quicfp）
  assert.match(head, /16 路/);
  assert.match(head, /慢车道/);
});

test('A-11 ③b：慢车道清单与注释里列的名字完全一致', () => {
  const RC = loadCollector(fakeEnv());
  assert.deepStrictEqual(Object.keys(RC.SLOW_IDS).sort(),
    ['ai', 'dns', 'etag', 'quicfp', 'trackers'],
    '慢车道清单变了，注释也得跟着改');
  const head = SRC.slice(0, 4000);
  for (const id of Object.keys(RC.SLOW_IDS)) {
    assert.ok(head.indexOf(id) >= 0, '注释里没提到慢车道项 ' + id);
  }
  assert.ok(RC.SLOW_TIMEOUT > RC.PROBE_TIMEOUT, '慢车道的期限必须比快速车道宽');
});
}

// ===== artifact.test.js =====
{
'use strict';
// G02 回归：发布产物必须与源逐字节相同，且测试跑在产物上
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'static', 'radish-collect.js');
const ART = path.join(ROOT, 'docs', 'radish-collect.js');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('G02：static 与 docs 里的采集器逐字节一致', () => {
  assert.ok(fs.existsSync(ART), 'docs/radish-collect.js 不存在，先跑一次构建或 node tools/sync-artifact.js');
  assert.strictEqual(sha(ART), sha(SRC), '产物与源不一致：docs 落后于 static，不能发布');
});

test('G02：产物里能读出与源相同的版本号', () => {
  const v = (p) => (fs.readFileSync(p, 'utf8').match(/var VERSION = '([^']+)'/) || [])[1];
  assert.strictEqual(v(ART), v(SRC));
  assert.match(v(SRC), /^radish-\d+\.\d+\.\d+$/);
});

test('G12：工作流没有 write-all，且产物自检与行为测试都跑在上传之前', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'Gmeek.yml'), 'utf8');
  assert.ok(!/permissions:\s*write-all/.test(wf), '仍然给了 write-all');
  assert.match(wf, /patch-generated\.js/, '工作流没有跑生成后修补');
  // 产物自检和行为测试都收在 tools/check-artifact.js 里，工作流只调它一次
  assert.match(wf, /node tools\/check-artifact\.js/, '工作流没有跑产物自检');
  const chk = fs.readFileSync(path.join(__dirname, '..', 'tools', 'check-artifact.js'), 'utf8');
  assert.match(chk, /'--test'/, '自检脚本里没有跑单元测试');
  assert.match(chk, /static\/radish-collect\.js/, '自检脚本没有校验产物与源一致');
  const uploadAt = wf.indexOf('upload-pages-artifact');
  const checkAt = wf.indexOf('node tools/check-artifact.js');
  assert.ok(checkAt > 0 && uploadAt > checkAt, '自检与测试必须在打包上传之前');
});

test('BLOG-11：config.json 里的脚本版本号要和采集器版本一致', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const m = String(cfg.allHead || '').match(/radish-collect\.js\?v=([0-9.]+)/);
  assert.ok(m, 'allHead 里的脚本地址要带 ?v= 版本号，否则 CDN 会把旧脚本缓存好几个小时');
  const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'radish-collect.js'), 'utf8');
  const ver = (src.match(/VERSION = 'radish-([0-9.]+)'/) || [])[1];
  assert.strictEqual(m[1], ver, 'config.json 写 ' + m[1] + '，采集器是 ' + ver);
});
}

// ===== f07-request-lifecycle.test.js =====
{
'use strict';
// F-07：trackers 这类"对照 + 多目标"请求的期限与资源释放。
// 三件事必须真的成立：
//   1. 对照请求与每个目标各有自己的期限（不是共用整轮死线）；
//   2. 期限到点要 abort 底层 fetch，不是只把 within 的等待结束掉；
//   3. 本轮探针的取消信号（pctx.__ac）要接进请求，一轮收工时没跑完的立刻停。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 fetch：一直不返回，只有 abort 时才 reject —— 真实 fetch 被 abort 就是这个行为 */
function hangingFetch(seen) {
  return (url, opts) => {
    const sig = opts && opts.signal;
    const rec = { url: String(url), signal: sig, mode: opts && opts.mode, abortedAt: null };
    const t0 = Date.now();
    seen.push(rec);
    return new Promise((resolve, reject) => {
      if (!sig) return;                       // 没有信号就永远挂着，模拟"没人管"的请求
      const onAbort = () => {
        rec.abortedAt = Date.now() - t0;
        reject(new Error('AbortError'));
      };
      if (sig.aborted) { onAbort(); return; }
      sig.addEventListener('abort', onAbort, { once: true });
    });
  };
}

/** 直接跑 trackers 探针（不经过整轮），这样可以单独控制 pctx 与取消时机 */
async function runTrackers(env, pctx) {
  const RC = loadCollector(env);
  const probe = RC.probes.filter((p) => p.id === 'trackers')[0];
  assert.ok(probe, 'trackers 探针必须存在');
  const out = await probe.run(env, pctx);
  return { RC, out };
}

function pctxWith(ac) {
  const pctx = Object.create(collectorCtx());
  pctx.__ac = ac;
  return pctx;
}

test('F-07：对照请求有自己的期限，到点就 abort（不再等整轮）', async () => {
  const env = fakeEnv();
  const seen = [];
  env.fetch = hangingFetch(seen);
  const t0 = Date.now();
  const { RC, out } = await runTrackers(env, pctxWith(new AbortController()));
  const dt = Date.now() - t0;
  const v = plain(out);

  // 对照不通，就只该发出这一个请求
  assert.strictEqual(seen.length, 1, '对照不通时发出了 ' + seen.length + ' 个请求');
  assert.strictEqual(seen[0].mode, 'cors');
  assert.strictEqual(v.control_ok, false);
  assert.strictEqual(v.verdict, 'unknown');
  assert.strictEqual(v.requests.total, 1);
  assert.strictEqual(v.skipped, true, '对照不通就不再试 7 个目标');
  assert.strictEqual(v.probed_targets, 0);
  assert.deepStrictEqual(v.reachable, []);
  assert.deepStrictEqual(v.unreachable, [], '没测过的目标不能写成"不可达"');
  // 对照的期限与目标的期限是两份，不是同一个数
  assert.deepStrictEqual(v.deadlines, {
    control_ms: RC.TRACKER_CONTROL_TIMEOUT,
    target_ms: RC.TRACKER_TARGET_TIMEOUT
  });
  assert.ok(RC.TRACKER_CONTROL_TIMEOUT < RC.TRACKER_TARGET_TIMEOUT, '对照与目标必须各有期限');
  // 按对照自己的期限收工，而不是一直等到目标期限或整轮死线
  assert.ok(dt >= RC.TRACKER_CONTROL_TIMEOUT - 200 && dt < RC.TRACKER_TARGET_TIMEOUT,
    '探针用了 ' + dt + 'ms，对照期限是 ' + RC.TRACKER_CONTROL_TIMEOUT + 'ms');
  // 关键：到点是真的 abort 了底层请求，不是只结束等待
  assert.strictEqual(seen[0].signal.aborted, true, '对照请求到点必须被 abort');
  assert.ok(seen[0].abortedAt !== null && seen[0].abortedAt >= RC.TRACKER_CONTROL_TIMEOUT - 120,
    'abort 发生在 ' + seen[0].abortedAt + 'ms');
  // 记账：最长一次等待 + 这一项自己的耗时
  assert.ok(v.max_wait_ms >= RC.TRACKER_CONTROL_TIMEOUT - 120, 'max_wait_ms=' + v.max_wait_ms);
  assert.ok(v.elapsed_ms >= RC.TRACKER_CONTROL_TIMEOUT - 120, 'elapsed_ms=' + v.elapsed_ms);
});

test('F-07：7 个目标各有期限，探针结束后没有请求还在飞', async () => {
  const env = fakeEnv();
  const seen = [];
  const hang = hangingFetch(seen);
  const RC = loadCollector(env);
  // 对照立刻通，7 个目标永远不自己结束 —— 只能靠自己的期限把 fetch 掐掉
  env.fetch = (url, opts) => {
    if (String(url).indexOf('cloudflare.com/cdn-cgi/trace') >= 0) {
      seen.push({ url: String(url), signal: opts && opts.signal, mode: opts && opts.mode, abortedAt: null });
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        text: () => Promise.resolve('ip=203.0.113.7\nloc=US\n')
      });
    }
    if (RC.TRACKER_TARGETS.some((t) => t.url === String(url))) return hang(url, opts);
    // 别的探针（etag / extwar）不在这条用例的范围内，给个温和的成功响应
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('') });
  };

  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.trackers);
  const targetCalls = seen.filter((c) => RC.TRACKER_TARGETS.some((t) => t.url === c.url));

  assert.strictEqual(targetCalls.length, RC.TRACKER_TARGETS.length, '7 个目标都要真发出去');
  for (const c of targetCalls) {
    assert.strictEqual(c.mode, 'no-cors');
    assert.ok(c.signal, '目标请求必须带取消信号');
    assert.strictEqual(c.signal.aborted, true, c.url + ' 到期后必须被 abort');
    assert.ok(c.abortedAt >= RC.TRACKER_TARGET_TIMEOUT - 150 && c.abortedAt <= RC.TRACKER_TARGET_TIMEOUT + 700,
      c.url + ' 的 abort 时刻 ' + c.abortedAt + 'ms 不对');
  }
  assert.strictEqual(v.control_ok, true);
  assert.strictEqual(v.verdict, 'some_unreachable');
  assert.deepStrictEqual(v.reachable, []);
  assert.deepStrictEqual(v.unreachable, plain(RC.TRACKER_TARGETS.map((t) => t.id)));
  assert.strictEqual(v.requests.total, RC.TRACKER_TARGETS.length + 1);
  assert.strictEqual(v.scope, 'network-reachability', '读数范围要写成"网络可达性"');
  assert.match(v.note, /no-cors/, 'note 要写清 no-cors 证明不了状态码与脚本内容');
  assert.ok(v.max_wait_ms >= RC.TRACKER_TARGET_TIMEOUT - 150, 'max_wait_ms=' + v.max_wait_ms);
  assert.ok(v.elapsed_ms >= RC.TRACKER_TARGET_TIMEOUT - 150, 'elapsed_ms=' + v.elapsed_ms);
  // 目标期限之和 / 对照+目标必须落在这一项的单项额度里
  assert.strictEqual(RC.SLOW_IDS.trackers, 1, 'trackers 要放在慢车道，单项额度才够');
  assert.ok(RC.TRACKER_CONTROL_TIMEOUT + RC.TRACKER_TARGET_TIMEOUT < RC.SLOW_TIMEOUT);
});

test('F-07：本轮取消信号接进了请求，一轮收工时立刻停（不等自己的期限）', async () => {
  const env = fakeEnv();
  const seen = [];
  env.fetch = hangingFetch(seen);
  const ac = new AbortController();
  const t0 = Date.now();
  const RC = loadCollector(env);
  const probe = RC.probes.filter((p) => p.id === 'trackers')[0];
  const p = probe.run(env, pctxWith(ac));
  await sleep(60);
  assert.strictEqual(seen.length, 1, '对照请求应该已经发出');
  assert.strictEqual(seen[0].signal.aborted, false);
  ac.abort();                                  // 模拟整轮死线/探针收工
  const v = plain(await p);
  const dt = Date.now() - t0;

  assert.strictEqual(seen[0].signal.aborted, true, '取消信号必须传到请求上');
  assert.ok(dt < RC.TRACKER_CONTROL_TIMEOUT - 200,
    '取消后应立刻收工，实际用了 ' + dt + 'ms（对照期限 ' + RC.TRACKER_CONTROL_TIMEOUT + 'ms）');
  assert.strictEqual(v.control_ok, false);
  assert.strictEqual(v.verdict, 'unknown');
  assert.strictEqual(v.requests.total, 1);
  assert.strictEqual(v.skipped, true);
});

test('F-07：真实 ctx 下 text / json 走的是同一份合并信号，到点 abort', async () => {
  // 这条用例不注入 ctx 桩：buildEnvelope 会自己 makeCtx，走 ctx.text / ctx.json 的真实现，
  // 验证两处确实共用 signalFor（而不是各自抄一份、漏接期限或本轮取消）。
  const env = fakeEnv();
  const seen = [];
  const hang = hangingFetch(seen);
  env.fetch = (url, opts) => {
    if (String(url).indexOf('chatgpt.com/cdn-cgi/trace') >= 0) return hang(url, opts);
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      text: () => Promise.resolve(''), json: () => Promise.resolve({})
    });
  };
  const RC = loadCollector(env);
  const t0 = Date.now();
  const e = await RC.buildEnvelope(env);
  const dt = Date.now() - t0;

  const call = seen.filter((c) => c.url.indexOf('chatgpt.com') >= 0)[0];
  assert.ok(call, 'ex_gpt 的 trace 请求应该发出去');
  assert.ok(call.signal, 'ctx.text 的请求必须带取消信号');
  assert.strictEqual(call.signal.aborted, true, '到点必须 abort 底层 fetch');
  assert.ok(call.abortedAt >= 1700 && call.abortedAt <= 2600, 'abort 时刻 ' + call.abortedAt + 'ms');
  assert.ok(dt < RC.PROBE_TIMEOUT + 2500, '整轮不该被这一个请求拖住：' + dt + 'ms');
  assert.strictEqual(e.cli.ex_gpt.$, 'unreadable');
});

test('F-07：没有 AbortSignal.any 的引擎自己合成合并信号（Safari 17.4 之前）', async () => {
  const env = fakeEnv();
  const seen = [];
  env.fetch = hangingFetch(seen);
  // 拆掉 any，只留 timeout，逼 signalFor 走手写合并那条路
  env.AbortSignal = {
    timeout: (ms) => AbortSignal.timeout(ms),
    abort: (r) => AbortSignal.abort(r)
  };
  env.AbortController = AbortController;
  const { RC, out } = await runTrackers(env, pctxWith(new AbortController()));
  const v = plain(out);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(v.control_ok, false);
  // 手写合并后，请求自己的期限照样能 abort 到底层 fetch
  assert.strictEqual(seen[0].signal.aborted, true, '合并信号必须能 abort 到请求上');
  assert.strictEqual(v.deadlines.control_ms, RC.TRACKER_CONTROL_TIMEOUT);
});
}

// ===== n04-identity-alg.test.js =====
{
'use strict';
// N-04 回归：摘要算法标签必须跟着**实际**用的算法走。
//
// 旧实现无条件写 `sha256/tmpl-1`、`sha256/hw-1`（1.9.6 起版本号改为 tmpl-2 / hw-2，
// 因为摘要的输入范围变大了），可是 crypto.subtle 被禁用时
// hash() 会退到 shaSync 的 FNV-1a，值是 `fnv:` 前缀——标签在撒谎。
// 下面四组分别覆盖：subtle 可用、subtle 缺失、digest 拒绝、以及标签与值前缀的不变式。
const test = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const { loadCollector, fakeEnv, collectorCtx } = require('./harness');

/** 起一个采集器上下文，返回 buildEnvelope 的 cli */
async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

test('N-04：crypto.subtle 可用时标签是 sha256/tmpl-2 与 sha256/hw-2', async () => {
  const env = fakeEnv();
  env.crypto = webcrypto;
  const cli = await cliOf(env);
  assert.match(cli.fpid, /^sha256:[0-9a-f]{64}$/, 'fpid=' + cli.fpid);
  assert.match(cli.hwid, /^sha256:[0-9a-f]{64}$/, 'hwid=' + cli.hwid);
  assert.strictEqual(cli.fpid_alg, 'sha256/tmpl-2');
  assert.strictEqual(cli.hwid_alg, 'sha256/hw-2');
});

test('N-04：没有 crypto.subtle 时降级到 FNV，标签必须写明降级', async () => {
  const env = fakeEnv();
  env.crypto = {}; // 有 crypto，但没有 subtle：真机上隐私插件会这样把接口拿走
  const cli = await cliOf(env);
  assert.match(cli.fpid, /^fnv:[0-9a-f]{16}$/, 'fpid=' + cli.fpid);
  assert.match(cli.hwid, /^fnv:[0-9a-f]{16}$/, 'hwid=' + cli.hwid);
  assert.strictEqual(cli.fpid_alg, 'fnv/tmpl-2-fallback');
  assert.strictEqual(cli.hwid_alg, 'fnv/hw-2-fallback');
  assert.ok(cli.fpid_alg.indexOf('sha256') < 0, '降级的结果不能冒充 SHA256');
});

test('N-04：subtle.digest 拒绝（被策略拦下）时同样降级，标签一起改', async () => {
  const env = fakeEnv();
  env.crypto = {
    subtle: {
      digest() {
        const err = new Error('NotAllowedError: digest blocked');
        return Promise.reject(err);
      }
    }
  };
  const cli = await cliOf(env);
  assert.match(cli.fpid, /^fnv:/);
  assert.match(cli.hwid, /^fnv:/);
  assert.strictEqual(cli.fpid_alg, 'fnv/tmpl-2-fallback');
  assert.strictEqual(cli.hwid_alg, 'fnv/hw-2-fallback');
});

test('N-04：标签前缀与摘要值前缀永远一致', async () => {
  const cases = [
    { name: 'sha256', crypto: webcrypto, want: /^sha256\// },
    { name: 'fnv', crypto: {}, want: /^fnv\// }
  ];
  for (const one of cases) {
    const env = fakeEnv();
    env.crypto = one.crypto;
    const cli = await cliOf(env);
    for (const [head, algKey] of [['fpid', 'fpid_alg'], ['hwid', 'hwid_alg']]) {
      const alg = String(cli[algKey] || '');
      assert.match(alg, one.want, one.name + ' 的 ' + algKey + '=' + alg);
      // 摘要值的前缀就是算法名，标签的第一段必须与它逐字相同
      assert.strictEqual(alg.split('/')[0], String(cli[head]).split(':')[0]);
      // 标签里必须带版本号：同一版本内才可比，换版本就该是另一个标签
      assert.match(alg, /^(sha256|fnv)\/[a-z]+-\d+(-fallback)?$/);
    }
  }
});
}

// ===== n05-week-field-rename.test.js =====
{
'use strict';
// N-05 · week 读数的字段改名（reviews 16 里 CI 上一轮发现的那个真问题）
//
// 背景：`Intl.Locale.prototype.weekInfo` 的字段在规范里改过名——早期是
// `minimalDays`，现行规范（Chrome / Safari / Firefox 这一代）叫 `minDays`。
// 采集器原来只读旧名，于是**在所有现代浏览器上恒为 null**：读数丢了一半，
// 页面上还看不出来（null 会被当成"读不到"而不是"我们读错了字段"）。
//
// 这条测试钉住三件事：
//   ① 新名字（minDays）能读到；
//   ② 只有旧名字（minimalDays）的引擎，退回旧名字，仍然能读到；
//   ③ 两个名字都没有时是 null——不编数字，也不把 null 说成 0。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function weekOf(opts) {
  const e = await loadCollector(fakeEnv(), opts).buildEnvelope(undefined, collectorCtx());
  return plain(e.cli.week);
}

test('week：现行规范的 minDays 能读到（读旧名会在现代引擎上恒为 null）', async () => {
  const w = await weekOf({ weekInfo: { firstDay: 1, weekend: [6, 7], minDays: 4 } });
  assert.equal(w.minDays, 4, 'weekInfo.minDays 必须被读到');
  assert.equal(w.firstDay, 1);
  assert.deepEqual(w.weekend, [6, 7]);
});

test('week：只有早期规范 minimalDays 的引擎退回旧名字，仍能读到', async () => {
  const w = await weekOf({ weekInfo: { firstDay: 7, weekend: [5, 6], minimalDays: 1 } });
  assert.equal(w.minDays, 1, 'minDays 缺失时要退回 minimalDays');
  assert.equal(w.firstDay, 7, 'firstDay 不受字段改名影响');
});

test('week：两个名字都没有 → null，不编数字', async () => {
  const w = await weekOf({ weekInfo: { firstDay: 1, weekend: [6, 7] } });
  assert.equal(w.minDays, null, '读不到就是 null，不能写 0 或猜一个');
  assert.equal(w.firstDay, 1);
});

test('week：引擎没有 weekInfo → {"$":"unsupported"}，不是全 null 的对象', async () => {
  const w = await weekOf({ weekInfo: 'absent' });
  assert.equal(w.$, 'unsupported', '没有 weekInfo 要如实标 unsupported');
});
}

// ===== w03-probe-reason.test.js =====
{
'use strict';
// W-03 回归：探针结果映射要保留抓包失败原因（契约 specs/radishcloud-contract.md 附录 G）
//
// 探针在抓不到包时回 {"tcp":{"$":"not_configured"},"tcp_reason":"npcap-not-installed"}。
// tcp 的单键缺失标记形状不变，原因走旁路元数据 cli.tcp_reason —— 这样画像才能分清
// "驱动没装 / 网卡没匹配上 / 权限不足"，也不会把"探针已响应"说成"探针未接入"。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function probeCtx(fp, extra) {
  const seen = [];
  const ctx = collectorCtx(Object.assign({
    probeUrl: 'https://probe.test',
    json: (url) => {
      seen.push(String(url));
      return Promise.resolve(fp);
    }
  }, extra || {}));
  ctx.__seen = seen;
  return ctx;
}

test('W-03：探针映射保留 tcp_reason，tcpfp 仍是单键标记', async () => {
  const ctx = probeCtx({ tcp: { $: 'not_configured' }, tcp_reason: 'npcap-not-installed' });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'not_configured' }, '标记形状不能变');
  assert.strictEqual(e.cli.tcp_reason, 'npcap-not-installed', '原因必须活着传到信封里');
  assert.strictEqual(ctx.__seen.filter((u) => u.endsWith('/fp')).length, 1, '五项共用一次 /fp');
});

test('W-03：原因码逐条透传（权限不足 / 网卡不匹配 / 无 SYN / HTTP3）', async () => {
  const cases = [
    ['permission-denied', { $: 'denied' }],
    ['no-matching-device', { $: 'not_configured' }],
    ['multiple-matching-devices', { $: 'not_configured' }],
    ['no-device', { $: 'not_configured' }],
    ['syn-not-in-table', { $: 'unreadable' }],
    ['http3-connection-carries-no-tcp-syn', { $: 'unsupported' }]
  ];
  for (const [reason, tcp] of cases) {
    const ctx = probeCtx({ tcp: tcp, tcp_reason: reason });
    const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
    assert.deepStrictEqual(plain(e.cli.tcpfp), tcp, reason);
    assert.strictEqual(e.cli.tcp_reason, reason, reason);
  }
});

test('W-03：形状不对的原因码丢掉，不猜也不截半截词', async () => {
  for (const bad of ['Npcap Not Installed!', '', '   ', '-leading', 'trailing-', 42, null, ['x'], 'a'.repeat(65)]) {
    const ctx = probeCtx({ tcp: { $: 'error' }, tcp_reason: bad });
    const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
    assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'error' }, String(bad));
    assert.strictEqual(e.cli.tcp_reason, undefined, 'bad=' + String(bad));
  }
});

test('W-03：tcp 有读数时没有原因可讲，tcp_reason 不出现', async () => {
  const ctx = probeCtx({ tcp: { os: 'windows', mtu: 1500 }, tcp_reason: 'syn-not-in-table' });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.strictEqual(plain(e.cli.tcpfp).os, 'windows');
  assert.strictEqual(e.cli.tcp_reason, undefined);
});

test('W-03：PROBE_URL 为空时不请求探针 /fp、也不写 tcp_reason', async () => {
  const seen = [];
  const ctx = collectorCtx({
    probeUrl: '',
    // 后端发现接口说"没有探针"：采集器不该再去请求探针本身
    json: (url) => {
      seen.push(String(url));
      return Promise.resolve({ available: false, url: null, reason: 'probe-not-configured' });
    }
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  // 只允许一次"问后端有没有探针"的发现请求（现行为），探针自己的 /fp 一次都不许发
  const probeCalls = seen.filter((u) => /^https:\/\/probe\.test/.test(u));
  assert.strictEqual(probeCalls.length, 0, '没接探针就不发探针 /fp 请求：' + seen.join(','));
  assert.strictEqual(
    seen.filter((u) => /\/v1\/fp$/.test(u)).length, 1,
    '空的 PROBE_URL 只做一次发现请求：' + seen.join(',')
  );
  assert.strictEqual(e.cli.tcpfp, undefined);
  assert.strictEqual(e.cli.tcp_reason, undefined, '没接探针就没有原因可写');
});

test('W-03：探针不可达时写 unreachable 标记，但不编原因', async () => {
  const ctx = collectorCtx({
    probeUrl: 'https://probe.test',
    json: () => Promise.reject(new Error('offline'))
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'unreachable' });
  assert.strictEqual(e.cli.tcp_reason, undefined);
});

test('W-03：HTTP/3 连接天然无 TCP，原因与 QUIC 读数同时保留', async () => {
  const ctx = probeCtx({
    proto: 'HTTP/3.0',
    tcp: { $: 'unsupported' },
    tcp_reason: 'http3-connection-carries-no-tcp-syn',
    tls: { ja4: 'q13d0312h3_55b375c5d22e', ja3n: 'ja3n-h3' }
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'unsupported' });
  assert.strictEqual(e.cli.tcp_reason, 'http3-connection-carries-no-tcp-syn');
  assert.strictEqual(e.cli.quicfp, 'q13d0312h3_55b375c5d22e');
  assert.strictEqual(e.cli.tlsfp, 'ja3n-h3');
});

test('W-03：TLS/H2 成功、TCP 缺失时两边都留着', async () => {
  const ctx = probeCtx({
    proto: 'HTTP/2.0',
    tcp: { $: 'not_configured' },
    tcp_reason: 'npcap-not-installed',
    tls: { ja4: 't13d1516h2_8daaf6152771', ja3n: 'ja3n-tls' },
    http2: { akamai: '1:65536|0|0|m,a,s,p' }
  });
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, ctx);
  assert.strictEqual(e.cli.ja4, 't13d1516h2_8daaf6152771');
  assert.strictEqual(e.cli.h2fp.akamai, '1:65536|0|0|m,a,s,p');
  assert.deepStrictEqual(plain(e.cli.tcpfp), { $: 'not_configured' });
  assert.strictEqual(e.cli.tcp_reason, 'npcap-not-installed');
});
}

// ===== xss.test.js =====
{
'use strict';
// BLOG-01/02 回归：修补必须真的把危险写法改掉、可重复执行，且模板变化时要报错
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { patchHtml } = require('../tools/patch-generated');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'tag.template.html');
const PUBLISHED = path.join(ROOT, 'docs', 'tag.html');

const template = () => fs.readFileSync(FIXTURE, 'utf8');

/** 从修补后的 HTML 里取出需要的函数，只跑这几段，避免执行整页初始化 */
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到 ' + name + '（模板变了？）');
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error(name + ' 花括号不闭合');
}

function patchedScriptFns(extraTags) {
  const { html, errors } = patchHtml(template(), true);
  assert.deepStrictEqual(errors, [], '修补不应报错');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const src = scripts.find(s => s.indexOf('function setClassDisplay') >= 0);
  assert.ok(src, 'tag.html 里找不到脚本');
  return [
    'var tagList=' + JSON.stringify(extraTags || []) + ',labelsCount={},jsonData=[];',
    extractFn(src, 'radishSafeColor'),
    extractFn(src, 'radishEsc'),
    extractFn(src, 'radishSafeHref'),
    extractFn(src, 'radishDecode'),
    extractFn(src, 'setClassDisplay'),
    extractFn(src, 'searchShow')
  ].join('\n');
}

function makeNode(over) {
  return Object.assign({
    _html: 0, _text: null, _attrs: {},
    set innerHTML(v) { this._html++; this._lastHtml = v; },
    get innerHTML() { return ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    style: {}, value: '', className: '',
    classList: { add() { }, remove() { } },
    appendChild() { },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    addEventListener() { }, childNodes: []
  }, over || {});
}

function sandbox(searchValue) {
  const lists = [
    makeNode({ _attrs: { 'data-labels': '|a b|中文|' } }),
    makeNode({ _attrs: { 'data-labels': '|other|' } })
  ];
  lists.forEach(l => { l.childNodes = [{ childNodes: [{ childNodes: [makeNode(), makeNode()] }] }]; });
  const nodes = {
    '.lists': lists,
    '.tagTitle': [makeNode()],
    '.subnav-search-input': [Object.assign(makeNode(), { value: searchValue || '' })],
    '.notFind': [makeNode()]
  };
  const document = {
    title: '',
    getElementsByClassName: (c) => nodes['.' + c] || [],
    getElementById: () => null,
    createElement: () => makeNode(),
    documentElement: { setAttribute() { } },
    addEventListener() { }
  };
  const win = { location: { hash: '' }, document, localStorage: { getItem: () => null, setItem() { } }, addEventListener() { } };
  return { sb: Object.assign({ document, window: win, console, setTimeout, __auditFlag: 0 }, win), nodes, lists };
}

test('BLOG-01：hash 里的 img/onerror 只按文字显示，不生成元素', () => {
  const payload = '<img src=x onerror=globalThis.__auditFlag=1>';
  for (const inList of [true, false]) {
    const { sb, nodes } = sandbox();
    const fns = patchedScriptFns(inList ? [payload] : []);
    vm.runInNewContext(fns, sb);
    sb.setClassDisplay(payload);
    const title = nodes['.tagTitle'][0];
    assert.strictEqual(title._html, 0, '不允许再通过 innerHTML 写入不可信内容');
    assert.ok(String(title._text).indexOf(payload) >= 0, '输入必须原样保留为文字，实际 ' + title._text);
    assert.strictEqual(sb.__auditFlag, 0);
  }
});

test('BLOG-01：搜索框里的 HTML 同样只显示文字', () => {
  const payload = '<img src=x onerror=globalThis.__auditFlag=1>';
  const { sb, nodes } = sandbox(payload);
  vm.runInNewContext(patchedScriptFns(), sb);
  sb.searchShow();
  for (const key of ['.tagTitle', '.notFind']) {
    const node = nodes[key][0];
    assert.strictEqual(node._html, 0, key + ' 不允许写 innerHTML');
    assert.ok(String(node._text).indexOf(payload) >= 0, key + ' 应保留原文');
  }
  assert.strictEqual(sb.__auditFlag, 0);
});

test('BLOG-01.4：带空格和中文的标签也能筛出来', () => {
  const { sb, lists } = sandbox();
  vm.runInNewContext(patchedScriptFns(['a b', '中文']), sb);
  sb.setClassDisplay('a b');
  assert.strictEqual(lists[0].style.display, 'block', '空格标签应命中');
  assert.strictEqual(lists[1].style.display, 'none', '不该命中别的标签');
  const { sb: sb2, lists: lists2 } = sandbox();
  vm.runInNewContext(patchedScriptFns(['a b', '中文']), sb2);
  sb2.setClassDisplay('中文');
  assert.strictEqual(lists2[0].style.display, 'block');
});

test('BLOG-02：修补可以重复执行，第二次不再改动', () => {
  const once = patchHtml(template(), true);
  assert.deepStrictEqual(once.errors, []);
  const twice = patchHtml(once.html, true);
  assert.deepStrictEqual(twice.errors, [], '第二次不应该报「原模式不存在」');
  assert.strictEqual(twice.html, once.html, '重复修补必须幂等');
});

test('BLOG-02：模板变了要报错（不能静默跳过）', () => {
  const broken = template().replace('tagTitle.innerHTML="Tag #"+label;', 'tagTitle.innerHTML = "Tag #" + label;');
  const r = patchHtml(broken, true);
  assert.ok(r.errors.length > 0, '写法一变就应该失败');
});

test('BLOG-01：已发布的 docs/tag.html 必须是修补后的版本', () => {
  const html = fs.readFileSync(PUBLISHED, 'utf8');
  const bad = [
    /tagTitle\.innerHTML\s*=/, /notFind\.innerHTML\s*=/,
    /setAttribute\(\s*"onclick"\s*,\s*"javascript:/, /LabelName\.innerHTML\s*=/,
    /LabelTime\.innerHTML\s*=/, /title\.innerHTML\s*=\s*jsonData/
  ];
  for (const re of bad) assert.ok(!re.test(html), '仍存在可疑 sink：' + re);
  const again = patchHtml(html, true);
  assert.deepStrictEqual(again.errors, [], '已发布产物也应当通过重复修补检查');
});

test('不许动外观：修补不得给页面新增任何 <style> 或无障碍属性', () => {
  const before = template();
  const after = patchHtml(before, true).html;
  const count = (s) => (s.match(/<style/gi) || []).length;
  assert.strictEqual(count(after), count(before), '修补不能新增样式表');
  for (const bad of ['radish-a11y', 'href="#theme"', 'role="button" aria-label="切换主题"', 'min-width:0;width:100%']) {
    assert.ok(after.indexOf(bad) < 0, '不能引入外观/无障碍改动：' + bad);
  }
});

test('不许动外观：线上 docs 里也不能残留任何样式注入', () => {
  const html = fs.readFileSync(PUBLISHED, 'utf8');
  for (const bad of ['radish-a11y', 'href="#theme"', 'prefers-reduced-motion', 'markdown-body { line-height: 1.75']) {
    assert.ok(html.indexOf(bad) < 0, 'docs/tag.html 残留外观改动：' + bad);
  }
});

test('修补前后正文文字逐字一致（只是不再当 HTML 解析）', () => {
  const html = patchHtml(template(), true).html;
  // 保留了原来的 &nbsp; 排版
  assert.ok(html.indexOf('showLabels.innerHTML="&nbsp;&nbsp;"+radishEsc(label)+" ";') > 0);
  assert.ok(html.indexOf('tagTitle.textContent="Tag #"+label;') > 0);
});
}
