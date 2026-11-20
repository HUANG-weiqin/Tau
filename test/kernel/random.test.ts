// 随机序列：用带种子的随机数生成输入的交错顺序，每一步之后检查不变量。
// 环境是忠实的：副作用只来自 effectOf；结果可能延迟、重复、丢失，或因为重启变成“被中断”。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { decide, effectOf } from "../../src/kernel/decide.ts";
import { contextUsed, endedReason, estimatedUsed, finalReply, handoffRequested, handoffThreshold, MESSAGE_MAX_BYTES, tokens, utf8Bytes } from "../../src/kernel/derive.ts";
import { unreachable } from "../../src/kernel/types.ts";
import type { AssistantMessage, Effect, Ended, Env, ImageContent, Input, Letter, Message, PresetSnapshot, PresetTool, Process } from "../../src/kernel/types.ts";
import { res } from "../plain.ts";
import { assistant, call, current, feed, image, letterInput, preset, processLetter, textOf, usage, userLetterWith, world } from "./helpers.ts";
import type { ReplySpec, Step } from "./helpers.ts";

/** mulberry32：32 位状态的伪随机数生成器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  float(): number;
  /** [lo, hi] 里的整数。 */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  weighted<K extends string>(w: Record<K, number>): K;
}

function rng(seed: number): Rng {
  const next = mulberry32(seed);
  const r: Rng = {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    weighted: (w) => {
      const entries = Object.entries(w) as [keyof typeof w & string, number][];
      let x = next() * entries.reduce((s, [, n]) => s + n, 0);
      for (const [k, n] of entries) if ((x -= n) < 0) return k;
      return entries.at(-1)![0];
    },
  };
  return r;
}

/** 随机文本从这里切：英文、中文、换行、引号混在一起，没有代理对。 */
const POOL = (() => {
  const r = rng(7);
  const words = ["const", "return", "函数", "进程", "工作段", "\n", "\"q\"", "\t", "{", "}", "x = 1;", "测试", "path/to/file.ts", "'s'", "\\"];
  let s = "";
  while (s.length < MESSAGE_MAX_BYTES + 40_000) s += r.pick(words) + " ";
  return s;
})();

function text(r: Rng, chars: number): string {
  const at = r.int(0, POOL.length - chars - 1);
  return POOL.slice(at, at + chars);
}

type Action = "user" | "stop" | "complete" | "deliver" | "duplicate" | "drop" | "forge" | "crash" | "reconfigure";
type ReplyKind = "toolUse" | "noCalls" | "stop" | "stopWithCalls" | "length" | "error" | "aborted" | "pending" | "deferred";
type HandoffKind = "note" | "lengthNote" | "empty" | "toolUse" | "error" | "aborted";

interface Profile {
  name: string;
  seeds: number[];
  steps: number;
  windows: number[];
  actions: Record<Action, number>;
  replies: Record<ReplyKind, number>;
  handoffs: Record<HandoffKind, number>;
  toolInterrupted: number;
  hugeResult: number;
}

