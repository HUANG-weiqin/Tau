// 第 3 步验收：工具调用配对。一条回复里有 3 个工具调用（read、bash、read）：全部跑完、中途停止、中途崩溃。
// 走真的服务、管道和库；模型是 pi-ai 的 faux。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message as AiMessage } from "@earendil-works/pi-ai";
import { request } from "../../src/cli/main.ts";
import { INTERRUPTED, SKIPPED } from "../../src/kernel/decide.ts";
import type { Message } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { loadProcess, loadSegment, openDb } from "../../src/store/db.ts";
import { effectRows, mailbox } from "../store/fixtures.ts";
import { assertStoreInvariants } from "../store/invariants.ts";

interface Env {
  work: string;
  presets: string;
  dbPath: string;
  pipe: string;
  faux: ReturnType<typeof fauxProvider>;
  models: ReturnType<typeof createModels>;
  services: Service[];
}

/** 临时目录、faux 模型和一个只有 read、bash 的预设。测试结束时关掉服务，等子进程都退出，再删目录。 */
function setup(t: TestContext): Env {
  const dir = mkdtempSync(join(tmpdir(), "tau-pairing-"));
  const work = join(dir, "work");
  const presets = join(dir, "presets");
  mkdirSync(work);
  mkdirSync(presets);
  writeFileSync(join(work, "a.txt"), "one\n");
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presets, "dev.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read, bash\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-pairing-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const env: Env = { work, presets, dbPath: join(dir, "tau.db"), pipe, faux, models, services: [] };
  t.after(async () => {
    // 已经“崩溃”的服务再关一次会因为库已关而拒绝，忽略。
    for (const s of env.services) await s.close().catch(() => {});
    await noChildren(10_000);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // 停止会结束 bash，原因同 kill.test.ts
  });
  return env;
}

/** 启动服务，并记下服务端的每个连接：模拟崩溃时由“操作系统”断开它们。 */
async function boot(e: Env): Promise<{ svc: Service; sockets: Set<Socket> }> {
  const svc = await serve({ pipe: e.pipe, dbPath: e.dbPath, presetsDir: e.presets, models: e.models, memory: sqliteMemory });
  e.services.push(svc);
  const sockets = new Set<Socket>();
  svc.server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return { svc, sockets };
}

/**
 * 进程内的崩溃。崩溃对库的全部效果是：库停在最后一个提交的事务上，之后什么都写不进去，运行中的动作永远不会上报。
 * 1. 先关掉库句柄。所有事务都是同步的，所以这一刻就是崩溃点：旧服务之后的任何事务都会失败。
 * 2. 断开所有连接，进程死后操作系统也会这样做。
 * 3. 停止监听，释放管道名。close() 会标记 closing：旧执行器里还在跑的动作迟到的上报碰到关掉的库而失败时被丢弃，
 *    不会让测试进程退出。close() 最后再关一次库会抛错，忽略。
 * 和真崩溃唯一的区别：运行中的 bash 不会随进程一起死，它会像孤儿进程一样跑完。
 */
async function crash({ svc, sockets }: { svc: Service; sockets: Set<Socket> }): Promise<void> {
  svc.db.close();
  for (const s of sockets) s.destroy();
  await svc.close().catch(() => {});
}

/** 发一条请求。`receipt` 在收到回执时给出进程 ID，连接没有回执就关了则给出 null；`done` 在服务关闭连接时给出全部回复。 */
function call(pipe: string, req: Request): { receipt: Promise<string | null>; done: Promise<Reply[]> } {
  const replies: Reply[] = [];
  const receipt = Promise.withResolvers<string | null>();
  const done = request(pipe, req, (r) => {
    replies.push(r);
    if (r.type === "receipt") receipt.resolve(r.process);
  }).then(() => {
    receipt.resolve(null);
    return replies;
  });
  return { receipt: receipt.promise, done };
}

/** 一条回复里的 3 个工具调用：读 a.txt、跑 bash、再读 a.txt。 */
function threeCalls(command: string): AssistantMessage {
  return fauxAssistantMessage(
    [fauxToolCall("read", { path: "a.txt" }, { id: "c1" }), fauxToolCall("bash", { command }, { id: "c2" }), fauxToolCall("read", { path: "a.txt" }, { id: "c3" })],
    { stopReason: "toolUse" },
  );
}

/** 消息的简写：角色，加上助手消息里的工具调用 ID，或工具结果所属的调用 ID。 */
function shape(m: AiMessage): string {
  switch (m.role) {
    case "assistant": {
      const ids = m.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : []));
      return ids.length > 0 ? `assistant ${ids.join(",")}` : "assistant";
    }
    case "toolResult":
      return `toolResult ${m.toolCallId}`;
    default:
      return m.role;
  }
}

