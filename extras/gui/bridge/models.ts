// 模型目录和 key 状态。目录来自 pi-ai 的公开函数，进程启动时算一次；key 状态每次现读 tau 的 auth.json（D83）。
// 只看每个条目的 provider 名、`type`，以及 key 能不能被 tau 读：key 的值不出这个文件。
import { readFileSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
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

export function buildCatalog(): CatalogProvider[] {
  const names = new Map(builtinProviders().map((p) => [p.id, p.name]));
  const out: CatalogProvider[] = [];
  for (const id of getBuiltinProviders()) {
    const models = getBuiltinModels(id).map((m) => ({
      id: m.id,
      name: m.name,
      window: m.contextWindow,
      image: m.input.includes("image"),
      thinking: getSupportedThinkingLevels(m).filter((l) => l !== "off"),
    }));
    if (models.length > 0) out.push({ id, name: names.get(id) ?? id, models });
  }
  return out;
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

/** 每个供应商的 key 状态，加文件本身读不读得出。出错的原因不带文件内容。 */
export function readKeys(file: string): { keys: Map<string, KeyStatus>; auth: { ok: true } | { ok: false; error: string } } {
  const keys = new Map<string, KeyStatus>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { keys, auth: { ok: true } };
    return { keys, auth: { ok: false, error: "读不了 auth.json" } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { keys, auth: { ok: false, error: "auth.json 不是合法的 JSON" } };
  }
  if (!isObject(raw)) return { keys, auth: { ok: false, error: "auth.json 的顶层不是 JSON 对象" } };
  for (const [id, c] of Object.entries(raw)) keys.set(id, keyStatus(c));
  return { keys, auth: { ok: true } };
}
