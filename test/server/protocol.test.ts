// 协议的 history 和 watch、text 回复的进程和编号（设计稿 5.9）。走真的服务、管道和库；模型是 pi-ai 的 faux。
// 客户端发完请求不半关闭：Windows 命名管道不支持，一半关连接就整个关了。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { request } from "../../src/cli/main.ts";
import type { Message } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { WATCH_BUFFER_MAX, serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { gif, jpeg, png } from "../images.ts";
import { appendMessages, loadProcess, loadSegment, putMail, saveProcess } from "../../src/store/db.ts";
import { putBlobs } from "../../src/store/blobs.ts";
import { checkImages } from "../../src/images.ts";
import type { Turn } from "../../src/kernel/types.ts";

interface Env {
  pipe: string;
  faux: FauxProviderHandle;
  svc: Service;
  presetsDir: string;
  toolsDir: string;
  work: string;
  /** 关服务。可以多次调用；测试结束时也会调。 */
  close(): Promise<void>;
}

async function setup(t: TestContext, fauxOptions: RegisterFauxProviderOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-proto-"));
  const work = join(dir, "work");
  const presetsDir = join(dir, "presets");
  const toolsDir = join(dir, "tools");
  mkdirSync(work);
  mkdirSync(presetsDir);
  mkdirSync(toolsDir);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }], ...fauxOptions });
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presetsDir, "p.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-proto-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir, models, memory: sqliteMemory });
  const sockets = new Set<Socket>();
  svc.server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= svc.close());
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { pipe, faux, svc, presetsDir, toolsDir, work, close };
}

async function collect(pipe: string, req: Request): Promise<Reply[]> {
  const out: Reply[] = [];
  await request(pipe, req, (r) => out.push(r));
  return out;
}

/** 回复一句话，再 `start` 一个进程，等它回到 idle。返回进程 ID。 */
async function startIdle(e: Env, answer = "好的。"): Promise<string> {
  e.faux.appendResponses([fauxAssistantMessage(fauxText(answer))]);
  const replies = await collect(e.pipe, { op: "start", preset: "p", text: "你好" });
  const first = replies[0];
  assert.equal(first?.type, "receipt");
  assert.equal(replies.at(-1)?.type, "final");
  return first.process;
}

interface Client {
  replies: Reply[];
  socket: Socket;
  /** 连接关闭了。 */
  closed: Promise<void>;
  /** 第一块数据到了（服务已经推完快照）。 */
  ready: Promise<void>;
}

/**
 * 发一行请求，之后一直读，不半关闭。`stall` 为真时，收到第一块数据就暂停读取，之后一直不读。
 * 暂停以后收不到回复，所以 `replies` 只有暂停前解析出的。
 */
function open(pipe: string, req: unknown, stall = false): Client {
  const replies: Reply[] = [];
  const ready = Promise.withResolvers<void>();
  const s = connect(pipe, () => s.write(`${JSON.stringify(req)}\n`));
  s.setEncoding("utf8");
  s.on("error", () => {});
  let buf = "";
  s.on("data", (chunk: string) => {
    if (stall) s.pause();
    ready.resolve();
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      replies.push(JSON.parse(buf.slice(0, i)) as Reply);
      buf = buf.slice(i + 1);
    }
  });
  const closed = new Promise<void>((resolve) => s.on("close", () => resolve()));
  return { replies, socket: s, closed, ready: ready.promise };
}

async function until(ok: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(10)) {
    if (Date.now() > end) throw new Error(`等了 ${ms} 毫秒，仍然没有：${what}`);
  }
}

/** 服务端现在的连接数。 */
async function connections(e: Env): Promise<number> {
  return new Promise((resolve, reject) => e.svc.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
}

function updates(c: Client): Extract<Reply, { type: "update" }>[] {
  return c.replies.filter((r) => r.type === "update");
}

function segmentOf(e: Env, id: string): Message[] {
  const p = loadProcess(e.svc.db, id);
  assert.ok(p);
  return loadSegment(e.svc.db, p);
}

// history

test("history：默认读当前段，从 0 起；每条一行，最后一行 end", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e, "第一句。");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "再说" });
  const seg = segmentOf(e, id);
  assert.equal(seg.length, 4);
  const replies = await collect(e.pipe, { op: "history", process: id });
  assert.deepEqual(replies, [...seg.map((message, seq) => ({ type: "message", segment: 1, seq, message })), { type: "end", segment: 1, messages: 4 }]);
});

test("history：from 从段内序号起；超过段尾只发 end；显式写当前段号同默认", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "再说" });
  const seg = segmentOf(e, id);
  const tail = await collect(e.pipe, { op: "history", process: id, from: 2 });
  assert.deepEqual(tail, [
    { type: "message", segment: 1, seq: 2, message: seg[2] },
    { type: "message", segment: 1, seq: 3, message: seg[3] },
    { type: "end", segment: 1, messages: 4 },
  ]);
  assert.deepEqual(await collect(e.pipe, { op: "history", process: id, from: 4 }), [{ type: "end", segment: 1, messages: 4 }]);
  assert.deepEqual(await collect(e.pipe, { op: "history", process: id, from: 1000 }), [{ type: "end", segment: 1, messages: 4 }]);
  assert.deepEqual(await collect(e.pipe, { op: "history", process: id, segment: 1, from: 3 }), [
    { type: "message", segment: 1, seq: 3, message: seg[3] },
    { type: "end", segment: 1, messages: 4 },
  ]);
});

test("history：可以读旧段；段号越界、进程不存在回 error", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const old = segmentOf(e, id);
  // 把进程直接改成第 2 段，段里有一条消息，模拟换段之后。
  const p = loadProcess(e.svc.db, id);
  assert.ok(p);
  const next = { ...p, segment: { ...p.segment, seq: 2 } };
  saveProcess(e.svc.db, next);
  const fresh: Message = { role: "user", content: "新段", timestamp: 1 };
  appendMessages(e.svc.db, next, 0, [fresh]);

  assert.deepEqual(await collect(e.pipe, { op: "history", process: id }), [
    { type: "message", segment: 2, seq: 0, message: fresh },
    { type: "end", segment: 2, messages: 1 },
  ]);
  const first = await collect(e.pipe, { op: "history", process: id, segment: 1 });
  assert.deepEqual(first, [...old.map((message, seq) => ({ type: "message", segment: 1, seq, message })), { type: "end", segment: 1, messages: old.length }]);

  for (const segment of [0, 3]) {
    const r = await collect(e.pipe, { op: "history", process: id, segment });
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, "error");
  }
  const missing = await collect(e.pipe, { op: "history", process: "nope" });
  assert.deepEqual(missing, [{ type: "error", message: "没有这个进程：nope" }]);
});

