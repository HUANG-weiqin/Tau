// backup：定期备份 tau 的库和领地（kb-extras 的“备份”，D73）。连管道发 `backup`，按本地时间命名，只留最近几份。
// 库备份成功后，把 ~/.tau/extras/home/ 整个拷到 <备份目录>/<库备份名去掉 .db>.home/；不拷符号链接和联接。
// 用法：node backup.ts [--dir <目录>] [--keep <个数>]。不导入 src/：只依赖线协议。
// 退出码照 CLI 的约定（kb-service）：0 成功；1 服务回了 error，或备份目录建不出来，或库备份成功但领地没拷完；2 用法错误、连不上服务；3 连接中途断了，不知道结果。
import { cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConnectError, talk } from "./tools/client.ts";
import { extrasDir } from "./tools/common.ts";

const DEFAULT_PIPE = "\\\\.\\pipe\\tau";
const DEFAULT_KEEP = 14;
const USAGE = "用法：node backup.ts [--dir <目录>] [--keep <个数>]";

/** 备份文件名：`tau-<YYYYMMDD-HHmmss>.db`，本地时间。按名字排序就是按时间排序。 */
export function backupName(d: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `tau-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

const NAME = /^tau-\d{8}-\d{6}\.db$/;
const HOME_NAME = /^tau-\d{8}-\d{6}\.home$/;
const PARTIAL_NAME = /^tau-\d{8}-\d{6}\.home\.partial$/;

/**
 * 只留 `keep` 个备份，返回删掉的库备份名和领地备份名。`made` 是刚做的那个库备份：永远不删，占一个名额；
 * 其余的按名字排序，留最新的 `keep - 1` 个（目录里已有名字比它更靠后的备份时，刚做的也不会被当成最旧的）。
 * 领地备份跟着库备份走：`tau-<时间>.home` 目录的 stem 不在留下的那组里就删（包括没有对应库备份的）。
 * `dropHomes` 为 false（这一次领地没拷成）时不删任何 `.home`，免得一份完整的领地备份都不剩。
 * `.home.partial` 是以前没拷完的残留，一律删。
 * 只认这几种名字（库备份是普通文件，领地备份和残留是目录），别的不碰。删不掉就抛出。
 */
export function prune(dir: string, keep: number, made: string, dropHomes = true): { dbs: string[]; homes: string[] } {
  const entries = readdirSync(dir, { withFileTypes: true });
  const others = entries
    .filter((e) => e.isFile() && NAME.test(e.name) && e.name !== made)
    .map((e) => e.name)
    .sort()
    .reverse();
  const old = others.slice(Math.max(keep - 1, 0));
  for (const name of old) rmSync(path.join(dir, name));
  const stem = (n: string): string => n.slice(0, n.lastIndexOf("."));
  const kept = new Set([made, ...others.slice(0, Math.max(keep - 1, 0))].map(stem));
  for (const e of entries) if (e.isDirectory() && PARTIAL_NAME.test(e.name)) rmSync(path.join(dir, e.name), { recursive: true });
  const homes = entries
    .filter((e) => dropHomes && e.isDirectory() && HOME_NAME.test(e.name) && !kept.has(stem(e.name)))
    .map((e) => e.name)
    .sort();
  for (const name of homes) rmSync(path.join(dir, name), { recursive: true });
  return { dbs: old, homes };
}

/** 数目录里的普通文件。 */
function countFiles(d: string): number {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(d, e.name)) : e.isFile() ? 1 : 0;
  return n;
}

// Windows 上，目标正被别人占着时，改名会报 EPERM、EBUSY、EACCES。等一等重试（最多 2.5 秒）。和 auth/store.ts 里的一样。
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
 * 把领地拷到 `dst`。领地不存在就跳过（返回 undefined）；成功返回拷了几个文件、跳过几个链接。
 * 先拷到 `<dst>.partial`，拷完再改名：进程中途被杀，留下的也只是 `.partial`，不会被当成完整的备份。
 * `dst` 拷之前已经有了就直接抛，不动它；`.partial` 拷之前已有就先删（只可能是以前的残留）；失败时删掉本次的 `.partial`。
 */
async function copyHome(src: string, dst: string): Promise<{ files: number; skipped: number } | undefined> {
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return undefined;
  if (lstatSync(dst, { throwIfNoEntry: false }) !== undefined) throw new Error(`目标已存在：${dst}`);
  const tmp = `${dst}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  let skipped = 0;
  try {
    cpSync(src, tmp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (p) => {
        let link: boolean;
        try {
          link = lstatSync(p).isSymbolicLink();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // 拷的时候刚好被删了
          throw e;
        }
        if (link) skipped++;
        return !link;
      },
    });
    const files = countFiles(tmp);
    await retry(() => rename(tmp, dst));
    return { files, skipped };
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    throw e;
  }
}

