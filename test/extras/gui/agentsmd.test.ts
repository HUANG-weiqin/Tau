// 上下文文件和 D58 留下的旧拼接块（桥的 agentsmd.ts 和 presets.ts）：认出和去掉旧块、手写的字原样、
// 新建勾选写 `context: AGENTS.md` 而不拼块、转成上下文文件、`context` 的写法检查。
// 纯函数直接测；接口对着“假的服务”（只回 `check`，按文件现在的样子造快照，不依赖内核有没有 `context`），
// 对着真的服务的几条在最后，要内核认 `context` 才能跑（D72）。全部用临时目录，不碰真的 ~/.tau。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { applyBlock, BEGIN, END, findBlock, splitPrompt } from "../../../extras/gui/bridge/agentsmd.ts";
import { patchPreset } from "../../../extras/gui/bridge/presets.ts";
import * as web from "../../../extras/gui/web/lib/agentsmd.js";

const BLOCK = [`${BEGIN} | x -->`, "一行", "两行", END];

test("agentsmd: 去掉旧块只去掉块和它前面的空行，用户写的字原样，包括末尾的空行", () => {
  for (const user of ["手写\n", "手写\n\n\n", "第一行\n\n第二行\n"]) {
    const rest = user.split("\n");
    // 旧块是 D58 加的：前面一个空行，后面接文件末尾的换行。
    const withBlock = [...rest.slice(0, -1), "", ...BLOCK, ""];
    assert.ok(findBlock(withBlock.slice(0, -1)), JSON.stringify(user));
    assert.deepEqual(applyBlock(withBlock, true, undefined), [...rest.slice(0, -1), ""], JSON.stringify(user));
    // 不去就是同一个数组：不动。
    assert.equal(applyBlock(withBlock, false, undefined), withBlock);
  }
  // 没有块时去也不动。
  const rest = ["手写", ""];
  assert.equal(applyBlock(rest, true, undefined), rest);
});

test("agentsmd: 给了 prompt 时旧块留着、用户的部分换掉；一起去掉就只剩新的；起始标记没有结束标记就当没有块", () => {
  assert.deepEqual(applyBlock(["旧", "", ...BLOCK, ""], false, "新写的\n"), ["新写的", "", ...BLOCK, ""]);
  assert.deepEqual(applyBlock(["旧", "", ...BLOCK, ""], true, "新写的"), ["新写的", ""]);
  assert.deepEqual(applyBlock(["旧", ""], false, ""), ["", ""]);
  assert.deepEqual(applyBlock(["", ...BLOCK, ""], false, ""), [...BLOCK, ""]);
  assert.equal(findBlock([BEGIN, "没有结束"]), null);
  assert.deepEqual(applyBlock(["留着", BEGIN, "没有结束", ""], true, undefined), ["留着", BEGIN, "没有结束", ""]);
  assert.deepEqual(splitPrompt(`写给模型\n\n${BLOCK.join("\n")}`), { user: "写给模型", block: BLOCK });
  assert.deepEqual(splitPrompt("只有手写"), { user: "只有手写", block: null });
});

test("agentsmd: 页面里的拆法（web/lib/agentsmd.js）和桥的一致：块在末尾、中间、开头，没有结束标记，空提示词", () => {
  const cases = [
    "",
    "只有手写",
    `写给模型\n\n${BLOCK.join("\n")}`,
    `前\n\n${BLOCK.join("\n")}\n\n后`,
    BLOCK.join("\n"),
    `${BEGIN} 没有结束\n正文`,
    `前面没有空行${"\n"}${BLOCK.join("\n")}`,
    `\n\n手写\n\n\n${BLOCK.join("\n")}\n`,
  ];
  for (const text of cases) assert.deepEqual(web.splitPrompt(text), splitPrompt(text), JSON.stringify(text));
  assert.equal(web.BEGIN, BEGIN);
  assert.equal(web.END, END);
  // 接回去：用户的部分、空一行、块；和桥对预设文件做的一样。
  assert.equal(web.joinPrompt("写给模型", BLOCK), `写给模型\n\n${BLOCK.join("\n")}`);
  assert.equal(web.joinPrompt("", BLOCK), BLOCK.join("\n"));
  assert.equal(web.joinPrompt(" 只有手写 ", null), "只有手写");
  for (const text of cases) {
    const { user, block } = web.splitPrompt(text);
    assert.deepEqual(web.splitPrompt(web.joinPrompt(user, block)), { user, block }, JSON.stringify(text));
  }
});

