/**
 * dsh-ui-refresh — host half.
 *
 * 故意空实现：全部逻辑在浏览器半边（`lib/client.js`）。这里只需要是一个能被 cordis
 * 加载的插件 —— 这个包没有 `dsh.bundle`（纯客户端插件），市场会为它建一条
 * client-only shim 条目，宿主侧导入的就是本文件。
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
