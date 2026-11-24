// Copilot 的模型列表（D105）：用账号的凭据拉 `/models`，生成模型补充文件 ~/.tau/models/github-copilot.json。
// 内核只读这个文件，不懂 Copilot。规则见 .knowledge/kb-extras.md 的“Copilot 的模型列表”。
// 用法：node copilot.ts [--file <auth.json>] [--dir <模型文件目录>]。退出码：0 成功（或没登录，什么都没做）；1 失败；2 用法错误。
// 失败（网络、非 2xx、不是 JSON、没有可用的模型）一律不碰旧文件。不导入 src/。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { fileCredentials } from "../auth/store.ts";
import { isObj, isValidEntry, writeFileAtomic, writeModelFile } from "./file.ts";

type Obj = Record<string, unknown>;

export const PROVIDER = "github-copilot";
/** 这一次没出现、但这么久之内出现过的模型照留：`/models` 每次可能返回不同的一套。 */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** 这一版的响应才有分档价格（`billing.token_prices`）。 */
export const API_VERSION = "2026-08-01";
/** Individual 账号的 API 地址。pi-ai 对这个端点才认 `policy.state === "enabled"`（有的付费账号所有 picker 标志都是 false）。 */
export const INDIVIDUAL_BASE = "https://api.individual.githubcopilot.com";
const FETCH_TIMEOUT_MS = 20_000;
const USAGE = "用法：node copilot.ts [--file <auth.json>] [--dir <模型文件目录>]   （默认 ~/.tau/auth.json 和 ~/.tau/models）";

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** 接口按这个顺序选：排在前面的优先。 */
const ENDPOINTS: readonly (readonly [string, string])[] = [
  ["/v1/messages", "anthropic-messages"],
  ["/responses", "openai-responses"],
  ["/chat/completions", "openai-completions"],
];

// ---------- 宽松解析：认不出的值只影响那一项，不丢整批 ----------

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const posInt = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const isChat = (item: Obj): boolean => {
  const t = obj(item.capabilities).type;
  return t === undefined || t === "chat";
};
const usable = (item: Obj): boolean => obj(item.policy).state !== "disabled" && obj(obj(item.capabilities).supports).tool_calls !== false;

/**
 * 取出能用的聊天模型，保持响应里的顺序。没有 `data` 数组算响应不对，抛错。
 * 有 picker 里的模型就用它们。没有时：Individual 端点取 `policy.state === "enabled"` 的，加上默认的那一个；别的端点（Business、Enterprise）只取默认的那一个。
 */
export function selectItems(raw: unknown, base?: string): Obj[] {
  const data = obj(raw).data;
  if (!Array.isArray(data)) throw new Error("响应里没有 data 数组");
  const items = data.filter((x): x is Obj => isObj(x) && str(x.id) !== undefined && isChat(x) && usable(x));
  const picked = items.filter((x) => x.model_picker_enabled === true);
  if (picked.length > 0) return picked;
  if (base?.replace(/\/+$/, "") === INDIVIDUAL_BASE) return items.filter((x) => obj(x.policy).state === "enabled" || x.is_chat_default === true);
  const fallback = items.find((x) => x.is_chat_default === true);
  return fallback ? [fallback] : [];
}

// ---------- 条目 ----------

/** 没写或空列表：走 `/chat/completions`（VS Code、Zed 都这样）。写了但一个都认不出：`undefined`。 */
function pickApi(endpoints: unknown): string | undefined {
  const list = strings(endpoints);
  return list.length === 0 ? "openai-completions" : ENDPOINTS.find(([e]) => list.includes(e))?.[1];
}

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** 同一种接口、`id` 前缀相同最长的那个。同样长取目录里靠前的。 */
function sibling(catalog: readonly Model<Api>[], id: string, api: string): Model<Api> | undefined {
  let best: Model<Api> | undefined;
  let bestLen = -1;
  for (const m of catalog) {
    if (m.api !== api) continue;
    const n = commonPrefix(m.id, id);
    if (n > bestLen) [best, bestLen] = [m, n];
  }
  return best;
}

