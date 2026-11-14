'use strict';
// 对外契约夹具与交接。
// 由 3 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== a09-contract.test.js =====
{
'use strict';
// A-09 · 博客侧**单仓**契约测试（不依赖 RadishCloud 兄弟目录）
//
// 复审 A-09：契约测试原来靠两仓并排（w08-handoff 在兄弟目录缺失时全部跳过），
// 单仓 CI 等于没验。这个文件把"采集器实际产出"和仓库里提交的契约夹具
// tests/contract/blog-cli-contract.json 逐项对齐：
//
//   1. 用当前采集器在内存里重算 cli_keys / shapes / markers / digest，和提交的夹具比；
//      不一致时打印**具体漂移路径**（不是一句"不相等"）；
//   2. semantics 必须覆盖全部顶层键（不多不少），且每条顶层语义都能对上 shapes 的键；
//   3. digest 能按 digest_scope 重算出来（防止改了内容忘了重算摘要）；
//   4. 兄弟目录在场时逐字节比对后端那份副本；不在场时**跳过**（不因此失败）。
//
// 重生成夹具：node tests\make-contract.js（在本仓库根目录即可，不需要另一仓）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gen = require('./make-contract.js');

const FIXTURE = gen.OUT;
const RELATIVE = 'tests/contract/' + gen.OUT_NAME;
const SIBLING = path.join(__dirname, '..', '..', 'RadishCloud', 'tests', 'contract', gen.OUT_NAME);
const SIBLING_MISSING =
  'RadishCloud 兄弟目录不在（单仓检出时跳过；两仓并排时这条必须跑起来）';

function readCommitted() {
  assert.ok(
    fs.existsSync(FIXTURE),
    '提交的契约夹具不见了：' + RELATIVE + '（跑 node tests\\make-contract.js 生成）'
  );
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function keysOf(obj) {
  return Object.keys(obj || {}).sort();
}

/** 形状的人类可读写法：漂移信息里要能一眼看出"从什么变成了什么" */
function describe(shape) {
  if (!shape) return '（缺席）';
  switch (shape.type) {
    case 'object':
      return 'object{' + keysOf(shape.props).join(',') + '}';
    case 'array':
      return 'array<' + describe(shape.of) + '>';
    case 'union':
      return 'union[' + shape.of.map(describe).join(' | ') + ']';
    case 'string':
      if (shape.enum) return 'string<' + shape.enum.join('|') + '>';
      if (shape.format) return 'string<' + shape.format + '>';
      if (shape.volatile) return 'string<volatile>';
      return 'string';
    case 'number':
      if (shape.host) return 'number<host>';
      if (shape.volatile) return 'number<volatile>';
      return 'number[' + shape.range.join(',') + ']';
    default:
      return shape.type;
  }
}

/** 逐层比对形状，把每个漂移点写成 "cli.worker.match: 提交的是 X，现在是 Y" */
function diffShapes(committed, fresh, at, out) {
  out = out || [];
  if (gen.canonicalJson(committed) === gen.canonicalJson(fresh)) return out;
  if (committed && fresh && committed.type === 'object' && fresh.type === 'object') {
    const committedKeys = keysOf(committed.props);
    const freshKeys = keysOf(fresh.props);
    committedKeys.forEach((key) => {
      if (freshKeys.indexOf(key) === -1) {
        out.push(at + '.' + key + ': 提交的是 ' + describe(committed.props[key]) +
          '，采集器现在**没有**这个子字段了');
      }
    });
    freshKeys.forEach((key) => {
      if (committedKeys.indexOf(key) === -1) {
        out.push(at + '.' + key + ': 提交的是（缺席），采集器现在产出 ' +
          describe(fresh.props[key]));
      }
    });
    committedKeys.forEach((key) => {
      if (freshKeys.indexOf(key) === -1) return;
      diffShapes(committed.props[key], fresh.props[key], at + '.' + key, out);
    });
    if (!out.length) out.push(at + ': 对象形状相同但键序/其它属性不同');
    return out;
  }
  if (committed && fresh && committed.type === 'array' && fresh.type === 'array') {
    return diffShapes(committed.of, fresh.of, at + '[]', out);
  }
  out.push(at + ': 提交的是 ' + describe(committed) + '，现在是 ' + describe(fresh));
  return out;
}

/** 按 "cli.a.b" 取形状骨架。顶层键里可能带点（如 keys.items.HTMLElement.prototype 那类
 *  子键），所以先按"最长前缀"认出顶层键，再逐段走 props。 */
function shapeAt(shapes, path) {
  const parts = String(path).split('.');
  if (parts[0] !== 'cli') return null;
  const topKeys = Object.keys(shapes).filter((k) => path.indexOf('cli.' + k) === 0)
    .sort((a, b) => b.length - a.length);
  if (!topKeys.length) return null;
  const top = topKeys[0];
  let node = shapes[top];
  const rest = path.slice(('cli.' + top).length + 1);
  if (!rest) return node;
  for (const seg of rest.split('.')) {
    if (!node || node.type !== 'object' || !node.props || !node.props[seg]) return null;
    node = node.props[seg];
  }
  return node;
}

/** 走一遍形状骨架，收集所有 number<host> 的路径（与 make-contract.js 的走法一致） */
function collectHostPaths(node, at, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'number' && node.host) { out.push(at); return out; }
  if (node.type === 'object') {
    Object.keys(node.props || {}).sort()
      .forEach((k) => collectHostPaths(node.props[k], at + '.' + k, out));
    return out;
  }
  if (node.type === 'array') collectHostPaths(node.of, at + '[]', out);
  if (node.type === 'union') (node.of || []).forEach((one) => collectHostPaths(one, at, out));
  return out;
}

test('A-09 契约夹具存在且自称的身份正确', () => {
  const doc = readCommitted();
  assert.strictEqual(doc.alg, 'blog-cli-contract/1', 'alg 必须是 blog-cli-contract/1');
  assert.strictEqual(doc.generated_by, 'tests/make-contract.js');
  assert.strictEqual(doc.source, 'static/radish-collect.js');
  assert.match(doc.digest, /^sha256:[0-9a-f]{64}$/, 'digest 必须是 sha256:<64 位十六进制>');
  assert.ok(doc.digest_scope && doc.digest_scope.includes('cli_keys'), 'digest_scope 要写清对哪些字段算的');
  // 夹具里不许留生成时间这类每次都变的东西，否则两次跑不可能字节相同
  assert.ok(!('generated_at' in doc), '夹具里不许写生成时间（会破坏确定性）');
});

test('A-09 顶层 cli 键清单与当前采集器一致（109 键 + 探针专属）', async () => {
  const committed = readCommitted();
  const fresh = await gen.buildContract({ write: false });

  assert.strictEqual(committed.cli_key_count, 109, '顶层 cli 键必须是 109 个（107 项 + fpid_alg/hwid_alg）');
  assert.deepStrictEqual(
    committed.cli_keys, fresh.cli_keys,
    '顶层 cli 键清单和采集器现在的产出不一致：多了 [' +
    committed.cli_keys.filter((k) => fresh.cli_keys.indexOf(k) === -1).join(',') +
    '] / 少了 [' + fresh.cli_keys.filter((k) => committed.cli_keys.indexOf(k) === -1).join(',') + ']'
  );
  assert.deepStrictEqual(
    committed.cli_keys_probe_only, fresh.cli_keys_probe_only,
    '探针专属键（附录 G/H）和采集器现在的产出不一致'
  );
  assert.strictEqual(committed.collector, fresh.collector, '夹具里的采集器版本该跟着采集器走');
});

test('A-09 每个键的形状骨架与当前采集器一致（漂移要能点出路径）', async () => {
  const committed = readCommitted();
  const fresh = await gen.buildContract({ write: false });

  const committedKeys = keysOf(committed.shapes);
  const freshKeys = keysOf(fresh.shapes);
  assert.deepStrictEqual(
    committedKeys, freshKeys,
    'shapes 的键空间和采集器不一致：多了 [' +
    committedKeys.filter((k) => freshKeys.indexOf(k) === -1).join(',') +
    '] / 少了 [' + freshKeys.filter((k) => committedKeys.indexOf(k) === -1).join(',') + ']'
  );

  const drift = [];
  committedKeys.forEach((key) => {
    diffShapes(committed.shapes[key], fresh.shapes[key], 'cli.' + key)
      .forEach((line) => drift.push(line));
  });

  if (drift.length) {
    assert.fail(
      '契约形状漂移（夹具该重生了：node tests\\make-contract.js；若采集器确实换了口径，' +
      '还要同步 make-contract.js 里的语义表）：\n  ' + drift.join('\n  ') + '\n' +
      '提交的这份夹具是 ' + committed.collector + ' 时生成的'
    );
  }
});

test('A-09 宿主决定的数值只钉类型（number<host>），不把构建机的 Node 版本写进契约', async () => {
  const committed = readCommitted();
  const fresh = await gen.buildContract({ write: false });

  // 1) 清单本身是单一来源：夹具里登记的 patterns 必须就是 make-contract.js 里那份
  assert.deepStrictEqual(
    committed.host_numbers.patterns,
    gen.HOST_NUMBER.map((re) => re.source),
    'host_numbers.patterns 与 make-contract.js 的 HOST_NUMBER 不一致（改了一边没改另一边）'
  );
  assert.ok(committed.host_numbers.paths.length > 0, '宿主相关数值清单是空的：这份夹具没起作用');

  // 2) 清单里的每一条在 shapes 里都必须是 number<host>（否则值又被钉回契约了）
  committed.host_numbers.paths.forEach((path) => {
    const shape = shapeAt(committed.shapes, path);
    assert.ok(shape, 'host_numbers 登记了 ' + path + '，但 shapes 里没有这个路径');
    assert.strictEqual(shape.type, 'number', path + ' 应当是数值：' + describe(shape));
    assert.strictEqual(shape.host, true, path + ' 没有标成 number<host>：' + describe(shape));
    assert.strictEqual(shape.range, undefined, path + ' 不许同时钉区间（那等于又把宿主读数写死了）');
  });

  // 3) 反过来：形状上所有 number<host> 都得在清单里，别偷偷放宽别的键
  const hostInShapes = [];
  Object.keys(committed.shapes).sort().forEach((key) => {
    collectHostPaths(committed.shapes[key], 'cli.' + key, hostInShapes);
  });
  assert.deepStrictEqual(
    hostInShapes.sort(), committed.host_numbers.paths.slice().sort(),
    'shapes 里的 number<host> 与 host_numbers.paths 不一致：' +
    hostInShapes.join(',') + ' vs ' + committed.host_numbers.paths.join(',')
  );

  // 4) 采集器自己写死的数值仍然逐值比较（不能一起被放宽成 number<host>）
  committed.value_sensitive_keys.forEach((path) => {
    const shape = shapeAt(committed.shapes, path);
    assert.ok(shape, 'value_sensitive_keys 登记了不存在的路径：' + path);
    assert.strictEqual(shape.type, 'number', path + ' 应当是数值：' + describe(shape));
    assert.strictEqual(shape.host, undefined, path + ' 是采集器自己写死的数值，不许标 number<host>');
    assert.ok(Array.isArray(shape.range), path + ' 应当钉区间：' + describe(shape));
    assert.strictEqual(shape.range[0], shape.range[1],
      path + ' 应当钉住一个确定值：' + describe(shape));
  });

  // 5) 装出来的这些放宽真的只在"宿主数值"这一层：换到新采集器上，形状照样逐键比
  assert.strictEqual(committed.digest, fresh.digest, 'digest 必须与本机的引擎无关（重算一次对上）');
});

test('A-09 漂移提示能点到路径：数值变了要点名，宿主数值变了不点', () => {
  // 这条测的是比对器本身（不依赖环境）：防"把数字整体忽略"这种假绿。
  const committed = {
    type: 'object',
    props: {
      screens: { type: 'object', props: { n: { type: 'number', range: [1, 1] } } },
      engver: { type: 'object', props: { supported: { type: 'number', host: true } } }
    }
  };
  const drifted = {
    type: 'object',
    props: {
      screens: { type: 'object', props: { n: { type: 'number', range: [2, 2] } } },
      engver: { type: 'object', props: { supported: { type: 'number', host: true } } }
    }
  };
  const lines = diffShapes(committed, drifted, 'cli');
  assert.deepStrictEqual(lines, ['cli.screens.n: 提交的是 number[1,1]，现在是 number[2,2]'],
    '采集器写死的数值变了必须逐路径点名：' + JSON.stringify(lines));

  // 宿主数值的"值"根本不在形状里，所以换 Node 不再算漂移
  const otherHost = {
    type: 'object',
    props: {
      screens: { type: 'object', props: { n: { type: 'number', range: [1, 1] } } },
      engver: { type: 'object', props: { supported: { type: 'number', host: true } } }
    }
  };
  assert.deepStrictEqual(diffShapes(committed, otherHost, 'cli'), [],
    '宿主数值（number<host>）不该被当成漂移');

  // 但类型变了仍然要点名：宿主数值被写成字符串/标记一样是漂移
  const wrongType = {
    type: 'object',
    props: {
      screens: { type: 'object', props: { n: { type: 'number', range: [1, 1] } } },
      engver: { type: 'object', props: { supported: { type: 'marker' } } }
    }
  };
  const typeLines = diffShapes(committed, wrongType, 'cli');
  assert.deepStrictEqual(typeLines,
    ['cli.engver.supported: 提交的是 number<host>，现在是 marker'],
    'number<host> 只放宽取值，不放宽类型：' + JSON.stringify(typeLines));
});

test('A-09 缺失标记集合与采集器实际能产生的一致', async () => {
  const committed = readCommitted();
  const fresh = await gen.buildContract({ write: false });
  assert.deepStrictEqual(
    committed.markers, fresh.markers,
    '缺失标记集合变了：采集器现在还会写 ' +
    fresh.markers.filter((m) => committed.markers.indexOf(m) === -1).join(',') + '（多了）/ ' +
    committed.markers.filter((m) => fresh.markers.indexOf(m) === -1).join(',') + '（少了）'
  );
  // 标记只许是纯小写词，别把状态塞成 {"$":"not configured!"} 这种
  committed.markers.forEach((marker) => {
    assert.match(marker, /^[a-z_]+$/, '缺失标记必须是小写词：' + marker);
  });
  // 后端认得的那套词（RadishCloud normalize.MISSING_MARKERS）是更宽的集合；
  // 这里只保证采集器不会发明后端没登记的词。
  const backendWide = ['unsupported', 'denied', 'timeout', 'error', 'truncated',
    'not_run', 'unreadable', 'unreachable', 'not_configured'];
  const unknown = committed.markers.filter((m) => backendWide.indexOf(m) === -1);
  assert.deepStrictEqual(unknown, [], '这些标记后端没见过（= 会被当成读数）：' + unknown.join(','));
});

test('A-09 语义覆盖全部顶层键，且与 shapes 的键空间对齐', () => {
  const doc = readCommitted();
  const cliKeys = doc.cli_keys.concat(doc.cli_keys_probe_only).sort();
  const shapeKeys = keysOf(doc.shapes);
  assert.deepStrictEqual(shapeKeys, cliKeys, 'shapes 的键必须恰好是 cli 的顶层键（含探针专属键）');

  const semanticKeys = keysOf(doc.semantics);
  const topLevel = semanticKeys.filter((k) => k.indexOf('.') === -1);
  const missing = cliKeys.filter((k) => topLevel.indexOf(k) === -1);
  const extra = topLevel.filter((k) => cliKeys.indexOf(k) === -1);
  assert.deepStrictEqual(missing, [], '这些顶层键没有语义（写清楚它们测的是什么）：' + missing.join(','));
  assert.deepStrictEqual(extra, [], '语义表里有不存在的顶层键：' + extra.join(','));

  // 子字段语义必须挂在真实存在的字段上（防止写了个 cli.worker.foo 这种虚构路径）
  const deep = semanticKeys.filter((k) => k.indexOf('.') !== -1);
  deep.forEach((p) => {
    const segments = p.split('.');
    const root = segments[0];
    if (root === 'meta') {
      assert.ok(p.startsWith('meta.'), 'meta 路径必须是 meta.<key>：' + p);
      return;
    }
    assert.ok(
      cliKeys.indexOf(root) !== -1,
      '语义路径的根字段不在 cli 顶层键里：' + p
    );
    const rootShape = doc.shapes[root];
    assert.ok(rootShape, '语义路径的根字段没有形状：' + p);
  });

  // 每条语义都要是真话：不许只是键名的中文重复
  semanticKeys.forEach((key) => {
    const text = doc.semantics[key];
    assert.strictEqual(typeof text, 'string', '语义必须是一句话字符串：' + key);
    assert.ok(text.trim().length >= 8, '语义太短，等于没写：' + key + ' → ' + text);
    assert.notStrictEqual(text.trim(), key, '语义不许直接复制键名：' + key);
  });
});

test('A-09 digest 能按 digest_scope 重算（改了内容忘重算摘要会红）', () => {
  const doc = readCommitted();
  const recomputed = gen.digestOf({
    cli_keys: doc.cli_keys,
    shapes: doc.shapes,
    markers: doc.markers,
    semantics: doc.semantics
  });
  assert.strictEqual(
    recomputed, doc.digest,
    'digest 与文件内容对不上：内容被改过但摘要没重算（重跑 node tests\\make-contract.js）'
  );

  // 摘要确实绑在内容上：改一个语义就该变
  const tampered = Object.assign({}, doc.semantics);
  const firstKey = keysOf(tampered)[0];
  tampered[firstKey] = tampered[firstKey] + '（改）';
  const changed = gen.digestOf({
    cli_keys: doc.cli_keys,
    shapes: doc.shapes,
    markers: doc.markers,
    semantics: tampered
  });
  assert.notStrictEqual(changed, doc.digest, '改了语义摘要却没变，说明摘要没覆盖该字段');
});

test('A-09 样本够用且形状合规（normal / partial / optout / probe）', () => {
  const doc = readCommitted();
  assert.ok(doc.samples.length >= 3 && doc.samples.length <= 5,
    '样本应当 3–5 份，实际 ' + doc.samples.length);
  const kinds = doc.samples.map((s) => s.kind).sort();
  ['normal', 'partial', 'optout', 'probe'].forEach((kind) => {
    assert.ok(kinds.indexOf(kind) !== -1, '缺 ' + kind + ' 样本');
  });

  const byKind = {};
  doc.samples.forEach((sample) => { byKind[sample.kind] = sample.envelope; });

  // 半份与补全同号；半份少的是慢车道四项
  assert.strictEqual(byKind.partial.id, byKind.normal.id, '半份与完整必须是同一次访问');
  assert.strictEqual(byKind.partial.meta.partial, true, '半份的 meta.partial 必须是布尔 true');
  assert.strictEqual(byKind.normal.meta.partial, false);
  const slow = doc.cli_keys.filter((k) => !(k in byKind.partial.cli)).sort();
  assert.deepStrictEqual(
    slow, gen.SLOW_IDS.filter((id) => id in byKind.normal.cli).sort(),
    '半份缺席的应当正好是慢车道那几项，实际 ' + slow.join(',')
  );

  // optout 整块 cli 为空
  assert.deepStrictEqual(byKind.optout.cli, {}, 'DNT/GCP 打开时整块 cli 不该有读数');
  assert.strictEqual(byKind.optout.meta.privacy.optout, true);

  // probe 样本要能演示附录 G/H：单键标记 + 旁路原因 + H3 分类
  assert.deepStrictEqual(byKind.probe.cli.tcpfp, { $: 'not_configured' });
  assert.strictEqual(byKind.probe.cli.tcp_reason, 'npcap-not-installed');
  assert.ok(byKind.probe.cli.ja4, '缺 Npcap 不等于没有 TLS 读数');
  assert.strictEqual(byKind.probe.meta.h3.state, 'upgraded');
  assert.strictEqual(byKind.probe.cli.quicfp, byKind.probe.meta.h3.ja4,
    'quicfp 的值必须等于 meta.h3.ja4（附录 H.4）');

  // 样本里不许有 null 读数（null 无法区分"读不到"，后端会当成真值）
  doc.samples.forEach((sample) => {
    Object.keys(sample.envelope.cli).forEach((key) => {
      assert.notStrictEqual(sample.envelope.cli[key], null,
        sample.name + ' 的 cli.' + key + ' 是 null（读不到要用标记）');
    });
    const text = JSON.stringify(sample.envelope);
    assert.ok(!/"(id|session)":"(?!018f2c6e|a1b2c3d4e5)/.test(text),
      sample.name + ' 的 id/session 没有换成固定值，夹具不可复现');
  });
});

// 行尾不算契约内容：两个仓库的 core.autocrlf 可能不同（Windows 检出 CRLF、Linux 检出 LF），
// 逐字节比对会把"换行风格不同"报成"跨仓夹具漂移"。这里先统一去掉 CR 再比，
// 契约内容本身（键、形状、语义、摘要）仍然逐字节比较。
function normalizeEol(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

test('A-09 与后端仓库的同一份夹具逐字节一致（兄弟目录不在时跳过）', { skip: fs.existsSync(SIBLING) ? false : SIBLING_MISSING }, () => {
  const mine = fs.readFileSync(FIXTURE);
  const theirs = fs.readFileSync(SIBLING);
  assert.ok(mine.length > 0, '本仓库的夹具是空的');
  assert.strictEqual(
    normalizeEol(mine), normalizeEol(theirs),
    '两仓的 blog-cli-contract.json 内容不一致：跑 node tests\\make-contract.js 后把文件' +
    '复制到 RadishCloud/tests/contract/（跨仓一致是集成验收，这条只在两仓并排时才跑）'
  );
});
}

// ===== fixtures.test.js =====
{
'use strict';
// 真浏览器夹具的守护测试：字段是 Chrome/Edge CDP 实跑出来的，
// 任何一项被改坏（例如安卓被识别成桌面、国家名混进 country）都会在这里失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures', 'envelopes');
const load = name => JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));

