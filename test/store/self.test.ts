// 设计稿第 4 节、5.3、5.8：`self` 的文字多了父进程、子进程、空闲子进程个数、消息条数和累计用量。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Message, Process, PresetSnapshot } from "../../src/kernel/types.ts";
import { handoffThreshold } from "../../src/kernel/derive.ts";
import { loadProcess, saveProcess, tx } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { runInStore, spawnId } from "../../src/store/instore.ts";
import { fakeMemory, PRESET, tempDb, toolCall } from "./fixtures.ts";
import { plain } from "../plain.ts";

const BOSS: PresetSnapshot = { ...PRESET, id: "boss", tools: ["agents", "memory"] };
const KID: PresetSnapshot = { ...PRESET, id: "kid", tools: ["read", "memory"] };
const readPreset = (id: string): PresetSnapshot => (id === "kid" ? KID : BOSS);

const SEGMENT: Message[] = [
  { role: "user", content: "a", timestamp: 0 },
  { role: "user", content: "b", timestamp: 1_000 },
  { role: "user", content: "c", timestamp: 2_000 },
];

function selfText(db: DatabaseSync, p: Process): string {
  const memory = fakeMemory();
  const r = plain(tx(db, () => runInStore(db, memory, p, SEGMENT, toolCall("c", "self"), 10_000, readPreset)));
  assert.equal(r.isError, false);
  return r.text;
}

test("self 的文字：没有父进程和子进程时，不多出这些行；带消息条数和累计用量", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "solo", BOSS, "开始", 0);
  const p: Process = { ...loadProcess(db, "solo")!, usage: { input: 1200, output: 34, cacheRead: 5, cacheWrite: 6 } };
  const lines = selfText(db, p).split("\n");
  assert.ok(lines.some((l) => l === "工作段：第 1 段，开始于 10 秒前，共 3 条消息"), lines.join("\n"));
  assert.ok(lines.includes("累计用量：输入 1200，输出 34，缓存读 5，缓存写 6（token）"), lines.join("\n"));
  assert.ok(!lines.some((l) => /父进程|子进程/.test(l)), lines.join("\n"));
});

test("self 的文字：父进程一行，运行中的子进程各一行，空闲的只给个数", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "boss1", BOSS, "开始", 0);
  const boss = loadProcess(db, "boss1")!;
  const asking: Process = { ...boss, lastEffect: 20, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } };
  for (const n of [1, 2, 3]) plain(tx(db, () => runInStore(db, memory, { ...asking, lastEffect: n }, [], toolCall("c", "spawn", { preset: "kid", text: "做" }), 0, readPreset)));
  const ids = [1, 2, 3].map((n) => spawnId("boss1", n, 0)).sort();
  // 第一个孩子在等模型，第二个在等工具，第三个空闲。
  const busy = (id: string, phase: Process["phase"]) => saveProcess(db, { ...loadProcess(db, id)!, lastEffect: 1, phase });
  busy(ids[0]!, { tag: "awaitingModel", purpose: "turn", turn: { steps: 2, queued: [], hops: 0, replyTo: [] } });
  busy(ids[1]!, { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } });

  const text = selfText(db, asking);
  assert.match(text, /^运行中的子进程：$/m);
  assert.match(text, new RegExp(`^- ${ids[0]}：预设 kid，等模型回复，本轮第 2 步，排队消息 0 条，已运行 10 秒$`, "m"));
  assert.match(text, new RegExp(`^- ${ids[1]}：预设 kid，等工具结果，本轮第 1 步，排队消息 0 条，已运行 10 秒$`, "m"));
  assert.match(text, /^空闲的子进程：1 个$/m);
  assert.doesNotMatch(text, /父进程/);

  // 孩子自己看：有父进程，没有子进程。
  const kid = loadProcess(db, ids[2]!)!;
  const kidText = selfText(db, kid);
  assert.match(kidText, /^父进程：boss1$/m);
  assert.doesNotMatch(kidText, /子进程/);
});

test("self 的文字：上下文那一行后面多一行换段阈值；有 handoff 时用较低的", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "solo", BOSS, "开始", 0);
  const p = loadProcess(db, "solo")!;
  const lines = selfText(db, p).split("\n");
  const at = lines.findIndex((l) => l.startsWith("上下文："));
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], `换段阈值：${handoffThreshold(BOSS)} token`);
  const low: Process = { ...p, preset: { ...BOSS, handoff: 1_234 } };
  assert.ok(selfText(db, low).split("\n").includes("换段阈值：1234 token"));
});
