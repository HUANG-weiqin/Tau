// 表结构、PRAGMA、表结构版本和事务。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, SCHEMA_VERSION, tx } from "../../src/store/db.ts";
import { tempDb, tempDir } from "./fixtures.ts";

test("新库：6 张表、WAL、synchronous=FULL、记下表结构版本", (t) => {
  const db = tempDb(t);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["blobs", "effects", "mailbox", "memory", "processes", "segment_messages"]);
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(db.prepare("PRAGMA table_info(blobs)").all().map((c) => [c.name, c.type]), [["hash", "TEXT"], ["data", "BLOB"]]);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
});

test("重新打开已有的库", (t) => {
  const path = join(tempDir(t), "tau.db");
  openDb(path).close();
  const db = openDb(path);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
  db.close();
});

test("表结构版本不一致就拒绝启动，提示重建库", (t) => {
  const path = join(tempDir(t), "tau.db");
  openDb(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => openDb(path), new RegExp(`表结构版本是 ${SCHEMA_VERSION + 1}.*重建`));
});

test("effects：每个进程最多一行，状态只能是 pending 或 running", (t) => {
  const db = tempDb(t);
  const insert = db.prepare("INSERT INTO effects (process_id, n, status) VALUES (?, ?, ?)");
  insert.run("p", 1, "pending");
  assert.throws(() => insert.run("p", 2, "pending"), /UNIQUE/);
  assert.throws(() => insert.run("q", 1, "done"), /CHECK/);
});

test("memory：版本号不复用被删掉的最大编号；(ns, key) 唯一", (t) => {
  const db = tempDb(t);
  const insert = db.prepare("INSERT INTO memory (ns, key, value) VALUES (?, ?, ?) RETURNING version");
  insert.get("a", "x", "1");
  const top = insert.get("a", "y", "2")?.version;
  db.prepare("DELETE FROM memory WHERE version = ?").run(top as number);
  assert.equal(insert.get("a", "y", "3")?.version, (top as number) + 1);
  assert.throws(() => insert.get("a", "x", "4"), /UNIQUE/);
  assert.equal(insert.get("b", "x", "5")?.version, (top as number) + 2);
});

test("mailbox：序号不复用", (t) => {
  const db = tempDb(t);
  const insert = db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES ('p', '{}') RETURNING seq");
  insert.get();
  const top = insert.get()?.seq as number;
  db.prepare("DELETE FROM mailbox WHERE seq = ?").run(top);
  assert.equal(insert.get()?.seq, top + 1);
});

test("事务抛出时回滚", (t) => {
  const db = tempDb(t);
  assert.throws(() =>
    tx(db, () => {
      db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES ('p', '{}')").run();
      throw new Error("boom");
    }),
  /boom/);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT count(*) AS c FROM mailbox").get()?.c, 0);
});