test("history 和 watch 的请求校验：数字必须是非负整数，process 必须是字符串", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const bad: unknown[] = [
    { op: "history" },
    { op: "history", process: 1 },
    { op: "history", process: id, segment: -1 },
    { op: "history", process: id, segment: 1.5 },
    { op: "history", process: id, from: "0" },
    { op: "history", process: id, from: -1 },
    { op: "history", process: id, from: null },
    { op: "watch", process: 7 },
    { op: "watch", process: null },
  ];
  for (const req of bad) {
    const r = await collect(e.pipe, req as Request);
    assert.equal(r.length, 1, JSON.stringify(req));
    assert.equal(r[0]?.type, "error", JSON.stringify(req));
    assert.match(r[0]?.type === "error" ? r[0].message : "", /^无法识别的请求/, JSON.stringify(req));
  }
});

test("history 是读请求：不写库，不动信箱和副作用表", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const count = () => Object.values(e.svc.db.prepare("SELECT (SELECT COUNT(*) FROM mailbox) AS m, (SELECT COUNT(*) FROM effects) AS f, (SELECT COUNT(*) FROM segment_messages) AS s").get() ?? {});
  const before = count();
  await collect(e.pipe, { op: "history", process: id });
  assert.deepEqual(count(), before);
  assert.equal(e.svc.db.isTransaction, false);
});

// text

test("start 和 send 的观察者收到的 text 带进程和副作用编号", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第一句。"))]);
  const first = await collect(e.pipe, { op: "start", preset: "p", text: "你好" });
  const id = first[0]?.type === "receipt" ? first[0].process : "";
  const texts = first.filter((r) => r.type === "text");
  assert.ok(texts.length > 0);
  for (const r of texts) assert.deepEqual([r.process, r.n], [id, 1]);
  assert.equal(texts.map((r) => r.delta).join(""), "第一句。");

  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  const second = await collect(e.pipe, { op: "send", process: id, text: "再说" });
  for (const r of second.filter((x) => x.type === "text")) assert.deepEqual([r.process, r.n], [id, 2]);
});

// watch

test("watch：带 process 时先推它的 update；不带时推每个进程的 update，按进程 ID 排序", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  const one = open(e.pipe, { op: "watch", process: a });
  await one.ready;
  await until(() => one.replies.length === 1, "一条快照");
  const snap = one.replies[0];
  assert.equal(snap?.type, "update");
  assert.equal(snap.self.id, a);
  assert.equal(snap.self.messages, segmentOf(e, a).length);
  assert.deepEqual(snap.self.phase, { tag: "idle", ended: "done" });
  assert.equal(Object.keys(snap).sort().join(), "self,type");

  const all = open(e.pipe, { op: "watch" });
  await until(() => all.replies.length === 2, "两条快照");
  assert.deepEqual(updates(all).map((r) => r.self.id), [a, b].sort());
  one.socket.destroy();
  all.socket.destroy();
});

test("watch：之后每次处理输入推一次增量；不推 final；text 带进程和编号；只推订阅的进程", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  const onlyA = open(e.pipe, { op: "watch", process: a });
  const everyone = open(e.pipe, { op: "watch" });
  await until(() => onlyA.replies.length === 1 && everyone.replies.length === 2, "快照");

  e.faux.appendResponses([fauxAssistantMessage(fauxText("给 b 的回复。"))]);
  const sent = await collect(e.pipe, { op: "send", process: b, text: "再说" });
  assert.equal(sent.at(-1)?.type, "final");
  const total = segmentOf(e, b).length;
  await until(() => updates(everyone).some((r) => r.self.id === b && r.self.phase.tag === "idle" && r.self.messages === total && r.self.segment === 1 && r.self.context.used > 0 && updates(everyone).length > 2), "b 的最后一次 update");

  const mine = updates(everyone).slice(2).filter((r) => r.self.id === b);
  assert.deepEqual(mine.map((r) => r.self.phase.tag), ["awaitingModel", "idle"]);
  assert.equal(mine.at(-1)?.self.messages, total);
  assert.deepEqual(mine.at(-1)?.self.phase, { tag: "idle", ended: "done" });
  // 增量和快照同形：只有 self，不带兄弟和子进程。
  for (const r of mine) assert.equal(Object.keys(r).sort().join(), "self,type");
  // 增量是库里状态的投影：消息条数和用量与库一致。
  assert.deepEqual(mine.at(-1)?.self.usage, loadProcess(e.svc.db, b)?.usage);

  const texts = everyone.replies.filter((r) => r.type === "text");
  assert.ok(texts.length > 0);
  for (const r of texts) assert.deepEqual([r.process, r.n], [b, 2]);
  assert.equal(texts.map((r) => r.delta).join(""), "给 b 的回复。");
  assert.equal(everyone.replies.some((r) => r.type === "final"), false);
  // 只订阅 a 的连接什么都没收到：快照之后，b 的活动与它无关。
  assert.equal(onlyA.replies.length, 1);
  onlyA.socket.destroy();
  everyone.socket.destroy();
});

test("watch：订阅不存在的进程回 error，然后服务关闭连接", async (t) => {
  const e = await setup(t);
  const c = open(e.pipe, { op: "watch", process: "nope" });
  await c.closed;
  assert.deepEqual(c.replies, [{ type: "error", message: "没有这个进程：nope" }]);
});

