// 第 5 步验收：用 CLI 同时运行两个进程，一个带记忆、一个不带；`self` 显示的内容和 `tau ps` 一致。
// 另外两条路径：流式文本到达连接，CLI 只打印一次；模型在启动之后从目录里消失，本轮出错，进程照常可用。
// 走真的服务、管道和库；模型是 pi-ai 的 faux。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { format } from "node:util";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxProviderHandle, FauxResponseFactory, Message as AiMessage, MutableModels, RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { ago, main, request } from "../../src/cli/main.ts";
import { contextUsed } from "../../src/kernel/derive.ts";
import type { Projection } from "../../src/kernel/observe.ts";
import type { Message } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { loadProcess, loadSegment, saveProcess } from "../../src/store/db.ts";
import { effectRows, mailbox } from "../store/fixtures.ts";
import { assertStoreInvariants } from "../store/invariants.ts";

const WINDOW = 200_000;

interface Env {
  pipe: string;
  /** faux 的 provider ID，也是预设里模型名的前缀。 */
  provider: string;
  faux: FauxProviderHandle;
  models: MutableModels;
  svc: Service;
  /** 本测试建的门。结束时全部放行：测试中途失败时，服务不会一直等一个被挡住的模型调用。 */
  gates: Gate[];
}