const PROFILES: Profile[] = [
  {
    name: "普通",
    seeds: [1, 2, 3, 4, 5, 6, 7, 8],
    steps: 2_500,
    windows: [28_000, 36_000, 80_000, 200_000],
    actions: { user: 10, stop: 3, complete: 45, deliver: 25, duplicate: 5, drop: 2, forge: 5, crash: 2, reconfigure: 4 },
    replies: { toolUse: 45, noCalls: 4, stop: 25, stopWithCalls: 3, length: 5, error: 5, aborted: 5, pending: 4, deferred: 4 },
    handoffs: { note: 70, lengthNote: 10, empty: 5, toolUse: 5, error: 5, aborted: 5 },
    toolInterrupted: 0.03,
    hugeResult: 0.08,
  },
  {
    // 模型几乎总是要求调用工具，没人按停止，窗口小：连续换段、换段失败。
    name: "失控",
    seeds: [101, 102, 103],
    steps: 4_000,
    windows: [28_500, 48_000],
    actions: { user: 2, stop: 0, complete: 60, deliver: 35, duplicate: 1, drop: 0, forge: 1, crash: 0, reconfigure: 2 },
    replies: { toolUse: 99, noCalls: 0, stop: 1, stopWithCalls: 0, length: 0, error: 0, aborted: 0, pending: 0, deferred: 0 },
    handoffs: { note: 97, lengthNote: 0, empty: 3, toolUse: 0, error: 0, aborted: 0 },
    toolInterrupted: 0,
    hugeResult: 0.05,
  },
  {
    // 模型从不自己停，窗口大到换段不会失败：一轮只能以步数用完结束（STEPS_PER_TURN 是 1024，见 D68）。
    name: "长轮",
    seeds: [301],
    steps: 30_000,
    windows: [400_000],
    actions: { user: 2, stop: 0, complete: 60, deliver: 35, duplicate: 1, drop: 0, forge: 1, crash: 0, reconfigure: 1 },
    replies: { toolUse: 100, noCalls: 0, stop: 0, stopWithCalls: 0, length: 0, error: 0, aborted: 0, pending: 0, deferred: 0 },
    handoffs: { note: 100, lengthNote: 0, empty: 0, toolUse: 0, error: 0, aborted: 0 },
    toolInterrupted: 0,
    hugeResult: 0.05,
  },
  {
    // 结果频繁延迟、重复、丢失、伪造，服务频繁重启。
    name: "不稳定",
    seeds: [201, 202, 203],
    steps: 2_500,
    windows: [32_000, 100_000],
    actions: { user: 15, stop: 8, complete: 30, deliver: 20, duplicate: 12, drop: 5, forge: 12, crash: 8, reconfigure: 8 },
    replies: { toolUse: 45, noCalls: 4, stop: 25, stopWithCalls: 3, length: 5, error: 5, aborted: 5, pending: 4, deferred: 4 },
    handoffs: { note: 40, lengthNote: 10, empty: 15, toolUse: 15, error: 10, aborted: 10 },
    toolInterrupted: 0.1,
    hugeResult: 0.08,
  },
];

const TOOL_NAMES = ["read", "write", "edit", "bash", "memory_get", "memory_set", "memory_edit", "memory_delete", "self", "handoff", "handoff", "grep"];

interface Stats {
  handoffOk: number;
  handoffFailed: number;
  done: number;
  stopped: number;
  stepLimit: number;
  errors: number;
  skipped: number;
  interrupted: number;
  queuedMerged: number;
  dropped: number;
  duplicates: number;
  usageAdded: number;
  processLetters: number;
  images: number;
  safePoints: number;
  handoffByCall: number;
  handoffByLetter: number;
  replies: number;
  emptyReplies: number;
  /** 重发（D92）：可恢复的模型失败后，同一个请求再发一次。 */
  retried: number;
  /** reconfigure 的几种结果：只改了调用参数或结构相同（含取消待换）、直接采用、条件都满足但段放不进新快照所以存 next、其余存 next，以及换段时采用或丢弃 next。 */
  reconfigured: number;
  cancelled: number;
  adopted: number;
  tooBig: number;
  pending: number;
  nextAdopted: number;
  nextDiscarded: number;
}

function newStats(): Stats {
  return { handoffOk: 0, handoffFailed: 0, done: 0, stopped: 0, stepLimit: 0, errors: 0, skipped: 0, interrupted: 0, queuedMerged: 0, dropped: 0, duplicates: 0, usageAdded: 0, processLetters: 0, images: 0, safePoints: 0, handoffByCall: 0, handoffByLetter: 0, replies: 0, emptyReplies: 0, retried: 0, reconfigured: 0, cancelled: 0, adopted: 0, tooBig: 0, pending: 0, nextAdopted: 0, nextDiscarded: 0 };
}

/**
 * 回信（设计稿 5.3 规则 3、4）：一轮结束时，收件人正好是 turn.replyTo，加上（不是 done 时）排队的信里不在其中的 replyTo；
 * 每个进程一封；正文是合并之前的最终回复，多出来的收件人正文为空；跳数是 max(turn.hops, 排队的信的 hops) + 1；不带 replyTo。其余时候没有回信。
 */
