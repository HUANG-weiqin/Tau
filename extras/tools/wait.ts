// wait：在同一轮里等子进程结束（kb-extras 的“多 Agent 的等待”）。用 `watch` 订阅，每个进程一个连接。
// 结束 = 空闲阶段带结束原因。刚建、还没处理第一封信的 `idle`（没有原因）不算结束。
import { talk } from "./client.ts";
import { Fail, readArgs, run, tauEnv } from "./common.ts";

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 590;
const MAX_PROCESSES = 8;

type Seen = { kind: "wait" } | { kind: "phase"; text: string; ended: boolean } | { kind: "gone"; text: string };

function endedText(e: unknown): string {
  if (e === "done") return "完成";
  if (e === "stepLimit") return "步数用完";
  if (e === "stopped") return "被停止";
  if (typeof e === "object" && e !== null && "error" in e) return `出错：${String((e as { error: unknown }).error)}`;
  return "结束了";
}

/** 阶段写成一句话；第二项是它算不算结束。 */
export function phaseText(phase: any): { text: string; ended: boolean } {
  if (phase?.tag === "idle") return phase.ended === undefined ? { text: "刚建好，还没处理第一封信", ended: false } : { text: `已结束，${endedText(phase.ended)}`, ended: true };
  if (phase?.tag === "awaitingModel") return { text: "运行中，在等模型", ended: false };
  if (phase?.tag === "awaitingTool") return { text: "运行中，在等工具", ended: false };
  return { text: "阶段不明", ended: false };
}

if (import.meta.main) run(async () => {
  const { pipe } = tauEnv();
  const args = await readArgs();
  const list = args.processes;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PROCESSES || list.some((x) => typeof x !== "string" || x === "")) throw new Fail(`processes 必须是 1 到 ${MAX_PROCESSES} 个进程 ID。`);
  const ids = [...new Set(list as string[])];
  const seconds = args.timeout === undefined ? DEFAULT_SECONDS : Math.min(MAX_SECONDS, Math.max(1, Math.trunc(Number(args.timeout))));
  if (!Number.isFinite(seconds)) throw new Fail("timeout 必须是整数（秒）。");

  const seen = new Map<string, Seen>(ids.map((id) => [id, { kind: "wait" }]));
  const ctl = new AbortController();
  const finished = () => ids.every((id) => {
    const s = seen.get(id)!;
    return (s.kind === "phase" && s.ended) || s.kind === "gone";
  });
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  let failure: Error | null = null;
  await Promise.all(
    ids.map((id) =>
      talk(
        pipe,
        { op: "watch", process: id },
        (r) => {
          if (r.type === "update") seen.set(id, { kind: "phase", ...phaseText(r.self?.phase) });
          else if (r.type === "removed") seen.set(id, { kind: "gone", text: "已被删除" });
          else if (r.type === "error") seen.set(id, { kind: "gone", text: `读不到：${String(r.message)}` });
          if (finished()) ctl.abort();
          return seen.get(id)!.kind === "gone";
        },
        ctl.signal,
      ).catch((e: Error) => {
        failure ??= e;
        ctl.abort();
      }),
    ),
  );
  clearTimeout(timer);
  if (failure !== null) throw new Fail((failure as Error).message);
  const done = finished();
  const allEnded = ids.every((id) => {
    const s = seen.get(id)!;
    return s.kind === "phase" && s.ended;
  });
  const rows = ids.map((id) => {
    const s = seen.get(id)!;
    return `- ${id}：${s.kind === "wait" ? "还没读到状态" : s.text}`;
  });
  process.stdout.write(`${done ? (allEnded ? "全部结束。" : "不用再等了：有的进程读不到或已删除。") : `等了 ${seconds} 秒，还没全部结束（超时不算错误，可以再等，或者先做别的）。`}\n${rows.join("\n")}\n`);
});
