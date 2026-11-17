// 进程栏：项目头、筛选、搜索、常驻团队、临时进程、位置尺。
import { html, projTitle, Icon, Tex, Lamp, pad2, Pill, showMenu, useRef, useState, useEffect, useLayoutEffect } from "./common.js";
import { formatAgo, formatDuration, contextPercent } from "../lib/format.js";
import { askRemove, askDeletePreset } from "./remove.js";

const FILTERS = /** @type {const} */ ([
  ["all", "全部"],
  ["running", "在跑"],
  ["error", "出错"],
]);

/** 折叠状态的键：`open:<名字>` 为 true 就是展开着。默认都折着。 @param {import("../lib/types.js").GuiState} gui @param {string} k */
const isOpen = (gui, k) => gui.collapsed["open:" + k] === true;

/**
 * 进程栏里按顺序出现的进程 ID（给 Alt+↑↓ 用）。
 * @param {import("../lib/derive.js").ProjectView} view
 * @param {import("../lib/types.js").GuiState} gui
 * @param {string} query
 */
export function railIds(view, gui, query) {
  const searching = query.trim() !== "";
  /** @type {string[]} */
  const ids = [];
  for (const t of view.teams) {
    if (t.current) ids.push(t.current.id);
    for (const e of t.shown) ids.push(e.id);
    if (searching || isOpen(gui, "team:" + t.presetId)) for (const e of t.folded) ids.push(e.id);
  }
  for (const e of view.temps.errors) ids.push(e.id);
  for (const e of view.temps.running) ids.push(e.id);
  if (searching || isOpen(gui, "idle")) {
    for (const e of view.temps.idle.today) ids.push(e.id);
    for (const e of view.temps.idle.week) ids.push(e.id);
    if (searching) for (const e of view.temps.idle.older) ids.push(e.id);
  }
  return ids;
}

/** 位置尺：列表长到要滚时，右边标出出错和在跑的进程在哪，框是正看着的这一段。 */
function Ruler({ scrollRef, sig }) {
  const [m, setM] = useState({ show: false, marks: /** @type {{ y: number, st: string }[]} */ ([]), a: 0, b: 1 });
  const calc = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 2) return setM((o) => (o.show ? { show: false, marks: [], a: 0, b: 1 } : o));
    const top = el.getBoundingClientRect().top;
    const marks = [...el.querySelectorAll("[data-st]")].flatMap((r) => {
      const st = r.getAttribute("data-st") ?? "";
      return st === "error" || st === "running" ? [{ y: (r.getBoundingClientRect().top - top + el.scrollTop) / el.scrollHeight, st }] : [];
    });
    setM({ show: true, marks, a: el.scrollTop / el.scrollHeight, b: (el.scrollTop + el.clientHeight) / el.scrollHeight });
  };
  useLayoutEffect(calc, [sig]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", calc, { passive: true });
    window.addEventListener("resize", calc);
    return () => {
      el.removeEventListener("scroll", calc);
      window.removeEventListener("resize", calc);
    };
  }, []);
  if (!m.show) return null;
  return html`<div class="ruler" aria-hidden="true">
    ${m.marks.map((k) => html`<span class=${`rk ${k.st}`} style=${`top:${(k.y * 100).toFixed(2)}%`}></span>`)}
    <span class="rf" style=${`top:${(m.a * 100).toFixed(2)}%;height:${((m.b - m.a) * 100).toFixed(2)}%`}></span>
  </div>`;
}

/** 右键菜单。`edit` 有就多一项“改预设”（常驻团队的行）。 @param {string} id @param {((row: Element) => void) | null} [edit] */
const processMenu = (id, edit = null) => (/** @type {MouseEvent} */ ev) => {
  ev.preventDefault();
  const row = /** @type {Element} */ (ev.currentTarget);
  showMenu(ev.clientX, ev.clientY, [...(edit ? [{ label: "改预设", run: () => edit(row) }] : []), { label: "删除这个进程", run: () => askRemove(id, row) }]);
};

/** 组头：粘在顶上。 */
function GroupHead({ title, en, count, children }) {
  return html`<div class="ghead"><span style="font-size:12px;font-weight:900">${title}</span><span class="label dim">${en}</span><span class="sep"></span>${children}<span class="mono dim" style="font-size:11px">${count}</span></div>`;
}

/** 一行的右侧文字：阶段和时长。 */
function rowSub(app, e) {
  const d = app.describe(e);
  if (e.status === "running") return d.tool ? `${d.label} · ${d.tool} ${d.dur}` : `${d.label} · ${d.dur}`;
  const at = app.lastAt[e.id];
  return `空闲 · ${at !== undefined ? formatDuration(app.now - at) : d.dur}`;
}

