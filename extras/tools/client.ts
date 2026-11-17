// 连 tau 服务的命名管道：发一行请求，逐行读回复。只依赖线协议（kb-service），不导入 src/。
// 发完请求不半关闭（Windows 命名管道不支持）；拿到要的回复就 destroy。
import { createConnection } from "node:net";

/** 连不上：服务没在运行，或者正在重启。请求肯定没发出，可以重试。 */
export class ConnectError extends Error {}

/**
 * `onReply` 返回 true 就断开，本函数返回 true；服务先关了连接返回 false。
 * 连不上抛 `ConnectError`；连上以后出错抛 `Error`。`signal` 中止算断开，返回 false。
 */
export function talk(pipe: string, request: Record<string, unknown>, onReply: (reply: any) => boolean | void, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    socket.setEncoding("utf8");
    let connected = false;
    let done = false;
    let buf = "";
    const onAbort = () => end(() => resolve(false));
    const end = (f: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      f();
    };
    if (signal?.aborted) return end(() => resolve(false));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        let reply: unknown;
        try {
          reply = JSON.parse(line);
        } catch {
          return end(() => reject(new Error("服务回的不是 JSON")));
        }
        if (onReply(reply) === true) return end(() => resolve(true));
      }
    });
    socket.on("error", (e) => end(() => reject(connected ? new Error(`连接出错：${e.message}`) : new ConnectError(`连不上 tau 服务：${e.message}`))));
    socket.on("close", () => end(() => resolve(false)));
  });
}
