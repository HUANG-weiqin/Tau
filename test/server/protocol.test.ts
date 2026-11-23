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
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, Models, RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { request } from "../../src/cli/main.ts";
import { limits } from "../../src/kernel/derive.ts";
import type { Message } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { TOOLS_FIELD_MAX, WATCH_BUFFER_MAX, serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { gif, jpeg, png } from "../images.ts";
import { appendMessages, loadProcess, loadSegment, putMail, saveProcess } from "../../src/store/db.ts";
import { putBlobs } from "../../src/store/blobs.ts";
import { checkImages } from "../../src/images.ts";
import "../home.ts";
import type { Turn } from "../../src/kernel/types.ts";

interface Env {
  pipe: string;
  faux: FauxProviderHandle;
  svc: Service;
  presetsDir: string;
  toolsDir: string;
  work: string;
  dbPath: string;
  models: Models;
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
  const dbPath = join(dir, "tau.db");
  const svc = await serve({ pipe, dbPath, presetsDir, toolsDir, models, memory: sqliteMemory });
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
  return { pipe, faux, svc, presetsDir, toolsDir, work, dbPath, models, close };
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

test("send 带 handoff：生效时换段，新段里处理这封信；只有 true 才带标记；不是布尔回 error", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const bad = await collect(e.pipe, { op: "send", process: id, text: "x", handoff: "yes" } as unknown as Request);
  assert.equal(bad[0]?.type, "error");
  assert.match(bad[0]?.type === "error" ? bad[0].message : "", /^无法识别的请求/);
  assert.equal(loadProcess(e.svc.db, id)?.segment.seq, 1);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("交接说明")), fauxAssistantMessage(fauxText("新段里的回复"))]);
  const replies = await collect(e.pipe, { op: "send", process: id, text: "换段后做这个", handoff: true });
  assert.equal(replies.at(-1)?.type, "final");
  const p = loadProcess(e.svc.db, id);
  assert.equal(p?.segment.seq, 2);
  const first = segmentOf(e, id)[0];
  assert.ok(first?.role === "user" && typeof first.content === "string" && first.content.includes("换段后做这个"));
  // handoff: false 不带标记，也不换段。
  e.faux.appendResponses([fauxAssistantMessage(fauxText("普通回复"))]);
  await collect(e.pipe, { op: "send", process: id, text: "普通", handoff: false });
  assert.equal(loadProcess(e.svc.db, id)?.segment.seq, 2);
});

test("send 带 handoff 和图片：标记保留，图片进新段", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("交接说明")), fauxAssistantMessage(fauxText("看到了"))]);
  const replies = await collect(e.pipe, { op: "send", process: id, text: "看图", images: [b64(png(7, 8, 1))], handoff: true });
  assert.equal(replies.at(-1)?.type, "final");
  assert.equal(loadProcess(e.svc.db, id)?.segment.seq, 2);
  const first = segmentOf(e, id)[0];
  assert.ok(first?.role === "user" && Array.isArray(first.content));
  assert.equal(first.content.filter((c) => c.type === "image").length, 1);
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

// inspect（D64 第 1 组）

type Inspected = Extract<Reply, { type: "process" }>;
const rowsOf = (r: Reply[]): Inspected[] => r.filter((x): x is Inspected => x.type === "process");

test("inspect：不带 process 回全部进程，按 ID 升序，一个进程一行，最后一行 inspected；记录原样", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  const r = await collect(e.pipe, { op: "inspect" });
  assert.equal(r.length, 3);
  const ids = [a, b].sort();
  assert.deepEqual(rowsOf(r).map((x) => x.process.id), ids);
  for (const row of rowsOf(r)) {
    const p = loadProcess(e.svc.db, row.process.id)!;
    assert.deepEqual(row.process, p);
    assert.equal(row.messages, segmentOf(e, p.id).length);
    assert.deepEqual(row.limits, limits(p.preset));
  }
  const end = r.at(-1);
  assert.equal(end?.type, "inspected");
  assert.equal(end?.type === "inspected" ? end.count : -1, 2);
  assert.equal(end?.type === "inspected" && typeof end.now, "number");
});

test("inspect：带 process 回这一个的一行加结束行；没有进程时回 error，没有结束行；没有任何进程时只有结束行", async (t) => {
  const e = await setup(t);
  const empty = await collect(e.pipe, { op: "inspect" });
  assert.equal(empty.length, 1);
  assert.equal(empty[0]?.type, "inspected");
  assert.equal(empty[0]?.type === "inspected" ? empty[0].count : -1, 0);
  const a = await startIdle(e);
  await startIdle(e);
  const one = await collect(e.pipe, { op: "inspect", process: a });
  assert.deepEqual(one.map((x) => x.type), ["process", "inspected"]);
  assert.equal(rowsOf(one)[0]?.process.id, a);
  assert.equal(one[1]?.type === "inspected" ? one[1].count : -1, 1);
  assert.match(errorOf(await collect(e.pipe, { op: "inspect", process: "nope" })), /没有这个进程：nope/);
});

test("inspect：记录加上 history 的前 messages 条，就是那一刻的状态；messages 和当前段条数一致", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e, "第一句。");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: id, text: "再说" });
  const row = rowsOf(await collect(e.pipe, { op: "inspect", process: id }))[0]!;
  const hist = (await collect(e.pipe, { op: "history", process: id })).filter((x): x is Extract<Reply, { type: "message" }> => x.type === "message");
  assert.equal(row.messages, 4);
  assert.deepEqual(hist.slice(0, row.messages).map((x) => x.message), segmentOf(e, id));
  assert.equal(row.process.segment.seq, 1);
});

test("inspect：出错原因不截短（投影里才截短）", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const long = `错误\n${"长".repeat(2_000)}`;
  saveProcess(e.svc.db, { ...loadProcess(e.svc.db, id)!, phase: { tag: "idle", ended: { error: long } } });
  const row = rowsOf(await collect(e.pipe, { op: "inspect", process: id }))[0]!;
  assert.deepEqual(row.process.phase, { tag: "idle", ended: { error: long } });
});

test("inspect 是读请求：不写库，不开事务，不调 pump（信箱里的信不被处理）；请求校验：process 必须是字符串", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  putMail(e.svc.db, id, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "留着" }], hops: 0 } });
  const before = dumpDb(e);
  await collect(e.pipe, { op: "inspect" });
  await collect(e.pipe, { op: "inspect", process: id });
  await sleep(100);
  assert.equal(dumpDb(e), before);
  assert.equal(e.svc.db.isTransaction, false);
  for (const req of [{ op: "inspect", process: 1 }, { op: "inspect", process: null }]) {
    assert.match(errorOf(await collect(e.pipe, req as unknown as Request)), /^无法识别的请求/);
  }
});

// check（D64 第 2 组）

type Checked = Extract<Reply, { type: "check" }>;

test("check：读得出就回快照、限度和 error:null；快照和 start 冻结的一致", async (t) => {
  const e = await setup(t);
  const r = await collect(e.pipe, { op: "check", preset: "p" });
  assert.equal(r.length, 1);
  const c = r[0] as Checked;
  assert.equal(c.type, "check");
  assert.equal(c.error, null);
  assert.equal(c.snapshot.id, "p");
  assert.deepEqual(c.limits, limits(c.snapshot));
  const id = await startIdle(e);
  assert.deepEqual(loadProcess(e.svc.db, id)?.preset, c.snapshot);
});

test("check：快照里有预设的 options", async (t) => {
  const e = await setup(t);
  writeFileSync(join(e.presetsDir, "opt.md"), `---
workdir: ${e.work}
model: ${e.faux.getModel().provider}/m
tools: read
options: {"temperature":0.4,"samplingParams":{"top_p":0.8}}
---
你是测试助手。
`);
  const c = (await collect(e.pipe, { op: "check", preset: "opt" }))[0] as Checked;
  assert.equal(c.type, "check");
  assert.deepEqual(c.snapshot.options, { temperature: 0.4, samplingParams: { top_p: 0.8 } });
});

