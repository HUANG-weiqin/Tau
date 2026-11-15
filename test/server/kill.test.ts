// 第 5 步验收：服务运行中被随机硬杀几次（taskkill /T /F，不跑任何退出处理）。
// 每次杀掉之后、重启之前，测试自己打开库，做启动恢复（createExecutor，不开始任何动作）：没有 running 行，不变量成立。
// 最后让一切静止：每个进程 idle，拿到回执的用户消息在全部工作段里恰好出现一次，信箱和副作用表为空。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { request } from "../../src/cli/main.ts";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Actions } from "../../src/executor/executor.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { loadProcess, loadProcesses, loadSegment, openDb } from "../../src/store/db.ts";
import { allMessages, effectRows, mailbox, rng } from "../store/fixtures.ts";
import { assertStoreInvariants } from "../store/invariants.ts";

const SEED = 20261115;
const KILLS = 5;
const PROCESSES = 3;
const CHILD = join(import.meta.dirname, "child.ts");

interface Child {
  proc: ChildProcess;
  stderr: string[];
  exit: Promise<void>;
}

interface Proc {
  id: string;
  name: string;
  next: number;
  random: () => number;
}

/** 父进程发出的一条用户消息。`receipt`：服务回了回执，也就是它已经写进库。 */
interface Sent {
  process: string;
  text: string;
  receipt: boolean;
}

/** 恢复检查只做恢复：执行器一旦开始动作就是错的。 */
const refuse: Actions = {
  callModel() {
    throw new Error("恢复检查不应开始模型调用");
  },
  runTool() {
    throw new Error("恢复检查不应开始工具");
  },
};

function launch(args: string[]): Child {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CHILD, ...args], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const stderr: string[] = [];
  proc.stderr?.setEncoding("utf8").on("data", (d: string) => stderr.push(d));
  return { proc, stderr, exit: new Promise((resolve) => proc.once("exit", () => resolve())) };
}

function alive(c: Child): boolean {
  return c.proc.exitCode === null && c.proc.signalCode === null;
}

