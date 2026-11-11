"use strict";
/**
 * Antigravity 中文补丁 — 主进程侧
 * 1) 包装 Menu.buildFromTemplate / setApplicationMenu / Tray.setContextMenu：
 *    递归翻译菜单标签（同时记录 reverse 映射，供 menu.js 按英文标签查找子菜单）。
 * 2) 包装 dialog.show*，翻译标题/正文/按钮。
 * 3) app 'web-contents-created'：对本应用自己的窗口（https://127.0.0.1 / data: / about:）
 *    在 dom-ready 与 did-finish-load 注入页面翻译引擎（引擎自带幂等保护）。
 * 由 main.js 顶部一行 require('./zh_main_patch').install() 启用。
 */
const path = require("path");
const fs = require("fs");

const WINDOW_ORIGINS = ["https://127.0.0.1"];
let EXACT = {};
let PATTERNS = [];
let INJECT_SRC = null;
let installed = false;

// 翻译后标签 -> 原英文标签，供 menu.js 的 addItemToSubmenu 反查
const revLabel = new Map();

function trCap(s) {
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(EXACT, s)) {
    const z = EXACT[s];
    return z === s ? null : z;
  }
  return null;
}

function tr(s) {
  if (typeof s !== "string" || !s || s.length > 200) return null;
  const t = s.trim();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(EXACT, t)) {
    const z = EXACT[t];
    if (z == null || z === t) return null;
    revLabel.set(z, t);
    return s === t ? z : s.replace(t, z);
  }
  for (const p of PATTERNS) {
    const m = p.re.exec(t);
    if (!m) continue;
    let out = p.to;
    for (let g = 1; g <= p.n; g++) {
      const raw = m[g] != null ? m[g].trim() : "";
      out = out.split("{" + g + "}").join(trCap(raw) || raw);
    }
    revLabel.set(out, t);
    return s === t ? out : s.replace(t, out);
  }
  return null;
}

function buildRegex(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const m = /^\{(\d+)\}/.exec(pattern.slice(i));
    if (m) { re += "(.*?)"; i += m[0].length; continue; }
    const ch = pattern[i];
    re += /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
    i += 1;
  }
  return new RegExp("^\\s*" + re + "\\s*$", "s");
}

/** 翻译菜单模板（plain object 树） */
function translateTemplate(tpl) {
  if (Array.isArray(tpl)) { tpl.forEach(translateTemplate); return tpl; }
  if (tpl && typeof tpl === "object") {
    if (typeof tpl.label === "string") {
      const z = tr(tpl.label);
      if (z != null) tpl.label = z;
    }
    if (tpl.submenu) translateTemplate(tpl.submenu);
  }
  return tpl;
}

/** 原地翻译已构建的菜单树 */
function translateMenuTree(menu) {
  try {
    for (const item of menu.items) {
      if (item && typeof item.label === "string") {
        const z = tr(item.label);
        if (z != null) item.label = z;
      }
      if (item && item.submenu) translateMenuTree(item.submenu);
    }
  } catch (e) { /* 菜单结构异常时不影响原流程 */ }
  return menu;
}

/** 翻译 dialog options 里面向用户的字符串 */
function translateDialogOptions(opts) {
  if (!opts || typeof opts !== "object") return opts;
  for (const k of ["title", "message", "detail", "buttonLabel", "nameFieldLabel", "promptToCreate"]) {
    if (typeof opts[k] === "string") {
      const z = tr(opts[k]);
      if (z != null) opts[k] = z;
    }
  }
  if (Array.isArray(opts.buttons)) {
    opts.buttons = opts.buttons.map((b) => (typeof b === "string" ? tr(b) ?? b : b));
  }
  return opts;
}

function isAppUiUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    WINDOW_ORIGINS.some((o) => u.startsWith(o)) ||
    u.startsWith("about:") ||
    u.startsWith("data:") ||
    u.startsWith("file://") && u.includes("antigravity")
  );
}

function loadDict() {
  const dict = require(path.join(__dirname, "zh_dict.js"));
  EXACT = dict.dict || {};
  PATTERNS = (dict.patterns || []).map((p) => ({
    re: buildRegex(p[0]),
    to: p[1],
    n: (p[0].match(/\{(\d+)\}/g) || []).length,
  }));
}

function makeInjectSrc() {
  if (INJECT_SRC) return INJECT_SRC;
  const engine = fs.readFileSync(path.join(__dirname, "zh_browser_patch.js"), "utf8");
  INJECT_SRC = engine;
  return INJECT_SRC;
}

function install() {
  if (installed) return;
  installed = true;
  try { loadDict(); } catch (e) {
    console.error("[zh-patch] dict load failed:", e && e.message);
    return;
  }
  const electron = require("electron");

  // 1) 菜单：构建模板 + 设置应用菜单 双保险
  try {
    const origBuild = electron.Menu.buildFromTemplate.bind(electron.Menu);
    electron.Menu.buildFromTemplate = function (tpl) {
      try { translateTemplate(tpl); } catch (e) { /* 忽略 */ }
      return origBuild(tpl);
    };
  } catch (e) { console.error("[zh-patch] hook buildFromTemplate failed:", e && e.message); }
  try {
    const origSet = electron.Menu.setApplicationMenu.bind(electron.Menu);
    electron.Menu.setApplicationMenu = function (menu) {
      try { translateMenuTree(menu); } catch (e) { /* 忽略 */ }
      return origSet(menu);
    };
  } catch (e) { console.error("[zh-patch] hook setApplicationMenu failed:", e && e.message); }

  // 2) 托盘（动态更新 label 后再次 setContextMenu，也会经过这里）
  try {
    const TrayCls = electron.Tray;
    if (TrayCls && TrayCls.prototype) {
      const origSetTray = TrayCls.prototype.setContextMenu;
      if (typeof origSetTray === "function") {
        TrayCls.prototype.setContextMenu = function (menu) {
          try { if (menu && menu.items) translateMenuTree(menu); } catch (e) { /* 忽略 */ }
          return origSetTray.call(this, menu);
        };
      }
    }
  } catch (e) { console.error("[zh-patch] hook Tray failed:", e && e.message); }

  // 3) 系统对话框
  try {
    const dlg = electron.dialog;
    for (const name of ["showMessageBox", "showMessageBoxSync", "showSaveDialog", "showSaveDialogSync", "showOpenDialog", "showOpenDialogSync"]) {
      const orig = dlg[name];
      if (typeof orig !== "function") continue;
      dlg[name] = function (...args) {
        if (args.length > 0) args[0] = translateDialogOptions(args[0]);
        return orig.apply(dlg, args);
      };
    }
  } catch (e) { console.error("[zh-patch] hook dialog failed:", e && e.message); }

  // 4) 页面注入
  try {
    electron.app.on("web-contents-created", (_ev, wc) => {
      if (!wc || wc.getType() !== "window") return;
      const inject = async () => {
        try {
          if (wc.isDestroyed()) return;
          if (!isAppUiUrl(wc.getURL())) return;
          await wc.executeJavaScript(makeInjectSrc());
        } catch (e) { /* 页面尚未就绪等情况忽略 */ }
      };
      wc.on("dom-ready", inject);
      wc.on("did-finish-load", inject);
    });
  } catch (e) { console.error("[zh-patch] hook webContents failed:", e && e.message); }

  console.log("[zh-patch] installed");
}

module.exports = { install, revLabel };
