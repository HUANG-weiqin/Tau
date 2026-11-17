// @ts-check
// 进程的标题。
import { clipText, parseUser } from "./messages.js";
/** @typedef {import("./types.js").Message} Message */
/** @typedef {import("./types.js").GuiState} GuiState */

/**
 * 一条用户消息里第一封信的正文。不是用户消息或没有正文是空串。
 * @param {unknown} m
 * @returns {string}
 */
export function firstLetterText(m) {
  const msg = /** @type {Message} */ (m);
  return msg && msg.role === "user" ? (parseUser(msg).letters[0]?.text ?? "") : "";
}

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
 * 这个进程该不该自动起标题：人建的根进程（没有 parent）、第一封信已经在了、没生成过。
 * 预设的进程（`kind` 不是 temp）有预设的名字，不用标题。
 * @param {{ id: string, kind: string, self: { parent?: string, messages: number } }} e
 * @param {Pick<GuiState, "titled">} state
 */
export function wantsAutoTitle(e, state) {
  return e.kind === "temp" && e.self.parent === undefined && e.self.messages > 0 && !state.titled.includes(e.id);
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
