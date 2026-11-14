'use strict';
/**
 * 生成后修补：Gmeek 的模板在每次构建时被重新生成，所以修复必须跑在生成之后。
 *
 * 硬性约束：只修安全问题，不改博客的任何外观与交互观感。
 *   - 不给页面加样式表（新增 <style> 一律不允许）
 *   - 不调整布局、不换字体、不加无障碍属性
 *   - 文本渲染结果必须和修补前逐字一致（同样的字符，只是不再当 HTML 解析）
 *
 * 每条规则三种结局：
 *   1. 危险写法还在   → 替换成安全写法
 *   2. 安全写法已在   → 通过（可重复执行）
 *   3. 两种都找不到   → 模板变了，构建失败
 * 先跑完全部检查再写盘，避免留下半修补产物。
 *
 * 用法：node tools/patch-generated.js [docsDir]
 */

const fs = require('fs');
const path = require('path');

// 转义成字符实体：输出与原来完全相同，但不会被解析成标签
const HELPERS = `function radishEsc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); }
function radishSafeColor(c){ return /^#[0-9a-fA-F]{3,8}$/.test(String(c||'')) ? String(c) : null; }
function radishSafeHref(u){ var s=String(u||''); return /^(https?:\\/\\/|\\/|\\.{0,2}\\/|[\\w.-]+\\.html)/i.test(s) ? s : '#'; }
function radishDecode(h){ try { return decodeURI(h); } catch (e) { return h; } }
`;

// tag.html 必改项：[危险写法, 安全写法]
const TAG_RULES = [
  // 文本节点：textContent 与原来的 innerHTML 渲染结果逐字相同
  ['tagTitle.innerHTML="Tag #"+label;', 'tagTitle.textContent="Tag #"+label;'],
  ['tagTitle.innerHTML="Search #"+searchInput;', 'tagTitle.textContent="Search #"+searchInput;'],
  [`notFind.innerHTML='Not Find "'+searchInput+'"';`, `notFind.textContent='Not Find "'+searchInput+'"';`],
  ['LabelName.innerHTML=label;', 'LabelName.textContent=label;'],
  ['LabelNum.innerHTML=labelsCount[label];', 'LabelNum.textContent=labelsCount[label];'],
  ["title.innerHTML=jsonData[i]['postTitle'];", "title.textContent=jsonData[i]['postTitle'];"],
  ["LabelTime.innerHTML=jsonData[i]['createdDate'];", "LabelTime.textContent=jsonData[i]['createdDate'];"],

  // 这一处原来用 &nbsp; 排版，保留同样的字符，只把标签名转义
  ['showLabels.innerHTML="&nbsp;&nbsp;"+label+" ";', 'showLabels.innerHTML="&nbsp;&nbsp;"+radishEsc(label)+" ";'],

  // onclick 字符串拼标签名 → 事件绑定
  ['showLabels.setAttribute("onclick", "javascript:updateShowTag(\'" + label + "\');");',
    'showLabels.setAttribute("data-label", label); showLabels.addEventListener("click", function () { updateShowTag(label); });'],

  // 颜色只做格式校验：不合法就当作没设（浏览器本来也会忽略非法值），不换前景色
  ['showLabels.setAttribute("style", "background-color:" + jsonData[\'labelColorDict\'][label]+";padding:4px;");',
    'showLabels.setAttribute("style", "background-color:" + (radishSafeColor(jsonData[\'labelColorDict\'][label]) || "transparent") + ";padding:4px;");'],

  // 标签筛选改用数据属性：class 名匹配对空格/引号/中文标签会失效
  ['div.setAttribute("class","lists "+jsonData[i][\'labels\'].join(" "));',
    'div.setAttribute("class","lists"); div.setAttribute("data-labels","|"+jsonData[i][\'labels\'].join("|")+"|");'],
  [`        let labels = document.getElementsByClassName(label);
        for(let i = 0; i < labels.length; i++){
            labels[i].style.display='block';
        }`,
    `        for(let i = 0; i < lists.length; i++){
            var dl = lists[i].getAttribute ? lists[i].getAttribute("data-labels") : null;
            if(dl && dl.indexOf("|"+label+"|") >= 0){ lists[i].style.display='block'; }
        }`],

  // 站内链接只允许安全协议
  ['item.setAttribute("href",jsonData[i][\'postUrl\']);', 'item.setAttribute("href", radishSafeHref(jsonData[i][\'postUrl\']));'],

  // 畸形 hash 解码容错
  ['setClassDisplay(decodeURI(window.location.hash.slice(1)));', 'setClassDisplay(radishDecode(window.location.hash.slice(1)));']
];

