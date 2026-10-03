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
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as plan from '../lib/restart-plan.js'
import * as helper from '../lib/restart-helper.js'

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

/** 断言失败时的可读值：DOM 替身有环形引用，不能直接 JSON.stringify。 */
function fmt(value) {
  try {
    if (value === null || value === undefined) return String(value)
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'object') {
      const tag = value.tagName ? '<' + String(value.tagName).toLowerCase() + '>' : Object.prototype.toString.call(value)
      const id = value.getAttribute ? value.getAttribute('data-dsh-ui-refresh-item') : ''
      return tag + (id ? '[' + id + ']' : '')
    }
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function eq(actual, expected, name) {
  ok(
    Object.is(actual, expected),
    name,
    actual === expected ? '' : `期望 ${fmt(expected)}，实际 ${fmt(actual)}`,
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
  const state = { reloadCount: 0, cachesCleared: 0, swUnregistered: 0, windowCloseCalls: 0, shortcutCloseCalls: 0, injectCalls: [] }
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
    /** 优雅重启靠"关掉窗口"让外壳自己退出，所以这里要能数到它被调了几次。 */
    close() {
      state.windowCloseCalls += 1
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
  // fetch 替身（「重启应用」用）：默认 200 { ok: true }，可切换成各种失败
  const fetchState = { calls: [], mode: 'ok' }
  function fakeFetch(url, options) {
    fetchState.calls.push({ url: url, options: options })
    switch (fetchState.mode) {
      case 'throw':
        throw new Error('同步抛出的网络错误')
      case 'reject':
        return Promise.reject(new Error('网络不可达'))
      case '405':
        return Promise.resolve({ ok: false, status: 405, json: async () => ({ error: '只接受 POST' }) })
      case '409':
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: '正在重启' }) })
      case 'nojson':
        return Promise.resolve({ ok: true, status: 200 })
      default:
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, helperPid: 4242 }) })
    }
  }
  win.fetch = fakeFetch

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
    fetch: fakeFetch,
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
    /**
     * 假 ctx。
     *   · `options.shortcuts` —— 当作外壳里有客户端快捷键服务（优雅重启要靠它关窗）；
     *   · `options.noInject`  —— 当作老宿主 / web 端，连 `ctx.inject` 都没有。
     */
    makeCtx(options) {
      const opts = options || {}
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
      if (opts.shortcuts !== undefined) ctx.shortcuts = opts.shortcuts
      if (!opts.noInject) {
        ctx.inject = function inject(deps, run) {
          state.injectCalls.push(Array.isArray(deps) ? deps.slice() : [])
          if (typeof run === 'function') {
            try {
              run(ctx)
            } catch (err) {
              errors.push('inject: ' + (err && err.message ? err.message : String(err)))
            }
          }
          return () => {}
        }
      }
      return ctx
    },
    /** 假的外壳快捷键服务：`closeWindow()` 记一笔，`reject` 时模拟桥不可用。 */
    makeShortcuts(options) {
      const opts = options || {}
      return {
        closeWindow() {
          state.shortcutCloseCalls += 1
          if (opts.reject) return Promise.reject(new Error('Desktop keyboard bridge unavailable'))
          return Promise.resolve()
        },
      }
    },
    injectCalls: () => state.injectCalls.slice(),
    windowCloseCalls: () => state.windowCloseCalls,
    shortcutCloseCalls: () => state.shortcutCloseCalls,
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
    fetchCalls: () => fetchState.calls.slice(),
    setFetchMode(mode) {
      fetchState.mode = mode
    },
    /** 模拟"这台宿主压根没有 fetch"（老宿主 / 非浏览器环境）。 */
    dropFetch() {
      delete sandbox.fetch
      delete win.fetch
    },
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
  eq(items.length, 3, 'B: 三个菜单项')
  eq(items[0] && items[0].getAttribute('data-dsh-ui-refresh-item'), 'reload', 'B: 第一项 id=reload')
  eq(items[1] && items[1].getAttribute('data-dsh-ui-refresh-item'), 'hard', 'B: 第二项 id=hard')
  eq(items[2] && items[2].getAttribute('data-dsh-ui-refresh-item'), 'restart', 'B: 第三项 id=restart')
  eq(items[0] && items[0].textContent, '刷新界面', 'B: 第一项文案「刷新界面」')
  eq(items[1] && items[1].textContent, '清空缓存并刷新', 'B: 第二项文案「清空缓存并刷新」')
  eq(items[2] && items[2].textContent, '重启应用', 'B: 第三项文案「重启应用」')
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
  eq(arrowItems.length, 3, 'B: 方向键测试时三个菜单项都在')
  guard('B down', () => a.document.fire('keydown', { key: 'ArrowDown' }))
  eq(a.document.activeElement, arrowItems[1], 'B: ↓ 移到第二项')
  guard('B down', () => a.document.fire('keydown', { key: 'ArrowDown' }))
  eq(a.document.activeElement, arrowItems[2], 'B: ↓ 移到第三项')
  guard('B down', () => a.document.fire('keydown', { key: 'ArrowDown' }))
  eq(a.document.activeElement, arrowItems[0], 'B: ↓ 到底回绕到第一项')
  guard('B up', () => a.document.fire('keydown', { key: 'ArrowUp' }))
  eq(a.document.activeElement, arrowItems[2], 'B: ↑ 从第一项回绕到最末一项')
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

  // ── B2 「重启应用」：点一下只进确认，点第二下才发请求 ────────────────────
  guard('B open8', () => btn.dispatch('click', {}))
  const restartItem = a.panelItems()[2]
  ok(!!restartItem, 'B2: 面板里有第三项（重启应用）')
  guard('B restart arm', () => restartItem.dispatch('click', {}))
  eq(a.fetchCalls().length, 0, 'B2: 第一下只进确认状态，不发重启请求')
  eq(restartItem.textContent, '再次点击确认重启', 'B2: 第一下把文案换成二次确认')
  ok(!!a.panel(), 'B2: 确认状态下面板不关（keepOpen）')

  guard('B restart go', () => restartItem.dispatch('click', {}))
  eq(a.fetchCalls().length, 1, 'B2: 第二下才发出一次重启请求')
  const restartCall = a.fetchCalls()[0] || {}
  eq(restartCall.url, '/dsh-ui-refresh/api/v1/restart', 'B2: 请求打到插件自己的重启路由')
  eq(restartCall.options && restartCall.options.method, 'POST', 'B2: 用 POST')
  eq(restartCall.options && restartCall.options.credentials, 'same-origin', 'B2: 带 same-origin 凭据')
  const restartBody =
    restartCall.options && typeof restartCall.options.body === 'string' ? JSON.parse(restartCall.options.body) : null
  eq(restartBody && restartBody.mode, 'graceful', 'B2: 请求体声明走优雅方式（不让宿主自杀）')
  await a.flushMicro()
  eq(restartItem.textContent, '正在重启…', 'B2: 宿主回 200 后显示「正在重启…」')
  eq(a.windowCloseCalls(), 1, 'B2: 拿到 200 立刻请外壳关窗（没有快捷键服务时退回 window.close）')
  a.tick(4200)
  eq(restartItem.textContent, '重启应用', 'B2: 提示停留几秒后自己复原成「重启应用」')
  eq(a.fetchCalls().length, 2, 'B2: 关窗没人理时，2.6 秒后自动补一次兜底请求')
  const forceBody =
    a.fetchCalls()[1] && a.fetchCalls()[1].options && typeof a.fetchCalls()[1].options.body === 'string'
      ? JSON.parse(a.fetchCalls()[1].options.body)
      : null
  eq(forceBody && forceBody.mode, 'force', 'B2: 兜底那次明确要求宿主自己退（mode=force）')
  eq(a.windowCloseCalls(), 2, 'B2: 1.2 秒时又补关了一次窗')

  // 二次确认 3 秒后自己失效
  guard('B restart rearm', () => restartItem.dispatch('click', {}))
  eq(restartItem.textContent, '再次点击确认重启', 'B2: 又进入确认状态')
  a.tick(3100)
  eq(restartItem.textContent, '重启应用', 'B2: 3 秒不点，确认状态过期复原')
  eq(a.fetchCalls().length, 2, 'B2: 过期不算确认，没有多打请求（那 2 次是重启 + 关窗兜底）')

  // 关面板要撤销确认状态
  guard('B restart arm2', () => restartItem.dispatch('click', {}))
  guard('B restart esc', () => a.document.fire('keydown', { key: 'Escape' }))
  ok(!a.panel(), 'B2: Escape 收面板')
  guard('B open9', () => btn.dispatch('click', {}))
  eq(a.panelItems()[2] && a.panelItems()[2].textContent, '重启应用', 'B2: 关面板会把确认状态清掉')

  // 宿主拒绝 / 网络失败时的提示
  a.setFetchMode('405')
  guard('B restart 405 arm', () => a.panelItems()[2].dispatch('click', {}))
  guard('B restart 405 go', () => a.panelItems()[2].dispatch('click', {}))
  await a.flushMicro()
  eq(a.panelItems()[2] && a.panelItems()[2].textContent, '只接受 POST', 'B2: 宿主拒绝时显示它给的原因')
  a.setFetchMode('reject')
  guard('B restart err arm', () => a.panelItems()[2].dispatch('click', {}))
  guard('B restart err go', () => a.panelItems()[2].dispatch('click', {}))
  await a.flushMicro()
  eq(a.panelItems()[2] && a.panelItems()[2].textContent, '重启请求没发出去', 'B2: 网络失败时的提示')
  a.setFetchMode('throw')
  guard('B restart throw arm', () => a.panelItems()[2].dispatch('click', {}))
  guard('B restart throw go', () => a.panelItems()[2].dispatch('click', {}))
  await a.flushMicro()
  eq(a.panelItems()[2] && a.panelItems()[2].textContent, '重启请求没发出去', 'B2: fetch 同步抛异常也不炸')
  a.setFetchMode('ok')
  guard('B restart ok arm', () => a.panelItems()[2].dispatch('click', {}))
  guard('B restart ok go', () => a.panelItems()[2].dispatch('click', {}))
  await a.flushMicro()
  eq(a.panelItems()[2] && a.panelItems()[2].textContent, '正在重启…', 'B2: 复位后再点仍然正常')
  guard('B2 close', () => a.document.fire('keydown', { key: 'Escape' }))
  ok(!a.panel(), 'B2: 收尾把面板收掉（D 段要从关闭状态开始）')
  eq(a.errors.length, 0, 'B2: 重启流程里没有内部错误', a.errors.join(' | '))

  // ── B3 优雅重启：优先请外壳关窗（官方那条关闭窗口命令），服务不在才退回 window.close ──
  section('B3 优雅重启：关窗服务 / 兜底')
  const b3 = makeEnv()
  b3.buildMenubar()
  const b3ctx = b3.makeCtx({ shortcuts: b3.makeShortcuts() })
  guard('B3 apply', () => b3.exports.apply(b3ctx))
  eq(b3.injectCalls().length, 1, 'B3: 只做了一次运行时注入')
  eq(b3.injectCalls()[0].join(','), 'shortcuts', 'B3: 注入的正是 shortcuts 服务')
  const b3btn = b3.menuButton()
  ok(!!b3btn, 'B3: 标题栏按钮挂上了')
  guard('B3 open', () => b3btn.dispatch('click', {}))
  const b3item = b3.panelItems()[2]
  guard('B3 arm', () => b3item.dispatch('click', {}))
  guard('B3 go', () => b3item.dispatch('click', {}))
  await b3.flushMicro()
  eq(b3.shortcutCloseCalls(), 1, 'B3: 先请外壳的关窗服务（官方「关闭窗口」走的就是它）')
  eq(b3.windowCloseCalls(), 1, 'B3: 紧接着也补一次 window.close()（revision 对不上时只有这条管用）')
  b3.tick(1200)
  eq(b3.shortcutCloseCalls(), 2, 'B3: 1.2 秒还没掉线就再请一次')
  eq(b3.windowCloseCalls(), 2, 'B3: 补关那次同样两条路都走')
  b3.tick(1500)
  eq(b3.fetchCalls().length, 2, 'B3: 窗口关不掉时退回让宿主自己退')
  eq(JSON.parse(b3.fetchCalls()[1].options.body).mode, 'force', 'B3: 兜底那次是 mode=force')
  eq(b3.errors.length, 0, 'B3: 优雅重启流程没有内部错误', b3.errors.join(' | '))
  const b3before = b3.fetchCalls().length
  guard('B3 dispose', () => b3ctx.dispose())
  b3.tick(20000)
  eq(b3.fetchCalls().length, b3before, 'B3: dispose 之后关窗兜底的定时器全清掉')

  // 桥报错（服务存在但调用失败）也不能把这颗按钮弄坏
  const b4 = makeEnv()
  b4.buildMenubar()
  const b4ctx = b4.makeCtx({ shortcuts: b4.makeShortcuts({ reject: true }) })
  guard('B4 apply', () => b4.exports.apply(b4ctx))
  const b4btn = b4.menuButton()
  guard('B4 open', () => b4btn.dispatch('click', {}))
  guard('B4 arm', () => b4.panelItems()[2].dispatch('click', {}))
  guard('B4 go', () => b4.panelItems()[2].dispatch('click', {}))
  await b4.flushMicro()
  eq(b4.shortcutCloseCalls(), 1, 'B4: 关窗被拒也照样请求过一次')
  eq(b4.windowCloseCalls(), 1, 'B4: 关窗服务就算报错，window.close() 也照样补上')
  eq(b4.errors.length, 0, 'B4: 关窗被拒不会变成内部错误', b4.errors.join(' | '))
  guard('B4 dispose', () => b4ctx.dispose())

  // 老宿主 / web 端：连 ctx.inject 都没有
  const b5 = makeEnv()
  b5.buildMenubar()
  const b5ctx = b5.makeCtx({ noInject: true })
  guard('B5 apply', () => b5.exports.apply(b5ctx))
  ok(!!b5.menuButton(), 'B5: 没有 ctx.inject 也照挂按钮')
  eq(b5.errors.length, 0, 'B5: 没有 ctx.inject 时不报错', b5.errors.join(' | '))
  guard('B5 dispose', () => b5ctx.dispose())

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

