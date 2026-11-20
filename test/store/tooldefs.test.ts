// 工具定义进快照（设计稿 5.5）：spawn 读预设时一起读定义并冻结；读不出就是错误结果，什么都不建。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { loadPreset } from "../../src/presets/load.ts";
import { loadProcess, loadProcesses, tx } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { runDeclared, runInStore } from "../../src/store/instore.ts";
import { plain, res } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";
import { fakeMemory, mailbox, PRESET, tempDb, tempDir, toolCall } from "./fixtures.ts";
import type { TestContext } from "node:test";

const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
const models = createModels();
models.setProvider(faux.provider);

/** 临时的预设目录、工具定义目录和两个工作目录，各写一个预设：`kid` 用 notes，`ghost` 用不存在的定义，`rules` 读 AGENTS.md。 */
function setup(t: TestContext) {
  const dir = tempDir(t);
  const presets = join(dir, "presets");
  const tools = join(dir, "tools");
  const work = join(dir, "work");
  const work2 = join(dir, "work2");
  for (const d of [presets, tools, work, work2]) mkdirSync(d);
  const preset = (id: string, toolList: string) => writeFileSync(join(presets, `${id}.md`), `---\nworkdir: ${work}\nmodel: faux/m\ntools: ${toolList}\n---\n你是测试助手。\n`);
  const def = (description: string) => writeFileSync(join(tools, "notes.json"), JSON.stringify({ description, parameters: { type: "object" }, command: "echo hi" }));
  preset("kid", "read, notes");
  preset("ghost", "read, nope");
  writeFileSync(join(presets, "rules.md"), `---\nworkdir: ${work}\nmodel: faux/m\ntools: read\ncontext: AGENTS.md\n---\n你是测试助手。\n`);
  writeFileSync(join(work, "AGENTS.md"), "老目录的规矩");
  writeFileSync(join(work2, "AGENTS.md"), "新目录的规矩");
  def("写笔记");
  return { tools, work, work2, readPreset: (id: string, workdir?: string) => loadPreset(presets, id, models, tools, workdir), def };
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

/** spawn 一个子进程，返回它的记录。 */
function spawn(db: ReturnType<typeof tempDb>, memory: ReturnType<typeof fakeMemory>, p: Process, args: Parameters<typeof toolCall>[2], readPreset: (id: string, workdir?: string) => PresetSnapshot): Process {
  const known = new Set(loadProcesses(db).map((x) => x.id));
  const r = plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", args), 0, readPreset)));
  const child = loadProcesses(db).find((x) => !known.has(x.id));
  assert.equal(r.isError, false, r.text);
  assert.ok(child);
  return child;
}

test("spawn 带 workdir：子进程的快照用覆盖的目录，上下文文件按新目录读", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { readPreset, work, work2 } = setup(t);
  const p = asking(db, memory);
  const child = spawn(db, memory, p, { preset: "rules", text: "做", workdir: work2 }, readPreset);
  assert.equal(child.preset.workdir, work2);
  assert.equal(child.segment.contextView, "### AGENTS.md\n新目录的规矩");
  assert.equal(spawn(db, memory, p, { preset: "rules", text: "做" }, readPreset).preset.workdir, work);
  // 模型常对可选参数传 null，和 post 的 reply、memory_set 的 version 一样当省略。
  assert.equal(spawn(db, memory, p, { preset: "rules", text: "做", workdir: null }, readPreset).preset.workdir, work);
});

test("spawn 带 workdir：目录不存在、不是字符串都是错误结果，不建进程", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { readPreset, work } = setup(t);
  const p = asking(db, memory);
  const bad = (args: Parameters<typeof toolCall>[2], why: RegExp) => {
    const r = plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", args), 0, readPreset)));
    assert.equal(r.isError, true);
    assert.match(r.text, why);
  };
  bad({ preset: "kid", text: "做", workdir: join(work, "nope") }, /^预设 kid 读不出：.*工作目录不存在/);
  // bad() 会加“参数错误：”前缀，和同一分支的其它参数错误一致。
  bad({ preset: "kid", text: "做", workdir: ["x"] }, /^参数错误：workdir 必须是字符串，或者省略。$/);
  assert.equal(loadProcesses(db).length, 1);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

test("工具定义声明的 spawn 带 workdir 同样生效", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { readPreset, work2 } = setup(t);
  const p = asking(db, memory);
  const r = plain(runDeclared(db, memory, p, [], res("好"), [{ name: "spawn", arguments: { preset: "rules", text: "做", workdir: work2 } }], 0, readPreset));
  assert.match(r.text, /^好\n\n\[spawn\] 已建进程 [0-9a-f]{8}，预设 rules。/);
  const child = loadProcesses(db).find((x) => x.parent === "boss")!;
  assert.equal(child.preset.workdir, work2);
  assert.equal(child.segment.contextView, "### AGENTS.md\n新目录的规矩");
});
