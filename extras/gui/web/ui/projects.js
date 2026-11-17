// 全部项目弹窗：搜名字和路径；钉住的在上（能拖动排序），没钉的在下（按最近的动静排）；每行能钉住或拿下，能改简称。
import { html, projTitle, Popover, DlgHead, SecHead, Pill, Icon, pad2, useState, useRef, Fragment } from "./common.js";
import { formatAgo } from "../lib/format.js";
import { MAX_PINNED, pathKey } from "../lib/state.js";

/** @typedef {import("../lib/derive.js").Project} Project */
/** @typedef {import("../app.js").App} App */

/** 简称最多几个字：窄条的按钮只放得下这么多。 */
const SHORT_MAX = 5;

/**
 * 改简称的小输入框。回车或失焦保存，Esc 放弃。写空就回到默认简称。
 * @param {{ app: App, p: Project, onDone: () => void }} a
 */
function ShortEdit({ app, p, onDone }) {
  const [v, setV] = useState(p.short);
  const done = useRef(false);
  const save = async () => {
    if (done.current) return;
    done.current = true;
    const text = v.trim();
    const k = pathKey(p.path);
    onDone();
    try {
      await app.setGui((g) => {
        /** @type {Record<string, string>} */
        const next = Object.fromEntries(Object.entries(g.short).filter(([x]) => pathKey(x) !== k));
        if (text !== "") next[p.path] = Array.from(text).slice(0, SHORT_MAX).join("");
        return { short: next };
      });
    } catch {
      // 提示已经弹了。
    }
  };
  return html`<input
    class="pj-short-in mono" type="text" value=${v} maxLength=${SHORT_MAX * 2} size="6" autofocus aria-label=${`${p.name} 的简称，最多 ${SHORT_MAX} 个字`}
    onInput=${(/** @type {any} */ e) => setV(e.currentTarget.value)}
    onClick=${(/** @type {Event} */ e) => e.stopPropagation()}
    onBlur=${save}
    onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done.current = true;
        onDone();
      }
    }}
  />`;
}

/**
 * 一行项目。
 * @param {{ app: App, p: Project, n: number, pinned: boolean, full: boolean, canDrag: boolean, current: boolean, over: string | null, setOver: (k: string | null) => void, close: () => void, last: boolean, first: boolean }} a
 */
function Row({ app, p, n, pinned, full, canDrag, current, over, setOver, close, last, first }) {
  const [editing, setEditing] = useState(false);
  const title = projTitle(app, p);
  const open = () => {
    app.focusProject(p.key);
    close();
  };
  const idle = p.running === 0 && p.errors === 0;
  const ago = p.lastActive > 0 ? formatAgo(app.now - p.lastActive) : "";
  const stat =
    p.errors > 0 || p.running > 0
      ? html`<${Fragment}>
          ${p.errors > 0 && html`<span class="tag warn">出错 ${p.errors}</span>`}
          ${p.running > 0 && html`<span class="pj-run"><i class="pulse" aria-hidden="true"></i>在跑 ${p.running}</span>`}
        </${Fragment}>`
      : html`<span class="pj-ago">${p.entries.length === 0 ? "还没有进程" : ago || "没有动静"}</span>`;
  const pinLabel = pinned ? "从窄条上拿下" : full ? `窄条上最多钉 ${MAX_PINNED} 个` : "钉在窄条上";
  return html`<li
    class=${`pj-row ${current ? "on" : ""} ${pinned ? "pinned" : ""} ${over === p.key ? "over" : ""}`}
    draggable=${canDrag ? "true" : undefined}
    onClick=${open}
    onDragStart=${(/** @type {DragEvent} */ e) => {
      e.dataTransfer?.setData("text/plain", p.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }}
    onDragEnd=${() => setOver(null)}
    onDragOver=${(/** @type {DragEvent} */ e) => {
      if (!canDrag) return;
      e.preventDefault();
      setOver(p.key);
    }}
    onDrop=${(/** @type {DragEvent} */ e) => {
      if (!canDrag) return;
      e.preventDefault();
      setOver(null);
      const from = e.dataTransfer?.getData("text/plain");
      if (from && pathKey(from) !== p.key) app.reorderPinned(from, p.path);
    }}
  >
    ${pinned && html`<span class="pj-grip" aria-hidden="true" title=${canDrag ? "拖动改顺序" : ""}></span>`}
    ${pinned ? html`<span class="pj-no num">${pad2(n)}</span>` : html`<span class="pj-dash" aria-hidden="true"></span>`}
    <div class="pj-body">
      <div class="pj-l1">
        <button
          type="button" class="pj-name" onClick=${(/** @type {Event} */ e) => { e.stopPropagation(); open(); }}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
            if (pinned && e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              e.preventDefault();
              app.movePinned(p.path, e.key === "ArrowUp" ? -1 : 1);
            }
          }}
        >${title.big}</button>
        ${editing
          ? html`<${ShortEdit} app=${app} p=${p} onDone=${() => setEditing(false)} />`
          : html`<button type="button" class="pj-short mono" title="改窄条上的简称" aria-label=${`${p.name} 的简称是 ${p.short}，点一下修改`} onClick=${(/** @type {Event} */ e) => { e.stopPropagation(); setEditing(true); }}>${title.custom ? p.name : p.short}</button>`}
        ${current && html`<span class="tag">在看</span>`}
      </div>
      <div class="pj-l2 mono ell" title=${p.path}>${p.path}${p.entries.length > 0 ? ` · ${p.entries.length} 个进程` : ""}</div>
    </div>
    <div class=${`pj-stat ${idle ? "idle" : ""}`}>${stat}</div>
    ${pinned && html`<span class="pj-mv">
      <button type="button" aria-label="上移一格" disabled=${first} onClick=${(/** @type {Event} */ e) => { e.stopPropagation(); app.movePinned(p.path, -1); }}><${Icon} name="up" size=${14} sw=${2.6} /></button>
      <button type="button" aria-label="下移一格" disabled=${last} onClick=${(/** @type {Event} */ e) => { e.stopPropagation(); app.movePinned(p.path, 1); }}><${Icon} name="down" size=${14} sw=${2.6} /></button>
    </span>`}
    <button
      type="button" class=${`pj-pin ${pinned ? "on" : ""}`} aria-pressed=${pinned} aria-label=${`${pinLabel}：${p.name}`} title=${pinLabel} disabled=${!pinned && full}
      onClick=${(/** @type {Event} */ e) => { e.stopPropagation(); (pinned ? app.unpin(p.path) : app.pin(p.path)).catch(() => {}); }}
    ><${Icon} name="pin" size=${16} sw=${2.4} /></button>
  </li>`;
}

