"use strict";
// 翻译逻辑自测：exact / pattern / 幂等 / 边界
const path = require("path");
const { dict, patterns } = require(path.join(__dirname, "src", "zh_dict.js"));
function buildRegex(pattern) {
  let re = ""; let i = 0;
  while (i < pattern.length) {
    const m = /^\{(\d+)\}/.exec(pattern.slice(i));
    if (m) { re += "(.*?)"; i += m[0].length; continue; }
    const ch = pattern[i];
    re += /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
    i += 1;
  }
  return new RegExp("^\\s*" + re + "\\s*$", "s");
}
const PATS = patterns.map(p => ({ re: buildRegex(p[0]), to: p[1], n: (p[0].match(/\{(\d+)\}/g) || []).length }));
function tr(s) {
  if (typeof s !== "string" || !s || s.length > 200) return null;
  const t = s.trim();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(dict, t)) {
    const z = dict[t];
    if (z == null || z === t) return null;
    return s === t ? z : s.replace(t, z);
  }
  for (const p of PATS) {
    const m = p.re.exec(t);
    if (!m) continue;
    let out = p.to;
    for (let g = 1; g <= p.n; g++) out = out.split("{" + g + "}").join(m[g] != null ? m[g].trim() : "");
    return s === t ? out : s.replace(t, out);
  }
  return null;
}
const cases = [
  ["Conversations", "对话"],
  ["Settings", "设置"],
  ["Copy Path", "复制路径"],
  ["Custom…", "自定义…"],
  ["No agents running", "没有正在运行的智能体"],
  ["3 agents running", "3 个智能体正在运行"],
  ["No agents running", "没有正在运行的智能体"],
  ["Deleted \"my-project\".", "已删除“my-project”。"],
  ["Failed to save settings: boom", "保存设置失败：boom"],
  ["Open Anthropic", "打开 Anthropic"],
  ["   Search conversations...  ", "   搜索对话…  "],
  ["MCP Servers", "MCP 服务器"],
  ["1 agent running", "1 个智能体正在运行"],
];
let bad = 0;
for (const [src, want] of cases) {
  const got = tr(src);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "PASS" : "FAIL"), JSON.stringify(src), "->", JSON.stringify(got), ok ? "" : `want ${JSON.stringify(want)}`);
}
// 幂等：翻译结果再翻译应返回 null（不再变化）
let idem = 0;
for (const [en] of cases) {
  const zh = tr(en);
  if (zh != null && tr(zh) !== null) { idem++; console.log("IDEM-FAIL", en, "->", zh, "->", tr(zh)); }
}
// 字典规模
console.log("dict entries:", Object.keys(dict).length, "patterns:", patterns.length);
process.exit(bad + idem > 0 ? 1 : 0);
