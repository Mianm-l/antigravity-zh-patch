#!/usr/bin/env node
"use strict";
/**
 * Antigravity 中文补丁 — 应用/回滚工具
 *
 * 用法：
 *   node patch.js apply            应用补丁（若应用正在运行需加 --restart）
 *   node patch.js apply --restart  自动关闭 Antigravity、打补丁、再启动
 *   node patch.js restore          还原原始 app.asar
 *   node patch.js status           查看补丁状态
 *
 * 原理：修改 Electron 壳的 resources/app.asar（备份为 app.asar.en.bak）：
 *   - dist/ 下新增 zh_main_patch.js / zh_dict.js / zh_browser_patch.js
 *   - dist/main.js 注入一行 require('./zh_main_patch').install()
 *   - dist/menu.js 的子菜单查找兼容中文标签（__agZhRev 反查）
 * App 自动更新会覆盖 app.asar，更新后重新执行 apply 即可。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const APP_DIR = path.join(os.homedir(), "AppData", "Local", "Programs", "antigravity");
const ASAR = path.join(APP_DIR, "resources", "app.asar");
const UNPACKED = path.join(APP_DIR, "resources", "app.asar.unpacked");
const BACKUP = ASAR + ".en.bak";
const SRC = path.join(__dirname, "src");
const BUILD = path.join(__dirname, "build");
const ASAR_NEW = ASAR + ".zh.new";
const UNPACKED_NEW = UNPACKED + ".zh.new";

const MAIN_ANCHOR = "const gotTheLock = electron_1.app.requestSingleInstanceLock();";
const MAIN_INJECT = '/* zh-patch: 中文补丁入口 */\ntry { require("./zh_main_patch").install(); } catch (e) { console.error("[zh-patch] install failed:", e); }\n\n';
const MENU_ANCHOR = "const submenuItem = appMenu.items.find((item) => item.label === submenuLabel);";
const MENU_PATCHED = "const submenuItem = appMenu.items.find((item) => item.label === submenuLabel || ((typeof globalThis !== 'undefined' && globalThis.__agZhRev && globalThis.__agZhRev.get(item.label)) === submenuLabel));";

function sh(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
}
// Node 18.20+ 起 spawnSync 直接执行 .cmd 会 EINVAL，统一走 cmd /c
function asarArgs(extra) {
  return ["/c", "npx", "-y", "@electron/asar", ...extra];
}
function asarList(file) {
  const r = sh("cmd.exe", asarArgs(["list", file]), { timeout: 300000 });
  if (r.status !== 0) throw new Error("asar list 失败: " + (r.stderr || r.stdout));
  return r.stdout || "";
}
function isRunning() {
  const r = sh("tasklist", ["/FI", "IMAGENAME eq Antigravity.exe", "/FO", "CSV", "/NH"]);
  return /antigravity\.exe/i.test(r.stdout || "");
}
function killApp() {
  sh("taskkill", ["/IM", "Antigravity.exe"], { timeout: 20000 });
  for (let i = 0; i < 15; i++) {
    if (!isRunning()) return true;
    spawnSync("cmd", ["/c", "timeout", "/t", "1", "/nobreak"], { encoding: "utf8", windowsHide: true });
  }
  // 优雅关闭失败（如托盘常驻）→ 强制结束
  console.log("[!] 优雅关闭超时，强制结束进程 ...");
  sh("taskkill", ["/F", "/IM", "Antigravity.exe"], { timeout: 20000 });
  for (let i = 0; i < 15; i++) {
    if (!isRunning()) return true;
    spawnSync("cmd", ["/c", "timeout", "/t", "1", "/nobreak"], { encoding: "utf8", windowsHide: true });
  }
  return !isRunning();
}
function launchApp() {
  const exe = path.join(APP_DIR, "Antigravity.exe");
  spawnSync(`start "" "${exe}"`, { shell: true, detached: true, stdio: "ignore", windowsHide: true });
}

function checkSyntax(file) {
  const r = sh(process.execPath, ["--check", file]);
  if (r.status !== 0) throw new Error(`语法检查失败: ${file}\n${r.stderr}`);
}

/** 从解包目录里反向剥离补丁，得到原始内容 */
function revertPatchesInBuild() {
  const dist = path.join(BUILD, "dist");
  for (const f of ["zh_main_patch.js", "zh_dict.js", "zh_browser_patch.js"]) {
    fs.rmSync(path.join(dist, f), { force: true });
  }
  const mainJs = path.join(dist, "main.js");
  let mainSrc = fs.readFileSync(mainJs, "utf8");
  if (mainSrc.includes("zh_main_patch")) {
    mainSrc = mainSrc.split(MAIN_INJECT).join("");
    if (mainSrc.includes("zh_main_patch")) throw new Error("main.js 反向剥离失败（存在非标准注入痕迹）");
    fs.writeFileSync(mainJs, mainSrc);
  }
  const menuJs = path.join(dist, "menu.js");
  let menuSrc = fs.readFileSync(menuJs, "utf8");
  if (menuSrc.includes("__agZhRev")) {
    menuSrc = menuSrc.split(MENU_PATCHED).join(MENU_ANCHOR);
    if (menuSrc.includes("__agZhRev")) throw new Error("menu.js 反向剥离失败");
    fs.writeFileSync(menuJs, menuSrc);
  }
}