function checkReplies(prev: Process, seg: readonly Message[], input: Input, next: Process, s: Step, stats: Stats): void {
  const before = prev.phase;
  // 一轮在这条输入里结束：回到 idle，或者 done 时有排队的信，接着开了新的一轮（新一轮的步数从 1 起，且进入了新的等待阶段；被丢弃的输入不动 lastEffect）。
  let ended: Ended | undefined;
  if (before.tag !== "idle") {
    if (next.phase.tag === "idle") ended = next.phase.ended;
    else if (before.tag === "awaitingModel" && input.kind === "modelResult" && next.phase.tag === "awaitingModel" && next.lastEffect === prev.lastEffect + 1 && next.phase.turn.steps === 1) ended = "done";
  }
  if (ended === undefined || before.tag === "idle") {
    assert.deepEqual(s.out, [], "一轮没有结束，不该有回信");
    return;
  }
  const { turn } = before;
  const extra = ended === "done" ? [] : turn.queued.flatMap((l) => (l.replyTo === undefined || turn.replyTo.includes(l.replyTo) ? [] : [l.replyTo]));
  const to = [...turn.replyTo, ...new Set(extra)];
  assert.deepEqual(s.out.map((o) => o.to), to);
  assert.equal(new Set(s.out.map((o) => o.to)).size, s.out.length, "每个进程最多一封");
  // 合并之前的段：最后追加的那条是合并的信（有排队的信时）。换段时旧段不再算：新段里还没有助手消息。
  const base = next.segment.seq === prev.segment.seq ? seg : [];
  const appended = turn.queued.length > 0 ? s.append.slice(0, -1) : s.append;
  const text = finalReply([...base, ...appended]);
  const hops = Math.max(turn.hops, ...turn.queued.map((l) => l.hops)) + 1;
  const reported = typeof ended === "object" ? { error: endedReason(ended.error) } : ended;
  for (const o of s.out) {
    assert.deepEqual(o.letter.from, { kind: "process", id: prev.id, preset: prev.preset.id, reply: { ended: reported } });
    assert.equal(o.letter.hops, hops);
    assert.ok(!("replyTo" in o.letter), "回信不带 replyTo");
    const body = o.letter.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const expected = turn.replyTo.includes(o.to) ? text : "";
    assert.equal(body, expected);
    assert.equal(o.letter.content.length, expected === "" ? 0 : 1);
    stats.replies++;
    if (expected === "") stats.emptyReplies++;
  }
}

/** 结构性字段（D71）的一份摘要：位置固定，所以键的顺序不影响比较。 */
const structure = (p: PresetSnapshot): string => JSON.stringify([p.id, p.workdir, p.model, p.tools, p.toolDefs, p.prompt, p.contextWindow, p.input, p.context ?? null]);
const hasAssistant = (seg: readonly Message[]): boolean => seg.some((m) => m.role === "assistant");
const hasImageBlock = (seg: readonly Message[]): boolean => seg.some((m) => m.role !== "assistant" && typeof m.content !== "string" && m.content.some((c) => c.type === "image"));
/** 开段视图：`fresh` 的两个视图，上下文视图为空串时没有这个键。 */
const viewsOf = (seq: number, fresh: NonNullable<Env["fresh"]>, memoryView = fresh.memoryView) => ({ seq, memoryView, ...(fresh.contextView === undefined || fresh.contextView === "" ? {} : { contextView: fresh.contextView }) });

/**
 * 会话配置（D71，设计稿对应 kb-kernel 的“流程：会话配置”）：不写消息、不发回信、不改阶段和副作用；调用参数立即换；
 * 结构性字段相等就取消 next；否则空闲、没有助手消息、新模型收图或段里没有图、段放得下新快照（估算用量低于新阈值）时直接采用；其余存 next。
 */
function checkReconfigure(prev: Process, seg: readonly Message[], s: PresetSnapshot, e: Env, next: Process, step: Step, stats: Stats): void {
  assert.deepEqual(step.append, []);
  assert.deepEqual(step.out, []);
  assert.deepEqual(next.phase, prev.phase);
  assert.equal(next.lastEffect, prev.lastEffect);
  assert.equal(next.since, prev.since);
  assert.deepEqual(next.usage, prev.usage);
  assert.deepEqual(step.after, step.before);
  assert.deepEqual([next.preset.thinking, next.preset.handoff, next.preset.options], [s.thinking, s.handoff, s.options], "调用参数立即生效");
  const fresh = e.fresh;
  assert.ok(fresh, "reconfigure 要带 fresh");
  stats.reconfigured++;
  if (structure(s) === structure(prev.preset)) {
    assert.ok(!("next" in next), "结构一样：取消待换配置");
    assert.equal(structure(next.preset), structure(prev.preset));
    assert.deepEqual(next.segment, prev.segment);
    stats.cancelled++;
  } else if (prev.phase.tag === "idle" && !hasAssistant(seg) && (s.input.includes("image") || !hasImageBlock(seg)) && fits(prev, seg, s, viewsOf(prev.segment.seq, fresh))) {
    assert.deepEqual(next.preset, s);
    assert.ok(!("next" in next));
    assert.deepEqual(next.segment, viewsOf(prev.segment.seq, fresh));
    stats.adopted++;
  } else {
    assert.deepEqual(next.next, s);
    assert.equal(structure(next.preset), structure(prev.preset), "结构性字段换段时才生效");
    assert.deepEqual(next.segment, prev.segment);
    stats.pending++;
    if (prev.phase.tag === "idle" && !hasAssistant(seg) && (s.input.includes("image") || !hasImageBlock(seg))) stats.tooBig++;
  }
}

