// 工具定义：`~/.tau/tools/<name>.json`（设计稿 5.5，格式见 .knowledge/kb-tools.md）。读不出一律抛错，原因是错误信息。
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolsFor } from "../kernel/tools.ts";
import type { PresetTool, ToolDef } from "../kernel/types.ts";

/** 一个定义的大小上限：`JSON.stringify({ description, parameters })` 的 UTF-8 字节数。 */
export const TOOL_DEF_MAX_BYTES = 16 * 1024;
/** 一个预设用到的全部定义的大小上限：各自 `JSON.stringify` 的 UTF-8 字节数相加。 */
export const TOOL_DEFS_MAX_BYTES = 64 * 1024;

const KEYS = ["description", "parameters", "command", "timeout", "output"];
const GROUPS = ["memory", "agents"];
const ALL: PresetTool[] = ["read", "write", "edit", "bash", "memory", "agents"];
/** 内置工具和工具组的名字，工具定义不能重名。 */
const RESERVED = new Set([...toolsFor({ tools: ALL, toolDefs: [] }).map((t) => t.name), ...GROUPS]);

export function toolsDir(): string {
  return path.join(os.homedir(), ".tau", "tools");
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

export function loadToolDef(dir: string, name: string): ToolDef {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`工具名不合法：${name}`);
  if (RESERVED.has(name)) throw new Error(`工具定义 ${name} 和内置工具或工具组重名`);
  const file = `${name}.json`;
  let text: string;
  try {
    // 精确匹配目录项，和预设一样。
    if (!readdirSync(dir).includes(file)) throw new Error();
    text = readFileSync(path.join(dir, file), "utf8");
  } catch {
    throw new Error(`找不到工具定义：${name}`);
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`工具定义 ${name} 不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`工具定义 ${name} 必须是 JSON 对象`);
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!KEYS.includes(key)) throw new Error(`工具定义 ${name} 有未知字段：${key}`);
  const { description, parameters, command, timeout = 120, output = "text" } = o;
  if (typeof description !== "string") throw new Error(`工具定义 ${name} 的 description 必须是字符串`);
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || (parameters as Record<string, unknown>).type !== "object") {
    throw new Error(`工具定义 ${name} 的 parameters 必须是 type 为 object 的 JSON Schema`);
  }
  if (typeof command !== "string") throw new Error(`工具定义 ${name} 的 command 必须是字符串`);
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error(`工具定义 ${name} 的 timeout 必须是 1 到 600 的整数`);
  if (output !== "text" && output !== "content") throw new Error(`工具定义 ${name} 的 output 只能是 text 或 content`);
  const size = bytes({ description, parameters });
  if (size > TOOL_DEF_MAX_BYTES) throw new Error(`工具定义 ${name} 的说明和参数有 ${size} 字节，上限 ${TOOL_DEF_MAX_BYTES} 字节`);
  return { name, description, parameters: parameters as ToolDef["parameters"], command, timeout, output };
}

/** 按顺序读一个预设用到的全部定义，再查总大小。`names` 已去重。 */
export function loadToolDefs(dir: string, names: readonly string[]): ToolDef[] {
  const defs = names.map((n) => loadToolDef(dir, n));
  const total = defs.reduce((sum, d) => sum + bytes(d), 0);
  if (total > TOOL_DEFS_MAX_BYTES) throw new Error(`用到的工具定义共 ${total} 字节，上限 ${TOOL_DEFS_MAX_BYTES} 字节`);
  return defs;
}
