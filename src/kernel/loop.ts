// 同样的错误连续出现时，请求末尾的提示（D108，见 .knowledge/kb-kernel.md）。
// 单独成文件：context.ts 要用它，而 derive.ts 导入 context.ts，放进 derive.ts 会成环。所以这里不导入 derive.ts。
import type { Message } from "./types.ts";

/** 段末连续这么多步相同（且有错误），请求末尾加提示（D108）。 */
export const LOOP_NOTE_AT = 3;
const TOOLS_MAX_BYTES = 200;
const ERROR_MAX_BYTES = 300;

const codeBytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** 不超过 maxBytes 字节：超出时按码点截短，末尾加 …（… 也算在内）。 */
function shorten(text: string, maxBytes: number): string {
  let bytes = 0;
  for (const ch of text) bytes += codeBytes(ch.codePointAt(0)!);
  if (bytes <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = codeBytes(ch.codePointAt(0)!);
    if (used + w > maxBytes - 3) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

const noteText = (n: number, tools: string, error: string) =>
  `注意：你最近连续 ${n} 次调用 ${tools}，都得到同样的错误（工具返回的原文，只引第一行）：「${error}」\n完整的错误见上面的工具结果。用同样的做法再试，多半还是这个结果。先读懂这个错误在说什么，再换一种做法：改参数、换工具，或者先查清原因。这一步实在做不下去，就先跳过它，接着做别的部分，并在最终回复里写明跳过了什么、卡在哪个错误。这是程序自动加的提醒，不是新任务，不用回复它，直接接着做。`;

/** 这条提示的字节上限：n 按 4 位数算，工具名和错误各按截短后的上限算。余量按它算（D108）。 */
export const LOOP_NOTE_MAX_BYTES = new TextEncoder().encode(noteText(9999, "x".repeat(TOOLS_MAX_BYTES), "x".repeat(ERROR_MAX_BYTES))).length;

interface Step {
  from: number;
  names: string[];
  results: Extract<Message, { role: "toolResult" }>[];
}

/** 以 `end` 结尾的一步：一条带工具调用的助手消息，加紧跟它的工具结果。不是就返回 undefined。 */
function stepEndingAt(segment: readonly Message[], end: number): Step | undefined {
  let i = end;
  while (i > 0 && segment[i - 1]!.role === "toolResult") i--;
  const a = segment[i - 1];
  if (i === end || a?.role !== "assistant") return undefined;
  const names = a.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : []));
  if (names.length === 0) return undefined;
  return { from: i - 1, names, results: segment.slice(i, end) as Step["results"] };
}

const same = (a: Step, b: Step) =>
  a.names.length === b.names.length &&
  a.results.length === b.results.length &&
  a.names.every((n, k) => n === b.names[k]) &&
  a.results.every((r, k) => r.isError === b.results[k]!.isError && JSON.stringify(r.content) === JSON.stringify(b.results[k]!.content));

/** 段末连续相同的错误步数 n 和提示用的工具名、错误；没有就返回 null。往前数到不同就停。 */
export function sameErrors(segment: readonly Message[]): { n: number; tools: string; error: string } | null {
  const last = stepEndingAt(segment, segment.length);
  if (last === undefined) return null;
  const firstError = last.results.find((r) => r.isError);
  if (firstError === undefined) return null;
  let n = 1;
  for (let s = stepEndingAt(segment, last.from); s !== undefined && same(s, last); s = stepEndingAt(segment, s.from)) n++;
  const line = firstError.content.flatMap((c) => (c.type === "text" ? c.text.split(/\r?\n/) : [])).map((l) => l.trim()).find((l) => l !== "");
  return { n, tools: [...new Set(last.names)].join("、"), error: line ?? "（没有文字）" };
}

/** 请求末尾的提示，段末连续相同的错误不到 `LOOP_NOTE_AT` 步时是空串。 */
export function loopNote(segment: readonly Message[]): string {
  const s = sameErrors(segment);
  return s === null || s.n < LOOP_NOTE_AT ? "" : noteText(s.n, shorten(s.tools, TOOLS_MAX_BYTES), shorten(s.error, ERROR_MAX_BYTES));
}
