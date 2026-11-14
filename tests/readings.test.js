'use strict';
// 各项读数（浏览器能力、指纹字段、场景判断）。
// 由 25 个小文件合并而来：只调整了文件组织，断言与用例名一律照原样保留。

// ===== g127-a-voices-budget.test.js =====
{
'use strict';
// G 127 · A：voices 的裁剪改成**预算驱动**。
// 旧行为：applyBudget 的 HARD 表无条件把 voices 裁到 32 条——信封还有 30 KiB 余量时
// 也在少报，而且读的人看不出少报了。现在的语义：
//   total  采集到的原始总数（不随裁剪变）
//   shown  这一份里实际带出去几条
//   cut    只在 shown < total 时为 true
//   meta.truncated 里记 {id:'voices', n: total}
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function voiceEnv(n, nameLen) {
  const env = fakeEnv();
  const list = Array.from({ length: n }, (_, i) => ({
    name: 'Voice ' + i + ' ' + 'x'.repeat(nameLen || 8),
    lang: 'zh-CN',
    localService: i % 2 === 0,
    default: i === 0
  }));
  env.speechSynthesis = {
    getVoices: () => list,
    addEventListener() { },
    removeEventListener() { }
  };
  return env;
}

test('A1：预算充足时一条都不裁（shown === total，cut=false）', async () => {
  const e = await loadCollector(voiceEnv(80, 20)).buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.voices);
  assert.strictEqual(v.total, 80);
  assert.strictEqual(v.shown, 80);
  assert.strictEqual(v.cut, false);
  assert.strictEqual(v.list.length, 80);
  assert.strictEqual(v.alg, 'voices/2');
  // 整份照样塞得进 48 KiB：预算检查不该动它
  const out = loadCollector(fakeEnv()).applyBudget(JSON.parse(JSON.stringify(e)), 48 * 1024);
  assert.strictEqual(out.envelope.cli.voices.shown, 80);
  assert.strictEqual(out.envelope.cli.voices.cut, false);
  assert.strictEqual(out.bytes <= 48 * 1024, true);
});

test('A2：预算紧时按剩余预算少发，但 total 仍是真实总数、cut=true、truncated 记 n', async () => {
  const RC = loadCollector(fakeEnv());
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  e.cli.voices = {
    alg: 'voices/2',
    total: 240,
    shown: 240,
    cut: false,
    source: 'speechSynthesis.getVoices',
    list: Array.from({ length: 240 }, (_, i) => ({
      name: 'Voice ' + i + ' ' + 'y'.repeat(30), lang: 'zh-CN', localService: true, default: false
    }))
  };
  const limit = 12 * 1024;
  const out = RC.applyBudget(e, limit);
  const v = plain(out.envelope.cli.voices);
  assert.ok(out.bytes <= limit, 'bytes=' + out.bytes);
  assert.ok(v.shown < v.total, 'shown=' + v.shown + ' total=' + v.total);
  assert.ok(v.shown >= 1, '至少留一条给读的人看结构');
  assert.strictEqual(v.total, 240, 'total 必须还是采集到的真实总数');
  assert.strictEqual(v.cut, true);
  assert.strictEqual(v.list.length, v.shown);
  assert.deepStrictEqual(plain(out.dropped).filter((d) => d.id === 'voices'), [{ id: 'voices', n: 240 }]);
  assert.deepStrictEqual(plain(out.envelope.meta.truncated).filter((d) => d.id === 'voices'), [{ id: 'voices', n: 240 }]);
});

test('A3：没有 speechSynthesis 时是 unsupported（不是空对象）', async () => {
  const env = fakeEnv();
  delete env.speechSynthesis;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.voices), { $: 'unsupported' });
});

test('A4：采集端解析上限（VOICE_POOL=300）也如实记进 total/cut', async () => {
  const env = voiceEnv(420, 4);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const v = plain(e.cli.voices);
  assert.strictEqual(v.total, 420, '总数是 getVoices() 的真实条数');
  assert.strictEqual(v.shown, 300, '解析池上限 300');
  assert.strictEqual(v.cut, true);
});
}

// ===== g127-b-form.test.js =====
{
'use strict';
// G 127 · B：form（dev）从"mobile/UA/iPad 粗分"改成消费高熵 formFactors。
// 形状：{kind, basis, formFactors, source}
//   basis ∈ {ua-ch-form-factors, ua-mobile, touch-heuristic}
//   ua-ch-form-factors  高熵 Sec-CH-UA-Form-Factors（浏览器亲口说的形态）
//   ua-mobile           低熵 userAgentData.mobile，或 UA 里的 Mobile/Tablet 标记
//   touch-heuristic     触屏点 + 屏幕宽度 + Macintosh（iPadOS 桌面模式）推断
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function uaChEnv(high, low) {
  const env = fakeEnv();
  env.navigator.userAgentData = Object.assign({
    platform: 'Windows',
    mobile: false,
    brands: [{ brand: 'Chromium', version: '141.0.0.0' }],
    getHighEntropyValues: () => Promise.resolve(high || {})
  }, low || {});
  return env;
}

test('B1：有高熵 formFactors 就以它为准（basis=ua-ch-form-factors）', async () => {
  const env = uaChEnv({ formFactors: ['Tablet'], model: 'Pixel Tablet' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const f = plain(e.cli.form);
  assert.strictEqual(f.kind, 'Tablet');
  assert.strictEqual(f.basis, 'ua-ch-form-factors');
  assert.deepStrictEqual(f.formFactors, ['Tablet']);
  assert.strictEqual(f.source, 'sec-ch-ua-form-factors');
});

test('B2：只有低熵 mobile 时退回 ua-mobile，并写清来源', async () => {
  const env = fakeEnv();
  env.navigator.userAgentData = { platform: 'Android', mobile: true, brands: [{ brand: 'Chromium', version: '141.0.0.0' }] };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const f = plain(e.cli.form);
  assert.strictEqual(f.kind, 'Mobile');
  assert.strictEqual(f.basis, 'ua-mobile');
  assert.deepStrictEqual(f.formFactors, []);
  assert.strictEqual(f.source, 'navigator.userAgentData.mobile');
});

test('B3：iPad 桌面模式（Macintosh UA + 触屏）走 touch-heuristic', async () => {
  const env = fakeEnv();
  env.navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  env.navigator.maxTouchPoints = 5;
  env.screen = { width: 1024, height: 1366, availWidth: 1024, availHeight: 1330, colorDepth: 24, isExtended: false };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const f = plain(e.cli.form);
  assert.strictEqual(f.kind, 'Tablet');
  assert.strictEqual(f.basis, 'touch-heuristic');
  assert.strictEqual(f.source, 'navigator.maxTouchPoints');
});

test('B4：高熵里没有 formFactors 时退回粗分，不硬编 ua-ch-form-factors', async () => {
  const env = uaChEnv({ model: 'Pixel 8', platformVersion: '14.0.0' }, { mobile: true, platform: 'Android' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const f = plain(e.cli.form);
  assert.strictEqual(f.kind, 'Mobile');
  assert.strictEqual(f.basis, 'ua-mobile');
  assert.deepStrictEqual(f.formFactors, []);
});

test('B5：iPhone UA 没有 UA-CH 时也判 Mobile（不是 Desktop）', async () => {
  const env = fakeEnv();
  env.navigator.userAgent = IPHONE_UA;
  env.navigator.maxTouchPoints = 5;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const f = plain(e.cli.form);
  assert.strictEqual(f.kind, 'Mobile');
  assert.strictEqual(f.basis, 'ua-mobile');
});
}

// ===== g127-c-model.test.js =====
{
'use strict';
// G 127 · C：model（dev）机型名称映射。
// 返回 {raw, decoded, candidates, basis, mapVersion, source}：
//   Android  高熵 model 常给代码名（panther / SM-G991B），配一张**带来源与版本**的
//            有限表翻译；表外的一律 decoded:null，不猜。
//   Apple    UA 与 CH 都不给机型，只能用「屏幕逻辑尺寸 + DPR + GPU renderer」给候选，
//            永不输出唯一结论。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function androidEnv(model) {
  const env = fakeEnv();
  env.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  env.navigator.userAgentData = {
    platform: 'Android',
    mobile: true,
    brands: [{ brand: 'Chromium', version: '141.0.0.0' }],
    getHighEntropyValues: () => Promise.resolve({ model, platformVersion: '14.0.0', architecture: 'arm', bitness: '64' })
  };
  return env;
}

test('C1：Android 已知代码名翻成市场名，表带版本与来源', async () => {
  const RC = loadCollector(androidEnv('panther'));
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const m = plain(e.cli.model);
  assert.strictEqual(m.raw, 'panther');
  assert.strictEqual(m.decoded, 'Pixel 7');
  assert.strictEqual(m.matched, 'panther');
  assert.strictEqual(m.mapVersion, 'android-codenames-2024a');
  assert.strictEqual(m.mapVersion, RC.MODEL_MAP_VERSION);
  assert.ok(/AOSP/.test(m.source), 'source 要能注到出处：' + m.source);
  assert.deepStrictEqual(m.candidates, [{ name: 'Pixel 7', confidence: 1, basis: 'codename-table' }]);
  assert.strictEqual(m.basis, 'ua-ch-model+map');
});

test('C2：三星机型码也走同一张表', async () => {
  const e = await loadCollector(androidEnv('SM-G991B')).buildEnvelope(undefined, collectorCtx());
  const m = plain(e.cli.model);
  assert.strictEqual(m.decoded, 'Galaxy S21 5G');
  assert.strictEqual(m.entrySource, 'samsung-model-code');
});

test('C3：表里没有的代码名 decoded:null（不编名字），raw 与 basis 如实保留', async () => {
  const e = await loadCollector(androidEnv('SM-Q999Z')).buildEnvelope(undefined, collectorCtx());
  const m = plain(e.cli.model);
  assert.strictEqual(m.raw, 'SM-Q999Z');
  assert.strictEqual(m.decoded, null);
  assert.deepStrictEqual(m.candidates, []);
  assert.strictEqual(m.basis, 'ua-ch-model-unmapped');
  assert.strictEqual(m.mapVersion, 'android-codenames-2024a');
});

test('C4：Apple 用屏幕逻辑尺寸 + DPR 给候选，绝不给唯一结论', async () => {
  const env = fakeEnv();
  env.navigator.userAgent = IPHONE_UA;
  env.screen = { width: 390, height: 844, availWidth: 390, availHeight: 844, colorDepth: 24, isExtended: false };
  env.devicePixelRatio = 3;
  const RC = loadCollector(env);
  const e = await RC.buildEnvelope(undefined, collectorCtx());
  const m = plain(e.cli.model);
  assert.strictEqual(m.raw, null, 'iOS 没有机型字段');
  assert.strictEqual(m.decoded, null, '候选不是结论');
  assert.strictEqual(m.basis, 'screen-gpu-candidate');
  assert.strictEqual(m.mapVersion, RC.APPLE_MAP_VERSION);
  assert.ok(m.candidates.length >= 1, '至少给出一条候选');
  assert.deepStrictEqual(m.matchedBy, { w: 390, h: 844, dpr: 3 });
  for (const c of m.candidates) {
    assert.ok(c.confidence > 0 && c.confidence <= 0.8, 'confidence 必须在 (0, 0.8]：' + c.confidence);
  }
});

test('C5：桌面没有机型字段时是 unsupported（不是编一个 candidate）', async () => {
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.model), { $: 'unsupported' });
});

test('C6：表是有限的、每条都有来源（防止有人往表里塞没出处的条目）', () => {
  const RC = loadCollector(fakeEnv());
  const allowed = ['aosp-pixel', 'aosp-nexus', 'samsung-model-code'];
  assert.ok(RC.MODEL_CODES.length >= 20, '表条目数：' + RC.MODEL_CODES.length);
  for (const row of RC.MODEL_CODES) {
    assert.strictEqual(row.length, 3, '每条必须是 [代码名, 市场名, 来源]：' + JSON.stringify(row));
    assert.ok(allowed.includes(row[2]), '来源必须是已核对的出处：' + row[2]);
  }
});
}

// ===== g127-d-gpulim.test.js =====
{
'use strict';
// G 127 · D：gpulim（dev）补全 GPUAdapter 的 limits / features。
//   - limits：枚举 adapter.limits 的**全部标量字段**（原型 getter 上的也要枚举到）
//   - features：全量清单
//   - adapter：high-performance / low-power 各一份，**复用** webgpu 那一项的请求
//   - webglFallback：WebGL 侧读数另标来源，不与 WebGPU limits 合并
//   - alg: 'gpulim/2'
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

// 真实 GPUAdapterLimits 的字段是原型上的 getter：Object.keys 拿不到，只能 for..in 或读原型。
class ProtoLimits {
  get maxTextureDimension2D() { return 8192; }
  get maxTextureDimension3D() { return 2048; }
  get maxBufferSize() { return 268435456; }
  get maxComputeWorkgroupSizeX() { return 256; }
  get maxBindGroups() { return 4; }
  get minUniformBufferOffsetAlignment() { return 256; }
}

// 另一条路径：普通对象（for..in 就能枚举到）
function plainLimits() {
  return { maxTextureDimension2D: 16384, maxBufferSize: 1073741824, maxBindGroups: 8 };
}

const GL = {
  VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, SHADING_LANGUAGE_VERSION: 0x8B8C,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_VIEWPORT_DIMS: 0x0D3A,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, HIGH_FLOAT: 0x8DF2,
  getParameter(k) {
    if (k === 0x1F00) return 'WebKit';
    if (k === 0x1F01) return 'WebKit WebGL';
    if (k === 0x1F02) return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
    if (k === 0x8B8C) return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
    if (k === 0x0D33) return 16384;
    if (k === 0x84E8) return 16384;
    if (k === 0x0D3A) return [32767, 32767];
    if (k === 0x9245) return 'Google Inc. (Intel)';
    if (k === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
    return null;
  },
  getExtension(name) {
    return /debug_renderer_info/.test(name) ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 } : null;
  },
  getSupportedExtensions() { return ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_debug_renderer_info']; },
  getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; }
};

function glEnv(over) {
  const env = fakeEnv(over);
  env.document.createElement = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, className: '',
    offsetWidth: 100, clientWidth: 85, offsetHeight: 250, clientHeight: 250,
    setAttribute(k, v) { this[k] = v; }, appendChild() { }, removeChild() { },
    getContext(kind) {
      if (/webgl/i.test(String(kind))) return GL;
      return { measureText: () => ({ width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) };
    },
    getBoundingClientRect: () => ({ width: 137.5, height: 43.25, x: 1.5, top: 2.5 }),
    getClientRects: () => [{}, {}],
    toDataURL: () => 'data:image/png;base64,AAA'
  });
  return env;
}

function gpuEnv(kind) {
  const env = glEnv();
  const calls = [];
  function adapter(limits) {
    return {
      limits: limits || new ProtoLimits(),
      features: new Set(['shader-f16', 'timestamp-query', 'depth-clip-control']),
      isFallbackAdapter: false,
      info: { vendor: 'intel', architecture: 'gen-12lp', device: '', description: 'Intel UHD' }
    };
  }
  env.navigator.gpu = {
    requestAdapter(opts) {
      const pref = (opts && opts.powerPreference) || 'default';
      calls.push(pref);
      return Promise.resolve(adapter(kind === 'plain' && pref === 'low-power' ? plainLimits() : null));
    }
  };
  env.__calls = calls;
  return env;
}

test('D1：枚举 limits 的全部标量字段（原型 getter 也要读到）', async () => {
  const env = gpuEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.strictEqual(g.alg, 'gpulim/2');
  assert.strictEqual(g.src, 'webgpu');
  assert.ok(g.fields >= 6, '枚举到的字段数：' + g.fields);
  assert.strictEqual(g.limits.maxTextureDimension2D, 8192);
  assert.strictEqual(g.limits.maxBufferSize, 268435456);
  assert.strictEqual(g.limits.maxComputeWorkgroupSizeX, 256);
  assert.strictEqual(g.maxTexDim, 8192, '兼容字段仍在');
  assert.deepStrictEqual(Object.keys(g.limits), Object.keys(g.limits).slice().sort(), '键序要稳定（字典序）');
});

test('D2：features 全量保留，并给总数', async () => {
  const env = gpuEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.deepStrictEqual(g.features, ['shader-f16', 'timestamp-query', 'depth-clip-control']);
  assert.strictEqual(g.featuresCount, 3);
});

test('D3：high-performance 与 low-power 各请求一次，webgpu 复用同一份（不重复请求）', async () => {
  const env = gpuEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.strictEqual(env.__calls.filter((p) => p === 'high-performance').length, 1, 'high 只该请求一次：' + JSON.stringify(env.__calls));
  assert.strictEqual(env.__calls.filter((p) => p === 'low-power').length, 1, 'low 只该请求一次：' + JSON.stringify(env.__calls));
  assert.ok(g.adapter['high-performance'], '要留下 high-performance 那一份');
  assert.ok(g.adapter['low-power'], '要留下 low-power 那一份');
  assert.strictEqual(g.adapter['high-performance'].fields, g.adapter['high-performance'].fields);
  assert.strictEqual(g.limitsSrc, 'high-performance');
});

test('D4：普通对象形状的 limits 也能枚举（for..in 路径）', async () => {
  const env = gpuEnv('plain');
  // 让 high 也走普通对象：把两个 pref 都换成 plainLimits
  env.navigator.gpu.requestAdapter = function (opts) {
    env.__calls.push((opts && opts.powerPreference) || 'default');
    return Promise.resolve({ limits: plainLimits(), features: ['shader-f16'], isFallbackAdapter: true });
  };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.strictEqual(g.limits.maxTextureDimension2D, 16384);
  assert.strictEqual(g.fields, 3);
  assert.deepStrictEqual(g.features, ['shader-f16']);
  assert.strictEqual(g.adapter['high-performance'].fallback, true);
});

test('D5：WebGL 侧的读数另标来源，不混进 WebGPU limits', async () => {
  const env = gpuEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.strictEqual(g.webglFallback.src, 'webgl');
  assert.strictEqual(g.webglFallback.maxTexDim, 16384);
  assert.deepStrictEqual(g.webglFallback.maxViewport, [32767, 32767]);
  assert.strictEqual(g.webglFallback.extCount, 3);
  assert.strictEqual(g.limits.maxTextureDimension2D === g.webglFallback.maxTexDim, false, '两份读数不许混算成同一份');
});

test('D6：没有 WebGPU 时退回 src=webgl（老形状），adapter 为 null', async () => {
  const env = glEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gpulim);
  assert.strictEqual(g.src, 'webgl');
  assert.strictEqual(g.adapter, null);
  assert.strictEqual(g.maxTexDim, 16384);
  assert.ok(Array.isArray(g.features) && g.features.length === 3);
  assert.strictEqual(g.webglFallback.src, 'webgl');
});

