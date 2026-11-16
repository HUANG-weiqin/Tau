// 存储层的不变量（执行清单第 2 步），加上每个进程的内核不变量。每个事务提交之后都必须成立。
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Content, Input, Message, Process } from "../../src/kernel/types.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import { findTool } from "../../src/kernel/tools.ts";
import { loadProcesses, loadSegment } from "../../src/store/db.ts";
import { assertInvariants } from "../invariants.ts";
import { effectRows, mailbox } from "./fixtures.ts";

/** 一组内容块里的图片引用。图片块的 data 不是 `blob:<hash>` 就是违反：库里只存引用。 */
function blobRefs(content: string | readonly Content[]): string[] {
  if (typeof content === "string") return [];
  return content.flatMap((c) => {
    if (c.type !== "image") return [];
    assert.ok(c.data.startsWith("blob:"), `图片块的 data 不是引用：${c.data.slice(0, 40)}`);
    return [c.data.slice("blob:".length)];
  });
}

const inputRefs = (i: Input): string[] => (i.kind === "letter" ? blobRefs(i.letter.content) : i.kind === "toolResult" && i.outcome.status === "ok" ? blobRefs(i.outcome.content.content) : []);
const messageRefs = (m: Message): string[] => (m.role === "assistant" ? [] : blobRefs(m.content));
const queuedRefs = (p: Process): string[] => (p.phase.tag === "idle" ? [] : p.phase.turn.queued.flatMap((l) => blobRefs(l.content)));

/** 设计稿 5.6：信箱、`turn.queued` 和全部进程的全部段里的每个 blob 引用，`blobs` 里都有对应的行。 */
function assertBlobRefs(db: DatabaseSync, processes: readonly Process[]): void {
  const have = new Set(db.prepare("SELECT hash FROM blobs").all().map((r) => r.hash as string));
  const messages = db.prepare("SELECT message_json FROM segment_messages").all().map((r) => JSON.parse(r.message_json as string) as Message);
  const refs = [...mailbox(db).flatMap((m) => inputRefs(m.input)), ...processes.flatMap(queuedRefs), ...messages.flatMap(messageRefs)];
  for (const h of refs) assert.ok(have.has(h), `引用的 blob ${h} 在 blobs 里没有行`);
}

/** 第 9 条：旧段要么整段在，要么整段删掉；删掉的是从 1 起连着的一段。没有段号大于当前段的行，也没有不属于任何进程的行。 */
function assertSegmentRows(db: DatabaseSync, processes: readonly Process[]): void {
  const rows = db.prepare("SELECT DISTINCT process_id, segment_seq FROM segment_messages ORDER BY process_id, segment_seq").all();
  for (const r of rows) assert.ok(processes.some((p) => p.id === r.process_id), `段里的消息属于不存在的进程 ${String(r.process_id)}`);
  for (const p of processes) {
    const have = rows.filter((r) => r.process_id === p.id).map((r) => r.segment_seq as number);
    assert.ok(have.every((s) => s <= p.segment.seq), `进程 ${p.id} 有段号大于当前段 ${p.segment.seq} 的消息：${have.join(",")}`);
    const old = have.filter((s) => s < p.segment.seq);
    old.forEach((s, i) => assert.equal(s, old[0]! + i, `进程 ${p.id} 的旧段不连续：${old.join(",")}，当前段 ${p.segment.seq}`));
    if (old.length > 0) assert.equal(old.at(-1), p.segment.seq - 1, `进程 ${p.id} 的旧段没有连到当前段的前一段：${old.join(",")}，当前段 ${p.segment.seq}`);
  }
}

export function assertStoreInvariants(db: DatabaseSync): void {
  const processes = loadProcesses(db);
  assertBlobRefs(db, processes);
  assertSegmentRows(db, processes);
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
