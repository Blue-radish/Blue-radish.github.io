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

test('G12：工作流没有 write-all，且跑测试与产物校验后才上传', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'Gmeek.yml'), 'utf8');
  assert.ok(!/permissions:\s*write-all/.test(wf), '仍然给了 write-all');
  assert.match(wf, /node --test tests\/\*\.test\.js/, '工作流没有跑单元测试');
  assert.match(wf, /patch-generated\.js/, '工作流没有跑生成后修补');
  const uploadAt = wf.indexOf('upload-pages-artifact');
  const testAt = wf.indexOf('node --test tests');
  assert.ok(testAt > 0 && uploadAt > testAt, '测试必须在打包上传之前');
});
