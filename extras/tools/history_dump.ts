// history_dump：把本进程的每个旧段写成 `~/.tau/extras/history/<进程 ID>/seg-<n>.md`，给模型一个能用 rg/grep 搜、用 read 读的目录
// （kb-extras 的“工具库”和“换段以后查旧段”）。没有参数。只读旧段，顺手清掉 7 天前的文件。
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { extrasDir, run, tauEnv } from "./common.ts";
import { currentSegment, fetchSegment, formatDump, headOf, probeSegment, pruneOld, readExistingSegment, renderSegment, segmentPath, writeSegment } from "./history.ts";
import type { DumpEntry } from "./history.ts";

if (import.meta.main) run(async () => {
  const { proc, pipe } = tauEnv();
  const now = Date.now();
  const root = extrasDir("history");
  pruneOld(root, now);
  const current = await currentSegment(pipe, proc);
  if (current === 1) {
    process.stdout.write("现在是第 1 段，没有旧段。\n");
    return;
  }
  // 目录写成正斜杠：模型直接粘给 rg 和 read。
  const dir = path.join(root, proc).replace(/\\/g, "/");
  // 每一段都读不到时不留一个空目录给 rg 报错。
  mkdirSync(dir, { recursive: true });
  const entries: DumpEntry[] = [];
  for (let seg = 1; seg < current; seg++) {
    if (existsSync(segmentPath(dir, seg))) {
      const missing = await probeSegment(pipe, proc, seg);
      if (missing !== null) {
        // 被 prune 的段：本地文件还在，照样刷新修改时间、给出大小和开头，别让模型以为这段没了。
        const local = readExistingSegment(dir, seg, now);
        entries.push(local === null ? { seg, missing } : { seg, ...local, stale: true });
        continue;
      }
      const cached = readExistingSegment(dir, seg, now);
      if (cached !== null) {
        entries.push({ seg, ...cached });
        continue;
      }
    }
    const rows = await fetchSegment(pipe, proc, seg);
    if (typeof rows === "string") {
      entries.push({ seg, missing: rows });
      continue;
    }
    const { bytes, lines } = writeSegment(dir, seg, renderSegment(seg, rows), now);
    entries.push({ seg, bytes, lines, head: headOf(rows) });
  }
  process.stdout.write(`${formatDump(dir, entries)}\n`);
});
