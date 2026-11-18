// 预设读取拆成 parsePresetFile 和 buildPreset（D71）：`context` 键的写法和校验（D72）、presetFields 还原、reconfigured 造新快照。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { buildPreset, CONTEXT_ITEM_MAX_CHARS, CONTEXT_ITEMS_MAX, loadPreset, presetFields, reconfigured } from "../../src/presets/load.ts";
import type { PresetSnapshot } from "../../src/kernel/types.ts";

const faux = fauxProvider({ models: [{ id: "m1", contextWindow: 123456 }, { id: "m2", contextWindow: 50_000 }] });
const models = createModels();
models.setProvider(faux.provider);
const m1 = `${faux.getModel("m1")!.provider}/m1`;
const m2 = `${faux.getModel("m2")!.provider}/m2`;

let root = "";
let work = "";
let tools = "";
let presets = "";

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tau-reconf-"));
  work = path.join(root, "work");
  tools = path.join(root, "tools");
  presets = path.join(root, "presets");
  for (const d of [work, tools, presets]) mkdirSync(d);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const toolDef = (description: string) => JSON.stringify({ description, parameters: { type: "object", properties: {} }, command: "node x.mjs" });

function write(id: string, lines: string[], body = "你是测试。"): void {
  writeFileSync(path.join(presets, `${id}.md`), ["---", `workdir: ${work}`, `model: ${m1}`, ...lines, "---", body].join("\n"), "utf8");
}

const load = (id: string): PresetSnapshot => loadPreset(presets, id, models, tools);
const message = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
};

// context 键

test("context：逗号分隔，去空白，跳空项，重复的去掉保留第一次的顺序；原样写进快照", () => {
  write("c1", ["tools: read", "context:  AGENTS.md , docs\\a.md,, AGENTS.md ,  ,..\\x.md"]);
  assert.deepEqual(load("c1").context, ["AGENTS.md", "docs\\a.md", "..\\x.md"]);
});

test("context：没写、写了但是空，都没有这个键", () => {
  write("c2", ["tools: read"]);
  assert.equal("context" in load("c2"), false);
  write("c3", ["tools: read", "context:"]);
  assert.equal("context" in load("c3"), false);
  write("c4", ["tools: read", "context: , ,"]);
  assert.equal("context" in load("c4"), false);
});

test("context：相对路径、盘符绝对路径、UNC 路径都认；只查写法，不查文件在不在", () => {
  write("c5", ["tools: read", "context: AGENTS.md, sub/dir/a.md, C:\\nowhere\\x.md, D:/y/z.md, \\\\server\\share\\k.md"]);
  assert.deepEqual(load("c5").context, ["AGENTS.md", "sub/dir/a.md", "C:\\nowhere\\x.md", "D:/y/z.md", "\\\\server\\share\\k.md"]);
});

test("context：不是相对路径也不是 Windows 绝对路径的，拒绝；/e/x 不认，只有盘符没有斜杠也不认", () => {
  for (const bad of ["/e/x", "\\x", "//", "C:x.md", "C:"]) {
    write("c6", ["tools: read", `context: ${bad}`]);
    assert.match(message(() => load("c6")), /^预设 c6 的 context 必须是相对路径或 Windows 绝对路径：/, bad);
  }
});

