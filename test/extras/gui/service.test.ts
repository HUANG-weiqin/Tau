// 界面的重启、旧代码提示、自动标题（extras/gui）。全部用临时目录、临时管道和假的 runner，不起停真的进程。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { createServiceControl, newestMtime } from "../../../extras/gui/bridge/service.ts";
import type { ServiceOps } from "../../../extras/gui/bridge/service.ts";
import { piCredentials } from "../../../extras/gui/bridge/credentials.ts";
import { cleanTitle, TITLE_SYSTEM } from "../../../extras/gui/bridge/title.ts";
import { confirmText, staleOf } from "../../../extras/gui/web/lib/service.js";
import { firstLetterText, wantsAutoTitle } from "../../../extras/gui/web/lib/titles.js";
import { plainFirstLine, plainLine } from "../../../extras/gui/web/lib/plain.js";
import { describeNow } from "../../../extras/gui/web/lib/messages.js";
import { firstLine } from "../../../extras/gui/web/lib/notify.js";
import { normalizeState, prunePatch } from "../../../extras/gui/web/lib/state.js";

const pipeName = () => `\\\\.\\pipe\\tau-test-svc-${process.pid}-${Math.random().toString(16).slice(2)}`;

function call(port: number, path: string, body: unknown): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    }).on("error", reject);
  });
}

/** 假服务：`ps` 回给定的阶段，别的请求不回。 */
async function fakePs(t: TestContext, tags: string[]): Promise<string> {
  const pipe = pipeName();
  const open = new Set<import("node:net").Socket>();
  const srv = createServer((s) => {
    open.add(s);
    s.on("data", () => s.write(`${JSON.stringify({ type: "ps", processes: tags.map((tag) => ({ self: { phase: { tag } } })) })}\n`));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(pipe, r));
  t.after(() => new Promise<void>((r) => (open.forEach((s) => s.destroy()), srv.close(() => r()))));
  return pipe;
}

function fakeOps(started: number | null) {
  const calls = { find: 0, restart: [] as any[] };
  const ops: ServiceOps = {
    serviceStartedAt: async () => (calls.find++, started),
    restart: (a) => void calls.restart.push(a),
  };
  return { ops, calls };
}

function tmpRepo(t: TestContext): string {
  const repo = mkdtempSync(join(tmpdir(), "tau-gui-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const d of ["src/kernel", "extras/gui/bridge", "extras/tools", "node_modules/x"]) mkdirSync(join(repo, d), { recursive: true });
  return repo;
}
const touch = (file: string, ms: number) => {
  writeFileSync(file, "x");
  utimesSync(file, new Date(ms), new Date(ms));
};

test("newestMtime：取目录树里最新的，跳过 node_modules 和不认的扩展名，不存在的是 0", (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "a.ts"), 1000);
  touch(join(repo, "src", "kernel", "b.ts"), 3000);
  touch(join(repo, "src", "notes.md"), 9000);
  touch(join(repo, "node_modules", "x", "i.js"), 8000);
  assert.equal(newestMtime([join(repo, "src")], [".ts"]), 3000);
  assert.equal(newestMtime([repo, join(repo, "none")], [".ts"]), 3000);
  assert.equal(newestMtime([join(repo, "none")]), 0);
});

test("/api/service：服务和桥的启动时间对比源码的最新修改时间；有几个进程在跑", async (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "kernel", "a.ts"), 5000);
  touch(join(repo, "extras", "gui", "bridge", "s.ts"), 7000);
  touch(join(repo, "extras", "tools", "t.ts"), 2000);
  const pipe = await fakePs(t, ["idle", "awaitingModel", "awaitingTool"]);
  const f = fakeOps(4000);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeStartedAt: 6000 });
  t.after(() => b.close());
  const r = await call(b.port, "/api/service", {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    service: { up: true, startedAt: 4000, stale: true },
    bridge: { startedAt: 6000, stale: true },
    running: 2,
    newestSource: 5000,
    newestBridge: 7000,
  });
  assert.deepEqual(staleOf(r.json), { service: true, bridge: true });
});

