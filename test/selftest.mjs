/**
 * dsh-ui-refresh 自检：用 node:vm + 最小 DOM 替身跑浏览器半边（lib/client.js）。
 *
 * 替身只覆盖本插件真正用到的东西：
 *   · 元素：attrs/style/listeners/children/offsetWidth/offsetHeight/getBoundingClientRect/contains/focus
 *   · **open shadow root**（外壳的 `[data-windows-menu]` 就是这种）
 *   · 选择器只支持 `[attr]` / `[attr="v"]` / `tag[attr]`
 *   · dispatch 沿 parentNode 冒泡，且 body/head 的 parentNode 是 document ⇒ 冒泡能到 document
 *   · MutationObserver 替身（手动 trigger）
 *   · 假定时器（tick(ms) —— 用来测"3 秒兜底胶囊"）
 *   · caches / navigator.serviceWorker 替身（测「清空缓存并刷新」）
 *
 * 跑法：node test/selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ── 断言 ──────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const failures = []

function ok(cond, name, detail) {
  if (cond) {
    pass += 1
  } else {
    fail += 1
    failures.push(name + (detail ? '  ——  ' + detail : ''))
  }
}

function eq(actual, expected, name) {
  ok(
    Object.is(actual, expected),
    name,
    actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function section(title) {
  console.log('\n· ' + title)
}

/** 包一层 try/catch：插件抛异常本身就是失败（它会拦掉整个 GUI）。 */
function guard(name, fn) {
  try {
    return fn()
  } catch (err) {
    ok(false, name + ' 不应抛出异常', err && err.message ? err.message : String(err))
    return undefined
  }
}

// ── 选择器（只认插件用到的三种形态）────────────────────────────────────────
const SEL_RE = /^([a-zA-Z][a-zA-Z0-9-]*)?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/

function matches(el, sel) {
  const m = SEL_RE.exec(String(sel).trim())
  if (!m) return false
  const tag = m[1]
  const attr = m[2]
  const value = m[3]
  if (!tag && !attr) return false
  if (!el || el.nodeType !== 1) return false
  if (tag && el.tagName !== tag.toUpperCase()) return false
  if (attr) {
    if (typeof el.hasAttribute !== 'function' || !el.hasAttribute(attr)) return false
    if (value !== undefined && el.getAttribute(attr) !== value) return false
  }
  return true
}

/** 深度优先找（**不**下沉进 shadow root —— 与真实 DOM 一致）。 */
function findIn(list, sel) {
  for (const child of list) {
    if (matches(child, sel)) return child
    if (child.children && child.children.length) {
      const hit = findIn(child.children, sel)
      if (hit) return hit
    }
  }
  return null
}

function findAll(list, sel, out = []) {
  for (const child of list) {
    if (matches(child, sel)) out.push(child)
    if (child.children && child.children.length) findAll(child.children, sel, out)
  }
  return out
}

function fire(map, type, event) {
  const list = map.get(type)
  if (!list || !list.length) return
  for (const fn of list.slice()) {
    try {
      fn(event)
    } catch (err) {
      throw err
    }
  }
}

// ── 环境 ──────────────────────────────────────────────────────────────────
const POS_KEY = 'dsh-ui-refresh:position'
const FALLBACK_MS = 3000
const VW = 1280
const VH = 800

