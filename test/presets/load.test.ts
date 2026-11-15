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

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tau-presets-"));
  work = path.join(root, "work");
  mkdirSync(work);
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
  assert.deepEqual(loadPreset(dir, "lf", models), {
    id: "lf",
    workdir: work,
    model: modelStr,
    tools: ["read", "bash"],
    prompt: "你是测试。\n第二行",
    contextWindow: 123456,
  });
});

test("valid preset with CRLF line endings", () => {
  const dir = write("crlf", valid([], "\r\n"));
  assert.deepEqual(loadPreset(dir, "crlf", models), {
    id: "crlf",
    workdir: work,
    model: modelStr,
    tools: ["read", "bash"],
    prompt: "你是测试。\n第二行",
    contextWindow: 123456,
  });
});

test("workdir value containing a colon is kept whole", () => {
  assert.ok(work.includes(":"), "temp path should contain a drive colon on Windows");
  const dir = write("colon", valid());
  assert.equal(loadPreset(dir, "colon", models).workdir, work);
});

test("model id may contain a slash", () => {
  const m2 = faux.getModel("org/m2");
  assert.ok(m2);
  const dir = write("slash", front([`workdir: ${work}`, "model: faux/org/m2", "tools:"]));
  const snap = loadPreset(dir, "slash", models);
  assert.equal(snap.model, "faux/org/m2");
  assert.equal(snap.contextWindow, 777);
});

test("empty tools means no tools; empty prompt allowed", () => {
  const dir = write("notools", front([`workdir: ${work}`, `model: ${modelStr}`, "tools:"], []));
  const snap = loadPreset(dir, "notools", models);
  assert.deepEqual(snap.tools, []);
  assert.equal(snap.prompt, "");
});

test("duplicate tools are removed, first-seen order kept", () => {
  const dir = write("dup", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, bash, read, memory, bash"]));
  assert.deepEqual(loadPreset(dir, "dup", models).tools, ["read", "bash", "memory"]);
});

test("unknown key is an error", () => {
  const dir = write("unk", valid(["color: red"]));
  assert.throws(() => loadPreset(dir, "unk", models), /color/);
});

test("duplicate key is an error", () => {
  const dir = write("dupkey", valid([`workdir: ${work}`]));
  assert.throws(() => loadPreset(dir, "dupkey", models), /workdir/);
});

for (const key of ["workdir", "model", "tools"]) {
  test(`missing key ${key} is an error`, () => {
    const all: Record<string, string> = { workdir: `workdir: ${work}`, model: `model: ${modelStr}`, tools: "tools: read" };
    const lines = Object.entries(all).filter(([k]) => k !== key).map(([, v]) => v);
    const dir = write(`miss-${key}`, front(lines));
    assert.throws(() => loadPreset(dir, `miss-${key}`, models), new RegExp(key));
  });
}

test("bad tool name is an error", () => {
  const dir = write("badtool", front([`workdir: ${work}`, `model: ${modelStr}`, "tools: read, sudo"]));
  assert.throws(() => loadPreset(dir, "badtool", models), /sudo/);
});

test("model without a slash is an error", () => {
  const dir = write("noslash", front([`workdir: ${work}`, "model: m1", "tools:"]));
  assert.throws(() => loadPreset(dir, "noslash", models), /<provider>\/<model-id>/);
});

test("model not in catalog is an error", () => {
  const dir = write("nomodel", front([`workdir: ${work}`, "model: faux/nope", "tools:"]));
  assert.throws(() => loadPreset(dir, "nomodel", models), /模型目录里没有 faux\/nope/);
});

test("missing workdir directory is an error", () => {
  const dir = write("nodir", front([`workdir: ${path.join(work, "nope")}`, `model: ${modelStr}`, "tools:"]));
  assert.throws(() => loadPreset(dir, "nodir", models), /工作目录不存在/);
});

test("missing file is an error naming the preset", () => {
  assert.throws(() => loadPreset(root, "ghost", models), /ghost/);
});

test("bad preset ids are rejected", () => {
  for (const id of ["../x", "a/b", "a\\b", "a:b", ""]) {
    assert.throws(() => loadPreset(root, id, models), /预设 ID 不合法/, id);
  }
});

test("missing opening --- is an error", () => {
  const dir = write("noopen", `workdir: ${work}\nmodel: ${modelStr}\ntools:\n---\n正文`);
  assert.throws(() => loadPreset(dir, "noopen", models), /开头的 ---/);
});

test("missing closing --- is an error", () => {
  const dir = write("noclose", `---\nworkdir: ${work}\nmodel: ${modelStr}\ntools:\n正文`);
  assert.throws(() => loadPreset(dir, "noclose", models), /结束的 ---/);
});