test("watch：客户端断开后服务不再给它推送，其余订阅照常；服务不因此出错", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const gone = open(e.pipe, { op: "watch", process: id });
  const stays = open(e.pipe, { op: "watch", process: id });
  await until(() => gone.replies.length === 1 && stays.replies.length === 1, "快照");
  assert.equal(await connections(e), 2);
  gone.socket.destroy();
  await until(() => !e.svc.server.listening || gone.socket.destroyed, "客户端关闭");
  // 服务的 close 事件在它读到 EOF 之后：连接数降到只剩一个。
  for (const end = Date.now() + 5_000; (await connections(e)) !== 1; await sleep(10)) assert.ok(Date.now() < end, "服务没有释放断开的订阅连接");

  e.faux.appendResponses([fauxAssistantMessage(fauxText("还在。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "再说" });
  await until(() => updates(stays).length >= 3, "剩下的订阅收到增量");
  assert.equal(gone.replies.length, 1);
  stays.socket.destroy();
});

test("watch：请求行之后又收到字节，客户端断开后仍然释放连接", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const c = open(e.pipe, { op: "watch", process: id });
  await until(() => c.replies.length === 1, "快照");
  c.socket.write("\n");
  await sleep(50);
  c.socket.destroy();
  for (const end = Date.now() + 5_000; (await connections(e)) !== 0; await sleep(10)) assert.ok(Date.now() < end, "服务没有释放断开的订阅连接");
});

test("watch：服务正常退出时先断开订阅，close() 不会一直等它", { timeout: 15_000 }, async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const c = open(e.pipe, { op: "watch", process: id });
  await c.ready;
  await e.close();
  await c.closed;
  assert.equal(updates(c).length, 1);
});

test("watch：退出开始以后才读到的 watch 请求回 error 并关闭；已经在等最终回复的连接照常收到", { timeout: 15_000 }, async (t) => {
  const e = await setup(t);
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  e.faux.appendResponses([
    async () => {
      reached.resolve();
      await gate.promise;
      return fauxAssistantMessage(fauxText("慢回复。"));
    },
  ]);
  t.after(() => gate.resolve());
  const waiting = collect(e.pipe, { op: "start", preset: "p", text: "你好" });
  await reached.promise;

  // 先连上，但不发请求：退出开始以后才发。
  const accepted = new Promise<void>((resolve) => e.svc.server.once("connection", () => resolve()));
  const late = connect(e.pipe);
  late.setEncoding("utf8");
  late.on("error", () => {});
  const lateReplies: Reply[] = [];
  late.on("data", (chunk: string) => lateReplies.push(...chunk.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Reply)));
  const lateClosed = new Promise<void>((resolve) => late.on("close", () => resolve()));
  await accepted;

  const closing = e.close();
  await sleep(50);
  late.write(`${JSON.stringify({ op: "watch" })}\n`);
  await lateClosed;
  assert.equal(lateReplies.length, 1);
  assert.equal(lateReplies[0]?.type, "error");

  gate.resolve();
  const replies = await waiting;
  assert.deepEqual(replies.at(-1), { type: "final", reply: "慢回复。", ended: "done" });
  await closing;
});

/** 把一个 idle 进程的预设 ID 改成很长的字符串：它的每条 update 都有这么长。 */
function bloat(e: Env, id: string, chars: number): void {
  const p = loadProcess(e.svc.db, id);
  assert.ok(p);
  saveProcess(e.svc.db, { ...p, preset: { ...p.preset, id: "x".repeat(chars) } });
}

