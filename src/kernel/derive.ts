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

export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
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
    if (m.role === "assistant" && usageOf(m) > 0) return usageOf(m) + estimate(JSON.stringify(segment.slice(i + 1).map((x) => x.content)));
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
  const done = new Set<string>();
  for (const m of segment.slice(i + 1)) if (m.role === "toolResult") done.add(m.toolCallId);
  return last.content.filter((c): c is ToolCall => c.type === "toolCall" && !done.has(c.id));
}

/** 超出字节上限时保留头尾，中间换成一行说明。 */
export function clip(text: string, maxBytes: number = TOOL_RESULT_MAX_BYTES): string {
  const total = utf8Bytes(text);
  if (total <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2) - 64;
  const head = prefixWithin(text, half);
  const tail = [...prefixWithin([...text].reverse().join(""), half)].reverse().join("");
  return `${head}\n…（中间省略 ${total - utf8Bytes(head) - utf8Bytes(tail)} 字节）…\n${tail}`;
}

function prefixWithin(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    bytes += utf8Bytes(ch);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}