test("context：最多 8 项（去重以后），每项 1 到 260 个字符，不含控制字符", () => {
  const ok = Array.from({ length: CONTEXT_ITEMS_MAX }, (_, i) => `f${i}.md`);
  write("c7", ["tools: read", `context: ${ok.join(", ")}`]);
  assert.deepEqual(load("c7").context, ok);
  write("c7", ["tools: read", `context: ${[...ok, "f8.md"].join(", ")}`]);
  assert.match(message(() => load("c7")), /^预设 c7 的 context 最多 8 项：现在有 9 项$/);
  write("c7", ["tools: read", `context: ${[...ok, ...ok].join(", ")}`]);
  assert.deepEqual(load("c7").context, ok, "重复的先去掉，再数");

  write("c8", ["tools: read", `context: ${"a".repeat(CONTEXT_ITEM_MAX_CHARS)}`]);
  assert.equal(load("c8").context?.[0]?.length, CONTEXT_ITEM_MAX_CHARS);
  write("c8", ["tools: read", `context: ${"a".repeat(CONTEXT_ITEM_MAX_CHARS + 1)}`]);
  assert.match(message(() => load("c8")), /^预设 c8 的 context 每项 1 到 260 个字符：有一项是 261 个字符$/);
  write("c9", ["tools: read", "context: a\u0007b.md"]);
  assert.match(message(() => load("c9")), /^预设 c9 的 context 不能含控制字符/);
});

test("context 和别的键：重复的 context 行报重复字段；check 和 start 走同一条路（快照里带 context）", () => {
  write("c10", ["tools: read", "context: a.md", "context: b.md"]);
  assert.match(message(() => load("c10")), /^预设 c10 重复的字段：context$/);
  write("c11", ["tools: read", "thinking: high", "handoff: 5000", 'options: {"temperature":0.3}', "context: AGENTS.md"]);
  const s = load("c11");
  assert.deepEqual([s.thinking, s.handoff, s.options, s.context], ["high", 5000, { temperature: 0.3 }, ["AGENTS.md"]]);
});

// presetFields、buildPreset

test("presetFields：tools 是内置工具名加工具定义的名字；buildPreset(presetFields(s)) 得到同样的快照", () => {
  writeFileSync(path.join(tools, "notes.json"), toolDef("写笔记"));
  write("r1", ["tools: read, notes, bash", "thinking: low", "handoff: 4000", 'options: {"temperature":0.5,"cacheRetention":"long"}', "context: AGENTS.md, docs\\a.md"], "提示词\n第二行");
  const s = load("r1");
  assert.deepEqual(s.tools, ["read", "bash"]);
  assert.deepEqual(s.toolDefs.map((d) => d.name), ["notes"]);
  const f = presetFields(s);
  assert.deepEqual(f.tools, ["read", "bash", "notes"]);
  assert.deepEqual(f, { workdir: work, model: m1, tools: ["read", "bash", "notes"], prompt: "提示词\n第二行", thinking: "low", handoff: "4000", options: JSON.stringify({ temperature: 0.5, cacheRetention: "long" }), context: ["AGENTS.md", "docs\\a.md"] });
  assert.deepEqual(buildPreset("r1", f, models, tools), s);
  // 没有可选键时，字段里也没有。
  write("r2", ["tools: read"]);
  assert.deepEqual(Object.keys(presetFields(load("r2"))).sort(), ["model", "prompt", "tools", "workdir"]);
  assert.deepEqual(buildPreset("r2", presetFields(load("r2")), models, tools), load("r2"));
});

test("buildPreset 的拒绝和 loadPreset 的一字不差：同一个函数", () => {
  write("r3", ["tools: read"]);
  const f = presetFields(load("r3"));
  assert.match(message(() => buildPreset("r3", { ...f, workdir: "rel" }, models, tools)), /^预设 r3 的工作目录必须是绝对路径：rel$/);
  assert.match(message(() => buildPreset("r3", { ...f, workdir: path.join(root, "没有") }, models, tools)), /^预设 r3 的工作目录不存在：/);
  assert.match(message(() => buildPreset("r3", { ...f, model: "faux/nope" }, models, tools)), /^模型目录里没有 faux\/nope$/);
  assert.match(message(() => buildPreset("r3", { ...f, model: "x" }, models, tools)), /^预设 r3 的模型格式应为/);
  assert.match(message(() => buildPreset("r3", { ...f, tools: ["read", "missing"] }, models, tools)), /^找不到工具定义：missing$/);
  assert.match(message(() => buildPreset("r3", { ...f, thinking: "wild" }, models, tools)), /^预设 r3 的 thinking 只能是/);
  assert.match(message(() => buildPreset("r3", { ...f, handoff: "0" }, models, tools)), /^预设 r3 的 handoff 必须是正整数（token）：0$/);
});

