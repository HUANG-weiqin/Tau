// D105 最重要的一条：拿 pi-ai 目录里每个 Copilot 聊天模型 M，用 M 自己的字段造一份 `/models` 条目，当作“目录里没有 M”生成条目，
// 再比较 pi-ai 对生成的条目和对 M 本身组出的请求体。差在哪里，要么改生成的规则，要么在 KNOWN 里写明为什么可以接受。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildEntry } from "../../../extras/models/copilot.ts";

type Obj = Record<string, any>;
const catalog = getBuiltinModels("github-copilot") as unknown as Model<Api>[];
const models = builtinModels({ credentials: { read: async () => ({ type: "api_key" as const, key: "k" }), list: async () => [], modify: async () => assert.fail(), delete: async () => assert.fail() } });

/** 用 M 自己的字段造一份 `/models` 条目。 */
function synthesize(m: Model<Api>): Obj {
  const compat = (m.compat ?? {}) as Obj;
  const map = (m.thinkingLevelMap ?? {}) as Obj;
  const levels = getSupportedThinkingLevels(m).filter((l) => l !== "off");
  const noEffort = m.api === "openai-completions" && compat.supportsReasoningEffort === false;
  const efforts = noEffort || !m.reasoning ? [] : [...new Set([...levels.map((l) => (typeof map[l] === "string" ? map[l] : l)), ...(typeof map.off === "string" ? [map.off] : [])])];
  const image = m.input.includes("image");
  return {
    id: m.id,
    name: m.name,
    supported_endpoints: m.api === "anthropic-messages" ? ["/v1/messages", "/chat/completions"] : m.api === "openai-responses" ? ["/responses", "ws:/responses"] : ["/chat/completions"],
    model_picker_enabled: true,
    capabilities: {
      type: "chat",
      limits: { max_prompt_tokens: m.contextWindow, max_output_tokens: m.maxTokens, ...(image ? { vision: { max_prompt_images: 20 } } : {}) },
      supports: { tool_calls: true, streaming: true, vision: image, thinking: m.reasoning, adaptive_thinking: compat.forceAdaptiveThinking === true, ...(efforts.length ? { reasoning_effort: efforts } : {}) },
    },
  };
}

const CTX = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "你好", timestamp: 0 }], tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } as never }] };

/** pi-ai 对这个模型组出的请求：地址、请求头（SDK 自己加的除外）、请求体。 */
async function request(model: Model<Api>, reasoning: ThinkingLevel | undefined): Promise<Obj> {
  let seen: Obj | undefined;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    // 请求头里 SDK 自己加的（x-stainless-*、user-agent）和每次不同的不比；模型自带的头、授权、版本这些都比。
    const headers = Object.fromEntries([...new Headers(init?.headers)].filter(([k]) => !/^(x-stainless-|user-agent$|x-request-id$)/.test(k)).sort(([a], [b]) => a.localeCompare(b)));
    seen = { url: String(url instanceof Request ? url.url : url), headers, body: JSON.parse(String(init?.body ?? "null")) };
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  const options: Obj = { apiKey: "k", fetch: fetchFn, maxRetries: 0 };
  if (reasoning) options.reasoning = reasoning;
  await models.streamSimple(model, CTX as never, options as never).result();
  assert.ok(seen, `${model.id} ${reasoning}: 没有发出请求`);
  return seen;
}

/** 两个请求哪里不一样：只列不同的键，值截短。 */
function describe(a: Obj, b: Obj): string {
  const out: string[] = [];
  const walk = (x: any, y: any, at: string): void => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${at}.${k}`);
    else out.push(`${at}: ${JSON.stringify(x)?.slice(0, 80)} -> ${JSON.stringify(y)?.slice(0, 80)}`);
  };
  walk(a, b, "");
  return out.join("; ");
}

const TAU_LEVELS: (ThinkingLevel | undefined)[] = [undefined, "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 已知而且接受的差别，每一条写为什么可以接受。没列的差别都算错。
 * 1. `thinking: {type: "disabled"}`：响应里没有“能不能关思考”这一项。目录里有的模型关得掉，有的（fable、opus-5.5）关不掉，
 *    发给关不掉的模型会报错。生成的 Anthropic 自适应条目一律不发 disabled（`off: null`），不思考时走模型的默认，最坏是多想一点。
 * 2. haiku 的 `eager_input_streaming`（请求体 `tools.N`）和请求头 `anthropic-beta` 里的 fine-grained-tool-streaming：
 *    目录里 haiku-4.5 的兼容开关写了 `supportsEagerToolInputStreaming: false`，这是个别模型的怪癖，响应里没有。
 *    生成的条目照同类（haiku）的兼容开关，所以 haiku-4.5 和 haiku-5.5 互相猜错一个；这两处是同一个开关的两面。
 */
const ACCEPTED: { why: string; ok: (id: string, part: string) => boolean }[] = [
  { why: "不发 disabled", ok: (_id, part) => part === '.body.thinking: {"type":"disabled"} -> undefined' },
  { why: "haiku 的个别怪癖：eager_input_streaming 和 anthropic-beta", ok: (id, part) => id.startsWith("claude-haiku-") && (/^\.body\.tools\.\d+\.eager_input_streaming: /.test(part) || part.startsWith(".headers.anthropic-beta: ")) },
];

test("往返：每个 pi-ai 目录里的 Copilot 聊天模型，当作目录外的新模型生成，发出的请求和目录里的它自己一样", async () => {
  const diffs: string[] = [];
  for (const m of catalog) {
    const rest = catalog.filter((x) => x.id !== m.id);
    const e = buildEntry(synthesize(m), rest);
    assert.ok(e, `${m.id}: 生成不出条目`);
    assert.equal(e.id, m.id);
    const gen = e as unknown as Model<Api>;
    assert.equal(gen.api, m.api, `${m.id}: 接口`);
    assert.equal(gen.contextWindow, m.contextWindow);
    assert.equal(gen.maxTokens, m.maxTokens);
    assert.deepEqual(gen.input, m.input);
    const a = new Set(getSupportedThinkingLevels(m)), b = new Set(getSupportedThinkingLevels(gen));
    // 少的只能是 off（不知道能不能关）；多的只能是 minimal（响应不列 minimal，生成的落到 low）。
    assert.deepEqual([...a].filter((l) => !b.has(l) && l !== "off"), [], `${m.id}: 生成的少了级别`);
    assert.deepEqual([...b].filter((l) => !a.has(l) && l !== "minimal"), [], `${m.id}: 生成的多了级别`);
    for (const level of TAU_LEVELS) {
      if (level !== undefined && !a.has(level)) continue; // tau 不会对 M 发它不支持的级别
      const ra = await request(m, level);
      const rb = await request(gen, level);
      try {
        assert.deepEqual(rb, ra);
      } catch {
        diffs.push(`${m.id} @ ${level ?? "none"}: ${describe(ra, rb)}`);
      }
    }
  }
  const unexpected = diffs.filter((d) => {
    const id = d.split(" @ ")[0]!;
    return !d.slice(d.indexOf(": ", d.indexOf(" @ ")) + 2).split("; ").every((part) => ACCEPTED.some((a) => a.ok(id, part)));
  });
  assert.deepEqual(unexpected, [], `请求体有差别：\n${unexpected.join("\n")}`);
});