/** @param {{ app: App, onClose: () => void }} p */
export function ProjectsDialog({ app, onClose }) {
  const [query, setQuery] = useState("");
  const [over, setOver] = useState(/** @type {string | null} */ (null));
  const q = query.trim().toLowerCase();
  const hit = (/** @type {Project} */ p) => q === "" || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || p.short.toLowerCase().includes(q);

  const pinnedAll = app.projects.filter((p) => p.pinnedIndex >= 0).sort((a, b) => a.pinnedIndex - b.pinnedIndex);
  const othersAll = app.projects.filter((p) => p.pinnedIndex < 0).sort((a, b) => b.lastActive - a.lastActive || (a.name < b.name ? -1 : 1));
  const pinned = pinnedAll.filter(hit);
  const others = othersAll.filter(hit);
  const full = pinnedAll.length >= MAX_PINNED;
  const curKey = app.project?.key ?? null;
  const shown = pinned.length + others.length;

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="全部项目" width=${660} est=${760}>
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="grid" title="全部项目" en="ALL PROJECTS" sub=${`${app.projects.length} 个，钉住 ${pinnedAll.length} 个`} onClose=${close} />
      <div class="dlg-body">
        <label class="pj-search">
          <${Icon} name="search" size=${16} sw=${2.4} color="#A3A59F" />
          <input type="text" value=${query} placeholder="搜项目名或路径" aria-label="搜项目名或路径" autofocus onInput=${(/** @type {any} */ e) => setQuery(e.currentTarget.value)} />
          <span class="mono dim" style="font-size:11px">${q === "" ? app.projects.length : `${shown} / ${app.projects.length}`}</span>
        </label>

        ${app.projects.length === 0 && html`<p class="dnote">还没有项目。点下面的“打开项目”选一个文件夹。</p>`}
        ${app.projects.length > 0 && shown === 0 && html`<p class="dnote">没有项目匹配“${query.trim()}”。</p>`}

        ${pinnedAll.length > 0 && (q === "" || pinned.length > 0) && html`<section class="pj-group">
          <${SecHead} n="01" title="钉在窄条上" en="PINNED" right=${html`<span class="dnote" style="font-size:11px">${q === "" ? `拖动改顺序 · Alt+1…${Math.min(9, pinnedAll.length)}` : "搜索时不能拖动"}</span>`} />
          <ul class="pj-list" onDragLeave=${(/** @type {DragEvent} */ e) => { if (!e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget))) setOver(null); }}>
            ${pinned.map((p) => html`<${Row} key=${p.key} app=${app} p=${p} n=${p.pinnedIndex + 1} pinned=${true} full=${full} canDrag=${q === ""} current=${curKey === p.key} over=${over} setOver=${setOver} close=${close} first=${p.pinnedIndex === 0} last=${p.pinnedIndex === pinnedAll.length - 1} />`)}
          </ul>
        </section>`}

        ${others.length > 0 && html`<section class="pj-group">
          <${SecHead} n="02" title="没钉的" en="OTHERS" right=${html`<span class="dnote" style="font-size:11px">按最近的动静排</span>`} />
          <ul class="pj-list">
            ${others.map((p) => html`<${Row} key=${p.key} app=${app} p=${p} n=${0} pinned=${false} full=${full} canDrag=${false} current=${curKey === p.key} over=${null} setOver=${setOver} close=${close} first=${false} last=${false} />`)}
          </ul>
        </section>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline">钉住、顺序、简称记在 ~/.tau/extras/gui/</span>
        <${Pill} kind="accent" icon="plus" label="打开项目" onClick=${() => app.openDialog("openproj")} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
