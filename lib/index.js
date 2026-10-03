/**
 * dsh-ui-refresh — host half.
 *
 * 浏览器半边（`lib/client.js`）负责标题栏那颗「刷新」菜单；这里负责**重启**：
 * 在组合的 `webServer` 上注册一条 exact 路由
 *
 *     POST /dsh-ui-refresh/api/v1/restart
 *
 * 客户端点「重启应用」就 POST 它。宿主半边收到后：写一张重启计划 → 拉起分离助手
 * （`lib/restart-helper.js`）→ 回 200 → 200 写完再自己退出。助手负责"等旧进程死透、
 * 用同一套参数把应用重开"（原因见 `lib/restart-plan.js` 头部：外壳有单实例锁，
 * 必须先退后起）。
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
import { API_PATH, buildPlan, isDesktopHost, isSameOriginRequest, logLine, validatePlan } from './restart-plan.js'

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
    try {
      const plan = buildPlan({ pid, argv, execPath, cwd, planPath, logPath, electron: true, now: now() })
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
      appendLog('host', `收到重启请求；助手 pid=${child?.pid ?? '?'}，本进程 pid=${pid}`)
      send(response, 200, {
        ok: true,
        helperPid: child?.pid ?? null,
        planPath,
        fallback: plan.fallback !== null,
      })
      // 先让响应真的发出去再退出，否则客户端只会看到连接被重置。
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
  }

  return effect(() => webServer.register({ kind: 'exact', path: API_PATH, handler }), 'dsh-ui-refresh: restart route')
}
