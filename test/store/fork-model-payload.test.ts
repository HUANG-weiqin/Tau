// 跨模型 fork 的请求体（D53）：别的模型产生的历史（含思考、工具调用）fork 成 claude-opus-5-5 的预设以后，请求体的形状。
// opus 不真调用（Anthropic 的凭据只许配 Haiku 用），只断言请求体：走执行器和真的 pi-ai 适配器，onPayload 截下来；假 fetch 回 400，不联网；凭据是假的。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createActions } from "../../src/executor/actions.ts";
import { fork, start } from "../../src/kernel/decide.ts";
import type { AssistantMessage, Message } from "../../src/kernel/types.ts";
import { PRESET, toolCall } from "./fixtures.ts";

const real = builtinModels({
  credentials: {
    read: async () => ({ type: "api_key" as const, key: "test-key" }),
    list: async () => [],
    modify: async () => {
      throw new Error("只读");
    },
    delete: async () => {
      throw new Error("只读");
    },
  },
});

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const from = (api: Api, provider: string, model: string, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content,
  api,
  provider,
  model,
  usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
  stopReason,
  timestamp: 0,
});

// openai-responses 风格的调用 ID：`call_…|fc_…`，含 `|`，远超 64 个字符；Anthropic 要求 ^[a-zA-Z0-9_-]{1,64}$。
const LONG_ID = "call_" + "AbC1".repeat(10) + "|fc_" + "xYz9".repeat(40);
// openai-completions 风格的调用 ID。
const PLAIN_ID = "call_00_abcdefghijklmnop";
const SIGNATURE = JSON.stringify({ type: "reasoning", id: "rs_0123456789", summary: [{ type: "summary_text", text: "想一想" }] });

const history: Message[] = [
  { role: "user", content: "取两个暗号。", timestamp: 0 },
  from(
    "openai-responses",
    "opencode-go",
    "gpt-6-luna",
    [{ type: "thinking", thinking: "先取第一个。", thinkingSignature: SIGNATURE }, toolCall(LONG_ID, "code_a")],
    "toolUse",
  ),
  { role: "toolResult", toolCallId: LONG_ID, toolName: "code_a", content: [{ type: "text", text: "暗号是 MANGO7" }], isError: false, timestamp: 0 },
  from(
    "openai-completions",
    "opencode-go",
    "deepseek-v4.1-flash",
    [{ type: "thinking", thinking: "再取第二个。", thinkingSignature: "reasoning_content" }, toolCall(PLAIN_ID, "code_b")],
    "toolUse",
  ),
  { role: "toolResult", toolCallId: PLAIN_ID, toolName: "code_b", content: [{ type: "text", text: "暗号是 KIWI42" }], isError: false, timestamp: 0 },
  from("openai-completions", "opencode-go", "deepseek-v4.1-flash", [{ type: "thinking", thinking: "好了。", thinkingSignature: "reasoning_content" }, { type: "text", text: "两个暗号是 MANGO7 和 KIWI42。" }], "stop"),
];

type Block = { type: string; [k: string]: unknown };
type Body = { messages: Array<{ role: string; content: Block[] | string }> };

async function bodyAfterFork(): Promise<Body> {
  let payload: unknown;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, { ...options, onPayload: (x) => void (payload = x), fetch: (async () => new Response("{}", { status: 400 })) as never }),
  } as unknown as Models;
  const m = real.getModel("anthropic", "claude-opus-5-5");
  assert.ok(m);
  const opus = { ...PRESET, id: "opus", model: "anthropic/claude-opus-5-5", contextWindow: m.contextWindow, input: ["text" as const, "image" as const], tools: [], thinking: "low" as const };
  const source = start("src", PRESET, { now: 0, memoryView: "" });
  const r = fork("f1", source, history, undefined, 0, { preset: opus, memoryView: "" });
  assert.deepEqual(r.messages, history, "同样支持图片，历史原样复制");
  const segment: Message[] = [...r.messages, { role: "user", content: "两个暗号各是什么？", timestamp: 0 }];
  const job = { process: r.process, segment, effect: { kind: "callModel" as const, n: 1, purpose: "turn" as const } };
  await createActions(models, () => {}, "test-pipe", () => undefined).callModel(job, new AbortController().signal);
  assert.ok(payload, "onPayload 没被调用");
  const body = payload as Body;
  // pi-ai 在末尾加一条只带 output_config 的 system 消息（思考级别），不是对话内容。
  return { ...body, messages: body.messages.filter((x) => x.role !== "system") };
}

test("fork 成 opus：别家的思考被丢掉（不当思考块发，也不变成文字），调用 ID 合规，调用和结果配得上", async () => {
  const { messages } = await bodyAfterFork();
  const blocks = messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
  assert.ok(!blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking" || "signature" in b), "别家的思考不能当 Anthropic 的 thinking 块发出");
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user", "assistant", "user"],
  );
  const assistantTexts = messages.filter((m) => m.role === "assistant").map((m) => (m.content as Block[]).filter((b) => b.type === "text").map((b) => b.text));
  assert.deepEqual(assistantTexts, [[], [], ["两个暗号是 MANGO7 和 KIWI42。"]], "别家的思考整段丢掉，只剩文字");
  assert.ok(!JSON.stringify(messages).match(/先取第一个|再取第二个|好了。/), "思考的文字哪里都不出现");
  const uses = blocks.filter((b) => b.type === "tool_use");
  const results = blocks.filter((b) => b.type === "tool_result");
  assert.deepEqual(uses.map((b) => b.name), ["code_a", "code_b"]);
  for (const b of [...uses.map((u) => u.id), ...results.map((r) => r.tool_use_id)]) assert.match(String(b), /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual(results.map((r) => r.tool_use_id), uses.map((u) => u.id), "改过的 ID 在调用和结果两边一致");
  assert.notEqual(uses[0]!.id, LONG_ID);
  assert.equal(uses[1]!.id, PLAIN_ID, "本来合规的 ID 不动");
  assert.deepEqual(results.map((r) => r.content), ["暗号是 MANGO7", "暗号是 KIWI42"]);
  const last = messages.at(-1)!.content as Block[];
  assert.equal(last[0]!.text, "两个暗号各是什么？");
});