test("/api/service：不比源码旧就不算旧；服务不在时没有启动时间和进程数，也不查进程", async (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "a.ts"), 5000);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pipe = await fakePs(t, []);
  const f = fakeOps(6000);
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeStartedAt: 1 });
  t.after(() => b.close());
  const r = await call(b.port, "/api/service", {});
  assert.deepEqual(r.json.service, { up: true, startedAt: 6000, stale: false });
  assert.equal(r.json.bridge.stale, false);
  assert.equal(r.json.running, 0);

  const down = fakeOps(6000);
  const b2 = await createBridge({ port: 0, home, pipe: pipeName(), repo, serviceOps: down.ops });
  t.after(() => b2.close());
  const r2 = await call(b2.port, "/api/service", {});
  assert.deepEqual(r2.json.service, { up: false, startedAt: null, stale: false });
  assert.equal(r2.json.running, null);
  assert.equal(down.calls.find, 0);
  assert.deepEqual(staleOf(r2.json), { service: false, bridge: false });
});

test("服务启动时间的查询结果缓存一段时间，重启以后立刻作废", async (t) => {
  const repo = tmpRepo(t);
  const pipe = await fakePs(t, []);
  const f = fakeOps(1000);
  let now = 0;
  const c = createServiceControl({ pipe, repo, ops: f.ops, cacheMs: 30_000, now: () => now });
  await c.status();
  now = 29_000;
  await c.status();
  assert.equal(f.calls.find, 1);
  now = 31_000;
  await c.status();
  assert.equal(f.calls.find, 2);
  await c.restart({ service: true, bridge: false, force: false, bridgeArgs: [] });
  await c.status();
  assert.equal(f.calls.find, 3);
});

test("/api/service/restart：有进程在跑又没 force 回 409 和个数，什么都不做；force 才动；只重启桥不拦", async (t) => {
  const repo = tmpRepo(t);
  const pipe = await fakePs(t, ["awaitingModel", "idle", "awaitingTool"]);
  const f = fakeOps(1);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeArgs: ["--port", "4317"] });
  t.after(() => b.close());

  const busy = await call(b.port, "/api/service/restart", { service: true });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.running, 2);
  assert.equal(f.calls.restart.length, 0);

  const forced = await call(b.port, "/api/service/restart", { service: true, force: true });
  assert.equal(forced.status, 202);
  assert.deepEqual(f.calls.restart.at(-1), { service: true, bridge: false, bridgePid: process.pid, bridgeArgs: ["--port", "4317"], repo });

  const bridgeOnly = await call(b.port, "/api/service/restart", { bridge: true });
  assert.equal(bridgeOnly.status, 202);
  assert.equal(f.calls.restart.at(-1).service, false);
  assert.equal(f.calls.restart.at(-1).bridge, true);

  assert.equal((await call(b.port, "/api/service/restart", {})).status, 400);
  assert.equal((await call(b.port, "/api/service/restart", { service: "yes" })).status, 400);
  assert.equal((await call(b.port, "/api/service/restart", { bridge: false, service: false })).status, 400);
  assert.equal(f.calls.restart.length, 2);
});

test("/api/service/restart：没有进程在跑，或者服务根本不在，直接 202", async (t) => {
  const repo = tmpRepo(t);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const pipe of [await fakePs(t, ["idle"]), pipeName()]) {
    const f = fakeOps(1);
    const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops });
    t.after(() => b.close());
    assert.equal((await call(b.port, "/api/service/restart", { service: true })).status, 202);
    assert.equal(f.calls.restart.length, 1);
  }
});

test("静态文件：/web/ 每次都要校验（no-cache），vendor 照旧缓存", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe: pipeName() });
  t.after(() => b.close());
  const js = await get(b.port, "/web/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["cache-control"], "no-cache");
  assert.equal((await get(b.port, "/web/styles.css")).headers["cache-control"], "no-cache");
  const v = await get(b.port, "/vendor/preact/package.json");
  if (v.status === 200) assert.match(String(v.headers["cache-control"]), /max-age/);
});

test("页面的横幅文字：确认框写明会中断几个进程和“被中断”", () => {
  assert.match(confirmText(3), /3 个在跑的进程/);
  assert.match(confirmText(3), /被中断/);
  assert.match(confirmText(3), /不自动重做/);
  assert.deepEqual(staleOf(null), { service: false, bridge: false });
  assert.deepEqual(staleOf({ service: { up: false, stale: true }, bridge: { stale: false } }), { service: false, bridge: false });
});

