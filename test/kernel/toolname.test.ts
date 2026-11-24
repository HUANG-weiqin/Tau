// 工具名解析（D109）：精确优先；写法不同时恰好对上一个内置工具才照做；handoff 只认原名；别家的名字不做别名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTool, renamed, unknownTool } from "../../src/kernel/tools.ts";
import type { PresetTool, ToolDef } from "../../src/kernel/types.ts";
import { preset } from "./helpers.ts";

const TOOLS: PresetTool[] = ["read", "write", "edit", "bash", "memory", "agents"];
const FULL = preset({ tools: TOOLS });
const DEF = (name: string): ToolDef => ({ name, description: name, parameters: { type: "object", properties: {} }, command: "echo", timeout: 30, output: "content" });
const found = (p: ReturnType<typeof preset>, name: string) => findTool(p, name)?.name;

test("一字不差的名字永远先用；大小写、空白、分隔符、供应商的前缀和序号后缀照做", () => {
  for (const [name, want] of [
    ["read", "read"], ["Read", "read"], ["BASH", "bash"], [" bash", "bash"], ["read\n", "read"], ["Memory_Get", "memory_get"], ["memoryGet", "memory_get"],
    ["Stop_Process", "stop_process"], ["Self", "self"], ["functions.read", "read"], ["functions.Read", "read"], ["default_api.read", "read"], ["default_api:read", "read"],
    ["functions.bash:0", "bash"], ["read:0", "read"], ["handoff", "handoff"], ["Handoff", "handoff"], ["functions.handoff:0", "handoff"], ["handoff ", "handoff"],
  ] as const) assert.equal(found(FULL, name), want, JSON.stringify(name));
});

test("别家的名字不做别名；别的前缀不去（sandbox.bash 不是 bash）；空串不对上任何工具", () => {
  for (const name of ["read_file", "shell", "Grep", "TodoWrite", "multi_tool_use.parallel", "sandbox.bash", "fs.write", "obsidian:read", ""]) assert.equal(findTool(FULL, name), undefined, JSON.stringify(name));
});

test("handoff 也解析：供应商带进来的前缀和空白模型自己改不掉，不解析就永远换不了段；工具定义叫 Handoff 时精确调用跑定义", () => {
  assert.equal(found(FULL, "default_api:handoff"), "handoff");
  const p = preset({ tools: ["read"], toolDefs: [DEF("Handoff")] });
  assert.equal(found(p, "Handoff"), "Handoff");
  assert.equal(found(p, "handoff"), "handoff");
  assert.equal(found(p, "HANDOFF"), undefined, "两个都对得上：有歧义，不猜");
});

test("只在预设有的工具里找；预设里没有的不兜底", () => {
  assert.equal(findTool(preset({ tools: ["read"] }), "Bash"), undefined);
  assert.equal(found(preset({ tools: ["read"] }), "Read"), "read");
});

test("工具定义的名字照旧要一字不差：写法接近的内置工具或工具定义都不会被它顶替", () => {
  const p = preset({ tools: ["read", "bash"], toolDefs: [DEF("web_search"), DEF("Bash")] });
  assert.equal(found(p, "WebSearch"), undefined, "不解析到工具定义");
  assert.equal(found(p, "web_search"), "web_search");
  assert.equal(found(p, "Bash"), "Bash", "精确匹配优先：工具定义可以就叫 Bash");
  assert.equal(found(p, "bash"), "bash");
  assert.equal(found(p, "BASH"), undefined, "两个都对得上：有歧义，不猜");
  assert.equal(found(preset({ tools: ["read"], toolDefs: [DEF("Task")] }), "task"), undefined);
});

test("工具定义只去掉开头的 functions.、default_api. 和结尾的 :数字，再一字不差地对（K1）", () => {
  const p = preset({ tools: ["read", "bash"], toolDefs: [DEF("web_search"), DEF("Web_Search2")] });
  for (const name of ["functions.web_search:0", "default_api.web_search", "web_search:12", "functions.web_search"]) assert.equal(found(p, name), "web_search", name);
  for (const name of ["Web_Search", "functions.WEB_SEARCH:0", "sandbox.web_search", "web_search:x", " web_search", "default_api:web_search"]) assert.equal(found(p, name), undefined, name);
  assert.equal(found(p, "functions.Web_Search2:1"), "Web_Search2");
  assert.deepEqual(renamed("functions.web_search:0", findTool(p, "functions.web_search:0")!), ['工具名 "functions.web_search:0" 当作 web_search']);
});

test("renamed：名字不同才有说明，名字用 JSON 引号写，空白看得见", () => {
  const read = findTool(FULL, "read")!;
  assert.deepEqual(renamed("read", read), []);
  assert.deepEqual(renamed("Read", read), ['工具名 "Read" 当作 read']);
  assert.deepEqual(renamed("read ", read), ['工具名 "read " 当作 read']);
});

test("找不到时的话：列出可用的工具，要求照抄，有 bash 时点名用 bash，最后说怎样结束一轮", () => {
  const text = unknownTool(preset({ tools: ["read", "bash"] }), "Grep");
  assert.equal(text, '工具 "Grep" 不存在，或者预设里没有它。可用的工具：read、bash、self、handoff。工具名要从这里照抄，一字不差。列表外的工具都调不通，不要再调用它。grep、ls、find、python、curl 这类命令，用 bash 运行。要结束这一轮或者提问，直接写回复，不调用工具。');
  assert.doesNotMatch(unknownTool(preset({ tools: ["read"] }), "Grep"), /用 bash 运行/, "预设没开 bash 就不提 bash");
});

test("换段的判断经过 findTool：functions.handoff:0 的成功调用也算主动换段（D109）", async () => {
  const { handoffRequested } = await import("../../src/kernel/derive.ts");
  const call = (name: string) => ({ type: "toolCall" as const, id: "c1", name, arguments: {} });
  const seg = (name: string, isError = false) => [
    { role: "user" as const, content: "x", timestamp: 1 },
    { role: "assistant" as const, content: [call(name)], api: "faux", provider: "faux", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: 2 },
    { role: "toolResult" as const, toolCallId: "c1", toolName: name, content: [{ type: "text" as const, text: "ok" }], isError, timestamp: 3 },
  ];
  assert.equal(handoffRequested(seg("handoff"), FULL), true);
  assert.equal(handoffRequested(seg("functions.handoff:0"), FULL), true);
  assert.equal(handoffRequested(seg("Handoff", true), FULL), false, "结果是错误不算");
  assert.equal(handoffRequested(seg("read"), FULL), false);
});
