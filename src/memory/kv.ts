// 记忆的键值实现（见 .knowledge/kb-memory.md）。版本号是全库自增 ID，永远不复用；每次写入 = 删掉旧行，插入新行。
import type { DatabaseSync } from "node:sqlite";
import { utf8Bytes } from "../kernel/derive.ts";
import { MEMORY_BRIEF_MAX_BYTES, MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../kernel/tools.ts";
import type { Memory, Versioned } from "../kernel/types.ts";

/** 索引行：视图用得到的一切。值只读它的字节数，不读本体。 */
interface IndexRow {
  key: string;
  brief: string;
  updated: number;
  bytes: number;
  version: number;
}

/** UTC 日期 `YYYY-MM-DD`：视图和 `memory_get` 的结果用它，同样的库在任何机器上渲染出同样的文本。纯函数层不许建 `Date`，所以它不在 `kernel/` 里。 */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 视图：每行一个键的索引，键和摘要写成 JSON 字符串，所以换行和竖线不会多出一行。上限按这份文本算。 */
function render(rows: Pick<IndexRow, "key" | "brief" | "updated" | "bytes">[]): string {
  return rows.map((r) => `${JSON.stringify(r.key)} | ${utcDate(r.updated)} | ${r.bytes} B | ${JSON.stringify(r.brief)}`).join("\n");
}

/** node:sqlite 读 TEXT 时在 U+0000 处截断，所以按字节读出再解码。 */
const text = (v: unknown): string => Buffer.from(v as Uint8Array).toString("utf8");

export function sqliteMemory(db: DatabaseSync): Memory {
  const get = (ns: string, key: string): Versioned | null => {
    const row = db
      .prepare("SELECT CAST(value AS BLOB) AS value, CAST(brief AS BLOB) AS brief, updated, version FROM memory WHERE ns = ? AND key = ?")
      .get(ns, key);
    return row ? { value: text(row.value), brief: text(row.brief), updated: row.updated as number, version: row.version as number } : null;
  };
  // 按键的 UTF-8 字节序（SQLite 的 BINARY 排序）。不读 value 本体。
  const indexRows = (ns: string): IndexRow[] =>
    db
      .prepare("SELECT CAST(key AS BLOB) AS key, CAST(brief AS BLOB) AS brief, updated, length(CAST(value AS BLOB)) AS bytes, version FROM memory WHERE ns = ? ORDER BY memory.key")
      .all(ns)
      .map((r) => ({ key: text(r.key), brief: text(r.brief), updated: r.updated as number, bytes: r.bytes as number, version: r.version as number }));
  const allRows = (ns: string): (Versioned & { key: string })[] =>
    db
      .prepare("SELECT CAST(key AS BLOB) AS key, CAST(value AS BLOB) AS value, CAST(brief AS BLOB) AS brief, updated, version FROM memory WHERE ns = ? ORDER BY memory.key")
      .all(ns)
      .map((r) => ({ key: text(r.key), value: text(r.value), brief: text(r.brief), updated: r.updated as number, version: r.version as number }));
  return {
    view: (ns) => render(indexRows(ns)),
    entries: allRows,
    namespaces: () =>
      db
        .prepare("SELECT DISTINCT CAST(ns AS BLOB) AS ns FROM memory ORDER BY memory.ns")
        .all()
        .map((r) => text(r.ns)),
    get,
    set(ns, k, put, expected) {
      // 孤立的代理项存进库时变成替换字符：先换好，量的和存的才是同一份文本。
      const [key, value, brief] = [k.toWellFormed(), put.value.toWellFormed(), put.brief.toWellFormed()];
      const keyBytes = utf8Bytes(key);
      if (keyBytes > MEMORY_KEY_MAX_BYTES) return { ok: false, over: "key", bytes: keyBytes };
      const valueBytes = utf8Bytes(value);
      if (valueBytes > MEMORY_VALUE_MAX_BYTES) return { ok: false, over: "value", bytes: valueBytes };
      const briefBytes = utf8Bytes(brief);
      if (briefBytes > MEMORY_BRIEF_MAX_BYTES) return { ok: false, over: "brief", bytes: briefBytes };
      const current = get(ns, key);
      if ((current?.version ?? null) !== expected) return { ok: false, current };
      // 旧的那一行（按版本号认）不算：在上限处用同样长的值覆盖可以写。字节数和行的顺序无关。
      const rows = indexRows(ns).filter((r) => r.version !== current?.version);
      const viewBytes = utf8Bytes(render([...rows, { key, brief, updated: put.now, bytes: valueBytes }]));
      if (viewBytes > MEMORY_VIEW_MAX_BYTES) return { ok: false, over: "view", bytes: viewBytes };
      if (current) db.prepare("DELETE FROM memory WHERE version = ?").run(current.version);
      const { lastInsertRowid } = db.prepare("INSERT INTO memory (ns, key, value, brief, updated) VALUES (?, ?, ?, ?, ?)").run(ns, key, value, brief, put.now);
      return { ok: true, version: Number(lastInsertRowid) };
    },
    delete(ns, key, expected) {
      const current = get(ns, key);
      if (current?.version !== expected) return { ok: false, current };
      db.prepare("DELETE FROM memory WHERE version = ?").run(expected);
      return { ok: true };
    },
  };
}