function makeEnv() {
  const state = { reloadCount: 0, cachesCleared: 0, swUnregistered: 0 }
  const errors = []
  const observers = []
  const store = new Map()
  const docListeners = new Map()
  const winListeners = new Map()

  // 假定时器
  const timers = { now: 0, nextId: 1, queue: new Map() }
  function fakeSetTimeout(fn, ms) {
    const id = timers.nextId++
    if (typeof fn !== 'function') return id
    timers.queue.set(id, { fn, at: timers.now + (Number(ms) || 0), every: 0 })
    return id
  }
  function fakeSetInterval(fn, ms) {
    const id = timers.nextId++
    if (typeof fn !== 'function') return id
    const every = Math.max(1, Number(ms) || 1)
    timers.queue.set(id, { fn, at: timers.now + every, every })
    return id
  }
  function fakeClear(id) {
    timers.queue.delete(id)
  }
  function tick(ms) {
    const target = timers.now + (Number(ms) || 0)
    let loops = 0
    while (loops++ < 500) {
      let pick = null
      for (const [id, task] of timers.queue) {
        if (task.at > target) continue
        if (!pick || task.at < pick.task.at || (task.at === pick.task.at && id < pick.id)) pick = { id, task }
      }
      if (!pick) break
      timers.now = pick.task.at
      if (pick.task.every) pick.task.at = timers.now + pick.task.every
      else timers.queue.delete(pick.id)
      try {
        pick.task.fn()
      } catch (err) {
        errors.push('timer: ' + (err && err.message ? err.message : String(err)))
      }
    }
    if (target > timers.now) timers.now = target
  }

  // 元素
  function makeElement(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      attrs: {},
      style: {},
      listeners: new Map(),
      children: [],
      parentNode: null,
      shadowRoot: null,
      textContent: '',
      _w: undefined,
      _h: undefined,
      _left: 0,
      _top: 0,
      get offsetWidth() {
        return this._w !== undefined ? this._w : this.tagName === 'BUTTON' ? 62 : 76
      },
      get offsetHeight() {
        return this._h !== undefined ? this._h : 30
      },
      setAttribute(name, value) {
        this.attrs[String(name)] = String(value)
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, String(name)) ? this.attrs[String(name)] : null
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, String(name))
      },
      removeAttribute(name) {
        delete this.attrs[String(name)]
      },
      appendChild(child) {
        if (child.parentNode && typeof child.parentNode.removeChild === 'function') child.parentNode.removeChild(child)
        child.parentNode = this
        this.children.push(child)
        return child
      },
      removeChild(child) {
        const i = this.children.indexOf(child)
        if (i >= 0) this.children.splice(i, 1)
        if (child.parentNode === this) child.parentNode = null
        return child
      },
      addEventListener(type, fn) {
        if (typeof fn !== 'function') return
        if (!this.listeners.has(type)) this.listeners.set(type, [])
        this.listeners.get(type).push(fn)
      },
      removeEventListener(type, fn) {
        const list = this.listeners.get(type)
        if (!list) return
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      },
      countListeners(type) {
        const list = this.listeners.get(type)
        return list ? list.length : 0
      },
      dispatch(type, extra) {
        const event = Object.assign(
          {
            type,
            target: this,
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true
            },
            stopPropagation() {},
            composedPath() {
              const path = []
              let node = this.target
              let guardCount = 0
              while (node && guardCount++ < 64) {
                path.push(node)
                node = node.parentNode
              }
              return path
            },
          },
          extra || {},
          { target: this },
        )
        let node = this
        let guardCount = 0
        while (node && guardCount++ < 64) {
          fire(node.listeners, type, event)
          if (node === doc) break
          node = node.parentNode
        }
        return event
      },
      querySelector(sel) {
        return findIn(this.children, sel)
      },
      querySelectorAll(sel) {
        return findAll(this.children, sel)
      },
      contains(node) {
        let n = node
        while (n) {
          if (n === this) return true
          n = n.parentNode
        }
        return false
      },
      getBoundingClientRect() {
        const width = this.offsetWidth
        const height = this.offsetHeight
        return {
          left: this._left,
          top: this._top,
          right: this._left + width,
          bottom: this._top + height,
          width,
          height,
          x: this._left,
          y: this._top,
        }
      },
      attachShadow() {
        const root = makeElement('#shadow-root')
        root.nodeType = 11
        root.tagName = '#shadow-root'
        root.host = this
        root.parentNode = null
        this.shadowRoot = root
        return root
      },
      focus() {
        doc.activeElement = this
      },
    }
    return el
  }

  // 文档
  const doc = {
    nodeType: 9,
    tagName: '#DOCUMENT',
    head: null,
    body: null,
    documentElement: null,
    activeElement: null,
    listeners: docListeners,
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return
      if (!docListeners.has(type)) docListeners.set(type, [])
      docListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type)
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    countListeners(type) {
      const list = docListeners.get(type)
      return list ? list.length : 0
    },
    fire(type, extra) {
      const event = Object.assign({ type, target: doc, preventDefault() {}, stopPropagation() {} }, extra || {})
      fire(docListeners, type, event)
      return event
    },
    querySelector(sel) {
      return findIn([doc.body, doc.head].filter(Boolean), sel)
    },
    querySelectorAll(sel) {
      return findAll([doc.body, doc.head].filter(Boolean), sel)
    },
    contains(node) {
      let n = node
      while (n) {
        if (n === doc) return true
        n = n.parentNode
      }
      return false
    },
  }

  const head = makeElement('head')
  const body = makeElement('body')
  head.parentNode = doc
  body.parentNode = doc
  doc.head = head
  doc.body = body

  // MutationObserver 替身
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.active = false
      observers.push(this)
    }
    observe(target) {
      this.targets.push(target)
      this.active = true
    }
    disconnect() {
      this.active = false
    }
    trigger() {
      if (!this.active || typeof this.callback !== 'function') return
      try {
        this.callback([], this)
      } catch (err) {
        errors.push('observer: ' + (err && err.message ? err.message : String(err)))
      }
    }
  }

  // window
  const win = {
    innerWidth: VW,
    innerHeight: VH,
    location: {
      reload() {
        state.reloadCount += 1
      },
    },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null
      },
      setItem(key, value) {
        store.set(String(key), String(value))
      },
      removeItem(key) {
        store.delete(String(key))
      },
    },
    caches: {
      async keys() {
        return ['shell-cache', 'asset-cache']
      },
      async delete() {
        state.cachesCleared += 1
        return true
      },
    },
    navigator: {
      serviceWorker: {
        async getRegistrations() {
          return [
            {
              async unregister() {
                state.swUnregistered += 1
                return true
              },
            },
          ]
        },
      },
    },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return
      if (!winListeners.has(type)) winListeners.set(type, [])
      winListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type)
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    countListeners(type) {
      const list = winListeners.get(type)
      return list ? list.length : 0
    },
    fire(type, extra) {
      const event = Object.assign({ type, target: win, preventDefault() {}, stopPropagation() {} }, extra || {})
      fire(winListeners, type, event)
      return event
    },
  }
  win.setTimeout = fakeSetTimeout
  win.clearTimeout = fakeClear
  win.MutationObserver = FakeObserver

  // 沙箱
  let entry = null
  win.__ModuleLoader__ = {
    load(value) {
      entry = value
    },
  }
  const sandbox = {
    window: win,
    document: doc,
    console,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClear,
    setInterval: fakeSetInterval,
    clearInterval: fakeClear,
    MutationObserver: FakeObserver,
  }
  sandbox.self = win
  sandbox.globalThis = sandbox

  const context = createContext(sandbox)
  runInContext(source, context, { filename: 'lib/client.js' })

  const env = {
    sandbox,
    context,
    window: win,
    document: doc,
    head,
    body,
    store,
    errors,
    observers,
    entry,
    exports: entry ? entry.factory(() => {}) : null,
    makeElement,
    buildMenubar() {
      const host = makeElement('div')
      host.setAttribute('data-windows-menu', '')
      const shadow = host.attachShadow({ mode: 'open' })
      const menubar = makeElement('div')
      menubar.setAttribute('role', 'menubar')
      const appButton = makeElement('button')
      appButton.setAttribute('aria-label', '应用')
      appButton.textContent = '应用'
      const editButton = makeElement('button')
      editButton.setAttribute('aria-label', '编辑')
      editButton.textContent = '编辑'
      menubar.appendChild(appButton)
      menubar.appendChild(editButton)
      shadow.appendChild(menubar)
      body.appendChild(host)
      return { host, shadow, menubar, appButton, editButton }
    },
    makeCtx() {
      const handlers = {}
      const ctx = {
        handlers,
        on(type, fn) {
          if (typeof fn !== 'function') throw new Error('handler 必须是函数')
          if (!handlers[type]) handlers[type] = []
          handlers[type].push(fn)
          return ctx
        },
        dispose() {
          const list = handlers.dispose || []
          for (const fn of list.slice()) fn()
        },
      }
      return ctx
    },
    tick,
    async flushMicro() {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    },
    flush() {
      for (const observer of observers.slice()) if (observer.active) observer.trigger()
    },
    findIn,
    findAll,
    matches,
    host() {
      return doc.querySelector('[data-windows-menu]')
    },
    menubar() {
      const host = doc.querySelector('[data-windows-menu]')
      return host && host.shadowRoot ? host.shadowRoot.querySelector('[role="menubar"]') : null
    },
    menuButton() {
      const bar = env.menubar()
      return bar ? bar.querySelector('button[data-dsh-ui-refresh-menu]') : null
    },
    ourButtons() {
      const bar = env.menubar()
      return bar ? findAll(bar.children, 'button[data-dsh-ui-refresh-menu]') : []
    },
    menuButtonText() {
      const btn = env.menuButton()
      const span = btn ? btn.querySelector('[data-dsh-ui-refresh-menu-text]') : null
      return span ? span.textContent : null
    },
    shadowStyles() {
      const host = doc.querySelector('[data-windows-menu]')
      if (!host || !host.shadowRoot) return []
      return host.shadowRoot.children.filter((el) => el.getAttribute && el.getAttribute('id') === 'dsh-ui-refresh-shadow-style')
    },
    pageStyles() {
      return head.children.filter((el) => el.tagName === 'STYLE')
    },
    pill() {
      return doc.querySelector('[data-dsh-ui-refresh]')
    },
    panel() {
      return doc.querySelector('[data-dsh-ui-refresh-panel]')
    },
    panelItems() {
      const panel = env.panel()
      return panel ? findAll(panel.children, 'button[data-dsh-ui-refresh-item]') : []
    },
    reloadCount: () => state.reloadCount,
    cachesCleared: () => state.cachesCleared,
    swUnregistered: () => state.swUnregistered,
    activeCount: () => observers.filter((observer) => observer.active).length,
  }
  return env
}