/** 硬杀：taskkill /T /F 直接结束整棵进程树，子进程里什么代码都不会再跑。等它真的退出。 */
async function hardKill(c: Child): Promise<void> {
  assert.ok(alive(c), `服务自己退出了：\n${c.stderr.join("")}`);
  await new Promise((resolve) => spawn("taskkill", ["/PID", String(c.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("close", resolve));
  await c.exit;
}

/** 发一条请求，收下全部回复，直到服务关闭连接（最终回复之后，或者服务被杀）。连不上时返回 null。 */
async function exchange(pipe: string, req: Request, onReceipt?: (id: string) => void): Promise<Reply[] | null> {
  const out: Reply[] = [];
  try {
    await request(pipe, req, (r) => {
      out.push(r);
      if (r.type === "receipt") onReceipt?.(r.process);
    });
  } catch {
    return null;
  }
  const error = out.find((r) => r.type === "error");
  if (error) throw new Error(`服务拒绝了 ${JSON.stringify(req)}：${JSON.stringify(error)}`);
  return out;
}

/** 等管道接受连接，并且服务能回答 ps。serve() 在回答任何请求之前已经做完启动恢复。 */
async function ready(c: Child, pipe: string): Promise<void> {
  for (const end = Date.now() + 10_000; ; await sleep(20)) {
    assert.ok(alive(c), `服务启动时退出了：\n${c.stderr.join("")}`);
    if ((await exchange(pipe, { op: "ps" }))?.[0]?.type === "ps") return;
    assert.ok(Date.now() < end, "服务 10 秒内没有开始回答请求");
  }
}

/** 服务已死：测试自己打开库，看崩溃点，再做启动恢复，检查恢复之后、执行器开始之前的状态。返回崩溃时在运行的副作用。 */
function checkRecovery(dbPath: string): { running: string[]; pending: number; mail: number } {
  const db = openDb(dbPath);
  try {
    assertStoreInvariants(db);
    const rows = effectRows(db);
    const running = rows
      .filter((r) => r.status === "running")
      .map((r) => {
        const p = loadProcess(db, r.id);
        const e = p && effectOf(p, loadSegment(db, p));
        return e?.kind === "runTool" ? e.call.name : "model";
      });
    createExecutor(db, refuse);
    const after = effectRows(db);
    assert.deepEqual(after.filter((r) => r.status === "running"), [], "恢复之后还有 running 行");
    assert.equal(after.length, rows.length - running.length, "恢复只删 running 行，pending 行不动");
    assertStoreInvariants(db);
    return { running, pending: after.length, mail: mailbox(db).length };
  } finally {
    db.close();
  }
}

test("服务运行中被随机硬杀 5 次：每次恢复后没有 running 行、不变量成立；最后全部静止，有回执的消息恰好出现一次", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-kill-"));
  const work = join(dir, "work");
  const presets = join(dir, "presets");
  mkdirSync(work);
  mkdirSync(presets);
  writeFileSync(join(work, "a.txt"), "hello\n");
  writeFileSync(join(presets, "k.md"), `---\nworkdir: ${work}\nmodel: faux/m\ntools: read, bash\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-kill-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const dbPath = join(dir, "tau.db");
  const kids: Child[] = [];
  t.after(() => {
    // 断言失败时也不留下服务：还活着的子进程连同它的进程树一起结束。
    for (const c of kids) if (alive(c)) spawnSync("taskkill", ["/PID", String(c.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    // 硬杀那一刻正在 fork 或 exec 的 msys 进程会卡住约 5 秒，期间 work 删不掉，靠重试等它。
    // rmSync 在 Windows 上对这种占用重试，要 Node 24.21 起（kb-tools 的坑点）。
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const boot = async (): Promise<Child> => {
    const c = launch([pipe, dbPath, presets]);
    kids.push(c);
    await ready(c, pipe);
    return c;
  };

  const random = rng(SEED);
  const sent: Sent[] = [];
  const procs: Proc[] = [];
  const say = (p: Proc): Promise<Reply[] | null> => {
    const s: Sent = { process: p.id, text: `${p.name}-${p.next++}`, receipt: false };
    sent.push(s);
    return exchange(pipe, { op: "send", process: p.id, text: s.text }, () => (s.receipt = true));
  };
  /** 一直给进程发消息，每条等到最终回复或连接断开。有时在本轮运行中再发一条（排队到本轮结束），有时停止它。 */
  const drive = async (p: Proc, live: { up: boolean }, extra: Promise<unknown>[]): Promise<void> => {
    while (live.up) {
      const r = p.random();
      if (r < 0.25) extra.push(sleep(p.random() * 400).then(() => (live.up ? say(p) : null)));
      else if (r < 0.35) extra.push(sleep(p.random() * 800).then(() => (live.up ? exchange(pipe, { op: "stop", process: p.id }) : null)));
      if ((await say(p)) === null) return;
    }
  };

  const started = Date.now();
  let child = await boot();
  // 启动 3 个进程；拿到回执（进程 ID）之后才开始计时，所以每个 start 都有回执。
  let extra: Promise<unknown>[] = [];
  for (let i = 0; i < PROCESSES; i++) {
    const s: Sent = { process: "", text: `p${i}-0`, receipt: false };
    sent.push(s);
    const got = Promise.withResolvers<void>();
    const done = exchange(pipe, { op: "start", preset: "k", text: s.text }, (id) => {
      s.process = id;
      s.receipt = true;
      got.resolve();
    });
    extra.push(done.finally(() => got.resolve()));
    await got.promise;
    assert.ok(s.receipt, `start ${s.text} 没有回执`);
    procs.push({ id: s.process, name: `p${i}`, next: 1, random: rng(SEED + i + 1) });
  }

  const kills: { delay: number; running: string[]; pending: number; mail: number }[] = [];
  for (let k = 0; k < KILLS; k++) {
    const live = { up: true };
    const drivers = procs.map((p) => drive(p, live, extra));
    // 多数落在运行中；五分之一紧跟在重启之后，那时恢复刚做完，副作用刚开始。
    const delay = Math.round(random() < 0.2 ? random() * 50 : 100 + random() * 1400);
    await sleep(delay);
    live.up = false;
    await hardKill(child);
    await Promise.all(drivers);
    await Promise.all(extra);
    extra = [];
    kills.push({ delay, ...checkRecovery(dbPath) });
    child = await boot();
  }
  for (const [i, k] of kills.entries()) {
    t.diagnostic(`第 ${i + 1} 次：服务就绪 ${k.delay} 毫秒后发出 taskkill；崩溃点 running [${k.running.join(", ")}]，恢复后 pending ${k.pending} 行、信箱 ${k.mail} 条`);
  }
  assert.ok(kills.some((k) => k.running.length > 0), "没有一次杀在副作用运行中，这个测试什么也没证明");

  // 最后一次重启之后不再杀：每个进程再发一条消息，等它的最终回复。
  const finals = await Promise.all(procs.map((p) => say(p)));
  for (const f of finals) {
    const last = f?.at(-1);
    assert.ok(last?.type === "final" && last.ended === "done", `最后一条消息没有正常结束：${JSON.stringify(f)}`);
  }
  const ps = (await exchange(pipe, { op: "ps" }))?.[0];
  assert.ok(ps?.type === "ps");
  assert.deepEqual(ps.processes.map((v) => v.self.phase.tag), procs.map(() => "idle"));
  await hardKill(child);

  const db = openDb(dbPath);
  try {
    assert.deepEqual(effectRows(db), []);
    assert.deepEqual(mailbox(db), []);
    const all = loadProcesses(db);
    assert.deepEqual(all.map((p) => p.id).sort(), procs.map((p) => p.id).sort());
    for (const p of all) assert.equal(p.phase.tag, "idle");
    assertStoreInvariants(db);

    // 每条用户消息拆成发出时的原文：排队的几条在本轮结束时用空行连成一条。
    // 上一轮没有正常结束时，decide 在下一条消息前面加一段说明（kb-kernel 的常量）。它不是原文，先去掉。
    const NOTE = /^（(用户停止了上一轮|上一轮的步数用完了|上一轮出错，没有做完：)/;
    const seen = new Map<string, string[]>();
    let merged = 0;
    for (const p of all) {
      for (const m of allMessages(db, p.id)) {
        if (m.role !== "user") continue;
        assert.equal(typeof m.content, "string");
        const texts = String(m.content).split("\n\n");
        if (NOTE.test(texts[0]!)) texts.shift();
        if (texts.length > 1) merged++;
        for (const text of texts) seen.set(text, [...(seen.get(text) ?? []), p.id]);
      }
    }
    const byText = new Map(sent.map((s) => [s.text, s]));
    for (const [text, where] of seen) {
      const s = byText.get(text);
      assert.ok(s, `工作段里有一条没发过的用户消息：${text}`);
      assert.deepEqual(where, [s.process], `${text} 应该在进程 ${s.process} 里恰好出现一次`);
    }
    const receipted = sent.filter((s) => s.receipt);
    assert.deepEqual(receipted.filter((s) => !seen.has(s.text)), [], "拿到回执的消息丢了");
    t.diagnostic(`发出 ${sent.length} 条消息，${receipted.length} 条有回执，工作段里 ${merged} 条用户消息是排队后合并的；总耗时 ${Date.now() - started} 毫秒`);
  } finally {
    db.close();
  }
});
