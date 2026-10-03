/**
 * dsh-ui-refresh — 分离重启助手。
 *
 * 宿主半边用 `spawn(execPath, [助手的绝对路径, 计划文件], { detached: true, stdio: 'ignore',
 * env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })` 把它拉起来，然后自己退出。它就是那句
 * "先等旧的死、再起新的"：
 *
 *   1. 等 `plan.pid` 彻底消失（轮询 `process.kill(pid, 0)`）—— 桌面外壳有单实例锁，
 *      新进程先起会抢不到锁并立刻自杀；
 *   2. 用 `plan.execPath` + `plan.args` **原样重放**（宿主是 Electron 本体，
 *      `--expose-internals`、desktop-host 入口、profile 目录这些参数缺一不可）；
 *   3. 观察一小会儿，若新进程立刻死了，再用 `plan.fallback`（等同双击桌面图标：
 *      exe + 无参数 + 它自己的目录）起一次；
 *   4. 全程写 `plan.logPath`，起不来时用户照那行日志就能定位。
 *
 * 这里不 `import` 任何宿主服务：它要能在"Electron 二进制 + ELECTRON_RUN_AS_NODE=1"
 * 和普通 `node` 两种载体下都跑得起来。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXIT_TIMEOUT_MS, PROBE_MS, logLine, planSummary, validatePlan } from './restart-plan.js'

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

  log('helper', `开始；计划 ${planPath}`)
  log('helper', planSummary(plan))
  const waited = wait(plan.pid, {})
  log(
    waited.exited ? 'helper' : 'warn',
    waited.exited
      ? `旧进程 ${plan.pid} 已退出（等了 ${waited.waitedMs}ms），开始重放`
      : `旧进程 ${plan.pid} 超过 ${EXIT_TIMEOUT_MS}ms 仍活着，仍然按计划启动新进程`,
  )

  const options = { env, spawnFn, log: (message) => log('launch', message) }
  const first = launch({ execPath: plan.execPath, args: plan.args, cwd: plan.cwd, label: '原样重放' }, options)
  sleep(probeMs)
  if (diedImmediately(first)) {
    log('warn', `原样重放立刻退出（exitCode=${first?.exitCode ?? 'null'}）`)
    if (plan.fallback === null || plan.fallback === undefined) {
      return { ok: false, reason: '原样重放起不来，且计划里没有兜底命令' }
    }
    const second = launch(
      { execPath: plan.fallback.execPath, args: plan.fallback.args ?? [], cwd: plan.fallback.cwd, label: '兜底（等同双击桌面图标）' },
      options,
    )
    sleep(probeMs)
    if (diedImmediately(second)) {
      log('error', '兜底命令也立刻退出，放弃；请手动双击桌面图标')
      return { ok: false, reason: '兜底命令也起不来' }
    }
    log('helper', `新进程已在运行（兜底方式）pid=${second?.pid ?? '?'}`)
    return { ok: true, mode: 'fallback', pid: second?.pid ?? null }
  }
  log('helper', `新进程已在运行（原样重放）pid=${first?.pid ?? '?'}`)
  return { ok: true, mode: 'replay', pid: first?.pid ?? null }
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
