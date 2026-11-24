// 旧段的简略视图（D103）：把刚结束的一段渲染成每条消息一行。纯函数，规格见 .knowledge/kb-kernel.md。
import { BRIEF_END, BRIEF_HEADER, CARRY_HEADER, HANDOFF_HEADER } from "./context.ts";
import { briefOf, utf8Bytes } from "./derive.ts";
import { findBuiltin, findTool } from "./tools.ts";
import type { Content, Message, PresetSnapshot, ToolCall } from "./types.ts";

/** 整块最多多少字节（预算的第一项）。 */
export const BRIEF_MAX_BYTES = 16 * 1024;
const LINE_MAX_BYTES = 300;
const NARRATION_MAX_BYTES = 120;
const ARG_MAX_BYTES = 100;

const omitLine = (n: number) => `（放不下，省略了 ${n} 行。）`;
/** 这一块里行以外的字节：前面的空行、两头的固定文字、省略行（按最长算）和这几处的换行。 */
export const BRIEF_FIXED_BYTES = utf8Bytes(`\n\n${BRIEF_HEADER}\n${omitLine(9999999999)}\n${BRIEF_END}`);

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (utf8Bytes(s) <= n ? s : `${briefOf(s, n - 3)}…`);
const blocks = (m: Message): readonly Content[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as readonly Content[]));
const textOf = (m: Message) => blocks(m).find((c) => c.type === "text")?.text ?? "";
/** 第一遍取的行：信、用户消息和交接说明。旧行也靠行首认。 */
const PRIORITY = /^\[\d+:\d+\] (用户：|信（|交接说明：)/;

/** 工具调用参数的开头：`command`，没有就 `path`，再没有就第一个字符串值。 */
function argOf(c: ToolCall): string {
  const a = c.arguments as Record<string, unknown>;
  const v = [a.command, a.path, ...Object.values(a)].find((x) => typeof x === "string");
  return typeof v === "string" ? cut(flat(v), ARG_MAX_BYTES) : "";
}

/** 一个工具结果的一行（不含位置）。 */
function resultLine(call: ToolCall | undefined, m: Extract<Message, { role: "toolResult" }>, preset: PresetSnapshot): string {
  const rows = blocks(m).flatMap((c) => (c.type === "text" ? c.text.split("\n").map(flat).filter((r) => r !== "" && !r.startsWith("注：")) : []));
  const name = call?.name ?? m.toolName;
  const head = [name, call === undefined ? "" : argOf(call)].filter((x) => x !== "").join(" ");
  if (!m.isError) return (findBuiltin(name) ?? findTool(preset, name))?.inStore === true && rows[0] !== undefined ? `${head} → ${cut(rows[0], ARG_MAX_BYTES)}` : head;
  const code = /^\[退出码 \d+\]$/.test(rows.at(-1) ?? "") ? rows.pop() : undefined;
  const first = rows[0];
  const last = rows.at(-1);
  const body = [code, first === undefined ? undefined : cut(first, ARG_MAX_BYTES), last === undefined || last === first ? undefined : `… ${cut(last, ARG_MAX_BYTES)}`].filter((x) => x !== undefined).join(" ");
  return `✗ ${head}${body === "" ? "" : `：${body}`}`;
}

/**
 * 第 0 到 `end` 条消息（`seq` 是它们所在的段号）渲染成行，旧的在前，和旧行被省略的行数。
 * 第 0 条是上一次换段写的：旧行（第 1 段里不带，只可能是 fork 复制来的）原样排在前面，说明和带过来的信各一行。
 * 工具结果按位置和调用配对，不按 ID。
 */
export function briefLines(seg: readonly Message[], end: number, seq: number, preset: PresetSnapshot): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let omitted = 0;
  let calls: ToolCall[] = [];
  let k = 0;
  const add = (i: number, body: string) => lines.push(cut(`[${seq}:${i}] ${flat(body)}`, LINE_MAX_BYTES));
  for (let i = 0; i < end; i++) {
    const m = seg[i]!;
    if (m.role === "assistant") {
      calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
      k = 0;
      const text = flat(m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" "));
      if (text !== "") add(i, `助手：${calls.length > 0 ? cut(text, NARRATION_MAX_BYTES) : text}`);
    } else if (m.role === "toolResult") {
      add(i, resultLine(calls[k++], m, preset));
    } else {
      const text = textOf(m);
      const letters = (m.tau?.letters ?? []).filter((l) => l.at !== undefined);
      if (m.tau?.handoff === true && text.startsWith(HANDOFF_HEADER)) {
        const brief = m.tau.brief;
        if (brief !== undefined && seq > 1) {
          for (const l of text.slice(brief[0], brief[1]).split("\n")) {
            if (l.startsWith("[")) lines.push(l);
            else omitted += Number(/省略了 (\d+) 行/.exec(l)?.[1] ?? 0);
          }
        }
        const carry = text.indexOf(`\n\n${CARRY_HEADER}`, HANDOFF_HEADER.length);
        add(i, `交接说明：${text.slice(HANDOFF_HEADER.length, brief === undefined ? (carry < 0 ? text.length : carry) : brief[0] - 2)}`);
      } else if (letters.length === 0) {
        add(i, `用户：${blocks(m).map((c) => (c.type === "text" ? c.text : "[图片]")).join(" ")}`);
      }
      const image = blocks(m).some((c) => c.type === "image");
      for (const l of letters) {
        const body = text.slice(l.at![0], l.at![1]) || (image ? "[图片]" : "");
        add(i, `${l.from.kind === "user" ? "用户：" : `信（来自 ${l.from.id}）：`}${body}`);
      }
    }
  }
  return { lines, omitted };
}

/**
 * 从新到旧取两遍，放不下就停：第一遍只取信、用户消息和交接说明，总量不超过预算的一半；第二遍从没取的行里取（含第一遍没放下的），总量不超过预算。按原顺序写成一块，从 `BRIEF_HEADER` 到 `BRIEF_END`。
 * `budget` 是行的预算：整块的预算减去 `BRIEF_FIXED_BYTES`。一行都放不下时返回空串。
 */
export function briefBlock(all: { lines: string[]; omitted: number }, budget: number): string {
  const take = new Set<number>();
  let used = 0;
  for (const [priority, cap] of [[true, Math.floor(budget / 2)], [false, budget]] as const) {
    for (let i = all.lines.length - 1; i >= 0; i--) {
      const line = all.lines[i]!;
      if (take.has(i) || (priority && !PRIORITY.test(line))) continue;
      const cost = utf8Bytes(line) + 1;
      if (used + cost > cap) break;
      used += cost;
      take.add(i);
    }
  }
  if (take.size === 0) return "";
  const omitted = all.omitted + all.lines.length - take.size;
  return [BRIEF_HEADER, ...(omitted > 0 ? [omitLine(omitted)] : []), ...all.lines.filter((_, i) => take.has(i)), BRIEF_END].join("\n");
}
