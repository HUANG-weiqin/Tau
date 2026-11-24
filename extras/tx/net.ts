// tx 连服务：只用线协议。错误一律变成带退出码的 Exit，文字里给能照抄的下一步。不导入 src/。
import { ConnectError, talk } from "../tools/client.ts";
import { inspectAll } from "../tools/procs.ts";
import type { Rec } from "../tools/procs.ts";
import { Exit } from "./args.ts";

/** 和内核的 CLI 一样：`TAU_PIPE` 有值就用它，否则默认的管道。 */
export const pipeName = (): string => process.env.TAU_PIPE || "\\\\.\\pipe\\tau";

/**
 * 发一个请求，逐个交出回复，`onReply` 返回 true 就断开（返回 true）；服务先关了连接返回 false，`signal` 中止也返回 false。
 * 连不上抛退出码 2（请求没发出）；连上以后出错抛退出码 3，`lost` 说明结果未知时怎么办。
 */
export async function ask(pipe: string, req: Record<string, unknown>, onReply: (r: any) => boolean | void, lost: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await talk(pipe, req, onReply, signal);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (e instanceof ConnectError) throw new Exit(2, `${m}。先运行 tau serve。`);
    throw new Exit(3, `${m}。${lost}`);
  }
}

/** 等到回执（`receipt`）。回 `error` 是退出码 1；断开没等到是退出码 3。返回回执。 */
export async function receipt(pipe: string, req: Record<string, unknown>, lost: string): Promise<any> {
  let got: any;
  let error: string | null = null;
  await ask(pipe, req, (r) => {
    if (r.type === "receipt") got = r;
    else if (r.type === "error") error = String(r.message);
    return got !== undefined || error !== null;
  }, lost);
  if (error !== null) throw new Exit(1, error);
  if (got === undefined) throw new Exit(3, `连接在回执之前断开了，结果未知。${lost}`);
  return got;
}

const running = (r: Rec): boolean => r.phase?.tag === "awaitingModel" || r.phase?.tag === "awaitingTool";
const MAX_HINT = 10;

/** 现有的进程 ID（新的在前，最多 10 个），给 ID 拼错时照抄。 */
export async function idHint(pipe: string): Promise<string> {
  const recs = await inspectAll(pipe);
  if (typeof recs === "string") return `（列不出现有的进程：${recs}）`;
  if (recs.length === 0) return "现在没有进程。tx start 建一个。";
  const list = [...recs].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HINT);
  const items = list.map((r) => `${r.id}（预设 ${r.preset}，${running(r) ? "运行中" : r.phase?.ended !== undefined ? "已结束" : "刚建好"}）`).join("、");
  return `现有的进程（新的在前${recs.length > MAX_HINT ? `，只列 ${MAX_HINT} 个，全部用 tx ps` : ""}）：${items}。`;
}

/** 服务回“没有这个进程”时，在错误后面补上候选。 */
export async function withIdHint(pipe: string, e: unknown): Promise<never> {
  if (e instanceof Exit && e.code === 1 && e.message.startsWith("没有这个进程")) throw new Exit(1, `${e.message}\n${await idHint(pipe)}`);
  throw e;
}
