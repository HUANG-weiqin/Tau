// backup 请求（D73）：真的服务、管道和库；模型是 pi-ai 的 faux。备份是同步的读请求：不是输入，不开写事务，不调 pump。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { request } from "../../src/cli/main.ts";
import type { Reply, Request } from "../../src/protocol.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { SCHEMA_VERSION, loadProcess, openDb, putMail } from "../../src/store/db.ts";
import { png } from "../images.ts";

interface Env {
  dir: string;
  pipe: string;
  faux: FauxProviderHandle;
  svc: Service;
}

async function setup(t: TestContext): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-backup-"));
  const work = join(dir, "work");
  const presetsDir = join(dir, "presets");
  const toolsDir = join(dir, "tools");
  for (const d of [work, presetsDir, toolsDir]) mkdirSync(d);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presetsDir, "p.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir, models, memory: sqliteMemory });
  t.after(async () => {
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, pipe, faux, svc };
}

/** 发一个请求，收齐回复直到连接关闭。`req` 可以是不合格的，所以收 unknown。 */
async function collect(e: Env, req: unknown): Promise<Reply[]> {
  const out: Reply[] = [];
  await request(e.pipe, req as Request, (r) => out.push(r));
  return out;
}

const errorOf = (r: Reply[]): string => {
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0]?.type, "error", JSON.stringify(r));
  return r[0]?.type === "error" ? r[0].message : "";
};

/** 每张表的全部行，按主键排序；库的内容。 */
const QUERIES = ["SELECT * FROM processes ORDER BY id", "SELECT * FROM segment_messages ORDER BY process_id, segment_seq, seq", "SELECT * FROM mailbox ORDER BY seq", "SELECT * FROM effects ORDER BY process_id", "SELECT * FROM memory ORDER BY version", "SELECT * FROM blobs ORDER BY hash"];
const dumpOf = (db: DatabaseSync): string => JSON.stringify(QUERIES.map((q) => db.prepare(q).all()));
const tablesOf = (db: DatabaseSync): string[] => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));
const versionOf = (db: DatabaseSync): unknown => db.prepare("PRAGMA user_version").get()?.user_version;

/** 一个有内容的库：一个带图片、跑完一轮的进程，一条记忆，一封没处理的信。 */
async function populate(e: Env): Promise<string> {
  e.faux.appendResponses([fauxAssistantMessage(fauxText("看到了。"))]);
  const replies = await collect(e, { op: "start", preset: "p", text: "看图", images: [png(16, 16, 1).toString("base64")] });
  assert.equal(replies.at(-1)?.type, "final");
  const id = replies[0]?.type === "receipt" ? replies[0].process : "";
  const w = await collect(e, { op: "memory_write", ops: [{ kind: "set", ns: "p", key: "k", value: "v", expected: null }] });
  assert.equal(w[0]?.type, "memory_written");
  // 信箱里留一封：备份不处理它（不调 pump），备份里也要有它。
  putMail(e.svc.db, id, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "留着" }], hops: 0 } });
  return id;
}

test("backup：回 backed_up，路径原样、字节数等于文件大小；备份能当库打开，版本、表和每张表的行都和库一致；连接关闭", async (t) => {
  const e = await setup(t);
  await populate(e);
  const live = dumpOf(e.svc.db);
  assert.ok(e.svc.db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n === 1 && e.svc.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n === 1, "库里该有的行都有");

  const path = join(e.dir, "b1.db");
  const replies = await collect(e, { op: "backup", path });
  assert.deepEqual(replies, [{ type: "backed_up", path, bytes: statSync(path).size }]);
  assert.ok(statSync(path).size > 0);

  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(versionOf(copy), SCHEMA_VERSION);
    assert.equal(versionOf(copy), versionOf(e.svc.db));
    assert.deepEqual(tablesOf(copy), tablesOf(e.svc.db));
    assert.deepEqual(tablesOf(copy), ["blobs", "effects", "mailbox", "memory", "processes", "segment_messages", "sqlite_sequence"]);
    assert.equal(dumpOf(copy), live);
  } finally {
    copy.close();
  }
  // 版本检查照常：openDb 认得它，不报表结构版本不一致。
  openDb(path).close();
});

test("backup：正斜杠的盘符路径也行；服务之后照常处理请求", async (t) => {
  const e = await setup(t);
  const id = await populate(e);
  const path = join(e.dir, "fwd.db").replace(/\\/g, "/");
  const replies = await collect(e, { op: "backup", path });
  assert.deepEqual(replies, [{ type: "backed_up", path, bytes: statSync(path).size }]);
  assert.equal((await collect(e, { op: "ps" }))[0]?.type, "ps");
  assert.equal(loadProcess(e.svc.db, id)?.id, id);
});

test("backup：目标已存在回 error（SQLite 的原文），已有的文件原样不动；目录不存在回 error，不建目录", async (t) => {
  const e = await setup(t);
  await populate(e);

  // 不是库的文件：SQLite 在“已存在”之前就认出它不是库，文字不同，都是拒绝，文件不动。
  const taken = join(e.dir, "taken.db");
  writeFileSync(taken, "别人的文件");
  assert.match(errorOf(await collect(e, { op: "backup", path: taken })), /already exists|not a database/);
  assert.equal(readFileSync(taken, "utf8"), "别人的文件");

  const once = join(e.dir, "once.db");
  assert.equal((await collect(e, { op: "backup", path: once }))[0]?.type, "backed_up");
  const bytes = readFileSync(once);
  assert.match(errorOf(await collect(e, { op: "backup", path: once })), /already exists/);
  assert.deepEqual(readFileSync(once), bytes);

  const missing = join(e.dir, "no-such-dir", "x.db");
  assert.match(errorOf(await collect(e, { op: "backup", path: missing })), /unable to open|cannot open|No such/i);
  assert.equal(existsSync(join(e.dir, "no-such-dir")), false);

  // 服务没被带坏：再备份一次到新路径照常成功。
  assert.equal((await collect(e, { op: "backup", path: join(e.dir, "after.db") }))[0]?.type, "backed_up");
});