// 夹具是 1.9.5 真浏览器跑出来的历史记录，不能为了新形状去改它。
// 1.9.6（G 127）把 form 改成 {kind, basis, formFactors, source}、model 改成
// {raw, decoded, candidates, basis, mapVersion, source}，所以这里两种形状都认：
// 老夹具读字符串/裸值，新采集器读对象里的结论字段。
const formKind = (v) => (v && typeof v === 'object' && !v.$ ? v.kind : v);
const modelName = (v) => (v && typeof v === 'object' && !v.$ ? (v.decoded || v.raw || null) : v);

test('夹具：安卓 Chrome 读的是高熵 CH，不是冻结 UA 里的 Android 10', () => {
  const e = load('androidChrome');
  assert.equal(e.cli.os, 'Android 15');
  assert.equal(e.cli.browser, 'Chrome 141');
  assert.equal(formKind(e.cli.form), 'Mobile');
  assert.equal(modelName(e.cli.model), 'Pixel 7');
  assert.equal(e.cli.arch, 'arm/64');
  assert.ok(e.cli.touch.points >= 5);
});

test('夹具：Firefox Android 不依赖 Client Hints 也能给出系统与浏览器', () => {
  const e = load('firefoxAndroid');
  assert.equal(e.cli.os, 'Android 14');
  assert.equal(e.cli.browser, 'Firefox 131');
  assert.equal(formKind(e.cli.form), 'Mobile');
  assert.equal(e.cli.engine.render, 'Gecko');
});

