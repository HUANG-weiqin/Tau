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
    ${current && html`<span class="tile-bar" aria-hidden="true"></span>`}
    ${pinned && html`<span class="num tile-n">${pad2(n)}</span>`}
    <span class="tile-s">${p.short}</span>
    ${badge !== null && html`<span class=${`badge ${badge}`} aria-hidden="true"></span>`}
  </button>`;
}

/** @param {{ app: import("../app.js").App }} p */
export function Rail({ app }) {
  const { pinned, active, runningTotal } = app.rail;
  const all = app.projects.length;
  const chiefCount = app.attention.length;
  return html`<nav class="rail" aria-label="项目">
    <${Tex} kind="tx-hatch-d" mask="linear-gradient(transparent 50%, #000 100%)" />
    <span class="rail-logo" aria-hidden="true"><${Icon} name="tau" size=${24} sw=${2.6} color="#111211" /></span>
    <div class="rail-scroll">
      ${pinned.map((p, i) => html`<${Tile} key=${p.key} app=${app} p=${p} n=${i + 1} />`)}
      ${pinned.length > 0 && active.length > 0 && html`<span class="hatch-bar rail-div" aria-hidden="true"></span>`}
      ${active.map((p) => html`<${Tile} key=${p.key} app=${app} p=${p} n=${0} />`)}
      <button type="button" id="btn-all" class="tile tool" aria-haspopup="dialog" aria-label=${`全部项目，${all} 个，Alt+0`} onClick=${(/** @type {Event} */ e) => app.openDialog("projects", /** @type {Element} */ (e.currentTarget))}>
        <${Icon} name="grid" size=${18} sw=${2.4} color="#A3A59F" />
        <span class="mono" style="font-size:10.5px;color:#A3A59F">全部 ${all}</span>
      </button>
      <button type="button" id="btn-open" class="tile plus" aria-haspopup="dialog" aria-label="打开项目" onClick=${(/** @type {Event} */ e) => app.openDialog("openproj", /** @type {Element} */ (e.currentTarget))}>
        <${Icon} name="plus" size=${16} sw=${2.8} color="#A3A59F" />
      </button>
    </div>
    <div class="rail-base">
      <button type="button" id="btn-chief" class="chief-btn" aria-haspopup="dialog" aria-label=${chiefCount ? `总管，${chiefCount} 件事待你看，Ctrl+K` : "总管，Ctrl+K"} onClick=${(/** @type {Event} */ e) => app.openDialog("chief", /** @type {Element} */ (e.currentTarget))}>
        <span class="chief-dia" aria-hidden="true"></span>
        <span style="font-size:11px;font-weight:900;line-height:1">总管</span>
        ${chiefCount > 0 && html`<span class="chief-n num" aria-hidden="true">${chiefCount}</span>`}
      </button>
      <div class="rail-run" role="status">
        <span class="rail-run-l">${runningTotal > 0 && html`<span class="pulse" aria-hidden="true" style="width:7px;height:7px;background:var(--acc)"></span>`}在跑</span>
        <span class="num" style="font-size:24px">${runningTotal}</span>
        <span class="dim" style="font-size:11px">个进程</span>
      </div>
    </div>
  </nav>`;
}