// reconfigured

const base = (): PresetSnapshot => {
  writeFileSync(path.join(tools, "notes.json"), toolDef("写笔记 v1"));
  write("b", ["tools: read, notes", "thinking: low", "handoff: 4000", "context: AGENTS.md"]);
  return load("b");
};

/** 一个一碰就报错的模型目录：证明没有查它。 */
const noCatalog = { getModel: () => { throw new Error("不该查模型目录"); } } as unknown as Models;

test("reconfigured：只有调用参数时，不重读文件、不查模型目录；null 删掉这个键，其余结构性字段原样", () => {
  const s = base();
  rmSync(path.join(tools, "notes.json"));
  rmSync(work, { recursive: true });
  const t = reconfigured(s, { thinking: "high", handoff: 9000, options: { temperature: 0.2 } }, noCatalog, path.join(root, "没有这个目录"));
  assert.deepEqual(t, { ...s, thinking: "high", handoff: 9000, options: { temperature: 0.2 } });
  assert.deepEqual(reconfigured(s, { thinking: null, handoff: null, options: null }, noCatalog, tools), (({ thinking: _t, handoff: _h, ...rest }) => rest)(s));
  assert.equal("thinking" in reconfigured(s, { thinking: null }, noCatalog, tools), false);
  assert.equal("options" in reconfigured({ ...s, options: { temperature: 1 } }, { options: {} }, noCatalog, tools), false, "{} 等于没有");
  mkdirSync(work);
  writeFileSync(path.join(tools, "notes.json"), toolDef("写笔记 v1"));
});

test("reconfigured：有结构性字段时整个重建；工具定义文件重读（手动刷新）、模型目录重查", () => {
  const s = base();
  writeFileSync(path.join(tools, "notes.json"), toolDef("写笔记 v2"));
  // 把现在的 tools 原样发一次：刷新。
  const refreshed = reconfigured(s, { tools: ["read", "notes"] }, models, tools);
  assert.equal(s.toolDefs[0]?.description, "写笔记 v1");
  assert.equal(refreshed.toolDefs[0]?.description, "写笔记 v2");
  assert.deepEqual({ ...refreshed, toolDefs: s.toolDefs }, s);
  // 换模型：窗口和输入跟着目录变。
  const other = reconfigured(s, { model: m2 }, models, tools);
  assert.deepEqual([other.model, other.contextWindow], [m2, 50_000]);
  // 改提示词、工作目录、context、tools。
  const sub = path.join(root, "sub");
  mkdirSync(sub, { recursive: true });
  const t = reconfigured(s, { prompt: "新的。", workdir: sub, context: ["a.md", "b.md"], tools: ["read"] }, models, tools);
  assert.deepEqual([t.prompt, t.workdir, t.context, t.tools, t.toolDefs], ["新的。", sub, ["a.md", "b.md"], ["read"], []]);
  assert.equal(t.thinking, "low", "没改的调用参数原样");
  assert.equal("context" in reconfigured(s, { context: null }, models, tools), false);
  assert.equal("context" in reconfigured(s, { context: [] }, models, tools), false);
  // 调用参数和结构性字段一起：都套上。
  const both = reconfigured(s, { prompt: "p", thinking: null, handoff: 100 }, models, tools);
  assert.deepEqual([both.prompt, "thinking" in both, both.handoff], ["p", false, 100]);
});