function results(segment: readonly Message[]): { id: string; text: string; isError: boolean }[] {
  return segment.flatMap((m) =>
    m.role === "toolResult" ? [{ id: m.toolCallId, text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError }] : [],
  );
}

function segmentOf(db: DatabaseSync, id: string): Message[] {
  const p = loadProcess(db, id);
  assert.ok(p, `库里没有进程 ${id}`);
  return loadSegment(db, p);
}

/** 此刻：第 1 个结果已经写入，进程在等第 2 个调用，它的副作用行是 running。 */
function assertSecondRunning(db: DatabaseSync, id: string): void {
  const p = loadProcess(db, id);
  assert.equal(p?.phase.tag, "awaitingTool");
  assert.deepEqual(segmentOf(db, id).map(shape), ["user", "assistant c1,c2,c3", "toolResult c1"]);
  assert.deepEqual(effectRows(db), [{ id, n: p.lastEffect, status: "running" }]);
  assertStoreInvariants(db);
}

/** 静止：副作用表和信箱都空，不变量成立。 */
function assertQuiet(db: DatabaseSync): void {
  assert.deepEqual(effectRows(db), []);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
}

/** 这个测试进程里还活着的子进程数：bash 工具启动的 bash，和它结束进程树时用的 taskkill、kill。 */
function children(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap").length;
}

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(10)) {
    if (Date.now() > end) throw new Error(`等了 ${ms} 毫秒，仍然没有：${what}`);
  }
}

/** 子进程全部退出，并且 200 毫秒内没有新的（bash 工具结束进程树分两步，中间有空档）。 */
async function noChildren(ms: number): Promise<void> {
  await until(() => children() === 0, ms, "子进程全部退出");
  await sleep(200);
  await until(() => children() === 0, ms, "子进程全部退出");
}

const FIRST = { id: "c1", text: "     1\tone", isError: false };

test("3 个工具调用按顺序执行：每个调用恰好一个结果，按调用顺序紧跟在助手消息后面，最终回复到达", async (t) => {
  const e = setup(t);
  let secondRequest: string[] = [];
  e.faux.setResponses([
    // 第 1 个和第 3 个读同一个文件，第 2 个改写它：读到的内容证明三者按顺序执行。
    threeCalls("printf 'two\\n' > a.txt; echo ran"),
    (context) => {
      secondRequest = context.messages.map(shape);
      return fauxAssistantMessage(fauxText("三件事都做完了。"));
    },
  ]);
  const { svc } = await boot(e);
  const { receipt, done } = call(e.pipe, { op: "start", preset: "dev", text: "按顺序做三件事" });
  const replies = await done;
  const id = await receipt;
  assert.ok(id);
  assert.deepEqual(replies.at(-1), { type: "final", reply: "三件事都做完了。", ended: "done" });

  const seg = segmentOf(svc.db, id);
  assert.deepEqual(seg.map(shape), ["user", "assistant c1,c2,c3", "toolResult c1", "toolResult c2", "toolResult c3", "assistant"]);
  const [r1, r2, r3, ...rest] = results(seg);
  assert.deepEqual(r1, FIRST);
  assert.equal(r2?.id, "c2");
  assert.equal(r2?.isError, false);
  assert.match(r2?.text ?? "", /^ran\n/);
  assert.deepEqual(r3, { id: "c3", text: "     1\ttwo", isError: false });
  assert.deepEqual(rest, []);
  // 模型的第二次请求里，三个结果按调用顺序紧跟在它自己那条消息后面。
  assert.deepEqual(secondRequest.slice(-4), ["assistant c1,c2,c3", "toolResult c1", "toolResult c2", "toolResult c3"]);
  assert.deepEqual(loadProcess(svc.db, id)?.phase, { tag: "idle", ended: "done" });
  assertQuiet(svc.db);
});

