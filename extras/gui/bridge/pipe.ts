// 一次性的管道请求：连上、写一行请求、逐行读回复。只写不半关闭（Windows 命名管道不支持）。
import { createConnection } from "node:net";

/** `onReply` 返回 true 就断开。管道关了也算读完。连不上或超时抛错。 */
export function pipeRequest(pipe: string, request: Record<string, unknown>, onReply: (r: any) => boolean | void, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let buf = "";
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("等服务回复超时")), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        let r: unknown;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        let stop: boolean | void;
        try {
          stop = onReply(r);
        } catch (e) {
          return finish(e instanceof Error ? e : new Error(String(e)));
        }
        if (stop === true) return finish();
      }
    });
    socket.on("error", () => finish(new Error("连不上 tau 服务")));
    socket.on("close", () => finish());
  });
}

/** 管道上有没有服务在听。 */
export function pipeUp(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(pipe);
    const t = setTimeout(() => (s.destroy(), resolve(false)), 1500);
    s.once("connect", () => (clearTimeout(t), s.destroy(), resolve(true)));
    s.once("error", () => (clearTimeout(t), s.destroy(), resolve(false)));
  });
}
