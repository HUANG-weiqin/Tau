// @ts-check
// 显示用的格式。不读时钟：现在几点由调用方传入。

/**
 * 时长：刚刚 / n 秒 / n 分钟 / n 小时 / n 天。
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (!(ms >= 5000)) return "刚刚";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/**
 * 正在跑的东西跑了多久，精确到秒，每秒都变：0 秒 / 12 秒 / 1 分 05 秒 / 1 小时 03 分。
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(m / 60)} 小时 ${String(m % 60).padStart(2, "0")} 分`;
}

/**
 * 多久以前：刚刚，或者“n 分钟前”。
 * @param {number} ms
 */
export function formatAgo(ms) {
  const d = formatDuration(ms);
  return d === "刚刚" ? d : `${d}前`;
}

/** @param {number} n */
const two = (n) => String(n).padStart(2, "0");

/**
 * 本地时间 HH:MM。
 * @param {number} ts
 */
export function formatClock(ts) {
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 上下文占窗口的百分比，取整，限制在 0 到 100。窗口为 0 时是 0。
 * @param {{ used: number, window: number }} ctx
 */
export function contextPercent(ctx) {
  if (!(ctx.window > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((ctx.used / ctx.window) * 100)));
}

/**
 * @param {{ used: number, window: number }} ctx
 */
export function formatContext(ctx) {
  return `${contextPercent(ctx)}%`;
}

/**
 * 字节数：B / KB / MB。
 * @param {number} n
 */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