test("watch 写缓冲上限：快照比管道缓冲大、订阅方一直不读，仍然在上限处断开；读的订阅不受影响", { timeout: 30_000 }, async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  // 快照约 400K 字符，比管道的缓冲大；每次 send 推两条 update，一次不到上限，两次超过。
  bloat(e, id, 400_000);
  const stalled = open(e.pipe, { op: "watch", process: id }, true);
  const reader = open(e.pipe, { op: "watch", process: id });
  await stalled.ready;
  await until(() => updates(reader).length === 1, "读的订阅收到快照");
  assert.equal(await connections(e), 2);

  e.faux.appendResponses([fauxAssistantMessage(fauxText("好。")), fauxAssistantMessage(fauxText("好。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "一" });
  await until(() => updates(reader).some((r) => r.self.messages === 4 && r.self.phase.tag === "idle"), "读的订阅收到第一次的最后一条 update");
  assert.equal(await connections(e), 2, "没到上限，不读的订阅还在");
  await collect(e.pipe, { op: "send", process: id, text: "二" });
  for (let end = Date.now() + 10_000; (await connections(e)) !== 1; await sleep(20)) assert.ok(Date.now() < end, "不读的订阅没有被断开");
  await until(() => updates(reader).some((r) => r.self.messages === 6 && r.self.phase.tag === "idle"), "读的订阅收到最后一条 update", 10_000);
  reader.socket.destroy();
});

test("watch 写缓冲上限：快照很小、订阅方不读，超过上限才断开；之前的少量推送不断开", { timeout: 30_000 }, async (t) => {
  const e = await setup(t, { tokenSize: { min: 20_000, max: 20_000 }, tokensPerSecond: 1_000_000 });
  const id = await startIdle(e);
  const stalled = open(e.pipe, { op: "watch", process: id }, true);
  const reader = open(e.pipe, { op: "watch", process: id });
  await stalled.ready;
  await until(() => updates(reader).length === 1, "读的订阅收到快照");

  // 少量推送：远低于上限，不断开。
  e.faux.appendResponses([fauxAssistantMessage(fauxText("短。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "一" });
  await until(() => updates(reader).length >= 3, "读的订阅收到短回复的 update");
  assert.equal(await connections(e), 2);

  // 大量流式文本：缓冲超过上限，不读的订阅被断开，读的订阅收到全部。
  const big = "字".repeat(WATCH_BUFFER_MAX * 2);
  e.faux.appendResponses([fauxAssistantMessage(fauxText(big))]);
  await collect(e.pipe, { op: "send", process: id, text: "二" });
  for (const end = Date.now() + 10_000; (await connections(e)) !== 1; await sleep(20)) assert.ok(Date.now() < end, "不读的订阅没有被断开");
  await until(() => reader.replies.filter((r) => r.type === "text").map((r) => r.delta).join("").length >= big.length + 2, "读的订阅收到全部文字", 15_000);
  reader.socket.destroy();
});

test("start：预设的固定部分加记忆到了阈值，回 error，什么都不建（设计稿 5.6 启动检查）", async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 30_000 }] });
  writeFileSync(join(e.presetsDir, "big.md"), `---
workdir: ${e.work}
model: ${e.faux.getModel().provider}/m
tools: read, memory
---
你是测试助手。
`);
  const r = await collect(e.pipe, { op: "start", preset: "big", text: "你好" });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.type, "error");
  assert.match(r[0]?.type === "error" ? r[0].message : "", /窗口太小.*固定部分 \d+ token，记忆的上界 \d+ token，换段阈值 -?\d+ token/);
  const ps = await collect(e.pipe, { op: "ps" });
  assert.deepEqual(ps, [{ type: "ps", processes: [] }]);
});

test("start：预设用到的工具定义冻结进快照；定义读不出或不合格，回 error，什么都不建（设计稿 5.5）", async (t) => {
  const e = await setup(t);
  const preset = (id: string, tools: string) => writeFileSync(join(e.presetsDir, `${id}.md`), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: ${tools}\n---\n你是测试助手。\n`);
  const def = (name: string, description: unknown) => writeFileSync(join(e.toolsDir, `${name}.json`), JSON.stringify({ description, parameters: { type: "object" }, command: "echo hi" }));
  preset("withdef", "read, notes");
  preset("nodef", "read, ghost");
  preset("baddef", "read, broken");
  def("notes", "写笔记");
  def("broken", 7);
  assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "nodef", text: "你好" })), /找不到工具定义：ghost/);
  assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "baddef", text: "你好" })), /broken 的 description 必须是字符串/);
  assert.deepEqual(await collect(e.pipe, { op: "ps" }), [{ type: "ps", processes: [] }]);

  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const replies = await collect(e.pipe, { op: "start", preset: "withdef", text: "你好" });
  assert.equal(replies.at(-1)?.type, "final");
  const first = replies[0];
  assert.equal(first?.type, "receipt");
  const id = first.process;
  def("notes", "改过的说明");
  assert.deepEqual(loadProcess(e.svc.db, id)?.preset.toolDefs.map((d) => d.description), ["写笔记"]);
});

// 图片：start、send 带 images，blob 请求（设计稿 5.6、5.9）

const b64 = (b: Buffer) => b.toString("base64");
const errorOf = (r: Reply[]): string => {
  assert.equal(r.length, 1);
  assert.equal(r[0]?.type, "error");
  return r[0]?.type === "error" ? r[0].message : "";
};
const blobRows = (e: Env) => e.svc.db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n;

test("start 带图片：段里是 blob 引用；blob 请求回类型和 base64，然后关闭", async (t) => {
  const e = await setup(t);
  const img = jpeg(640, 480, { exif: 500 });
  e.faux.appendResponses([fauxAssistantMessage(fauxText("看到了"))]);
  const replies = await collect(e.pipe, { op: "start", preset: "p", text: "看图", images: [b64(img)] });
  assert.equal(replies.at(-1)?.type, "final");
  const first = replies[0];
  assert.equal(first?.type, "receipt");
  const user = segmentOf(e, first.process)[0];
  assert.ok(user?.role === "user" && Array.isArray(user.content));
  const block = user.content[1];
  assert.ok(block?.type === "image");
  assert.match(block.data, /^blob:[0-9a-f]{64}$/);
  assert.equal(block.mimeType, "image/jpeg");
  const got = await collect(e.pipe, { op: "blob", hash: block.data.slice("blob:".length) });
  assert.deepEqual(got, [{ type: "blob", mimeType: "image/jpeg", data: b64(img) }]);
  // history 里的图片也是引用，不带字节。
  const hist = await collect(e.pipe, { op: "history", process: first.process });
  assert.equal(JSON.stringify(hist).includes(b64(img)), false);
});

test("blob：hash 不存在、带 blob: 前缀、不是字符串，都回 error", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const r = await collect(e.pipe, { op: "start", preset: "p", text: "x", images: [b64(png(5, 5))] });
  assert.equal(r.at(-1)?.type, "final");
  const hash = (e.svc.db.prepare("SELECT hash FROM blobs").get() as { hash: string }).hash;
  assert.match(errorOf(await collect(e.pipe, { op: "blob", hash: "0".repeat(64) })), /没有这个 blob/);
  assert.match(errorOf(await collect(e.pipe, { op: "blob", hash: `blob:${hash}` })), /没有这个 blob/);
  assert.match(errorOf(await collect(e.pipe, { op: "blob", hash: 5 } as never)), /无法识别的请求/);
  assert.equal((await collect(e.pipe, { op: "blob", hash }))[0]?.type, "blob");
});

test("blob 是读请求：不写库，不动信箱和副作用表", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  await collect(e.pipe, { op: "start", preset: "p", text: "x", images: [b64(gif(5, 5))] });
  const hash = (e.svc.db.prepare("SELECT hash FROM blobs").get() as { hash: string }).hash;
  const before = e.svc.db.prepare("PRAGMA data_version").get();
  await collect(e.pipe, { op: "blob", hash });
  assert.deepEqual(e.svc.db.prepare("PRAGMA data_version").get(), before);
  assert.equal(e.svc.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n, 0);
});

test("images 的校验：必须是字符串数组", async (t) => {
  const e = await setup(t);
  for (const images of ["abc", [1], [null], {}]) {
    assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "x", images } as never)), /无法识别的请求/);
    assert.match(errorOf(await collect(e.pipe, { op: "send", process: "nope", text: "x", images } as never)), /无法识别的请求/);
  }
  assert.deepEqual(await collect(e.pipe, { op: "ps" }), [{ type: "ps", processes: [] }]);
});

test("入口检查不合格：回 error，什么都不建，blobs 不动", async (t) => {
  const e = await setup(t);
  const ok = b64(png(10, 10));
  const cases: [string[], RegExp][] = [
    [[ok, ok, ok], /最多带 2 张/],
    [[b64(Buffer.concat([png(10, 10), Buffer.alloc(1_600_000)]))], /上限 1572864 字节/],
    [[b64(Buffer.from("BM" + "0".repeat(60)))], /类型不认识/],
    [[b64(png(2001, 100, 7))], /2001×100/],
    [["不是 base64"], /不是合法的 base64/],
  ];
  for (const [images, message] of cases) assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "x", images })), message);
  assert.deepEqual(await collect(e.pipe, { op: "ps" }), [{ type: "ps", processes: [] }]);
  assert.equal(blobRows(e), 0);
  // send：进程在，图片不合格；进程不在，图片合格。信箱和 blobs 都不动。
  const id = await startIdle(e);
  assert.match(errorOf(await collect(e.pipe, { op: "send", process: id, text: "y", images: [b64(png(5000, 5000))] })), /5000×5000/);
  assert.match(errorOf(await collect(e.pipe, { op: "send", process: "nope", text: "y", images: [ok] })), /没有这个进程/);
  assert.equal(blobRows(e), 0);
  assert.equal(segmentOf(e, id).length, 2);
});

test("send 带图片：同一进程的下一封信；blob 引用进段", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("收到图"))]);
  const replies = await collect(e.pipe, { op: "send", process: id, text: "再看", images: [b64(png(7, 8, 1)), b64(png(7, 8, 2))] });
  assert.equal(replies.at(-1)?.type, "final");
  const seg = segmentOf(e, id);
  const user = seg[2];
  assert.ok(user?.role === "user" && Array.isArray(user.content));
  assert.deepEqual(user.content.map((c) => c.type), ["text", "image", "image"]);
  assert.equal(blobRows(e), 2);
});

test("执行器：模型收到的请求里图片是真数据（base64），库里的段仍是引用", async (t) => {
  const e = await setup(t);
  const img = png(16, 16, 9);
  let seen: unknown;
  e.faux.appendResponses([
    (context) => {
      seen = context.messages.at(-1);
      return fauxAssistantMessage(fauxText("好"));
    },
  ]);
  const replies = await collect(e.pipe, { op: "start", preset: "p", text: "看图", images: [b64(img)] });
  assert.equal(replies.at(-1)?.type, "final");
  const content = (seen as { content: { type: string; data?: string; text?: string }[] }).content;
  assert.deepEqual(content.map((c) => c.type), ["text", "image"]);
  assert.equal(content[1]?.data, b64(img));
  assert.match(JSON.stringify(segmentOf(e, (replies[0] as { process: string }).process)[0]), /blob:[0-9a-f]{64}/);
});

test("不收图片的模型：先检查；合格才把每张图换成一行说明，不存图片；不合格回 error", async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 200_000, input: ["text"] }] });
  assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "x", images: [b64(png(3000, 10))] })), /3000×10/);
  assert.deepEqual(await collect(e.pipe, { op: "ps" }), [{ type: "ps", processes: [] }]);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const replies = await collect(e.pipe, { op: "start", preset: "p", text: "看图", images: [b64(png(10, 10)), b64(png(10, 10, 1))] });
  assert.equal(replies.at(-1)?.type, "final");
  const first = replies[0] as { process: string };
  assert.deepEqual(segmentOf(e, first.process)[0]?.role === "user" ? segmentOf(e, first.process)[0]?.content : null, "看图\n[图片：模型不支持，已省略]\n[图片：模型不支持，已省略]");
  assert.equal(blobRows(e), 0);
  assert.match(errorOf(await collect(e.pipe, { op: "send", process: first.process, text: "y", images: [b64(Buffer.from("x".repeat(40)))] })), /类型不认识/);
});

test("工具定义：真服务里运行。text 输出拿到标准输入的参数；content 输出的图片进 blobs，模型收到 base64，库里是引用", { timeout: 60_000 }, async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 200_000, input: ["text", "image"] }] });
  const img = png(20, 20, 4);
  const shot = join(e.work, "s.png");
  writeFileSync(shot, img);
  writeFileSync(join(e.work, "out.json"), JSON.stringify([{ type: "text", text: "截图" }, { type: "image", path: shot }]));
  const def = (name: string, command: string, output: string) => writeFileSync(join(e.toolsDir, `${name}.json`), JSON.stringify({ description: name, parameters: { type: "object", properties: { q: { type: "string" } } }, command, output }));
  def("echoargs", "cat", "text");
  def("shot", "cat out.json", "content");
  writeFileSync(join(e.presetsDir, "d.md"), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: echoargs, shot\n---\n你是测试助手。\n`);
  let seen: { role: string; content: { type: string; data?: string; text?: string }[] }[] = [];
  e.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("echoargs", { q: "问" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("shot", {})], { stopReason: "toolUse" }),
    (context) => {
      seen = context.messages as typeof seen;
      return fauxAssistantMessage(fauxText("看到了"));
    },
  ]);
  const replies = await collect(e.pipe, { op: "start", preset: "d", text: "开始" });
  assert.equal(replies.at(-1)?.type, "final");
  const results = seen.filter((m) => m.role === "toolResult");
  assert.equal(results[0]?.content[0]?.text, '{"q":"问"}\n[退出码 0]');
  assert.deepEqual(results[1]?.content.map((c) => c.type), ["text", "image"]);
  assert.equal(results[1]?.content[1]?.data, b64(img));
  const stored = segmentOf(e, (replies[0] as { process: string }).process).filter((m) => m.role === "toolResult");
  assert.match(JSON.stringify(stored[1]), /blob:[0-9a-f]{64}/);
  assert.equal(JSON.stringify(stored).includes(b64(img)), false);
  assert.equal(blobRows(e), 1);
});

