'use strict';
// G01 回归：URL hash 与搜索框里的 HTML 必须按文字显示，不能生成元素
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TAG = path.join(__dirname, '..', 'docs', 'tag.html');

function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('tag.html 里找不到 ' + name + '（模板变了？）');
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error(name + ' 花括号不闭合');
}

/** 只取这两个函数来跑，避免执行整页脚本里其它依赖 DOM 的初始化代码 */
function tagSource() {
  const html = fs.readFileSync(TAG, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const src = scripts.find(s => s.indexOf('function setClassDisplay') >= 0);
  if (!src) throw new Error('tag.html 里找不到 setClassDisplay（模板变了？）');
  return extractFn(src, 'setClassDisplay') + String.fromCharCode(10) + extractFn(src, 'searchShow');
}

function makeNode() {
  return {
    _html: 0, _text: null,
    set innerHTML(v) { this._html++; this._lastHtml = v; },
    get innerHTML() { return ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    style: {}, value: '', classList: { add() { }, remove() { } },
    appendChild() { }, setAttribute() { }, childNodes: []
  };
}

function sandbox(hashValue, searchValue) {
  const nodes = {
    '.lists': [Object.assign(makeNode(), { style: {}, childNodes: [{ childNodes: [{ childNodes: [makeNode(), makeNode()] }] }] })],
    '.tagTitle': [makeNode()],
    '.subnav-search-input': [Object.assign(makeNode(), { value: searchValue || '' })],
    '.notFind': [makeNode()],
    '.SideNav': [Object.assign(makeNode(), { classList: { add() { } } })],
    '#taglabel': [makeNode()]
  };
  const document = {
    title: '',
    getElementsByClassName: (c) => nodes['.' + c] || [],
    getElementById: (id) => nodes['#' + id] || null,
    createElement: () => makeNode(),
    documentElement: { setAttribute() { } },
    addEventListener() { }
  };
  const win = {
    location: { hash: hashValue === null ? '' : '#' + encodeURI(hashValue) },
    document, localStorage: { getItem: () => null, setItem() { } },
    addEventListener() { }, setTimeout, console
  };
  const sandbox = Object.assign({ document, window: win, console, setTimeout, __auditFlag: 0, tagList: [], labelsCount: {}, jsonData: [] }, win);
  return { sandbox, nodes, win };
}

test('G01：hash 里的 img/onerror 按文字显示，不生成元素', () => {
  const payload = '<img src=x onerror=globalThis.__auditFlag=1>';
  for (const inList of [true, false]) {
    const { sandbox: sb, nodes } = sandbox(payload);
    if (inList) sb.tagList = [payload];          // 命中真实标签列表
    vm.runInNewContext(tagSource(), sb);
    sb.setClassDisplay(decodeURIComponent(encodeURI(payload)));
    const title = nodes['.tagTitle'][0];
    assert.strictEqual(title._html, 0, '不允许再通过 innerHTML 写入不可信内容');
    assert.ok(String(title._text).indexOf(payload) >= 0, '输入必须原样保留为文字，实际 ' + title._text);
    assert.ok(/^(Tag #|Search #)/.test(String(title._text)), '实际 ' + title._text);
    assert.strictEqual(sb.__auditFlag, 0);
  }
});

test('G01：搜索框里的 HTML 同样按文字显示', () => {
  const payload = '<img src=x onerror=globalThis.__auditFlag=1>';
  const { sandbox: sb, nodes } = sandbox(null, payload);
  vm.runInNewContext(tagSource(), sb);
  sb.searchShow();
  const title = nodes['.tagTitle'][0];
  const notFind = nodes['.notFind'][0];
  assert.strictEqual(title._text, 'Search #' + payload);
  assert.strictEqual(title._html, 0);
  assert.strictEqual(notFind._text, 'Not Find "' + payload + '"');
  assert.strictEqual(notFind._html, 0);
  assert.strictEqual(sb.__auditFlag, 0);
});

test('G01：产物里不再有把不可信输入拼进 innerHTML 的赋值', () => {
  const html = fs.readFileSync(TAG, 'utf8');
  const bad = [
    /tagTitle\.innerHTML\s*=/,
    /notFind\.innerHTML\s*=/,
    /setAttribute\(\s*"onclick"\s*,\s*"javascript:/,
    /LabelName\.innerHTML\s*=/,
    /LabelTime\.innerHTML\s*=/,
    /title\.innerHTML\s*=\s*jsonData/
  ];
  for (const re of bad) assert.ok(!re.test(html), '仍存在可疑 sink：' + re);
});
