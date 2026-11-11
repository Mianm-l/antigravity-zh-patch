/* Antigravity 中文补丁 — 页面注入引擎
 * 纯浏览器脚本（executeJavaScript 注入，无 require）。
 * 字典由注入器先行注入 window.__AG_ZH_DICT__ = { dict, patterns }。
 * 关闭汉化：在 DevTools 里执行 localStorage.setItem('agzh','off') 后刷新。
 */
(function () {
  if (window.__agZh) return;
  window.__agZh = true;
  try {
    if ((typeof localStorage !== 'undefined') && localStorage.getItem('agzh') === 'off') return;
  } catch (e) { /* localStorage 不可用则继续 */ }

  var cfg = window.__AG_ZH_DICT__ || {};
  var EXACT = cfg.dict || {};
  // 把 {1}{2} 转成捕获组，其余字符按字面量转义
  function buildRegex(pattern) {
    var re = '';
    var i = 0;
    while (i < pattern.length) {
      var m = /^\{(\d+)\}/.exec(pattern.slice(i));
      if (m) { re += '(.*?)'; i += m[0].length; continue; }
      var ch = pattern[i];
      re += /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
      i += 1;
    }
    return new RegExp('^\\s*' + re + '\\s*$', 's');
  }
  var PATS = (cfg.patterns || []).map(function (p) {
    var holders = (p[0].match(/\{(\d+)\}/g) || []).length;
    return { re: buildRegex(p[0]), to: p[1], n: holders };
  });

  // 捕获组内容的递归翻译（仅查精确表，避免无限递归）
  function trCap(s) {
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(EXACT, s)) {
      var z = EXACT[s];
      return z === s ? null : z;
    }
    return null;
  }

  function translate(s) {
    if (!s || s.length > 200) return null;
    var t = s.trim();
    if (!t) return null;
    var hit = Object.prototype.hasOwnProperty.call(EXACT, t) ? EXACT[t] : null;
    if (hit != null) {
      if (hit === t) return null;
      return s === t ? hit : s.replace(t, hit);
    }
    for (var k = 0; k < PATS.length; k++) {
      var p = PATS[k];
      var m = p.re.exec(t);
      if (!m) continue;
      var out = p.to;
      for (var g = 1; g <= p.n; g++) {
        var raw = m[g] != null ? m[g].trim() : '';
        out = out.split('{' + g + '}').join(trCap(raw) || raw);
      }
      return s === t ? out : s.replace(t, out);
    }
    return null;
  }

  var ATTRS = ['title', 'placeholder', 'aria-label', 'aria-placeholder', 'alt', 'data-tooltip'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, PRE: 1, CODE: 1, KBD: 1, SAMP: 1 };

  function inSkipSubtree(node) {
    var n = node;
    while (n) {
      if (n.nodeType === 1) {
        if (SKIP_TAGS[n.tagName]) return true;
        if (n.isContentEditable) return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  function doTextNode(tn) {
    var v = tn.nodeValue;
    if (!v) return;
    var z = translate(v);
    if (z != null) tn.nodeValue = z;
  }

  function doElement(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if (!v) continue;
      var z = translate(v);
      if (z != null) el.setAttribute(a, z);
    }
  }

  function walkSubtree(root) {
    if (!root) return;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = tw.nextNode())) {
      if (!inSkipSubtree(n)) doTextNode(n);
    }
    if (root.nodeType === 1) {
      if (!inSkipSubtree(root)) doElement(root);
      var all = root.querySelectorAll
        ? root.querySelectorAll('[' + ATTRS.join('],[') + ']')
        : [];
      for (var i = 0; i < all.length; i++) {
        if (!inSkipSubtree(all[i])) doElement(all[i]);
      }
    }
  }

  function fullPass() {
    walkSubtree(document.documentElement);
    var t = document.title;
    if (t) {
      var z = translate(t);
      if (z != null) document.title = z;
    }
  }

  var pending = false;
  var queue = [];
  function scheduleBatch() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var batch = queue.splice(0, queue.length);
      for (var i = 0; i < batch.length; i++) {
        var node = batch[i];
        if (node.nodeType === 3) { if (!inSkipSubtree(node)) doTextNode(node); }
        else if (node.nodeType === 1) walkSubtree(node);
      }
    });
  }

  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'characterData' && m.target) queue.push(m.target);
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]);
      }
      if (m.type === 'attributes' && m.target.nodeType === 1) doElement(m.target);
    }
    scheduleBatch();
  });

  function start() {
    fullPass();
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
