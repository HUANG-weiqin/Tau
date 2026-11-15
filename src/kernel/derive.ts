// 能从工作段算出来的值都在这里算，不存（设计稿第 4.1 节）。
import { systemPrompt, toolDefinitions } from "./context.ts";
import { unreachable } from "./types.ts";
import type { AssistantMessage, Instant, Message, PresetSnapshot, Process, ToolCall } from "./types.ts";

/** 每轮最多调用多少次模型。 */
export const STEPS_PER_TURN = 100;
/** 按字节估算用量时，多少字节算一个 token。常见文本至少约 2 字节一个 token，所以宁可估高。 */
export const BYTES_PER_TOKEN = 2;
/** 工具结果和 decide 写入的用户消息共用的字节上限，超出时保留头尾。 */
export const MESSAGE_MAX_BYTES = 32 * 1024;
/** 阈值之上留给交接指令、补的结果、消息框架和估算误差的 token。 */
export const MARGIN_TOKENS = 4096;

export function tokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** 一次回复最多输出多少 token：窗口的 1/8。执行器请求时再取它和模型上限中较小的。 */
export function outputMax(p: PresetSnapshot): number {
  return Math.floor(p.contextWindow / 8);
}

/** 换段阈值。阈值之上要放得下：一次回复、一个没检查的工具结果、交接说明的输出和余量。 */
export function handoffThreshold(p: PresetSnapshot): number {
  return p.contextWindow - 2 * outputMax(p) - tokens(MESSAGE_MAX_BYTES) - MARGIN_TOKENS;
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
      return c.data.length;
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
  return tokens(utf8Bytes(systemPrompt(p)) + utf8Bytes(JSON.stringify(toolDefinitions(p.preset))) + bytes(segment));
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
