// 删进程之前先把它的标题缓存下来：删了以后第 1 段就没了，分叉出来的进程还要沿用这个标题（设计稿 7.7）。
import { tauStream, makeTitle } from "../api.js";
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

/** 已经试过自动起标题的进程。同一个进程只试一次，失败就算了，照旧显示第一行。 */
const tried = new Set();
/** 一个一个来，不并发调模型。 */
let chain = Promise.resolve();

/**
 * 让桥给这个人建的根进程起标题，存进界面数据的 `titles`，并记进 `titled`。
 * 模型：设置里的标题模型，没有就是默认模型，再没有就是这个进程自己的模型。
 * @param {import("../app.js").App} app
 * @param {{ id: string, self: { model: string } }} e
 */
export function autoTitle(app, e) {
  if (tried.has(e.id)) return;
  tried.add(e.id);
  const model = app.gui.titleModel ?? app.gui.defaultModel ?? e.self.model;
  const id = e.id;
  chain = chain.then(async () => {
    try {
      const title = await makeTitle(id, model);
      await app.setGui((g) => (g.titled.includes(id) ? {} : { titles: { ...g.titles, [id]: title }, titled: [...g.titled, id] }));
    } catch {
      // 失败就算了。
    }
  });
}
