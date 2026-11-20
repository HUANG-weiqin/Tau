// 工具描述是纯数据：名称、说明、参数，以及它是库内还是库外的副作用（见 .knowledge/kb-tools.md）。
import type { Tool } from "@earendil-works/pi-ai";
import type { PresetSnapshot, PresetTool } from "./types.ts";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Tool["parameters"];
  /** 库内副作用在处理输入的事务里执行；库外的由执行器执行。 */
  inStore: boolean;
}

function object(properties: Record<string, object>, required: string[]): Tool["parameters"] {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

const READ: ToolSpec = {
  name: "read",
  description: "读取文件。文本每行带行号；图片（png、jpeg、gif、webp）直接给你看。相对路径按工作目录解析。用 offset 和 limit 控制读多少。",
  parameters: object({ path: str("文件路径"), offset: int("从第几行开始，从 1 计"), limit: int("最多读多少行") }, ["path"]),
  inStore: false,
};

const WRITE: ToolSpec = {
  name: "write",
  description: "新建文件，或整体覆盖已有文件。",
  parameters: object({ path: str("文件路径"), content: str("完整的文件内容") }, ["path", "content"]),
  inStore: false,
};

const EDIT: ToolSpec = {
  name: "edit",
  description: "把文件里的一段原文精确替换成新文本。不加 replaceAll 时，原文在文件里必须唯一。",
  parameters: object(
    { path: str("文件路径"), old: str("要替换的原文"), new: str("新文本"), replaceAll: { type: "boolean", description: "替换所有出现的位置" } },
    ["path", "old", "new"],
  ),
  inStore: false,
};

const BASH: ToolSpec = {
  name: "bash",
  description: "在工作目录里运行一条 bash 命令（Git for Windows）。先等 timeout 秒（默认 60，最长 600，0 表示不等）：这么久里跑完了，结果就是输出和退出码；没跑完，命令继续在后台运行，不会被结束，工具立刻返回输出文件的路径，跑完给你寄一封信。输出太长时只回头尾，完整输出存在文件里，用 read 读。没有标准输入。" +
    "命令里的路径写 /c/Users/x 或 C:/Users/x，不要用反斜杠（bash 里它是转义）；read、write、edit 两种写法都认。PowerShell 的命令（Get-ChildItem、Get-Process 这类）bash 里没有，用 powershell -NoProfile -Command '…' 调用。",
  parameters: object({ command: str("要运行的命令"), timeout: int("最多等几秒，没跑完就转后台，0 是不等") }, ["command"]),
  inStore: false,
};

/** 记忆的上限，按 UTF-8 字节算。由记忆的实现检查；视图按渲染后的文本算。 */
export const MEMORY_KEY_MAX_BYTES = 128;
export const MEMORY_VALUE_MAX_BYTES = 4096;
export const MEMORY_BRIEF_MAX_BYTES = 200;
export const MEMORY_VIEW_MAX_BYTES = 32 * 1024;
/** 上下文文件视图的上界（D72），按 UTF-8 字节算，整个视图都计入：标题行、段间空行和各种说明。参与启动检查，改它要先重算（见 kb-contract）。 */
export const CONTEXT_VIEW_MAX_BYTES = 24 * 1024;

const MEMORY: ToolSpec[] = [
  {
    name: "memory_get",
    description: "读取记忆库里一个键现在的值、摘要、更新日期和版本号。系统提示词里的记忆索引是开段时的快照，每行只有摘要；要看值，或拿到最新版本号，用这个工具。",
    parameters: object({ key: str("键") }, ["key"]),
    inStore: true,
  },
  {
    name: "memory_set",
    description:
      "写入一个键。version 是你读到的版本号；省略 version 表示这个键现在必须不存在。版本对不上时写入失败，结果里带最新值。" +
      `键最多 ${MEMORY_KEY_MAX_BYTES} 字节，值最多 ${MEMORY_VALUE_MAX_BYTES} 字节，摘要最多 ${MEMORY_BRIEF_MAX_BYTES} 字节，整个记忆视图最多 ${MEMORY_VIEW_MAX_BYTES} 字节（按 UTF-8 算）；超出时不写入。` +
      "摘要显示在每次开段的记忆索引里，值改了就一起改摘要。" +
      "临时的内容（只对眼下这件事有用），键用 tmp. 开头，用完自己 memory_delete，索引里的更新日期能看出哪些过期了；长期的知识不用这个前缀。",
    parameters: object({ key: str("键"), value: str("值"), brief: str("摘要，一句话说清这个值是什么、什么时候该读它"), version: int("读到的版本号。新键没有，不要填") }, ["key", "value", "brief"]),
    inStore: true,
  },
  {
    name: "memory_edit",
    description:
      "把一个键的值里的一段原文精确替换成新文本，不用重发整个值。old 必须和值逐字一致，且在值里恰好出现一次；old 只取值的正文，不要带 memory_get 输出的前两行（键、版本、摘要）。version 是你读到的版本号（先 memory_get）；brief 不传则摘要不变，值的含义变了就一起改摘要。" +
      "版本对不上或原文不唯一时不写入。",
    parameters: object({ key: str("键"), old: str("要替换的原文"), new: str("新文本"), version: int("读到的版本号，必填"), brief: str("摘要，值的意思变了就一起改；不写就不变") }, ["key", "old", "new", "version"]),
    inStore: true,
  },
  {
    name: "memory_delete",
    description: "删除一个键。version 必须是你读到的版本号，对不上时失败，结果里带最新值。",
    parameters: object({ key: str("键"), version: int("读到的版本号") }, ["key", "version"]),
    inStore: true,
  },
];

/** 回信的三件事（设计稿 5.3）：`post` 和 `spawn` 的说明共用。 */
const REPLY_NOTES =
  "对方只在处理这封信的那一轮结束时回信一次，之后的几轮不回。" +
  "对方在同一轮里处理了你的几封信时，只回一封。" +
  "你自己结束本轮去等别的事时，等你回信的进程会立刻收到你这时的回复。";

const AGENTS: ToolSpec[] = [
  {
    name: "post",
    description: `往另一个进程的信箱寄一封信。reply 为真时，对方处理这封信的那一轮结束时，会把最终回复作为回信寄给你。${REPLY_NOTES}`,
    parameters: object({ to: str("收件进程的 ID"), text: str("信的正文"), reply: { type: "boolean", description: "要对方回信" } }, ["to", "text"]),
    inStore: true,
  },
  {
    name: "spawn",
    description: `用一个预设建新进程，你是它的父进程。text 是它收到的第一封信，它这一轮结束时会给你回信。${REPLY_NOTES}`,
    parameters: object({ preset: str("预设 ID"), text: str("第一封信的正文"), workdir: str("工作目录，绝对路径，必须是已有的目录。不写就用预设里的") }, ["preset", "text"]),
    inStore: true,
  },
  {
    name: "stop_process",
    description:
      "停止另一个进程此刻正在跑的这一轮。它不认是哪一轮：发出之前对方已经开了新一轮，停掉的就是新的那一轮。对方空闲时什么都不发生。" +
      "被停止的一轮照样给等回信的进程寄回信。",
    parameters: object({ process: str("进程 ID") }, ["process"]),
    inStore: true,
  },
];

const SELF: ToolSpec = {
  name: "self",
  description: "查看自己：进程、阶段、工作段、上下文用量、时间，以及同一个预设下正在运行的其他进程。只读。",
  parameters: object({}, []),
  inStore: true,
};

const HANDOFF: ToolSpec = {
  name: "handoff",
  description:
    "主动换到一个新的工作段，例如一个阶段做完、上下文里堆了太多不再需要的内容时。它在这批工具结果之后生效：" +
    "之后会让你不调用工具，写一份交接说明，写完才换段，旧段的内容你之后看不到。所以换段前要先把该存的存好。同一批里的其他工具照常执行。",
  parameters: object({}, []),
  inStore: true,
};

type Tools = Pick<PresetSnapshot, "tools" | "toolDefs">;

/** 预设能用的工具，按固定顺序：read、write、edit、bash，memory 组，agents 组；`self` 和 `handoff` 总在；最后是工具定义，按预设里的顺序，都是库外工具。 */
export function toolsFor(preset: Tools): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const t of [READ, WRITE, EDIT, BASH]) if (preset.tools.includes(t.name as PresetTool)) out.push(t);
  if (preset.tools.includes("memory")) out.push(...MEMORY);
  if (preset.tools.includes("agents")) out.push(...AGENTS);
  out.push(SELF, HANDOFF);
  for (const { name, description, parameters } of preset.toolDefs) out.push({ name, description, parameters, inStore: false });
  return out;
}

/** 预设里有这个工具时返回它的描述；不认识或预设里没有时返回 undefined。 */
export function findTool(preset: Tools, name: string): ToolSpec | undefined {
  return toolsFor(preset).find((t) => t.name === name);
}

const BUILTIN = toolsFor({ tools: ["read", "write", "edit", "bash", "memory", "agents"], toolDefs: [] });

/** 全部内置工具里按名字找描述，不看预设开了哪些组（`runDeclared` 可以声明未在预设列出的库内动作）。 */
export const findBuiltin = (name: string): ToolSpec | undefined => BUILTIN.find((t) => t.name === name);
