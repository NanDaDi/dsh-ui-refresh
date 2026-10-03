/**
 * dsh-ui-refresh — 重启计划的纯函数（宿主半边 `lib/index.js` 与分离助手
 * `lib/restart-helper.js` 共用）。
 *
 * 为什么不"直接 spawn 一个新进程就完事"：官方桌面外壳有**单实例锁**
 * （`app.asar` 里 `claimDesktopSingleInstance()` → `application.requestSingleInstanceLock()`，
 * 抢不到锁的第二个实例会立刻 `application.quit()`）。所以必须**先等旧进程死透，
 * 再起新的** —— 这正是为什么重启要拆成"宿主半边开一张计划 + 一个分离助手去执行"。
 *
 * 这里只放没有副作用的东西：计划怎么造、怎么校验、同源怎么判、日志行长什么样。
 * 时间与进程操作全由调用方注入（测试要能假装时间）。
 */
import { dirname, isAbsolute } from 'node:path'

/** 客户端 POST 这条路径要求重启；宿主半边按 `exact` 路由注册它。 */
export const API_PATH = '/dsh-ui-refresh/api/v1/restart'
/** 计划文件的 schema 版本；助手只认这一个版本，免得旧计划被新助手误读。 */
export const PLAN_SCHEMA = 1
/** 客户端「再次点击确认重启」的窗口（毫秒）。 */
export const CONFIRM_MS = 3000
/**
 * 两种重启方式。
 *
 *   · `graceful` —— 打算让**外壳自己**走正常退出流程（关掉窗口 → `window-all-closed`
 *     → `app.quit()`），所以宿主半边**不**自杀。这样才不会弹「应用无法启动或已意外停止」
 *     （外壳把 host 子进程的非停机退出判成崩溃，见 `app.asar/lib/main.js` 的 `child.once("close")`）。
 *   · `force` —— 老办法：宿主回完响应就 `process.exit(0)`。会弹恢复框，只当兜底。
 */
export const RESTART_MODES = ['graceful', 'force']
/** 缺省方式：兜底那条（老客户端不带 body 也按这个跑）。 */
export const DEFAULT_MODE = 'force'
/** 助手等旧进程退出的上限（毫秒）。 */
export const EXIT_TIMEOUT_MS = 30000
/** 优雅退出要等用户可能的"确认退出"对话框，给宽一点。 */
export const GRACEFUL_EXIT_TIMEOUT_MS = 60000
/** 外壳进程消失之后再等一下下：单实例锁要等系统真的回收了那个进程才松手。 */
export const SETTLE_MS = 1500
/** 助手起完新进程后观察多久，用来判断"原样重放"是不是立刻死了。 */
export const PROBE_MS = 2500

/**
 * `Host` 头是不是本机回环权威。
 *
 * 和市场的 `loopbackAuthority()` 同一套语义：`Host` 是 DNS 重绑定页面唯一伪造不了的
 * 头，所以它就是判断"这个请求到底有没有打到本机"的依据。`localhost` 按 RFC 6761
 * 算回环；`localhost.evil.com` 不算；端口先去掉再比。
 */
export function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * 这个请求允不允许改本机状态。
 *
 * 三条规则，逐条都能说出理由：
 *   · `Host` 存在就必须是本机权威 —— 不存在则放行（浏览器一定带 `Host`，所以"没有"
 *     说明不是页面发的；桌面外壳的代理会把它连同 `Origin` 一起剥掉）；
 *   · `Sec-Fetch-Site: cross-site` 直接拒 —— 浏览器自己声明这次是跨站；
 *   · `Origin` 存在就必须与 `Host` 同源（`null` / 空串这类"存在但解析不了"的也算拒）。
 */
