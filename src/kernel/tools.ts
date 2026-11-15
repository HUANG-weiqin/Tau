// 工具描述是纯数据：名称、说明、参数，以及它是库内还是库外的副作用（见 .knowledge/kb-tools.md）。
import type { Tool } from "@earendil-works/pi-ai";
import type { PresetSnapshot } from "./types.ts";

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
  description: "读取文本文件，每行带行号。相对路径按工作目录解析。用 offset 和 limit 控制读多少。",
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
  description: "在工作目录里运行一条 bash 命令（Git for Windows），返回输出和退出码。默认超时 120 秒，上限 600 秒；超时或中止时结束它启动的进程。命令退出后，留在后台的进程不再归本工具管，它们之后的输出看不到。",
  parameters: object({ command: str("要运行的命令"), timeout: int("超时秒数") }, ["command"]),
  inStore: false,
};

/** 记忆的上限，按 UTF-8 字节算。由记忆的实现检查；视图按渲染后的文本算。 */
export const MEMORY_KEY_MAX_BYTES = 128;
export const MEMORY_VALUE_MAX_BYTES = 4096;
export const MEMORY_VIEW_MAX_BYTES = 16384;

const MEMORY: ToolSpec[] = [
  {
    name: "memory_get",
    description: "读取记忆库里一个键现在的值和版本号。系统提示词里的记忆是开段时的快照，要拿到最新值用这个工具。",
    parameters: object({ key: str("键") }, ["key"]),
    inStore: true,
  },
  {
    name: "memory_set",
    description:
      "写入一个键。version 是你读到的版本号；省略 version 表示这个键现在必须不存在。版本对不上时写入失败，结果里带最新值。" +
      `键最多 ${MEMORY_KEY_MAX_BYTES} 字节，值最多 ${MEMORY_VALUE_MAX_BYTES} 字节，整个记忆视图最多 ${MEMORY_VIEW_MAX_BYTES} 字节（按 UTF-8 算）；超出时不写入。`,
    parameters: object({ key: str("键"), value: str("值"), version: int("读到的版本号") }, ["key", "value"]),
    inStore: true,
  },
  {
    name: "memory_delete",
    description: "删除一个键。version 必须是你读到的版本号，对不上时失败，结果里带最新值。",
    parameters: object({ key: str("键"), version: int("读到的版本号") }, ["key", "version"]),
    inStore: true,
  },
];

const SELF: ToolSpec = {
  name: "self",
  description: "查看自己：进程、阶段、工作段、上下文用量、时间，以及同一个预设下正在运行的其他进程。只读。",
  parameters: object({}, []),
  inStore: true,
};

/** 预设能用的工具，按固定顺序；`self` 总在。 */
export function toolsFor(preset: PresetSnapshot): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const t of [READ, WRITE, EDIT, BASH]) if (preset.tools.includes(t.name as PresetSnapshot["tools"][number])) out.push(t);
  if (preset.tools.includes("memory")) out.push(...MEMORY);
  out.push(SELF);
  return out;
}

/** 预设里有这个工具时返回它的描述；不认识或预设里没有时返回 undefined。 */
export function findTool(preset: PresetSnapshot, name: string): ToolSpec | undefined {
  return toolsFor(preset).find((t) => t.name === name);
}