/** 对一份 HTML 应用规则；返回 {html, errors}，不写盘 */
function patchHtml(html, isTag) {
  const errors = [];
  let out = html;
  // 生成产物是 CRLF，多行规则要按文件自己的行尾匹配
  const eol = out.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const norm = (s) => (eol === '\n' ? s : s.split('\n').join(eol));

  // 上一版注入过带 radishInk 的辅助函数：整块换成现在的（只转义、不改前景色）
  if (isTag && out.indexOf('function radishEsc(') < 0 && out.indexOf('function radishSafeColor(') >= 0) {
    out = out.replace(/function radishSafeColor\([\s\S]*?(?=function showList\()/, norm(HELPERS));
  }
  // 上一版为了可读前景色改过这两处，迁回"与原始渲染一致"的写法
  if (isTag) {
    out = out.split('showLabels.textContent=label;').join('showLabels.innerHTML="&nbsp;&nbsp;"+radishEsc(label)+" ";');
    out = out.split('"background-color:" + radishSafeColor(jsonData[\'labelColorDict\'][label]) + ";padding:4px 10px;color:" + radishInk(jsonData[\'labelColorDict\'][label]) + ";"')
             .join('"background-color:" + (radishSafeColor(jsonData[\'labelColorDict\'][label]) || "transparent") + ";padding:4px;"');
  }
  if (isTag && out.indexOf('function radishEsc(') < 0) {
    // 辅助函数只注入一次（守卫式，保证幂等）
    if (out.indexOf('function showList(labelsCount){') >= 0) {
      out = out.replace('function showList(labelsCount){', norm(HELPERS) + 'function showList(labelsCount){');
    } else {
      errors.push('辅助函数注入点 function showList 不见了');
    }
  }

  if (isTag) {
    for (const [rawUnsafe, rawSafe] of TAG_RULES) {
      const unsafe = norm(rawUnsafe), safe = norm(rawSafe);
      if (out.indexOf(unsafe) >= 0) { out = out.split(unsafe).join(safe); continue; }
      if (out.indexOf(safe) >= 0) continue;                        // 已经修过
      errors.push(rawUnsafe.split('\n')[0].slice(0, 80));
    }
  }
  return { html: out, errors };
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.html$/i.test(name)) out.push(p);
  }
  return out;
}

function main(docsDir) {
  const DOCS = docsDir || path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(DOCS)) { console.error('找不到生成目录：' + DOCS); process.exit(1); }

  const files = walk(DOCS, []);
  const allErrors = [];
  const pending = [];

  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    const isTag = /(^|[\\/])tag\.html$/i.test(file);
    const { html, errors } = patchHtml(before, isTag);
    for (const e of errors) allErrors.push(path.basename(file) + ' :: ' + e);
    if (html !== before) pending.push([file, html]);
  }

  if (allErrors.length) {
    console.error('以下必改项既没找到危险写法、也没找到安全写法（模板改了？）构建失败：');
    for (const e of allErrors) console.error('  - ' + e);
    process.exit(1);
  }
  for (const [file, html] of pending) fs.writeFileSync(file, html);
  console.log('生成后修补完成：扫描 ' + files.length + ' 个页面，改动 ' + pending.length + ' 个');
}

if (require.main === module) main(process.argv[2]);

module.exports = { patchHtml, main, TAG_RULES };
