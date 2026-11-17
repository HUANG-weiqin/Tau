// 删除的确认框（设计稿 7.7）：删进程、删空预设。贴着点的按钮或行，不进地址栏的 #。
import { html, Popover, DlgHead, Pill, useState, useEffect, Fragment } from "./common.js";
import { removeBlock, removeBlockText } from "../lib/remove.js";
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

/** @param {{ title: string, sub?: string, onClose: () => void, children?: any, foot: (close: () => void) => any, rect: Rect | null, label: string }} p */
function Box({ title, sub, onClose, children, foot, rect, label }) {
  return html`<${Popover} rect=${rect} onClose=${onClose} label=${label} width=${460} est=${300}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="trash" title=${title} en="DELETE" sub=${sub} onClose=${close} />
      <div class="dlg-body">${children}</div>
      <div class="dlg-foot"><span class="cmdline"></span>${foot(close)}</div>
    </${Fragment}>`}
  </${Popover}>`;
}

/** @param {{ app: import("../app.js").App, id: string, rect: Rect | null, onClose: () => void }} p */
function RemoveBox({ app, id, rect, onClose }) {
  const e = app.byId[id];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 进程没了（删成功了，或者别处删了）就收起来。
  useEffect(() => {
    if (!app.store.procs[id]) onClose();
  });
  const block = removeBlock(id, Object.values(app.store.procs).map((p) => p.self));
  const reason = block ? removeBlockText(block) : "";
  const title = app.titleOf(id).title;
  const who = e ? (e.kind === "temp" ? title : e.name) : id;

  const go = async (/** @type {() => void} */ close) => {
    if (block || busy) return;
    setBusy(true);
    setErr("");
    try {
      // 临时进程先缓存标题：从它分叉出来的进程沿用这个标题。
      if (e?.kind === "temp") await cacheTitles(app, [id]);
      await app.remove(id);
      close();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  };

  return html`<${Box} rect=${rect} onClose=${onClose} label="删除进程" title="删除进程" sub=${id}
    foot=${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${Pill} label="取消" onClick=${close} />
      <${Pill} kind="warn" icon="trash" label=${busy ? "删除中" : "删除"} disabled=${!!block || busy} onClick=${() => go(close)} />
    </${Fragment}>`}>
    <p style="margin:0;font-size:15px;font-weight:900;overflow-wrap:anywhere">${who}</p>
    <p class="mono dim" style="margin:0">${id}</p>
    <p class="dnote" style="color:var(--fg)">当前段有 ${e?.self.messages ?? 0} 条消息。删了找不回。记忆不动。</p>
    ${reason !== "" && html`<div class="callout" role="status" style="box-shadow:inset 3px 0 0 var(--warn)">${reason}</div>`}
    ${err !== "" && html`<div class="callout" role="alert" style="box-shadow:inset 3px 0 0 var(--warn)">服务拒绝了：${err}</div>`}
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
