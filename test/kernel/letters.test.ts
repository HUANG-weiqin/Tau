// 设计稿第 5.1 节：信的头和合并、两种形状、张数上限和省略行、换段带全部段末消息。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CARRY_HEADER, HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { clip, handoffThreshold, IMAGES_PER_MESSAGE, MESSAGE_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import type { Ended, ImageContent, Message } from "../../src/kernel/types.ts";
import { assistant, call, codeText, current, feed, giveUp, image, letterInput, preset, processLetter, reply, stopInput, stripTau, textOf, toolDone, toolOkContent, userInput, userLetterWith, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000 });
const HIGH = Math.ceil(handoffThreshold(P));
const STOPPED = "（上一轮被停止。上面还没回复的消息都已取消：不要回应它们，只回应下面的信。）";
const WAITED = "如果有进程在等你回信，它们已经收到上一轮的结束通知，之后的回复不会寄给它们。";
const WAIT = "（来自进程 x，预设 other。它在等回信：你这一轮结束时，最终回复会寄给它，之后的几轮不会。）";

/** 一轮进行中（等模型）。 */
function begin(text = "你好"): World {
  const w = world(P);
  feed(w, userInput(text));
  return w;
}

/** 一轮进行中，等第一个工具。 */
function withCalls(ids: string[]): World {
  const w = begin();
  reply(w, assistant({ usage: 1_000, calls: ids.map((id) => call(id)) }));
  return w;
}

/** 等交接说明。 */
function atHandoff(): World {
  const w = begin();
  reply(w, assistant({ usage: HIGH, calls: [call("c1")] }));
  toolDone(w, "好");
  assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
  return w;
}

/** 一条最后的消息：运行中到几封信，停止，合并写进段，返回合并出的那条。 */
function merged(letters: Parameters<typeof letterInput>[0][]): Message {
  const w = begin();
  for (const l of letters) feed(w, letterInput(l));
  return feed(w, stopInput()).append.at(-1)!;
}

const contentOf = (m: Message) => (m.role === "user" ? m.content : assert.fail("不是用户消息"));
const blocksOf = (m: Message) => {
  const c = contentOf(m);
  return typeof c === "string" ? assert.fail("应为内容块") : c;
};

describe("信的头", () => {
  test("空闲时收到一封信：用户的信没有头；进程的信、要回信的信、回信各有头", () => {
    const text = (l: Parameters<typeof letterInput>[0]) => textOf(feed(world(P), letterInput(l)).append[0]!);
    assert.equal(text(userLetterWith("你好")), "你好");
    assert.equal(text(processLetter("问题")), "（来自进程 x，预设 other）\n问题");
    assert.equal(text(processLetter("问题", { replyTo: "x" })), `${WAIT}\n问题`);
    assert.equal(text(processLetter("答案", { reply: "done" })), "（进程 x 的回信，这一轮正常结束）\n答案");
  });

  test("回信的头写结束原因：四种", () => {
    const cases: [Ended, string][] = [
      ["done", "正常结束"],
      ["stepLimit", "步数用完"],
      ["stopped", "被停止"],
      [{ error: "529 过载" }, "出错：529 过载"],
    ];
    for (const [ended, words] of cases) {
      const m = feed(world(P), letterInput(processLetter("", { id: "q7", reply: ended }))).append[0]!;
      assert.equal(textOf(m), `（进程 q7 的回信，这一轮${words}）\n`);
    }
  });

  test("回信的头永远只有一行：出错原因里的回车换行换成空格，超长的先裁剪", () => {
    const one = textOf(feed(world(P), letterInput(processLetter("正文", { reply: { error: "第一行\r\n第二行\n第三行" } }))).append[0]!);
    assert.equal(one, "（进程 x 的回信，这一轮出错：第一行  第二行 第三行）\n正文");
    const long = textOf(feed(world(P), letterInput(processLetter("正文", { reply: { error: codeText(50_000, "因") } }))).append[0]!);
    const lines = long.split("\n");
    assert.equal(lines.length, 2, "头一行，正文一行");
    assert.ok(lines[0]!.startsWith("（进程 x 的回信，这一轮出错：") && lines[0]!.endsWith("）"));
    assert.ok(utf8Bytes(lines[0]!) < 1024 + 200, `${utf8Bytes(lines[0]!)} 字节`);
    assert.ok(lines[0]!.includes("中间省略"), "先 clip，省略标记在里面，标记的换行也成了空格");
  });

  test("合并：只有用户的信不加头；和进程的信（含回信）合并时，用户的信加“来自用户”", () => {
    assert.equal(textOf(merged([userLetterWith("甲"), userLetterWith("乙")])), "甲\n\n乙");
    assert.equal(textOf(merged([userLetterWith("甲"), processLetter("乙")])), "（来自用户）\n甲\n\n（来自进程 x，预设 other）\n乙");
    assert.equal(textOf(merged([processLetter("乙", { replyTo: "x" }), userLetterWith("甲")])), `${WAIT}\n乙\n\n（来自用户）\n甲`);
    assert.equal(
      textOf(merged([processLetter("答", { id: "a", reply: "stopped" }), userLetterWith("甲"), processLetter("答2", { id: "b", reply: { error: "坏了" } })])),
      "（进程 a 的回信，这一轮被停止）\n答\n\n（来自用户）\n甲\n\n（进程 b 的回信，这一轮出错：坏了）\n答2",
    );
  });

  test("上一轮没有正常结束的说明在最前面，空一行，然后是信", () => {
    const w = begin();
    feed(w, stopInput());
    const s = feed(w, letterInput(processLetter("问题")));
    assert.equal(textOf(s.append[0]!), `${STOPPED}\n\n（来自进程 x，预设 other）\n问题`);
  });

  test("出错原因里的换行换成空格：说明也一样", () => {
    const w = begin();
    giveUp(w, assistant({ usage: 0, stopReason: "error", errorMessage: "第一行\n第二行" }));
    assert.equal(textOf(feed(w, userInput("好")).append[0]!), `（上一轮出错，没有做完：第一行 第二行。${WAITED}）\n\n好`);
  });
});

