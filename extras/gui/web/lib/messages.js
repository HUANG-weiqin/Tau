// @ts-check
// 把一段的 pi-ai 消息变成界面要显示的条目。信的来历读消息的 `tau`（内核写的结构），不解析文字。
/** @typedef {import("./types.js").Message} Message */
/** @typedef {import("./types.js").Ended} Ended */
/** @typedef {import("./types.js").PhaseView} PhaseView */

/** 新段第一条消息的开头和带过来的用户消息前的一行（`src/kernel/context.ts`）：只用来切出交接说明和带过来的消息。 */
export const HANDOFF_HEADER = "（这是你在上一个工作段结束时写的交接说明。）\n\n";
export const CARRY_HEADER = "（下面是写交接说明时还没处理的用户消息。）";

/**
 * 一封信，来自消息的 `tau.letters`。`user`：用户的信；`process`：别的进程的信，`waiting` 是写信时它在等回信（有 `replyTo`）；
 * `reply`：回信，`ended` 是那一轮的结束原因。`hops` 是跳数；没有 `tau` 的旧消息没有它。
 * @typedef {{ from: "user", text: string, hops?: number }
 *   | { from: "process", id: string, preset: string, waiting: boolean, text: string, hops?: number }
 *   | { from: "reply", id: string, endedText: string, ended: Ended, text: string, hops?: number }} Letter
 */
/** @typedef {{ hash: string, mimeType: string }} ImageRef */
/** `filled`：内核补的结果，`interrupted` 被中断，`skipped` 未执行；真实的工具结果是 null。 @typedef {{ seq: number, ts: number, text: string, summary: string, images: ImageRef[], isError: boolean, filled: "interrupted" | "skipped" | null }} CallResult */
/** `status`：`pending` 还没有结果，`ok`，`error`（工具报错），`interrupted`（被中断，结果未知），`skipped`（未执行）。 @typedef {{ id: string, name: string, args: Record<string, unknown>, summary: string, status: "pending" | "ok" | "error" | "interrupted" | "skipped", result: CallResult | null }} Call */
/**
 * @typedef {{ kind: "user", seq: number, ts: number, note: string | null, letters: Letter[], images: ImageRef[] }
 *   | { kind: "handoff", seq: number, ts: number, note: string, carried: string | null, images: ImageRef[] }
 *   | { kind: "assistant", seq: number, ts: number, text: string, thinking: string, calls: Call[], stopReason: string | null, errorMessage: string | null }
 *   | { kind: "orphanResult", seq: number, ts: number, name: string, result: CallResult }
 *   | { kind: "fold", count: number, from: number, to: number }} Item
 */

/**
 * @param {string} s
 * @param {number} max 按字符数
 */
export function clipText(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("") + "…";
}

