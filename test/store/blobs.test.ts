// blobs 表和图片引用（设计稿 5.6）：和信同一个事务、只增、引用完整，不收图片的模型换成说明，执行器调用模型之前换成真数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../../src/executor/actions.ts";
import { checkImages } from "../../src/images.ts";
import type { Image } from "../../src/images.ts";
import { IMAGE_UNSUPPORTED } from "../../src/kernel/context.ts";
import { start } from "../../src/kernel/decide.ts";
import { userLetter } from "../../src/kernel/types.ts";
import type { Content, Message, PresetSnapshot } from "../../src/kernel/types.ts";
import { readBlob, resolveImages } from "../../src/store/blobs.ts";
import { loadSegment } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { gif, jpeg, png } from "../images.ts";
import { allMessages, fakeMemory, mailbox, PRESET, say, tempDb } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const VISION: PresetSnapshot = { ...PRESET, input: ["text", "image"] };
const images = (...bufs: Buffer[]): Image[] => checkImages(bufs.map((b) => b.toString("base64")));
const blobCount = (db: ReturnType<typeof tempDb>) => db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n;
const letterOf = (db: ReturnType<typeof tempDb>, i = 0): Content[] => {
  const input = mailbox(db)[i]!.input;
  assert.equal(input.kind, "letter");
  return input.kind === "letter" ? input.letter.content : [];
};

test("start 带图片：blobs 存原始字节，信里的图片块是 blob:<hash>，类型来自魔数", (t) => {
  const db = tempDb(t);
  const [a, b] = images(png(10, 20, 1), jpeg(30, 40, { exif: 300 }));
  startProcess(db, fakeMemory(), "p1", VISION, "看图", 0, [a!, b!]);
  assert.deepEqual(letterOf(db), [
    { type: "text", text: "看图" },
    { type: "image", data: `blob:${a!.hash}`, mimeType: "image/png" },
    { type: "image", data: `blob:${b!.hash}`, mimeType: "image/jpeg" },
  ]);
  assert.deepEqual(readBlob(db, a!.hash), a!.bytes);
  assert.deepEqual(readBlob(db, b!.hash), b!.bytes);
  assert.equal(readBlob(db, "0".repeat(64)), undefined);
  assertStoreInvariants(db);
});

test("没有文字只有图片：信里没有文本块", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "p1", VISION, "", 0, images(gif(5, 5)));
  assert.deepEqual(letterOf(db).map((c) => c.type), ["image"]);
});

test("没有图片：和从前一样，信是一个文本块，blobs 不动", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "p1", VISION, "你好", 0);
  assert.deepEqual(letterOf(db), [{ type: "text", text: "你好" }]);
  assert.equal(blobCount(db), 0);
});

test("处理这封信：段里的用户消息是文本块加图片块，引用原样", (t) => {
  const db = tempDb(t);
  const [a] = images(png(10, 20, 1));
  const memory = fakeMemory();
  startProcess(db, memory, "p1", VISION, "看图", 0, [a!]);
  const h = handleNext(db, memory, 1);
  assert.deepEqual(h?.segment[0]?.role === "user" ? h.segment[0].content : null, [
    { type: "text", text: "看图" },
    { type: "image", data: `blob:${a!.hash}`, mimeType: "image/png" },
  ]);
  assert.equal(JSON.stringify(loadSegment(db, h!.process)).includes(a!.bytes.toString("base64")), false, "段里不出现图片的字节");
  assertStoreInvariants(db);
});

test("send 带图片：同一张图只存一行；只增不删", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "p1", VISION, "一", 0);
  const [a] = images(png(10, 20, 1));
  send(db, "p1", userLetter("二"), [a!]);
  send(db, "p1", userLetter("三"), [a!]);
  assert.equal(blobCount(db), 1);
  while (handleNext(db, memory, 1));
  assert.equal(blobCount(db), 1);
  assertStoreInvariants(db);
});

