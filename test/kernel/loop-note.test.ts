// D108：同样的错误连续出现时，请求末尾加一条不入库的提示，提醒模型换做法。不停这一轮。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, EMPTY_REPLY_NOTE } from "../../src/kernel/context.ts";
import { utf8Bytes } from "../../src/kernel/derive.ts";
import { LOOP_NOTE_AT, LOOP_NOTE_MAX_BYTES } from "../../src/kernel/loop.ts";
import type { Message } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, preset, reply, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const LOW = 1_000;
const ERR = "ENOENT: no such file";

function begin(): World {
  const w = world(preset());
  feed(w, userInput("你好"));
  return w;
}

/** 一步：一条助手消息（每个调用一个名字，参数用序号区分）加它的结果。results 与 calls 一一对应。 */
function step(w: World, names: string[], results: { text: string; isError: boolean }[], usage = LOW) {
  const k = current(w).length;
  reply(w, assistant({ usage, text: `想法${k}`, calls: names.map((n, i) => call(`c${k}-${i}`, n, { path: `f${k}-${i}.txt` })) }));
  for (const r of results) toolDone(w, r.text, undefined, r.isError);
}

const bad = (text = ERR) => ({ text, isError: true });
const ok = (text = "好") => ({ text, isError: false });
const tail = (w: World): Message => buildContext(w.p, current(w)).messages.at(-1)! as Message;
const lastText = (w: World) => textOf(tail(w));
const isNote = (w: World) => tail(w).role === "user" && lastText(w).includes("注意：你最近连续");

describe("D108 连续同样的错误", () => {
  test("1 段末 3 步同名同错，参数各不相同：末尾多一条提示，写明次数、工具名和错误的第一行", () => {
    const w = begin();
    for (let i = 0; i < LOOP_NOTE_AT; i++) step(w, ["read"], [bad(`${ERR}\n第二行不显示`)]);
    assert.ok(isNote(w));
    const t = lastText(w);
    assert.ok(t.includes("连续 3 次"), t);
    assert.ok(t.includes("read"), t);
    assert.ok(t.includes(ERR), t);
    assert.ok(!t.includes("第二行不显示"), t);
    assert.equal(tail(w).role, "user");
  });

  test("2 只有 2 步：没有提示", () => {
    const w = begin();
    for (let i = 0; i < LOOP_NOTE_AT - 1; i++) step(w, ["read"], [bad()]);
    assert.ok(!isNote(w));
  });

  test("3 3 步但错误文字不同：没有提示", () => {
    const w = begin();
    step(w, ["read"], [bad("错 A")]);
    step(w, ["read"], [bad("错 B")]);
    step(w, ["read"], [bad("错 C")]);
    assert.ok(!isNote(w));
  });

  test("3b 工具名不同或 isError 不同：没有提示", () => {
    const w = begin();
    step(w, ["read"], [bad()]);
    step(w, ["bash"], [bad()]);
    step(w, ["read"], [bad()]);
    assert.ok(!isNote(w));
    const v = begin();
    step(v, ["read"], [bad()]);
    step(v, ["read"], [bad()]);
    step(v, ["read"], [ok(ERR)]);
    assert.ok(!isNote(v));
  });

  test("4 中间夹一条用户消息：从信之后重新数", () => {
    const w = begin();
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()]);
    // 运行中来信：排队，下一个安全点（这一步的结果写完后）并进段，接在这一步后面。
    feed(w, userInput("换个思路"));
    step(w, ["read"], [bad()]);
    assert.equal(current(w).at(-1)!.role, "user");
    assert.ok(!isNote(w), "段末是信");
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()]);
    assert.ok(!isNote(w), "信之后只有 2 步");
    step(w, ["read"], [bad()]);
    assert.ok(isNote(w));
    assert.ok(lastText(w).includes("连续 3 次"));
  });

  test("5 中间有一步全成功：重新数", () => {
    const w = begin();
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()]);
    step(w, ["read"], [ok()]);
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()]);
    assert.ok(!isNote(w));
    step(w, ["read"], [bad()]);
    assert.ok(isNote(w));
  });

  test("5b 段末那一步没有错误：没有提示", () => {
    const w = begin();
    for (let i = 0; i < 3; i++) step(w, ["read"], [bad()]);
    step(w, ["read"], [ok()]);
    assert.ok(!isNote(w));
  });

  test("6 一步两个调用，3 步都相同且有一个错误：有提示，工具名两个；多于 3 步数到 n", () => {
    const w = begin();
    for (let i = 0; i < 4; i++) step(w, ["read", "bash"], [ok("好"), bad("坏了")]);
    assert.ok(isNote(w));
    const t = lastText(w);
    assert.ok(t.includes("连续 4 次"), t);
    assert.ok(t.includes("read、bash"), t);
    assert.ok(t.includes("坏了"), t);
  });

  test("7 turn.retry 是 empty：只有 EMPTY_REPLY_NOTE，没有这条提示", () => {
    const w = begin();
    for (let i = 0; i < 3; i++) step(w, ["read"], [bad()]);
    reply(w, assistant({ usage: LOW, thinking: "想了想", text: " \n" }));
    const ctx = buildContext(w.p, current(w)).messages;
    assert.equal(textOf(ctx.at(-1)! as Message), EMPTY_REPLY_NOTE);
    assert.ok(!ctx.some((m) => m.role === "user" && textOf(m as Message).includes("注意：你最近连续")));
  });

  test("8 用途是 handoff：没有这条提示", () => {
    const w = begin();
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()]);
    step(w, ["read"], [bad()], 150_000);
    const ph = w.p.phase;
    assert.ok(ph.tag === "awaitingModel" && ph.purpose === "handoff");
    assert.ok(!isNote(w));
  });

  test("9 工具名和错误都超长：提示不超过上限，截短处有 …", () => {
    const w = begin();
    const longName = "t".repeat(500);
    const longErr = "错".repeat(500);
    for (let i = 0; i < LOOP_NOTE_AT; i++) {
      const k = current(w).length;
      reply(w, assistant({ usage: LOW, calls: [call(`c${k}`, longName)] }));
      // 未知工具名由内核补错误结果：不依赖它，直接看提示是否出现。
      while (w.p.phase.tag === "awaitingTool") toolDone(w, longErr, undefined, true);
    }
    const t = lastText(w);
    assert.ok(t.includes("注意：你最近连续"), t);
    assert.ok(t.includes("…"));
    assert.ok(utf8Bytes(t) <= LOOP_NOTE_MAX_BYTES, `${utf8Bytes(t)} > ${LOOP_NOTE_MAX_BYTES}`);
    assert.ok(!t.includes("t".repeat(201)));
  });

  test("9b 上限常量：n 按 4 位数算，比一个典型的提示大", () => {
    assert.ok(LOOP_NOTE_MAX_BYTES > 300 + 200);
    assert.ok(LOOP_NOTE_MAX_BYTES < 1500);
  });

  test("10 提示不入库：段的条数和内容不变，下一次请求没有它", () => {
    const w = begin();
    for (let i = 0; i < LOOP_NOTE_AT; i++) step(w, ["read"], [bad()]);
    const before = JSON.stringify(current(w));
    const n = current(w).length;
    assert.ok(isNote(w));
    assert.equal(buildContext(w.p, current(w)).messages.length, n + 1);
    assert.equal(JSON.stringify(current(w)), before);
    // 模型换了做法：结果不同，下一次请求没有提示。
    step(w, ["read"], [bad("另一个错")]);
    assert.ok(!isNote(w));
  });
});
