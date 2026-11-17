// 工具定义页的桥：列 `<home>/tools/*.json`，列工具库（extras/tools），装、更新、删。
// 工具定义的格式不许多余字段，所以“是不是库装的”靠和库里的定义逐项比较。不导入 src/。
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CATALOG, definitionOf } from "../../tools/catalog.ts";
import type { ToolEntry } from "../../tools/catalog.ts";
import { parseCommand } from "../../mcp/gen.ts";
import { HttpError } from "./util.ts";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** 工具库的位置，正斜杠：写进命令里的路径。 */
const LIB_DIR = path.resolve(import.meta.dirname, "..", "..", "tools").replace(/\\/g, "/");

export type LibStatus = "none" | "installed" | "differs";

export interface InstalledTool {
  name: string;
  /** 读得出时才有下面几项。 */
  description?: string;
  params?: string[];
  timeout?: number;
  output?: string;
  command?: string;
  /** 读不出：原因。 */
  error?: string;
  /** 用到它的预设 ID。 */
  usedBy: string[];
  /** MCP 生成的定义：命令指向 `extras/mcp/call.ts` 时才有，读出服务器名和工具名。 */
  mcp?: { server: string; tool: string };
}

export interface LibraryTool {
  name: string;
  description: string;
  params: string[];
  timeout: number;
  output: string;
  command: string;
  status: LibStatus;
}

const paramNames = (parameters: unknown): string[] => {
  const props = (parameters as { properties?: unknown } | null)?.properties;
  return typeof props === "object" && props !== null ? Object.keys(props) : [];
};

/** 键排序后的 JSON，用来比较两个定义。 */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 读 `<dir>/<name>.json`：文本和解析结果。没有这个文件是 null。 */
export function readDef(dir: string, name: string): { value: unknown } | { error: string } | null {
  let text: string;
  try {
    text = readFileSync(path.join(dir, `${name}.json`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { error: `读不出：${(e as Error).message}` };
  }
  try {
    return { value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch {
    return { error: "不是合法的 JSON" };
  }
}

/** 每个预设的 `tools:` 一行里的名字。读不出的预设跳过。 */
export function presetTools(home: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: string[];
  try {
    names = readdirSync(path.join(home, "presets"));
  } catch {
    return out;
  }
  for (const n of names.filter((f) => f.endsWith(".md"))) {
    let lines: string[];
    try {
      lines = readFileSync(path.join(home, "presets", n), "utf8").replace(/^﻿/, "").split(/\r?\n/);
    } catch {
      continue;
    }
    const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    if (end < 0) continue;
    const line = lines.slice(1, end).find((l) => /^tools\s*:/.test(l));
    if (line !== undefined) out.set(n.slice(0, -3), line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim()).filter((s) => s !== ""));
  }
  return out;
}

function usedBy(home: string, name: string): string[] {
  return [...presetTools(home)].filter(([, tools]) => tools.includes(name)).map(([id]) => id).sort();
}

function entryDef(e: ToolEntry): Record<string, unknown> {
  return definitionOf(e, LIB_DIR);
}

export function listTools(home: string): { installed: InstalledTool[]; library: LibraryTool[] } {
  const dir = path.join(home, "tools");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // 没有目录：一个都没装。
  }
  const users = presetTools(home);
  const used = (name: string) => [...users].filter(([, tools]) => tools.includes(name)).map(([id]) => id).sort();
  const installed: InstalledTool[] = files
    .filter((f) => f.endsWith(".json") && NAME.test(f.slice(0, -5)))
    .sort()
    .map((f) => {
      const name = f.slice(0, -5);
      const r = readDef(dir, name);
      if (r === null || "error" in r) return { name, error: r === null ? "读不出" : r.error, usedBy: used(name) };
      const v = r.value;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return { name, error: "不是 JSON 对象", usedBy: used(name) };
      const d = v as Record<string, unknown>;
      const mcp = typeof d.command === "string" ? parseCommand(d.command) : null;
      return {
        name,
        ...(typeof d.description === "string" ? { description: d.description } : {}),
        params: paramNames(d.parameters),
        ...(typeof d.timeout === "number" ? { timeout: d.timeout } : {}),
        ...(typeof d.output === "string" ? { output: d.output } : {}),
        ...(typeof d.command === "string" ? { command: d.command } : {}),
        ...(mcp === null ? {} : { mcp }),
        usedBy: used(name),
      };
    });
  const library: LibraryTool[] = CATALOG.map((e) => {
    const def = entryDef(e);
    const have = readDef(dir, e.name);
    const status: LibStatus = have === null ? "none" : "value" in have && canon(have.value) === canon(def) ? "installed" : "differs";
    return { name: e.name, description: e.description, params: paramNames(e.parameters), timeout: e.timeout, output: e.output, command: String(def.command), status };
  });
  return { installed, library };
}

/** 装或更新一个库里的工具。同名文件内容不同，没有 `replace` 就拒绝（409）。写临时文件再改名。 */
export function installTool(home: string, body: Record<string, unknown>): LibStatus {
  const name = body.name;
  const e = typeof name === "string" ? CATALOG.find((c) => c.name === name) : undefined;
  if (e === undefined) throw new HttpError(404, `工具库里没有这个工具：${String(name)}`);
  if (/["$`]/.test(LIB_DIR)) throw new HttpError(500, `工具库的路径含有引号、$ 或反引号，写不进命令：${LIB_DIR}`);
  if (body.replace !== undefined && typeof body.replace !== "boolean") throw new HttpError(400, "replace 必须是布尔值");
  const def = entryDef(e);
  const dir = path.join(home, "tools");
  const have = readDef(dir, e.name);
  if (have !== null && "value" in have && canon(have.value) === canon(def)) return "installed";
  if (have !== null && body.replace !== true) throw new HttpError(409, `已经有一个同名的工具定义 ${e.name}.json，内容和工具库里的不同。要换成工具库的，选更新。`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${e.name}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(def, null, 2)}\n`);
  renameSync(tmp, file);
  return "installed";
}

/** 删 `<home>/tools/<name>.json`。有预设用到它就拒绝（409），说是哪些。 */
export function removeTool(home: string, body: Record<string, unknown>): void {
  const name = body.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new HttpError(400, "name 只许字母、数字、下划线和连字符");
  const users = usedBy(home, name);
  if (users.length > 0) throw new HttpError(409, `预设 ${users.join("、")} 在用它，先从预设里去掉。`);
  try {
    unlinkSync(path.join(home, "tools", `${name}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `没有这个工具定义：${name}`);
    throw e;
  }
}
