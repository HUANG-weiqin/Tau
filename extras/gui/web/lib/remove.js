// @ts-check
// 删进程连带它开的进程（设计稿 7.7）：按 parent 找出整棵子树，从叶子删起。
/** @typedef {import("./types.js").Self} Self */

/**
 * @typedef {object} RemovePlan
 * @property {string[]} order 删除顺序：叶子在前，最后是目标自己。
 * @property {Record<string, number>} depth 离目标几层，目标是 0。
 * @property {Record<string, string | undefined>} parent 子树里每个进程的父进程，目标的父进程不算。
 * @property {string[]} running 子树里不空闲的进程，按删除顺序。
 */

/**
 * 子树和删除顺序。靠 parent 指针往下找，每个进程只算一次，所以环也不会死循环。目标不在表里时只有它自己。
 * @param {string} id
 * @param {Pick<Self, "id" | "phase" | "parent">[]} all 全部进程。
 * @returns {RemovePlan}
 */
export function removePlan(id, all) {
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  for (const s of all) {
    if (s.parent === undefined) continue;
    const l = kids.get(s.parent);
    if (l) l.push(s.id);
    else kids.set(s.parent, [s.id]);
  }
  /** @type {string[]} */
  const order = [];
  /** @type {Record<string, number>} */
  const depth = {};
  /** @type {Record<string, string | undefined>} */
  const parent = {};
  /** @param {string} x @param {number} d */
  const walk = (x, d) => {
    depth[x] = d;
    for (const c of (kids.get(x) ?? []).sort()) {
      if (c in depth) continue;
      parent[c] = x;
      walk(c, d + 1);
    }
    order.push(x);
  };
  walk(id, 0);
  const busy = new Set(all.filter((s) => s.phase.tag !== "idle").map((s) => s.id));
  return { order, depth, parent, running: order.filter((x) => busy.has(x)) };
}

/**
 * 被拒绝的进程，它的祖先（只算删除顺序里的）也删不掉，要跳过。别的分支不受影响。
 * @param {string[]} order
 * @param {Record<string, string | undefined>} parent
 * @param {Iterable<string>} refused
 * @returns {string[]} 按删除顺序。
 */
export function skippedFor(order, parent, refused) {
  const bad = new Set(refused);
  const skip = new Set();
  for (const r of bad) {
    const seen = new Set([r]);
    for (let p = parent[r]; p !== undefined && !seen.has(p); p = parent[p]) {
      seen.add(p);
      if (!bad.has(p)) skip.add(p);
    }
  }
  return order.filter((x) => skip.has(x));
}
