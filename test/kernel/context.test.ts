// buildContext 和工具描述（设计稿第 4.3 节、第 10 节）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import { findTool, toolsFor } from "../../src/kernel/tools.ts";
import type { Message, Phase, PresetTool, Process } from "../../src/kernel/types.ts";
import { deepFreeze, env, preset } from "./helpers.ts";

const seg: readonly Message[] = deepFreeze([
  { role: "user", content: "你好", timestamp: 1 },
  { role: "user", content: "在吗", timestamp: 2 },
]);

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
  const turn = buildContext(proc(["read"]), seg);
  assert.deepEqual(turn.messages, seg);

  const handoff = buildContext(proc(["read"], { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" }), seg);
  assert.equal(handoff.messages.length, seg.length + 1);
  assert.deepEqual(handoff.messages.slice(0, seg.length), seg);
  const last = handoff.messages.at(-1);
  assert.ok(last?.role === "user" && last.content === HANDOFF_INSTRUCTION);
  assert.equal(seg.length, 2, "工作段没有被改动");
  assert.equal(handoff.systemPrompt, turn.systemPrompt);
  assert.deepEqual(handoff.tools, turn.tools, "交接调用带同样的工具，提示缓存继续有效");

  // 交接指令：不调用工具，写出目标、进展、下一步、未完成的事，原样引用最后一条还没回复的用户消息。
  for (const word of ["不要调用任何工具", "目标", "下一步", "还没完成", "原样引用"]) assert.ok(HANDOFF_INSTRUCTION.includes(word), word);
});

test("idle 和 awaitingTool 时也不加交接指令", () => {
  assert.deepEqual(buildContext(proc(["read"], { tag: "idle", ended: "done" }), seg).messages, seg);
  assert.deepEqual(buildContext(proc(["read"], { tag: "awaitingTool", turn: { steps: 1, queued: [] } }), seg).messages, seg);
});
