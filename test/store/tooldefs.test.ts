// 工具定义进快照（设计稿 5.5）：spawn 读预设时一起读定义并冻结；读不出就是错误结果，什么都不建。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Process } from "../../src/kernel/types.ts";
import { loadPreset } from "../../src/presets/load.ts";
import { loadProcess, loadProcesses, tx } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { runInStore } from "../../src/store/instore.ts";
import { plain } from "../plain.ts";
import { fakeMemory, mailbox, PRESET, tempDb, tempDir, toolCall } from "./fixtures.ts";
import type { TestContext } from "node:test";

const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
const models = createModels();
models.setProvider(faux.provider);

/** 临时的预设目录、工具定义目录和工作目录，各写一个预设：`kid` 用 notes，`ghost` 用不存在的定义。 */
function setup(t: TestContext) {
  const dir = tempDir(t);
  const presets = join(dir, "presets");
  const tools = join(dir, "tools");
  const work = join(dir, "work");
  for (const d of [presets, tools, work]) mkdirSync(d);
  const preset = (id: string, toolList: string) => writeFileSync(join(presets, `${id}.md`), `---\nworkdir: ${work}\nmodel: faux/m\ntools: ${toolList}\n---\n你是测试助手。\n`);
  const def = (description: string) => writeFileSync(join(tools, "notes.json"), JSON.stringify({ description, parameters: { type: "object" }, command: "echo hi" }));
  preset("kid", "read, notes");
  preset("ghost", "read, nope");
  def("写笔记");
  return { tools, readPreset: (id: string) => loadPreset(presets, id, models, tools), def };
}

function asking(db: ReturnType<typeof tempDb>, memory: ReturnType<typeof fakeMemory>): Process {
  startProcess(db, memory, "boss", { ...PRESET, id: "boss", tools: ["agents"] }, "开始", 0);
  db.exec("DELETE FROM mailbox");
  return { ...loadProcess(db, "boss")!, lastEffect: 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } };
}

test("spawn：子进程的快照冻结了用到的工具定义；之后改文件，已建的进程不变，新建的变", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { readPreset, def } = setup(t);
  const p = asking(db, memory);
  const spawn = (n: number) => plain(tx(db, () => runInStore(db, memory, { ...p, lastEffect: n }, [], toolCall("c", "spawn", { preset: "kid", text: "做" }), 0, readPreset)));
  assert.equal(spawn(1).isError, false);
  def("改过的说明");
  assert.equal(spawn(2).isError, false);
  const kids = loadProcesses(db).filter((x) => x.parent === "boss");
  assert.equal(kids.length, 2);
  assert.deepEqual(kids.map((k) => k.preset.toolDefs.map((d) => d.description)), [["写笔记"], ["改过的说明"]]);
  assert.deepEqual(kids[0]!.preset.toolDefs[0], { name: "notes", description: "写笔记", parameters: { type: "object" }, command: "echo hi", timeout: 120, output: "text" });
});

test("spawn：工具定义读不出，错误结果是“预设 <preset> 读不出：<原因>”，不建进程、不寄信", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { readPreset } = setup(t);
  const p = asking(db, memory);
  const r = plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", { preset: "ghost", text: "做" }), 0, readPreset)));
  assert.equal(r.isError, true);
  assert.equal(r.text, "预设 ghost 读不出：找不到工具定义：nope");
  assert.equal(loadProcesses(db).length, 1);
  assert.equal(mailbox(db).length, 0);
});

test("start：快照冻结工具定义，写进 state_json，读回来一样；之后改文件不影响它", (t) => {
  const db = tempDb(t);
  const { readPreset, def } = setup(t);
  startProcess(db, fakeMemory(), "p1", readPreset("kid"), "你好", 0);
  def("改过的说明");
  const p = loadProcess(db, "p1")!;
  assert.deepEqual(p.preset.toolDefs.map((d) => d.description), ["写笔记"]);
  assert.equal(readPreset("kid").toolDefs[0]!.description, "改过的说明", "新读的快照是新的");
});
