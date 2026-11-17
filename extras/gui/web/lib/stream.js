// @ts-check
// 流式预览：一次模型调用边写边推来的三种片段，按 `kind` 分开存。纯函数，不碰 DOM，不读时钟。
// 正文（没有 `kind`）是最终回答的文字，走吐字；`thinking` 是思考，直接追加；`toolCall` 是工具调用参数的 JSON 片段，
// 同一次调用里多个工具的参数接在一起，片段里没有工具名。不认识的 `kind` 丢掉，不当成正文。

/** 思考最多存这么多字，超出丢开头。 */
export const THINK_KEEP = 100000;
/** 参数只存最后这么多字；总字数另记。 */
export const ARGS_KEEP = 2000;

/** @typedef {{ n: number, text: string, thinking: string, args: string, argsLen: number }} Live */

/**
 * @param {number} n
 * @returns {Live}
 */
export function emptyLive(n) {
  return { n, text: "", thinking: "", args: "", argsLen: 0 };
}

/**
 * 并进一块流式文字。编号变大：新的一次调用，从头来；变小：过时的，丢掉。
 * @param {Live | undefined} cur
 * @param {{ n: number, delta: string, kind?: string }} r
 * @returns {Live | undefined} 没变就是原来那个对象
 */
export function appendDelta(cur, r) {
  if (cur && r.n < cur.n) return cur;
  if (r.kind !== undefined && r.kind !== "thinking" && r.kind !== "toolCall") return cur;
  const base = cur && cur.n === r.n ? cur : emptyLive(r.n);
  if (r.kind === undefined) return { ...base, text: base.text + r.delta };
  if (r.kind === "thinking") {
    const t = base.thinking + r.delta;
    return { ...base, thinking: t.length > THINK_KEEP ? t.slice(t.length - THINK_KEEP) : t };
  }
  const a = base.args + r.delta;
  return { ...base, args: a.length > ARGS_KEEP ? a.slice(a.length - ARGS_KEEP) : a, argsLen: base.argsLen + r.delta.length };
}

/**
 * 最后 `max` 行。`hidden` 是被省掉的行数。末尾的空行不算。
 * @param {string} s
 * @param {number} max
 * @returns {{ text: string, hidden: number }}
 */
export function tailLines(s, max) {
  const lines = s.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length <= max) return { text: lines.join("\n"), hidden: 0 };
  return { text: lines.slice(lines.length - max).join("\n"), hidden: lines.length - max };
}

/**
 * 参数的预览：压成一行，只留最后 `max` 个字（头上加省略号）。
 * @param {string} args
 * @param {number} max
 */
export function argsPreview(args, max) {
  const flat = args.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : "…" + chars.slice(chars.length - max).join("");
}