/** 临时目录、faux 模型、预设（ID → tools 字段）和一个服务。测试结束时放行所有门、断开连接、关服务、删目录。 */
async function setup(t: TestContext, presets: Record<string, string>, fauxOptions: RegisterFauxProviderOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-cli-"));
  const work = join(dir, "work");
  const presetsDir = join(dir, "presets");
  mkdirSync(work);
  mkdirSync(presetsDir);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: WINDOW }], ...fauxOptions });
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = faux.getModel().provider;
  for (const [id, tools] of Object.entries(presets)) {
    writeFileSync(join(presetsDir, `${id}.md`), `---\nworkdir: ${work}\nmodel: ${provider}/m\ntools: ${tools}\n---\n你是测试助手。\n`);
  }
  const pipe = `\\\\.\\pipe\\tau-test-cli-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const gates: Gate[] = [];
  const sockets = new Set<Socket>();
  let svc: Service | undefined;
  t.after(async () => {
    for (const g of gates) g.open();
    for (const s of sockets) s.destroy();
    await svc?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, models, memory: sqliteMemory });
  svc.server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return { pipe, provider, faux, models, svc, gates };
}

interface Gate {
  /** 模型调用走到了门口。 */
  reached: Promise<void>;
  open(): void;
  /** 在模型调用里用：报告走到了门口，再等放行。 */
  pass(): Promise<void>;
}

function gate(e: Env): Gate {
  const reached = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const g: Gate = {
    reached: reached.promise,
    open: () => opened.resolve(),
    pass: () => {
      reached.resolve();
      return opened.promise;
    },
  };
  e.gates.push(g);
  return g;
}

interface ModelCall {
  /** 本段第一条用户消息，用它认出是哪个进程。 */
  first: string;
  /** 本段第几次调用模型：段里已有的助手消息数加一。 */
  step: number;
  /** 请求里带的工具名。 */
  tools: string[];
  messages: AiMessage[];
}

/** 每次调用模型都交给 `f`。faux 的回复队列由所有进程共用，所以按请求的内容分派，不按调用的先后。 */
function script(faux: FauxProviderHandle, f: (c: ModelCall) => AssistantMessage | Promise<AssistantMessage>): void {
  const step: FauxResponseFactory = (context) => {
    const { messages } = context;
    const tools = getCurrentTools(messages).map((x) => x.name);
    return f({ first: firstUser(messages), step: messages.filter((m) => m.role === "assistant").length + 1, tools, messages });
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
}

function firstUser(messages: readonly AiMessage[]): string {
  for (const m of messages) {
    if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  return "";
}

interface ToolOutput {
  name: string;
  text: string;
  isError: boolean;
}

function toolOutputs(messages: readonly (AiMessage | Message)[]): ToolOutput[] {
  return messages.flatMap((m) =>
    m.role === "toolResult" ? [{ name: m.toolName, text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError }] : [],
  );
}

interface Capture {
  /** 写到标准输出的每一块：`console.log` 一次算一块，`process.stdout.write` 一次算一块。 */
  out: string[];
  err: string[];
}

/**
 * 截下 CLI 的输出，测试结束时还原。只截字符串：`node --test` 的子进程用 Buffer 往标准输出写测试结果，照常放行。
 * 截取是全局的，所以同时运行的几个 `main` 的输出会交错；断言只看确定没有别人在写的那一段。
 */
function capture(t: TestContext): Capture {
  const cap: Capture = { out: [], err: [] };
  const { log, error } = console;
  const write = process.stdout.write;
  console.log = (...a: unknown[]) => void cap.out.push(`${format(...a)}\n`);
  console.error = (...a: unknown[]) => void cap.err.push(`${format(...a)}\n`);
  const stdout = process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== "string") return Reflect.apply(write, process.stdout, [chunk, ...rest]) as boolean;
    cap.out.push(chunk);
    return true;
  };
  t.after(() => {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  });
  return cap;
}

/** 标准错误里 `tau start` 打印的进程 ID，按打印的顺序。 */
function startedIds(cap: Capture): string[] {
  return [...cap.err.join("").matchAll(/^进程 (\w+)$/gm)].map((m) => m[1] ?? "");
}

/** 运行 `tau ps`，取它这一次打印的文字：表头，和按进程 ID 索引的各列（列之间是两个空格）。 */
async function cliPs(pipe: string, cap: Capture): Promise<{ header: string; rows: Map<string, string[]> }> {
  const from = cap.out.length;
  assert.equal(await main(["ps"], pipe), 0);
  const [header = "", ...lines] = cap.out.slice(from).join("").trimEnd().split("\n");
  const rows = new Map<string, string[]>();
  for (const line of lines) {
    const cols = line.split("  ");
    rows.set(cols[0] ?? "", cols);
  }
  return { header, rows };
}

/** 发一条请求。`receipt` 在收到回执时给出进程 ID，连接没有回执就关了则拒绝；`done` 在服务关闭连接时给出全部回复。 */
function call(pipe: string, req: Request): { receipt: Promise<string>; done: Promise<Reply[]> } {
  const replies: Reply[] = [];
  const receipt = Promise.withResolvers<string>();
  receipt.promise.catch(() => {});
  const done = request(pipe, req, (r) => {
    replies.push(r);
    if (r.type === "receipt") receipt.resolve(r.process);
  }).then(() => {
    receipt.reject(new Error(`没有回执：${JSON.stringify(replies)}`));
    return replies;
  });
  return { receipt: receipt.promise, done };
}

async function collect(pipe: string, req: Request): Promise<Reply[]> {
  const out: Reply[] = [];
  await request(pipe, req, (r) => out.push(r));
  return out;
}

async function projections(pipe: string): Promise<Projection[]> {
  const [r] = await collect(pipe, { op: "ps" });
  assert.equal(r?.type, "ps");
  return r.processes;
}

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(10)) {
    if (Date.now() > end) throw new Error(`等了 ${ms} 毫秒，仍然没有：${what}`);
  }
}

/** 静止：副作用表和信箱都空，不变量成立。 */
function assertQuiet(svc: Service): void {
  assert.deepEqual(effectRows(svc.db), []);
  assert.deepEqual(mailbox(svc.db), []);
  assertStoreInvariants(svc.db);
}

function segmentOf(svc: Service, id: string): Message[] {
  const p = loadProcess(svc.db, id);
  assert.ok(p, `库里没有进程 ${id}`);
  return loadSegment(svc.db, p);
}

const PLAIN = "只读的进程：等着";
const MEM = "带记忆的进程：记住颜色";


test("ps 的运行多久和 self 一样向下取整：ps 不会比 self 显示得更久", () => {
  assert.equal(ago(6_999), "6秒");
  assert.equal(ago(119_999), "1分");
  assert.equal(ago(3_600_000 + 359_999), "1.0时");
  assert.equal(ago(86_400_000 * 2 - 1), "1.9天");
  // 系统对时把时钟往回拨时，创建时间可能晚于现在。self 显示 0 秒，ps 也一样。
  assert.equal(ago(-1), "0秒");
  assert.equal(ago(-90_000), "0秒");
});

test("用 CLI 同时运行两个进程：带记忆的写入又读回记忆，不带记忆的请求里没有记忆工具；停止一个，另一个照常结束", { timeout: 10_000 }, async (t) => {
  const e = await setup(t, { mem: "read, memory", plain: "read" });
  const plainGate = gate(e);
  const memGate = gate(e);
  let plainTools: string[] = [];
  let memTools: string[] = [];
  let memSeen: ToolOutput[] = [];
  let plainReturned = false;
  script(e.faux, async (c) => {
    if (c.first === PLAIN) {
      plainTools = c.tools;
      await plainGate.pass();
      plainReturned = true;
      return fauxAssistantMessage("这条回复来得太晚，会被丢弃。");
    }
    assert.equal(c.first, MEM);
    switch (c.step) {
      case 1:
        memTools = c.tools;
        return fauxAssistantMessage(fauxToolCall("memory_set", { key: "color", value: "blue" }), { stopReason: "toolUse" });
      case 2:
        return fauxAssistantMessage(fauxToolCall("memory_get", { key: "color" }), { stopReason: "toolUse" });
      default:
        memSeen = toolOutputs(c.messages);
        await memGate.pass();
        return fauxAssistantMessage("记住了：blue。");
    }
  });
  const cap = capture(t);

  // 先启动不带记忆的进程，挡在第一次模型调用上；再启动带记忆的，它在前者运行期间写记忆、读记忆，然后挡在第 3 步。
  const plainMain = main(["start", "plain", PLAIN], e.pipe);
  await plainGate.reached;
  await until(() => startedIds(cap).length === 1, 5_000, "tau start 打印第一个进程 ID");
  const memMain = main(["start", "mem", MEM], e.pipe);
  await memGate.reached;
  await until(() => startedIds(cap).length === 2, 5_000, "tau start 打印第二个进程 ID");
  const [plainId = "", memId = ""] = startedIds(cap);

  // 两个模型调用此刻都在运行。
  assert.deepEqual(new Set(effectRows(e.svc.db).map((r) => `${r.id} ${r.status}`)), new Set([`${plainId} running`, `${memId} running`]));
  const ps1 = await cliPs(e.pipe, cap);
  assert.match(ps1.header, /^现在 /);
  assert.equal(ps1.rows.size, 2);
  assert.deepEqual(ps1.rows.get(plainId)?.slice(1, 3), ["plain", "等模型 第1步"]);
  assert.deepEqual(ps1.rows.get(memId)?.slice(1, 3), ["mem", "等模型 第3步"]);
  // 兄弟进程只算同一个预设下的：两个进程的预设不同，互相不是兄弟。
  for (const p of await projections(e.pipe)) assert.deepEqual(p.siblings, [], `${p.self.id} 的兄弟进程`);

  // 带记忆的进程：memory_set 写入，memory_get 读回同一个版本和值。
  const [set, got, ...more] = memSeen;
  assert.equal(set?.name, "memory_set");
  assert.equal(set.isError, false);
  const version = /^已写入 color，版本 (\d+)。$/.exec(set.text)?.[1];
  assert.ok(version, set.text);
  assert.deepEqual(got, { name: "memory_get", text: `color（版本 ${version}）：\nblue`, isError: false });
  assert.deepEqual(more, []);

  // 工具列表取自 faux 收到的请求。
  for (const name of ["memory_get", "memory_set", "memory_delete"]) assert.ok(memTools.includes(name), `带记忆的请求里没有 ${name}：${memTools.join(", ")}`);
  assert.deepEqual(plainTools.filter((n) => n.startsWith("memory")), [], `不带记忆的请求里有记忆工具：${plainTools.join(", ")}`);
  assert.ok(plainTools.includes("read") && plainTools.includes("self"), plainTools.join(", "));

  // 停止不带记忆的进程：它的 start 收到被停止的最终回复；另一个仍在运行。
  assert.equal(await main(["stop", plainId], e.pipe), 0);
  assert.equal(await plainMain, 1);
  assert.match(cap.err.join(""), /^\[本轮结束：stopped\]$/m);
  // 被中止的模型调用这时才返回：它的行已经不在了，回复被丢弃（见最后对段的断言）。
  plainGate.open();
  await until(() => plainReturned, 5_000, "被停止的模型调用返回");
  const ps2 = await cliPs(e.pipe, cap);
  assert.deepEqual(ps2.rows.get(plainId)?.slice(1, 3), ["plain", "idle(stopped)"]);
  assert.deepEqual(ps2.rows.get(memId)?.slice(1, 3), ["mem", "等模型 第3步"]);

  memGate.open();
  assert.equal(await memMain, 0);
  const ps3 = await cliPs(e.pipe, cap);
  assert.equal(ps3.rows.size, 2);
  assert.deepEqual(ps3.rows.get(plainId)?.slice(1, 3), ["plain", "idle(stopped)"]);
  assert.deepEqual(ps3.rows.get(memId)?.slice(1, 3), ["mem", "idle(done)"]);
  assert.equal(cap.out.join("").split("记住了：blue。").length, 2, "带记忆的回复应恰好打印一次");

  assert.deepEqual(loadProcess(e.svc.db, plainId)?.phase, { tag: "idle", ended: "stopped" });
  assert.deepEqual(segmentOf(e.svc, plainId).map((m) => m.role), ["user"]);
  const rows = e.svc.db.prepare("SELECT ns, key, value FROM memory").all();
  assert.deepEqual(rows.map((r) => [r.ns, r.key, r.value]), [["mem", "color", "blue"]]);
  assertQuiet(e.svc);
});

const BUSY = "一直在跑的进程";
const LOOKER = "看看自己的进程";

test("self 显示上下文用量、时间和运行中的兄弟进程；tau ps 的投影和它一致", { timeout: 10_000 }, async (t) => {
  const e = await setup(t, { dev: "read" });
  const busyGate = gate(e);
  const lookerGate = gate(e);
  let seen: ToolOutput[] = [];
  script(e.faux, async (c) => {
    if (c.first === BUSY) {
      await busyGate.pass();
      return fauxAssistantMessage("忙完了。");
    }
    if (c.step === 1) return fauxAssistantMessage(fauxToolCall("self", {}), { stopReason: "toolUse" });
    seen = toolOutputs(c.messages);
    await lookerGate.pass();
    return fauxAssistantMessage("看过了。");
  });

  // 同一个预设的两个进程：一个挡在模型调用上；另一个调用 self，然后挡在下一次模型调用上。
  const busy = call(e.pipe, { op: "start", preset: "dev", text: BUSY });
  const busyId = await busy.receipt;
  await busyGate.reached;
  const t0 = Date.now();
  const looker = call(e.pipe, { op: "start", preset: "dev", text: LOOKER });
  const lookerId = await looker.receipt;
  await lookerGate.reached;
  const t1 = Date.now();

  // 两个进程都挡着，投影里能比的字段在 self 之后都不会再变。
  const all = await projections(e.pipe);
  const cap = capture(t);
  const table = await cliPs(e.pipe, cap);
  const mine = all.find((p) => p.self.id === lookerId);
  const theirs = all.find((p) => p.self.id === busyId);
  assert.ok(mine && theirs, JSON.stringify(all));

  const [self, ...more] = seen;
  assert.equal(self?.name, "self");
  assert.equal(self.isError, false);
  assert.deepEqual(more, []);
  const text = self.text;
  const now = /^现在：(.+)（(.+)）$/m.exec(text);
  const who = /^进程：(\w+)，预设 ([^，]+)，模型 ([^，]+)，已运行 /m.exec(text);
  const seg = /^工作段：第 (\d+) 段/m.exec(text);
  const used = /^上下文：已用约 (\d+) token，窗口 (\d+) token$/m.exec(text);
  assert.ok(now && who && seg && used, text);
  const siblings = [...text.matchAll(/^- (\w+)：(.+)，已运行 [^，]+$/gm)].map((m) => [m[1], m[2]]);

  // 时间：服务所在机器的本地时间和时区，是 self 执行那一刻的。
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(now[2], tz);
  const shown: string[] = [];
  for (let s = Math.floor(t0 / 1000) * 1000; s <= t1; s += 1000) shown.push(new Date(s).toLocaleString("zh-CN", { hour12: false }));
  assert.ok(shown.includes(now[1] ?? ""), `self 的时间 ${now[1]} 不在 ${shown.join("、")} 之中`);

  // 上下文用量：self 执行时，段里是用户消息和调用 self 的那条助手消息；ps 时多了 self 的结果。两者按同一个函数算。
  const record = loadProcess(e.svc.db, lookerId);
  assert.ok(record);
  const segment = loadSegment(e.svc.db, record);
  assert.deepEqual(segment.map((m) => m.role), ["user", "assistant", "toolResult"]);
  assert.ok(Number(used[1]) > 0, text);
  assert.equal(Number(used[1]), contextUsed(record, segment.slice(0, 2)));
  assert.equal(mine.self.context.used, contextUsed(record, segment));

  // 自己的阶段：self 在事务里执行，所以总是“等工具结果”。兄弟进程：另一个还在等模型。
  assert.match(text, /^阶段：等工具结果，本轮第 1 步，排队消息 0 条$/m);
  assert.deepEqual(siblings, [[busyId, "等模型回复，本轮第 1 步，排队消息 0 条"]]);
  assert.deepEqual(mine.siblings.map((s) => [s.id, s.phase]), [[busyId, { tag: "awaitingModel", purpose: "turn", steps: 1, queued: 0 }]]);
  assert.deepEqual(theirs.siblings.map((s) => s.id), [lookerId]);

  // self 的文字和 ps 的投影一致。
  const fromSelf = { id: who[1], preset: who[2], model: who[3], segment: Number(seg[1]), window: Number(used[2]), siblings: siblings.map((s) => s[0]) };
  const fromPs = { id: mine.self.id, preset: mine.self.preset, model: mine.self.model, segment: mine.self.segment, window: mine.self.context.window, siblings: mine.siblings.map((s) => s.id) };
  assert.deepEqual(fromSelf, fromPs);
  assert.deepEqual(fromSelf, { id: lookerId, preset: "dev", model: `${e.provider}/m`, segment: 1, window: WINDOW, siblings: [busyId] });

  // tau ps 的文字：同一个时区；这一行的预设、窗口和段号和 self 一致。
  assert.ok(table.header.startsWith("现在 ") && table.header.endsWith(`（${tz}）`), table.header);
  const row = table.rows.get(lookerId);
  assert.ok(row, [...table.rows.keys()].join(", "));
  assert.equal(row[1], who[2]);
  assert.equal(row[3]?.split("/")[1], `${(WINDOW / 1000).toFixed(1)}k`);
  assert.equal(row[4], `段${seg[1]}`);
  assert.equal(table.rows.get(busyId)?.[2], "等模型 第1步");

  lookerGate.open();
  busyGate.open();
  assert.deepEqual((await looker.done).at(-1), { type: "final", reply: "看过了。", ended: "done" });
  assert.deepEqual((await busy.done).at(-1), { type: "final", reply: "忙完了。", ended: "done" });
  assertQuiet(e.svc);
});

test("tau ps 的文字不随 v2 的投影变：有父进程、累计用量时，每一行和以前一样", { timeout: 10_000 }, async (t) => {
  const e = await setup(t, { dev: "read" });
  script(e.faux, () => fauxAssistantMessage("好。"));
  const cap = capture(t);
  assert.equal(await main(["start", "dev", "一"], e.pipe), 0);
  assert.equal(await main(["start", "dev", "二"], e.pipe), 0);
  const [parent = "", kid = ""] = startedIds(cap);
  const before = await cliPs(e.pipe, cap);
  assert.equal(before.rows.size, 2);
  for (const row of before.rows.values()) assert.equal(row.length, 6, row.join("|"));

  // 把第二个进程改成第一个的子进程，并给它累计用量。两个进程都空闲，没有别的写库的人。
  const k = loadProcess(e.svc.db, kid);
  assert.ok(k);
  saveProcess(e.svc.db, { ...k, parent, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } });
  const after = await cliPs(e.pipe, cap);
  assert.deepEqual([...after.rows].map(([id, cols]) => [id, ...cols.slice(1, 5)]), [...before.rows].map(([id, cols]) => [id, ...cols.slice(1, 5)]));
  for (const row of after.rows.values()) assert.equal(row.length, 6, row.join("|"));

  // 协议里的投影是 v2 的形状。
  const all = await projections(e.pipe);
  const mine = all.find((p) => p.self.id === parent);
  const theirs = all.find((p) => p.self.id === kid);
  assert.ok(mine && theirs);
  assert.deepEqual([mine.children, mine.idleChildren], [[], 1]);
  assert.equal(theirs.self.parent, parent);
  assert.deepEqual(theirs.self.usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(theirs.self.messages, segmentOf(e.svc, kid).length);
});

const FIRST_REPLY ="第一段回复：分成好几块流式发出，拼起来就是最终回复。";
const SECOND_REPLY = "第二段回复：CLI 把流式文本原样打印，只打印一次。";

test("流式文本到达连接：各块拼起来等于最终回复；CLI 只打印一次", { timeout: 10_000 }, async (t) => {
  // 每块 1 个 token（4 个字符），每秒 2000 个 token：每块之间隔一个计时器。
  const e = await setup(t, { dev: "read" }, { tokenSize: { min: 1, max: 1 }, tokensPerSecond: 2000 });
  e.faux.setResponses([fauxAssistantMessage(fauxText(FIRST_REPLY)), fauxAssistantMessage(fauxText(SECOND_REPLY))]);

  const replies = await collect(e.pipe, { op: "start", preset: "dev", text: "说点什么" });
  const [receipt, ...rest] = replies;
  const final = rest.pop();
  assert.equal(receipt?.type, "receipt");
  assert.deepEqual(final, { type: "final", reply: FIRST_REPLY, ended: "done" });
  const deltas = rest.map((r) => (r.type === "text" ? r.delta : assert.fail(`回执和最终回复之间不该有 ${JSON.stringify(r)}`)));
  assert.equal(deltas.length, Math.ceil(FIRST_REPLY.length / 4));
  assert.equal(deltas.join(""), final.reply);

  const cap = capture(t);
  assert.equal(await main(["send", receipt.process, "再说一遍"], e.pipe), 0);
  // 每块写一次，最后写一个换行；最终回复的正文没有再写一遍。
  assert.equal(cap.out.length, Math.ceil(SECOND_REPLY.length / 4) + 1);
  assert.equal(cap.out.join(""), `${SECOND_REPLY}\n`);
  assert.deepEqual(cap.err, []);
  assertQuiet(e.svc);
});

test("模型在启动之后从目录里消失：本轮以“模型目录里没有”结束，进程照常可用", { timeout: 10_000 }, async (t) => {
  const e = await setup(t, { dev: "read" });
  const first = gate(e);
  e.faux.setResponses([
    async () => {
      await first.pass();
      return fauxAssistantMessage("第一轮。");
    },
    fauxAssistantMessage("恢复了。"),
  ]);

  // 启动时模型在目录里。第一次调用进行中把 provider 删掉：这次调用已经拿到模型，照常完成。
  const start = call(e.pipe, { op: "start", preset: "dev", text: "第一条" });
  const id = await start.receipt;
  await first.reached;
  e.models.deleteProvider(e.provider);
  assert.equal(e.models.getModel(e.provider, "m"), undefined);
  first.open();
  assert.deepEqual((await start.done).at(-1), { type: "final", reply: "第一轮。", ended: "done" });

  // 下一轮调用模型时查不到：本轮出错，provider 一次都没被调用。
  const failed = await collect(e.pipe, { op: "send", process: id, text: "第二条" });
  assert.deepEqual(failed[0], { type: "receipt", process: id });
  const final = failed.at(-1);
  assert.equal(final?.type, "final");
  assert.equal(final.reply, "");
  assert.ok(typeof final.ended === "object" && final.ended !== null, JSON.stringify(final));
  assert.match(final.ended.error, /模型目录里没有/);
  assert.equal(e.faux.state.callCount, 1);
  assert.deepEqual(loadProcess(e.svc.db, id)?.phase, { tag: "idle", ended: final.ended });
  // 失败的回复不写进段。
  assert.deepEqual(segmentOf(e.svc, id).map((m) => m.role), ["user", "assistant", "user"]);
  assertQuiet(e.svc);
  const [p] = await projections(e.pipe);
  assert.deepEqual(p?.self.phase, { tag: "idle", ended: final.ended });

  // 进程没有卡住：模型回到目录后，下一条消息照常回复。
  e.models.setProvider(e.faux.provider);
  assert.deepEqual((await collect(e.pipe, { op: "send", process: id, text: "第三条" })).at(-1), { type: "final", reply: "恢复了。", ended: "done" });
  assert.equal(e.faux.state.callCount, 2);
  assert.deepEqual(segmentOf(e.svc, id).map((m) => m.role), ["user", "assistant", "user", "user", "assistant"]);
  assertQuiet(e.svc);
});
