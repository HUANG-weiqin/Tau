// @ts-check
// 完成通知、标签页标题的纯逻辑。“待你看”的定义在 derive.js 的 `attention`，这里不重写。
import { plainFirstLine } from "./plain.js";

/** 标签页标题：有待你看的进程时 “(N) tau”。 @param {number} n */
export function tabTitle(n) {
  return n > 0 ? `(${n}) tau` : "tau";
}

/**
 * 谁刚进入“待你看”。
 * `prev` 是上一次看到的那批进程 ID，null 表示还没看过；`ready` 为假（数据没读全）时不动。
 * 第一次看到（页面刚打开）只记下，不算进入。离开再进入算新的一轮。
 * @param {ReadonlySet<string> | null} prev @param {readonly string[]} ids @param {boolean} ready
 * @returns {{ next: ReadonlySet<string> | null, entered: string[] }}
 */
export function watchAttention(prev, ids, ready) {
  if (!ready) return { next: prev, entered: [] };
  const next = new Set(ids);
  if (prev === null) return { next, entered: [] };
  return { next, entered: ids.filter((id) => !prev.has(id)) };
}

/**
 * 该不该弹通知：开关开着、浏览器许可了、页面不在前台。
 * @param {{ enabled: boolean, permission: string, away: boolean }} o
 */
export function shouldNotify(o) {
  return o.enabled && o.permission === "granted" && o.away;
}

/** 第一个非空行，超过 `max` 个字就截短。 @param {string} text @param {number} [max] */
export function firstLine(text, max = 80) {
  const line = plainFirstLine(text);
  const chars = Array.from(line);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : line;
}

/**
 * 当前段里最后一条助手消息的文字。没有文字（只调了工具）时是空串。
 * @param {readonly { role: string, content?: unknown }[]} messages
 */
export function lastReply(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    return m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  }
  return "";
}

/**
 * 通知的标题和正文：标题是进程的显示名，正文是结束原因加最终回复的第一行。
 * @param {string} name @param {string} ended @param {string} reply
 */
export function notifyText(name, ended, reply) {
  const line = firstLine(reply);
  return { title: name, body: line === "" ? ended : `${ended}：${line}` };
}

/**
 * “新结果”：根进程（人建的，没有父进程）一轮结束，不管什么原因。出错的子进程走 `attention`，这里不管。
 * `prev` 是上一次的结果，null 表示还没看过：第一次只记下谁在跑，已经结束的轮不算。`ready` 为假时不动。
 * 用户在页面前台、聚焦到某个进程，它的新结果就清掉；页面不在前台时不清（人不在看）。
 * 没了的进程也清掉。`ended` 是这一次刚结束的根进程。
 * @typedef {{ busy: Readonly<Record<string, boolean>>, results: ReadonlySet<string> }} Results
 * @param {Results | null} prev
 * @param {readonly { id: string, root: boolean, busy: boolean }[]} procs
 * @param {{ focusedId: string | null, away: boolean, ready: boolean }} o
 * @returns {{ next: Results | null, ended: string[] }}
 */
export function trackResults(prev, procs, o) {
  if (!o.ready) return { next: prev, ended: [] };
  const busy = Object.fromEntries(procs.map((p) => [p.id, p.busy]));
  if (prev === null) return { next: { busy, results: new Set() }, ended: [] };
  const ended = procs.filter((p) => p.root && !p.busy && prev.busy[p.id] === true).map((p) => p.id);
  const alive = new Set(procs.map((p) => p.id));
  const results = new Set([...prev.results, ...ended].filter((id) => alive.has(id) && (o.away || id !== o.focusedId)));
  return { next: { busy, results }, ended };
}

/** 标题和图标算的数：待你看和新结果去重后的进程数。 @param {readonly string[]} attentionIds @param {ReadonlySet<string>} results */
export function unseenCount(attentionIds, results) {
  return new Set([...attentionIds, ...results]).size;
}