function asarHasZh(file) {
  try { return asarList(file).includes("zh_main_patch.js"); } catch (e) { return false; }
}

/** 确保存在 pristine 备份：缺失或被污染时，从当前 asar 逆向重建 */
function ensurePristineBackup() {
  const asar = ["/c", "npx", "-y", "@electron/asar"];
  if (fs.existsSync(BACKUP) && !asarHasZh(BACKUP)) {
    console.log("[i] 原版备份完好");
    return false; // 未重建
  }
  if (!fs.existsSync(BACKUP)) console.log("[!] 备份缺失，从当前 app.asar 逆向重建原版备份 ...");
  else console.log("[!] 备份被污染（含补丁内容），从当前 app.asar 逆向重建 ...");
  fs.rmSync(BUILD, { recursive: true, force: true });
  let r = sh("cmd.exe", [...asar, "extract", ASAR, BUILD], { timeout: 300000 });
  if (r.status !== 0) throw new Error("解包失败: " + (r.stderr || r.stdout));
  revertPatchesInBuild();
  checkSyntax(path.join(BUILD, "dist", "main.js"));
  checkSyntax(path.join(BUILD, "dist", "menu.js"));
  const bakNew = BACKUP + ".rebuilding";
  r = sh("cmd.exe", [...asar, "pack", BUILD, bakNew, "--unpack", "node_modules/chrome-devtools-mcp/**"], { timeout: 300000 });
  if (r.status !== 0) throw new Error("重建备份打包失败: " + (r.stderr || r.stdout));
  fs.rmSync(BACKUP, { force: true });
  fs.renameSync(bakNew, BACKUP);
  console.log("[+] 已重建 pristine 原版备份 app.asar.en.bak");
  return true; // 已重建，BUILD 即原版内容可直接复用
}

