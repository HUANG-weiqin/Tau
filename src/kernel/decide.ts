// start、decide、effectOf：纯函数（见 .knowledge/kb-kernel.md）。
import { briefBlock, briefLines, BRIEF_FIXED_BYTES, BRIEF_MAX_BYTES } from "./brief.ts";
import { CARRY_HEADER, HANDOFF_HEADER, IMAGE_UNSUPPORTED, tailStart } from "./context.ts";
import { BYTES_PER_TOKEN, clip, contextUsed, endedReason, endedText, estimatedUsed, finalReply, HANDOFF_REQUEST_MAX_BYTES, handoffRequested, handoffThreshold, IMAGES_PER_MESSAGE, MARGIN_TOKENS, MESSAGE_MAX_BYTES, newSegmentUsed, pendingCalls, RETRIES_PER_REPLY, STEPS_PER_TURN, tokens, utf8Bytes } from "./derive.ts";
import { sameStructure, withCallParams } from "./snapshot.ts";
import { textContent, unreachable } from "./types.ts";
import type { AssistantMessage, Content, Effect, Ended, Env, ImageContent, Input, Instant, Letter, LetterMeta, Message, Phase, PresetSnapshot, Process, ProcessId, Purpose, ToolCall, ToolResultContent, Turn, Usage, UserTau } from "./types.ts";

export const INTERRUPTED = "被中断，结果未知";
export const SKIPPED = "未执行";

