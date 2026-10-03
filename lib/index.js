/**
 * dsh-ui-refresh — host half.
 *
 * 故意空实现：全部逻辑在浏览器半边（`lib/client.js`）。这里只需要是一个能被 cordis
 * 加载的插件：本包用 `cordis.patch.yml` 做一条**纯 insert**（只把本插件插进组合树，
 * 不动任何别人的条目），所以内核与市场都把它当正规插件安装。
 *
 * 为什么不能只声明 `dsh.client`（2026-10-03 实测的坑）：安装入口拿
 * `bundleManifest()` 读到 `dsh.bundle === undefined` 就 `ManagementFailure('not-bundle')`
 * 并回滚 —— 界面上就是「这个包没有声明组合包，不能作为插件管理」。只声明 `dsh.client`
 * 的那条 client-only shim 路子（dshmarket `lib/hot.js:543`）只对**已经躺在 dependencies
 * 里**的包生效（`mountClientOnlyDeps()` 每次市场启动扫一遍），救不了安装那一步。
 *
 * 两条硬约束（来自 dsh-surface-unify 的教训）：
 *   · 顶层**不声明 inject**：cordis 在 inactive ctx 下解析 inject 会抛
 *     `cannot get required service ... in inactive context`，那个错发生在 apply
 *     之前，apply 里的 try/catch 拦不住，会让整个 `dsh web` 起不来。
 *   · apply 也不做事，但同样不抛。
 */
export const name = 'dsh-ui-refresh'

export const inject = []

export function apply() {}
