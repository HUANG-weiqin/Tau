// 连接：`ps` 加 `watch`，断了就退避重连；按 lib/history 的计划增量读 `history`。
// 这里只管发请求和收回复，状态都交给调用方（app.js）。
import { tauAll, tauStream, ApiError } from "./api.js";
import { applyEnd, applyMessage, emptyHistory, giveUp, noteSelf, plan } from "./lib/history.js";
import { extractTitle } from "./lib/titles.js";

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连上服务：先 `ps`，再 `watch`（不带进程）。被断开就等一会儿，从 `ps` 重来。
 * @param {{ reply: (r: any) => void, status: (s: "connecting" | "online" | "offline", msg?: string) => void }} hooks
 * @returns {{ stop: () => void }}
 */
export function createConn(hooks) {
  const ctl = new AbortController();
  let stopped = false;
  (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        hooks.status("connecting");
        const rs = await tauAll({ op: "ps" });
        const ps = rs.find((r) => r.type === "ps");
        if (!ps) throw new ApiError("服务没有回 ps");
        hooks.reply(ps);
        hooks.status("online");
        failures = 0;
        await tauStream({ op: "watch" }, (r) => {
          hooks.reply(r);
        }, ctl.signal);
        if (stopped) return;
        throw new ApiError("订阅断开了");
      } catch (e) {
        if (stopped) return;
        failures++;
        hooks.status("offline", e instanceof Error ? e.message : String(e));
        await sleep(Math.min(10000, 500 * 2 ** Math.min(failures, 5)));
      }
    }
  })();
  return {
    stop() {
      stopped = true;
      ctl.abort();
    },
  };
}

/**
 * 增量读一个进程的全部段。同一个进程同一时刻只发一个请求；回来以后按 `plan` 接着读，直到没有要读的。
 * @param {{
 *   getSelf: (id: string) => import("./lib/types.js").Self | undefined,
 *   getHist: (id: string) => import("./lib/history.js").History | undefined,
 *   setHist: (id: string, h: import("./lib/history.js").History) => void,
 * }} io
 */
export function createHistoryReader(io) {
  /** @type {Set<string>} */
  const running = new Set();
  /** @type {Set<string>} */
  const again = new Set();

  /** @param {string} id */
  async function loop(id) {
    let stuck = 0;
    for (;;) {
      const self = io.getSelf(id);
      if (!self) return;
      let h = noteSelf(io.getHist(id) ?? emptyHistory(), self);
      io.setHist(id, h);
      const p = plan(h, self);
      if (!p) {
        if (again.delete(id)) continue;
        return;
      }
      const before = h.segs[p.segment]?.msgs.length ?? 0;
      let ended = false;
      let failed = false;
      let gaveUp = false;
      try {
        await tauStream({ op: "history", process: id, segment: p.segment, from: p.from }, (r) => {
          if (r.type === "message") {
            h = applyMessage(h, r);
          } else if (r.type === "end") {
            h = applyEnd(h, r, p);
            ended = true;
          } else if (r.type === "error") {
            failed = true;
            if (p.sealed) {
              h = giveUp(h, p.segment);
              gaveUp = true;
            }
          }
        });
      } catch {
        failed = true;
      }
      io.setHist(id, h);
      const after = h.segs[p.segment]?.msgs.length ?? 0;
      if (gaveUp) continue; // 抛错（连不上）不算放弃，走下面的退避。
      if (failed || !ended || after === before) {
        stuck++;
        if (stuck >= 3) return;
        await sleep(800 * stuck);
      } else stuck = 0;
    }
  }

  return {
    /** 告诉它这个进程有新状态。已经在读就标记再来一遍。 @param {string} id */
    follow(id) {
      if (running.has(id)) {
        again.add(id);
        return;
      }
      running.add(id);
      loop(id).finally(() => {
        running.delete(id);
        if (again.delete(id)) this.follow(id);
      });
    },
  };
}

/**
 * 别的进程的轻量读取：只读当前段末尾几条（最后动静的时刻、在做什么），和第 1 段的标题。
 * 读取的并发有上限；同一份状态只读一次。
 * @param {{ onPeek: (id: string, v: { segment: number, total: number, msgs: any[], lastAt: number | null }) => void, onTitle: (id: string, title: string | null) => void }} io
 */
export function createPeeker(io) {
  const TAIL = 6;
  const LIMIT = 3;
  /** @type {Map<string, { segment: number, messages: number }>} */
  const have = new Map();
  /** @type {Map<string, { segment: number, messages: number }>} */
  const queue = new Map();
  /** @type {Set<string>} */
  const titleQueue = new Set();
  /** @type {Set<string>} */
  const titleDone = new Set();
  let active = 0;

  function pump() {
    while (active < LIMIT) {
      const next = queue.entries().next();
      if (!next.done) {
        const [id, want] = next.value;
        queue.delete(id);
        active++;
        readTail(id, want).finally(() => {
          active--;
          pump();
        });
        continue;
      }
      const t = titleQueue.values().next();
      if (t.done) return;
      titleQueue.delete(t.value);
      titleDone.add(t.value);
      active++;
      readTitle(t.value).finally(() => {
        active--;
        pump();
      });
    }
  }

  /** @param {string} id @param {{ segment: number, messages: number }} want */
  async function readTail(id, want) {
    /** @type {any[]} */
    const msgs = [];
    let ok = false;
    try {
      await tauStream({ op: "history", process: id, segment: want.segment, from: Math.max(0, want.messages - TAIL) }, (r) => {
        if (r.type === "message") msgs.push(r.message);
        else if (r.type === "end") ok = true;
      });
    } catch {
      // 下次再试。
    }
    if (!ok) return;
    have.set(id, want);
    io.onPeek(id, { segment: want.segment, total: want.messages, msgs, lastAt: msgs[msgs.length - 1]?.timestamp ?? null });
  }

  /** @param {string} id */
  async function readTitle(id) {
    /** @type {any} */
    let first = null;
    try {
      await tauStream({ op: "history", process: id, segment: 1, from: 0 }, (r) => {
        if (r.type === "message" && r.message.role === "user") {
          first = r.message;
          return true;
        }
        return r.type === "end" || r.type === "error";
      });
    } catch {
      // 读不到就不记。
    }
    io.onTitle(id, first ? extractTitle([first]) : null);
  }

  return {
    /** 这个进程的状态变了，需要的话排队读末尾。 @param {import("./lib/types.js").Self} self */
    note(self) {
      const h = have.get(self.id);
      if (h && h.segment === self.segment && h.messages === self.messages) return;
      queue.set(self.id, { segment: self.segment, messages: self.messages });
      pump();
    },
    /** @param {string} id */
    wantTitle(id) {
      if (titleDone.has(id) || titleQueue.has(id)) return;
      titleQueue.add(id);
      pump();
    },
    /** 这个进程已读的结果作废（进程被删）。 @param {string} id */
    forget(id) {
      have.delete(id);
      queue.delete(id);
    },
  };
}