describe("消息的两种形状", () => {
  test("没有图片：正文是字符串，经 clip 截到上限，头直接拼进文本", () => {
    const big = codeText(100 * 1024);
    const m = feed(world(P), letterInput(processLetter(big))).append[0]!;
    assert.equal(typeof contentOf(m), "string");
    assert.equal(contentOf(m), clip(`（来自进程 x，预设 other）\n${big}`));
    assert.ok(utf8Bytes(textOf(m)) <= MESSAGE_MAX_BYTES);
  });

  test("有图片：一个文本块，后面接图片块；只有图片时没有文本块", () => {
    const a = image("a");
    const b = image("b");
    const m = feed(world(P), letterInput(userLetterWith("看图", [a, b]))).append[0]!;
    assert.deepEqual(contentOf(m), [{ type: "text", text: "看图" }, a, b]);
    const only = feed(world(P), letterInput(userLetterWith("", [a]))).append[0]!;
    assert.deepEqual(contentOf(only), [a]);
    // 头也是文本：进程的信带图片时，文本块是头加换行。
    const p = feed(world(P), letterInput(processLetter("", { images: [a] }))).append[0]!;
    assert.deepEqual(contentOf(p), [{ type: "text", text: "（来自进程 x，预设 other）\n" }, a]);
  });

  test("有图片时文本也经 clip", () => {
    const big = codeText(100 * 1024);
    const m = feed(world(P), letterInput(userLetterWith(big, [image()]))).append[0]!;
    assert.deepEqual(contentOf(m), [{ type: "text", text: clip(big) }, image()]);
  });

  test("合并几封信：图片按信的顺序全带，不限张数", () => {
    const imgs = ["1", "2", "3", "4", "5", "6"].map((d) => image(d));
    const m = merged([userLetterWith("甲", imgs.slice(0, 2)), userLetterWith("乙", imgs.slice(2, 4)), userLetterWith("丙", imgs.slice(4))]);
    assert.deepEqual(contentOf(m), [{ type: "text", text: "甲\n\n乙\n\n丙" }, ...imgs]);
  });

  test("空闲收到的信，一封里的图片不再限张数（入口限每封信，第 6 步）", () => {
    const imgs = ["1", "2", "3"].map((d) => image(d));
    const m = feed(world(P), letterInput(userLetterWith("三张", imgs))).append[0]!;
    assert.deepEqual(contentOf(m), [{ type: "text", text: "三张" }, ...imgs]);
  });
});

describe("工具结果的张数上限", () => {
  const imgs = (n: number): ImageContent[] => Array.from({ length: n }, (_, i) => image(`i${i}`));
  const result = (content: Parameters<typeof toolOkContent>[1]): Message => {
    const w = withCalls(["c1"]);
    return feed(w, toolOkContent(w.p.lastEffect, content)).append[0]!;
  };
  const line = (k: number) => `[图片：省略了 ${k} 张较早的图片]`;

  test("不超过上限：原样；只有图片时没有文本块", () => {
    assert.equal(IMAGES_PER_MESSAGE, 2);
    assert.deepEqual(blocksOfResult(result([{ type: "text", text: "图" }, ...imgs(2)])), [{ type: "text", text: "图" }, ...imgs(2)]);
    assert.deepEqual(blocksOfResult(result(imgs(2))), imgs(2));
    assert.deepEqual(blocksOfResult(result(imgs(1))), imgs(1));
  });

  test("文本是空串的文本块加图片：和没有文本一样，不加空文本块", () => {
    assert.deepEqual(blocksOfResult(result([{ type: "text", text: "" }, ...imgs(1)])), imgs(1));
    assert.deepEqual(blocksOfResult(result([{ type: "text", text: "" }, ...imgs(3)])), [{ type: "text", text: line(1) }, ...imgs(3).slice(1)]);
  });

  test("超过上限：从最早的起省略，留下最后几张，文本块末尾加一行", () => {
    const m = result([{ type: "text", text: "图" }, ...imgs(5)]);
    assert.deepEqual(blocksOfResult(m), [{ type: "text", text: `图\n${line(3)}` }, ...imgs(5).slice(3)]);
  });

  test("只有图片、没有文本的结果超过上限：文本块只有那一行", () => {
    const m = result(imgs(3));
    assert.deepEqual(blocksOfResult(m), [{ type: "text", text: line(1) }, ...imgs(3).slice(1)]);
  });

  test("文本很长时：连省略行整条文本不超过上限，行还在末尾", () => {
    const big = codeText(100 * 1024);
    const m = result([{ type: "text", text: big }, ...imgs(4)]);
    const text = textOf(m);
    assert.ok(utf8Bytes(text) <= MESSAGE_MAX_BYTES, `${utf8Bytes(text)} 字节`);
    assert.ok(text.endsWith(`\n${line(2)}`));
    assert.ok(text.startsWith(clip(big).slice(0, 100)));
    assert.deepEqual(blocksOfResult(m).slice(1), imgs(4).slice(2));
  });

  test("没有图片时和从前一样：多个文本块连起来裁剪成一个", () => {
    const m = result([{ type: "text", text: "甲" }, { type: "text", text: "乙" }]);
    assert.deepEqual(blocksOfResult(m), [{ type: "text", text: "甲乙" }]);
  });
});

