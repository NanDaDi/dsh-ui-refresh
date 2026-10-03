# dsh-ui-refresh

往标题栏「应用 / 编辑」**后面补一颗自己的「刷新」菜单**，点一下就是重新加载当前窗口 —— 用来补上官方桌面外壳缺的那个刷新入口。

```
 ┌──────────────────────────────────────────────────────────────┐
 │ 应用   编辑   刷新 ▾                                          │
 └──────────────────────────────────────────────────────────────┘
                  ┌──────────────────┐
                  │ ⟳ 刷新界面        │
                  │ ⌫ 清空缓存并刷新  │
                  └──────────────────┘
```

万一那颗按钮没地方落（标题栏结构变了、或不是桌面外壳），3 秒后它会**自己退回右下角一颗半透明小胶囊**：可以拖到任何位置，位置记在本机。两条路是同一份代码，能挂标题栏就用标题栏。

## 为什么需要它

官方桌面端（`DeepSeek Harness.exe`）只绑了一个快捷键：**F12**（开 DevTools）。F5、Ctrl+R 都没有绑定，菜单也被 `window.setMenu(null)` 摘掉了 —— 所以"界面上出了新东西"这件事在应用里没有可点的地方。

而这件事又确实经常发生：

| 场景 | 刷新页面够不够 |
| --- | --- |
| 插件刚被**热挂载成功**（市场里启用插件、切主题） | **够** —— 条目集变化会实时进图 |
| 插件只改了**客户端 UI 文件**、且宿主已经提供新 rev | **够**（见下面的"边界"） |
| 插件**本体的代码更新**（宿主半边或客户端产物） | **不够**，必须完全退出应用重开 |
| 新增/卸载插件、改 bundles 顺序后要求重启 | **不够**，条目表由宿主启动时决定 |

原因在 `@deepseek-ai/dsh-client-modules`：客户端产物按 `?rev=<mtime/size>` 标记成 `public, max-age=31536000, immutable`（`lib/index.js:159`），脚本正文首次 GET 之后就被缓存住；只有**条目集**变化才会实时反映到模块图上。所以"重新加载一次页面"能覆盖的就是这些 —— 但应用里没有按钮。

## 用法

**标题栏路线（默认）**

- 标题栏上的「刷新」按钮出现在「应用」「编辑」右边，样式跟着原生按钮走（同样的高度、圆角、悬停底色）。
- 点它 → 下拉两项：
  - **刷新界面** = 重新加载当前窗口（等于普通浏览器里按 F5）。
  - **清空缓存并刷新** = 先删掉 Cache Storage 里所有缓存、注销 Service Worker，再重新加载。界面看着像旧的时候用它。
- 收起方式：点面板外面、点「应用」或「编辑」、按 `Escape` 或 `Tab`。上下方向键在两项之间走焦点，回车执行。
- 面板跟着按钮走：贴着按钮左下角弹出，出屏幕就自动右移或翻到按钮上方。

**兜底路线（找不到标题栏时自动启用）**

- 右下角一颗小胶囊，**点一下** = 重新加载当前窗口。
- **按住拖动** = 挪开；挪过之后位置记在 `localStorage`（`dsh-ui-refresh:position`），下次启动还在原处；没挪过就一直贴右下角。
- 平时半透明，鼠标移上去变清晰。拖到视口外面会被夹回边缘，不会丢。
- 一旦标题栏那颗按钮能挂上，胶囊会自己收掉。

## 安装

在应用内「插件市场」输入：

```
github:NanDaDi/dsh-ui-refresh
```

装完按市场提示重启一次（或等它热挂载）即可。之后它每次都随商店一起自动挂载，不用管。

## 卸载 / 关掉

在市场里禁用或卸载这个插件，然后重启应用；或者禁用后直接点它自己刷新一次（禁用会让条目集变化，刷新就生效）。它不写任何文件、不改任何配置，禁用即完全还原。

## 实现与边界