test("check：读不出回 error，文字和 start 一字不差；装不下回 check，error 是启动检查的原文", async (t) => {
  const e = await setup(t);
  const preset = (id: string, extra: string) => writeFileSync(join(e.presetsDir, `${id}.md`), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: read\n${extra}---\n你是测试助手。\n`);
  preset("tiny", "handoff: 100\n");
  const c = (await collect(e.pipe, { op: "check", preset: "tiny" }))[0] as Checked;
  assert.equal(c.type, "check");
  assert.match(c.error ?? "", /窗口太小，装不下/);
  assert.equal(errorOf(await collect(e.pipe, { op: "start", preset: "tiny", text: "你好" })), c.error);
  const ghost = errorOf(await collect(e.pipe, { op: "check", preset: "ghost" }));
  assert.equal(ghost, errorOf(await collect(e.pipe, { op: "start", preset: "ghost", text: "你好" })));
});

test("check：不读库，不开事务，什么都不写；请求校验：preset 必须是字符串", async (t) => {
  const e = await setup(t);
  await startIdle(e);
  const before = dumpDb(e);
  await collect(e.pipe, { op: "check", preset: "p" });
  await collect(e.pipe, { op: "check", preset: "ghost" });
  assert.equal(dumpDb(e), before);
  assert.equal(e.svc.db.isTransaction, false);
  for (const req of [{ op: "check" }, { op: "check", preset: 1 }, { op: "check", preset: null }]) {
    assert.match(errorOf(await collect(e.pipe, req as unknown as Request)), /^无法识别的请求/);
  }
});

test("check 和 start 结论一致：读不出、工具定义坏、装不下、能启动", async (t) => {
  const e = await setup(t);
  const preset = (id: string, tools: string, extra = "") => writeFileSync(join(e.presetsDir, `${id}.md`), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: ${tools}\n${extra}---\n你是测试助手。\n`);
  writeFileSync(join(e.toolsDir, "broken.json"), JSON.stringify({ description: 7, parameters: { type: "object" }, command: "echo" }));
  preset("baddef", "read, broken");
  preset("tiny", "read", "handoff: 100\n");
  const cases: { id: string; verdict: "unreadable" | "toobig" | "ok" }[] = [
    { id: "ghost", verdict: "unreadable" },
    { id: "baddef", verdict: "unreadable" },
    { id: "tiny", verdict: "toobig" },
    { id: "p", verdict: "ok" },
  ];
  for (const { id, verdict } of cases) {
    e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
    const c = (await collect(e.pipe, { op: "check", preset: id }))[0]!;
    const s = await collect(e.pipe, { op: "start", preset: id, text: "你好" });
    if (verdict === "unreadable") {
      assert.equal(c.type, "error", id);
      assert.deepEqual(s, [c], id);
    } else if (verdict === "toobig") {
      assert.equal(c.type, "check", id);
      assert.equal(s[0]?.type, "error", id);
      assert.equal(s[0]?.type === "error" ? s[0].message : "", (c as Checked).error, id);
    } else {
      assert.equal(c.type, "check", id);
      assert.equal((c as Checked).error, null, id);
      assert.equal(s[0]?.type, "receipt", id);
    }
  }
});

// start、check 带 workdir：顶掉预设文件里的工作目录

test("start 带 workdir：进程快照的工作目录是覆盖值；目录不存在回 error", async (t) => {
  const e = await setup(t);
  const other = join(e.work, "other");
  mkdirSync(other);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好的。"))]);
  const first = (await collect(e.pipe, { op: "start", preset: "p", text: "你好", workdir: other }))[0];
  assert.equal(first?.type, "receipt");
  const id = first?.type === "receipt" ? first.process : "";
  const row = rowsOf(await collect(e.pipe, { op: "inspect", process: id }))[0]!;
  assert.equal(row.process.preset.workdir, other);
  assert.match(errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "你好", workdir: join(other, "nope") })), /工作目录不存在/);
});

test("check 带 workdir：回执快照的工作目录是覆盖值；同一个坏 workdir 的错误文字和 start 一字不差", async (t) => {
  const e = await setup(t);
  const other = join(e.work, "other");
  mkdirSync(other);
  const c = (await collect(e.pipe, { op: "check", preset: "p", workdir: other }))[0] as Checked;
  assert.equal(c.type, "check");
  assert.equal(c.error, null);
  assert.equal(c.snapshot.workdir, other);
  const missing = join(other, "nope");
  const fromCheck = errorOf(await collect(e.pipe, { op: "check", preset: "p", workdir: missing }));
  assert.equal(fromCheck, errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "你好", workdir: missing })));
  assert.match(fromCheck, /工作目录不存在/);
});

test("start、check 的 workdir 不是字符串：都回无法识别的请求", async (t) => {
  const e = await setup(t);
  for (const req of [
    { op: "start", preset: "p", text: "你好", workdir: 5 },
    { op: "check", preset: "p", workdir: 5 },
  ]) {
    assert.match(errorOf(await collect(e.pipe, req as unknown as Request)), /^无法识别的请求/);
  }
});

// memory、memory_write（D64 第 6 组、D81）

type MemoryReply = Extract<Reply, { type: "memory" | "namespaces" | "memory_written" | "memory_rejected" }>;
const w = (ops: unknown[]) => ({ op: "memory_write", ops }) as unknown as Request;
const setOp = (ns: string, key: string, value: string, expected: unknown, brief?: string) => ({ kind: "set", ns, key, value, expected, ...(brief === undefined ? {} : { brief }) });

/** memory 回复里的 entries：`updated` 是毫秒时间戳（服务的 now），只断言它是个像样的数字，比较时换成 true。 */
function entriesOf(replies: Reply[], ns: string): { key: string; value: string; brief: string; version: number; updated: boolean }[] {
  const m = replies[0];
  assert.ok(m?.type === "memory" && m.ns === ns, JSON.stringify(m));
  return m.entries.map((e) => ({ key: e.key, value: e.value, brief: e.brief, version: e.version, updated: e.updated > 1_600_000_000_000 }));
}

test("memory：不带 ns 列出有键的 ns，带 ns 给键、值、摘要、更新时间、版本；没有键给空数组", async (t) => {
  const e = await setup(t);
  assert.deepEqual(await collect(e.pipe, { op: "memory" }), [{ type: "namespaces", ns: [] }]);
  assert.deepEqual(await collect(e.pipe, { op: "memory", ns: "m" }), [{ type: "memory", ns: "m", entries: [] }]);
  await collect(e.pipe, w([setOp("m", "b", "2", null), setOp("m", "a", "1", null), setOp("zz", "k", "v", null)]));
  assert.deepEqual(await collect(e.pipe, { op: "memory" }), [{ type: "namespaces", ns: ["m", "zz"] }]);
  // 没带 brief：用 briefOf(value)。
  assert.deepEqual(entriesOf(await collect(e.pipe, { op: "memory", ns: "m" }), "m"), [
    { key: "a", value: "1", brief: "1", version: 2, updated: true },
    { key: "b", value: "2", brief: "2", version: 1, updated: true },
  ]);
});

test("memory_write：set 带 brief 就用它，不带就用 briefOf(value)", async (t) => {
  const e = await setup(t);
  const long = "x".repeat(300);
  assert.deepEqual(await collect(e.pipe, w([setOp("m", "短", "值", null, "一句话说明"), setOp("m", "长", long, null)])), [{ type: "memory_written", versions: [1, 2] }]);
  assert.deepEqual(entriesOf(await collect(e.pipe, { op: "memory", ns: "m" }), "m"), [
    { key: "短", value: "值", brief: "一句话说明", version: 1, updated: true },
    { key: "长", value: long, brief: "x".repeat(200), version: 2, updated: true },
  ]);
});

