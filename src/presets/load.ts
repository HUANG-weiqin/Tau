import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { PresetSnapshot, PresetTool } from "../kernel/types.ts";

const TOOLS: readonly PresetTool[] = ["read", "write", "edit", "bash", "memory"];
const KEYS = ["workdir", "model", "tools"];

export function presetsDir(): string {
  return path.join(os.homedir(), ".tau", "presets");
}

function isTool(s: string): s is PresetTool {
  return (TOOLS as readonly string[]).includes(s);
}

export function loadPreset(dir: string, id: string, models: Models): PresetSnapshot {
  if (id === "" || /[/\\:]|\.\./.test(id)) throw new Error(`预设 ID 不合法：${id}`);
  let text: string;
  try {
    text = readFileSync(path.join(dir, `${id}.md`), "utf8");
  } catch {
    throw new Error(`找不到预设：${id}`);
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`预设 ${id} 缺少开头的 ---`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`预设 ${id} 缺少结束的 ---`);

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at < 0) throw new Error(`预设 ${id} 的前置信息格式错误：${line}`);
    const key = line.slice(0, at).trim();
    if (!KEYS.includes(key)) throw new Error(`预设 ${id} 有未知字段：${key}`);
    if (fields.has(key)) throw new Error(`预设 ${id} 重复的字段：${key}`);
    fields.set(key, line.slice(at + 1).trim());
  }
  for (const key of KEYS) {
    if (!fields.has(key)) throw new Error(`预设 ${id} 缺少字段：${key}`);
  }

  const workdir = path.resolve(fields.get("workdir") ?? "");
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new Error(`预设 ${id} 的工作目录不存在：${workdir}`);
  }

  const model = fields.get("model") ?? "";
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (slash < 0 || provider === "" || modelId === "") throw new Error(`预设 ${id} 的模型格式应为 <provider>/<model-id>：${model}`);
  const found = models.getModel(provider, modelId);
  if (!found) throw new Error(`模型目录里没有 ${model}`);

  const tools: PresetTool[] = [];
  for (const item of (fields.get("tools") ?? "").split(",").map((s) => s.trim())) {
    if (item === "") continue;
    if (!isTool(item)) throw new Error(`预设 ${id} 有未知工具：${item}`);
    if (!tools.includes(item)) tools.push(item);
  }

  return {
    id,
    workdir,
    model,
    tools,
    prompt: lines.slice(end + 1).join("\n").trim(),
    contextWindow: found.contextWindow,
  };
}