/** 常驻团队里的一行：一个进程。`nested` 是同预设的其它进程。 */
function TeamRow({ app, e, n, t, nested = false, tag }) {
  const cur = app.focusedId === e.id;
  const kids = app.entries.filter((x) => x.status === "running" && x.self.parent !== undefined && app.byId[x.self.parent]?.preset === e.preset).length;
  const pct = contextPercent(e.self.context);
  const wait = e.status === "error" || e.status === "running";
  return html`<button type="button" class=${`row team ${nested ? "nested" : ""}`} data-st=${e.status} aria-current=${cur ? "true" : undefined} onClick=${() => app.focusProcess(e.id)} onContextMenu=${processMenu(e.id, (row) => app.openDialog("editpreset", row, { preset: e.preset }))}>
    ${nested && html`<span class="tl" aria-hidden="true"></span>`}
    ${cur && html`<span class="rbar" aria-hidden="true"></span>`}
    <span class="num rn">${n}</span>
    <span class="rmain">
      <span class="rname"><b>${e.name}</b><span class="mono dim ell">${nested ? e.id : e.preset}</span></span>
      <span class="rsub ell">${tag}${e.status === "error" ? html`<span class="tag warn rtag">出错</span>` : ""}${rowSub(app, e)}</span>
    </span>
    <span class="rend">
      <span class="rend1">
        ${kids > 0 && html`<span class="kids" title=${`它开的进程里有 ${kids} 个在跑`}><${Icon} name="reply" size=${11} sw=${2.8} />${kids}</span>`}
        <${Lamp} phase=${e.self.phase.tag} />
      </span>
      <span class="mono dim" style="font-size:11px">${pct}%</span>
    </span>
  </button>`;
}

/** 一个预设一组：当前进程那一行，其它在跑和出错的，“另有 N 个”。 */
function TeamGroup({ app, t, i, searching }) {
  const key = "team:" + t.presetId;
  const open = searching || isOpen(app.gui, key);
  const cur = t.current;
  const folded = t.folded;
  if (!cur) {
    const del = (/** @type {MouseEvent} */ ev) => {
      ev.preventDefault();
      if (t.presetId === app.gui.chief) return;
      const row = /** @type {Element} */ (ev.currentTarget);
      showMenu(ev.clientX, ev.clientY, [{ label: "改预设", run: () => app.openDialog("editpreset", row, { preset: t.presetId }) }, { label: "删除这个预设", run: () => askDeletePreset(t.presetId, row) }]);
    };
    return html`<button type="button" class="row team empty" onContextMenu=${del} onClick=${(/** @type {Event} */ ev) => app.openDialog("newproc", /** @type {Element} */ (ev.currentTarget), { preset: t.presetId })}>
      <span class="num rn">${pad2(i + 1)}</span>
      <span class="rmain"><span class="rname"><b>${t.name}</b><span class="mono dim ell">${t.presetId}</span></span><span class="rsub">还没有进程，点一下开一个</span></span>
      <span class="rend"><${Icon} name="plus" size=${14} sw=${2.6} /></span>
    </button>`;
  }
  return html`<div class="tgroup">
    <${TeamRow} app=${app} e=${cur} n=${pad2(i + 1)} t=${t} />
    ${t.shown.map((e) => html`<${TeamRow} key=${e.id} app=${app} e=${e} n="↳" t=${t} nested tag=${app.gui.forkedFrom[e.id] ? "分叉 · " : ""} />`)}
    ${folded.length > 0 && !searching && html`<button type="button" class="row more" aria-expanded=${open} onClick=${() => app.setGui((g) => ({ collapsed: { ...g.collapsed, ["open:" + key]: !open } }))}>
      <span class="tl" aria-hidden="true"></span>
      <span class="chev" style=${open ? "" : "transform:rotate(-90deg)"}><${Icon} name="down" size=${12} sw=${2.8} color="var(--fg2)" /></span>
      <span style="font-size:12px;font-weight:700">另有 ${folded.length} 个</span><span class="dim" style="font-size:11px">${open ? "收起" : "展开"}</span>
    </button>`}
    ${(open || searching) && folded.map((e) => html`<${TeamRow} key=${e.id} app=${app} e=${e} n="↳" t=${t} nested />`)}
  </div>`;
}