test('D7：既没有 WebGPU 也没有 WebGL 时是 unsupported', async () => {
  const env = fakeEnv();
  env.document.createElement = () => ({
    tagName: 'CANVAS', style: {}, className: '', offsetWidth: 0, clientHeight: 0, offsetHeight: 0,
    setAttribute() { }, appendChild() { }, removeChild() { }, getContext: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }), getClientRects: () => [], toDataURL: () => ''
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.gpulim), { $: 'unsupported' });
});
}

// ===== g127-e-glx.test.js =====
{
'use strict';
// G 127 · E：glx（dev）WebGL 能力补全。
// 保留既有纹理/缓冲/viewport 字段；新增 shaderPrecision、version/sl、完整扩展名清单。
// 全部在**假 WebGL 上下文**上验，没有声称真实浏览器结果。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const C = {
  VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, SHADING_LANGUAGE_VERSION: 0x8B8C,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_VIEWPORT_DIMS: 0x0D3A,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, HIGH_FLOAT: 0x8DF2,
  UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246
};

function fakeGl(over) {
  const gl = Object.assign({}, C, {
    getParameter(k) {
      if (k === C.VENDOR) return 'WebKit';
      if (k === C.RENDERER) return 'WebKit WebGL';
      if (k === C.VERSION) return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
      if (k === C.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00';
      if (k === C.MAX_TEXTURE_SIZE) return 16384;
      if (k === C.MAX_RENDERBUFFER_SIZE) return 16384;
      if (k === C.MAX_VIEWPORT_DIMS) return [32767, 32767];
      if (k === C.UNMASKED_VENDOR_WEBGL) return 'Google Inc. (NVIDIA)';
      if (k === C.UNMASKED_RENDERER_WEBGL) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)';
      return null;
    },
    getExtension(name) {
      if (/debug_renderer_info/.test(name)) {
        return { UNMASKED_VENDOR_WEBGL: C.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: C.UNMASKED_RENDERER_WEBGL };
      }
      return null;
    },
    getSupportedExtensions() {
      return ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_debug_renderer_info', 'KHR_parallel_shader_compile'];
    },
    getShaderPrecisionFormat(shaderType, precisionType) {
      if (over && over.throwPrecision) throw new Error('no precision');
      return { precision: 23, rangeMin: 127, rangeMax: 127, shaderType, precisionType };
    }
  });
  if (over && over.dropPrecision) delete gl.getShaderPrecisionFormat;
  return gl;
}

function envWithGl(over) {
  const env = fakeEnv(over);
  const gl = fakeGl(over);
  env.document.createElement = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, className: '',
    offsetWidth: 100, clientWidth: 85, offsetHeight: 250, clientHeight: 250,
    setAttribute(k, v) { this[k] = v; }, appendChild() { }, removeChild() { },
    getContext(kind) {
      if (/webgl/i.test(String(kind))) return gl;
      return { measureText: () => ({ width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) };
    },
    getBoundingClientRect: () => ({ width: 137.5, height: 43.25, x: 1.5, top: 2.5 }),
    getClientRects: () => [{}, {}],
    toDataURL: () => 'data:image/png;base64,AAA'
  });
  return env;
}

test('E1：shaderPrecision 取 vertex/fragment 的 precision/rangeMin/rangeMax', async () => {
  const e = await loadCollector(envWithGl()).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.glx);
  assert.strictEqual(g.alg, 'glx/2');
  assert.deepStrictEqual(g.shaderPrecision.vertex, { precision: 23, rangeMin: 127, rangeMax: 127, type: 'high_float' });
  assert.deepStrictEqual(g.shaderPrecision.fragment, { precision: 23, rangeMin: 127, rangeMax: 127, type: 'high_float' });
});

test('E2：version 与着色语言版本各自留一份', async () => {
  const e = await loadCollector(envWithGl()).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.glx);
  assert.match(g.version, /^WebGL 2\.0/);
  assert.match(g.sl, /GLSL ES 3\.00/);
});

test('E3：扩展是完整清单（extNames），ext 仍是数量（兼容老消费者）', async () => {
  const e = await loadCollector(envWithGl()).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.glx);
  assert.strictEqual(g.ext, 4);
  assert.deepStrictEqual(g.extNames, ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_debug_renderer_info', 'KHR_parallel_shader_compile']);
});

test('E4：既有的纹理/缓冲/viewport 字段一个都不少', async () => {
  const e = await loadCollector(envWithGl()).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.glx);
  assert.strictEqual(g.maxTexture, 16384);
  assert.strictEqual(g.maxRenderbuffer, 16384);
  assert.deepStrictEqual(g.maxViewport, [32767, 32767]);
});

test('E5：没有 getShaderPrecisionFormat 时 shaderPrecision 是 null（不编 0）', async () => {
  const e = await loadCollector(envWithGl({ dropPrecision: true })).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.glx);
  assert.strictEqual(g.shaderPrecision, null);
  assert.strictEqual(g.maxTexture, 16384, '其它字段照常给');
});

test('E6：没有 WebGL 上下文时是 unsupported', async () => {
  const env = fakeEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.glx), { $: 'unsupported' });
});
}

// ===== g127-f-bio.test.js =====
{
'use strict';
// G 127 · F：bio（dev）通行密钥能力。
// 有 PublicKeyCredential.getClientCapabilities() 就逐项记真值（basis=getClientCapabilities）；
// 老浏览器没有这个 API 就退回 isUVPAA 并**写清 basis**，绝不把"接口不在"说成"能力 false"。
// 形状：{alg, uvp:{isUVPAA, source}, capabilities: {...}|null, basis}
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function pkEnv(over) {
  const env = fakeEnv();
  env.PublicKeyCredential = Object.assign({
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true)
  }, over || {});
  return env;
}

test('F1：getClientCapabilities 存在时逐项记真值', async () => {
  const env = pkEnv({
    getClientCapabilities: () => Promise.resolve({
      conditionalGet: true,
      conditionalCreate: false,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      relatedOrigins: false,
      signalAllAcceptedCredentials: true,
      signalUnknownCredential: false,
      userVerifyingPlatformAuthenticator: true
    })
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const b = plain(e.cli.bio);
  assert.strictEqual(b.alg, 'pk-capabilities/1');
  assert.strictEqual(b.basis, 'getClientCapabilities');
  assert.strictEqual(b.capabilities.conditionalGet, true);
  assert.strictEqual(b.capabilities.conditionalCreate, false);
  assert.strictEqual(b.capabilities.hybridTransport, true);
  assert.strictEqual(b.capabilities.signalUnknownCredential, false);
  assert.strictEqual(b.capabilities.userVerifyingPlatformAuthenticator, true);
  assert.strictEqual(b.uvp.isUVPAA, true, 'isUVPAA 仍然单独保留');
});

test('F2：getClientCapabilities 同步返回对象也能读（早期实现不是 Promise）', async () => {
  const env = pkEnv({ getClientCapabilities: () => ({ hybridTransport: true, relatedOrigins: true }) });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const b = plain(e.cli.bio);
  assert.strictEqual(b.basis, 'getClientCapabilities');
  assert.strictEqual(b.capabilities.hybridTransport, true);
  assert.strictEqual(b.capabilities.relatedOrigins, true);
  assert.strictEqual(Object.keys(b.capabilities).length, 2);
});

test('F3：老浏览器只有 isUVPAA → capabilities:null，basis=isUVPAA', async () => {
  const env = pkEnv({ isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false) });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const b = plain(e.cli.bio);
  assert.strictEqual(b.basis, 'isUVPAA');
  assert.strictEqual(b.capabilities, null);
  assert.strictEqual(b.uvp.isUVPAA, false);
  assert.strictEqual(b.uvp.source, 'isUserVerifyingPlatformAuthenticatorAvailable');
});

test('F4：getClientCapabilities 抛错时退回 isUVPAA，不当成"全都能用"', async () => {
  const env = pkEnv({
    getClientCapabilities: () => Promise.reject(new Error('not allowed')),
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true)
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const b = plain(e.cli.bio);
  assert.strictEqual(b.basis, 'isUVPAA');
  assert.strictEqual(b.capabilities, null);
  assert.strictEqual(b.uvp.isUVPAA, true);
});

test('F5：两个接口都读不到时是 unsupported', async () => {
  const env = fakeEnv();
  env.PublicKeyCredential = {};
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.bio), { $: 'unsupported' });
});

test('F6：完全没有 PublicKeyCredential 时也是 unsupported', async () => {
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.bio), { $: 'unsupported' });
});
}

// ===== g127-fp-audio.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.10：audio/2
// 保住压缩器指纹摘要（sum），另加一组物理量交叉核对：声明的采样率/帧数/声道
// 与真渲染出来的缓冲区是否自洽；实时上下文的延迟/声道上限是否在物理范围内。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** OfflineAudioContext 替身：默认"物理自洽"，over 里可以逐项造假 */
function audioEnv(over) {
  over = over || {};
  const env = fakeEnv();
  const closed = { n: 0, opened: 0 };
  env.OfflineAudioContext = function (channels, frames, rate) {
    this.numberOfChannels = channels;
    this.length = frames;
    this.sampleRate = rate;
    this.destination = { maxChannelCount: 2 };
    this.createOscillator = () => ({ type: '', frequency: { value: 0 }, connect() { }, start() { } });
    this.createDynamicsCompressor = () => ({ connect() { } });
    this.startRendering = () => Promise.resolve({
      sampleRate: over.reportRate === undefined ? rate : over.reportRate,
      length: over.reportFrames === undefined ? frames : over.reportFrames,
      duration: (over.reportFrames === undefined ? frames : over.reportFrames) / (over.reportRate === undefined ? rate : over.reportRate),
      numberOfChannels: over.reportChannels === undefined ? channels : over.reportChannels,
      getChannelData: () => new Float32Array(over.reportFrames === undefined ? frames : over.reportFrames)
    });
  };
  env.AudioContext = function () {
    closed.opened++;   // audiohw 探针也会开一个实时上下文，这里按"开一个关一个"来验
    return {
      state: over.rtState === undefined ? 'running' : over.rtState,
      sampleRate: over.rtRate === undefined ? 48000 : over.rtRate,
      baseLatency: over.baseLatency === undefined ? 0.01 : over.baseLatency,
      outputLatency: 0.02,
      destination: { maxChannelCount: 2 },
      close() { closed.n++; return Promise.resolve(); }
    };
  };
  return { env, closed };
}

