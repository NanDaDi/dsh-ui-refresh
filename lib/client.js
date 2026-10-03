/**
 * dsh-ui-refresh — client half (browser).
 *
 * 在桌面外壳的标题栏菜单条（「应用」「编辑」旁边）加一颗「刷新」。点开是一个小菜单：
 *   · 刷新界面        —— `location.reload()`；
 *   · 清空缓存并刷新  —— 清掉 Cache Storage / Service Worker 后重载。
 *
 * ── 那个菜单条是什么 ──────────────────────────────────────────────────────
 * 它不是页面 UI：外壳 preload 的 `installWindowsMenu()` 往 body 挂了一个
 * `<div data-windows-menu>`，带 **open** shadow root，里面是 `[role=menubar]` +
 * 两颗按钮（「应用」「编辑」），点击走 `ipcRenderer.invoke("dsh-desktop:windows-menu", …)`
 * 让主进程弹**原生** `Menu`。原生菜单的 item 列表写死在主进程里，插件塞不进去。
 *
 * 但 shadow root 是 open 的，所以本插件把按钮与样式**注入那个 shadow root** ——
 * 只在自己这边追加一颗，不动「应用」「编辑」，也不碰原生弹菜单的 IPC。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 官方桌面外壳只绑了 F12（`app.asar` 里 `before-input-event` 唯一分支），F5 / Ctrl+R
 * 一律没有绑定；菜单条里也没有「刷新」（那两项被 `development = !app.isPackaged` 关掉了）。
 * 而 DSH 的客户端模块系统把产物按 `?rev=<mtime/size>` 标成
 * `public, max-age=31536000, immutable`（`@deepseek-ai/dsh-client-modules/lib/index.js:159`），
 * 只有**条目集**变化（插件热挂载成功、启用/禁用、主题切换）会实时进图 —— 这些场景
 * 重新加载页面就到，但应用里没有可点的地方。
 *
 * ── 边界（说清楚，免得被当成万能药）────────────────────────────────────────
 *   · 插件只改了客户端 UI、且已热挂载 / 刚被启用 → 刷新就到；
 *   · 插件**本体的代码更新**（宿主半边或客户端产物）→ 刷新拿到的还是旧快照
 *     （rev 由 mtime 推导，URL 没变，HTTP 不变缓存从 JS 也清不掉），必须完全退出应用重开。
 *
 * ── 做法 ──────────────────────────────────────────────────────────────────
 * 纯 DOM：往标题栏菜单条追加一颗按钮，自己的下拉是普通 DOM（不注册 slot、不引 React、
 * 不碰宿主、不写任何文件）。标题栏 3 秒内找不到，就退回右下角的可拖动小胶囊，
 * 保证这个插件在任何形态下都有用。
 *
 * 两个必须遵守的硬约束（客户端条目一旦抛异常、或停在 pending，加载器会拦掉整个 GUI：
 * `web boot: N entry did not activate`）：
 *   · `exports.inject = []`；
 *   · `exports.apply()` 全程 try/catch，永不抛出。
 *
 * 本文件必须是浏览器 ModuleLoader 格式（不是 ESM）：它由客户端加载器直接 eval，
 * `require` 由宿主注入（本插件不需要任何模块）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-refresh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 外壳 preload 挂标题栏菜单条的宿主（open shadow root）。 */
    const HOST_SEL = '[data-windows-menu]'
    /** 宿主 shadow root 里那条菜单栏（「应用」「编辑」在里面）。 */
    const MENUBAR_SEL = '[role="menubar"]'

    /** 我们追加的那颗「刷新」按钮。 */
    const BTN_ATTR = 'data-dsh-ui-refresh-menu'
    const BTN_TEXT_ATTR = 'data-dsh-ui-refresh-menu-text'
    /** 我们自己的下拉面板。 */
    const PANEL_ATTR = 'data-dsh-ui-refresh-panel'
    const ITEM_ATTR = 'data-dsh-ui-refresh-item'
    const SHADOW_STYLE_ID = 'dsh-ui-refresh-shadow-style'
    const STYLE_ID = 'dsh-ui-refresh-style'
    /** 兜底胶囊（标题栏菜单条找不到时用）。 */
    const PILL_ATTR = 'data-dsh-ui-refresh'
    const PILL_TEXT_ATTR = 'data-dsh-ui-refresh-label'
    const POS_KEY = 'dsh-ui-refresh:position'

    /** 等这么久还没找到标题栏菜单条，就退回右下角胶囊。 */
    const FALLBACK_MS = 3000
    /** 超过这么多像素才算拖动，否则算点击（免得手抖把刷新点丢了）。 */
    const DRAG_SLOP = 4
    /** 胶囊默认停靠边距（右下角）。 */
    const MARGIN = 14
    /** 贴边最少留多少。 */
    const EDGE = 2
    /** 下拉面板离按钮的间距。 */
    const GAP = 4
    const Z = 2147483000

    const BUTTON_HINT = '刷新界面（重新加载这个窗口；插件本体的代码更新仍需完全退出应用重开）'
    const HARD_HINT =
      '清空 Cache Storage 与 Service Worker 后重新加载；HTTP 不变缓存里的模块产物清不掉，插件本体的代码更新仍需完全退出应用重开'

    /**
     * 「重启应用」：POST 宿主半边的重启路由。
     * 路径必须与 `lib/restart-plan.js` 的 `API_PATH` 一致 —— 客户端半边是独立打包的
     * bundle，不能 import 宿主的模块，所以只能各写一份；自检里有一条断言盯着两者相等。
     */
    const RESTART_API = '/dsh-ui-refresh/api/v1/restart'
    const RESTART_TEXT = '重启应用'
    const RESTART_CONFIRM_TEXT = '再次点击确认重启'
    const RESTART_STARTING_TEXT = '正在重启…'
    const RESTART_HINT =
      '关闭并重新启动 DeepSeek Harness —— 装 / 更新 / 卸载插件之后必须来一次；点两下才执行，窗口会自己关掉再打开（若弹出「确认退出」，点退出即可），万一起不来，双击桌面图标即可恢复'
    /**
     * 两种重启方式（与 `lib/restart-plan.js` 的 `RESTART_MODES` 一致）：
     *   · `graceful` —— 让外壳自己走正常退出流程：宿主只准备助手不自杀，我们请外壳
     *     关掉这个窗口，外壳随后 `app.quit()`。这样不会弹「应用无法启动或已意外停止」。
     *   · `force` —— 老办法（宿主 `process.exit(0)`），只在关窗没生效时兜底，会弹恢复框。
     */
    const RESTART_MODE_GRACEFUL = 'graceful'
    const RESTART_MODE_FORCE = 'force'
    /** 交给外壳关窗后，等这么久还没掉线就再关一次。 */
    const CLOSE_RETRY_MS = 1200
    /** 再等这么久页面还在，就退回"让宿主自己退"的兜底方式。 */
    const CLOSE_FORCE_MS = 2600
    const RESTART_BLOCKED_TEXT = '没能让窗口自动关闭；请手动退出应用后重开'
    /** 二次确认的窗口，以及提示文字停留多久。 */
    const RESTART_CONFIRM_MS = 3000
    const RESTART_NOTICE_MS = 4000

    /** 注入进外壳菜单条 shadow root 的样式：把按钮做成与「应用」「编辑」同款。 */
    const SHADOW_CSS = `
button[${BTN_ATTR}] {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 14px;
  white-space: nowrap;
  cursor: default;
  -webkit-app-region: no-drag;
  -webkit-user-select: none;
  user-select: none;
}
button[${BTN_ATTR}]:hover,
button[${BTN_ATTR}][aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
}
/* 与外壳那条 button:focus-visible 保持一致（键盘用户看得见，鼠标用户不画框）。 */
button[${BTN_ATTR}]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, rgba(120, 170, 255, 0.9));
  outline-offset: -2px;
}
:host-context(html[data-input-modality='pointer']) button[${BTN_ATTR}]:focus-visible {
  outline-color: transparent;
}
`

    /** 下拉面板的样式（挂在 document 上，因为面板是 body 级元素）。 */
    const PAGE_CSS = `
[${PANEL_ATTR}] {
  position: fixed;
  z-index: ${Z};
  box-sizing: border-box;
  min-width: 176px;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-1, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(28, 32, 40, 0.96));
  color: var(--dsw-alias-text-1, var(--dsw-alias-label-1, inherit));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
  font: inherit;
  font-size: 12px;
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  -webkit-app-region: no-drag;
  -webkit-user-select: none;
  user-select: none;
}
[${PANEL_ATTR}] [${ITEM_ATTR}] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  text-align: left;
  white-space: nowrap;
  cursor: default;
}
[${PANEL_ATTR}] [${ITEM_ATTR}]:hover,
[${PANEL_ATTR}] [${ITEM_ATTR}]:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
  outline: none;
}

/* 兜底胶囊：标题栏菜单条找不到时用（例如纯 web 端）。 */
[${PILL_ATTR}] {
  position: fixed;
  z-index: ${Z};
  right: ${MARGIN}px;
  bottom: ${MARGIN}px;
  opacity: 0.55;
  transition: opacity 0.16s ease;
  -webkit-app-region: no-drag;
}
[${PILL_ATTR}]:hover,
[${PILL_ATTR}]:focus-within { opacity: 1; }
[${PILL_ATTR}] > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-1, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(28, 32, 40, 0.88));
  color: var(--dsw-alias-text-1, var(--dsw-alias-label-1, inherit));
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
}
[${PILL_ATTR}] > button:hover { background: var(--dsw-alias-bg-layer-3, rgba(38, 44, 54, 0.94)); }
`

    /** 菜单项定义：顺序即显示顺序。 */
    const ITEMS = [
      { id: 'reload', text: '刷新界面', hint: BUTTON_HINT, run: refreshPage },
      { id: 'hard', text: '清空缓存并刷新', hint: HARD_HINT, run: refreshHard },
      {
        id: 'restart',
        text: RESTART_TEXT,
        hint: RESTART_HINT,
        run: restartApp,
        // 点第一下只进"确认"状态，点第二下才真发请求；发请求时面板留着，好显示进度。
        confirm: RESTART_CONFIRM_TEXT,
        keepOpen: true,
      },
    ]

    // ── 状态 ────────────────────────────────────────────────────────────────
    /** 找到的菜单条宿主 / 菜单栏 / 它自己的 shadow root。 */
    let menuHost = null
    let menubar = null
    let watchedRoot = null
    let menuButton = null
    /** 注入进 shadow root / document 的样式表。 */
    let shadowStyle = null
    let pageStyle = null
    /** 下拉面板与它的菜单项。 */
    let panel = null
    let panelItems = []
    let focusIndex = 0
    /** 兜底胶囊。 */
    let pill = null
    let pillButton = null
    /** 两个观察器 + 兜底定时器。 */
    let observer = null
    let shadowObserver = null
    let fallbackTimer = null
    /** window 上的拖动监听是否已挂。 */
    let attached = false
    /** document 上的 MutationObserver 是否已挂（重复 apply 不要漏挂第二个）。 */
    let started = false
    /** 拖出来的位置 { x, y }；null = 还没拖过 / 读不到，用默认右下角。 */
    let pos = null
    /** 正在进行的拖动。 */
    let drag = null
    /** 刚拖完那一次 click 要吞掉（浏览器拖完仍会补一个 click）。 */
    let suppressClick = false
    /** 「重启应用」的二次确认状态 `{ id, item, text, confirm, timer }`；null = 没在等确认。 */
    let armed = null
    /** 「重启应用」那项文字被临时换成提示时的复原定时器。 */
    let noticeTimer = null
    /**
     * 客户端快捷键服务（`ctx.shortcuts`）。外壳里那句官方「关闭窗口」走的就是它，
     * 拿不到（web 端 / 服务没起来）时退回标准 `window.close()`。
     */
    let shortcuts = null
    /** 关窗兜底的两条定时器：先补关一次窗，再退回让宿主自己退。 */
    let closeTimer = null
    let forceTimer = null

    function viewport() {
      let w = 0
      let h = 0
      try {
        w = window.innerWidth || 0
        h = window.innerHeight || 0
      } catch {}
      if (!w || !isFinite(w) || w < 1) w = 1024
      if (!h || !isFinite(h) || h < 1) h = 768
      return { w, h }
    }

    function rectOf(el) {
      try {
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
        if (rect && isFinite(rect.left) && isFinite(rect.top)) return rect
      } catch {}
      return null
    }

    /** 事件经过的节点（含 shadow 内部）。拿不到 composedPath 就沿 parentNode 走。 */
    function pathOf(event) {
      try {
        if (event && typeof event.composedPath === 'function') {
          const path = event.composedPath()
          if (path && path.length) return path
        }
      } catch {}
      const out = []
      try {
        let node = event && event.target ? event.target : null
        while (node && out.length < 64) {
          out.push(node)
          node = node.parentNode
        }
      } catch {}
      return out
    }

    /** 这条路径里有没有 root（或它的后代）。 */
    function inPath(root, path) {
      if (!root) return false
      for (let i = 0; i < path.length; i++) {
        const node = path[i]
        if (node === root) return true
        try {
          if (node && typeof root.contains === 'function' && root.contains(node)) return true
        } catch {}
      }
      return false
    }

    function halt(event) {
      try {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      } catch {}
    }

    function reload() {
      try {
        window.location.reload()
      } catch {}
    }

    function refreshPage() {
      reload()
    }

    /** 清掉能清的缓存，然后重载。清不掉的（HTTP 不变缓存）在 tooltip 里说清楚。 */
    function refreshHard() {
      let chain = null
      try {
        const cachesRef = window.caches
        if (cachesRef && typeof cachesRef.keys === 'function' && typeof cachesRef.delete === 'function') {
          chain = cachesRef.keys().then((keys) => Promise.all((keys || []).map((key) => cachesRef.delete(key))))
        }
      } catch {}
      try {
        const sw = window.navigator && window.navigator.serviceWorker
        if (sw && typeof sw.getRegistrations === 'function') {
          const next = sw
            .getRegistrations()
            .then((regs) => Promise.all((regs || []).map((reg) => (reg && typeof reg.unregister === 'function' ? reg.unregister() : null))))
          chain = chain && typeof chain.then === 'function' ? chain.then(() => next) : next
        }
      } catch {}
      if (chain && typeof chain.then === 'function') chain.then(reload, reload)
      else reload()
      return chain
    }

    // ── 标题栏菜单条 ────────────────────────────────────────────────────────
    function findHost() {
      try {
        return document.querySelector ? document.querySelector(HOST_SEL) : null
      } catch {
        return null
      }
    }

    function findMenubar(host) {
      try {
        const root = host && host.shadowRoot ? host.shadowRoot : null
        return root && typeof root.querySelector === 'function' ? root.querySelector(MENUBAR_SEL) : null
      } catch {
        return null
      }
    }

    function ensureShadowStyle(root) {
      try {
        if (!root || typeof root.appendChild !== 'function') return
        if (shadowStyle && shadowStyle.parentNode === root) return
        const el = document.createElement('style')
        el.setAttribute('id', SHADOW_STYLE_ID)
        el.textContent = SHADOW_CSS
        root.appendChild(el)
        shadowStyle = el
      } catch {}
    }

    function ensurePageStyle() {
      try {
        if (pageStyle && pageStyle.parentNode) return
        if (!document.head || typeof document.head.appendChild !== 'function') return
        const el = document.createElement('style')
        el.setAttribute('id', STYLE_ID)
        el.textContent = PAGE_CSS
        document.head.appendChild(el)
        pageStyle = el
      } catch {}
    }

    function mountButton(bar, root) {
      try {
        if (!bar || typeof bar.appendChild !== 'function') return
        ensureShadowStyle(root)
        const btn = document.createElement('button')
        btn.setAttribute('type', 'button')
        btn.setAttribute(BTN_ATTR, '')
        btn.setAttribute('title', BUTTON_HINT)
        btn.setAttribute('aria-label', '刷新')
        btn.setAttribute('aria-haspopup', 'menu')
        btn.setAttribute('aria-expanded', 'false')
        const text = document.createElement('span')
        text.setAttribute(BTN_TEXT_ATTR, '')
        text.textContent = '刷新'
        btn.appendChild(text)
        btn.addEventListener('click', onButtonClick)
        bar.appendChild(btn)
        if (typeof bar.addEventListener === 'function') bar.addEventListener('click', onBarClick)
        menuButton = btn
        menubar = bar
      } catch {
        menuButton = null
        menubar = null
      }
    }

    function unmountButton() {
      closePanel()
      try {
        if (menuButton && menuButton.parentNode) menuButton.parentNode.removeChild(menuButton)
      } catch {}
      try {
        if (menubar && typeof menubar.removeEventListener === 'function') menubar.removeEventListener('click', onBarClick)
      } catch {}
      menuButton = null
      menubar = null
    }

    /** 点标题栏里别的按钮（「应用」「编辑」）时，把自己的下拉收起来。 */
    function onBarClick(event) {
      try {
        if (!panel) return
        if (inPath(menuButton, pathOf(event))) return
        closePanel()
      } catch {}
    }

    function onButtonClick(event) {
      halt(event)
      if (panel) closePanel()
      else openPanel()
    }

    function watchShadow(host) {
      try {
        const root = host && host.shadowRoot ? host.shadowRoot : null
        if (!root || root === watchedRoot) return
        try {
          if (shadowObserver) shadowObserver.disconnect()
        } catch {}
        shadowObserver = null
        watchedRoot = root
        if (typeof MutationObserver === 'function' && typeof root === 'object') {
          shadowObserver = new MutationObserver(onMutate)
          shadowObserver.observe(root, { childList: true })
        }
      } catch {}
    }

    /**
     * 对账：有菜单条就挂按钮（并把兜底胶囊收掉），没有就先约一个兜底。
     * 幂等 —— 观察器、resize、DOMContentLoaded 都会反复喊它。
     */
    function sync() {
      try {
        const host = findHost()
        if (host) {
          watchShadow(host)
          menuHost = host
          const bar = findMenubar(host)
          if (bar) {
            cancelFallback()
            unmountPill()
            if (!menuButton || menuButton.parentNode !== bar) mountButton(bar, host.shadowRoot)
            return
          }
        }
        if (menuButton) unmountButton()
        menuHost = host || null
        scheduleFallback()
      } catch {}
    }

    /** 观察器回调：已经一切就绪时立刻返回，免得界面一动就全量对账。 */
    function onMutate() {
      try {
        if (menuButton && menubar && menuButton.parentNode === menubar && menuHost && rootContains(menuHost)) return
      } catch {}
      sync()
    }

    function rootContains(node) {
      try {
        if (document.contains) return !!document.contains(node)
      } catch {}
      return true
    }

    // ── 下拉面板 ────────────────────────────────────────────────────────────
    /** 面板里某个 id 的菜单项。 */
    function itemOf(id) {
      try {
        if (panel && typeof panel.querySelector === 'function') return panel.querySelector(`[${ITEM_ATTR}="${id}"]`)
      } catch {}
      return null
    }

    /** 取消「再次点击确认」状态，并把这一项的文字复原。 */
    function disarm() {
      if (!armed) return
      const current = armed
      armed = null
      try {
        if (current.timer) clearTimeout(current.timer)
      } catch {}
      try {
        if (current.item && current.item.textContent === current.confirm) current.item.textContent = current.text
      } catch {}
    }

    /** 第一次点「重启应用」：把这一项变成「再次点击确认重启」，3 秒内不点就自己复原。 */
    function armConfirm(spec) {
      disarm()
      const state = { id: spec.id, item: itemOf(spec.id), text: spec.text, confirm: spec.confirm, timer: null }
      armed = state
      try {
        if (state.item) state.item.textContent = spec.confirm
      } catch {}
      try {
        state.timer = setTimeout(disarm, RESTART_CONFIRM_MS)
      } catch {
        state.timer = null
      }
      return state
    }

    /** 把「重启应用」那项的文字临时换成一句提示，过一会儿复原。 */
    function notice(text, ms) {
      try {
        const item = itemOf('restart')
        if (item) item.textContent = text
      } catch {}
      try {
        if (noticeTimer) clearTimeout(noticeTimer)
      } catch {}
      noticeTimer = null
      try {
        noticeTimer = setTimeout(() => {
          noticeTimer = null
          try {
            const again = itemOf('restart')
            if (again) again.textContent = RESTART_TEXT
          } catch {}
        }, ms || RESTART_NOTICE_MS)
      } catch {}
    }

    /** 收掉关窗兜底的两条定时器。 */
    function cancelCloseFallback() {
      try {
        if (closeTimer) clearTimeout(closeTimer)
      } catch {}
      closeTimer = null
      try {
        if (forceTimer) clearTimeout(forceTimer)
      } catch {}
      forceTimer = null
    }

    /**
     * 请外壳把这个窗口关掉 —— 这是"正常退出应用"唯一的路子：关掉最后一扇窗 →
     * 外壳自己 `app.quit()` → 正常停掉宿主进程。反过来让宿主进程 `process.exit(0)`
     * （v0.3.0 的做法）会被外壳判成"意外停止"，弹那个「应用无法启动或已意外停止」。
     *
     * **两条路都走**（0.3.1 只走一条，结果优雅重启整条链路卡死）：
     *   1. 客户端快捷键服务 `ctx.shortcuts.closeWindow()` —— 外壳里那条官方「关闭窗口」
     *      命令用的就是它；但它要把当前 revision 交给主进程核对，**从没改过快捷键的用户
     *      主进程侧根本没有 revision**，那次调用会被静默忽略（实测：外壳进程 60 秒没退）。
     *   2. 标准 `window.close()` —— Electron 里等价于点窗口自己的关闭按钮，外壳没拦
     *      `close`（`mainWindow.on("close"` 在 asar 里 0 命中），关掉最后一扇窗就会
     *      `window-all-closed` → `app.quit()`。所以它才是真正兜住的那条。
     */
    function closeShellWindow() {
      try {
        if (shortcuts && typeof shortcuts.closeWindow === 'function') {
          const pending = shortcuts.closeWindow()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
      } catch {}
      try {
        if (typeof window !== 'undefined' && typeof window.close === 'function') window.close()
      } catch {}
    }

    /**
     * 关窗没生效时的两层兜底：+1.2s 再请一次外壳关窗；+2.6s 页面居然还在，就退回让宿主
     * 自己退（那条会弹恢复框，所以只当最后手段）。窗口真关掉的话，这些定时器随页面一起
     * 消失，不会误触发。
     */
    function scheduleCloseFallback() {
      cancelCloseFallback()
      try {
        closeTimer = setTimeout(() => {
          closeTimer = null
          closeShellWindow()
        }, CLOSE_RETRY_MS)
      } catch {}
      try {
        forceTimer = setTimeout(() => {
          forceTimer = null
          requestRestart(RESTART_MODE_FORCE, (outcome) => {
            if (!outcome.ok) notice(RESTART_BLOCKED_TEXT)
          })
        }, CLOSE_FORCE_MS)
      } catch {}
    }

    /**
     * POST 重启路由；拿到结论时回调一次 `{ ok, message }`（`done` 只会被调一次，
     * 抛出的异常也吞在这里）。`mode` = `graceful`（请外壳正常退出）/ `force`（宿主自己退）。
     */
    function requestRestart(mode, done) {
      let settled = false
      const settle = (outcome) => {
        if (settled) return
        settled = true
        try {
          done(outcome)
        } catch {}
      }
      let pending = null
      try {
        if (typeof fetch !== 'function') throw new Error('no fetch')
        pending = fetch(RESTART_API, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode }),
        })
      } catch {
        settle({ ok: false, message: '重启请求没发出去' })
        return
      }
      if (!pending || typeof pending.then !== 'function') {
        settle({ ok: false, message: '重启请求没发出去' })
        return
      }
      pending
        .then((response) => {
          const status = response && typeof response.status === 'number' ? response.status : 0
          const ok = !!(response && response.ok)
          let body = null
          try {
            if (response && typeof response.json === 'function') body = response.json()
          } catch {}
          if (body && typeof body.then === 'function') {
            return body.then(
              (parsed) => ({ status: status, ok: ok, message: parsed && parsed.error ? String(parsed.error) : '' }),
              () => ({ status: status, ok: ok, message: '' }),
            )
          }
          return { status: status, ok: ok, message: '' }
        })
        .then((result) => {
          if (result.ok) {
            settle({ ok: true, message: '' })
            return
          }
          if (result.status === 0) settle({ ok: false, message: '重启请求没发出去' })
          else settle({ ok: false, message: result.message || `宿主拒绝了重启（HTTP ${result.status}）` })
        })
        .catch(() => settle({ ok: false, message: '重启请求没发出去' }))
    }

    /**
     * 点「重启应用」：先请宿主**准备**重启（优雅方式：宿主写计划、拉起分离助手，但
     * 自己**不**退出），拿到 200 后请外壳关掉窗口 —— 关掉最后一扇窗，外壳自己走
     * `app.quit()`，这才是"正常退出"；只有关窗没生效才退回老办法（宿主自杀，会弹恢复框）。
     */
    function restartApp() {
      disarm()
      cancelCloseFallback()
      notice(RESTART_STARTING_TEXT)
      requestRestart(RESTART_MODE_GRACEFUL, (outcome) => {
        if (outcome.ok) {
          notice(RESTART_STARTING_TEXT)
          closeShellWindow()
          scheduleCloseFallback()
          return
        }
        notice(outcome.message)
      })
    }

    function onItemClick(spec) {
      return function handler(event) {
        halt(event)
        // 需要二次确认且还没确认过：只武装，不执行，也不关面板。
        if (spec.confirm && !(armed && armed.id === spec.id)) {
          armConfirm(spec)
          return
        }
        if (!spec.keepOpen) closePanel()
        try {
          spec.run()
        } catch {}
      }
    }

    function buildPanel() {
      if (!document.body || typeof document.body.appendChild !== 'function') return null
      const box = document.createElement('div')
      box.setAttribute(PANEL_ATTR, '')
      box.setAttribute('role', 'menu')
      box.setAttribute('aria-label', '刷新')
      const items = []
      for (let i = 0; i < ITEMS.length; i++) {
        const spec = ITEMS[i]
        const item = document.createElement('button')
        item.setAttribute('type', 'button')
        item.setAttribute(ITEM_ATTR, spec.id)
        item.setAttribute('role', 'menuitem')
        item.setAttribute('tabindex', '-1')
        item.setAttribute('title', spec.hint)
        item.textContent = spec.text
        item.addEventListener('click', onItemClick(spec))
        items.push(item)
        box.appendChild(item)
      }
      // 面板内部按下不要冒到 document，否则会被自己的"点外面关掉"逻辑收掉。
      box.addEventListener('pointerdown', halt)
      document.body.appendChild(box)
      return { panel: box, items: items }
    }

    function setExpanded(on) {
      try {
        if (menuButton && typeof menuButton.setAttribute === 'function') {
          menuButton.setAttribute('aria-expanded', on ? 'true' : 'false')
        }
      } catch {}
    }

    function positionPanel() {
      if (!panel) return
      try {
        const vp = viewport()
        const anchor = rectOf(menuButton) || rectOf(menuHost)
        const w = panel.offsetWidth || 176
        const h = panel.offsetHeight || 76
        let left = anchor ? anchor.left : EDGE
        let top = anchor ? anchor.bottom + GAP : EDGE
        if (left + w > vp.w - EDGE) left = Math.max(EDGE, vp.w - w - EDGE)
        if (top + h > vp.h - EDGE) top = Math.max(EDGE, (anchor ? anchor.top : EDGE) - h - GAP)
        if (left < EDGE) left = EDGE
        if (top < EDGE) top = EDGE
        panel.style.left = Math.round(left) + 'px'
        panel.style.top = Math.round(top) + 'px'
      } catch {}
    }

    function moveFocus(step) {
      if (!panelItems.length) return
      focusIndex = (focusIndex + step + panelItems.length) % panelItems.length
      try {
        if (typeof panelItems[focusIndex].focus === 'function') panelItems[focusIndex].focus()
      } catch {}
    }

    /**
     * 点到面板和「刷新」按钮**以外**的任何地方都收起来 —— 标题栏里也不例外。
     * 只豁免这两处：豁免面板是显然的；豁免按钮是因为它自己的 `click` 负责开合
     * （pointerdown 若先把它收掉，紧接着的 click 会当成"再打开一次"，
     * 看起来就是"点按钮关不掉"）。
     */
    function onDocumentPointerDown(event) {
      try {
        if (!panel) return
        const path = pathOf(event)
        if (inPath(panel, path)) return
        if (inPath(menuButton, path)) return
        closePanel()
      } catch {}
    }

    /** 点到别的窗口（或托盘）时窗口失焦，也把面板收起来。 */
    function onWindowBlur() {
      if (panel) closePanel()
    }

    function onDocumentKeyDown(event) {
      try {
        if (!panel) return
        const key = event ? event.key : null
        if (key === 'Escape' || key === 'Esc') {
          halt(event)
          closePanel()
        } else if (key === 'ArrowDown') {
          halt(event)
          moveFocus(1)
        } else if (key === 'ArrowUp') {
          halt(event)
          moveFocus(-1)
        } else if (key === 'Tab') {
          closePanel()
        }
      } catch {}
    }

    /**
     * 监听装在 window / document 的**捕获**阶段：页面里总有人对 pointerdown 调
     * `stopPropagation`，冒泡阶段就收不到；捕获阶段从 window 往下走，谁都拦不住。
     * 面板内部按下的 `halt`（`stopPropagation`）挂在面板自己身上，不挡这里的捕获。
     */
    function addPanelListeners() {
      try {
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('pointerdown', onDocumentPointerDown, true)
          window.addEventListener('resize', positionPanel)
          window.addEventListener('scroll', positionPanel, true)
          window.addEventListener('blur', onWindowBlur)
        }
      } catch {}
      try {
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', onDocumentPointerDown, true)
          document.addEventListener('keydown', onDocumentKeyDown)
        }
      } catch {}
    }

    function removePanelListeners() {
      try {
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('pointerdown', onDocumentPointerDown, true)
          window.removeEventListener('resize', positionPanel)
          window.removeEventListener('scroll', positionPanel, true)
          window.removeEventListener('blur', onWindowBlur)
        }
      } catch {}
      try {
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('pointerdown', onDocumentPointerDown, true)
          document.removeEventListener('keydown', onDocumentKeyDown)
        }
      } catch {}
    }

    function openPanel() {
      try {
        if (!menuButton) return
        if (!panel) {
          const built = buildPanel()
          if (!built) return
          panel = built.panel
          panelItems = built.items
        }
        focusIndex = 0
        positionPanel()
        setExpanded(true)
        addPanelListeners()
        if (panelItems[0] && typeof panelItems[0].focus === 'function') panelItems[0].focus()
      } catch {}
    }

    function closePanel() {
      disarm()
      try {
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
      } catch {}
      panel = null
      panelItems = []
      focusIndex = 0
      setExpanded(false)
      removePanelListeners()
      try {
        if (menuButton && typeof menuButton.focus === 'function') menuButton.focus()
      } catch {}
    }

    // ── 兜底胶囊（标题栏不可用时）────────────────────────────────────────────
    function clampPos(x, y, w0, h0) {
      const size = viewport()
      const maxX = Math.max(EDGE, size.w - w0 - EDGE)
      const maxY = Math.max(EDGE, size.h - h0 - EDGE)
      let nx = isFinite(x) ? x : EDGE
      let ny = isFinite(y) ? y : EDGE
      if (nx < EDGE) nx = EDGE
      if (ny < EDGE) ny = EDGE
      if (nx > maxX) nx = maxX
      if (ny > maxY) ny = maxY
      return { x: Math.round(nx), y: Math.round(ny) }
    }

    function readPos() {
      try {
        if (!window.localStorage || typeof window.localStorage.getItem !== 'function') return null
        const raw = window.localStorage.getItem(POS_KEY)
        if (!raw) return null
        const value = JSON.parse(raw)
        if (!value || typeof value !== 'object') return null
        const x = Number(value.x)
        const y = Number(value.y)
        if (!isFinite(x) || !isFinite(y)) return null
        return { x: x, y: y }
      } catch {
        return null
      }
    }

    function writePos(value) {
      try {
        if (!window.localStorage || typeof window.localStorage.setItem !== 'function') return
        window.localStorage.setItem(POS_KEY, JSON.stringify({ x: value.x, y: value.y }))
      } catch {
        /* 存不下（隐私模式等）就退化成"这次会话内有效"。 */
      }
    }

    function place() {
      if (!pill) return
      try {
        if (!pos) {
          pill.style.left = 'auto'
          pill.style.top = 'auto'
          pill.style.right = MARGIN + 'px'
          pill.style.bottom = MARGIN + 'px'
          return
        }
        const w0 = pill.offsetWidth || 72
        const h0 = pill.offsetHeight || 30
        const fixed = clampPos(pos.x, pos.y, w0, h0)
        pos = fixed
        pill.style.right = 'auto'
        pill.style.bottom = 'auto'
        pill.style.left = fixed.x + 'px'
        pill.style.top = fixed.y + 'px'
      } catch {}
    }

    function onPointerDown(event) {
      try {
        if (!pill) return
        if (event && typeof event.button === 'number' && event.button !== 0) return
        suppressClick = false
        const rect = rectOf(pill)
        drag = {
          id: event ? event.pointerId : undefined,
          startX: event && isFinite(event.clientX) ? event.clientX : 0,
          startY: event && isFinite(event.clientY) ? event.clientY : 0,
          originX: rect ? rect.left : 0,
          originY: rect ? rect.top : 0,
          moved: false,
        }
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
      } catch {
        drag = null
      }
    }

    function onPointerMove(event) {
      try {
        if (!drag || !pill) return
        if (drag.id !== undefined && event && event.pointerId !== undefined && event.pointerId !== drag.id) return
        const x = event && isFinite(event.clientX) ? event.clientX : drag.startX
        const y = event && isFinite(event.clientY) ? event.clientY : drag.startY
        const dx = x - drag.startX
        const dy = y - drag.startY
        if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
        drag.moved = true
        pos = clampPos(drag.originX + dx, drag.originY + dy, pill.offsetWidth || 72, pill.offsetHeight || 30)
        place()
      } catch {}
    }

    function onPointerUp() {
      try {
        if (drag && drag.moved && pos) {
          writePos(pos)
          suppressClick = true
        }
      } catch {}
      drag = null
    }

    function onPillClick(event) {
      try {
        if (suppressClick) {
          suppressClick = false
          return
        }
        halt(event)
      } catch {}
      reload()
    }

    function attachWindow() {
      if (attached) return
      attached = true
      try {
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('pointermove', onPointerMove)
          window.addEventListener('pointerup', onPointerUp)
          window.addEventListener('pointercancel', onPointerUp)
          window.addEventListener('resize', place)
        }
      } catch {}
    }

    function detachWindow() {
      attached = false
      try {
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerUp)
          window.removeEventListener('resize', place)
        }
      } catch {}
    }

    function mountPill() {
      if (pill) return
      try {
        if (!document.body || typeof document.body.appendChild !== 'function') return
        const box = document.createElement('div')
        box.setAttribute(PILL_ATTR, '')
        box.setAttribute('title', BUTTON_HINT)

        const btn = document.createElement('button')
        btn.setAttribute('type', 'button')
        btn.setAttribute('title', BUTTON_HINT)
        btn.setAttribute('aria-label', '刷新界面')

        const glyph = document.createElement('span')
        glyph.setAttribute('aria-hidden', 'true')
        glyph.textContent = '⟳'

        const label = document.createElement('span')
        label.setAttribute(PILL_TEXT_ATTR, '')
        label.textContent = '刷新'

        btn.appendChild(glyph)
        btn.appendChild(label)
        box.appendChild(btn)
        box.addEventListener('pointerdown', onPointerDown)
        box.addEventListener('click', onPillClick)
        document.body.appendChild(box)
        pill = box
        pillButton = btn
        place()
        attachWindow()
      } catch {
        pill = null
        pillButton = null
      }
    }

    function unmountPill() {
      try {
        if (pill) {
          pill.removeEventListener('pointerdown', onPointerDown)
          pill.removeEventListener('click', onPillClick)
        }
      } catch {}
      try {
        if (pill && pill.parentNode) pill.parentNode.removeChild(pill)
      } catch {}
      pill = null
      pillButton = null
      drag = null
      suppressClick = false
      detachWindow()
    }

    function scheduleFallback() {
      try {
        if (pill || fallbackTimer || !document.body) return
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null
          try {
            if (!menuButton) mountPill()
          } catch {}
        }, FALLBACK_MS)
      } catch {}
    }

    function cancelFallback() {
      try {
        if (fallbackTimer) clearTimeout(fallbackTimer)
      } catch {}
      fallbackTimer = null
    }

    // ── 生命周期 ────────────────────────────────────────────────────────────
    function start() {
      try {
        ensurePageStyle()
        if (!pos) pos = readPos()
        if (!started && document.body) {
          started = true
          try {
            if (typeof MutationObserver === 'function') {
              observer = new MutationObserver(onMutate)
              observer.observe(document.body, { childList: true, subtree: true })
            }
          } catch {
            observer = null
          }
        }
        sync()
      } catch {}
    }

    function stop() {
      closePanel()
      cancelFallback()
      cancelCloseFallback()
      try {
        if (noticeTimer) clearTimeout(noticeTimer)
      } catch {}
      noticeTimer = null
      try {
        if (observer) observer.disconnect()
      } catch {}
      observer = null
      started = false
      try {
        if (shadowObserver) shadowObserver.disconnect()
      } catch {}
      shadowObserver = null
      watchedRoot = null
      unmountButton()
      unmountPill()
      menuHost = null
      try {
        if (shadowStyle && shadowStyle.parentNode) shadowStyle.parentNode.removeChild(shadowStyle)
      } catch {}
      shadowStyle = null
      try {
        if (pageStyle && pageStyle.parentNode) pageStyle.parentNode.removeChild(pageStyle)
      } catch {}
      pageStyle = null
      shortcuts = null
      pos = null
    }

    /** 空 inject：本插件不等待任何服务，条目立即 active。 */
    exports.inject = []

    exports.apply = function apply(ctx) {
      try {
        if (document.body) start()
        else if (typeof document.addEventListener === 'function') {
          document.addEventListener('DOMContentLoaded', start, { once: true })
        }

        // 「关掉窗口」要用的客户端快捷键服务（外壳里那条官方关闭窗口命令走的就是它）。
        // 只做**运行时**注入、且整段包在 try/catch 里：服务不在（web 端、或它还没起来）
        // 插件照样得激活 —— 顶层 inject 声明会让整个 GUI 等它。
        try {
          if (ctx && typeof ctx.inject === 'function') {
            ctx.inject(['shortcuts'], (scoped) => {
              try {
                shortcuts = (scoped && scoped.shortcuts) || null
              } catch {}
            })
          }
        } catch {}

        // 卸载（热重载 / 禁用）：按钮、胶囊、样式表全收干净，回到 DSH 原生外观。
        if (ctx && typeof ctx.on === 'function') ctx.on('dispose', stop)
      } catch {
        /* 永不抛出：客户端条目一抛异常，整个 GUI 都起不来。 */
      }
    }

    return module.exports
  },
})
