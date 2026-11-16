// 带图的工具结果的请求体（设计稿第 9 节第 7 步的核实，D45）：claude-opus-5-5 不真调用，只断言请求体。
// 走执行器和真的 pi-ai 适配器，onPayload 截下来；假 fetch 回 400，不联网；凭据是假的。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createActions } from "../../src/executor/actions.ts";
import { start } from "../../src/kernel/decide.ts";
import type { Message } from "../../src/kernel/types.ts";
import { BLOB_PREFIX } from "../../src/store/blobs.ts";
import { checkImages } from "../../src/images.ts";
import { png } from "../images.ts";
import { PRESET, reply, toolCall } from "./fixtures.ts";

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

const bytes = png(768, 768, 3);
const [image] = checkImages([bytes.toString("base64")]);
const toolResult: Message = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "shot",
  content: [
    { type: "text", text: "截图如下" },
    { type: "image", data: BLOB_PREFIX + image!.hash, mimeType: "image/png" },
  ],
  isError: false,
  timestamp: 0,
};
const head: Message[] = [{ role: "user", content: "截图", timestamp: 0 }, reply("toolUse", [toolCall("c1", "shot")]), toolResult];
const letter: Message = { role: "user", content: "补充：最后一行写 PINEAPPLE。", timestamp: 0 };

async function bodyFor(segment: Message[]): Promise<{ messages: Array<{ role: string; content: unknown }> }> {
  let payload: unknown;
  const models = {
    getModel: (p: string, id: string) => real.getModel(p, id),
    streamSimple: (m: Model<Api>, context: unknown, options: SimpleStreamOptions) =>
      real.streamSimple(m, context as never, { ...options, onPayload: (x) => void (payload = x), fetch: (async () => new Response("{}", { status: 400 })) as never }),
  } as unknown as Models;
  const m = real.getModel("anthropic", "claude-opus-5-5");
  assert.ok(m);
  const preset = { ...PRESET, model: "anthropic/claude-opus-5-5", contextWindow: m.contextWindow, input: ["text", "image"] as const };
  const process = start("p1", { ...preset, input: [...preset.input] }, { now: 0, memoryView: "" });
  const job = { process, segment, effect: { kind: "callModel" as const, n: 2, purpose: "turn" as const } };
  const actions = createActions(models, () => {}, "test-pipe", (hash) => (hash === image!.hash ? bytes : undefined));
  await actions.callModel(job, new AbortController().signal);
  assert.ok(payload, "onPayload 没被调用");
  const body = payload as { messages: Array<{ role: string; content: unknown }> };
  // pi-ai 在末尾加一条只带 output_config 的 system 消息（思考级别），不是对话内容。
  return { ...body, messages: body.messages.filter((m) => m.role !== "system") };
}

type Block = { type: string; [k: string]: unknown };
/** 带图的 tool_result 块：内容里文字在前，图片在后，图片是 base64，没有 blob: 引用。 */
function assertImageResult(block: Block): void {
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "c1");
  const content = block.content as Block[];
  assert.deepEqual(
    content.map((c) => c.type),
    ["text", "image"],
  );
  assert.equal(content[0]!.text, "截图如下");
  const source = content[1]!.source as { type: string; media_type: string; data: string };
  assert.deepEqual({ type: source.type, media_type: source.media_type }, { type: "base64", media_type: "image/png" });
  assert.equal(source.data, bytes.toString("base64"));
}

test("opus 请求体，形状一：以带图的工具结果结尾，图在 tool_result 里，最后一条是 user", async () => {
  const body = await bodyFor(head);
  const last = body.messages.at(-1)!;
  assert.equal(last.role, "user");
  const blocks = last.content as Block[];
  assert.equal(blocks.length, 1);
  assertImageResult(blocks[0]!);
  assert.ok(!JSON.stringify(body).includes(BLOB_PREFIX), "请求里不留 blob: 引用");
});

test("opus 请求体，形状二：工具结果后并入的信，是紧跟在 tool_result 后的另一条 user 消息", async () => {
  const body = await bodyFor([...head, letter]);
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["user", "assistant", "user", "user"],
    "pi-ai 不合并相邻的 user：tool_result 一条，信一条",
  );
  const [result, mail] = body.messages.slice(-2) as unknown as [{ content: Block[] }, { content: Block[] }];
  assert.equal(result.content.length, 1);
  assertImageResult(result.content[0]!);
  assert.deepEqual(
    mail.content.map((b) => [b.type, b.text]),
    [["text", "补充：最后一行写 PINEAPPLE。"]],
  );
  assert.ok(!JSON.stringify(body).includes(BLOB_PREFIX));
});
