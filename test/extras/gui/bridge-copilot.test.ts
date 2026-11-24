// D105 桥这一边：模型补充文件叠在目录上（规则和服务一样），Copilot 有补充文件时列表就是文件，后台刷新的触发。不联网。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import type { BridgeOptions } from "../../../extras/gui/bridge/server.ts";
import { createCopilotRefresher, RETRY_MS, STALE_MS } from "../../../extras/gui/bridge/copilot.ts";
import { INDIVIDUAL_BASE, refreshCopilot } from "../../../extras/models/copilot.ts";
import { entry } from "../../modelfile-suite.ts";

type Obj = Record<string, any>;

async function setup(t: TestContext, opts: Partial<BridgeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-copilot-"));
  const home = join(dir, "home");
  mkdirSync(join(home, "models"), { recursive: true });
  const bridge = await createBridge({ port: 0, home, pipe: `\\\\.\\pipe\\tau-test-gui-copilot-${process.pid}-${Math.random().toString(16).slice(2)}`, copilotRefresh: async () => ({ kind: "skipped", summary: "" }), ...opts });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const models = async (): Promise<Obj> => {
    const r = await fetch(`http://127.0.0.1:${bridge.port}/api/models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return (await r.json()) as Obj;
  };
  const provider = async (id: string): Promise<Obj> => ((await models()).providers as Obj[]).find((p) => p.id === id)!;
  const file = (id: string, doc: unknown) => writeFileSync(join(home, "models", `${id}.json`), typeof doc === "string" ? doc : JSON.stringify(doc));
  const auth = (c: unknown) => writeFileSync(join(home, "auth.json"), JSON.stringify({ "github-copilot": c }));
  return { dir, home, models, provider, file, auth };
}
const oauth = { type: "oauth", access: "A-SECRET", refresh: "R-SECRET", expires: 1 };
const own = (id: string, extra: Obj = {}) => entry(id, { provider: "github-copilot", api: "anthropic-messages", ...extra });

test("叠补充文件：同 id 换成文件里的，新 id 加在后面；别的供应商照旧；坏条目和坏文件按内核的规则忽略；改了不用重启", async (t) => {
  const e = await setup(t);
  const base = getBuiltinModels("openai").map((m) => m.id);
  assert.ok(base.length > 2);
  assert.deepEqual((await e.provider("openai")).models.map((m: Obj) => m.id), base);
  e.file("openai", { models: [entry(base[1]!, { name: "Replaced", contextWindow: 123_456, input: ["text", "image"], reasoning: true, thinkingLevelMap: { low: null, high: "high" } }), entry("brand-new", { contextWindow: 77_000 }), entry("bad", { maxTokens: 0 }), entry("brand-new", { name: "dup" })] });
  const p = await e.provider("openai");
  assert.deepEqual(p.models.map((m: Obj) => m.id), [...base, "brand-new"]);
  const replaced = p.models.find((m: Obj) => m.id === base[1]);
  assert.deepEqual([replaced.name, replaced.window, replaced.image], ["Replaced", 123_456, true]);
  assert.ok(!replaced.thinking.includes("low") && replaced.thinking.includes("high"), "思考级别按文件里条目的映射算");
  assert.equal(p.models.find((m: Obj) => m.id === "brand-new").window, 77_000);
  assert.equal(p.models.find((m: Obj) => m.id === base[0]).name, getBuiltinModels("openai")[0]!.name);
  assert.equal((await e.provider("anthropic")).models.length, getBuiltinModels("anthropic").length);
  e.file("openai", "{ not json");
  assert.deepEqual((await e.provider("openai")).models.map((m: Obj) => m.id), base, "文件坏了整份忽略");
  e.file("no-such-provider", { models: [entry("x")] });
  assert.equal(((await e.models()).providers as Obj[]).some((p) => p.id === "no-such-provider"), false, "目录里没有的供应商不读");
});

test("Copilot 有补充文件：列的恰好是文件里的模型（含目录外的），不按 availableModelIds 过滤；文件不合格（没有一个合格条目）就照旧", async (t) => {
  const e = await setup(t);
  const all = getBuiltinModels("github-copilot").map((m) => m.id);
  e.auth({ ...oauth, availableModelIds: [all[0]] });
  assert.deepEqual((await e.provider("github-copilot")).models.map((m: Obj) => m.id), [all[0]], "没有文件：按账号清单过滤（老办法）");
  e.file("github-copilot", { generatedAt: "t", models: [own("claude-sonnet-5.5", { contextWindow: 111_000 }), own("claude-new-9", { name: "New 9", input: ["text", "image"] }), own("junk", { cost: null })] });
  const c = await e.provider("github-copilot");
  assert.deepEqual(c.models.map((m: Obj) => m.id), ["claude-sonnet-5.5", "claude-new-9"], "恰好是文件里的，顺序照文件");
  assert.equal(c.models[0].window, 111_000);
  assert.equal(c.models[1].image, true);
  assert.equal(c.key, "oauth");
  e.auth({ type: "api_key", key: "ghu_X" });
  assert.equal((await e.provider("github-copilot")).models.length, 2, "api_key 也一样");
  e.file("github-copilot", { models: [own("junk", { maxTokens: -1 })] });
  e.auth({ ...oauth, availableModelIds: [all[0]] });
  assert.deepEqual((await e.provider("github-copilot")).models.map((m: Obj) => m.id), [all[0]], "没有合格条目：当没有文件");
  e.file("github-copilot", "garbage");
  assert.deepEqual((await e.provider("github-copilot")).models.map((m: Obj) => m.id), [all[0]]);
  assert.doesNotMatch(JSON.stringify(await e.models()), /SECRET/);
});

const waitFor = async (f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await sleep(10)) if (Date.now() - t0 > ms) assert.fail("等不到");
};

test("桥启动：auth.json 里有 Copilot 凭据就在后台刷新一次，没有就不刷新；刷新不挡响应", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-copilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  let calls = 0;
  const open = (calls_: () => void) => createBridge({ port: 0, home, pipe: `\\\\.\\pipe\\tau-test-gui-copilot-${process.pid}-${Math.random().toString(16).slice(2)}`, copilotRefresh: async () => (calls_(), new Promise(() => {})) });
  const none = await open(() => calls++);
  await sleep(50);
  assert.equal(calls, 0, "没登录：不刷新");
  await none.close();
  writeFileSync(join(home, "auth.json"), JSON.stringify({ "github-copilot": oauth }));
  const b = await open(() => calls++);
  t.after(() => b.close());
  await waitFor(() => calls === 1);
  // 刷新还没完（永远不完），请求照样回，也不会再起第二个。
  const r = await fetch(`http://127.0.0.1:${b.port}/api/models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200);
  await r.json();
  await sleep(50);
  assert.equal(calls, 1, "单飞");
});

test("/api/models：上次成功超过 6 小时才在后台刷新；没有记录也刷新；新的不刷新；没登录不刷新", async (t) => {
  let calls = 0;
  let finish: (() => void) | undefined;
  const e = await setup(t, { copilotRefresh: async () => (calls++, new Promise<never>((_, rej) => (finish = () => rej(new Error("x"))))) });
  const state = join(e.home, "extras", "models", "github-copilot.json");
  mkdirSync(join(e.home, "extras", "models"), { recursive: true });
  await e.models();
  assert.equal(calls, 0, "没登录");
  e.auth(oauth);
  writeFileSync(state, JSON.stringify({ lastSuccess: Date.now() - 60_000, seen: {} }));
  await e.models();
  assert.equal(calls, 0, "刚成功过");
  writeFileSync(state, JSON.stringify({ lastSuccess: Date.now() - STALE_MS - 60_000, seen: {} }));
  await e.models();
  await e.models();
  assert.equal(calls, 1, "旧了：刷新一次，在跑的时候不再起");
  finish!();
  await sleep(20);
  await e.models();
  assert.equal(calls, 1, "失败后 10 分钟内不再试");
});

test("刷新的调度：单飞；失败或没登录后等够 10 分钟；成功后不用等；成功记录没有就算旧", async () => {
  let now = 1_000_000_000;
  let last: number | undefined;
  let loggedIn = true;
  let kind: "ok" | "failed" | "skipped" = "failed";
  let throws = false;
  const runs: (() => void)[] = [];
  const r = createCopilotRefresher({
    run: () => new Promise((resolve, reject) => runs.push(() => (throws ? reject(new Error("boom")) : resolve({ kind, summary: "" })))),
    lastSuccess: () => last,
    loggedIn: () => loggedIn,
    now: () => now,
  });
  const settle = async () => {
    runs.shift()!();
    await sleep(0);
  };
  r.maybe();
  r.maybe();
  r.start();
  assert.equal(runs.length, 1, "单飞");
  await settle();
  r.maybe();
  assert.equal(runs.length, 0, "刚失败");
  now += RETRY_MS - 1;
  r.maybe();
  assert.equal(runs.length, 0);
  now += 1;
  r.maybe();
  assert.equal(runs.length, 1, "等够了");
  throws = true;
  await settle();
  now += RETRY_MS - 1;
  r.maybe();
  assert.equal(runs.length, 0, "抛错也算失败");
  now += 1;
  throws = false;
  kind = "ok";
  last = undefined;
  r.maybe();
  await settle();
  last = now;
  r.maybe();
  assert.equal(runs.length, 0, "成功了，6 小时内不刷新");
  now += STALE_MS;
  r.maybe();
  assert.equal(runs.length, 0, "恰好 6 小时：还不算旧");
  now += 1;
  r.maybe();
  assert.equal(runs.length, 1, "超过 6 小时");
  await settle();
  loggedIn = false;
  now += 2 * STALE_MS;
  r.maybe();
  r.start();
  assert.equal(runs.length, 0, "没登录");
  loggedIn = true;
  kind = "skipped";
  r.start();
  await settle();
  now += 1;
  r.maybe();
  assert.equal(runs.length, 0, "没登录那一类的结果也要等 10 分钟");
});

test("Individual 账号所有 picker 标志都是 false：刷新生成的文件有 policy 是 enabled 的那 4 个，桥给 Copilot 列出这 4 个", async (t) => {
  const e = await setup(t);
  const item = (id: string, over: Obj = {}) => ({
    id,
    name: id,
    model_picker_enabled: false,
    policy: { state: "enabled" },
    supported_endpoints: ["/chat/completions"],
    capabilities: { type: "chat", limits: { max_prompt_tokens: 100_000, max_output_tokens: 8_000 }, supports: { tool_calls: true } },
    ...over,
  });
  const data = [item("gpt-4.1", { is_chat_default: true }), item("claude-sonnet-5.5"), item("gpt-6-sol"), item("gemini-4-argon")];
  const r = await refreshCopilot({
    authFile: join(e.home, "auth.json"),
    modelsDir: join(e.home, "models"),
    stateFile: join(e.home, "extras", "models", "github-copilot.json"),
    models: { getAuth: async () => ({ auth: { apiKey: "tok-SECRET", baseUrl: INDIVIDUAL_BASE } }) as never },
    fetch: (async () => Response.json({ data })) as typeof fetch,
  });
  assert.equal(r.kind, "ok", r.summary);
  e.auth(oauth);
  assert.deepEqual((await e.provider("github-copilot")).models.map((m: Obj) => m.id), ["gpt-4.1", "claude-sonnet-5.5", "gpt-6-sol", "gemini-4-argon"]);
});
