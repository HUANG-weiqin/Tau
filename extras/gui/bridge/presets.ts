// 预设的读取和新建。自己写解析，不导入 src/；规则照内核（设计稿第 2 节），但不查模型目录和工具定义。
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpError, isAbsoluteWinPath } from "./util.ts";

const KEYS = ["workdir", "model", "tools", "thinking", "handoff"];
const REQUIRED = ["workdir", "model", "tools"];
const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface PresetOk {
  id: string;
  ok: true;
  workdir: string;
  model: string;
  tools: string[];
  memory: boolean;
  thinking?: string;
  handoff?: number;
}
export type PresetInfo = PresetOk | { id: string; ok: false; error: string };

export function parsePreset(id: string, raw: string): PresetInfo {
  try {
    return { id, ...parseFields(id, raw) };
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseFields(id: string, raw: string): Omit<PresetOk, "id"> {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("缺少开头的 ---");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("缺少结束的 ---");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at < 0) throw new Error(`前置信息格式错误：${line}`);
    const key = line.slice(0, at).trim();
    if (!KEYS.includes(key)) throw new Error(`未知字段：${key}`);
    if (fields.has(key)) throw new Error(`重复的字段：${key}`);
    fields.set(key, line.slice(at + 1).trim());
  }
  for (const key of REQUIRED) if (!fields.has(key)) throw new Error(`缺少字段：${key}`);
  const rawDir = fields.get("workdir") ?? "";
  if (!isAbsoluteWinPath(rawDir)) throw new Error(`工作目录必须是绝对路径：${rawDir}`);
  const workdir = path.resolve(rawDir);
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new Error(`工作目录不存在：${workdir}`);
  }
  const model = fields.get("model") ?? "";
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error(`模型格式应为 <provider>/<model-id>：${model}`);
  const tools = (fields.get("tools") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const thinking = fields.get("thinking");
  if (thinking !== undefined && !THINKING.includes(thinking)) throw new Error(`thinking 只能是 ${THINKING.join(", ")}：${thinking}`);
  const handoff = fields.get("handoff");
  if (handoff !== undefined && !/^[1-9][0-9]{0,14}$/.test(handoff)) throw new Error(`handoff 必须是正整数：${handoff}`);
  return {
    ok: true,
    workdir,
    model,
    tools,
    memory: tools.includes("memory"),
    ...(thinking === undefined ? {} : { thinking }),
    ...(handoff === undefined ? {} : { handoff: Number(handoff) }),
  };
}

export function listPresets(home: string): PresetInfo[] {
  const dir = path.join(home, "presets");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PresetInfo[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const id = name.slice(0, -3);
    try {
      out.push(parsePreset(id, readFileSync(path.join(dir, name), "utf8")));
    } catch (e) {
      out.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export function presetWorkdirs(home: string): string[] {
  return listPresets(home).flatMap((p) => (p.ok ? [p.workdir] : []));
}

function line(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || /[\r\n]/.test(v)) throw new HttpError(400, `${name} 必须是单行的非空字符串`);
  return v.trim();
}

export function createPreset(home: string, body: Record<string, unknown>): void {
  const id = body.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id) || /^\.+$/.test(id) || id.endsWith(".")) throw new HttpError(400, "预设 ID 只许字母、数字、点、下划线和连字符");
  const workdir = line("workdir", body.workdir);
  if (!isAbsoluteWinPath(workdir)) throw new HttpError(400, "工作目录必须是绝对路径");
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "工作目录不存在");
  }
  const model = line("model", body.model);
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new HttpError(400, "模型格式应为 <provider>/<model-id>");
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !/^[A-Za-z0-9._-]+$/.test(t))) throw new HttpError(400, "tools 必须是名字的数组");
  const head = [`workdir: ${workdir}`, `model: ${model}`, `tools: ${tools.join(", ")}`];
  if (body.thinking !== undefined) {
    if (typeof body.thinking !== "string" || !THINKING.includes(body.thinking)) throw new HttpError(400, `thinking 只能是 ${THINKING.join(", ")}`);
    head.push(`thinking: ${body.thinking}`);
  }
  if (typeof body.prompt !== "string") throw new HttpError(400, "prompt 必须是字符串");
  const dir = path.join(home, "presets");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, `${id}.md`), `---\n${head.join("\n")}\n---\n${body.prompt.trim()}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `预设已经存在：${id}`);
    throw e;
  }
}
