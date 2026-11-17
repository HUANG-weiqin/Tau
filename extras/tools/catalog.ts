// 工具库的目录：每个工具的定义（说明、参数、超时、输出方式）和脚本。界面的“工具定义”页按它安装。
// 只放数据和拼命令的函数，不导入别的文件。装进 `~/.tau/tools/<name>.json` 的就是 `definitionOf` 的结果。

export interface ToolEntry {
  name: string;
  /** 本目录下的脚本文件名。 */
  script: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 秒，1 到 600。 */
  timeout: number;
  output: "text" | "content";
  /** 工具定义里的 `command`。`script` 是脚本的绝对路径，正斜杠，不含 `"`、`$`、反引号。 */
  command(script: string): string;
}

/** bash 里的换行写法：`$'\n'`。 */
const NL = "$'\\n'";

const node = (script: string): string => `node "${script}"`;

export const CATALOG: ToolEntry[] = [
  {
    name: "shell",
    script: "shell.ts",
    description:
      "运行一条 shell 命令（Git Bash）。和内置的 bash 二选一：一个预设里只开一个。" +
      "输出太长时只回开头和结尾，完整输出存成文件，结果里给出路径，用 read 读。" +
      "命令跑满 300 秒会被结束，这时结果里没有输出，完整输出在 ~/.tau/extras/shell/<进程 ID>/ 下最新的文件里。长命令用 bg_run；想更早结束，在命令前加 timeout N。退出码不是 0 算错误。",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要运行的命令" } },
      required: ["command"],
      additionalProperties: false,
    },
    timeout: 300,
    output: "text",
    // 用户的命令在这个 bash 里 eval，不另起 bash：内核超时和停止时按进程组结束它。
    // node 只管取参数（start）和截断输出（report）。输出全进文件，命令的标准输入是空设备。
    command: (s) => `out=$(node "${s}" start) || exit 1; o=\${out%%${NL}*}; c=\${out#*${NL}}; (eval "$c") >"$o" 2>&1 </dev/null; code=$?; node "${s}" report "$o"; exit $code`,
  },
  {
    name: "bg_run",
    script: "bg_run.ts",
    description:
      "把命令放到后台运行，立刻返回，不用等。跑完会给你寄一封信：退出码加 log 最后几行。" +
      "log 写在 ~/.tau/extras/bg/ 下，结果里给出路径，想看进度用 read 读。命令没有标准输入。同名任务还在跑时拒绝。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名，字母、数字、下划线、连字符，最多 40 个字符", pattern: "^[A-Za-z0-9_-]{1,40}$" },
        command: { type: "string", description: "要在后台运行的命令" },
      },
      required: ["name", "command"],
      additionalProperties: false,
    },
    timeout: 30,
    output: "text",
    // 后台子 shell 的输出全进 log：工具返回后管道会关闭，往它写会 SIGPIPE。跑完由 finish 写退出码行并寄信。
    command: (s) =>
      `out=$(node "${s}" start) || exit 1; l=\${out%%${NL}*}; r=\${out#*${NL}}; m=\${r%%${NL}*}; c=\${r#*${NL}}; ( (eval "$c") </dev/null; code=$?; node "${s}" finish "$l" "$code" ) >>"$l" 2>&1 </dev/null & echo "$m"`,
  },
  {
    name: "peek",
    script: "peek.ts",
    description: "看另一个进程的当前段，只给最后几条：谁说的、文字、工具调用的名字。每条最多约 1500 字。只读。",
    parameters: {
      type: "object",
      properties: {
        process: { type: "string", description: "进程 ID" },
        last: { type: "integer", description: "看最后几条，默认 6，最多 20" },
      },
      required: ["process"],
      additionalProperties: false,
    },
    timeout: 30,
    output: "text",
    command: node,
  },
  {
    name: "wait",
    script: "wait.ts",
    description:
      "在这一轮里等子进程结束。每个进程进入“结束”（完成、出错、被停止、步数用完）就算到了；全到了就返回各自的状态。" +
      "刚建好、还没处理第一封信的进程不算结束。最长等 timeout 秒；超时不算错误，返回还没结束的和它们当前的阶段。",
    parameters: {
      type: "object",
      properties: {
        processes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "进程 ID，1 到 8 个" },
        timeout: { type: "integer", description: "最长等多少秒，默认 300，最多 590" },
      },
      required: ["processes"],
      additionalProperties: false,
    },
    timeout: 600,
    output: "text",
    command: node,
  },
];

/** 写进 `~/.tau/tools/<name>.json` 的内容。键的顺序固定。`dir` 是本目录的绝对路径，正斜杠。 */
export function definitionOf(e: ToolEntry, dir: string): Record<string, unknown> {
  return { description: e.description, parameters: e.parameters, command: e.command(`${dir}/${e.script}`), timeout: e.timeout, output: e.output };
}