/** 临时进程的一行。 */
function TempRow({ app, e }) {
  const cur = app.focusedId === e.id;
  const t = app.titleOf(e.id);
  const parent = e.self.parent;
  const from = parent ? (app.byId[parent]?.name ?? parent) : app.gui.mine.includes(e.id) ? "你开的" : "没有父进程";
  const d = app.describe(e);
  const at = app.lastAt[e.id];
  const endedLabel = e.self.phase.tag === "idle" ? d.endedText : "";
  return html`<button type="button" class=${`row temp ${e.status}`} data-st=${e.status} aria-current=${cur ? "true" : undefined} onClick=${() => app.focusProcess(e.id)} onContextMenu=${processMenu(e.id)}>
    ${cur && html`<span class="rbar" aria-hidden="true"></span>`}
    <span class=${`glyph ${e.status} ${e.status === "running" ? "pulse" : ""}`} aria-hidden="true"></span>
    <span class="rmain">
      <span class="ttitle ell" style=${t.known ? "" : "font-family:var(--mono);font-size:12px"}>${t.title}</span>
      <span class="tmeta"><span class="mono">${e.id}</span><span class="arrow" aria-hidden="true">←</span><span class="ell">${from}</span>${t.note && html`<span class="ell dim">· ${t.note}</span>`}</span>
    </span>
    <span class="rend">
      ${e.status === "running" ? html`<${Lamp} phase=${e.self.phase.tag} />` : e.status === "error" ? html`<span class="tag warn rtag">出错</span>` : html`<span class=${`ended ${endedLabel === "被停止" || endedLabel === "步数用完" ? "mid" : ""}`}>${endedLabel}</span>`}
      <span class="mono dim tt">${e.status === "running" ? (d.tool ? `${d.tool} ${d.dur}` : d.dur) : at !== undefined ? formatAgo(app.now - at) : ""}</span>
    </span>
  </button>`;
}

function IdleBucket({ app, title, list }) {
  if (list.length === 0) return null;
  return html`<div class="bucket"><span style="font-weight:700">${title}</span><span class="dash"></span><span class="mono">${list.length}</span></div>${list.map((e) => html`<${TempRow} key=${e.id} app=${app} e=${e} />`)}`;
}

