// D104：纯函数 hurried——进程是 awaitingTool 且有排队的信。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hurried } from "../../src/kernel/decide.ts";
import { assistant, call, feed, preset, reply, toolDone, userInput, world } from "./helpers.ts";

test("hurried：只有 awaitingTool 且 queued 不空才算", () => {
  const w = world(preset());
  assert.equal(hurried(w.p), false, "idle");
  feed(w, userInput("你好"));
  assert.equal(hurried(w.p), false, "awaitingModel，没排队的信");
  feed(w, userInput("插话"));
  assert.equal(w.p.phase.tag, "awaitingModel");
  assert.equal(hurried(w.p), false, "awaitingModel，有排队的信：不是在等工具");
  reply(w, assistant({ usage: 1_000, calls: [call("c1")] }));
  assert.equal(w.p.phase.tag, "awaitingTool");
  assert.equal(hurried(w.p), true, "模型调用时到的信排在 queued，进了 awaitingTool 就催");
});

test("hurried：工具运行中来信变真，信并进段后变假", () => {
  const w = world(preset());
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: 1_000, calls: [call("c1"), call("c2")] }));
  assert.equal(hurried(w.p), false);
  feed(w, userInput("插话"));
  assert.equal(hurried(w.p), true);
  toolDone(w, "一");
  assert.equal(w.p.phase.tag, "awaitingTool");
  assert.equal(hurried(w.p), true, "批没做完，信还在排队");
  toolDone(w, "二");
  assert.equal(hurried(w.p), false, "安全点信并进段");
});
