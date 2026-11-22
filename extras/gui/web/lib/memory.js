// 记忆页的纯函数：排序、折叠预览、编辑状态、写回复的判读、版本冲突的处理。
// 协议的格式见 .knowledge/kb-service.md 的“读写记忆”。值只能是字符串。

/**
 * `updated` 是毫秒数，`brief` 是模型写这一条时给的一句话摘要。
 * @typedef {{ key: string, value: string, brief: string, updated: number, version: number }} Entry
 * 一次编辑：`base` 是写入时带的版本号（新键、或别处把它删了以后是 null），`orig`、`origBrief` 是开始编辑时的值和摘要，
 * `other` 是写冲突后重读到的别处的值和摘要（`gone` 为真表示别处把它删了）。
 * @typedef {{ key: string, draft: string, brief: string, base: number | null, isNew: boolean, orig: string, origBrief: string, other?: { value: string, brief: string } | { gone: true } }} Edit
 */

const enc = new TextEncoder();

/** 键的 UTF-8 字节序，和服务给的顺序一致。 @param {string} a @param {string} b */
export function byKeyBytes(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return /** @type {number} */ (x[i]) - /** @type {number} */ (y[i]);
  return x.length - y.length;
}

/** @param {readonly Entry[]} entries @returns {Entry[]} */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => byKeyBytes(a.key, b.key));
}

/** UTF-8 字节数。 @param {string} s */
export const utf8Bytes = (s) => enc.encode(s).length;

const PREVIEW_CHARS = 80;

/** 值要不要折起来：多行，或者长。 @param {string} value */
export function isLong(value) {
  return value.includes("\n") || [...value].length > PREVIEW_CHARS;
}

/** 折起来时看到的：第一行，太长截断。 @param {string} value */
export function preview(value) {
  const first = value.split("\n")[0] ?? "";
  const chars = [...first];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : first;
}

/** 毫秒数成本地时区的 YYYY-MM-DD。 @param {number} ms */
export function dayOf(ms) {
  const d = new Date(ms);
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** @param {Entry} entry @returns {Edit} */
export function editOf(entry) {
  return { key: entry.key, draft: entry.value, brief: entry.brief, base: entry.version, isNew: false, orig: entry.value, origBrief: entry.brief };
}

/** @returns {Edit} */
export function newEdit() {
  return { key: "", draft: "", brief: "", base: null, isNew: true, orig: "", origBrief: "" };
}

/**
 * 这次编辑有没有要保存的东西。摘要改了也算。
 * @param {Edit} e
 */
export function editDirty(e) {
  if (e.other) return "gone" in e.other ? true : e.draft !== e.other.value || e.brief !== e.other.brief;
  return e.isNew ? true : e.draft !== e.orig || e.brief !== e.origBrief;
}

/**
 * 保存前能在页面上查出来的错。没有错是 null。
 * 键、值、摘要的字节上限由服务查，这里不抄一份。
 * @param {Edit} e @param {readonly Entry[]} entries
 * @returns {string | null}
 */
export function editError(e, entries) {
  if (e.key === "") return "键不能为空";
  if (e.isNew && e.brief.trim() === "") return "摘要不能为空";
  if (e.isNew && entries.some((x) => x.key === e.key)) return "已经有这个键了，去改它";
  return null;
}

/** 保存总是带 `brief`：不带，服务会用值的前 200 字节，把模型写的摘要冲掉。 @param {string} ns @param {Edit} e */
export function setOp(ns, e) {
  return { kind: "set", ns, key: e.key, value: e.draft, brief: e.brief, expected: e.base };
}

/** @param {string} ns @param {Entry} entry */
export function deleteOp(ns, entry) {
  return { kind: "delete", ns, key: entry.key, expected: entry.version };
}

/**
 * 读 `memory_write` 的回复。
 * @param {any} reply
 * @returns {{ kind: "ok", version: number | null } | { kind: "conflict", current: { value: string, brief: string, updated: number, version: number } | null } | { kind: "over", over: "key" | "value" | "view", bytes: number } | { kind: "unknown" }}
 */
export function interpretWrite(reply) {
  if (reply && reply.type === "memory_written") return { kind: "ok", version: reply.versions?.[0] ?? null };
  if (reply && reply.type === "memory_rejected" && reply.result) {
    const r = reply.result;
    if ("current" in r) return { kind: "conflict", current: r.current ?? null };
    if (typeof r.over === "string") return { kind: "over", over: r.over, bytes: r.bytes };
  }
  return { kind: "unknown" };
}

/**
 * 写冲突以后的编辑：用户写的值和摘要原样留着，版本号换成别处现在的，把别处现在的值和摘要放进 `other` 给他对照。
 * 版本号换了，再按保存就是他决定覆盖；别处把键删了（`current` 为 null），保存就重建它。
 * 新键撞上别处刚建的同名键时，它就成了改已有的键，不再按“新键”查重。
 * @param {Edit} e @param {{ value: string, brief: string, updated: number, version: number } | null} current
 * @returns {Edit}
 */
export function afterConflict(e, current) {
  return { ...e, isNew: current ? false : e.isNew, base: current ? current.version : null, other: current ? { value: current.value, brief: current.brief } : { gone: true } };
}

/** 超出上限的说明。上限的数在服务那边，页面只说哪一项、多少字节。 @param {"key" | "value" | "view"} over @param {number} bytes */
export function overText(over, bytes) {
  if (over === "key") return `键太长，${bytes} 字节，超出记忆库的上限`;
  if (over === "value") return `值太长，${bytes} 字节，超出记忆库的上限`;
  if (over === "view") return `写进去以后整个库有 ${bytes} 字节，超出记忆库的上限。先删掉一些，或者把值写短`;
  return `有一项超出记忆库的上限（${bytes} 字节）`;
}
