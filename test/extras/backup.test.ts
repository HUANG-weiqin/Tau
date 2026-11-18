// extras/backup.ts（D73）：脚本在真的服务上跑。服务和测试在同一个进程里，所以脚本必须用异步的子进程，不能 spawnSync。
// 数据目录靠 USERPROFILE 指到临时目录，不碰真的 ~/.tau。要固定时间的用 test/extras/fake-now.ts 预加载。
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { backupName, prune } from "../../extras/backup.ts";
import { talk } from "../../extras/tools/client.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { SCHEMA_VERSION } from "../../src/store/db.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "extras", "backup.ts");
const FAKE_NOW = join(import.meta.dirname, "fake-now.ts");
let dir = "";
let home = "";
let pipe = "";
let svc: Service;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tau-bk-"));
  home = join(dir, "home");
  const work = join(dir, "work");
  const presetsDir = join(home, ".tau", "presets");
  const toolsDir = join(home, ".tau", "tools");
  for (const d of [presetsDir, toolsDir, work]) mkdirSync(d, { recursive: true });
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  faux.setResponses([fauxAssistantMessage(fauxText("好的。"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presetsDir, "t.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read\n---\n提示词。\n`);
  pipe = `\\\\.\\pipe\\tau-test-backup-script-${process.pid}-${Math.random().toString(16).slice(2)}`;
  svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir, models, memory: sqliteMemory });
  // 库里放点东西：一个跑完一轮的进程，一条记忆。
  let final = false;
  await talk(pipe, { op: "start", preset: "t", text: "你好" }, (r) => (final = r.type === "final"));
  assert.ok(final, "进程没有跑完");
  await talk(pipe, { op: "memory_write", ops: [{ kind: "set", ns: "t", key: "k", value: "v", expected: null }] }, (r) => r.type === "memory_written");
});

after(async () => {
  await svc.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** 异步跑脚本。`now` 是本地时间，形如 2031-05-06T07:08:09，让脚本以为现在是这个时刻。 */
function run(args: string[], opts: { now?: string; pipe?: string; cwd?: string } = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, TAU_PIPE: opts.pipe ?? pipe };
  delete env.TAU_TEST_NOW;
  if (opts.now !== undefined) env.TAU_TEST_NOW = opts.now;
  const argv = [...(opts.now === undefined ? [] : ["--import", pathToFileURL(FAKE_NOW).href]), SCRIPT, ...args];
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { env, cwd: opts.cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : (err as { code?: unknown }).code;
      assert.equal(typeof code === "number" || code === 0, true, `脚本没能运行：${String(err)}`);
      resolve({ code: code as number, stdout, stderr });
    });
  });
}

/** 一个没有的目录。 */
const fresh = (name: string): string => join(dir, name);
const names = (d: string): string[] => readdirSync(d).sort();

test("backupName：本地时间，按位补零；按名字排序就是按时间排序", () => {
  assert.equal(backupName(new Date(2031, 4, 6, 7, 8, 9)), "tau-20310506-070809.db");
  assert.equal(backupName(new Date(2031, 11, 31, 23, 59, 59)), "tau-20311231-235959.db");
  assert.equal(backupName(new Date(999, 0, 2, 3, 4, 5)), "tau-09990102-030405.db");
  const a = backupName(new Date(2031, 0, 1, 9, 59, 59));
  const b = backupName(new Date(2031, 0, 1, 10, 0, 0));
  assert.ok(a < b);
});

/** 建一个目录，放几个空文件。 */
function withFiles(name: string, files: string[]): string {
  const d = fresh(name);
  mkdirSync(d);
  for (const f of files) writeFileSync(join(d, f), "x");
  return d;
}

