// 项目窄条：钉住的项目、有动静的项目、全部和打开、总管和在跑数。
import { html, Icon, Tex, pad2, tipProps, showMenu, useRef, Fragment } from "./common.js";

/**
 * 一个项目按钮。钉住的带编号，没钉住的是虚线框。
 * @param {{ app: import("../app.js").App, p: import("../lib/derive.js").Project, n: number }} a
 */
function Tile({ app, p, n }) {
  const current = app.project?.key === p.key;
  const pinned = p.pinnedIndex >= 0;
  const badge = p.errors > 0 ? "warn" : p.running > 0 ? "" : null;
  const counts = `${p.entries.length} 个进程${p.running ? `，${p.running} 个在跑` : ""}${p.errors ? `，${p.errors} 个出错` : ""}`;
  const label = `${p.name}：${p.entries.length === 0 ? "还没有进程" : counts}${pinned ? `，Alt+${n}` : "，没钉住"}`;
  const drag = useRef(/** @type {HTMLElement | null} */ (null));
  const tip = tipProps(() => html`<${Fragment}><b>${p.name}</b><div class="mono">${p.path}</div><div style="margin-top:6px">${p.entries.length === 0 ? "还没有进程" : counts}</div></${Fragment}>`);
  const inner = html`<span class=${`tile-face ${pinned ? "" : "loose-face"}`}>
    ${current && html`<span class="tile-bar" aria-hidden="true"></span>`}
    ${pinned && html`<span class="num tile-n">${pad2(n)}</span>`}
    <span class="tile-s">${p.short}</span>
  </span>`;
  // 浮牌的处理器先铺，后面的 onClick 才不会被它的 onClick（只收起浮牌）盖掉。
  return html`<button
    ...${tip}
    type="button" ref=${drag} class=${`tile ${pinned ? "pinned" : "loose"}`} aria-current=${current ? "true" : undefined} aria-label=${label}
    draggable=${pinned ? "true" : undefined}
    onClick=${() => {
      tip.onClick();
      app.focusProject(p.key);
    }}
    onContextMenu=${(/** @type {MouseEvent} */ e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [pinned ? { label: "拿下", run: () => app.unpin(p.path) } : { label: "钉住", run: () => app.pin(p.path) }]);
    }}
    onDragStart=${(/** @type {DragEvent} */ e) => e.dataTransfer?.setData("text/plain", p.path)}
    onDragOver=${(/** @type {DragEvent} */ e) => pinned && e.preventDefault()}
    onDrop=${(/** @type {DragEvent} */ e) => {
      e.preventDefault();
      const from = e.dataTransfer?.getData("text/plain");
      if (from) app.reorderPinned(from, p.path);
    }}
  >
    ${pinned ? html`<span class="tile-shell">${inner}</span>` : inner}
    ${badge !== null && html`<span class=${`badge ${badge}`} aria-hidden="true"></span>`}
  </button>`;
}

/** @param {{ app: import("../app.js").App }} p */
export function Rail({ app }) {
  const { pinned, active, runningTotal } = app.rail;
  const all = app.projects.length;
  const chiefCount = app.attention.length;
  return html`<nav class="rail" aria-label="项目">
    <${Tex} kind="tx-hatch-d" mask="linear-gradient(transparent 55%, rgba(0,0,0,.65) 100%)" />
    <span class="rail-logo" aria-hidden="true">
      <${Tex} kind="tx-dots-y" mask="linear-gradient(135deg, rgba(0,0,0,.5) 0%, transparent 75%)" />
      <${Icon} name="tau" size=${24} sw=${2.6} color="var(--on-fill)" />
    </span>
    <div class="rail-scroll">
      ${pinned.map((p, i) => html`<${Tile} key=${p.key} app=${app} p=${p} n=${i + 1} />`)}
      ${pinned.length > 0 && active.length > 0 && html`<span class="hatch-bar rail-div" aria-hidden="true"></span>`}
      ${active.map((p) => html`<${Tile} key=${p.key} app=${app} p=${p} n=${0} />`)}
      ${pinned.length + active.length > 0 && html`<span class="rail-sep" aria-hidden="true"></span>`}
      <div class="rail-ops">
        <button type="button" id="btn-all" class="rail-op all" aria-haspopup="dialog" aria-label=${`全部项目，${all} 个，Alt+0`} onClick=${(/** @type {Event} */ e) => app.openDialog("projects", /** @type {Element} */ (e.currentTarget))}>
          <${Icon} name="grid" size=${15} sw=${2.3} />
          <span class="rail-op-l">全部 <span class="mono">${all}</span></span>
        </button>
        <button type="button" id="btn-open" class="rail-op plus" aria-haspopup="dialog" aria-label="打开项目" onClick=${(/** @type {Event} */ e) => app.openDialog("openproj", /** @type {Element} */ (e.currentTarget))}>
          <${Icon} name="plus" size=${15} sw=${2.6} />
        </button>
      </div>
    </div>
    <div class="rail-base">
      <button type="button" id="btn-settings" class="tile set-btn" aria-haspopup="dialog" aria-label="设置，Ctrl+," title="设置 Ctrl+," onClick=${(/** @type {Event} */ e) => app.openDialog("settings", /** @type {Element} */ (e.currentTarget))}>
        <span class="tile-shell"><span class="tile-face">
          <${Icon} name="sliders" size=${15} sw=${2.3} />
          <span class="rail-btn-l">设置</span>
        </span></span>
      </button>
      <button type="button" id="btn-chief" class="chief-btn" aria-haspopup="dialog" aria-label=${chiefCount ? `总管，${chiefCount} 件事待你看，Ctrl+K` : "总管，Ctrl+K"} onClick=${(/** @type {Event} */ e) => app.openDialog("chief", /** @type {Element} */ (e.currentTarget))}>
        <span class="tile-shell"><span class="tile-face">
          <span class="chief-dia" aria-hidden="true"></span>
          <span class="chief-l">总管</span>
        </span></span>
        ${chiefCount > 0 && html`<span class="chief-n num" aria-hidden="true">${chiefCount}</span>`}
      </button>
      <div class="rail-run" role="status" aria-label=${`全局 ${runningTotal} 个进程在跑`}>
        <span class="rail-run-h"><span>在跑</span><i class=${runningTotal > 0 ? "on pulse" : ""} aria-hidden="true"></i></span>
        <span class="rail-run-v"><span class=${`num rail-run-n ${runningTotal > 0 ? "acc-fg" : ""}`}>${pad2(runningTotal)}</span><span class="rail-run-u">进程</span></span>
      </div>
    </div>
  </nav>`;
}
