// extras/models/copilot.ts（D105）：从 `/models` 的响应生成模型补充文件。响应是照官方插件和 Zed 的源码自己造的（没有真账号）。
// 不联网：假凭据、假 fetch、临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { API_VERSION, GRACE_MS, buildEntry, main, readLastSuccess, refreshCopilot, selectItems } from "../../../extras/models/copilot.ts";
import type { RefreshOptions } from "../../../extras/models/copilot.ts";
import { readModelFile } from "../../../extras/models/file.ts";

type Obj = Record<string, any>;
const catalog = getBuiltinModels("github-copilot") as unknown as Model<Api>[];
const byId = (id: string): Model<Api> => catalog.find((m) => m.id === id)!;

/** 一个 `/models` 条目，字段照官方响应。 */
function item(id: string, over: Obj = {}): Obj {
  const { capabilities, ...rest } = over;
  return {
    id,
    name: `Name ${id}`,
    vendor: "Anthropic",
    model_picker_enabled: true,
    policy: { state: "enabled" },
    supported_endpoints: ["/v1/messages", "/chat/completions"],
    ...rest,
    capabilities: {
      type: "chat",
      limits: { max_prompt_tokens: 128_000, max_output_tokens: 64_000, max_context_window_tokens: 200_000 },
      supports: { tool_calls: true, streaming: true, vision: true, thinking: true, adaptive_thinking: true, reasoning_effort: ["low", "medium", "high", "xhigh", "max"] },
      ...capabilities,
    },
  };
}
const limits = (l: Obj, supports: Obj = {}) => ({ capabilities: { limits: l, supports: { tool_calls: true, ...supports } } });

// ---------- 选哪些 ----------

test("选：picker 开着、policy 不是 disabled、tool_calls 不是 false、聊天模型；保持响应里的顺序", () => {
  const data = [
    item("a"),
    item("no-picker", { model_picker_enabled: false }),
    item("picker-missing", { model_picker_enabled: undefined }),
    item("disabled", { policy: { state: "disabled" } }),
    item("unconfigured", { policy: { state: "unconfigured" } }),
    item("no-policy", { policy: undefined }),
    item("no-tools", { capabilities: { supports: { tool_calls: false } } }),
    item("embed", { capabilities: { type: "embeddings" } }),
    item("completion", { capabilities: { type: "completion" } }),
    item("no-type", { capabilities: { type: undefined } }),
    item("z"),
  ];
  assert.deepEqual(selectItems({ data }).map((x) => x.id), ["a", "unconfigured", "no-policy", "no-type", "z"]);
});

test("选：没有 picker 里的模型、端点不是 Individual 时，只取 is_chat_default 那一个（要能用）", () => {
  const free = (extra: Obj[]) => ({ data: [item("x", { model_picker_enabled: false }), ...extra, item("y", { model_picker_enabled: false })] });
  assert.deepEqual(selectItems(free([item("d", { model_picker_enabled: false, is_chat_default: true })])).map((x) => x.id), ["d"]);
  assert.deepEqual(selectItems(free([item("d", { model_picker_enabled: false, is_chat_default: true, policy: { state: "disabled" } })])), [], "默认的被禁了：没有");
  assert.deepEqual(selectItems(free([item("d", { model_picker_enabled: false, is_chat_default: true, capabilities: { type: "embeddings" } })])), [], "默认的不是聊天模型：没有");
  assert.deepEqual(selectItems(free([])), []);
  assert.deepEqual(selectItems({ data: [item("p"), item("d", { model_picker_enabled: false, is_chat_default: true })] }).map((x) => x.id), ["p"], "有 picker 的就不看默认");
});

