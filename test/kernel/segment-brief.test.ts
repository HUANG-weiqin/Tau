// D103：换段时新段第一条带上旧段的简略视图。规格见 .knowledge/kb-kernel.md 的“旧段的简略视图”。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF_END, BRIEF_HEADER, CARRY_HEADER, HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { BRIEF_FIXED_BYTES, briefBlock } from "../../src/kernel/brief.ts";
import { BYTES_PER_TOKEN, handoffThreshold, HANDOFF_REQUEST_MAX_BYTES, MESSAGE_MAX_BYTES, newSegmentUsed, utf8Bytes } from "../../src/kernel/derive.ts";
import { fork } from "../../src/kernel/decide.ts";
import type { Letter, Message } from "../../src/kernel/types.ts";
import { assistant, call, current, deepFreeze, env, feed, letter, letterInput, preset, reply, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000 });
const marked = (text: string): Letter => ({ ...letter(text), handoff: true });

/** 模型调 handoff 工具、写交接说明：换到下一段。 */
function handoff(w: World, note: string): void {
  reply(w, assistant({ usage: 1000, calls: [call("h", "handoff", {})] }));
  toolDone(w, "ok");
  reply(w, assistant({ usage: 1000, text: note }));
}

/** 一次 bash 调用和它的成功结果。 */
function bash(w: World, command: string, out = "ok"): void {
  reply(w, assistant({ usage: 1000, calls: [call("c", "bash", { command })] }));
  toolDone(w, out);
}

const firstOf = (w: World): { text: string; tau: { letters: { at?: [number, number] }[]; brief?: [number, number] } } => {
  const m = current(w)[0]! as Message & { tau?: never };
  return { text: textOf(m), tau: (m as unknown as { tau: { letters: { at?: [number, number] }[]; brief?: [number, number] } }).tau };
};

/** 第一条里的简略视图那一块的内容行（以 [ 开头）。 */
const linesOf = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("["));

