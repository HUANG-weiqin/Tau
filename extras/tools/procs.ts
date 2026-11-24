// 进程 ID 对不上时（peek、wait 共用）：连一次管道读进程记录，列出能用的候选。正常路径不连。不导入 src/。
import { talk } from "./client.ts";

export interface Rec {
  id: string;
  preset: string;
  parent?: string;
  phase: any;
  createdAt: number;
}

const MAX_CANDIDATES = 10;
const MAX_WAIT_EXAMPLE = 8;

/** 读全部进程记录（`inspect` 不读段，只读记录）。读不出返回原因。 */
export async function inspectAll(pipe: string): Promise<Rec[] | string> {
  const recs: Rec[] = [];
  let failure: string | null = null;
  try {
    const ok = await talk(pipe, { op: "inspect" }, (r) => {
      if (r.type === "process") recs.push({ id: String(r.process.id), preset: String(r.process.preset?.id ?? "?"), parent: r.process.parent, phase: r.process.phase, createdAt: Number(r.process.createdAt) || 0 });
      else if (r.type === "error") failure = String(r.message);
      return r.type === "inspected" || r.type === "error";
    });
    if (!ok && failure === null) failure = "服务没回完就断开了";
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  return failure === null ? recs : failure;
}

const running = (r: Rec): boolean => r.phase?.tag === "awaitingModel" || r.phase?.tag === "awaitingTool";
const stage = (r: Rec): string => (running(r) ? "运行中" : r.phase?.ended !== undefined ? "已结束" : "刚建好");

/**
 * 候选和照抄的例子。文字只由当时的记录决定：同样的状态下重发，一字不差。
 * wait 只列调用者的子进程；peek 先子进程，再别的运行中的进程；都是新的在前，最多 10 个。
 */
export function candidateText(kind: "wait" | "peek", recs: Rec[], me: string): string {
  const kids = recs.filter((r) => r.parent === me).sort((a, b) => b.createdAt - a.createdAt);
  const others = kind === "peek" ? recs.filter((r) => r.parent !== me && r.id !== me && running(r)).sort((a, b) => b.createdAt - a.createdAt) : [];
  const list = [...kids, ...others].slice(0, MAX_CANDIDATES);
  if (list.length === 0) return kind === "wait" ? "你没有子进程；进程 ID 在 spawn 的结果里。" : "现在没有别的运行中的进程，你也没有子进程。";
  const items = list.map((r) => `${r.id}（预设 ${r.preset}，${stage(r)}${kind === "peek" && r.parent === me ? "，你的子进程" : ""}）`).join("、");
  if (kind === "peek") return `现有的进程：${items}。照这样看：peek ${JSON.stringify({ process: list[0]!.id })}`;
  const live = list.filter(running).slice(0, MAX_WAIT_EXAMPLE);
  return `你的子进程（新的在前）：${items}。照这样等：wait ${JSON.stringify({ processes: (live.length > 0 ? live : [list[0]!]).map((r) => r.id) })}`;
}

/** 连一次管道列候选；列不出写原因。 */
export async function candidatesFor(kind: "wait" | "peek", pipe: string, me: string): Promise<{ text: string; recs: Rec[] | null }> {
  const recs = await inspectAll(pipe);
  return typeof recs === "string" ? { text: `（列不出候选：${recs}）`, recs: null } : { text: candidateText(kind, recs, me), recs };
}