test('夹具：iOS Safari 版本与系统都对，渲染内核是 WebKit', () => {
  const e = load('iosSafari');
  assert.match(e.cli.os, /^iOS 17\./);
  assert.match(e.cli.browser, /^Safari 17/);
  assert.equal(formKind(e.cli.form), 'Mobile');
  assert.equal(e.cli.engine.render, 'WebKit');
});

test('夹具：桌面站点模式下 CH 说安卓，UA 说 Windows，取 CH 且不自相矛盾', () => {
  const e = load('desktopSiteMode');
  assert.equal(e.cli.os, 'Android 15', 'CH 的高熵平台版本优先于桌面 UA');
  assert.equal(formKind(e.cli.form), 'Mobile');
});

test('夹具：桌面 Chrome 是 Desktop，系统读到 Windows 11', () => {
  const e = load('desktopChrome');
  assert.equal(e.cli.os, 'Windows 11');
  assert.equal(formKind(e.cli.form), 'Desktop');
  // 这台 Windows 主机的真实读数就是 10 点触摸 + hover，别按"0 点"假设改夹具
  assert.equal(e.cli.touch.hover, true);
});

test('夹具：DNS 结果带校验过的国家代码、原始名字与解析器信息', () => {
  for (const name of ['androidChrome', 'firefoxAndroid', 'iosSafari', 'desktopSiteMode', 'desktopChrome']) {
    const dns = load(name).cli.dns;
    if (!dns || dns.$) continue;                       // 标记状态也算合法，夹具可能没跑 DNS
    assert.match(dns.country, /^[A-Z]{2}$/, name + ' 的 country 必须是两字母代码');
    assert.ok(dns.country_raw, name + ' 要保留原始国家名');
    assert.ok(dns.resolver_ip, name + ' 要保留解析器 IP');
    assert.ok([4, 6].includes(dns.family), name + ' 要保留地址族');
    assert.equal(dns.method, 'edns-ip-api-query-nonce');
  }
});