/** 思考照 `adaptive_thinking`、`reasoning_effort` 生成，写法照模板那一类条目（Anthropic：自适应加 effort 映射；OpenAI 两种：级别原样，不支持的写 null）。 */
function deriveThinking(api: string, tpl: Model<Api> | undefined, supports: Obj): { reasoning: boolean; compat: Obj; map: Obj | undefined } {
  const efforts = strings(supports.reasoning_effort).map((s) => s.toLowerCase());
  const levels = efforts.filter((e): e is (typeof LEVELS)[number] => (LEVELS as readonly string[]).includes(e));
  const adaptive = supports.adaptive_thinking === true;
  const reasoning = supports.thinking === true || adaptive || efforts.length > 0;
  const compat: Obj = structuredClone((tpl?.compat ?? {}) as Obj);
  delete compat.forceAdaptiveThinking;
  if (!reasoning) return { reasoning, compat, map: undefined };
  const map: Obj = {};
  const anthropic = api === "anthropic-messages";
  if (anthropic && adaptive) {
    compat.forceAdaptiveThinking = true;
    // 自适应的模型能不能关思考，响应里没写。不发 `thinking: disabled`：关不掉的模型收到会报错，能关的模型不发也只是走默认。
    map.off = null;
  }
  if (levels.length > 0 && (adaptive || !anthropic)) {
    for (const l of LEVELS) {
      const high = l === "xhigh" || l === "max";
      if (levels.includes(l)) {
        // Anthropic：xhigh 和 max 写了才算支持，别的级别不写就是原样。
        if (high || !anthropic) map[l] = l;
      } else if (high) {
        if (!anthropic) map[l] = null;
      } else {
        // 没列出的 minimal 到 high，落在最近的一档上（同样近取低的）。
        const at = LEVELS.indexOf(l);
        map[l] = [...levels].sort((a, b) => Math.abs(LEVELS.indexOf(a) - at) - Math.abs(LEVELS.indexOf(b) - at) || LEVELS.indexOf(a) - LEVELS.indexOf(b))[0]!;
      }
    }
    if (!anthropic) map.off = efforts.includes("none") ? "none" : null;
  }
  if (api === "openai-completions") compat.supportsReasoningEffort = levels.length > 0;
  return { reasoning, compat, map: Object.keys(map).length > 0 ? map : undefined };
}

/** 一个 `/models` 的条目生成一个模型条目。认不出接口、没有窗口或输出上限的返回 `undefined`。 */
export function buildEntry(item: Obj, catalog: readonly Model<Api>[]): Obj | undefined {
  const id = str(item.id);
  if (id === undefined) return undefined;
  const caps = obj(item.capabilities);
  const limits = obj(caps.limits);
  const supports = obj(caps.supports);
  const tokenPrices = obj(obj(item.billing).token_prices);
  // 账号能收的提示词上限：两个来源里有的取小的。窗口比它大，交接请求本身就超限，进程会卡住。都没有才用总窗口。
  const prompts = [posInt(obj(tokenPrices.default).max_prompt_tokens), posInt(limits.max_prompt_tokens)].filter((n): n is number => n !== undefined);
  const window = prompts.length > 0 ? Math.min(...prompts) : posInt(limits.max_context_window_tokens);
  const maxTokens = posInt(limits.max_output_tokens);
  const vision = supports.vision === true || isObj(limits.vision) ? true : supports.vision === false ? false : undefined;

  const same = catalog.find((m) => m.id === id);
  if (same) {
    const e: Obj = structuredClone(same) as unknown as Obj;
    if (window !== undefined) e.contextWindow = window;
    if (maxTokens !== undefined) e.maxTokens = maxTokens;
    if (vision !== undefined) e.input = vision ? ["text", "image"] : ["text"];
    return e;
  }

  const api = pickApi(item.supported_endpoints);
  if (!api) return undefined;
  const tpl = sibling(catalog, id, api);
  const fallback = tpl ?? catalog[0];
  const maxOut = maxTokens ?? tpl?.maxTokens;
  if (window === undefined || maxOut === undefined) return undefined;
  const th = deriveThinking(api, tpl, supports);
  const image = vision === true;
  const e: Obj = {
    id,
    name: str(item.name) ?? id,
    api,
    provider: PROVIDER,
    baseUrl: fallback?.baseUrl ?? "https://api.individual.githubcopilot.com",
    reasoning: th.reasoning,
    input: image ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: window,
    maxTokens: maxOut,
    type: "chat",
  };
  if (fallback?.headers) e.headers = structuredClone(fallback.headers);
  if (Object.keys(th.compat).length > 0) e.compat = th.compat;
  if (th.map) e.thinkingLevelMap = th.map;
  const limitsOf = (tpl as unknown as Obj | undefined)?.inputLimits;
  if (image && limitsOf !== undefined) e.inputLimits = structuredClone(limitsOf);
  return e;
}

