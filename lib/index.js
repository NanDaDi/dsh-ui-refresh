/**
 * dsh-ui-refresh — host half.
 *
 * 浏览器半边（`lib/client.js`）负责标题栏那颗「刷新」菜单；这里负责**重启**：
 * 在组合的 `webServer` 上注册一条 exact 路由
 *
 *     POST /dsh-ui-refresh/api/v1/restart
 *
 * 客户端点「重启应用」就 POST 它，body 里带 `{ "mode": "graceful" | "force" }`：
 *   · `graceful`（客户端默认）—— 写计划 + 拉起分离助手 + 回 200，**本进程不退出**：
 *     客户端收到 200 后请外壳关掉窗口，外壳自己走 `app.quit()` —— 那才是"正常退出"；
 *   · `force` —— 老办法：回完响应 250ms 后 `process.exit(0)`。外壳会把 host 子进程的
 *     这种退出判成崩溃并弹恢复框，所以只当"关窗没生效"时的兜底。
 * 助手（`lib/restart-helper.js`）负责"等旧进程死透、用同一套参数把应用重开"
 * （原因见 `lib/restart-plan.js` 头部：外壳有单实例锁，必须先退后起）。
 *
 * 为什么不做"直接 spawn 新进程"：新进程会在旧进程还活着时抢单实例锁失败并自杀
 * （`app.asar` 里 `claimDesktopSingleInstance()`），所以那一小段等待必须由一个
 * **不属于这个进程**的助手来做。
 *
 * 三条硬约束：
 *   · 顶层**不声明 inject**（cordis 在 inactive ctx 下解析 inject 会抛
 *     `cannot get required service ... in inactive context`，那个错发生在 apply
 *     之前，apply 里的 try/catch 拦不住，会让整个 GUI 起不来）；
 *   · 只用**运行时注入** `ctx.inject(['webServer'], …)`，服务不在时插件照样激活；
 *   · `apply` 自己不抛异常。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PATH, buildPlan, isDesktopHost, isSameOriginRequest, logLine, normalizeMode, validatePlan } from './restart-plan.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 助手脚本的绝对路径；spawn 时用它的绝对路径，别靠 cwd。 */
export const HELPER_PATH = join(HERE, 'restart-helper.js')

export const name = 'dsh-ui-refresh'

export const inject = []

export function apply(ctx) {
  try {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (hostCtx) => {
      try {
        registerRestartRoute(hostCtx)
      } catch {}
    })
  } catch {}
}

/**
 * 把重启路由挂到 `hostCtx.webServer` 上。
 *
 * 所有依赖都能注入，所以自检里可以拿假的 ctx / webServer / spawn / 定时器把它完整
 * 跑一遍。返回 disposer（`webServer.register()` 的注销函数），服务不在时返回 `null`。
 */
