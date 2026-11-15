// 派生函数（设计稿第 4.1 节的表）：能从工作段算出来的值不存。
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPrompt, toolDefinitions } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import {
  BYTES_PER_TOKEN,
  clip,
  contextUsed,
  handoffThreshold,
  MESSAGE_MAX_BYTES,
  messageBytes,
  outputMax,
  pendingCalls,
  segmentStartedAt,
  tokens,
  utf8Bytes,
} from "../../src/kernel/derive.ts";
import type { Message } from "../../src/kernel/types.ts";
import { assistant, call, env, preset, usage } from "./helpers.ts";

const p = start("p", preset(), env(0));
const user = (text: string, timestamp = 0): Message => ({ role: "user", content: text, timestamp });
const result = (id: string, text = "好"): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 });
/** 用量为 1000 的锚点：它之后的消息按字节估算。 */
const anchored = (...after: Message[]): Message[] => [user("u"), assistant({ usage: 1_000, text: "好" }), ...after];

test("上下文用量：最后一条用量不为 0 的助手消息取 totalTokens，再加上它之后的消息按字节估算", () => {
  const seg = [user("u"), assistant({ usage: 100, text: "旧的" }), user("v"), assistant({ usage: 5_000, text: "好" })];
  assert.equal(contextUsed(p, seg), 5_000);
  const tail = "字".repeat(300);
  assert.equal(contextUsed(p, [...seg, user(tail)]) - 5_000, Math.ceil(utf8Bytes(tail) / BYTES_PER_TOKEN));
});

test("上下文用量：totalTokens 为 0 时取四项之和", () => {
  const m = assistant({ usage: usage(0, { input: 10, output: 20, cacheRead: 300, cacheWrite: 4_000 }), text: "好" });
  assert.equal(contextUsed(p, [user("u"), m]), 4_330);
});

test("上下文用量：用量为 0 的助手消息被跳过，它本身也按字节估算", () => {
  const zero = assistant({ usage: 0, text: "x".repeat(3_000) });
  const seg = [user("u"), assistant({ usage: 1_000, text: "好" }), user("v"), zero];
  assert.equal(contextUsed(p, seg), 1_000 + tokens(1 + 3_000));
});

test("上下文用量：没有这样的助手消息时全部按字节估算，含系统提示词、工具定义的 JSON 和记忆视图", () => {
  const seg = [user("u")];
  const bare = contextUsed(p, seg);
  assert.equal(bare, tokens(utf8Bytes(systemPrompt(p)) + utf8Bytes(JSON.stringify(toolDefinitions(p.preset))) + 1));
  const view = "k: " + "v".repeat(3_000);
  const withView = contextUsed({ ...p, segment: { seq: 1, memoryView: view } }, seg);
  assert.ok(withView - bare >= utf8Bytes(view) / BYTES_PER_TOKEN - 1, `记忆视图只多了 ${withView - bare}`);
  assert.ok(contextUsed(p, [user("u"), assistant({ usage: 0, text: "好" })]) > bare, "用量为 0 的助手消息也按字节算");
});

test("估算按原始字节算，不按 JSON 转义后的字节：N 字节的换行或 \\x01 估成 ceil(N/2)", () => {
  for (const ch of ["\n", "\x01"]) {
    for (const n of [1, 1_001, 30_000]) {
      assert.equal(contextUsed(p, anchored(user(ch.repeat(n)))), 1_000 + Math.ceil(n / 2), `${JSON.stringify(ch)} × ${n}`);
    }
  }
});

test("一条消息的字节：工具调用算 ID + 名称 + 参数的 JSON；工具结果算 ID + 名称 + 文本；思考也算", () => {
  const args = { path: "目录\\a.ts", text: "第一行\n\"引号\"" };
  const ask = assistant({ usage: 0, text: "文本", thinking: "想", calls: [call("id-1", "write", args)] });
  assert.equal(messageBytes(ask), utf8Bytes("文本") + utf8Bytes("想") + utf8Bytes("id-1") + utf8Bytes("write") + utf8Bytes(JSON.stringify(args)));
  assert.equal(messageBytes(result("id-1", "结果")), utf8Bytes("id-1") + utf8Bytes("read") + utf8Bytes("结果"));
  assert.equal(messageBytes(user("用户")), utf8Bytes("用户"));
  const blocks: Message = { role: "user", content: [{ type: "text", text: "ab" }, { type: "image", data: "QUJD", mimeType: "image/png" }], timestamp: 0 };
  assert.equal(messageBytes(blocks), 2 + 4);
});

test("估算只在总字节数上向上取整一次：三条 1 字节的消息估成 2", () => {
  assert.equal(contextUsed(p, anchored(user("a"), user("b"), user("c"))), 1_002);
  assert.equal(contextUsed(p, anchored()), 1_000, "锚点之后没有消息就不加");
});

test("输出上限和换段阈值：输出取窗口的 1/8，阈值之上放得下两次输出、一个结果和余量", () => {
  const cases: [number, number, number][] = [
    [65_536, 8_192, 28_672],
    [64_000, 8_000, 27_520],
    [128_000, 16_000, 75_520],
    [131_072, 16_384, 77_824],
    [200_000, 25_000, 129_520],
    [1_000_000, 125_000, 729_520],
  ];
  for (const [w, out, t] of cases) {
    const pr = preset({ contextWindow: w });
    assert.deepEqual([outputMax(pr), handoffThreshold(pr)], [out, t], `窗口 ${w}`);
  }
  assert.equal(handoffThreshold(preset({ contextWindow: 27_306 })), 0, "窗口太小时阈值不是正数，每次调用都换段");
  assert.equal(handoffThreshold(preset({ contextWindow: 27_307 })), 1);
});

test("本段开始时间是本段第一条消息的 timestamp", () => {
  assert.equal(segmentStartedAt([user("a", 42), user("b", 99)]), 42);
  assert.equal(segmentStartedAt([]), undefined);
});

test("待执行的工具调用：最后一条助手消息里还没有结果的调用", () => {
  const ask = assistant({ usage: 1, calls: [call("c1"), call("c2"), call("c3")] });
  assert.deepEqual(pendingCalls([user("u"), ask]).map((c) => c.id), ["c1", "c2", "c3"]);
  assert.deepEqual(pendingCalls([user("u"), ask, result("c1")]).map((c) => c.id), ["c2", "c3"]);
  assert.deepEqual(pendingCalls([user("u"), ask, result("c1"), result("c2"), result("c3")]), []);
  assert.deepEqual(pendingCalls([user("u"), assistant({ usage: 1, calls: [call("old")] }), result("old"), user("v")]), []);
  assert.deepEqual(pendingCalls([]), []);
});

test("消息的字节上限：不超时原样返回，超出时保留头尾", () => {
  assert.equal(clip("短"), "短");
  const exact = "a".repeat(MESSAGE_MAX_BYTES);
  assert.equal(clip(exact), exact);
  const long = "头" + "中".repeat(MESSAGE_MAX_BYTES) + "尾";
  const out = clip(long);
  assert.ok(utf8Bytes(out) <= MESSAGE_MAX_BYTES);
  assert.ok(out.startsWith("头中") && out.endsWith("中尾"));
});