describe("D103 简略视图：位置", () => {
  test("交接说明之后、CARRY_HEADER 之前，tau.brief 框住 BRIEF_HEADER 到 BRIEF_END", () => {
    const w = world(P);
    feed(w, userInput("做重构"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, letterInput(marked("稍后处理这个")));
    reply(w, assistant({ usage: 1000, text: "说明一" }));
    const { text, tau } = firstOf(w);
    assert.ok(text.startsWith(HANDOFF_HEADER + "说明一\n\n" + BRIEF_HEADER));
    const [a, b] = tau.brief!;
    assert.equal(a, (HANDOFF_HEADER + "说明一\n\n").length);
    assert.ok(text.slice(a, b).startsWith(BRIEF_HEADER));
    assert.ok(text.slice(a, b).endsWith(BRIEF_END));
    assert.equal(text.slice(b, b + 2 + CARRY_HEADER.length), "\n\n" + CARRY_HEADER);
    const at = tau.letters[0]!.at!;
    assert.equal(text.slice(at[0], at[1]), "稍后处理这个");
    assert.ok(text.slice(a, b).includes("[1:0] 用户：做重构"));
    assert.ok(text.slice(a, b).includes("[1:1] 助手：好"));
  });

  test("没有带过去的信时，这一块在说明后面，tau 有 brief", () => {
    const w = world(P);
    feed(w, userInput("任务"));
    handoff(w, "说明");
    const { text, tau } = firstOf(w);
    assert.equal(text.slice(tau.brief![1]), "");
    assert.ok(text.endsWith(BRIEF_END));
  });
});

describe("D103 简略视图：预算", () => {
  const carriedOverhead = utf8Bytes(`\n\n${CARRY_HEADER}\n\n`);
  /** 带过去的信：整条第一条的字节数是 total。 */
  function withCarried(total: number): World {
    const w = world(P);
    feed(w, userInput("你好"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    const n = total - utf8Bytes(HANDOFF_HEADER + "说明") - carriedOverhead;
    feed(w, letterInput(marked("x".repeat(n))));
    reply(w, assistant({ usage: 1000, text: "说明" }));
    return w;
  }

  test("带过去的信很长：放得下时第一条不被截，at 能截出原文", () => {
    const w = withCarried(MESSAGE_MAX_BYTES - BRIEF_FIXED_BYTES - 400);
    const { text, tau } = firstOf(w);
    assert.ok(tau.brief, "有这一块");
    assert.ok(utf8Bytes(text) <= MESSAGE_MAX_BYTES);
    assert.ok(!text.includes("中间省略"));
    const at = tau.letters[0]!.at!;
    assert.equal(text.slice(at[0], at[1]), "x".repeat(at[1] - at[0]));
    assert.ok(at[1] - at[0] > 30_000);
  });

  test("预算不到一行：没有这一块，没有 brief，也不截", () => {
    const w = withCarried(MESSAGE_MAX_BYTES - BRIEF_FIXED_BYTES + 5);
    const { text, tau } = firstOf(w);
    assert.equal(tau.brief, undefined);
    assert.ok(!text.includes(BRIEF_HEADER));
    assert.ok(!text.includes("中间省略"));
    const at = tau.letters[0]!.at!;
    assert.equal(text.slice(at[0], at[1]), "x".repeat(at[1] - at[0]));
  });

  test("交接说明很长：第一条不被截", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    const note = "说".repeat(8000); // 24000 字节
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, letterInput(marked("尾")));
    reply(w, assistant({ usage: 1000, text: note }));
    const { text, tau } = firstOf(w);
    assert.ok(utf8Bytes(text) <= MESSAGE_MAX_BYTES);
    assert.ok(!text.includes("中间省略"));
    const at = tau.letters[0]!.at!;
    assert.equal(text.slice(at[0], at[1]), "尾");
  });

  test("整块（含前面的空行）不超过新段离阈值剩下空间的一半", () => {
    const small = preset({ contextWindow: 50_000 });
    const w = world(small);
    const note = "说".repeat(5000);
    feed(w, userInput("任务"));
    for (let i = 0; i < 200; i++) bash(w, `echo ${i} ${"y".repeat(90)}`);
    handoff(w, note);
    const { text, tau } = firstOf(w);
    const probe: Message = { role: "user", content: HANDOFF_HEADER + note, timestamp: 0 };
    const { used } = newSegmentUsed(w.p, "", probe);
    const half = Math.floor((handoffThreshold(small) - used) / 2) * BYTES_PER_TOKEN;
    const block = text.slice(tau.brief![0], tau.brief![1]);
    const whole = utf8Bytes("\n\n" + block);
    assert.ok(half < 16 * 1024, "这一项是最小的");
    assert.ok(whole <= half, `${whole} <= ${half}`);
    assert.ok(whole > half - 400, "取得很满");
    assert.match(block, /放不下，省略了 \d+ 行/);
  });

  test("离阈值很近：放不下固定文字加一行，不写这一块，新段不会立刻再换段", () => {
    const small = preset({ contextWindow: 40_000 });
    const w = world(small);
    feed(w, userInput("任务"));
    for (let i = 0; i < 20; i++) bash(w, `echo ${i}`);
    const proc = w.p;
    const usedFor = (n: number) => newSegmentUsed(proc, "", { role: "user", content: HANDOFF_HEADER + "说".repeat(n), timestamp: 0 }).used;
    let n = 1;
    while (usedFor(n + 1) < handoffThreshold(small) - 60) n++;
    const half = Math.floor((handoffThreshold(small) - usedFor(n)) / 2) * BYTES_PER_TOKEN;
    assert.ok(half < BRIEF_FIXED_BYTES + 20, `半数 ${half} 放不下固定文字加一行`);
    handoff(w, "说".repeat(n));
    const { text, tau } = firstOf(w);
    assert.equal(tau.brief, undefined);
    assert.ok(!text.includes(BRIEF_HEADER));
    assert.equal(w.p.segment.seq, 2);
    assert.ok(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose === "turn", "第一次 continueTurn 不换段");
  });
});

describe("D103 简略视图：多段", () => {
  test("连续换段：每行只出现一次，不嵌套，越旧越先挤掉，省略数累加", () => {
    const w = world(P);
    const omitted: number[] = [];
    feed(w, userInput("任务一"));
    for (let s = 1; s <= 3; s++) {
      for (let i = 0; i < 100; i++) bash(w, `echo s${s}-${i} ${"z".repeat(90)}`);
      handoff(w, `说明${s}`);
      const { text } = firstOf(w);
      assert.equal(text.split(BRIEF_HEADER).length, 2, "BRIEF_HEADER 只一个");
      assert.equal(text.split(BRIEF_END).length, 2);
      const lines = linesOf(text);
      assert.equal(new Set(lines).size, lines.length, "每行只出现一次");
      omitted.push(Number(/省略了 (\d+) 行/.exec(text)?.[1] ?? 0));
      if (s < 3) reply(w, assistant({ usage: 1000, text: "好" })), feed(w, userInput(`再来${s}`));
    }
    const { text } = firstOf(w);
    assert.equal(omitted[0], 0);
    assert.ok(omitted[1]! > 0 && omitted[2]! > omitted[1]!, `省略数累加：${omitted}`);
    assert.ok(text.includes("[1:0] 用户：任务一"), "原话在第一批取的里面");
    // 工具行（第二批取）：留下的是最新的，没有被挤掉的行夹在中间。
    const tools = linesOf(text).filter((l) => l.includes(" bash echo "));
    const seqs = tools.map((l) => Number(/echo s(\d)-(\d+)/.exec(l)![1]) * 1000 + Number(/echo s(\d)-(\d+)/.exec(l)![2]));
    assert.ok(seqs.length > 0 && seqs.length < 300);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(seqs.at(-1) === 3099, "最新的在");
    const contiguous = seqs.every((v, i) => i === 0 || v === seqs[i - 1]! + 1 || Math.floor(v / 1000) !== Math.floor(seqs[i - 1]! / 1000));
    assert.ok(contiguous, "同一段里留下的是连续的一截（旧的先被挤掉）");
  });

  test("从带着这一块的段 fork，新进程的第 1 段换段时不带那些行", () => {
    const w = world(P);
    feed(w, userInput("任务"));
    bash(w, "echo SOURCE_MARK");
    handoff(w, "说明一");
    reply(w, assistant({ usage: 1000, text: "好" }));
    assert.ok(firstOf(w).text.includes("SOURCE_MARK"));
    const r = fork("f1", deepFreeze(w.p), current(w), undefined, 99);
    const f: World = { p: r.process, segments: new Map([[1, r.messages]]) };
    feed(f, userInput("接着做"));
    handoff(f, "说明二");
    const { text } = firstOf(f);
    assert.ok(!text.includes("SOURCE_MARK"));
    assert.ok(text.includes("[1:0] 交接说明：说明一"));
  });
});

describe("D103 简略视图：取法", () => {
  test("两遍取：第一封信很早、后面大量工具调用时，第一封信仍在", () => {
    const w = world(P);
    feed(w, userInput("最早的任务"));
    for (let i = 0; i < 200; i++) bash(w, `echo ${i} ${"q".repeat(90)}`);
    handoff(w, "说明");
    const { text } = firstOf(w);
    assert.ok(text.includes("[1:0] 用户：最早的任务"));
    assert.match(text, /放不下，省略了 \d+ 行/);
    assert.ok(!text.includes("echo 0 "), "最早的工具行被挤掉");
    assert.ok(text.includes("echo 199 "));
  });

  test("工具调用 ID 全是空串：结果按位置配对", () => {
    const w = world(P);
    feed(w, userInput("任务"));
    reply(w, assistant({ usage: 1000, calls: [call("", "bash", { command: "echo A" }), call("", "read", { path: "b.ts" })] }));
    toolDone(w, "A");
    toolDone(w, "没有这个文件", env(0), true);
    handoff(w, "说明");
    const lines = linesOf(firstOf(w).text);
    assert.ok(lines.includes("[1:2] bash echo A"), lines.join("\n"));
    assert.ok(lines.includes("[1:3] ✗ read b.ts：没有这个文件"), lines.join("\n"));
  });

  test("失败的 bash：行里有退出码和它前面那一行", () => {
    const w = world(P);
    feed(w, userInput("任务"));
    bash(w, "make");
    reply(w, assistant({ usage: 1000, calls: [call("c", "bash", { command: "false" })] }));
    toolDone(w, "开头\n中间\n最后一行报错\n[退出码 1]", env(0), true);
    handoff(w, "说明");
    assert.ok(linesOf(firstOf(w).text).includes("[1:4] ✗ bash false：[退出码 1] 开头 … 最后一行报错"));
  });

  test("库内工具成功：行里带结果第一行", () => {
    const w = world(P);
    feed(w, userInput("任务"));
    reply(w, assistant({ usage: 1000, calls: [call("c", "spawn", { preset: "worker", text: "去做" })] }));
    toolDone(w, "新进程 ab12cd\n其余");
    handoff(w, "说明");
    assert.ok(linesOf(firstOf(w).text).includes("[1:2] spawn worker → 新进程 ab12cd"));
  });

  test("回归：最早的任务之后 80 次失败的 bash，任务仍在（失败行不进第一遍）", () => {
    const w = world(P);
    feed(w, userInput("最早的任务：把 X 模块重构成 Y"));
    for (let i = 0; i < 80; i++) {
      reply(w, assistant({ usage: 1000, calls: [call("c", "bash", { command: `make ${i} ${"m".repeat(90)}` })] }));
      toolDone(w, `${"a".repeat(100)}\n${"b".repeat(100)}\n[退出码 1]`, env(0), true);
    }
    handoff(w, "说明");
    const text = firstOf(w).text;
    assert.ok(text.includes("[1:0] 用户：最早的任务：把 X 模块重构成 Y"));
    assert.match(text, /放不下，省略了 \d+ 行/);
  });

  test("回归：一行比一半预算大、不到两倍时，这一块不是空的（第二遍补上第一遍没放下的）", () => {
    const line = `[1:0] 用户：${"字".repeat(95)}`;
    assert.ok(utf8Bytes(line) > 280 && utf8Bytes(line) <= 300);
    const budget = utf8Bytes(line) + 1 + 100;
    assert.ok(budget < 2 * (utf8Bytes(line) + 1));
    const block = briefBlock({ lines: [line], omitted: 0 }, budget);
    assert.ok(block.includes(line));
  });
});

test("HANDOFF_REQUEST_MAX_BYTES 是 671", () => {
  assert.equal(HANDOFF_REQUEST_MAX_BYTES, 671);
});
