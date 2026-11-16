// 设计稿 5.6：请求里的成批省略、两种 R、最坏的图片负载、交接以后的检查。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, IMAGE_OMITTED, IMAGES_OMIT_BATCH, IMAGES_PER_REQUEST } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import { contextUsed, fixedTokens, handoffThreshold, IMAGE_TOKENS, IMAGES_PER_MESSAGE, MESSAGE_MAX_BYTES, outputMax, resultReserve, tokens, utf8Bytes } from "../../src/kernel/derive.ts";
import { HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import type { Message, ModelRequest } from "../../src/kernel/types.ts";
import { assistant, call, codeText, current, env, feed, image, preset, reply, toolOkContent, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const SEE = ["text", "image"] as ("text" | "image")[];

test("常量照设计稿 5.6", () => {
  assert.deepEqual([IMAGE_TOKENS, IMAGES_PER_REQUEST, IMAGES_OMIT_BATCH], [5000, 8, 4]);
});

test("两种 R：不收图片 16,384，收图片 16,384 + 2 × IMAGE_TOKENS；阈值照式子代入", () => {
  assert.equal(resultReserve(preset({ input: ["text"] })), 16_384);
  assert.equal(resultReserve(preset({ input: SEE })), 16_384 + IMAGES_PER_MESSAGE * IMAGE_TOKENS);
  assert.equal(resultReserve(preset({ input: SEE })), 26_384);
  const text: [number, number][] = [[64_000, 27_520], [128_000, 75_520], [200_000, 129_520], [1_000_000, 729_520]];
  const seen: [number, number][] = [[64_000, 17_520], [128_000, 65_520], [200_000, 119_520], [1_000_000, 719_520]];
  for (const [w, t] of text) assert.equal(handoffThreshold(preset({ contextWindow: w, input: ["text"] })), t, `不收图片 ${w}`);
  for (const [w, t] of seen) assert.equal(handoffThreshold(preset({ contextWindow: w, input: SEE })), t, `收图片 ${w}`);
});

/** n 张图分在几条消息里：用户消息、工具结果交替，每条 1 到 2 张。图的 data 是它的序号。 */
function segmentWithImages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i += 2) {
    const imgs = [image(`i${i}`), ...(i + 1 < n ? [image(`i${i + 1}`)] : [])];
    out.push(
      (i / 2) % 2 === 0
        ? { role: "user", content: [{ type: "text", text: `信 ${i}` }, ...imgs], timestamp: 0 }
        : { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "图" }, ...imgs], isError: false, timestamp: 0 },
    );
  }
  return out;
}

const imagesIn = (ms: ModelRequest["messages"]): string[] => ms.flatMap((m) => (m.role === "assistant" || typeof m.content === "string" ? [] : m.content.flatMap((c) => (c.type === "image" ? [c.data] : []))));
const omittedIn = (ms: ModelRequest["messages"]): number => ms.flatMap((m) => (m.role === "assistant" || typeof m.content === "string" ? [] : m.content)).filter((c) => c.type === "text" && c.text === IMAGE_OMITTED).length;

test("请求里成批省略旧图：n = 8、9、12、13 省 0、4、4、8 张，留下最近的；不改段", () => {
  const p = start("p", preset({ input: SEE }), env(0));
  const cases: [number, number][] = [[0, 0], [7, 0], [8, 0], [9, 4], [10, 4], [12, 4], [13, 8], [16, 8], [17, 12]];
  for (const [n, omit] of cases) {
    const seg = segmentWithImages(n);
    const before = JSON.stringify(seg);
    const req = buildContext(p, seg);
    assert.equal(omittedIn(req.messages), omit, `n = ${n}`);
    const kept = imagesIn(req.messages);
    assert.equal(kept.length, n - omit, `n = ${n}`);
    assert.ok(kept.length <= IMAGES_PER_REQUEST);
    assert.deepEqual(kept, Array.from({ length: n - omit }, (_, i) => `i${i + omit}`), `留下的是最近的，n = ${n}`);
    assert.equal(req.messages.length, seg.length);
    assert.equal(JSON.stringify(seg), before, "不改段");
  }
});

test("成批省略：新来一张图时，前缀只在凑满一批时才变", () => {
  const p = start("p", preset({ input: SEE }), env(0));
  const prefix = (n: number) => JSON.stringify(buildContext(p, segmentWithImages(n).slice(0, 1)).messages);
  // 只看第一条消息：n 从 9 到 12 它都一样（都是省略 4 张里的头两张），n = 13 时省略 8 张，里面的内容变了。
  assert.equal(prefix(9), prefix(12));
  assert.equal(prefix(13), prefix(16));
});

