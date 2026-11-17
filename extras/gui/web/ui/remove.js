// 删除的确认框（设计稿 7.7）：删进程、删空预设。贴着点的按钮或行，不进地址栏的 #。
import { html, Popover, DlgHead, Pill, useState, useEffect, useRef, Fragment } from "./common.js";
import { removePlan, skippedFor } from "../lib/remove.js";
import { cacheTitles } from "./titlecache.js";

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */
/** @type {{ kind: "process" | "preset", id: string, rect: Rect | null } | null} */
let asking = null;
/** @type {Set<() => void>} */
const subs = new Set();
const emit = () => subs.forEach((f) => f());

/** @param {"process" | "preset"} kind @param {string} id @param {Element | null} anchor */
function ask(kind, id, anchor) {
  const r = anchor ? anchor.getBoundingClientRect() : null;
  asking = { kind, id, rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null };
  emit();
}

/** 删进程前先确认。 @param {string} id @param {Element | null} anchor */
export const askRemove = (id, anchor) => ask("process", id, anchor);
/** 删没有进程的预设前先确认。 @param {string} id @param {Element | null} anchor */
export const askDeletePreset = (id, anchor) => ask("preset", id, anchor);
/** 确认框开着时，全局快捷键不动。 */
export const confirmOpen = () => asking !== null;

/** @param {{ app: import("../app.js").App }} p */
export function ConfirmLayer({ app }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  if (!asking) return null;
  const close = () => {
    asking = null;
    emit();
  };
  const a = asking;
  return a.kind === "process" ? html`<${RemoveBox} key=${"p" + a.id} app=${app} id=${a.id} rect=${a.rect} onClose=${close} />` : html`<${DeletePresetBox} key=${"s" + a.id} app=${app} id=${a.id} rect=${a.rect} onClose=${close} />`;
}

