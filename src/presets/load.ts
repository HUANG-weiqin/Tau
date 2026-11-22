import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { withCallParams } from "../kernel/snapshot.ts";
import type { PresetOptions, PresetSnapshot, PresetTool } from "../kernel/types.ts";
import type { ReconfigureFields } from "../protocol.ts";
import { loadToolDefs } from "./tooldefs.ts";

const TOOLS: readonly PresetTool[] = ["read", "write", "edit", "bash", "memory", "agents"];
const REQUIRED = ["workdir", "model", "tools"];
const KEYS = [...REQUIRED, "thinking", "handoff", "options", "context"];
const THINKING: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** 预设 `options` 的字节上限。 */
export const OPTIONS_MAX_BYTES = 4096;
/** 预设 `context` 最多几项，每项最多几个字符（D72）。 */
export const CONTEXT_ITEMS_MAX = 8;
export const CONTEXT_ITEM_MAX_CHARS = 260;

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

/** Windows 的绝对路径：盘符路径和 UNC 路径。`path.isAbsolute("/foo")` 在 Windows 上为真，但它会落在服务当前盘符下，所以不认。 */
const isWindowsAbsolute = (s: string): boolean => /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s);

/** 预设文件头和正文读出的字段，值是文件里写的原样（`tools`、`context` 已按逗号拆开，`handoff`、`options` 还是文本），还没有校验。`reconfigure` 的字段也先变成它，所以两条路用同一套校验。 */
export interface PresetFields {
  workdir: string;
  model: string;
  tools: string[];
  prompt: string;
  thinking?: string;
  handoff?: string;
  options?: string;
  context?: string[];
}

/** 逗号分隔的一行：去空白，跳过空项。 */
const items = (line: string): string[] => line.split(",").map((s) => s.trim()).filter((s) => s !== "");

/** `dir` 是预设目录。读文件、拆文件头，查未知、重复和缺少的字段；字段的值在 `buildPreset` 里校验。 */
function parsePresetFile(dir: string, id: string): PresetFields {
  const file = `${id}.md`;
  let text: string;
  try {
    // 精确匹配目录项：拒绝大小写不同的文件名（NTFS 下会读到同一个文件）和 8.3 短名。
    if (!readdirSync(dir).includes(file)) throw new Error();
    text = readFileSync(path.join(dir, file), "utf8");
  } catch {
    throw new Error(`找不到预设：${id}`);
  }
  if (text.startsWith("﻿")) text = text.slice(1);
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
  const thinking = fields.get("thinking");
  const handoff = fields.get("handoff");
  const options = fields.get("options");
  const context = fields.get("context");
  return {
    workdir: fields.get("workdir") ?? "",
    model: fields.get("model") ?? "",
    tools: items(fields.get("tools") ?? ""),
    prompt: lines.slice(end + 1).join("\n").trim(),
    ...(thinking === undefined ? {} : { thinking }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(options === undefined ? {} : { options }),
    ...(context === undefined ? {} : { context: items(context) }),
  };
}

/** 三个调用参数的校验：预设和 `reconfigure` 共用。`thinking`、`handoff`、`options` 没有就没有这个键，`options` 是 `{}` 也没有。 */
function callParams(id: string, f: Pick<PresetFields, "thinking" | "handoff" | "options">): Pick<PresetSnapshot, "thinking" | "handoff" | "options"> {
  const { thinking, handoff, options: optionsText } = f;
  if (thinking !== undefined && !isThinking(thinking)) throw new Error(`预设 ${id} 的 thinking 只能是 ${THINKING.join(", ")}：${thinking}`);
  if (handoff !== undefined && !/^[1-9][0-9]{0,14}$/.test(handoff)) throw new Error(`预设 ${id} 的 handoff 必须是正整数（token）：${handoff}`);
  const options = optionsText === undefined ? undefined : parseOptions(id, optionsText);
  return { ...(thinking === undefined ? {} : { thinking }), ...(handoff === undefined ? {} : { handoff: Number(handoff) }), ...(options === undefined ? {} : { options }) };
}

/** `context` 的校验（D72）：去重保序，最多 8 项，每项 1 到 260 个字符、没有控制字符、不含逗号、首尾没有空白，是相对路径或 Windows 绝对路径。只查写法，不查文件在不在。没有项就没有这个键。 */
function parseContext(id: string, list: readonly string[]): string[] | undefined {
  const paths = [...new Set(list)];
  if (paths.length > CONTEXT_ITEMS_MAX) throw new Error(`预设 ${id} 的 context 最多 ${CONTEXT_ITEMS_MAX} 项：现在有 ${paths.length} 项`);
  for (const p of paths) {
    if (p.length < 1 || p.length > CONTEXT_ITEM_MAX_CHARS) throw new Error(`预设 ${id} 的 context 每项 1 到 ${CONTEXT_ITEM_MAX_CHARS} 个字符：有一项是 ${p.length} 个字符`);
    if (/[\x00-\x1f\x7f]/.test(p)) throw new Error(`预设 ${id} 的 context 不能含控制字符：${JSON.stringify(p)}`);
    if (p.includes(",") || p !== p.trim()) throw new Error(`预设 ${id} 的 context 的路径不能含逗号，首尾不能有空白：${p}`);
    // 相对路径按 workdir 解析；以斜杠开头（UNC 除外）和只有盘符没有斜杠的，都不是相对路径，也不是 Windows 绝对路径。
    if (!isWindowsAbsolute(p) && (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p))) throw new Error(`预设 ${id} 的 context 必须是相对路径或 Windows 绝对路径：${p}`);
  }
  return paths.length === 0 ? undefined : paths;
}

