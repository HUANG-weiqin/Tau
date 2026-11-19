// @ts-check
// 界面数据文件的读法和改法。改法都回一个补丁：顶层键整个覆盖进文件（`/api/state` 的 `set`）。
/** @typedef {import("./types.js").GuiState} GuiState */
import { LEVELS } from "./models.js";

export const MAX_PINNED = 9;
export const DEFAULT_CLEAN_DAYS = 7;

/** @param {unknown} v @returns {Record<string, any>} */
function obj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};
}

/** @param {unknown} v @returns {string[]} */
function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * 文件里的内容补上默认值，坏的键当没有。
 * @param {unknown} raw
 * @returns {GuiState}
 */
export function normalizeState(raw) {
  const r = obj(raw);
  /** @param {unknown} v @param {(x: unknown) => boolean} ok */
  const rec = (v, ok) => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => ok(x)));
  const days = r["cleanDays"];
  return {
    ...(typeof r["chief"] === "string" && r["chief"] !== "" ? { chief: r["chief"] } : {}),
    names: rec(r["names"], (x) => typeof x === "string"),
    current: rec(r["current"], (x) => typeof x === "string"),
    folders: strings(r["folders"]),
    pinned: strings(r["pinned"]),
    short: rec(r["short"], (x) => typeof x === "string"),
    mine: strings(r["mine"]),
    forkedFrom: rec(r["forkedFrom"], (x) => typeof x === "string"),
    titles: rec(r["titles"], (x) => typeof x === "string"),
    titled: strings(r["titled"]),
    collapsed: rec(r["collapsed"], (x) => typeof x === "boolean"),
    recentModels: strings(r["recentModels"]),
    ...(typeof r["defaultModel"] === "string" && r["defaultModel"] !== "" ? { defaultModel: r["defaultModel"] } : {}),
    ...(typeof r["defaultThinking"] === "string" && LEVELS.includes(r["defaultThinking"]) ? { defaultThinking: r["defaultThinking"] } : {}),
    ...(typeof r["titleModel"] === "string" && r["titleModel"] !== "" ? { titleModel: r["titleModel"] } : {}),
    ...(r["notify"] === true ? { notify: true } : {}),
    ...(r["theme"] === "night" || r["theme"] === "vscode" ? { theme: r["theme"] } : {}),
    cleanDays: typeof days === "number" && Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_CLEAN_DAYS,
  };
}

/**
 * 路径比较用的键：不分大小写，斜杠统一，去掉末尾的斜杠。
 * @param {string} p
 */
export function pathKey(p) {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return (s === "" ? p : s).toLowerCase();
}

/** 把预设 `id` 的当前进程设为 `pid`。 @param {GuiState} s @param {string} id @param {string} pid */
export function setCurrent(s, id, pid) {
  return { current: { ...s.current, [id]: pid } };
}

/** 记下界面建的进程。 @param {GuiState} s @param {string} pid */
export function addMine(s, pid) {
  return s.mine.includes(pid) ? { mine: s.mine } : { mine: [...s.mine, pid] };
}

/** 记下界面分叉出的进程。 @param {GuiState} s @param {string} pid @param {string} source */
export function addFork(s, pid, source) {
  return { forkedFrom: { ...s.forkedFrom, [pid]: source }, ...addMine(s, pid) };
}

/** 钉住一个文件夹。已经钉了或者满 9 个，原样。 @param {GuiState} s @param {string} path */
export function pinFolder(s, path) {
  const k = pathKey(path);
  if (s.pinned.some((p) => pathKey(p) === k) || s.pinned.length >= MAX_PINNED) return { pinned: s.pinned };
  return { pinned: [...s.pinned, path] };
}

/** @param {GuiState} s @param {string} path */
export function unpinFolder(s, path) {
  const k = pathKey(path);
  return { pinned: s.pinned.filter((p) => pathKey(p) !== k) };
}

/** 钉住的顺序里挪一格，`delta` 是 -1 或 1。到头了原样。 @param {GuiState} s @param {string} path @param {number} delta */
export function movePinned(s, path, delta) {
  const k = pathKey(path);
  const from = s.pinned.findIndex((p) => pathKey(p) === k);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= s.pinned.length) return { pinned: s.pinned };
  const next = s.pinned.slice();
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return { pinned: next };
}

/** 记下打开过的文件夹。 @param {GuiState} s @param {string} path */
export function addFolder(s, path) {
  const k = pathKey(path);
  return s.folders.some((p) => pathKey(p) === k) ? { folders: s.folders } : { folders: [...s.folders, path] };
}

/**
 * 已经不在的进程，从界面数据里清掉它们的键，回补丁（没有要清的就是空补丁）。
 * 被还在的分叉指着的标题留着：删了源进程，分叉出来的进程还要用它。
 * @param {GuiState} g
 * @param {(id: string) => boolean} stale
 * @returns {Record<string, unknown>}
 */
export function prunePatch(g, stale) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  /** @param {Record<string, any>} r @param {(k: string, v: any) => boolean} drop */
  const filt = (r, drop) => Object.fromEntries(Object.entries(r).filter(([k, v]) => !drop(k, v)));
  const used = new Set(Object.entries(g.forkedFrom).flatMap(([k, v]) => (stale(k) ? [] : [v])));
  if (Object.keys(g.forkedFrom).some(stale)) patch["forkedFrom"] = filt(g.forkedFrom, (k) => stale(k));
  if (Object.keys(g.titles).some((k) => stale(k) && !used.has(k))) patch["titles"] = filt(g.titles, (k) => stale(k) && !used.has(k));
  if (g.titled.some(stale)) patch["titled"] = g.titled.filter((x) => !stale(x));
  if (g.mine.some(stale)) patch["mine"] = g.mine.filter((x) => !stale(x));
  if (Object.values(g.current).some(stale)) patch["current"] = filt(g.current, (_k, v) => stale(v));
  return patch;
}
