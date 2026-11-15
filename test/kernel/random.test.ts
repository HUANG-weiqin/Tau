// 随机序列：用带种子的随机数生成输入的交错顺序，每一步之后检查不变量。
// 环境是忠实的：副作用只来自 effectOf；结果可能延迟、重复、丢失，或因为重启变成“被中断”。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { decide, effectOf } from "../../src/kernel/decide.ts";
import { BYTES_PER_TOKEN, contextUsed, HANDOFF_RATIO, TOOL_RESULT_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { unreachable } from "../../src/kernel/types.ts";
import type { AssistantMessage, Effect, Env, Input, Message, PresetTool, Process } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, preset, textOf, usage, world } from "./helpers.ts";
import type { ReplySpec } from "./helpers.ts";

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
  while (s.length < TOOL_RESULT_MAX_BYTES + 40_000) s += r.pick(words) + " ";
  return s;
})();

function text(r: Rng, chars: number): string {
  const at = r.int(0, POOL.length - chars - 1);
  return POOL.slice(at, at + chars);
}

type Action = "user" | "stop" | "complete" | "deliver" | "duplicate" | "drop" | "forge" | "crash";
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
    windows: [2_000, 8_000, 50_000, 200_000],
    actions: { user: 10, stop: 3, complete: 45, deliver: 25, duplicate: 5, drop: 2, forge: 5, crash: 2 },
    replies: { toolUse: 45, noCalls: 4, stop: 25, stopWithCalls: 3, length: 5, error: 5, aborted: 5, pending: 4, deferred: 4 },
    handoffs: { note: 70, lengthNote: 10, empty: 5, toolUse: 5, error: 5, aborted: 5 },
    toolInterrupted: 0.03,
    hugeResult: 0.08,
  },
  {
    // 模型几乎总是要求调用工具，没人按停止：步数上限和连续换段。
    name: "失控",
    seeds: [101, 102, 103],
    steps: 4_000,
    windows: [3_000, 20_000],
    actions: { user: 2, stop: 0, complete: 60, deliver: 35, duplicate: 1, drop: 0, forge: 1, crash: 0 },
    replies: { toolUse: 99, noCalls: 0, stop: 1, stopWithCalls: 0, length: 0, error: 0, aborted: 0, pending: 0, deferred: 0 },
    handoffs: { note: 97, lengthNote: 0, empty: 3, toolUse: 0, error: 0, aborted: 0 },
    toolInterrupted: 0,
    hugeResult: 0.05,
  },
  {
    // 结果频繁延迟、重复、丢失、伪造，服务频繁重启。
    name: "不稳定",
    seeds: [201, 202, 203],
    steps: 2_500,
    windows: [5_000, 100_000],
    actions: { user: 15, stop: 8, complete: 30, deliver: 20, duplicate: 12, drop: 5, forge: 12, crash: 8 },
    replies: { toolUse: 45, noCalls: 4, stop: 25, stopWithCalls: 3, length: 5, error: 5, aborted: 5, pending: 4, deferred: 4 },
    handoffs: { note: 40, lengthNote: 10, empty: 15, toolUse: 15, error: 10, aborted: 10 },
    toolInterrupted: 0.1,
    hugeResult: 0.08,
  },
];

const TOOL_NAMES = ["read", "write", "edit", "bash", "memory_get", "memory_set", "memory_delete", "self", "grep"];

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
}

function newStats(): Stats {
  return { handoffOk: 0, handoffFailed: 0, done: 0, stopped: 0, stepLimit: 0, errors: 0, skipped: 0, interrupted: 0, queuedMerged: 0, dropped: 0, duplicates: 0 };
}