const INDIVIDUAL = "https://api.individual.githubcopilot.com";
test("选：没有任何 picker 模型时，Individual 端点取 policy.state 是 enabled 的，加上默认的那一个，保持顺序；别的端点只取默认的那一个", () => {
  const off = (id: string, over: Obj = {}) => item(id, { model_picker_enabled: false, ...over });
  const data = [off("gpt-4.1", { is_chat_default: true, policy: { state: "unconfigured" } }), off("claude-sonnet-5.5"), off("unset", { policy: { state: "unconfigured" } }), off("gpt-6-sol"), off("dead", { policy: { state: "disabled" } }), off("no-tools", { capabilities: { supports: { tool_calls: false } } }), off("gemini-4-argon")];
  assert.deepEqual(selectItems({ data }, INDIVIDUAL).map((x) => x.id), ["gpt-4.1", "claude-sonnet-5.5", "gpt-6-sol", "gemini-4-argon"]);
  assert.deepEqual(selectItems({ data }, `${INDIVIDUAL}/`).map((x) => x.id), ["gpt-4.1", "claude-sonnet-5.5", "gpt-6-sol", "gemini-4-argon"], "末尾的斜杠不算");
  assert.deepEqual(selectItems({ data }, "https://api.business.githubcopilot.com").map((x) => x.id), ["gpt-4.1"]);
  assert.deepEqual(selectItems({ data }).map((x) => x.id), ["gpt-4.1"]);
  assert.deepEqual(selectItems({ data: [...data, item("p")] }, INDIVIDUAL).map((x) => x.id), ["p"], "有 picker 的就用它们");
  assert.deepEqual(selectItems({ data: [off("a")] }, INDIVIDUAL).map((x) => x.id), ["a"]);
  assert.deepEqual(selectItems({ data: [off("a", { policy: { state: "unconfigured" } })] }, INDIVIDUAL), []);
});

test("选：解析宽松，垃圾项只丢它自己；没有 data 数组才算响应不对", () => {
  const data = [null, 5, "x", [], {}, { id: 3 }, { id: "" }, item("ok"), { id: "weird", model_picker_enabled: true, capabilities: "oops", policy: 7 }];
  assert.deepEqual(selectItems({ data }).map((x) => x.id), ["ok", "weird"]);
  for (const bad of [null, [], {}, { data: {} }, { data: "x" }, "x"]) assert.throws(() => selectItems(bad), /data/);
});

// ---------- 目录里有的模型：用模板 ----------

test("模板：目录里有同 id 的，接口、思考、兼容、价格、请求头都照它，只改窗口、输出上限、能不能看图", () => {
  const t = byId("claude-sonnet-5.5");
  const e = buildEntry(item("claude-sonnet-5.5", { capabilities: { limits: { max_prompt_tokens: 111_000, max_output_tokens: 22_000, max_context_window_tokens: 999_999 }, supports: { vision: false, adaptive_thinking: false, reasoning_effort: ["low"] } }, supported_endpoints: ["/chat/completions"] }), catalog)!;
  assert.deepEqual({ ...e, contextWindow: t.contextWindow, maxTokens: t.maxTokens, input: t.input }, JSON.parse(JSON.stringify(t)));
  assert.equal(e.contextWindow, 111_000);
  assert.equal(e.maxTokens, 22_000);
  assert.deepEqual(e.input, ["text"]);
  assert.equal(e.api, "anthropic-messages", "接口照模板，不看 supported_endpoints");
  assert.deepEqual(e.cost, t.cost, "价格照模板");
  assert.notEqual(e, t, "不改 pi-ai 的对象");
  assert.equal(catalog.find((m) => m.id === t.id)!.contextWindow, t.contextWindow);
});

test("模板：响应没写的字段保留模板的；看图写了才改", () => {
  const t = byId("claude-sonnet-5.5");
  const e = buildEntry({ id: t.id, capabilities: {} }, catalog)!;
  assert.deepEqual(e, JSON.parse(JSON.stringify(t)));
  assert.deepEqual(buildEntry({ id: "gpt-6-sol", capabilities: { limits: { vision: { max_prompt_images: 5 } } } }, catalog)!.input, ["text", "image"]);
  assert.deepEqual(buildEntry({ id: "gpt-6-sol", capabilities: { supports: { vision: false } } }, catalog)!.input, ["text"]);
});

