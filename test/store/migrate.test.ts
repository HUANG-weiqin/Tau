// 5 升 6 的迁移（D81）：memory 表加 brief、updated 两列，旧行填摘要和迁移时刻。用真文件库。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { briefOf } from "../../src/kernel/derive.ts";
import { migrate5to6, openDb, SCHEMA_VERSION } from "../../src/store/db.ts";
import { tempDir } from "./fixtures.ts";

/** 5 版的 memory 表：没有 brief、updated。另建一张别的表：迁移不许动它。 */
const SCHEMA_V5 = `
CREATE TABLE memory (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (ns, key)
) STRICT;
CREATE TABLE other (
  x TEXT NOT NULL
) STRICT;
`;

/** 迁移要处理的三种行：300 字节以上的中文长值、含 U+0000 的值、空串。 */
const VALUES = ["汉".repeat(150), "前\u0000后", ""];

/** 造一个 5 版的库，写上三行记忆和别的表的一行。 */
function v5Db(t: TestContext): { path: string; versions: number[] } {
  const path = join(tempDir(t), "tau.db");
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V5);
  const insert = db.prepare("INSERT INTO memory (ns, key, value) VALUES (?, ?, ?) RETURNING version");
  const versions = VALUES.map((value, i) => insert.get("m", `k${i}`, value)?.version as number);
  db.prepare("INSERT INTO other (x) VALUES (?)").run("不动");
  db.exec("PRAGMA user_version = 5");
  db.close();
  return { path, versions };
}

/** node:sqlite 读 TEXT 时在 U+0000 处截断，所以按字节读出再解码。 */
const text = (v: unknown): string => Buffer.from(v as Uint8Array).toString("utf8");

const memoryRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT version, ns, key, value, brief, updated FROM memory ORDER BY version")
    .all()
    .map((r) => ({ version: r.version as number, ns: text(r.ns), key: text(r.key), value: text(r.value), brief: text(r.brief), updated: r.updated as number }));

test("migrate5to6：加两列、给旧行填摘要和 updated，行数、键、值、版本号和别的表都不变", (t) => {
  const { path, versions } = v5Db(t);
  const db = new DatabaseSync(path);
  migrate5to6(db, 12345);

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.deepEqual(db.prepare("PRAGMA table_info(memory)").all().map((c) => c.name), ["version", "ns", "key", "value", "brief", "updated"]);
  const rows = memoryRows(db);
  assert.equal(rows.length, 3);
  rows.forEach((r, i) => {
    assert.deepEqual({ version: r.version, ns: r.ns, key: r.key, value: r.value }, { version: versions[i], ns: "m", key: `k${i}`, value: VALUES[i] });
    assert.equal(r.brief, briefOf(VALUES[i]!), "摘要是值的前 200 字节");
    assert.equal(r.updated, 12345, "更新时间是迁移那一刻");
  });
  assert.equal(rows[0]?.brief, "汉".repeat(66), "300 字节以上的中文值截到 198 字节");
  assert.deepEqual(db.prepare("SELECT x FROM other").all().map((r) => r.x), ["不动"]);
  db.close();
});

test("openDb 走完整路径：5 版的库升到 6，updated 落在调用前后的两个 Date.now() 之间", (t) => {
  const { path } = v5Db(t);
  const before = Date.now();
  const db = openDb(path);
  const after = Date.now();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
  for (const r of memoryRows(db)) {
    assert.ok(r.updated >= before && r.updated <= after, `updated ${r.updated} 不在 ${before} 和 ${after} 之间`);
    assert.equal(r.brief, briefOf(r.value));
  }
  db.close();
  const again = openDb(path);
  assert.equal(again.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION, "再打开一次不用迁移");
  again.close();
});

test("崩溃安全：第二条 ALTER 失败时整条迁移回滚，版本号仍是 5，memory 表没有 brief 列", (t) => {
  const { path } = v5Db(t);
  const db = new DatabaseSync(path);
  // 模拟上次在第一步之后崩掉：updated 已经有了，brief 还没有。
  db.exec("ALTER TABLE memory ADD COLUMN updated INTEGER NOT NULL DEFAULT 0");
  assert.throws(() => migrate5to6(db, 1), /duplicate column name/);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 5);
  assert.deepEqual(db.prepare("PRAGMA table_info(memory)").all().map((c) => c.name), ["version", "ns", "key", "value", "updated"], "第一条 ALTER 也回滚了");
  assert.equal(db.isTransaction, false);
  db.close();
});
