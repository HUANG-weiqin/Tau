// Copilot 模型补充文件的后台刷新（D105）：桥启动时跑一次；`/api/models` 发现上次成功已超过 6 小时，也在后台跑。
// 同时只跑一个。失败（或没登录）以后至少等 10 分钟再试。永远不让请求等它。
import type { RefreshResult } from "../../models/copilot.ts";

export const STALE_MS = 6 * 60 * 60 * 1000;
export const RETRY_MS = 10 * 60 * 1000;

export interface CopilotRefresher {
  /** 桥启动时：登录了就跑一次（失败后的等待照样算）。 */
  start(): void;
  /** 每次 `/api/models`：登录了、上次成功超过 6 小时、没有在跑、离上次失败超过 10 分钟，才在后台跑。 */
  maybe(): void;
}

export function createCopilotRefresher(o: {
  run: () => Promise<RefreshResult>;
  /** 上次成功的时间（毫秒）。没有是 `undefined`。 */
  lastSuccess: () => number | undefined;
  /** auth.json 里有没有 Copilot 的凭据。 */
  loggedIn: () => boolean;
  now?: () => number;
}): CopilotRefresher {
  const now = o.now ?? Date.now;
  let running = false;
  let retryAt = 0;
  const go = (): void => {
    running = true;
    void (async () => {
      let kind = "failed";
      try {
        kind = (await o.run()).kind;
      } catch {}
      if (kind !== "ok") retryAt = now() + RETRY_MS;
      running = false;
    })();
  };
  return {
    start() {
      if (!running && o.loggedIn()) go();
    },
    maybe() {
      if (running || now() < retryAt || !o.loggedIn()) return;
      const last = o.lastSuccess();
      if (last === undefined || now() - last > STALE_MS) go();
    },
  };
}