test("第 2 个调用运行中停止：第 1 个是真结果，第 2 个被中断，第 3 个未执行；sleep 很快被中止；之后的 send 照常工作", async (t) => {
  const e = setup(t);
  e.faux.setResponses([threeCalls("echo started > started.txt; sleep 5; echo finished > finished.txt"), fauxAssistantMessage(fauxText("这次好了。"))]);
  const { svc } = await boot(e);
  const first = call(e.pipe, { op: "start", preset: "dev", text: "做三件事" });
  const id = await first.receipt;
  assert.ok(id);
  await until(() => existsSync(join(e.work, "started.txt")), 10_000, "bash 开始执行命令");
  assertSecondRunning(svc.db, id);

  const t0 = performance.now();
  assert.deepEqual(await call(e.pipe, { op: "stop", process: id }).done, [{ type: "receipt", process: id }]);
  assert.deepEqual((await first.done).at(-1), { type: "final", reply: "", ended: "stopped" });
  // 停止的事务删掉了 running 行，服务随即中止 bash。bash 不被中止的话要 5 秒后才退出。
  await until(() => children() === 0, 4_000, "被中止的 bash 退出");
  const ms = Math.round(performance.now() - t0);
  t.diagnostic(`从发出停止到 bash 退出：${ms} 毫秒`);
  assert.ok(ms < 2_500, `bash 在停止后 ${ms} 毫秒才退出`);

  const seg = segmentOf(svc.db, id);
  assert.deepEqual(seg.map(shape), ["user", "assistant c1,c2,c3", "toolResult c1", "toolResult c2", "toolResult c3"]);
  assert.deepEqual(results(seg), [FIRST, { id: "c2", text: INTERRUPTED, isError: true }, { id: "c3", text: SKIPPED, isError: true }]);
  assert.deepEqual(loadProcess(svc.db, id)?.phase, { tag: "idle", ended: "stopped" });
  assertQuiet(svc.db);

  // 被中止的 bash 迟到的上报被丢弃：它的行已经不在了。
  await noChildren(4_000);
  const later = await call(e.pipe, { op: "send", process: id, text: "再来一次" }).done;
  assert.deepEqual(later.at(-1), { type: "final", reply: "这次好了。", ended: "done" });
  const after = segmentOf(svc.db, id);
  assert.deepEqual(after.slice(0, seg.length), seg);
  assert.deepEqual(after.slice(seg.length).map(shape), ["user", "assistant"]);
  assertQuiet(svc.db);
  assert.equal(existsSync(join(e.work, "finished.txt")), false);
});

test("第 2 个调用运行中崩溃：重启后第 2 个被中断、第 3 个未执行，本轮以服务重启的错误结束；不变量成立", async (t) => {
  const e = setup(t);
  e.faux.setResponses([threeCalls("echo started > started.txt; sleep 2; echo finished > finished.txt"), fauxAssistantMessage(fauxText("重启后也好了。"))]);
  const old = await boot(e);
  const first = call(e.pipe, { op: "start", preset: "dev", text: "做三件事" });
  const id = await first.receipt;
  assert.ok(id);
  await until(() => existsSync(join(e.work, "started.txt")), 10_000, "bash 开始执行命令");
  assertSecondRunning(old.svc.db, id);

  await crash(old);
  // 连接被断开：客户端只拿到回执，没有最终回复。
  assert.deepEqual(await first.done, [{ type: "receipt", process: id }]);

  // 崩溃点：第 2 个调用的行还是 running，不变量成立。
  const db = openDb(e.dbPath);
  try {
    assertSecondRunning(db, id);
  } finally {
    db.close();
  }

  // serve() 返回之前已经做完启动恢复，也处理完了恢复放进信箱的输入。
  const { svc } = await boot(e);
  const p = loadProcess(svc.db, id);
  assert.equal(p?.phase.tag, "idle");
  const ended = p.phase.tag === "idle" ? p.phase.ended : undefined;
  assert.ok(typeof ended === "object", `本轮应以错误结束，实际是 ${JSON.stringify(ended)}`);
  assert.match(ended.error, /服务重启/);
  const seg = segmentOf(svc.db, id);
  assert.deepEqual(seg.map(shape), ["user", "assistant c1,c2,c3", "toolResult c1", "toolResult c2", "toolResult c3"]);
  assert.deepEqual(results(seg), [FIRST, { id: "c2", text: INTERRUPTED, isError: true }, { id: "c3", text: SKIPPED, isError: true }]);
  assertQuiet(svc.db);

  const later = await call(e.pipe, { op: "send", process: id, text: "继续" }).done;
  assert.deepEqual(later.at(-1), { type: "final", reply: "重启后也好了。", ended: "done" });

  // 崩溃前启动的 bash 跑完了（写了 finished.txt），它的结果没有进库，也没有被重做。
  await noChildren(5_000);
  assert.equal(existsSync(join(e.work, "finished.txt")), true);
  const after = segmentOf(svc.db, id);
  assert.deepEqual(after.slice(0, seg.length), seg);
  assert.deepEqual(after.slice(seg.length).map(shape), ["user", "assistant"]);
  assertQuiet(svc.db);
});
