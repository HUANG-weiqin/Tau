// 新进程：只做一件事，写第一封信，等于 `tau start <预设> "<信>"`。预设是信框上面一行小按钮，默认选好（设计稿 7.2）。
import { html, Popover, DlgHead, Pill, useState, useRef, useEffect, Fragment, letterKey } from "./common.js";
import { pathKey } from "../lib/state.js";
import { defaultPreset } from "../lib/derive.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function NewProcDialog({ app, onClose }) {
  const project = app.project;
  const all = app.presetList.filter((p) => p.ok && p.id !== app.gui.chief && project && pathKey(p.workdir) === project.key);
  const asked = app.dialog?.props?.preset;
  /** 用户点过的预设；没点过，每次渲染都重算默认值：预设列表是打开以后才读到的。 */
  const [clicked, setClicked] = useState(/** @type {string | null} */ (null));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = clicked !== null && all.some((p) => p.id === clicked) ? clicked : defaultPreset(all, project?.entries ?? [], app.lastAt, asked);
  const sel = all.find((p) => p.id === chosen);
  const can = !!sel && text.trim() !== "" && !busy;
  // 预设列表是打开以后才读到的：信框晚于弹窗出现时，焦点补到它上面。
  const box = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  useEffect(() => {
    if (sel) box.current?.focus();
  }, [sel !== undefined]);
  const shared = sel && sel.ok && sel.memory ? app.entries.filter((e) => e.preset === sel.id).length : 0;
  const nameOf = (/** @type {string} */ id) => app.gui.names[id] ?? id;

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
  const newPreset = (/** @type {Event} */ e) => app.openDialog("newpreset", /** @type {Element} */ (e.currentTarget), { back: true });

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="新进程" width=${560} est=${all.length === 0 ? 260 : 340}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="plus" title="新进程" en="NEW PROCESS" sub=${project ? `在 ${project.name}` : "还没有项目"} onClose=${close} />
      ${all.length === 0
        ? html`<div class="dlg-body"><div class="callout">${project ? "这个项目还没有预设。开进程前要先建一个。" : "先打开一个项目。"}</div></div>
          <div class="dlg-foot">
            <span class="cmdline"></span>
            <${Pill} label="取消" onClick=${close} />
            ${project && html`<${Pill} kind="accent" icon="plus" label="新建预设" onClick=${newPreset} />`}
          </div>`
        : html`<div class="dlg-body">
            <div class="usewho">
              <span>预设</span>
              <div class="toggles" role="group" aria-label="用哪个预设">
                ${all.map((p) => html`<button type="button" key=${p.id} class="toggle" aria-pressed=${chosen === p.id} onClick=${() => setClicked(p.id)}>${nameOf(p.id)}${p.ok && !p.memory ? " · 临时" : ""}</button>`)}
              </div>
            </div>
            ${shared > 0 && html`<p class="dnote" style="margin-top:-8px">已有 ${shared} 个进程，新进程和它们共用记忆。</p>`}
            <textarea ref=${box} class="letter-in" rows="4" placeholder=${`给 ${sel ? nameOf(sel.id) : "它"} 的第一封信`} value=${text} autofocus
              onInput=${(/** @type {any} */ e) => setText(e.currentTarget.value)}
              onKeyDown=${(/** @type {KeyboardEvent} */ e) => letterKey(e, () => go(close), setText)}></textarea>
            <p class="dnote" style="margin-top:-8px;font-size:12px">Enter 开始，Ctrl+Enter 换行。</p>
          </div>
          <div class="dlg-foot">
            <span class="cmdline"></span>
            <${Pill} label="取消" onClick=${close} />
            <${Pill} kind="accent" label=${busy ? "开始中" : "开始"} icon="arrow" disabled=${!can} onClick=${() => go(close)} />
          </div>`}
    </${Fragment}>`}
  </${Popover}>`;
}
