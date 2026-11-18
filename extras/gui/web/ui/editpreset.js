// 改预设：和新建预设共用一张表。写完服务马上 check，读不出就改回去，错误原文写在底部的检查条里。
import { html, Popover, DlgHead, SecHead, Pill, useState, Fragment } from "./common.js";
import { CheckStrip, PresetFields, usePresetForm } from "./presetform.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function EditPresetDialog({ app, onClose }) {
  const id = /** @type {string} */ (app.dialog?.props?.preset ?? "");
  const found = app.presets[id];
  const orig = found && found.ok ? found : undefined;
  const form = usePresetForm({ app, ...(orig ? { orig } : {}) });
  const [busy, setBusy] = useState(false);
  /** 保存失败时服务回的原文。 */
  const [err, setErr] = useState(/** @type {string | null} */ (null));
  const draft = orig ? form.update() : { ok: /** @type {const} */ (false), error: "" };
  const changed = draft.ok && Object.keys(draft.patch).length > 0;
  const procs = app.entries.filter((e) => e.preset === id).length;
  const shown = app.gui.names[id] ?? id;

  const go = async (/** @type {() => void} */ close) => {
    if (!orig || !draft.ok || !changed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await app.updatePreset({ id, ...draft.patch });
      if (draft.patch["model"] !== undefined) app.rememberModel(form.model.trim()).catch(() => {});
      app.toast(`预设 ${id} 改好了。新出生的会话用新的，已有的会话不变`);
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // 检查条：保存失败写服务的原文，否则写这个预设现在读成什么样。
  const strip = err !== null ? { ok: false, text: err } : !draft.ok && orig ? { ok: false, text: draft.error } : found ? (found.ok ? { ok: true, text: "现在的文件能启动" } : { ok: false, text: found.error }) : { ok: false, text: `没有这个预设：${id}` };

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="改预设" width=${660} est=${720} class="editpreset">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="tau" title="改预设" en="EDIT PRESET" sub=${shown === id ? id : `${shown} · ${id}`} onClose=${close} />
      <div class="dlg-body">
        ${!orig
          ? html`<${Fragment}>
              <div class="callout">${found && !found.ok ? "这个预设现在读不出，界面不知道它的各个字段，没法改。请在编辑器里改 " : "找不到这个预设："}<span class="mono">~/.tau/presets/${id}.md</span></div>
              <${CheckStrip} ok=${false} text=${strip.text} />
            </${Fragment}>`
          : html`<${Fragment}>
              <p class="dnote" style="color:var(--fg)">改的是预设文件，只对新出生的会话生效。已经有的会话不变，要改它们，用详情栏概况页里的“改这个会话”。${procs > 0 ? `这个预设现在有 ${procs} 个进程。` : ""}</p>
              <${SecHead} n="01" title="预设" en="PRESET" right=${html`<span class="dnote" style="font-size:11px">工作目录 ${orig.workdir}</span>`} />
              <${PresetFields} form=${form} app=${app} />
              <${CheckStrip} ok=${strip.ok} text=${strip.text} />
            </${Fragment}>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline">${orig ? `写入 ~/.tau/presets/${id}.md，写完马上 check，读不出就改回去` : ""}</span>
        <${Pill} label=${orig ? "取消" : "关闭"} onClick=${close} />
        ${orig && html`<${Pill} kind="accent" icon="arrow" label=${busy ? "检查中" : changed ? "保存" : "没有改动"} disabled=${!draft.ok || !changed || busy} onClick=${() => go(close)} />`}
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
