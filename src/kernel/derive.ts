// 能从工作段算出来的值都在这里算，不存（设计稿第 4.1 节）。
import { systemPrompt, toolDefinitions } from "./context.ts";
import type { AssistantMessage, Instant, Message, Process, ToolCall } from "./types.ts";

/** 每轮最多调用多少次模型。 */
export const STEPS_PER_TURN = 100;
/** 上下文用量达到窗口的这个比例就换段。第 4 步定。 */
export const HANDOFF_RATIO = 0.75;
/** 按字节估算用量时，多少字节算一个 token。第 4 步定。 */
export const BYTES_PER_TOKEN = 3;
/** 所有工具结果共用的字节上限，超出时保留头尾。 */
export const TOOL_RESULT_MAX_BYTES = 32 * 1024;

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

function estimate(text: string): number {
  return Math.ceil(utf8Bytes(text) / BYTES_PER_TOKEN);
}

export function usageOf(m: AssistantMessage): number {
  const u = m.usage;
  return u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** 上下文用量（token）：最后一条用量不为 0 的助手消息，加上它之后的消息的估算。 */
export function contextUsed(p: Process, segment: readonly Message[]): number {
  for (let i = segment.length - 1; i >= 0; i--) {
    const m = segment[i]!;
    if (m.role !== "assistant" || usageOf(m) === 0) continue;
    const after = segment.slice(i + 1);
    return usageOf(m) + (after.length === 0 ? 0 : estimate(JSON.stringify(after.map((x) => x.content))));
  }
  return estimate(systemPrompt(p) + JSON.stringify(toolDefinitions(p.preset)) + JSON.stringify(segment.map((x) => x.content)));
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
export function clip(text: string, maxBytes: number = TOOL_RESULT_MAX_BYTES): string {
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
