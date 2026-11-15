// 记忆的键值实现（设计稿第 8 节）。版本号是全库自增 ID，永远不复用；每次写入 = 删掉旧行，插入新行。
import type { DatabaseSync } from "node:sqlite";
import type { Memory, Versioned } from "../kernel/types.ts";

export function sqliteMemory(db: DatabaseSync): Memory {
  const get = (ns: string, key: string): Versioned | null => {
    const row = db.prepare("SELECT value, version FROM memory WHERE ns = ? AND key = ?").get(ns, key);
    return row ? { value: row.value as string, version: row.version as number } : null;
  };
  return {
    view(ns) {
      return db
        .prepare("SELECT key, value FROM memory WHERE ns = ? ORDER BY key")
        .all(ns)
        .map((r) => `${String(r.key)}: ${String(r.value)}`)
        .join("\n");
    },
    get,
    set(ns, key, value, expected) {
      const current = get(ns, key);
      if ((current?.version ?? null) !== expected) return { ok: false, current };
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
