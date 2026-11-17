// peek：看别的进程的当前段，只给最后几条（kb-extras 的“工具库”）。连管道发 `history`，只读。
import { talk } from "./client.ts";
import { cut, Fail, readArgs, run, tauEnv } from "./common.ts";

const DEFAULT_LAST = 6;
const MAX_LAST = 20;
const MESSAGE_CHARS = 1500;

interface Row {
  seq: number;
  message: any;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "image" ? "[图片]" : ""))
    .filter((s) => s !== "")
    .join("\n");
}

/** 一条消息写成一行标题加正文。 */
export function describe({ seq, message: m }: Row): string {
  if (m?.role === "user") {
    const from = m.tau?.letters?.[0]?.from;
    const who = from?.kind === "process" ? `进程 ${from.id}（${from.preset}）` : "用户";
    return `#${seq} ${who}：\n${cut(textOf(m.content), MESSAGE_CHARS)}`;
  }
  if (m?.role === "assistant") {
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
    const calls = blocks.filter((b) => b?.type === "toolCall").map((b) => String(b.name));
    return `#${seq} 助手：\n${cut(text, MESSAGE_CHARS)}${calls.length > 0 ? `${text === "" ? "" : "\n"}调用：${calls.join("、")}` : ""}`;
  }
  if (m?.role === "toolResult") {
    return `#${seq} 工具结果 ${String(m.toolName)}${m.isError ? "（出错）" : ""}：\n${cut(textOf(m.content), MESSAGE_CHARS)}`;
  }
  return `#${seq} （不认识的消息）`;
}

if (import.meta.main) run(async () => {
  const { pipe } = tauEnv();
  const args = await readArgs();
  const id = args.process;
  if (typeof id !== "string" || id === "") throw new Fail("process 必须是进程 ID。");
  const last = args.last === undefined ? DEFAULT_LAST : Math.min(MAX_LAST, Math.max(1, Math.trunc(Number(args.last))));
  if (!Number.isFinite(last)) throw new Fail("last 必须是整数。");
  const rows: Row[] = [];
  let end: { segment: number; messages: number } | null = null;
  let error: string | null = null;
  await talk(pipe, { op: "history", process: id }, (r) => {
    if (r.type === "message") {
      rows.push({ seq: r.seq, message: r.message });
      if (rows.length > last) rows.shift();
    } else if (r.type === "end") end = { segment: r.segment, messages: r.messages };
    else if (r.type === "error") error = String(r.message);
    return end !== null || error !== null;
  });
  if (error !== null) throw new Fail(`读不到进程 ${id}：${error}`);
  if (end === null) throw new Fail("服务没读完就断开了。");
  const { segment, messages } = end as { segment: number; messages: number };
  const head = `进程 ${id}，当前段（第 ${segment} 段）共 ${messages} 条，最后 ${rows.length} 条：`;
  process.stdout.write(rows.length === 0 ? `进程 ${id} 的当前段还没有消息。\n` : `${head}\n\n${rows.map(describe).join("\n\n")}\n`);
});
