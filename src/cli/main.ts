// 命令行（见 .knowledge/kb-service.md）。只依赖 protocol.ts。
import { connect } from "node:net";
import { PIPE } from "../protocol.ts";
import type { Reply, Request } from "../protocol.ts";

const USAGE = `用法：
  tau serve
  tau start <预设> <消息>
  tau send <进程> <消息>
  tau ps
  tau stop <进程>`;

export async function main(argv: readonly string[], pipe: string = PIPE): Promise<number> {
  const [cmd, target, ...rest] = argv;
  const text = rest.join(" ");
  if ((cmd === "start" || cmd === "send") && target && text) {
    return command(pipe, cmd === "start" ? { op: "start", preset: target, text } : { op: "send", process: target, text });
  }
  if (cmd === "stop" && target) return command(pipe, { op: "stop", process: target });
  if (cmd === "ps") return command(pipe, { op: "ps" });
  console.error(USAGE);
  return 2;
}

/** 发一条请求，打印回复。没收到回执就断开时，结果未知。 */
async function command(pipe: string, req: Request): Promise<number> {
  let receipt = false;
  let streamed = false;
  let code: number | null = null;
  const onReply = (r: Reply): void => {
    switch (r.type) {
      case "receipt":
        receipt = true;
        if (req.op === "start") console.error(`进程 ${r.process}`);
        if (req.op === "stop") code = 0;
        return;
      case "text":
        streamed = true;
        process.stdout.write(r.delta);
        return;
      case "final":
        if (!streamed) process.stdout.write(r.reply);
        process.stdout.write("\n");
        if (r.ended !== null && r.ended !== "done") console.error(`[本轮结束：${typeof r.ended === "string" ? r.ended : r.ended.error}]`);
        code = r.ended === null || r.ended === "done" ? 0 : 1;
        return;
      case "ps":
        console.log(formatPs(r));
        code = 0;
        return;
      case "error":
        console.error(r.message);
        code = 1;
        return;
      default: {
        const unknown: never = r;
        console.error(`无法识别的回复：${JSON.stringify(unknown)}`);
      }
    }
  };
  try {
    await request(pipe, req, onReply);
  } catch (e) {
    console.error(`连不上 tau 服务（${e instanceof Error ? e.message : String(e)}）。先运行 tau serve。`);
    return 2;
  }
  if (code !== null) return code;
  if (!receipt && req.op !== "ps") console.error("结果未知：服务在回执之前断开了。这条命令可能已经写进库，也可能没有。用 tau ps 查看，不要盲目重发。");
  else console.error("连接在最终回复之前断开了。进程可能还在运行，用 tau ps 查看。");
  return 3;
}

/** 连接、发一行请求、逐行交出回复，直到服务关闭连接。连不上时拒绝。 */
export function request(pipe: string, req: Request, onReply: (r: Reply) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let buf = "";
    const s = connect(pipe, () => {
      connected = true;
      s.write(`${JSON.stringify(req)}\n`);
    });
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line !== "") onReply(JSON.parse(line) as Reply);
      }
    });
    s.on("error", (e) => (connected ? undefined : reject(e)));
    s.on("close", () => resolve());
  });
}

function formatPs(r: Extract<Reply, { type: "ps" }>): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = r.processes.map(({ self: p }) => {
    const ph = p.phase;
    const phase = ph.tag === "idle" ? `idle${ph.ended === undefined ? "" : `(${typeof ph.ended === "string" ? ph.ended : "error"})`}` : ph.tag === "awaitingModel" ? `${ph.purpose === "handoff" ? "换段中" : "等模型"} 第${ph.steps}步` : `等工具 第${ph.steps}步`;
    return [p.id, p.preset, phase, `${k(p.context.used)}/${k(p.context.window)}`, `段${p.segment}`, ago(p.age)].join("  ");
  });
  return [`现在 ${new Date().toLocaleString()}（${tz}）`, ...(rows.length > 0 ? rows : ["没有进程。"])].join("\n");
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 运行多久，只用一个单位。和 `self` 一样向下取整，负数算 0（时钟被往回拨时）。导出给测试。 */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  if (s < 86400) return `${(Math.floor(s / 360) / 10).toFixed(1)}时`;
  return `${(Math.floor(s / 8640) / 10).toFixed(1)}天`;
}
