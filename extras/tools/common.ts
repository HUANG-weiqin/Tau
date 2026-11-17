// 工具库共用的小件：读参数、查环境、数据目录、出错写法。不导入 src/。
import { homedir } from "node:os";
import path from "node:path";

/** 给模型看的错误：消息原样写到标准错误，退出码 1。 */
export class Fail extends Error {}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 工具只在 tau 里运行：执行器给命令设了 TAU_PROCESS 和 TAU_PIPE。 */
export function tauEnv(): { proc: string; pipe: string } {
  const proc = process.env.TAU_PROCESS;
  const pipe = process.env.TAU_PIPE;
  if (!proc || !pipe) throw new Fail("这个工具只能在 tau 的工具调用里运行：没有 TAU_PROCESS 或 TAU_PIPE。");
  if (!ID.test(proc)) throw new Fail(`TAU_PROCESS 不是合法的进程 ID：${proc}`);
  return { proc, pipe };
}

/** 标准输入是参数的 JSON，一个对象。 */
export async function readArgs(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Fail("参数不是合法的 JSON。");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Fail("参数必须是 JSON 对象。");
  return v as Record<string, unknown>;
}

/** `~/.tau/extras/<name>`：上层的数据目录。 */
export function extrasDir(name: string): string {
  return path.join(homedir(), ".tau", "extras", name);
}

/** 给模型看的路径：Windows 的反斜杠写法。 */
export const winPath = (p: string): string => path.resolve(p).replace(/\//g, "\\");

/** 给 bash 用的路径：盘符加正斜杠，msys 认。 */
export const bashPath = (p: string): string => path.resolve(p).replace(/\\/g, "/");

/** 入口：出错写标准错误、退出码 1。不要在里面留着不关的连接，否则进程不退出。 */
export function run(fn: () => Promise<void>): void {
  fn().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Fail ? e.message : `工具出错：${e instanceof Error ? e.message : String(e)}`}\n`);
    process.exitCode = 1;
  });
}

/** 一段文字最多留 `max` 个字符，多的写明总数。 */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字，已截）`;
}