test('audio/2：渲染读数与声明参数逐项自洽，不一致清单为空', async () => {
  const { env, closed } = audioEnv();
  const a = plain((await cliOf(env)).audio);
  assert.equal(a.alg, 'audio/2');
  assert.equal(a.rate, 44100);
  assert.equal(a.frames, 4500);
  assert.equal(typeof a.sum, 'number');
  assert.deepStrictEqual(a.mismatches, [], '不该有物理量不一致：' + JSON.stringify(a.mismatches));
  const names = a.checks.map((c) => c.name).sort();
  for (const want of ['sampleRate', 'frames', 'duration', 'channels', 'dataLength', 'offlineBaseLatency', 'realtimeState', 'baseLatency', 'maxChannelCount']) {
    assert.ok(names.includes(want), '缺核对项 ' + want + '，实际 ' + names.join(','));
  }
  for (const c of a.checks) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['actual', 'expected', 'name', 'ok'], c.name + ' 的四字段不全');
  }
  assert.ok(closed.opened >= 1, 'audio 探针要开一个实时上下文读延迟/声道上限');
  assert.equal(closed.n, closed.opened, '开一个就必须关一个，否则一直占着音频线程');
});

test('audio/2：渲染出来的采样率/帧数对不上声明时点名列出，不悄悄放过', async () => {
  const { env } = audioEnv({ reportRate: 48000, reportFrames: 4410, reportChannels: 2 });
  const a = plain((await cliOf(env)).audio);
  assert.ok(a.mismatches.includes('sampleRate'), JSON.stringify(a.mismatches));
  assert.ok(a.mismatches.includes('frames'));
  assert.ok(a.mismatches.includes('channels'));
  const sr = a.checks.find((c) => c.name === 'sampleRate');
  assert.equal(sr.expected, 44100);
  assert.equal(sr.actual, 48000);
  assert.equal(sr.ok, false);
});

test('audio/2：延迟读数超出物理范围时点名 baseLatency', async () => {
  const { env } = audioEnv({ baseLatency: 3.5 });
  const a = plain((await cliOf(env)).audio);
  assert.deepStrictEqual(a.mismatches, ['baseLatency'], JSON.stringify(a.mismatches));
});

test('audio/2：没有 OfflineAudioContext 就记 unsupported', async () => {
  const a = plain((await cliOf(fakeEnv())).audio);
  assert.deepStrictEqual(a, { $: 'unsupported' });
});
}

// ===== g127-fp-cssv.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.4：cssv/2
// 逐特性真值 + 首用版本/年份。CSS.supports 只回答"这条声明认不认"，
// @layer 与嵌套选择器是 at-rule/选择器语法，得塞进样式表数 cssRules——两种测法分开记。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 只认这几条声明的 CSS.supports 桩 */
function supportsEnv(accept) {
  const env = fakeEnv();
  env.CSS = {
    supports(query) {
      return accept.some((s) => String(query).indexOf(s) >= 0);
    }
  };
  return env;
}

/** 能"解析样式表"的 style 元素桩：@layer 出一条规则，带 & 的嵌套出一条带 cssRules 的规则 */
function styleEnv() {
  const env = supportsEnv([]); // supports 全否，逼着 layer/nesting 走解析这条路
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    if (String(tag).toLowerCase() !== 'style') return orig(tag);
    return {
      textContent: '',
      get sheet() {
        const text = String(this.textContent || '');
        const rules = [];
        if (/^@layer/.test(text)) rules.push({ cssText: text });
        if (text.indexOf('&') >= 0) rules.push({ cssRules: [{ cssText: text }] });
        return { cssRules: rules };
      }
    };
  };
  return env;
}

test('cssv/2：14 项特性各带 supported/sinceYear/min，清单按版本升序', async () => {
  const RC = loadCollector(fakeEnv());
  const rows = plain(RC.CSSV_FEATURES);
  assert.equal(rows.length, 14);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i][1] >= rows[i - 1][1], '版本要按升序：' + rows.map((r) => r[1]).join(','));
    assert.ok(rows[i][2] >= rows[i - 1][2], '年份要跟着版本单调：' + rows.map((r) => r[2]).join(','));
  }
  for (const [name, version, year, how] of rows) {
    assert.ok(['supports', 'parse'].includes(how), name + ' 的测法=' + how);
    assert.ok(version >= 40 && year >= 2015, name + ' 的版本/年份不像话：' + version + '/' + year);
  }
});

test('cssv/2：support/总量/最新年份都由逐项真值算出来，不写死', async () => {
  const v = plain((await cliOf(supportsEnv(['display:grid', 'aspect-ratio:1/1', 'color:color-mix']))).cssv);
  assert.equal(v.alg, 'cssv/2');
  assert.equal(v.total, 14);
  assert.equal(v.items.grid.supported, true);
  assert.equal(v.items['aspect-ratio'].supported, true);
  assert.equal(v.items['color-mix'].supported, true);
  assert.equal(v.items.subgrid.supported, false);
  assert.equal(v.supported, 3);
  assert.deepStrictEqual(v.supported, 3);
  assert.equal(v.newest, 'color-mix');
  assert.equal(v.newestYear, 2023, '最新的是 2023 档的 color-mix');
  // layer/nesting 走样式表解析，替身没有真样式表 → 如实记 unreadable，不记 false
  assert.deepStrictEqual(v.unreadable.sort(), ['layer', 'nesting']);
  assert.equal(v.items.layer.supported, null);
  assert.ok(v.missing.includes('subgrid') && !v.missing.includes('layer'));
});

test('cssv/2：@layer 与嵌套用样式表解析判，CSS.supports 问不出来', async () => {
  const v = plain((await cliOf(styleEnv())).cssv);
  assert.equal(v.items.layer.supported, true, '@layer 出一条规则即算支持');
  assert.equal(v.items.nesting.supported, true, '嵌套规则里有子规则即算支持');
  assert.deepStrictEqual(v.unreadable, []);
  assert.equal(v.items.grid.supported, false, 'supports 桩全否，声明类都是 false');
});

test('cssv/2：没有 CSS.supports 就记 unsupported（浏览器没这能力，不是没跑）', async () => {
  const v = plain((await cliOf(fakeEnv())).cssv);
  assert.deepStrictEqual(v, { $: 'unsupported' });
});
}

// ===== g127-fp-domrect.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.5：domrect/2
// 四种变换各取一组 rect（参考实现同样用多变换），另有 Range 一条取几何的路；
// 所有临时 DOM 在 finally 里摘掉，一个节点都不许留在文档上。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 记着挂在 body 上的临时节点 + 一共 append 过几次 */
function trackedEnv(over) {
  const env = fakeEnv(over);
  const live = new Set();
  const stat = { appends: 0 };
  env.document.body = {
    appendChild(el) { live.add(el); stat.appends++; },
    removeChild(el) { live.delete(el); }
  };
  return { env, live, stat };
}

test('domrect/2：四种变换各取一组 rect，摘要由这些读数拼出来', async () => {
  const d = plain((await cliOf(fakeEnv())).domrect);
  assert.equal(d.alg, 'domrect/2');
  assert.deepStrictEqual(Object.keys(d.items).sort(), ['matrix3d', 'rotate', 'scale', 'skew']);
  for (const [name, row] of Object.entries(d.items)) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['h', 'rects', 'w', 'x', 'y'], name + ' 的字段不全');
    assert.equal(typeof row.w, 'number', name + ' 没读到宽');
    assert.equal(typeof row.h, 'number', name + ' 没读到高');
    assert.equal(row.rects, 2, name + ' 的 getClientRects 条数要如实记');
  }
  assert.match(String(d.h), /^(sha256|fnv):/);
  assert.match(String(d.scope), /off-screen/);
});

test('domrect/2：临时 DOM 全部摘掉，异常路径上也不留', async () => {
  const a = trackedEnv();
  const va = plain((await cliOf(a.env)).domrect);
  assert.ok(a.stat.appends >= 4, '至少要挂过 4 个元素，实际 ' + a.stat.appends);
  assert.equal(a.live.size, 0, '正常路径泄漏了 ' + a.live.size + ' 个节点');
  assert.equal(va.alg, 'domrect/2');

  // 读矩形时抛错：整项记 error，但临时节点仍然要摘干净
  const b = trackedEnv();
  const orig = b.env.document.createElement;
  b.env.document.createElement = (tag) => {
    const el = orig(tag);
    el.getBoundingClientRect = () => { throw new Error('LayoutError: boom'); };
    return el;
  };
  const vb = plain((await cliOf(b.env)).domrect);
  assert.deepStrictEqual(vb, { $: 'error' });
  assert.equal(b.live.size, 0, '异常路径泄漏了 ' + b.live.size + ' 个节点');
});

test('domrect/2：有 createRange 时给 Range 一组读数，没有就记 unsupported', async () => {
  const plainEnv = fakeEnv();
  const v1 = plain((await cliOf(plainEnv)).domrect);
  assert.deepStrictEqual(v1.ranges, { $: 'unsupported' });

  const env = fakeEnv();
  env.document.createRange = () => ({
    selectNodeContents() { },
    getBoundingClientRect() { return { width: 201.5, height: 19.25, x: 0, y: 3 }; },
    getClientRects() { return [{}, {}, {}]; }
  });
  const v2 = plain((await cliOf(env)).domrect);
  assert.equal(v2.ranges.w, 201.5);
  assert.equal(v2.ranges.h, 19.25);
  assert.equal(v2.ranges.rects, 3);
  assert.ok(v2.ranges.text > 0, '文字长度要如实记：' + v2.ranges.text);
});
}

// ===== g127-fp-engver.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.2：engver（feature-floor/2）
// 声明版本能被改写，特性区间不能：下限 = 已支持特性里最高的版本，
// 上限 = 未支持特性里最低的版本减一。11 条特性与参考站 src/infer.mjs 一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

test('engver：11 条特性各带 {ok,min,year}，版本与年份一一对应且单调', async () => {
  const RC = loadCollector(fakeEnv());
  assert.equal(RC.JS_FEATURES.length, 11, '参考实现是 11 条');
  const mins = RC.JS_FEATURES.map((r) => r[1]);
  const years = RC.JS_FEATURES.map((r) => r[2]);
  for (let i = 1; i < mins.length; i++) {
    assert.ok(mins[i] >= mins[i - 1], '版本清单要按升序排：' + mins.join(','));
    assert.ok(years[i] >= years[i - 1], '年份跟着版本单调：' + years.join(','));
  }
  assert.ok(mins[0] >= 40 && mins[mins.length - 1] <= 200, '版本号要像 Chromium 主版本：' + mins.join(','));
  assert.ok(years[0] >= 2015 && years[years.length - 1] <= 2030, '年份要像年份：' + years.join(','));
});

test('engver：floor/ceiling 由真值表推出来，不是照抄声明版', async () => {
  const v = plain((await cliOf(fakeEnv())).engver);
  assert.equal(v.alg, 'feature-floor/2');
  assert.equal(v.total, 11);
  assert.equal(Object.keys(v.items).length, 11);
  const supported = Object.keys(v.items).filter((k) => v.items[k].ok);
  const missing = Object.keys(v.items).filter((k) => !v.items[k].ok);
  assert.equal(supported.length, v.supported);
  assert.equal(v.floor_chromium, Math.max(...supported.map((k) => v.items[k].min)));
  if (missing.length) {
    assert.equal(v.ceiling_chromium, Math.min(...missing.map((k) => v.items[k].min)) - 1,
      '上限应是未支持特性里最低版本减一');
  } else {
    assert.equal(v.ceiling_chromium, null);
  }
  // 声明版是字符串（可被 UA 改写），区间是数字——两层不许混
  assert.equal(typeof v.declared, 'string');
  assert.equal(typeof v.floor_chromium, 'number');
});

test('engver：年份跟着下限走（floor_year 与该特性的 year 一致）', async () => {
  const v = plain((await cliOf(fakeEnv())).engver);
  if (v.floor_chromium === null) {
    assert.equal(v.floor_year, null);
  } else {
    assert.equal(v.floor_year, v.items[v.newest].year, 'floor_year 必须是最新特性的首用年份');
    assert.equal(v.items[v.newest].min, v.floor_chromium);
  }
});

// 藏掉某一条特性：按特性名挑一个**只影响那一条**的改法。
// 都是改全局名或全局上的方法/属性，采集器的判定函数就靠这些名字读真假。
const HIDE = {
  findLast: (env) => { env.Array.prototype.findLast = undefined; },
  structuredClone: (env) => { env.structuredClone = undefined; },
  groupBy: (env) => { env.Object.groupBy = undefined; },
  withResolvers: (env) => { env.Promise.withResolvers = undefined; },
  fromAsync: (env) => { env.Array.fromAsync = undefined; },
  'set-union': (env) => { env.Set.prototype.union = undefined; },
  'promise-try': (env) => { env.Promise.try = undefined; },
  'duration-format': (env) => { env.Intl.DurationFormat = undefined; },
  'error-iserror': (env) => { env.Error.isError = undefined; },
  float16array: (env) => { env.Float16Array = undefined; },
  'regexp-escape': (env) => { env.RegExp.escape = undefined; }
};

// 注意：这些改法要落到 **vm 里的全局对象** 上（realm 的内建），不是宿主沙箱对象：
// 沙箱上读不到 realm 内建。loadCollector() 会把同一个 env 建成上下文，所以
// 在 loadCollector 之后用 vm.runInContext 改 globalThis 才有效。
function hideInRealm(env, name) {
  const RC = loadCollector(env);
  const ctx = vm.createContext(env);                 // 同一个 sandbox → 同一个上下文
  vm.runInContext('(function (hide) { hide(globalThis); })', ctx)(HIDE[name]);
  return RC;
}