test("reconfigured：校验用读预设的同一套，拒绝的文字一样；什么都不改（返回前就抛）", () => {
  const s = base();
  assert.match(message(() => reconfigured(s, { thinking: "wild" as never }, models, tools)), /^预设 b 的 thinking 只能是/);
  assert.match(message(() => reconfigured(s, { handoff: 0 }, models, tools)), /^预设 b 的 handoff 必须是正整数（token）：0$/);
  assert.match(message(() => reconfigured(s, { handoff: 1.5 }, models, tools)), /^预设 b 的 handoff 必须是正整数（token）：1\.5$/);
  assert.match(message(() => reconfigured(s, { handoff: -3 }, models, tools)), /^预设 b 的 handoff 必须是正整数/);
  assert.match(message(() => reconfigured(s, { options: { apiKey: "x" } }, models, tools)), /^预设 b 的 options 里的 apiKey 不能用：凭据，不能写进预设$/);
  assert.match(message(() => reconfigured(s, { options: { temperature: "热" } }, models, tools)), /^预设 b 的 options 里的 temperature 必须是有限数/);
  assert.match(message(() => reconfigured(s, { options: { metadata: { x: "a".repeat(5000) } } }, models, tools)), /^预设 b 的 options 超过 4096 字节$/);
  assert.match(message(() => reconfigured(s, { model: "faux/nope" }, models, tools)), /^模型目录里没有 faux\/nope$/);
  assert.match(message(() => reconfigured(s, { workdir: "rel" }, models, tools)), /^预设 b 的工作目录必须是绝对路径：rel$/);
  assert.match(message(() => reconfigured(s, { tools: ["read", "missing"] }, models, tools)), /^找不到工具定义：missing$/);
  assert.match(message(() => reconfigured(s, { context: ["/e/x"] }, models, tools)), /^预设 b 的 context 必须是相对路径或 Windows 绝对路径：/);
  assert.match(message(() => reconfigured(s, { context: ["a.md,b.md"] }, models, tools)), /^预设 b 的 context 的路径不能含逗号，首尾不能有空白：/);
  assert.match(message(() => reconfigured(s, { context: [" a.md"] }, models, tools)), /^预设 b 的 context 的路径不能含逗号，首尾不能有空白：/);
  assert.match(message(() => reconfigured(s, { context: [""] }, models, tools)), /^预设 b 的 context 每项 1 到 260 个字符：有一项是 0 个字符$/);
  assert.match(message(() => reconfigured(s, { context: Array.from({ length: 9 }, (_, i) => `f${i}`) }, models, tools)), /^预设 b 的 context 最多 8 项/);
});

test("reconfigured 以待换的为底：快照不变，结果由 target 和 fields 决定", () => {
  const s = base();
  const next = reconfigured(s, { prompt: "待换的提示词" }, models, tools);
  const again = reconfigured(next, { thinking: "high" }, noCatalog, tools);
  assert.deepEqual(again, { ...next, thinking: "high" });
  assert.equal(s.prompt, "你是测试。", "没有改传进去的快照");
});

test("buildPreset 的工具名去重不是平方级：十万个不同的名字，读第一个定义就失败，很快；重复的名字只读一次，顺序保持第一次出现", () => {
  const many = Array.from({ length: 100_000 }, (_, i) => `t${i}`);
  const t0 = Date.now();
  assert.equal(message(() => buildPreset("x", { workdir: work, model: m1, tools: many, prompt: "" }, models, tools)), "找不到工具定义：t0");
  assert.ok(Date.now() - t0 < 2_000, `用了 ${Date.now() - t0} 毫秒`);
  // 去重照旧：内置工具和工具定义都保留第一次出现的位置。
  writeFileSync(path.join(tools, "dd-b.json"), toolDef("b"));
  writeFileSync(path.join(tools, "dd-a.json"), toolDef("a"));
  const s = buildPreset("x", { workdir: work, model: m1, tools: ["dd-b", "read", "dd-a", "dd-b", "read", "bash", "dd-a"], prompt: "" }, models, tools);
  assert.deepEqual(s.tools, ["read", "bash"]);
  assert.deepEqual(s.toolDefs.map((d) => d.name), ["dd-b", "dd-a"]);
});
