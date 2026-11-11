# Antigravity 中文补丁（antigravity-zh-patch）

给 Google Antigravity 桌面版（Windows）打中文界面补丁。不改 `language_server.exe`，只改 Electron 壳的 `resources/app.asar`，原版自动备份，可一键还原。

> **⚠️ 免责声明 / Disclaimer**
> 本项目为**非官方**社区工具，与 Google 无任何关联。它只包含我们原创的补丁脚本与翻译字典，**不包含、不分发** Antigravity 的任何原始或修改后的程序文件——脚本仅修改你自己机器上的本地安装。
> 修改客户端软件可能违反 Google 服务条款（理论上存在账号风险），请自行评估、风险自担。本补丁为纯本地界面翻译，不修改任何网络行为。使用前请阅读 [Antigravity 服务条款](https://antigravity.google/terms)。
>
> This is an **unofficial** community tool, not affiliated with Google. It distributes only our own patcher script and translation dictionary — no Google software, original or modified. Patching your local installation may violate Google's Terms of Service; use at your own risk.

## 原理

Antigravity 桌面端 = Electron 壳 + `language_server.exe`（内嵌 React Web UI，硬编码英文，无多语言机制）。本补丁：

1. **主进程**（`dist/zh_main_patch.js` + `dist/zh_dict.js`）：包装 `Menu.buildFromTemplate` / `Menu.setApplicationMenu` / `Tray.setContextMenu` / `dialog.show*`，翻译原生菜单、托盘、系统对话框。
2. **页面注入**（`dist/zh_browser_patch.js` = 字典 JSON + 引擎）：对本应用自己的窗口（`https://127.0.0.1:<port>`）在 `dom-ready`/`did-finish-load` 注入 MutationObserver 翻译引擎，翻译文本节点和 `title`/`placeholder`/`aria-label`/`data-tooltip` 等属性。
3. **`dist/main.js`** 注入一行 `require("./zh_main_patch").install()`；**`dist/menu.js`** 加中文标签反查（保证 File/Help 子菜单追加逻辑不受翻译影响）。

安全边界：只做**精确匹配 + 白名单通配模板**翻译，`pre/code/kbd`、内容可编辑区不碰，文件名、对话标题、AI 回复内容等用户内容不会被误翻。

## 用法

```bat
git clone <本仓库>
cd antigravity-zh-patch
node patch.js status            :: 查看补丁/备份状态
node patch.js apply --restart   :: 打补丁（自动关闭并重启 Antigravity）
node patch.js apply             :: 打补丁（需先手动关闭 Antigravity）
node patch.js restore           :: 还原英文原版并重启
```

依赖：Node.js ≥ 18（`@electron/asar` 经 npx 自动获取）。

- 原版备份在 Antigravity 安装目录的 `resources\app.asar.en.bak`，补丁每次都会校验备份纯净性，损坏/丢失时自动从当前 asar 逆向重建。
- 重复执行 `apply` 安全（幂等），也用于**更新字典后重打**。
- **App 自动更新会覆盖 app.asar** → 更新后重新跑一遍 `apply --restart` 即可。

## 加词条

编辑 `src/zh_dict.js`：

- `dict`：精确匹配，`"English text": "中文"`。
- `patterns`：通配模板，`["Open {1}", "打开 {1}"]`，`{1}{2}` 对应原文变量；**具体模式放通用模式前面**。

改完执行 `node patch.js apply --restart` 生效。临时关闭汉化（单机）：DevTools 里 `localStorage.setItem('agzh','off')` 后刷新。

## 测试

```bat
node test-dict.js   :: 字典翻译逻辑自测（精确/通配/幂等）
```

## 已知边界

- 未覆盖的英文：欢迎语、少数深层页面文案、AI 回复内容。按上面方式加词条即可。
- App 大版本更新若改了 `main.js` 锚点，`apply` 会报"锚点缺失"并中止——此时需要对照新版调整 `patch.js` 里的 `MAIN_ANCHOR`/`MENU_ANCHOR`。
- macOS 未适配（菜单结构不同），本补丁仅针对 Windows 安装版。
