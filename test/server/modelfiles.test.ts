// 模型补充文件（D105）：读法的规则在 test/modelfile-suite.ts，这里测叠加、每次现读，和读预设、调用模型、启动检查用上文件里的条目。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { request } from "../../src/cli/main.ts";
import { createActions } from "../../src/executor/actions.ts";
import { start } from "../../src/kernel/decide.ts";
import { outputMax } from "../../src/kernel/derive.ts";
import type { Message } from "../../src/kernel/types.ts";
import { loadProcess } from "../../src/store/db.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { buildPreset, loadPreset } from "../../src/presets/load.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { MODELS_FILE_MAX_BYTES, readModelFile, withModelFiles } from "../../src/server/modelfiles.ts";
import { serve } from "../../src/server/serve.ts";
import { entry, modelFileSuite } from "../modelfile-suite.ts";
import { PRESET } from "../store/fixtures.ts";
import "../home.ts";

modelFileSuite("src", readModelFile as never);

test("MODELS_FILE_MAX_BYTES 是 1 MiB", () => {
  assert.equal(MODELS_FILE_MAX_BYTES, 1024 * 1024);
});

const temp = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelfiles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const put = (dir: string, provider: string, models: unknown[]): void => writeFileSync(join(dir, `${provider}.json`), JSON.stringify({ models }));

const credentials = {
  read: async () => ({ type: "api_key" as const, key: "test-key" }),
  list: async () => [],
  modify: async () => {
    throw new Error("只读");
  },
  delete: async () => {
    throw new Error("只读");
  },
};

function fauxCatalog(dir: string) {
  const faux = fauxProvider({ models: [{ id: "m1", contextWindow: 123_456 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const base = faux.getModel("m1")!;
  const e = (id: string, extra: Record<string, unknown> = {}) => entry(id, { api: base.api, baseUrl: base.baseUrl, ...extra });
  return { faux, base, models: withModelFiles(models, dir), e };
}

test("没有文件：目录照旧", (t) => {
  const dir = temp(t);
  const { base, models } = fauxCatalog(dir);
  assert.deepEqual(models.getModels(base.provider), [base]);
  assert.equal(models.getModel(base.provider, "m1"), base);
  assert.equal(models.getModel(base.provider, "nope"), undefined);
});

test("同 id 替换，新 id 加在后面，别的不动", (t) => {
  const dir = temp(t);
  const { base, models, e } = fauxCatalog(dir);
  put(dir, base.provider, [e("m1", { contextWindow: 777, maxTokens: 55 }), e("m9", { name: "nine" })]);
  const list = models.getModels(base.provider);
  assert.deepEqual(list.map((m) => m.id), ["m1", "m9"]);
  assert.equal(models.getModel(base.provider, "m1")!.contextWindow, 777);
  assert.equal(models.getModel(base.provider, "m1")!.maxTokens, 55);
  assert.equal(models.getModel(base.provider, "m9")!.name, "nine");
  assert.equal(models.getModel(base.provider, "m9")!.provider, base.provider);
});

test("每次查都现读：改文件、删文件、写坏文件，下一次查就变", (t) => {
  const dir = temp(t);
  const { base, models, e } = fauxCatalog(dir);
  const file = join(dir, `${base.provider}.json`);
  assert.equal(models.getModel(base.provider, "m9"), undefined);
  put(dir, base.provider, [e("m9", { contextWindow: 10 })]);
  assert.equal(models.getModel(base.provider, "m9")!.contextWindow, 10);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ models: [e("m9", { contextWindow: 20 })] }));
  renameSync(tmp, file);
  assert.equal(models.getModel(base.provider, "m9")!.contextWindow, 20);
  writeFileSync(file, "{坏");
  assert.equal(models.getModel(base.provider, "m9"), undefined);
  assert.equal(models.getModel(base.provider, "m1"), base);
  rmSync(file);
  assert.deepEqual(models.getModels(base.provider), [base]);
});

test("没注册的 provider 的文件：没有影响", (t) => {
  const dir = temp(t);
  const { base, models, e } = fauxCatalog(dir);
  put(dir, "ghost", [{ ...e("g1"), provider: undefined }]);
  assert.deepEqual(models.getProviders().map((p) => p.id), [base.provider]);
  assert.deepEqual(models.getModels("ghost"), []);
  assert.equal(models.getModel("ghost", "g1"), undefined);
  assert.deepEqual(models.getModels().map((m) => m.id), ["m1"]);
});

test("只有文件里有的模型能流式调用：请求还是原来的 provider 发", async (t) => {
  const dir = temp(t);
  const { faux, base, models, e } = fauxCatalog(dir);
  put(dir, base.provider, [e("only-in-file")]);
  const m = models.getModel(base.provider, "only-in-file")!;
  faux.appendResponses([fauxAssistantMessage(fauxText("来自文件里的模型"))]);
  const result = await models.streamSimple(m, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}).result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "来自文件里的模型" }]);
});

