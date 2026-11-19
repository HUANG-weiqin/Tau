// tau 自己的凭据文件（~/.tau/auth.json，D83）。每家供应商一条，形状同 pi-ai 的 Credential：api_key 或 oauth。
// 这是 src/server/credentials.ts 的拷贝（extras 不许导入 src），测试共用一套（test/credential-suite.ts）。改一边，另一边照改。
// 登录脚本（login.ts）、界面的桥（填 key、取标题）读写它；服务（刷新令牌）用 src 里的那份。
// 读不加锁：写是“写临时文件再改名”，读到的总是完整的一份。写（modify、delete）整个过程持锁，锁是文件旁边的一个目录。
import { mkdir, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Obj = Record<string, unknown>;

// Windows 上，目标文件正被别人读着时，改名会报 EPERM、EBUSY、EACCES。读的人马上就关，等一等重试（最多 2.5 秒）。读不受影响，不用重试。
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const retry = async <T>(op: () => Promise<T>): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      if (i >= 100 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await sleep(25);
    }
  }
};

/**
 * `staleMs`：锁目录这么久没动过，就当持锁的进程崩了，清掉；持锁的人每 `staleMs / 3` 刷新一次修改时间，所以慢的 `fn`（刷新令牌的网络请求，最多 15 秒）不会被偷锁。
 * `lockTimeoutMs`：等锁最久多久，要大于 `staleMs`，不然持锁的进程崩了，等锁的人在清掉陈旧锁之前就超时了。
 */
export function fileCredentials(file: string, { lockTimeoutMs = 30_000, staleMs = 15_000 } = {}): CredentialStore {
  const lock = `${file}.lock`;
  // 整个文件读成对象。不存在算空；坏了报错，不带原文：V8 的 JSON 报错会引用出错处附近的内容，可能是 key 的开头。
  const readAll = async (): Promise<Obj> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`${file} 不是合法的 JSON。`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file} 的顶层不是 JSON 对象。`);
    return raw as Obj;
  };
  // 只认 api_key 和 oauth，别的当作没有。形状对不对到 read 才查，这样写得不对的条目还能被 modify 换掉。
  const shape = (c: unknown): Credential | undefined => {
    const type = (c as { type?: unknown } | null)?.type;
    return type === "api_key" || type === "oauth" ? (c as Credential) : undefined;
  };
  const check = (id: string, c: Credential | undefined): void => {
    if (c?.type === "oauth" && (typeof c.access !== "string" || typeof c.refresh !== "string" || typeof c.expires !== "number")) throw new Error(`${file} 里 ${id} 的 OAuth 条目缺 access、refresh 或 expires。`);
    if (c?.type !== "api_key" || c.key === undefined) return;
    if (typeof c.key !== "string") throw new Error(`${file} 里 ${id} 的 key 不是字符串。`);
    // `!` 开头是 pi 的“执行命令”写法，`$` 是变量。tau 不执行也不展开，原样发出去等于把命令原文当 key。已知的 key 都不含 `$`。
    if (c.key.startsWith("!") || c.key.includes("$")) throw new Error(`tau 只支持字面量 key：${file} 里 ${id} 的 key 用了命令或变量写法。`);
  };
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + lockTimeoutMs;
    await mkdir(dirname(file), { recursive: true });
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => Date.now())) > staleMs) await rm(lock, { recursive: true, force: true });
        else if (Date.now() > deadline) throw new Error(`${file} 被别的进程占着，等了 ${lockTimeoutMs / 1000} 秒。`);
        else await sleep(50);
      }
    }
    const beat = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => {}), staleMs / 3);
    try {
      return await fn();
    } finally {
      clearInterval(beat);
      await rm(lock, { recursive: true, force: true }).catch(() => {}); // 删不掉就留着，等 staleMs 后别人清；不能盖掉已经写成的结果
    }
  };
  // 先写临时文件、落盘，再改名：崩溃时留下的是旧文件或新文件，不会是半个。轮换 refresh 令牌的供应商，写丢了就要重新登录。
  const writeAll = async (all: Obj): Promise<void> => {
    const h = await open(`${file}.tmp`, "w", 0o600);
    try {
      await h.writeFile(`${JSON.stringify(all, null, 2)}\n`);
      await h.sync();
    } finally {
      await h.close();
    }
    await retry(() => rename(`${file}.tmp`, file));
  };
  return {
    async read(id) {
      const c = shape((await readAll())[id]);
      check(id, c);
      return c;
    },
    list: async () =>
      Object.entries(await readAll()).flatMap(([providerId, c]): CredentialInfo[] => {
        const s = shape(c);
        return s ? [{ providerId, type: s.type }] : [];
      }),
    modify: (id, fn) =>
      withLock(async () => {
        const all = await readAll();
        const cur = shape(all[id]);
        const next = await fn(cur);
        if (next === undefined) return cur;
        all[id] = next;
        await writeAll(all);
        return next;
      }),
    delete: (id) =>
      withLock(async () => {
        const all = await readAll();
        if (!Object.hasOwn(all, id)) return;
        delete all[id];
        await writeAll(all);
      }),
  };
}