test("窗口：分档价格的 max_prompt_tokens 和 limits.max_prompt_tokens 有的取小的，都没有才用 max_context_window_tokens", () => {
  const w = (over: Obj, lim: Obj) => buildEntry(item("claude-sonnet-5.5", { ...over, ...limits(lim) }), catalog)!.contextWindow;
  const prices = { billing: { token_prices: { default: { max_prompt_tokens: 200_000 }, long_context: { max_prompt_tokens: 1_000_000 } } } };
  assert.equal(w(prices, { max_prompt_tokens: 128_000, max_context_window_tokens: 1_000_000 }), 128_000, "价格档更大：取 limits 的");
  assert.equal(w(prices, { max_prompt_tokens: 300_000, max_context_window_tokens: 1_000_000 }), 200_000, "limits 更大：取价格档的");
  assert.equal(w(prices, { max_context_window_tokens: 1_000_000 }), 200_000, "只有价格档");
  assert.equal(w({}, { max_prompt_tokens: 128_000, max_context_window_tokens: 1_000_000 }), 128_000);
  assert.equal(w({}, { max_context_window_tokens: 300_000 }), 300_000);
  assert.equal(w({ billing: { token_prices: { default: { max_prompt_tokens: "x" } } } }, { max_prompt_tokens: 128_000 }), 128_000, "不是数字的跳过");
  assert.equal(w({}, { max_prompt_tokens: -1, max_context_window_tokens: 0.5 }), byId("claude-sonnet-5.5").contextWindow, "都不合格：保留模板的");
});

// ---------- 目录外的新模型 ----------

const NEW = "claude-sonnet-5.9";

test("新模型：接口按 /v1/messages、/responses、/chat/completions 的顺序选，认不出的字符串不影响", () => {
  const api = (eps: unknown) => buildEntry(item(NEW, { supported_endpoints: eps }), catalog)?.api;
  assert.equal(api(["/chat/completions", "/responses", "/v1/messages"]), "anthropic-messages");
  assert.equal(api(["ws:/responses", "/responses", "/chat/completions"]), "openai-responses");
  assert.equal(api(["/chat/completions"]), "openai-completions");
  assert.equal(api(["/future/api", 5, null, "/chat/completions"]), "openai-completions");
  assert.equal(api(["/future/api", "ws:/responses"]), undefined, "一个认得的都没有：这个模型不要，别的不受影响");
});

test("新模型：supported_endpoints 没写或空列表，走 /chat/completions，模板在 completions 的条目里按名字前缀选；名字像 claude 也不走 anthropic", () => {
  for (const eps of [undefined, [], null, "x", [5, null]]) {
    const e = buildEntry(item("claude-sonnet-5.9", { supported_endpoints: eps }), catalog)!;
    assert.equal(e.api, "openai-completions", JSON.stringify(eps));
    assert.equal((e.compat as Obj | undefined)?.forceAdaptiveThinking, undefined);
  }
  const bare = (id: string) => buildEntry(item(id, { supported_endpoints: undefined, capabilities: { supports: { thinking: false } } }), catalog)!;
  assert.equal(bare("o5-mini").api, "openai-completions", "o5-mini 不会被猜成 anthropic-messages");
  for (const id of ["gemini-3.8-flash", "gemini-4-argon", "kimi-k3"]) assert.equal(bare(id).api, "openai-completions", id);
  assert.equal((bare("gemini-4-argon").compat as Obj).supportsDeveloperRole, false, "gemini-* 的模板");
});

test("新模型：模板是同一种接口、id 前缀相同最长的那个；同样长取目录里靠前的", () => {
  const e = (id: string, eps: string[]) => buildEntry(item(id, { supported_endpoints: eps, capabilities: { supports: { thinking: false } } }), catalog)!;
  const headers = byId("claude-sonnet-5.5").headers;
  // 兼容开关能看出模板是谁：haiku-4.5 的 supportsEagerToolInputStreaming:false 只有它有。
  assert.equal((e("claude-haiku-4.9", ["/v1/messages"]).compat as Obj | undefined)?.supportsEagerToolInputStreaming, false, "claude-haiku-4.9 → claude-haiku-4.5");
  assert.equal((e("claude-haiku-5.9", ["/v1/messages"]).compat as Obj | undefined)?.supportsEagerToolInputStreaming, undefined, "claude-haiku-5.9 → claude-haiku-5.5");
  assert.deepEqual(e("gpt-6.1-nova", ["/responses"]).headers, headers);
  assert.equal((e("gemini-9", ["/chat/completions"]).compat as Obj).supportsDeveloperRole, false, "gemini-9 → gemini-*（openai-completions）");
  // 目录里没有这种接口的模型：不拿别种接口的兼容开关
  const onlyAnthropic = catalog.filter((m) => m.api === "anthropic-messages");
  const bare = buildEntry(item("gpt-9", { supported_endpoints: ["/responses"] }), onlyAnthropic)!;
  assert.equal(bare.api, "openai-responses");
  assert.equal(bare.compat, undefined);
  assert.deepEqual(bare.headers, onlyAnthropic[0]!.headers);
});