// ---------- 状态：哪些模型什么时候见过，上次成功是什么时候 ----------

interface Seen {
  lastSeen: number;
  entry: Obj;
}
interface State {
  lastSuccess?: number;
  seen: Record<string, Seen>;
}

function readState(file: string): State {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const seen: Record<string, Seen> = {};
    for (const [id, v] of Object.entries(obj(obj(raw).seen))) {
      const s = obj(v);
      if (typeof s.lastSeen === "number" && isObj(s.entry)) seen[id] = { lastSeen: s.lastSeen, entry: s.entry };
    }
    const last = obj(raw).lastSuccess;
    return { ...(typeof last === "number" ? { lastSuccess: last } : {}), seen };
  } catch {
    return { seen: {} };
  }
}

/** 上次成功刷新的时间（毫秒）。没有、读不出是 `undefined`。 */
export function readLastSuccess(stateFile: string): number | undefined {
  return readState(stateFile).lastSuccess;
}

// ---------- 刷新 ----------

export interface RefreshOptions {
  /** tau 的凭据文件。 */
  authFile: string;
  /** 模型补充文件的目录。 */
  modelsDir: string;
  /** 记录哪些模型什么时候见过。 */
  stateFile: string;
  /** 测试注入。默认是内置的全部供应商，凭据读写 `authFile`。 */
  models?: Pick<Models, "getAuth">;
  /** 不认旧的见过状态：换了账号登录时用，旧账号的模型不再留 7 天。 */
  forgetSeen?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** 测试注入。默认是 pi-ai 的 Copilot 目录。 */
  catalog?: readonly Model<Api>[];
  timeoutMs?: number;
}
export interface RefreshResult {
  kind: "ok" | "skipped" | "failed";
  /** 一行，给人看。 */
  summary: string;
}

function piAiVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      try {
        const pkg = obj(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")));
        if (pkg.name === "@earendil-works/pi-ai" && typeof pkg.version === "string") return pkg.version;
      } catch {}
    }
  } catch {}
  return "unknown";
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 不抛错：什么结果都在返回值里。失败时旧文件原样。 */
export async function refreshCopilot(opts: RefreshOptions): Promise<RefreshResult> {
  const fail = (why: string): RefreshResult => ({ kind: "failed", summary: `刷新 GitHub Copilot 的模型列表失败：${why}。旧文件没动。` });
  const now = opts.now ?? Date.now;
  try {
    const catalog = opts.catalog ?? (getBuiltinModels(PROVIDER) as unknown as Model<Api>[]);
    const models = opts.models ?? builtinModels({ credentials: fileCredentials(opts.authFile) });
    let auth: Awaited<ReturnType<Models["getAuth"]>>;
    try {
      auth = await models.getAuth(PROVIDER);
    } catch (e) {
      return fail(`取不到凭据（${message(e)}）`);
    }
    const token = auth?.auth.apiKey;
    if (!auth || !token) return { kind: "skipped", summary: "没登录 GitHub Copilot，什么都没做。" };

    const headers: Record<string, string> = {
      ...((catalog[0]?.headers as Record<string, string> | undefined) ?? {}),
      ...(auth.auth.headers as Record<string, string> | undefined),
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    };
    const base = (auth.auth.baseUrl ?? catalog[0]?.baseUrl ?? "https://api.individual.githubcopilot.com").replace(/\/+$/, "");
    let raw: unknown;
    try {
      const res = await (opts.fetch ?? fetch)(`${base}/models`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS) });
      if (!res.ok) return fail(`HTTP ${res.status}`);
      raw = await res.json();
    } catch (e) {
      return fail(`请求出错（${message(e)}）`);
    }
    let items: Obj[];
    try {
      items = selectItems(raw, base);
    } catch (e) {
      return fail(message(e));
    }

    const t = now();
    const state: State = opts.forgetSeen ? { seen: {} } : readState(opts.stateFile);
    const seen: Record<string, Seen> = {};
    const entries: Obj[] = [];
    const add = (e: Obj, lastSeen: number): boolean => {
      const id = e.id as string;
      if (!isValidEntry(e, PROVIDER) || id in seen) return false;
      seen[id] = { lastSeen, entry: e };
      entries.push(e);
      return true;
    };
    let fromCatalog = 0;
    let generated = 0;
    for (const item of items) {
      const e = buildEntry(item, catalog);
      if (e && add(e, t)) catalog.some((m) => m.id === e.id) ? fromCatalog++ : generated++;
    }
    if (entries.length === 0) return fail("没有可用的聊天模型");
    let kept = 0;
    for (const [id, s] of Object.entries(state.seen)) if (!(id in seen) && t - s.lastSeen <= GRACE_MS && add(s.entry, s.lastSeen)) kept++;

    await writeModelFile(opts.modelsDir, PROVIDER, { generatedAt: new Date(t).toISOString(), piAiVersion: piAiVersion(), models: entries });
    // 状态在文件之后写：状态写不了，文件已经是新的，下一次照常再来。
    await writeFileAtomic(opts.stateFile, `${JSON.stringify({ lastSuccess: t, seen }, null, 2)}\n`).catch(() => {});
    return { kind: "ok", summary: `GitHub Copilot 的模型列表已更新：${entries.length} 个（pi-ai 目录里有的 ${fromCatalog} 个，按元数据生成 ${generated} 个，保留上次的 ${kept} 个）。` };
  } catch (e) {
    return fail(message(e));
  }
}

// ---------- 命令行 ----------

export interface Deps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** 测试注入。 */
  refresh?: (opts: RefreshOptions) => Promise<RefreshResult>;
}

/** 凭据文件所在的目录当 tau 的家：模型文件在 `<家>/models`，状态在 `<家>/extras/models`。 */
export function defaultPaths(authFile: string, modelsDir?: string): { authFile: string; modelsDir: string; stateFile: string } {
  const home = path.dirname(authFile);
  return { authFile, modelsDir: modelsDir ?? path.join(home, "models"), stateFile: path.join(home, "extras", "models", `${PROVIDER}.json`) };
}

/** 返回退出码。 */
export async function main(argv: readonly string[], deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((s) => void process.stdout.write(s));
  const err = deps.err ?? ((s) => void process.stderr.write(s));
  let values: { file?: string; dir?: string };
  try {
    const parsed = parseArgs({ args: [...argv], options: { file: { type: "string" }, dir: { type: "string" } }, allowPositionals: true });
    if (parsed.positionals.length > 0) throw new Error(`多余的参数：${parsed.positionals.join(" ")}`);
    values = parsed.values;
  } catch (e) {
    err(`${message(e)}\n${USAGE}\n`);
    return 2;
  }
  const authFile = path.resolve(values.file ?? path.join(homedir(), ".tau", "auth.json"));
  const r = await (deps.refresh ?? refreshCopilot)(defaultPaths(authFile, values.dir === undefined ? undefined : path.resolve(values.dir)));
  (r.kind === "failed" ? err : out)(`${r.summary}\n`);
  return r.kind === "failed" ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
