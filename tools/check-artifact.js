'use strict';
// 发布前自检：产物一致性 + 模板补丁到没到位 + 关键读数没被悄悄改掉。
// 由 CI 在"生成产物"之后调用一次（node tools/check-artifact.js），本地也能直接跑。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = 'static/radish-collect.js';
const OUT = 'docs/radish-collect.js';
const problems = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

// 1) 待发布的产物必须与源逐字节一致
const srcBuf = fs.readFileSync(path.join(ROOT, SRC));
const outBuf = fs.readFileSync(path.join(ROOT, OUT));
if (!srcBuf.equals(outBuf)) {
  problems.push(`${OUT} 与 ${SRC} 不一致（本地跑 node tools/sync-artifact.js 同步）`);
}

const outText = outBuf.toString('utf8');

// 2) 模板补丁必须仍然生效（补丁匹配不上就失败，漏洞不许悄悄回来）
const mustNot = [
  ['docs/tag.html', 'tagTitle\\.innerHTML'],
  ['docs/tag.html', 'notFind\\.innerHTML'],
  ['docs/tag.html', 'javascript:updateShowTag'],
];
for (const [file, pattern] of mustNot) {
  if (new RegExp(pattern).test(read(file))) {
    problems.push(`${file} 里还有未修补的 sink：${pattern}`);
  }
}

// 3) 反过来守：博客前端（样式/无障碍/布局）一行都不许被改
const pages = [];
for (const dir of ['docs', 'docs/post']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (f.endsWith('.html')) pages.push(path.join(dir, f));
  }
}
for (const page of pages) {
  const text = read(page);
  for (const pattern of ['radish-a11y', 'href="#theme"', 'prefers-reduced-motion']) {
    if (text.indexOf(pattern) !== -1) problems.push(`${page} 里出现了前端外观改动：${pattern}`);
  }
}

// 4) 关键读数与三层期限不许被悄悄改回旧值
const must = [
  ['edns\\.ip-api\\.com/json\\?nonce=', 'DNS 探针丢了 nonce 或整项被删'],
  ['var SLOW_TIMEOUT = 10000;', 'DNS 单项期限不是 10 秒'],
  ['var DEADLINE = 12000;', '整轮死线不是 12 秒，DNS 会被外层掐断'],
];
for (const [pattern, why] of must) {
  if (!new RegExp(pattern).test(outText)) problems.push(why);
}

if (problems.length) {
  for (const p of problems) console.error('::error::' + p);
  process.exit(1);
}

const version = (outText.match(/var VERSION = '([^']+)'/) || [])[1] || '(未找到版本号)';
console.log('产物自检通过：' + version);
console.log(SRC + '  ' + sha256(SRC));
console.log(OUT + '  ' + sha256(OUT));

// 5) 行为测试跑在待发布的产物上
try {
  execFileSync(process.execPath, ['--test'].concat(
    fs.readdirSync(path.join(ROOT, 'tests'))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join('tests', f))
  ), {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { SITE_SRC: OUT }),
  });
} catch (e) {
  console.error('::error::行为测试未通过');
  process.exit(1);
}
