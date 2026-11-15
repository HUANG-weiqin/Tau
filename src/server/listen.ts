// 单实例：只在命名管道上监听，监听成功才算持有锁（设计稿第 11 节）。同一个管道不能被监听两次，所以没有锁文件。
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

export function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    const onError = (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`已经有一个 tau 服务在 ${path} 上运行。`) : e);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
