// 设计稿 5.7：执行器传给 pi-ai 的参数，和每个在用的模型请求体里的输出上限、思考预算、重试。
// 不联网：假凭据、假 fetch。不读真凭据。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model, Models, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createActions, MODEL_RETRIES } from "../../src/executor/actions.ts";
import { outputMax } from "../../src/kernel/derive.ts";
import type { Message, PresetSnapshot } from "../../src/kernel/types.ts";
import { start } from "../../src/kernel/decide.ts";
import { PRESET } from "./fixtures.ts";

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
const real = builtinModels({ credentials });

function job(preset: PresetSnapshot) {
  const segment: Message[] = [{ role: "user", content: "你好", timestamp: 0 }];
  const process = start("p1", preset, { now: 0, memoryView: "" });
  return { process, segment, effect: { kind: "callModel" as const, n: 1, purpose: "turn" as const } };
}

type Call = { model: Model<Api>; options: SimpleStreamOptions };

/** 假的 Models：记下 streamSimple 收到的参数，用真目录里的模型。 */
function recording(): { models: Models; calls: Call[] } {
  const calls: Call[] = [];
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple(model: Model<Api>, context: unknown, options: SimpleStreamOptions) {
      calls.push({ model, options });
      return real.streamSimple(model, context as never, { ...options, fetch: (async () => new Response("{}", { status: 400 })) as never });
    },
  } as unknown as Models;
  return { models, calls };
}

const noText = () => {};
const preset = (model: string, thinking?: ThinkingLevel): PresetSnapshot => {
  const m = real.getModel(model.split("/")[0]!, model.split("/").slice(1).join("/"));
  assert.ok(m, `模型目录里没有 ${model}`);
  return { ...PRESET, model, contextWindow: m.contextWindow, ...(thinking ? { thinking } : {}) };
};

test("执行器传给 pi-ai：模型的 maxTokens 和 options.maxTokens 都是 cap，maxRetries 是 MODEL_RETRIES，没有 thinkingBudgets", async () => {
  const { models, calls } = recording();
  const p = preset("anthropic/claude-haiku-4-5", "high");
  await createActions(models, noText, "test-pipe", () => undefined).callModel(job(p), new AbortController().signal);
  const c = calls[0]!;
  const cap = Math.min(real.getModel("anthropic", "claude-haiku-4-5")!.maxTokens, outputMax(p));
  assert.equal(cap, 25_000);
  assert.equal(c.model.maxTokens, cap);
  assert.equal(c.options.maxTokens, cap);
  assert.equal(c.options.reasoning, "high");
  assert.equal(c.options.maxRetries, MODEL_RETRIES);
  assert.equal(MODEL_RETRIES, 5);
  assert.equal("thinkingBudgets" in c.options, false);
  assert.equal(c.options.sessionId, "p1");
});

test("模型的 maxTokens 比 outputMax 小时，cap 是模型的上限", async () => {
  const { models, calls } = recording();
  const p = { ...preset("anthropic/claude-haiku-4-5"), contextWindow: 4_000_000 };
  await createActions(models, noText, "test-pipe", () => undefined).callModel(job(p), new AbortController().signal);
  assert.equal(calls[0]!.model.maxTokens, 64_000);
  assert.equal(calls[0]!.options.maxTokens, 64_000);
});

test("预设没写 thinking：不传 reasoning，键都不在", async () => {
  const { models, calls } = recording();
  await createActions(models, noText, "test-pipe", () => undefined).callModel(job(preset("anthropic/claude-haiku-4-5")), new AbortController().signal);
  assert.equal("reasoning" in calls[0]!.options, false);
});

type Case = { model: string; api: string; field: "max_tokens" | "max_output_tokens"; budget: boolean };
const CASES: Case[] = [
  { model: "anthropic/claude-haiku-4-5", api: "anthropic-messages", field: "max_tokens", budget: true },
  { model: "anthropic/claude-opus-5-5", api: "anthropic-messages", field: "max_tokens", budget: false },
  { model: "opencode-go/deepseek-v4.1-flash", api: "openai-completions", field: "max_tokens", budget: false },
  { model: "opencode-go/mimo-v2.6-flash", api: "openai-completions", field: "max_tokens", budget: false },
  { model: "opencode-go/gpt-6-luna", api: "openai-responses", field: "max_output_tokens", budget: false },
  { model: "opencode-go/muse-spark-1.3-contributor", api: "openai-responses", field: "max_output_tokens", budget: false },
];

/** 请求体：经执行器和真的 pi-ai 适配器，用 onPayload 截下来；假 fetch 回 400，不联网。 */
async function payloadFor(model: string, thinking?: ThinkingLevel): Promise<{ payload: Record<string, unknown>; cap: number; fetches: number }> {
  let payload: Record<string, unknown> | undefined;
  let fetches = 0;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, {
        ...options,
        onPayload: (x) => {
          payload = x as Record<string, unknown>;
        },
        fetch: (async () => {
          fetches++;
          return new Response("{}", { status: 400 });
        }) as never,
      }),
  } as unknown as Models;
  const p = preset(model, thinking);
  await createActions(models, noText, "test-pipe", () => undefined).callModel(job(p), new AbortController().signal);
  assert.ok(payload, "onPayload 没被调用");
  const slash = model.indexOf("/");
  return { payload, cap: Math.min(real.getModel(model.slice(0, slash), model.slice(slash + 1))!.maxTokens, outputMax(p)), fetches };
}