/** @param {string} s */
function firstLine(s) {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

/**
 * 内容块里的文字。
 * @param {string | ({ type: string, text?: string })[]} content
 */
export function textOf(content) {
  if (typeof content === "string") return content;
  return content.flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");
}

/**
 * 内容块里的图片。`data` 是 `blob:<hash>`；不是这个形式的（例如还没入库的 base64）不算。
 * @param {string | ({ type: string, data?: string, mimeType?: string })[]} content
 * @returns {ImageRef[]}
 */
export function imagesOf(content) {
  if (typeof content === "string") return [];
  return content.flatMap((c) => (c.type === "image" && typeof c.data === "string" && c.data.startsWith("blob:") ? [{ hash: c.data.slice(5), mimeType: c.mimeType ?? "image/png" }] : []));
}

/**
 * 结束原因的界面文字。出错带原因（回信里的出错原因内核已经截短）。
 * @param {Ended} ended
 */
export function endedLabel(ended) {
  if (ended === "done") return "正常结束";
  if (ended === "stepLimit") return "步数用完";
  if (ended === "stopped") return "被停止";
  return `出错：${ended.error}`;
}

/**
 * 一条用户消息的文本：`content` 是字符串就是它，是数组就是第一个文本块（`tau.letters[].at` 指的就是它）。
 * @param {import("./types.js").UserMessage} m
 */
function tauText(m) {
  if (typeof m.content === "string") return m.content;
  const first = m.content.find((c) => c.type === "text");
  return first && first.type === "text" ? first.text : "";
}

/**
 * 一封信的视图。
 * @param {import("./types.js").LetterMeta} meta
 * @param {string} text
 * @returns {Letter}
 */
function letterOf(meta, text) {
  const f = meta.from;
  if (f.kind === "user") return { from: "user", text, hops: meta.hops };
  if (f.reply) return { from: "reply", id: f.id, endedText: endedLabel(f.reply.ended), ended: f.reply.ended, text, hops: meta.hops };
  return { from: "process", id: f.id, preset: f.preset, waiting: meta.replyTo !== undefined, text, hops: meta.hops };
}

/**
 * 一条用户消息：上一轮的说明、交接说明、信。全部读 `tau`，不解析文字。没有 `tau` 的旧消息是普通用户消息：整段文字一封用户的信。
 * 文字被截过的消息，`tau.letters` 没有 `at`：整段文字当成一封信，发送者取第一封。
 * @param {import("./types.js").UserMessage} m
 * @returns {{ note: string | null, handoff: { note: string, carried: string | null } | null, letters: Letter[], images: ImageRef[] }}
 */
export function parseUser(m) {
  const text = tauText(m);
  const images = imagesOf(m.content);
  const tau = m.tau;
  if (!tau) return { note: null, handoff: null, letters: [{ from: "user", text }], images };
  const note = tau.after === undefined ? null : `上一轮${endedLabel(tau.after)}`;
  const ats = tau.letters.flatMap((l) => (l.at ? [l.at] : []));
  // 没有文字的信（只有图片）没有 `at`；有文字却一封都没有 `at`，是文字被截过。
  const clipped = ats.length === 0 && text !== "";
  /** @type {Letter[]} */
  const letters = clipped ? (tau.letters[0] ? [letterOf(tau.letters[0], text)] : []) : tau.letters.map((l) => letterOf(l, l.at ? text.slice(l.at[0], l.at[1]) : ""));
  if (tau.handoff !== true) return { note, handoff: null, letters, images };
  // 换段后的第一条：说明在前，带过来的消息（有正文的信）在后。
  const from = text.startsWith(HANDOFF_HEADER) ? HANDOFF_HEADER.length : 0;
  if (ats.length === 0) {
    const at = text.indexOf("\n\n" + CARRY_HEADER, from);
    return { note: null, handoff: { note: text.slice(from, at < 0 ? text.length : at), carried: null }, letters: [], images };
  }
  const first = Math.min(...ats.map((a) => a[0]));
  const last = Math.max(...ats.map((a) => a[1]));
  const at = text.lastIndexOf("\n\n" + CARRY_HEADER, first);
  return { note: null, handoff: { note: text.slice(from, at < 0 ? first : at), carried: text.slice(first, last) }, letters: [], images };
}

/**
 * 这一轮是谁开的：看开头那封信的发送者。
 * @param {import("./types.js").UserMessage} m
 */
export function describeStart(m) {
  const l = parseUser(m).letters[0];
  if (l?.from === "process") return `由 ${l.preset} 的来信开始`;
  return l?.from === "reply" ? "开始" : "由你的来信开始";
}

/**
 * 工具调用的一行摘要：bash 取命令，读写改取路径，其它取第一个字符串参数。
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export function summarizeCall(name, args) {
  /** @type {unknown} */
  let v;
  if (name === "bash") v = args["command"];
  else if (name === "read" || name === "write" || name === "edit") v = args["path"] ?? args["file_path"] ?? args["filePath"];
  if (typeof v !== "string") v = Object.values(args).find((x) => typeof x === "string");
  if (typeof v !== "string") return Object.keys(args).length === 0 ? "" : clipText(JSON.stringify(args), 80);
  return clipText(firstLine(v), 80);
}

/** @param {import("./types.js").ToolResultMessage} m @param {number} seq @returns {CallResult} */
function resultOf(m, seq) {
  const text = textOf(m.content);
  return { seq, ts: m.timestamp, text, summary: clipText(firstLine(text), 100), images: imagesOf(m.content), isError: m.isError, filled: m.tau?.filled ?? null };
}

/** @param {CallResult | null} r @returns {Call["status"]} */
function statusOf(r) {
  if (r === null) return "pending";
  if (r.filled) return r.filled;
  return r.isError ? "error" : "ok";
}

/**
 * 一段的消息变成条目。助手消息里的工具调用按位置配上它后面连着的工具结果（同内核：ID 来自模型，可能为空或重复）；多出来的结果单列。
 * 条目的 `seq` 是消息在段里的序号。
 * @param {readonly Message[]} messages
 * @returns {Item[]}
 */
export function toItems(messages) {
  const claimed = new Set();
  /** 助手消息的序号 → 它后面连着的结果（按顺序）。 @type {Map<number, { seq: number, m: import("./types.js").ToolResultMessage }[]>} */
  const following = new Map();
  /** @type {{ seq: number, m: import("./types.js").ToolResultMessage }[] | null} */
  let run = null;
  messages.forEach((m, seq) => {
    if (m.role === "assistant") {
      run = [];
      following.set(seq, run);
    } else if (m.role === "user") run = null;
    else if (m.role === "toolResult" && run) run.push({ seq, m });
  });
  /** @type {Item[]} */
  const items = [];
  messages.forEach((m, seq) => {
    if (m.role === "user") {
      const p = parseUser(m);
      items.push(p.handoff ? { kind: "handoff", seq, ts: m.timestamp, note: p.handoff.note, carried: p.handoff.carried, images: p.images } : { kind: "user", seq, ts: m.timestamp, note: p.note, letters: p.letters, images: p.images });
    } else if (m.role === "assistant") {
      /** @type {Call[]} */
      const calls = [];
      const mine = following.get(seq) ?? [];
      let k = 0;
      for (const b of m.content) {
        if (b.type !== "toolCall") continue;
        const r = mine[k++];
        if (r) claimed.add(r.seq);
        const result = r ? resultOf(r.m, r.seq) : null;
        calls.push({ id: b.id, name: b.name, args: b.arguments, summary: summarizeCall(b.name, b.arguments), status: statusOf(result), result });
      }
      items.push({
        kind: "assistant",
        seq,
        ts: m.timestamp,
        text: m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        thinking: m.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n"),
        calls,
        stopReason: m.stopReason ?? null,
        errorMessage: m.errorMessage ?? null,
      });
    }
  });
  messages.forEach((m, seq) => {
    if (m.role === "toolResult" && !claimed.has(seq)) items.push({ kind: "orphanResult", seq, ts: m.timestamp, name: m.toolName, result: resultOf(m, seq) });
  });
  return items.sort((a, b) => seqOf(a) - seqOf(b));
}