/** 最坏情况：用量 U < T 时调用模型，回复写满输出上限，带 40 个工具调用，结果都带满字节上限的文本和 IMAGES_PER_MESSAGE 张图。 */
test("最坏的图片负载：交接请求、指令和交接说明的输出放得进窗口", (t) => {
  const I = tokens(utf8Bytes(HANDOFF_INSTRUCTION));
  const huge = codeText(2 * MESSAGE_MAX_BYTES);
  for (const W of [65_536, 64_000, 128_000, 200_000, 1_000_000]) {
    const pr = preset({ contextWindow: W, input: SEE });
    const T = handoffThreshold(pr);
    for (const used of [Math.floor(0.5 * T), T - 1]) {
      const label = `窗口 ${W}，回复前用量 ${used}`;
      const w = world(pr);
      feed(w, userInput("开始"));
      reply(w, assistant({ usage: used - tokens(utf8Bytes("继续")), text: "好的" }));
      feed(w, userInput("继续"));
      assert.equal(contextUsed(w.p, current(w)), used, label);
      reply(w, assistant({ usage: used + outputMax(pr), calls: Array.from({ length: 40 }, (_, i) => call(`c${i}`, "read", { path: `big${i}.ts` })) }));
      let ran = 0;
      while (w.p.phase.tag === "awaitingTool") {
        const eff = effectNumber(w);
        feed(w, toolOkContent(eff, [{ type: "text", text: huge }, image("a"), image("b"), image("c")]));
        ran++;
        assert.ok(contextUsed(w.p, current(w)) <= W, `${label}：第 ${ran} 个结果之后超过窗口`);
      }
      assert.ok(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose === "handoff", label);
      const need = contextUsed(w.p, current(w)) + I + outputMax(pr);
      assert.ok(need <= W, `${label}：${need} 放不进窗口 ${W}`);
      t.diagnostic(`${label}：执行 ${ran} 个，交接请求 + 输出 ${need}（${((100 * need) / W).toFixed(1)}%）`);
    }
  }
});

const endedOf = (w: World) => (w.p.phase.tag === "idle" ? w.p.phase.ended : undefined);
const purposeOf = (w: World) => (w.p.phase.tag === "awaitingModel" ? w.p.phase.purpose : undefined);

function effectNumber(w: World): number {
  if (w.p.phase.tag !== "awaitingTool") throw new Error("没在等工具");
  return w.p.lastEffect;
}

test("交接以后的检查：固定部分离阈值不到一份说明时，每封信只交接一次就出错，不建新段", () => {
  // 找一个窗口，使阈值刚好比固定部分大一点：启动检查（没有记忆）放行，但一份交接说明放不进去。
  let W = 26_000;
  while (handoffThreshold(preset({ contextWindow: W })) <= fixedTokens(preset({ contextWindow: W }))) W++;
  const pr = preset({ contextWindow: W, input: ["text"] });
  const gap = handoffThreshold(pr) - fixedTokens(pr);
  assert.ok(gap > 0 && gap < 10, `差 ${gap}`);
  const w = world(pr);
  for (let round = 1; round <= 3; round++) {
    feed(w, userInput(`第 ${round} 封`));
    assert.equal(purposeOf(w), "handoff");
    reply(w, assistant({ usage: 1, text: "交接说明：目标、进展、下一步。" }));
    assert.equal(w.p.segment.seq, 1);
    assert.equal(current(w).length, round);
    const ended = endedOf(w);
    assert.ok(typeof ended === "object" && ended.error.startsWith("交接失败：新段一开头就到阈值（固定部分 "), JSON.stringify(ended));
    assert.match(typeof ended === "object" ? ended.error : "", new RegExp(`共 \\d+ / ${handoffThreshold(pr)} token）$`));
  }
});

test("交接以后的检查：原因里的数字——固定部分、记忆、交接说明加起来等于共", () => {
  const view = "记忆" + "字".repeat(4000);
  const pr = preset({ contextWindow: 30_000 });
  const w = world(pr, env(0, view));
  feed(w, userInput("开始"), env(0, view));
  reply(w, assistant({ usage: 1, text: "说明" }), env(0, view));
  const ended = endedOf(w);
  assert.ok(typeof ended === "object");
  const m = /固定部分 (\d+)、记忆 (\d+)、交接说明 (\d+)，共 (\d+) \/ (\d+) token/.exec(ended.error);
  assert.ok(m, ended.error);
  const [f, mem, note, x, T] = m.slice(1).map(Number) as [number, number, number, number, number];
  assert.equal(f + mem + note, x);
  assert.equal(T, handoffThreshold(pr));
  assert.ok(mem > 4000 && note > 0);
});

test("交接以后的检查：带过去的信让新段到阈值时不拦，照常再换一次段", () => {
  const pr = preset({ contextWindow: 48_000 });
  const T = handoffThreshold(pr);
  const BIG = codeText(MESSAGE_MAX_BYTES + 100);
  const w = world(pr);
  feed(w, userInput("开始"));
  reply(w, assistant({ usage: 100, text: "好" }));
  feed(w, userInput(BIG));
  assert.equal(purposeOf(w), "handoff");
  reply(w, assistant({ usage: 200, text: "交接说明" }));
  assert.equal(w.p.segment.seq, 2, "检查不拦");
  assert.ok(contextUsed(w.p, current(w)) >= T, "带过去的信让新段到了阈值");
  assert.equal(purposeOf(w), "handoff");
  reply(w, assistant({ usage: 300, text: "再来一份说明" }));
  assert.equal(w.p.segment.seq, 3);
  assert.equal(purposeOf(w), "turn");
});