for (const c of CASES) {
  for (const thinking of [undefined, "high", "max"] as const) {
    test(`请求体 ${c.model}（${c.api}）thinking=${thinking ?? "无"}：输出上限不超过 cap`, async () => {
      const m = real.getModel(c.model.split("/")[0]!, c.model.split("/").slice(1).join("/"));
      assert.equal(m?.api, c.api);
      const { payload, cap, fetches } = await payloadFor(c.model, thinking);
      assert.equal(cap, Math.min(m!.maxTokens, Math.floor(m!.contextWindow / 8)));
      const limit = payload[c.field];
      assert.equal(typeof limit, "number");
      assert.ok((limit as number) <= cap, `${c.field} ${String(limit)} 超过 cap ${cap}`);
      assert.equal(limit, cap, "不思考和自适应路径上，上限就是 cap");
      assert.equal(fetches, 1, "400 不重试");
      const think = payload.thinking as { type?: string; budget_tokens?: number } | undefined;
      if (c.budget && thinking) {
        assert.equal(think?.type, "enabled");
        assert.ok(think!.budget_tokens! < (limit as number), "预算路径上，思考预算小于 max_tokens");
        assert.equal(think!.budget_tokens, 16_384, "high 和 max 都按 high 的预算");
      } else if (c.budget) {
        assert.deepEqual(think, { type: "disabled" });
      }
    });
  }
}

test("预算路径：cap 不大于预算加 1,024 时，预算被压到 cap 减 1,024，回答只剩 1,024", async () => {
  // 合成：窗口 8×17,408，cap = 17,408，high 的预算 16,384 正好卡在边界。
  let payload: Record<string, any> | undefined;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, { ...options, onPayload: (x) => void (payload = x as never), fetch: (async () => new Response("{}", { status: 400 })) as never }),
  } as unknown as Models;
  const p = { ...preset("anthropic/claude-haiku-4-5", "high"), contextWindow: 8 * 17_408 };
  await createActions(models, noText, "test-pipe", () => undefined).callModel(job(p), new AbortController().signal);
  assert.equal(payload!.max_tokens, 17_408);
  assert.equal(payload!.thinking.budget_tokens, 17_408 - 1024);
});

// 重试：pi-ai 只重试拿到成功的响应之前的失败（设计稿 5.7）。假 fetch，退避用 retry-after-ms 压到 1 毫秒。
async function runWithFetch(fetchImpl: () => Promise<Response>): Promise<{ stopReason: string; errorMessage?: string; fetches: number }> {
  let fetches = 0;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, {
        ...options,
        fetch: (async () => {
          fetches++;
          return fetchImpl();
        }) as never,
      }),
  } as unknown as Models;
  const reply = await createActions(models, noText, "test-pipe", () => undefined).callModel(job(preset("opencode-go/mimo-v2.6-flash")), new AbortController().signal);
  return { stopReason: reply.stopReason, errorMessage: reply.errorMessage, fetches };
}

const err = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });

test("重试：5xx 带 retry-after-ms 时按它等，一共 1 + MODEL_RETRIES 次，然后出错", async () => {
  const r = await runWithFetch(async () => err(503, { "retry-after-ms": "1" }));
  assert.equal(r.fetches, 1 + MODEL_RETRIES);
  assert.equal(r.stopReason, "error");
});

for (const status of [408, 409, 429, 500]) {
  test(`重试：${status} 会重试`, async () => {
    const r = await runWithFetch(async () => err(status, { "retry-after-ms": "1" }));
    assert.equal(r.fetches, 1 + MODEL_RETRIES);
  });
}

for (const status of [400, 401, 403, 404, 422]) {
  test(`重试：${status} 不重试`, async () => {
    assert.equal((await runWithFetch(async () => err(status))).fetches, 1);
  });
}

test("重试：x-should-retry 头优先于状态码", async () => {
  assert.equal((await runWithFetch(async () => err(500, { "x-should-retry": "false" }))).fetches, 1);
  assert.equal((await runWithFetch(async () => err(400, { "x-should-retry": "true", "retry-after-ms": "1" }))).fetches, 1 + MODEL_RETRIES);
});

test("重试：没有状态码的连接错误会重试", async () => {
  let n = 0;
  const r = await runWithFetch(async () => {
    n++;
    if (n < 3) throw new TypeError("fetch failed");
    return err(400);
  });
  assert.equal(r.fetches, 3);
});

test("重试：retry-after 超过 60 秒就直接失败，不等", async () => {
  const t0 = Date.now();
  const r = await runWithFetch(async () => err(429, { "retry-after": "61" }));
  assert.equal(r.fetches, 1);
  assert.equal(r.stopReason, "error");
  assert.match(r.errorMessage ?? "", /61s retry delay \(max: 60s\)/);
  assert.ok(Date.now() - t0 < 5000);
  const r2 = await runWithFetch(async () => err(429, { "retry-after-ms": "60001" }));
  assert.equal(r2.fetches, 1);
});

test("重试：恰好 60 秒不算超过（只验证不被拒绝，用 retry-after-ms 的上限判断）", async () => {
  // 60,000 毫秒不超过上限；真等 60 秒太慢，所以中止它：被接受的重试在睡眠中响应中止。
  const ac = new AbortController();
  let fetches = 0;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, { ...options, fetch: (async () => (fetches++, err(429, { "retry-after-ms": "60000" }))) as never }),
  } as unknown as Models;
  const done = createActions(models, noText, "test-pipe", () => undefined).callModel(job(preset("opencode-go/mimo-v2.6-flash")), ac.signal);
  await new Promise((r) => setTimeout(r, 200));
  ac.abort();
  const reply = await done;
  assert.equal(fetches, 1);
  assert.equal(reply.stopReason, "aborted");
});
