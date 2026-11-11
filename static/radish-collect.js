/*!
 * radish-collect 1.0.0 — 博客访客信息采集
 * 契约：specs/radishcloud-contract.md   设计：specs/2026-11-10-radish-visitor-insights-design.md
 * 不读 Cookie / 不写 localStorage / 不改 DOM / 不上报异常；每会话最多发一次。
 */
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__radish) return;

  var VERSION = 'radish-1.0.3';
  var ENDPOINT = 'https://radishcloud.072120.xyz/v1/collect';
  var TRACE_URL = 'https://radishcloud.072120.xyz/cdn-cgi/trace';
  var HINTS_URL = 'https://radishcloud.072120.xyz/v1/hints';
  var BUDGET = 48 * 1024;
  var PROBE_TIMEOUT = 2500;
  var DEADLINE = 6000;

  // ---------- 基础工具 ----------
  function M(kind, n) { return n === undefined ? { $: kind } : { $: 'truncated', n: n }; }
  function isMissing(v) { return v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ === 'string'; }
  function safe(fn, fallback) { try { var r = fn(); return r === undefined ? fallback : r; } catch (e) { return fallback; } }
  function has(o, k) { return o && typeof o[k] !== 'undefined' && o[k] !== null; }
  function num(v, d) { v = +v; return isFinite(v) ? Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0) : null; }

  function sha(str) {
    try {
      var d = crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
      return d.then(function (buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
        return 'sha256:' + s;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function shaSync(str) { // 同步兜底（crypto.subtle 不可用时）：FNV-1a 64 位，只用于区分，不用于安全
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9, s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = (h1 * 16777619) >>> 0;
      h2 = ((h2 ^ c) * 2246822519 + i) >>> 0;
    }
    return 'fnv:' + ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function hash(str) {
    var s = sha(str);
    return s && s.then ? s.then(function (v) { return v || shaSync(str); }) : Promise.resolve(shaSync(str));
  }

  function tmpl(env) {
    var nav = env.navigator || {}, scr = env.screen || {};
    var ua = safe(function () { return nav.userAgent; }, '');
    var langs = safe(function () { return (nav.languages || [nav.language]).join(','); }, '');
    return {
      ua: ua, langs: langs,
      screen: safe(function () { return [scr.width, scr.height, scr.availWidth, scr.availHeight, env.devicePixelRatio, scr.colorDepth].join('x'); }, ''),
      tz: safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, ''),
      hc: safe(function () { return nav.hardwareConcurrency; }, ''),
      mem: safe(function () { return nav.deviceMemory; }, ''),
      touch: safe(function () { return nav.maxTouchPoints; }, ''),
      plat: safe(function () { return nav.platform; }, ''),
      vendor: safe(function () { return nav.vendor; }, '')
    };
  }
  function tmplStr(env) {
    var t = tmpl(env), out = [];
    for (var k in t) out.push(k + '=' + t[k]);
    return out.join('|');
  }

  // ---------- 探针注册 ----------
  var PROBES = [], MAP = {};
  function probe(id, fn) { if (MAP[id]) return; MAP[id] = true; PROBES.push({ id: id, run: fn }); }

  // ============ net · 客户端可读部分 ============
  probe('clock', function (env, ctx) {
    var local = Date.now() / 1000;
    var off = -new Date().getTimezoneOffset() / 60;
    var skew = null;
    if (ctx.trace && ctx.trace.ts) skew = num((parseFloat(ctx.trace.ts) - local) / 3600, 1);
    return { off: num(off, 2), skew_h: skew };
  });

  // 一次 ICE 收集，供 webrtc / lan / v6mac 共用
  var icePromise = null;
  function ice(env) {
    if (icePromise) return icePromise;
    icePromise = new Promise(function (resolve) {
      var RTC = safe(function () { return env.RTCPeerConnection || env.webkitRTCPeerConnection; }, null);
      if (!RTC) { resolve(M('unsupported')); return; }
      var addrs = [], done = false;
      function finish() { if (done) return; done = true; resolve(addrs); }
      try {
        var pc = new RTC({ iceServers: [], iceCandidatePoolSize: 0 });
        var timer = setTimeout(function () { finish(); }, 2000);
        pc.onicecandidate = function (e) {
          if (!e || !e.candidate) { clearTimeout(timer); finish(); return; }
          var c = e.candidate.candidate || '';
          var m = c.match(/([0-9a-fA-F.:]{3,})\s/);
          if (m) addrs.push(m[1]);
          if (/\.local/.test(c)) addrs.push('mdns.local');
        };
        pc.createDataChannel('r');
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { clearTimeout(timer); finish(); });
      } catch (e) { resolve(M('error')); }
    });
    return icePromise;
  }
  probe('webrtc', function (env) { return ice(env).then(function (a) { return { api: !isMissing(a), mdns: a.indexOf ? a.indexOf('mdns.local') >= 0 : null }; }); });
  probe('lan', function (env) {
    return ice(env).then(function (a) {
      if (isMissing(a)) return a;
      var ips = a.filter(function (x) { return x !== 'mdns.local' && /^\d+\.\d+\.\d+\.\d+$/.test(x); });
      if (!ips.length) return { ips: [], mdns_only: true };
      return { ips: ips.slice(0, 8) };
    });
  });
  probe('v6mac', function (env) {
    return ice(env).then(function (a) {
      if (isMissing(a)) return a;
      var v6 = a.filter(function (x) { return x.indexOf(':') > 0; });
      return { v6: v6.length > 0, eui64: v6.some(function (x) { return /ff:fe/i.test(x); }) };
    });
  });

  probe('dns', function (env, ctx) {
    return ctx.json('https://edns.ip-api.com/json', 2200).then(function (j) { return (j && j.dns) ? j : M('unsupported'); });
  });

  // ============ exit · 出口 ============
  function exitTrace(host, field) {
    return function (env, ctx) {
      return ctx.text('https://' + host + '/cdn-cgi/trace', 1800).then(function (t) {
        if (!t) return M('unsupported');
        var kv = ctx.parseTrace(t);
        var o = { loc: kv.loc || null, colo: kv.colo || null };
        if (field && kv[field]) o[field] = kv[field];
        return o;
      });
    };
  }
  probe('ex_gpt', exitTrace('chatgpt.com'));
  probe('ex_claude', exitTrace('claude.ai'));
  probe('ex_cf', exitTrace('www.cloudflare.com'));
  // trace 主机兜底：只要有一个能读到 http/tls 就算成功（radar 那条不一定带 http=）
  probe('stack', function (env, ctx) {
    var hosts = ['www.cloudflare.com', 'radar.cloudflare.com', 'cloudflare.com'];
    var i = 0;
    function next() {
      if (i >= hosts.length) return Promise.resolve(M('unsupported'));
      var host = hosts[i++];
      return ctx.text('https://' + host + '/cdn-cgi/trace', 2500).then(function (t2) {
        if (!t2) return next();
        var kv = ctx.parseTrace(t2);
        if (!kv.http && !kv.tls) return next();
        return { loc: kv.loc || null, colo: kv.colo || null, http: kv.http || null, tls: kv.tls || null };
      });
    }
    return next();
  });
  probe('ex_intl', function (env, ctx) {
    return ctx.json('https://api.ip.sb/geoip', 2000).then(function (j) {
      if (!j) return M('unsupported');
      return { country: j.country_code || j.country || null, isp: j.isp || j.organization || null, asn: j.asn || null };
    });
  });
  probe('ex_cn', function (env, ctx) {
    // 现在的返回是 {"ret":"ok","data":{"ip":"…","location":["中国","陕西","西安","","电信"]}}
    // 老格式是 {data:{country,province,city,isp}}，两种都要认
    return ctx.text('https://myip.ipip.net/json', 2200).then(function (t) {
      if (!t) return M('unsupported');
      var j = null; try { j = JSON.parse(t); } catch (e) { return M('unsupported'); }
      var d = (j && (j.data || j)) || {};
      var loc = Array.isArray(d.location) ? d.location : [];
      var o = {
        country: d.country || loc[0] || null,
        province: d.province || loc[1] || null,
        city: d.city || loc[2] || null,
        isp: d.isp || loc[4] || null
      };
      if (!o.country && !o.province && !o.city && !o.isp) return M('unsupported');
      return o;
    });
  });

  // ============ loc · 9 项 ============
  probe('langs', function (env) { return safe(function () { return (env.navigator.languages || [env.navigator.language]).slice(0, 12); }, M('unsupported')); });
  probe('locale', function (env) { return safe(function () { return Intl.DateTimeFormat().resolvedOptions().locale; }, M('unsupported')); });
  probe('tz', function (env) { return safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, M('unsupported')); });
  probe('hour', function () { return safe(function () { return new Date().getHours(); }, null); });
  probe('week', function (env) { return safe(function () { return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date()); }, M('unsupported')); });
  probe('fmt', function (env) {
    return safe(function () {
      var d = new Date(2024, 0, 2, 15, 4, 5);
      return new Intl.DateTimeFormat().format(d) + '|' + new Intl.NumberFormat().format(1234567.891) + '|' + (1234.5).toLocaleString();
    }, M('unsupported'));
  });
  probe('icu', function (env) {
    return safe(function () {
      var out = [];
      if (Intl.Segmenter) { try { var seg = new Intl.Segmenter('zh', { granularity: 'word' }); var n = 0; for (var s of seg.segment('今天天气不错')) n++; out.push('seg' + n); } catch (e) { out.push('seg0'); } }
      if (Intl.DisplayNames) { try { out.push(new Intl.DisplayNames(['zh'], { type: 'region' }).of('US')); } catch (e) { out.push('dn0'); } }
      if (Intl.ListFormat) { try { out.push(new Intl.ListFormat('zh').format(['甲', '乙', '丙'])); } catch (e) { out.push('lf0'); } }
      if (Intl.RelativeTimeFormat) { try { out.push(new Intl.RelativeTimeFormat('zh').format(-1, 'day')); } catch (e) { out.push('rt0'); } }
      out.push('cal:' + safe(function () { return new Intl.DateTimeFormat('en-u-ca-chinese').format(new Date(2024, 0, 2)); }, '-'));
      return out;
    }, M('unsupported'));
  });
  probe('kbd', function (env) { return safe(function () { return env.navigator.keyboard && env.navigator.keyboard.getLayoutMap ? env.navigator.keyboard.getLayoutMap().then(function (m) { return m.get('KeyY') + '|' + m.get('KeyQ'); }) : M('unsupported'); }, M('unsupported')); });
  probe('voices', function (env) {
    return safe(function () {
      var ss = env.speechSynthesis;
      if (!ss || !ss.getVoices) return M('unsupported');
      var read = function () {
        var vs = ss.getVoices ? ss.getVoices() : [];
        if (!vs || !vs.length) return M('unsupported');
        return vs.slice(0, 300).map(function (v) { return (v.lang || '') + '/' + (v.name || ''); });
      };
      var now = read();
      if (!isMissing(now) && now.length) return now;
      return new Promise(function (res) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; res(read()); } }, 1200);
        try { ss.onvoiceschanged = function () { if (done) return; done = true; clearTimeout(t); res(read()); }; } catch (e) { }
      });
    }, M('unsupported'));
  });

  // ============ fp · 22 项 ============
  function canvasData(env, txt) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    c.width = 320; c.height = 70;
    var x = c.getContext('2d');
    if (!x) return null;
    x.textBaseline = 'top';
    x.font = '16px "Arial"';
    x.fillStyle = '#f60'; x.fillRect(0, 0, 320, 70);
    x.fillStyle = '#069'; x.fillText(txt || 'Radish 指纹 Cwm fjordbank 😃 0123', 4, 4);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Radish 指纹 Cwm fjordbank 😃 0123', 8, 24);
    var g = x.createLinearGradient(0, 0, 320, 0);
    g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f');
    x.fillStyle = g; x.fillRect(0, 50, 320, 20);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = 'rgba(0,255,255,0.5)'; x.beginPath(); x.arc(180, 35, 24, 0, Math.PI * 2); x.fill();
    return c.toDataURL();
  }
  probe('canvas', function (env) {
    try { var d = canvasData(env); if (!d) return M('unsupported'); return hash(d).then(function (h) { return { h: h, len: d.length }; }); }
    catch (e) { return M('error'); }
  });
  probe('rand', function (env) {
    try {
      var a = canvasData(env, 'rand-A'), b = canvasData(env, 'rand-A'), c = canvasData(env, 'rand-B');
      return { same: a === b && a !== c };
    } catch (e) { return M('error'); }
  });
  function glInfo(env) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return null;
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gl: gl,
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      sl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      ext: (gl.getSupportedExtensions() || []).length
    };
  }
  probe('webgl', function (env) {
    try {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      return { vendor: i.vendor, renderer: i.renderer, unmaskedVendor: i.unmaskedVendor, unmaskedRenderer: i.unmaskedRenderer, version: i.version, sl: i.sl, ext: i.ext };
    } catch (e) { return M('error'); }
  });
  probe('audio', function (env) {
    try {
      var AC = env.OfflineAudioContext || env.webkitOfflineAudioContext;
      if (!AC) return M('unsupported');
      var off = new AC(1, 44100, 44100);
      var o = off.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000;
      var comp = off.createDynamicsCompressor();
      o.connect(comp); comp.connect(off.destination); o.start(0);
      return off.startRendering().then(function (buf) {
        var d = buf.getChannelData(0), s = 0;
        for (var i = 0; i < d.length; i += 97) s += Math.abs(d[i]);
        return num(s, 6);
      }).then(function (v) { return String(v); });
    } catch (e) { return M('error'); }
  });
  var MATH_KEYS = ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'atan2', 'pow', 'sinh', 'cosh', 'tanh', 'asin', 'acos', 'atan', 'expm1', 'log1p', 'cbrt', 'atanh'];
  probe('mathfp', function (env) {
    try {
      var out = [];
      for (var i = 0; i < MATH_KEYS.length; i++) {
        var f = Math[MATH_KEYS[i]];
        out.push(MATH_KEYS[i] + ':' + safe(function () { return f(0.123456789); }, '?'));
      }
      out.push('h32:' + Math.fround(1.1) + ':' + (0.1 + 0.2) + ':' + Math.hypot(3, 4) + ':' + Math.imul(0xffffffff, 5));
      return hash(out.join('|'));
    } catch (e) { return M('error'); }
  });
  var FONT_PROBE = 'mmmmmmmmmmlli1|WQ@#ä';
  var FONT_BASE = ['monospace', 'sans-serif', 'serif'];
  var FONT_LIST = ['Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Meiryo', 'Microsoft YaHei', 'Microsoft JhengHei', 'MS Gothic', 'Palatino Linotype', 'Segoe UI', 'SimSun', 'NSimSun', 'SimHei', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Wingdings', 'Noto Sans', 'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans', 'Helvetica Neue', 'Roboto', 'Ubuntu', 'Cantarell', 'DejaVu Sans', 'Liberation Sans', 'Fira Sans', 'Menlo', 'Monaco', 'Consolas UI'];
  function fontDetect(env) {
    var doc = env.document;
    var c = doc.createElement('canvas');
    var x = c.getContext('2d');
    if (!x) return null;
    var base = {};
    for (var b = 0; b < FONT_BASE.length; b++) { x.font = '72px ' + FONT_BASE[b]; base[FONT_BASE[b]] = x.measureText(FONT_PROBE).width; }
    var found = [];
    for (var i = 0; i < FONT_LIST.length; i++) {
      for (var j = 0; j < FONT_BASE.length; j++) {
        x.font = '72px "' + FONT_LIST[i] + '",' + FONT_BASE[j];
        if (x.measureText(FONT_PROBE).width !== base[FONT_BASE[j]]) { found.push(FONT_LIST[i]); break; }
      }
    }
    return found;
  }
  probe('fontfp', function (env) { try { var f = fontDetect(env); return f ? hash(f.join(',')) : M('unsupported'); } catch (e) { return M('error'); } });
  probe('fonts', function (env) { try { var f = fontDetect(env); return f ? f : M('unsupported'); } catch (e) { return M('error'); } });
  probe('emoji', function (env) {
    try {
      var doc = env.document, c = doc.createElement('canvas'), x = c.getContext('2d');
      if (!x) return M('unsupported');
      var marks = { '13.0': '🥲', '14.0': '🫠', '15.0': '🫸', '15.1': '🍋‍🟩', '16.0': '🪾' };
      var last = 'unknown';
      for (var k in marks) {
        x.font = '32px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
        var w = x.measureText(marks[k]).width, r = x.measureText('\uFFFF').width;
        if (w > r * 1.2) last = k;
      }
      return last;
    } catch (e) { return M('error'); }
  });
  probe('domrect', function (env) {
    try {
      var doc = env.document, d = doc.createElement('div');
      d.style.cssText = 'position:absolute;left:-9999px;top:0;width:137.5px;height:43.25px;transform:rotate(7deg);border:1px solid #000;padding:2.5px';
      doc.body.appendChild(d);
      var r = d.getBoundingClientRect(), rects = d.getClientRects();
      var s = [r.width, r.height, r.x, r.top, rects.length].join(',');
      doc.body.removeChild(d);
      return hash(s);
    } catch (e) { return M('error'); }
  });
  probe('svgrect', function (env) {
    try {
      var doc = env.document;
      var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '137.5'); svg.setAttribute('height', '43.25');
      var t = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', '3.25'); t.setAttribute('y', '17.75');
      t.setAttribute('font-size', '13.5'); t.textContent = 'Radish 指纹 Cwm';
      svg.appendChild(t); doc.body.appendChild(svg);
      var b = t.getBBox(), r = svg.getBoundingClientRect();
      var s = [b.x, b.y, b.width, b.height, r.width, r.height].join(',');
      doc.body.removeChild(svg);
      return hash(s);
    } catch (e) { return M('error'); }
  });
  probe('textm', function (env) {
    try {
      var doc = env.document, c = doc.createElement('canvas'), x = c.getContext('2d');
      if (!x) return M('unsupported');
      x.font = '17.5px "Arial"';
      var m = x.measureText('Cwm fjordbank glyphs vext quiz 0123456789 博客');
      var s = [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent].join(',');
      return hash(s);
    } catch (e) { return M('error'); }
  });
  probe('glimg', function (env) {
    try {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      var gl = i.gl;
      gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
      gl.compileShader(vs);
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float;void main(){gl_FragColor=vec4(0.1,0.7,0.3,1.);}');
      gl.compileShader(fs);
      var pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return M('unsupported');
      gl.useProgram(pr);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var px = new Uint8Array(4 * 64);
      gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return hash(px.join(','));
    } catch (e) { return M('error'); }
  });
  probe('keys', function (env) {
    return safe(function () {
      var out = { window: Object.keys(env).length };
      try { out.html = Object.keys(env.HTMLElement.prototype).length; } catch (e) { out.html = null; }
      try { out.css = env.CSS && env.CSS.supports ? 1 : 0; } catch (e) { out.css = null; }
      var doc = env.document;
      if (doc && doc.documentElement) {
        var styles = env.getComputedStyle ? env.getComputedStyle(doc.documentElement) : null;
        if (styles) out.html = out.html === null ? null : out.html;
      }
      // 用一张元素统计所有可枚举 CSS 属性，作为风格指纹的一部分
      try {
        var d = doc.createElement('div');
        doc.body.appendChild(d);
        var cs = env.getComputedStyle ? env.getComputedStyle(d) : null;
        out.css = cs ? cs.length : out.css;
        doc.body.removeChild(d);
      } catch (e) { }
      return out;
    }, M('unsupported'));
  });
  probe('timer', function (env) {
    try {
      var p = env.performance;
      if (!p || !p.now) return M('unsupported');
      var best = 1, seen = 0;
      for (var i = 0; i < 20000 && seen < 64; i++) {
        var a = p.now(), b = p.now();
        if (b > a) { var d = b - a; if (d > 0 && d < best) best = d; seen++; }
      }
      var nowc = p.now();
      return { res: num(best, 6), now: num(nowc, 3), jitter: 0 };
    } catch (e) { return M('error'); }
  });
  probe('callstack', function () { 
    try {
      var n = 0;
      function r() { n++; if (n < 30000) r(); }
      try { r(); } catch (e) { }
      return n;
    } catch (e) { return M('error'); }
  });
  probe('engine', function (env) {
    return safe(function () {
      var s = new Error().stack || '';
      if (/Firefox|@\[native code\]/.test(s) && /Safari/.test(s)) return 'safari';
      if (/chrome|chromium/i.test(env.navigator.userAgent) || typeof env.chrome !== 'undefined') return 'blink';
      if (/firefox/i.test(env.navigator.userAgent)) return 'gecko';
      if (/safari/i.test(env.navigator.userAgent)) return 'webkit';
      return 'unknown';
    }, M('unsupported'));
  });
  probe('engver', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '';
      var m = ua.match(/(?:Chrome|Chromium|Firefox|Edg|OPR|Version)\/(\d+)/);
      return m ? m[1] : 'unknown';
    }, M('unsupported'));
  });
  probe('lies', function (env) {
    return safe(function () {
      var out = [], doc = env.document;
      var f = Function.prototype.toString;
      function check(name, obj) {
        try {
          var s = f.call(obj);
          if (s.indexOf('[native code]') < 0) out.push(name);
        } catch (e) { out.push(name + ':err'); }
      }
      check('Function.prototype.toString', f);
      try { if (!('languages' in env.navigator) || !Object.getOwnPropertyDescriptor(Object.getPrototypeOf(env.navigator) || {}, 'languages')) out.push('languages-missing'); } catch (e) { }
      try { if (env.Notification && !Object.getOwnPropertyDescriptor(env.Notification, 'permission')) out.push('notification-descriptor'); } catch (e) { out.push('notification-err'); }
      try {
        if (typeof WebGLRenderingContext !== 'undefined' && !Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter')) out.push('webgl-getParameter-descriptor');
      } catch (e) { }
      try { if (env.navigator.plugins && env.navigator.plugins.length === 0 && /Chrome/.test(env.navigator.userAgent)) out.push('plugins-empty-chrome'); } catch (e) { }
      if (env.navigator && env.navigator.webdriver === true) out.push('webdriver-true');
      return out;
    }, M('unsupported'));
  });
  probe('cssv', function (env) {
    return safe(function () {
      var S = env.CSS && env.CSS.supports;
      if (!S) return M('unsupported');
      var tests = [
        ['2024', ['color', 'color-mix(in srgb, red, blue)']],
        ['2023', ['container-type', 'size']],
        ['2022', ['accent-color', 'red']],
        ['2021', ['aspect-ratio', '1/1']],
        ['2020', ['gap', '1px']],
        ['2019', ['position', 'sticky']],
        ['2017', ['display', 'grid']]
      ];
      for (var i = 0; i < tests.length; i++) if (S(tests[i][1][0], tests[i][1][1])) return tests[i][0];
      return 'old';
    }, M('unsupported'));
  });
  probe('smooth', function (env) {
    return safe(function () {
      var doc = env.document, c = doc.createElement('canvas'), x = c.getContext('2d');
      if (!x) return M('unsupported');
      x.font = '12px sans-serif';
      var m = x.measureText('mm');
      return [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].join(',');
    }, M('unsupported'));
  });
  probe('shield', function (env) {
    return safe(function () {
      var brave = !!(env.navigator && (env.navigator.brave || /Brave/.test(env.navigator.userAgent || '')));
      var noise = null;
      try {
        var a = Math.random(), b = Math.random(), c = Math.random();
        noise = !(a !== b && b !== c);
      } catch (e) { noise = null; }
      return { brave: brave, noise: noise };
    }, M('unsupported'));
  });
  probe('fpid', function (env) {
    return hash(tmplStr(env)).then(function (h) { return h; });
  });
  probe('hwid', function (env) {
    var t = tmpl(env);
    var bits = [];
    bits.push(t.screen, t.hc, t.mem, t.touch, t.plat, t.vendor);
    try {
      var i = glInfo(env);
      if (i) bits.push(i.unmaskedRenderer, i.unmaskedVendor);
    } catch (e) { }
    try {
      var f = fontDetect(env);
      if (f) bits.push(f.length, f.slice(0, 8).join(','));
    } catch (e) { }
    return hash(bits.join('|'));
  });

  // ============ dev · 34 项 ============
  function uaData(env) { return safe(function () { return env.navigator.userAgentData || null; }, null); }
  probe('os', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '';
      var uad = uaData(env);
      if (uad && uad.platform) {
        var v = safe(function () { return uad.getHighEntropyValues ? '?' : '?'; }, '?');
        return uad.platform;
      }
      var m;
      if ((m = ua.match(/Windows NT 10\.0/))) return /Windows/.test(ua) ? 'Windows' : 'Windows';
      if (/Android/.test(ua)) { m = ua.match(/Android ([\d.]+)/); return 'Android ' + (m ? m[1] : ''); }
      if (/iPhone|iPad|iPod/.test(ua)) { m = ua.match(/OS ([\d_]+)/); return 'iOS ' + (m ? m[1].replace(/_/g, '.') : ''); }
      if (/Mac OS X/.test(ua)) { m = ua.match(/Mac OS X ([\d_.]+)/); return 'macOS ' + (m ? m[1].replace(/_/g, '.') : ''); }
      if (/CrOS/.test(ua)) return 'ChromeOS';
      if (/Linux/.test(ua)) return 'Linux';
      return 'unknown';
    }, M('unsupported'));
  });
  probe('browser', function (env) {
    return safe(function () {
      var ua = env.navigator.userAgent || '', m;
      var names = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']];
      for (var i = 0; i < names.length; i++) { m = ua.match(names[i][0]); if (m) return names[i][1] + ' ' + m[1]; }
      return 'unknown';
    }, M('unsupported'));
  });
  probe('arch', function (env) {
    return safe(function () {
      var uad = uaData(env);
      if (uad && uad.getHighEntropyValues) {
        return uad.getHighEntropyValues(['architecture', 'bitness']).then(function (v) {
          try { env.__radishHints = env.__radishHints || {}; env.__radishHints.architecture = v.architecture; env.__radishHints.bitness = v.bitness; } catch (e) { }
          return (v.architecture || 'unknown') + (v.bitness ? '/' + v.bitness : '');
        }).catch(function () { return archFromUa(env); });
      }
      return archFromUa(env);
    }, M('unsupported'));
    function archFromUa(env) {
      var ua = env.navigator.userAgent || '';
      if (/aarch64|arm64|arm/i.test(ua)) return 'arm';
      if (/WOW64|Win64|x64|x86_64/.test(ua)) return 'x86/64';
      return 'unknown';
    }
  });
  probe('form', function (env) {
    return safe(function () {
      var uad = uaData(env);
      if (uad && uad.mobile === true) return 'Mobile';
      var ua = env.navigator.userAgent || '';
      if (/iPad|Tablet/.test(ua)) return 'Tablet';
      if (/Mobi|Android.*Mobile/.test(ua)) return 'Mobile';
      var touch = (env.navigator.maxTouchPoints || 0) > 0;
      if (touch && (env.screen ? env.screen.width >= 768 : false) && /Macintosh/.test(ua)) return 'Tablet';
      return 'Desktop';
    }, M('unsupported'));
  });
  probe('model', function (env) {
    return safe(function () {
      var uad = uaData(env);
      if (uad && uad.getHighEntropyValues) {
        return uad.getHighEntropyValues(['model']).then(function (v) { return v.model || M('unsupported'); }).catch(function () { return M('unsupported'); });
      }
      return M('unsupported');
    }, M('unsupported'));
  });
  probe('screen', function (env) {
    return safe(function () {
      var s = env.screen;
      return { w: s.width, h: s.height, aw: s.availWidth, ah: s.availHeight, dpr: num(env.devicePixelRatio, 3), depth: s.colorDepth };
    }, M('unsupported'));
  });
  probe('hz', function (env) {
    var doc = env.document || {};
    return new Promise(function (resolve) {
      var raf = env.requestAnimationFrame;
      if (!raf) { resolve(M('unsupported')); return; }
      var settled = false;
      var guard = setTimeout(function () { done(M('unsupported')); }, 4500);
      function done(v) { if (settled) return; settled = true; clearTimeout(guard); resolve(v); }
      // 后台标签页 rAF 会被暂停，等页面可见再测
      if (doc.visibilityState === 'hidden') {
        if (!env.addEventListener) { done(M('unsupported')); return; }
        env.addEventListener('visibilitychange', function () {
          if (doc.visibilityState !== 'hidden') measure();
        }, { once: true });
        return;
      }
      measure();
      function measure() {
        var times = [];
        var stop = setTimeout(finish, 1200);
        function finish() {
          clearTimeout(stop);
          if (times.length < 3) { done(M('unsupported')); return; }
          var deltas = [];
          for (var i = 1; i < times.length; i++) { var d = times[i] - times[i - 1]; if (d > 0) deltas.push(d); }
          if (!deltas.length) { done(M('unsupported')); return; }
          deltas.sort(function (a, b) { return a - b; });
          done(num(1000 / deltas[Math.floor(deltas.length / 2)], 0));
        }
        function step(ts) {
          times.push(ts || 0);
          if (times.length >= 30) { finish(); return; }
          raf.call(env, step);
        }
        raf.call(env, step);
      }
    });
  });
  probe('screens', function (env) {
    return safe(function () {
      var s = env.screen;
      return { n: s.isExtended ? 2 : 1, ext: !!s.isExtended };
    }, M('unsupported'));
  });
  probe('win', function (env) {
    return safe(function () {
      var o = { iw: env.innerWidth || 0, ih: env.innerHeight || 0 };
      var ow = env.outerWidth || 0, oh = env.outerHeight || 0;
      // 只在合理时给外框尺寸，否则宁可不发（最小化 / 无边框窗口会给出 160×28 这种垃圾值）
      if (ow > 0 && ow >= o.iw && oh >= o.ih) { o.ow = ow; o.oh = oh; }
      return o;
    }, M('unsupported'));
  });
  probe('scrollbar', function (env) {
    return safe(function () {
      var doc = env.document, d = doc.createElement('div');
      d.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
      doc.body.appendChild(d);
      var w = d.offsetWidth - d.clientWidth;
      doc.body.removeChild(d);
      return w;
    }, M('unsupported'));
  });
  probe('gpu', function (env) {
    return safe(function () {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      return { vendor: i.vendor, renderer: i.renderer, unmasked: i.unmaskedRenderer };
    }, M('error'));
  });
  probe('webgpu', function (env) {
    return new Promise(function (resolve) {
      try {
        var g = env.navigator.gpu;
        if (!g || !g.requestAdapter) { resolve(M('unsupported')); return; }
        g.requestAdapter().then(function (a) {
          if (!a) { resolve(M('unsupported')); return; }
          var info = a.info || (a.requestAdapterInfo ? null : null);
          var out = { vendor: info && info.vendor || null, arch: info && info.architecture || null, device: info && info.device || null, desc: info && info.description || null };
          if (!info && a.requestAdapterInfo) { return a.requestAdapterInfo().then(function (i2) { resolve({ vendor: i2.vendor || null, arch: i2.architecture || null, device: i2.device || null, desc: i2.description || null }); }); }
          resolve(out.vendor || out.desc ? out : M('unsupported'));
        }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('gpulim', function (env) {
    return safe(function () {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      var gl = i.gl;
      return { maxTexDim: gl.getParameter(gl.MAX_TEXTURE_SIZE), features: (gl.getSupportedExtensions() || []).slice(0, 40) };
    }, M('unsupported'));
  });
  probe('glx', function (env) {
    return safe(function () {
      var i = glInfo(env);
      if (!i) return M('unsupported');
      var gl = i.gl, vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      return { maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewport: [vp[0], vp[1]], ext: i.ext };
    }, M('unsupported'));
  });
  probe('cpu', function (env) { return safe(function () { return env.navigator.hardwareConcurrency || null; }, M('unsupported')); });
  probe('mem', function (env) { return safe(function () { return env.navigator.deviceMemory || null; }, M('unsupported')); });
  probe('heap', function (env) {
    return safe(function () {
      var m = env.performance && env.performance.memory;
      if (!m) return M('unsupported');
      return Math.round(m.jsHeapSizeLimit / 1048576);
    }, M('unsupported'));
  });
  probe('touch', function (env) {
    return safe(function () {
      var nav = env.navigator;
      return { points: nav.maxTouchPoints || 0, pointer: nav.pointerEnabled === false ? 'no' : (env.PointerEvent ? 'yes' : 'no'), hover: env.matchMedia ? (env.matchMedia('(hover: hover)').matches ? true : false) : null };
    }, M('unsupported'));
  });
  probe('battery', function (env) {
    return new Promise(function (resolve) {
      try {
        var n = env.navigator;
        if (!n.getBattery) { resolve(M('unsupported')); return; }
        n.getBattery().then(function (b) { resolve({ level: num(b.level, 2), charging: !!b.charging }); }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('geoloc', function () { return M('denied'); });
  probe('sensors', function () { return M('denied'); });
  probe('gamepad', function (env) { return safe(function () { return env.navigator.getGamepads ? M('denied') : M('unsupported'); }, M('unsupported')); });
  probe('conn', function (env) {
    return safe(function () {
      var c = env.navigator.connection || env.navigator.mozConnection || env.navigator.webkitConnection;
      if (!c) return M('unsupported');
      return { eff: c.effectiveType || null, rtt: c.rtt === undefined ? null : c.rtt, down: c.downlink === undefined ? null : c.downlink, save: !!c.saveData };
    }, M('unsupported'));
  });
  probe('media', function (env) {
    return safe(function () {
      var n = env.navigator;
      return { audio: n.hardwareConcurrency && env.MediaSource ? 1 : 0, video: env.HTMLMediaElement ? 1 : 0 };
    }, M('unsupported'));
  });
  probe('audiohw', function (env) {
    return new Promise(function (resolve) {
      try {
        var md = env.navigator.mediaDevices;
        if (!md || !md.enumerateDevices) { resolve(M('unsupported')); return; }
        md.enumerateDevices().then(function (d) {
          resolve({ total: d.length, audio: d.filter(function (x) { return x.kind === 'audioinput' || x.kind === 'audiooutput'; }).length, video: d.filter(function (x) { return x.kind === 'videoinput'; }).length });
        }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('bio', function (env) {
    return new Promise(function (resolve) {
      try {
        var p = env.PublicKeyCredential;
        if (!p || !p.isUserVerifyingPlatformAuthenticatorAvailable) { resolve(M('unsupported')); return; }
        p.isUserVerifyingPlatformAuthenticatorAvailable().then(function (v) { resolve(!!v); }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('bt', function (env) { return safe(function () { return !!(env.navigator.bluetooth); }, M('unsupported')); });
  probe('xr', function (env) {
    return new Promise(function (resolve) {
      try {
        var x = env.navigator.xr;
        if (!x || !x.isSessionSupported) { resolve(M('unsupported')); return; }
        Promise.all([x.isSessionSupported('immersive-vr').catch(function () { return null; }), x.isSessionSupported('immersive-ar').catch(function () { return null; })]).then(function (r) { resolve({ vr: !!r[0], ar: !!r[1] }); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  var CODECS = {
    h264: 'video/mp4; codecs="avc1.42E01E"',
    hev1: 'video/mp4; codecs="hev1.1.6.L93.B0"',
    vp8: 'video/webm; codecs="vp8"',
    vp9: 'video/webm; codecs="vp9"',
    av01: 'video/mp4; codecs="av01.0.05M.08"',
    opus: 'audio/webm; codecs="opus"',
    flac: 'audio/ogg; codecs="flac"',
    mp3: 'audio/mpeg',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    alac: 'audio/mp4; codecs="alac"'
  };
  probe('codecs', function (env) {
    return safe(function () {
      var MS = env.MediaSource;
      if (!MS || !MS.isTypeSupported) return M('unsupported');
      var out = {};
      for (var k in CODECS) out[k] = !!MS.isTypeSupported(CODECS[k]);
      return out;
    }, M('unsupported'));
  });
  probe('rtccodecs', function (env) {
    return safe(function () {
      // 注意：静态 getCapabilities 挂在 RTCRtpSender / RTCRtpReceiver 上，RTCPeerConnection 没有
      var S = env.RTCRtpSender, R = env.RTCRtpReceiver;
      if (!(S && S.getCapabilities) && !(R && R.getCapabilities)) return M('unsupported');
      var get = function (kind) { return (S && S.getCapabilities) ? S.getCapabilities(kind) : R.getCapabilities(kind); };
      var a = safe(function () { return get('audio').codecs.map(function (c) { return c.mimeType; }); }, []);
      var v = safe(function () { return get('video').codecs.map(function (c) { return c.mimeType; }); }, []);
      if (!a.length && !v.length) return M('unsupported');
      return { audio: a.slice(0, 12), video: v.slice(0, 16) };
    }, M('unsupported'));
  });
  probe('recmime', function (env) {
    return safe(function () {
      var MR = env.MediaRecorder;
      if (!MR || !MR.isTypeSupported) return M('unsupported');
      var list = ['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'video/mp4'];
      var out = {};
      for (var i = 0; i < list.length; i++) out[list[i]] = !!MR.isTypeSupported(list[i]);
      return out;
    }, M('unsupported'));
  });
  probe('hwdec', function (env) {
    return new Promise(function (resolve) {
      try {
        var mc = env.navigator.mediaCapabilities;
        if (!mc || !mc.decodingInfo) { resolve(M('unsupported')); return; }
        var cfgs = {
          h2648: { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          hevc: { type: 'file', video: { contentType: 'video/mp4; codecs="hev1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          av1: { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } },
          vp9: { type: 'file', video: { contentType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } }
        };
        var keys = Object.keys(cfgs), out = {};
        Promise.all(keys.map(function (k) { return mc.decodingInfo(cfgs[k]).then(function (r) { out[k] = !!r.powerEfficient; }).catch(function () { out[k] = null; }); })).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('drm', function (env) {
    return new Promise(function (resolve) {
      try {
        var n = env.navigator;
        if (!n.requestMediaKeySystemAccess) { resolve(M('unsupported')); return; }
        var sets = {
          widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready', fairplay: 'com.apple.fps.1_0', clearkey: 'org.w3.clearkey'
        };
        var keys = Object.keys(sets), out = {};
        Promise.all(keys.map(function (k) {
          var cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }];
          return n.requestMediaKeySystemAccess(sets[k], cfg).then(function () { out[k] = true; }).catch(function () { out[k] = false; });
        })).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('storage', function (env) {
    return new Promise(function (resolve) {
      try {
        var sm = env.navigator.storage;
        if (!sm || !sm.estimate) { resolve(M('unsupported')); return; }
        sm.estimate().then(function (e) { resolve({ quota: e.quota || null, usage: e.usage || null }); }).catch(function () { resolve(M('unsupported')); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });

  // ============ brw · 24 项 ============
  function mq(env, q) { return safe(function () { return env.matchMedia ? env.matchMedia(q).matches : null; }, null); }
  probe('scheme', function (env) { return safe(function () { return mq(env, '(prefers-color-scheme: dark)') ? 'dark' : 'light'; }, M('unsupported')); });
  probe('motion', function (env) { return safe(function () { return mq(env, '(prefers-reduced-motion: reduce)') ? 'reduce' : 'no-preference'; }, M('unsupported')); });
  probe('gamut', function (env) {
    return safe(function () {
      var g = mq(env, '(color-gamut: rec2020)') ? 'rec2020' : mq(env, '(color-gamut: p3)') ? 'p3' : mq(env, '(color-gamut: srgb)') ? 'srgb' : 'unknown';
      var d = mq(env, '(dynamic-range: high)') ? 'high' : 'standard';
      return { gamut: g, dynamic: d };
    }, M('unsupported'));
  });
  probe('a11y', function (env) {
    return safe(function () {
      var c = mq(env, '(prefers-contrast: more)') ? 'more' : mq(env, '(prefers-contrast: less)') ? 'less' : mq(env, '(prefers-contrast: custom)') ? 'custom' : 'no-preference';
      return { contrast: c, forced: !!mq(env, '(forced-colors: active)') };
    }, M('unsupported'));
  });
  probe('sysui', function (env) {
    return safe(function () {
      var doc = env.document, d = doc.createElement('div');
      d.style.cssText = 'position:absolute;top:-9999px;width:100px;height:40px;background:Canvas;color:CanvasText';
      doc.body.appendChild(d);
      var cs = env.getComputedStyle ? env.getComputedStyle(d) : null;
      var out = { fontSize: cs ? parseFloat(cs.fontSize) || null : null, accent: cs ? (cs.accentColor || null) : null };
      doc.body.removeChild(d);
      return out;
    }, M('unsupported'));
  });
  probe('display', function (env) { return safe(function () { return mq(env, '(display-mode: standalone)') ? 'standalone' : mq(env, '(display-mode: fullscreen)') ? 'fullscreen' : mq(env, '(display-mode: minimal-ui)') ? 'minimal-ui' : 'browser'; }, M('unsupported')); });
  probe('dnt', function (env) {
    return safe(function () {
      var n = env.navigator;
      var raw = n.doNotTrack;
      var dnt = (raw === undefined || raw === null || raw === '') ? null : String(raw);
      return { dnt: dnt, gpc: n.globalPrivacyControl === true };
    }, M('unsupported'));
  });
  probe('cookies', function (env) { return safe(function () { return env.navigator.cookieEnabled === undefined ? null : !!env.navigator.cookieEnabled; }, M('unsupported')); });
  probe('perms', function (env) {
    return new Promise(function (resolve) {
      try {
        var p = env.navigator.permissions;
        if (!p || !p.query) { resolve(M('unsupported')); return; }
        var names = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'local-fonts', 'persistent-storage', 'midi', 'accelerometer'];
        var out = {};
        Promise.all(names.map(function (n) {
          return p.query({ name: n }).then(function (r) { out[n] = r.state; }).catch(function () { out[n] = 'n/a'; });
        })).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('apis', function (env) {
    return safe(function () {
      var n = env.navigator, out = {};
      var list = ['usb', 'serial', 'hid', 'nfc', 'idle', 'share', 'clipboard', 'wakeLock', 'credentials', 'serviceWorker', 'gpu', 'bluetooth', 'storage', 'presentation', 'contacts'];
      for (var i = 0; i < list.length; i++) out[list[i]] = !!n[list[i]];
      return out;
    }, M('unsupported'));
  });
  probe('ai', function (env) {
    return new Promise(function (resolve) {
      try {
        var out = {};
        var L = env.LanguageModel || (env.window && env.window.LanguageModel);
        var T = env.Translator;
        if (!L && !T) { resolve(M('unsupported')); return; }
        var jobs = [];
        if (L && L.availability) jobs.push(L.availability().then(function (s) { out.languageModel = String(s); }).catch(function () { out.languageModel = 'error'; }));
        if (T && T.availability) jobs.push(T.availability().then(function (s) { out.translator = String(s); }).catch(function () { out.translator = 'error'; }));
        Promise.all(jobs).then(function () { resolve(out); });
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('webdriver', function (env) { return safe(function () { return env.navigator.webdriver === true; }, M('unsupported')); });
  probe('pdf', function (env) {
    return safe(function () {
      var n = env.navigator;
      if (n.pdfViewerEnabled !== undefined) return !!n.pdfViewerEnabled;
      if (n.plugins) for (var i = 0; i < n.plugins.length; i++) if (/pdf/i.test(n.plugins[i].name || '')) return true;
      return M('unsupported');
    }, M('unsupported'));
  });
  probe('auto', function (env) {
    return safe(function () {
      var out = [], w = env, n = env.navigator || {};
      if (n.webdriver === true) out.push('webdriver');
      if (w.callPhantom) out.push('phantom');
      if (w._phantom || w.__nightmare) out.push('phantomjs');
      if (w.Buffer) out.push('node-buffer');
      if (w.process && w.process.versions && w.process.versions.node) out.push('node-process');
      if (w.emit) out.push('node-emit');
      if (w.domAutomation || w.domAutomationController) out.push('cdp');
      if (n.userAgent && /HeadlessChrome/.test(n.userAgent)) out.push('headless-ua');
      if (w.external && w.external.toString && /Sequentum|Selenium/.test(String(w.external)))
        out.push('external');
      if (n.plugins && n.plugins.length === 0 && /Chrome/.test(n.userAgent || '')) out.push('plugins-empty');
      return out;
    }, M('unsupported'));
  });
  probe('idstr', function (env) {
    return safe(function () {
      var n = env.navigator, plugins = [];
      if (n.plugins) for (var i = 0; i < Math.min(n.plugins.length, 20); i++) plugins.push(n.plugins[i].name || '');
      return { vendor: n.vendor || null, productSub: n.productSub || null, plugins: plugins };
    }, M('unsupported'));
  });
  probe('agent', function (env) {
    return safe(function () {
      var uad = uaData(env), ua = env.navigator.userAgent || '';
      var kind = 'unknown', consistent = null;
      if (uad && uad.brands) {
        kind = uad.brands.map(function (b) { return b.brand; }).join(',');
        var major = uad.brands.filter(function (b) { return !/Not/.test(b.brand); }).map(function (b) { return b.version; })[0];
        var m = ua.match(/Chrome\/(\d+)/);
        consistent = !!(major && m && String(major).split('.')[0] === m[1]);
      } else if (/Firefox/.test(ua)) { kind = 'Firefox'; consistent = true; }
      else if (/Safari/.test(ua) && /Version/.test(ua)) { kind = 'Safari'; consistent = true; }
      return { kind: kind, consistent: consistent };
    }, M('unsupported'));
  });
  probe('worker', function (env) {
    return new Promise(function (resolve) {
      try {
        var W = env.Worker, B = env.Blob, U = env.URL;
        if (!W || !B || !U || !U.createObjectURL) { resolve(M('unsupported')); return; }
        var src = 'self.onmessage=function(){self.postMessage(navigator.userAgent)}';
        var url = U.createObjectURL(new B([src], { type: 'text/javascript' }));
        var w = new W(url), done = false;
        var t = setTimeout(function () { if (!done) { done = true; resolve(M('timeout')); } }, 2000);
        w.onmessage = function (e) {
          if (done) return; done = true; clearTimeout(t);
          resolve({ ok: true, uaSame: e.data === env.navigator.userAgent });
          try { U.revokeObjectURL(url); w.terminate(); } catch (er) { }
        };
        w.postMessage(1);
      } catch (e) { resolve(M('unsupported')); }
    });
  });
  probe('adblock', function (env) {
    return new Promise(function (resolve) {
      try {
        var doc = env.document, d = doc.createElement('div');
        d.className = 'adsbox ad-banner adsbygoogle pub_300x250';
        d.style.cssText = 'position:absolute;left:-9999px;width:300px;height:250px';
        doc.body.appendChild(d);
        setTimeout(function () {
          var blocked = d.offsetHeight === 0 || d.clientHeight === 0 || (env.getComputedStyle && env.getComputedStyle(d).display === 'none');
          try { doc.body.removeChild(d); } catch (e) { }
          resolve(!!blocked);
        }, 120);
      } catch (e) { resolve(M('error')); }
    });
  });
  probe('trackers', function () { return M('denied'); });
  probe('extwar', function () { return M('denied'); });
  probe('ext', function (env) {
    return safe(function () {
      var w = env, out = [];
      var marks = ['ethereum', '__NEXT_DATA__', '__REACT_DEVTOOLS_GLOBAL_HOOK__', '__VUE__', '__VUE_DEVTOOLS_GLOBAL_HOOK__', '__REDUX_DEVTOOLS_EXTENSION__', 'grammarly', 'Grammarly', '__grammarly', 'fbq', 'gtag', 'ga', 'dataLayer', '_gaGlobal', 'passiveEye'];
      for (var i = 0; i < marks.length; i++) if (typeof w[marks[i]] !== 'undefined') out.push(marks[i]);
      try {
        var uad = env.navigator.userAgentData;
        if (uad && uad.brands) for (var j = 0; j < uad.brands.length; j++) if (!/Not|Chromium|Google Chrome|Microsoft Edge/.test(uad.brands[j].brand)) out.push('brand:' + uad.brands[j].brand);
      } catch (e) { }
      return out;
    }, M('unsupported'));
  });
  probe('history', function (env) { return safe(function () { return env.history ? env.history.length : null; }, M('unsupported')); });
  probe('traces', function (env) {
    return safe(function () {
      var out = {};
      try { out.localStorage = !!env.localStorage && env.localStorage.length > 0; } catch (e) { out.localStorage = 'blocked'; }
      try { out.sessionStorage = !!env.sessionStorage && env.sessionStorage.length > 0; } catch (e) { out.sessionStorage = 'blocked'; }
      try { out.name = !!(env.name && String(env.name).length); } catch (e) { out.name = null; }
      try { out.caches = !!env.caches; } catch (e) { out.caches = null; }
      try {
        if (env.indexedDB && env.indexedDB.databases) {
          var p = env.indexedDB.databases();
          if (p && p.then) return p.then(function (d) { out.idb = (d || []).length > 0; return out; }).catch(function () { out.idb = null; return out; });
        }
        out.idb = null;
      } catch (e) { out.idb = null; }
      return out;
    }, M('unsupported'));
  });

  // ============ 网络辅助（trace / hints） ============
  function parseTrace(t) {
    var kv = {};
    String(t).split('\n').forEach(function (l) { var i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return kv;
  }

  function makeCtx(env) {
    var ctx = { trace: {}, hints: {} };
    ctx.parseTrace = parseTrace;
    ctx.text = function (url, ms) {
      try {
        return fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(ms || 2500) })
          .then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    };
    ctx.json = function (url, ms) {
      return ctx.text(url, ms).then(function (t) { if (!t) return null; try { return JSON.parse(t); } catch (e) { return null; } });
    };
    ctx.trace = {};
    return ctx;
  }

  // 并发池（8 路）+ 全局死线：到点就收工，没跑完的记 timeout 并记进 meta.stuck
  async function runProbes(env, ctx, cli, stuck, budgetMs) {
    var deadline = Date.now() + (budgetMs || DEADLINE);
    var next = 0;
    async function worker() {
      while (true) {
        var i = next++;
        if (i >= PROBES.length) return;
        var p = PROBES[i];
        var left = deadline - Date.now();
        if (left <= 0) { cli[p.id] = M('timeout'); stuck.push(p.id); continue; }
        var v = await withTimeout(
          Promise.resolve().then(function () { return p.run(env, ctx); }).catch(function () { return { __error: true }; }),
          Math.min(PROBE_TIMEOUT, Math.max(200, left)),
          p.id
        );
        if (v && v.__timeout) { cli[p.id] = M('timeout'); stuck.push(p.id); }
        else if (v && v.__error) { cli[p.id] = M('error'); }
        else if (v === undefined || v === null) { cli[p.id] = M('unsupported'); }
        else cli[p.id] = v;
      }
    }
    var lanes = [];
    for (var k = 0; k < 16; k++) lanes.push(worker());
    await Promise.all(lanes);
  }

  // ---------- 信封 ----------
  function uuid(env) {
    try { if (env.crypto && env.crypto.randomUUID) return env.crypto.randomUUID(); } catch (e) { }
    try {
      var b = new Uint8Array(16);
      (env.crypto || crypto).getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = ''; for (var i = 0; i < 16; i++) h += ('0' + b[i].toString(16)).slice(-2);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      return 'r' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    }
  }

  function store(env) {
    return safe(function () { return env.sessionStorage; }, null);
  }
  function getSession(env) {
    var s = store(env);
    if (s) {
      var v = safe(function () { return s.getItem('radish.sid'); }, null);
      if (v) return v;
      var nv = Math.random().toString(16).slice(2, 12);
      safe(function () { s.setItem('radish.sid', nv); }, null);
      return nv;
    }
    env.__radishSid = env.__radishSid || Math.random().toString(16).slice(2, 12);
    return env.__radishSid;
  }
  function alreadySent(env) {
    var s = store(env);
    var v = s ? safe(function () { return s.getItem('radish.sent'); }, null) : null;
    return v === '1' || env.__radishSent === true;
  }
  function markSent(env) {
    env.__radishSent = true;
    var s = store(env);
    if (s) safe(function () { s.setItem('radish.sent', '1'); }, null);
  }

  function optedOut(env) {
    var n = env.navigator || {};
    return n.globalPrivacyControl === true || String(n.doNotTrack) === '1';
  }

  function withTimeout(p, ms, id) {
    if (!p || typeof p.then !== 'function') return Promise.resolve(p);
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve({ __timeout: true }); } }, ms);
      p.then(function (v) { if (done) return; done = true; clearTimeout(t); resolve(v); },
        function () { if (done) return; done = true; clearTimeout(t); resolve({ __error: true }); });
    });
  }

  async function buildEnvelope(env, ctx) {
    env = env || (typeof globalThis !== 'undefined' ? globalThis : this);
    ctx = ctx || makeCtx(env);
    var t0 = Date.now();
    var cli = {}, stuck = [];
    var optout = optedOut(env);

    if (!optout) {
      await runProbes(env, ctx, cli, stuck, DEADLINE);
      // trace 派生项（浏览器直连边缘那次请求）——先等并行发出去的 trace/hints 回来
      if (ctx.ready) { try { await ctx.ready; } catch (e) { } }
      var tr = ctx.trace || {};
      cli['kex'] = tr.kex || M('unsupported');
      cli['warp'] = tr.warp || M('unsupported');
      cli['proto'] = (tr.http || tr.tls) ? { http: tr.http || null, tls: tr.tls || null } : M('unsupported');
      cli['edge'] = tr.colo || M('unsupported');
      // Accept-CH 回显
      var h = ctx.hints && ctx.hints.h ? ctx.hints.h : null;
      if (h && Object.keys(h).length) {
        var chv = [];
        for (var k in h) chv.push(k + '=' + h[k]);
        cli['ch'] = chv.slice(0, 8);
      }
    }

    var nav = env.navigator || {};
    return {
      v: 1,
      id: uuid(env),
      ts: new Date().toISOString(),
      session: getSession(env),
      page: {
        path: safe(function () { return env.location.pathname; }, ''),
        title: safe(function () { return String(env.document.title || '').slice(0, 120); }, ''),
        lang: safe(function () { return env.document.documentElement.lang || nav.language || ''; }, ''),
        ref: safe(function () { return String(env.document.referrer || '').slice(0, 300); }, ''),
        nav: 'navigate'
      },
      cli: cli,
      meta: {
        dur_ms: Date.now() - t0,
        stuck: stuck,
        truncated: [],
        privacy: { dnt: String(nav.doNotTrack) === '1', gpc: nav.globalPrivacyControl === true, optout: optout },
        collector: VERSION,
        ua: safe(function () { return nav.userAgent; }, '')
      }
    };
  }

  // ---------- 归一化与预算 ----------
  function normalize(v) {
    if (v === null || v === undefined) return 'null';
    if (isMissing(v)) return v.$;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(num(v, 4));
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) {
      var a = v.map(function (x) { return typeof x === 'object' && x ? JSON.stringify(x) : String(x); });
      a = a.filter(function (x, i) { return a.indexOf(x) === i; }).sort();
      return a.join('|');
    }
    var keys = Object.keys(v).sort(), out = [];
    for (var i = 0; i < keys.length; i++) out.push(keys[i] + ':' + normalize(v[keys[i]]));
    return out.join('|');
  }

  // 只裁数组型长尾项；逐级压缩直到塞进预算，被裁的项目记在 meta.truncated 里
  var TRIM_ORDER = ['fonts', 'voices', 'icu'];
  var TRIM_LEVELS = [300, 150, 75, 37, 18, 9];

  function applyBudget(envelope, limit) {
    limit = limit || BUDGET;
    var was = {}, dropped = [];
    var bytes = function () {
      var s = JSON.stringify(envelope);
      return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length;
    };
    var HARD = { fonts: 300, voices: 32, icu: 24 };
    for (var hid in HARD) {
      var hv = envelope.cli[hid];
      if (Array.isArray(hv) && hv.length > HARD[hid]) { was[hid] = hv.length; envelope.cli[hid] = hv.slice(0, HARD[hid]); }
    }
    for (var L = 0; L < TRIM_LEVELS.length && bytes() > limit; L++) {
      var cap = TRIM_LEVELS[L];
      for (var i = 0; i < TRIM_ORDER.length; i++) {
        if (bytes() <= limit) break;
        var id = TRIM_ORDER[i], v = envelope.cli[id];
        if (!Array.isArray(v) || v.length <= cap) continue;
        was[id] = was[id] || v.length;
        envelope.cli[id] = v.slice(0, cap);
      }
    }
    for (var k in was) dropped.push({ id: k, n: was[k] });
    envelope.meta = envelope.meta || {};
    envelope.meta.truncated = dropped;
    return { envelope: envelope, dropped: dropped, bytes: bytes() };
  }

  // ---------- 发送 ----------
  function endpointOf(opts) { return (opts && opts.endpoint) || ENDPOINT; }

  function waitIdle(env) {
    return new Promise(function (resolve) {
      var w = env;
      var done = false;
      function go() { if (done) return; done = true; resolve(); }
      try {
        if (w.document && w.document.readyState === 'complete') {
          if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 1500);
        } else if (w.addEventListener) {
          w.addEventListener('load', function () {
            if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 800);
          }, { once: true });
          setTimeout(go, 4000);
        } else setTimeout(go, 0);
      } catch (e) { go(); }
    });
  }

  async function run(env, opts) {
    env = env || (typeof globalThis !== 'undefined' ? globalThis : this);
    opts = opts || {};
    if (alreadySent(env)) return 'already';
    var traceUrl = opts.trace || TRACE_URL, hintsUrl = opts.hints || HINTS_URL;
    var ctx = makeCtx(env);

    // pagehide 时立刻继续（用户 1 秒内关页也要发出去）
    var hideResolve;
    var hidePromise = new Promise(function (r) { hideResolve = r; });
    try {
      if (env.addEventListener) env.addEventListener('pagehide', function () { hideResolve(); }, { once: true });
    } catch (e) { }

    await Promise.race([waitIdle(env), hidePromise, new Promise(function (r) { setTimeout(r, 4000); })]);

    // trace / hints 和探针同时跑：探针不依赖它们，只有组装信封时才需要
    ctx.ready = Promise.race([
      Promise.all([
        ctx.text(traceUrl, 2500).then(function (t) { if (t) ctx.trace = parseTrace(t); }),
        ctx.json(hintsUrl, 2500).then(function (j) { if (j) ctx.hints = j; })
      ]),
      new Promise(function (r) { setTimeout(r, 2500); })
    ]);
    var env2 = await buildEnvelope(env, ctx);
    var res = applyBudget(env2, opts.limit || BUDGET);
    env2 = res.envelope;
    env2.meta.dur_ms = Math.max(0, env2.meta.dur_ms);
    var body;
    try { body = JSON.stringify(env2); } catch (e) { return 'serialize_failed'; }

    var url = endpointOf(opts);
    var sent = false;
    try {
      if (env.navigator && typeof env.navigator.sendBeacon === 'function') {
        sent = env.navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      }
    } catch (e) { sent = false; }
    if (!sent) {
      try {
        await fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'content-type': 'text/plain' } });
        sent = true;
      } catch (e) { sent = false; }
    }
    markSent(env);
    return sent ? 'sent' : 'failed';
  }

  var RC = {
    VERSION: VERSION,
    ENDPOINT: ENDPOINT,
    TRACE_URL: TRACE_URL,
    HINTS_URL: HINTS_URL,
    BUDGET: BUDGET,
    normalize: normalize,
    applyBudget: applyBudget,
    buildEnvelope: buildEnvelope,
    parseTrace: parseTrace,
    M: M,
    probes: PROBES,
    run: run,
    getSession: getSession,
    optedOut: optedOut
  };

  if (typeof window !== 'undefined') {
    window.__radish = RC;
    // 自动启动：页面 load 后 1.2s 开始（给字体/权限状态留出稳定时间）；测试环境用 __radishManual 关掉
    if (!window.__radishManual) {
      try {
        var kick = function () { try { RC.run(); } catch (e) { } };
        var doc = typeof document !== 'undefined' ? document : null;
        // 越早发越好：不再等 load（要等图片/字体），也不再固定空等 1.2s
        if (!doc) kick();
        else if (doc.readyState === 'complete' || doc.readyState === 'interactive') kick();
        else if (doc.addEventListener) doc.addEventListener('DOMContentLoaded', kick, { once: true });
        else if (window.addEventListener) window.addEventListener('load', kick, { once: true });
      } catch (e) { }
    }
  }
  if (typeof globalThis !== 'undefined') globalThis.__radish = RC;
  if (typeof module !== 'undefined' && module.exports) module.exports = RC;
})();