test('engver：藏掉最新支持的那条特性，上下限一起往下走', async () => {
  // 期望值从**这一次的读数**推出来，不写死版本号：engver 的支持面由跑沙箱的 JS 引擎
  // 决定（CI 是 Node 22、本地是 Node 24，支持的特性条数天然不同）。写死「136」等于
  // 让这条用例只在某台机器上成立——这正是上一轮 CI 红的原因。
  const base = plain((await cliOf(fakeEnv())).engver);
  const supported = Object.keys(base.items).filter((k) => base.items[k].ok)
    .sort((a, b) => base.items[a].min - base.items[b].min);
  assert.ok(supported.length >= 1, '这个环境一条特性都不支持，无从"藏掉最新的一条"');

  const newest = supported[supported.length - 1];
  assert.equal(base.newest, newest, 'newest 必须是最新的已支持特性：' + base.newest + ' vs ' + newest);
  const rest = supported.slice(0, -1);
  const expectedFloor = rest.length ? Math.max(...rest.map((k) => base.items[k].min)) : null;

  const env = fakeEnv();
  const RC = hideInRealm(env, newest);
  const v = plain(await RC.buildEnvelope(undefined, collectorCtx()).then((e) => e.cli.engver));

  assert.equal(v.items[newest].ok, false, '藏掉 ' + newest + ' 之后它必须读成不支持');
  assert.equal(v.supported, base.supported - 1, '支持条数要少一条');
  assert.equal(v.floor_chromium, expectedFloor,
    '下限应退到剩下的最新已支持特性（' + (rest[rest.length - 1] || '无') + '）：' + v.floor_chromium);
  if (rest.length) {
    assert.ok(v.floor_chromium < base.floor_chromium, '下限要往下走：' +
      base.floor_chromium + ' → ' + v.floor_chromium);
    assert.equal(v.floor_year, v.items[v.newest].year, '年份要跟着新的下限走');
  }

  // 上限 = 未支持特性里最低的那条减一。藏掉 latest 只是把它挪进"未支持"这一堆，
  // 所以期望值要按**藏完之后的未支持集合**重算（这个环境里本来就不支持的条目
  // ——比如 vm 里没有的 structuredClone——仍然把上限压得更低，不许无视）。
  const missingAfter = Object.keys(base.items).filter((k) => !base.items[k].ok && k !== newest)
    .concat([newest]);
  const ceilingMin = Math.min(...missingAfter.map((k) => base.items[k].min));
  const ceilingYear = Math.max(...missingAfter.filter((k) => base.items[k].min === ceilingMin)
    .map((k) => base.items[k].year));
  assert.equal(v.ceiling_chromium, ceilingMin - 1,
    '上限应是未支持特性里最低版本减一（' + ceilingMin + ' - 1）');
  assert.equal(v.ceiling_year, ceilingYear, '上限落在 ' + ceilingMin + ' 这一档的年份');
  assert.ok(v.ceiling_chromium < base.items[newest].min,
    '藏掉的那条必须已经落在区间外：上限 ' + v.ceiling_chromium + ' < ' + base.items[newest].min);
});
}

// ===== g127-fp-fpid-hwid.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.12：fpid / hwid 的输入范围与版本升级
// 值仍是**标量摘要字符串**（后端 visit.fpid 是 TEXT、identity_text 只吃标量），
// 换了输入清单就把标签升到 tmpl-2 / hw-2，历史行按标签分档，不和旧值混在一个分布里。
// 这里逐项验证"清单里的每个输入都真的进了摘要"——清单只有 FP_INPUTS / HW_INPUTS 一处。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const CONTRACT = path.join(__dirname, '..', 'specs', 'radishcloud-contract.md');

/** 只跑一个探针，不建整封（逐项改环境时快得多）。
 *  探针要拿到的是**vm 里的全局对象**（buildEnvelope 里也是如此），不是宿主的沙箱对象：
 *  沙箱对象上读不到 realm 的内建（Float16Array 之类），直接传沙箱会读出一堆假 false。 */
async function digestOf(env, id) {
  const RC = loadCollector(env);
  const one = RC.probes.find((p) => p.id === id);
  assert.ok(one, '没有 ' + id + ' 探针');
  const G = vm.runInContext('globalThis', vm.createContext(env));
  return plain(await one.run(G));
}

/** 带一个能读出厂商/渲染器的 WebGL 替身 */
function withGL(env, renderer) {
  const gl = {
    VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c,
    getParameter(p) {
      if (p === this.VENDOR) return 'TestVendor';
      if (p === this.RENDERER) return renderer;
      if (p === this.VERSION) return 'WebGL 2.0';
      if (p === this.SHADING_LANGUAGE_VERSION) return 'GLSL ES 3.00';
      return null;
    },
    getExtension(n) {
      return n === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }
        : null;
    },
    getSupportedExtensions() { return ['WEBGL_debug_renderer_info']; }
  };
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() === 'canvas') el.getContext = (k) => (String(k).indexOf('2d') === 0 ? null : gl);
    return el;
  };
  return env;
}

/** 能画的 canvas（2d） */
function withCanvas(env, dataUrl) {
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    el.getContext = () => ({
      textBaseline: '', font: '', fillStyle: '', globalCompositeOperation: '',
      fillRect() { }, fillText() { }, beginPath() { }, arc() { }, fill() { },
      createLinearGradient() { return { addColorStop() { } }; },
      measureText() { return { width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 100 }; }
    });
    el.toDataURL = () => dataUrl;
    return el;
  };
  return env;
}

/** 字体探测能命中的 canvas：具体字体族比基准族宽 */
function withFonts(env, hits) {
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    el.getContext = () => ({
      font: '',
      measureText(s) {
        const font = String(this.font);
        const named = font.indexOf('"') >= 0 && hits > 0;
        const w = named ? 900 : String(s).length * 10;
        return { width: w, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w };
      }
    });
    return el;
  };
  return env;
}

test('fpid/hwid 仍是标量摘要字符串，版本号只来自两个常量', async () => {
  const env = fakeEnv();
  const RC = loadCollector(env);
  assert.equal(RC.FP_ALG_VERSION, 'tmpl-2');
  assert.equal(RC.HW_ALG_VERSION, 'hw-2');
  const cli = (await RC.buildEnvelope(undefined, collectorCtx())).cli;
  assert.match(cli.fpid, /^fnv:[0-9a-f]{16}$/, '替身没有 crypto.subtle，走 FNV 并截断：' + cli.fpid);
  assert.match(cli.hwid, /^fnv:[0-9a-f]{16}$/);
  assert.equal(cli.fpid_alg, 'fnv/tmpl-2-fallback');
  assert.equal(cli.hwid_alg, 'fnv/hw-2-fallback');
  // 摘要绝不能变成对象：后端 visit.fpid 是 TEXT，identity_text 只吃标量
  assert.equal(typeof cli.fpid, 'string');
  assert.equal(typeof cli.hwid, 'string');
});

test('fpid：crypto.subtle 可用时是 sha256 全长摘要，标签同步是 tmpl-2', async () => {
  const env = fakeEnv();
  env.crypto = webcrypto;
  const cli = (await loadCollector(env).buildEnvelope(undefined, collectorCtx())).cli;
  assert.match(cli.fpid, /^sha256:[0-9a-f]{64}$/);
  assert.equal(cli.fpid_alg, 'sha256/tmpl-2');
  assert.equal(cli.hwid_alg, 'sha256/hw-2');
});

// 每个输入一个"只改它"的改法。键名必须与 FP_INPUTS 完全一致（下面第一条断言就查这个）。
const FP_MUTATORS = {
  ua: (env) => { env.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120'; },
  langs: (env) => { env.navigator.languages = ['en-US', 'en']; },
  screen: (env) => { env.screen.width = 1280; },
  tz: (env) => {
    env.Intl = {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'UTC' }) }),
      DurationFormat: Intl.DurationFormat,
      Segmenter: Intl.Segmenter
    };
  },
  hc: (env) => { env.navigator.hardwareConcurrency = 4; },
  mem: (env) => { env.navigator.deviceMemory = 4; },
  touch: (env) => { env.navigator.maxTouchPoints = 5; },
  plat: (env) => { env.navigator.platform = 'Linux x86_64'; },
  vendor: (env) => { env.navigator.vendor = 'Apple Computer, Inc.'; },
  canvas: (env) => { withCanvas(env, 'data:image/png;base64,DIFFERENT'); },
  fonts: (env) => { withFonts(env, 3); },
  mathfp: (env) => { env.Math = Object.assign(Object.create(Math), { tan: () => 42 }); },
  // engver 进摘要的是 "supported@floor"（采集器 fpBits 里的 engver: 那段）。所以改它要真的
  // 改到条数或下限：原来只藏 Float16Array，在 Node 22 上这条本来就读不到（等于没改，
  // 摘要不变 → CI 红），那是把宿主的特性面当成了夹具的前提。
  // 这里两头一起打，哪一头在这个宿主上生效都会让 supported@floor 变：
  //   ① 给沙箱补上 structuredClone（Chromium 98 引入、假 window 没提供）→ 支持条数 +1
  //   ② 藏掉 RegExp（regexp-escape 是清单里最新的一条，Chromium 136）→ 支持条数 -1、下限回退
  engver: (env) => { env.structuredClone = () => undefined; env.RegExp = undefined; },
  wasm: (env) => { env.WebAssembly = null; },
  gl: (env) => { withGL(env, 'ANGLE (NVIDIA, RTX 4090)'); }
};

const HW_MUTATORS = {
  screen: FP_MUTATORS.screen,
  dpr: (env) => { env.devicePixelRatio = 2; },
  depth: (env) => { env.screen.colorDepth = 30; },
  hc: FP_MUTATORS.hc,
  mem: FP_MUTATORS.mem,
  touch: FP_MUTATORS.touch,
  plat: FP_MUTATORS.plat,
  vendor: FP_MUTATORS.vendor,
  'gl-vendor': (env) => { withGL(env, 'ANGLE (NVIDIA, RTX 4090)'); },
  'gl-renderer': (env) => { withGL(env, 'ANGLE (Intel, UHD 630)'); },
  fonts: FP_MUTATORS.fonts,
  'fonts-hits': (env) => { withFonts(env, 7); },
  'heap-limit': (env) => { env.performance.memory = { jsHeapSizeLimit: 4294705152 }; }
};

test('fpid：FP_INPUTS 里每一项都真的进了摘要（逐项改一个，摘要必须变）', async () => {
  const RC = loadCollector(fakeEnv());
  const inputs = plain(RC.FP_INPUTS);
  assert.deepStrictEqual(Object.keys(FP_MUTATORS).sort(), inputs.slice().sort(),
    '改法表必须与 FP_INPUTS 一字不差（多一个少一个都是漂移）');
  const base = await digestOf(fakeEnv(), 'fpid');
  for (const name of inputs) {
    const env = fakeEnv();
    FP_MUTATORS[name](env);
    const got = await digestOf(env, 'fpid');
    assert.notEqual(got, base, '改了 ' + name + ' 摘要却没变，说明它没进摘要');
  }
});

test('hwid：HW_INPUTS 里每一项都真的进了摘要', async () => {
  const RC = loadCollector(fakeEnv());
  const inputs = plain(RC.HW_INPUTS);
  assert.deepStrictEqual(Object.keys(HW_MUTATORS).sort(), inputs.slice().sort());
  const base = await digestOf(fakeEnv(), 'hwid');
  for (const name of inputs) {
    const env = fakeEnv();
    HW_MUTATORS[name](env);
    const got = await digestOf(env, 'hwid');
    assert.notEqual(got, base, '改了 ' + name + ' 摘要却没变，说明它没进摘要');
  }
});

test('fpid：同一环境两次读数一致，清单外的改动不影响摘要', async () => {
  const a = await digestOf(fakeEnv(), 'fpid');
  const b = await digestOf(fakeEnv(), 'fpid');
  assert.equal(a, b, '同输入必须同摘要');
  const env = fakeEnv();
  env.innerWidth = 1024;              // 窗口尺寸不在清单里
  env.document.title = '别的标题';     // 页面标题也不在
  env.navigator.cookieEnabled = false;
  assert.equal(await digestOf(env, 'fpid'), a, '清单外的输入不该改变摘要');
});

test('契约：附录 K.12 逐个列出了摘要输入名（文档与代码不许各说一套）', async (t) => {
  // 契约文档不进公开仓库；本地保留了 specs/ 才检查这一条
  if (!fs.existsSync(CONTRACT)) { t.skip('本地没有 specs/，跳过文档一致性检查'); return; }
  const RC = loadCollector(fakeEnv());
  const text = fs.readFileSync(CONTRACT, 'utf8');
  const k12 = text.slice(text.indexOf('### K.12'));
  assert.ok(k12.length > 200, '附录 K.12 还没写');
  for (const name of plain(RC.FP_INPUTS)) {
    assert.ok(k12.indexOf('`' + name + '`') >= 0, 'K.12 里没写 fpid 输入 `' + name + '`');
  }
  for (const name of plain(RC.HW_INPUTS)) {
    assert.ok(k12.indexOf('`' + name + '`') >= 0, 'K.12 里没写 hwid 输入 `' + name + '`');
  }
  assert.ok(k12.indexOf('tmpl-2') >= 0 && k12.indexOf('hw-2') >= 0, 'K.12 要写明版本升级');
});
}

