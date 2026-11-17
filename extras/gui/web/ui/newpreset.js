// 新预设：给聚焦的项目再加一个预设（设计稿 7.6）。工作目录固定是项目的文件夹。
import { html, Popover, DlgHead, SecHead, Pill, useState, useRef, Fragment } from "./common.js";
import { pathKey } from "../lib/state.js";
import { DEFAULT_MODEL, PresetFields, usePresetForm } from "./presetform.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function NewPresetDialog({ app, onClose }) {
  const project = app.project;
  const key = project?.key ?? "";
  const mine = app.presetList.filter((p) => p.ok && p.id !== app.gui.chief && pathKey(p.workdir) === key);
  const model = mine.flatMap((p) => (p.ok ? [p.model] : []))[0] ?? DEFAULT_MODEL;
  const form = usePresetForm({ model });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** 从新进程弹窗来的，建好以后回到它，选中新建的预设。 */
  const back = /** @type {boolean} */ (app.dialog?.props?.back === true);
  const after = useRef(/** @type {(() => void) | null} */ (null));
  const can = !!project && form.valid(app.presets) && !busy;

  const go = async (/** @type {() => void} */ close) => {
    if (!can || !project) return;
    setBusy(true);
    const id = form.idFinal;
    try {
      await app.createPreset({ id, workdir: project.path, model: form.model.trim(), tools: form.tools, prompt: form.prompt });
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
        <p class="dnote" style="color:var(--fg)">同一个文件夹里的预设，界面都归到这个项目下。预设建好就能开进程。</p>
        <${SecHead} n="01" title="工作目录" en="WORKDIR" />
        <div class="pathrow"><input class="input mono" type="text" value=${project?.path ?? ""} readonly aria-label="工作目录，不能改" style="box-shadow:inset 0 0 0 1px var(--ink4);color:var(--fg2);font-weight:400" /></div>
        <${SecHead} n="02" title="预设" en="PRESET" right=${html`<span class="dnote" style="font-size:11px">这个项目里已有 ${mine.length} 个</span>`} />
        <${PresetFields} form=${form} placeholder="例如 render" promptHint="这个预设的 Agent 是做什么的" />
        <label class="field">显示名（可以不填，只用在界面上）<input class="input" type="text" value=${name} placeholder="例如 渲染" maxlength="24" onInput=${(/** @type {any} */ e) => setName(e.currentTarget.value)} /></label>
        <p class="dnote">建好以后，用编辑器打开这个文件补上提示词。显示名记在界面自己的数据里，不写进预设文件。</p>
      </div>
      <div class="dlg-foot">
        <span class="cmdline">写入 ~/.tau/presets/${form.idFinal || "<ID>"}.md</span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="accent" icon="arrow" label=${busy ? "建立中" : "建预设"} disabled=${!can} onClick=${() => go(close)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