function apply(opts) {
  if (!fs.existsSync(ASAR)) throw new Error(`找不到 ${ASAR}`);
  if (isRunning()) {
    if (!opts.restart) {
      console.error("Antigravity 正在运行，app.asar 被占用。请先关闭应用后重试，或使用: node patch.js apply --restart");
      process.exit(2);
    }
    console.log("[*] 正在关闭 Antigravity ...");
    if (!killApp()) throw new Error("无法关闭 Antigravity（请手动关闭后重试）");
    console.log("[*] 已关闭。");
  }

  // 1) 确保存在 pristine 原版备份（缺失/污染时从当前逆向重建，BUILD 即原版内容）
  const rebuilt = ensurePristineBackup();

  // 2) 解包：一律从当前 app.asar 出发（已打补丁也没关系，注入是幂等的）
  if (!rebuilt) {
    fs.rmSync(BUILD, { recursive: true, force: true });
    console.log("[*] 解包当前 app.asar ...");
    const r0 = sh("cmd.exe", asarArgs(["extract", ASAR, BUILD]), { timeout: 300000 });
    if (r0.status !== 0) throw new Error("解包失败: " + (r0.stderr || r0.stdout));
  }
  let r;

  // 3) 拷贝补丁文件
  const dist = path.join(BUILD, "dist");
  for (const f of ["zh_main_patch.js", "zh_dict.js"]) {
    fs.copyFileSync(path.join(SRC, f), path.join(dist, f));
  }
  // 生成浏览器补丁 = 字典 JSON + 引擎
  const dictSrc = fs.readFileSync(path.join(SRC, "zh_dict.js"), "utf8");
  const dict = (() => { const m = { exports: {} }; new Function("module", "exports", dictSrc)(m, m.exports); return m.exports; })();
  const engine = fs.readFileSync(path.join(SRC, "zh_browser_engine.js"), "utf8");
  const browserPatch =
    "/* Antigravity zh patch: dict + engine, generated by patch.js */\n" +
    "window.__AG_ZH_DICT__ = " + JSON.stringify({ dict: dict.dict, patterns: dict.patterns }) + ";\n" +
    engine;
  fs.writeFileSync(path.join(dist, "zh_browser_patch.js"), browserPatch);

  // 4) 改 main.js（幂等）
  const mainJs = path.join(dist, "main.js");
  let mainSrc = fs.readFileSync(mainJs, "utf8");
  if (!mainSrc.includes("zh_main_patch")) {
    if (!mainSrc.includes(MAIN_ANCHOR)) throw new Error("main.js 锚点缺失（应用版本变化？），中止。");
    mainSrc = mainSrc.replace(MAIN_ANCHOR, MAIN_INJECT + MAIN_ANCHOR);
    fs.writeFileSync(mainJs, mainSrc);
    console.log("[+] main.js 已注入 zh_main_patch 入口");
  } else {
    console.log("[i] main.js 已注入过，跳过");
  }

  // 5) 改 menu.js（幂等，失败仅告警）
  const menuJs = path.join(dist, "menu.js");
  let menuSrc = fs.readFileSync(menuJs, "utf8");
  if (!menuSrc.includes("__agZhRev")) {
    if (menuSrc.includes(MENU_ANCHOR)) {
      menuSrc = menuSrc.replace(MENU_ANCHOR, MENU_PATCHED);
      fs.writeFileSync(menuJs, menuSrc);
      console.log("[+] menu.js 已加入中文标签反查兼容");
    } else {
      console.log("[!] menu.js 锚点未找到，跳过（仅影响 File/Help 子菜单追加项）");
    }
  }

  // 6) 语法检查
  for (const f of ["main.js", "menu.js", "zh_main_patch.js", "zh_dict.js", "zh_browser_patch.js"]) {
    checkSyntax(path.join(dist, f));
  }
  console.log("[+] 语法检查通过");

  // 7) 重新打包
  console.log("[*] 重新打包 app.asar ...");
  fs.rmSync(ASAR_NEW, { force: true });
  fs.rmSync(UNPACKED_NEW, { recursive: true, force: true });
  r = sh("cmd.exe", asarArgs(["pack", BUILD, ASAR_NEW, "--unpack", "node_modules/chrome-devtools-mcp/**"]), { timeout: 300000 });
  if (r.status !== 0) throw new Error("打包失败: " + (r.stderr || r.stdout));

  // 8) 替换
  fs.rmSync(ASAR, { force: true });
  fs.renameSync(ASAR_NEW, ASAR);
  fs.rmSync(UNPACKED, { recursive: true, force: true });
  if (fs.existsSync(UNPACKED_NEW)) fs.renameSync(UNPACKED_NEW, UNPACKED);
  console.log("[+] app.asar 已替换为中文补丁版");

  // 9) 校验内容
  if (!asarList(ASAR).includes("zh_main_patch.js")) throw new Error("打包校验失败：新 asar 中未见补丁文件");
  console.log("[+] 打包校验通过");

  // 10) 重启
  if (opts.restart) {
    console.log("[*] 启动 Antigravity ...");
    launchApp();
  } else {
    console.log("[i] 请手动启动 Antigravity 使补丁生效");
  }
  console.log("\n完成 ✔  如界面仍有英文，可往 src/zh_dict.js 加词条后重新 apply。");
}

function restore() {
  if (!fs.existsSync(BACKUP)) throw new Error("没有找到备份 " + BACKUP + "，无法还原");
  if (asarHasZh(BACKUP)) throw new Error("备份内容异常（含补丁文件），拒绝还原。请先执行 node patch.js apply 重建备份。");
  if (isRunning()) {
    console.log("[*] 正在关闭 Antigravity ...");
    if (!killApp()) throw new Error("无法关闭 Antigravity，请手动关闭后重试");
  }
  fs.copyFileSync(BACKUP, ASAR + ".restoring");
  fs.rmSync(ASAR, { force: true });
  fs.renameSync(ASAR + ".restoring", ASAR);
  console.log("[+] 已还原原始 app.asar");
  launchApp();
  console.log("[i] Antigravity 已启动（原版英文界面）");
}

function status() {
  console.log("app.asar      :", ASAR, fs.existsSync(ASAR) ? `(${Math.round(fs.statSync(ASAR).size / 1048576)} MB)` : "(不存在)");
  if (fs.existsSync(BACKUP)) {
    const polluted = asarHasZh(BACKUP);
    console.log("原版备份      :", BACKUP, `(${Math.round(fs.statSync(BACKUP).size / 1048576)} MB)`, polluted ? "【被污染！apply 可自动重建】" : "【pristine】");
  } else {
    console.log("原版备份      : (无)");
  }
  console.log("Antigravity   :", isRunning() ? "运行中" : "未运行");
  if (!fs.existsSync(ASAR)) return;
  console.log("补丁状态      :", asarHasZh(ASAR) ? "已安装中文补丁" : "未安装（原版）");
}

const cmd = process.argv[2];
const opts = { restart: process.argv.includes("--restart") };
try {
  if (cmd === "apply") apply(opts);
  else if (cmd === "restore") restore();
  else if (cmd === "status") status();
  else {
    console.log("用法: node patch.js apply [--restart] | restore | status");
    process.exit(1);
  }
} catch (e) {
  console.error("[x] " + (e && e.message || e));
  process.exit(1);
}
