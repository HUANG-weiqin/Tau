// 只读复用 pi 的凭据文件（~/.pi/agent/auth.json），只用 api_key 条目（见 .knowledge/kb-decisions.md D23）。
// 不写入：OAuth 刷新要写回这个文件，会和 pi 抢，所以 OAuth 条目当作不存在，pi-ai 接着查环境变量。
import { readFile } from "node:fs/promises";
import type { ApiKeyCredential, CredentialStore } from "@earendil-works/pi-ai";

export function piCredentials(file: string): CredentialStore {
  // 每次都重读：pi 改了 key，tau 不用重启。文件不存在算没有凭据；内容不对就报错，不悄悄退回环境变量。
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
      // 不带 V8 的原文：它引用出错处附近的内容，可能是 key 的开头，而报错会存进库、显示在 CLI 上。
      throw new Error(`${file} 不是合法的 JSON。pi 正在写这个文件时也会这样，稍后重发。`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file} 的顶层不是 JSON 对象。`);
    const out = new Map<string, ApiKeyCredential>();
    for (const [id, c] of Object.entries(raw)) if ((c as { type?: unknown } | null)?.type === "api_key") out.set(id, c as ApiKeyCredential);
    return out;
  };
  const readOnly = async (): Promise<never> => {
    throw new Error(`tau 只读 ${file}，不写入凭据。`);
  };
  return {
    async read(id) {
      const c = (await keys()).get(id);
      const key: unknown = c?.key;
      if (key !== undefined && typeof key !== "string") throw new Error(`${file} 里 ${id} 的 key 不是字符串。`);
      // pi 把 `!` 开头的 key 当命令执行，`$` 可能是变量或转义。tau 不解析，原样发出去就是把命令原文当 key。
      // 含 `$` 一律拒绝，比 pi 严；已知的 provider key 都不含 `$`。
      if (key !== undefined && (key.startsWith("!") || key.includes("$"))) throw new Error(`tau 只支持字面量 key：${file} 里 ${id} 的 key 用了 pi 的命令或变量写法。`);
      return c;
    },
    list: async () => [...(await keys()).keys()].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: readOnly,
    delete: readOnly,
  };
}