// ── F 包声明（2026-10-03 实测的坑：没声明 dsh.bundle 的包，内核与市场都拒绝安装）──
// 依据（本机内核 / 市场源码）：
//   · @deepseek-ai/dsh-plugin-manager lib/index.js:1785-1786 —— pnpm 装完后
//     bundleManifest() 读不到 dsh.bundle 就 ManagementFailure('not-bundle') 并把
//     dependencies 回滚，界面上是「这个包没有声明组合包，不能作为插件管理」；
//   · dshmarket lib/hot.js:543-555 —— client-only shim 只对**已经躺在 dependencies 里**
//     的包生效（mountClientOnlyDeps 每次市场启动扫一遍），安装入口不认它；
//   · dshmarket lib/hot.js:721 —— 热挂载只接受纯 insert 的 patch，含配置行/表达式就得重启。
{
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const dsh = pkg.dsh || {}
  eq(pkg.name, 'dsh-ui-refresh', 'F: 包名')
  ok(typeof pkg.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkg.version), 'F: 版本是三段式')
  ok(!!dsh.client, 'F: 声明 dsh.client（浏览器半边才会被送进页面）')
  eq(dsh.client ? dsh.client.platform : undefined, 'web', 'F: 平台是 web')
  eq(dsh.bundle ? dsh.bundle.patch : undefined, './cordis.patch.yml', 'F: 声明 dsh.bundle.patch（缺它被判 not-bundle，安装直接失败）')
  ok(Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'), 'F: files 里带上 patch 文件（否则装到本机也缺它）')
  eq(pkg.exports && pkg.exports['./client'] ? pkg.exports['./client'].default : undefined, './lib/client.js', 'F: exports ./client 指向 lib/client.js')

  let patch = ''
  let patchRead = false
  try {
    patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
    patchRead = true
  } catch {}
  ok(patchRead, 'F: cordis.patch.yml 真的存在')
  const patchLines = patch.split('\n')
  ok(/^- insert:\s*$/.test(patchLines[0] || ''), 'F: patch 第一条是顶层 insert')
  ok(/^\s{4}- id: ui-refresh\s*$/.test(patchLines[1] || ''), 'F: insert 条目的 id')
  ok(/^\s{6}name: 'dsh-ui-refresh'\s*$/.test(patchLines[2] || ''), 'F: insert 条目的 name 是包名')
  eq(patch.split('\n').filter((line) => line.trim() !== '').length, 3, 'F: 只有三行数据（纯 insert）')
  ok(!/[={}]/.test(patch.slice(patch.indexOf('insert:'))), 'F: insert 里没有配置行/表达式（纯 insert 才能热挂载）')
  ok(!/[一-龥]/.test(patch), 'F: patch 里没有中文')

  const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  ok(/export const inject = \[\]/.test(host), 'F: 宿主半边顶层 inject 为空数组（有 inject 缺服务会让整个 GUI 起不来）')
  ok(/export function apply\(\s*ctx\s*\)/.test(host), 'F: 宿主半边 apply 接收 ctx')
  ok(/ctx\.inject\(/.test(host), 'F: 宿主半边只用运行时 ctx.inject 拿 webServer')

  const hostModule = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
  ok(typeof hostModule.apply === 'function', 'F: 宿主半边导出 apply 函数')
  ok(Array.isArray(hostModule.inject) && hostModule.inject.length === 0, 'F: 宿主半边 inject 运行时是空数组')
  eq(hostModule.name, 'dsh-ui-refresh', 'F: 宿主半边包名')
  let threw = ''
  const badContexts = [undefined, null, {}, { inject() { throw new Error('boom') } }, { inject: 42 }]
  for (const bad of badContexts) {
    try {
      hostModule.apply(bad)
    } catch (err) {
      threw = threw || String((err && err.message) || err)
    }
  }
  eq(threw, '', 'F: 宿主半边 apply 对任何 ctx 都不抛（抛了会拦掉整个 GUI）')
}

// ── G 重启计划：路径常量 / 计划构造与校验 / 同源判据 ──────────────────────
section('G 重启计划：路径 / 计划 / 同源判据')
{
  eq(plan.API_PATH, '/dsh-ui-refresh/api/v1/restart', 'G: 重启路由常量')
  ok(plan.API_PATH.startsWith('/'), 'G: 路由是绝对路径')
  eq(plan.PLAN_SCHEMA, 1, 'G: 计划 schema = 1')
  eq(plan.CONFIRM_MS, 3000, 'G: 二次确认窗口 3 秒')
  eq(plan.EXIT_TIMEOUT_MS, 30000, 'G: 等旧进程退出的上限 30 秒')
  eq(plan.PROBE_MS, 2500, 'G: 起完新进程观察 2.5 秒')
  eq(plan.RESTART_IDLE_MS, 90000, 'G: 优雅重启挂起 90 秒后自愈放开（比助手的 60 秒宽）')

  // 客户端半边把路径写死在自己的 bundle 里（两个半边各写一份），这里盯着两者一致
  const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  ok(clientSrc.indexOf(`'${plan.API_PATH}'`) >= 0, 'G: 客户端里写死的路径与 API_PATH 一致')

  ok(plan.isLoopbackAuthority('127.0.0.1'), 'G: 127.0.0.1 是回环')
  ok(plan.isLoopbackAuthority('localhost'), 'G: localhost 是回环')
  ok(plan.isLoopbackAuthority('[::1]'), 'G: [::1] 是回环')
  ok(plan.isLoopbackAuthority('LOCALHOST:19387'), 'G: 大写 + 端口也认')
  ok(plan.isLoopbackAuthority('[::1]:19387'), 'G: IPv6 + 端口也认')
  ok(!plan.isLoopbackAuthority('localhost.evil.com'), 'G: localhost.evil.com 不是回环')
  ok(!plan.isLoopbackAuthority('192.168.1.9:19387'), 'G: 局域网地址不是回环')
  ok(!plan.isLoopbackAuthority(''), 'G: 空 Host 不是回环')
  ok(!plan.isLoopbackAuthority(undefined), 'G: 没有 Host 不是回环')

  ok(plan.isSameOriginRequest({}), 'G: 一个头都没有也放行（桌面外壳代理会剥掉 Host/Origin）')
  ok(plan.isSameOriginRequest({ host: '127.0.0.1:19387' }), 'G: 只有回环 Host 放行')
  ok(plan.isSameOriginRequest({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), 'G: Host 与 Origin 同源放行')
  ok(!plan.isSameOriginRequest({ host: 'evil.com' }), 'G: 非回环 Host 拒绝')
  ok(!plan.isSameOriginRequest({ host: '127.0.0.1:19387', origin: 'http://evil.com' }), 'G: Origin 与 Host 不同源拒绝')
  ok(!plan.isSameOriginRequest({ host: '127.0.0.1:19387', origin: 'null' }), 'G: Origin: null 拒绝')
  ok(!plan.isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }), 'G: 跨站声明直接拒绝')
  ok(plan.isSameOriginRequest({ host: 'localhost:19387', 'sec-fetch-site': 'same-origin' }), 'G: 同站声明放行')

  ok(plan.isDesktopHost({ electron: '38.0.0' }), 'G: versions.electron 有值即桌面端')
  ok(!plan.isDesktopHost({ node: '22.0.0' }), 'G: 纯 node 宿主不算桌面端')
  ok(!plan.isDesktopHost(undefined), 'G: versions 缺失也不算')

  const made = plan.buildPlan({
    pid: 4242,
    argv: ['C:\\App\\app.exe', '--expose-internals', 'host.js', 'profile'],
    execPath: 'C:\\App\\app.exe',
    cwd: 'C:\\App',
    planPath: 'C:\\home\\.dsh\\ui-refresh\\restart-plan.json',
    logPath: 'C:\\home\\.dsh\\ui-refresh\\restart.log',
    electron: true,
    now: new Date('2026-10-03T00:00:00.000Z'),
  })
  eq(made.schema, 1, 'G: 计划带 schema')
  eq(made.pid, 4242, 'G: 计划记住旧 pid')
  eq(made.mode, 'force', 'G: 不传 mode 时按兜底方式（老客户端 / 老计划兼容）')
  eq(made.shellPid, null, 'G: 没给 shellPid 就不记（只能等宿主自己）')
  eq(made.args.length, 3, 'G: argv[0] 与 execPath 相同时会被切掉')
  eq(made.args[0], '--expose-internals', 'G: 剩下的参数原样保留')
  eq(made.createdAt, '2026-10-03T00:00:00.000Z', 'G: 时间戳可注入（测试要能假装时间）')
  eq(made.fallback && made.fallback.cwd, 'C:\\App', 'G: Electron 桌面的兜底 = exe 自己所在目录')
  eq(made.fallback && made.fallback.args.length, 0, 'G: 兜底不带任何参数（等同双击图标）')
  const webPlan = plan.buildPlan({
    pid: 1,
    argv: ['node', 'x.js'],
    execPath: '/usr/bin/node',
    cwd: '/tmp',
    planPath: 'p',
    logPath: 'l',
    electron: false,
  })
  eq(webPlan.fallback, null, 'G: 非 Electron / 非 exe 宿主不给兜底命令')

  const graceful = plan.buildPlan({
    pid: 4242,
    shellPid: 5555,
    argv: ['C:\\App\\app.exe', '--expose-internals', 'host.js', 'profile'],
    execPath: 'C:\\App\\app.exe',
    cwd: 'C:\\App',
    planPath: 'C:\\home\\.dsh\\ui-refresh\\restart-plan.json',
    logPath: 'C:\\home\\.dsh\\ui-refresh\\restart.log',
    mode: 'graceful',
    electron: true,
  })
  eq(graceful.mode, 'graceful', 'G: 优雅方式记进计划')
  eq(graceful.shellPid, 5555, 'G: 优雅方式记下外壳 pid（要等它退）')
  eq(
    plan.buildPlan({
      pid: 4242,
      shellPid: 4242,
      argv: ['a'],
      execPath: 'C:\\App\\app.exe',
      cwd: 'C:\\App',
      planPath: 'p',
      logPath: 'l',
      mode: 'graceful',
      electron: true,
    }).shellPid,
    null,
    'G: shellPid 与自己相同就当没给（否则会等自己）',
  )
  eq(plan.normalizeMode('graceful'), 'graceful', 'G: 认识 graceful')
  eq(plan.normalizeMode('force'), 'force', 'G: 认识 force')
  eq(plan.normalizeMode(undefined), 'force', 'G: 缺省回兜底方式')
  eq(plan.normalizeMode('乱写的'), 'force', 'G: 不认识的 mode 也回兜底方式，不报错')
  eq(plan.exitTimeoutFor(made), 30000, 'G: 兜底方式最多等 30 秒')
  eq(plan.exitTimeoutFor(graceful), 60000, 'G: 优雅方式多等一会儿（用户可能要手点一下「退出」）')
  const forceTargets = plan.waitTargetsFor(made)
  eq(forceTargets.length, 1, 'G: 兜底方式只等一个进程')
  eq(forceTargets[0].pid, 4242, 'G: 兜底方式等的是宿主自己')
  eq(forceTargets[0].label, '宿主进程', 'G: 标签写清等的是谁')
  const graceTargets = plan.waitTargetsFor(graceful)
  eq(graceTargets.length, 1, 'G: 优雅方式也只等一个进程')
  eq(graceTargets[0].pid, 5555, 'G: 优雅方式等外壳进程（单实例锁在它手里）')
  eq(graceTargets[0].label, '外壳进程', 'G: 优雅方式的标签是外壳进程')

  eq(plan.validatePlan(made).ok, true, 'G: 自家造的计划能过校验')
  eq(plan.validatePlan(made).plan, made, 'G: 校验通过时把计划原样返回')

  const badPlans = [
    [null, '不是对象'],
    [[], '是数组'],
    [{ ...made, schema: 2 }, 'schema 版本不对'],
    [{ ...made, pid: 0 }, 'pid 为 0'],
    [{ ...made, pid: 1.5 }, 'pid 不是整数'],
    [{ ...made, execPath: 'relative.exe' }, 'execPath 不是绝对路径'],
    [{ ...made, args: ['ok', 42] }, 'args 里有非字符串'],
    [{ ...made, cwd: '' }, 'cwd 为空'],
    [{ ...made, fallback: { execPath: 1 } }, 'fallback 不合法'],
    [{ ...made, mode: 'graceful-ish' }, 'mode 不认识'],
    [{ ...made, shellPid: 0 }, 'shellPid 为 0'],
    [{ ...made, shellPid: '5555' }, 'shellPid 是字符串'],
  ]
  for (const [value, why] of badPlans) {
    const verdict = plan.validatePlan(value)
    ok(
      verdict.ok === false && typeof verdict.reason === 'string' && verdict.reason.length > 0,
      `G: 拒绝不合法的计划 —— ${why}`,
    )
  }
  eq(plan.validatePlan({ ...made, fallback: null }).ok, true, 'G: fallback 允许是 null')
  eq(plan.validatePlan({ ...made, fallback: undefined }).ok, true, 'G: fallback 允许缺省')
  eq(plan.validatePlan({ ...made, mode: undefined }).ok, true, 'G: mode 缺省也合法')
  eq(plan.validatePlan({ ...made, shellPid: null }).ok, true, 'G: shellPid 允许是 null')
  eq(plan.validatePlan({ ...made, shellPid: undefined }).ok, true, 'G: shellPid 允许缺省')

  const summary = plan.planSummary(made)
  ok(summary.indexOf('pid=4242') >= 0 && summary.indexOf('args=3') >= 0, 'G: 摘要里带 pid 与参数个数')
  ok(/mode=force/.test(summary) && /shell=-/.test(summary), 'G: 摘要里带方式，没有外壳 pid 就画一个 -')
  ok(/fallback=yes/.test(summary), 'G: 摘要标出有兜底命令')
  const gracefulSummary = plan.planSummary(graceful)
  ok(/mode=graceful/.test(gracefulSummary) && /shell=5555/.test(gracefulSummary), 'G: 优雅方式的摘要如实标出')
  ok(/fallback=no/.test(plan.planSummary(webPlan)), 'G: 没有兜底时标 no')
  const line = plan.logLine('helper', 'hi', new Date('2026-10-03T00:00:00.000Z'))
  eq(line, '2026-10-03T00:00:00.000Z [helper] hi\n', 'G: 日志行 = ISO 时间 + 级别 + 内容')
}

