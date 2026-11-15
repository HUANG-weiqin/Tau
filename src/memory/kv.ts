// 记忆的键值实现（设计稿第 8 节）。版本号是全库自增 ID，永远不复用；每次写入 = 删掉旧行，插入新行。
import type { DatabaseSync } from "node:sqlite";
import { utf8Bytes } from "../kernel/derive.ts";
import { MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../kernel/tools.ts";
import type { Memory, Versioned } from "../kernel/types.ts";

interface Row {
  key: string;
  value: string;
  version: number;
}

/** 视图：每行一个键，键和值都写成 JSON 字符串，所以换行和冒号不会多出一行。上限按这份文本算。 */
function render(rows: Pick<Row, "key" | "value">[]): string {
  return rows.map((r) => `${JSON.stringify(r.key)}: ${JSON.stringify(r.value)}`).join("\n");
}

/** node:sqlite 读 TEXT 时在 U+0000 处截断，所以按字节读出再解码。 */
const text = (v: unknown): string => Buffer.from(v as Uint8Array).toString("utf8");

export function sqliteMemory(db: DatabaseSync): Memory {
  const get = (ns: string, key: string): Versioned | null => {
    const row = db.prepare("SELECT CAST(value AS BLOB) AS value, version FROM memory WHERE ns = ? AND key = ?").get(ns, key);
    return row ? { value: text(row.value), version: row.version as number } : null;
  };
  // 按 SQLite 的 BINARY 排序，即 UTF-8 字节序。
  const rows = (ns: string): Row[] =>
    db
      .prepare("SELECT CAST(key AS BLOB) AS key, CAST(value AS BLOB) AS value, version FROM memory WHERE ns = ? ORDER BY memory.key")
      .all(ns)
      .map((r) => ({ key: text(r.key), value: text(r.value), version: r.version as number }));
  return {
    view(ns) {
      return render(rows(ns));
    },
    get,
    set(ns, k, v, expected) {
      // 孤立的代理项存进库时变成替换字符：先换好，量的和存的才是同一份文本。
      const [key, value] = [k.toWellFormed(), v.toWellFormed()];
      const keyBytes = utf8Bytes(key);
      if (keyBytes > MEMORY_KEY_MAX_BYTES) return { ok: false, over: "key", bytes: keyBytes };
      const valueBytes = utf8Bytes(value);
      if (valueBytes > MEMORY_VALUE_MAX_BYTES) return { ok: false, over: "value", bytes: valueBytes };
      const current = get(ns, key);
      if ((current?.version ?? null) !== expected) return { ok: false, current };
      // 旧的那一行（按版本号认）不算：在上限处用同样长的值覆盖可以写。字节数和行的顺序无关。
      const viewBytes = utf8Bytes(render([...rows(ns).filter((r) => r.version !== current?.version), { key, value }]));
      if (viewBytes > MEMORY_VIEW_MAX_BYTES) return { ok: false, over: "view", bytes: viewBytes };
      if (current) db.prepare("DELETE FROM memory WHERE version = ?").run(current.version);
      const { lastInsertRowid } = db.prepare("INSERT INTO memory (ns, key, value) VALUES (?, ?, ?)").run(ns, key, value);
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
