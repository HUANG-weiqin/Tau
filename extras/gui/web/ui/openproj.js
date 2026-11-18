// 打开项目：只做一件事，把一个文件夹记成项目。不建预设：项目还没有预设时，主区的空状态再问（设计稿 7.3、5.3）。
import { html, Popover, DlgHead, Pill, useState, Fragment } from "./common.js";
import { pathKey, addFolder, pinFolder } from "../lib/state.js";

/** @param {string} p */
const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function OpenProjDialog({ app, onClose }) {
  const [folder, setFolder] = useState(/** @type {string} */ (app.dialog?.props?.folder ?? ""));
  const [busy, setBusy] = useState(false);

  const path = folder.trim();
  const key = path === "" ? "" : pathKey(path);
  const absOk = isAbs(path);
  const opened = key !== "" && app.projects.some((p) => p.key === key && (p.entries.length > 0 || p.presets.length > 0 || app.gui.folders.some((f) => pathKey(f) === key)));
  const recent = [...app.gui.folders, ...app.projects.map((p) => p.path)].filter((p, i, a) => a.findIndex((q) => pathKey(q) === pathKey(p)) === i).slice(0, 6);

  const pick = async () => {
    try {
      const p = await app.pickFolder();
      if (p) setFolder(p);
    } catch {
      // 提示已经弹了，可以手写路径。
    }
  };
  const go = async (/** @type {() => void} */ close) => {
    if (!absOk || busy) return;
    setBusy(true);
    try {
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

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="打开项目" width=${520} est=${300}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="plus" title="打开项目" en="OPEN PROJECT" onClose=${close} />
      <div class="dlg-body">
        <div class="pathrow">
          <input class="input mono" type="text" value=${folder} placeholder="E:\\games\\cardGame" onInput=${(/** @type {any} */ e) => setFolder(e.currentTarget.value)}
            onKeyDown=${(/** @type {KeyboardEvent} */ e) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && go(close)} aria-label="文件夹的完整路径" autofocus />
          <${Pill} label="选文件夹" onClick=${pick} />
        </div>
        ${recent.length > 0 && html`<div class="recent"><span>最近</span>${recent.map((r) => html`<button type="button" class=${pathKey(r) === key ? "on" : ""} title=${r} onClick=${() => setFolder(r)}>${r}</button>`)}</div>`}
        ${path !== "" && !absOk && html`<p class="dnote" style="color:var(--warn)">要写完整的路径，例如 E:\\games\\cardGame。</p>`}
        ${opened && html`<p class="dnote" style="color:var(--acc)">这个文件夹已经是一个项目了，点“打开”切到它。</p>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline"></span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="accent" icon="arrow" label="打开" disabled=${!absOk || busy} onClick=${() => go(close)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
