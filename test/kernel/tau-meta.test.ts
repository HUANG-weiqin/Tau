// D64 第 3 组：段里的消息带结构（`tau`）。信的发送者、跳数、回信对象和正文位置，不用解析文字就能读出。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { contextUsed, messageBytes } from "../../src/kernel/derive.ts";
import { fork } from "../../src/kernel/decide.ts";
import type { Message } from "../../src/kernel/types.ts";
import { assistant, call, codeText, current, deepFreeze, feed, giveUp, letter, letterInput, preset, processLetter, reply, stopInput, textOf, toolDone, toolInterrupted, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000, input: ["text", "image"] });
type Tau = { letters?: { from: unknown; hops: number; replyTo?: string; handoff?: true; at?: [number, number] }[]; after?: unknown; handoff?: true; filled?: string };
const tauOf = (m: Message | undefined): Tau | undefined => (m as { tau?: Tau } | undefined)?.tau;
/** 消息文本：content 是字符串时就是它，是数组时是第一个文本块。 */
const textOfMessage = (m: Message): string => {
  if (m.role === "assistant") throw new Error("助手消息没有 tau");
  if (typeof m.content === "string") return m.content;
  const b = m.content.find((c) => c.type === "text");
  return b?.type === "text" ? b.text : "";
};
const cut = (m: Message, at: [number, number] | undefined): string => {
  assert.ok(at, "有 at");
  return textOfMessage(m).slice(at[0], at[1]);
};

/** 进程在等工具，排队里有 `letters`，工具结果一到就在安全点合并。返回合并出的那条消息。 */
function merged(letters: ReturnType<typeof letter>[]): Message {
  const w = world(P);
  feed(w, userInput("开头"));
  reply(w, assistant({ usage: 1000, calls: [call("c1")] }));
  for (const l of letters) feed(w, letterInput(l));
  toolDone(w, "ok");
  const m = current(w).at(-1)!;
  assert.equal(m.role, "user");
  return m;
}

describe("用户消息带 tau.letters", () => {
  test("用户的信、进程的信、回信混在一批：按 at 截出的正文和原信一致，头里的字段照抄", () => {
    const ls = [letter("甲：用户的信"), processLetter("乙：要回信的\n两行", { id: "a1", preset: "x", replyTo: "a1", hops: 3 }), processLetter("丙：回信正文", { id: "b2", reply: "done", hops: 5 }), letter("丁：另一封用户的信，带🙂")];
    const m = merged(ls);
    const t = tauOf(m)!;
    assert.equal(t.letters!.length, 4);
    assert.deepEqual(
      t.letters!.map((l) => cut(m, l.at)),
      ["甲：用户的信", "乙：要回信的\n两行", "丙：回信正文", "丁：另一封用户的信，带🙂"],
    );
    assert.deepEqual(t.letters![0]!.from, { kind: "user" });
    assert.deepEqual(t.letters![1], { from: ls[1]!.from, hops: 3, replyTo: "a1", at: t.letters![1]!.at });
    assert.deepEqual(t.letters![2]!.from, ls[2]!.from);
    assert.equal(t.letters![2]!.hops, 5);
    assert.equal("replyTo" in t.letters![2]!, false);
    assert.equal(t.after, undefined);
  });

  test("只有用户信的一批（没有头）：位置也对", () => {
    const m = merged([letter("第一封"), letter("第二封")]);
    assert.equal(textOfMessage(m), "第一封\n\n第二封");
    assert.deepEqual(
      tauOf(m)!.letters!.map((l) => cut(m, l.at)),
      ["第一封", "第二封"],
    );
  });

  test("空闲时来的信：一封信，位置对；带图片时消息是数组，文本取第一个文本块", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    const m = current(w)[0]!;
    assert.equal(cut(m, tauOf(m)!.letters![0]!.at), "你好");
    const w2 = world(P);
    feed(w2, letterInput({ from: { kind: "user" }, content: [{ type: "text", text: "看图" }, { type: "image", data: "aGk=", mimeType: "image/png" }], hops: 0 }));
    const m2 = current(w2)[0]!;
    assert.ok(Array.isArray((m2 as { content: unknown }).content));
    assert.equal(cut(m2, tauOf(m2)!.letters![0]!.at), "看图");
  });

  test("没有 at 的情形：clip 截过，就去掉这条消息全部的 at，别的字段照留", () => {
    const big = codeText(40_000);
    const m = merged([letter("小信"), letter(big)]);
    const t = tauOf(m)!;
    assert.equal(t.letters!.length, 2);
    for (const l of t.letters!) {
      assert.equal("at" in l, false);
      assert.deepEqual(l.from, { kind: "user" });
      assert.equal(l.hops, 0);
    }
    assert.ok(textOf(m).includes("中间省略"));
  });

  test("上一轮没有正常结束：after 记结束原因，位置计入说明的长度；done 和没有结束原因不带 after", () => {
    const w = world(P);
    feed(w, userInput("一"));
    feed(w, stopInput());
    feed(w, userInput("二"));
    const m = current(w).at(-1)!;
    assert.deepEqual(tauOf(m)!.after, "stopped");
    assert.ok(textOfMessage(m).startsWith("（上一轮被停止"));
    assert.equal(cut(m, tauOf(m)!.letters![0]!.at), "二");

    const e = world(P);
    feed(e, userInput("一"));
    giveUp(e, assistant({ usage: 10, stopReason: "error", errorMessage: "炸了" }));
    feed(e, userInput("二"));
    assert.deepEqual(tauOf(current(e).at(-1))!.after, { error: "炸了" });

    const d = world(P);
    feed(d, userInput("一"));
    reply(d, assistant({ usage: 10, text: "好" }));
    feed(d, userInput("二"));
    assert.equal("after" in tauOf(current(d).at(-1))!, false);
    assert.equal("after" in tauOf(current(d)[0])!, false);
  });
});

