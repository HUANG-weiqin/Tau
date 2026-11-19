// 登录脚本：OAuth 登录、填 api key、登出、看存了哪些（D83）。凭据存在 ~/.tau/auth.json，服务每次调模型现读，登录完不用重启。
// 用法：node login.ts list | login <供应商> [api_key] | logout <供应商>，都可以带 --file <路径>。不导入 src/。
// 登录的流程（设备码、浏览器加本机回调、粘贴代码）都是 pi-ai 供应商自己的，这里只管把提示和事件接到终端上。
// 退出码照 CLI 的约定（kb-service）：0 成功；1 登录失败或出错；2 用法错误。
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { AuthEvent, AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { checkKey } from "./key.ts";
import { fileCredentials } from "./store.ts";

const USAGE = "用法：node login.ts list | login <供应商> [api_key] | logout <供应商>   （都可以带 --file <路径>，默认 ~/.tau/auth.json）";

export interface Deps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** 测试注入。默认是内置的全部供应商，凭据读写 --file。 */
  models?: (file: string) => Models;
  /** 测试注入。默认是终端：提示读一行（secret 不回显），事件打印出来。 */
  interaction?: AuthInteraction;
}

/** 终端里的交互。提示写到标准错误，读标准输入。 */
export function terminal(out: (text: string) => void): AuthInteraction & { close(): void } {
  let muted = false;
  const echo = new Writable({ write: (chunk, _enc, done) => (muted || process.stderr.write(chunk), done()) });
  const rl = createInterface({ input: process.stdin, output: echo, terminal: process.stdin.isTTY === true });
  // 输入关了（标准输入结束，或 Ctrl+C）以后，等着的 question 既不 resolve 也不 reject，进程会以 13 退出。这里让它报错。
  const closed = new Promise<never>((_, reject) => rl.once("close", () => reject(new Error("输入被关闭了（标准输入结束，或按了 Ctrl+C）。"))));
  closed.catch(() => {});
  return {
    close: () => rl.close(),
    async prompt(p: AuthPrompt) {
      const hint = "placeholder" in p && p.placeholder ? `（例如 ${p.placeholder}）` : "";
      if (p.type === "select") {
        p.options.forEach((o, i) => out(`  ${i + 1}. ${o.label}${o.description ? `：${o.description}` : ""}\n`));
        const o = p.options[Number(await Promise.race([rl.question(`${p.message} [1-${p.options.length}] `, { signal: p.signal }), closed])) - 1];
        if (!o) throw new Error("没有这个选项");
        return o.id;
      }
      out(`${p.message}${hint}: `);
      muted = p.type === "secret";
      try {
        return await Promise.race([rl.question("", { signal: p.signal }), closed]);
      } finally {
        if (muted) out("\n");
        muted = false;
      }
    },
    notify(e: AuthEvent) {
      if (e.type === "auth_url") out(`在浏览器里打开：${e.url}\n${e.instructions ? `${e.instructions}\n` : ""}`);
      else if (e.type === "device_code") out(`在浏览器里打开 ${e.verificationUri} ，输入代码 ${e.userCode}${e.expiresInSeconds ? `（${Math.round(e.expiresInSeconds / 60)} 分钟内有效）` : ""}\n`);
      else out(`${e.message}\n${e.type === "info" ? (e.links ?? []).map((l) => `  ${l.label ?? ""} ${l.url}\n`).join("") : ""}`);
    },
  };
}

/** 返回退出码。 */
export async function main(argv: readonly string[], deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((s) => void process.stdout.write(s));
  const err = deps.err ?? ((s) => void process.stderr.write(s));
  const fail = (code: number, message: string): number => (err(`${message}\n`), code);
  let values: { file?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...argv], options: { file: { type: "string" } }, allowPositionals: true }));
  } catch (e) {
    return fail(2, `${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const [cmd, id, type, ...extra] = positionals;
  const file = path.resolve(values.file ?? path.join(homedir(), ".tau", "auth.json"));
  const credentials = fileCredentials(file);
  const models = deps.models?.(file) ?? builtinModels({ credentials });
  const list = cmd === "list" && id === undefined;
  if (!list && ((cmd !== "login" && cmd !== "logout") || id === undefined || extra.length > 0 || (cmd === "logout" && type !== undefined))) return fail(2, USAGE);
  const provider = list ? undefined : models.getProvider(id!);
  if (!list && !provider) return fail(2, `没有这家供应商：${id}。用 list 看有哪些。`);
  try {
    if (list) {
      const oauth = models.getProviders().filter((p) => p.auth.oauth).map((p) => p.id);
      const known = (await credentials.list()).map((c) => `${c.providerId}（${c.type}）`).join("、") || "（空）";
      out(`${file} 里存了：${known}\n可以 OAuth 登录的供应商：${oauth.join("、")}\n`);
      return 0;
    }
    if (!provider || id === undefined) return fail(2, USAGE);
    if (cmd === "logout") {
      await models.logout(id);
      out(`已登出 ${provider.name}，${file} 里不再有它。\n`);
      return 0;
    }
    const kind = type ?? (provider.auth.oauth ? "oauth" : "api_key");
    if (kind !== "oauth" && kind !== "api_key") return fail(2, `类型只能是 oauth 或 api_key：${kind}\n${USAGE}`);
    const own = deps.interaction ? undefined : terminal(out);
    const inner = own ?? deps.interaction!;
    // api key 过和界面一样的检查：trim，不收空的、含控制字符的、`!` 开头或含 `$` 的。
    const checked: AuthInteraction = { ...inner, prompt: async (p) => (p.type === "secret" ? checkKey(await inner.prompt(p)) : inner.prompt(p)) };
    try {
      await models.login(id, kind, checked);
    } finally {
      own?.close();
    }
    out(`已登录 ${provider.name}（${kind}），存进 ${file}。\n`);
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error && !message.includes(e.cause.message) ? `：${e.cause.message}` : "";
    return fail(1, `失败：${message}${cause}`);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