// ── H 宿主半边：重启路由（状态码 / 计划 / 助手启动 / 退出时机）────────────
section('H 宿主半边：重启路由')
{
  const hostModule = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
  const planDir = join('C:\\home', '.dsh', 'ui-refresh')
  const expectedPlanPath = join(planDir, 'restart-plan.json')

  function makeHost(overrides) {
    const state = { registered: [], effects: [], plans: [], logs: [], spawns: [], exited: [], later: [] }
    const webServer = {
      register(route) {
        state.registered.push(route)
        return () => {
          state.removed = (state.removed ?? 0) + 1
        }
      },
    }
    const ctx = {
      webServer,
      effect(fn, label) {
        state.effects.push(label)
        return fn()
      },
    }
    state.disposer = hostModule.registerRestartRoute(ctx, {
      spawnFn(execPath, args, options) {
        const child = {
          pid: 7000 + state.spawns.length,
          unrefCalled: false,
          unref() {
            this.unrefCalled = true
            return this
          },
        }
        state.spawns.push({ execPath, args, options, child })
        return child
      },
      mkdir() {},
      writeFile(file, text) {
        state.plans.push({ file, text })
      },
      appendFile(file, text) {
        state.logs.push(text)
      },
      versions: { electron: '38.0.0' },
      argv: ['C:\\App\\app.exe', '--expose-internals', 'host.js'],
      execPath: 'C:\\App\\app.exe',
      cwd: 'C:\\App',
      env: { DSH_HOME: 'C:\\home', ELECTRON_RUN_AS_NODE: '1' },
      home: 'C:\\home',
      pid: 4242,
      later(fn) {
        state.later.push(fn)
        return state.later.length
      },
      exit(code) {
        state.exited.push(code)
      },
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      ...(overrides ?? {}),
    })
    state.route = state.registered[0]
    return state
  }

  function makeReq(method, headers) {
    return { method, headers: headers ?? {} }
  }
  /** 带请求体的假 request：handler 会挂上 data/end 监听，测完由 `req.feed()` 手动喂给它。 */
  function makeBodyReq(method, headers, body, options) {
    const opts = options ?? {}
    const req = { method, headers: headers ?? {}, handlers: {} }
    req.on = (type, fn) => {
      req.handlers[type] = fn
    }
    req.feed = () => {
      for (const chunk of opts.chunks ?? [body]) {
        if (req.handlers.data) req.handlers.data(chunk)
      }
      if (opts.end !== false && req.handlers.end) req.handlers.end()
    }
    return req
  }
  function makeRes() {
    const res = { status: null, headers: null, body: '', finished: [] }
    res.writeHead = (status, headers) => {
      res.status = status
      res.headers = headers
    }
    res.end = (text) => {
      res.body = text
    }
    res.on = (type, fn) => {
      if (type === 'finish') res.finished.push(fn)
    }
    res.finish = () => {
      for (const fn of res.finished) fn()
    }
    return res
  }

  const h = makeHost()
  eq(h.effects.length, 1, 'H: 用 effect 注册路由（宿主 dispose 时自动摘掉）')
  eq(h.route && h.route.kind, 'exact', 'H: 路由是 exact')
  eq(h.route && h.route.path, plan.API_PATH, 'H: 路由路径与客户端写死的那条一致')
  eq(typeof (h.route && h.route.handler), 'function', 'H: 路由带 handler')

  const res405 = makeRes()
  h.route.handler(makeReq('GET', { host: '127.0.0.1:19387' }), res405)
  eq(res405.status, 405, 'H: 非 POST 回 405')
  eq(res405.headers && res405.headers.allow, 'POST', 'H: 405 带 Allow: POST')
  eq(h.spawns.length, 0, 'H: 非 POST 不会拉起助手')

  const res403 = makeRes()
  h.route.handler(makeReq('POST', { host: 'evil.com' }), res403)
  eq(res403.status, 403, 'H: 非回环 Host 回 403')
  eq(h.spawns.length, 0, 'H: 403 不会拉起助手')

  const h501 = makeHost({ versions: { node: '22.0.0' } })
  const res501 = makeRes()
  h501.route.handler(makeReq('POST', { host: '127.0.0.1:19387' }), res501)
  eq(res501.status, 501, 'H: 纯 node 宿主回 501（web 端有市场自带的重启）')
  eq(h501.spawns.length, 0, 'H: 501 不会拉起助手')

  const okHost = makeHost()
  const res200 = makeRes()
  okHost.route.handler(makeReq('POST', { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), res200)
  eq(res200.status, 200, 'H: 正常请求回 200')
  const payload = JSON.parse(res200.body)
  eq(payload.ok, true, 'H: 回 { ok: true }')
  eq(payload.helperPid, 7000, 'H: 回助手 pid（便于用户去任务管理器看）')
  eq(payload.fallback, true, 'H: 告诉客户端有没有兜底命令')
  eq(payload.mode, 'force', 'H: 没带 mode 的请求（老客户端）按兜底方式')
  eq(res200.headers && res200.headers['cache-control'], 'no-store', 'H: 不许缓存这个响应')
  eq(okHost.spawns.length, 1, 'H: 只拉起一个助手')
  const spawnCall = okHost.spawns[0]
  eq(spawnCall.execPath, 'C:\\App\\app.exe', 'H: 用同一个可执行文件起助手')
  eq(spawnCall.args[0], hostModule.HELPER_PATH, 'H: 第一个参数是助手的绝对路径')
  eq(spawnCall.args[1], expectedPlanPath, 'H: 第二个参数是计划文件')
  eq(spawnCall.options.detached, true, 'H: 助手要 detached（否则会跟着我一起死）')
  eq(spawnCall.options.stdio, 'ignore', 'H: 助手不要管道（我一退管道就断）')
  eq(spawnCall.options.cwd, planDir, 'H: 助手在计划目录里跑')
  eq(spawnCall.options.env.ELECTRON_RUN_AS_NODE, '1', 'H: 助手用 Electron 二进制当 node 跑')
  eq(spawnCall.options.env.DSH_HOME, 'C:\\home', 'H: 环境原样继承（助手要落在同一个 profile）')
  eq(spawnCall.child.unrefCalled, true, 'H: 助手被 unref（不拖住我退出）')
  eq(okHost.plans.length, 1, 'H: 写了一张计划')
  const written = JSON.parse(okHost.plans[0].text)
  eq(written.pid, 4242, 'H: 计划里记的是宿主自己的 pid')
  eq(written.execPath, 'C:\\App\\app.exe', 'H: 计划记下可执行文件')
  eq(written.args.length, 2, 'H: 计划记下原样参数')
  eq(written.fallback !== null, true, 'H: 计划带兜底命令')
  eq(written.mode, 'force', 'H: 计划里记下这次是哪一种方式')
  eq(written.shellPid, process.ppid, 'H: 记下外壳 pid（优雅方式要等它退出）')
  ok(okHost.logs.join('').indexOf('收到重启请求') >= 0, 'H: 写了一条"收到请求"日志')

  // 挂起期内又来一次优雅请求：幂等 200（用户窗口没关成、又点了一遍按钮就是这条）
  const againReq = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"graceful"}')
  const resAgain = makeRes()
  okHost.route.handler(againReq, resAgain)
  againReq.feed()
  eq(resAgain.status, 200, 'H: 挂起期内重复的优雅请求回 200（0.3.1 回 409 会把用户彻底卡住）')
  eq(JSON.parse(resAgain.body).already, true, 'H: 幂等回包带 already 标记')
  eq(okHost.spawns.length, 1, 'H: 幂等分支不会多拉一个助手')
  eq(okHost.later.length, 0, 'H: 幂等分支不排自杀延时')

  // force 是"窗口关不掉"时的最后手段：挂起期内也永远放行（0.3.1 在这里被 409 堵死）
  const forceReq900 = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"force"}')
  const resForce900 = makeRes()
  okHost.route.handler(forceReq900, resForce900)
  forceReq900.feed()
  eq(resForce900.status, 200, 'H: 挂起期内 force 照样放行')
  eq(JSON.parse(resForce900.body).mode, 'force', 'H: 回包说这次是 force')
  eq(okHost.spawns.length, 2, 'H: force 兜底拉自己的助手（优雅那个在等外壳，不该复用它）')

  eq(okHost.exited.length, 0, 'H: 响应还没发完，本进程不退出')
  res200.finish()
  eq(okHost.later.length, 1, 'H: 响应发完才排一个延时')
  eq(okHost.exited.length, 0, 'H: 延时到点之前不退出')
  okHost.later[0]()
  eq(okHost.exited[0], 0, 'H: 退出码 0')

  // 挂起超时自愈：优雅请求发出后 90 秒还没成（窗口没关掉），就该放用户重试
  let idleClock = new Date('2026-10-03T00:00:00.000Z')
  const idleHost = makeHost({ now: () => idleClock })
  const idleReq1 = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"graceful"}')
  const idleRes1 = makeRes()
  idleHost.route.handler(idleReq1, idleRes1)
  idleReq1.feed()
  eq(idleRes1.status, 200, 'H: 超时段：第一次优雅请求正常回 200')
  eq(idleHost.spawns.length, 1, 'H: 超时段：第一次拉了一个助手')
  idleClock = new Date('2026-10-03T00:01:00.000Z')
  const idleReq2 = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"graceful"}')
  const idleRes2 = makeRes()
  idleHost.route.handler(idleReq2, idleRes2)
  idleReq2.feed()
  eq(JSON.parse(idleRes2.body).already, true, 'H: 60 秒时还在挂起期内（仍是幂等）')
  eq(idleHost.spawns.length, 1, 'H: 60 秒时没有多拉助手')
  idleClock = new Date('2026-10-03T00:02:00.000Z')
  const idleReq3 = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"graceful"}')
  const idleRes3 = makeRes()
  idleHost.route.handler(idleReq3, idleRes3)
  idleReq3.feed()
  eq(idleRes3.status, 200, 'H: 超过 90 秒后不再拦')
  eq(JSON.parse(idleRes3.body).already, undefined, 'H: 超时后是一次正常重启（没有 already 标记）')
  eq(idleHost.spawns.length, 2, 'H: 超时后重新拉起助手，用户能重试')
  ok(idleHost.logs.join('').indexOf('放开重试') >= 0, 'H: 超时放开时写了一条日志')

  // 优雅方式：客户端默认走这条，宿主**不许自己退**
  const graceHost = makeHost()
  const graceReq = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '{"mode":"graceful"}')
  const resGrace = makeRes()
  graceHost.route.handler(graceReq, resGrace)
  eq(resGrace.status, null, 'H: 请求体还没读完就不回（别抢答）')
  graceReq.feed()
  eq(resGrace.status, 200, 'H: 优雅方式也回 200')
  eq(JSON.parse(resGrace.body).mode, 'graceful', 'H: 回包里告诉客户端这次是优雅方式')
  eq(graceHost.spawns.length, 1, 'H: 优雅方式照样先拉起助手')
  const gracePlan = JSON.parse(graceHost.plans[0].text)
  eq(gracePlan.mode, 'graceful', 'H: 计划里记下优雅方式')
  eq(gracePlan.shellPid, process.ppid, 'H: 计划里记下外壳 pid')
  ok(graceHost.logs.join('').indexOf('优雅') >= 0, 'H: 日志里写清是优雅方式')
  resGrace.finish()
  eq(graceHost.later.length, 0, 'H: 优雅方式绝不排那个自杀延时')
  eq(graceHost.exited.length, 0, 'H: 优雅方式宿主自己不退（退不退由外壳决定）')

  // 读不清 body 一律当兜底方式，绝不因此拒绝重启
  const muddled = [
    ['{"mode":"乱写的"}', '不认识的 mode'],
    ['{不是 JSON', '坏 JSON'],
    ['', '空 body'],
    ['null', 'body 是 null'],
  ]
  for (const [body, why] of muddled) {
    const host = makeHost()
    const req = makeBodyReq('POST', { host: '127.0.0.1:19387' }, body)
    const res = makeRes()
    host.route.handler(req, res)
    req.feed()
    eq(res.status, 200, `H: ${why}也照样重启（不拒绝）`)
    eq(JSON.parse(res.body).mode, 'force', `H: ${why}按兜底方式`)
  }

  const fatHost = makeHost()
  const fatReq = makeBodyReq('POST', { host: '127.0.0.1:19387' }, 'x'.repeat(5000), { end: false })
  const resFat = makeRes()
  fatHost.route.handler(fatReq, resFat)
  fatReq.feed()
  eq(resFat.status, 200, 'H: 请求体超长就直接按兜底方式走（不无限等）')
  eq(JSON.parse(resFat.body).mode, 'force', 'H: 超长体也是 force')

  const errHost = makeHost()
  const errReq = makeBodyReq('POST', { host: '127.0.0.1:19387' }, '')
  const resErr = makeRes()
  errHost.route.handler(errReq, resErr)
  if (errReq.handlers.error) errReq.handlers.error(new Error('连接断了'))
  eq(resErr.status, 200, 'H: 读 body 出错也照样按兜底方式重启')

  const plainHost = makeHost()
  plainHost.route.handler(makeReq('POST', {}), { writeHead() {}, end() {} })
  eq(plainHost.later.length, 1, 'H: 响应对象没有 finish 事件时也排延时')
  plainHost.later[0]()
  eq(plainHost.exited[0], 0, 'H: 照样退出码 0')

  const boomHost = makeHost({
    spawnFn() {
      throw new Error('spawn 挂了')
    },
  })
  const res500 = makeRes()
  boomHost.route.handler(makeReq('POST', { host: '127.0.0.1:19387' }), res500)
  eq(res500.status, 500, 'H: 起助手失败回 500')
  ok(JSON.parse(res500.body).error.indexOf('spawn 挂了') >= 0, 'H: 500 里带上原因')
  eq(boomHost.exited.length, 0, 'H: 失败时绝不退出进程（否则用户连界面都没了）')

  eq(hostModule.registerRestartRoute({}), null, 'H: 没有 webServer 就什么也不注册')
  eq(hostModule.registerRestartRoute(undefined), null, 'H: 没有 ctx 也不抛')
  eq(typeof h.disposer, 'function', 'H: register 返回 disposer')
  h.disposer()
  eq(h.removed, 1, 'H: disposer 能摘掉路由')
}

