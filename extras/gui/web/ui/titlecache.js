// 删进程之前先把它的标题缓存下来：删了以后第 1 段就没了，分叉出来的进程还要沿用这个标题（设计稿 7.7）。
import { tauStream } from "../api.js";
import { extractTitle } from "../lib/titles.js";

/**
 * 读第 1 段的第一封信，取标题。读不到是 null。
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function readTitle(id) {
  /** @type {any} */
  let first = null;
  try {
    await tauStream({ op: "history", process: id, segment: 1, from: 0 }, (r) => {
      if (r.type === "message" && r.message.role === "user") {
        first = r.message;
        return true;
      }
      return r.type === "end" || r.type === "error";
    });
  } catch {
    return null;
  }
  return first ? extractTitle([first]) : null;
}

/**
 * 把这几个进程的标题记进界面数据。已经有标题的不重读；分叉出来的进程，把它沿用到的标题记在自己名下，它的源进程以后被清掉，它的分叉也认得。
 * 缓存失败不拦着后面的删除，只是以后显示进程 ID。
 * @param {import("../app.js").App} app
 * @param {string[]} ids
 */
export async function cacheTitles(app, ids) {
  /** @type {Record<string, string>} */
  const batch = {};
  for (const id of ids) {
    const t = app.titleOf(id);
    if (t.known) {
      if (app.gui.titles[id] === undefined) batch[id] = t.title;
      continue;
    }
    const read = await readTitle(id);
    if (read !== null) batch[id] = read;
  }
  if (Object.keys(batch).length === 0) return;
  try {
    await app.setGui((g) => ({ titles: { ...g.titles, ...batch } }));
  } catch {
    // 提示已经弹了。
  }
}
