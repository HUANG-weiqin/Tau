// 上下文文件在纯函数层的部分（D72）：系统提示词里的一节、启动检查里的上界、假想的新段、出生处和 fork 带上视图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, CONTEXT_HEADING, contextSection, fixedPrompt, MEMORY_HEADING, memorySection, systemPrompt } from "../../src/kernel/context.ts";
import { fork, start } from "../../src/kernel/decide.ts";
import { contextUsed, fixedTokens, handoffThreshold, limits, newSegmentUsed, startError, tokens, utf8Bytes } from "../../src/kernel/derive.ts";
import { CONTEXT_VIEW_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../../src/kernel/tools.ts";
import type { Message, Process } from "../../src/kernel/types.ts";
import { env, preset } from "./helpers.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const VIEW = "### AGENTS.md\n先读测试。";
const withContext = (p: Process, contextView: string): Process => ({ ...p, segment: { ...p.segment, contextView } });

test("常量：上界 24 KiB，标题带前面的空行", () => {
  assert.equal(CONTEXT_VIEW_MAX_BYTES, 24 * 1024);
  assert.equal(CONTEXT_HEADING, "\n\n## 上下文文件（开段时的快照）\n\n");
});

test("系统提示词：没有上下文视图时和以前一字不变；有就是固定部分、上下文一节、记忆一节，上下文在记忆前面", () => {
  const p = start("p", preset(), env(0, "k: v"));
  assert.equal(systemPrompt(p), fixedPrompt(p.preset) + memorySection("k: v"));
  assert.equal(systemPrompt(p), `${p.preset.prompt}\n\n工作目录：${p.preset.workdir}${MEMORY_HEADING}k: v`);
  const q = withContext(p, VIEW);
  assert.equal(systemPrompt(q), fixedPrompt(q.preset) + CONTEXT_HEADING + VIEW + MEMORY_HEADING + "k: v");
  assert.ok(systemPrompt(q).indexOf("上下文文件") < systemPrompt(q).indexOf("记忆索引（开段时的快照）"));
  // 没有记忆时只有上下文一节。
  assert.equal(systemPrompt(withContext(start("p", preset(), env(0)), VIEW)), `${p.preset.prompt}\n\n工作目录：${p.preset.workdir}\n\n## 上下文文件（开段时的快照）\n\n${VIEW}`);
});

test("上下文一节：空视图没有；空串的 contextView 和缺省一样", () => {
  assert.equal(contextSection(""), "");
  assert.equal(contextSection(VIEW), CONTEXT_HEADING + VIEW);
  const p = start("p", preset(), env(0));
  assert.equal(systemPrompt(withContext(p, "")), systemPrompt(p));
});

test("模型请求的系统提示词带上下文一节", () => {
  const p = withContext(start("p", preset(), env(0)), VIEW);
  assert.equal(buildContext(p, [user("问")]).systemPrompt, systemPrompt(p));
  assert.ok(buildContext(p, [user("问")]).systemPrompt?.includes(VIEW));
});

test("上下文用量：没有锚点的估算算上上下文一节", () => {
  const p = start("p", preset(), env(0));
  const view = "### a.md\n" + "字".repeat(3_000);
  const diff = contextUsed(withContext(p, view), [user("u")]) - contextUsed(p, [user("u")]);
  assert.ok(diff >= utf8Bytes(CONTEXT_HEADING + view) / 2 - 1, `上下文一节只多了 ${diff} token`);
  assert.ok(diff <= utf8Bytes(CONTEXT_HEADING + view) / 2 + 1);
});

test("limits：没声明 context 时 contextMax 是 0，其余数字不变；context 为空数组也是 0", () => {
  const base = preset({ contextWindow: 200_000, tools: ["read", "memory"] });
  const l = limits(base);
  assert.deepEqual(l, { fixed: fixedTokens(base), memoryMax: tokens(utf8Bytes(MEMORY_HEADING) + MEMORY_VIEW_MAX_BYTES), contextMax: 0, threshold: handoffThreshold(base) });
  assert.equal(limits({ ...base, context: [] }).contextMax, 0);
});

test("limits：声明了 context 时 contextMax 是上界加一节标题的 token，不并进固定部分", () => {
  const base = preset({ contextWindow: 200_000, tools: ["read"] });
  const withCtx = { ...base, context: ["AGENTS.md"] };
  const l = limits(withCtx);
  assert.equal(l.contextMax, tokens(utf8Bytes(CONTEXT_HEADING) + CONTEXT_VIEW_MAX_BYTES));
  assert.equal(l.contextMax, 12_311);
  assert.equal(l.fixed, limits(base).fixed, "固定部分和有没有 context 无关");
  assert.equal(l.memoryMax, 0);
  assert.equal(l.threshold, limits(base).threshold);
});

test("startError：没声明 context 时文字一字不变；声明了才多一项上下文的上界", () => {
  const small = preset({ contextWindow: 30_000, tools: ["read", "memory"] });
  const l = limits(small);
  assert.equal(startError(small), `预设 ${small.id} 的窗口太小，装不下：固定部分 ${l.fixed} token，记忆的上界 ${l.memoryMax} token，换段阈值 ${l.threshold} token`);
  const c = { ...small, context: ["AGENTS.md"] };
  assert.equal(startError(c), `预设 ${small.id} 的窗口太小，装不下：固定部分 ${l.fixed} token，记忆的上界 ${l.memoryMax} token，上下文的上界 ${limits(c).contextMax} token，换段阈值 ${l.threshold} token`);
});

test("startError：窗口刚好够不带上下文的预设，声明了 context 就挡住；上界刚好够的窗口通过，少 1 token 的窗口挡住", () => {
  const base = preset({ tools: ["read", "memory"] });
  const edge = (extra: { context?: string[] }) => {
    let W = 30_000;
    while (startError({ ...base, ...extra, contextWindow: W }) !== null) W++;
    return W;
  };
  const plainW = edge({});
  const ctxW = edge({ context: ["a"] });
  assert.ok(ctxW > plainW, "上下文的上界要多占窗口");
  assert.equal(startError({ ...base, contextWindow: plainW }), null);
  assert.match(startError({ ...base, contextWindow: plainW, context: ["a"] }) ?? "", /窗口太小.*记忆的上界 \d+ token，上下文的上界 12311 token，换段阈值 \d+ token/);
  const ok = { ...base, contextWindow: ctxW, context: ["a"] };
  const l = limits(ok);
  assert.ok(l.fixed + l.memoryMax + l.contextMax < l.threshold);
  assert.notEqual(startError({ ...ok, contextWindow: ctxW - 1 }), null);
});

test("newSegmentUsed：缺省没有上下文，和显式传空串一样；传了视图就算进用量，各部分分开报", () => {
  const p = start("p", preset(), env(0));
  const first = user("交接说明");
  const none = newSegmentUsed(p, "", first);
  assert.deepEqual(none, newSegmentUsed(p, "", first, ""));
  assert.equal(none.context, 0);
  assert.equal(none.memory, 0);
  const view = "### AGENTS.md\n" + "字".repeat(2_000);
  const r = newSegmentUsed(p, "", first, view);
  assert.equal(r.context, tokens(utf8Bytes(CONTEXT_HEADING + view)));
  assert.equal(r.fixed, none.fixed);
  assert.ok(r.used > none.used);
  assert.ok(r.used - none.used >= r.context - 1 && r.used - none.used <= r.context + 1, "用量多了一节的 token");
  const mem = newSegmentUsed(p, "k: v", first, view);
  assert.equal(mem.memory, tokens(utf8Bytes(memorySection("k: v"))));
  assert.equal(mem.context, r.context);
});

test("newSegmentUsed：探针取参数里的视图，不取进程当前段的", () => {
  const p = withContext(start("p", preset(), env(0)), "### 旧的\n" + "旧".repeat(5_000));
  const first = user("说明");
  assert.equal(newSegmentUsed(p, "", first).context, 0);
  assert.equal(newSegmentUsed(p, "", first).used, newSegmentUsed(start("p", preset(), env(0)), "", first).used);
});

test("start：出生时带上上下文视图；空串或缺省没有这个键", () => {
  const pr = preset({ context: ["AGENTS.md"] });
  const born = start("p", pr, env(5, "k: v"), VIEW);
  assert.deepEqual(born.segment, { seq: 1, memoryView: "k: v", contextView: VIEW });
  assert.deepEqual(start("p", pr, env(5), "").segment, { seq: 1, memoryView: "" });
  assert.equal("contextView" in start("p", pr, env(5)).segment, false);
  assert.equal("contextView" in start("p", pr, env(5), "").segment, false);
});

test("fork 不带 to：复制源进程当前段的上下文视图；源进程没有就没有这个键", () => {
  const src = start("a", preset({ context: ["AGENTS.md"] }), env(0, "k: v"), VIEW);
  const copy = fork("b", src, [], undefined, 7);
  assert.deepEqual(copy.process.segment, { seq: 1, memoryView: "k: v", contextView: VIEW });
  const plain = fork("c", start("a", preset(), env(0)), [], undefined, 7);
  assert.equal("contextView" in plain.process.segment, false);
});

test("fork 带 to：用新预设的视图，不用源进程的；新预设没有视图就没有这个键", () => {
  const src = start("a", preset({ context: ["AGENTS.md"] }), env(0), VIEW);
  const target = preset({ id: "other", context: ["NOTES.md"] });
  const to = fork("b", src, [], undefined, 7, { preset: target, memoryView: "", contextView: "### NOTES.md\n新的" });
  assert.equal(to.process.segment.contextView, "### NOTES.md\n新的");
  const none = fork("c", src, [], undefined, 7, { preset: preset({ id: "plain" }), memoryView: "" });
  assert.equal("contextView" in none.process.segment, false, "源进程有视图，新预设没有，不能带过去");
  const empty = fork("d", src, [], undefined, 7, { preset: preset({ id: "plain" }), memoryView: "", contextView: "" });
  assert.equal("contextView" in empty.process.segment, false);
});

test("fork 带 to：上下文视图算进放不放得下新阈值的估算", () => {
  const target = preset({ id: "small", contextWindow: 40_000 });
  const src = start("a", preset(), env(0));
  const segment = [user("问")];
  assert.doesNotThrow(() => fork("b", src, segment, undefined, 7, { preset: target, memoryView: "" }));
  const big = "### x\n" + "字".repeat(8_000);
  assert.throws(() => fork("b", src, segment, undefined, 7, { preset: target, memoryView: "", contextView: big }), /放不进预设 small/);
});