test("prune：刚做的那个永远不删，占一个名额；名字比它更靠后的旧备份挤掉的是别人", () => {
  // 复现：目录里已有 14 个名字更靠后的，刚做的名字排在最前。以前它会被当成最旧的删掉。
  const future = Array.from({ length: 14 }, (_, i) => `tau-20400101-0000${String(i + 1).padStart(2, "0")}.db`);
  const made = "tau-20261118-120000.db";
  const a = withFiles("prune-repro", [...future, made]);
  assert.deepEqual(prune(a, 14, made), ["tau-20400101-000001.db"]);
  assert.deepEqual(names(a), [made, ...future.slice(1)]);

  // 保留数仍按 keep 算：刚做的一个，加其余里最新的 keep-1 个。
  const b = withFiles("prune-keep3", [made, "tau-20300101-000001.db", "tau-20300101-000002.db", "tau-20300101-000003.db", "tau-20300101-000004.db"]);
  assert.deepEqual(prune(b, 3, made), ["tau-20300101-000002.db", "tau-20300101-000001.db"]);
  assert.deepEqual(names(b), [made, "tau-20300101-000003.db", "tau-20300101-000004.db"]);
});

test("prune：keep 为 1 只留刚做的，不管它的名字排在哪；目录里只有它自己、或没超出，什么都不删", () => {
  const made = "tau-20261118-120000.db";
  const a = withFiles("prune-one", [made, "tau-20400101-000001.db", "tau-20200101-000001.db"]);
  assert.deepEqual(prune(a, 1, made).sort(), ["tau-20200101-000001.db", "tau-20400101-000001.db"]);
  assert.deepEqual(names(a), [made]);

  const alone = withFiles("prune-alone", [made]);
  assert.deepEqual(prune(alone, 1, made), []);
  assert.deepEqual(prune(alone, 14, made), []);
  assert.deepEqual(names(alone), [made]);

  const few = withFiles("prune-few", [made, "tau-20261118-115959.db"]);
  assert.deepEqual(prune(few, 2, made), []);
  assert.deepEqual(names(few), ["tau-20261118-115959.db", made]);
});

test("prune：同一秒前后的备份（时钟回拨）按名字排，刚做的照样不删；不是备份的名字和目录不碰", () => {
  const made = "tau-20261118-120000.db";
  const d = withFiles("prune-sec", [made, "tau-20261118-115959.db", "tau-20261118-120001.db", "notes.txt", "tau-20261118-120000.db.bak"]);
  mkdirSync(join(d, "tau-20200101-000000.db"));
  assert.deepEqual(prune(d, 2, made), ["tau-20261118-115959.db"]);
  assert.deepEqual(names(d), ["notes.txt", made, "tau-20200101-000000.db", "tau-20261118-120000.db.bak", "tau-20261118-120001.db"].sort());
  assert.deepEqual(prune(d, 1, made), ["tau-20261118-120001.db"]);
  assert.equal(existsSync(join(d, "tau-20200101-000000.db")), true, "同名的目录不碰");
  assert.equal(existsSync(join(d, "notes.txt")), true);
});

test("默认目录 ~/.tau/extras/backup（不存在就建）：文件名是本地时间；打印路径和大小；备份能打开，版本、表和行数和库一致", async () => {
  const bk = join(home, ".tau", "extras", "backup");
  assert.equal(existsSync(bk), false);
  const before = Date.now();
  const r = await run([]);
  const after = Date.now();
  assert.deepEqual([r.code, r.stderr], [0, ""], r.stdout);
  const files = names(bk);
  assert.equal(files.length, 1);
  const file = files[0]!;
  const m = /^tau-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(file);
  assert.ok(m, file);
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  assert.ok(at >= before - 1000 && at <= after + 1000, `文件名里的时间 ${file} 不在 ${before} 到 ${after} 之间（本地时间）`);

  const path = join(bk, file);
  assert.equal(r.stdout, `已备份：${path}（${statSync(path).size} 字节）\n`);
  const copy = new DatabaseSync(path, { readOnly: true });
  const live = svc.db;
  try {
    assert.equal(copy.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((x) => String(x.name));
    assert.deepEqual(tables(copy), tables(live));
    for (const t of tables(live)) {
      assert.deepEqual(copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), live.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t);
    }
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n, 1);
    assert.equal(copy.prepare("SELECT value FROM memory WHERE ns = 't' AND key = 'k'").get()?.value, "v");
    assert.ok(Number(copy.prepare("SELECT COUNT(*) AS n FROM segment_messages").get()?.n) >= 2);
  } finally {
    copy.close();
  }
});

