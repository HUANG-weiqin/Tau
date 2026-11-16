// 能从工作段算出来的值都在这里算，不存（见 .knowledge/kb-kernel.md）。
import { fixedPrompt, MEMORY_HEADING, memorySection, systemPrompt, toolDescriptions } from "./context.ts";
import { MEMORY_VIEW_MAX_BYTES } from "./tools.ts";
import { unreachable } from "./types.ts";
import type { AssistantMessage, Ended, Instant, Message, PresetSnapshot, Process, ToolCall } from "./types.ts";

/** 每轮最多调用多少次模型。 */
export const STEPS_PER_TURN = 100;
/** 按字节估算用量时，多少字节算一个 token。常见文本至少约 2 字节一个 token，所以宁可估高。 */
export const BYTES_PER_TOKEN = 2;
/** 工具结果和 decide 写入的用户消息共用的字节上限，超出时保留头尾。 */
export const MESSAGE_MAX_BYTES = 32 * 1024;
/** 工具结果和新段的第一条消息，最多带多少张图片。 */
export const IMAGES_PER_MESSAGE = 2;
/** 一张图片算多少 token，不看字节（设计稿 5.6）。暂定值，要不低于在用模型一张图的真实 token 数。 */
export const IMAGE_TOKENS = 5000;
/** 结束原因的字节上限。provider 的报错可能很长，原文由 CLI 显示给用户。 */
export const ENDED_REASON_MAX_BYTES = 1024;
/** `post` 和 `spawn` 寄出的信，跳数超过它就失败（设计稿 5.3）。回信不受限制。 */
export const HOPS_MAX = 32;
/** 阈值之上留给交接指令、补的结果、消息框架和估算误差的 token。 */
export const MARGIN_TOKENS = 4096;

export function tokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** 一次回复最多输出多少 token：窗口的 1/8。执行器请求时再取它和模型上限中较小的。 */
export function outputMax(p: PresetSnapshot): number {
  return Math.floor(p.contextWindow / 8);
}

/** R：一个没检查的工具结果最多多少 token。收图片的预设再加一份满张数的图片。只看快照。 */
export function resultReserve(p: PresetSnapshot): number {
  return tokens(MESSAGE_MAX_BYTES) + (p.input.includes("image") ? IMAGES_PER_MESSAGE * IMAGE_TOKENS : 0);
}

/** 换段阈值。阈值之上要放得下：一次回复、一个没检查的工具结果、交接说明的输出和余量。 */
export function handoffThreshold(p: PresetSnapshot): number {
  return p.contextWindow - 2 * outputMax(p) - resultReserve(p) - MARGIN_TOKENS;
}

/** 固定部分的 token：预设提示词、工作目录那一行、工具描述。口径和 `contextUsed` 一样。 */
export function fixedTokens(p: PresetSnapshot): number {
  return tokens(utf8Bytes(fixedPrompt(p)) + utf8Bytes(JSON.stringify(toolDescriptions(p))));
}

/** 启动检查（设计稿 5.6）：固定部分加记忆的上界要低于阈值。通过时返回 null，否则返回失败的原因。 */
export function startError(p: PresetSnapshot): string | null {
  const fixed = fixedTokens(p);
  const memory = p.tools.includes("memory") ? tokens(utf8Bytes(MEMORY_HEADING) + MEMORY_VIEW_MAX_BYTES) : 0;
  const threshold = handoffThreshold(p);
  if (fixed + memory < threshold) return null;
  return `预设 ${p.id} 的窗口太小，装不下：固定部分 ${fixed} token，记忆的上界 ${memory} token，换段阈值 ${threshold} token`;
}

/** 假想的新段开头：只有一条消息 `first`，记忆视图是 `view`。返回它的用量和各部分的 token。 */
export function newSegmentUsed(p: Process, view: string, first: Message): { used: number; fixed: number; memory: number } {
  const probe: Process = { ...p, segment: { seq: p.segment.seq + 1, memoryView: view } };
  return { used: contextUsed(probe, [first]), fixed: fixedTokens(p.preset), memory: tokens(utf8Bytes(memorySection(view))) };
}

/** 一条消息实际发出的原始 UTF-8 字节数，不算 JSON 外壳和转义。工具调用的参数本来就按 JSON 发，所以按 JSON 算。 */
export function messageBytes(m: Message): number {
  switch (m.role) {
    case "user":
      return typeof m.content === "string" ? utf8Bytes(m.content) : sum(m.content.map(blockBytes));
    case "assistant":
      return sum(m.content.map(blockBytes));
    case "toolResult":
      return utf8Bytes(m.toolCallId) + utf8Bytes(m.toolName) + sum(m.content.map(blockBytes));
    default:
      return unreachable(m);
  }
}

function blockBytes(c: Exclude<Message["content"], string>[number]): number {
  switch (c.type) {
    case "text":
      return utf8Bytes(c.text);
    case "thinking":
      return utf8Bytes(c.thinking);
    case "toolCall":
      return utf8Bytes(c.id) + utf8Bytes(c.name) + utf8Bytes(JSON.stringify(c.arguments));
    case "image":
      return IMAGE_TOKENS * BYTES_PER_TOKEN;
    default:
      return unreachable(c);
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** UTF-8 字节数。孤立的代理项按替换字符算 3 字节。 */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else n += width(c);
  }
  return n;
}

