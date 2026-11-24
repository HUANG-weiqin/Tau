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
        // messages: true：追加的消息和思考、工具调用参数的流式片段也推来。
        await tauStream({ op: "watch", messages: true }, (r) => {
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
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();

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
          // 读的同时 watch 也在往缓存里追加：每次从缓存取最新的，别用手里的旧副本盖掉。
          h = io.getHist(id) ?? h;
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
          io.setHist(id, h);
          return r.type === "end" || r.type === "error";
        });
      } catch {
        failed = true;
      }
      h = io.getHist(id) ?? h;
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
    /**
     * 告诉它这个进程有新状态。已经在读就标记再来一遍。
     * `grace` 毫秒：先等一等，那期间 watch 推来的消息能补上的就不读 history；到时候还差，才读。
     * @param {string} id @param {number} [grace]
     */
    follow(id, grace = 0) {
      if (grace > 0) {
        if (!timers.has(id)) {
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              this.follow(id);
            }, grace),
          );
        }
        return;
      }
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(id);
      }
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
  /** 已读到的末尾几条，watch 推来的消息接在后面。 @type {Map<string, any[]>} */
  const tails = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const soon = new Map();
  /** @type {Map<string, { segment: number, messages: number }>} */
  const queue = new Map();
  /** @type {Set<string>} */
  const titleQueue = new Set();
  /** @type {Set<string>} */
  const titleDone = new Set();
  /** 等着的那一次要用的最新 self。 @type {Map<string, import("./lib/types.js").Self>} */
  const latest = new Map();
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
        return r.type === "end" || r.type === "error";
      });
    } catch {
      // 下次再试。
    }
    if (!ok) return;
    have.set(id, want);
    tails.set(id, msgs);
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
    /**
     * 这个进程的状态变了，需要的话排队读末尾。`grace` 毫秒：先等一等，那期间 watch 推来的消息（`push`）接得上就不读。
     * @param {import("./lib/types.js").Self} self @param {number} [grace]
     */
    note(self, grace = 0) {
      if (grace > 0) {
        if (!soon.has(self.id)) {
          soon.set(
            self.id,
            setTimeout(() => {
              soon.delete(self.id);
              const last = latest.get(self.id);
              if (last) this.note(last);
            }, grace),
          );
        }
        latest.set(self.id, self);
        return;
      }
      const h = have.get(self.id);
      if (h && h.segment === self.segment && h.messages === self.messages) return;
      queue.set(self.id, { segment: self.segment, messages: self.messages });
      pump();
    },
    /**
     * watch 推来一条追加的消息：正好接在已读的末尾后面就并进去，不用再读。新段的第 0 条总是接得上。
     * @param {string} id @param {{ segment: number, seq: number, message: any }} r
     */
    push(id, r) {
      const h = have.get(id);
      const prev = h && h.segment === r.segment && h.messages === r.seq ? (tails.get(id) ?? []) : r.seq === 0 && (!h || r.segment > h.segment) ? [] : null;
      if (prev === null) return;
      const msgs = [...prev, r.message].slice(-TAIL);
      have.set(id, { segment: r.segment, messages: r.seq + 1 });
      tails.set(id, msgs);
      io.onPeek(id, { segment: r.segment, total: r.seq + 1, msgs, lastAt: r.message.timestamp ?? null });
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
      tails.delete(id);
      queue.delete(id);
      latest.delete(id);
      const t = soon.get(id);
      if (t !== undefined) clearTimeout(t);
      soon.delete(id);
    },
  };
}
