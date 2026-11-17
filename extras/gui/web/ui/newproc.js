// 新进程：第一步选预设，第二步写第一封信，等于 `tau start <预设> "<信>"`。
import { html, Popover, DlgHead, SecHead, Pill, useState, Fragment, letterKey } from "./common.js";
import { pathKey } from "../lib/state.js";
import { clipText } from "../lib/messages.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function NewProcDialog({ app, onClose }) {
  const project = app.project;
  const all = app.presetList.filter((p) => p.ok && p.id !== app.gui.chief && project && pathKey(p.workdir) === project.key);
  const asked = app.dialog?.props?.preset;
  const [pick, setPick] = useState(/** @type {string | null} */ (asked && all.some((p) => p.id === asked) ? asked : null));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sel = all.find((p) => p.id === pick);
  const can = !!sel && text.trim() !== "" && !busy;

  const go = async (/** @type {() => void} */ close) => {
    if (!can || !sel) return;
    setBusy(true);
    try {
      await app.start(sel.id, text);
      close();
    } catch {
      setBusy(false);
    }
  };

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="新进程" width=${640} est=${560}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="plus" title="新进程" en="NEW PROCESS" sub=${project ? `在 ${project.name}` : "还没有项目"} onClose=${close} />
      <div class="dlg-body">
        <${SecHead} n="01" title="选预设" en="PRESET" right=${html`<span class="mono dim">工作目录是这个项目的 ${all.length} 个</span>`} />
        ${all.length === 0 && html`<div class="callout">${project ? "这个项目里还没有预设，先新建一个。" : "先打开一个项目。"}</div>`}
        <div class="pgrid">
          ${all.map((p) => {
            if (!p.ok) return null;
            const n = app.entries.filter((e) => e.preset === p.id).length;
            const on = pick === p.id;
            return html`<button type="button" key=${p.id} class=${`pcard ${p.memory ? "" : "temp"}`} aria-pressed=${on} onClick=${() => setPick(p.id)}>
              <span class="nm"><b>${app.gui.names[p.id] ?? p.id}</b>${app.gui.names[p.id] && html`<span class="mono">${p.id}</span>`}</span>
              <span class="tags"><span class="tag line">${p.memory ? "带记忆" : "不带记忆"}</span>${p.tools.filter((t) => t === "agents").map((t) => html`<span class="tag line">${t}</span>`)}</span>
              <span class="cnt">${n === 0 ? "还没有进程" : on && p.memory ? `已有 ${n} 个进程，会共用记忆` : `${n} 个进程`}</span>
            </button>`;
          })}
        </div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px">
          <p class="dnote" style="flex:1 1 260px">同一个预设能开好几个进程，它们共用这个预设的记忆库。要临时的，选不带记忆的。</p>
          <${Pill} label="新建预设" icon="ext" chip="gray" onClick=${(/** @type {Event} */ e) => app.openDialog("newpreset", /** @type {Element} */ (e.currentTarget), { back: true })} />
        </div>
        <${SecHead} n="02" title="第一封信" en="FIRST LETTER" />
        <textarea class="letter-in" rows="3" placeholder=${sel ? `给 ${app.gui.names[sel.id] ?? sel.id} 的第一封信` : "先选一个预设"} value=${text} disabled=${!sel}
          onInput=${(/** @type {any} */ e) => setText(e.currentTarget.value)}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => letterKey(e, () => go(close), setText)}></textarea>
        <p class="dnote" style="margin-top:-6px;font-size:12px">进程从这封信开始跑第一轮。内核建进程要两样：预设和第一封信。Enter 开始，Ctrl+Enter 换行。</p>
      </div>
      <div class="dlg-foot">
        <span class="cmdline">$ tau start ${sel?.id ?? "<预设>"} "${clipText(text.replace(/\s+/g, " "), 40) || "…"}"</span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="accent" label=${busy ? "开始中" : "开始"} icon="arrow" disabled=${!can} onClick=${() => go(close)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