export function usageOf(m: AssistantMessage): number {
  const u = m.usage;
  return u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** 上下文用量（token）：最后一条用量不为 0 的助手消息，加上它之后的消息的估算。估算只在总字节数上取整一次。 */
export function contextUsed(p: Process, segment: readonly Message[]): number {
  const bytes = (ms: readonly Message[]) => sum(ms.map(messageBytes));
  for (let i = segment.length - 1; i >= 0; i--) {
    const m = segment[i]!;
    if (m.role === "assistant" && usageOf(m) > 0) return usageOf(m) + tokens(bytes(segment.slice(i + 1)));
  }
  return tokens(utf8Bytes(systemPrompt(p)) + utf8Bytes(JSON.stringify(toolDescriptions(p.preset))) + bytes(segment));
}

/** 本段开始时间：本段第一条消息的时间戳。 */
export function segmentStartedAt(segment: readonly Message[]): Instant | undefined {
  return segment[0]?.timestamp;
}

/** 待执行的工具调用：最后一条助手消息里，还没有结果的工具调用。 */
export function pendingCalls(segment: readonly Message[]): ToolCall[] {
  let i = segment.length - 1;
  while (i >= 0 && segment[i]!.role !== "assistant") i--;
  const last = segment[i];
  if (last?.role !== "assistant") return [];
  // 按位置配对，不按 ID：结果总是按调用的顺序写入，而 ID 来自模型，可能重复或为空。
  const answered = segment.slice(i + 1).filter((m) => m.role === "toolResult").length;
  return last.content.filter((c): c is ToolCall => c.type === "toolCall").slice(answered);
}

/** 主动换段：最后一条助手消息里有 `handoff` 调用，并且它的结果不是错误。补的结果都是错误，所以没执行的 `handoff` 不算。不存状态，从段算。 */
export function handoffRequested(segment: readonly Message[]): boolean {
  let i = segment.length - 1;
  while (i >= 0 && segment[i]!.role !== "assistant") i--;
  const last = segment[i];
  if (last?.role !== "assistant") return false;
  const results = segment.slice(i + 1).filter((m) => m.role === "toolResult");
  // 按位置配对，同 pendingCalls。
  return last.content.filter((c): c is ToolCall => c.type === "toolCall").some((c, k) => c.name === "handoff" && results[k]?.role === "toolResult" && !results[k].isError);
}

/** 最终回复：从段尾往前，遇到用户消息之前的最后一条助手消息的正文。 */
export function finalReply(segment: readonly Message[]): string {
  for (let i = segment.length - 1; i >= 0; i--) {
    const m = segment[i]!;
    if (m.role === "user") return "";
    if (m.role === "assistant") return m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  }
  return "";
}

/** 出错原因：先 clip，再把回车和换行换成空格。顺序不能反：clip 插进去的省略标记也带换行。 */
export function endedReason(error: string): string {
  return clip(error, ENDED_REASON_MAX_BYTES).replace(/[\r\n]/g, " ");
}

/** 结束原因的文字，`self` 和回信的头共用。永远只有一行。 */
export function endedText(e: Ended): string {
  if (typeof e === "object") return `出错：${endedReason(e.error)}`;
  switch (e) {
    case "done":
      return "正常结束";
    case "stepLimit":
      return "步数用完";
    case "stopped":
      return "被停止";
    default:
      return unreachable(e);
  }
}

/** 超出字节上限时保留头尾，中间换成一行说明。只扫描保留的部分和一次全长计数，不拷贝整串。 */
export function clip(text: string, maxBytes: number = MESSAGE_MAX_BYTES): string {
  const total = utf8Bytes(text);
  if (total <= maxBytes) return text;
  const marker = (n: number) => `\n…（中间省略 ${n} 字节）…\n`;
  const budget = Math.max(0, Math.floor((maxBytes - utf8Bytes(marker(total))) / 2));
  const head = text.slice(0, edge(text, budget, 1));
  const tail = text.slice(edge(text, budget, -1));
  return head + marker(total - utf8Bytes(head) - utf8Bytes(tail)) + tail;
}

/** 从头（1）或从尾（-1）取不超过 budget 字节的最长一段，返回它的边界下标。不拆开代理对。 */
function edge(text: string, budget: number, dir: 1 | -1): number {
  let bytes = 0;
  let i = dir === 1 ? 0 : text.length;
  while (dir === 1 ? i < text.length : i > 0) {
    const c = text.charCodeAt(dir === 1 ? i : i - 1);
    const pair = dir === 1 ? isHigh(c) && isLow(text.charCodeAt(i + 1)) : isLow(c) && isHigh(text.charCodeAt(i - 2));
    const w = pair ? 4 : width(c);
    if (bytes + w > budget) break;
    bytes += w;
    i += dir * (pair ? 2 : 1);
  }
  return i;
}

const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00;
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000;
const width = (c: number) => (c < 0x80 ? 1 : c < 0x800 ? 2 : 3);