describe("换段", () => {
  /** u0 完成；u1 被停止；u2 是带换段标记的进程的信（带“被停止”的说明）。换段请求发出时段末有 u1、u2 两条用户消息。 */
  function beforeHandoff(): World {
    const w = world(P);
    feed(w, userInput("u0"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, userInput("一：u1 的正文"));
    feed(w, stopInput());
    feed(w, letterInput({ ...processLetter("二：u2 的正文", { id: "z9", hops: 2 }), handoff: true }));
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
    return w;
  }

  test("新段第一条带 handoff:true，带过去的信位置平移后仍截得出原文，原来的 after 不带", () => {
    const w = beforeHandoff();
    const old = current(w);
    assert.equal(tauOf(old.at(-1))!.after, "stopped");
    reply(w, assistant({ usage: 1000, text: "  交接说明  " }));
    assert.equal(w.p.segment.seq, 2);
    const first = current(w)[0]!;
    const t = tauOf(first)!;
    assert.equal(t.handoff, true);
    assert.equal("after" in t, false);
    assert.ok(textOfMessage(first).startsWith(HANDOFF_HEADER + "交接说明"));
    assert.equal(t.letters!.length, 2);
    assert.deepEqual(
      t.letters!.map((l) => cut(first, l.at)),
      ["一：u1 的正文", "二：u2 的正文"],
    );
    assert.deepEqual(t.letters![1]!.from, { kind: "process", id: "z9", preset: "other" });
    assert.equal(t.letters![1]!.hops, 2);
    assert.equal(t.letters![1]!.handoff, true);
  });

  test("段末没有信时，新段第一条是 handoff:true、letters 为空", () => {
    const w = world(P);
    feed(w, userInput("u0"));
    reply(w, assistant({ usage: 1000, calls: [call("c1", "handoff", {})] }));
    toolDone(w, "ok");
    reply(w, assistant({ usage: 1000, text: "说明" }));
    const t = tauOf(current(w)[0])!;
    assert.equal(t.handoff, true);
    assert.deepEqual(t.letters, []);
  });

  test("带过去的消息被 clip 截过：新段第一条没有 at", () => {
    const w = world(P);
    feed(w, userInput("u0"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, userInput("一"));
    feed(w, stopInput());
    feed(w, letterInput({ ...letter(codeText(30_000)), handoff: true }));
    reply(w, assistant({ usage: 1000, text: codeText(5_000) }));
    const first = current(w)[0]!;
    assert.ok(textOf(first).includes("中间省略"));
    for (const l of tauOf(first)!.letters!) assert.equal("at" in l, false);
    assert.equal(tauOf(first)!.handoff, true);
  });
});

describe("补的工具结果带 filled", () => {
  test("被中断的是第一个待执行的调用，其余是未执行；真实结果不带 tau", () => {
    const w = world(P);
    feed(w, userInput("开头"));
    reply(w, assistant({ usage: 1000, calls: [call("c1"), call("c2"), call("c3")] }));
    toolDone(w, "真结果");
    const eff = w.p.lastEffect;
    feed(w, toolInterrupted(eff));
    const rs = current(w).filter((m) => m.role === "toolResult");
    assert.equal(rs.length, 3);
    assert.equal(tauOf(rs[0]), undefined);
    assert.deepEqual(tauOf(rs[1]), { filled: "interrupted" });
    assert.deepEqual(tauOf(rs[2]), { filled: "skipped" });
  });

  test("停止时补的结果：等的那个是 interrupted，其余 skipped", () => {
    const w = world(P);
    feed(w, userInput("开头"));
    reply(w, assistant({ usage: 1000, calls: [call("c1"), call("c2")] }));
    feed(w, stopInput());
    const rs = current(w).filter((m) => m.role === "toolResult");
    assert.deepEqual(rs.map(tauOf), [{ filled: "interrupted" }, { filled: "skipped" }]);
  });
});

describe("发给模型的请求不带 tau", () => {
  /** 一个什么都有的段：信、after、补的结果、换段后的第一条。 */
  function rich(): World {
    const w = world(P);
    feed(w, userInput("一"));
    reply(w, assistant({ usage: 1000, calls: [call("c1"), call("c2")] }));
    feed(w, letterInput(processLetter("来信", { id: "q", replyTo: "q" })));
    feed(w, stopInput());
    feed(w, userInput("二"));
    return w;
  }

  test("buildContext 的输出里没有 tau，内容一个字都不变", () => {
    const w = rich();
    const seg = current(w);
    assert.ok(seg.some((m) => tauOf(m) !== undefined));
    const req = buildContext(w.p, seg);
    assert.equal(JSON.stringify(req).includes('"tau"'), false);
    const stripped = seg.map((m) => {
      const { tau: _, ...rest } = m as Message & { tau?: unknown };
      return rest;
    });
    assert.deepEqual(req.messages, stripped);
    assert.equal(seg.length, req.messages.length);
  });

  test("换段请求里也没有 tau", () => {
    const w = world(P);
    feed(w, userInput("u0"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, letterInput({ ...letter("换段"), handoff: true }));
    assert.equal(JSON.stringify(buildContext(w.p, current(w))).includes('"tau"'), false);
  });

  test("用量估算只数内容，不受 tau 影响", () => {
    const w = rich();
    const seg = current(w);
    const stripped = seg.map((m) => {
      const { tau: _, ...rest } = m as Message & { tau?: unknown };
      return rest as Message;
    });
    assert.deepEqual(seg.map(messageBytes), stripped.map(messageBytes));
    assert.equal(contextUsed(w.p, seg), contextUsed(w.p, stripped));
  });
});

describe("fork 原样复制", () => {
  test("带不带 before，复制来的消息都保留 tau", () => {
    const w = world(P);
    feed(w, userInput("一"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    feed(w, userInput("二"));
    reply(w, assistant({ usage: 1000, text: "好" }));
    const seg = current(w);
    assert.ok(tauOf(seg[0]) !== undefined);
    assert.deepEqual(fork("f1", deepFreeze(w.p), seg, undefined, 9).messages, seg);
    const part = fork("f2", deepFreeze(w.p), seg, 2, 9).messages;
    assert.deepEqual(part, seg.slice(0, 2));
    assert.deepEqual(tauOf(part[0]), tauOf(seg[0]));
  });
});