test('夹具：每个文件的顶层结构都是七键信封', () => {
  for (const name of ['androidChrome', 'firefoxAndroid', 'iosSafari', 'desktopSiteMode', 'desktopChrome']) {
    const e = load(name);
    assert.deepEqual(Object.keys(e).sort(), ['cli', 'id', 'meta', 'page', 'session', 'ts', 'v']);
    assert.equal(e.v, 1);
    assert.equal(e.id, '<uuid>', name + ' 的 id 必须脱敏');
    assert.ok(Object.keys(e.cli).length > 80, name + ' 的 cli 字段数太少，可能采集失败');
  }
});

test('夹具：1.6.0 的四项在真浏览器里都有实测读数', () => {
  const e = load('androidChrome');
  // wasm：真的编译过特性模块，不是问接口在不在。
  // 夹具是 1.9.5 的历史捕获（6 项、alg=validate-features），G 127·fp 批把它扩到 17 项
  // （wasm/2），所以两种形状都认：老夹具按 6 项，新算法按 17 项各验各的。
  const w = e.cli.wasm;
  if (w.alg === 'wasm/2') {
    assert.strictEqual(w.total, 17);
    assert.ok(w.supported >= 13, 'wasm 只过了 ' + w.supported + ' 项');
  } else {
    assert.ok(w.supported >= 5, 'wasm 只过了 ' + w.supported + ' 项');
    assert.strictEqual(w.total, 6);
  }
  // smooth：像素读数
  assert.strictEqual(e.cli.smooth.alg, 'aa-pixels');
  assert.ok(['subpixel', 'grayscale', 'none'].indexOf(e.cli.smooth.verdict) >= 0);
  // traces：写标记读回来
  assert.match(String(e.cli.traces.alg), /^storage-tag/);
  assert.strictEqual(typeof e.cli.traces.first, 'boolean');
  // engver：声明版 + 特性区间（老夹具是 feature-floor 只有下限，1.9.6 起是 feature-floor/2）
  assert.ok(/^feature-floor/.test(e.cli.engver.alg), '实际 ' + e.cli.engver.alg);
  assert.ok(e.cli.engver.floor_chromium >= 87);
  assert.ok(e.cli.engver.declared, '声明版不该是空的');
  assert.ok(e.cli.engver.total === 7 || e.cli.engver.total === 11, '实际 ' + e.cli.engver.total);
});
}