/** 一次模拟：一个进程、一个忠实的环境。 */
function simulate(profile: Profile, seed: number, stats: Stats): void {
  const r = rng(seed);
  const window = r.pick(profile.windows);
  const tools = (["read", "write", "edit", "bash", "memory"] as PresetTool[]).filter(() => r.chance(0.7));
  let now = 1_000_000;
  let memoryView = "";
  const w = world(preset({ id: "rand", contextWindow: window, tools }), { now, memoryView });
  /** 执行器做完、还没进信箱的结果。 */
  let outbox: { n: number; input: Input }[] = [];
  /** 已经产生过结果的副作用编号：每个副作用只执行一次。 */
  const produced = new Set<number>();
  /** 已经送进 decide 的结果，用来重放。 */
  const history: Input[] = [];
  let ids = 0;

  const usageFor = (purpose: "turn" | "handoff" | null): AssistantMessage["usage"] => {
    const base = contextUsed(w.p, current(w)) + (purpose === "handoff" ? Math.ceil(utf8Bytes(HANDOFF_INSTRUCTION) / BYTES_PER_TOKEN) : 0);
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
        const size = r.chance(profile.hugeResult) ? TOOL_RESULT_MAX_BYTES + r.int(1, 30_000) : r.chance(0.3) ? r.int(1_000, 8_000) : r.int(0, 300);
        return { kind: "toolResult", n: e.n, outcome: { status: "ok", content: { text: text(r, size), isError: r.chance(0.1) } } };
      }
      default:
        return unreachable(e);
    }
  };

  const isResult = (i: Input): i is Extract<Input, { n: number }> => i.kind === "modelResult" || i.kind === "toolResult";

  /** `origin`：执行器正常送回、重放一条已送过的、或者伪造一个编号不对的结果。 */
  const run = (input: Input, origin: "normal" | "duplicate" | "forged" = "normal"): void => {
    now += r.int(1, 60_000);
    if (r.chance(0.05)) memoryView = r.chance(0.3) ? "" : `k${r.int(0, 9)}: ${text(r, r.int(1, 200))}`;
    const e: Env = { now, memoryView };
    const prev: Process = w.p;
    const seg: readonly Message[] = current(w);
    const s = feed(w, input, e); // 包括 assertInvariants

    // decide 是纯函数：同样的输入给同样的结果。
    assert.deepEqual(decide(prev, seg, input, e), { process: w.p, append: s.append });

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

    const dropped = (isResult(input) && (prev.phase.tag === "idle" || input.n !== prev.lastEffect)) || (input.kind === "stop" && prev.phase.tag === "idle");
    const duplicate = origin === "duplicate";
    if (dropped || duplicate) {
      assert.deepEqual(w.p, prev);
      assert.deepEqual(s.append, []);
      stats.dropped++;
      if (duplicate) stats.duplicates++;
    }
    if (input.kind === "userMessage" && prev.phase.tag !== "idle") {
      assert.deepEqual(s.append, []);
      assert.equal(w.p.phase.tag !== "idle" && w.p.phase.turn.queued.at(-1), input.text);
    }
    // 只重放执行器真正送回过的结果；伪造的编号可能在将来变成当前编号。
    if (isResult(input) && origin === "normal") history.push(input);
    if (history.length > 50) history.shift();

    // 统计覆盖面。
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
        run({ kind: "userMessage", text: text(r, r.chance(0.05) ? r.int(2_000, 20_000) : r.int(1, 200)) });
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
        run(r.chance(0.5) ? { kind: "modelResult", n, outcome: { status: "ok", message } } : { kind: "toolResult", n, outcome: { status: "ok", content: { text: "伪造的", isError: false } } }, "forged");
        return true;
      }
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
    if (profile.name === "失控") {
      assert.ok(stats.stepLimit > 0, "没有用完步数");
    } else {
      for (const k of ["handoffFailed", "done", "stopped", "errors", "skipped", "interrupted", "queuedMerged", "duplicates"] as const) {
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
  // 阈值的比例在 (0, 1) 里，随机的窗口才会触发换段。
  assert.ok(HANDOFF_RATIO > 0 && HANDOFF_RATIO < 1);
});
