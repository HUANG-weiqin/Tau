import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type { PresetSnapshot, PresetTool } from "../kernel/types.ts";
import { loadToolDefs } from "./tooldefs.ts";

const TOOLS: readonly PresetTool[] = ["read", "write", "edit", "bash", "memory", "agents"];
const REQUIRED = ["workdir", "model", "tools"];
const KEYS = [...REQUIRED, "thinking", "handoff"];
const THINKING: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function presetsDir(): string {
  return path.join(os.homedir(), ".tau", "presets");
}

function isThinking(s: string): s is ThinkingLevel {
  return (THINKING as readonly string[]).includes(s);
}

function isTool(s: string): s is PresetTool {
  return (TOOLS as readonly string[]).includes(s);
}

/** `dir` 是预设目录，`toolsDir` 是工具定义目录；预设的 tools 里不是内置工具的名字，都按工具定义读，一起冻结进快照。 */
export function loadPreset(dir: string, id: string, models: Models, toolsDir: string): PresetSnapshot {
  if (id === "" || /[/\\:]|\.\./.test(id)) throw new Error(`预设 ID 不合法：${id}`);
  const file = `${id}.md`;
  let text: string;
  try {
    // 精确匹配目录项：拒绝大小写不同的文件名（NTFS 下会读到同一个文件）和 8.3 短名。
    if (!readdirSync(dir).includes(file)) throw new Error();
    text = readFileSync(path.join(dir, file), "utf8");
  } catch {
    throw new Error(`找不到预设：${id}`);
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
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
  for (const key of REQUIRED) {
    if (!fields.has(key)) throw new Error(`预设 ${id} 缺少字段：${key}`);
  }

  const raw = fields.get("workdir") ?? "";
  // Windows 上 path.isAbsolute("/foo") 为真，但它会落在服务当前盘符下，所以只认盘符路径和 UNC 路径。
  if (!/^[A-Za-z]:[\\/]/.test(raw) && !/^[\\/]{2}[^\\/]/.test(raw)) {
    throw new Error(`预设 ${id} 的工作目录必须是绝对路径：${raw}`);
  }
  const workdir = path.resolve(raw);
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
  const defNames: string[] = [];
  for (const item of (fields.get("tools") ?? "").split(",").map((s) => s.trim())) {
    if (item === "") continue;
    if (isTool(item)) {
      if (!tools.includes(item)) tools.push(item);
    } else if (!defNames.includes(item)) defNames.push(item);
  }
  const toolDefs = loadToolDefs(toolsDir, defNames);

  const thinking = fields.get("thinking");
  if (thinking !== undefined && !isThinking(thinking)) throw new Error(`预设 ${id} 的 thinking 只能是 ${THINKING.join(", ")}：${thinking}`);

  const handoffText = fields.get("handoff");
  if (handoffText !== undefined && !/^[1-9][0-9]{0,14}$/.test(handoffText)) throw new Error(`预设 ${id} 的 handoff 必须是正整数（token）：${handoffText}`);

  return {
    id,
    workdir,
    model,
    tools,
    toolDefs,
    prompt: lines.slice(end + 1).join("\n").trim(),
    contextWindow: found.contextWindow,
    input: [...found.input],
    ...(thinking === undefined ? {} : { thinking }),
    ...(handoffText === undefined ? {} : { handoff: Number(handoffText) }),
  };
}