test("反例：进程不存在时 send 抛错，图片不存；启动检查不过、进程 ID 重复，也一样：blobs 和信同生同灭", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  assert.throws(() => send(db, "nope", userLetter("x"), images(png(1, 1, 1))), /没有这个进程/);
  assert.equal(blobCount(db), 0);
  assert.throws(() => startProcess(db, memory, "p1", { ...VISION, contextWindow: 100 }, "x", 0, images(png(1, 1, 2))), /窗口太小/);
  assert.equal(blobCount(db), 0);
  startProcess(db, memory, "p1", VISION, "x", 0);
  assert.throws(() => startProcess(db, memory, "p1", VISION, "y", 0, images(png(1, 1, 3))), /进程 ID 已存在：p1/);
  assert.equal(blobCount(db), 0);
  assert.equal(mailbox(db).length, 1);
});

test("图片只能跟着信：带 stop 抛错，什么都不写", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "p1", VISION, "x", 0);
  assert.throws(() => send(db, "p1", { kind: "stop" }, images(png(1, 1))), /图片只能跟着信/);
  assert.equal(blobCount(db), 0);
  assert.equal(mailbox(db).length, 1);
});

test("不收图片的模型：每张图换成一行说明，不存图片，段里没有图片块", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "p1", PRESET, "看图", 0, images(png(1, 1, 1), gif(1, 1, 2)));
  assert.deepEqual(letterOf(db), [{ type: "text", text: `看图\n${IMAGE_UNSUPPORTED}\n${IMAGE_UNSUPPORTED}` }]);
  send(db, "p1", userLetter(""), images(png(1, 1, 3)));
  assert.deepEqual(letterOf(db, 1), [{ type: "text", text: IMAGE_UNSUPPORTED }]);
  assert.equal(blobCount(db), 0);
  while (handleNext(db, memory, 1));
  assert.equal(JSON.stringify(allMessages(db, "p1")).includes("blob:"), false);
});

test("存储层不变量：信箱、段、turn.queued 里的引用，blobs 里都要有行；图片块的 data 不是引用也违反", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const [a] = images(png(10, 20, 1));
  startProcess(db, memory, "p1", VISION, "看图", 0, [a!]);
  assertStoreInvariants(db);
  db.prepare("DELETE FROM blobs").run();
  assert.throws(() => assertStoreInvariants(db), /在 blobs 里没有行/);
  const memory2 = fakeMemory();
  const db2 = tempDb(t);
  startProcess(db2, memory2, "p1", VISION, "看图", 0, [a!]);
  handleNext(db2, memory2, 1);
  db2.prepare("DELETE FROM blobs").run();
  assert.throws(() => assertStoreInvariants(db2), /在 blobs 里没有行/);
  // 运行中到的信存在 turn.queued 里。
  const db3 = tempDb(t);
  startProcess(db3, memory2, "p1", VISION, "一", 0);
  handleNext(db3, memory2, 1);
  send(db3, "p1", userLetter("二"), [a!]);
  handleNext(db3, memory2, 2);
  assert.match(JSON.stringify(db3.prepare("SELECT state_json FROM processes").get()), /blob:/);
  assertStoreInvariants(db3);
  db3.prepare("DELETE FROM blobs").run();
  assert.throws(() => assertStoreInvariants(db3), /在 blobs 里没有行/);
});

const user = (...content: Content[]): Message => ({ role: "user", content, timestamp: 0 });
const ref = (hash: string): Content => ({ type: "image", data: `blob:${hash}`, mimeType: "image/png" });