test("memory_write：成功回 memory_written 和每项的版本；不要求预设存在；读和写不开事务不调 pump", async (t) => {
  const e = await setup(t);
  const r = await collect(e.pipe, w([setOp("没有这个预设", "k", "v", null), setOp("m", "k", "v", null)]));
  assert.deepEqual(r, [{ type: "memory_written", versions: [1, 2] }]);
  const del = await collect(e.pipe, w([{ kind: "delete", ns: "m", key: "k", expected: 2 }]));
  assert.deepEqual(del, [{ type: "memory_written", versions: [null] }]);
  assert.equal(e.svc.db.isTransaction, false);
});

test("memory_write：版本冲突、超限是正常回复不是 error，整批回滚", async (t) => {
  const e = await setup(t);
  await collect(e.pipe, w([setOp("m", "k", "旧", null, "旧的")]));
  const conflict = await collect(e.pipe, w([setOp("m", "new", "1", null), setOp("m", "k", "新", 7)]));
  assert.equal(conflict[0]?.type, "memory_rejected");
  const rejected = conflict[0] as Extract<Reply, { type: "memory_rejected" }>;
  assert.equal(rejected.index, 1);
  assert.ok("current" in rejected.result);
  assert.deepEqual(rejected.result.current && { value: rejected.result.current.value, brief: rejected.result.current.brief, version: rejected.result.current.version, updated: rejected.result.current.updated > 1_600_000_000_000 }, { value: "旧", brief: "旧的", version: 1, updated: true });
  const over = await collect(e.pipe, w([setOp("m", "big", "x".repeat(5000), null)]));
  assert.deepEqual(over, [{ type: "memory_rejected", index: 0, result: { ok: false, over: "value", bytes: 5000 } }]);
  // 摘要超过存储上限：不拒，写截断后的（D96）。
  const truncated = await collect(e.pipe, w([setOp("n", "long", "v", null, "b".repeat(301))]));
  assert.equal(truncated[0]?.type, "memory_written");
  assert.equal(entriesOf(await collect(e.pipe, { op: "memory", ns: "n" }), "n")[0]?.brief, "b".repeat(297) + "…");
  const gone = await collect(e.pipe, w([{ kind: "delete", ns: "m", key: "none", expected: 3 }]));
  assert.deepEqual(gone, [{ type: "memory_rejected", index: 0, result: { ok: false, current: null } }]);
  assert.deepEqual(entriesOf(await collect(e.pipe, { op: "memory", ns: "m" }), "m"), [{ key: "k", value: "旧", brief: "旧的", version: 1, updated: true }]);
});

test("memory、memory_write 的校验：ns 不合法、expected 缺失或不是正整数、brief 不是字符串、delete 的 expected 为 null、ops 为空，都回 error，库不变", async (t) => {
  const e = await setup(t);
  const bads: unknown[] = [
    { op: "memory", ns: "" },
    { op: "memory", ns: "a/b" },
    { op: "memory", ns: "a:b" },
    { op: "memory", ns: "a..b" },
    { op: "memory", ns: 1 },
    { op: "memory", ns: null },
    w([]),
    { op: "memory_write" },
    { op: "memory_write", ops: "x" },
    w([setOp("", "k", "v", null)]),
    w([setOp("a/b", "k", "v", null)]),
    w([setOp("m", "k", "v", 0)]),
    w([setOp("m", "k", "v", -1)]),
    w([setOp("m", "k", "v", 1.5)]),
    w([setOp("m", "k", "v", "1")]),
    w([{ kind: "set", ns: "m", key: "k", value: "v" }]),
    w([{ kind: "set", ns: "m", key: 1, value: "v", expected: null }]),
    w([{ kind: "set", ns: "m", key: "k", value: 1, expected: null }]),
    w([{ kind: "set", ns: "m", key: "k", value: "v", brief: 1, expected: null }]),
    w([{ kind: "set", ns: "m", key: "k", value: "v", brief: null, expected: null }]),
    w([{ kind: "delete", ns: "m", key: "k", expected: null }]),
    w([{ kind: "delete", ns: "m", key: "k" }]),
    w([{ kind: "delete", ns: "m", key: "k", expected: 0 }]),
    w([{ kind: "nope", ns: "m", key: "k" }]),
    w([null]),
    // 好的一项后面跟坏的一项：整批拒绝，好的也不写。
    w([setOp("m", "good", "v", null), { kind: "delete", ns: "m", key: "k", expected: null }]),
    w([setOp("m", "good", "v", null), { kind: "set", ns: "m", key: "k", value: "v", brief: 1, expected: null }]),
  ];
  const before = dumpDb(e);
  for (const req of bads) {
    const r = await collect(e.pipe, req as Request);
    assert.equal(r.length, 1, JSON.stringify(req));
    assert.equal(r[0]?.type, "error", JSON.stringify(req));
  }
  assert.match(errorOf(await collect(e.pipe, { op: "memory", ns: "a/b" })), /预设 ID 不合法/);
  assert.match(errorOf(await collect(e.pipe, w([])) ), /^无法识别的请求/);
  assert.equal(dumpDb(e), before);
});