// ===== g127-fp-glimg.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.8：glimg/2
// 片元按坐标出非恒定图案（sin/fract），采样区按设备上限取 64×64（上限小就退 32/16），
// 所有 GPU 资源在 finally 里释放：程序、两个着色器、缓冲，最后丢上下文。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 一个记着"哪些资源被删了"的 WebGL 替身 */
function glEnv(over) {
  over = over || {};
  const env = fakeEnv();
  const calls = [];
  let readPixelsArgs = null;
  const gl = {
    COLOR_BUFFER_BIT: 0x4000, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_TEXTURE_SIZE: 0x0d33,
    VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c,
    LINK_STATUS: 0x8b82,
    getParameter(p) {
      if (p === this.MAX_RENDERBUFFER_SIZE) return over.maxSize === undefined ? 4096 : over.maxSize;
      if (p === this.MAX_TEXTURE_SIZE) return 4096;
      if (p === this.VENDOR) return 'TestVendor';
      if (p === this.RENDERER) return 'TestRenderer';
      if (p === this.VERSION) return 'WebGL 2.0';
      if (p === this.SHADING_LANGUAGE_VERSION) return 'GLSL ES 3.00';
      return null;
    },
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      if (name === 'WEBGL_lose_context') {
        return { loseContext() { calls.push('loseContext'); } };
      }
      return null;
    },
    getSupportedExtensions() { return ['WEBGL_debug_renderer_info', 'WEBGL_lose_context']; },
    createShader(type) { return { type }; }, shaderSource() { }, compileShader() { },
    getShaderParameter() { return true; },
    createProgram() { return {}; }, attachShader() { }, linkProgram() { }, useProgram() { },
    getProgramParameter() { return true; },
    createBuffer() { return {}; }, bindBuffer() { }, bufferData() { },
    getAttribLocation() { return 0; }, enableVertexAttribArray() { }, vertexAttribPointer() { },
    clearColor() { }, clear() { }, drawArrays() { },
    readPixels(x, y, w, h, f, t, px) {
      readPixelsArgs = { x, y, w, h };
      for (let i = 0; i < px.length; i++) px[i] = (i * 7 + 3) % 256;
    },
    deleteProgram() { calls.push('deleteProgram'); },
    deleteShader() { calls.push('deleteShader'); },
    deleteBuffer() { calls.push('deleteBuffer'); }
  };
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    el.getContext = (kind) => (String(kind).indexOf('2d') === 0 ? null : gl);
    return el;
  };
  return { env, calls, readPixels: () => readPixelsArgs, gl };
}

test('glimg/2：默认 64×64 采样，读回 16384 字节且不是恒定色', async () => {
  const { env, readPixels } = glEnv();
  const g = plain((await cliOf(env)).glimg);
  assert.equal(g.alg, 'glimg/2');
  assert.equal(g.side, 64);
  assert.equal(g.bytes, 64 * 64 * 4);
  assert.deepStrictEqual(readPixels(), { x: 0, y: 0, w: 64, h: 64 }, '采样区从原点起 64×64');
  assert.ok(g.nonzero > g.bytes / 2, '非恒定图案应该让绝大多数字节非零：' + g.nonzero);
  assert.match(String(g.h), /^(sha256|fnv):/);
});

test('glimg/2：设备上限只有 32 时退回 32×32，并如实记下 side', async () => {
  const { env } = glEnv({ maxSize: 32 });
  const g = plain((await cliOf(env)).glimg);
  assert.equal(g.side, 32);
  assert.equal(g.bytes, 32 * 32 * 4);
});

test('glimg/2：程序/两个着色器/缓冲/上下文全部释放，一样都不能漏', async () => {
  const { env, calls } = glEnv();
  const g = plain((await cliOf(env)).glimg);
  assert.equal(g.alg, 'glimg/2');
  assert.equal(calls.filter((c) => c === 'deleteProgram').length, 1, '程序要删：' + calls.join(','));
  assert.equal(calls.filter((c) => c === 'deleteShader').length, 2, '两个着色器都要删：' + calls.join(','));
  assert.equal(calls.filter((c) => c === 'deleteBuffer').length, 1, '缓冲要删：' + calls.join(','));
  assert.equal(calls.filter((c) => c === 'loseContext').length, 1, '最后要丢上下文：' + calls.join(','));
  assert.equal(calls[calls.length - 1], 'loseContext', 'loseContext 必须是最后一步');
});

test('glimg/2：没有 WebGL 就记 unsupported', async () => {
  const g = plain((await cliOf(fakeEnv())).glimg);
  assert.deepStrictEqual(g, { $: 'unsupported' });
});
}

// ===== g127-fp-keys.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.9：keys/2
// 旧实现把 Object.keys(window)（可枚举全局，含站点脚本自己加的键）与
// getComputedStyle().length（CSS 属性条数）并排返回，名字却像同一件事。
// 现在五项各有名字、取法与说明；旧字段 window/html/css 的语义一个字没动。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

test('keys/2：五项范围齐全，每项都写清取法与含义', async () => {
  const k = plain((await cliOf(fakeEnv())).keys);
  assert.equal(k.alg, 'keys/2');
  assert.equal(k.scope, 'globals-enumerable', '老字段 scope 的含义不变');
  assert.deepStrictEqual(Object.keys(k.items).sort(), [
    'CSS', 'HTMLElement.prototype', 'computed-style-properties', 'enumerable-globals', 'own-property-names'
  ]);
  for (const [name, row] of Object.entries(k.items)) {
    assert.equal(typeof row.how, 'string', name + ' 缺取法说明');
    assert.ok(row.how.length > 5, name + ' 的取法说明太短：' + row.how);
    assert.ok(row.n === null || typeof row.n === 'number', name + ' 的 n 只能是数字或 null');
    assert.equal(typeof row.note, 'string', name + ' 缺范围提示');
  }
});

test('keys/2：可枚举全局与自有属性名是两个范围，不能互换', async () => {
  const k = plain((await cliOf(fakeEnv())).keys);
  const en = k.items['enumerable-globals'].n;
  const own = k.items['own-property-names'].n;
  assert.equal(k.window, en, '老字段 window 就是可枚举全局计数');
  assert.ok(en > 0);
  assert.ok(own >= en, '自有属性名（含不可枚举）不会比可枚举计数少：' + own + ' vs ' + en);
  assert.ok(own > en, '这个环境里两者应当确实不同，否则测不出范围差别');
});

test('keys/2：站点脚本往 window 上加一个键，两个计数一起动（说明含站点自己的键）', async () => {
  const base = plain((await cliOf(fakeEnv())).keys);
  const env = fakeEnv();
  env.__g127ExtraGlobal = 1;
  const withExtra = plain((await cliOf(env)).keys);
  assert.equal(withExtra.items['enumerable-globals'].n, base.items['enumerable-globals'].n + 1);
  assert.equal(withExtra.items['own-property-names'].n, base.items['own-property-names'].n + 1);
});

test('keys/2：CSS 命名空间的接口数不是 CSS 属性条数（旧 css 指的是后者）', async () => {
  const env = fakeEnv();
  env.CSS = { supports() { return true; }, escape() { return ''; } };
  const k = plain((await cliOf(env)).keys);
  assert.equal(k.items.CSS.n, 2, 'Object.getOwnPropertyNames(CSS) 是 2');
  assert.equal(k.css, 320, '老字段 css 仍是 getComputedStyle(div).length');
  assert.equal(k.items['computed-style-properties'].n, 320);
  assert.notEqual(k.items.CSS.n, k.css, '两个数不是一个东西，不许混用');
});
}

// ===== g127-fp-lies.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.3：lies/2
// 一个离屏、同源、没有脚本的 iframe 是"干净参照"：页面里的改写脚本不会动到新开文档的
// 原生函数。两边字符串不同 → 本页被改；拿不到同源窗口 → 记 unsupported，绝不判成篡改。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0';

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 记着哪些元素还挂在 body 上，用来验临时 DOM 是否摘干净 */
function trackedEnv(over) {
  const env = fakeEnv(over);
  const live = new Set();
  env.document.body = {
    appendChild(el) { live.add(el); },
    removeChild(el) { live.delete(el); }
  };
  return { env, live };
}

/** frameWin：同源空 iframe 的窗口替身 */
function fakeFrameWin(share) {
  return {
    Function: { prototype: { toString: share.toString || ((fn) => Function.prototype.toString.call(fn)) } },
    navigator: share.navigator,
    screen: share.screen || { width: 1920, height: 1080 },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: share.tz || 'Asia/Shanghai' }) }) },
    Date: function () { return { getTimezoneOffset: () => (share.offset === undefined ? -480 : share.offset) }; }
  };
}

function frameEnv(frameWin) {
  const { env, live } = trackedEnv();
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() === 'iframe') el.contentWindow = frameWin;
    return el;
  };
  return { env, live };
}

test('lies/2：拿不到同源窗口就记 unsupported，不把"读不到"判成篡改', async () => {
  const v = plain((await cliOf(fakeEnv())).lies);
  assert.equal(v.alg, 'lies/2');
  assert.equal(v.ctx, 'unsupported');
  assert.equal(v.why, 'no-contentWindow');
  assert.deepStrictEqual(v.readings, [], '没有同源参照时不做读数对照，不编数据');
  const accused = v.list.filter((x) => x.indexOf('page≠frame') >= 0 || x.indexOf('frame≠') >= 0);
  assert.deepStrictEqual(accused, [], '跨上下文部分没跑就不能有跨上下文结论：' + JSON.stringify(accused));
});

test('lies/2：同源空 iframe 用完必须摘掉，一个临时节点都不留', async () => {
  const env0 = fakeEnv();
  const { env, live } = frameEnv(fakeFrameWin({ navigator: env0.navigator }));
  const v = plain((await cliOf(env)).lies);
  assert.equal(v.ctx, 'iframe');
  assert.equal(v.why, 'same-origin-blank');
  assert.equal(live.size, 0, '临时 DOM 泄漏了 ' + live.size + ' 个节点');
  assert.ok(!('contentWindow' in env.document), '不该往 document 上写东西');
});

test('lies/2：本页与 iframe 读数一致时不点名；不一致时点名到具体项', async () => {
  // 一致：让参照窗口共用本页的 navigator/screen/时区
  const envA0 = fakeEnv();
  const a = frameEnv(fakeFrameWin({ navigator: envA0.navigator, offset: new Date().getTimezoneOffset() }));
  const va = plain((await cliOf(a.env)).lies);
  const uaRow = va.readings.find((r) => r.k === 'userAgent');
  assert.equal(uaRow.same, true, '同一个 navigator，userAgent 必须一致');
  assert.ok(!va.list.includes('frame≠userAgent'));

  // 不一致：参照窗口报另一个 UA
  const envB0 = fakeEnv();
  const other = Object.assign({}, envB0.navigator, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' });
  const b = frameEnv(fakeFrameWin({ navigator: other, offset: new Date().getTimezoneOffset() }));
  const vb = plain((await cliOf(b.env)).lies);
  assert.ok(vb.list.includes('frame≠userAgent'), '实际 ' + JSON.stringify(vb.list));
  const row = vb.readings.find((r) => r.k === 'userAgent');
  assert.equal(row.same, false);
  assert.match(String(row.frame), /X11; Linux/);
});

test('lies/2：本页函数的源码字符串与 iframe 里的不一致时逐项点名', async () => {
  // 参照窗口的 toString 恒返回另一串 —— 这就是"本页被改"的反向证据
  const env0 = fakeEnv();
  const liar = fakeFrameWin({
    navigator: env0.navigator,
    toString: () => 'function tampered() { [native code] }',
    offset: new Date().getTimezoneOffset()
  });
  const { env } = frameEnv(liar);
  const v = plain((await cliOf(env)).lies);
  const hit = v.items.filter((it) => it.same === false);
  assert.ok(hit.length > 0, '应逐项记下 same=false');
  assert.ok(v.list.some((x) => x.indexOf(':page≠frame') >= 0), '实际 ' + JSON.stringify(v.list));
  // 逐项三元组都在：本页是否原生 / iframe 是否原生 / 两边是否同一串
  for (const it of v.items) {
    assert.ok(['page', 'frame', 'same', 'proto'].every((f) => f in it), '缺字段：' + JSON.stringify(it));
  }
});

test('lies/2：getter 对照看"是否原生、是否拒绝陌生 this"', async () => {
  const env = fakeEnv();
  const proto = {};
  Object.defineProperty(proto, 'userAgent', {
    configurable: true,
    get() {
      if (this && this.__nav === true) return UA;
      throw new TypeError('Illegal invocation');   // 原生访问器的行为
    }
  });
  const nav = Object.create(proto);
  Object.assign(nav, { platform: 'Win32', languages: ['zh-CN'], hardwareConcurrency: 8, vendor: 'Google Inc.' });
  Object.defineProperty(nav, '__nav', { value: true });
  env.navigator = nav;
  const v = plain((await cliOf(env)).lies);
  const row = v.getters.find((g) => g.k === 'navigator.userAgent');
  assert.equal(row.stranger, true, '拒绝陌生 this 才是原生访问器的样子');
  assert.equal(row.get, false, '替身里的 getter 是 JS 写的，本来就不是 [native code]');
  assert.ok(!v.list.includes('navigator.userAgent:accepts-stranger'));
  assert.ok(v.list.includes('navigator.userAgent:getter'), '非原生 getter 要点名');
});
}

// ===== g127-fp-shield.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.11：shield/2
// 四态判定 + 每一项都写依据：canvas 两遍是否一致、数学两遍是否一致、原生函数字符串是否完整。
// 与 canvas/rand 联动：shield.canvasStable 必须和 rand.same 说同一件事。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36';
const BRAVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Brave/141';

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 能画的 canvas；noisy=true 时 toDataURL 每次都不一样（模拟加噪保护） */
function canvasEnv(opts) {
  opts = opts || {};
  const env = fakeEnv();
  if (opts.ua) env.navigator.userAgent = opts.ua;
  let draws = 0;
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    let first = '';
    el.getContext = () => ({
      textBaseline: '', font: '', fillStyle: '', globalCompositeOperation: '',
      fillRect() { }, beginPath() { }, arc() { }, fill() { },
      fillText(t) { if (!first) first = String(t); },   // 记住这一段画的是什么
      createLinearGradient() { return { addColorStop() { } }; },
      measureText() { return { width: 100, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 100 }; }
    });
    el.toDataURL = () => {
      draws++;
      // 稳定：同一段文字画出同一串；noisy：每次都不一样
      return opts.noisy ? 'data:image/png;base64,N' + draws + Math.random() : 'data:image/png;base64,' + first;
    };
    return el;
  };
  return env;
}

test('shield/2：没有 canvas 读数时不猜，basis=canvas_unmeasured、verdict=unknown', async () => {
  const s = plain((await cliOf(fakeEnv())).shield);
  assert.equal(s.alg, 'shield/2');
  assert.equal(s.canvasStable, null, '画不出来就是 null，不许当"没有噪声"');
  assert.equal(s.noise, null);
  assert.equal(s.basis, 'canvas_unmeasured');
  assert.equal(s.verdict, 'unknown');
  assert.match(String(s.note), /不判断/);
});

