// history_dump：把本进程的每个旧段写成 `~/.tau/extras/history/<进程 ID>/seg-<n>.md`，给模型一个能用 rg/grep 搜、用 read 读的目录
// （kb-extras 的“工具库”和“换段以后查旧段”），每段再写一份简略视图 `seg-<n>.brief.md`（D103）。没有参数。只读旧段，顺手清掉 7 天前的文件。
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dropUnknown, extrasDir, readArgs, run, takeArgs, tauEnv } from "./common.ts";
import { currentSegment, fetchSegment, formatDump, headOf, probeSegment, pruneOld, readExistingBrief, readExistingSegment, renderBrief, renderSegmentParts, segmentPath, writeBrief, writeSegment } from "./history.ts";
import type { DumpEntry } from "./history.ts";

if (import.meta.main) run(async () => {
  const { proc, pipe } = tauEnv();
  // 不拒绝任何参数：它只写自己的旧段，指向别的进程的参数也丢掉并说明。
  dropUnknown("history_dump", takeArgs("history_dump", await readArgs()).unknown, "；它只写你自己的旧段，看别的进程用 peek");
  const now = Date.now();
  const root = extrasDir("history");
  pruneOld(root, now);
  const current = await currentSegment(pipe, proc);
  if (current === 1) {
    process.stdout.write("现在是第 1 段，没有旧段。当前段的内容你已经有了，不用再调；看别的进程用 peek。\n");
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
        // 被 prune 的段：本地文件还在，照样刷新修改时间、给出大小和开头，别让模型以为这段没了。简略视图有就带上，没有只列原文。
        const local = readExistingSegment(dir, seg, now);
        const brief = readExistingBrief(dir, seg, now) ?? undefined;
        entries.push(local === null ? { seg, missing } : { seg, ...local, stale: true, ...(brief === undefined ? {} : { brief }) });
        continue;
      }
      const cached = readExistingSegment(dir, seg, now);
      if (cached !== null) {
        let brief = readExistingBrief(dir, seg, now) ?? undefined;
        if (brief === undefined) {
          // 以前写的段没有简略视图：库里还有，就拉一次补写（原文已在，不重写）。
          const rows = await fetchSegment(pipe, proc, seg);
          if (typeof rows !== "string") {
            const w = writeBrief(dir, seg, renderBrief(seg, renderSegmentParts(seg, rows)), now);
            brief = { bytes: w.bytes, lines: w.lines };
          }
        }
        entries.push({ seg, ...cached, ...(brief === undefined ? {} : { brief }) });
        continue;
      }
    }
    const rows = await fetchSegment(pipe, proc, seg);
    if (typeof rows === "string") {
      entries.push({ seg, missing: rows });
      continue;
    }
    const parts = renderSegmentParts(seg, rows);
    const { bytes, lines } = writeSegment(dir, seg, parts.text, now);
    const w = writeBrief(dir, seg, renderBrief(seg, parts), now);
    entries.push({ seg, bytes, lines, head: headOf(rows), brief: { bytes: w.bytes, lines: w.lines } });
  }
  process.stdout.write(`${formatDump(dir, entries)}\n`);
});
