// 模型目录和 key 状态。目录来自 pi-ai 的公开函数，进程启动时算一次，每次请求再叠上模型补充文件（D105）；key 状态和账号的可用清单每次现读 tau 的 auth.json（D83）。
// key 的值不出这个文件：回复里只有 provider 名、`type`、key 能不能被 tau 读。条目本身只交给 pi-ai 的 `filterModels`。
import { readFileSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { readModelFile } from "../../models/file.ts";
import { isObject } from "./util.ts";

export interface ModelInfo {
  id: string;
  name: string;
  window: number;
  image: boolean;
  /** 这个模型支持的思考级别，已去掉预设不收的 `off`（不思考就是预设不写 `thinking`）。 */
  thinking: string[];
}
export interface CatalogProvider {
  id: string;
  name: string;
  models: ModelInfo[];
}
/** `key`：已配 api_key、`oauth`：已用 OAuth 登录、没配、tau 读不了。 */
export type KeyStatus = "key" | "oauth" | "none" | "unreadable";

const info = (m: Model<Api>): ModelInfo => ({
  id: m.id,
  name: m.name,
  window: m.contextWindow,
  image: m.input.includes("image"),
  thinking: getSupportedThinkingLevels(m).filter((l) => l !== "off"),
});

export function buildCatalog(): CatalogProvider[] {
  const names = new Map(builtinProviders().map((p) => [p.id, p.name]));
  const out: CatalogProvider[] = [];
  for (const id of getBuiltinProviders()) {
    const models = getBuiltinModels(id).map((m) => info(m as Model<Api>));
    if (models.length > 0) out.push({ id, name: names.get(id) ?? id, models });
  }
  return out;
}

/** 有模型补充文件时，列表就是账号的清单，不再按 `availableModelIds` 过滤（那份只在刷新令牌时更新，会漏掉新模型）。 */
const ACCOUNT_LIST = "github-copilot";

/**
 * 叠上模型补充文件（D105，规则和服务一样：同 id 换成文件里的，新 id 加在后面；文件坏了、条目不合格按 readModelFile 的规则）。每次请求现读。
 * `exact` 是列表已经是账号清单的供应商：Copilot 有可用的补充文件时，只列文件里的模型。
 */
export function overlayCatalog(catalog: CatalogProvider[], dir: string): { catalog: CatalogProvider[]; exact: Set<string> } {
  const exact = new Set<string>();
  const out = catalog.map((c) => {
    const entries = readModelFile(dir, c.id);
    if (entries.length === 0) return c;
    if (c.id === ACCOUNT_LIST) {
      exact.add(c.id);
      return { ...c, models: entries.map(info) };
    }
    const byId = new Map(entries.map((m) => [m.id, info(m)]));
    const replaced = c.models.map((m) => byId.get(m.id) ?? m);
    const have = new Set(c.models.map((m) => m.id));
    return { ...c, models: [...replaced, ...[...byId].filter(([id]) => !have.has(id)).map(([, m]) => m)] };
  });
  return { catalog: out, exact };
}

/**
 * 账号真能用的模型。目录是 pi-ai 包里的全部；provider 可以自带过滤（`filterModels`，现在只有 GitHub Copilot：
 * 登录和刷新令牌时记下账号的可用清单，不在清单里的模型这个账号用不了）。没有过滤、没登录、条目里没有清单，都是目录的全部。
 * 服务不按它挡预设：预设写了目录里有的模型就收，用不了由调用时的错误说。
 */
export function accountModels(catalog: CatalogProvider[], creds: Map<string, Credential>, exact: ReadonlySet<string> = new Set()): CatalogProvider[] {
  const providers = new Map(builtinProviders().map((p) => [p.id, p]));
  return catalog.map((c) => {
    const p = providers.get(c.id);
    if (!p?.filterModels || exact.has(c.id)) return c;
    const ok = new Set(p.filterModels(p.getModels(), creds.get(c.id)).map((m) => m.id));
    return { ...c, models: c.models.filter((m) => ok.has(m.id)) };
  });
}

/** 和凭据库 `read` 的检查一致（src/server/credentials.ts）：OAuth 缺字段、key 不是字符串、`!` 开头或含 `$` 的 key，tau 读不了。只有 `env` 没有 `key` 的条目（例如 cloudflare 的账号 ID）pi-ai 读得了。 */
function keyStatus(c: unknown): KeyStatus {
  if (!isObject(c)) return "none";
  if (c.type === "oauth") return typeof c.access === "string" && typeof c.refresh === "string" && typeof c.expires === "number" ? "oauth" : "unreadable";
  if (c.type !== "api_key") return "none";
  const key = c.key;
  if (key === undefined) return isObject(c.env) ? "key" : "none";
  if (typeof key !== "string") return "unreadable";
  return key.startsWith("!") || key.includes("$") ? "unreadable" : "key";
}

/** 每个供应商的 key 状态，加文件本身读不读得出，加 tau 读得了的条目（给 `accountModels`，不进回复）。出错的原因不带文件内容。 */
export function readKeys(file: string): { keys: Map<string, KeyStatus>; creds: Map<string, Credential>; auth: { ok: true } | { ok: false; error: string } } {
  const keys = new Map<string, KeyStatus>();
  const creds = new Map<string, Credential>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { keys, creds, auth: { ok: true } };
    return { keys, creds, auth: { ok: false, error: "读不了 auth.json" } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { keys, creds, auth: { ok: false, error: "auth.json 不是合法的 JSON" } };
  }
  if (!isObject(raw)) return { keys, creds, auth: { ok: false, error: "auth.json 的顶层不是 JSON 对象" } };
  for (const [id, c] of Object.entries(raw)) {
    const k = keyStatus(c);
    keys.set(id, k);
    if (k === "key" || k === "oauth") creds.set(id, c as Credential);
  }
  return { keys, creds, auth: { ok: true } };
}