/** 段放得下新快照：不用锚点的估算用量低于新快照的阈值（`>=` 算放不下），和 fork 带 preset 一致。 */
const fits = (prev: Process, seg: readonly Message[], s: PresetSnapshot, segment: Process["segment"]): boolean => estimatedUsed({ ...prev, preset: s, segment }, seg) < handoffThreshold(s);

/** 接受交接（或交接失败）时对 next 的处理，和别的输入都不动快照和 next。 */
function checkNext(prev: Process, input: Input, e: Env, next: Process, stats: Stats): void {
  const handoff = prev.phase.tag === "awaitingModel" && prev.phase.purpose === "handoff" && input.kind === "modelResult";
  if (input.kind === "reconfigure") return;
  if (!handoff || next.segment.seq === prev.segment.seq) {
    const discarded = handoff && next.phase.tag === "idle" && typeof next.phase.ended === "object" && next.phase.ended.error.endsWith("；待换的配置已丢弃");
    if (discarded) {
      assert.ok(prev.next, "没有待换配置，不该写丢弃");
      assert.deepEqual(next.preset, prev.preset, "丢弃以后用旧快照");
      assert.ok(!("next" in next));
      stats.nextDiscarded++;
    } else {
      assert.deepEqual(next.preset, prev.preset);
      assert.deepEqual(next.next, prev.next);
    }
    return;
  }
  assert.equal(next.segment.seq, prev.segment.seq + 1);
  assert.ok(e.fresh, "接受交接要带 fresh");
  if (prev.next === undefined) {
    assert.deepEqual(next.preset, prev.preset);
    assert.deepEqual(next.segment, viewsOf(next.segment.seq, e.fresh, e.memoryView), "没有待换配置：记忆视图用 env 的，上下文视图每次换段重取");
  } else {
    assert.deepEqual(next.preset, prev.next, "换段采用待换配置");
    assert.ok(!("next" in next));
    assert.deepEqual(next.segment, viewsOf(next.segment.seq, e.fresh));
    stats.nextAdopted++;
  }
}

