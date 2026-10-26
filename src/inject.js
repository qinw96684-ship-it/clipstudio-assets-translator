/* CLIP STUDIO 素材库自动翻译 —— 页面内注入引擎（多目标语言版）
 * 由 daemon.js 通过 CDP Runtime.evaluate 注入。
 *
 * 支持目标语言：zh-CN（简体中文）/ id（印尼语）/ pt（葡语）/ th（泰语）
 * 设计要点：
 *  - 只翻译「叶子文本节点」，不动 input 值，不破坏事件
 *  - 优先命中内置词库（离线、准确），未命中再走 Google 翻译
 *  - 翻译结果按「目标语言」分别缓存
 *  - 能识别「已经是目标语言」的文本并跳过，避免反复翻译
 *  - MutationObserver 监听动态加载的素材卡片
 *  - 右下角浮动按钮可切换目标语言 / 切回原文
 */
(function () {
  "use strict";

  var VERSION = "2.0.1";
  var CACHE_PREFIX = "clipTrCache.v3.";

  if (window.__CLIP_TRANSLATOR__ && window.__CLIP_TRANSLATOR__.version === VERSION) {
    try { window.__CLIP_TRANSLATOR__.rescan(); } catch (e) {}
    return "already-injected:" + VERSION;
  }
  if (window.__CLIP_TRANSLATOR__) {
    try { window.__CLIP_TRANSLATOR__.restore(); } catch (e) {}
    var oldPanel = document.getElementById("cliptrs-panel");
    if (oldPanel && oldPanel.parentNode) oldPanel.parentNode.removeChild(oldPanel);
    delete window.__CLIP_TRANSLATOR__;
  }

  var DICT_ALL = window.__CLIP_DICT__ || {};
  var TARGET = window.__CLIP_TARGET__ || "zh-CN";
  var META = (DICT_ALL._meta && DICT_ALL._meta.targets) || {};
  var ON = true;

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1, IFRAME: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  var NO_TRANSLATE = {};
  (DICT_ALL.noTranslate || []).forEach(function (w) { NO_TRANSLATE[String(w).toLowerCase()] = 1; });

  var queue = [];
  var queued = Object.create(null);
  var inflight = 0;
  var MAX_INFLIGHT = 4;
  var translatedCount = 0;
  var cache = {};
  var dictLower = {};

  /* ================= 语言识别 ================= */

  var RE = {
    zh: /[\u4e00-\u9fff]/,
    th: /[\u0e00-\u0e7f]/,
    ja: /[\u3040-\u30ff]/,
    ko: /[\uac00-\ud7af]/
  };

  // 印尼语常见功能词（用于判断文本是否已是印尼语）
  var ID_WORDS = ["yang", "dan", "untuk", "dengan", "dari", "ini", "itu", "tidak",
    "adalah", "pada", "akan", "bisa", "sudah", "atau", "juga", "dalam", "ke",
    "di", "oleh", "karena", "saat", "lebih", "sangat", "banyak", "semua"];
  // 葡语常见功能词
  var PT_WORDS = ["para", "com", "não", "uma", "dos", "das", "por", "mais",
    "como", "você", "seu", "sua", "está", "são", "também", "mas", "ao", "à",
    "pelo", "pela", "quando", "muito", "todos", "essa", "esse"];

  function wordHit(text, list) {
    var low = " " + text.toLowerCase().replace(/[^\wà-ÿ\s]/g, " ") + " ";
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (low.indexOf(" " + list[i] + " ") >= 0) n++;
    }
    return n;
  }

  // 判断这段文字是否「已经是目标语言」，是则无需翻译
  function isAlreadyTarget(text) {
    if (!text) return true;
    var t = text.trim();
    if (!t) return true;

    // 中日韩 / 泰文：字符集判定可靠
    if (TARGET === "zh-CN") return RE.zh.test(t);
    if (TARGET === "th") return RE.th.test(t);
    if (TARGET === "ja") return RE.ja.test(t);
    if (TARGET === "ko") return RE.ko.test(t);

    // 印尼语 / 葡语：拉丁字母，用功能词 + 命中词库判断
    if (RE.zh.test(t) || RE.th.test(t) || RE.ja.test(t) || RE.ko.test(t)) return true;

    // 先看是不是我们词库里的「译文」（说明已经翻过了）
    for (var k in dictLower) {
      if (dictLower[k] === t) return true;
    }

    if (TARGET === "id") {
      // 至少两个印尼语功能词，且不是明显英语
      if (wordHit(t, ID_WORDS) >= 2) return true;
    }
    if (TARGET === "pt") {
      if (wordHit(t, PT_WORDS) >= 2) return true;
    }
    return false;
  }

  /* ================= 缓存 ================= */

  function cacheKey() { return CACHE_PREFIX + TARGET; }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(cacheKey()) || "{}") || {}; }
    catch (e) { return {}; }
  }

  var saveTimer = null;
  function saveCache() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { localStorage.setItem(cacheKey(), JSON.stringify(cache)); } catch (e) {}
    }, 1200);
  }

  /* ================= 词库 ================= */

  function rebuildDict() {
    dictLower = Object.create(null);
    var d = DICT_ALL[TARGET] || {};
    for (var k in d) {
      dictLower[k.toLowerCase().replace(/\s+/g, " ").trim()] = d[k];
    }
  }

  function fromDict(text) {
    var key = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (dictLower[key]) return dictLower[key];
    var stripped = key.replace(/[：:。.]+$/, "");
    if (stripped !== key && dictLower[stripped]) return dictLower[stripped];
    return null;
  }

  function polish(out) {
    if (!out) return out;
    var rules = (DICT_ALL.postFix && DICT_ALL.postFix[TARGET]) || [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0] !== rules[i][1] && out.indexOf(rules[i][0]) >= 0) {
        out = out.split(rules[i][0]).join(rules[i][1]);
      }
    }
    return out;
  }

  /* ================= 需要翻译吗 ================= */

  // 品牌 / 产品名：这些词在译文里必须原样保留
  var BRANDS = [
    "CLIP STUDIO PAINT", "CLIP STUDIO START", "CLIP STUDIO ASSETS",
    "CLIP STUDIO TIPS", "CLIP STUDIO ASK", "CLIP STUDIO SHARE",
    "CLIP STUDIO SUPPORT", "CLIP STUDIO", "CLIP", "PAINT", "PRO/EX",
    "PRO", "EX", "DEBUT", "START", "ASSETS", "TIPS", "ASK", "SHARE",
    "SUPPORT", "Clippy", "GOLD", "Gold", "TABMATE", "CELSYS"
  ];

  // 把品牌名换成占位符，翻译后再换回来
  var PH_OPEN = "\uE000";
  var PH_CLOSE = "\uE001";
  function protectBrands(text) {
    var slots = [];
    var out = text;
    // 长的优先，避免 CLIP 先于 CLIP STUDIO PAINT 被替换
    var sorted = BRANDS.slice().sort(function (a, b) { return b.length - a.length; });
    sorted.forEach(function (brand) {
      var re = new RegExp("(^|[^A-Za-z])(" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![A-Za-z])", "g");
      out = out.replace(re, function (m, pre, hit) {
        var i = slots.length;
        slots.push(hit);
        return pre + PH_OPEN + i + PH_CLOSE;
      });
    });
    return { text: out, slots: slots };
  }

  function restoreBrands(out, slots) {
    if (!slots.length) return out;
    return out.replace(/\uE000(\d+)\uE001/g, function (m, i) {
      var idx = Number(i);
      return slots[idx] !== undefined ? slots[idx] : m;
    });
  }

  function needTranslate(text) {
    if (!text) return false;
    var t = text.trim();
    if (t.length < 2) return false;
    if (!/[A-Za-z]{2,}/.test(t)) return false;      // 没有字母（纯数字/符号）
    if (/^[\d\s.,:%+\-–—/()\[\]]+$/.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (NO_TRANSLATE[t.toLowerCase()]) return false;
    if (/^\d{1,2}([:.]\d{2})?\s*(AM|PM)?$/i.test(t)) return false;
    if (/^[\d,.]+\s*(CP|GB|MB|KB|pt|px)$/i.test(t)) return false;
    // 纯品牌名（如 CLIP STUDIO PAINT）不翻
    if (isOnlyBrand(t)) return false;
    if (isAlreadyTarget(t)) return false;
    return true;
  }

  function isOnlyBrand(t) {
    var rest = t;
    var sorted = BRANDS.slice().sort(function (a, b) { return b.length - a.length; });
    sorted.forEach(function (brand) {
      var re = new RegExp("(^|[^A-Za-z])" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z])", "g");
      rest = rest.replace(re, " ");
    });
    rest = rest.replace(/[\s\/\-|·.,:;()]+/g, "");
    return rest.length === 0;
  }

  /* ================= 翻译接口 ================= */

  // 品牌名先换成占位符再送翻译，避免被译成 KLIP / CAT 之类
  function googleTranslate(text) {
    var p = protectBrands(text);
    var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
      encodeURIComponent(TARGET) + "&dt=t&dj=1&q=" + encodeURIComponent(p.text);
    return fetch(url, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        var out = (j.sentences || []).map(function (s) { return s.trans || ""; }).join("").trim();
        return restoreBrands(out, p.slots);
      });
  }

  function myMemoryTranslate(text) {
    var p = protectBrands(text);
    var url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(p.text) +
      "&langpair=en|" + encodeURIComponent(TARGET);
    return fetch(url, { credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var t = j && j.responseData && j.responseData.translatedText;
        if (!t) throw new Error("empty");
        return restoreBrands(String(t).trim(), p.slots);
      });
  }

  function translateRemote(text) {
    return googleTranslate(text).catch(function () { return myMemoryTranslate(text); });
  }

  /* ================= 队列 ================= */

  function enqueue(text, apply) {
    var key = text.trim();
    if (cache[key]) { apply(cache[key]); return; }
    var hit = fromDict(key);
    if (hit) { cache[key] = hit; saveCache(); apply(hit); return; }
    if (queued[key]) { queued[key].push(apply); return; }
    queued[key] = [apply];
    queue.push(key);
    pump();
  }

  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) {
      var key = queue.shift();
      inflight++;
      translateRemote(key)
        .then(function (out) {
          if (out) {
            out = polish(out);
            cache[key] = out;
            saveCache();
            (queued[key] || []).forEach(function (fn) { try { fn(out); } catch (e) {} });
          }
        })
        .catch(function () {})
        .then(function () {
          delete queued[key];
          inflight--;
          updatePanel();
          pump();
        });
    }
    updatePanel();
  }

  /* ================= 节点处理 ================= */

  function shouldSkipNode(node) {
    var p = node.parentElement;
    if (!p) return true;
    if (SKIP_TAGS[p.tagName]) return true;
    if (p.closest && p.closest("#cliptrs-panel")) return true;
    if (p.tagName === "INPUT" || p.tagName === "SELECT" || p.tagName === "OPTION") return true;

    var skipSel = [
      ".materialCard__cardAuthor", ".materialCard__favoriteCount", ".materialCard__priceNum",
      "[class*='__author']", "[class*='__userName']", "[class*='__user']", "[class*='__creator']",
      "[class*='__account']", "[class*='__price']", "[class*='__count']", "[class*='__date']",
      "[class*='__datetime']", "[class*='__number']", "[class*='__time']", "[class*='__id']"
    ].join(",");
    try { if (p.closest(skipSel)) return true; } catch (e) {}

    var t = node.nodeValue.trim();
    if (/^@[A-Za-z0-9_.\-]+$/.test(t)) return true;

    // 作者名：同一区块里有头像 img 且 alt 与文本一致
    try {
      var block = p.parentElement;
      if (block) {
        var imgs = block.querySelectorAll("img");
        for (var i = 0; i < imgs.length; i++) {
          var alt = (imgs[i].getAttribute("alt") || "").trim();
          if (alt && alt === t) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function applyText(node, out) {
    if (!node || !node.nodeValue) return;
    if (!node.__cliptOrig) node.__cliptOrig = node.nodeValue;
    var m = node.__cliptOrig.match(/^(\s*)([\s\S]*?)(\s*)$/);
    var lead = m ? m[1] : "";
    var trail = m ? m[3] : "";
    node.nodeValue = lead + out + trail;
    translatedCount++;
  }

  function handleTextNode(node) {
    if (!ON) return;
    if (node.nodeType !== 3) return;
    if (node.__cliptDone) return;
    var raw = node.nodeValue;
    if (!raw) return;
    var text = raw.replace(/\s+/g, " ").trim();
    if (!needTranslate(text)) return;
    if (shouldSkipNode(node)) return;
    node.__cliptDone = true;
    var snap = node;
    enqueue(text, function (out) { applyText(snap, out); });
  }

  function translateAttributes(root) {
    if (!ON) return;
    var els;
    try { els = root.querySelectorAll("[placeholder],[title],[alt],[aria-label]"); }
    catch (e) { return; }
    var list = [];
    if (root.nodeType === 1 && root.matches && root.matches("[placeholder],[title],[alt],[aria-label]")) list.push(root);
    for (var i = 0; i < els.length && i < 600; i++) list.push(els[i]);

    ["placeholder", "title", "alt", "aria-label"].forEach(function (attr) {
      list.forEach(function (el) {
        var v = el.getAttribute(attr);
        if (!v) return;
        var key = "attr:" + attr;
        if (el.__cliptAttr && el.__cliptAttr[key]) return;
        if (!needTranslate(v)) return;
        el.__cliptAttr = el.__cliptAttr || {};
        el.__cliptAttr[key] = v;
        enqueue(v.trim(), function (out) {
          try { el.setAttribute(attr, out); } catch (e) {}
        });
      });
    });
  }

  function scanRoot(root) {
    if (!root) return;
    if (root.nodeType === 3) { handleTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    translateAttributes(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n, batch = [];
    while ((n = walker.nextNode())) {
      batch.push(n);
      if (batch.length >= 400) { batch.forEach(handleTextNode); batch = []; }
    }
    if (batch.length) batch.forEach(handleTextNode);
  }

  /* ================= 还原 / 切换语言 ================= */

  function restoreAll() {
    ON = false;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.__cliptOrig) { n.nodeValue = n.__cliptOrig; n.__cliptDone = false; }
    }
    document.querySelectorAll("[placeholder],[title],[alt],[aria-label]").forEach(function (el) {
      if (!el.__cliptAttr) return;
      for (var k in el.__cliptAttr) {
        try { el.setAttribute(k.replace("attr:", ""), el.__cliptAttr[k]); } catch (e) {}
      }
      el.__cliptAttr = null;
    });
    updatePanel();
  }

  function rescan(force) {
    if (!ON) ON = true;
    if (force) {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
      while ((n = w.nextNode())) { n.__cliptDone = false; }
    }
    scanRoot(document.body);
    updatePanel();
  }

  // 切换目标语言：先还原成英文，再用新语言重翻
  function setTarget(lang) {
    if (!DICT_ALL[lang]) return false;
    // 先把当前译文还原回原文
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.__cliptOrig) { n.nodeValue = n.__cliptOrig; n.__cliptDone = false; }
    }
    document.querySelectorAll("[placeholder],[title],[alt],[aria-label]").forEach(function (el) {
      if (!el.__cliptAttr) return;
      for (var k in el.__cliptAttr) {
        try { el.setAttribute(k.replace("attr:", ""), el.__cliptAttr[k]); } catch (e) {}
      }
      el.__cliptAttr = null;
    });

    TARGET = lang;
    try { window.__CLIP_TARGET__ = lang; } catch (e) {}
    rebuildDict();
    cache = loadCache();
    queue.length = 0;
    queued = Object.create(null);
    inflight = 0;
    translatedCount = 0;
    ON = true;
    scanRoot(document.body);
    updatePanel();
    return true;
  }

  /* ================= 浮动面板 ================= */

  var panel, btn, badge, labelEl, menu;
  var LANGS = ["zh-CN", "id", "pt", "th"];

  function buildPanel() {
    if (document.getElementById("cliptrs-panel")) {
      panel = document.getElementById("cliptrs-panel");
      btn = document.getElementById("cliptrs-btn");
      badge = document.getElementById("cliptrs-badge");
      labelEl = document.getElementById("cliptrs-label");
      menu = document.getElementById("cliptrs-menu");
      return;
    }

    var style = document.createElement("style");
    style.textContent = [
      "#cliptrs-panel{position:fixed;right:16px;bottom:18px;z-index:2147483600;font:12px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#fff;user-select:none;}",
      "#cliptrs-btn{display:flex;align-items:center;gap:6px;background:rgba(28,30,36,.92);border:1px solid rgba(255,255,255,.16);border-radius:18px;padding:7px 12px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);backdrop-filter:blur(6px);}",
      "#cliptrs-btn:hover{background:rgba(45,48,58,.96);}",
      "#cliptrs-badge{background:#2b7fff;border-radius:9px;padding:1px 6px;font-size:11px;min-width:14px;text-align:center;}",
      "#cliptrs-badge.off{background:#666;}",
      "#cliptrs-menu{position:absolute;right:0;bottom:44px;background:rgba(28,30,36,.97);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:6px;min-width:168px;box-shadow:0 6px 22px rgba(0,0,0,.45);display:none;}",
      "#cliptrs-menu button{display:block;width:100%;text-align:left;background:none;border:0;color:#eee;padding:7px 10px;border-radius:6px;cursor:pointer;font:inherit;}",
      "#cliptrs-menu button:hover{background:rgba(255,255,255,.1);}",
      "#cliptrs-menu button.cur{color:#4da3ff;font-weight:600;}",
      "#cliptrs-sep{height:1px;background:rgba(255,255,255,.14);margin:5px 2px;}"
    ].join("");
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "cliptrs-panel";

    menu = document.createElement("div");
    menu.id = "cliptrs-menu";

    // 语言列表
    LANGS.forEach(function (lang) {
      var m = META[lang] || {};
      var b = document.createElement("button");
      b.dataset.lang = lang;
      b.textContent = (m.label || lang) + (m.name ? "  ·  " + m.name : "");
      b.onclick = function () {
        setTarget(lang);
        menu.style.display = "none";
      };
      menu.appendChild(b);
    });

    var sep = document.createElement("div");
    sep.id = "cliptrs-sep";
    menu.appendChild(sep);

    var bOff = document.createElement("button");
    bOff.textContent = "原文 / Original";
    bOff.onclick = function () { restoreAll(); menu.style.display = "none"; };
    menu.appendChild(bOff);

    var bRe = document.createElement("button");
    bRe.textContent = "重新翻译本页 / Retranslate";
    bRe.onclick = function () { rescan(true); menu.style.display = "none"; };
    menu.appendChild(bRe);

    var bClr = document.createElement("button");
    bClr.textContent = "清空缓存 / Clear cache";
    bClr.onclick = function () {
      cache = {};
      try { localStorage.removeItem(cacheKey()); } catch (e) {}
      menu.style.display = "none";
    };
    menu.appendChild(bClr);

    btn = document.createElement("div");
    btn.id = "cliptrs-btn";
    badge = document.createElement("span");
    badge.id = "cliptrs-badge";
    badge.textContent = (META[TARGET] && META[TARGET].flag) || "译";
    labelEl = document.createElement("span");
    labelEl.id = "cliptrs-label";
    labelEl.textContent = "自动翻译";
    btn.appendChild(badge);
    btn.appendChild(labelEl);
    btn.onclick = function (ev) {
      ev.stopPropagation();
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    };

    panel.appendChild(menu);
    panel.appendChild(btn);
    document.body.appendChild(panel);
    document.addEventListener("click", function () { if (menu) menu.style.display = "none"; }, true);
  }

  function updatePanel() {
    if (!badge) return;
    if (!ON) {
      badge.textContent = "EN";
      badge.className = "off";
    } else {
      badge.textContent = String(translatedCount);
      badge.className = "";
    }
    if (labelEl) {
      var m = META[TARGET] || {};
      labelEl.textContent = ON ? ("自动翻译 · " + (m.label || TARGET)) : "原文模式";
    }
    if (menu) {
      menu.querySelectorAll("button[data-lang]").forEach(function (b) {
        if (b.dataset.lang === TARGET) b.classList.add("cur");
        else b.classList.remove("cur");
      });
    }
  }

  /* ================= 动态内容 ================= */

  var dirty = false;
  var mo = new MutationObserver(function (muts) {
    if (!ON) return;
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type !== "childList") continue;
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j];
        if (node.nodeType === 1) {
          if (node.id === "cliptrs-panel" || (node.closest && node.closest("#cliptrs-panel"))) continue;
          scanRoot(node);
          dirty = true;
        } else if (node.nodeType === 3) {
          handleTextNode(node);
          dirty = true;
        }
      }
    }
  });

  /* ================= 启动 ================= */

  function boot() {
    rebuildDict();
    cache = loadCache();
    buildPanel();
    scanRoot(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
    [600, 1500, 3000, 6000].forEach(function (ms) {
      setTimeout(function () { if (ON) scanRoot(document.body); }, ms);
    });
    updatePanel();
  }

  window.__CLIP_TRANSLATOR__ = {
    version: VERSION,
    get target() { return TARGET; },
    setTarget: setTarget,
    languages: LANGS,
    rescan: function (force) { dirty = false; rescan(force); },
    restore: restoreAll,
    needsRescan: function () { return dirty; },
    stats: function () {
      return {
        on: ON,
        target: TARGET,
        translated: translatedCount,
        cache: Object.keys(cache).length,
        queue: queue.length
      };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  return "injected:" + VERSION + ":" + TARGET;
})();
