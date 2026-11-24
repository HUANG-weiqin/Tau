// @ts-check
// 一个进程的消息缓存，按段号分开，和增量读 `history` 的计划。
// 用法：`noteSelf` 记下最新的 self，`plan` 问下一步读什么，读到的回复交给 `applyMessage` 和 `applyEnd`。
// 同一个进程同一时刻只发一个 `history` 请求；回复回来再 `plan`，直到回 null。
/** @typedef {import("./types.js").Self} Self */
/** @typedef {import("./types.js").Message} Message */

/**
 * `sealed`：这一段已经不是当前段，并且在它不是当前段以后完整读过一遍。
 * @typedef {{ msgs: Message[], total: number | null, sealed: boolean }} SegCache
 */
/** @typedef {{ followed: number | null, segs: Record<number, SegCache> }} History */
/** 下一次要发的 `history` 请求。`sealed`：规划时这一段已经不是当前段，读完的 `end` 才算数。 @typedef {{ segment: number, from: number, sealed: boolean }} HistoryPlan */

/** @returns {History} */
export function emptyHistory() {
  return { followed: null, segs: {} };
}

/** 已经连续读到的条数。 @param {History} h @param {number} segment */
export function known(h, segment) {
  return h.segs[segment]?.msgs.length ?? 0;
}

/** @param {History} h @param {number} segment @returns {Message[]} */
export function segmentMessages(h, segment) {
  return h.segs[segment]?.msgs ?? [];
}

/** 这一段最后一条消息的时间戳。没有时是 null。 @param {History} h @param {number} segment @returns {number | null} */
export function lastTimestamp(h, segment) {
  const msgs = h.segs[segment]?.msgs ?? [];
  return msgs[msgs.length - 1]?.timestamp ?? null;
}

/** @returns {SegCache} */
function blank() {
  return { msgs: [], total: null, sealed: false };
}

/**
 * 记下最新的 self。段号变大时，旧段里以前读到的结尾不再算数：它是在旧段还在长的时候读的。
 * @param {History} h
 * @param {Self} self
 * @returns {History}
 */
export function noteSelf(h, self) {
  if (h.followed !== null && self.segment < h.followed) return h;
  const segs = { ...h.segs };
  if (!segs[self.segment]) segs[self.segment] = blank();
  // 段号跳了不止一段（断开期间换了几次段）：中间的段补上空条目，`plan` 会按旧段读完。
  if (h.followed !== null) for (let s = h.followed + 1; s < self.segment; s++) if (!segs[s]) segs[s] = blank();
  return { followed: self.segment, segs };
}

/**
 * 下一个要读的请求。先把旧段读完（从已知的条数起，`end` 给总数），再读当前段新增的部分。
 * @param {History} h
 * @param {Self} self
 * @returns {HistoryPlan | null}
 */
export function plan(h, self) {
  const followed = h.followed ?? self.segment;
  const olds = Object.keys(h.segs)
    .map(Number)
    .filter((s) => s < followed && !h.segs[s]?.sealed)
    .sort((a, b) => a - b);
  const old = olds[0];
  if (old !== undefined) return { segment: old, from: known(h, old), sealed: true };
  if (self.segment === followed && known(h, followed) < self.messages) return { segment: followed, from: known(h, followed), sealed: false };
  return null;
}

/**
 * 读到一条消息。`seq` 说了算：重复的覆盖，不重复追加；跳号的丢掉，缓存永远是从 0 起连续的。
 * @param {History} h
 * @param {{ segment: number, seq: number, message: Message }} reply
 * @returns {History}
 */
export function applyMessage(h, reply) {
  const cur = h.segs[reply.segment] ?? blank();
  if (reply.seq > cur.msgs.length) return h;
  const msgs = cur.msgs.slice();
  msgs[reply.seq] = reply.message;
  return { ...h, segs: { ...h.segs, [reply.segment]: { ...cur, msgs } } };
}

