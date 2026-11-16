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
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { request } from "../../src/cli/main.ts";
import type { Message } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { WATCH_BUFFER_MAX, serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { appendMessages, loadProcess, loadSegment, saveProcess } from "../../src/store/db.ts";

interface Env {
  pipe: string;
  faux: FauxProviderHandle;
  svc: Service;
  /** 关服务。可以多次调用；测试结束时也会调。 */
  close(): Promise<void>;
}

async function setup(t: TestContext, fauxOptions: RegisterFauxProviderOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-proto-"));
  const work = join(dir, "work");
  const presetsDir = join(dir, "presets");
  mkdirSync(work);
  mkdirSync(presetsDir);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }], ...fauxOptions });
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presetsDir, "p.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-proto-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, models, memory: sqliteMemory });
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
  return { pipe, faux, svc, close };
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
