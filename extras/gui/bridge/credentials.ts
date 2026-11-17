// 桥自己的只读凭据库：规则和 src/server/credentials.ts 一样（D23），extras/ 不许导入 src/，所以抄一份。
// 只认 api_key 条目；`!` 开头或含 `$` 的 key 不认；每次现读，pi 改了不用重启。
import { readFile } from "node:fs/promises";
import type { ApiKeyCredential, CredentialStore } from "@earendil-works/pi-ai";

export function piCredentials(file: string): CredentialStore {
  const keys = async (): Promise<Map<string, ApiKeyCredential>> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // 不带 V8 的原文：它可能引用 key 的开头。
      throw new Error("auth.json 不是合法的 JSON，pi 正在写它时也会这样");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("auth.json 的顶层不是 JSON 对象");
    const out = new Map<string, ApiKeyCredential>();
    for (const [id, c] of Object.entries(raw)) if ((c as { type?: unknown } | null)?.type === "api_key") out.set(id, c as ApiKeyCredential);
    return out;
  };
  const readOnly = async (): Promise<never> => {
    throw new Error("只读 auth.json，不写入凭据");
  };
  return {
    async read(id) {
      const c = (await keys()).get(id);
      const key: unknown = c?.key;
      if (key !== undefined && typeof key !== "string") throw new Error(`auth.json 里 ${id} 的 key 不是字符串`);
      if (key !== undefined && (key.startsWith("!") || key.includes("$"))) throw new Error(`auth.json 里 ${id} 的 key 用了命令或变量写法，不支持`);
      return c;
    },
    list: async () => [...(await keys()).keys()].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: readOnly,
    delete: readOnly,
  };
}