/** 一次模拟：一个进程、一个忠实的环境。 */
function simulate(profile: Profile, seed: number, stats: Stats): void {
  const r = rng(seed);
  const window = r.pick(profile.windows);
  const tools = (["read", "write", "edit", "bash", "memory"] as PresetTool[]).filter(() => r.chance(0.7));
  let now = 1_000_000;
  let memoryView = "";
  let contextView = "";
  const w = world(preset({ id: "rand", contextWindow: window, tools }), { now, memoryView });
  /** 执行器做完、还没进信箱的结果。 */
  let outbox: { n: number; input: Input }[] = [];
  /** 已经产生过结果的副作用编号：每个副作用只执行一次。 */
  const produced = new Set<number>();
  /** 已经送进 decide 的结果，用来重放。 */
  const history: Input[] = [];
  let ids = 0;

  const usageFor = (purpose: "turn" | "handoff" | null): AssistantMessage["usage"] => {
    const base = contextUsed(w.p, current(w)) + (purpose === "handoff" ? tokens(utf8Bytes(HANDOFF_INSTRUCTION)) : 0);
    const out = r.int(10, 800);
    const roll = r.float();
    if (roll < 0.1) {
      const cached = r.int(0, base);
      return usage(0, { input: base - cached, output: out, cacheRead: cached });
    }
    if (roll < 0.14) return usage(0);
    if (roll < 0.18) return usage(Math.floor(window * (0.7 + 0.5 * r.float())));
    return usage(base + out, { input: base, output: out });
  };

  /** 一封随机的信：用户的信、进程的信、要回信的信、回信；四分之一带 1 到 2 张图片，可能只有图片。 */
  const randomLetter = (): Letter => {
    const images: ImageContent[] = r.chance(0.25) ? Array.from({ length: r.int(1, 2) }, () => image(`d${r.int(0, 99)}`)) : [];
    const body = images.length > 0 && r.chance(0.3) ? "" : text(r, r.chance(0.05) ? r.int(2_000, 20_000) : r.int(1, 200));
    const id = `q${r.int(1, 3)}`;
    switch (r.weighted({ user: 55, process: 15, wait: 15, reply: 15 })) {
      case "user": {
        // D64 第 7 组：一部分用户的信带换段标记。
        const l = userLetterWith(body, images);
        return r.chance(0.15) ? { ...l, handoff: true } : l;
      }
      case "process":
        return processLetter(body, { id, hops: r.int(1, 5), images });
      case "wait":
        return processLetter(body, { id, replyTo: id, hops: r.int(1, 5), images });
      default: {
        const ended: Ended = r.pick<Ended>(["done", "stepLimit", "stopped", { error: text(r, r.int(1, 3_000)) }]);
        return processLetter(body, { id, reply: ended, hops: r.int(1, 5), images });
      }
    }
  };

  const calls = (k: number) => Array.from({ length: k }, () => call(`c${ids++}`, r.pick(TOOL_NAMES), { path: `f${ids}.ts` }));

  const modelReply = (purpose: "turn" | "handoff"): AssistantMessage => {
    const u = usageFor(purpose);
    const errorMessage = r.chance(0.5) ? { errorMessage: `错误 ${r.int(400, 599)}` } : {};
    let s: ReplySpec;
    if (purpose === "handoff") {
      const kind = r.weighted(profile.handoffs);
      switch (kind) {
        case "note":
          s = { usage: u, stopReason: "stop", text: text(r, r.int(1, 3_000)) };
          break;
        case "lengthNote":
          s = { usage: u, stopReason: "length", text: text(r, r.int(1, 3_000)) };
          break;
        case "empty":
          s = { usage: u, stopReason: r.pick(["stop", "length"] as const), ...(r.chance(0.5) ? { text: "  \n" } : { thinking: "想" }) };
          break;
        case "toolUse":
          s = { usage: u, stopReason: "toolUse", text: "先查一下", calls: calls(1) };
          break;
        case "error":
        case "aborted":
          s = { usage: u, stopReason: kind, ...errorMessage };
          break;
        default:
          return unreachable(kind);
      }
    } else {
      const kind = r.weighted(profile.replies);
      const body = r.chance(0.7) ? { text: text(r, r.int(0, 400)) } : {};
      switch (kind) {
        case "toolUse":
          s = { usage: u, stopReason: "toolUse", ...body, calls: calls(r.int(1, 5)) };
          break;
        case "noCalls":
          s = { usage: u, stopReason: "toolUse", ...body };
          break;
        case "stop":
          s = { usage: u, stopReason: "stop", ...body };
          break;
        case "stopWithCalls":
          s = { usage: u, stopReason: "stop", ...body, calls: calls(r.int(1, 3)) };
          break;
        case "length":
          s = { usage: u, stopReason: "length", ...body, ...(r.chance(0.5) ? { calls: calls(1) } : {}) };
          break;
        case "error":
        case "aborted":
        case "pending":
        case "deferred":
          s = { usage: u, stopReason: kind, ...body, ...errorMessage };
          break;
        default:
          return unreachable(kind);
      }
    }
    return assistant({ ...s, timestamp: now });
  };

  const resultFor = (e: Effect): Input => {
    switch (e.kind) {
      case "callModel":
        return { kind: "modelResult", n: e.n, outcome: { status: "ok", message: modelReply(e.purpose) } };
      case "runTool": {
        if (r.chance(profile.toolInterrupted)) return { kind: "toolResult", n: e.n, outcome: { status: "interrupted" } };
        const size = r.chance(profile.hugeResult) ? MESSAGE_MAX_BYTES + r.int(1, 30_000) : r.chance(0.3) ? r.int(1_000, 8_000) : r.int(0, 300);
        const out = res(text(r, size), r.chance(0.1));
        const images = r.chance(0.15) ? Array.from({ length: r.int(1, 5) }, () => image(`t${r.int(0, 99)}`)) : [];
        return { kind: "toolResult", n: e.n, outcome: { status: "ok", content: { ...out, content: [...out.content, ...images] } } };
      }
      default:
        return unreachable(e);
    }
  };

  /** 服务造的新快照（kb-service 的“会话配置”）：以 next 或当前快照为底，随机改一些键，偶尔是 revert（当前快照）。启动检查不查：小窗口也要走交接后的检查。 */
  const randomSnapshot = (): PresetSnapshot => {
    if (r.chance(0.1)) return w.p.preset;
    const s: PresetSnapshot = { ...(w.p.next ?? w.p.preset) };
    if (r.chance(0.4)) {
      if (r.chance(0.3)) delete s.thinking;
      else s.thinking = r.pick(["low", "high"] as const);
    }
    if (r.chance(0.4)) {
      if (r.chance(0.3)) delete s.handoff;
      else s.handoff = r.int(2_000, 60_000);
    }
    if (r.chance(0.2)) {
      if (r.chance(0.5)) delete s.options;
      else s.options = { temperature: r.int(0, 10) / 10 };
    }
    if (r.chance(0.3)) s.prompt = text(r, r.int(0, 600));
    if (r.chance(0.25)) s.tools = (["read", "write", "edit", "bash", "memory"] as PresetTool[]).filter(() => r.chance(0.6));
    if (r.chance(0.25)) {
      s.model = `faux/m${r.int(1, 3)}`;
      s.contextWindow = r.pick(profile.windows);
      s.input = r.chance(0.5) ? ["text"] : ["text", "image"];
    }
    if (r.chance(0.15)) s.workdir = `E:/work${r.int(1, 3)}`;
    if (r.chance(0.2)) {
      if (r.chance(0.5)) delete s.context;
      else s.context = ["AGENTS.md"];
    }
    return s;
  };

  const isResult = (i: Input): i is Extract<Input, { n: number }> => i.kind === "modelResult" || i.kind === "toolResult";

  /** `origin`：执行器正常送回、重放一条已送过的、或者伪造一个编号不对的结果。 */
  const run = (input: Input, origin: "normal" | "duplicate" | "forged" = "normal"): void => {
    now += r.int(1, 60_000);
    if (r.chance(0.05)) memoryView = r.chance(0.3) ? "" : `k${r.int(0, 9)}: ${text(r, r.int(1, 200))}`;
    if (r.chance(0.05)) contextView = r.chance(0.3) ? "" : `### AGENTS.md
${text(r, r.int(1, 300))}`;
    const prev: Process = w.p;
    const seg: readonly Message[] = current(w);
    // 存储层只在两种输入上算 fresh（instore.ts 的 freshFor）：reconfigure，和接受交接的那条模型结果。
    const target = input.kind === "reconfigure" ? input.preset : input.kind === "modelResult" && prev.phase.tag === "awaitingModel" && prev.phase.purpose === "handoff" && input.n === prev.lastEffect && input.outcome.status === "ok" ? (prev.next ?? prev.preset) : undefined;
    const e: Env = { now, memoryView, ...(target === undefined ? {} : { fresh: { memoryView: target.tools.includes("memory") ? memoryView : "", contextView: target.context === undefined ? "" : contextView } }) };
    const s = feed(w, input, e); // 包括 assertInvariants

    // decide 是纯函数：同样的输入给同样的结果。
    assert.deepEqual(decide(prev, seg, input, e), { process: w.p, append: s.append, out: s.out });

    // 每次 decide 最多进入一个等待阶段，lastEffect 最多加一。
    const delta = w.p.lastEffect - prev.lastEffect;
    assert.ok(delta === 0 || delta === 1, `lastEffect 变了 ${delta}`);
    if (delta === 0) {
      // 编号没变时，副作用要么不变，要么因为回到 idle 而没有了；绝不会换成别的内容。
      if (s.after !== null) assert.deepEqual(s.after, s.before);
      else assert.equal(w.p.phase.tag, "idle");
    } else {
      assert.equal(s.after?.n, w.p.lastEffect);
    }

    checkReplies(prev, seg, input, w.p, s, stats);
    if (input.kind === "reconfigure") checkReconfigure(prev, seg, input.preset, e, w.p, s, stats);
    checkNext(prev, input, e, w.p, stats);

    // 累计用量：只有不丢弃的、正常的模型结果才加。
    const counted = input.kind === "modelResult" && input.outcome.status === "ok" && prev.phase.tag === "awaitingModel" && input.n === prev.lastEffect;
    if (counted && input.outcome.status === "ok") {
      const m = input.outcome.message.usage;
      const u = prev.usage;
      assert.deepEqual(w.p.usage, { input: u.input + m.input, output: u.output + m.output, cacheRead: u.cacheRead + m.cacheRead, cacheWrite: u.cacheWrite + m.cacheWrite });
      stats.usageAdded++;
    } else {
      assert.deepEqual(w.p.usage, prev.usage);
    }

    const dropped = (isResult(input) && (prev.phase.tag === "idle" || input.n !== prev.lastEffect)) || (input.kind === "stop" && prev.phase.tag === "idle");
    const duplicate = origin === "duplicate";
    if (dropped || duplicate) {
      assert.deepEqual(w.p, prev);
      assert.deepEqual(s.append, []);
      stats.dropped++;
      if (duplicate) stats.duplicates++;
    }
    if (input.kind === "letter" && prev.phase.tag !== "idle") {
      assert.deepEqual(s.append, []);
      assert.equal(w.p.phase.tag !== "idle" && w.p.phase.turn.queued.at(-1), input.letter);
    }
    // 只重放执行器真正送回过的结果；伪造的编号可能在将来变成当前编号。
    if (isResult(input) && origin === "normal") history.push(input);
    if (history.length > 50) history.shift();

    // 安全点（设计稿 5.2）：工具结果写入后批做完，排队的信并成一条用户消息，replyTo 和 hops 并进本轮，不计步。
    if (input.kind === "toolResult" && prev.phase.tag === "awaitingTool" && prev.phase.turn.queued.length > 0 && w.p.phase.tag === "awaitingModel" && w.p.phase.turn.queued.length === 0) {
      const { queued, steps, hops, replyTo } = prev.phase.turn;
      const turn = w.p.phase.turn;
      assert.equal(turn.steps, steps + 1, "安全点写入不计步，下一次调用模型才计");
      assert.equal(turn.hops, Math.max(hops, ...queued.map((l) => l.hops)));
      assert.deepEqual(turn.replyTo, [...new Set([...replyTo, ...queued.flatMap((l) => (l.replyTo === undefined ? [] : [l.replyTo]))])]);
      stats.safePoints++;
    }
    if (input.kind === "toolResult" && prev.phase.tag === "awaitingTool" && w.p.phase.tag === "awaitingModel" && w.p.phase.purpose === "handoff" && contextUsed(w.p, current(w)) < handoffThreshold(w.p.preset) && !prev.phase.turn.queued.some((l) => l.handoff === true)) stats.handoffByCall++;
    // 没有任何触发条件、用途却是 handoff：只能是换段信。
    if (w.p.phase.tag === "awaitingModel" && w.p.phase.purpose === "handoff" && contextUsed(w.p, current(w)) < handoffThreshold(w.p.preset) && !handoffRequested(current(w))) stats.handoffByLetter++;

    // D92：重发不写段、不寄信、不动信箱里的信，阶段和用途不变，只计一步。
    if (input.kind === "modelResult" && prev.phase.tag === "awaitingModel" && w.p.phase.tag === "awaitingModel" && w.p.phase.turn.retry !== undefined && prev.lastEffect === input.n) {
      assert.deepEqual(s.append, []);
      assert.deepEqual(s.out, []);
      assert.equal(w.p.phase.purpose, prev.phase.purpose);
      assert.equal(w.p.phase.turn.steps, prev.phase.turn.steps + 1);
      assert.deepEqual(w.p.phase.turn.queued, prev.phase.turn.queued);
      assert.equal(w.p.segment.seq, prev.segment.seq);
      stats.retried++;
    }

    // 统计覆盖面。
    if (input.kind === "letter" && input.letter.from.kind === "process") stats.processLetters++;
    if (s.append.some((m) => typeof m.content !== "string" && m.content.some((c) => c.type === "image"))) stats.images++;
    if (w.p.segment.seq !== prev.segment.seq) stats.handoffOk++;
    for (const m of s.append) {
      if (m.role === "toolResult" && textOf(m) === "未执行") stats.skipped++;
      if (m.role === "toolResult" && textOf(m) === "被中断，结果未知") stats.interrupted++;
    }
    if (prev.phase.tag !== "idle" && prev.phase.turn.queued.length > 0 && (w.p.phase.tag === "idle" || w.p.phase.turn.queued.length === 0)) stats.queuedMerged++;
    if (prev.phase.tag !== "idle" && w.p.phase.tag === "idle") {
      const ended = w.p.phase.ended;
      if (ended === "done") stats.done++;
      else if (ended === "stopped") stats.stopped++;
      else if (ended === "stepLimit") stats.stepLimit++;
      else if (ended !== undefined) {
        stats.errors++;
        if (ended.error.startsWith("交接失败")) stats.handoffFailed++;
      }
    }
  };

  const act = (a: Action): boolean => {
    const eff = effectOf(w.p, current(w));
    switch (a) {
      case "user":
        run(letterInput(randomLetter()));
        return true;
      case "stop":
        run({ kind: "stop" });
        return true;
      case "complete": {
        if (eff === null || produced.has(eff.n)) return false;
        produced.add(eff.n);
        const res = resultFor(eff);
        if (r.chance(0.6)) run(res);
        else outbox.push({ n: eff.n, input: res });
        return true;
      }
      case "deliver": {
        if (outbox.length === 0) return false;
        const [item] = outbox.splice(r.int(0, outbox.length - 1), 1);
        run(item!.input);
        return true;
      }
      case "duplicate":
        if (history.length === 0) return false;
        run(r.pick(history), "duplicate");
        return true;
      case "drop":
        if (outbox.length === 0) return false;
        outbox.splice(r.int(0, outbox.length - 1), 1);
        return true;
      case "forge": {
        const n = r.chance(0.5) || w.p.lastEffect === 0 ? w.p.lastEffect + r.int(1, 3) : r.int(0, w.p.lastEffect - 1);
        const message = assistant({ usage: 10, text: "伪造的" });
        run(r.chance(0.5) ? { kind: "modelResult", n, outcome: { status: "ok", message } } : { kind: "toolResult", n, outcome: { status: "ok", content: res("伪造的") } }, "forged");
        return true;
      }
      case "reconfigure":
        run({ kind: "reconfigure", preset: randomSnapshot() });
        return true;
      case "crash": {
        // 重启：执行器里正在跑的结果丢失，副作用作为“被中断”送回。
        if (eff === null) return false;
        outbox = outbox.filter((o) => o.n !== eff.n);
        produced.add(eff.n);
        run(eff.kind === "callModel" ? { kind: "modelResult", n: eff.n, outcome: { status: "interrupted" } } : { kind: "toolResult", n: eff.n, outcome: { status: "interrupted" } });
        return true;
      }
      default:
        return unreachable(a);
    }
  };

  for (let i = 0; i < profile.steps; i++) {
    const a = r.weighted(profile.actions);
    try {
      if (!act(a) && !act("complete")) act("user");
    } catch (err) {
      throw new Error(`${profile.name}，种子 ${seed}，窗口 ${window}，第 ${i} 步（${a}）：${(err as Error).message}`, { cause: err });
    }
  }
}

