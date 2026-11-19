// buildContext 和工具描述（设计稿第 4.3 节、第 10 节）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, CONTEXT_HEADING, HANDOFF_INSTRUCTION, MEMORY_HEADING, tailStart, toolDescriptions } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import { findTool, MEMORY_BRIEF_MAX_BYTES, MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES, toolsFor } from "../../src/kernel/tools.ts";
import type { Message, Phase, PresetTool, Process, ToolDef } from "../../src/kernel/types.ts";
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
const HANDOFF: Phase = { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 0, replyTo: [] }, purpose: "handoff" };

function proc(tools: PresetTool[], phase: Phase = { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" }, memoryView = ""): Process {
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

test("工具按预设的 tools 选出，self 和 handoff 总在", () => {
  assert.deepEqual(names(proc([])), ["handoff", "self"]);
  assert.deepEqual(names(proc(["read"])), ["handoff", "read", "self"]);
  assert.deepEqual(names(proc(["bash", "edit", "read", "write"])), ["bash", "edit", "handoff", "read", "self", "write"]);
  assert.deepEqual(names(proc(["memory"])), ["handoff", "memory_delete", "memory_edit", "memory_get", "memory_set", "self"]);
  assert.deepEqual(names(proc(["read", "write", "edit", "bash", "memory"])), ["bash", "edit", "handoff", "memory_delete", "memory_edit", "memory_get", "memory_set", "read", "self", "write"]);
  for (const t of buildContext(proc(["read", "memory"]), seg).tools ?? []) {
    assert.deepEqual(Object.keys(t).sort(), ["description", "name", "parameters"], "请求里只放 pi-ai 的工具定义");
  }
});

test("工具描述标明库内还是库外：记忆工具、self 和 handoff 在库内，其余在库外", () => {
  const all = toolsFor(preset({ tools: ["read", "write", "edit", "bash", "memory"] }));
  assert.deepEqual(Object.fromEntries(all.map((t) => [t.name, t.inStore])), {
    read: false,
    write: false,
    edit: false,
    bash: false,
    memory_get: true,
    memory_set: true,
    memory_edit: true,
    memory_delete: true,
    self: true,
    handoff: true,
  });
  const bare = preset({ tools: ["read"] });
  assert.equal(findTool(bare, "read")?.name, "read");
  assert.equal(findTool(bare, "self")?.name, "self");
  assert.equal(findTool(bare, "handoff")?.name, "handoff");
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

test("记忆索引这一节的标题和说明", () => {
  assert.equal(MEMORY_HEADING, "\n\n## 记忆索引（开段时的快照）\n\n每行：键 | 更新日期（UTC） | 值的字节数 | 摘要。要看值，用 memory_get。\n\n");
  assert.notEqual(MEMORY_HEADING, CONTEXT_HEADING);
});

test("memory_set 的说明引用四个上限、key、value、brief 都必填，还写了 tmp. 前缀的约定", () => {
  const spec = findTool(preset({ tools: ["memory"] }), "memory_set")!;
  const text = spec.description;
  for (const n of [MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_BRIEF_MAX_BYTES, MEMORY_VIEW_MAX_BYTES]) assert.ok(text.includes(`${n} 字节`), text);
  assert.deepEqual([MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_BRIEF_MAX_BYTES, MEMORY_VIEW_MAX_BYTES], [128, 4096, 200, 32768]);
  assert.ok(text.includes("摘要显示在每次开段的记忆索引里，值改了就一起改摘要"), text);
  assert.ok(text.includes("tmp."), text);
  const schema = spec.parameters as unknown as { properties: Record<string, { type: string; description: string }>; required: string[] };
  assert.deepEqual(Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.type])), { key: "string", value: "string", brief: "string", version: "integer" });
  assert.deepEqual(schema.required, ["key", "value", "brief"]);
  assert.equal(schema.properties.brief?.description, "摘要，一句话说清这个值是什么、什么时候该读它");
});

test("memory_get 的说明：系统提示词里的记忆索引是快照，每行只有摘要", () => {
  const text = findTool(preset({ tools: ["memory"] }), "memory_get")!.description;
  assert.ok(text.includes("值、摘要、更新日期和版本号"), text);
  assert.ok(text.includes("记忆索引是开段时的快照，每行只有摘要"), text);
  assert.ok(text.includes("要看值，或拿到最新版本号，用这个工具"), text);
});

test("idle 和 awaitingTool 时也不加交接指令", () => {
  assert.deepEqual(buildContext(proc(["read"], { tag: "idle", ended: "done" }), seg).messages, seg);
  assert.deepEqual(buildContext(proc(["read"], { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } }), seg).messages, seg);
});

