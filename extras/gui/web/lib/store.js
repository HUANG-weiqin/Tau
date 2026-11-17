// @ts-check
// 线协议回复的 reducer。不读时钟：时间由调用方传入。
/** @typedef {import("./types.js").Self} Self */
/** @typedef {import("./types.js").Reply} Reply */

/**
 * 一个进程在页面里的记录。`createdAt` 和 `segmentStartedAt` 是按页面的时钟推算的：
 * 投影只给时长，不给时刻，服务的时钟和页面的可能不同。
 * @typedef {{ self: Self, createdAt: number, segmentStartedAt: number | null, seenAt: number }} ProcRecord
 */
/** @typedef {{ procs: Record<string, ProcRecord>, text: Record<string, { n: number, text: string }> }} Store */

/** @returns {Store} */
export function emptyStore() {
  return { procs: {}, text: {} };
}

/**
 * @param {Self} self
 * @param {number} clientNow
 * @returns {ProcRecord}
 */
function record(self, clientNow) {
  return { self, createdAt: clientNow - self.age, segmentStartedAt: self.segmentAge === null ? null : clientNow - self.segmentAge, seenAt: clientNow };
}

/**
 * 流式文本只在等模型时有意义：离开 `awaitingModel` 就清掉。
 * @param {Store["text"]} text
 * @param {Record<string, ProcRecord>} procs
 * @returns {Store["text"]}
 */
function pruneText(text, procs) {
  /** @type {Store["text"]} */
  const out = {};
  for (const [id, t] of Object.entries(text)) {
    const p = procs[id];
    if (p && p.self.phase.tag === "awaitingModel") out[id] = t;
  }
  return out;
}

/**
 * 处理一条回复，返回新的 store。不认识的回复原样返回。
 * @param {Store} store
 * @param {Reply} reply
 * @param {number} clientNow 页面收到它的时刻
 * @returns {Store}
 */
export function reduce(store, reply, clientNow) {
  switch (reply.type) {
    case "ps": {
      /** @type {Record<string, ProcRecord>} */
      const procs = {};
      for (const p of reply.processes) procs[p.self.id] = record(p.self, clientNow);
      return { procs, text: pruneText(store.text, procs) };
    }
    case "update": {
      const procs = { ...store.procs, [reply.self.id]: record(reply.self, clientNow) };
      const text = store.text[reply.self.id] && reply.self.phase.tag !== "awaitingModel" ? omit(store.text, reply.self.id) : store.text;
      return { procs, text };
    }
    case "removed": {
      if (!store.procs[reply.process] && !store.text[reply.process]) return store;
      return { procs: omit(store.procs, reply.process), text: omit(store.text, reply.process) };
    }
    case "text": {
      const cur = store.text[reply.process];
      // 编号变大：新的一次调用，从头来；变小：过时的，丢掉。
      if (cur && reply.n < cur.n) return store;
      const next = cur && cur.n === reply.n ? { n: cur.n, text: cur.text + reply.delta } : { n: reply.n, text: reply.delta };
      return { procs: store.procs, text: { ...store.text, [reply.process]: next } };
    }
    default:
      return store;
  }
}

/**
 * 正在流式输出的文字。进程不在等模型时是空串。
 * @param {Store} store
 * @param {string} id
 * @returns {string}
 */
export function streamingText(store, id) {
  const p = store.procs[id];
  if (!p || p.self.phase.tag !== "awaitingModel") return "";
  return store.text[id]?.text ?? "";
}

/**
 * @template T
 * @param {Record<string, T>} obj
 * @param {string} key
 * @returns {Record<string, T>}
 */
function omit(obj, key) {
  const { [key]: _gone, ...rest } = obj;
  return rest;
}

/** 全部进程记录，按 ID 排序。 @param {Store} store @returns {ProcRecord[]} */
export function allProcs(store) {
  return Object.values(store.procs).sort((a, b) => (a.self.id < b.self.id ? -1 : a.self.id > b.self.id ? 1 : 0));
}

/**
 * 按 `parent` 数每个进程开的进程个数（含空闲的）。`update` 只带 `self`，所以界面自己数。
 * @param {Store} store
 * @returns {Record<string, number>}
 */
export function childCounts(store) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const { self } of Object.values(store.procs)) {
    if (self.parent !== undefined) out[self.parent] = (out[self.parent] ?? 0) + 1;
  }
  return out;
}