/** 建一个 idle 进程。`contextView` 是调用方读好的上下文视图（D72），空串就不写这个键。 */
export function start(id: ProcessId, preset: PresetSnapshot, env: Env, contextView = ""): Process {
  return { id, preset, createdAt: env.now, segment: { seq: 1, memoryView: env.memoryView, ...(contextView === "" ? {} : { contextView }) }, lastEffect: 0, phase: { tag: "idle" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, since: env.now };
}

/**
 * 从源进程的当前段分叉出一个新进程（见 .knowledge/kb-kernel.md 的 fork）。`before` 是当前段里一条用户消息的段内序号：新进程的第 1 段是它前面的全部消息，阶段是没有结束原因的 idle。
 * 不带 `before` 时复制整个当前段和 idle 阶段，源进程必须是 idle。不合格就抛错。
 * 带 `to` 是换角色：新进程的快照、记忆视图和上下文视图用 `to` 的，不用源进程的。新模型不收图片就把复制的图片换成说明；不用用量锚点估算，复制来的段要低于新预设的换段阈值，否则抛错。
 */
export function fork(id: ProcessId, source: Process, segment: readonly Message[], before: number | undefined, now: Instant, to?: { preset: PresetSnapshot; memoryView: string; contextView?: string }): { process: Process; messages: Message[] } {
  let phase: Phase;
  let messages: Message[];
  if (before === undefined) {
    if (source.phase.tag !== "idle") throw new Error(`进程 ${source.id} 正在运行，不带 before 不能 fork。`);
    phase = source.phase;
    messages = [...segment];
  } else {
    const at = segment[before];
    if (!at) throw new Error(`进程 ${source.id} 的当前段有 ${segment.length} 条消息，没有第 ${before} 条。`);
    if (at.role !== "user") throw new Error(`进程 ${source.id} 的当前段第 ${before} 条是 ${at.role}，不是用户消息。`);
    phase = { tag: "idle" };
    messages = segment.slice(0, before);
  }
  const preset = to?.preset ?? source.preset;
  if (to && !preset.input.includes("image")) messages = messages.map(withoutImages);
  const contextView = to ? to.contextView : source.segment.contextView;
  const process: Process = { id, preset, createdAt: now, segment: { seq: 1, memoryView: to?.memoryView ?? source.segment.memoryView, ...(contextView ? { contextView } : {}) }, lastEffect: 0, phase, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, since: now };
  if (to) {
    // 超过阈值时第一次调用就是交接调用，带着整段，换到小窗口会失败。
    const used = estimatedUsed(process, messages);
    const threshold = handoffThreshold(preset);
    if (used >= threshold) throw new Error(`复制来的 ${messages.length} 条消息放不进预设 ${preset.id}：估算 ${used} token，换段阈值 ${threshold} token`);
  }
  return { process, messages };
}

/** 一条消息里的图片换成说明，在原位置，和文字用换行连成一段：用户消息是字符串，工具结果是一个文本块。没有图片的消息原样。 */
function withoutImages(m: Message): Message {
  if (m.role === "assistant" || typeof m.content === "string" || !m.content.some((c) => c.type === "image")) return m;
  const text = m.content.map((c) => (c.type === "image" ? IMAGE_UNSUPPORTED : c.text)).join("\n");
  // 用户消息没有图片时 content 是字符串（消息的两种形状）。
  return m.role === "user" ? { ...m, content: text } : { ...m, content: textContent(text) };
}

/** 要寄出的回信：收件人和信件。存储层在同一个事务里放进收件人的信箱。 */
export interface Out {
  to: ProcessId;
  letter: Letter;
}

/** 处理一条输入时的草稿。`seg` 是当前段的全部消息，`append` 是这次要追加的，`out` 是要寄的回信。 */
interface Draft {
  p: Process;
  seg: Message[];
  append: Message[];
  out: Out[];
  env: Env;
}

export function decide(p: Process, segment: readonly Message[], input: Input, env: Env): { process: Process; append: Message[]; out: Out[] } {
  const d: Draft = { p, seg: [...segment], append: [], out: [], env };
  step(d, input);
  return { process: d.p, append: d.append, out: d.out };
}

export function effectOf(p: Process, segment: readonly Message[]): Effect | null {
  const { phase } = p;
  switch (phase.tag) {
    case "idle":
      return null;
    case "awaitingModel":
      return { kind: "callModel", n: p.lastEffect, purpose: phase.purpose };
    case "awaitingTool": {
      const call = pendingCalls(segment)[0];
      return call ? { kind: "runTool", n: p.lastEffect, call } : null;
    }
    default:
      return unreachable(phase);
  }
}

function step(d: Draft, input: Input): void {
  const { phase } = d.p;
  switch (input.kind) {
    case "letter":
      if (phase.tag === "idle") {
        const note = endedNote(phase.ended);
        const { text, images, metas } = render([input.letter]);
        const shift = note === "" ? 0 : note.length + 2;
        const tau: UserTau = { letters: shifted(metas, shift), ...(phase.ended === undefined || note === "" ? {} : { after: phase.ended }) };
        push(d, userMessage(note === "" ? text : `${note}\n\n${text}`, images, false, d.env.now, tau));
        continueTurn(d, newTurn([input.letter]), wantsHandoff(d, [input.letter]));
      } else {
        const turn = { ...phase.turn, queued: [...phase.turn.queued, input.letter] };
        d.p = { ...d.p, phase: { ...phase, turn } };
      }
      return;
    case "stop":
      if (phase.tag !== "idle") endTurn(d, phase.turn, "stopped");
      return;
    case "modelResult":
      if (phase.tag !== "awaitingModel" || input.n !== d.p.lastEffect) return;
      if (input.outcome.status === "interrupted") return endTurn(d, phase.turn, { error: "服务重启，模型调用被中断" });
      d.p = { ...d.p, usage: addUsage(d.p.usage, input.outcome.message.usage) };
      if (phase.purpose === "turn") return onReply(d, phase.turn, input.outcome.message);
      return onHandoff(d, phase.turn, input.outcome.message);
    case "toolResult":
      if (phase.tag !== "awaitingTool" || input.n !== d.p.lastEffect) return;
      if (input.outcome.status === "interrupted") return endTurn(d, phase.turn, { error: "服务重启，工具被中断" });
      return onToolResult(d, phase.turn, input.outcome.content);
    case "reconfigure":
      return reconfigure(d, input.preset);
    default:
      return unreachable(input);
  }
}

/**
 * 会话配置（D71，见 .knowledge/kb-kernel.md 的“流程：会话配置”）。`s` 是服务算好的完整新快照。任何阶段都处理，不写消息，不发回信，不改阶段，不开轮。
 * 1. 三个调用参数立即换成 `s` 的。2. 结构性字段和当前的相等：取消待换配置。
 * 3. 空闲、段里没有助手消息、新模型收图或段里没有图、段放得下新快照：直接采用，视图用 `env.fresh` 的。4. 否则存进 `next`，换段时生效。
 */
function reconfigure(d: Draft, s: PresetSnapshot): void {
  const { next: _, ...p } = d.p;
  const preset = withCallParams(p.preset, s);
  if (sameStructure(s, preset)) {
    d.p = { ...p, preset };
    return;
  }
  // 在途的调用拿着旧的提示词和工具清单，所以只有空闲、没有助手回复过旧提示词时才直接换。段里有图而新模型不收图时也不直接换：已有的消息不改写，下一次调用会带着图失败。
  const hasImage = d.seg.some((m) => m.role !== "assistant" && typeof m.content !== "string" && m.content.some((c) => c.type === "image"));
  if (p.phase.tag === "idle" && !d.seg.some((m) => m.role === "assistant") && (s.input.includes("image") || !hasImage)) {
    const view = openingViews(d);
    const adopted: Process = { ...p, preset: s, segment: { seq: p.segment.seq, memoryView: view.memoryView, ...(view.contextView === "" ? {} : { contextView: view.contextView }) } };
    // 窗口变小时，已有的段可能放不进新快照：下一次调用就是带着整段的交接调用，会超窗口。口径和 `fork` 带 preset 一样：不用锚点的估算，`>=` 算放不下。放不下就存 `next`，走换段采用的路。
    if (estimatedUsed(adopted, d.seg) < handoffThreshold(s)) {
      d.p = adopted;
      return;
    }
  }
  d.p = { ...d.p, preset, next: s };
}

/** 开段视图：存储层给 `fresh` 的；缺省时记忆视图用 `env.memoryView`，没有上下文视图。 */
function openingViews(d: Draft): { memoryView: string; contextView: string } {
  const f = d.env.fresh;
  return { memoryView: f?.memoryView ?? d.env.memoryView, contextView: f?.contextView ?? "" };
}

/**
 * 第 5.3 节。可恢复的失败（空回复、`length`、流出错）不结束这一轮，重发同一个请求（D92，`retry`）；失败的回复不入段。
 * 好的回复被接受时去掉 `turn.retry`。
 */
function onReply(d: Draft, turn: Turn, m: AssistantMessage): void {
  const r = m.stopReason;
  const { retry: _, ...clean } = turn;
  switch (r) {
    case "toolUse":
    case "stop": {
      // 空：没有非空白文字，没有工具调用（思考不算）。次数用完仍空就照常写进段，done。
      if (!m.content.some((c) => c.type === "toolCall" || (c.type === "text" && c.text.trim() !== ""))) {
        return retry(d, turn, "turn", "empty", () => {
          push(d, m);
          endTurn(d, clean, "done");
        });
      }
      const fitted = fitCalls(m);
      if (fitted === null) return endTurn(d, turn, { error: "一次回复的工具调用太多" });
      push(d, fitted);
      // 只看有没有待执行的调用，不看 stopReason：弱模型的 stop 常常带着调用。
      if (pendingCalls(d.seg).length > 0) return enter(d, { tag: "awaitingTool", turn: clean });
      return endTurn(d, clean, "done");
    }
    case "length":
      return retry(d, turn, "turn", "length", () => endTurn(d, turn, { error: "输出被截断" }));
    case "error":
      return retry(d, turn, "turn", "error", () => endTurn(d, turn, { error: m.errorMessage ?? r }));
    case "aborted":
    case "pending":
    case "deferred":
      return endTurn(d, turn, { error: m.errorMessage ?? r });
    default: {
      // 编译期穷尽；运行时遇到 pi-ai 之外的值也按失败处理，不让这条输入卡住。
      const unknown: never = r;
      return endTurn(d, turn, { error: m.errorMessage ?? String(unknown) });
    }
  }
}

/**
 * 重发同一个请求（D92）：阶段仍是 `awaitingModel`，用途不变，`turn.retry` 记最后一次失败的种类和连续失败的次数，不分种类。
 * 次数超过 `RETRIES_PER_REPLY` 就调用 `give`（现状的结束处理）。重发也计步，步数用完时以 `stepLimit` 结束。
 */
function retry(d: Draft, turn: Turn, purpose: Purpose, kind: NonNullable<Turn["retry"]>["kind"], give: () => void): void {
  const n = (turn.retry?.n ?? 0) + 1;
  if (n > RETRIES_PER_REPLY) return give();
  if (turn.steps >= STEPS_PER_TURN) return endTurn(d, turn, "stepLimit");
  return enter(d, { tag: "awaitingModel", turn: { ...turn, steps: turn.steps + 1, retry: { kind, n } }, purpose });
}

/** 调用都补成“未执行”后放不进余量时只留放得下的前几个（D87）。预算只有余量减去交接请求末尾的消息（指令加重试提示，D92）：阈值之上的余量已经分给了一次
 * 回复、一个没检查的工具结果和交接说明的输出。ID 算两次（调用和结果各带一次，回复的用量里没有它）。截断后没有文字时把尾巴
 * 里最后一个文字块接回来，免得回信正文是空串；连一个调用都放不下时返回 null。 */
function fitCalls(m: AssistantMessage): AssistantMessage | null {
  const budget = MARGIN_TOKENS - tokens(HANDOFF_REQUEST_MAX_BYTES);
  let bytes = 0;
  let cut = -1;
  for (const [i, c] of m.content.entries()) {
    if (cut >= 0 || c.type !== "toolCall") continue;
    const next = bytes + 2 * utf8Bytes(c.id) + utf8Bytes(c.name) + utf8Bytes(SKIPPED);
    if (tokens(next) <= budget) bytes = next;
    else cut = i;
  }
  if (cut < 0) return m;
  const kept = m.content.slice(0, cut);
  if (!kept.some((c) => c.type === "text")) kept.push(...m.content.slice(cut).filter((c) => c.type === "text").slice(-1));
  return kept.some((c) => c.type === "toolCall") ? { ...m, content: kept } : null;
}

/**
 * 第 5.4 节。有待换配置（`p.next`，D71）时，新段按它开：快照、阈值、两个开段视图都用 `next` 和 `env.fresh` 的，检查通过才采用。
 * 没有 `next` 时，快照不变，记忆视图用 `env.memoryView`，上下文视图每次换段重取（`env.fresh`）。
 */
function onHandoff(d: Draft, turn: Turn, m: AssistantMessage): void {
  const note = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
  if ((m.stopReason === "stop" || m.stopReason === "length") && note !== "") {
    if (d.append.length > 0) throw new Error("换段前不能有要追加的消息");
    const { next, ...kept } = d.p;
    const to = next ?? d.p.preset;
    const views = openingViews(d);
    const { contextView } = views;
    const memoryView = next === undefined ? d.env.memoryView : views.memoryView;
    // 第 5.6 节：先查假想的新段，不带要带过去的信。到阈值就按交接失败结束本轮，不写交接回复。
    const first = userMessage(HANDOFF_HEADER + note, [], true, d.env.now);
    const { used, fixed, memory, context } = newSegmentUsed({ ...d.p, preset: to }, memoryView, first, contextView);
    const threshold = handoffThreshold(to);
    if (used >= threshold) {
      // 待换的配置让新段一开头就到阈值：丢掉它，进程用旧快照继续，不会陷进每封信都交接失败的循环。
      if (next !== undefined) d.p = kept;
      return endTurn(d, turn, { error: `交接失败：新段一开头就到阈值（固定部分 ${fixed}、记忆 ${memory}${context > 0 ? `、上下文 ${context}` : ""}、交接说明 ${used - fixed - memory - context}，共 ${used} / ${threshold} token）${next === undefined ? "" : "；待换的配置已丢弃"}` });
    }
    // 交接请求没带段末的用户消息（见 buildContext），把它们原样附在交接说明后面：文本接在说明后，图片块原样带过去。采用的待换配置的模型不收图片时，图换成说明，和 fork 带 preset 同一段代码。
    const tail0 = tailStart(d.seg);
    const carriedMessages = d.seg.slice(tail0).map((u) => (next === undefined || next.input.includes("image") ? u : withoutImages(u)));
    const users = carriedMessages.flatMap((u) => (u.role === "user" ? [u] : []));
    const tail = users.map((u) => (typeof u.content === "string" ? textContent(u.content) : u.content));
    const carriedText = tail.map(textOf).filter((t) => t !== "").join("\n\n");
    const carried = tail.length === 0 ? "" : `\n\n${CARRY_HEADER}${carriedText === "" ? "" : `\n\n${carriedText}`}`;
    // 简略视图（D103）：预算取三项最小，放得下至少一行才写。第一条不被 clip 截，交接以后的检查也不会因它失败。
    const images = tail.flatMap(imagesOf);
    const head = HANDOFF_HEADER + note;
    const imageNote = images.length > IMAGES_PER_MESSAGE ? utf8Bytes(`[图片：省略了 ${images.length - IMAGES_PER_MESSAGE} 张较早的图片]`) + 1 : 0;
    const { used: usedWithCarried } = newSegmentUsed({ ...d.p, preset: to }, memoryView, userMessage(head + carried, images, true, d.env.now), contextView);
    const budget = Math.min(BRIEF_MAX_BYTES, MESSAGE_MAX_BYTES - utf8Bytes(head + carried) - imageNote, Math.floor((threshold - usedWithCarried) / 2) * BYTES_PER_TOKEN) - BRIEF_FIXED_BYTES;
    const block = briefBlock(briefLines(d.seg, tail0, d.p.segment.seq), budget);
    const brief = block === "" ? "" : `\n\n${block}`;
    // 带过去的信，位置平移到新段第一条的文本里：每条消息的文本在 carriedText 里的起点。没有文本的消息不进 carriedText，它的信没有位置。
    let offset = (head + brief + `\n\n${CARRY_HEADER}\n\n`).length;
    const letters = users.flatMap((u, i) => {
      const text = textOf(tail[i]!);
      const metas = u.tau?.letters ?? [];
      if (text === "") return metas.map(unlocated);
      const moved = shifted(metas, offset);
      offset += text.length + 2;
      return moved;
    });
    d.p = { ...kept, preset: to, segment: { seq: d.p.segment.seq + 1, memoryView, ...(contextView === "" ? {} : { contextView }) } };
    d.seg = [];
    push(d, userMessage(head + brief + carried, images, true, d.env.now, { letters, handoff: true, ...(block === "" ? {} : { brief: [head.length + 2, head.length + 2 + block.length] as [number, number] }) }));
    // 交接已经做了：交接调用进行中到的信，标记用掉了，合并它们时不再换段。
    const { retry: _, ...clean } = turn;
    return continueTurn(d, { ...clean, queued: clean.queued.map(unmarked) });
  }
  // 没写出说明（调用了工具，或者没有文字）和流出错都重发，用途仍是 handoff（D92）；次数用完才报交接失败。其余（aborted、pending、deferred）直接失败。
  const r = m.stopReason;
  const fail = () => endTurn(d, turn, { error: "交接失败：" + (m.errorMessage ?? r) });
  if (r === "error") return retry(d, turn, "handoff", "error", fail);
  if (r === "toolUse" || r === "stop" || r === "length") return retry(d, turn, "handoff", "handoff", fail);
  return fail();
}

/** 第 5.2 节，`toolResult` 正常。 */
function onToolResult(d: Draft, turn: Turn, content: ToolResultContent): void {
  const call = pendingCalls(d.seg)[0];
  if (!call) throw new Error("awaitingTool 时没有待执行的工具调用");
  push(d, toolResult(call, content.content, content.isError, d.env.now));
  const rest = pendingCalls(d.seg);
  if (rest.length > 0 && !overThreshold(d)) return enter(d, { tag: "awaitingTool", turn });
  for (const c of rest) push(d, toolResult(c, textContent(SKIPPED), true, d.env.now, "skipped"));
  return atSafePoint(d, turn);
}

/**
 * 安全点（设计稿第 5.2 节）：这批工具结果都写完或补完，调用 `continueTurn` 之前。先查步数：步数用完时不合并，
 * 信留在 `queued`，由 `endTurn` 处理。否则排队的信合并成一条用户消息写进段，`replyTo` 和 `hops` 并进本轮。写入不计步。
 */
function atSafePoint(d: Draft, turn: Turn): void {
  if (turn.steps >= STEPS_PER_TURN || turn.queued.length === 0) return continueTurn(d, turn);
  const { text, images, metas } = render(turn.queued);
  push(d, userMessage(text, images, false, d.env.now, { letters: metas }));
  const handoff = wantsHandoff(d, turn.queued);
  const replyTo = [...new Set([...turn.replyTo, ...turn.queued.flatMap((l) => (l.replyTo === undefined ? [] : [l.replyTo]))])];
  const hops = turn.queued.reduce((m, l) => Math.max(m, l.hops), turn.hops);
  return continueTurn(d, { ...turn, queued: [], hops, replyTo }, handoff);
}

/** 换段信（D64 第 7 组）：刚写进段的这一批信里有带标记的，并且段里有助手消息。其余情形标记作废，不留到下一轮。 */
function wantsHandoff(d: Draft, letters: readonly Letter[]): boolean {
  return letters.some((l) => l.handoff === true) && d.seg.some((m) => m.role === "assistant");
}

function unmarked(l: Letter): Letter {
  const { handoff: _, ...rest } = l;
  return rest;
}

/** `handoff`：这一批信要求换段（`wantsHandoff`），下一次调用的用途是 handoff。 */
function continueTurn(d: Draft, turn: Turn, handoff = false): void {
  if (turn.steps >= STEPS_PER_TURN) return endTurn(d, turn, "stepLimit");
  const next = { ...turn, steps: turn.steps + 1 };
  return enter(d, { tag: "awaitingModel", turn: next, purpose: handoff || overThreshold(d) || handoffRequested(d.seg) ? "handoff" : "turn" });
}

function endTurn(d: Draft, turn: Turn, ended: Ended): void {
  // 正在等的就是第一个待执行的调用：它可能已经开始。
  const waiting = d.p.phase.tag === "awaitingTool";
  pendingCalls(d.seg).forEach((c, i) => {
    const interrupted = waiting && i === 0;
    push(d, toolResult(c, textContent(interrupted ? INTERRUPTED : SKIPPED), true, d.env.now, interrupted ? "interrupted" : "skipped"));
  });
  // 最终回复在合并排队的信之前算（设计稿 5.3 规则 3）。
  sendReplies(d, turn, ended, finalReply(d.seg));
  if (turn.queued.length > 0) {
    const { text, images, metas } = render(turn.queued);
    push(d, userMessage(text, images, false, d.env.now, { letters: metas }));
  }
  if (ended === "done" && turn.queued.length > 0) return continueTurn(d, newTurn(turn.queued), wantsHandoff(d, turn.queued));
  d.p = { ...d.p, phase: { tag: "idle", ended }, since: d.env.now };
}

/**
 * 回信（设计稿 5.3 规则 4）。收件人：`turn.replyTo` 里的每个进程，正文是最终回复；结束原因不是 done 时，
 * 再加排队的信里要回信、又不在 `turn.replyTo` 里的进程，正文为空。每个进程最多一封，没有 `replyTo`。
 * 头里的出错原因先经 `endedReason`：整页的报错不进收件人的信箱。
 */
function sendReplies(d: Draft, turn: Turn, ended: Ended, text: string): void {
  const extra = ended === "done" ? [] : turn.queued.flatMap((l) => (l.replyTo === undefined || turn.replyTo.includes(l.replyTo) ? [] : [l.replyTo]));
  const hops = turn.queued.reduce((m, l) => Math.max(m, l.hops), turn.hops) + 1;
  const reply = { ended: typeof ended === "object" ? { error: endedReason(ended.error) } : ended };
  const from = { kind: "process" as const, id: d.p.id, preset: d.p.preset.id, reply };
  for (const to of turn.replyTo) d.out.push({ to, letter: { from, content: text === "" ? [] : textContent(text), hops } });
  for (const to of new Set(extra)) d.out.push({ to, letter: { from, content: [], hops } });
}

/** 新一轮：`hops` 和 `replyTo` 只取自开这一轮的信（设计稿第 5.3 节规则 2、5）。 */
function newTurn(letters: readonly Letter[]): Turn {
  const replyTo = letters.flatMap((l) => (l.replyTo === undefined ? [] : [l.replyTo]));
  return { steps: 0, queued: [], hops: letters.reduce((m, l) => Math.max(m, l.hops), 0), replyTo: [...new Set(replyTo)] };
}

const textOf = (blocks: readonly Content[]): string => blocks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
const imagesOf = (blocks: readonly Content[]): ImageContent[] => blocks.flatMap((c) => (c.type === "image" ? [c] : []));

/** 信的头（设计稿第 5.1 节）。`mixed`：这一批里有进程的信，用户的信才加头。 */
function header(l: Letter, mixed: boolean): string {
  const f = l.from;
  if (f.kind === "user") return mixed ? "（来自用户）" : "";
  if (f.reply) return `（进程 ${f.id} 的回信，这一轮${endedText(f.reply.ended)}）`;
  const who = `来自进程 ${f.id}，预设 ${f.preset}`;
  return l.replyTo === undefined ? `（${who}）` : `（${who}。它在等回信：你这一轮结束时，最终回复会寄给它，之后的几轮不会。）`;
}

/** 一批信写进段的正文和图片：每封信是头、换行、正文，信之间空一行；图片按信的顺序。`metas` 记每封信正文在 `text` 里的位置。 */
function render(letters: readonly Letter[]): { text: string; images: ImageContent[]; metas: LetterMeta[] } {
  const mixed = letters.some((l) => l.from.kind === "process");
  let text = "";
  const metas = letters.map((l, i): LetterMeta => {
    const h = header(l, mixed);
    const body = textOf(l.content);
    if (i > 0) text += "\n\n";
    if (h !== "") text += `${h}\n`;
    const at: [number, number] = [text.length, text.length + body.length];
    text += body;
    return { from: l.from, hops: l.hops, ...(l.replyTo === undefined ? {} : { replyTo: l.replyTo }), ...(l.handoff === true ? { handoff: true } : {}), at };
  });
  return { text, images: letters.flatMap((l) => imagesOf(l.content)), metas };
}

const unlocated = (m: LetterMeta): LetterMeta => {
  const { at: _, ...rest } = m;
  return rest;
};
const shifted = (metas: readonly LetterMeta[], n: number): LetterMeta[] => metas.map((m) => (m.at === undefined ? m : { ...m, at: [m.at[0] + n, m.at[1] + n] }));

/**
 * 文本和图片成内容块：文本经 clip 成一个文本块（没有文本就不加），图片块原样接在后面。
 * `limit` 时最多留最后 IMAGES_PER_MESSAGE 张，多出的从最早的起省略，文本块末尾加一行说明；连这一行不超过 MESSAGE_MAX_BYTES。
 */
function fit(text: string | undefined, images: readonly ImageContent[], limit: boolean): Content[] {
  const omitted = limit ? Math.max(0, images.length - IMAGES_PER_MESSAGE) : 0;
  const kept = images.slice(omitted);
  if (omitted === 0) return text === undefined ? kept : [{ type: "text", text: clip(text) }, ...kept];
  const line = `[图片：省略了 ${omitted} 张较早的图片]`;
  const body = text === undefined || text === "" ? line : `${clip(text, MESSAGE_MAX_BYTES - utf8Bytes(line) - 1)}\n${line}`;
  return [{ type: "text", text: body }, ...kept];
}

/** 累计用量：不丢弃的模型结果都加（设计稿第 5.8 节）。 */
function addUsage(u: Usage, m: Usage): Usage {
  return { input: u.input + m.input, output: u.output + m.output, cacheRead: u.cacheRead + m.cacheRead, cacheWrite: u.cacheWrite + m.cacheWrite };
}

/** 进入一个等待阶段：发出下一个副作用编号。 */
function enter(d: Draft, phase: Exclude<Phase, { tag: "idle" }>): void {
  d.p = { ...d.p, phase, lastEffect: d.p.lastEffect + 1, since: d.env.now };
}

function overThreshold(d: Draft): boolean {
  return contextUsed(d.p, d.seg) >= handoffThreshold(d.p.preset);
}

function push(d: Draft, m: Message): void {
  d.seg.push(m);
  d.append.push(m);
}

const WAITED = "如果有进程在等你回信，它们已经收到上一轮的结束通知，之后的回复不会寄给它们。";

/**
 * 上一轮没有正常结束时，下一条用户消息前面的说明。段里不写失败的回复，也不写停止，模型否则看不出
 * 上一轮没做完，会把旧请求当成还要做的事。合并的排队消息不加：说明只加在之后的第一条消息上。
 */
function endedNote(ended: Ended | undefined): string {
  switch (ended) {
    case undefined:
    case "done":
      return "";
    case "stopped":
      return "（上一轮被停止。上面还没回复的消息都已取消：不要回应它们，只回应下面的信。）";
    case "stepLimit":
      return `（上一轮的步数用完了，停在中途。${WAITED}）`;
    default:
      return `（上一轮出错，没有做完：${endedReason(ended.error)}。${WAITED}）`;
  }
}

/**
 * decide 写入的每条用户消息都经过这里（工具结果经 `toolResult`）：空闲时的消息、合并的排队消息、新段的第一条。
 * 没有图片时正文是字符串；有图片时是文本块加图片块。`limit`：新段的第一条，图片张数受限。
 * `tau` 带上结构；文本被截过（消息文本不再以 `text` 开头）就去掉全部 `at`。
 */
function userMessage(text: string, images: readonly ImageContent[], limit: boolean, now: number, tau?: UserTau): Message {
  const content = images.length === 0 ? clip(text) : fit(text === "" ? undefined : text, images, limit);
  if (tau === undefined) return { role: "user", content, timestamp: now };
  const shown = typeof content === "string" ? content : content.find((c) => c.type === "text")?.text ?? "";
  return { role: "user", content, timestamp: now, tau: shown.startsWith(text) ? tau : { ...omitBrief(tau), letters: tau.letters.map(unlocated) } };
}

const omitBrief = ({ brief: _, ...rest }: UserTau): UserTau => rest;

/** 工具结果：文本和图片都经 `fit`，图片张数受限。 */
function toolResult(call: ToolCall, content: readonly Content[], isError: boolean, now: number, filled?: "interrupted" | "skipped"): Message {
  const images = imagesOf(content);
  const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  // 有图片时，空串和没有文本一样：不加文本块。没有图片时保持从前的做法。
  const only = images.length > 0 && text === "";
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: fit(only || (images.length === 0 && content.length === 0) ? undefined : text, images, true), isError, timestamp: now, ...(filled === undefined ? {} : { tau: { filled } }) };
}
