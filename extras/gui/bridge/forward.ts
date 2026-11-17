// 转发线协议：一个 POST 带一条请求，管道回的每一行原样分块写回。
// 连管道后只写、不半关闭（Windows 命名管道不支持，见 kb-service 的坑点）。
import { createConnection } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

export function forward(pipe: string, request: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): void {
  const socket = createConnection(pipe);
  let headersSent = false;
  socket.once("connect", () => {
    headersSent = true;
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on("data", (chunk) => {
    if (!res.write(chunk)) {
      socket.pause();
      res.once("drain", () => socket.resume());
    }
  });
  socket.on("error", () => {
    if (!headersSent) {
      headersSent = true;
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "连不上 tau 服务，先运行 tau serve" }));
    } else res.destroy();
  });
  socket.on("close", () => {
    if (headersSent && !res.writableEnded) res.end();
  });
  // 浏览器断开：断开管道，服务那边的订阅随之释放。
  res.on("close", () => socket.destroy());
  req.on("aborted", () => socket.destroy());
}