- **纯客户端 + 纯 DOM**：宿主半边（`lib/index.js`）是空的，什么都不做。浏览器半边往外壳 preload 挂的 `[data-windows-menu]`（一个 open shadow root）里的 `[role="menubar"]` 追加一颗 `button`，下拉面板是自己画的固定定位 div。不注册 slot 座位、不引 React、不碰宿主模块、不写文件。
- **声明一条纯 insert 的组合补丁**（`cordis.patch.yml`，三行）：只把本插件插进组合树，不动任何别人的条目。内核与市场的**安装入口**都要求包声明 `dsh.bundle` —— 只声明 `dsh.client` 的包会被直接拒掉（`not-bundle`，界面文案是「这个包没有声明组合包，不能作为插件管理」），所以这一行不是装饰。
- **样式分两处注入**：按钮的样式必须注入**它所在的那个 shadow root**（在外面写的选择器穿不进去），面板和胶囊的样式注入 `document.head`。都只用 DSH 自己的令牌（`--dsw-alias-*`，逐级回退），所以亮色/暗色都协调。
- **不动官方文件**：左上角的「应用」「编辑」是 Electron 原生菜单（每次开窗按模板重建），插件没有接口往里加项 —— 所以这里是在它**旁边**加一颗自己的按钮，官方菜单一个字没改；`app.asar` 也没动过。
- **`-webkit-app-region: no-drag`**：按钮和面板都带这条，落在外壳可拖拽区域上时点它不会变成拖窗口。
- **不抛异常是第一原则**：客户端条目一旦抛异常或停在 pending，加载器会拦掉整个 GUI（`web boot: N entry did not activate`）。所以 `inject` 为空、`apply` 全程 try/catch、`document.body` 还没出来时等 `DOMContentLoaded`；找不到 shadow root、没有 `localStorage`、没有 `caches`、没有 `navigator.serviceWorker`、`getBoundingClientRect` 抛异常……每种情况都有对应处理，最差就是退回胶囊或什么都不显示。
- **重复 `apply` 安全**：`start()` 幂等，`MutationObserver` 只挂一次；`dispose` 时按钮、面板、胶囊、两张样式表、所有 window/ document 监听和观察器全部撤掉。
- **暂无全局快捷键**：`Ctrl+R` / `Ctrl+Alt+按键` 这类组合属于 DSH 自己的可改键空间，可能和已有绑定撞车，所以只做按钮。
- 它**不是**重启助手：真要重启还是得完全退出应用（含托盘）再打开。

## 开发 / 自检

```bash
node test/selftest.mjs
```

自检用 `node:vm` 跑浏览器半边，配一套最小 DOM 替身（含 open shadow root、事件冒泡到 `document`、假定时器、`caches` / `serviceWorker` 替身），覆盖 **147 条断言**：标题栏挂载与样式、下拉开合与每一项的行为、Escape / 点外 / 点内 / 方向键 / `Tab`、兜底胶囊的 3 秒接管与迟到菜单条回收、拖动与位置持久化、dispose 收干净、各种"输入不合法也不许抛异常"的场景，以及包声明本身（`cordis.patch.yml` 真的在、是纯 insert、`files` 带上它、`exports ./client` 指向浏览器半边 —— 这条是安装被 `not-bundle` 拒掉那次留下的回归防线）。

`npm test` 与上面的命令等价；`npm run check` 会先做 `node --check` 再跑自检。

### 真浏览器对照测试

`test/manual.html` 会在页面里 1:1 复刻外壳的 `installWindowsMenu()`（`<div data-windows-menu>` + open shadow root + `[role=menubar]` +「应用」「编辑」两颗按钮，连 CSS 一起抄），然后加载 `../lib/client.js`，跑 **64 条断言**：真 shadow root 里的挂载与**样式级联**（跟官方那两颗按钮逐项比 height / font-size / color / background / border-radius / padding / cursor / line-height / `-webkit-app-region`）、真 `PointerEvent` 的 `composedPath` 行为（点自己的按钮能开能关、点「应用」时自己的面板收起而原生菜单照弹）、`Escape` / 方向键 / `Tab`、窗口 resize 后面板跟着按钮走、dispose 收干净、以及 3 秒找不到标题栏时退回胶囊。

用任意 Chromium 打开这个文件即可，结果在页面顶部；命令行版（无头）：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --allow-file-access-from-files --virtual-time-budget=9000 `
  --dump-dom "file:///<仓库路径>/test/manual.html"
```

结果既会渲染进 `#report`，也会挂在 `window.__RESULT__` 上。

## License

MIT