function blocksOfResult(m: Message) {
  return m.role === "toolResult" ? m.content : assert.fail("不是工具结果");
}

describe("换段带全部段末消息", () => {
  /** 交接失败后又发来的消息，在段末。 */
  function tailWith(...letters: Parameters<typeof letterInput>[0][]): World {
    const w = atHandoff();
    for (const l of letters) {
      giveUp(w, assistant({ usage: 3_000, stopReason: "error", errorMessage: "超时" }));
      feed(w, letterInput(l));
    }
    return w;
  }

  test("两种形状的段末消息都带：文本接在说明后面，图片块原样带过去", () => {
    const a = image("a");
    const b = image("b");
    const w = tailWith(userLetterWith("甲"), userLetterWith("乙", [a, b]));
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    const note = `（上一轮出错，没有做完：交接失败：超时。${WAITED}）`;
    assert.deepEqual(stripTau(s.append), [
      { role: "user", content: [{ type: "text", text: `${HANDOFF_HEADER}交接说明\n\n${CARRY_HEADER}\n\n${note}\n\n甲\n\n${note}\n\n乙` }, a, b], timestamp: 0 },
    ]);
  });

  test("没有图片：新段第一条仍是字符串", () => {
    const w = tailWith(userLetterWith("甲"));
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    assert.equal(typeof contentOf(s.append[0]!), "string");
  });

  test("新段第一条的图片受限：留最后 IMAGES_PER_MESSAGE 张，文本末尾加省略行", () => {
    const imgs = ["1", "2", "3", "4", "5"].map((d) => image(d));
    const w = tailWith(userLetterWith("甲", imgs.slice(0, 2)), userLetterWith("乙", imgs.slice(2, 5)));
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    const blocks = blocksOf(s.append[0]!);
    assert.deepEqual(blocks.slice(1), imgs.slice(3));
    assert.equal(blocks[0]?.type, "text");
    assert.ok(textOf(s.append[0]!).startsWith(HANDOFF_HEADER + "交接说明"));
    assert.ok(textOf(s.append[0]!).endsWith("\n[图片：省略了 3 张较早的图片]"));
  });

  test("带过去的文本很大加图片：整条文本连省略行不超过上限", () => {
    const imgs = ["1", "2", "3"].map((d) => image(d));
    const w = tailWith(userLetterWith(codeText(MESSAGE_MAX_BYTES, "甲"), imgs));
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    assert.ok(utf8Bytes(textOf(s.append[0]!)) <= MESSAGE_MAX_BYTES);
    assert.ok(textOf(s.append[0]!).endsWith("\n[图片：省略了 1 张较早的图片]"));
    assert.deepEqual(blocksOf(s.append[0]!).slice(1), imgs.slice(1));
  });

  test("段末有只有图片的消息：说明后面只有文本部分，没有多余的空行", () => {
    const a = image("a");
    const w = atHandoff();
    feed(w, letterInput(userLetterWith("", [a]))); // 排队，交接失败时合并写进旧段，没有说明
    giveUp(w, assistant({ usage: 3_000, stopReason: "error", errorMessage: "超时" }));
    assert.deepEqual(stripTau([current(w).at(-1)!])[0], { role: "user", content: [a], timestamp: 0 });
    feed(w, letterInput(userLetterWith("再来")));
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    const note = `（上一轮出错，没有做完：交接失败：超时。${WAITED}）`;
    assert.deepEqual(stripTau(s.append), [{ role: "user", content: [{ type: "text", text: `${HANDOFF_HEADER}交接说明\n\n${CARRY_HEADER}\n\n${note}\n\n再来` }, a], timestamp: 0 }]);
  });
});