test("getAllModels：有就合并，同 id 的聊天模型换掉，别的类型的模型不动", (t) => {
  const dir = temp(t);
  const real = builtinModels({ credentials });
  const providerId = real.getProviders().find((p) => p.getAllModels && p.getAllModels().some((m) => (m as { type?: string }).type && (m as { type?: string }).type !== "chat"))?.id;
  const models = withModelFiles(real, dir);
  // 用一家有 getAllModels 的内置 provider。
  const id = providerId ?? real.getProviders().find((p) => p.getAllModels)!.id;
  const before = models.getAllModels(id);
  const chat = before.find((m) => ((m as { type?: string }).type ?? "chat") === "chat")!;
  put(dir, id, [{ ...entry(chat.id), api: (chat as Model<Api>).api, maxTokens: 123 }, entry("brand-new", { api: (chat as Model<Api>).api })]);
  const after = models.getAllModels(id);
  assert.equal(after.length, before.length + 1);
  assert.equal((after.find((m) => m.id === chat.id) as Model<Api>).maxTokens, 123);
  assert.equal(after.at(-1)!.id, "brand-new");
  for (const m of before.filter((x) => x !== chat && ((x as { type?: string }).type ?? "chat") !== "chat")) assert.ok(after.includes(m));
  assert.equal(models.getModel(id, "brand-new")!.id, "brand-new");
});

test("内置的 provider 都是普通对象（展开复制才安全）；叠完以后别的成员原样在", (t) => {
  const dir = temp(t);
  const catalog = builtinModels({ credentials });
  const originals = catalog.getProviders();
  for (const p of originals) {
    assert.equal(Object.getPrototypeOf(p), Object.prototype, p.id);
    assert.ok(Object.values(Object.getOwnPropertyDescriptors(p)).every((d) => d.enumerable && !d.get && !d.set), p.id);
  }
  withModelFiles(catalog, dir);
  const wrapped = catalog.getProviders();
  assert.deepEqual(wrapped.map((p) => p.id), originals.map((p) => p.id));
  for (const [i, p] of wrapped.entries()) {
    const orig = originals[i]!;
    assert.notEqual(p, orig);
    for (const key of Object.keys(orig) as (keyof typeof orig)[]) {
      if (key === "getModels" || key === "getAllModels") continue;
      assert.equal(p[key], orig[key], `${p.id}.${key}`);
    }
    assert.deepEqual(p.getModels().map((m) => m.id), orig.getModels().map((m) => m.id));
  }
});

// 读预设：快照冻结 contextWindow 和 input

const preset = (work: string, model: string): string => ["---", `workdir: ${work}`, `model: ${model}`, "tools: read", "---", "你是测试。"].join("\n");

test("loadPreset 和 buildPreset：快照冻结文件条目的 contextWindow 和 input；改文件不动已有快照", (t) => {
  const dir = temp(t);
  const work = join(dir, "work");
  const presets = join(dir, "presets");
  for (const d of [work, presets, join(dir, "tools")]) mkdirSync(d);
  const { base, models, e } = fauxCatalog(join(dir, "models"));
  mkdirSync(join(dir, "models"));
  const mdir = join(dir, "models");
  put(mdir, base.provider, [e("m1", { contextWindow: 4_321, input: ["text", "image"] }), e("file-only", { contextWindow: 999, input: ["text"] })]);
  writeFileSync(join(presets, "a.md"), preset(work, `${base.provider}/m1`));
  writeFileSync(join(presets, "b.md"), preset(work, `${base.provider}/file-only`));
  const a = loadPreset(presets, "a", models, join(dir, "tools"));
  assert.equal(a.contextWindow, 4_321);
  assert.deepEqual(a.input, ["text", "image"]);
  const b = loadPreset(presets, "b", models, join(dir, "tools"));
  assert.equal(b.contextWindow, 999);
  assert.deepEqual(b.input, ["text"]);
  assert.ok(buildPreset);
  // 再读一遍：文件变了，新读的快照跟着变，旧快照是值，不变。
  put(mdir, base.provider, [e("m1", { contextWindow: 8_000 })]);
  assert.equal(loadPreset(presets, "a", models, join(dir, "tools")).contextWindow, 8_000);
  assert.equal(a.contextWindow, 4_321);
  assert.throws(() => loadPreset(presets, "b", models, join(dir, "tools")), /模型目录里没有/);
});

// 走真的服务：check 和 start

