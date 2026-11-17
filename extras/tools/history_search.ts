// history_search：搜自己的旧段，一次扫完全部旧段，给总数和每段的分布（kb-extras 的“换段以后查旧段”）。只读。
import { Fail, readArgs, run, tauEnv } from "./common.ts";
import { currentSegment, fetchSegment, formatSearch, parseSearchArgs, scanHistory } from "./history.ts";

if (import.meta.main) run(async () => {
  const { proc, pipe } = tauEnv();
  const a = parseSearchArgs(await readArgs());
  const current = await currentSegment(pipe, proc);
  if (a.segment !== undefined && a.segment > current) throw new Fail(`没有第 ${a.segment} 段，现在是第 ${current} 段。`);
  const r = await scanHistory({
    ...a,
    current,
    now: Date.now,
    read: async (segment) => {
      const rows = await fetchSegment(pipe, proc, segment);
      return typeof rows === "string" ? null : rows;
    },
  });
  process.stdout.write(`${formatSearch(r, { current, segment: a.segment, before: a.before })}\n`);
});