test('shield/2：canvas 两遍结果不同 + Brave UA → likely-privacy-browser', async () => {
  const cli = await cliOf(canvasEnv({ noisy: true, ua: BRAVE_UA }));
  const s = plain(cli.shield);
  assert.equal(s.brave, true);
  assert.equal(s.canvasStable, false);
  assert.equal(s.noise, true);
  assert.equal(s.verdict, 'likely-privacy-browser');
  // 联动：rand 探针的重复性结论必须与 shield 一致
  assert.equal(plain(cli.rand).same, false, 'rand 与 shield 读的是同一件事（同一段绘制两遍）');
});

test('shield/2：canvas 两遍不同但没有隐私浏览器特征 → canvas-noise，不说成"伪装"', async () => {
  const cli = await cliOf(canvasEnv({ noisy: true, ua: CHROME_UA }));
  const s = plain(cli.shield);
  assert.equal(s.brave, false);
  assert.equal(s.verdict, 'canvas-noise');
  assert.equal(s.mathStable, true, 'Math 没被扰动');
});

test('shield/2：canvas 稳定时 canvasStable=true，且与 rand.same 一致', async () => {
  const cli = await cliOf(canvasEnv({ ua: CHROME_UA }));
  const s = plain(cli.shield);
  assert.equal(s.canvasStable, true);
  assert.equal(s.noise, false);
  assert.equal(plain(cli.rand).same, true);
  assert.ok(['clean', 'unknown'].includes(s.verdict), '实际 ' + s.verdict);
});

test('shield/2：原生函数字符串被改时 nativeToStringIntact=false，clean 就轮不到', async () => {
  const env = canvasEnv({ ua: CHROME_UA });
  // 盖住 Function.prototype.toString：所有函数都改口说自己是原生（或都不说）
  const fakeF = function () { };
  fakeF.prototype = { toString: () => 'function altered() { [native code] }' };
  env.Function = fakeF;
  const s = plain((await cliOf(env)).shield);
  assert.equal(s.nativeToStringIntact, true, '替身里所有函数都"说自己是原生"，这一项就应当为 true');
  assert.equal(s.verdict, 'clean', 'canvas 稳定 + 数学稳定 + 字符串完整 → clean');

  const env2 = canvasEnv({ ua: CHROME_UA });
  const fakeF2 = function () { };
  fakeF2.prototype = { toString: () => 'function altered() { /* not native */ }' };
  env2.Function = fakeF2;
  const s2 = plain((await cliOf(env2)).shield);
  assert.equal(s2.nativeToStringIntact, false, '字符串里没有 [native code] 就是被改过');
  assert.equal(s2.verdict, 'unknown', '有一条证据不对时不下 clean 的结论');
});
}

// ===== g127-fp-svgrect.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.6：svgrect/2
// SVG 例外地放进离屏零尺寸容器（不参与布局），同时取 getBBox 与 getComputedTextLength；
// 容器用完必须摘掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

function trackedEnv() {
  const env = fakeEnv();
  const live = new Set();
  env.document.body = {
    appendChild(el) { live.add(el); },
    removeChild(el) { live.delete(el); }
  };
  return { env, live };
}

/** 给 <text> 补上排版长度相关的三个方法 */
function textEnv(over) {
  const env = fakeEnv();
  const orig = env.document.createElementNS;
  env.document.createElementNS = (ns, tag) => {
    const el = orig(ns, tag);
    if (String(tag) === 'text') {
      el.getComputedTextLength = over && over.throws
        ? () => { throw new Error('InvalidStateError: not rendered'); }
        : () => 123.456;
      el.getNumberOfChars = () => 24;
      el.getSubStringLength = () => 51.25;
    }
    return el;
  };
  return env;
}

test('svgrect/2：同时给 getBBox 与 getComputedTextLength，视图尺寸另记', async () => {
  const v = plain((await cliOf(textEnv())).svgrect);
  assert.equal(v.alg, 'svgrect/2');
  assert.deepStrictEqual(v.box, { x: 1.5, y: 2.5, w: 3.5, h: 4.5 });
  assert.equal(v.textLength, 123.456);
  assert.equal(v.chars, 24);
  assert.equal(v.subLength, 51.25);
  assert.deepStrictEqual(v.viewport, { w: 137.5, h: 43.25 });
  assert.match(String(v.h), /^(sha256|fnv):/);
  assert.match(String(v.scope), /zero-size wrapper/);
});

test('svgrect/2：离屏容器用完就摘，零尺寸容器不进正常流', async () => {
  const { env, live } = trackedEnv();
  const orig = env.document.createElementNS;
  env.document.createElementNS = orig;
  const v = plain((await cliOf(env)).svgrect);
  assert.equal(v.alg, 'svgrect/2');
  assert.equal(live.size, 0, '临时容器泄漏了 ' + live.size + ' 个节点');
});

test('svgrect/2：读文本长度抛错只把这一项记 null，别的读数照给', async () => {
  const v = plain((await cliOf(textEnv({ throws: true }))).svgrect);
  assert.equal(v.alg, 'svgrect/2');
  assert.equal(v.textLength, null, '读不到就是 null，不许编一个数');
  assert.ok(v.box && typeof v.box.w === 'number', 'getBBox 的读数仍然要给');
  assert.equal(v.chars, 24);
});
}

// ===== g127-fp-textm.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.7：textm/2
// 3 个字体族 × 3 个字符串，取 width 与 actualBoundingBox 四边，另给跨字体差分。
// 单一字体的单个宽度说明不了系统字体差异，必须多族多串才有分辨力。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

/** 每个字体族的字宽不同：monospace 10px/字、中文族 12px/字、其余 8.5px/字 */
function textmEnv() {
  const env = fakeEnv();
  const orig = env.document.createElement;
  env.document.createElement = (tag) => {
    const el = orig(tag);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    el.getContext = () => ({
      font: '',
      measureText(s) {
        const font = String(this.font);
        const per = font.indexOf('monospace') >= 0 ? 10 : (font.indexOf('YaHei') >= 0 ? 12 : 8.5);
        const w = String(s).length * per;
        return { width: w, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3, actualBoundingBoxLeft: 1, actualBoundingBoxRight: w };
      }
    });
    return el;
  };
  return env;
}

test('textm/2：3 个字体族 × 3 个字符串全部取到，每格带五边读数', async () => {
  const t = plain((await cliOf(textmEnv())).textm);
  assert.equal(t.alg, 'textm/2');
  assert.equal(Object.keys(t.items).length, 3, '三个字体族各一组');
  for (const [font, rows] of Object.entries(t.items)) {
    assert.deepStrictEqual(Object.keys(rows).sort(), ['s1', 's2', 's3'], font + ' 的三个字符串不全');
    for (const [k, row] of Object.entries(rows)) {
      assert.deepStrictEqual(Object.keys(row).sort(), ['ascent', 'descent', 'left', 'right', 'w'], font + '/' + k + ' 字段不全');
      assert.equal(typeof row.w, 'number');
    }
  }
  assert.equal(t.fonts.length, 3);
  for (const f of t.fonts) assert.equal(f.n, 3, f.font + ' 只量到 ' + f.n + ' 个字符串');
});

test('textm/2：字号一样时各族平均宽不同，差分把这件事写出来', async () => {
  const t = plain((await cliOf(textmEnv())).textm);
  const mono = t.fonts.find((f) => /monospace/.test(f.font));
  const aria = t.fonts.find((f) => /Arial/.test(f.font));
  assert.ok(mono.meanW > aria.meanW, 'monospace 10px/字 应大于 Arial 8.5px/字');
  assert.equal(t.diff.length, 1, '差分是"第一个族减最后一个族"的一条读数');
  assert.ok(t.diff[0] < 0, '最后一个族（中文 12px/字）更宽，所以差分是负的：' + t.diff[0]);
});

test('textm/2：拿不到 2D 上下文就记 unsupported（不是没跑，也不是 error）', async () => {
  const t = plain((await cliOf(fakeEnv())).textm);
  assert.deepStrictEqual(t, { $: 'unsupported' });
});
}

// ===== g127-fp-wasm.test.js =====
{
'use strict';
// G 127 · fp 批 · 契约附录 K.1：wasm/2
// 17 项特性（参考站 src/wasm.mjs 的同一套 wasm-feature-detect 1.10.0 字节），
// 逐项给 {ok, source}，先跑 control 空模块证明"能校验"这件事本身成立。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

async function cliOf(env) {
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  return e.cli;
}

test('wasm/2：清单 17 项、每项都写清来源，JSPI 没有模块只按 API 判', async () => {
  const RC = loadCollector(fakeEnv());
  // 常量是 vm 那个 realm 里的数组，比较前先转成本 realm 的普通值
  assert.deepStrictEqual(plain(RC.WASM_CONTROL), [0, 97, 115, 109, 1, 0, 0, 0], 'control 必须是空模块');
  const rows = plain(RC.WASM_CASES);
  assert.equal(rows.length, 17, '参考实现是 17 项');
  const names = rows.map((r) => r[0]);
  assert.equal(new Set(names).size, 17, '特性名不能重复：' + names.join(','));
  for (const row of rows) {
    const [name, source, bytes] = row;
    assert.ok(['validate', 'api-existence'].includes(source), name + ' 的来源=' + source);
    if (source === 'api-existence') {
      assert.equal(bytes, null, name + ' 没有模块就不该编一个出来');
    } else {
      assert.ok(Array.isArray(bytes) && bytes.length > 8, name + ' 缺最小模块字节');
      assert.deepStrictEqual(bytes.slice(0, 4), [0, 97, 115, 109], name + ' 的字节不是 wasm 魔数');
    }
  }
});

test('wasm/2：逐特性真值表覆盖全部 17 项，has/missing 是完整划分', async () => {
  const w = plain((await cliOf(fakeEnv())).wasm);
  assert.equal(w.alg, 'wasm/2');
  assert.equal(w.total, 17);
  assert.equal(w.control, 'valid', 'Node 里空模块必须校验通过，否则整项应该是 unreadable');
  assert.equal(Object.keys(w.items).length, 17);
  assert.deepStrictEqual(w.unreadable, []);
  assert.equal(w.has.length + w.missing.length, 17);
  assert.deepStrictEqual(w.has.concat(w.missing).sort(), Object.keys(w.items).sort());
  assert.equal(w.sources.validate + w.sources['api-existence'], 17);
  assert.equal(w.items.jspi.source, 'api-existence');
  assert.equal(w.items.simd.source, 'validate');
  // Node 的 V8 还没有 wide arithmetic，其余都过——这正是"逐项真值"该有的样子
  assert.ok(w.supported >= 13, '实际 ' + w.supported);
});

test('wasm/2：validate 被桩掉（control 不过）记 unreadable，不把"读不到"说成"不支持"', async () => {
  const env = fakeEnv();
  env.WebAssembly = { validate: () => false };
  const w = plain((await cliOf(env)).wasm);
  assert.deepStrictEqual(w, { $: 'unreadable' }, JSON.stringify(w));
});

test('wasm/2：某一项的 validate 抛错只把那一项记 unreadable，其余照常读数', async () => {
  const env = fakeEnv();
  const CONTROL_LEN = 8;
  env.WebAssembly = {
    validate(bytes) {
      if (bytes.length === CONTROL_LEN) return true;      // control 过得去
      throw new TypeError('CompileError: boom');         // 特性模块全炸
    }
  };
  const w = plain((await cliOf(env)).wasm);
  assert.equal(w.alg, 'wasm/2');
  assert.equal(w.unreadable.length, 16, '16 条有模块的特性都该记为 unreadable');
  assert.ok(!w.unreadable.includes('jspi'), 'JSPI 走 API 存在性，不该被算成 unreadable');
  assert.deepStrictEqual(w.missing, ['jspi']);
  assert.equal(w.items.simd.unreadable, true);
  assert.equal(w.supported, 0);
});
}

// ===== g127-g-gamepad.test.js =====
{
'use strict';
// G 127 · G：gamepad（dev）在**一次真实用户输入之后**重读。
// 形状：{alg, atLoad, afterInput, needsInteraction, pads:[{id,mapping,buttons,axes,...}], windowMs}
// 没有输入时 needsInteraction:true，afterInput:null —— 这是"没等到输入"，不是"没有手柄"
// （Firefox 在用户手势之前 getGamepads() 可能一律返回空）。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, eventEnv, fakeEnv, collectorCtx, plain } = require('./harness');

function pad(id, buttons, axes) {
  return { id, mapping: 'standard', connected: true, index: 0, buttons: new Array(buttons).fill({ pressed: false }), axes: new Array(axes).fill(0) };
}

test('G1：加载时读一次、真实输入后重读，并记每个手柄的按钮/摇杆数量', async () => {
  const env = eventEnv();
  env.__radishInputWait = 200;
  let n = 0;
  env.navigator.getGamepads = () => { n += 1; return n === 1 ? [] : [pad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', 17, 4)]; };
  // 真实用户输入：一次 pointerdown
  setTimeout(() => env.__dispatch('pointerdown'), 20);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gamepad);
  assert.strictEqual(g.alg, 'gamepad/2');
  assert.strictEqual(g.atLoad, 0, '加载时 0 个（Firefox 这种情况很常见）');
  assert.strictEqual(g.needsInteraction, false);
  assert.strictEqual(g.afterInput, 1);
  assert.strictEqual(g.pads.length, 1);
  assert.strictEqual(g.pads[0].mapping, 'standard');
  assert.strictEqual(g.pads[0].buttons, 17);
  assert.strictEqual(g.pads[0].axes, 4);
});

test('G2：一个输入都没有时 needsInteraction:true，afterInput:null（不下"没手柄"的结论）', async () => {
  const env = eventEnv();
  env.__radishInputWait = 60;
  env.navigator.getGamepads = () => [];
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gamepad);
  assert.strictEqual(g.atLoad, 0);
  assert.strictEqual(g.afterInput, null);
  assert.strictEqual(g.needsInteraction, true);
  assert.deepStrictEqual(g.pads, []);
});

test('G3：只有 mousemove（悬停）不算"真实输入"，不触发重读', async () => {
  const env = eventEnv();
  env.__radishInputWait = 80;
  let n = 0;
  env.navigator.getGamepads = () => { n += 1; return [pad('Pad', 4, 2)]; };
  setTimeout(() => env.__dispatch('mousemove'), 10);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gamepad);
  assert.strictEqual(g.needsInteraction, true, '悬停不构成 user activation');
  assert.strictEqual(g.afterInput, null);
  assert.strictEqual(g.pads[0].buttons, 4, '加载时那一份仍然如实带回来');
});