test("memory_write 之后：同预设新开的进程视图看得到，已有进程当前段的 memoryView 不变", async (t) => {
  const e = await setup(t);
  writeFileSync(join(e.presetsDir, "mem.md"), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: read, memory\n---\n你是测试助手。\n`);
  const viewOf = async (id: string) => rowsOf(await collect(e.pipe, { op: "inspect", process: id }))[0]!.process.segment.memoryView;
  const start = async () => {
    e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
    return ((await collect(e.pipe, { op: "start", preset: "mem", text: "hi" }))[0] as { process: string }).process;
  };
  const old = await start();
  assert.equal(await viewOf(old), "");
  assert.deepEqual(await collect(e.pipe, w([setOp("mem", "城市", "北京", null)])), [{ type: "memory_written", versions: [1] }]);
  const fresh = await start();
  assert.match(await viewOf(fresh), /城市/);
  assert.equal(await viewOf(old), "", "运行中的进程当前段的视图是开段时的快照");
  assert.equal(old === fresh, false);
});

// D64 第 8、9 组：send 带 from、reply；start、fork 带 id

test("send 带 from：寄给另一个进程，信的发送者和跳数来自 from 的记录；请求里多余的字段不进信", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e, "a 好");
  const b = await startIdle(e, "b 好");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("收到"))]);
  const r = await collect(e.pipe, { op: "send", process: b, text: "问你", from: a, hops: 99, replyTo: "zzz", sender: { kind: "user" } } as unknown as Request);
  assert.equal(r.at(-1)?.type, "final");
  const first = segmentOf(e, b)[2];
  assert.ok(first?.role === "user");
  assert.match(String(first.content), new RegExp(`^（来自进程 ${a}`));
  // 没有 replyTo：不给 zzz 回信，b 结束时不会往不存在的进程寄信。
  assert.deepEqual(loadProcess(e.svc.db, b)?.phase, { tag: "idle", ended: "done" });
});

test("send 带 from 和 reply：b 处理完，回信进 a 的信箱，a 被唤醒；reply 没有 from、from 不是字符串、reply 不是布尔，回 error", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e, "a 好");
  const b = await startIdle(e, "b 好");
  for (const bad of [{ reply: true }, { from: 1 }, { from: a, reply: "yes" }, { from: a, reply: 1 }]) {
    const r = await collect(e.pipe, { op: "send", process: b, text: "x", ...bad } as unknown as Request);
    assert.match(errorOf(r), /^无法识别的请求/, JSON.stringify(bad));
  }
  assert.equal(segmentOf(e, b).length, 2);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("答案")), fauxAssistantMessage(fauxText("a 收到回信"))]);
  const r = await collect(e.pipe, { op: "send", process: b, text: "几点", from: a, reply: true });
  assert.equal(r.at(-1)?.type, "final");
  // 回信的投递在 b 的结束事务里，a 随后由 pump 处理；等 a 回到 idle。
  for (let i = 0; i < 200 && segmentOf(e, a).length < 4; i++) await sleep(10);
  const seg = segmentOf(e, a);
  assert.equal(seg.length, 4);
  assert.match(String(seg[2]!.role === "user" ? seg[2]!.content : ""), /答案/);
});

test("send 带 from 的拒绝：from 不存在、from 等于目标，回 error，什么都不写", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const before = dumpDb(e);
  assert.match(errorOf(await collect(e.pipe, { op: "send", process: a, text: "x", from: "nobody" })), /没有这个进程：nobody/);
  assert.match(errorOf(await collect(e.pipe, { op: "send", process: a, text: "x", from: a, reply: true })), /不能给自己寄信/);
  assert.equal(dumpDb(e), before);
});

test("send 带 from 和 handoff：标记保留，换段", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = await startIdle(e);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("交接说明")), fauxAssistantMessage(fauxText("新段回复"))]);
  const r = await collect(e.pipe, { op: "send", process: b, text: "换段后做", from: a, handoff: true });
  assert.equal(r.at(-1)?.type, "final");
  assert.equal(loadProcess(e.svc.db, b)?.segment.seq, 2);
});

test("start、fork 带 id：用这个 ID；字符集 [0-9a-z][0-9a-z_-]{0,31}，其余回 error，什么都不建", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const r = await collect(e.pipe, { op: "start", preset: "p", text: "hi", id: "job-1_a" });
  assert.deepEqual(r[0], { type: "receipt", process: "job-1_a" });
  assert.ok(loadProcess(e.svc.db, "job-1_a"));
  const f = await collect(e.pipe, { op: "fork", process: "job-1_a", id: "f0" });
  assert.deepEqual(f, [{ type: "receipt", process: "f0" }]);
  assert.ok(loadProcess(e.svc.db, "f0"));
  const max = "a".repeat(32);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  assert.equal((await collect(e.pipe, { op: "start", preset: "p", text: "hi", id: max }))[0]?.type, "receipt");
  const before = dumpDb(e);
  for (const id of ["", "-a", "_a", "A", "a".repeat(33), "a/b", "a.b", "a b", "中", 1, null]) {
    for (const req of [{ op: "start", preset: "p", text: "hi", id }, { op: "fork", process: "f0", id }]) {
      assert.match(errorOf(await collect(e.pipe, req as unknown as Request)), /^无法识别的请求/, JSON.stringify(req));
    }
  }
  assert.equal(dumpDb(e), before);
});

test("start、fork 带 id：ID 已存在回“进程 ID 已存在”，什么都不写；同一个 id 重试是幂等的", async (t) => {
  const e = await setup(t);
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  assert.equal((await collect(e.pipe, { op: "start", preset: "p", text: "hi", id: "x1" })).at(-1)?.type, "final");
  const before = dumpDb(e);
  assert.equal(errorOf(await collect(e.pipe, { op: "start", preset: "p", text: "hi", id: "x1" })), "进程 ID 已存在：x1");
  assert.equal(errorOf(await collect(e.pipe, { op: "fork", process: "x1", id: "x1" })), "进程 ID 已存在：x1");
  assert.equal(dumpDb(e), before);
  assert.deepEqual(await collect(e.pipe, { op: "fork", process: "x1", id: "x2" }), [{ type: "receipt", process: "x2" }]);
  const once = dumpDb(e);
  assert.equal(errorOf(await collect(e.pipe, { op: "fork", process: "x1", id: "x2" })), "进程 ID 已存在：x2");
  assert.equal(dumpDb(e), once);
});

// D64 第 5 组：watch 推追加的消息；流式预览的种类

const messagesOf = (c: Client): Extract<Reply, { type: "message" }>[] => c.replies.filter((r) => r.type === "message");

test("watch messages：每条 update 之后接着推这次追加的消息，带进程、段号、段内序号；和 history 一致", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const w = open(e.pipe, { op: "watch", process: a, messages: true });
  await until(() => w.replies.length === 1, "快照");
  assert.equal(w.replies[0]?.type, "update", "快照之后才有增量，快照不带消息");

  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: a, text: "再说" });
  await until(() => messagesOf(w).length === 2, "两条消息");
  const rest = w.replies.slice(1).filter((r) => r.type !== "text");
  assert.deepEqual(rest.map((r) => r.type), ["update", "message", "update", "message"], "每次处理输入：先 update，后这次追加的消息");
  const full = segmentOf(e, a);
  assert.deepEqual(messagesOf(w), [
    { type: "message", process: a, segment: 1, seq: 2, message: full[2] },
    { type: "message", process: a, segment: 1, seq: 3, message: full[3] },
  ]);
  // 这条 update 的 messages 已经包含刚推的那条：先 update 后消息，所以 update 里的条数等于消息的 seq 加一。
  const ups = updates(w).slice(1);
  assert.deepEqual(ups.map((u) => u.self.messages), [3, 4]);
  w.socket.destroy();
});

test("watch messages：不带或为 false 时不推消息；不是布尔回 error", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const plain = open(e.pipe, { op: "watch", process: a });
  const off = open(e.pipe, { op: "watch", process: a, messages: false });
  await until(() => plain.replies.length === 1 && off.replies.length === 1, "快照");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("第二句。"))]);
  await collect(e.pipe, { op: "send", process: a, text: "再说" });
  await until(() => updates(plain).length === 3 && updates(off).length === 3, "增量");
  assert.deepEqual([messagesOf(plain).length, messagesOf(off).length], [0, 0]);
  plain.socket.destroy();
  off.socket.destroy();
  const bad = await collect(e.pipe, { op: "watch", process: a, messages: "yes" } as unknown as Request);
  assert.match(errorOf(bad), /^无法识别的请求/);
});

test("watch messages：换段后从新段的第 0 条推起；history 读新段和推的一样", async (t) => {
  const e = await setup(t);
  const id = await startIdle(e);
  const w = open(e.pipe, { op: "watch", process: id, messages: true });
  await until(() => w.replies.length === 1, "快照");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("交接说明")), fauxAssistantMessage(fauxText("新段里的回复"))]);
  await collect(e.pipe, { op: "send", process: id, text: "换段后做这个", handoff: true });
  assert.equal(loadProcess(e.svc.db, id)?.segment.seq, 2);
  await until(() => messagesOf(w).filter((m) => m.segment === 2).length === 2, "新段的两条消息");
  const got = messagesOf(w);
  // 旧段：把交接说明那次调用写进的消息（合并的信本身是新段的第 0 条，不在旧段）。
  assert.deepEqual(got.filter((m) => m.segment === 2).map((m) => m.seq), [0, 1]);
  assert.ok(got.filter((m) => m.segment === 1).every((m, i, all) => i === 0 || m.seq === all[i - 1]!.seq + 1));
  const fresh = (await collect(e.pipe, { op: "history", process: id })).flatMap((r) => (r.type === "message" ? [r.message] : []));
  assert.deepEqual(got.filter((m) => m.segment === 2).map((m) => m.message), fresh);
  w.socket.destroy();
});

test("watch messages：fork 只推新进程的 update，不推复制来的消息；之后新进程的消息照推", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e, "第一句。");
  const w = open(e.pipe, { op: "watch", messages: true });
  await until(() => w.replies.length === 1, "快照");
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a }));
  await until(() => updates(w).some((u) => u.self.id === b), "新进程的 update");
  await sleep(100);
  assert.equal(messagesOf(w).length, 0, "复制来的消息不推");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("分叉后的回复。"))]);
  await collect(e.pipe, { op: "send", process: b, text: "继续" });
  await until(() => messagesOf(w).length === 2, "新进程自己的消息");
  assert.deepEqual(messagesOf(w).map((m) => [m.process, m.segment, m.seq]), [[b, 1, 2], [b, 1, 3]], "序号接在复制来的两条后面");
  w.socket.destroy();
});

test("命令边跑边写的输出（D88）：kind 是 output，只推给带 messages 的订阅，不进库；跑完的结果照旧只在工具结果里", async (t) => {
  const e = await setup(t);
  // 预设带 bash：每行之间停一下，输出一定是分块来的。
  writeFileSync(join(e.presetsDir, "sh.md"), `---
workdir: ${e.work}
model: ${e.faux.getModel().provider}/m
tools: read, bash
---
你是测试助手。
`);
  const r = await collect(e.pipe, { op: "start", preset: "sh", text: "你好" });
  const id = r.find((x) => x.type === "receipt")?.process;
  assert.equal(typeof id, "string");
  const plain = open(e.pipe, { op: "watch", process: id });
  const sub = open(e.pipe, { op: "watch", process: id, messages: true });
  await until(() => plain.replies.length === 1 && sub.replies.length === 1, "快照");
  e.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo 第一行; sleep 0.4; echo 第二行" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("好了。")),
  ]);
  await collect(e.pipe, { op: "send", process: id!, text: "跑一下" });
  await until(() => sub.replies.some((x: any) => x.type === "message" && x.message.role === "toolResult"), "工具结果进段");
  const out = sub.replies.filter((x: any) => x.type === "text" && x.kind === "output");
  assert.ok(out.length >= 2, `分批推来的：${JSON.stringify(out.map((x: any) => String(x.delta)))}`);
  assert.equal(out.map((x: any) => String(x.delta)).join(""), "第一行\n第二行\n");
  assert.ok(out.every((x: any) => typeof x.n === "number"));
  // 结果里的输出和推来的内容一致；旧订阅收不到带 kind 的流。
  const result = sub.replies.find((x) => x.type === "message" && x.message.role === "toolResult");
  assert.match(JSON.stringify(result?.type === "message" ? result.message.content : ""), /第一行\\n第二行/);
  assert.equal(plain.replies.filter((x: any) => x.type === "text" && x.kind !== undefined).length, 0, "不带 messages 的订阅收不到");
  // 预览不进库：段里就是两条信、一次调用、一份结果、一条正文。
  const hist = await collect(e.pipe, { op: "history", process: id!, segment: 1, from: 0 });
  assert.equal(hist.filter((x) => x.type === "message").length, 5);
  plain.socket.destroy();
  sub.socket.destroy();
});

test("text 的 kind：思考和工具调用的流只推给带 messages 的订阅；start、send 的连接和普通订阅只收正文，不带 kind", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const plain = open(e.pipe, { op: "watch", process: a });
  const sub = open(e.pipe, { op: "watch", process: a, messages: true });
  await until(() => plain.replies.length === 1 && sub.replies.length === 1, "快照");
  e.faux.appendResponses([
    fauxAssistantMessage([fauxThinking("先想一想"), fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("好了。")),
  ]);
  const replies = await collect(e.pipe, { op: "send", process: a, text: "你好" });
  const texts = replies.filter((r) => r.type === "text");
  assert.ok(texts.length > 0);
  for (const r of texts) assert.equal("kind" in r, false, "start 的连接收到的 text 不带 kind");
  assert.equal(texts.map((r) => r.delta).join(""), "好了。", "只有正文");
  await until(() => sub.replies.some((r) => r.type === "text" && r.kind === "toolCall") && sub.replies.some((r) => r.type === "text" && r.delta === "好了。"), "订阅收到各种流");
  const subTexts = sub.replies.filter((r) => r.type === "text");
  const thinking = subTexts.filter((r) => r.kind === "thinking");
  assert.ok(thinking.length > 0);
  assert.equal(thinking.map((r) => r.delta).join(""), "先想一想");
  const calls = subTexts.filter((r) => r.kind === "toolCall");
  assert.ok(calls.length > 0);
  assert.deepEqual(JSON.parse(calls.map((r) => r.delta).join("")), { path: "a.txt" });
  // 正文没有 kind，编号是产生它的副作用编号。
  const body = subTexts.filter((r) => r.kind === undefined);
  assert.equal(body.map((r) => r.delta).join(""), "好了。");
  assert.ok(body.every((r) => r.n === 4));
  // 不带 messages 的订阅（旧客户端）：只有正文，没有 kind。
  const plainTexts = plain.replies.filter((r) => r.type === "text");
  assert.equal(plainTexts.some((r) => "kind" in r), false, "旧订阅收不到带 kind 的 text");
  assert.equal(plainTexts.map((r) => r.delta).join(""), "好了。");
  plain.socket.destroy();
  sub.socket.destroy();
});

// reconfigure（D71）：改这个会话的快照。校验、回执的 pending、调用参数不重读文件、结构性字段重读（手动刷新）、startError、revert、不唤醒空闲进程。

const reconfigureErrors = async (e: Env, req: unknown): Promise<string> => {
  const before = dumpDb(e);
  const message = errorOf(await collect(e.pipe, req as Request));
  assert.equal(dumpDb(e), before, `${JSON.stringify(req)} 回了 error，库必须不变`);
  return message;
};
const reconfigure = async (e: Env, process: string, body: { fields?: unknown; revert?: true }): Promise<boolean> => {
  const r = await collect(e.pipe, { op: "reconfigure", process, ...body } as Request);
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0]?.type, "reconfigured", JSON.stringify(r));
  assert.ok(r[0]?.type === "reconfigured" && r[0].process === process);
  return r[0]?.type === "reconfigured" && r[0].pending;
};
const preset = (e: Env, id: string, tools: string): void => writeFileSync(join(e.presetsDir, `${id}.md`), `---\nworkdir: ${e.work}\nmodel: ${e.faux.getModel().provider}/m\ntools: ${tools}\n---\n你是测试助手。\n`);
const toolFile = (e: Env, name: string, description: string): void => writeFileSync(join(e.toolsDir, `${name}.json`), JSON.stringify({ description, parameters: { type: "object" }, command: "echo hi" }));

test("reconfigure 的请求校验：fields 和 revert 恰好一个；id、不认识的键、类型不对，都回 error，库不变", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const errors = (req: unknown) => reconfigureErrors(e, req);
  const base = { op: "reconfigure", process: a };
  assert.match(await errors(base), /要带 fields 或者 revert: true，恰好一个/);
  assert.match(await errors({ ...base, fields: { thinking: "low" }, revert: true }), /要带 fields 或者 revert: true，恰好一个/);
  for (const revert of [false, null, 1, "true"]) assert.match(await errors({ ...base, revert }), /要带 fields 或者 revert: true，恰好一个/, JSON.stringify(revert));
  for (const fields of [{}, [], null, "x", 1]) assert.match(await errors({ ...base, fields }), /fields 必须是至少一个键的对象|要带 fields 或者 revert: true，恰好一个/, JSON.stringify(fields));
  assert.equal(await errors({ ...base, fields: { id: "other" } }), "id 不能改：它是记忆库的 ID，换角色用 fork 带 preset");
  assert.equal(await errors({ ...base, fields: { thinking: "low", id: "p" } }), "id 不能改：它是记忆库的 ID，换角色用 fork 带 preset");
  for (const key of ["color", "toolDefs", "contextWindow", "input", "next", "constructor", "__proto__", "toString"]) assert.match(await errors({ ...base, fields: JSON.parse(`{"${key}": 1}`) }), new RegExp(`fields 里没有这个键：${key}$`), key);
  const bad: [string, unknown][] = [["model", 1], ["tools", "read"], ["tools", [1]], ["tools", null], ["thinking", 5], ["handoff", "1000"], ["handoff", true], ["options", []], ["options", "{}"], ["prompt", null], ["prompt", 3], ["workdir", 3], ["workdir", null], ["context", "a.md"], ["context", [1]]];
  for (const [key, value] of bad) assert.equal(await errors({ ...base, fields: { [key]: value } }), `reconfigure 的 fields.${key} 类型不对`, `${key}: ${JSON.stringify(value)}`);
  // process 不是字符串、缺失：无法识别的请求。
  for (const req of [{ op: "reconfigure", fields: { thinking: "low" } }, { op: "reconfigure", process: 1, fields: { thinking: "low" } }, { op: "reconfigure", revert: true }]) assert.match(await errors(req), /^无法识别的请求/);
  // 值的内容由读预设的同一套校验管，文字一样。
  assert.match(await errors({ ...base, fields: { thinking: "wild" } }), /^预设 p 的 thinking 只能是/);
  assert.match(await errors({ ...base, fields: { handoff: 0 } }), /^预设 p 的 handoff 必须是正整数（token）：0$/);
  assert.match(await errors({ ...base, fields: { handoff: 1.5 } }), /^预设 p 的 handoff 必须是正整数/);
  assert.match(await errors({ ...base, fields: { options: { apiKey: "x" } } }), /^预设 p 的 options 里的 apiKey 不能用/);
  assert.match(await errors({ ...base, fields: { model: "faux/nope" } }), /^模型目录里没有 faux\/nope$/);
  assert.match(await errors({ ...base, fields: { workdir: "rel" } }), /^预设 p 的工作目录必须是绝对路径：rel$/);
  assert.match(await errors({ ...base, fields: { tools: ["read", "ghost"] } }), /^找不到工具定义：ghost$/);
  assert.match(await errors({ ...base, fields: { context: ["/e/x"] } }), /^预设 p 的 context 必须是相对路径或 Windows 绝对路径/);
});

test("reconfigure：进程不存在回 error，库不变", async (t) => {
  const e = await setup(t);
  await startIdle(e);
  assert.equal(await reconfigureErrors(e, { op: "reconfigure", process: "nope", fields: { thinking: "low" } }), "没有这个进程：nope");
  assert.equal(await reconfigureErrors(e, { op: "reconfigure", process: "nope", revert: true }), "没有这个进程：nope");
});

test("reconfigure：只改调用参数立即生效，pending 为 false；改结构性字段存 next，pending 为 true；空闲的进程不被唤醒", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const old = loadProcess(e.svc.db, a)!;
  const seg = segmentOf(e, a);
  assert.equal(await reconfigure(e, a, { fields: { thinking: "high", handoff: 50_000, options: { temperature: 0.3 } } }), false);
  const p = loadProcess(e.svc.db, a)!;
  assert.deepEqual([p.preset.thinking, p.preset.handoff, p.preset.options], ["high", 50_000, { temperature: 0.3 }]);
  assert.equal("next" in p, false);
  assert.deepEqual({ ...p, preset: old.preset }, old, "别的一点没动：阶段、段、副作用编号");

  assert.equal(await reconfigure(e, a, { fields: { prompt: "新的提示词。", tools: ["read", "write"] } }), true);
  const q = loadProcess(e.svc.db, a)!;
  assert.deepEqual([q.next?.prompt, q.next?.tools, q.next?.thinking], ["新的提示词。", ["read", "write"], "high"]);
  assert.equal(q.preset.prompt, old.preset.prompt, "结构性字段换段时才生效");
  assert.deepEqual(q.phase, { tag: "idle", ended: "done" }, "回执之后仍是 idle");
  assert.deepEqual(segmentOf(e, a), seg, "没有新消息");
  assert.deepEqual(e.svc.db.prepare("SELECT * FROM mailbox").all(), []);
  assert.deepEqual(e.svc.db.prepare("SELECT * FROM effects").all(), []);
  // inspect 原样带 next，limits 是当前快照的。
  const inspected = await collect(e.pipe, { op: "inspect", process: a });
  const row = inspected[0];
  assert.ok(row?.type === "process");
  assert.equal(row.process.next?.prompt, "新的提示词。");
  assert.deepEqual(row.limits, limits(q.preset));
});

test("reconfigure：watch 的 update 带 self.pending；改回来以后没有这个键", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const sub = open(e.pipe, { op: "watch", process: a });
  await until(() => updates(sub).length === 1, "快照");
  assert.equal("pending" in updates(sub)[0]!.self, false);
  assert.equal(await reconfigure(e, a, { fields: { prompt: "新的。", tools: ["read", "write"], context: ["AGENTS.md"] } }), true);
  await until(() => updates(sub).length === 2, "reconfigure 之后的 update");
  assert.deepEqual(updates(sub)[1]!.self.pending, { fields: ["prompt", "tools", "context"] });
  assert.equal(await reconfigure(e, a, { revert: true }), false);
  await until(() => updates(sub).length === 3, "revert 之后的 update");
  assert.equal("pending" in updates(sub)[2]!.self, false);
  sub.socket.destroy();
});

test("reconfigure：fields 只有调用参数时不重读文件；有结构性字段时重读工具定义文件（手动刷新）", async (t) => {
  const e = await setup(t);
  preset(e, "withdef", "read, notes");
  toolFile(e, "notes", "写笔记 v1");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const a = receiptOf((await collect(e.pipe, { op: "start", preset: "withdef", text: "你好" }).then((r) => r.slice(0, 1))));
  await until(() => loadProcess(e.svc.db, a)?.phase.tag === "idle", "空闲");
  // 换掉、甚至删掉工具定义文件：调用参数的 reconfigure 不看它，也不受它影响。
  toolFile(e, "notes", "写笔记 v2");
  assert.equal(await reconfigure(e, a, { fields: { thinking: "low" } }), false);
  rmSync(join(e.toolsDir, "notes.json"));
  assert.equal(await reconfigure(e, a, { fields: { handoff: 60_000 } }), false);
  const p = loadProcess(e.svc.db, a)!;
  assert.deepEqual(p.preset.toolDefs.map((d) => d.description), ["写笔记 v1"]);
  assert.equal("next" in p, false);
  // 结构性字段：重读文件。文件没了就报错；文件回来、把 tools 原样发一次，就是手动刷新。
  assert.match(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { tools: ["read", "notes"] } }), /^找不到工具定义：notes$/);
  toolFile(e, "notes", "写笔记 v3");
  assert.equal(await reconfigure(e, a, { fields: { tools: ["read", "notes"] } }), true);
  const q = loadProcess(e.svc.db, a)!;
  assert.deepEqual(q.preset.toolDefs.map((d) => d.description), ["写笔记 v1"]);
  assert.deepEqual(q.next?.toolDefs.map((d) => d.description), ["写笔记 v3"]);
  assert.deepEqual(q.next?.thinking, "low", "调用参数跟着");
});

test("reconfigure：startError 不通过回 error，原文，库不变（调用参数和结构性字段两条路都查）", async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 200_000 }, { id: "small", contextWindow: 28_000 }] });
  const a = await startIdle(e);
  const provider = e.faux.getModel().provider;
  const low = await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { handoff: 5 } });
  assert.match(low, /^预设 p 的窗口太小，装不下：固定部分 \d+ token，记忆的上界 0 token，换段阈值 5 token$/);
  const small = await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { model: `${provider}/small`, tools: ["read", "memory"] } });
  assert.match(small, /^预设 p 的窗口太小，装不下：固定部分 \d+ token，记忆的上界 \d+ token，换段阈值 -?\d+ token$/);
  // 声明了 context 才多一项上下文的上界。
  const ctx = await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { handoff: 9_000, context: ["AGENTS.md"] } });
  assert.match(ctx, /记忆的上界 0 token，上下文的上界 \d+ token，换段阈值 9000 token$/);
});

test("reconfigure：revert 放弃待换配置，调用参数保留；没有待换配置时什么都不改", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  assert.equal(await reconfigure(e, a, { fields: { thinking: "high", prompt: "待换的。" } }), true);
  assert.equal(await reconfigure(e, a, { revert: true }), false);
  const p = loadProcess(e.svc.db, a)!;
  assert.equal("next" in p, false);
  assert.equal(p.preset.thinking, "high");
  assert.notEqual(p.preset.prompt, "待换的。");
  // 没有待换配置：revert 是空操作，库里只有那一条信箱输入被处理掉。
  const before = dumpDb(e);
  assert.equal(await reconfigure(e, a, { revert: true }), false);
  assert.equal(dumpDb(e), before);
});

test("reconfigure：待换配置存在时，新的以待换的为底；换回当前结构就取消", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  assert.equal(await reconfigure(e, a, { fields: { prompt: "第一版。" } }), true);
  assert.equal(await reconfigure(e, a, { fields: { tools: ["read", "write"] } }), true);
  const p = loadProcess(e.svc.db, a)!;
  assert.deepEqual([p.next?.prompt, p.next?.tools], ["第一版。", ["read", "write"]], "第二次以第一次的结果为底");
  const old = p.preset;
  assert.equal(await reconfigure(e, a, { fields: { prompt: old.prompt, tools: old.tools } }), false, "换回和当前一样：取消");
  assert.equal("next" in loadProcess(e.svc.db, a)!, false);
});

test("reconfigure：空闲、段里没有助手消息：直接采用，pending 为 false", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const b = receiptOf(await collect(e.pipe, { op: "fork", process: a, before: 0 }));
  assert.deepEqual(segmentOf(e, b), []);
  assert.equal(await reconfigure(e, b, { fields: { prompt: "新角色。", tools: ["read", "write"] } }), false);
  const p = loadProcess(e.svc.db, b)!;
  assert.deepEqual([p.preset.prompt, p.preset.tools], ["新角色。", ["read", "write"]]);
  assert.equal("next" in p, false);
  assert.equal(p.segment.seq, 1);
});

test("reconfigure：进程在跑时，调用参数立即换，结构性字段存 next；已发出的副作用编号不变", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  withTurn(e, a, {});
  const running = loadProcess(e.svc.db, a)!;
  assert.equal(running.phase.tag, "awaitingModel");
  assert.equal(await reconfigure(e, a, { fields: { thinking: "high", prompt: "待换的。" } }), true);
  const p = loadProcess(e.svc.db, a)!;
  assert.deepEqual(p.phase, running.phase);
  assert.equal(p.lastEffect, running.lastEffect);
  assert.equal(p.preset.thinking, "high");
  assert.equal(p.preset.prompt, running.preset.prompt);
  assert.equal(p.next?.prompt, "待换的。");
});

test("reconfigure 之后换段：采用待换配置，新段的请求带新的系统提示词和工具", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  assert.equal(await reconfigure(e, a, { fields: { prompt: "你是新角色。", tools: ["read", "write"] } }), true);
  const seen: { system: string; tools: string[] }[] = [];
  const spy = (answer: string) => (context: { systemPrompt?: string; messages: { role: string; content?: unknown }[] }) => {
    const [head] = context.messages;
    seen.push({ system: context.systemPrompt ?? (head?.role === "system" ? JSON.stringify(head.content) : ""), tools: getCurrentTools(context.messages as never).map((x) => x.name) });
    return fauxAssistantMessage(fauxText(answer));
  };
  e.faux.appendResponses([spy("交接说明：继续。"), spy("新段里的回复。")]);
  const r = await collect(e.pipe, { op: "send", process: a, text: "换段后处理", handoff: true });
  assert.equal(r.at(-1)?.type, "final");
  assert.equal(seen.length, 2);
  assert.match(seen[0]!.system, /你是测试助手/, "交接请求仍用旧快照");
  assert.deepEqual(seen[0]!.tools, ["read", "self", "handoff"]);
  assert.match(seen[1]!.system, /你是新角色/);
  assert.doesNotMatch(seen[1]!.system, /你是测试助手/);
  assert.deepEqual(seen[1]!.tools, ["read", "write", "self", "handoff"]);
  const p = loadProcess(e.svc.db, a)!;
  assert.equal(p.segment.seq, 2);
  assert.equal(p.preset.prompt, "你是新角色。");
  assert.equal("next" in p, false);
  assert.equal(await reconfigure(e, a, { revert: true }), false);
});

// reconfigure 的边界（D71）：嵌套很深的工具定义、fields.tools 的个数、立即生效的那份也过启动检查、段放不进新窗口。

test("reconfigure：嵌套 2200 层的工具定义不会卡住信箱：只改 thinking 成功，信箱里没有残留，进程照常收信，服务能重启", async (t) => {
  const e = await setup(t);
  let nested: unknown = { type: "object" };
  for (let i = 0; i < 2200; i++) nested = { a: nested };
  writeFileSync(join(e.toolsDir, "deep.json"), JSON.stringify({ description: "d", parameters: { type: "object", properties: nested }, command: "echo hi" }));
  preset(e, "deepy", "read, deep");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const started = await collect(e.pipe, { op: "start", preset: "deepy", text: "你好" });
  const a = receiptOf(started);
  assert.equal(started.at(-1)?.type, "final");
  const mailbox = () => e.svc.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n;

  assert.equal(await reconfigure(e, a, { fields: { thinking: "low" } }), false);
  assert.equal(mailbox(), 0, "信箱里没有残留");
  assert.equal(loadProcess(e.svc.db, a)?.preset.thinking, "low");
  // 结构性字段：重读工具定义、重建快照，和当前的比较，同样不抛。
  assert.equal(await reconfigure(e, a, { fields: { prompt: "新的。" } }), true);
  assert.equal(mailbox(), 0);
  assert.equal(loadProcess(e.svc.db, a)?.next?.prompt, "新的。");
  assert.equal(await reconfigure(e, a, { fields: { prompt: loadProcess(e.svc.db, a)!.preset.prompt } }), false, "换回去：取消");
  // 进程照常收信。
  e.faux.appendResponses([fauxAssistantMessage(fauxText("再好"))]);
  const sent = await collect(e.pipe, { op: "send", process: a, text: "再来" });
  assert.equal(sent.at(-1)?.type, "final");
  assert.equal(mailbox(), 0);

  // 服务重启：库里没有卡住的输入，进程还在。
  await e.close();
  const again = await serve({ pipe: `${e.pipe}-again`, dbPath: e.dbPath, presetsDir: e.presetsDir, toolsDir: e.toolsDir, models: e.models, memory: sqliteMemory });
  try {
    assert.equal(loadProcess(again.db, a)?.preset.thinking, "low");
    assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n, 0);
  } finally {
    await again.close();
  }
});

test("reconfigure：fields.tools 最多 128 项，超了回清楚的 error 且库不变；3 万个名字的请求也立刻回；128 项能过校验；去重照旧", async (t) => {
  const e = await setup(t);
  const a = await startIdle(e);
  const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);
  assert.equal(TOOLS_FIELD_MAX, 128);
  assert.equal(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { tools: names(129) } }), "reconfigure 的 fields.tools 最多 128 项：现在有 129 项");
  const t0 = Date.now();
  assert.equal(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { tools: names(30_000) } }), "reconfigure 的 fields.tools 最多 128 项：现在有 30000 项");
  assert.ok(Date.now() - t0 < 5_000, `3 万个名字用了 ${Date.now() - t0} 毫秒`);
  // 个数按请求里的算，重复的也计：129 个同名的也拒绝。
  assert.match(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { tools: Array.from({ length: 129 }, () => "read") } }), /最多 128 项：现在有 129 项$/);
  // 128 项能过个数的检查：名字都没有对应的工具定义，错在读文件，不在个数。
  assert.equal(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { tools: names(128) } }), "找不到工具定义：t0");
  // 去重照旧：重复的名字只算一个，保留第一次出现的位置。
  toolFile(e, "n1", "一");
  toolFile(e, "n2", "二");
  assert.equal(await reconfigure(e, a, { fields: { tools: ["n2", "read", "n1", "n2", "read", "n1"] } }), true);
  const next = loadProcess(e.svc.db, a)?.next;
  assert.deepEqual(next?.tools, ["read"]);
  assert.deepEqual(next?.toolDefs.map((d) => d.name), ["n2", "n1"]);
});

test("reconfigure：已有待换配置时只改调用参数，立即生效的那份（当前快照带新参数）也过启动检查，两份任何一份不过就回 error，库不变", async (t) => {
  const e = await setup(t);
  preset(e, "mem", "read, memory");
  e.faux.appendResponses([fauxAssistantMessage(fauxText("好"))]);
  const started = await collect(e.pipe, { op: "start", preset: "mem", text: "你好" });
  const a = receiptOf(started);
  // 待换配置去掉了 memory：固定部分加记忆的上界小得多。
  assert.equal(await reconfigure(e, a, { fields: { tools: ["read"] } }), true);
  const p = loadProcess(e.svc.db, a)!;
  assert.deepEqual([p.preset.tools, p.next?.tools], [["read", "memory"], ["read"]]);
  const threshold = 5_000;
  assert.ok(limits(p.next!).fixed + limits(p.next!).memoryMax < threshold, "待换的那份放得下");
  assert.ok(limits(p.preset).fixed + limits(p.preset).memoryMax >= threshold, "当前的那份放不下");
  // 以待换的为底，handoff 5000：S 过启动检查，立即生效的那份（当前快照带 handoff 5000）过不了。
  const error = await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { handoff: threshold } });
  assert.match(error, /^当前配置带上新的调用参数就过不了启动检查：预设 mem 的窗口太小，装不下：固定部分 \d+ token，记忆的上界 \d+ token，换段阈值 5000 token$/);
  assert.equal(loadProcess(e.svc.db, a)?.preset.handoff, undefined, "当前快照没被套上");
  // 对照：没有待换配置时，同样的 handoff 由 S（就是当前快照）的检查拦下，文字和从前一样。
  assert.equal(await reconfigure(e, a, { revert: true }), false);
  assert.match(await reconfigureErrors(e, { op: "reconfigure", process: a, fields: { handoff: threshold } }), /^预设 mem 的窗口太小，装不下：固定部分/);
  // 两份都过时照常成功：调用参数立即换，next 带着同样的调用参数。
  assert.equal(await reconfigure(e, a, { fields: { tools: ["read"] } }), true);
  assert.equal(await reconfigure(e, a, { fields: { handoff: 100_000 } }), true);
  const q = loadProcess(e.svc.db, a)!;
  assert.deepEqual([q.preset.handoff, q.next?.handoff, q.next?.tools], [100_000, 100_000, ["read"]]);
});

test("reconfigure：空闲、段里没有助手消息、但段放不进新窗口：存 next，pending 为 true，当前快照照用；放得下时直接采用，pending 为 false", async (t) => {
  const e = await setup(t, { models: [{ id: "m", contextWindow: 200_000 }, { id: "mid", contextWindow: 100_000 }] });
  const a = await startIdle(e);
  const provider = e.faux.getModel().provider;
  // 复制出一个没有助手消息的进程（上一轮被停止的样子），段里放四条各约 32 KB 的用户消息。
  const fillTo = async (messages: number): Promise<string> => {
    const id = receiptOf(await collect(e.pipe, { op: "fork", process: a, before: 0 }));
    const p = loadProcess(e.svc.db, id)!;
    appendMessages(e.svc.db, p, 0, Array.from({ length: messages }, (): Message => ({ role: "user", content: "字".repeat(10_900), timestamp: 1 })));
    return id;
  };
  const big = await fillTo(4);
  assert.equal(segmentOf(e, big).length, 4);
  assert.equal(await reconfigure(e, big, { fields: { model: `${provider}/mid` } }), true);
  const p = loadProcess(e.svc.db, big)!;
  assert.equal(p.preset.contextWindow, 200_000, "当前快照没换");
  assert.equal(p.next?.contextWindow, 100_000);
  assert.deepEqual(segmentOf(e, big).length, 4, "段没动");
  // 同样的窗口，段里只有一条消息：放得下，直接采用。
  const small = await fillTo(1);
  assert.equal(await reconfigure(e, small, { fields: { model: `${provider}/mid` } }), false);
  const q = loadProcess(e.svc.db, small)!;
  assert.equal(q.preset.contextWindow, 100_000);
  assert.equal("next" in q, false);
});

test("等 bash 的时候来了信（D104）：前台的 bash 约 1 秒后转后台，结果多一行说明，信在安全点并进段，完成信照常寄到", async (t) => {
  const e = await setup(t);
  writeFileSync(join(e.presetsDir, "sh.md"), `---
workdir: ${e.work}
model: ${e.faux.getModel().provider}/m
tools: read, bash
---
你是测试助手。
`);
  e.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo 开始; sleep 5", timeout: 60 })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("看到插话了。")),
    fauxAssistantMessage(fauxText("收到完成信。")),
  ]);
  const starter = open(e.pipe, { op: "start", preset: "sh", text: "你好" });
  await until(() => starter.replies.some((x) => x.type === "receipt"), "回执");
  const id = starter.replies.find((x) => x.type === "receipt")!.process;
  await until(() => segmentOf(e, id).some((m) => m.role === "assistant"), "bash 的调用进段");
  await sleep(300);
  const sent = Date.now();
  const letter = open(e.pipe, { op: "send", process: id, text: "插话" });
  await until(() => segmentOf(e, id).some((m) => m.role === "toolResult"), "bash 的结果", 8_000);
  assert.ok(Date.now() - sent < 4_000, `用了 ${Date.now() - sent} 毫秒`);
  const text = (m: Message | undefined): string => (m?.role === "toolResult" ? m.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "");
  const at = segmentOf(e, id).findIndex((m) => m.role === "toolResult");
  assert.match(text(segmentOf(e, id)[at]), /^(开始\n)?有新的信在排队，没等满 timeout 就转了后台。\n\[转入后台 [0-9a-f]{6}\] 命令还在运行，没有被结束。\n/);
  // 完成信（约 5 秒后）把进程再唤醒一次，回复完才算收尾：不留 notify.ts 在跑。
  await until(() => segmentOf(e, id).some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("收到完成信")), "完成信的回复", 15_000);
  const seg = segmentOf(e, id);
  assert.equal(seg[at + 1]?.role, "user", "信在安全点紧跟工具结果");
  assert.match(JSON.stringify(seg[at + 1]?.content), /插话/);
  assert.match(JSON.stringify(seg.at(-2)?.content), /\[后台任务 [0-9a-f]{6}\] 退出码 0/);
  starter.socket.destroy();
  letter.socket.destroy();
});
