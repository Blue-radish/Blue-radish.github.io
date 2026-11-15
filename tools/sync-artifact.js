'use strict';
// 把源同步成待发布的产物（CI 里由构建完成，这里只在本地开发时用）。
//
// 规则只有一条：static/ 下的每个文件，都在 docs/ 里有一份逐字节相同的副本。
// 为什么要有两份：Pages 只发布 docs/，而 docs/ 是构建产物（Gmeek 每次生成时会把
// static/ 复制进去）。所以 static/ 是源，docs/ 是产物——**手抄到 docs/ 迟早会漏**，
// 同步只允许走这个脚本；漏了会被 tools/check-artifact.js 和单测 G13 同时挡下来。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'static');
const TO = path.join(ROOT, 'docs');

if (!fs.existsSync(FROM)) {
  console.error('没有 static/ 目录，无法同步');
  process.exit(1);
}
if (!fs.existsSync(TO)) {
  console.error('没有 docs/ 目录，无法同步');
  process.exit(1);
}

let changed = 0;
let same = 0;
for (const name of fs.readdirSync(FROM)) {
  const src = path.join(FROM, name);
  if (!fs.statSync(src).isFile()) continue;
  const dst = path.join(TO, name);
  const buf = fs.readFileSync(src);
  const had = fs.existsSync(dst);
  if (had && fs.readFileSync(dst).equals(buf)) {
    same += 1;
    console.log('已是最新：docs/' + name);
    continue;
  }
  fs.writeFileSync(dst, buf);
  changed += 1;
  console.log((had ? '已更新：docs/' : '已新增：docs/') + name);
}
console.log('同步完成：改动 ' + changed + ' 个，本来一致 ' + same + ' 个');