// ── I 分离助手：等旧的死 / 原样重放 / 兜底 ────────────────────────────────
section('I 分离助手：等旧的死 / 原样重放 / 兜底')
{
  const planPath = join('C:\\home', '.dsh', 'ui-refresh', 'restart-plan.json')
  function makePlanFile(overrides) {
    return JSON.stringify({
      schema: plan.PLAN_SCHEMA,
      createdAt: '2026-10-03T00:00:00.000Z',
      requestedBy: 'dsh-ui-refresh',
      pid: 4242,
      execPath: 'C:\\App\\app.exe',
      args: ['--expose-internals', 'host.js'],
      cwd: 'C:\\App',
      fallback: { execPath: 'C:\\App\\app.exe', args: [], cwd: 'C:\\App' },
      planPath,
      logPath: join('C:\\home', '.dsh', 'ui-refresh', 'restart.log'),
      ...(overrides ?? {}),
    })
  }

  function runCase(mode) {
    const options = mode ?? {}
    const calls = { launches: [], log: [], sleeps: [], waits: [] }
    const result = helper.runHelper(planPath, {
      readFile() {
        if (options.readError) throw new Error(options.readError)
        if (options.raw !== undefined) return options.raw
        return makePlanFile(options.plan)
      },
      append: (file, text) => calls.log.push(text),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      wait(pid, opts) {
        calls.waits.push({ pid, options: opts })
        return options.waitResult ?? { exited: true, waitedMs: 120 }
      },
      sleep: (ms) => calls.sleeps.push(ms),
      launch(target, opts) {
        const index = calls.launches.length
        calls.launches.push({ target, options: opts })
        const dead = Array.isArray(options.dead) && options.dead.includes(index)
        return { pid: 8000 + index, exitCode: dead ? 1 : null, signalCode: null }
      },
      env: { DSH_HOME: 'C:\\home', ELECTRON_RUN_AS_NODE: '1' },
      probeMs: 2500,
    })
    return { result, calls }
  }

  const okCase = runCase()
  eq(okCase.result.ok, true, 'I: 正常路径返回 ok')
  eq(okCase.result.mode, 'replay', 'I: 方式标成原样重放')
  eq(okCase.result.pid, 8000, 'I: 返回新进程 pid')
  eq(okCase.calls.waits.length, 1, 'I: 先等旧进程退出')
  eq(okCase.calls.waits[0].pid, 4242, 'I: 等的是计划里的 pid')
  eq(okCase.calls.waits[0].options.timeoutMs, 30000, 'I: 兜底方式最多等 30 秒')
  ok(okCase.calls.log.join('').indexOf('宿主进程 4242') >= 0, 'I: 日志里写清等的是宿主')
  eq(okCase.calls.launches.length, 1, 'I: 只起了一个进程')
  eq(okCase.calls.launches[0].target.execPath, 'C:\\App\\app.exe', 'I: 用计划里的可执行文件')
  eq(okCase.calls.launches[0].target.args.length, 2, 'I: 参数原样重放')
  eq(okCase.calls.launches[0].target.cwd, 'C:\\App', 'I: cwd 原样重放')
  ok(okCase.calls.log.join('').indexOf('pid=4242') >= 0, 'I: 日志里记下等了谁')
  ok(okCase.calls.log.join('').indexOf('原样重放') >= 0, 'I: 日志里记下重放方式')

  const stuck = runCase({ waitResult: { exited: false, waitedMs: 30000 } })
  eq(stuck.result.ok, true, 'I: 旧进程超时没死也照样起新的')
  ok(stuck.calls.log.join('').indexOf('仍然按计划启动') >= 0, 'I: 超时会写一条警告日志')

  // 优雅方式：等外壳进程、先走"等同双击桌面图标"
  const graceCase = runCase({ plan: { mode: 'graceful', shellPid: 5555 } })
  eq(graceCase.result.ok, true, 'I: 优雅方式正常跑通')
  eq(graceCase.calls.waits.length, 1, 'I: 优雅方式只等一个进程')
  eq(graceCase.calls.waits[0].pid, 5555, 'I: 优雅方式等的是外壳 pid')
  eq(graceCase.calls.waits[0].options.timeoutMs, 60000, 'I: 优雅方式多等一会儿（用户可能要手点「退出」）')
  ok(graceCase.calls.log.join('').indexOf('外壳进程 5555') >= 0, 'I: 日志里写清等的是外壳')
  ok(graceCase.calls.log.join('').indexOf('优雅退出') >= 0, 'I: 日志里写明这是优雅方式')
  eq(graceCase.result.mode, 'fallback', 'I: 优雅方式先走"等同双击桌面图标"那条')
  eq(graceCase.calls.launches.length, 1, 'I: 第一条起来就够了')
  eq(graceCase.calls.launches[0].target.args.length, 0, 'I: 第一条命令不带参数')
  eq(graceCase.calls.launches[0].target.cwd, 'C:\\App', 'I: 第一条命令在 exe 自己的目录里')
  ok(graceCase.calls.sleeps.indexOf(1500) >= 0, 'I: 起之前先等一下，让系统把单实例锁放开')

  const stuckShell = runCase({
    waitResult: { exited: false, waitedMs: 60000 },
    plan: { mode: 'graceful', shellPid: 5555 },
  })
  eq(stuckShell.result.ok, false, 'I: 外壳没退就绝不硬起新进程（新实例抢不到锁会自杀）')
  eq(stuckShell.calls.launches.length, 0, 'I: 一条命令都不发')
  ok(String(stuckShell.result.reason).indexOf('外壳还在运行') >= 0, 'I: 说清是外壳还在')
  ok(stuckShell.calls.log.join('').indexOf('不再启动新进程') >= 0, 'I: 日志里给出人工出路（托盘 → 退出）')

  const graceReplay = runCase({ dead: [0], plan: { mode: 'graceful', shellPid: 5555 } })
  eq(graceReplay.result.ok, true, 'I: 优雅方式第一条起不来，还有原样重放兜着')
  eq(graceReplay.calls.launches.length, 2, 'I: 优雅方式也会起第二次')
  eq(graceReplay.calls.launches[1].target.args.length, 2, 'I: 第二条才是原样重放（参数齐全）')
  eq(graceReplay.result.mode, 'replay', 'I: 第二次成功就算原样重放')

  const fell = runCase({ dead: [0] })
  eq(fell.result.ok, true, 'I: 回退到兜底后算成功')
  eq(fell.result.mode, 'fallback', 'I: 方式标成 fallback')
  eq(fell.calls.launches.length, 2, 'I: 一共起了两次')
  eq(fell.calls.launches[1].target.execPath, 'C:\\App\\app.exe', 'I: 兜底用同一个 exe')
  eq(fell.calls.launches[1].target.args.length, 0, 'I: 兜底不带参数（等同双击图标）')
  eq(fell.calls.launches[1].target.cwd, 'C:\\App', 'I: 兜底用 exe 自己的目录')
  ok(fell.calls.sleeps.length >= 2, 'I: 每次起完都观察一会儿')

  const both = runCase({ dead: [0, 1] })
  eq(both.result.ok, false, 'I: 兜底也起不来就报失败')
  ok(String(both.result.reason).indexOf('起不来') >= 0, 'I: 说清两种方式都没起来')
  ok(both.calls.log.join('').indexOf('请手动双击桌面图标') >= 0, 'I: 日志里给出人工出路')

  const noFallback = runCase({ dead: [0], plan: { fallback: null } })
  eq(noFallback.result.ok, false, 'I: 没有兜底命令就报失败')
  eq(noFallback.calls.launches.length, 1, 'I: 不会硬起第二次')

  const noFile = runCase({ readError: 'ENOENT' })
  eq(noFile.result.ok, false, 'I: 读不到计划报失败')
  ok(String(noFile.result.reason).indexOf('读不到计划文件') >= 0, 'I: 说清是读文件失败')
  const badJson = runCase({ raw: '{不是 JSON' })
  eq(badJson.result.ok, false, 'I: 计划不是 JSON 报失败')
  const badPlan = runCase({ plan: { schema: 99 } })
  eq(badPlan.result.ok, false, 'I: 计划 schema 不对报失败')
  eq(badPlan.calls.launches.length, 0, 'I: 校验不过绝不起进程')

  const launched = []
  const child = helper.launchProcess(
    { execPath: 'C:\\App\\app.exe', args: ['a'], cwd: 'C:\\App', label: '测试' },
    {
      spawnFn(execPath, args, options) {
        launched.push({ execPath, args, options })
        return { pid: 999, unref() {} }
      },
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: 'C:\\home' },
      log: () => {},
    },
  )
  eq(launched.length, 1, 'I: launchProcess 调了 spawn')
  eq(launched[0].options.env.ELECTRON_RUN_AS_NODE, undefined, 'I: 必须删掉 ELECTRON_RUN_AS_NODE（否则重开的是没窗口的 node）')
  eq(launched[0].options.env.DSH_HOME, 'C:\\home', 'I: 其余环境原样保留')
  eq(launched[0].options.detached, true, 'I: 新进程 detached')
  eq(child.pid, 999, 'I: launchProcess 返回子进程')

  eq(helper.isAlive(4242, () => {}), true, 'I: kill(pid,0) 不抛就是活着')
  eq(
    helper.isAlive(4242, () => {
      const err = new Error('gone')
      err.code = 'ESRCH'
      throw err
    }),
    false,
    'I: ESRCH 说明进程没了',
  )
  eq(
    helper.isAlive(4242, () => {
      const err = new Error('nope')
      err.code = 'EPERM'
      throw err
    }),
    true,
    'I: EPERM 也算活着（只是不归我管）',
  )
  eq(helper.isAlive(0), false, 'I: 非法 pid 直接算没了')
  eq(helper.isAlive(undefined), false, 'I: 缺 pid 也算没了')

  let aliveTimes = 3
  const waited = helper.waitForExit(4242, {
    intervalMs: 100,
    kill: () => {
      if (aliveTimes-- <= 0) {
        const err = new Error('gone')
        err.code = 'ESRCH'
        throw err
      }
    },
    now: (() => {
      let t = 0
      return () => (t += 100)
    })(),
    sleep: () => {},
  })
  eq(waited.exited, true, 'I: 轮询到进程消失')
  const timedOut = helper.waitForExit(4242, {
    timeoutMs: 500,
    intervalMs: 100,
    kill: () => {},
    now: (() => {
      let t = 0
      return () => (t += 100)
    })(),
    sleep: () => {},
  })
  eq(timedOut.exited, false, 'I: 超过上限就不等了')

  eq(helper.diedImmediately({ exitCode: 0, signalCode: null }), true, 'I: 已退出算"起来就死"')
  eq(helper.diedImmediately({ exitCode: null, signalCode: 'SIGKILL' }), true, 'I: 被信号打死也算')
  eq(helper.diedImmediately({ exitCode: null, signalCode: null }), false, 'I: 还活着就不算')
  eq(helper.diedImmediately(null), true, 'I: 压根没起来也算')
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length) {
  console.log('失败项：')
  for (const line of failures) console.log('  ✗ ' + line)
}
console.log(`自检：${pass} 项通过 / ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
