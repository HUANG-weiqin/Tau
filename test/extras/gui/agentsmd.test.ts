// 把项目的 AGENTS.md 拼进预设提示词（桥的 agentsmd.ts 和 presets.ts）：拼、去掉、不传不动、过期、没了、超限改回、手写的字原样。
// 纯函数直接测；接口对着真的测试服务。全部用临时目录，不碰真的 ~/.tau。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { applyBlock, BEGIN, END, findBlock, splitPrompt } from "../../../extras/gui/bridge/agentsmd.ts";
import { patchPreset } from "../../../extras/gui/bridge/presets.ts";

const BLOCK = [`${BEGIN} | x -->`, "一行", "两行", END];

test("agentsmd: 加块和去块互逆，用户写的字原样，包括末尾的空行", () => {
  for (const user of ["手写\n", "手写\n\n\n", "第一行\n\n第二行\n"]) {
    const rest = user.split("\n");
    const added = applyBlock(rest, BLOCK, undefined);
    assert.ok(findBlock(added.slice(0, -1)), JSON.stringify(user));
    assert.deepEqual(applyBlock(added, null, undefined), rest,JSON.stringify(user));
  }
  // 不传不动：同一个数组。
  const rest = ["手写", ""];
  assert.equal(applyBlock(rest, undefined, undefined), rest);
  // 没有块时去块也不动。
  assert.equal(applyBlock(rest, null, undefined), rest);
});

test("agentsmd: 换块在原处；给了 prompt 时块留着、用户的部分换掉；起始标记没有结束标记就当没有块", () => {
  const rest = ["前", "", ...BLOCK, "", "后", ""];
  const NEW = [`${BEGIN} | y -->`, "新", END];
  assert.deepEqual(applyBlock(rest, NEW, undefined), ["前", "", ...NEW, "", "后", ""]);
  assert.deepEqual(applyBlock(["旧", "", ...BLOCK, ""], undefined, "新写的\n"), ["新写的", "", ...BLOCK, ""]);
  assert.deepEqual(applyBlock(["旧", "", ...BLOCK, ""], null, "新写的"), ["新写的", ""]);
  assert.deepEqual(applyBlock(["旧", ""], BLOCK, ""), [...BLOCK, ""]);
  assert.equal(findBlock([BEGIN, "没有结束"]), null);
  assert.deepEqual(splitPrompt(`写给模型\n\n${BLOCK.join("\n")}`), { user: "写给模型", block: BLOCK });
  assert.deepEqual(splitPrompt("只有手写"), { user: "只有手写", block: null });
});

test("agentsmd: patchPreset 整份文件加块再去掉，字节不变（CRLF、BOM、手写的末尾空行）", () => {
  for (const eol of ["\n", "\r\n"]) {
    const text = `\uFEFF---${eol}workdir: E:\\w${eol}model: a/b${eol}tools: read${eol}---${eol}手写${eol}${eol}${eol}`;
    const added = patchPreset(text, [], undefined, BLOCK);
    assert.ok(added.includes(BLOCK[1]!) && added.startsWith("\uFEFF"));
    assert.equal(patchPreset(added, [], undefined, null), text);
    assert.equal(patchPreset(text, [], undefined), text);
    // 只换头部的一行，块不动。
    assert.ok(patchPreset(added, [["model", "c/d"]], undefined).includes(BLOCK.join(eol)));
  }
});

interface Env {
  home: string;
  work: string;
  port: number;
  model: string;
  agents: string;
}

