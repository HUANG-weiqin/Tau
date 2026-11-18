import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGES_PER_MESSAGE } from "../../../src/kernel/derive.ts";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE } from "../../../src/images.ts";
import { ACCEPTED, MAX_BYTES, MAX_EDGE, PER_MESSAGE, addNote, attempts, fitSize, isFit, room } from "../../../extras/gui/web/lib/image.js";
import { mailOf, refusesImages, rulerOf, seenFromInspect } from "../../../extras/gui/web/lib/derive.js";

test("页面里的图片常量和服务的入口条件一致", () => {
  assert.equal(MAX_BYTES, IMAGE_MAX_BYTES);
  assert.equal(MAX_EDGE, IMAGE_MAX_EDGE);
  assert.equal(PER_MESSAGE, IMAGES_PER_MESSAGE);
  assert.deepEqual(ACCEPTED, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
});

test("fitSize 长边缩到上限，保持比例，合格的不动", () => {
  assert.deepEqual(fitSize(1000, 800), { width: 1000, height: 800 });
  assert.deepEqual(fitSize(4000, 2000), { width: 2000, height: 1000 });
  assert.deepEqual(fitSize(1000, 5000), { width: 400, height: 2000 });
  assert.deepEqual(fitSize(20000, 1), { width: 2000, height: 1 });
});

test("isFit：类型、字节、尺寸都合格才原样发", () => {
  const ok = { type: "image/png", bytes: 1000, width: 2000, height: 2000 };
  assert.equal(isFit(ok), true);
  assert.equal(isFit({ ...ok, bytes: MAX_BYTES + 1 }), false);
  assert.equal(isFit({ ...ok, width: 2001 }), false);
  assert.equal(isFit({ ...ok, type: "image/bmp" }), false);
});

test("attempts：先原格式，再转 JPEG 降质量，最后缩小边长", () => {
  const a = attempts("image/png", 4000, 3000);
  assert.deepEqual(a[0], { mime: "image/png", quality: 0.92, width: 2000, height: 1500 });
  assert.ok(a.slice(1).every((x) => x.mime === "image/jpeg"));
  const q = a.filter((x) => x.width === 2000).map((x) => x.quality);
  assert.deepEqual(q, [0.92, 0.9, 0.8, 0.7, 0.55, 0.4]);
  assert.ok(a.every((x) => x.width <= MAX_EDGE && x.height <= MAX_EDGE));
  const last = a[a.length - 1]!;
  assert.ok(last.width < 2000 && last.mime === "image/jpeg");
});

test("attempts：gif 没有原格式这一项", () => {
  assert.equal(attempts("image/gif", 100, 100)[0]!.mime, "image/jpeg");
  assert.equal(attempts("image/bmp", 100, 100)[0]!.mime, "image/jpeg");
});

test("room 和 addNote：到上限就不再收，并说明", () => {
  assert.deepEqual(room(0, 5), { take: PER_MESSAGE, dropped: 5 - PER_MESSAGE });
  assert.deepEqual(room(PER_MESSAGE, 1), { take: 0, dropped: 1 });
  assert.deepEqual(room(1, 1), { take: 1, dropped: 0 });
  assert.match(addNote(3, [])!, /3 张/);
  assert.equal(addNote(0, []), null);
  assert.equal(addNote(0, ["a：坏了"]), "a：坏了");
});

const snapLine = (o: object = {}) => ({ type: "process", process: { preset: { workdir: "/w", tools: ["read"], toolDefs: [], input: ["text"], model: "m/x" } }, limits: { threshold: 900 }, ...o });

test("seenFromInspect 带上输入类型和换段阈值；refusesImages 只在确知不收时为真", () => {
  const f = seenFromInspect(snapLine())!;
  assert.deepEqual(f.input, ["text"]);
  assert.equal(f.threshold, 900);
  assert.equal(refusesImages(f), true);
  assert.equal(refusesImages(seenFromInspect(snapLine({ process: { preset: { workdir: "/w", tools: [], input: ["text", "image"] } } }))), false);
  assert.equal(refusesImages(seenFromInspect({ type: "process", process: { preset: { workdir: "/w", tools: [] } } })), false);
  assert.equal(refusesImages(null), false);
});

test("rulerOf：占比、刻线位置、九成警告", () => {
  assert.deepEqual(rulerOf({ used: 400, window: 1000 }, 800), { pct: 40, mark: 80, near: false });
  assert.equal(rulerOf({ used: 720, window: 1000 }, 800).near, true);
  assert.equal(rulerOf({ used: 719, window: 1000 }, 800).near, false);
  assert.equal(rulerOf({ used: 900, window: 1000 }, 800).near, true);
  assert.deepEqual(rulerOf({ used: 500, window: 1000 }, undefined), { pct: 50, mark: null, near: false });
  assert.deepEqual(rulerOf({ used: 5, window: 0 }, 10), { pct: 0, mark: null, near: false });
  assert.equal(rulerOf({ used: 2000, window: 1000 }, 800).pct, 100);
});

const user = { kind: "user" } as const;
const txt = (t: string) => [{ type: "text", text: t }];
const run = (id: string, turn: { queued?: object[]; replyTo?: string[] }) => ({ id, preset: { id: `p-${id}` }, phase: { tag: "awaitingModel", purpose: "turn", turn: { steps: 1, hops: 0, queued: [], replyTo: [], ...turn } } });
const idle = (id: string) => ({ id, preset: { id: `p-${id}` }, phase: { tag: "idle" } });

test("mailOf：排队的信，谁寄的、第一行", () => {
  const a = run("a", { queued: [{ from: user, content: txt("\n\n第一行\n第二行"), hops: 0 }, { from: { kind: "process", id: "b", preset: "pb", reply: { ended: "done" } }, content: [{ type: "image", data: "", mimeType: "image/png" }], hops: 2 }] });
  const m = mailOf([a, idle("b")], "a");
  assert.equal(m.queued.length, 2);
  assert.deepEqual([m.queued[0]!.from, m.queued[0]!.first], ["你", "第一行"]);
  assert.deepEqual([m.queued[1]!.from, m.queued[1]!.reply, m.queued[1]!.first, m.queued[1]!.images], ["pb · b", true, "（图片）", 1]);
  assert.deepEqual(mailOf([idle("a")], "a"), { queued: [], waitedBy: [], waitingOn: [] });
  // 后台任务的完成通知标成后台任务，不标成“你”。
  const bg = run("a", { queued: [{ from: user, content: txt("[后台任务 build] 完成，退出码 0\nlog 最后 3 行"), hops: 0 }] });
  assert.deepEqual([mailOf([bg], "a").queued[0]!.from, mailOf([bg], "a").queued[0]!.first], ["后台任务 · build", "[后台任务 build] 完成，退出码 0"]);
});

test("mailOf：谁在等它回信，它在等谁", () => {
  const a = run("a", { replyTo: ["b"], queued: [{ from: user, content: txt("x"), hops: 0, replyTo: "c" }] });
  const c = run("c", { replyTo: ["a"] });
  const d = run("d", { queued: [{ from: user, content: txt("y"), hops: 1, replyTo: "a" }] });
  const e = run("e", { replyTo: ["z"] });
  const m = mailOf([a, c, d, e, idle("b")], "a");
  assert.deepEqual(m.waitedBy, ["b", "c"]);
  assert.deepEqual(m.waitingOn, ["c", "d"]);
  assert.deepEqual(mailOf([idle("a"), c], "a").waitedBy, []);
  assert.deepEqual(mailOf([run("a", { replyTo: ["a"] })], "a").waitedBy, []);
});
