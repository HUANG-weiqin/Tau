// 工具名解析在存储层和执行器两处用同一个函数（D109）：规范名执行，段里的调用名不改，结果末尾说明改了什么。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createActions } from "../../src/executor/actions.ts";
import { createExecutor } from "../../src/executor/executor.ts";
import { start } from "../../src/kernel/decide.ts";
import type { PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { loadProcess, loadSegment } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { allMessages, fakeMemory, PRESET, say, scripted, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import { plain } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

test("库内：写法不同的名字按规范名执行，事务不抛错；段里的名字不改；Handoff 也换段（D109）", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "Memory_Get", { key: "k" }), toolCall("c2", "Read", { path: "a" }), toolCall("c3", "Handoff")), say("交接说明"), say("好")]));
  startProcess(db, memory, "p1", PRESET, "试", 0);
  await settle(db, memory, exec);
  const results = allMessages(db, "p1").filter((m) => m.role === "toolResult");
  assert.deepEqual(results.map((m) => [m.toolCallId, m.toolName, m.isError, m.content[0]?.type === "text" && m.content[0].text]), [
    ["c1", "Memory_Get", false, '键 k 不存在。\n注：工具名 "Memory_Get" 当作 memory_get。'],
    ["c2", "Read", false, "out:c2"],
    ["c3", "Handoff", false, '将在这批工具结果之后换段。\n注：工具名 "Handoff" 当作 handoff。'],
  ]);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "done" });
  assert.equal(loadProcess(db, "p1")?.segment.seq, 2, "写成 Handoff 也换了段");
  assertStoreInvariants(db);
});

test("库内：别家的名字回能照抄的话；预设有 bash 时点名用 bash", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "Grep", { pattern: "x" })), say("好")]));
  startProcess(db, memory, "p1", { ...PRESET, tools: ["read", "bash"] }, "找", 0);
  await settle(db, memory, exec);
  const [r] = loadSegment(db, loadProcess(db, "p1")!).filter((m) => m.role === "toolResult");
  assert.equal(r?.isError, true);
  assert.equal(r?.content[0]?.type === "text" && r.content[0].text, '工具 "Grep" 不存在，或者预设里没有它。可用的工具：read、bash、self、handoff。工具名要从这里照抄，一字不差。列表外的工具都调不通，不要再调用它。grep、ls、find、python、curl 这类命令，用 bash 运行。要结束这一轮或者提问，直接写回复，不调用工具。');
});

test("库内：名字和参数都不规范，说明合成一行，名字那项在前", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "Memory_Set", { key: "k", content: "v", brief: "b" })), say("好")]));
  startProcess(db, memory, "p1", PRESET, "记", 0);
  await settle(db, memory, exec);
  const [r] = loadSegment(db, loadProcess(db, "p1")!).filter((m) => m.role === "toolResult");
  assert.equal(r?.isError, false);
  assert.equal(r?.content[0]?.type === "text" && r.content[0].text, '已写入 k，版本 1。\n注：工具名 "Memory_Set" 当作 memory_set；参数 content 当作 value。');
  assert.equal(memory.get(PRESET.id, "k")?.value, "v");
});

const world = (t: Parameters<typeof tempDir>[0], over: Partial<PresetSnapshot> = {}) => {
  const workdir = tempDir(t);
  const preset: PresetSnapshot = { ...PRESET, workdir, tools: ["read", "write", "edit", "bash"], ...over };
  const process: Process = start("p1", preset, { now: 0, memoryView: "" });
  const actions = createActions(createModels(), () => {}, "test-pipe", () => undefined);
  const run = async (name: string, args: JsonObject) => {
    const call = toolCall("c1", name, args);
    return plain(await actions.runTool({ process, segment: [], effect: { kind: "runTool", n: 1, call } }, call, new AbortController().signal, new AbortController().signal));
  };
  return { workdir, run };
};