/** @param {{ title: string, sub?: string, onClose: () => void, onClosing?: () => void, children?: any, foot: (close: () => void) => any, rect: Rect | null, label: string }} p */
function Box({ title, sub, onClose, onClosing, children, foot, rect, label }) {
  return html`<${Popover} rect=${rect} onClose=${onClose} onClosing=${onClosing} label=${label} width=${460} est=${300}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="trash" title=${title} en="DELETE" sub=${sub} onClose=${close} />
      <div class="dlg-body">${children}</div>
      <div class="dlg-foot"><span class="cmdline"></span>${foot(close)}</div>
    </${Fragment}>`}
  </${Popover}>`;
}

/**
 * 删的过程。开始删时一次性定下来：计划和显示名都是点按钮那一刻的快照，之后进程一个个消失，列表不跟着变。
 * @typedef {object} Run
 * @property {string[]} order 删除顺序，叶子在前。
 * @property {Record<string, number>} depth
 * @property {Record<string, string>} who 显示名。
 * @property {string[]} done
 * @property {{ id: string, reason: string }[]} refused
 * @property {string[]} skipped 有后代没删掉，跳过的祖先。
 * @property {string | null} at 正在删的。
 * @property {boolean} over
 */

/** 一行一个进程，按深度缩进。 @param {{ id: string, who: string, depth: number, mark: string, tone?: string }} p */
function TreeRow({ id, who, depth, mark, tone = "dim" }) {
  return html`<li style=${`display:flex;gap:8px;align-items:baseline;padding:2px 0 2px ${depth * 16}px`}>
    <span class="dim" aria-hidden="true">${depth > 0 ? "↳" : "·"}</span>
    <span style="flex:1;min-width:0;overflow-wrap:anywhere;font-weight:${depth === 0 ? 900 : 700}">${who} <span class="mono dim" style="font-weight:400">${id}</span></span>
    <span class=${tone === "warn" ? "" : tone} style=${tone === "warn" ? "color:var(--warn)" : ""}>${mark}</span>
  </li>`;
}

/** @param {{ app: import("../app.js").App, id: string, rect: Rect | null, onClose: () => void }} p */
function RemoveBox({ app, id, rect, onClose }) {
  const e = app.byId[id];
  /** @type {[Run | null, (r: Run) => void]} */
  const [run, setRun] = useState(/** @type {Run | null} */ (null));
  // 框一开始关就停：删完手上这一个，不再往下删。留下的永远是一棵完整的树，因为从叶子删起。
  // 要在开始关的那一刻停，不能等卸载：离场动效的 160ms 里，本机的 remove 能删完一整棵树。
  const stopped = useRef(false);
  useEffect(() => () => void (stopped.current = true), []);
  const halt = () => void (stopped.current = true);
  // 还没开始删时，进程没了（别处删了）就收起来。开始以后，删的进度由 go 管，进程一个个消失是正常的。
  useEffect(() => {
    if (!run && !app.store.procs[id]) onClose();
  });
  const live = removePlan(id, Object.values(app.store.procs).map((p) => p.self));
  const whoOf = (/** @type {string} */ x) => {
    const en = app.byId[x];
    return en ? (en.kind === "temp" ? app.titleOf(x).title : en.name) : x;
  };

  const go = async (/** @type {() => void} */ close) => {
    if (run || live.running.length > 0) return;
    const plan = live;
    /** @type {Run} */
    let st = { order: plan.order, depth: plan.depth, who: Object.fromEntries(plan.order.map((x) => [x, whoOf(x)])), done: [], refused: [], skipped: [], at: null, over: false };
    setRun(st);
    // 临时进程，和被分叉指着的进程，先缓存标题：删了以后第 1 段就没了。
    const forked = new Set(Object.values(app.gui.forkedFrom));
    await cacheTitles(app, plan.order.filter((x) => app.byId[x]?.kind === "temp" || forked.has(x)));
    /** @type {Map<string, string>} */
    const refused = new Map();
    for (const x of plan.order) {
      if (stopped.current) return;
      if (skippedFor(plan.order, plan.parent, refused.keys()).includes(x)) continue;
      st = { ...st, at: x };
      setRun(st);
      if (app.store.procs[x]) {
        try {
          await app.remove(x);
        } catch (err) {
          refused.set(x, err instanceof Error ? err.message : String(err));
        }
      }
      if (!refused.has(x)) st = { ...st, done: [...st.done, x] };
      else st = { ...st, refused: [...st.refused, { id: x, reason: refused.get(x) ?? "" }] };
    }
    if (stopped.current) return;
    if (refused.size === 0) return close();
    setRun({ ...st, at: null, over: true, skipped: skippedFor(plan.order, plan.parent, refused.keys()) });
  };

  const shown = run ?? { order: live.order, depth: live.depth, who: Object.fromEntries(live.order.map((x) => [x, whoOf(x)])), done: [], refused: [], skipped: [], at: null, over: false };
  const total = shown.order.length;
  const refusedBy = Object.fromEntries(shown.refused.map((r) => [r.id, r.reason]));
  const markOf = (/** @type {string} */ x) => {
    if (shown.done.includes(x)) return ["已删", "dim"];
    if (x in refusedBy) return ["被拒绝", "warn"];
    if (shown.skipped.includes(x)) return ["跳过", "warn"];
    if (shown.at === x) return ["删除中", ""];
    if (run) return ["待删", "dim"];
    return live.running.includes(x) ? ["在跑", "warn"] : ["", "dim"];
  };
  const idle = !run || run.over;
  const nth = run && !run.over ? shown.done.length + shown.refused.length + (shown.at !== null && !shown.done.includes(shown.at) && !(shown.at in refusedBy) ? 1 : 0) : 0;
  const label = run && !run.over ? `删除中 ${nth}/${total}` : total > 1 ? `删除 ${total} 个` : "删除";

  return html`<${Box} rect=${rect} onClose=${onClose} onClosing=${halt} label="删除进程" title="删除进程" sub=${id}
    foot=${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${Pill} label=${run && !run.over ? "停止" : run ? "关闭" : "取消"} onClick=${close} />
      ${!(run && run.over) && html`<${Pill} kind="warn" icon="trash" label=${label} disabled=${live.running.length > 0 || !!run} onClick=${() => go(close)} />`}
    </${Fragment}>`}>
    <ul style="list-style:none;margin:0;padding:0;font-size:13px;max-height:240px;overflow:auto">
      ${[...shown.order].reverse().map((x) => {
        const [mark, tone] = markOf(x);
        return html`<${TreeRow} key=${x} id=${x} who=${shown.who[x] ?? x} depth=${shown.depth[x] ?? 0} mark=${mark} tone=${tone} />`;
      })}
    </ul>
    ${!run && html`<p class="dnote" style="color:var(--fg)">${total > 1 ? `连它开的进程一共删 ${total} 个，从最里面的删起。` : `当前段有 ${e?.self.messages ?? 0} 条消息。`}删了找不回。记忆不动。</p>`}
    ${!run && live.running.length > 0 && html`<div class="callout" role="status" style="box-shadow:inset 3px 0 0 var(--warn)">在跑的：${live.running.map((x) => `${shown.who[x] ?? x} ${x}`).join("、")}。先停止它们，再来删。这里不替你停。</div>`}
    ${run && !run.over && html`<p class="dnote" style="color:var(--fg)" role="status">删到第 ${nth} 个，共 ${total} 个。关掉这个框就停在删完手上这个。</p>`}
    ${run?.over && html`<p class="dnote" style="color:var(--fg)" role="status">删了 ${run.done.length} 个，没删掉 ${total - run.done.length} 个。</p>`}
    ${run?.over && run.refused.map((r) => html`<div class="callout" role="alert" key=${r.id} style="box-shadow:inset 3px 0 0 var(--warn)">${shown.who[r.id] ?? r.id} ${r.id} 被服务拒绝：${r.reason}</div>`)}
    ${run?.over && run.skipped.length > 0 && html`<div class="callout" role="status" style="box-shadow:inset 3px 0 0 var(--warn)">跳过了 ${run.skipped.map((x) => shown.who[x] ?? x).join("、")}：它们有开的进程没删掉。</div>`}
  </${Box}>`;
}

