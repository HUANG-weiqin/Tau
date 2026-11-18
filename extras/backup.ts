// backup：定期备份 tau 的库（kb-extras 的“备份”，D73）。连管道发 `backup`，按本地时间命名，只留最近几份。
// 用法：node backup.ts [--dir <目录>] [--keep <个数>]。不导入 src/：只依赖线协议。
// 退出码照 CLI 的约定（kb-service）：0 成功；1 服务回了 error，或备份目录建不出来；2 用法错误、连不上服务；3 连接中途断了，不知道结果。
import { mkdirSync, readdirSync, rmSync } from "node:fs";
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

/**
 * 只留 `keep` 个备份，返回删掉的文件名。`made` 是刚做的那个：永远不删，占一个名额；
 * 其余的按名字排序，留最新的 `keep - 1` 个（目录里已有名字比它更靠后的备份时，刚做的也不会被当成最旧的）。
 * 只认 `tau-<时间>.db` 这种名字的普通文件，目录里别的东西不碰。删不掉就抛出。
 */
export function prune(dir: string, keep: number, made: string): string[] {
  const others = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && NAME.test(e.name) && e.name !== made)
    .map((e) => e.name)
    .sort()
    .reverse();
  const old = others.slice(Math.max(keep - 1, 0));
  for (const name of old) rmSync(path.join(dir, name));
  return old;
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
  // 备份已经成功。清理旧文件失败只是警告：下一次运行会把超出的全部再清一遍。刚做的这份不会被清掉。
  try {
    const removed = prune(dir, keep, path.basename(target));
    if (removed.length > 0) process.stdout.write(`已删除更旧的备份 ${removed.length} 个，保留最近 ${keep} 个。\n`);
  } catch (e) {
    process.stderr.write(`备份成功，但清理旧备份失败：${e instanceof Error ? e.message : String(e)}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
