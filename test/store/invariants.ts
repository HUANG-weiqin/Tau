// 存储层的不变量（执行清单第 2 步），加上每个进程的内核不变量。每个事务提交之后都必须成立。
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { effectOf } from "../../src/kernel/decide.ts";
import { findTool } from "../../src/kernel/tools.ts";
import { loadProcesses, loadSegment } from "../../src/store/db.ts";
import { assertInvariants } from "../invariants.ts";
import { effectRows, mailbox } from "./fixtures.ts";

export function assertStoreInvariants(db: DatabaseSync): void {
  const processes = loadProcesses(db);
  const rows = effectRows(db);
  const mail = mailbox(db);
  for (const r of rows) assert.ok(processes.some((p) => p.id === r.id), `副作用表里的行属于不存在的进程 ${r.id}`);
  for (const p of processes) {
    const seg = loadSegment(db, p);
    assertInvariants(p, seg);
    const mine = rows.filter((r) => r.id === p.id);
    assert.ok(mine.length <= 1, `进程 ${p.id} 在副作用表里有 ${mine.length} 行`);
    const e = effectOf(p, seg);
    if (p.phase.tag === "idle" || !e) {
      assert.equal(p.phase.tag, "idle", `进程 ${p.id} 在运行，却算不出在等的副作用`);
      assert.equal(mine.length, 0, `进程 ${p.id} 空闲，副作用表里却有它的行`);
      continue;
    }
    const resultKind = e.kind === "callModel" ? "modelResult" : "toolResult";
    const results = mail.filter((m) => m.id === p.id && m.input.kind === resultKind && m.input.n === e.n).length;
    const row = mine.filter((r) => r.n === e.n).length;
    assert.equal(mine.length, row, `进程 ${p.id} 在副作用表里的行不是它在等的 #${e.n}`);
    const external = e.kind === "callModel" || findTool(p.preset, e.call.name)?.inStore === false;
    if (external) assert.equal(row + results, 1, `进程 ${p.id} 在等库外副作用 #${e.n}：表里 ${row} 行，信箱里 ${results} 个结果`);
    else assert.deepEqual([row, results], [0, 1], `进程 ${p.id} 在等库内副作用 #${e.n}：表里 ${row} 行，信箱里 ${results} 个结果`);
  }
}
