// 把共享手册的原型（handbook.md）渲染后装到 ~/.tau/handbook.md。用法：node extras/handbook/install.ts [--check] [--force]
// 原型里的 {{TAU_HOME}}、{{SKILLS}}、{{REPO}} 换成本机路径。以后改手册只改原型，再跑这个脚本。
// 不连 tau 服务。退出码：0 成功；1 不是最新（拒绝覆盖，或 --check 不是最新）；2 用法错误、在 git worktree 里跑、原型读不出或有未知占位符。
// 上次装进去的内容的哈希记在 <TAU_HOME>/extras/handbook/installed.sha256：装着的和记录一致，说明没人手改过，改了原型就可以放心更新。
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export function render(template: string, vars: Record<string, string>): string {
  const unknown = new Set<string>();
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name] as string;
    unknown.add(name);
    return m;
  });
  if (unknown.size > 0) throw new Error(`原型里有未知占位符：${[...unknown].join("、")}`);
  return out;
}

// 服务开段时会读目标文件。Windows 上目标正被读着时，改名会报 EPERM、EBUSY、EACCES，等一等重试（最多 2.5 秒）。做法同 extras/auth/store.ts。
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

async function writeAtomic(file: string, text: string): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    await retry(() => rename(tmp, file));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const readOptional = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

type Env = { home?: string; repoRoot?: string; source?: string; out?: (s: string) => void; err?: (s: string) => void };

export async function main(argv: string[], env: Env = {}): Promise<number> {
  const out = env.out ?? console.log;
  const err = env.err ?? console.error;
  let values: { check?: boolean; force?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { check: { type: "boolean" }, force: { type: "boolean" } }, strict: true, allowPositionals: false }));
    if (values.check && values.force) throw new Error("--check 和 --force 不能一起给。");
  } catch (e) {
    err(`${(e as Error).message}\n用法：node extras/handbook/install.ts [--check] [--force]`);
    return 2;
  }
  const slash = (p: string): string => p.replaceAll("\\", "/");
  const home = env.home ?? os.homedir();
  const tauHome = path.join(home, ".tau");
  // 先过 realpath 规整盘符大小写，不然 e:/ 和 E:\ 渲染出不同的路径。
  const repo = realpathSync.native(env.repoRoot ?? path.resolve(import.meta.dirname, "..", ".."));
  // linked worktree 的 .git 是普通文件。装出来的路径会指向它，它一删命令就失效。
  if (lstatSync(path.join(repo, ".git"), { throwIfNoEntry: false })?.isFile()) {
    err(`这是 git worktree（${repo}），装出来的路径会指向它。到主仓库里跑。`);
    return 2;
  }
  const source = env.source ?? path.join(repo, "extras", "handbook", "handbook.md");
  const target = path.join(tauHome, "handbook.md");
  const recordFile = path.join(tauHome, "extras", "handbook", "installed.sha256");
  let wanted: string;
  try {
    wanted = render(readFileSync(source, "utf8"), {
      TAU_HOME: slash(tauHome),
      SKILLS: slash(path.join(home, ".agents", "skills")),
      REPO: slash(repo),
    });
  } catch (e) {
    err(`读不了原型 ${source}：${(e as Error).message}`);
    return 2;
  }
  const current = readOptional(target);
  const record = readOptional(recordFile)?.trim();
  const state =
    current === undefined ? "没装" : current === wanted ? "已是最新" : record === sha256(current) ? "原型有更新" : "装着的被改过";
  if (values.check) {
    out(state);
    return state === "已是最新" ? 0 : 1;
  }
  if (state === "装着的被改过" && !values.force) {
    err(`装着的手册被直接改过（和上次装的不一样）。先把要留的改动搬进原型 ${source}，再用 --force 覆盖。`);
    return 1;
  }
  // 先写目标再写记录。两步之间崩溃，下次运行时装着的 == 渲染结果，走“已是最新”并补记录。
  if (state === "已是最新") {
    if (record !== sha256(wanted)) await writeAtomic(recordFile, sha256(wanted));
    out("已是最新，没改");
    return 0;
  }
  await writeAtomic(target, wanted);
  await writeAtomic(recordFile, sha256(wanted));
  out(`${state === "没装" ? "已装" : state === "原型有更新" ? "已更新" : "已覆盖"}：${target}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
