// @ts-check
// 批量操作的顺序：全部停止，清理旧进程。
import { activityAt, currentOf } from "./derive.js";
/** @typedef {import("./derive.js").Entry} Entry */
/** @typedef {import("./types.js").GuiState} GuiState */

/**
 * 沿 `parent` 往上数的层数。有环或父进程不在表里就停。
 * @param {string} id
 * @param {Map<string, Entry>} byId
 */
function depth(id, byId) {
  const seen = new Set([id]);
  let d = 0;
  let cur = byId.get(id)?.self.parent;
  while (cur !== undefined && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = byId.get(cur)?.self.parent;
  }
  return d;
}

/**
 * 全部停止一轮的顺序：在跑的进程，子孙在前，祖先在后（越深越先），同一层按 ID。
 * 被停的一轮会寄回信，可能唤醒别的进程，所以调用方在 `ps` 里还有在跑的就再算一轮。
 * 层数用 `all` 里的全部进程（含空闲的）算：空闲的中间进程不挡着。
 * @param {Entry[]} all 项目里的全部进程
 * @returns {string[]}
 */
export function stopOrder(all) {
  const byId = new Map(all.map((e) => [e.id, e]));
  return all
    .filter((e) => e.status === "running")
    .map((e) => ({ id: e.id, d: depth(e.id, byId) }))
    .sort((a, b) => b.d - a.d || (a.id < b.id ? -1 : 1))
    .map((x) => x.id);
}

/**
 * 清理计划（设计稿 7.5）。候选：空闲超过 `cleanDays` 天的临时进程，和常驻预设里不是当前进程的空闲进程（同样超过天数）。
 * 没读过最后动静时刻（`lastAt` 没有它）的进程不进候选：时刻是猜的，删除又不可逆。
 * 当前进程永远不清理：界面数据记的，和没记时按规则算出的。总管的当前进程也一样。
 * 它开的进程不在这次清理里（还在跑，或者不够旧）：这个进程删不了，列进 `blocked`；删不了的连带它的祖先。
 * `remove` 从叶子排起。
 * @param {Entry[]} all 全部进程
 * @param {{ state: GuiState, lastAt: Record<string, number>, clientNow: number }} o
 * @returns {{ remove: string[], blocked: { id: string, reason: string }[] }}
 */
export function cleanPlan(all, o) {
  const byId = new Map(all.map((e) => [e.id, e]));
  const protectedIds = new Set(Object.values(o.state.current));
  for (const preset of new Set(all.filter((e) => e.kind !== "temp").map((e) => e.preset))) {
    // 没读过最后动静的进程不参与：它们的时刻只能猜，猜错就会保护错的、放过在用的。
    const c = currentOf(preset, all.filter((e) => e.kind !== "temp" && o.lastAt[e.id] !== undefined), o.state, o.lastAt);
    if (c) protectedIds.add(c.id);
  }
  const limit = o.state.cleanDays * 24 * 60 * 60 * 1000;
  const candidates = new Set(
    all
      .filter((e) => (e.status === "idle" || e.status === "error" || e.status === "fresh") && !protectedIds.has(e.id) && o.lastAt[e.id] !== undefined && o.clientNow - activityAt(e, o.lastAt) > limit)
      .filter((e) => e.kind === "temp" || e.kind === "team" || e.kind === "chief")
      .map((e) => e.id),
  );
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  for (const e of all) {
    const p = e.self.parent;
    if (p !== undefined && byId.has(p)) kids.set(p, [...(kids.get(p) ?? []), e.id]);
  }
  /** @type {Map<string, string>} */
  const blocked = new Map();
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...candidates]) {
      const left = (kids.get(id) ?? []).filter((k) => !candidates.has(k));
      if (left.length === 0) continue;
      candidates.delete(id);
      blocked.set(id, `它开的进程还在：${left.join("、")}`);
      changed = true;
    }
  }
  return {
    remove: [...candidates].sort((a, b) => depth(b, byId) - depth(a, byId) || (a < b ? -1 : 1)),
    blocked: [...blocked].map(([id, reason]) => ({ id, reason })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