test("只在文件里的模型：check 通过、start 起得来；快照是文件条目的窗口；换文件后 check 立刻跟着变", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelfiles-"));
  const work = join(dir, "work");
  const presetsDir = join(dir, "presets");
  const toolsDir = join(dir, "tools");
  const mdir = join(dir, "models");
  for (const d of [work, presetsDir, toolsDir, mdir]) mkdirSync(d);
  const { faux, base, models, e } = fauxCatalog(mdir);
  writeFileSync(join(presetsDir, "p.md"), preset(work, `${base.provider}/file-only`));
  const pipe = `\\\\.\\pipe\\tau-test-modelfiles-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir, models, memory: sqliteMemory });
  t.after(async () => {
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ask = async (req: Request): Promise<Reply[]> => {
    const out: Reply[] = [];
    await request(pipe, req, (r) => out.push(r));
    return out;
  };
  const checked = async () => (await ask({ op: "check", preset: "p" }))[0]!;

  const missing = await checked();
  assert.equal(missing.type, "error");
  assert.match(JSON.stringify(missing), /模型目录里没有/);
  put(mdir, base.provider, [e("file-only", { contextWindow: 150_000 })]);
  const ok = await checked();
  assert.equal(ok.type, "check");
  if (ok.type !== "check") return;
  assert.equal(ok.error, null);
  assert.equal(ok.snapshot.contextWindow, 150_000);

  faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const replies = await ask({ op: "start", preset: "p", text: "你好" });
  assert.equal(replies[0]?.type, "receipt");
  assert.equal(replies.at(-1)?.type, "final");
});

// spawn、带预设的 fork、reconfigure：都经服务的读预设，用现读的条目

/** 真服务，faux 模型叠文件；预设 boss（faux 的 m1）、kid（只在文件里的 file-only，窗口 150000）。 */
async function serving(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelfiles-"));
  const work = join(dir, "work");
  const [presetsDir, toolsDir, mdir] = [join(dir, "presets"), join(dir, "tools"), join(dir, "models")];
  for (const d of [work, presetsDir, toolsDir, mdir]) mkdirSync(d);
  const { faux, base, models, e } = fauxCatalog(mdir);
  const head = (model: string, tools: string) => `---
workdir: ${work}
model: ${base.provider}/${model}
tools: ${tools}
---
`;
  writeFileSync(join(presetsDir, "boss.md"), `${head("m1", "agents")}老板。
`);
  writeFileSync(join(presetsDir, "kid.md"), `${head("file-only", "read")}孩子。
`);
  put(mdir, base.provider, [e("file-only", { contextWindow: 150_000 })]);
  const pipe = `\\\\.\\pipe\\tau-test-modelfiles-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir, models, memory: sqliteMemory });
  t.after(async () => {
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ask = async (req: Request): Promise<Reply[]> => {
    const out: Reply[] = [];
    await request(pipe, req, (r) => out.push(r));
    return out;
  };
  return { svc, faux, base, mdir, e, ask, head, presetsDir, work };
}

test("spawn：子进程的预设写的是只在文件里的模型，快照拿到文件里的窗口", async (t) => {
  const s = await serving(t);
  const brain = (ctx: { messages: { role: string; content: unknown }[] }) => {
    const last = ctx.messages.at(-1);
    if (JSON.stringify(last?.content).includes("去做") || last?.role === "toolResult") return fauxAssistantMessage(fauxText("好"));
    return fauxAssistantMessage([fauxToolCall("spawn", { preset: "kid", text: "去做" })], { stopReason: "toolUse" });
  };
  s.faux.setResponses(Array.from({ length: 6 }, () => brain));
  assert.equal((await s.ask({ op: "start", preset: "boss", text: "开工" })).at(-1)?.type, "final");
  const kid = (): { preset: { id: string; contextWindow: number } } | undefined => s.svc.db.prepare("SELECT state_json FROM processes").all().map((r) => JSON.parse(r.state_json as string)).find((p) => p.preset.id === "kid");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !kid()) await new Promise((r) => setTimeout(r, 20));
  assert.equal(kid()?.preset.contextWindow, 150_000);
});