// ── 加载插件 ──────────────────────────────────────────────────────────────
const probe = makeEnv()
ok(!!probe.entry, '插件注册了 __ModuleLoader__ 条目')
eq(probe.entry && probe.entry.id, 'dsh-ui-refresh', '条目 id 正确')
ok(typeof probe.exports.apply === 'function', '导出 apply()')
ok(Array.isArray(probe.exports.inject) && probe.exports.inject.length === 0, 'inject 为空（不等任何服务，条目立即 active）')

// ── A 标题栏路线：挂载、样式、幂等 ────────────────────────────────────────
section('A 标题栏菜单条：挂载 / 样式 / 幂等')
{
  const a = makeEnv()
  const bar = a.buildMenubar()
  const ctx = a.makeCtx()
  guard('A apply', () => a.exports.apply(ctx))

  const btn = a.menuButton()
  ok(!!btn, 'A: 菜单条里出现「刷新」按钮')
  eq(btn && btn.parentNode, bar.menubar, 'A: 按钮挂在 [role=menubar] 里')
  eq(bar.menubar.children.length, 3, 'A: 菜单栏 =「应用」「编辑」+ 我们一颗')
  eq(bar.menubar.children[2], btn, 'A: 我们的按钮追加在「编辑」后面')
  eq(a.menuButtonText(), '刷新', 'A: 按钮文案是「刷新」')
  eq(btn && btn.getAttribute('type'), 'button', 'A: type=button（不提交表单）')
  eq(btn && btn.getAttribute('aria-haspopup'), 'menu', 'A: aria-haspopup=menu')
  eq(btn && btn.getAttribute('aria-expanded'), 'false', 'A: 默认 aria-expanded=false')
  ok(!!(btn && btn.getAttribute('title')), 'A: 有 tooltip 说明')

  const shadowStyles = a.shadowStyles()
  eq(shadowStyles.length, 1, 'A: 样式注进 shadow root 且只有一张')
  const shadowCss = shadowStyles[0] ? shadowStyles[0].textContent : ''
  ok(shadowCss.indexOf('-webkit-app-region: no-drag') >= 0, 'A: shadow 样式带 no-drag')
  ok(shadowCss.indexOf('[aria-expanded="true"]') >= 0, 'A: 展开态有高亮规则')
  ok(shadowCss.indexOf('--dsw-alias-label-secondary') >= 0, 'A: 复用官方文字色令牌')

  const pageStyles = a.pageStyles()
  eq(pageStyles.length, 1, 'A: 页面样式表注入 head（只一张）')
  const pageCss = pageStyles[0] ? pageStyles[0].textContent : ''
  ok(pageCss.indexOf('position: fixed') >= 0, 'A: 面板是浮层')
  ok(pageCss.indexOf('data-dsh-ui-refresh-panel') >= 0, 'A: 页面样式含面板规则')
  ok(pageCss.indexOf('border-radius: 999px') >= 0, 'A: 页面样式含兜底胶囊规则')

  // 幂等：再对账几次不应重复注入 / 重复追加
  a.flush()
  a.flush()
  guard('A re-apply', () => a.exports.apply(ctx))
  a.flush()
  eq(a.ourButtons().length, 1, 'A: 反复对账也只挂一颗按钮')
  eq(a.menuButton(), btn, 'A: 还是同一颗（没有重建）')
  eq(a.shadowStyles().length, 1, 'A: 反复对账样式只注入一张')
  eq(a.pageStyles().length, 1, 'A: 页面样式表也只要一张')

  ok(!a.pill(), 'A: 标题栏可用时不出现兜底胶囊')
  a.tick(FALLBACK_MS * 2)
  ok(!a.pill(), 'A: 过了兜底时间也不出现胶囊')
  eq(a.window.countListeners('pointermove'), 0, 'A: 标题栏路线不挂拖动监听')

  // ── B 下拉面板 ──────────────────────────────────────────────────────────
  section('B 下拉面板：开合 / 内容 / 行为')
  const opened = a.panel()
  ok(!opened, 'B: 一开始没有面板')

  btn._left = 100
  btn._top = 8
  guard('B open', () => btn.dispatch('click', {}))
  const panel = a.panel()
  ok(!!panel, 'B: 点按钮弹出面板')
  eq(btn.getAttribute('aria-expanded'), 'true', 'B: aria-expanded=true')
  eq(panel && panel.getAttribute('role'), 'menu', 'B: 面板 role=menu')
  eq(panel && panel.parentNode, a.body, 'B: 面板挂在 body 上')
  eq(panel && panel.style.left, '100px', 'B: 面板对齐按钮左边')
  eq(panel && panel.style.top, '42px', 'B: 面板在按钮下方（按钮底 38 + 间距 4）')

  const items = a.panelItems()
  eq(items.length, 2, 'B: 两个菜单项')
  eq(items[0] && items[0].getAttribute('data-dsh-ui-refresh-item'), 'reload', 'B: 第一项 id=reload')
  eq(items[1] && items[1].getAttribute('data-dsh-ui-refresh-item'), 'hard', 'B: 第二项 id=hard')
  eq(items[0] && items[0].textContent, '刷新界面', 'B: 第一项文案「刷新界面」')
  eq(items[1] && items[1].textContent, '清空缓存并刷新', 'B: 第二项文案「清空缓存并刷新」')
  eq(items[0] && items[0].getAttribute('role'), 'menuitem', 'B: 菜单项 role=menuitem')
  eq(a.document.activeElement, items[0], 'B: 打开时焦点落在第一项')
  eq(a.window.countListeners('resize'), 1, 'B: 面板打开时跟随 resize')
  eq(a.window.countListeners('scroll'), 1, 'B: 面板打开时跟随 scroll（含捕获）')

  guard('B reload', () => items[0].dispatch('click', {}))
  eq(a.reloadCount(), 1, 'B: 点「刷新界面」重载窗口')
  ok(!a.panel(), 'B: 点完自动收起')
  eq(btn.getAttribute('aria-expanded'), 'false', 'B: 收起后 aria-expanded 复位')
  eq(a.window.countListeners('resize'), 0, 'B: 收起后不再跟随 resize')

  guard('B open2', () => btn.dispatch('click', {}))
  ok(!!a.panel(), 'B: 可以再次打开')
  guard('B hard', () => a.panelItems()[1].dispatch('click', {}))
  await a.flushMicro()
  eq(a.cachesCleared(), 2, 'B: 「清空缓存并刷新」清掉 Cache Storage 两个条目')
  eq(a.swUnregistered(), 1, 'B: 顺便注销 service worker')
  eq(a.reloadCount(), 2, 'B: 清完缓存后重载')

  guard('B open3', () => btn.dispatch('click', {}))
  guard('B escape', () => a.document.fire('keydown', { key: 'Escape' }))
  ok(!a.panel(), 'B: Escape 收起面板')
  eq(a.reloadCount(), 2, 'B: Escape 不触发刷新')

  guard('B open4', () => btn.dispatch('click', {}))
  const other = a.makeElement('div')
  a.body.appendChild(other)
  guard('B outside', () => other.dispatch('pointerdown', {}))
  ok(!a.panel(), 'B: 点面板外面收起')

  guard('B open5', () => btn.dispatch('click', {}))
  guard('B inside', () => a.panelItems()[0].dispatch('pointerdown', {}))
  ok(!!a.panel(), 'B: 面板内部按下不收起')

  guard('B app click', () => bar.appButton.dispatch('click', {}))
  ok(!a.panel(), 'B: 点「应用」收起我们的面板')

  guard('B open6', () => btn.dispatch('click', {}))
  const arrowItems = a.panelItems()
  guard('B down', () => a.document.fire('keydown', { key: 'ArrowDown' }))
  eq(a.document.activeElement, arrowItems[1], 'B: ↓ 移到第二项')
  guard('B down', () => a.document.fire('keydown', { key: 'ArrowDown' }))
  eq(a.document.activeElement, arrowItems[0], 'B: ↓ 到底回到第一项')
  guard('B up', () => a.document.fire('keydown', { key: 'ArrowUp' }))
  eq(a.document.activeElement, arrowItems[1], 'B: ↑ 回到上一项')
  guard('B tab', () => a.document.fire('keydown', { key: 'Tab' }))
  ok(!a.panel(), 'B: Tab 收起面板')

  guard('B toggle open', () => btn.dispatch('click', {}))
  ok(!!a.panel(), 'B: 又打开了')
  guard('B toggle', () => btn.dispatch('click', {}))
  ok(!a.panel(), 'B: 再点按钮收起（toggle）')

  guard('B open7', () => btn.dispatch('click', {}))
  guard('B resize', () => a.window.fire('resize', {}))
  ok(!!a.panel(), 'B: resize 后面板仍在')
  guard('B close', () => btn.dispatch('click', {}))
  eq(a.reloadCount(), 2, 'B: 全程只有那两次刷新')
  eq(a.errors.length, 0, 'B: 过程中没有内部错误', a.errors.join(' | '))

  // ── C 兜底胶囊 ─────────────────────────────────────────────────────────
  section('C 找不到标题栏时的兜底胶囊')
  const c = makeEnv()
  const cctx = c.makeCtx()
  guard('C apply', () => c.exports.apply(cctx))
  ok(!c.pill(), 'C: 还没到时间，先不出胶囊')
  c.tick(FALLBACK_MS - 1)
  ok(!c.pill(), 'C: 3 秒前不出胶囊')
  c.tick(1)
  const pill = c.pill()
  ok(!!pill, 'C: 3 秒后兜底胶囊出现')
  eq(pill && pill.parentNode, c.body, 'C: 胶囊挂在 body')
  eq(pill && pill.style.right, '14px', 'C: 默认停靠右下角（right）')
  eq(pill && pill.style.bottom, '14px', 'C: 默认停靠右下角（bottom）')
  eq(pill && pill.style.left, 'auto', 'C: 默认不写 left')
  eq(pill && pill.getAttribute('title') !== null, true, 'C: 胶囊带 tooltip')

  const cbtn = pill ? pill.children[0] : null
  ok(!!cbtn, 'C: 胶囊里有按钮')
  eq(cbtn && cbtn.getAttribute('aria-label'), '刷新界面', 'C: 胶囊按钮有无障碍名')

  guard('C click', () => pill.dispatch('click', {}))
  eq(c.reloadCount(), 1, 'C: 点胶囊刷新')
  eq(c.window.countListeners('pointermove'), 1, 'C: 胶囊挂上拖动监听')

  pill._left = 1000
  pill._top = 700
  guard('C down', () => pill.dispatch('pointerdown', { clientX: 1000, clientY: 700, pointerId: 1, button: 0 }))
  guard('C move', () => c.window.fire('pointermove', { clientX: 900, clientY: 640, pointerId: 1 }))
  guard('C up', () => c.window.fire('pointerup', { pointerId: 1 }))
  eq(pill.style.left, '900px', 'C: 拖到哪就停哪（left）')
  eq(pill.style.top, '640px', 'C: 拖到哪就停哪（top）')
  const saved = c.store.get(POS_KEY)
  ok(!!saved, 'C: 位置写进 localStorage')
  eq(saved, JSON.stringify({ x: 900, y: 640 }), 'C: 存的是夹取后的坐标')
  guard('C click after drag', () => pill.dispatch('click', {}))
  eq(c.reloadCount(), 1, 'C: 拖完补的那次 click 不算点击')

  const lateBar = c.buildMenubar()
  c.flush()
  ok(!c.pill(), 'C: 标题栏出现后胶囊收掉')
  ok(!!c.menuButton(), 'C: 标题栏出现后按钮挂上')
  eq(c.window.countListeners('pointermove'), 0, 'C: 收掉胶囊后拖动监听也撤了')
  c.tick(FALLBACK_MS * 2)
  ok(!c.pill(), 'C: 按钮在位时胶囊不会复活')
  guard('C menu click', () => c.menuButton().dispatch('click', {}))
  ok(!!c.panel(), 'C: 迟到挂上的按钮照常能用')
  guard('C late app click', () => lateBar.appButton.dispatch('click', {}))
  ok(!c.panel(), 'C: 迟到挂上的面板也能被「应用」收掉')

  // 位置记忆 / 坏数据 / 越界夹取
  const c2 = makeEnv()
  c2.store.set(POS_KEY, JSON.stringify({ x: 40, y: 50 }))
  guard('C2 apply', () => c2.exports.apply(c2.makeCtx()))
  c2.tick(FALLBACK_MS)
  eq(c2.pill() && c2.pill().style.left, '40px', 'C: 记住的位置会被用上（left）')
  eq(c2.pill() && c2.pill().style.top, '50px', 'C: 记住的位置会被用上（top）')

  const c3 = makeEnv()
  c3.store.set(POS_KEY, '{坏掉的 JSON')
  guard('C3 apply', () => c3.exports.apply(c3.makeCtx()))
  c3.tick(FALLBACK_MS)
  eq(c3.pill() && c3.pill().style.right, '14px', 'C: 位置读坏就退回默认停靠')

  const c4 = makeEnv()
  c4.store.set(POS_KEY, JSON.stringify({ x: 99999, y: -5 }))
  guard('C4 apply', () => c4.exports.apply(c4.makeCtx()))
  c4.tick(FALLBACK_MS)
  eq(c4.pill() && c4.pill().style.left, '1202px', 'C: 越界坐标被夹回视口内（1280-76-2）')
  eq(c4.pill() && c4.pill().style.top, '2px', 'C: 负数坐标被顶回边距')

  // ── D dispose 收干净 ───────────────────────────────────────────────────
  section('D dispose：全部收干净')
  guard('D open before dispose', () => btn.dispatch('click', {}))
  ok(!!a.panel(), 'D: dispose 前面板还开着')
  guard('D dispose', () => ctx.dispose())
  ok(!a.menuButton(), 'D: 标题栏按钮摘掉')
  eq(a.shadowStyles().length, 0, 'D: 注入 shadow 的样式摘掉')
  eq(a.pageStyles().length, 0, 'D: 注入页面的样式摘掉')
  ok(!a.panel(), 'D: 未关的面板也收掉')
  eq(a.activeCount(), 0, 'D: 观察器全部断开')
  eq(a.reloadCount(), 2, 'D: dispose 不顺手刷新')
  eq(a.window.countListeners('resize'), 0, 'D: 面板的 window 监听撤掉')
  guard('D dispose twice', () => ctx.dispose())
  ok(true, 'D: 重复 dispose 不抛')

  guard('D pill dispose', () => cctx.dispose())
  ok(!c.pill(), 'D: 兜底胶囊摘掉')
  eq(c.window.countListeners('pointermove'), 0, 'D: 拖动 pointermove 撤掉')
  eq(c.window.countListeners('pointerup'), 0, 'D: 拖动 pointerup 撤掉')
  eq(c.window.countListeners('pointercancel'), 0, 'D: 拖动 pointercancel 撤掉')
  eq(c.window.countListeners('resize'), 0, 'D: 拖动 resize 撤掉')
  eq(c.activeCount(), 0, 'D: 观察器断开')
  eq(c.pageStyles().length, 0, 'D: 页面样式表撤掉')

  // ── E 健壮性（永不抛异常）──────────────────────────────────────────────
  section('E 健壮性：任何情况下都不抛')

  const e1 = makeEnv()
  e1.buildMenubar()
  guard('E1 apply(undefined)', () => e1.exports.apply(undefined))
  ok(!!e1.menuButton(), 'E: apply(undefined) 也照常挂载')

  const e2 = makeEnv()
  e2.buildMenubar()
  guard('E2 bad ctx', () => e2.exports.apply({ on() { throw new Error('ctx.on 挂了') } }))
  ok(!!e2.menuButton(), 'E: ctx.on 抛异常也不影响挂载')

  const e3 = makeEnv()
  const host3 = e3.makeElement('div')
  host3.setAttribute('data-windows-menu', '')
  e3.body.appendChild(host3)
  guard('E3 apply', () => e3.exports.apply(e3.makeCtx()))
  e3.tick(FALLBACK_MS)
  ok(!!e3.pill(), 'E: 宿主没有 shadow root 时退回胶囊')
  eq(e3.errors.length, 0, 'E: 没有内部错误', e3.errors.join(' | '))

  const e4 = makeEnv()
  const host4 = e4.makeElement('div')
  host4.setAttribute('data-windows-menu', '')
  host4.attachShadow({ mode: 'open' })
  e4.body.appendChild(host4)
  guard('E4 apply', () => e4.exports.apply(e4.makeCtx()))
  e4.tick(FALLBACK_MS)
  ok(!!e4.pill(), 'E: 菜单栏还没出现时先退回胶囊')
  const bar4 = e4.makeElement('div')
  bar4.setAttribute('role', 'menubar')
  host4.shadowRoot.appendChild(bar4)
  e4.flush()
  ok(!e4.pill(), 'E: 菜单栏一出现胶囊立刻收掉')
  ok(!!e4.menuButton(), 'E: 菜单栏一出现按钮立刻挂上')

  const e5 = makeEnv()
  const bar5 = e5.buildMenubar()
  e5.document.body = null
  guard('E5 apply', () => e5.exports.apply(e5.makeCtx()))
  ok(!e5.menuButton(), 'E: body 还没有时不挂（等 DOMContentLoaded）')
  e5.document.body = e5.body
  guard('E5 domready', () => e5.document.fire('DOMContentLoaded', {}))
  ok(!!e5.menuButton(), 'E: DOMContentLoaded 后补挂')
  eq(e5.menuButton() && e5.menuButton().parentNode, bar5.menubar, 'E: 补挂到正确的菜单栏')

  const e6 = makeEnv()
  e6.buildMenubar()
  guard('E6 apply', () => e6.exports.apply(e6.makeCtx()))
  const btn6 = e6.menuButton()
  btn6.getBoundingClientRect = () => {
    throw new Error('量不到')
  }
  guard('E6 open', () => btn6.dispatch('click', {}))
  ok(!!e6.panel(), 'E: 量不到按钮位置也照常弹出面板')

  const e7 = makeEnv()
  e7.window.localStorage.getItem = () => {
    throw new Error('denied')
  }
  e7.window.localStorage.setItem = () => {
    throw new Error('denied')
  }
  guard('E7 apply', () => e7.exports.apply(e7.makeCtx()))
  e7.tick(FALLBACK_MS)
  ok(!!e7.pill(), 'E: localStorage 不可用也有胶囊')
  guard('E7 drag', () => {
    const p = e7.pill()
    p._left = 100
    p._top = 100
    p.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 2, button: 0 })
    e7.window.fire('pointermove', { clientX: 240, clientY: 180, pointerId: 2 })
    e7.window.fire('pointerup', { pointerId: 2 })
  })
  ok(!!e7.pill(), 'E: localStorage 不可用时拖动不抛')
  eq(e7.errors.length, 0, 'E: 没有内部错误', e7.errors.join(' | '))

  const e8 = makeEnv()
  e8.buildMenubar()
  guard('E8 apply', () => e8.exports.apply(e8.makeCtx()))
  delete e8.window.caches
  e8.window.navigator = {}
  const btn8 = e8.menuButton()
  guard('E8 open', () => btn8.dispatch('click', {}))
  guard('E8 hard', () => e8.panelItems()[1].dispatch('click', {}))
  await e8.flushMicro()
  eq(e8.reloadCount(), 1, 'E: 没有 caches / serviceWorker 也照样重载')

  const e9 = makeEnv()
  e9.buildMenubar()
  e9.window.innerWidth = 0
  e9.window.innerHeight = 0
  guard('E9 apply', () => e9.exports.apply(e9.makeCtx()))
  const btn9 = e9.menuButton()
  btn9._left = 5000
  btn9._top = 5000
  guard('E9 open', () => btn9.dispatch('click', {}))
  const panel9 = e9.panel()
  ok(!!panel9, 'E: 视口读成 0 也能弹出面板')
  ok(!!panel9 && /px$/.test(panel9.style.left) && /px$/.test(panel9.style.top), 'E: 用回退视口尺寸并写成 px')

  const e10 = makeEnv()
  const bar10 = e10.buildMenubar()
  guard('E10 apply', () => e10.exports.apply(e10.makeCtx()))
  ok(!!e10.menuButton(), 'E10: 先正常挂上')
  e10.body.removeChild(bar10.host)
  e10.flush()
  ok(!e10.menuButton(), 'E: 菜单条被摘掉后我们那颗按钮也收掉')
  e10.body.appendChild(bar10.host)
  e10.flush()
  ok(!!e10.menuButton(), 'E: 菜单条回来后按钮自动补回')
  eq(e10.ourButtons().length, 1, 'E: 补回后仍然只有一颗')
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length) {
  console.log('失败项：')
  for (const line of failures) console.log('  ✗ ' + line)
}
console.log(`自检：${pass} 项通过 / ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
