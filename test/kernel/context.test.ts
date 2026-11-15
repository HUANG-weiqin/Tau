// buildContext 和工具描述（设计稿第 4.3 节、第 10 节）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, HANDOFF_INSTRUCTION, tailStart } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import { findTool, MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES, toolsFor } from "../../src/kernel/tools.ts";
import type { Message, Phase, PresetTool, Process } from "../../src/kernel/types.ts";
import { assistant, call, deepFreeze, env, preset } from "./helpers.ts";

const seg: readonly Message[] = deepFreeze([
  { role: "user", content: "你好", timestamp: 1 },
  { role: "user", content: "在吗", timestamp: 2 },
]);
/** 段末不是用户消息的段。 */
const done: readonly Message[] = deepFreeze([
  { role: "user", content: "读 a", timestamp: 1 },
  assistant({ usage: 10, calls: [call("c1")], timestamp: 2 }),
  { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "好" }], isError: false, timestamp: 3 },
]);
const HANDOFF: Phase = { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" };

function proc(tools: PresetTool[], phase: Phase = { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" }, memoryView = ""): Process {
  return { ...start("p", preset({ tools, prompt: "你是写代码的助手。" }), env(0, memoryView)), lastEffect: 1, phase };
}

const names = (p: Process) => (buildContext(p, seg).tools ?? []).map((t) => t.name).sort();

test("系统提示词 = 预设提示词 + 开段时的记忆视图", () => {
  const withMemory = buildContext(proc(["memory"], undefined, "city: 杭州\nlang: zh"), seg).systemPrompt ?? "";
  assert.ok(withMemory.startsWith("你是写代码的助手。"), withMemory);
  assert.ok(withMemory.includes("city: 杭州\nlang: zh"), withMemory);
  const without = buildContext(proc([]), seg).systemPrompt ?? "";
  assert.ok(without.startsWith("你是写代码的助手。"), without);
});

test("工具按预设的 tools 选出，self 总在", () => {
  assert.deepEqual(names(proc([])), ["self"]);
  assert.deepEqual(names(proc(["read"])), ["read", "self"]);
  assert.deepEqual(names(proc(["bash", "edit", "read", "write"])), ["bash", "edit", "read", "self", "write"]);
  assert.deepEqual(names(proc(["memory"])), ["memory_delete", "memory_get", "memory_set", "self"]);
  assert.deepEqual(names(proc(["read", "write", "edit", "bash", "memory"])), ["bash", "edit", "memory_delete", "memory_get", "memory_set", "read", "self", "write"]);
  for (const t of buildContext(proc(["read", "memory"]), seg).tools ?? []) {
    assert.deepEqual(Object.keys(t).sort(), ["description", "name", "parameters"], "请求里只放 pi-ai 的工具定义");
  }
});

test("工具描述标明库内还是库外：记忆工具和 self 在库内，其余在库外", () => {
  const all = toolsFor(preset({ tools: ["read", "write", "edit", "bash", "memory"] }));
  assert.deepEqual(Object.fromEntries(all.map((t) => [t.name, t.inStore])), {
    read: false,
    write: false,
    edit: false,
    bash: false,
    memory_get: true,
    memory_set: true,
    memory_delete: true,
    self: true,
  });
  const bare = preset({ tools: ["read"] });
  assert.equal(findTool(bare, "read")?.name, "read");
  assert.equal(findTool(bare, "self")?.name, "self");
  assert.equal(findTool(bare, "bash"), undefined, "预设里没有的工具");
  assert.equal(findTool(bare, "memory_get"), undefined, "没有记忆库就没有记忆工具");
  assert.equal(findTool(bare, "grep"), undefined, "不认识的工具");
});

test("消息就是工作段；用途是 handoff 时末尾加一条不入库的交接指令，前缀不变", () => {
  const turn = buildContext(proc(["read"]), done);
  assert.deepEqual(turn.messages, done);

  const handoff = buildContext(proc(["read"], HANDOFF), done);
  assert.equal(handoff.messages.length, done.length + 1, "段末没有用户消息：什么都不去掉");
  assert.deepEqual(handoff.messages.slice(0, done.length), done);
  assert.deepEqual(handoff.messages.at(-1), { role: "user", content: HANDOFF_INSTRUCTION, timestamp: 3 });
  assert.equal(handoff.systemPrompt, turn.systemPrompt);
  assert.deepEqual(handoff.tools, turn.tools, "交接调用带同样的工具，提示缓存继续有效");

  // 交接指令：不调用工具，写出目标、进展、下一步、未完成的事；段末的用户消息会原样附在说明后面。
  for (const word of ["不要调用任何工具", "目标", "下一步", "还没完成", "原样附在说明后面"]) assert.ok(HANDOFF_INSTRUCTION.includes(word), word);
});

test("交接请求去掉段末连续的用户消息，但不去掉第一条", () => {
  const tailed: readonly Message[] = deepFreeze([...done, { role: "user", content: "甲", timestamp: 4 }, { role: "user", content: "乙", timestamp: 5 }]);
  const req = buildContext(proc(["read"], HANDOFF), tailed);
  assert.deepEqual(req.messages, [...done, { role: "user", content: HANDOFF_INSTRUCTION, timestamp: 3 }], "指令的时间戳取保留的最后一条");
  assert.equal(tailStart(tailed), done.length);
  assert.equal(tailStart(done), done.length);

  // 整段都是用户消息：保留第一条，它是写交接说明的依据。
  assert.deepEqual(buildContext(proc(["read"], HANDOFF), seg).messages, [seg[0], { role: "user", content: HANDOFF_INSTRUCTION, timestamp: 1 }]);
  assert.equal(tailStart(seg), 1);
  assert.equal(tailStart([]), 0);
  assert.deepEqual(buildContext(proc(["read"], HANDOFF), []).messages, [{ role: "user", content: HANDOFF_INSTRUCTION, timestamp: 0 }], "段空时取 createdAt");
});

test("memory_set 的说明引用三个上限", () => {
  const text = findTool(preset({ tools: ["memory"] }), "memory_set")?.description ?? "";
  for (const n of [MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES]) assert.ok(text.includes(`${n} 字节`), text);
  assert.deepEqual([MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES], [128, 4096, 16384]);
});

test("idle 和 awaitingTool 时也不加交接指令", () => {
  assert.deepEqual(buildContext(proc(["read"], { tag: "idle", ended: "done" }), seg).messages, seg);
  assert.deepEqual(buildContext(proc(["read"], { tag: "awaitingTool", turn: { steps: 1, queued: [] } }), seg).messages, seg);
});
