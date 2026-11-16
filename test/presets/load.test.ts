import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { loadPreset } from "../../src/presets/load.ts";

const faux = fauxProvider({ models: [{ id: "m1", contextWindow: 123456 }, { id: "org/m2", contextWindow: 777 }] });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel(); // faux/m1
const modelStr = `${model.provider}/${model.id}`;

let root = "";
let work = "";
let toolsRoot = "";

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tau-presets-"));
  work = path.join(root, "work");
  mkdirSync(work);
  toolsRoot = path.join(root, "tools");
  mkdirSync(toolsRoot);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(id: string, text: string): string {
  writeFileSync(path.join(root, `${id}.md`), text, "utf8");
  return root;
}

function front(lines: string[], body: string[] = ["你是测试。"], eol = "\n"): string {
  return ["---", ...lines, "---", ...body].join(eol);
}

function valid(extra: string[] = [], eol = "\n"): string {
  return front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, bash", ...extra], ["你是测试。", "第二行"], eol);
}

test("valid preset with LF line endings", () => {
  const dir = write("lf", valid());
  assert.deepEqual(loadPreset(dir, "lf", models, toolsRoot), {
    id: "lf",
    workdir: work,
    model: modelStr,
    tools: ["read", "bash"],
    toolDefs: [],
    prompt: "你是测试。\n第二行",
    contextWindow: 123456,
    input: ["text", "image"],
  });
});

test("valid preset with CRLF line endings", () => {
  const dir = write("crlf", valid([], "\r\n"));
  assert.deepEqual(loadPreset(dir, "crlf", models, toolsRoot), {
    id: "crlf",
    workdir: work,
    model: modelStr,
    tools: ["read", "bash"],
    toolDefs: [],
    prompt: "你是测试。\n第二行",
    contextWindow: 123456,
    input: ["text", "image"],
  });
});

test("workdir value containing a colon is kept whole", () => {
  assert.ok(work.includes(":"), "temp path should contain a drive colon on Windows");
  const dir = write("colon", valid());
  assert.equal(loadPreset(dir, "colon", models, toolsRoot).workdir, work);
});

test("model id may contain a slash", () => {
  const m2 = faux.getModel("org/m2");
  assert.ok(m2);
  const dir = write("slash", front([`workdir: ${work}`, "model: faux/org/m2", "tools:"]));
  const snap = loadPreset(dir, "slash", models, toolsRoot);
  assert.equal(snap.model, "faux/org/m2");
  assert.equal(snap.contextWindow, 777);
});

test("empty tools means no tools; empty prompt allowed", () => {
  const dir = write("notools", front([`workdir: ${work}`, `model: ${modelStr}`, "tools:"], []));
  const snap = loadPreset(dir, "notools", models, toolsRoot);
  assert.deepEqual(snap.tools, []);
  assert.equal(snap.prompt, "");
});