const fail = (code: number, message: string): number => {
  process.stderr.write(`${message}\n`);
  return code;
};

/** 返回退出码。`now` 只给测试用。 */
export async function main(argv: readonly string[], now: () => Date = () => new Date()): Promise<number> {
  let values: { dir?: string; keep?: string };
  try {
    values = parseArgs({ args: [...argv], options: { dir: { type: "string" }, keep: { type: "string" } }, strict: true, allowPositionals: false }).values;
  } catch (e) {
    return fail(2, `${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  if (values.keep !== undefined && !/^[1-9]\d{0,5}$/.test(values.keep)) return fail(2, `--keep 要是正整数：${values.keep}\n${USAGE}`);
  if (values.dir === "") return fail(2, `--dir 不能是空串\n${USAGE}`);
  const keep = values.keep === undefined ? DEFAULT_KEEP : Number(values.keep);
  const dir = path.resolve(values.dir ?? extrasDir("backup"));
  const target = path.join(dir, backupName(now()));
  const pipe = process.env.TAU_PIPE || DEFAULT_PIPE;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return fail(1, `备份目录建不出来：${dir}（${e instanceof Error ? e.message : String(e)}）`);
  }

  const got: { done?: { path: string; bytes: number }; error?: string } = {};
  try {
    await talk(pipe, { op: "backup", path: target }, (r) => {
      if (r.type === "backed_up") got.done = { path: String(r.path), bytes: Number(r.bytes) };
      else if (r.type === "error") got.error = String(r.message);
      return got.done !== undefined || got.error !== undefined;
    });
  } catch (e) {
    if (e instanceof ConnectError) return fail(2, `${e.message}\n先运行 tau serve。没有发出备份请求。`);
    return fail(3, `${e instanceof Error ? e.message : String(e)}\n不知道备份有没有做成，目标文件可能已经有了：${target}`);
  }
  if (got.error !== undefined) return fail(1, `服务拒绝备份：${got.error}`);
  if (got.done === undefined) return fail(3, `服务没回复就断开了，不知道备份有没有做成，目标文件可能已经有了：${target}`);

  process.stdout.write(`已备份：${got.done.path}（${got.done.bytes} 字节）\n`);
  let code = 0;
  let homeFailed = false;
  const homeTarget = path.join(dir, `${path.basename(target, ".db")}.home`);
  try {
    const copied = await copyHome(extrasDir("home"), homeTarget);
    if (copied !== undefined) process.stdout.write(`已备份领地：${homeTarget}（${copied.files} 个文件${copied.skipped > 0 ? `，跳过 ${copied.skipped} 个链接` : ""}）\n`);
  } catch (e) {
    homeFailed = true;
    code = fail(1, `库已备份，但领地没拷完：${e instanceof Error ? e.message : String(e)}`);
  }
  // 备份已经成功。清理旧文件失败只是警告：下一次运行会把超出的全部再清一遍。刚做的这份不会被清掉。
  try {
    const removed = prune(dir, keep, path.basename(target), !homeFailed);
    if (removed.dbs.length > 0) process.stdout.write(`已删除更旧的备份 ${removed.dbs.length} 个，保留最近 ${keep} 个。\n`);
    if (removed.homes.length > 0) process.stdout.write(`已删除更旧的领地备份 ${removed.homes.length} 个。\n`);
  } catch (e) {
    process.stderr.write(`备份成功，但清理旧备份失败：${e instanceof Error ? e.message : String(e)}\n`);
  }
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
