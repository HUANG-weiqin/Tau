// credential-suite.ts 的子进程：对同一个凭据文件的同一条目做 N 次“读、加一、写”。
// 用法：node test/credential-child.ts <模块 URL> <文件> <次数>
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

const [moduleUrl, file, count] = process.argv.slice(2);
if (!moduleUrl || !file || !count) throw new Error("用法：credential-child.ts <模块 URL> <文件> <次数>");
const { fileCredentials } = (await import(moduleUrl)) as { fileCredentials: (f: string) => CredentialStore };
const store = fileCredentials(file);
for (let i = 0; i < Number(count); i++) {
  await store.modify("counter", async (cur) => ({ type: "oauth", access: "a", refresh: "r", expires: ((cur as OAuthCredential | undefined)?.expires ?? 0) + 1 }));
}