/**
 * 一次 history 请求读到的一批消息，从 `from` 起。结果和对 `msgs` 逐条 `applyMessage`（seq = from + i）完全一样：
 * `from` 超过已有条数就原样返回；否则覆盖 [from, from + msgs.length)，后面已有的留着。
 * @param {History} h
 * @param {number} segment
 * @param {number} from
 * @param {Message[]} msgs
 * @returns {History}
 */
export function applyMessages(h, segment, from, msgs) {
  const cur = h.segs[segment] ?? blank();
  if (msgs.length === 0 || from > cur.msgs.length) return h;
  const merged = [...cur.msgs.slice(0, from), ...msgs, ...cur.msgs.slice(from + msgs.length)];
  return { ...h, segs: { ...h.segs, [segment]: { ...cur, msgs: merged } } };
}

/**
 * 一次读完。`request` 是发出这次读的计划。旧段读到末尾才封住。
 * @param {History} h
 * @param {{ segment: number, messages: number }} reply
 * @param {HistoryPlan} request
 * @returns {History}
 */
export function applyEnd(h, reply, request) {
  const cur = h.segs[reply.segment] ?? blank();
  const sealed = request.sealed && cur.msgs.length >= reply.messages;
  return { ...h, segs: { ...h.segs, [reply.segment]: { ...cur, total: reply.messages, sealed: cur.sealed || sealed } } };
}

/**
 * 读不到这一段（例如已被 `prune` 删掉）：不再重试。当前段不受影响。
 * @param {History} h
 * @param {number} segment
 * @returns {History}
 */
export function giveUp(h, segment) {
  const cur = h.segs[segment];
  if (!cur || h.followed === null || segment >= h.followed) return h;
  return { ...h, segs: { ...h.segs, [segment]: { ...cur, sealed: true } } };
}

/**
 * `watch` 带 `messages: true` 推来的追加消息。先 `noteSelf`（`update` 总在它前面，段号已经变了的话先记下），
 * 再只收正好接在后面的一条：已有的（重连后重读和推送重叠）丢掉，跳号的（漏了几条）也丢掉，留给 `plan` 用 `history` 补。
 * 不认识的段（没读过、已经是旧段之外的）也丢掉。没有变化时返回原对象。
 * @param {History} h
 * @param {Self} self 这个进程最新的 self
 * @param {{ segment: number, seq: number, message: Message }} reply
 * @returns {History}
 */
export function applyPushed(h, self, reply) {
  const noted = noteSelf(h, self);
  const cur = noted.segs[reply.segment];
  if (!cur || reply.seq !== cur.msgs.length) return noted;
  return { ...noted, segs: { ...noted.segs, [reply.segment]: { ...cur, msgs: [...cur.msgs, reply.message] } } };
}

/** 聚焦时先读段末尾这么多条消息当预览（条）。 */
export const PREVIEW = 40;

/**
 * 当前段末尾的预览：这一段第 `start` 条起、连续到读的那一刻段末的消息。
 * @typedef {{ segment: number, start: number, msgs: Message[] }} Preview
 */

/**
 * 去掉开头连着的工具结果：它们的调用在 `start` 之前，显示出来是“没有对应的调用”。全被去掉回 null。
 * @param {number} start
 * @param {Message[]} msgs
 * @returns {{ start: number, msgs: Message[] } | null}
 */
export function alignPreview(start, msgs) {
  let k = 0;
  while (k < msgs.length && msgs[k]?.role === "toolResult") k++;
  return k >= msgs.length ? null : { start: start + k, msgs: k === 0 ? msgs : msgs.slice(k) };
}

/**
 * watch 推来的消息正好接在预览末尾就并进去（新数组），否则原样返回。
 * @param {Preview} pv
 * @param {{ segment: number, seq: number, message: Message }} reply
 * @returns {Preview}
 */
export function pushPreview(pv, reply) {
  if (reply.segment !== pv.segment || reply.seq !== pv.start + pv.msgs.length) return pv;
  return { ...pv, msgs: [...pv.msgs, reply.message] };
}
