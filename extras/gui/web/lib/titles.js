// @ts-check
// 进程的标题。
import { clipText, parseUser } from "./messages.js";
/** @typedef {import("./types.js").Message} Message */
/** @typedef {import("./types.js").GuiState} GuiState */

/**
 * 第 1 段第一条用户消息里第一封信正文的第一个非空行（信头和说明不在正文里）。没有可用的行是 null。
 * 调用方把结果缓存进界面数据的 `titles`。
 * @param {readonly Message[]} segment1
 * @returns {string | null}
 */
export function extractTitle(segment1) {
  const first = segment1.find((m) => m.role === "user");
  if (!first || first.role !== "user") return null;
  const line = (parseUser(first).letters[0]?.text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line === undefined ? null : clipText(line, 80);
}

/**
 * 显示用的标题。界面自己分叉的进程沿用源进程的标题，`note` 写“分叉自 <ID>”；缓存里没有的是进程 ID。
 * `known` 是标题来自缓存。
 * @param {string} id
 * @param {Pick<GuiState, "titles" | "forkedFrom">} state
 * @returns {{ title: string, note?: string, known: boolean }}
 */
export function processTitle(id, state) {
  const src = state.forkedFrom[id];
  if (src !== undefined && src !== id) {
    const seen = new Set([id]);
    /** @type {string} */
    let root = src;
    while (!seen.has(root)) {
      seen.add(root);
      const up = state.forkedFrom[root];
      if (up === undefined) break;
      root = up;
    }
    const base = state.titles[root] ?? state.titles[src];
    return { title: base ?? root, note: `分叉自 ${src}`, known: base !== undefined };
  }
  const t = state.titles[id];
  return t === undefined ? { title: id, known: false } : { title: t, known: true };
}
