// 从进程记录和工作段构造模型请求（见 .knowledge/kb-kernel.md）。
import type { Tool } from "@earendil-works/pi-ai";
import { toolsFor } from "./tools.ts";
import type { Content, Message, ModelRequest, PresetSnapshot, Process } from "./types.ts";

/** 换段时末尾加的用户消息，不入库（见 .knowledge/kb-kernel.md）。 */
export const HANDOFF_INSTRUCTION = [
  "上下文快满了，要换到一个新的工作段。",
  "这一次不要调用任何工具，直接写一份交接说明。它会成为新工作段的第一条消息，旧段的内容你之后看不到。",
  "写清楚：当前目标；已经做了什么，结果如何；下一步做什么；还没完成的事。",
  "如果有还没回复完的用户请求，在说明里写清它要什么。最后几条还没处理的用户消息会原样附在说明后面，不用抄写。",
].join("\n");

/** 新段第一条消息的开头。 */
export const HANDOFF_HEADER = "（这是你在上一个工作段结束时写的交接说明。）\n\n";
/** 新段第一条消息里，交接说明之后、带过来的用户消息之前的一行。 */
export const CARRY_HEADER = "（下面是写交接说明时还没处理的用户消息。）";

/** 段末连续用户消息的起点，段非空时最小为 1：第一条消息是写交接说明的依据。 */
export function tailStart(segment: readonly Message[]): number {
  let i = segment.length;
  while (i > 1 && segment[i - 1]!.role === "user") i--;
  return i;
}

/** 系统提示词里的固定部分：预设提示词和工作目录那一行。 */
export function fixedPrompt(preset: PresetSnapshot): string {
  return `${preset.prompt}\n\n工作目录：${preset.workdir}`;
}

/** 记忆视图前面的标题，连同它前面的空行。 */
export const MEMORY_HEADING = "\n\n## 记忆（开段时的快照）\n\n";

/** 系统提示词里记忆的那一段，视图为空时没有。 */
export function memorySection(view: string): string {
  return view === "" ? "" : MEMORY_HEADING + view;
}

export function systemPrompt(p: Process): string {
  return fixedPrompt(p.preset) + memorySection(p.segment.memoryView);
}

export function toolDescriptions(preset: PresetSnapshot): Tool[] {
  return toolsFor(preset).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** 一次请求最多带段里最近的多少张图片（设计稿第 5.6 节的 K）。 */
export const IMAGES_PER_REQUEST = 8;
/** 超出时每批省略多少张（B）。成批省略，请求的前缀才不是每来一张图都变。 */
export const IMAGES_OMIT_BATCH = 4;
export const IMAGE_OMITTED = "[图片：较早的图片，已省略]";

/** 消息里的内容块，字符串正文和助手消息没有图片。 */
const blocksOf = (m: Message): readonly Content[] => (m.role === "assistant" || typeof m.content === "string" ? [] : m.content);

/** 段里有 n 张图：n 不超过 K 时全带；否则从最早的起整批省略，省 B × ⌈(n − K) / B⌉ 张，每张换成一行说明。不改库。 */
export function omitOldImages(messages: readonly Message[]): Message[] {
  const n = messages.reduce((c, m) => c + blocksOf(m).filter((b) => b.type === "image").length, 0);
  let omit = n <= IMAGES_PER_REQUEST ? 0 : IMAGES_OMIT_BATCH * Math.ceil((n - IMAGES_PER_REQUEST) / IMAGES_OMIT_BATCH);
  return messages.map((m) => {
    if (omit === 0 || blocksOf(m).length === 0) return m;
    const content = blocksOf(m).map((b): Content => (b.type === "image" && omit-- > 0 ? { type: "text", text: IMAGE_OMITTED } : b));
    return { ...m, content } as Message;
  });
}

export function buildContext(p: Process, segment: readonly Message[]): ModelRequest {
  let messages: Message[] = [...segment];
  if (p.phase.tag === "awaitingModel" && p.phase.purpose === "handoff") {
    // 段末还没处理的用户消息不进交接请求：换段成功时它们原样带到新段（decide 的 onHandoff）。
    messages.splice(tailStart(segment));
    messages.push({ role: "user", content: HANDOFF_INSTRUCTION, timestamp: messages.at(-1)?.timestamp ?? p.createdAt });
  }
  messages = omitOldImages(messages);
  return { systemPrompt: systemPrompt(p), messages, tools: toolDescriptions(p.preset) };
}