test("fork 带 preset：新进程的快照拿到文件里的窗口", async (t) => {
  const s = await serving(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
  const started = await s.ask({ op: "start", preset: "boss", text: "你好" });
  const a = started.find((r) => r.type === "receipt");
  assert.ok(a && a.type === "receipt");
  const forked = (await s.ask({ op: "fork", process: a.process, preset: "kid" }))[0]!;
  assert.equal(forked.type, "receipt");
  if (forked.type !== "receipt") return;
  assert.equal(loadProcess(s.svc.db, forked.process)!.preset.contextWindow, 150_000);
});

test("reconfigure 把 model 原样发一次：文件改了以后，新快照的窗口是新的，旧的不变", async (t) => {
  const s = await serving(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
  const a = (await s.ask({ op: "start", preset: "kid", text: "你好" })).find((r) => r.type === "receipt");
  assert.ok(a && a.type === "receipt");
  assert.equal(loadProcess(s.svc.db, a.process)!.preset.contextWindow, 150_000);
  put(s.mdir, s.base.provider, [s.e("file-only", { contextWindow: 160_000 })]);
  const r = (await s.ask({ op: "reconfigure", process: a.process, fields: { model: `${s.base.provider}/file-only` } }))[0]!;
  assert.equal(r.type, "reconfigured");
  const p = loadProcess(s.svc.db, a.process)!;
  assert.equal(p.preset.contextWindow, 150_000);
  assert.equal(p.next?.contextWindow ?? p.preset.contextWindow, 160_000);
});

// 调用模型：用现读的条目

const job = (model: string, contextWindow: number) => {
  const segment: Message[] = [{ role: "user", content: "你好", timestamp: 0 }];
  const preset = { ...PRESET, model, contextWindow };
  return { process: start("p1", preset, { now: 0, memoryView: "" }), segment, effect: { kind: "callModel" as const, n: 1, purpose: "turn" as const } };
};

/** 真目录叠文件，经执行器和真的 pi-ai 适配器；onPayload 截下请求体，假 fetch 回 400 并记下地址。模型目录和 actions 只建一次，返回的函数可以连调。 */
function caller(dir: string) {
  const catalog = withModelFiles(builtinModels({ credentials }), dir);
  const seen: { model?: Model<Api>; payload?: Record<string, unknown>; urls: string[] } = { urls: [] };
  const models = {
    getModel: (p: string, id: string) => catalog.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) => {
      seen.model = m;
      return catalog.streamSimple(m, context as never, {
        ...options,
        onPayload: (x) => {
          seen.payload = x as Record<string, unknown>;
        },
        fetch: (async (url: unknown) => {
          seen.urls.push(String(url));
          return new Response("{}", { status: 400 });
        }) as never,
      });
    },
  } as unknown as Models;
  const actions = createActions(models, () => {}, "test-pipe", () => undefined);
  return async (model: string, contextWindow: number) => {
    seen.urls = [];
    await actions.callModel(job(model, contextWindow), new AbortController().signal);
    return seen;
  };
}
const callWith = (dir: string, model: string, contextWindow: number) => caller(dir)(model, contextWindow);

test("callModel 用文件里的条目：maxTokens 定 cap，字段送到请求", async (t) => {
  const dir = temp(t);
  const real = builtinModels({ credentials }).getModel("opencode-go", "deepseek-v4.1-flash")!;
  put(dir, "opencode-go", [
    { ...real, maxTokens: 777, baseUrl: "https://file.example.test/v1", headers: { "X-From-File": "1" } },
    entry("file-only", { api: "openai-completions", baseUrl: "https://only.example.test/v1", maxTokens: 555, contextWindow: 200_000 }),
  ]);
  const a = await callWith(dir, "opencode-go/deepseek-v4.1-flash", real.contextWindow);
  assert.equal(a.model!.maxTokens, Math.min(777, outputMax({ ...PRESET, contextWindow: real.contextWindow })));
  assert.equal(a.model!.maxTokens, 777);
  assert.equal(a.payload!.max_tokens, 777);
  assert.ok(a.urls[0]!.startsWith("https://file.example.test/v1"), a.urls[0]);
  const b = await callWith(dir, "opencode-go/file-only", 200_000);
  assert.equal(b.model!.maxTokens, 555);
  assert.equal(b.payload!.max_tokens ?? b.payload!.max_completion_tokens, 555);
  assert.equal(b.payload!.model, "file-only");
  assert.ok(b.urls[0]!.startsWith("https://only.example.test/v1"), b.urls[0]);
});

test("callModel 现读：同一个模型目录、同一个 actions 连调，文件改了，下一次调用就用新的 maxTokens", async (t) => {
  const dir = temp(t);
  const real = builtinModels({ credentials }).getModel("opencode-go", "deepseek-v4.1-flash")!;
  const call = caller(dir);
  const name = "opencode-go/deepseek-v4.1-flash";
  put(dir, "opencode-go", [{ ...real, maxTokens: 300 }]);
  assert.equal((await call(name, real.contextWindow)).payload!.max_tokens, 300);
  put(dir, "opencode-go", [{ ...real, maxTokens: 400 }]);
  assert.equal((await call(name, real.contextWindow)).payload!.max_tokens, 400);
  rmSync(join(dir, "opencode-go.json"));
  assert.equal((await call(name, real.contextWindow)).model!.maxTokens, Math.min(real.maxTokens, outputMax({ ...PRESET, contextWindow: real.contextWindow })));
});