test("--dir：嵌套的目录不存在就建；相对路径按当前目录算成绝对路径再发给服务", async () => {
  const nested = fresh("deep/er/backups");
  const a = await run(["--dir", nested], { now: "2031-05-06T07:08:09" });
  assert.deepEqual([a.code, a.stderr], [0, ""]);
  assert.deepEqual(names(nested), ["tau-20310506-070809.db"]);
  assert.ok(a.stdout.startsWith(`已备份：${join(nested, "tau-20310506-070809.db")}（`), a.stdout);

  const cwd = fresh("cwd");
  mkdirSync(cwd);
  const b = await run(["--dir", "rel-backups"], { now: "2031-05-06T07:08:10", cwd });
  assert.deepEqual([b.code, b.stderr], [0, ""]);
  assert.deepEqual(names(join(cwd, "rel-backups")), ["tau-20310506-070810.db"]);
});

test("--keep：只留最近几个，更旧的删掉；只认 tau-<时间>.db 这种名字的文件，别的和同名的目录都不碰", async () => {
  const bk = fresh("keep");
  mkdirSync(bk);
  // 不该碰的：名字不对的文件，和一个名字像备份的目录。
  const others = ["notes.txt", "other.db", "tau-20300101-000001.db.bak", "tau-2030-01-01.db", "tau-20300101-000001x.db", "xtau-20300101-000001.db"];
  for (const o of others) writeFileSync(join(bk, o), "别人的文件");
  mkdirSync(join(bk, "tau-20290101-000000.db"));
  writeFileSync(join(bk, "tau-20290101-000000.db", "inside.txt"), "x");

  const out: Run[] = [];
  for (let s = 1; s <= 5; s++) out.push(await run(["--dir", bk, "--keep", "3"], { now: `2031-01-01T10:00:0${s}` }));
  for (const r of out) assert.deepEqual([r.code, r.stderr], [0, ""], r.stdout);
  // 前三次一共才 1、2、3 个，没删；后两次各删最旧的一个。
  assert.deepEqual(out.map((r) => r.stdout.includes("已删除更旧的备份 1 个，保留最近 3 个。")), [false, false, false, true, true]);
  assert.deepEqual(names(bk).filter((n) => /^tau-\d{8}-\d{6}\.db$/.test(n) && statSync(join(bk, n)).isFile()), ["tau-20310101-100003.db", "tau-20310101-100004.db", "tau-20310101-100005.db"]);
  for (const o of others) assert.equal(existsSync(join(bk, o)), true, o);
  assert.deepEqual(readdirSync(join(bk, "tau-20290101-000000.db")), ["inside.txt"]);
  // 留下的是真的备份，能打开。
  const copy = new DatabaseSync(join(bk, "tau-20310101-100005.db"), { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n, 1);
  } finally {
    copy.close();
  }
});

test("--keep 默认 14", async () => {
  const bk = fresh("keep-default");
  mkdirSync(bk);
  const old = Array.from({ length: 20 }, (_, i) => `tau-20300101-0000${String(i + 1).padStart(2, "0")}.db`);
  for (const o of old) writeFileSync(join(bk, o), "旧备份");
  const r = await run(["--dir", bk], { now: "2031-01-01T10:00:00" });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.match(r.stdout, /已删除更旧的备份 7 个，保留最近 14 个。/);
  assert.deepEqual(names(bk), [...old.slice(7), "tau-20310101-100000.db"]);
});

