// 打开项目：选文件夹。文件夹里还没有预设就当场建一个项目 Agent 的预设，或者只记下文件夹。
import { html, Popover, DlgHead, SecHead, Pill, Icon, useState, Fragment } from "./common.js";
import { pathKey, addFolder, pinFolder } from "../lib/state.js";
import { CheckStrip, PresetFields, usePresetForm } from "./presetform.js";

/** @param {string} p */
const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
/** 文件夹名变成能当预设 ID 的字。 @param {string} p */
function suggestId(p) {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function OpenProjDialog({ app, onClose }) {
  const [folder, setFolder] = useState(/** @type {string} */ (app.dialog?.props?.folder ?? ""));
  const [busy, setBusy] = useState(false);
  const form = usePresetForm({ app, suggest: suggestId(folder) });
  const extra = form.create();

  const key = folder.trim() === "" ? "" : pathKey(folder.trim());
  const existing = app.presetList.filter((p) => p.ok && p.id !== app.gui.chief && pathKey(p.workdir) === key);
  const opened = key !== "" && app.projects.some((p) => p.key === key && (p.entries.length > 0 || p.presets.length > 0 || app.gui.folders.some((f) => pathKey(f) === key)));
  const idFinal = form.idFinal;
  const absOk = isAbs(folder.trim());
  const recent = [...app.gui.folders, ...app.projects.map((p) => p.path)].filter((p, i, a) => a.findIndex((q) => pathKey(q) === pathKey(p)) === i).slice(0, 6);

  const pick = async () => {
    try {
      const p = await app.pickFolder();
      if (p) setFolder(p);
    } catch {
      // 提示已经弹了，可以手写路径。
    }
  };
  const finish = async (/** @type {() => void} */ close, /** @type {boolean} */ create) => {
    setBusy(true);
    try {
      const path = folder.trim();
      if (create) {
        if (!extra.ok) throw new Error(extra.error);
        await app.createPreset({ id: idFinal, workdir: path, model: form.model.trim(), tools: form.tools, prompt: form.prompt, ...extra.fields });
        app.rememberModel(form.model.trim()).catch(() => {});
      }
      await app.setGui((g) => {
        const withFolder = addFolder(g, path);
        return { ...withFolder, ...pinFolder({ ...g, ...withFolder }, path) };
      });
      app.focusProject(pathKey(path));
      close();
    } catch {
      setBusy(false);
    }
  };

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="打开项目" width=${660} est=${700}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="plus" title="打开项目" en="OPEN PROJECT" sub="左边窄条多一个项目" onClose=${close} />
      <div class="dlg-body">
        <p class="dnote" style="color:var(--fg)">项目就是一个文件夹。界面按预设里写的工作目录，把进程归到项目下。</p>
        <${SecHead} n="01" title="文件夹" en="FOLDER" />
        <div class="pathrow">
          <input class="input mono" type="text" value=${folder} placeholder="E:\\games\\cardGame" onInput=${(/** @type {any} */ e) => setFolder(e.currentTarget.value)} aria-label="文件夹的完整路径" autofocus />
          <${Pill} label="选文件夹" onClick=${pick} />
        </div>
        ${recent.length > 0 && html`<div class="recent"><span>最近</span>${recent.map((r) => html`<button type="button" class=${pathKey(r) === key ? "on" : ""} title=${r} onClick=${() => setFolder(r)}>${r}</button>`)}</div>`}
        ${folder.trim() !== "" && !absOk && html`<p class="dnote" style="color:var(--warn)">要写完整的路径，例如 E:\\games\\cardGame。</p>`}

        <${SecHead} n="02" title="预设" en="PRESET" right=${html`<span class="dnote" style="font-size:11px">${existing.length > 0 ? `这个文件夹已有 ${existing.length} 个预设` : "这个文件夹还没有预设"}</span>`} />
        ${existing.length > 0
          ? html`<div class="callout">${existing.map((p) => app.gui.names[p.id] ?? p.id).join("、")}：项目里的进程会按这些预设归到一起。</div>`
          : html`<div class="callout">没有预设就开不了进程。先建一个项目 Agent 的预设，以后还能再加。</div>
            <${PresetFields} form=${form} app=${app} />
            <p class="dnote">建好以后，随时可以在预设入口里“改预设”。只记下文件夹不建预设也行，项目会先空着。</p>
            <${CheckStrip} ok=${false} text=${extra.ok ? null : extra.error} label="input" />`}
        ${opened && html`<p class="dnote" style="color:var(--acc)">这个文件夹已经是一个项目了。</p>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline">${existing.length === 0 && absOk ? `写入 ~/.tau/presets/${idFinal || "<ID>"}.md` : ""}</span>
        ${existing.length === 0 && html`<${Pill} label="只记下文件夹" disabled=${!absOk || busy} onClick=${() => finish(close, false)} />`}
        <${Pill} kind="accent" icon="arrow" label=${existing.length > 0 ? "打开项目" : "打开并建预设"} disabled=${!absOk || busy || (existing.length === 0 && !form.valid(app.presets))} onClick=${() => finish(close, existing.length === 0)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