test("resolveImages：用户消息和工具结果里的 blob:<hash> 换成 base64，别的块和消息原样；不改入参", () => {
  const blobs = new Map([["h1", Buffer.from("AAA")], ["h2", Buffer.from("BBB")]]);
  const input = {
    systemPrompt: "s",
    messages: [
      user({ type: "text", text: "t" }, ref("h1")),
      { role: "toolResult" as const, toolCallId: "c", toolName: "read", content: [ref("h2")], isError: false, timestamp: 0 },
      { role: "user" as const, content: "字符串", timestamp: 0 },
    ],
  };
  const before = JSON.stringify(input);
  const out = resolveImages(input, (h) => blobs.get(h));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(out.messages[0], user({ type: "text", text: "t" }, { type: "image", data: Buffer.from("AAA").toString("base64"), mimeType: "image/png" }));
  assert.deepEqual((out.messages[1] as { content: Content[] }).content, [{ type: "image", data: Buffer.from("BBB").toString("base64"), mimeType: "image/png" }]);
  assert.equal(out.messages[2], input.messages[2]);
  assert.equal(out.systemPrompt, "s");
});

test("resolveImages：引用对不上就抛出，不发出请求", () => {
  const req = { systemPrompt: "s", messages: [user(ref("gone"))] };
  assert.throws(() => resolveImages(req, () => undefined), /blob:gone.*没有对应的行/);
  assert.throws(() => resolveImages({ systemPrompt: "s", messages: [user({ type: "image", data: "AAAA", mimeType: "image/png" })] }, () => Buffer.from("x")), /没有对应的行/);
});

/** 假的 Models：记下 streamSimple 收到的上下文，回一句话。 */
function recordingModels(): { models: Models; contexts: { messages: Message[] }[] } {
  const contexts: { messages: Message[] }[] = [];
  const models = {
    getModel: () => ({ id: "model-1", provider: "faux", maxTokens: 4096 }),
    streamSimple(_m: unknown, context: { messages: Message[] }) {
      contexts.push(context);
      return { async *[Symbol.asyncIterator]() {}, result: async () => say("好") };
    },
  } as unknown as Models;
  return { models, contexts };
}

test("执行器：调用模型之前把请求里的 blob 引用换成真数据，只读真正要发的图片；段不变", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const bufs = Array.from({ length: 10 }, (_, i) => png(10 + i, 10, i));
  const [first] = images(bufs[0]!);
  startProcess(db, memory, "p1", VISION, "开头", 0, [first!]);
  // 再 9 封信，每封一张图。请求里共 10 张，按 K=8、B=4 省略最早的 4 张。
  for (let i = 1; i < 10; i++) send(db, "p1", userLetter(`图 ${i}`), images(bufs[i]!));
  const proc = start("p1", VISION, { now: 0, memoryView: "" });
  const hashes = bufs.map((b) => images(b)[0]!.hash);
  const refs: Message[] = hashes.map((hash) => user(ref(hash)));
  const { models, contexts } = recordingModels();
  const reads: string[] = [];
  const actions = createActions(models, () => {}, "test-pipe", (hash) => {
    reads.push(hash);
    return readBlob(db, hash);
  });
  await actions.callModel({ process: proc, segment: refs, effect: { kind: "callModel", n: 1, purpose: "turn" } }, new AbortController().signal);
  assert.deepEqual(reads, hashes.slice(4), "省略的 4 张不读");
  const sent = contexts[0]!.messages;
  assert.equal(sent.length, 10);
  for (let i = 0; i < 4; i++) assert.deepEqual(sent[i], user({ type: "text", text: "[图片：较早的图片，已省略]" }));
  for (let i = 4; i < 10; i++) assert.deepEqual(sent[i], user({ type: "image", data: bufs[i]!.toString("base64"), mimeType: "image/png" }));
  // 入参的段里仍是引用。
  assert.deepEqual(refs[9], user(ref(hashes[9]!)));
});

test("执行器：引用对不上时 callModel 拒绝，不发请求", async () => {
  const { models, contexts } = recordingModels();
  const actions = createActions(models, () => {}, "test-pipe", () => undefined);
  const proc = start("p1", VISION, { now: 0, memoryView: "" });
  await assert.rejects(actions.callModel({ process: proc, segment: [user(ref("f".repeat(64)))], effect: { kind: "callModel", n: 1, purpose: "turn" } }, new AbortController().signal), /没有对应的行/);
  assert.equal(contexts.length, 0);
});
