import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type { PresetOptions, PresetSnapshot, PresetTool } from "../kernel/types.ts";
import { loadToolDefs } from "./tooldefs.ts";

const TOOLS: readonly PresetTool[] = ["read", "write", "edit", "bash", "memory", "agents"];
const REQUIRED = ["workdir", "model", "tools"];
const KEYS = [...REQUIRED, "thinking", "handoff", "options"];
const THINKING: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** 预设 `options` 的字节上限。 */
export const OPTIONS_MAX_BYTES = 4096;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= min;
const oneOf = (list: readonly string[]) => (v: unknown) => typeof v === "string" && list.includes(v);
const BUDGET_KEYS = ["minimal", "low", "medium", "high"];
/** `samplingParams` 里不许出现的键：请求的结构和输出上限归内核和适配器管。 */
const SAMPLING_RESERVED = ["model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "stream_options", "n", "max_tokens", "max_completion_tokens", "max_output_tokens", "previous_response_id", "store", "prompt_cache_key", "reasoning", "reasoning_effort", "thinking"];

/** 白名单：键 -> [类型说明, 检查]。 */
const OPTION_CHECKS: Record<keyof PresetOptions, [string, (v: unknown) => boolean]> = {
  temperature: ["有限数", (v) => typeof v === "number" && Number.isFinite(v)],
  cacheRetention: ["none、short、long 之一", oneOf(["none", "short", "long"])],
  transport: ["sse、websocket、websocket-cached、auto 之一", oneOf(["sse", "websocket", "websocket-cached", "auto"])],
  timeoutMs: ["正整数", (v) => isInt(v, 1)],
  websocketConnectTimeoutMs: ["正整数", (v) => isInt(v, 1)],
  maxRetryDelayMs: ["非负整数", (v) => isInt(v, 0)],
  metadata: ["对象", isObject],
  thinkingBudgets: ["对象，键只能是 minimal、low、medium、high，值是正整数", (v) => isObject(v) && Object.entries(v).every(([k, n]) => BUDGET_KEYS.includes(k) && isInt(n, 1))],
  samplingParams: [`对象，不许有这些键：${SAMPLING_RESERVED.join("、")}`, (v) => isObject(v) && !SAMPLING_RESERVED.some((k) => k in v)],
};

/** 白名单外的键按类别报原因。 */
function rejectedReason(key: string): string {
  if (["signal", "sessionId", "maxTokens", "maxRetries", "reasoning"].includes(key)) return "内核管的键，用预设的 thinking 或由内核决定";
  if (["toolChoice", "deferred"].includes(key)) return "一轮的语义，不能按预设定";
  if (["apiKey", "headers", "env"].includes(key)) return "凭据，不能写进预设";
  if (["fetch", "onPayload", "onResponse", "onProviderStreamEvent", "telemetryContext"].includes(key)) return "函数，JSON 写不出来";
  return "streamSimple 不转发，或不在白名单里";
}

function parseOptions(id: string, text: string): PresetOptions | undefined {
  if (Buffer.byteLength(text) > OPTIONS_MAX_BYTES) throw new Error(`预设 ${id} 的 options 超过 ${OPTIONS_MAX_BYTES} 字节`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`预设 ${id} 的 options 必须是一行 JSON 对象：${text}`);
  }
  if (!isObject(value)) throw new Error(`预设 ${id} 的 options 必须是一行 JSON 对象：${text}`);
  const checks = new Map(Object.entries(OPTION_CHECKS));
  for (const [key, v] of Object.entries(value)) {
    const check = checks.get(key);
    if (!check) throw new Error(`预设 ${id} 的 options 里的 ${key} 不能用：${rejectedReason(key)}`);
    if (!check[1](v)) throw new Error(`预设 ${id} 的 options 里的 ${key} 必须是${check[0]}：${JSON.stringify(v)}`);
  }
  return Object.keys(value).length === 0 ? undefined : (value as PresetOptions);
}

export function presetsDir(): string {
  return path.join(os.homedir(), ".tau", "presets");
}

function isThinking(s: string): s is ThinkingLevel {
  return (THINKING as readonly string[]).includes(s);
}

function isTool(s: string): s is PresetTool {
  return (TOOLS as readonly string[]).includes(s);
}

/** 预设 ID 的检查：记忆的 `ns` 也用它。不合法就抛错。 */
export function checkPresetId(id: string): void {
  if (id === "" || /[/\\:]|\.\./.test(id)) throw new Error(`预设 ID 不合法：${id}`);
}

/** `dir` 是预设目录，`toolsDir` 是工具定义目录；预设的 tools 里不是内置工具的名字，都按工具定义读，一起冻结进快照。 */
export function loadPreset(dir: string, id: string, models: Models, toolsDir: string): PresetSnapshot {
  checkPresetId(id);
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

  const optionsText = fields.get("options");
  const options = optionsText === undefined ? undefined : parseOptions(id, optionsText);

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
    ...(options === undefined ? {} : { options }),
  };
}