test("--keep：目录里已有名字更靠后的备份（时钟回拨）时，刚做的这份不会被当成最旧的删掉", async () => {
  const bk = fresh("keep-future");
  mkdirSync(bk);
  const future = Array.from({ length: 14 }, (_, i) => `tau-20400101-0000${String(i + 1).padStart(2, "0")}.db`);
  for (const f of future) writeFileSync(join(bk, f), "名字更靠后的备份");
  const r = await run(["--dir", bk], { now: "2031-01-01T10:00:00" });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.match(r.stdout, /已删除更旧的备份 1 个，保留最近 14 个。/);
  assert.deepEqual(names(bk), ["tau-20310101-100000.db", ...future.slice(1)]);
  const copy = new DatabaseSync(join(bk, "tau-20310101-100000.db"), { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n, 1, "刚做的是真的备份");
  } finally {
    copy.close();
  }

  const one = fresh("keep-future-1");
  mkdirSync(one);
  writeFileSync(join(one, "tau-20400101-000001.db"), "名字更靠后的备份");
  const r1 = await run(["--dir", one, "--keep", "1"], { now: "2031-01-01T10:00:00" });
  assert.deepEqual([r1.code, r1.stderr], [0, ""]);
  assert.deepEqual(names(one), ["tau-20310101-100000.db"]);
});

test("退出码 1：服务回 error（目标已存在），原文写到标准错误；已有的文件不动，也不清理旧备份", async () => {
  const bk = fresh("exists");
  const first = await run(["--dir", bk], { now: "2031-02-03T04:05:06" });
  assert.equal(first.code, 0, first.stderr);
  const file = join(bk, "tau-20310203-040506.db");
  const size = statSync(file).size;
  writeFileSync(join(bk, "tau-20000101-000000.db"), "旧备份");

  const again = await run(["--dir", bk, "--keep", "1"], { now: "2031-02-03T04:05:06" });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /服务拒绝备份：.*already exists/);
  assert.equal(again.stdout, "");
  assert.equal(statSync(file).size, size);
  assert.deepEqual(names(bk), ["tau-20000101-000000.db", "tau-20310203-040506.db"], "失败时不清理旧备份");
});

test("退出码 2：连不上服务，没有发出请求", async () => {
  const bk = fresh("no-service");
  const r = await run(["--dir", bk], { pipe: `\\\\.\\pipe\\tau-test-nobody-${process.pid}-${Math.random().toString(16).slice(2)}` });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /连不上/);
  assert.match(r.stderr, /tau serve/);
  assert.equal(r.stdout, "");
  assert.deepEqual(existsSync(bk) ? readdirSync(bk) : [], [], "没有备份文件");
});

test("退出码 2：用法错误，什么都不做（目录不建，也不连服务）", async () => {
  const bk = fresh("usage");
  const bad: string[][] = [["--keep", "0"], ["--keep", "abc"], ["--keep", "-1"], ["--keep", "1.5"], ["--keep", "1000000"], ["--keep"], ["--dir"], ["--bogus"], ["extra"], ["--dir", ""]];
  for (const args of bad) {
    const r = await run(args.includes("--dir") ? args : ["--dir", bk, ...args]);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /用法：node backup\.ts/, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
  }
  assert.equal(existsSync(bk), false);
});

test("退出码 3：服务收下请求就断开、或回的不是 JSON：不知道结果，提示目标文件可能已经有了", async () => {
  const bk = fresh("midway");
  for (const behave of ["hangup", "garbage"] as const) {
    const fake = `\\\\.\\pipe\\tau-test-fake-${behave}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const server = createServer((s) => {
      s.on("error", () => {});
      s.once("data", () => (behave === "hangup" ? s.destroy() : s.write("这不是 JSON\n")));
    });
    await new Promise<void>((resolve) => server.listen(fake, resolve));
    try {
      const r = await run(["--dir", bk], { now: "2031-03-04T05:06:07", pipe: fake });
      assert.equal(r.code, 3, `${behave}：${r.stderr}`);
      assert.match(r.stderr, /不知道备份有没有做成/);
      assert.ok(r.stderr.includes(join(bk, "tau-20310304-050607.db")), r.stderr);
      assert.equal(r.stdout, "");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