test("新模型：价格写 0，provider 和 type 补上，窗口、输出上限、看图来自响应，名字用响应的", () => {
  const e = buildEntry(item(NEW, { name: "Sonnet 5.9", ...limits({ max_prompt_tokens: 150_000, max_output_tokens: 33_000 }, { vision: true }) }), catalog)!;
  assert.deepEqual(e.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(e.provider, "github-copilot");
  assert.equal(e.type, "chat");
  assert.equal(e.name, "Sonnet 5.9");
  assert.equal(e.contextWindow, 150_000);
  assert.equal(e.maxTokens, 33_000);
  assert.deepEqual(e.input, ["text", "image"]);
  assert.deepEqual(e.inputLimits, byId("claude-sonnet-5.5").inputLimits);
  assert.equal(e.baseUrl, byId("claude-sonnet-5.5").baseUrl);
  const noVision = buildEntry(item(NEW, limits({ max_prompt_tokens: 1, max_output_tokens: 1 })), catalog)!;
  assert.deepEqual(noVision.input, ["text"]);
  assert.equal(noVision.inputLimits, undefined);
  assert.equal(buildEntry(item(NEW, { name: undefined }), catalog)!.name, NEW);
});

test("新模型：没有窗口或没有输出上限（模板也给不了）就不要这一个", () => {
  assert.equal(buildEntry(item(NEW, { capabilities: { limits: { max_output_tokens: 5 } } }), catalog), undefined);
  // 输出上限缺：用模板的
  assert.equal(buildEntry(item(NEW, { capabilities: { limits: { max_prompt_tokens: 5 } } }), catalog)!.maxTokens, byId("claude-sonnet-5.5").maxTokens);
  assert.equal(buildEntry(item(NEW, { capabilities: { limits: { max_prompt_tokens: 5 } } }), [])?.api, undefined, "没有目录也没有输出上限");
});

test("新模型的思考：Anthropic 自适应——xhigh 和 max 写了才支持，没列的低档落到最近一档，不发 disabled", () => {
  const e = buildEntry(item(NEW, { capabilities: { supports: { thinking: true, adaptive_thinking: true, reasoning_effort: ["medium", "high", "xhigh"] } } }), catalog)!;
  assert.equal(e.reasoning, true);
  assert.equal((e.compat as Obj).forceAdaptiveThinking, true);
  assert.deepEqual(e.thinkingLevelMap, { off: null, minimal: "medium", low: "medium", xhigh: "xhigh" });
  const all = buildEntry(item(NEW), catalog)!;
  assert.deepEqual(all.thinkingLevelMap, { off: null, minimal: "low", xhigh: "xhigh", max: "max" });
});

test("新模型的思考：Anthropic 不自适应——预算式，没有映射，也不写 forceAdaptiveThinking", () => {
  const e = buildEntry(item("claude-haiku-5.9", { capabilities: { supports: { thinking: true, adaptive_thinking: false, reasoning_effort: ["low", "high"] } } }), catalog)!;
  assert.equal(e.reasoning, true);
  assert.equal((e.compat as Obj | undefined)?.forceAdaptiveThinking, undefined);
  assert.equal(e.thinkingLevelMap, undefined);
});

test("新模型的思考：没有任何思考字段的不是推理模型，没有映射", () => {
  const e = buildEntry(item(NEW, { capabilities: { supports: { tool_calls: true, adaptive_thinking: undefined, thinking: undefined, reasoning_effort: undefined } } }), catalog)!;
  assert.equal(e.reasoning, false);
  assert.equal(e.thinkingLevelMap, undefined);
  assert.equal((e.compat as Obj | undefined)?.forceAdaptiveThinking, undefined, "模板的自适应不带过来");
});

test("新模型的思考：OpenAI 两种——列出的级别原样，没列的 xhigh 和 max 是 null，minimal 到 high 落到最近一档，none 才能关", () => {
  const eps = ["/responses"];
  const e = buildEntry(item("gpt-6.2-sol", { supported_endpoints: eps, capabilities: { supports: { thinking: true, reasoning_effort: ["low", "medium", "high", "xhigh"] } } }), catalog)!;
  assert.deepEqual(e.thinkingLevelMap, { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null, off: null });
  const none = buildEntry(item("gpt-6.2-sol", { supported_endpoints: eps, capabilities: { supports: { thinking: true, reasoning_effort: ["none", "low", "medium", "high"] } } }), catalog)!;
  assert.equal((none.thinkingLevelMap as Obj).off, "none");
  const c = buildEntry(item("gemini-9", { supported_endpoints: ["/chat/completions"], capabilities: { supports: { thinking: true, reasoning_effort: ["low", "high"] } } }), catalog)!;
  assert.equal((c.compat as Obj).supportsReasoningEffort, true);
  assert.deepEqual((c.thinkingLevelMap as Obj).medium, "low", "同样近取低的");
  const noEffort = buildEntry(item("gemini-9", { supported_endpoints: ["/chat/completions"], capabilities: { supports: { thinking: true } } }), catalog)!;
  assert.equal((noEffort.compat as Obj).supportsReasoningEffort, false);
  assert.equal(noEffort.thinkingLevelMap, undefined);
});

// ---------- 刷新 ----------

function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "tau-copilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelsDir = join(dir, "models");
  const stateFile = join(dir, "extras", "models", "github-copilot.json");
  const file = join(modelsDir, "github-copilot.json");
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let respond: () => Response | Promise<Response> = () => Response.json({ data: [item(NEW, limits({ max_prompt_tokens: 150_000, max_output_tokens: 33_000 })), item("claude-sonnet-5.5", limits({ max_prompt_tokens: 111_000, max_output_tokens: 22_000 }))] });
  let clock = Date.UTC(2026, 10, 24);
  let auth: { auth: { apiKey?: string; baseUrl?: string } } | undefined = { auth: { apiKey: "tok-SECRET", baseUrl: "https://api.example.test/" } };
  const opts: RefreshOptions = {
    authFile: join(dir, "auth.json"),
    modelsDir,
    stateFile,
    models: { getAuth: async () => auth as never },
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return respond();
    }) as typeof fetch,
    now: () => clock,
  };
  return {
    dir, modelsDir, stateFile, file, calls, opts,
    respond: (f: () => Response | Promise<Response>) => (respond = f),
    json: (data: unknown[]) => (respond = () => Response.json({ data })),
    tick: (ms: number) => (clock += ms),
    login: (a: typeof auth) => (auth = a),
    read: () => JSON.parse(readFileSync(file, "utf8")) as Obj,
  };
}