test("cleanTitle：取第一个非空行，去引号和结尾标点，截到 16 个字，空的是 null", () => {
  assert.equal(cleanTitle("\n  “修登录页的 bug。”\n多余的解释"), "修登录页的 bug");
  assert.equal(cleanTitle("`标题`"), "标题");
  assert.equal(cleanTitle("一二三四五六七八九十一二三四五六七八九十"), "一二三四五六七八九十一二三四五六");
  assert.equal(cleanTitle("  \n "), null);
  assert.equal(cleanTitle("“”"), null);
  assert.match(TITLE_SYSTEM, /16/);
});

test("凭据：只认 api_key；`!` 开头或含 `$` 的 key 不认；OAuth 当没有；每次现读", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "auth.json");
  const store = piCredentials(file);
  assert.equal(await store.read("a"), undefined);
  writeFileSync(file, JSON.stringify({ a: { type: "api_key", key: "k1" }, o: { type: "oauth", access: "x" }, c: { type: "api_key", key: "!echo hi" }, d: { type: "api_key", key: "a$b" } }));
  assert.equal((await store.read("a"))?.type, "api_key");
  assert.equal(await store.read("o"), undefined);
  await assert.rejects(store.read("c"), /命令或变量/);
  await assert.rejects(store.read("d"), /命令或变量/);
  assert.deepEqual((await store.list()).map((x) => x.providerId), ["a", "c", "d"]);
  writeFileSync(file, JSON.stringify({ a: { type: "api_key", key: "k2" } }));
  assert.equal(((await store.read("a")) as any).key, "k2");
  await assert.rejects(store.modify("a", async () => undefined as any), /只读/);
  writeFileSync(file, "{坏");
  await assert.rejects(store.read("a"), (e: Error) => !e.message.includes("坏"));
});

