// history_read：读自己某一段里的一条消息原文，带前后几条（kb-extras 的“换段以后查旧段”）。只读。
import { Fail, readArgs, run, tauEnv } from "./common.ts";
import { fetchSegment, parseReadArgs, renderRead } from "./history.ts";

if (import.meta.main) run(async () => {
  const { proc, pipe } = tauEnv();
  const a = parseReadArgs(await readArgs());
  const rows = await fetchSegment(pipe, proc, a.at.seg);
  if (typeof rows === "string") throw new Fail(`读不到第 ${a.at.seg} 段：${rows}`);
  process.stdout.write(`${renderRead(a.at.seg, rows, a)}\n`);
});
