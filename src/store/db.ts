// SQLite：表、事务和行的读写（见 .knowledge/kb-store.md）。只用 node:sqlite 最基本的同步 API。
import { DatabaseSync } from "node:sqlite";
import type { Input, Message, Process, ProcessId } from "../kernel/types.ts";

/** 表结构的版本，记在 `PRAGMA user_version` 里。MVP 不做迁移。 */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
) STRICT;
CREATE TABLE segment_messages (
  process_id TEXT NOT NULL,
  segment_seq INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (process_id, segment_seq, seq)
) STRICT;
CREATE TABLE mailbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id TEXT NOT NULL,
  input_json TEXT NOT NULL
) STRICT;
CREATE TABLE effects (
  process_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running'))
) STRICT;
CREATE TABLE memory (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (ns, key)
) STRICT;
`;

/** 打开库：WAL、每次提交都落盘。新库建表；表结构版本不一致就拒绝。 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    const mode = db.prepare("PRAGMA journal_mode = WAL").get();
    if (mode?.journal_mode !== "wal") throw new Error(`库 ${path} 无法使用 WAL 模式。`);
    db.exec("PRAGMA synchronous = FULL");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) tx(db, () => db.exec(`${SCHEMA}PRAGMA user_version = ${SCHEMA_VERSION};`));
    else if (version !== SCHEMA_VERSION) {
      throw new Error(`库 ${path} 的表结构版本是 ${String(version)}，这个版本的 tau 要求 ${SCHEMA_VERSION}。MVP 不做迁移：停掉服务，把旧库移走，再启动 tau 重建一个新库。`);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** 一个 `BEGIN IMMEDIATE … COMMIT` 事务；`f` 抛出时回滚。 */
export function tx<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = f();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export function loadProcess(db: DatabaseSync, id: ProcessId): Process | undefined {
  const row = db.prepare("SELECT state_json FROM processes WHERE id = ?").get(id);
  return row && (JSON.parse(row.state_json as string) as Process);
}

export function loadProcesses(db: DatabaseSync): Process[] {
  return db.prepare("SELECT state_json FROM processes ORDER BY id").all().map((r) => JSON.parse(r.state_json as string) as Process);
}

export function saveProcess(db: DatabaseSync, p: Process): void {
  db.prepare("UPDATE processes SET state_json = ? WHERE id = ?").run(JSON.stringify(p), p.id);
}

/** 当前段的消息。旧段靠 `(process_id, segment_seq)` 定位，不加载。 */
export function loadSegment(db: DatabaseSync, p: Process): Message[] {
  return db
    .prepare("SELECT message_json FROM segment_messages WHERE process_id = ? AND segment_seq = ? ORDER BY seq")
    .all(p.id, p.segment.seq)
    .map((r) => JSON.parse(r.message_json as string) as Message);
}

/** 把消息追加到 `p.segment.seq` 那一段，段内序号从 `from` 开始。 */
export function appendMessages(db: DatabaseSync, p: Process, from: number, messages: readonly Message[]): void {
  const insert = db.prepare("INSERT INTO segment_messages (process_id, segment_seq, seq, message_json) VALUES (?, ?, ?, ?)");
  messages.forEach((m, i) => insert.run(p.id, p.segment.seq, from + i, JSON.stringify(m)));
}

/** 把一条输入放进信箱。 */
export function post(db: DatabaseSync, id: ProcessId, input: Input): void {
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run(id, JSON.stringify(input));
}