/** @param {Item} x */
function seqOf(x) {
  return x.kind === "fold" ? x.from : x.seq;
}

/**
 * 中间的条目太多时折成一条：留开头 `head` 条、结尾 `tail` 条。
 * @param {Item[]} items
 * @param {number} head
 * @param {number} tail
 * @returns {Item[]}
 */
export function foldMiddle(items, head, tail) {
  if (items.length <= head + tail + 1) return items;
  const hidden = items.slice(head, items.length - tail);
  const first = hidden[0];
  const last = hidden[hidden.length - 1];
  if (!first || !last || first.kind === "fold" || last.kind === "fold") return items;
  return [...items.slice(0, head), { kind: "fold", count: hidden.length, from: first.seq, to: last.seq }, ...items.slice(items.length - tail)];
}

/**
 * “在做什么”：最后一条助手消息里最后一个工具调用（名字加参数摘要），没有就取它的文字的第一行。
 * @param {readonly Message[]} messages
 */
export function describeNow(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const calls = m.content.flatMap((b) => (b.type === "toolCall" ? [b] : []));
    const call = calls[calls.length - 1];
    if (call) {
      const s = summarizeCall(call.name, call.arguments);
      return s === "" ? call.name : `${call.name} ${s}`;
    }
    return clipText(firstLine(m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")), 80);
  }
  return "";
}

/**
 * 进程在当前阶段是从什么时刻开始待的：等模型和空闲时是最后一条消息的时间戳，等工具时是带调用的那条助手消息的时间戳。没有消息是 null。
 * @param {readonly Message[]} messages
 * @param {PhaseView["tag"]} tag
 * @returns {number | null}
 */
export function phaseStartedAt(messages, tag) {
  if (tag === "awaitingTool") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") return m.timestamp;
    }
  }
  return messages[messages.length - 1]?.timestamp ?? null;
}

/**
 * 一段里最后一条消息的时间戳。
 * @param {readonly Message[]} messages
 * @returns {number | null}
 */
export function lastMessageAt(messages) {
  return messages[messages.length - 1]?.timestamp ?? null;
}

/**
 * 当前段里能从它前面分叉的位置：用户消息的段内序号，新的在后。
 * @param {readonly Message[]} messages
 * @returns {number[]}
 */
export function forkPoints(messages) {
  return messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
}

/**
 * 第 `i` 条是不是一轮的开头：用户消息，前面不是工具结果；或者前面是工具结果但带 `tau.after`
 * （上一轮没正常结束，停在工具结果上，下一封信带说明开新的一轮）。
 * @param {readonly Message[]} messages
 * @param {number} i
 */
function opensTurn(messages, i) {
  const m = messages[i];
  if (m?.role !== "user") return false;
  if (messages[i - 1]?.role !== "toolResult") return true;
  return m.tau?.after !== undefined;
}

/**
 * 这一轮开头那封信的序号：最后一封开新一轮的用户消息（见 `opensTurn`），连着的用户消息取第一条。
 * （运行中到的信在安全点并进段，前面是工具结果。）段里没有时是 null：这一轮中途换过段，开头在上一段。
 * @param {readonly Message[]} messages
 * @returns {number | null}
 */
export function turnStart(messages) {
  let i = messages.length - 1;
  while (i >= 0 && !opensTurn(messages, i)) i--;
  if (i < 0) return null;
  while (i > 0 && messages[i - 1]?.role === "user") i--;
  const first = messages[i];
  if (i === 0 && first?.role === "user" && first.tau?.handoff === true) return null;
  return i;
}

/**
 * 换段信（`send` 带 `handoff`）要生效，段里得已有助手消息：新进程的第一封信、刚换段的新段开头，标记都作废
 * （[kb-kernel 的换段信](../../../../.knowledge/kb-kernel.md#换段信)）。界面在这两种情形下禁用“换段”。
 * @param {readonly Message[]} messages 当前段
 */
export function canHandoff(messages) {
  return messages.some((m) => m.role === "assistant");
}

/**
 * “换段”按钮寄的信的正文。换段信原样带进新段，模型在新段里接着处理它，所以写明不用做别的事。
 * 它和写信框寄的信一样写进段，消息流里看得见（在交接说明下面“带过来的用户消息”里）。
 */
export const HANDOFF_LETTER = "这封信是界面为了换段寄的，换段已经完成。没有别的事要做，回一句“已换段”就结束。";