export function isSameOriginRequest(headers) {
  const host = headers?.host
  if (typeof host === 'string' && host.length > 0 && !isLoopbackAuthority(host)) return false
  if (headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 宿主是不是官方 Electron 桌面端。
 *
 * 只有它为真才允许一键重启：纯 node 宿主（`dsh web`）的 `execPath` 是 `node.exe`，
 * 那句"无参数兜底启动"会起出一个 REPL；而且 web 端本来就有市场的一键重启
 * （`allowRestart` 只在桌面端被上游关掉）。
 */
export function isDesktopHost(versions) {
  return typeof versions?.electron === 'string' && versions.electron.length > 0
}

/** 把请求里的 mode 归一化成受支持的值；不认识的（含 `undefined`）按兜底方式处理。 */
export function normalizeMode(value) {
  return RESTART_MODES.includes(value) ? value : DEFAULT_MODE
}

/** 这张计划该等多久旧进程退出：优雅退出要留时间给用户可能要点的那一下「确认退出」。 */
export function exitTimeoutFor(plan) {
  return plan?.mode === 'graceful' ? GRACEFUL_EXIT_TIMEOUT_MS : EXIT_TIMEOUT_MS
}

/**
 * 助手该等哪些进程消失（按顺序）。
 *
 * **为什么不是永远只等宿主**：单实例锁的持有者是**外壳**（`app.asar` 里
 * `claimDesktopSingleInstance()` 跑在 Electron 主进程，也就是 `plan.shellPid`），
 * v0.3.0 那种"宿主一退就重放"的做法，起出来的新实例抢不到锁、会被自己
 * `application.quit()` 掉 —— 用户看到的就是"点了没反应、还得在恢复框上再点一次"。
 * 所以优雅方式下真正该等的是**外壳**；兜底方式（宿主自杀）下外壳还活着（它会弹恢复框），
 * 那时只能等宿主自己。
 */
export function waitTargetsFor(plan) {
  const pid = plan?.pid
  const shellPid = plan?.shellPid
  if (plan?.mode === 'graceful' && Number.isInteger(shellPid) && shellPid > 0 && shellPid !== pid) {
    return [{ pid: shellPid, label: '外壳进程' }]
  }
  return [{ pid, label: '宿主进程' }]
}

/**
 * 造一张重启计划。
 *
 * `args` 是 `process.argv.slice(1)` 那种形态（不含可执行文件本身）：原样重放要保证
 * `--expose-internals`、desktop-host 入口脚本、profile 目录、runtime/pnpm/bin 这些
 * 参数一个不少地传回去 —— 宿主就是 Electron 本体，漏一个就起不来。
 *
 * `fallback` 是"等同双击桌面图标"的那条命令（exe + 无参数 + 它自己的目录）。只在
 * Electron 宿主上给：web 端 `node.exe` 无参数会进 REPL。
 */
export function buildPlan(input) {
  const {
    pid,
    shellPid,
    argv,
    execPath,
    cwd,
    planPath,
    logPath,
    mode,
    electron = false,
    now = new Date(),
  } = input
  const list = Array.isArray(argv) ? argv.filter((entry) => typeof entry === 'string') : []
  // 调用方可能传完整的 process.argv（argv[0] === execPath），也可能已经切过。
  const args = list.length > 0 && list[0] === execPath ? list.slice(1) : list
  const fallback = electron && /\.exe$/i.test(execPath)
    ? { execPath, args: [], cwd: dirname(execPath) }
    : null
  const shell = Number.isInteger(shellPid) && shellPid > 0 && shellPid !== pid ? shellPid : null
  return {
    schema: PLAN_SCHEMA,
    createdAt: now instanceof Date ? now.toISOString() : String(now),
    requestedBy: 'dsh-ui-refresh',
    mode: normalizeMode(mode),
    pid,
    shellPid: shell,
    execPath,
    args,
    cwd,
    fallback,
    planPath,
    logPath,
  }
}

/** 校验一张计划；返回 `{ ok: true, plan }` 或 `{ ok: false, reason }`。 */
export function validatePlan(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: '计划不是对象' }
  }
  if (value.schema !== PLAN_SCHEMA) return { ok: false, reason: `计划的 schema 不是 ${PLAN_SCHEMA}` }
  if (!Number.isInteger(value.pid) || value.pid <= 0) return { ok: false, reason: '计划里的 pid 不合法' }
  if (typeof value.execPath !== 'string' || !isAbsolute(value.execPath)) {
    return { ok: false, reason: '计划里的 execPath 不是绝对路径' }
  }
  if (!Array.isArray(value.args) || value.args.some((entry) => typeof entry !== 'string')) {
    return { ok: false, reason: '计划里的 args 不合法' }
  }
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) return { ok: false, reason: '计划里的 cwd 不合法' }
  if (value.mode !== undefined && !RESTART_MODES.includes(value.mode)) {
    return { ok: false, reason: `计划里的 mode 不是 ${RESTART_MODES.join(' / ')}` }
  }
  if (value.shellPid !== undefined && value.shellPid !== null) {
    if (!Number.isInteger(value.shellPid) || value.shellPid <= 0) {
      return { ok: false, reason: '计划里的 shellPid 不合法' }
    }
  }
  const fallback = value.fallback
  if (fallback !== null && fallback !== undefined) {
    if (typeof fallback !== 'object' || typeof fallback.execPath !== 'string' || !Array.isArray(fallback.args)) {
      return { ok: false, reason: '计划里的 fallback 不合法' }
    }
  }
  return { ok: true, plan: value }
}

/** 一行摘要：助手日志里用，出问题时一眼看出它打算重放什么。 */
export function planSummary(plan) {
  return `mode=${normalizeMode(plan.mode)} pid=${plan.pid} shell=${plan.shellPid ?? '-'} exe=${plan.execPath} args=${plan.args.length} cwd=${plan.cwd} fallback=${plan.fallback ? 'yes' : 'no'}`
}

/** 带 ISO 时间戳的一行日志。 */
export function logLine(kind, message, now = new Date()) {
  const stamp = now instanceof Date ? now.toISOString() : String(now)
  return `${stamp} [${kind}] ${message}\n`
}
