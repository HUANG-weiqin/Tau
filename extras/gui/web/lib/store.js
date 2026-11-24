// @ts-check
// 线协议回复的 reducer。不读时钟：时间由调用方传入。
/** @typedef {import("./types.js").Self} Self */
/** @typedef {import("./types.js").Reply} Reply */
/** @typedef {import("./stream.js").Live} Live */
import { appendDelta } from "./stream.js";

/**
 * 一个进程在页面里的记录。`createdAt` 和 `segmentStartedAt` 是按页面的时钟推算的：
 * 投影只给时长，不给时刻，服务的时钟和页面的可能不同。
 * @typedef {{ self: Self, createdAt: number, segmentStartedAt: number | null, seenAt: number }} ProcRecord
 */
/** @typedef {{ procs: Record<string, ProcRecord>, text: Record<string, Live> }} Store */

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
 * 流式文本只在两个阶段有意义：等模型时有正文和思考，等工具时有命令的实时输出（D88）。
 * 别的阶段没有，`ps` 重连时清掉。
 * @param {Store["text"]} text
 * @param {Record<string, ProcRecord>} procs
 * @returns {Store["text"]}
 */
function pruneText(text, procs) {
  /** @type {Store["text"]} */
  const out = {};
  for (const [id, t] of Object.entries(text)) {
    const tag = procs[id]?.self.phase.tag;
    if (tag === "awaitingModel" || tag === "awaitingTool") out[id] = t;
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
      // 等模型时留正文和思考，等工具时留命令的实时输出；回到空闲才清。
      const text = store.text[reply.self.id] && reply.self.phase.tag === "idle" ? omit(store.text, reply.self.id) : store.text;
      return { procs, text };
    }
    case "removed": {
      if (!store.procs[reply.process] && !store.text[reply.process]) return store;
      return { procs: omit(store.procs, reply.process), text: omit(store.text, reply.process) };
    }
    case "text": {
      // 按 kind 分开存、编号的规则见 lib/stream.js。
      const cur = store.text[reply.process];
      const next = appendDelta(cur, reply);
      if (next === cur || !next) return store;
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
 * 正在流式输出的全部内容：正文、思考、工具调用参数、命令的实时输出（D88）。进程不在等模型时是 null。
 * @param {Store} store
 * @param {string} id
 * @returns {Live | null}
 */
export function streamingLive(store, id) {
  const p = store.procs[id];
  if (!p || p.self.phase.tag !== "awaitingModel") return null;
  return store.text[id] ?? null;
}

/**
 * 一条 `text` 回复要不要引起重画。流式文字只有两处读：聚焦的进程，和总管弹窗开着时总管的进程。
 * `chiefPreset` 只在总管弹窗开着时给总管的预设 ID，否则是 null。别的进程的流式片段只并进 store。
 * @param {Store} store
 * @param {string} id 回复所属的进程
 * @param {{ focused: string | null, chiefPreset: string | null }} view
 * @returns {boolean}
 */
export function textShown(store, id, view) {
  if (id === view.focused) return true;
  return view.chiefPreset !== null && store.procs[id]?.self.preset === view.chiefPreset;
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

/**
 * 命令边跑边写的输出（D88）。进程不在等工具时是空串。
 * @param {Store} store
 * @param {string} id
 * @returns {string}
 */
export function streamingOutput(store, id) {
  const p = store.procs[id];
  if (!p || p.self.phase.tag !== "awaitingTool") return "";
  return store.text[id]?.output ?? "";
}