export function registerRestartRoute(hostCtx, deps = {}) {
  const {
    webServer = hostCtx?.webServer,
    effect = (fn, label) => hostCtx.effect(fn, label),
    spawnFn = spawn,
    mkdir = mkdirSync,
    writeFile = writeFileSync,
    appendFile = appendFileSync,
    versions = process.versions,
    argv = process.argv,
    execPath = process.execPath,
    cwd = process.cwd(),
    env = process.env,
    home = homedir(),
    pid = process.pid,
    shellPid = process.ppid,
    later = setTimeout,
    exit = (code) => process.exit(code),
    now = () => new Date(),
    helperPath = HELPER_PATH,
  } = deps
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return null

  const dir = join(home, '.dsh', 'ui-refresh')
  const planPath = join(dir, 'restart-plan.json')
  const logPath = join(dir, 'restart.log')
  /** 一次只允许一次重启：连点第二次给 409，别拉起两个助手。 */
  let restarting = false

  function appendLog(kind, message) {
    try {
      mkdir(dir, { recursive: true })
      appendFile(logPath, logLine(kind, message, now()))
    } catch {}
  }

  function send(response, status, payload, headers) {
    try {
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        ...(headers ?? {}),
      })
      response.end(JSON.stringify(payload))
    } catch {}
  }

  /**
   * 读请求体里的 `mode`。
   *
   * 客户端只发一个很小的 `{ "mode": "graceful" }`；读不到（老客户端、没有 `on` 的假
   * request、坏 JSON、body 过长）一律按缺省方式处理 —— 绝不因为读不清 body 就拒绝重启。
   */
  function readMode(request, done) {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        done(normalizeMode(value))
      } catch {}
    }
    try {
      if (request === null || request === undefined || typeof request.on !== 'function') {
        finish(undefined)
        return
      }
      let body = ''
      request.on('data', (chunk) => {
        if (settled) return
        body += typeof chunk === 'string' ? chunk : String(chunk ?? '')
        // 客户端只发几十字节；再大就说明不是它，别再攒了。
        if (body.length > 4096) finish(undefined)
      })
      request.on('end', () => {
        if (settled) return
        try {
          const parsed = body.length > 0 ? JSON.parse(body) : {}
          finish(parsed === null || typeof parsed !== 'object' ? undefined : parsed.mode)
        } catch {
          finish(undefined)
        }
      })
      request.on('error', () => finish(undefined))
    } catch {
      finish(undefined)
    }
  }

  function handler(request, response) {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
    if (method !== 'POST') {
      send(response, 405, { ok: false, error: '这个地址只接受 POST' }, { allow: 'POST' })
      return
    }
    if (!isSameOriginRequest(request?.headers)) {
      send(response, 403, { ok: false, error: '只接受本机同源请求' })
      return
    }
    if (!isDesktopHost(versions)) {
      send(response, 501, { ok: false, error: '这台宿主不是桌面端：重启由插件市场里的一键重启负责' })
      return
    }
    if (restarting) {
      send(response, 409, { ok: false, error: '已经在重启了' })
      return
    }
    readMode(request, (mode) => {
      try {
        const plan = buildPlan({
          pid,
          shellPid,
          argv,
          execPath,
          cwd,
          planPath,
          logPath,
          mode,
          electron: true,
          now: now(),
        })
        const verdict = validatePlan(plan)
        if (!verdict.ok) {
          send(response, 500, { ok: false, error: verdict.reason })
          return
        }
        mkdir(dir, { recursive: true })
        writeFile(planPath, JSON.stringify(plan, null, 2))
        const child = spawnFn(execPath, [helperPath, planPath], {
          // 助手要活过我：detached + 不要管道 + unref。
          detached: true,
          stdio: 'ignore',
          cwd: dir,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        })
        try {
          child.unref()
        } catch {}
        restarting = true
        appendLog('host', `收到重启请求（${plan.mode}）；助手 pid=${child?.pid ?? '?'}，本进程 pid=${pid}`)
        send(response, 200, {
          ok: true,
          mode: plan.mode,
          helperPid: child?.pid ?? null,
          planPath,
          fallback: plan.fallback !== null,
        })
        if (plan.mode === 'graceful') {
          // 优雅方式：**本进程不许自己退**。外壳把 host 子进程的非停机退出判成崩溃
          // （`app.asar/lib/main.js` 的 `child.once("close")` → 弹「应用无法启动或已意外停止」）。
          // 客户端收到 200 后会请外壳关掉窗口，由外壳自己走 `app.quit()` 把我们停掉 ——
          // 那才是"正常退出"；助手在那边等**外壳进程**消失，再原样重开。
          appendLog('host', '按优雅方式：等外壳自己退出（客户端会请求关窗）')
          return
        }
        // 兜底方式：回完响应就退掉本进程，让助手去重开（会弹恢复框，只当最后手段）。
        const finish = () => {
          later(() => {
            try {
              appendLog('host', '退出本进程，交给助手重开')
            } catch {}
            try {
              exit(0)
            } catch {}
          }, 250)
        }
        if (response !== null && typeof response?.on === 'function') response.on('finish', finish)
        else finish()
      } catch (error) {
        restarting = false
        appendLog('error', `重启失败：${error?.message ?? error}`)
        send(response, 500, { ok: false, error: `重启失败：${error?.message ?? error}` })
      }
    })
  }

  return effect(() => webServer.register({ kind: 'exact', path: API_PATH, handler }), 'dsh-ui-refresh: restart route')
}
