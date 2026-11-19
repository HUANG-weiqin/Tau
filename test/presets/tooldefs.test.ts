// 工具定义的格式和读取（设计稿 5.5）：每条规则、名字、重名、两个大小上限。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolsFor } from "../../src/kernel/tools.ts";
import { loadToolDef, loadToolDefs, TOOL_DEF_MAX_BYTES, TOOL_DEFS_MAX_BYTES } from "../../src/presets/tooldefs.ts";

let dir = "";

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tau-tooldefs-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARAMS = { type: "object", properties: { text: { type: "string" } }, additionalProperties: false };
const GOOD = { description: "写笔记", parameters: PARAMS, command: "node notes.mjs write" };

function put(name: string, def: unknown, raw = false): void {
  writeFileSync(path.join(dir, `${name}.json`), raw ? String(def) : JSON.stringify(def), "utf8");
}

/** 写一个定义，再读它：返回读出的结果或错误信息。 */
function load(name: string, def: unknown): { def?: ReturnType<typeof loadToolDef>; error?: string } {
  put(name, def);
  try {
    return { def: loadToolDef(dir, name) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

test("只写必填项：timeout 默认 120，output 默认 text，名字是文件名", () => {
  assert.deepEqual(load("notes", GOOD).def, { name: "notes", description: "写笔记", parameters: PARAMS, command: "node notes.mjs write", timeout: 120, output: "text" });
});

test("可选项都写上：原样读出", () => {
  assert.deepEqual(load("full", { ...GOOD, timeout: 600, output: "content" }).def, { name: "full", ...GOOD, timeout: 600, output: "content" });
  assert.equal(load("one", { ...GOOD, timeout: 1 }).def?.timeout, 1);
});

test("开头的 BOM 忽略", () => {
  writeFileSync(path.join(dir, "bom.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(GOOD))]));
  assert.equal(loadToolDef(dir, "bom").command, GOOD.command);
});

test("名字：匹配 ^[A-Za-z0-9_-]{1,64}$，64 个字符可以，65 个不行", () => {
  for (const bad of ["", "a b", "a.b", "a/b", "a\\b", "../x", "中文", "x".repeat(65)]) assert.throws(() => loadToolDef(dir, bad), /工具名不合法/, JSON.stringify(bad));
  const long = "x".repeat(64);
  assert.equal(load(long, GOOD).def?.name, long);
  assert.equal(load("A_b-1", GOOD).def?.name, "A_b-1");
});

test("名字按目录项精确匹配：大小写不同、没有文件都找不到", () => {
  put("exact", GOOD);
  assert.equal(loadToolDef(dir, "exact").name, "exact");
  assert.throws(() => loadToolDef(dir, "Exact"), /找不到工具定义：Exact/);
  assert.throws(() => loadToolDef(dir, "ghost"), /找不到工具定义：ghost/);
  assert.throws(() => loadToolDef(path.join(dir, "no-such-dir"), "exact"), /找不到工具定义：exact/);
});

test("不能和内置工具、工具组重名", () => {
  for (const name of ["read", "write", "edit", "bash", "self", "handoff", "post", "spawn", "stop_process", "memory_get", "memory_set", "memory_edit", "memory_delete", "memory", "agents"]) {
    put(name, GOOD);
    assert.throws(() => loadToolDef(dir, name), /重名/, name);
  }
  assert.equal(load("memory_x", GOOD).def?.name, "memory_x", "只是前缀相同不算重名");
  // 保留名单由 toolsFor 算出，不另写一份：内核加一个内置工具，这里不用改，定义也不能叫那个名字（D89 的 memory_edit）。
  const builtin = toolsFor({ tools: ["read", "write", "edit", "bash", "memory", "agents"], toolDefs: [] }).map((t) => t.name);
  assert.ok(builtin.includes("memory_edit"), builtin.join("、"));
  for (const name of builtin) {
    put(name, GOOD);
    assert.throws(() => loadToolDef(dir, name), /重名/, name);
  }
});

test("JSON 读不出、不是对象，都报错", () => {
  put("broken", "{ nope", true);
  assert.throws(() => loadToolDef(dir, "broken"), /broken 不是合法的 JSON/);
  for (const [name, text] of [["arr", "[]"], ["nul", "null"], ["num", "3"], ["str", '"x"']] as const) {
    put(name, text, true);
    assert.throws(() => loadToolDef(dir, name), /必须是 JSON 对象/, name);
  }
});

test("有别的字段就报错", () => {
  assert.match(load("extra", { ...GOOD, cwd: "E:/" }).error ?? "", /未知字段：cwd/);
});

for (const key of ["description", "parameters", "command"]) {
  test(`缺 ${key} 报错`, () => {
    const { [key as keyof typeof GOOD]: _, ...rest } = GOOD;
    assert.match(load(`miss-${key}`, rest).error ?? "", new RegExp(key));
  });
}

test("description 和 command 必须是字符串；空串可以", () => {
  assert.match(load("d-num", { ...GOOD, description: 1 }).error ?? "", /description/);
  assert.match(load("c-num", { ...GOOD, command: ["node"] }).error ?? "", /command/);
  assert.equal(load("d-empty", { ...GOOD, description: "" }).def?.description, "");
});

test("parameters 顶层必须是 type 为 object 的对象，内层不查", () => {
  for (const [name, parameters] of [["p-str", "x"], ["p-arr", []], ["p-null", null], ["p-str-type", { type: "string" }], ["p-notype", { properties: {} }]] as const) {
    assert.match(load(name, { ...GOOD, parameters }).error ?? "", /parameters/, name);
  }
  const weird = { type: "object", properties: { a: { type: "no-such-type" } }, required: 3 };
  assert.deepEqual(load("p-weird", { ...GOOD, parameters: weird }).def?.parameters, weird);
  assert.ok(load("p-min", { ...GOOD, parameters: { type: "object" } }).def);
});

test("timeout：1 到 600 的整数", () => {
  for (const bad of [0, -1, 601, 1.5, "120", null, NaN]) assert.match(load("t-bad", { ...GOOD, timeout: bad }).error ?? "", /timeout/, String(bad));
});

test("output：只能是 text 或 content", () => {
  for (const bad of ["json", "", "Text", 1, null]) assert.match(load("o-bad", { ...GOOD, output: bad }).error ?? "", /output/, String(bad));
  assert.equal(load("o-text", { ...GOOD, output: "text" }).def?.output, "text");
});

test("一个定义的大小：说明和参数的 JSON 不超过 16 KiB，按 UTF-8 字节算", () => {
  const sized = (bytes: number, ch: string) => {
    // { description, parameters } 的外壳是固定的；用 ASCII 填到刚好，再换成多字节字符。
    const fixed = Buffer.byteLength(JSON.stringify({ description: "", parameters: PARAMS }));
    return { ...GOOD, description: ch.repeat(Math.floor((bytes - fixed) / Buffer.byteLength(ch))) };
  };
  assert.equal(TOOL_DEF_MAX_BYTES, 16 * 1024);
  const edge = sized(TOOL_DEF_MAX_BYTES, "a");
  assert.equal(Buffer.byteLength(JSON.stringify({ description: edge.description, parameters: edge.parameters })), TOOL_DEF_MAX_BYTES);
  assert.ok(load("size-ok", edge).def, "刚好 16 KiB 可以");
  assert.match(load("size-bad", { ...edge, description: `${edge.description}a` }).error ?? "", /16384/, "多 1 字节不行");
  // 中文一个字 3 字节：按字符数算会放过它。
  const zh = sized(TOOL_DEF_MAX_BYTES + 3, "中");
  assert.ok(zh.description.length < TOOL_DEF_MAX_BYTES);
  assert.match(load("size-zh", zh).error ?? "", /上限 16384 字节/);
  // command 不算在一个定义的上限里。
  assert.ok(load("size-cmd", { ...edge, command: "x".repeat(5000) }).def);
});

test("一个预设用到的全部定义：每个 ToolDef 的 JSON 相加不超过 64 KiB，含 name、command 和默认值", () => {
  assert.equal(TOOL_DEFS_MAX_BYTES, 64 * 1024);
  // 4 个定义，每个的说明和参数 15 KiB 以内，总数超过 64 KiB。
  const names = ["g1", "g2", "g3", "g4"];
  const fixed = Buffer.byteLength(JSON.stringify({ description: "", parameters: PARAMS }));
  for (const n of names) put(n, { ...GOOD, description: "a".repeat(TOOL_DEF_MAX_BYTES - fixed) });
  const one = Buffer.byteLength(JSON.stringify(loadToolDef(dir, "g1")));
  assert.ok(one > TOOL_DEF_MAX_BYTES, "整个 ToolDef 比说明和参数大：多了 name、command 和默认值");
  assert.ok(3 * one <= TOOL_DEFS_MAX_BYTES && 4 * one > TOOL_DEFS_MAX_BYTES);
  assert.equal(loadToolDefs(dir, names.slice(0, 3)).length, 3, "三个刚好在上限内");
  assert.throws(() => loadToolDefs(dir, names), /共 \d+ 字节，上限 65536 字节/);
  assert.deepEqual(loadToolDefs(dir, []), []);
});

test("总大小刚好等于上限可以，多 1 字节不行；名字和 command 算在内", () => {
  const fixed = Buffer.byteLength(JSON.stringify({ description: "", parameters: PARAMS }));
  put("h1", { ...GOOD, description: "a".repeat(TOOL_DEF_MAX_BYTES - fixed) });
  put("h2", { ...GOOD, description: "a".repeat(TOOL_DEF_MAX_BYTES - fixed) });
  put("h3", { ...GOOD, description: "a".repeat(TOOL_DEF_MAX_BYTES - fixed) });
  const used = ["h1", "h2", "h3"].reduce((s, n) => s + Buffer.byteLength(JSON.stringify(loadToolDef(dir, n))), 0);
  const room = TOOL_DEFS_MAX_BYTES - used;
  assert.ok(room > 0);
  // 第四个：只靠 command 补到刚好。
  const base = Buffer.byteLength(JSON.stringify({ name: "h4", description: "", parameters: PARAMS, command: "", timeout: 120, output: "text" }));
  put("h4", { description: "", parameters: PARAMS, command: "c".repeat(room - base) });
  assert.equal(loadToolDefs(dir, ["h1", "h2", "h3", "h4"]).length, 4);
  put("h4", { description: "", parameters: PARAMS, command: "c".repeat(room - base + 1) });
  assert.throws(() => loadToolDefs(dir, ["h1", "h2", "h3", "h4"]), /上限 65536/);
});

test("loadToolDefs 按给的顺序读，任何一个读不出就整体失败", () => {
  put("o1", GOOD);
  put("o2", GOOD);
  assert.deepEqual(loadToolDefs(dir, ["o2", "o1"]).map((d) => d.name), ["o2", "o1"]);
  assert.throws(() => loadToolDefs(dir, ["o1", "nope"]), /找不到工具定义：nope/);
});