test('G4：没有 getGamepads 时是 unsupported', async () => {
  const env = fakeEnv();
  delete env.navigator.getGamepads;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.gamepad), { $: 'unsupported' });
});

test('G5：getGamepads 抛错时是 unreadable（不是 0 个手柄）', async () => {
  const env = eventEnv();
  env.navigator.getGamepads = () => { throw new Error('SecurityError'); };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.gamepad), { $: 'unreadable' });
});

test('G6：userActivation 已有手势时立刻重读（windowMs=0，basis=userActivation）', async () => {
  const env = eventEnv();
  delete env.__radishInputWait;
  env.navigator.userActivation = { isActive: false, hasBeenActive: true };
  env.navigator.getGamepads = () => [pad('Pad', 16, 4)];
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const g = plain(e.cli.gamepad);
  assert.strictEqual(g.windowMs, 0);
  assert.strictEqual(g.basis, 'userActivation');
  assert.strictEqual(g.needsInteraction, false);
  assert.strictEqual(g.afterInput, 1, '不用等也能读到重读结果');
});

test('G7：两个观测窗口都短于最慢网络项（藏在慢车道后面，不推迟上传）', () => {
  const RC = loadCollector(fakeEnv());
  assert.ok(RC.AGENT_WAIT_DEFAULT <= 1000, 'agent 窗口：' + RC.AGENT_WAIT_DEFAULT);
  assert.ok(RC.GAMEPAD_WAIT_DEFAULT <= RC.AGENT_WAIT_DEFAULT, 'gamepad 窗口不该比 agent 长');
  assert.ok(RC.GAMEPAD_WAIT_DEFAULT + RC.AGENT_WAIT_DEFAULT <= RC.SLOW_TIMEOUT, '即便串起来也远小于单项额度');
});

test('G8：最坏情况（访客完全没交互）不改变整轮耗时（实测对比 0 窗口）', async () => {
  async function build(withHook) {
    const env = eventEnv();
    if (withHook) env.__radishInputWait = 0; else delete env.__radishInputWait;
    env.navigator.getGamepads = () => [];
    const RC = loadCollector(env);
    const t0 = Date.now();
    const e = await RC.buildEnvelope(undefined, collectorCtx());
    return { dur: Date.now() - t0, e: e, RC: RC };
  }
  const withWait = await build(false);
  const noWait = await build(true);
  const g = plain(withWait.e.cli.gamepad);
  assert.strictEqual(g.windowMs, withWait.RC.GAMEPAD_WAIT_DEFAULT, '默认窗口真的生效了');
  assert.strictEqual(g.needsInteraction, true);
  assert.strictEqual(plain(withWait.e.cli.agent).level, 'insufficient-observation');
  // 观测窗口与其余探针并行，且整轮本来就有空闲等待垫底，所以总耗时不该被它拉长
  assert.ok(withWait.dur - noWait.dur < 300, '等待窗口不该延长整轮：' + withWait.dur + 'ms vs ' + noWait.dur + 'ms');
});
}

// ===== g127-h-perms.test.js =====
{
'use strict';
// G 127 · H：perms（brw）查询范围扩大到参考站量级，逐项保留五种结果。
// 关键口径：**查询失败不是"没有权限"**。名字不被接受（camera / microphone 在 Chrome 里
// 会抛 TypeError）记 unsupported-name；查询报错或超时记 error，都不许写成 denied/prompt。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function permEnv(rules) {
  const env = fakeEnv();
  const seen = [];
  env.navigator.permissions = {
    query(desc) {
      const name = desc && desc.name;
      seen.push(name);
      const rule = rules[name];
      if (rule === 'throw-type') { const e = new Error('not a valid permission name'); e.name = 'TypeError'; throw e; }
      if (rule === 'reject-unsupported') return Promise.reject(Object.assign(new Error('name not supported'), { name: 'NotSupportedError' }));
      if (rule === 'reject') return Promise.reject(new Error('boom'));
      if (rule === 'weird') return Promise.resolve({ state: 'weird' });
      if (rule === 'hang') return new Promise(() => { });
      return Promise.resolve({ state: rule || 'prompt' });
    }
  };
  env.__seen = seen;
  return env;
}

test('H1：逐项结果与计数都留着，未知名字如实记 unsupported-name', async () => {
  const env = permEnv({
    geolocation: 'granted',
    notifications: 'denied',
    midi: 'prompt',
    camera: 'throw-type',
    microphone: 'reject-unsupported',
    gyroscope: 'reject',
    magnetometer: 'weird'
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const p = plain(e.cli.perms);
  assert.strictEqual(p.alg, 'permissions-query/2');
  assert.strictEqual(p.items.geolocation, 'granted');
  assert.strictEqual(p.items.notifications, 'denied');
  assert.strictEqual(p.items.midi, 'prompt');
  assert.strictEqual(p.items.camera, 'unsupported-name', 'camera 不是合法权限名，不能猜成 denied');
  assert.strictEqual(p.items.microphone, 'unsupported-name');
  assert.strictEqual(p.items.gyroscope, 'error', '查询报错是"没读到"，不是"没权限"');
  assert.strictEqual(p.items.magnetometer, 'unsupported', '返回不认识的状态 → unsupported');
  assert.strictEqual(p.counts.total, p.items && Object.keys(p.items).length);
});

test('H2：查询名单扩到 21 项，含参考站点名的那几个', async () => {
  const env = permEnv({});
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const p = plain(e.cli.perms);
  const required = ['geolocation', 'notifications', 'midi', 'camera', 'microphone', 'background-sync',
    'persistent-storage', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer',
    'screen-wake-lock', 'window-management', 'local-fonts', 'storage-access',
    'top-level-storage-access', 'display-capture', 'capture-controller'];
  for (const name of required) assert.ok(name in p.items, '缺权限名：' + name);
  assert.ok(Object.keys(p.items).length >= 18, '实际项数：' + Object.keys(p.items).length);
  assert.strictEqual(p.counts.total, Object.keys(p.items).length);
});

test('H3：每个名字都真的问过 permissions.query（不靠猜）', async () => {
  const env = permEnv({});
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const asked = new Set(env.__seen);
  for (const name of Object.keys(plain(e.cli.perms).items)) {
    assert.ok(asked.has(name), '没有真的 query 过 ' + name);
  }
});

test('H4：不答的名字在期限内记 error（不是 prompt）', async () => {
  const env = permEnv({ geolocation: 'hang' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const p = plain(e.cli.perms);
  assert.strictEqual(p.items.geolocation, 'error');
  assert.ok(p.counts.error >= 1);
});

test('H5：没有 Permissions API 时是 unsupported', async () => {
  const env = fakeEnv();
  delete env.navigator.permissions;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  assert.deepStrictEqual(plain(e.cli.perms), { $: 'unsupported' });
});
}

// ===== g127-i-apis.test.js =====
{
'use strict';
// G 127 · I：apis（brw）补敏感接口。既有布尔清单一个字不动，新项追加在里面，
// serialBasis 之类的既有字段保留。新增的全部只记**接口存在性**，不代表授权或可用。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

test('I1：新增的敏感接口逐个记真值', async () => {
  const env = fakeEnv();
  env.PressureObserver = function PressureObserver() { };
  env.navigator.queryLocalFonts = () => Promise.resolve([]);
  env.navigator.getScreenDetails = () => Promise.resolve({});
  env.navigator.requestMIDIAccess = () => Promise.resolve({});
  env.showOpenFilePicker = () => Promise.resolve([]);
  env.IdleDetector = function IdleDetector() { };
  env.ContactsManager = function ContactsManager() { };
  env.Translator = { availability: () => Promise.resolve('available') };
  env.LanguageModel = { availability: () => Promise.resolve('available') };
  env.EyeDropper = function EyeDropper() { };
  env.WebTransport = function WebTransport() { };
  env.IdentityCredential = function IdentityCredential() { };
  env.DigitalCredential = function DigitalCredential() { };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.apis);
  assert.strictEqual(a.alg, 'apis/2');
  assert.strictEqual(a.pressure, true);
  assert.strictEqual(a.localFonts, true);
  assert.strictEqual(a.screenDetails, true);
  assert.strictEqual(a.midi, true);
  assert.strictEqual(a.filePicker, true);
  assert.strictEqual(a.idleDetector, true);
  assert.strictEqual(a.contactsManager, true);
  assert.strictEqual(a.translator, true);
  assert.strictEqual(a.languageModel, true);
  assert.strictEqual(a.eyeDropper, true);
  assert.strictEqual(a.webTransport, true);
  assert.strictEqual(a.fedcm, true);
  assert.strictEqual(a.digitalCredential, true);
  assert.strictEqual(a.digitalCredentialsBasis, 'constructor-presence');
  assert.strictEqual(a.aiBasis, 'presence-only', 'availability 在 ai 那一项采过，这里不重复探测');
});

test('I2：什么都没有时新项一律 false，既有字段仍在', async () => {
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.apis);
  for (const k of ['pressure', 'localFonts', 'screenDetails', 'midi', 'filePicker', 'idleDetector',
    'contactsManager', 'translator', 'languageModel', 'eyeDropper', 'webTransport', 'fedcm', 'digitalCredential']) {
    assert.strictEqual(a[k], false, k + ' 应为 false');
  }
  // 既有清单没被改坏
  for (const k of ['usb', 'serial', 'hid', 'share', 'clipboard', 'wakeLock', 'credentials',
    'serviceWorker', 'gpu', 'bluetooth', 'storage', 'presentation', 'contacts', 'nfc', 'idle']) {
    assert.strictEqual(typeof a[k], 'boolean', '既有的 ' + k + ' 必须还在且是布尔');
  }
  assert.ok('serialBasis' in a, 'serialBasis 这类既有字段要保留');
});

test('I3：apis 只有接口存在性，不发起任何探测请求', async () => {
  const env = fakeEnv();
  let called = 0;
  env.navigator.queryLocalFonts = () => { called += 1; return Promise.resolve([]); };
  env.navigator.requestMIDIAccess = () => { called += 1; return Promise.resolve({}); };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.apis);
  assert.strictEqual(a.localFonts, true);
  assert.strictEqual(a.midi, true);
  assert.strictEqual(called, 0, 'apis 不该调用这些接口（真探测在各自的项里）');
});
}

// ===== g127-j-auto.test.js =====
{
'use strict';
// G 127 · J：auto（brw）驱动全局名扫描 + 组合弱信号。
// 形状：{alg, signals:[...], combos:[...], comboCount, level}
// 关键口径（沿用 B4 的结论，不许破坏）：空插件列表**本身不是证据**——
// 真实安卓/iOS 浏览器零插件仍然必须判正常（signals 为空、combos 为空、level 'none'）。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

test('J1：真实手机零插件仍判正常（level none，没有任何 plugins 信号）', async () => {
  const env = fakeEnv();
  // 替身环境的 Buffer 只用来算 UTF-8 字节数，真浏览器 window 上没有它
  delete env.Buffer;
  env.navigator.userAgent = ANDROID_UA;
  env.navigator.plugins = [];
  env.navigator.pdfViewerEnabled = false;
  env.navigator.webdriver = false;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  assert.deepStrictEqual(a.signals, []);
  assert.deepStrictEqual(a.combos, []);
  assert.strictEqual(a.level, 'none');
});

test('J2：驱动全局名逐条记名字（含 __playwright / $cdc_ 前缀族）', async () => {
  const env = fakeEnv();
  delete env.Buffer;
  env.$cdc_asdjflasutopfhvcZLmcfl_ = 1;
  env.__playwright_utility_script__ = {};
  env.__puppeteer_evaluation_script__ = {};
  env.__nightmare = {};
  env.callPhantom = function () { };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  for (const name of ['$cdc_asdjflasutopfhvcZLmcfl_', '__playwright_utility_script__',
    '__puppeteer_evaluation_script__', '__nightmare', 'callPhantom']) {
    assert.ok(a.signals.includes(name), '没记下 ' + name + '：' + JSON.stringify(a.signals));
  }
  assert.strictEqual(a.level, 'strong');
});

test('J3：webdriver=true + 空插件 + 空 languages 凑出组合弱信号', async () => {
  const env = fakeEnv();
  delete env.Buffer;
  env.navigator.webdriver = true;
  env.navigator.plugins = [];
  env.navigator.languages = [];
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  assert.ok(a.signals.includes('webdriver'));
  assert.ok(a.combos.includes('webdriver+empty-plugins'), JSON.stringify(a.combos));
  assert.ok(a.combos.includes('webdriver+languages-anomaly'), JSON.stringify(a.combos));
  assert.strictEqual(a.comboCount, a.combos.length);
  assert.strictEqual(a.level, 'strong');
});

test('J4：只有"插件空 + pdfViewerEnabled 矛盾"时是 weak（弱信号不是强证据）', async () => {
  const env = fakeEnv();               // pdfViewerEnabled:true + plugins:[] 就是矛盾
  delete env.Buffer;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  assert.deepStrictEqual(a.signals, ['plugins-empty-pdf-conflict']);
  assert.strictEqual(a.level, 'weak');
  assert.deepStrictEqual(a.combos, [], '单独一条弱信号不凑组合');
});

test('J5：headless UA 也逐条记，并与空插件凑成组合', async () => {
  const env = fakeEnv();
  delete env.Buffer;
  env.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
  env.navigator.plugins = [];
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  assert.ok(a.signals.includes('headless-ua'));
  assert.ok(a.combos.includes('headless-ua+empty-plugins'), JSON.stringify(a.combos));
});

test('J6：形状固定（alg/signals/combos/level 都在）', async () => {
  const e = await loadCollector(fakeEnv()).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.auto);
  assert.strictEqual(a.alg, 'auto/2');
  assert.ok(Array.isArray(a.signals));
  assert.ok(Array.isArray(a.combos));
  assert.ok(['none', 'weak', 'strong'].includes(a.level));
  assert.ok(/空插件列表本身不是证据/.test(a.note), '口径要跟着读数一起走');
});
}