test("刷新：请求 <账号的 API 地址>/models，带令牌、目录里的请求头和 X-GitHub-Api-Version；写出的文件内核读得了，每条都合格", async (t) => {
  const s = setup(t);
  const r = await refreshCopilot(s.opts);
  assert.equal(r.kind, "ok", r.summary);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.url, "https://api.example.test/models");
  const h = s.calls[0]!.headers;
  assert.equal(h.Authorization, "Bearer tok-SECRET");
  assert.equal(h.Accept, "application/json");
  assert.equal(h["X-GitHub-Api-Version"], API_VERSION);
  for (const [k, v] of Object.entries(byId("claude-sonnet-5.5").headers!)) assert.equal(h[k], v, k);
  const doc = s.read();
  assert.deepEqual(doc.models.map((m: Obj) => m.id), [NEW, "claude-sonnet-5.5"]);
  assert.equal(doc.generatedAt, "2026-11-24T00:00:00.000Z");
  assert.match(doc.piAiVersion, /^\d+\.\d+\.\d+/);
  const read = readModelFile(s.modelsDir, "github-copilot");
  assert.deepEqual(read.map((m) => m.id), [NEW, "claude-sonnet-5.5"]);
  assert.equal(read[1]!.contextWindow, 111_000);
  assert.match(r.summary, /2 个/);
  assert.doesNotMatch(r.summary + readFileSync(s.stateFile, "utf8"), /SECRET/, "令牌不进摘要和状态");
  assert.equal(readLastSuccess(s.stateFile), Date.UTC(2026, 10, 24));
  assert.deepEqual(readdirSync(s.modelsDir), ["github-copilot.json"]);
});

test("刷新：没登录就什么都不做，不请求，不写文件", async (t) => {
  const s = setup(t);
  s.login(undefined);
  assert.equal((await refreshCopilot(s.opts)).kind, "skipped");
  s.login({ auth: {} });
  assert.equal((await refreshCopilot(s.opts)).kind, "skipped");
  assert.equal(s.calls.length, 0);
  assert.equal(existsSync(s.file), false);
});

