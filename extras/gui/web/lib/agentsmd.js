// @ts-check
// 提示词里 D58 留下的旧拼接块：认出它，从用户写的部分里分出来，保存时接回去。
// 桥的 `bridge/agentsmd.ts` 对预设文件做同样的事；会话快照的提示词不经桥，页面自己拆。两边的规则要一致，测试逐例对比。

/** 起始标记行的固定开头，后面接说明和文件路径。 */
export const BEGIN = "<!-- tau-gui:agents-md begin";
/** 结束标记行，整行就是它。 */
export const END = "<!-- tau-gui:agents-md end -->";

/**
 * 块在哪几行（含标记行）。有起始没有结束，当没有块：不替用户删不认识的字。
 * @param {readonly string[]} lines
 * @returns {{ i: number, j: number } | null}
 */
export function findBlock(lines) {
  const i = lines.findIndex((l) => l.startsWith(BEGIN));
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && l === END);
  return j < 0 ? null : { i, j };
}

/**
 * 一段提示词拆成用户写的部分和块。`user` 去掉了首尾空白；块前面那一个空行跟着块走。
 * @param {string} text
 * @returns {{ user: string, block: string[] | null }}
 */
export function splitPrompt(text) {
  const lines = text.split("\n");
  const b = findBlock(lines);
  if (!b) return { user: text.trim(), block: null };
  const from = b.i > 0 && lines[b.i - 1] === "" ? b.i - 1 : b.i;
  return { user: [...lines.slice(0, from), ...lines.slice(b.j + 1)].join("\n").trim(), block: lines.slice(b.i, b.j + 1) };
}

/**
 * 用户写的部分和旧块接成一段提示词：中间空一行。没有块就只有用户写的部分。
 * @param {string} user
 * @param {string[] | null} block
 */
export function joinPrompt(user, block) {
  const p = user.trim();
  if (block === null) return p;
  return p === "" ? block.join("\n") : `${p}\n\n${block.join("\n")}`;
}