test("backup：path 不合格回 error，库不变，没有备份文件出现", async (t) => {
  const e = await setup(t);
  await populate(e);
  const before = dumpOf(e.svc.db);
  const files = readdirSync(e.dir).sort();
  const bad: [string, unknown, RegExp][] = [
    ["空串", "", /1 到 1024/],
    [":memory:", ":memory:", /绝对路径/],
    ["file: 开头", "file:x.db", /绝对路径/],
    ["file: URI", "file:///C:/x.db", /绝对路径/],
    ["相对路径", "backup.db", /绝对路径/],
    ["上一级", "..\\x.db", /绝对路径/],
    ["没有盘符的根", "\\x.db", /绝对路径/],
    ["msys 路径", "/e/x.db", /绝对路径/],
    ["盘符相对", "C:x.db", /绝对路径/],
    ["空字符", "C:\\a\u0000b.db", /控制字符/],
    ["换行", "C:\\a\nb.db", /控制字符/],
    ["DEL", "C:\\a\u007fb.db", /控制字符/],
    ["超长", `C:\\${"x".repeat(1022)}.db`, /1 到 1024/],
    ["以空格结尾", "C:\\x.db ", /不能以空格或点结尾/],
    ["以点结尾", "C:\\x.db.", /不能以空格或点结尾/],
    ["以点结尾的目录", "C:\\dir\\.", /不能以空格或点结尾/],
    ["备用数据流", "C:\\x.db:s", /盘符之后不能再有冒号/],
    ["默认数据流", "C:\\x.db::$DATA", /盘符之后不能再有冒号/],
    ["目录名里的冒号", "C:\\d:x\\a.db", /盘符之后不能再有冒号/],
    ["UNC 里的冒号", "\\\\server\\share\\x.db:s", /盘符之后不能再有冒号/],
    ["设备路径", "\\\\?\\C:\\x.db", /盘符之后不能再有冒号/],
    ["不是字符串", 123, /无法识别的请求/],
    ["null", null, /无法识别的请求/],
    ["缺 path", undefined, /无法识别的请求/],
  ];
  for (const [what, path, why] of bad) assert.match(errorOf(await collect(e, { op: "backup", path })), why, what);
  assert.equal(dumpOf(e.svc.db), before);
  assert.deepEqual(readdirSync(e.dir).sort(), files);

  // 边界：1024 个字符的合格路径能通过校验（目录不存在，所以是 SQLite 的错，不是校验的错）。
  const edge = `C:\\${"x".repeat(1018)}.db`;
  assert.equal(edge.length, 1024);
  assert.doesNotMatch(errorOf(await collect(e, { op: "backup", path: edge })), /备份路径|无法识别/);
  // 路径中间的空格和点是正常的：能过校验，错在目录不存在。
  assert.doesNotMatch(errorOf(await collect(e, { op: "backup", path: "C:\\no such dir.x\\a b.c.db" })), /备份路径|无法识别/);
});

test("backup：是读请求。库的内容前后一致；不调用 pump，信箱里的信不被处理；多余的字段被忽略", async (t) => {
  const e = await setup(t);
  const id = await populate(e);
  const before = dumpOf(e.svc.db);
  const mail = () => e.svc.db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n;
  assert.equal(mail(), 1);

  const path = join(e.dir, "read-only.db");
  assert.equal((await collect(e, { op: "backup", path, extra: 1 }))[0]?.type, "backed_up");
  await sleep(150);
  assert.equal(mail(), 1, "信没有被处理");
  assert.equal(dumpOf(e.svc.db), before, "库没有任何变化");
  assert.equal(loadProcess(e.svc.db, id)?.phase.tag, "idle");
  assert.equal(e.svc.db.prepare("SELECT COUNT(*) AS n FROM effects").get()?.n, 0);
});

test("backup：进程在运行时也能备份，不用停服务；备份里是那一刻一致的状态", async (t) => {
  const e = await setup(t);
  const gate = Promise.withResolvers<void>();
  let started = false;
  e.faux.appendResponses([
    async () => {
      started = true;
      await gate.promise;
      return fauxAssistantMessage(fauxText("慢回复"));
    },
  ]);
  // 连接留着不读：t.after 里关服务时会断开它。
  void collect(e, { op: "start", preset: "p", text: "慢" });
  for (const end = Date.now() + 5_000; !started; await sleep(10)) assert.ok(Date.now() < end, "模型调用没有开始");

  const path = join(e.dir, "running.db");
  assert.equal((await collect(e, { op: "backup", path }))[0]?.type, "backed_up");
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const procs = copy.prepare("SELECT state_json FROM processes").all().map((r) => JSON.parse(String(r.state_json)));
    assert.equal(procs.length, 1);
    assert.equal(procs[0].phase.tag, "awaitingModel");
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM effects").get()?.n, 1, "在等的副作用也在备份里");
  } finally {
    copy.close();
  }
  gate.resolve();
  for (const end = Date.now() + 5_000; e.svc.db.prepare("SELECT 1 FROM effects").get(); await sleep(10)) assert.ok(Date.now() < end, "动作没有收尾");
});
