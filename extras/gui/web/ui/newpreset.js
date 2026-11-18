// 新预设：给聚焦的项目再加一个预设（设计稿 7.6）。工作目录固定是项目的文件夹。初始只问几样，其余折在“更多设置”里。
import { html, Popover, DlgHead, Pill, useState, useRef, Fragment } from "./common.js";
import { pathKey } from "../lib/state.js";
import { suggestId } from "../lib/models.js";
import { CheckStrip, PresetFields, usePresetForm } from "./presetform.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function NewPresetDialog({ app, onClose }) {
  const project = app.project;
  const key = project?.key ?? "";
  const mine = app.presetList.filter((p) => p.ok && p.id !== app.gui.chief && pathKey(p.workdir) === key);
  const model = mine.flatMap((p) => (p.ok ? [p.model] : []))[0];
  // 项目里还没有预设：ID 没填就取文件夹名。
  const suggest = project && mine.length === 0 ? suggestId(project.path) : "";
  const form = usePresetForm({ app, ...(model !== undefined ? { model } : {}), ...(project ? { workdir: project.path } : {}), ...(suggest !== "" ? { suggest } : {}) });
  const extra = form.create();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** 从新进程弹窗来的，建好以后回到它，选中新建的预设。 */
  const back = /** @type {boolean} */ (app.dialog?.props?.back === true);
  const after = useRef(/** @type {(() => void) | null} */ (null));
  const can = !!project && form.valid(app.presets) && extra.ok && !busy;

  const go = async (/** @type {() => void} */ close) => {
    if (!can || !project || !extra.ok) return;
    setBusy(true);
    const id = form.idFinal;
    try {
      await app.createPreset({ id, workdir: project.path, model: form.model.trim(), tools: form.tools, prompt: form.prompt, ...extra.fields });
      app.rememberModel(form.model.trim()).catch(() => {});
      const shown = name.trim();
      if (shown !== "") {
        try {
          await app.setGui((g) => ({ names: { ...g.names, [id]: shown } }));
        } catch {
          // 提示已经弹了；预设建好了，只是显示名没记上，之后显示预设 ID。
        }
      }
      if (back) after.current = () => app.openDialog("newproc", null, { preset: id });
      close();
    } catch {
      setBusy(false);
    }
  };

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${() => { onClose(); after.current?.(); }} label="新预设" width=${660} est=${620}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="plus" title="新预设" en="NEW PRESET" sub=${project ? `加到 ${project.name}` : "还没有项目"} onClose=${close} />
      <div class="dlg-body">
        <${PresetFields} form=${form} app=${app} compact placeholder="例如 render" promptHint="这个预设的 Agent 是做什么的"
          idExtra=${html`<label class="field">显示名（可以不填，只在界面上用）<input class="input" type="text" value=${name} placeholder="例如 渲染" maxlength="24" onInput=${(/** @type {any} */ e) => setName(e.currentTarget.value)} /></label>`} />
        <${CheckStrip} ok=${false} text=${extra.ok ? null : extra.error} label="input" />
      </div>
      <div class="dlg-foot">
        <span class="cmdline">写入 ~/.tau/presets/${form.idFinal || "<ID>"}.md</span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="accent" icon="arrow" label=${busy ? "建立中" : "建预设"} disabled=${!can} onClick=${() => go(close)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
