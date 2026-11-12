'use strict';
/**
 * 生成后修补：Gmeek 的模板在 docs/ 里被重新生成，所以修复必须跑在生成之后。
 * 每条规则要么命中并替换，要么在「必改」清单里直接让构建失败——绝不静默跳过。
 *
 * 用法：node tools/patch-generated.js [docsDir]
 */

const fs = require('fs');
const path = require('path');

const DOCS = process.argv[2] || path.join(__dirname, '..', 'docs');

// ---------- tag.html：DOM XSS（G01）+ 标签列表的键盘可用性（G13） ----------
const REQUIRED_IN_TAG = [
  ['tagTitle.innerHTML="Tag #"+label;',
    'tagTitle.textContent="Tag #"+label;'],
  ['tagTitle.innerHTML="Search #"+searchInput;',
    'tagTitle.textContent="Search #"+searchInput;'],
  [`notFind.innerHTML='Not Find "'+searchInput+'"';`,
    `notFind.textContent='Not Find "'+searchInput+'"';`],
  ['showLabels.innerHTML="&nbsp;&nbsp;"+label+" ";',
    'showLabels.textContent=label;'],
  ['showLabels.setAttribute("onclick", "javascript:updateShowTag(\'" + label + "\');");',
    'showLabels.addEventListener("click",function(){updateShowTag(label);});'],
  ['LabelName.innerHTML=label;', 'LabelName.textContent=label;'],
  ['LabelNum.innerHTML=labelsCount[label];', 'LabelNum.textContent=labelsCount[label];'],
  ["title.innerHTML=jsonData[i]['postTitle'];", "title.textContent=jsonData[i]['postTitle'];"],
  ["LabelTime.innerHTML=jsonData[i]['createdDate'];", "LabelTime.textContent=jsonData[i]['createdDate'];"]
];

// ---------- 所有页面：可选修补 ----------
const OPTIONAL = [
  ['.SideNav{min-width: 360px;}', '.SideNav{min-width:0;width:100%;max-width:360px;}'],
  // 主题开关原来是个没有 href 的 <a onclick>，键盘根本聚焦不到
  ['<a class="btn btn-invisible circle" onclick="modeSwitch()" title="切换主题">',
    '<a href="#theme" class="btn btn-invisible circle" role="button" aria-label="切换主题" onclick="modeSwitch();return false;" title="切换主题">']
];

const HEAD_STYLE = `<style id="radish-a11y">
  /* 浅色底上的白字对比度只有 1.3:1，标签一律用深色字 */
  .Label, .Label a { color: #1f2328 !important; }
  /* 尊重系统的「减少动态效果」 */
  @media (prefers-reduced-motion: reduce) {
    .avatar, .avatar:hover { transition: none !important; transform: none !important; }
  }
  /* 键盘焦点必须看得见 */
  a:focus-visible, button:focus-visible, [role="button"]:focus-visible {
    outline: 2px solid #0969da; outline-offset: 2px;
  }
</style>
`;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.html$/i.test(name)) out.push(p);
  }
  return out;
}

if (!fs.existsSync(DOCS)) {
  console.error('找不到生成目录：' + DOCS);
  process.exit(1);
}

const files = walk(DOCS, []);
const missing = [];
let touched = 0;

for (const file of files) {
  let html = fs.readFileSync(file, 'utf8');
  const before = html;
  const isTag = /(^|[\\/])tag\.html$/i.test(file);

  if (isTag) {
    for (const [from, to] of REQUIRED_IN_TAG) {
      if (html.indexOf(from) < 0) { missing.push(path.basename(file) + ' :: ' + from); continue; }
      html = html.split(from).join(to);
    }
  }
  for (const [from, to] of OPTIONAL) {
    if (html.indexOf(from) >= 0) html = html.split(from).join(to);
  }
  if (html.indexOf('id="radish-a11y"') < 0 && html.indexOf('</head>') > 0) {
    html = html.replace('</head>', HEAD_STYLE + '</head>');
  }
  if (html !== before) { fs.writeFileSync(file, html); touched++; }
}

if (missing.length) {
  console.error('以下必改项在生成产物里没找到（模板变了？），构建失败以免漏洞悄悄回来：');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}

console.log('生成后修补完成：扫描 ' + files.length + ' 个页面，改动 ' + touched + ' 个');