/** 字段变成快照：工作目录要存在，模型要在目录里，工具定义要读得出，调用参数和上下文要合格。`loadPreset` 和 `reconfigure` 都走它，所以两处的拒绝永远一致。 */
export function buildPreset(id: string, f: PresetFields, models: Models, toolsDir: string): PresetSnapshot {
  const raw = f.workdir;
  if (!isWindowsAbsolute(raw)) throw new Error(`预设 ${id} 的工作目录必须是绝对路径：${raw}`);
  const workdir = path.resolve(raw);
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new Error(`预设 ${id} 的工作目录不存在：${workdir}`);
  }

  const { model } = f;
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (slash < 0 || provider === "" || modelId === "") throw new Error(`预设 ${id} 的模型格式应为 <provider>/<model-id>：${model}`);
  const found = models.getModel(provider, modelId);
  if (!found) throw new Error(`模型目录里没有 ${model}`);

  // 去重保序：名字很多时数组的 includes 是平方级，用 Set 收敛。
  const tools: PresetTool[] = [...new Set(f.tools.filter(isTool))];
  const defNames = new Set(f.tools.filter((t) => !isTool(t)));
  const toolDefs = loadToolDefs(toolsDir, [...defNames]);
  const call = callParams(id, f);
  const context = f.context === undefined ? undefined : parseContext(id, f.context);

  return {
    id,
    workdir,
    model,
    tools,
    toolDefs,
    prompt: f.prompt,
    contextWindow: found.contextWindow,
    input: [...found.input],
    ...call,
    ...(context === undefined ? {} : { context }),
  };
}

/** `dir` 是预设目录，`toolsDir` 是工具定义目录；预设的 tools 里不是内置工具的名字，都按工具定义读，一起冻结进快照。`workdir` 给了就顶掉文件里的那个，检查照样走 `buildPreset`。 */
export function loadPreset(dir: string, id: string, models: Models, toolsDir: string, workdir?: string): PresetSnapshot {
  checkPresetId(id);
  const fields = parsePresetFile(dir, id);
  return buildPreset(id, workdir === undefined ? fields : { ...fields, workdir }, models, toolsDir);
}

/** 快照还原成预设字段：`tools` 是内置工具名加工具定义的名字。`buildPreset(id, presetFields(s))` 重读文件和目录以后，得到和 `s` 同样的快照。 */
export function presetFields(s: PresetSnapshot): PresetFields {
  return {
    workdir: s.workdir,
    model: s.model,
    tools: [...s.tools, ...s.toolDefs.map((d) => d.name)],
    prompt: s.prompt,
    ...(s.thinking === undefined ? {} : { thinking: s.thinking }),
    ...(s.handoff === undefined ? {} : { handoff: String(s.handoff) }),
    ...(s.options === undefined ? {} : { options: JSON.stringify(s.options) }),
    ...(s.context === undefined ? {} : { context: [...s.context] }),
  };
}

/**
 * `reconfigure` 的新快照 S（D71）：以 `target`（待换的，没有就是当前的）为底，套上 `fields`，值 `null` 表示删掉这个键。
 * `fields` 的键都是调用参数时，只用同一套校验，不重读文件、不查模型目录；有结构性字段时整个重建（`buildPreset`），这就是“工具定义的手动刷新”。
 */
export function reconfigured(target: PresetSnapshot, fields: ReconfigureFields, models: Models, toolsDir: string): PresetSnapshot {
  const merged: Record<string, unknown> = { ...presetFields(target) };
  for (const [key, v] of Object.entries(fields)) {
    if (v === null) delete merged[key];
    else merged[key] = typeof v === "number" ? String(v) : key === "options" ? JSON.stringify(v) : v;
  }
  const f = merged as unknown as PresetFields;
  if (Object.keys(fields).every((k) => k === "thinking" || k === "handoff" || k === "options")) return withCallParams(target, callParams(target.id, f));
  return buildPreset(target.id, f, models, toolsDir);
}
