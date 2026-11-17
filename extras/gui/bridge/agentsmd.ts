// 把项目的 AGENTS.md 拼进预设提示词的末尾（D58：上层拼）。块前后各一行标记，块里的字由界面管，用户别手改。
// 只认 <工作目录>/AGENTS.md，不认 CLAUDE.md。块的格式和状态见 .knowledge/kb-gui.md。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HttpError } from "./util.ts";

/** 起始标记行的固定开头，后面接说明和文件路径。 */
export const BEGIN = "<!-- tau-gui:agents-md begin";
/** 结束标记行，整行就是它。 */
export const END = "<!-- tau-gui:agents-md end -->";
const MARK = "<!-- tau-gui:agents-md";

/** `none` 没有块；`fresh` 块和文件一致；`stale` 文件改过了；`missing` 有块但文件没了。 */
export type AgentsMdState = "none" | "fresh" | "stale" | "missing";

export interface AgentsFile {
  path: string;
  /** 按行拆开，去掉末尾的空行。 */
  lines: string[];
  bytes: number;
}

/** 读 `<workdir>/AGENTS.md`。没有这个文件（或不是文件）回 null。 */
export function readAgentsMd(workdir: string): AgentsFile | null {
  const file = path.join(workdir, "AGENTS.md");
  try {
    if (!statSync(file).isFile()) return null;
    const buf = readFileSync(file);
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return { path: file, lines, bytes: buf.length };
  } catch {
    return null;
  }
}

/** 要拼进去的整块（含两行标记）。文件为空、或里面有界面的标记行都拒绝。 */
export function buildBlock(f: AgentsFile): string[] {
  if (f.lines.length === 0) throw new HttpError(400, `AGENTS.md 是空的：${f.path}`);
  if (f.lines.some((l) => l.startsWith(MARK))) throw new HttpError(400, `AGENTS.md 里有界面用的标记行（${MARK}…），拼不进去：${f.path}`);
  return [`${BEGIN} | 这一段由界面从 AGENTS.md 拼进来，别手改 | ${f.path} -->`, ...f.lines, END];
}

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

/** 块和文件现在的关系。`block` 是预设里现有的块（没有是 null）。 */
export function stateOf(block: string[] | null, workdir: string): AgentsMdState {
  if (block === null) return "none";
  const f = readAgentsMd(workdir);
  if (f === null) return "missing";
  const body = block.slice(1, -1);
  return body.length === f.lines.length && body.every((l, k) => l === f.lines[k]) ? "fresh" : "stale";
}

/**
 * 预设文件头部之后的各行（`rest`，最后一个空串是文件末尾的换行）换上块。
 * - `block === undefined`：不动块。`prompt` 给了就换掉用户的部分，现有的块留着。
 * - `block === null`：去掉块。`block` 是数组：换成它，没有就加在末尾。
 * - `prompt === undefined` 时，用户写的字一行不动，包括末尾的空行：加块只在后面接一个空行和块，去块只去掉那一个空行和块。
 */
export function applyBlock(rest: string[], block: string[] | null | undefined, prompt: string | undefined): string[] {
  const nl = rest.length > 0 && rest[rest.length - 1] === "";
  const lines = nl ? rest.slice(0, -1) : rest.slice();
  const found = findBlock(lines);
  if (prompt !== undefined) {
    const keep = block === undefined ? (found ? lines.slice(found.i, found.j + 1) : null) : block;
    const p = prompt.trim();
    if (keep === null) return [p, ""];
    return [...(p === "" ? [] : [p, ""]), ...keep, ""];
  }
  if (block === undefined) return rest;
  if (found === null && block === null) return rest;
  if (block === null) return [...without(lines, found!), ""];
  if (found) return [...lines.slice(0, found.i), ...block, ...lines.slice(found.j + 1), ""];
  return [...lines, ...(lines.length > 0 ? [""] : []), ...block, ""];
}

/** `/api/agents-md`：表单用它决定默认勾不勾。`workdir` 要是存在的绝对路径。 */
export function agentsMdInfo(body: Record<string, unknown>): { exists: boolean; bytes?: number } {
  const w = body.workdir;
  if (typeof w !== "string" || !path.isAbsolute(w)) throw new HttpError(400, "workdir 必须是绝对路径");
  try {
    if (!statSync(w).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "工作目录不存在");
  }
  const f = readAgentsMd(w);
  return f === null ? { exists: false } : { exists: true, bytes: f.bytes };
}
