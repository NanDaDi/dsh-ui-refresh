/**
 * dsh-ui-refresh — 分离重启助手。
 *
 * 宿主半边用 `spawn(execPath, [助手的绝对路径, 计划文件], { detached: true, stdio: 'ignore',
 * env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })` 把它拉起来，然后自己退出。它就是那句
 * "先等旧的死、再起新的"：
 *
 *   1. 等该等的进程彻底消失（轮询 `process.kill(pid, 0)`）—— 桌面外壳有单实例锁，
 *      新进程先起会抢不到锁并立刻自杀。等谁由 `plan.mode` 决定（`waitTargetsFor()`）：
 *      优雅方式等**外壳进程** `plan.shellPid`，兜底方式只能等宿主 `plan.pid`；
 *   2. 用 `plan.execPath` + `plan.args` **原样重放**（宿主是 Electron 本体，
 *      `--expose-internals`、desktop-host 入口、profile 目录这些参数缺一不可）；
 *      优雅方式反过来：先走"等同双击桌面图标"，原样重放当兜底；
 *   3. 观察一小会儿，若新进程立刻死了，就换另一种命令再起一次；
 *   4. 全程写 `plan.logPath`，起不来时用户照那行日志就能定位。
 *
 * 这里不 `import` 任何宿主服务：它要能在"Electron 二进制 + ELECTRON_RUN_AS_NODE=1"
 * 和普通 `node` 两种载体下都跑得起来。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EXIT_TIMEOUT_MS,
  PROBE_MS,
  SETTLE_MS,
  exitTimeoutFor,
  logLine,
  planSummary,
  validatePlan,
  waitTargetsFor,
} from './restart-plan.js'

/** 同步睡一会儿。助手是"短命命令行脚本"，用同步等待最简单、也最不容易被误以为卡死。 */
export function sleepSync(ms) {
  if (!(ms > 0)) return
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/**
 * 进程还活着吗。
 * `process.kill(pid, 0)` 不投递信号，只做存在性检查：`ESRCH` = 没了；
 * `EPERM` = 还在，只是不归我管（照样算活着）。
 */
export function isAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 等一个 pid 消失。返回 `{ exited, waitedMs }`；超时不算致命，调用方自己决定。 */
export function waitForExit(pid, options = {}) {
  const {
    timeoutMs = EXIT_TIMEOUT_MS,
    intervalMs = 250,
    kill = process.kill,
    now = () => Date.now(),
    sleep = sleepSync,
  } = options
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  while (isAlive(pid, kill)) {
    if (now() >= deadline) return { exited: false, waitedMs: now() - startedAt }
    sleep(intervalMs)
  }
  return { exited: true, waitedMs: now() - startedAt }
}

/**
 * 起一个新进程：`{ execPath, args, cwd, label }`。
 * 只在这里决定环境 —— 必须删掉 `ELECTRON_RUN_AS_NODE`，否则"重开的应用"会变成
 * 一个没有窗口的 node 进程。
 */
export function launchProcess(target, options = {}) {
  const { spawnFn = spawn, env = process.env, log = () => {} } = options
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawnFn(target.execPath, target.args, {
    detached: true,
    stdio: 'ignore',
    cwd: target.cwd,
    env: childEnv,
    windowsHide: false,
  })
  try {
    child.unref()
  } catch {}
  log(`${target.label ?? 'launch'} pid=${child?.pid ?? '?'} args=${target.args.length}`)
  return child
}

/** 新进程是不是"起来就死了"。`exitCode`/`signalCode` 有任一非空即视为死了。 */
export function diedImmediately(child) {
  if (child === null || child === undefined) return true
  if (child.exitCode !== null && child.exitCode !== undefined) return true
  if (child.signalCode !== null && child.signalCode !== undefined) return true
  return false
}

/**
 * 助手主流程。所有 I/O 都能注入，所以它可以在自检里被完整跑一遍。
 * 返回 `{ ok, mode?, pid?, reason? }`。
 */
export function runHelper(planPath, deps = {}) {
  const {
    readFile = (file) => readFileSync(file, 'utf8'),
    append = (file, text) => {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now = () => new Date(),
    launch = launchProcess,
    wait = waitForExit,
    sleep = sleepSync,
    spawnFn = spawn,
    env = process.env,
    probeMs = PROBE_MS,
    settleMs = SETTLE_MS,
  } = deps
  let logPath = null
  const log = (kind, message) => {
    const line = logLine(kind, message, now())
    if (logPath !== null) {
      try {
        append(logPath, line)
      } catch {}
    }
    return line
  }

  let raw
  try {
    raw = readFile(planPath)
  } catch (error) {
    return { ok: false, reason: `读不到计划文件：${error?.message ?? error}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `计划文件不是 JSON：${error?.message ?? error}` }
  }
  const verdict = validatePlan(parsed)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const plan = verdict.plan
  if (typeof plan.logPath === 'string' && plan.logPath.length > 0) logPath = plan.logPath
  const graceful = plan.mode === 'graceful'

  log('helper', `开始；计划 ${planPath}`)
  log('helper', planSummary(plan))
  log(
    'helper',
    graceful
      ? '方式：优雅退出 —— 外壳自己走 app.quit()，本助手等外壳进程消失后重开'
      : '方式：兜底 —— 宿主进程自杀后重开（外壳会弹恢复框）',
  )

  const timeoutMs = exitTimeoutFor(plan)
  const targets = waitTargetsFor(plan)
  let allGone = true
  for (const target of targets) {
    const waited = wait(target.pid, { timeoutMs })
    allGone = allGone && waited.exited
    log(
      waited.exited ? 'helper' : 'warn',
      waited.exited
        ? `${target.label} ${target.pid} 已退出（等了 ${waited.waitedMs}ms）`
        : `${target.label} ${target.pid} 超过 ${timeoutMs}ms 仍活着`,
    )
  }

  if (graceful && !allGone) {
    // 外壳还活着 = 单实例锁还攥在它手里 = 现在起新进程只会被它自己 `app.quit()` 掉。
    // 先别起，把话说清楚：用户可能只是还没点那下「确认退出」，或者点了取消。
    log('warn', '外壳仍在运行，不再启动新进程；若应用像是没了反应：托盘 → 退出，然后双击桌面图标')
    return { ok: false, reason: '外壳还在运行，等它退出后再启动' }
  }
  if (!allGone) {
    // 兜底方式：宿主没退干净也只能硬起，大不了外壳弹一次恢复框。
    log('warn', '等不到旧进程消失，仍然按计划启动（外壳可能会弹一次恢复框）')
  }
  if (graceful) {
    // 单实例锁要等系统真的回收了那个进程才松手，等一下下再起。
    sleep(settleMs)
  }

  const replay = { kind: 'replay', label: '原样重放', execPath: plan.execPath, args: plan.args, cwd: plan.cwd }
  const plain = plan.fallback === null || plan.fallback === undefined
    ? null
    : {
        kind: 'fallback',
        label: '等同双击桌面图标',
        execPath: plan.fallback.execPath,
        args: plan.fallback.args ?? [],
        cwd: plan.fallback.cwd,
      }
  // 优雅方式下先走"等同双击桌面图标"：外壳已经没了，这条是唯一被证实一定能起来的命令
  // （exe + 无参数 + 它自己的目录），也不用担心宿主那串参数被新实例当成别的意思。
  const attempts = graceful ? [plain, replay] : [replay, plain]
  const options = { env, spawnFn, log: (message) => log('launch', message) }

  for (const target of attempts) {
    if (target === null) continue
    const child = launch({ execPath: target.execPath, args: target.args, cwd: target.cwd, label: target.label }, options)
    sleep(probeMs)
    if (!diedImmediately(child)) {
      log('helper', `新进程已在运行（${target.label}）pid=${child?.pid ?? '?'}`)
      return { ok: true, mode: target.kind, pid: child?.pid ?? null }
    }
    log('warn', `${target.label} 立刻退出（exitCode=${child?.exitCode ?? 'null'}）`)
  }
  log('error', '两种启动方式都没起来，放弃；请手动双击桌面图标')
  return { ok: false, reason: '两种启动方式都起不来' }
}

/** 直接跑这个文件时才当助手用（`node restart-helper.js <计划文件>`）。 */
function isMain() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isMain()) {
  const result = runHelper(process.argv[2])
  process.exit(result.ok ? 0 : 1)
}