async function titleSetup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-title-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  const presetsDir = join(home, "presets");
  mkdirSync(presetsDir, { recursive: true });
  mkdirSync(work);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const ref = `${faux.getModel().provider}/m`;
  writeFileSync(join(presetsDir, "p.md"), `---\nworkdir: ${work}\nmodel: ${ref}\ntools: read\n---\n你是测试助手。\n`);
  const pipe = pipeName();
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir: join(dir, "tools"), models, memory: sqliteMemory });
  const bridge = await createBridge({ port: 0, home, pipe, titleModels: models });
  t.after(async () => {
    await bridge.close();
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { faux, port: bridge.port, ref, pipe };
}

async function startProcess(pipe: string, text: string): Promise<string> {
  const { pipeRequest } = await import("../../../extras/gui/bridge/pipe.ts");
  let id = "";
  await pipeRequest(pipe, { op: "start", preset: "p", text }, (r) => {
    if (r.type === "receipt") id = r.process;
    return r.type === "final" || r.type === "error";
  });
  return id;
}

test("/api/title：读第一封信，调一次模型，思考关掉、输出上限小、提示词是约定的；回整理过的标题", async (t) => {
  const s = await titleSetup(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好的"))]);
  const id = await startProcess(s.pipe, "帮我把登录页的报错提示改成中文\n再检查一下表单");
  let seen: any = null;
  s.faux.setResponses([
    (ctx, opts, _state, model) => {
      seen = { ctx, opts, model };
      return fauxAssistantMessage(fauxText("“修改登录页报错提示。”\n解释"));
    },
  ]);
  const r = await call(s.port, "/api/title", { process: id, model: s.ref });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.title, "修改登录页报错提示");
  const sent = JSON.stringify(seen.ctx.messages);
  assert.ok(sent.includes(TITLE_SYSTEM));
  assert.ok(sent.includes("帮我把登录页的报错提示改成中文"));
  assert.equal(seen.opts?.reasoning, undefined);
  assert.equal(seen.model.maxTokens, 100);
});

test("/api/title：参数不对 400，没有这个进程 404，模型不在目录 422，模型出错 502，服务不在 503", async (t) => {
  const s = await titleSetup(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好的"))]);
  const id = await startProcess(s.pipe, "做点事");
  assert.equal((await call(s.port, "/api/title", { model: s.ref })).status, 400);
  assert.equal((await call(s.port, "/api/title", { process: "a/b", model: s.ref })).status, 400);
  assert.equal((await call(s.port, "/api/title", { process: id })).status, 400);
  assert.equal((await call(s.port, "/api/title", { process: id, model: "没有斜杠" })).status, 400);
  assert.equal((await call(s.port, "/api/title", { process: "nope", model: s.ref })).status, 404);
  assert.equal((await call(s.port, "/api/title", { process: id, model: "faux/none" })).status, 422);
  s.faux.setResponses([fauxAssistantMessage(fauxText("   "))]);
  assert.equal((await call(s.port, "/api/title", { process: id, model: s.ref })).status, 502);

  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(s.faux.provider);
  const b = await createBridge({ port: 0, home, pipe: pipeName(), titleModels: models });
  t.after(() => b.close());
  assert.equal((await call(b.port, "/api/title", { process: id, model: s.ref })).status, 503);
});

test("自动标题的条件：人建的根进程、第一封信在了、没生成过；预设进程和子进程不要", () => {
  const e = (o: any = {}) => ({ id: "a", kind: "temp", self: { messages: 1, ...o } });
  const st = { titled: [] as string[] };
  assert.equal(wantsAutoTitle(e(), st), true);
  assert.equal(wantsAutoTitle(e({ messages: 0 }), st), false);
  assert.equal(wantsAutoTitle(e({ parent: "x" }), st), false);
  assert.equal(wantsAutoTitle({ ...e(), kind: "team" }, st), false);
  assert.equal(wantsAutoTitle(e(), { titled: ["a"] }), false);
});

test("第一封信的正文：纯文本和带信头的用户消息都能取，不是用户消息是空串", () => {
  assert.equal(firstLetterText({ role: "user", content: "你好\n第二行", timestamp: 1 }), "你好\n第二行");
  assert.equal(firstLetterText({ role: "assistant", content: [], timestamp: 1 }), "");
  assert.equal(firstLetterText(null), "");
});

test("界面数据：titled 和 titleModel 读得出，坏的当没有；进程被清掉后 titled 里它的 ID 也清掉", () => {
  const g = normalizeState({ titled: ["a", 3, "b"], titleModel: "x/y" });
  assert.deepEqual(g.titled, ["a", "b"]);
  assert.equal(g.titleModel, "x/y");
  assert.equal("titleModel" in normalizeState({ titleModel: "" }), false);
  assert.deepEqual(normalizeState({}).titled, []);
  assert.deepEqual(prunePatch(g, (id) => id === "a"), { titled: ["b"] });
});

test("Markdown 小修：去掉行首的标题、列表、引用标记和行内的 ** 与反引号", () => {
  assert.equal(plainLine("## 方案"), "方案");
  assert.equal(plainLine("###### 小标题"), "小标题");
  assert.equal(plainLine("- 第一条"), "第一条");
  assert.equal(plainLine("* 第一条"), "第一条");
  assert.equal(plainLine("1. 先做这个"), "先做这个");
  assert.equal(plainLine("2) 再做这个"), "再做这个");
  assert.equal(plainLine("> 引用的话"), "引用的话");
  assert.equal(plainLine("> - 引用里的列表"), "引用里的列表");
  assert.equal(plainLine("- [ ] 待办"), "待办");
  assert.equal(plainLine("**重点**：改 `foo.ts` 里的 **bar**"), "重点：改 foo.ts 里的 bar");
  assert.equal(plainLine("2026 年的计划"), "2026 年的计划");
  assert.equal(plainLine("#标签不是标题"), "#标签不是标题");
  assert.equal(plainLine("a * b"), "a * b");
  assert.equal(plainFirstLine("\n```ts\nconst a = 1\n```"), "ts");
  assert.equal(plainFirstLine("---\n\n## 方案\n细节"), "方案");
  assert.equal(plainFirstLine("   \n\n"), "");
});

test("Markdown 小修：“正在做”和通知用的第一行不再露出标记", () => {
  const msg = { role: "assistant", content: [{ type: "text", text: "## 方案\n**先**读 `a.ts`" }], timestamp: 1 } as any;
  assert.equal(describeNow([msg]), "方案");
  assert.equal(firstLine("**做完了**：改了 `x`"), "做完了：改了 x");
});
