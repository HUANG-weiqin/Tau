// 只读复用 pi 的凭据文件（~/.pi/agent/auth.json），只用 api_key 条目（见 .knowledge/kb-decisions.md D23）。
// 不写入：OAuth 刷新要写回这个文件，会和 pi 抢，所以 OAuth 条目当作不存在，pi-ai 接着查环境变量。
import { readFile } from "node:fs/promises";
import type { ApiKeyCredential, CredentialStore } from "@earendil-works/pi-ai";

export function piCredentials(file: string): CredentialStore {
  // 每次都重读：pi 改了 key，tau 不用重启。文件不存在算没有凭据；格式坏了就报错，不悄悄忽略。
  const keys = async (): Promise<Map<string, ApiKeyCredential>> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw e;
    }
    const raw: unknown = JSON.parse(text);
    const out = new Map<string, ApiKeyCredential>();
    if (typeof raw === "object" && raw !== null) {
      for (const [id, c] of Object.entries(raw)) if ((c as { type?: unknown } | null)?.type === "api_key") out.set(id, c as ApiKeyCredential);
    }
    return out;
  };
  const readOnly = async (): Promise<never> => {
    throw new Error(`tau 只读 ${file}，不写入凭据。`);
  };
  return {
    read: async (id) => (await keys()).get(id),
    list: async () => [...(await keys()).keys()].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: readOnly,
    delete: readOnly,
  };
}
