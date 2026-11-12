'use strict';
// 本地把源同步成产物（CI 里由构建完成，这里只在本地开发时用）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const from = path.join(ROOT, 'static', 'radish-collect.js');
const to = path.join(ROOT, 'docs', 'radish-collect.js');
fs.copyFileSync(from, to);
console.log('已同步 static/radish-collect.js → docs/radish-collect.js');
