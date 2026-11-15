// 从进程记录和工作段构造模型请求（设计稿第 4.3 节）。
import type { Tool } from "@earendil-works/pi-ai";
import { toolsFor } from "./tools.ts";
import type { Message, ModelRequest, PresetSnapshot, Process } from "./types.ts";

/** 换段时末尾加的用户消息，不入库（设计稿第 5.4 节）。 */
export const HANDOFF_INSTRUCTION = [
  "上下文快满了，要换到一个新的工作段。",
  "这一次不要调用任何工具，直接写一份交接说明。它会成为新工作段的第一条消息，旧段的内容你之后看不到。",
  "写清楚：当前目标；已经做了什么，结果如何；下一步做什么；还没完成的事。",
  "如果最后一条用户消息还没回复完，原样引用它。",
].join("\n");

/** 新段第一条消息的开头。 */
export const HANDOFF_HEADER = "（这是你在上一个工作段结束时写的交接说明。）\n\n";

export function systemPrompt(p: Process): string {
  const parts = [p.preset.prompt, `工作目录：${p.preset.workdir}`];
  if (p.segment.memoryView !== "") parts.push(`## 记忆（开段时的快照）\n\n${p.segment.memoryView}`);
  return parts.join("\n\n");
}

export function toolDefinitions(preset: PresetSnapshot): Tool[] {
  return toolsFor(preset).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function buildContext(p: Process, segment: readonly Message[]): ModelRequest {
  const messages: Message[] = [...segment];
  if (p.phase.tag === "awaitingModel" && p.phase.purpose === "handoff") {
    messages.push({ role: "user", content: HANDOFF_INSTRUCTION, timestamp: segment.at(-1)?.timestamp ?? p.createdAt });
  }
  return { systemPrompt: systemPrompt(p), messages, tools: toolDefinitions(p.preset) };
}