test("工具定义：模型不收图片时，content 输出的图片不存，在原位置换成一行说明", { timeout: 60_000 }, async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 200_000, input: ["text"] }] });
  const shot = join(e.work, "s.png");
  writeFileSync(shot, png(20, 20, 5));
  writeFileSync(join(e.work, "out.json"), JSON.stringify([{ type: "text", text: "截图" }, { type: "image", path: shot }]));
  writeFileSync(join(e.toolsDir, "shot.json"), JSON.stringify({ description: "截图", parameters: { type: "object" }, command: "cat out.json", output: "content" }));
  writeFileSync(join(e.presetsDir, "d.md"), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: shot\n---\n你是测试助手。\n`);
  e.faux.appendResponses([fauxAssistantMessage([fauxToolCall("shot", {})], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("好"))]);
  const replies = await collect(e.pipe, { op: "start", preset: "d", text: "开始" });
  assert.equal(replies.at(-1)?.type, "final");
  const result = segmentOf(e, (replies[0] as { process: string }).process).find((m) => m.role === "toolResult");
  assert.deepEqual(result?.role === "toolResult" && result.content, [{ type: "text", text: "截图\n[图片：模型不支持，已省略]" }]);
  assert.equal(blobRows(e), 0);
});

// fork

/** 回复里的回执：新进程的 ID。 */
const receiptOf = (r: Reply[]): string => {
  const first = r[0];
  assert.equal(first?.type, "receipt");
  return first.process;
};

async function history(e: Env, id: string): Promise<Message[]> {
  const r = await collect(e.pipe, { op: "history", process: id });
  return r.flatMap((x) => (x.type === "message" ? [x.message] : []));
}

test("fork：回执带新 ID，然后关闭连接；history 读新进程等于源进程的前缀；源进程不变", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e, "第一句。");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: a, text: "再说" });
  const src = await history(e, a);
  assert.equal(src.length, 4);
  const stateBefore = JSON.stringify(loadProcess(e.svc.db, a));

  const c = open(e.pipe, { op: "fork", process: a, before: 2 });
  await c.closed;
  assert.equal(c.replies.length, 1);
  const b = receiptOf(c.replies);
  assert.match(b, /^[0-9a-f]{8}$/);
  assert.notEqual(b, a);
  assert.deepEqual(await history(e, b), src.slice(0, 2));
  assert.deepEqual(await collect(e.pipe, { op: "history", process: b }).then((r) => r.at(-1)), { type: "end", segment: 1, messages: 2 });
  assert.equal(JSON.stringify(loadProcess(e.svc.db, a)), stateBefore);
  assert.deepEqual(await history(e, a), src);

  // 不带 before：整个当前段。
  const full = receiptOf(await collect(e.pipe, { op: "fork", process: a }));
  assert.deepEqual(await history(e, full), src);
  const ps = await collect(e.pipe, { op: "ps" });
  const rows = ps[0]?.type === "ps" ? ps[0].processes : [];
  assert.equal(rows.length, 3);
  const row = rows.find((p) => p.self.id === full);
  assert.deepEqual(row?.self.phase, { tag: "idle", ended: "done" });
  assert.deepEqual(rows.find((p) => p.self.id === b)?.self.phase, { tag: "idle" });
});

test("fork 之后对新进程 send：模型收到复制的消息和同样的系统提示词，源进程不受影响", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e, "第一句。");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: a, text: "再说" });
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a, before: 2 }));

  const seen: { system: string | undefined; roles: string[]; last: unknown }[] = [];
  const spy = (context: { systemPrompt?: string; messages: { role: string; content?: unknown }[] }) => {
    // 系统提示词在 systemPrompt 里或者是第一条 system 消息，随 provider 而定。
    const [head, ...rest] = context.messages;
    const inline = head?.role === "system";
    seen.push({ system: context.systemPrompt ?? (inline ? JSON.stringify(head.content) : undefined), roles: (inline ? rest : context.messages).map((m) => m.role), last: context.messages.at(-1) });
    return fauxAssistantMessage(fauxText("分支的话。"));
  };
  e.faux.appendResponses([spy, spy]);
  const r = await collect(e.pipe, { op: "send", process: b, text: "改问" });
  assert.equal(r.at(-1)?.type, "final");
  await collect(e.pipe, { op: "send", process: a, text: "源的下一句" });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0]!.roles, ["user", "assistant", "user"]);
  assert.deepEqual(seen[1]!.roles, ["user", "assistant", "user", "assistant", "user"]);
  assert.ok(seen[0]!.system !== undefined && seen[0]!.system === seen[1]!.system, "系统提示词和源进程一样");
  const bseg = segmentOf(e, b);
  assert.deepEqual(bseg.slice(0, 2), segmentOf(e, a).slice(0, 2));
  assert.equal(bseg.length, 4);
  assert.deepEqual(loadProcess(e.svc.db, b)?.preset, loadProcess(e.svc.db, a)?.preset);
});

test("fork：各种 error，什么都不建", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const errors = async (req: unknown): Promise<string> => {
    const r = await collect(e.pipe, req as Request);
    assert.equal(r.length, 1, JSON.stringify(req));
    assert.equal(r[0]?.type, "error", JSON.stringify(req));
    return r[0]?.type === "error" ? r[0].message : "";
  };
  assert.match(await errors({ op: "fork", process: "nope" }), /没有这个进程：nope/);
  assert.match(await errors({ op: "fork", process: a, before: 2 }), /没有第 2 条/);
  assert.match(await errors({ op: "fork", process: a, before: 1 }), /不是用户消息/);
  for (const bad of [{ op: "fork" }, { op: "fork", process: 1 }, { op: "fork", process: a, before: -1 }, { op: "fork", process: a, before: 0.5 }, { op: "fork", process: a, before: "0" }, { op: "fork", process: a, before: null }]) {
    assert.match(await errors(bad), /^无法识别的请求/, JSON.stringify(bad));
  }
  // 源进程在运行：不带 before 被拒，带 before 可以。
  const p = loadProcess(e.svc.db, a)!;
  saveProcess(e.svc.db, { ...p, lastEffect: p.lastEffect + 1, phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" } });
  assert.match(await errors({ op: "fork", process: a }), /正在运行/);
  assert.equal(receiptOf(await collect(e.pipe, { op: "fork", process: a, before: 0 })).length, 8);
  // 启动检查不通过。
  const q = loadProcess(e.svc.db, a)!;
  saveProcess(e.svc.db, { ...q, phase: { tag: "idle", ended: "done" }, preset: { ...q.preset, contextWindow: 20_000 } });
  assert.match(await errors({ op: "fork", process: a }), /窗口太小/);
  const ps = await collect(e.pipe, { op: "ps" });
  assert.equal(ps[0]?.type === "ps" ? ps[0].processes.length : 0, 2, "只有 a 和那个 before 为 0 的");
});

test("fork：watch 的订阅在回执之前收到新进程的 update；只订阅别的进程的不收", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const all = open(e.pipe, { op: "watch" });
  const mine = open(e.pipe, { op: "watch", process: a });
  await until(() => updates(all).length === 1 && updates(mine).length === 1, "快照");
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a }));
  await until(() => updates(all).length === 2, "新进程的 update");
  const u = updates(all)[1]!;
  assert.equal(u.self.id, b);
  assert.equal(u.self.messages, segmentOf(e, b).length);
  assert.equal(u.self.segment, 1);
  assert.deepEqual(u.self.phase, { tag: "idle", ended: "done" });
  await sleep(100);
  assert.equal(updates(mine).length, 1);
  all.socket.destroy();
  mine.socket.destroy();
});

test("fork 带图片引用的段：新进程的图片还能用 blob 请求读到", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("看到了"))]);
  const img = png(16, 16, 3).toString("base64");
  const a = receiptOf(await collect(e.pipe, { op: "start", preset: "p", text: "看图", images: [img] }));
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a }));
  assert.match(JSON.stringify(segmentOf(e, b)[0]), /blob:[0-9a-f]{64}/);
  assert.deepEqual(segmentOf(e, b), segmentOf(e, a));
});

test("fork 带 preset：新进程用新预设的快照和记忆，之后 send 模型收到新系统提示词、新工具描述和复制的消息；源不变", async (t) => {
  const e = await setup(t);
  writeFileSync(join(e.presetsDir, "q.md"), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: read, write\n---\n你是另一个角色。\n`);
  const a = await startIdle(e, "第一句。");
  const stateBefore = JSON.stringify(loadProcess(e.svc.db, a));
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a, preset: "q" }));
  assert.deepEqual(await history(e, b), await history(e, a));
  assert.equal(loadProcess(e.svc.db, b)?.preset.id, "q");
  assert.equal(JSON.stringify(loadProcess(e.svc.db, a)), stateBefore);

  const seen: { system: string; tools: string[]; roles: string[] }[] = [];
  e.faux.appendResponses([
    (context: { systemPrompt?: string; messages: { role: string; content?: unknown }[] }) => {
      const [head, ...rest] = context.messages;
      const inline = head?.role === "system";
      seen.push({ system: context.systemPrompt ?? (inline ? JSON.stringify(head.content) : ""), tools: getCurrentTools(context.messages as never).map((x) => x.name), roles: (inline ? rest : context.messages).map((m) => m.role) });
      return fauxAssistantMessage(fauxText("换了角色。"));
    },
  ]);
  const r = await collect(e.pipe, { op: "send", process: b, text: "继续" });
  assert.equal(r.at(-1)?.type, "final");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.system, /你是另一个角色/);
  assert.doesNotMatch(seen[0]!.system, /你是测试助手/);
  assert.deepEqual(seen[0]!.tools, ["read", "write", "self", "handoff"]);
  assert.deepEqual(seen[0]!.roles, ["user", "assistant", "user"]);
});

