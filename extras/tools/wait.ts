// wait：在同一轮里等子进程结束（kb-extras 的“多 Agent 的等待”）。用 `watch` 订阅，每个进程一个连接。
// 结束 = 空闲阶段带结束原因。刚建、还没处理第一封信的 `idle`（没有原因）不算结束。
// 也订阅自己（`TAU_PROCESS`）：自己的阶段是 `awaitingTool` 而且有信排队，就提前返回。信本来就只能在安全点并入，等下去是白等。
import { talk } from "./client.ts";
import { Fail, readArgs, run, tauEnv } from "./common.ts";

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 590;
const MAX_PROCESSES = 8;
/** 被来信打断时，最多再等这么久，让每个等待目标都读到一次状态再返回。 */
const GRACE_MS = 1000;

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
  const { proc, pipe } = tauEnv();
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
  /** 被打断时自己队列里有几封信；null 表示没被打断。 */
  let queued: number | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const unread = () => ids.some((id) => seen.get(id)!.kind === "wait");
  /** 打断了，但有的目标还没读到状态：等它们读到（最多 GRACE_MS）再返回，免得结果里写“还没读到状态”。 */
  const settle = () => {
    if (queued === null) return;
    if (!unread()) ctl.abort();
    else grace ??= setTimeout(() => ctl.abort(), GRACE_MS);
  };
  /** 订阅一个进程；订阅自己时，同一个回调也看它的队列。返回 true 表示这一路不用再听了。 */
  const watch = (id: string): Promise<unknown> => {
    const own = id === proc;
    return talk(
      pipe,
      { op: "watch", process: id },
      (r) => {
        if (r.type === "update") {
          const phase = r.self?.phase;
          // 开始时队列里就有信也算：返回得越快越对（只等每个目标读到一次状态，见 settle）。
          if (own && queued === null && phase?.tag === "awaitingTool" && phase.queued > 0) queued = phase.queued;
          if (seen.has(id)) seen.set(id, { kind: "phase", ...phaseText(phase) });
        } else if (!seen.has(id)) {
          // 自己不是等待目标：这一路只用来打断，出错就不听了（读不到自己，无非等不到打断）。
          return true;
        } else if (r.type === "removed") seen.set(id, { kind: "gone", text: "已被删除" });
        else if (r.type === "error") seen.set(id, { kind: "gone", text: `读不到：${String(r.message)}` });
        settle();
        if (finished()) ctl.abort();
        return seen.has(id) && seen.get(id)!.kind === "gone";
      },
      ctl.signal,
    ).catch((e: Error) => {
      failure ??= e;
      ctl.abort();
    });
  };
  // 自己的 ID 也在 processes 里时只订阅一次，按等待目标的那套规则处理（它在跑，所以只能靠被打断或者超时）。
  await Promise.all((ids.includes(proc) ? ids : [...ids, proc]).map(watch));
  clearTimeout(timer);
  clearTimeout(grace);
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
  const head = queued !== null && !done
    ? `被来信打断：有 ${queued} 封信排队，到下一个安全点并入。先看信，再决定要不要接着等。`
    : done ? (allEnded ? "全部结束。" : "不用再等了：有的进程读不到或已删除。") : `等了 ${seconds} 秒，还没全部结束（超时不算错误，可以再等，或者先做别的）。`;
  process.stdout.write(`${head}\n${rows.join("\n")}\n`);
});