for (const profile of PROFILES) {
  test(`随机序列（${profile.name}）：${profile.seeds.length} 个种子 × ${profile.steps} 步，每一步不变量都成立`, (t) => {
    const stats = newStats();
    for (const seed of profile.seeds) simulate(profile, seed, stats);
    t.diagnostic(JSON.stringify(stats));
    // 确认生成器真的走到了这些流程。
    assert.ok(stats.handoffOk > 0, "没有成功换段");
    assert.ok(stats.dropped > 0, "没有丢弃过输入");
    assert.ok(stats.reconfigured > 0, "没有 reconfigure");
    if (profile.name === "失控") {
      assert.ok(stats.handoffFailed > 0, "没有换段失败");
    } else if (profile.name === "长轮") {
      assert.ok(stats.stepLimit > 0, "没有用完步数");
    } else {
      for (const k of ["handoffFailed", "done", "stopped", "errors", "skipped", "interrupted", "queuedMerged", "duplicates", "usageAdded", "processLetters", "images", "safePoints", "handoffByCall", "handoffByLetter", "replies", "emptyReplies", "retried", "cancelled", "adopted", "tooBig", "pending", "nextAdopted", "nextDiscarded"] as const) {
        assert.ok(stats[k] > 0, `没有覆盖到 ${k}`);
      }
    }
  });
}

test("随机数生成器：同一个种子给同样的序列", () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.float(), b.float());
  assert.notEqual(rng(1).float(), rng(2).float());
  // 每个随机的窗口阈值都是正数：小窗口测的是频繁换段，不是每次调用都换段。
  for (const w of PROFILES.flatMap((p) => p.windows)) assert.ok(handoffThreshold(preset({ contextWindow: w })) > 0, `窗口 ${w}`);
});
