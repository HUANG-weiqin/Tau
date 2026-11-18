// 预设提示词里 D58 留下的旧拼接块：认出它，去掉它。块前后各一行标记（D58 原来由界面把 AGENTS.md 拼进提示词）。
// 现在项目的 AGENTS.md 由内核按预设的 `context` 在每次开段重读（D72），这里不再加块。
// 只认 <工作目录>/AGENTS.md，不认 CLAUDE.md。块的格式和状态见 .knowledge/kb-gui.md。
import { statSync } from "node:fs";
import path from "node:path";
import { HttpError } from "./util.ts";

/** 起始标记行的固定开头，后面接说明和文件路径。 */
export const BEGIN = "<!-- tau-gui:agents-md begin";
/** 结束标记行，整行就是它。 */
export const END = "<!-- tau-gui:agents-md end -->";

/** `none` 没有旧块；`legacy` 有旧块。 */
export type AgentsMdState = "none" | "legacy";

/** 块在哪几行（含标记行）。有起始没有结束，当没有块：不替用户删不认识的字。 */
export function findBlock(lines: readonly string[]): { i: number; j: number } | null {
  const i = lines.findIndex((l) => l.startsWith(BEGIN));
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && l === END);
  return j < 0 ? null : { i, j };
}

/** 把块拿掉：块前面我们加的那一个空行一起拿掉。 */
function without(lines: string[], b: { i: number; j: number }): string[] {
  const from = b.i > 0 && lines[b.i - 1] === "" ? b.i - 1 : b.i;
  return [...lines.slice(0, from), ...lines.slice(b.j + 1)];
}

/** 一段提示词文本拆成用户写的部分和块。`user` 去掉了首尾空白。 */
export function splitPrompt(text: string): { user: string; block: string[] | null } {
  const lines = text.split("\n");
  const b = findBlock(lines);
  if (!b) return { user: text.trim(), block: null };
  return { user: without(lines, b).join("\n").trim(), block: lines.slice(b.i, b.j + 1) };
}

export function stateOf(block: string[] | null): AgentsMdState {
  return block === null ? "none" : "legacy";
}

/**
 * 预设文件头部之后的各行（`rest`，最后一个空串是文件末尾的换行）换上新的提示词、或者去掉旧块。
 * - `prompt` 给了：换掉用户写的部分，旧块留着（`drop` 为真时一起去掉）。
 * - `prompt === undefined`：用户写的字一行不动，包括末尾的空行；`drop` 为真就只去掉块前面的那一个空行和块。
 * - 没有旧块时 `drop` 不起作用。
 */
export function applyBlock(rest: string[], drop: boolean, prompt: string | undefined): string[] {
  const nl = rest.length > 0 && rest[rest.length - 1] === "";
  const lines = nl ? rest.slice(0, -1) : rest.slice();
  const found = findBlock(lines);
  if (prompt !== undefined) {
    const keep = found && !drop ? lines.slice(found.i, found.j + 1) : null;
    const p = prompt.trim();
    if (keep === null) return [p, ""];
    return [...(p === "" ? [] : [p, ""]), ...keep, ""];
  }
  if (!drop || found === null) return rest;
  return [...without(lines, found), ""];
}

/** `/api/agents-md`：表单用它决定“用项目的 AGENTS.md”勾选可不可用、默认勾不勾。`workdir` 要是存在的绝对路径。 */
export function agentsMdInfo(body: Record<string, unknown>): { exists: boolean; bytes?: number } {
  const w = body.workdir;
  if (typeof w !== "string" || !path.isAbsolute(w)) throw new HttpError(400, "workdir 必须是绝对路径");
  try {
    if (!statSync(w).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "工作目录不存在");
  }
  try {
    const st = statSync(path.join(w, "AGENTS.md"));
    return st.isFile() ? { exists: true, bytes: st.size } : { exists: false };
  } catch {
    return { exists: false };
  }
}
