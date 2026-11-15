// 派生函数（设计稿第 4.1 节的表）：能从工作段算出来的值不存。
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../../src/kernel/decide.ts";
import { BYTES_PER_TOKEN, clip, contextUsed, pendingCalls, segmentStartedAt, TOOL_RESULT_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import type { Message } from "../../src/kernel/types.ts";
import { assistant, call, env, preset, usage } from "./helpers.ts";

const p = start("p", preset(), env(0));
const user = (text: string, timestamp = 0): Message => ({ role: "user", content: text, timestamp });
const result = (id: string, text = "好"): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 });

test("上下文用量：最后一条用量不为 0 的助手消息取 totalTokens，再加上它之后的消息按字节估算", () => {
  const seg = [user("u"), assistant({ usage: 100, text: "旧的" }), user("v"), assistant({ usage: 5_000, text: "好" })];
  assert.equal(contextUsed(p, seg), 5_000);
  const tail = "字".repeat(300);
  const more = [...seg, user(tail)];
  const added = contextUsed(p, more) - 5_000;
  assert.ok(added >= utf8Bytes(tail) / BYTES_PER_TOKEN, `后面的消息只估了 ${added}`);
  assert.ok(added <= (utf8Bytes(tail) + 64) / BYTES_PER_TOKEN, `后面的消息估了 ${added}`);
});

test("上下文用量：totalTokens 为 0 时取四项之和", () => {
  const m = assistant({ usage: usage(0, { input: 10, output: 20, cacheRead: 300, cacheWrite: 4_000 }), text: "好" });
  assert.equal(contextUsed(p, [user("u"), m]), 4_330);
});

test("上下文用量：用量为 0 的助手消息被跳过，它本身也按字节估算", () => {
  const zero = assistant({ usage: 0, text: "x".repeat(3_000) });
  const seg = [user("u"), assistant({ usage: 1_000, text: "好" }), user("v"), zero];
  const used = contextUsed(p, seg);
  assert.ok(used >= 1_000 + 3_000 / BYTES_PER_TOKEN, String(used));
});

test("上下文用量：没有这样的助手消息时全部按字节估算，含系统提示词和记忆视图", () => {
  const seg = [user("u")];
  const bare = contextUsed(p, seg);
  assert.ok(bare >= utf8Bytes(p.preset.prompt) / BYTES_PER_TOKEN);
  const view = "k: " + "v".repeat(3_000);
  const withView = contextUsed({ ...p, segment: { seq: 1, memoryView: view } }, seg);
  assert.ok(withView - bare >= utf8Bytes(view) / BYTES_PER_TOKEN - 1, `记忆视图只多了 ${withView - bare}`);
  assert.ok(contextUsed(p, [user("u"), assistant({ usage: 0, text: "好" })]) > bare, "用量为 0 的助手消息也按字节算");
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

test("工具结果的字节上限：不超时原样返回，超出时保留头尾", () => {
  assert.equal(clip("短"), "短");
  const exact = "a".repeat(TOOL_RESULT_MAX_BYTES);
  assert.equal(clip(exact), exact);
  const long = "头" + "中".repeat(TOOL_RESULT_MAX_BYTES) + "尾";
  const out = clip(long);
  assert.ok(utf8Bytes(out) <= TOOL_RESULT_MAX_BYTES);
  assert.ok(out.startsWith("头中") && out.endsWith("中尾"));
});