test("刷新：取凭据出错（凭据文件坏了）是失败，旧文件不动", async (t) => {
  const s = setup(t);
  await refreshCopilot(s.opts);
  const before = readFileSync(s.file, "utf8");
  const r = await refreshCopilot({ ...s.opts, models: { getAuth: async () => Promise.reject(new Error("auth.json 不是合法的 JSON。")) } });
  assert.equal(r.kind, "failed");
  assert.match(r.summary, /auth\.json/);
  assert.equal(readFileSync(s.file, "utf8"), before);
});

test("刷新：失败（网络出错、超时、非 2xx、不是 JSON、没有 data、一个可用模型都没有、都生成不出）一律不动旧文件和状态", async (t) => {
  const s = setup(t);
  assert.equal((await refreshCopilot(s.opts)).kind, "ok");
  const file = readFileSync(s.file, "utf8");
  const state = readFileSync(s.stateFile, "utf8");
  const cases: [string, () => Response | Promise<Response>][] = [
    ["网络出错", () => Promise.reject(new TypeError("fetch failed"))],
    ["500", () => new Response("boom", { status: 500 })],
    ["401", () => new Response("{}", { status: 401 })],
    ["不是 JSON", () => new Response("<html>")],
    ["没有 data", () => Response.json({ models: [] })],
    ["data 是空的", () => Response.json({ data: [] })],
    ["都被策略禁了", () => Response.json({ data: [item("a", { policy: { state: "disabled" } })] })],
    ["都生成不出（没有窗口）", () => Response.json({ data: [item("a", { capabilities: { limits: {} } })] })],
  ];
  for (const [name, f] of cases) {
    s.respond(f);
    const r = await refreshCopilot(s.opts);
    assert.equal(r.kind, "failed", name);
    assert.match(r.summary, /旧文件没动/, name);
    assert.equal(readFileSync(s.file, "utf8"), file, name);
    assert.equal(readFileSync(s.stateFile, "utf8"), state, name);
  }
  s.respond(() => new Promise(() => {}));
  const slow = await refreshCopilot({ ...s.opts, fetch: (async (_u: unknown, init?: RequestInit) => new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)))) as never, timeoutMs: 20 });
  assert.equal(slow.kind, "failed", "超时");
  assert.equal(readFileSync(s.file, "utf8"), file);
});

test("刷新：写不了（目录位置是个文件）是失败，不抛错", async (t) => {
  const s = setup(t);
  writeFileSync(s.modelsDir, "i am a file");
  const r = await refreshCopilot(s.opts);
  assert.equal(r.kind, "failed");
});

test("刷新：生成出来不合格的条目不写（照内核的条件再查一遍），别的照写", async (t) => {
  const s = setup(t);
  // id 里有换行：内核会跳过这个条目，这里就不写。
  s.json([item("bad\nid", limits({ max_prompt_tokens: 100, max_output_tokens: 10 })), item("good", limits({ max_prompt_tokens: 100, max_output_tokens: 10 }))]);
  const r = await refreshCopilot(s.opts);
  assert.equal(r.kind, "ok", r.summary);
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["good"]);
  assert.equal(readModelFile(s.modelsDir, "github-copilot").length, 1);
});

test("宽限：这一次没出现、7 天内出现过的模型照留，超过 7 天丢掉；再出现就按新的", async (t) => {
  const s = setup(t);
  s.json([item("a", limits({ max_prompt_tokens: 100, max_output_tokens: 10 })), item("b", limits({ max_prompt_tokens: 200, max_output_tokens: 10 }))]);
  await refreshCopilot(s.opts);
  // 1 天后：只回 a。
  s.tick(24 * 3600_000);
  s.json([item("a", limits({ max_prompt_tokens: 101, max_output_tokens: 10 }))]);
  const r = await refreshCopilot(s.opts);
  assert.deepEqual(s.read().models.map((m: Obj) => [m.id, m.contextWindow]), [["a", 101], ["b", 200]]);
  assert.match(r.summary, /保留上次的 1 个/);
  // 又过 6 天（离 b 上次出现 7 天整）：还留；再过 1 毫秒：丢。
  s.tick(6 * 24 * 3600_000);
  await refreshCopilot(s.opts);
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["a", "b"]);
  s.tick(1);
  await refreshCopilot(s.opts);
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["a"]);
  assert.equal(GRACE_MS, 7 * 24 * 3600_000);
  // b 回来：用这一次的。
  s.json([item("b", limits({ max_prompt_tokens: 300, max_output_tokens: 10 })), item("a", limits({ max_prompt_tokens: 101, max_output_tokens: 10 }))]);
  await refreshCopilot(s.opts);
  assert.deepEqual(s.read().models.map((m: Obj) => [m.id, m.contextWindow]), [["b", 300], ["a", 101]]);
});

