// tx：外部主 Agent 和用户用的命令行（kb-extras 的“上层的命令行 tx”）。只用线协议，不导入 src/。
import path from "node:path";
import { Exit, usage } from "./args.ts";
import { COMMANDS } from "./cmds.ts";
import { helpText } from "./help.ts";
import { pipeName } from "./net.ts";

/** 跑一条命令，返回退出码。 */
export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(helpText(path.resolve(import.meta.dirname, "..", "..")));
    return 0;
  }
  const f = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (f === undefined) throw usage(`不认识的命令 ${cmd}。tx help 看用法。`);
  return f(rest, { pipe: pipeName(), cwd: path.resolve(cwd) });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => void (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Exit ? e.message : `tx 出错：${e instanceof Error ? e.message : String(e)}`}\n`);
      process.exitCode = e instanceof Exit ? e.code : 1;
    },
  );
}
