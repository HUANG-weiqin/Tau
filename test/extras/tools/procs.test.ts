// 进程 ID 对不上时列候选（extras/tools/procs.ts）：纯函数，用假记录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateText } from "../../../extras/tools/procs.ts";
import type { Rec } from "../../../extras/tools/procs.ts";

const rec = (id: string, preset: string, phase: any, createdAt: number, parent?: string): Rec => ({ id, preset, phase, createdAt, ...(parent === undefined ? {} : { parent }) });
const RUN = { tag: "awaitingTool" };
const END = { tag: "idle", ended: "done" };
const NEW = { tag: "idle" };

test("wait：只列自己的子进程，新的在前；阶段写成运行中、已结束、刚建好", () => {
  const recs = [rec("c1", "worker", RUN, 1, "me"), rec("c2", "tau", END, 2, "me"), rec("c3", "x", NEW, 3, "me"), rec("o1", "other", RUN, 4, "zz"), rec("me", "tau", RUN, 0)];
  const t = candidateText("wait", recs, "me");
  assert.ok(t.indexOf("c3") < t.indexOf("c2") && t.indexOf("c2") < t.indexOf("c1"), t);
  assert.ok(t.includes("c1（预设 worker，运行中）") && t.includes("c2（预设 tau，已结束）") && t.includes("c3（预设 x，刚建好）"), t);
  assert.ok(!t.includes("o1"), t);
  assert.ok(t.includes('照这样等：wait {"processes":["c1"]}'), t);
});

test("wait：例子取运行中的子进程；没有运行中的就取最新的", () => {
  const t = candidateText("wait", [rec("a", "p", END, 1, "me"), rec("b", "p", END, 2, "me")], "me");
  assert.ok(t.includes('wait {"processes":["b"]}'), t);
});

test("wait：没有子进程，不给例子", () => {
  const t = candidateText("wait", [rec("me", "tau", RUN, 0)], "me");
  assert.ok(t.includes("你没有子进程"), t);
  assert.ok(!t.includes("照这样"), t);
});

test("peek：子进程在前，再是别的运行中的，不含自己；最多 10 个", () => {
  const recs = [rec("o1", "other", RUN, 5), rec("c1", "w", END, 1, "me"), rec("me", "tau", RUN, 0), rec("o2", "idle", END, 6)];
  const t = candidateText("peek", recs, "me");
  assert.ok(t.indexOf("c1") < t.indexOf("o1"), t);
  assert.ok(!t.includes("o2") && !t.includes("me（"), t);
  assert.ok(t.includes('照这样看：peek {"process":"c1"}'), t);
  const many = Array.from({ length: 15 }, (_, i) => rec(`k${i}`, "w", RUN, i, "me"));
  assert.equal(candidateText("peek", many, "me").match(/（预设/g)!.length, 10);
});

test("peek：没有候选", () => {
  const t = candidateText("peek", [rec("me", "tau", RUN, 0)], "me");
  assert.ok(t.includes("现在没有别的运行中的进程，你也没有子进程"), t);
  assert.ok(!t.includes("照这样"), t);
});
