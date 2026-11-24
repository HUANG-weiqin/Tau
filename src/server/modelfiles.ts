// 模型补充文件（D105）：~/.tau/models/<provider>.json 给服务的模型目录补模型、改模型。上层写，内核只读。
// extras/ 里有一份读法的拷贝，测试共用一套（test/modelfile-suite.ts）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { SAMPLING_RESERVED } from "../presets/load.ts";

export const MODELS_FILE_MAX_BYTES = 1024 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
const posInt = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;

// 输出上限归内核（cap = min(model.maxTokens, 快照的上限)，D105）：适配器会让 samplingParams 顶掉上限，compat 能让它不发上限，所以这三样带坏值的条目整条跳过。
const noReserved = (v: unknown): boolean => isObj(v) && !SAMPLING_RESERVED.some((k) => k in v);
// 内核只查它要用、要冻结进快照的字段；别的键原样交给 pi-ai。
function valid(e: unknown, provider: string): e is Obj {
  if (!isObj(e)) return false;
  const { id, input, cost, samplingParams: sp, samplingParamsByThinkingLevel: byLevel, compat } = e;
  return (
    typeof id === "string" && id.length >= 1 && id.length <= 200 && !/\p{Cc}/u.test(id) &&
    typeof e.name === "string" && typeof e.baseUrl === "string" && typeof e.api === "string" && e.api !== "" &&
    typeof e.reasoning === "boolean" &&
    Array.isArray(input) && input.every((x) => x === "text" || x === "image") && input.includes("text") && new Set(input).size === input.length &&
    posInt(e.contextWindow) && posInt(e.maxTokens) &&
    isObj(cost) && nonNeg(cost.input) && nonNeg(cost.output) && nonNeg(cost.cacheRead) && nonNeg(cost.cacheWrite) &&
    (e.provider === undefined || e.provider === provider) && (e.type === undefined || e.type === "chat") &&
    (sp === undefined || noReserved(sp)) && (byLevel === undefined || (isObj(byLevel) && Object.values(byLevel).every(noReserved))) &&
    !(isObj(compat) && compat.supportsMaxOutputTokens === false)
  );
}

/** 读 `<dir>/<provider>.json`。文件坏了整份忽略，坏条目跳过，同 id 只用第一条合格的。从不抛错。 */
export function readModelFile(dir: string, provider: string): Model<Api>[] {
  let raw: unknown;
  try {
    const file = join(dir, `${provider}.json`);
    if (statSync(file).size > MODELS_FILE_MAX_BYTES) return [];
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return [];
  }
  const list = isObj(raw) ? raw.models : undefined;
  if (!Array.isArray(list)) return [];
  const byId = new Map<unknown, Model<Api>>();
  for (const e of list) if (valid(e, provider) && !byId.has(e.id)) byId.set(e.id, { ...e, provider } as unknown as Model<Api>);
  return [...byId.values()];
}

// 同 id 的聊天模型换成文件里的，新 id 加在后面。`isChat` 只在 getAllModels 里有用：别的类型的模型不动。
function overlay<T extends { id: string }>(base: readonly T[], file: readonly Model<Api>[], isChat: (m: T) => boolean): T[] {
  const byId = new Map(file.map((m) => [m.id, m as unknown as T]));
  const replaced = base.map((m) => (isChat(m) ? byId.get(m.id) : undefined) ?? m);
  return [...replaced, ...[...byId.values()].filter((m) => !replaced.includes(m))];
}

/** 把每家 provider 换成叠了补充文件的版本。每次列模型都现读文件。只改 `getModels` 和 `getAllModels`，请求还是原来的 provider 发。 */
export function withModelFiles(models: MutableModels, dir: string): MutableModels {
  for (const p of models.getProviders()) {
    const file = (): Model<Api>[] => readModelFile(dir, p.id);
    const wrapped: Provider = { ...p, getModels: () => overlay(p.getModels(), file(), () => true) };
    const all = p.getAllModels?.bind(p);
    if (all) wrapped.getAllModels = () => overlay(all(), file(), (m) => ((m as { type?: string }).type ?? "chat") === "chat");
    models.setProvider(wrapped);
  }
  return models;
}