test("duplicate tools are removed, first-seen order kept", () => {
  const dir = write("dup", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, bash, read, memory, bash"]));
  assert.deepEqual(loadPreset(dir, "dup", models, toolsRoot).tools, ["read", "bash", "memory"]);
});

test("unknown key is an error", () => {
  const dir = write("unk", valid(["color: red"]));
  assert.throws(() => loadPreset(dir, "unk", models, toolsRoot), /color/);
});

test("duplicate key is an error", () => {
  const dir = write("dupkey", valid([`workdir: ${work}`]));
  assert.throws(() => loadPreset(dir, "dupkey", models, toolsRoot), /workdir/);
});

for (const key of ["workdir", "model", "tools"]) {
  test(`missing key ${key} is an error`, () => {
    const all: Record<string, string> = { workdir: `workdir: ${work}`, model: `model: ${modelStr}`, tools: "tools: read" };
    const lines = Object.entries(all).filter(([k]) => k !== key).map(([, v]) => v);
    const dir = write(`miss-${key}`, front(lines));
    assert.throws(() => loadPreset(dir, `miss-${key}`, models, toolsRoot), new RegExp(key));
  });
}

test("bad tool name is an error", () => {
  const dir = write("badtool", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, sudo"]));
  assert.throws(() => loadPreset(dir, "badtool", models, toolsRoot), /sudo/);
});

test("model without a slash is an error", () => {
  const dir = write("noslash", front([`workdir: ${work}`, "model: m1", "tools:"]));
  assert.throws(() => loadPreset(dir, "noslash", models, toolsRoot), /<provider>\/<model-id>/);
});

test("model not in catalog is an error", () => {
  const dir = write("nomodel", front([`workdir: ${work}`, "model: faux/nope", "tools:"]));
  assert.throws(() => loadPreset(dir, "nomodel", models, toolsRoot), /模型目录里没有 faux\/nope/);
});

test("missing workdir directory is an error", () => {
  const dir = write("nodir", front([`workdir: ${path.join(work, "nope")}`, `model: ${modelStr}`, "tools:"]));
  assert.throws(() => loadPreset(dir, "nodir", models, toolsRoot), /工作目录不存在/);
});

test("missing file is an error naming the preset", () => {
  assert.throws(() => loadPreset(root, "ghost", models, toolsRoot), /ghost/);
});

test("id must match the file name exactly (case variants rejected)", () => {
  write("assistant", valid());
  assert.equal(loadPreset(root, "assistant", models, toolsRoot).id, "assistant");
  assert.throws(() => loadPreset(root, "Assistant", models, toolsRoot), /找不到预设：Assistant/);
});

for (const [name, line] of [
  ["empty", "workdir:"],
  ["dot", "workdir: ."],
  ["relative", "workdir: relative/dir"],
  ["drive-less slash", "workdir: /foo"],
  ["drive-less backslash", "workdir: \\foo"],
] as const) {
  test(`workdir that is ${name} must be absolute`, () => {
    const dir = write(`rel-${name}`, front([line, `model: ${modelStr}`, "tools:"]));
    assert.throws(() => loadPreset(dir, `rel-${name}`, models, toolsRoot), /工作目录必须是绝对路径/);
  });
}

test("UTF-8 BOM is ignored", () => {
  const body = Buffer.from(valid(), "utf8");
  writeFileSync(path.join(root, "bom.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  writeFileSync(path.join(root, "nobom.md"), body);
  const withBom = loadPreset(root, "bom", models, toolsRoot);
  const without = loadPreset(root, "nobom", models, toolsRoot);
  assert.deepEqual({ ...withBom, id: "" }, { ...without, id: "" });
  assert.equal(withBom.id, "bom");
});

test("bad preset ids are rejected", () => {
  for (const id of ["../x", "a/b", "a\\b", "a:b", ""]) {
    assert.throws(() => loadPreset(root, id, models, toolsRoot), /预设 ID 不合法/, id);
  }
});

test("missing opening --- is an error", () => {
  const dir = write("noopen", `workdir: ${work}\nmodel: ${modelStr}\ntools:\n---\n正文`);
  assert.throws(() => loadPreset(dir, "noopen", models, toolsRoot), /开头的 ---/);
});

test("missing closing --- is an error", () => {
  const dir = write("noclose", `---\nworkdir: ${work}\nmodel: ${modelStr}\ntools:\n正文`);
  assert.throws(() => loadPreset(dir, "noclose", models, toolsRoot), /结束的 ---/);
});

test("thinking is optional: absent means the snapshot has no thinking key", () => {
  const snap = loadPreset(write("nothink", valid()), "nothink", models, toolsRoot);
  assert.equal("thinking" in snap, false);
});

for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
  test(`thinking ${level} is frozen into the snapshot`, () => {
    const snap = loadPreset(write(`think-${level}`, valid([`thinking: ${level}`])), `think-${level}`, models, toolsRoot);
    assert.equal(snap.thinking, level);
  });
}

for (const bad of ["", "off", "none", "High", "ultra"]) {
  test(`thinking "${bad}" is an error that names the allowed values`, () => {
    const id = `badthink-${bad || "empty"}`;
    assert.throws(() => loadPreset(write(id, valid([`thinking: ${bad}`])), id, models, toolsRoot), /thinking.*minimal, low, medium, high, xhigh, max/);
  });
}

test("duplicate thinking is an error", () => {
  assert.throws(() => loadPreset(write("dupthink", valid(["thinking: low", "thinking: high"])), "dupthink", models, toolsRoot), /thinking/);
});

test("handoff is optional: absent means the snapshot has no handoff key", () => {
  const snap = loadPreset(write("nohandoff", valid()), "nohandoff", models, toolsRoot);
  assert.equal("handoff" in snap, false);
});

test("handoff is frozen into the snapshot as a number", () => {
  const snap = loadPreset(write("handoff-ok", valid(["handoff: 50000"])), "handoff-ok", models, toolsRoot);
  assert.equal(snap.handoff, 50000);
  // 比算出的阈值大也照样冻结：取较小的是阈值函数的事。
  assert.equal(loadPreset(write("handoff-big", valid(["handoff: 99999999"])), "handoff-big", models, toolsRoot).handoff, 99999999);
});

for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "1_000", "0x10", "+5", "007", "99999999999999999"]) {
  test(`handoff "${bad}" is an error`, () => {
    const id = `badhandoff-${bad || "empty"}`;
    assert.throws(() => loadPreset(write(id, valid([`handoff: ${bad}`])), id, models, toolsRoot), /handoff 必须是正整数/);
  });
}

test("duplicate handoff is an error", () => {
  assert.throws(() => loadPreset(write("duphandoff", valid(["handoff: 1000", "handoff: 2000"])), "duphandoff", models, toolsRoot), /handoff/);
});

test("agents is a known tool, kept in order", () => {
  const dir = write("agents", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, agents, memory"]));
  assert.deepEqual(loadPreset(dir, "agents", models, toolsRoot).tools, ["read", "agents", "memory"]);
});

// 工具定义（设计稿 5.5）：预设的 tools 里不是内置工具的名字，都按工具定义读，冻结进快照的 toolDefs。

function putDef(name: string, extra: object = {}): void {
  writeFileSync(path.join(toolsRoot, `${name}.json`), JSON.stringify({ description: `工具 ${name}`, parameters: { type: "object" }, command: `echo ${name}`, ...extra }), "utf8");
}

test("tools 里的工具定义名读进 toolDefs，按写的顺序，和内置工具混写、去重", () => {
  putDef("zeta");
  putDef("alpha", { timeout: 5, output: "content" });
  const dir = write("defs", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: zeta, read, alpha, memory, zeta"]));
  const snap = loadPreset(dir, "defs", models, toolsRoot);
  assert.deepEqual(snap.tools, ["read", "memory"], "内置工具不含工具定义的名字");
  assert.deepEqual(snap.toolDefs.map((d) => [d.name, d.timeout, d.output]), [["zeta", 120, "text"], ["alpha", 5, "content"]]);
});

test("没用工具定义时 toolDefs 是空数组；工具定义目录不存在也不要紧", () => {
  const dir = write("nodefs", valid());
  assert.deepEqual(loadPreset(dir, "nodefs", models, toolsRoot).toolDefs, []);
  assert.deepEqual(loadPreset(dir, "nodefs", models, path.join(root, "no-such-tools")).toolDefs, []);
});

test("工具定义读不出、格式不对、重名、超过大小上限：读预设失败", () => {
  putDef("badfmt", { extra: 1 });
  putDef("fat", { description: "字".repeat(6000) });
  const cases: [string, RegExp][] = [
    ["ghost", /找不到工具定义：ghost/],
    ["badfmt", /未知字段：extra/],
    ["self", /重名/],
    ["fat", /上限 16384 字节/],
    ["bad name", /工具名不合法/],
  ];
  for (const [tool, message] of cases) {
    const id = `def-${tool.replace(" ", "-")}`;
    const dir = write(id, front([`workdir: ${work}`, `model: ${modelStr}`, `tools: read, ${tool}`]));
    assert.throws(() => loadPreset(dir, id, models, toolsRoot), message, tool);
  }
});

test("一个预设用到的定义加起来超过 64 KiB：读预设失败", () => {
  for (const n of ["m1", "m2", "m3", "m4", "m5"]) putDef(n, { description: "a".repeat(15_000) });
  const dir = write("many", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: m1, m2, m3, m4, m5"]));
  assert.throws(() => loadPreset(dir, "many", models, toolsRoot), /共 \d+ 字节，上限 65536 字节/);
  const three = write("three", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: m1, m2, m3"]));
  assert.equal(loadPreset(three, "three", models, toolsRoot).toolDefs.length, 3);
});