test("换账号：forgetSeen 不认旧的见过状态，旧账号的模型当场丢掉；状态记新的，lastSuccess 照常更新", async (t) => {
  const s = setup(t);
  s.json([item("old-a", limits({ max_prompt_tokens: 100, max_output_tokens: 10 }))]);
  await refreshCopilot(s.opts);
  s.tick(1000);
  s.json([item("new-b", limits({ max_prompt_tokens: 200, max_output_tokens: 10 }))]);
  await refreshCopilot(s.opts);
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["new-b", "old-a"], "平常的刷新：旧的留着");
  s.tick(1000);
  const r = await refreshCopilot({ ...s.opts, forgetSeen: true });
  assert.equal(r.kind, "ok", r.summary);
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["new-b"]);
  assert.match(r.summary, /保留上次的 0 个/);
  const state = JSON.parse(readFileSync(s.stateFile, "utf8")) as Obj;
  assert.deepEqual(Object.keys(state.seen), ["new-b"]);
  assert.equal(state.lastSuccess, Date.UTC(2026, 10, 24) + 2000);
  // 失败时不动：忽略旧状态只在成功写出之后才生效。
  s.tick(1000);
  s.respond(() => new Response("x", { status: 500 }));
  await refreshCopilot({ ...s.opts, forgetSeen: true });
  assert.deepEqual(Object.keys((JSON.parse(readFileSync(s.stateFile, "utf8")) as Obj).seen), ["new-b"]);
});

test("宽限：失败的那一次不算见过，也不动状态；状态文件坏了当没有", async (t) => {
  const s = setup(t);
  s.json([item("a", limits({ max_prompt_tokens: 100, max_output_tokens: 10 }))]);
  await refreshCopilot(s.opts);
  writeFileSync(s.stateFile, "{garbage");
  s.tick(1000);
  s.json([item("c", limits({ max_prompt_tokens: 100, max_output_tokens: 10 }))]);
  assert.equal((await refreshCopilot(s.opts)).kind, "ok");
  assert.deepEqual(s.read().models.map((m: Obj) => m.id), ["c"]);
  assert.equal(readLastSuccess(join(s.dir, "nope.json")), undefined);
});

// ---------- 命令行 ----------

test("命令行：成功 0、没登录 0、失败 1（摘要在标准错误）、用法错误 2；--file 决定家目录，--dir 改模型目录", async () => {
  const run = async (argv: string[], result?: { kind: "ok" | "skipped" | "failed"; summary: string }) => {
    const out: string[] = [], err: string[] = [], seen: RefreshOptions[] = [];
    const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), refresh: async (o) => (seen.push(o), result ?? { kind: "ok", summary: "好" }) });
    return { code, out: out.join(""), err: err.join(""), seen };
  };
  const ok = await run(["--file", join("x", "home", "auth.json")]);
  assert.equal(ok.code, 0);
  assert.equal(ok.out, "好\n");
  assert.match(ok.seen[0]!.modelsDir, /home[\\/]models$/);
  assert.match(ok.seen[0]!.stateFile, /home[\\/]extras[\\/]models[\\/]github-copilot\.json$/);
  assert.match(ok.seen[0]!.authFile, /home[\\/]auth\.json$/);
  assert.match((await run(["--file", "a/auth.json", "--dir", "d/m"])).seen[0]!.modelsDir, /d[\\/]m$/);
  assert.equal((await run(["--file", "a/auth.json"], { kind: "skipped", summary: "没登录" })).code, 0);
  const bad = await run(["--file", "a/auth.json"], { kind: "failed", summary: "坏了" });
  assert.equal(bad.code, 1);
  assert.equal(bad.err, "坏了\n");
  for (const argv of [["--nope"], ["extra"], ["--file"]]) {
    const u = await run(argv);
    assert.equal(u.code, 2, argv.join(" "));
    assert.match(u.err, /用法/);
    assert.equal(u.seen.length, 0);
  }
});