test("agents 组：post、spawn、stop_process 在库内，参数照设计稿 5.3，预设里没有 agents 就没有它们", () => {
  assert.deepEqual(names(proc(["agents"])), ["handoff", "post", "self", "spawn", "stop_process"]);
  const p = preset({ tools: ["agents"] });
  const params = (name: string) => {
    const spec = findTool(p, name)!;
    assert.equal(spec.inStore, true, `${name} 是库内工具`);
    const schema = spec.parameters as unknown as { properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    return { properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.type])), required: schema.required };
  };
  assert.deepEqual(params("post"), { properties: { to: "string", text: "string", reply: "boolean" }, required: ["to", "text"] });
  assert.deepEqual(params("spawn"), { properties: { preset: "string", text: "string", workdir: "string" }, required: ["preset", "text"] });
  assert.deepEqual(params("stop_process"), { properties: { process: "string" }, required: ["process"] });
  // post 和 spawn 的说明写明回信的三件事。
  for (const name of ["post", "spawn"]) {
    const d = findTool(p, name)!.description;
    assert.ok(d.includes("只在处理这封信的那一轮结束时回信一次，之后的几轮不回"), `${name}：只回一轮`);
    assert.ok(d.includes("同一轮里处理了你的几封信时，只回一封"), `${name}：同一轮只回一封`);
    assert.ok(d.includes("结束本轮去等别的事时，等你回信的进程会立刻收到你这时的回复"), `${name}：结束本轮去等别的事`);
  }
  assert.equal(findTool(preset({ tools: ["read"] }), "post"), undefined);
});

const DEF = (name: string, description = `工具 ${name}`): ToolDef => ({ name, description, parameters: { type: "object", properties: { x: { type: "string" } } }, command: `echo ${name}`, timeout: 30, output: "content" });

test("工具定义排在内置工具之后，按预设 tools 里的顺序；都是库外工具", () => {
  const p = preset({ tools: ["agents", "read", "memory"], toolDefs: [DEF("zeta"), DEF("alpha")] });
  const order = toolsFor(p).map((t) => t.name);
  assert.deepEqual(order, ["read", "memory_get", "memory_set", "memory_edit", "memory_delete", "post", "spawn", "stop_process", "self", "handoff", "zeta", "alpha"]);
  assert.deepEqual(toolsFor(p).slice(-2).map((t) => t.inStore), [false, false]);
  assert.equal(findTool(p, "zeta")?.inStore, false);
  assert.equal(findTool(preset({ tools: ["read"] }), "zeta"), undefined, "没写进预设的定义不存在");
  assert.deepEqual(toolsFor(preset({ tools: [], toolDefs: [DEF("only")] })).map((t) => t.name), ["self", "handoff", "only"]);
});

test("请求里的工具描述只放名称、说明、参数；command、timeout、output 不给模型", () => {
  const p: Process = { ...start("p", preset({ tools: ["read"], toolDefs: [DEF("notes", "写笔记")] }), env(0)), lastEffect: 1, phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" } };
  const tools = buildContext(p, seg).tools ?? [];
  assert.deepEqual(tools.at(-1), { name: "notes", description: "写笔记", parameters: DEF("notes").parameters });
  assert.deepEqual(toolDescriptions(p.preset), tools);
  assert.equal(JSON.stringify(tools).includes("echo notes"), false);
});