test("agentsmd: patchPreset 整份文件去掉旧块，别的字节不变（CRLF、BOM、手写的末尾空行）；改头部的行时块不动", () => {
  for (const eol of ["\n", "\r\n"]) {
    const head = `\uFEFF---${eol}workdir: E:\\w${eol}model: a/b${eol}tools: read${eol}---${eol}`;
    const plain = `${head}手写${eol}${eol}${eol}`;
    const withBlock = `${head}手写${eol}${eol}${eol}${eol}${BLOCK.join(eol)}${eol}`;
    assert.equal(patchPreset(withBlock, [], undefined, true), plain);
    assert.equal(patchPreset(plain, [], undefined, true), plain, "没有块时去也不动");
    assert.equal(patchPreset(withBlock, [], undefined), withBlock);
    assert.ok(patchPreset(withBlock, [["model", "c/d"]], undefined).includes(BLOCK.join(eol)));
    assert.ok(patchPreset(withBlock, [["context", "AGENTS.md"]], undefined, true).includes(`context: AGENTS.md${eol}---`));
  }
});

interface Env {
  home: string;
  work: string;
  port: number;
  model: string;
  agents: string;
}

const presetFile = (e: Env, id: string) => readFileSync(join(e.home, "presets", `${id}.md`), "utf8");
async function post(e: Env, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${e.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}
const listed = async (e: Env, id: string) => (await post(e, "/api/presets", {})).json.presets.find((p: any) => p.id === id);

const pipeName = () => `\\\\.\\pipe\\tau-test-gui-agents-${process.pid}-${Math.random().toString(16).slice(2)}`;

/**
 * 假服务：只回 `check`，按预设文件现在的样子造快照（头部的键，加第二个 `---` 后面的提示词），不查模型目录、工具定义和窗口。
 * `reject` 给了就先看文件的文字，返回字符串就当 `check` 的 `error`（起不来）。
 */
async function fakeService(t: TestContext, home: string, reject: (text: string) => string | null = () => null): Promise<string> {
  const pipe = pipeName();
  const open = new Set<Socket>();
  const srv = createServer((s) => {
    open.add(s);
    s.on("error", () => {});
    s.on("data", (buf) => {
      const req = JSON.parse(buf.toString("utf8").split("\n")[0]!);
      let text: string;
      try {
        text = readFileSync(join(home, "presets", `${req.preset}.md`), "utf8");
      } catch {
        return void s.write(`${JSON.stringify({ type: "error", message: `找不到预设：${req.preset}` })}\n`);
      }
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
      const end = lines.indexOf("---", 1);
      const f = new Map(lines.slice(1, end).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
      const names = (f.get("tools") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
      const builtin = ["read", "write", "edit", "bash", "memory", "agents"];
      const snapshot = {
        id: req.preset,
        workdir: f.get("workdir"),
        model: f.get("model"),
        tools: names.filter((n) => builtin.includes(n)),
        toolDefs: names.filter((n) => !builtin.includes(n)).map((name) => ({ name })),
        prompt: lines.slice(end + 1).join("\n").trim(),
        ...(f.has("thinking") ? { thinking: f.get("thinking") } : {}),
        ...(f.has("handoff") ? { handoff: Number(f.get("handoff")) } : {}),
        ...(f.has("options") ? { options: JSON.parse(f.get("options")!) } : {}),
        ...(f.has("context") ? { context: [...new Set((f.get("context") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""))] } : {}),
      };
      s.write(`${JSON.stringify({ type: "check", snapshot, error: reject(text) })}\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(pipe, r));
  t.after(() => new Promise<void>((r) => (open.forEach((s) => s.destroy()), srv.close(() => r()))));
  return pipe;
}

async function setupFake(t: TestContext, reject?: (text: string) => string | null): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-agents-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(work);
  const bridge = await createBridge({ port: 0, home, pipe: await fakeService(t, home, reject) });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, work, port: bridge.port, model: "x/m", agents: join(work, "AGENTS.md") };
}

test("接口：AGENTS.md 在不在、多大；只认 AGENTS.md，不认 CLAUDE.md", async (t) => {
  const e = await setupFake(t);
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: e.work })).json, { exists: false });
  writeFileSync(join(e.work, "CLAUDE.md"), "别的文件\n");
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: e.work })).json, { exists: false });
  writeFileSync(e.agents, "三个字\n");
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: e.work })).json, { exists: true, bytes: 10 });
  mkdirSync(join(e.work, "sub", "AGENTS.md"), { recursive: true });
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: join(e.work, "sub") })).json, { exists: false }, "是目录不算");
  assert.equal((await post(e, "/api/agents-md", { workdir: "rel" })).status, 400);
  assert.equal((await post(e, "/api/agents-md", { workdir: join(e.work, "nope") })).status, 400);
  assert.equal((await post(e, "/api/agents-md", {})).status, 400);
});

test("新建：勾选就是 context 里一项 AGENTS.md，不往提示词里拼块；列表带 context，agentsMd 只有 none", async (t) => {
  const e = await setupFake(t);
  writeFileSync(e.agents, "# 规则\r\n一条\r\n");
  const body = { id: "a", workdir: e.work, model: e.model, tools: ["read"], prompt: "你好", context: ["AGENTS.md"] };
  assert.equal((await post(e, "/api/presets/create", body)).status, 200);
  assert.equal(presetFile(e, "a"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\ncontext: AGENTS.md\n---\n你好\n`);
  assert.deepEqual(await listed(e, "a"), { id: "a", ok: true, workdir: e.work, model: e.model, tools: ["read"], memory: false, prompt: "你好", agentsMd: "none", context: ["AGENTS.md"] });
  // agentsMd 在新建里不认：不拼块，也不报错（只写认识的字段）。
  assert.equal((await post(e, "/api/presets/create", { ...body, id: "b", context: undefined, agentsMd: true })).status, 200);
  assert.equal(presetFile(e, "b"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n你好\n`);
  assert.equal((await listed(e, "b")).agentsMd, "none");
  assert.equal((await listed(e, "b")).context, undefined);
});

test("context 的写法：去空白、跳空项、去重保留第一次的顺序；空数组不写这一行；不合格的 400 且不写文件", async (t) => {
  const e = await setupFake(t);
  const base = { workdir: e.work, model: e.model, tools: ["read"], prompt: "p" };
  const mk = (id: string, context: unknown) => post(e, "/api/presets/create", { ...base, id, context });
  assert.equal((await mk("a", [" AGENTS.md ", "", "docs/a.md", "AGENTS.md", "E:\\x\\b.md"])).status, 200);
  assert.ok(presetFile(e, "a").includes("\ncontext: AGENTS.md, docs/a.md, E:\\x\\b.md\n---"));
  assert.equal((await mk("empty", [])).status, 200);
  assert.ok(!presetFile(e, "empty").includes("context"));
  assert.equal((await mk("eight", Array.from({ length: 8 }, (_, i) => `f${i}.md`))).status, 200);
  assert.equal((await mk("nine", Array.from({ length: 9 }, (_, i) => `f${i}.md`))).status, 400);
  assert.equal((await mk("dup", [...Array.from({ length: 8 }, (_, i) => `f${i}.md`), "f0.md"])).status, 200, "重复的先去掉再数");
  for (const [n, v] of [["str", "AGENTS.md"], ["num", [1]], ["comma", ["a,b.md"]], ["ctl", ["a\nb.md"]], ["nul", ["a\u0000b"]], ["long", ["x".repeat(261)]], ["obj", {}]] as [string, unknown][]) {
    const r = await mk(n, v);
    assert.equal(r.status, 400, n);
    assert.equal(typeof r.json.error, "string");
    assert.throws(() => presetFile(e, n), /ENOENT/, `${n}：没写文件`);
  }
  assert.equal((await mk("max", ["x".repeat(260)])).status, 200, "260 个字符可以");
});

test("改预设：context 加、换、删（null 和 [] 都是删这一行）；写完经 check 读得出；别的行和手写的字原样", async (t) => {
  const e = await setupFake(t);
  const file = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n手写的\n\n末尾还有空行\n\n\n`;
  writeFileSync(join(e.home, "presets", "a.md"), file);
  const upd = (body: Record<string, unknown>) => post(e, "/api/presets/update", { id: "a", ...body });
  const r1 = await upd({ context: ["AGENTS.md", "docs/a.md"] });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.deepEqual(r1.json.preset.context, ["AGENTS.md", "docs/a.md"]);
  assert.equal(presetFile(e, "a"), file.replace("tools: read\n", "tools: read\ncontext: AGENTS.md, docs/a.md\n"));
  assert.equal((await upd({ context: ["b.md"] })).status, 200);
  assert.ok(presetFile(e, "a").includes("tools: read\ncontext: b.md\n---\n"));
  assert.equal((await upd({ context: null })).status, 200);
  assert.equal(presetFile(e, "a"), file);
  assert.equal((await upd({ context: ["a.md"] })).status, 200);
  assert.equal((await upd({ context: [] })).status, 200);
  assert.equal(presetFile(e, "a"), file);
  assert.equal((await listed(e, "a")).context, undefined);
  for (const bad of [{ context: "AGENTS.md" }, { context: ["a,b"] }, { context: Array(9).fill("x").map((x, i) => `${x}${i}`) }]) {
    assert.equal((await upd(bad)).status, 400, JSON.stringify(bad));
    assert.equal(presetFile(e, "a"), file);
  }
});

test("改预设：context 加上以后 check 说起不来，改回旧文件，422 带错误原文", async (t) => {
  const e = await setupFake(t, (text) => (/^context:/m.test(text) ? "上下文装不下窗口（假服务的原文）" : null));
  const file = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n手写\n`;
  writeFileSync(join(e.home, "presets", "a.md"), file);
  const r = await post(e, "/api/presets/update", { id: "a", context: ["AGENTS.md"] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "上下文装不下窗口（假服务的原文）");
  assert.equal(presetFile(e, "a"), file, "改回旧文件，字节不变");
});

test("旧拼接块：列表标 legacy，prompt 里没有块；去块只发 agentsMd: false；true 和别的值 400", async (t) => {
  const e = await setupFake(t);
  const handwritten = "手写的\n\n末尾还有空行\n\n\n";
  const legacy = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n${handwritten}\n${BEGIN} | 说明 | ${e.agents} -->\n# 规则\n一条\n${END}\n`;
  writeFileSync(join(e.home, "presets", "a.md"), legacy);
  const upd = (body: Record<string, unknown>) => post(e, "/api/presets/update", { id: "a", ...body });
  const l = await listed(e, "a");
  assert.equal(l.agentsMd, "legacy");
  assert.equal(l.prompt, "手写的\n\n末尾还有空行", "不含旧块");

  // 改别的字段、改提示词，块都留着。
  assert.equal((await upd({ thinking: "low" })).status, 200);
  assert.ok(presetFile(e, "a").includes(`${BEGIN} | 说明 |`));
  assert.equal((await upd({ prompt: "新的手写" })).status, 200);
  assert.ok(presetFile(e, "a").includes(`新的手写\n\n${BEGIN}`));
  assert.equal((await listed(e, "a")).agentsMd, "legacy");

  // 只接受 false。
  for (const bad of [true, 1, "false", null]) {
    const r = await upd({ agentsMd: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.ok(presetFile(e, "a").includes(BEGIN));

  // 去掉：块没了，手写的和别的行不动。
  assert.equal((await upd({ agentsMd: false })).status, 200);
  const text = presetFile(e, "a");
  assert.ok(!text.includes(BEGIN) && !text.includes(END));
  assert.equal((await listed(e, "a")).agentsMd, "none");
  assert.equal((await listed(e, "a")).prompt, "新的手写");
  assert.equal((await post(e, "/api/presets/update", { id: "a" })).status, 400, "什么都没传还是 400");
});

test("转成上下文文件：一次 update 去块并加 context；已有 AGENTS.md 不重复；加完起不来就改回去（块还在）", async (t) => {
  const e = await setupFake(t, (text) => (text.includes("context: AGENTS.md, huge.md") ? "装不下窗口" : null));
  const handwritten = "手写的\n\n\n";
  const legacy = (ctx: string) => `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n${ctx}---\n${handwritten}${BEGIN} | x -->\n正文\n${END}\n`;
  writeFileSync(join(e.home, "presets", "a.md"), legacy(""));
  const upd = (body: Record<string, unknown>) => post(e, "/api/presets/update", { id: "a", ...body });

  const r = await upd({ agentsMd: false, context: ["AGENTS.md"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(presetFile(e, "a"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\ncontext: AGENTS.md\n---\n手写的\n\n`, "块和它前面的一个空行没了，手写的字不动");
  assert.deepEqual([r.json.preset.agentsMd, r.json.preset.context], ["none", ["AGENTS.md"]]);

  // 已有的不重复（页面算好再发：context 原样，不多一项）。
  writeFileSync(join(e.home, "presets", "a.md"), legacy("context: AGENTS.md, docs/a.md\n"));
  assert.equal((await upd({ agentsMd: false, context: ["AGENTS.md", "docs/a.md"] })).status, 200);
  assert.ok(presetFile(e, "a").includes("context: AGENTS.md, docs/a.md\n---"));
  assert.equal((await listed(e, "a")).agentsMd, "none");

  // 起不来：改回旧文件，旧块还在。
  const before = legacy("");
  writeFileSync(join(e.home, "presets", "a.md"), before);
  const bad = await upd({ agentsMd: false, context: ["AGENTS.md", "huge.md"] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, "装不下窗口");
  assert.equal(presetFile(e, "a"), before);
  assert.equal((await listed(e, "a")).agentsMd, "legacy", "旧文件仍然读得出");
});

// ---------------------------------------------------------------- 真的服务
// 下面几条对着真的测试服务，要内核认预设的 `context`（D72）才能跑；内核没落地前会失败。

async function setupReal(t: TestContext): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-agents-real-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(work);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const pipe = pipeName();
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, "presets"), toolsDir: join(home, "tools"), models, memory: sqliteMemory });
  const bridge = await createBridge({ port: 0, home, pipe });
  t.after(async () => {
    await bridge.close();
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, work, port: bridge.port, model: `${faux.getModel().provider}/m`, agents: join(work, "AGENTS.md") };
}

test("真服务：新建带 context 读得出，列表原样带回；遗留的旧块读得出并标 legacy；转成上下文文件以后读得出", async (t) => {
  const e = await setupReal(t);
  writeFileSync(e.agents, "# 规则\n一条\n");
  const body = { id: "a", workdir: e.work, model: e.model, tools: ["read"], prompt: "你好", context: ["AGENTS.md", "docs/a.md"] };
  assert.equal((await post(e, "/api/presets/create", body)).status, 200);
  assert.deepEqual(await listed(e, "a"), { id: "a", ok: true, workdir: e.work, model: e.model, tools: ["read"], memory: false, prompt: "你好", agentsMd: "none", context: ["AGENTS.md", "docs/a.md"] }, "只查写法，不查 docs/a.md 在不在");

  writeFileSync(join(e.home, "presets", "old.md"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n旧的手写\n\n${BEGIN} | x -->\n# 规则\n一条\n${END}\n`);
  const old = await listed(e, "old");
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.deepEqual([old.agentsMd, old.prompt, old.context], ["legacy", "旧的手写", undefined]);
  const r = await post(e, "/api/presets/update", { id: "old", agentsMd: false, context: ["AGENTS.md"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.preset.agentsMd, r.json.preset.prompt, r.json.preset.context], ["none", "旧的手写", ["AGENTS.md"]]);
  assert.ok(!presetFile(e, "old").includes(BEGIN));
});

test("真服务：context 的路径写法内核不认（/e/x.md 不是 Windows 的绝对路径）：改回旧文件，错误原文带回", async (t) => {
  const e = await setupReal(t);
  const file = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n手写\n`;
  writeFileSync(join(e.home, "presets", "a.md"), file);
  const r = await post(e, "/api/presets/update", { id: "a", context: ["/e/x.md"] });
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.equal(typeof r.json.error, "string");
  assert.equal(presetFile(e, "a"), file);
});