test("执行器：按解析后的名字运行，结果末尾说明；名字和参数的说明合成一行", async (t) => {
  const { workdir, run } = world(t);
  await writeFile(join(workdir, "a.txt"), "hi");
  assert.deepEqual(await run("read", { path: "a.txt" }), { text: "     1\thi", isError: false }, "精确的名字没有说明");
  assert.deepEqual(await run("functions.Read", { path: "a.txt" }), { text: '     1\thi\n注：工具名 "functions.Read" 当作 read。', isError: false });
  assert.deepEqual(await run("Read", { file_path: "a.txt" }), { text: '     1\thi\n注：工具名 "Read" 当作 read；参数 file_path 当作 path。', isError: false });
  const e = await run("Edit", { file_path: "a.txt", old_string: "hi", new_string: "yo" });
  assert.deepEqual(e.isError, false);
  assert.match(e.text, /\n注：工具名 "Edit" 当作 edit；参数 file_path 当作 path；参数 old_string 当作 old；参数 new_string 当作 new。$/);
  assert.equal(await readFile(join(workdir, "a.txt"), "utf8"), "yo");
});

test("执行器：isError 跟着真实结果走；参数错误整段是错误文字，没有注", async (t) => {
  const { run } = world(t);
  const missing = await run("Read", { path: "nope.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /\n注：工具名 "Read" 当作 read。$/);
  const bad = await run("Read", { file: "a", offset: 1.5 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^参数错误：offset 要整数，收到的是 1\.5。read 的参数：/);
  assert.doesNotMatch(bad.text, /注：/);
});

test("执行器：工具定义的名字要一字不差；工具定义叫 Bash 时，Bash 跑定义，bash 跑内置", async (t) => {
  const def = { name: "Bash", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, command: "echo from-def", timeout: 30, output: "content" } as const;
  const { run } = world(t, { toolDefs: [def] });
  assert.match((await run("Bash", {})).text, /from-def/);
  assert.match((await run("bash", { command: "echo builtin" })).text, /builtin/);
  const miss = await run("BASH", { command: "echo x" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /^工具 "BASH" 不存在/);
  assert.equal((await run("nope", {})).isError, true);
});

test("执行器：工具定义带供应商的前缀和序号也认，结果末尾说明（K1）", async (t) => {
  const def = { name: "notes", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, command: "echo hi", timeout: 30, output: "text" } as const;
  const { run } = world(t, { toolDefs: [def] });
  assert.deepEqual(await run("notes", {}), { text: "hi\n[退出码 0]", isError: false });
  const r = await run("functions.notes:0", {});
  assert.equal(r.isError, false);
  assert.match(r.text, /^hi\n/);
  assert.match(r.text, /\n注：工具名 "functions\.notes:0" 当作 notes。$/);
});

test("执行器：工具定义的参数只按 schema 校验，错误加中文开头，后面附校验器的原文", async (t) => {
  const def = { name: "notes", description: "d", parameters: { type: "object", properties: { text: { type: "string" }, n: { type: "integer" } }, required: ["text"], additionalProperties: false }, command: "cat", timeout: 30, output: "content" } as const;
  const { run } = world(t, { toolDefs: [def] });
  const e = await run("notes", { text: "x", extra: 1 });
  assert.equal(e.isError, true);
  assert.match(e.text, /^参数错误：参数不合 schema（下面是校验器的原文）。\nValidation failed for tool "notes"/);
  assert.match((await run("Notes", { text: "x" })).text, /^工具 "Notes" 不存在/, "工具定义不按写法兜底");
});

test("执行器：bash 的说明接在最后一行；cwd 变成命令前的 cd", async (t) => {
  const { workdir, run } = world(t);
  assert.deepEqual(await run("bash", { command: "echo hi", description: "x" }), { text: "hi\n[退出码 0]\n注：没用上参数 description。", isError: false });
  assert.deepEqual(await run("Bash", { cmd: "echo hi" }), { text: 'hi\n[退出码 0]\n注：工具名 "Bash" 当作 bash；参数 cmd 当作 command。', isError: false });
  const there = await run("bash", { command: "pwd", cwd: workdir });
  assert.equal(there.isError, false);
  assert.match(there.text, /\n注：参数 cwd 当作命令前的 cd -- /);
  const gone = await run("bash", { command: "echo should-not-run", cwd: join(workdir, "nope") });
  assert.doesNotMatch(gone.text, /should-not-run\n/, "cd 失败就不跑原命令");
});