/** @param {{ app: import("../app.js").App }} p */
export function ProcList({ app }) {
  const { project: p, view } = app;
  const scroll = useRef(/** @type {HTMLElement | null} */ (null));
  const searching = app.query.trim() !== "";
  // 选中的行滚进视野。
  useEffect(() => {
    scroll.current?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [app.focusedId]);

  if (!app.ready) return html`<section class="plist" aria-label="进程" aria-busy="true"><${Tex} kind="tx-dots-d" mask="linear-gradient(#000 0, transparent 230px)" /></section>`;
  if (!p || !view) {
    return html`<section class="plist" aria-label="进程"><${Tex} kind="tx-dots-d" mask="linear-gradient(#000 0, transparent 230px)" /><div class="plist-empty"><p>还没有项目。</p><${Pill} icon="plus" label="打开项目" onClick=${(/** @type {Event} */ e) => app.openDialog("openproj", /** @type {Element} */ (e.currentTarget))} /></div></section>`;
  }
  const temps = view.temps;
  const tempTotal = temps.errors.length + temps.running.length + temps.idleCount;
  // 筛选和搜索没命中的组只剩组头。
  const hasTeam = p.entries.some((e) => e.kind === "team") || p.presets.some((x) => x.memory);
  const hasTemp = p.entries.some((e) => e.kind === "temp");
  const idleOpen = searching || app.filter !== "all" || isOpen(app.gui, "idle");
  const latest = [...temps.idle.today, ...temps.idle.week, ...temps.idle.older].map((e) => app.lastAt[e.id]).filter((x) => x !== undefined).sort((a, b) => b - a)[0];
  const pi = p.pinnedIndex;
  const ptitle = projTitle(app, p);
  const sig = `${view.teams.length}:${temps.errors.length}:${temps.running.length}:${temps.idleCount}:${idleOpen}:${app.filter}:${app.query}:${app.entries.map((e) => e.status[0]).join("")}`;

  return html`<section class="plist" aria-label=${`${p.name} 的进程`}>
    <${Tex} kind="tx-dots-d" mask="linear-gradient(#000 0, transparent 230px)" />
    <${Tex} kind="tx-grid-d" mask="linear-gradient(transparent 60%, #000 100%)" />
    <div class="plist-top">
      <button type="button" class="phead" aria-label=${`聚焦项目：${p.name}`} onClick=${() => app.focusProject(p.key)}>
        <span class="num phead-n">${pi >= 0 ? pad2(pi + 1) : "··"}</span>
        <span class="phead-t"><span class="phead-name ell">${ptitle.big}</span>${ptitle.small !== "" ? html`<span class="kicker dim ell">${ptitle.small}</span>` : html`<span class="kicker dim ell">项目</span>`}</span>
        <span style="align-self:start"><${Icon} name="ext" size=${16} /></span>
      </button>
      <div class="chips" role="group" aria-label="按状态筛选">
        ${FILTERS.map(([k, label]) => {
          const on = app.filter === k;
          const cnt = view.counts[k === "error" ? "error" : k === "running" ? "running" : "all"];
          return html`<button type="button" class=${`chip ${k} ${k === "error" && cnt > 0 ? "hot" : ""}`} aria-pressed=${on} onClick=${() => app.setFilter(k)}><span class="chip-l">${label}</span><span class="chip-n mono">${cnt}</span></button>`;
        })}
      </div>
      <div class="psearch">
        <label class="sr" for="proc-filter">搜索进程</label>
        <div class="sbox"><${Icon} name="search" size=${14} color="var(--fg2)" /><input id="proc-filter" type="search" placeholder="搜索" value=${app.query} onInput=${(/** @type {any} */ e) => app.setQuery(e.currentTarget.value)} autocomplete="off" /></div>
        <${Pill} size="sm" id="btn-newproc" label="新进程" icon="plus" onClick=${(/** @type {Event} */ e) => app.openDialog("newproc", /** @type {Element} */ (e.currentTarget))} title="Ctrl+N" />
      </div>
    </div>
    <div class="plist-body">
      <div class="plist-scroll" ref=${scroll}>
        ${(hasTeam || app.filter === "all") && html`<${GroupHead} title="常驻团队" en="TEAM" count=${pad2(view.teams.length)}>
          <button type="button" id="btn-newpreset" class="gbtn" aria-haspopup="dialog" onClick=${(/** @type {Event} */ e) => app.openDialog("newpreset", /** @type {Element} */ (e.currentTarget))}><${Icon} name="plus" size=${14} sw=${2.4} />预设</button>
        </${GroupHead}>`}
        ${view.teams.map((t, i) => html`<${TeamGroup} key=${t.presetId} app=${app} t=${t} i=${i} searching=${searching} />`)}
        ${view.teams.length === 0 && app.filter === "all" && !searching && html`<div class="hint">这个项目里没有带记忆的预设。</div>`}
        ${hasTemp && html`<${GroupHead} title="临时" en="TEMP" count=${pad2(tempTotal)}>
          <button type="button" id="btn-clean" class="gbtn" aria-haspopup="dialog" onClick=${(/** @type {Event} */ e) => app.openDialog("clean", /** @type {Element} */ (e.currentTarget))}><${Icon} name="trash" size=${14} sw=${2.4} />清理</button>
        </${GroupHead}>`}
        ${temps.errors.map((e) => html`<${TempRow} key=${e.id} app=${app} e=${e} />`)}
        ${temps.running.map((e) => html`<${TempRow} key=${e.id} app=${app} e=${e} />`)}
        ${temps.idleCount > 0 && !searching && app.filter === "all" && html`<button type="button" class="row fold" aria-expanded=${idleOpen} onClick=${() => app.setGui((g) => ({ collapsed: { ...g.collapsed, "open:idle": !idleOpen } }))}>
          <span class="chev" style=${idleOpen ? "" : "transform:rotate(-90deg)"}><${Icon} name="down" size=${12} sw=${2.8} color="var(--fg2)" /></span>
          <span style="font-size:12.5px;font-weight:700;white-space:nowrap">${idleOpen ? "收起空闲的" : `空闲的 ${temps.idleCount} 个`}</span>
          ${!idleOpen && latest !== undefined && html`<span class="dim ell" style="font-size:11px">最近一个 ${formatAgo(app.now - latest)}</span>`}
          <span class="mono dim" style="margin-left:auto;font-size:11px">${idleOpen ? "" : "展开"}</span>
        </button>`}
        ${idleOpen && html`<${IdleBucket} app=${app} title="今天" list=${temps.idle.today} /><${IdleBucket} app=${app} title="7 天内" list=${temps.idle.week} />
          ${temps.idle.older.length > 0 && (searching ? html`<${IdleBucket} app=${app} title="更早" list=${temps.idle.older} />` : html`<div class="older"><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="rmain"><b style="font-size:12.5px">更早的 ${temps.idle.older.length} 个</b><span class="dim" style="font-size:11px">都空闲超过 7 天</span></span><button type="button" class="gbtn" onClick=${(/** @type {Event} */ e) => app.openDialog("clean", /** @type {Element} */ (e.currentTarget))}><${Icon} name="trash" size=${14} sw=${2.4} />清理</button></div>`)}`}
        ${view.hidden > 0 && html`<button type="button" class="hidden-n" onClick=${() => { app.setFilter("all"); app.setQuery(""); }}>筛选和搜索藏了 ${view.hidden} 个<span class="link" style="color:var(--acc)">显示全部</span></button>`}
      </div>
      <${Ruler} scrollRef=${scroll} sig=${sig} />
    </div>
  </section>`;
}
