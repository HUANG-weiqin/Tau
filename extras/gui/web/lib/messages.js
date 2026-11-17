// @ts-check
// 把一段的 pi-ai 消息变成界面要显示的条目。信头的格式照内核的 `decide.ts` 的 `header` 和 `render`。
/** @typedef {import("./types.js").Message} Message */
/** @typedef {import("./types.js").Ended} Ended */
/** @typedef {import("./types.js").PhaseView} PhaseView */

/** 内核补的工具结果原文（`src/kernel/decide.ts`）。 */
export const INTERRUPTED = "被中断，结果未知";
export const SKIPPED = "未执行";
/** 新段第一条消息的开头和带过来的用户消息前的一行（`src/kernel/context.ts`）。 */
export const HANDOFF_HEADER = "（这是你在上一个工作段结束时写的交接说明。）\n\n";
export const CARRY_HEADER = "（下面是写交接说明时还没处理的用户消息。）";

/**
 * 一封信。`user`：用户的信；`process`：别的进程的信，`waiting` 是信头说它在等回信；`reply`：回信，`ended` 是那一轮的结束原因。
 * @typedef {{ from: "user", text: string }
 *   | { from: "process", id: string, preset: string, waiting: boolean, text: string }
 *   | { from: "reply", id: string, endedText: string, ended: Ended | null, text: string }} Letter
 */
/** @typedef {{ hash: string, mimeType: string }} ImageRef */
/** @typedef {{ seq: number, ts: number, text: string, summary: string, images: ImageRef[], isError: boolean }} CallResult */
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

const HEADER_LINE = /^（(?:(来自用户)|来自进程 (\S+?)，预设 (.+?)(。它在等回信：.*)?|进程 (\S+) 的回信，这一轮(.*))）$/;

/**
 * 结束原因的文字（`endedText`）还原成结束原因。认不出时是 null。
 * @param {string} t
 * @returns {Ended | null}
 */
export function endedFromText(t) {
  if (t === "正常结束") return "done";
  if (t === "步数用完") return "stepLimit";
  if (t === "被停止") return "stopped";
  if (t.startsWith("出错：")) return { error: t.slice(3) };
  return null;
}

/**
 * 一条用户消息的正文拆成信。一批里有进程的信时，每封信前面有一行信头，信之间空一行；
 * 没有信头就是用户的一封信。信头只认写在行首、前面是空行（或开头）的整行。
 * @param {string} text
 * @returns {Letter[]}
 */
export function splitLetters(text) {
  const lines = text.split("\n");
  /** @type {number[]} */
  const heads = [];
  lines.forEach((line, i) => {
    if ((i === 0 || lines[i - 1] === "") && HEADER_LINE.test(line)) heads.push(i);
  });
  if (heads[0] !== 0) return [{ from: "user", text }];
  return heads.map((h, k) => {
    const next = heads[k + 1];
    const body = lines.slice(h + 1, next === undefined ? lines.length : next - 1).join("\n");
    const m = HEADER_LINE.exec(lines[h] ?? "");
    if (!m) return { from: "user", text: body };
    if (m[1]) return { from: "user", text: body };
    if (m[2] !== undefined) return { from: "process", id: m[2], preset: m[3] ?? "", waiting: m[4] !== undefined, text: body };
    const endedText = m[6] ?? "";
    return { from: "reply", id: m[5] ?? "", endedText, ended: endedFromText(endedText), text: body };
  });
}

/**
 * 一条用户消息：开头的“上一轮…”说明、交接说明、信。
 * @param {import("./types.js").UserMessage} m
 * @returns {{ note: string | null, handoff: { note: string, carried: string | null } | null, letters: Letter[], images: ImageRef[] }}
 */
export function parseUser(m) {
  let text = textOf(m.content);
  const images = imagesOf(m.content);
  if (text.startsWith(HANDOFF_HEADER)) {
    const rest = text.slice(HANDOFF_HEADER.length);
    const at = rest.indexOf("\n\n" + CARRY_HEADER);
    if (at < 0) return { note: null, handoff: { note: rest, carried: null }, letters: [], images };
    const carried = rest.slice(at + 2 + CARRY_HEADER.length).replace(/^\n\n/, "");
    return { note: null, handoff: { note: rest.slice(0, at), carried }, letters: [], images };
  }
  /** @type {string | null} */
  let note = null;
  const m1 = /^（上一轮[^\n]*）\n\n/.exec(text);
  if (m1) {
    note = m1[0].slice(0, -2);
    text = text.slice(m1[0].length);
  }
  return { note, handoff: null, letters: splitLetters(text), images };
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
  return { seq, ts: m.timestamp, text, summary: clipText(firstLine(text), 100), images: imagesOf(m.content), isError: m.isError };
}

/** @param {CallResult | null} r @returns {Call["status"]} */
function statusOf(r) {
  if (r === null) return "pending";
  if (r.isError && r.text === INTERRUPTED) return "interrupted";
  if (r.isError && r.text === SKIPPED) return "skipped";
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
 * 第 `i` 条是不是一轮的开头：用户消息，前面不是工具结果；或者前面是工具结果但开头带“上一轮…”说明
 * （上一轮没正常结束，停在工具结果上，下一封信带说明开新的一轮）。
 * @param {readonly Message[]} messages
 * @param {number} i
 */
function opensTurn(messages, i) {
  const m = messages[i];
  if (m?.role !== "user") return false;
  if (messages[i - 1]?.role !== "toolResult") return true;
  return textOf(m.content).startsWith("（上一轮");
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
  if (i === 0 && first?.role === "user" && textOf(first.content).startsWith(HANDOFF_HEADER)) return null;
  return i;
}

/**
 * “换段”按钮寄的信。内核没有从外面强制换段的请求，只有模型自己调用 `handoff` 工具才换段，
 * 所以界面请模型去调。它和写信框寄的信一样走 `send`，消息流里看得见。
 */
export const HANDOFF_LETTER = "请现在调用 handoff 工具换段，这一轮不做别的事。换段以后回一句“已换段”就结束。";
