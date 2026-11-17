// @ts-check
// 删进程前，界面看得见的两条拒绝条件（设计稿 7.7）：进程在跑，它开的进程还在。
/** @typedef {import("./types.js").Self} Self */

/**
 * 删不掉它的原因。都不是就是 `null`：看不见的两条（有人等它回信、信箱里有它的输入）由服务在删的时候拒绝。
 * @param {string} id
 * @param {Pick<Self, "id" | "phase" | "parent">[]} all 全部进程。
 * @returns {{ running: boolean, children: string[] } | null}
 */
export function removeBlock(id, all) {
  const me = all.find((s) => s.id === id);
  const running = !!me && me.phase.tag !== "idle";
  const children = all.filter((s) => s.parent === id).map((s) => s.id).sort();
  return running || children.length > 0 ? { running, children } : null;
}

/** 一句话说清删不掉的原因。 @param {{ running: boolean, children: string[] }} b */
export function removeBlockText(b) {
  const out = [];
  if (b.running) out.push("进程在跑。先停止它。");
  if (b.children.length > 0) out.push(`它开的进程还在：${b.children.join("、")}。要先删它们。`);
  return out.join("");
}