// ===== g127-k-agent.test.js =====
{
'use strict';
// G 127 · K：agent（brw）补可信交互维度。
// 形状：{alg, uaCh:{...既有}, input:{pointerdown, mousemove, keydown, touchstart, trustedAll, windowMs}, level}
// 没有交互时 level 'insufficient-observation'——**不判自动化**（短访问本来就没有交互）。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, eventEnv, fakeEnv, collectorCtx, plain } = require('./harness');

test('K1：全部可信输入 → trusted-input，计数与观测窗口都在', async () => {
  const env = eventEnv();
  env.__radishInputWait = 200;
  setTimeout(() => {
    env.__dispatch('pointerdown');
    env.__dispatch('mousemove');
    env.__dispatch('mousemove');
    env.__dispatch('keydown');
  }, 20);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.agent);
  assert.strictEqual(a.alg, 'agent/2');
  assert.strictEqual(a.input.pointerdown, 1);
  assert.strictEqual(a.input.mousemove, 2);
  assert.strictEqual(a.input.keydown, 1);
  assert.strictEqual(a.input.touchstart, 0);
  assert.strictEqual(a.input.trustedAll, true);
  assert.strictEqual(a.input.untrusted, 0);
  assert.ok(a.input.windowMs >= 0 && a.input.windowMs < 2000, 'windowMs=' + a.input.windowMs);
  assert.strictEqual(a.level, 'trusted-input');
  // 既有的 UA-CH 维度还在
  assert.ok(a.uaCh && typeof a.uaCh.kind === 'string');
});

test('K2：混进 isTrusted=false 的事件 → untrusted-input（只是迹象，不是结论）', async () => {
  const env = eventEnv();
  env.__radishInputWait = 200;
  setTimeout(() => {
    env.__dispatch('pointerdown');
    env.__dispatch('keydown', { isTrusted: false });
  }, 20);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.agent);
  assert.strictEqual(a.input.untrusted, 1);
  assert.strictEqual(a.input.trustedAll, false);
  assert.strictEqual(a.level, 'untrusted-input');
});

test('K3：没有任何交互 → insufficient-observation，trustedAll 是 null（不是 true）', async () => {
  const env = eventEnv();
  env.__radishInputWait = 60;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.agent);
  assert.strictEqual(a.input.total, 0);
  assert.strictEqual(a.input.trustedAll, null, '没有观测就不是"全部可信"');
  assert.strictEqual(a.level, 'insufficient-observation');
});

test('K4：监听是一次性的被动监听，整轮收工就摘掉（不常驻）', async () => {
  const env = eventEnv();
  env.__radishInputWait = 40;
  const before = ['pointerdown', 'mousemove', 'keydown', 'touchstart'].map((t) => env.__listeners(t));
  assert.deepStrictEqual(before, [0, 0, 0, 0], '加载前不该有人挂着监听');
  const RC = loadCollector(env);
  await RC.buildEnvelope(undefined, collectorCtx());
  const after = ['pointerdown', 'mousemove', 'keydown', 'touchstart'].map((t) => env.__listeners(t));
  assert.deepStrictEqual(after, [0, 0, 0, 0], '整轮收工后不该留监听：' + JSON.stringify(after));
});

test('K5：UA-CH 维度不可用时仍给读数（kind=unknown），不是整体失败', async () => {
  const env = eventEnv();
  env.__radishInputWait = 20;
  env.navigator.userAgent = 'CustomAgent/1.0';
  env.navigator.languages = ['en-US'];
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.agent);
  assert.strictEqual(a.uaCh.kind, 'unknown');
  assert.ok('input' in a && 'level' in a);
});

test('K6：userActivation 已记录真实手势时不等（waitMs=0，basis=userActivation）', async () => {
  const env = eventEnv();
  delete env.__radishInputWait;                       // 用生产默认窗口
  env.navigator.userActivation = { isActive: false, hasBeenActive: true };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.agent);
  assert.strictEqual(a.waitMs, 0, '已有 activation 就不该再等');
  assert.strictEqual(a.basis, 'userActivation');
  assert.strictEqual(a.userActivation, true);
  assert.strictEqual(a.input.trustedAll, null, '没观测到事件仍然是"没有证据"');
});
}

// ===== g127-l-adblock.test.js =====
{
'use strict';
// G 127 · L：adblock（brw）广告 URL + 同源对照。
// 形状：{alg, bait, adUrl, control, verdict: blocked|reachable|unknown, basis}
// 口径：对照不通 → unknown（网络不可达**不是**被拦截）；对照通、广告 URL 不通 → blocked；
// 都通 → reachable。no-cors 是 opaque 响应，只证明"请求走完了网络栈"。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function adEnv(rules) {
  const env = fakeEnv();
  env.fetch = (url) => {
    const kind = /googlesyndication/.test(String(url)) ? 'ad' : 'control';
    const r = rules[kind];
    if (r === 'ok') return Promise.resolve({ ok: false, type: 'opaque', status: 0 });
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  return env;
}

test('L1：对照通 + 广告 URL 不通 → blocked', async () => {
  const env = adEnv({ control: 'ok', ad: 'fail' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.adblock);
  assert.strictEqual(a.alg, 'adblock/2');
  assert.strictEqual(a.control.state, 'reachable');
  assert.strictEqual(a.adUrl.state, 'unreachable');
  assert.strictEqual(a.verdict, 'blocked');
  assert.strictEqual(a.basis, 'ad-url-unreachable');
});

test('L2：两条都通 → reachable', async () => {
  const env = adEnv({ control: 'ok', ad: 'ok' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.adblock);
  assert.strictEqual(a.verdict, 'reachable');
  assert.strictEqual(a.basis, 'ad-url+control-reachable');
  assert.strictEqual(a.bait.hidden, false, '诱饵没被隐藏');
});

test('L3：连对照都不通 → unknown（网络不可达不能判成被拦截）', async () => {
  const env = adEnv({ control: 'fail', ad: 'fail' });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.adblock);
  assert.strictEqual(a.control.state, 'unreachable');
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.basis, 'control-unreachable');
  assert.ok(/分不清/.test(a.note), '口径要写清为什么只能记 unknown');
});

test('L4：网络通但诱饵被隐藏（只做了 cosmetic 过滤）也算 blocked，并在 basis 里说明', async () => {
  const env = adEnv({ control: 'ok', ad: 'ok' });
  env.__baitHidden = true;
  env.document.createElement = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, className: '',
    offsetWidth: 0, clientWidth: 0, offsetHeight: 0, clientHeight: 0,
    setAttribute(k, v) { this[k] = v; }, appendChild() { }, removeChild() { },
    getContext: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }), getClientRects: () => [], toDataURL: () => ''
  });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.adblock);
  assert.strictEqual(a.bait.hidden, true);
  assert.strictEqual(a.verdict, 'blocked');
  assert.strictEqual(a.basis, 'bait-hidden-network-reachable');
});

test('L5：没有 fetch 时两条都记 unsupported，verdict 是 unknown', async () => {
  const env = fakeEnv();
  delete env.fetch;
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const a = plain(e.cli.adblock);
  assert.strictEqual(a.adUrl.state, 'unsupported');
  assert.strictEqual(a.control.state, 'unsupported');
  assert.strictEqual(a.verdict, 'unknown');
});

test('L6：广告 URL 与对照各发一次请求（不多打第三方）', async () => {
  const env = adEnv({ control: 'ok', ad: 'fail' });
  const seen = [];
  const inner = env.fetch;
  env.fetch = (url, opts) => { seen.push({ url: String(url), mode: opts && opts.mode }); return inner(url, opts); };
  await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const adCalls = seen.filter((c) => /googlesyndication/.test(c.url));
  assert.strictEqual(adCalls.length, 1);
  assert.strictEqual(adCalls[0].mode, 'no-cors');
  const controlCalls = seen.filter((c) => /radish-collect\.js$/.test(c.url));
  assert.strictEqual(controlCalls.length, 1, '对照只发一次：' + JSON.stringify(controlCalls));
  assert.ok(/radish-collect\.js$/.test(controlCalls[0].url), '对照用同源静态资源（本脚本）：' + controlCalls[0].url);
});
}

// ===== g127-m-traces.test.js =====
{
'use strict';
// G 127 · M：traces（brw）补 IndexedDB 与 Cache Storage，写入后**读回核验**再清理。
// 每项独立状态：unsupported / blocked（写当场抛错）/ written / readback / lost / timeout。
// 写失败**直接**记 blocked，不等下一次访问才推断。
const test = require('node:test');
const assert = require('node:assert');
const { loadCollector, fakeEnv, collectorCtx, plain } = require('./harness');

function memStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    get length() { return m.size; }
  };
}

// 最小可用的假 IndexedDB：够跑 open → transaction → get/put/delete，
// opts.putThrows 模拟配额/隐私模式写入失败，opts.storeAs 模拟"写进去的其实是别的值"。
function fakeIdb(opts) {
  opts = opts || {};
  const data = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    close() { },
    transaction() {
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };
      t.objectStore = () => ({
        get: (k) => ({ result: data.has(k) ? data.get(k) : undefined }),
        put: (v, k) => {
          if (opts.putThrows) throw new Error('QuotaExceededError');
          data.set(k, opts.storeAs !== undefined ? opts.storeAs : v);
          return { result: undefined };
        },
        delete: (k) => { data.delete(k); return { result: undefined }; }
      });
      setTimeout(() => { if (!t.error && t.oncomplete) t.oncomplete(); }, 1);
      return t;
    }
  };
  return {
    open() {
      const req = { result: db };
      setTimeout(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 1);
      return req;
    }
  };
}

// 最小可用的假 Cache Storage：put 存下 Response 的内容，match 原样读回来。
function fakeCaches(opts) {
  opts = opts || {};
  const store = new Map();
  return {
    open() {
      return Promise.resolve({
        put(url, res) {
          if (opts.putThrows) return Promise.reject(new Error('QuotaExceededError'));
          store.set(url, opts.matchValue !== undefined ? opts.matchValue : String(res && res.__body));
          return Promise.resolve();
        },
        match(url) {
          if (!store.has(url)) return Promise.resolve(null);
          const body = store.get(url);
          return Promise.resolve({ text: () => Promise.resolve(body) });
        }
      });
    },
    delete() { store.clear(); return Promise.resolve(true); }
  };
}

function tracesEnv(over) {
  const env = fakeEnv();
  env.localStorage = memStore();
  env.sessionStorage = memStore();
  env.document.cookie = '';
  env.Response = class FakeResponse {
    constructor(body) { this.__body = body; }
    text() { return Promise.resolve(this.__body); }
  };
  Object.assign(env, over || {});
  return env;
}

test('M1：IndexedDB 与 Cache Storage 都能写入并读回（state=readback），且清理干净', async () => {
  const env = tracesEnv({ indexedDB: fakeIdb(), caches: fakeCaches() });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.alg, 'storage-tag/2');
  assert.strictEqual(t.items.indexDB.state, 'readback');
  assert.strictEqual(t.items.cacheStorage.state, 'readback');
  assert.strictEqual(t.items.indexDB.readback, 'ok');
  assert.strictEqual(t.items.cacheStorage.readback, 'ok');
  assert.strictEqual(t.items.localStorage.state, 'readback');
  assert.deepStrictEqual(t.blocked, []);
  assert.strictEqual(t.first, true, '第一次来没有任何旧标记');
});

test('M2：写入当场抛错就记 blocked（不等下一次访问）', async () => {
  const env = tracesEnv({ indexedDB: fakeIdb({ putThrows: true }), caches: fakeCaches({ putThrows: true }) });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.items.indexDB.state, 'blocked');
  assert.strictEqual(t.items.indexDB.wrote, false);
  assert.strictEqual(t.items.cacheStorage.state, 'blocked');
  assert.deepStrictEqual(t.blocked.sort(), ['cacheStorage', 'indexDB']);
});

test('M3：写进去读回不一致 → lost（不是 readback）', async () => {
  const env = tracesEnv({ indexedDB: fakeIdb({ storeAs: '{"t":"00000000deadbeef","at":1}' }), caches: fakeCaches({ matchValue: '{"t":"00000000deadbeef","at":1}' }) });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.items.indexDB.state, 'lost');
  assert.strictEqual(t.items.indexDB.readback, 'mismatch');
  assert.strictEqual(t.items.cacheStorage.state, 'lost');
});

test('M4：没有 indexedDB / caches 时两项都是 unsupported，其余存储照常', async () => {
  const env = tracesEnv();
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.items.indexDB.state, 'unsupported');
  assert.strictEqual(t.items.cacheStorage.state, 'unsupported');
  assert.strictEqual(t.items.localStorage.state, 'readback');
  assert.strictEqual(t.items.windowName.state, 'readback');
});

test('M5：每一项都有独立状态字段（不许只给聚合的三个数组）', async () => {
  const env = tracesEnv({ indexedDB: fakeIdb(), caches: fakeCaches() });
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  for (const name of ['localStorage', 'sessionStorage', 'cookie', 'windowName', 'indexDB', 'cacheStorage']) {
    assert.ok(t.items[name], '缺少 items.' + name);
    assert.ok(typeof t.items[name].state === 'string', name + '.state 必须是字符串');
    assert.ok('wrote' in t.items[name] && 'readback' in t.items[name] && 'prev' in t.items[name], name + ' 字段不全');
  }
  assert.strictEqual(t.ttl_days, 30);
  assert.match(t.scope, /write-readback/);
});

test('M6：上一轮留下的标记这一轮还读得到 → kept（跨访问语义没变）', async () => {
  const env = tracesEnv();
  const prev = JSON.stringify({ t: 'abcdef0123456789', at: Date.now() });
  env.localStorage.setItem('__radish_trace', prev);
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.strictEqual(t.first, false);
  assert.ok(t.kept.includes('localStorage'), JSON.stringify(t.kept));
  assert.strictEqual(t.items.localStorage.prev, true);
});

test('M7：读不出来的同步存储仍是 blocked（回归 features16 的口径）', async () => {
  const env = tracesEnv();
  env.localStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { }, length: 0 };
  const e = await loadCollector(env).buildEnvelope(undefined, collectorCtx());
  const t = plain(e.cli.traces);
  assert.ok(t.blocked.includes('localStorage'));
  assert.strictEqual(t.items.localStorage.state, 'blocked');
});
}