test("fork 带 preset：读不出的预设、放不进的预设、类型不对，都回 error，什么都不建", async (t) => {
  const e = await setup(t);
  writeFileSync(join(e.presetsDir, "low.md"), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: read\nhandoff: 5\n---\n低。\n`);
  const a = await startIdle(e);
  const errors = async (req: unknown): Promise<string> => {
    const r = await collect(e.pipe, req as Request);
    assert.equal(r.length, 1, JSON.stringify(req));
    assert.equal(r[0]?.type, "error", JSON.stringify(req));
    return r[0]?.type === "error" ? r[0].message : "";
  };
  assert.match(await errors({ op: "fork", process: a, preset: "nope" }), /nope/);
  assert.match(await errors({ op: "fork", process: a, preset: "low" }), /窗口太小|放不进/);
  for (const bad of [{ preset: 1 }, { preset: null }]) assert.match(await errors({ op: "fork", process: a, ...bad }), /^无法识别的请求/);
  const ps = await collect(e.pipe, { op: "ps" });
  assert.equal(ps[0]?.type === "ps" ? ps[0].processes.length : 0, 1);
});

// prune、remove、sweep（D59）

/** 整个库，拒绝以后必须和之前逐字节相同。 */
const dumpDb = (e: Env): string =>
  JSON.stringify(["SELECT * FROM processes ORDER BY id", "SELECT * FROM segment_messages ORDER BY process_id, segment_seq, seq", "SELECT * FROM mailbox ORDER BY seq", "SELECT * FROM effects", "SELECT hash FROM blobs ORDER BY hash", "SELECT * FROM memory ORDER BY version"].map((q) => e.svc.db.prepare(q).all()));

/** 把空闲进程改成第 `current` 段：旧段 1 保留，2 到 current-1 各放一条消息，当前段 0 条。 */
function riseTo(e: Env, id: string, current: number): void {
  const p = loadProcess(e.svc.db, id)!;
  saveProcess(e.svc.db, { ...p, segment: { ...p.segment, seq: current } });
  for (let seq = 2; seq < current; seq++) appendMessages(e.svc.db, { ...p, segment: { ...p.segment, seq } }, 0, [{ role: "user", content: `第 ${seq} 段`, timestamp: 1 }]);
}

function withTurn(e: Env, id: string, patch: Partial<Turn>): void {
  const p = loadProcess(e.svc.db, id)!;
  const turn: Turn = { steps: 1, queued: [], hops: 0, replyTo: [], ...patch };
  saveProcess(e.svc.db, { ...p, lastEffect: p.lastEffect + 1, phase: { tag: "awaitingModel", turn, purpose: "turn" } });
}

test("prune：回执，然后关闭；旧段 history 回 error，当前段照读，当前段 0 条回 end；before 越界回 error", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const old = segmentOf(e, id);
  riseTo(e, id, 3);
  assert.equal((await collect(e.pipe, { op: "history", process: id, segment: 2 })).at(-1)?.type, "end");

  const c = open(e.pipe, { op: "prune", process: id, before: 3 });
  await c.closed;
  assert.deepEqual(c.replies, [{ type: "receipt", process: id }]);
  for (const segment of [1, 2]) assert.match(errorOf(await collect(e.pipe, { op: "history", process: id, segment })), /已经被删掉/);
  assert.deepEqual(await collect(e.pipe, { op: "history", process: id }), [{ type: "end", segment: 3, messages: 0 }]);
  assert.equal(old.length, 2);

  // 当前段有消息时照读。
  const p = loadProcess(e.svc.db, id)!;
  const fresh: Message = { role: "user", content: "新段", timestamp: 2 };
  appendMessages(e.svc.db, p, 0, [fresh]);
  assert.deepEqual(await collect(e.pipe, { op: "history", process: id }), [{ type: "message", segment: 3, seq: 0, message: fresh }, { type: "end", segment: 3, messages: 1 }]);

  const before = dumpDb(e);
  assert.match(errorOf(await collect(e.pipe, { op: "prune", process: id, before: 4 })), /当前段/);
  assert.match(errorOf(await collect(e.pipe, { op: "prune", process: "nope", before: 1 })), /没有这个进程/);
  assert.equal(dumpDb(e), before);
  // before 不大于 1 成功，什么都不删。
  assert.deepEqual(await collect(e.pipe, { op: "prune", process: id, before: 0 }), [{ type: "receipt", process: id }]);
  assert.equal(dumpDb(e), before);
});

test("remove：成功时两种订阅都先收到 removed，订阅这个进程的随后关闭，订阅全部的照常收到之后的推送；回执在 removed 之后", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  const all = open(e.pipe, { op: "watch" });
  const mine = open(e.pipe, { op: "watch", process: a });
  const other = open(e.pipe, { op: "watch", process: b });
  await until(() => updates(all).length === 2 && updates(mine).length === 1 && updates(other).length === 1, "快照");

  const order: string[] = [];
  all.socket.on("data", () => order.push("all"));
  mine.socket.on("data", () => order.push("mine"));
  const rm = open(e.pipe, { op: "remove", process: a });
  rm.socket.on("data", () => order.push("receipt"));
  await rm.closed;
  assert.deepEqual(rm.replies, [{ type: "receipt", process: a }]);
  await mine.closed;
  assert.deepEqual(mine.replies.at(-1), { type: "removed", process: a });
  assert.deepEqual(all.replies.filter((r) => r.type === "removed"), [{ type: "removed", process: a }]);
  assert.equal(order.at(-1), "receipt", `回执在 removed 之后：${order.join(",")}`);
  assert.ok(order.indexOf("all") < order.indexOf("receipt") && order.indexOf("mine") < order.indexOf("receipt"));
  assert.ok(!other.replies.some((r) => r.type === "removed"), "订阅别的进程的不收 removed");

  // 记录和段都没了。
  assert.equal(loadProcess(e.svc.db, a), undefined);
  assert.match(errorOf(await collect(e.pipe, { op: "history", process: a })), /没有这个进程/);
  const ps = await collect(e.pipe, { op: "ps" });
  assert.deepEqual(ps[0]?.type === "ps" ? ps[0].processes.map((p) => p.self.id) : [], [b]);

  // 订阅全部的照常订阅：b 之后的推送还能收到。
  e.faux.appendResponses([fauxAssistantMessage(fauxText("再答"))]);
  const n = updates(all).length;
  assert.equal((await collect(e.pipe, { op: "send", process: b, text: "再来" })).at(-1)?.type, "final");
  await until(() => updates(all).length > n, "removed 之后的 update");
  assert.ok(updates(other).length > 1);
  for (const c of [all, other]) c.socket.destroy();
});

test("remove：每条拒绝回 error，库不变", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  const refused = async (id: string, why: RegExp): Promise<void> => {
    const before = dumpDb(e);
    assert.match(errorOf(await collect(e.pipe, { op: "remove", process: id })), why);
    assert.equal(dumpDb(e), before);
  };
  await refused("nope", /没有这个进程/);

  // 信箱里有它的输入。服务不处理它：没有请求调用 pump。
  putMail(e.svc.db, a, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "x" }], hops: 0 } });
  await refused(a, /信箱/);
  e.svc.db.exec("DELETE FROM mailbox");

  // 有进程的 parent 是它。
  saveProcess(e.svc.db, { ...loadProcess(e.svc.db, b)!, parent: a });
  await refused(a, /父进程/);
  saveProcess(e.svc.db, { ...loadProcess(e.svc.db, b)!, parent: undefined });

  // 它在别的进程的 turn.replyTo 里；在排队的信的 replyTo 里；在信箱里的信的 replyTo 里。
  const idleB = loadProcess(e.svc.db, b)!;
  withTurn(e, b, { replyTo: [a] });
  await refused(a, /回信/);
  withTurn(e, b, { queued: [{ from: { kind: "user" }, content: [{ type: "text", text: "x" }], hops: 0, replyTo: a }] });
  await refused(a, /回信/);
  saveProcess(e.svc.db, idleB);
  putMail(e.svc.db, b, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "x" }], hops: 0, replyTo: a } });
  await refused(a, /回信/);
  e.svc.db.exec("DELETE FROM mailbox");

  // 不是空闲。
  withTurn(e, a, {});
  await refused(a, /不是空闲/);
});

test("remove：执行器里还有这个进程的动作没收尾时回 error；收尾以后可以删", async (t) => {
  const e = await setup(t);
  const gate = Promise.withResolvers<void>();
  let started = false;
  e.faux.appendResponses([
    async () => {
      started = true;
      await gate.promise;
      return fauxAssistantMessage(fauxText("晚到的回复"));
    },
  ]);
  const first = open(e.pipe, { op: "start", preset: "p", text: "慢" });
  await until(() => started && first.replies.length > 0, "模型调用开始");
  const id = receiptOf(first.replies);
  // 停止：进程回到 idle，信箱空，但被中止的动作还没结束。
  await collect(e.pipe, { op: "stop", process: id });
  await until(() => loadProcess(e.svc.db, id)?.phase.tag === "idle" && e.svc.db.prepare("SELECT 1 FROM mailbox").get() === undefined, "停止处理完");
  const before = dumpDb(e);
  assert.match(errorOf(await collect(e.pipe, { op: "remove", process: id })), /动作/);
  assert.equal(dumpDb(e), before);

  gate.resolve();
  await first.closed;
  await until(() => !e.svc.db.prepare("SELECT 1 FROM effects").get(), "动作收尾");
  await sleep(50);
  assert.deepEqual(await collect(e.pipe, { op: "remove", process: id }), [{ type: "receipt", process: id }]);
  assert.equal(loadProcess(e.svc.db, id), undefined);
});

test("sweep：回一行 swept，数目对；引用的图片留下，blob 请求还能读到", async (t) => {
  const e = await setup(t);
  const kept = png(16, 16, 1);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("看到了"))]);
  const replies = await collect(e.pipe, { op: "start", preset: "p", text: "看图", images: [b64(kept)] });
  assert.equal(replies.at(-1)?.type, "final");
  const orphans = checkImages([png(16, 16, 2), png(16, 16, 3)].map(b64));
  putBlobs(e.svc.db, orphans);
  assert.equal(blobRows(e), 3);

  const c = open(e.pipe, { op: "sweep" });
  await c.closed;
  assert.deepEqual(c.replies, [{ type: "swept", blobs: 2 }]);
  assert.equal(blobRows(e), 1);
  assert.deepEqual(await collect(e.pipe, { op: "sweep" }), [{ type: "swept", blobs: 0 }]);
  const hash = checkImages([b64(kept)])[0]!.hash;
  assert.equal((await collect(e.pipe, { op: "blob", hash }))[0]?.type, "blob");
});

test("prune、remove、sweep 不调用 pump：信箱里的信不被处理", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  putMail(e.svc.db, a, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "留着" }], hops: 0 } });
  const mail = () => e.svc.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n;
  assert.equal((await collect(e.pipe, { op: "prune", process: a, before: 1 }))[0]?.type, "receipt");
  assert.equal((await collect(e.pipe, { op: "sweep" }))[0]?.type, "swept");
  assert.equal((await collect(e.pipe, { op: "remove", process: b }))[0]?.type, "receipt");
  await sleep(100);
  assert.equal(mail(), 1);
});

test("prune、remove、sweep 的请求校验：缺字段、类型不对都回无法识别的请求", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const bad: unknown[] = [
    { op: "prune", process: id },
    { op: "prune", process: id, before: -1 },
    { op: "prune", process: id, before: 1.5 },
    { op: "prune", process: id, before: "1" },
    { op: "prune", process: id, before: null },
    { op: "prune", before: 1 },
    { op: "prune", process: 1, before: 1 },
    { op: "remove" },
    { op: "remove", process: 1 },
    { op: "remove", process: null },
  ];
  const before = dumpDb(e);
  for (const req of bad) assert.match(errorOf(await collect(e.pipe, req as Request)), /^无法识别的请求/, JSON.stringify(req));
  assert.equal(dumpDb(e), before);
});