// ===== w08-handoff.test.js =====
{
'use strict';
// W-08：交接文档引用的夹具必须和当前采集器产出的字段集合一致。
//
// 复审说文档里那些"示例信封"是手写的，和采集器早就对不上了（collector 还写着
// radish-1.2.0、meta.partial 写成一个数组）。现在文档引用的是
// RadishCloud/docs/fixtures/handoff/ 下的真夹具，由 RadishCloud/tests/
// make_handoff_fixtures.js 用本仓库的 tests/harness.js 真跑生成。
//
// 这个测试做两件事：
//   1. 用同一个生成器在内存里重算一遍，把字段**集合**和落盘夹具比对——
//      采集器改了字段而夹具没重生成，这里就会红；
//   2. 检查文档确实按文件名引用了这些夹具，而不是又贴了几段手写 JSON。
//
// 只比集合、不比数值：dur_ms、ts 这类每次都不一样的字段本来就该变。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RC_ROOT = path.join(__dirname, '..', '..', 'RadishCloud');
const FIXTURE_DIR = path.join(RC_ROOT, 'docs', 'fixtures', 'handoff');
const GENERATOR = path.join(RC_ROOT, 'tests', 'make_handoff_fixtures.js');
const DOC = path.join(RC_ROOT, 'docs', 'blog-collector-handoff.md');

const SIBLING_MISSING =
  'RadishCloud 兄弟目录不在这里（单仓检出时跳过；两仓并排时这个测试必须跑起来）';
const available =
  fs.existsSync(FIXTURE_DIR) && fs.existsSync(GENERATOR) && fs.existsSync(DOC);
const skip = available ? false : SIBLING_MISSING;

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function keysOf(obj) {
  return Object.keys(obj || {}).sort();
}

test('W-08 夹具与当前采集器产出的字段集合一致', { skip }, async () => {
  const { buildFixtures } = require(GENERATOR);
  const fresh = await buildFixtures({ write: false });

  const names = keysOf(fresh);
  assert.ok(names.length >= 6, '生成器至少要产出六个夹具，实际 ' + names.length);
  names.forEach((name) => {
    const onDiskPath = path.join(FIXTURE_DIR, name);
    assert.ok(fs.existsSync(onDiskPath), `夹具 ${name} 没有落盘，请重跑 make_handoff_fixtures.js`);
    const onDisk = readFixture(name);
    const regenerated = fresh[name];

    assert.deepStrictEqual(
      keysOf(onDisk),
      keysOf(regenerated),
      `${name} 的顶层键和采集器现在的产出不一致（夹具该重生了）`
    );

    if (onDisk.meta) {
      assert.deepStrictEqual(
        keysOf(onDisk.meta),
        keysOf(regenerated.meta),
        `${name} 的 meta 键和采集器现在的产出不一致`
      );
    }
    if (onDisk.cli) {
      assert.deepStrictEqual(
        keysOf(onDisk.cli),
        keysOf(regenerated.cli),
        `${name} 的 cli 字段集合和采集器现在的产出不一致：多了 ` +
          keysOf(onDisk.cli).filter((k) => !(k in regenerated.cli)).join(',') +
          ' / 少了 ' +
          keysOf(regenerated.cli).filter((k) => !(k in onDisk.cli)).join(',')
      );
    }
  });
});

test('W-08 半份与补全是同一次访问，且慢车道项只在补全里出现', { skip }, () => {
  const half = readFixture('envelope-partial.json');
  const complete = readFixture('envelope-complete.json');
  assert.strictEqual(half.id, complete.id, '半份与补全必须同号，否则后端不会归并');
  assert.strictEqual(half.meta.partial, true);
  assert.strictEqual(complete.meta.partial, false);
  // meta.partial 是布尔值，不是"哪些项没跑完"的数组——这正是复审指出的旧文档错误
  assert.strictEqual(typeof half.meta.partial, 'boolean');
  assert.ok(!Array.isArray(half.meta.partial));

  const onlyInComplete = keysOf(complete.cli).filter((k) => !(k in half.cli));
  assert.deepStrictEqual(
    onlyInComplete,
    ['ai', 'dns', 'etag', 'trackers'],
    '半份缺席的应当正好是慢车道那四项'
  );
  keysOf(half.cli).forEach((k) => {
    assert.ok(k in complete.cli, `补全丢了半份里已有的字段 ${k}`);
  });
});

test('W-08 退出收集的夹具不带浏览器读数', { skip }, () => {
  const payload = readFixture('envelope-optout.json');
  assert.deepStrictEqual(payload.cli, {}, 'DNT/GPC 打开时整块 cli 不该有读数');
  assert.strictEqual(payload.meta.privacy.optout, true);
  assert.strictEqual(payload.meta.privacy.dnt, true);
});

test('W-08 探针失败的夹具保持缺失标记 + 旁路原因', { skip }, () => {
  const payload = readFixture('envelope-probe-npcap-missing.json');
  assert.deepStrictEqual(payload.cli.tcpfp, { $: 'not_configured' });
  assert.strictEqual(payload.cli.tcp_reason, 'npcap-not-installed');
  assert.ok(payload.cli.ja4, '缺 Npcap 不等于没有 TLS 读数');
  assert.ok(payload.cli.h2fp, '缺 Npcap 不等于没有 HTTP/2 读数');

  const probe = readFixture('probe-fp-npcap-missing.json');
  assert.deepStrictEqual(probe.response.tcp, { $: 'not_configured' });
  assert.strictEqual(probe.response.tcp_reason, 'npcap-not-installed');
});

test('W-08 文档按文件名引用夹具，而不是贴手写 JSON', { skip }, () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const names = fs.readdirSync(FIXTURE_DIR).sort();
  assert.ok(names.length >= 6, '夹具目录里应当至少六个文件');
  names.forEach((name) => {
    assert.ok(
      doc.includes(name),
      `文档没有引用夹具 ${name}（docs/fixtures/handoff/${name}）`
    );
  });
  assert.ok(
    doc.includes('docs/fixtures/handoff/'),
    '文档应当给出夹具目录，读者才能自己打开原文件'
  );
});

test('W-08 文档里不再有过时的形状与真实地址', { skip }, () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  // 文档里可以提到"老版本号长这样"来提醒读者，但不能把它当成示例的取值
  assert.ok(
    !/"collector"\s*:\s*"radish-1\.2\.0"/.test(doc),
    '文档还把 radish-1.2.0 当成 collector 的取值示例'
  );
  assert.ok(!doc.includes('1.2.3.4'), '文档里还有真实地址 1.2.3.4，应换成 192.0.2.4');
  assert.ok(doc.includes('192.0.2.4'), '文档应当用 RFC 5737 的 192.0.2.4 举例');
  assert.ok(/tcp_reason/.test(doc), '探针缺失原因要走旁路字段 tcp_reason');
  assert.ok(/not_configured/.test(doc), 'tcp 缺失标记要写成 not_configured');
  assert.ok(
    /meta\.partial/.test(doc),
    '文档要说明 meta.partial 是布尔值（半份/补全协议）'
  );
});
}