/** @param {{ app: import("../app.js").App, id: string, rect: Rect | null, onClose: () => void }} p */
function DeletePresetBox({ app, id, rect, onClose }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const used = app.entries.filter((e) => e.preset === id).length;
  const name = app.gui.names[id];

  const go = async (/** @type {() => void} */ close) => {
    if (used > 0 || busy) return;
    setBusy(true);
    setErr("");
    try {
      await app.deletePreset(id);
      close();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  };

  return html`<${Box} rect=${rect} onClose=${onClose} label="删除预设" title="删除预设" sub=${id}
    foot=${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${Pill} label="取消" onClick=${close} />
      <${Pill} kind="warn" icon="trash" label=${busy ? "删除中" : "删除"} disabled=${used > 0 || busy} onClick=${() => go(close)} />
    </${Fragment}>`}>
    <p style="margin:0;font-size:15px;font-weight:900;overflow-wrap:anywhere">${name ?? id}</p>
    <p class="mono dim" style="margin:0">~/.tau/presets/${id}.md</p>
    <p class="dnote" style="color:var(--fg)">只删这个预设文件。删了找不回。记忆库不动：以后用同一个 ID 建预设，记忆还在。</p>
    ${used > 0 && html`<div class="callout" role="status" style="box-shadow:inset 3px 0 0 var(--warn)">它还有 ${used} 个进程。先删掉它们。</div>`}
    ${err !== "" && html`<div class="callout" role="alert" style="box-shadow:inset 3px 0 0 var(--warn)">删不掉：${err}</div>`}
  </${Box}>`;
}