async function setup(t: TestContext): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-agents-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(work);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const pipe = `\\\\.\\pipe\\tau-test-gui-agents-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, "presets"), toolsDir: join(home, "tools"), models, memory: sqliteMemory });
  const bridge = await createBridge({ port: 0, home, pipe });
  t.after(async () => {
    await bridge.close();
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, work, port: bridge.port, model: `${faux.getModel().provider}/m`, agents: join(work, "AGENTS.md") };
}

async function post(e: Env, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${e.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

const presetFile = (e: Env, id: string) => readFileSync(join(e.home, "presets", `${id}.md`), "utf8");
const listed = async (e: Env, id: string) => (await post(e, "/api/presets", {})).json.presets.find((p: any) => p.id === id);

test("接口：AGENTS.md 在不在、多大", async (t) => {
  const e = await setup(t);
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: e.work })).json, { exists: false });
  writeFileSync(e.agents, "三个字\n");
  assert.deepEqual((await post(e, "/api/agents-md", { workdir: e.work })).json, { exists: true, bytes: 10 });
  assert.equal((await post(e, "/api/agents-md", { workdir: "rel" })).status, 400);
  assert.equal((await post(e, "/api/agents-md", { workdir: join(e.work, "nope") })).status, 400);
  assert.equal((await post(e, "/api/agents-md", {})).status, 400);
});

test("新建：拼上、不拼、没有文件拒绝；CLAUDE.md 不认", async (t) => {
  const e = await setup(t);
  const body = { id: "a", workdir: e.work, model: e.model, tools: ["read"], prompt: "你好" };
  writeFileSync(join(e.work, "CLAUDE.md"), "别的文件\n");
  const no = await post(e, "/api/presets/create", { ...body, agentsMd: true });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /没有 AGENTS\.md/);
  assert.throws(() => presetFile(e, "a"));
  assert.equal((await post(e, "/api/presets/create", { ...body, agentsMd: "yes" })).status, 400);

  writeFileSync(e.agents, "# 规则\r\n一条\r\n\r\n");
  assert.equal((await post(e, "/api/presets/create", { ...body, agentsMd: true })).status, 200);
  const text = presetFile(e, "a");
  assert.ok(text.endsWith(`你好\n\n${BEGIN} | 这一段由界面从 AGENTS.md 拼进来，别手改 | ${e.agents} -->\n# 规则\n一条\n${END}\n`), text);
  assert.deepEqual(await listed(e, "a"), { id: "a", ok: true, workdir: e.work, model: e.model, tools: ["read"], memory: false, prompt: "你好", agentsMd: "fresh" });

  assert.equal((await post(e, "/api/presets/create", { ...body, id: "b", agentsMd: false })).status, 200);
  assert.equal(presetFile(e, "b"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n你好\n`);
  assert.equal((await post(e, "/api/presets/create", { ...body, id: "c" })).status, 200);
  assert.equal((await listed(e, "c")).agentsMd, "none");
});

test("改预设：过期、重新拼、没了、去掉；不传不动，改别的字段块和手写的字都不变", async (t) => {
  const e = await setup(t);
  writeFileSync(e.agents, "第一版\n");
  const handwritten = "手写的\n\n末尾还有空行\n\n\n";
  writeFileSync(join(e.home, "presets", "a.md"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n${handwritten}`);
  const upd = (body: Record<string, unknown>) => post(e, "/api/presets/update", { id: "a", ...body });
  assert.equal((await listed(e, "a")).agentsMd, "none");

  // 拼上。手写的字一行不动。
  assert.equal((await upd({ agentsMd: true })).status, 200);
  const first = presetFile(e, "a");
  assert.ok(first.startsWith(`---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n${handwritten}\n${BEGIN}`), first);
  assert.equal((await listed(e, "a")).agentsMd, "fresh");
  assert.equal((await listed(e, "a")).prompt, "手写的\n\n末尾还有空行");

  // 不传：块不动，改别的字段、改提示词都一样。
  assert.equal((await upd({ model: e.model, thinking: "low" })).status, 200);
  assert.equal(presetFile(e, "a"), first.replace("tools: read\n", "tools: read\nthinking: low\n"));
  assert.equal((await upd({ prompt: "新的手写" })).status, 200);
  assert.equal((await listed(e, "a")).prompt, "新的手写");
  assert.equal((await listed(e, "a")).agentsMd, "fresh");
  assert.ok(presetFile(e, "a").includes(`新的手写\n\n${BEGIN}`));

  // 文件改过：过期，保存别的东西不会重拼，重新拼才换。
  writeFileSync(e.agents, "第二版\n加一行\n");
  assert.equal((await listed(e, "a")).agentsMd, "stale");
  assert.equal((await upd({ thinking: "high" })).status, 200);
  assert.equal((await listed(e, "a")).agentsMd, "stale");
  assert.equal((await upd({ agentsMd: true })).status, 200);
  assert.equal((await listed(e, "a")).agentsMd, "fresh");
  assert.ok(presetFile(e, "a").includes("第二版\n加一行\n"));
  assert.ok(!presetFile(e, "a").includes("第一版"));
  assert.equal(presetFile(e, "a").split(BEGIN).length, 2, "只有一块");

  // 文件没了：missing；重新拼被拒绝，旧文件原样；去掉可以。
  rmSync(e.agents);
  assert.equal((await listed(e, "a")).agentsMd, "missing");
  const before = presetFile(e, "a");
  const gone = await upd({ agentsMd: true });
  assert.equal(gone.status, 400);
  assert.match(gone.json.error, /没有 AGENTS\.md/);
  assert.equal(presetFile(e, "a"), before);
  assert.equal((await upd({ agentsMd: false })).status, 200);
  assert.equal((await listed(e, "a")).agentsMd, "none");
  assert.ok(!presetFile(e, "a").includes(BEGIN) && !presetFile(e, "a").includes(END));
  assert.equal((await listed(e, "a")).prompt, "新的手写");
  assert.equal((await upd({ agentsMd: 1 })).status, 400);
  assert.equal((await post(e, "/api/presets/update", { id: "a" })).status, 400, "什么都没传还是 400");
});

test("改预设：拼完装不下窗口，check 报错，改回旧文件，错误原文带回", async (t) => {
  const e = await setup(t);
  writeFileSync(e.agents, `${"很长的一行。".repeat(1_000_000)}\n`);
  writeFileSync(join(e.home, "presets", "a.md"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\n---\n手写\n\n\n`);
  const before = presetFile(e, "a");
  const r = await post(e, "/api/presets/update", { id: "a", agentsMd: true });
  assert.equal(r.status, 422);
  assert.equal(typeof r.json.error, "string");
  assert.equal(presetFile(e, "a"), before, "改回旧文件，字节不变");
  assert.equal((await listed(e, "a")).agentsMd, "none");
});

test("AGENTS.md 里有界面的标记行：拒绝，不写", async (t) => {
  const e = await setup(t);
  writeFileSync(e.agents, `正常\n${END}\n后面\n`);
  const r = await post(e, "/api/presets/create", { id: "a", workdir: e.work, model: e.model, tools: ["read"], prompt: "", agentsMd: true });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /标记行/);
  writeFileSync(e.agents, "  \n\n");
  assert.match((await post(e, "/api/presets/create", { id: "a", workdir: e.work, model: e.model, tools: ["read"], prompt: "", agentsMd: true })).json.error, /是空的/);
});
