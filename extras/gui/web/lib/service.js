// @ts-check
// 旧代码横幅的纯逻辑。

/**
 * 横幅要不要显示、显示什么。纯函数。
 * @param {any} st `/api/service` 的回复
 * @returns {{ service: boolean, bridge: boolean }}
 */
export function staleOf(st) {
  return { service: !!(st && st.service && st.service.up && st.service.stale), bridge: !!(st && st.bridge && st.bridge.stale) };
}

/** 确认框里的话。 @param {number} n */
export function confirmText(n) {
  return `会中断 ${n} 个在跑的进程。在跑的工具调用会报“被中断”，不自动重做。`;
}
