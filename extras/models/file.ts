// 模型补充文件（D105）：~/.tau/models/<provider>.json。读法和 src/server/modelfiles.ts 一样（extras 不许导入 src，是拷贝），测试共用一套（test/modelfile-suite.ts）。
// 改一边，另一边照改。写：先写临时文件、落盘，再改名，内核读到的是旧文件或新文件。
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

export const MODELS_FILE_MAX_BYTES = 1024 * 1024;

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
const posInt = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;

/** 同 src/presets/load.ts 的 SAMPLING_RESERVED（extras 不许导入 src，这里存一份）。 */
const SAMPLING_RESERVED = ["model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "stream_options", "n", "max_tokens", "max_completion_tokens", "max_output_tokens", "previous_response_id", "store", "prompt_cache_key", "reasoning", "reasoning_effort", "thinking"];
const noReserved = (v: unknown): boolean => isObj(v) && !SAMPLING_RESERVED.some((k) => k in v);

/** 内核查的条件，一字不差。输出上限归内核：带 samplingParams 保留键、或 compat.supportsMaxOutputTokens 为 false 的条目整条跳过。别的键原样交给 pi-ai，这里不查。 */
export function isValidEntry(e: unknown, provider: string): e is Obj {
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
  for (const e of list) if (isValidEntry(e, provider) && !byId.has(e.id)) byId.set(e.id, { ...e, provider } as unknown as Model<Api>);
  return [...byId.values()];
}

// Windows 上，目标文件正被别人读着时，改名会报 EPERM、EBUSY、EACCES。读的人马上就关，等一等重试（最多 2.5 秒），同 auth/store.ts。
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function retry<T>(op: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      if (i >= 100 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await sleep(25);
    }
  }
}

/** 先写临时文件（名字唯一，两个写的人不踩）、落盘，再改名。失败时临时文件删掉，旧文件原样。 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const h = await open(tmp, "w", 0o600);
    try {
      await h.writeFile(text);
      await h.sync();
    } finally {
      await h.close();
    }
    await retry(() => rename(tmp, file));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 写 `<dir>/<provider>.json`。超过内核的大小上限就不写（内核会整份忽略），抛错。 */
export async function writeModelFile(dir: string, provider: string, doc: Obj): Promise<void> {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (Buffer.byteLength(text) > MODELS_FILE_MAX_BYTES) throw new Error(`模型文件超过 ${MODELS_FILE_MAX_BYTES} 字节，内核会整份忽略，没写。`);
  await writeFileAtomic(join(dir, `${provider}.json`), text);
}

