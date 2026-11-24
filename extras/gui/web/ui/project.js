// 聚焦项目时的主区：铭牌、成员表、最近动态、写信框。项目里一个预设都没有时，成员表换成空状态（设计稿 5.3）。
import { html, projTitle, Pill, Lamp, Tex, Contour, pad2, clockS, useState, useEffect, Fragment } from "./common.js";
import * as api from "../api.js";
import { itemsOf, clipText } from "../lib/messages.js";
import { currentOf } from "../lib/derive.js";
import { formatContext } from "../lib/format.js";
import { Compose } from "./compose.js";

/** 最近动态最多留几条。 */
const ACTIVITY_MAX = 12;

/**
 * 进程在界面上的名字：临时进程用标题，其余用显示名。
 * @param {import("../app.js").App} app
 * @param {import("../lib/derive.js").Entry} e
 */
const nameOf = (app, e) => (e.kind === "temp" ? app.titleOf(e.id).title : e.name);

/**
 * 成员：每个常驻预设一行，取它的当前进程。按显示名排。
 * @param {import("../app.js").App} app
 * @param {import("../lib/derive.js").Project} p
 */
function membersOf(app, p) {
  const ids = [...new Set(p.entries.filter((e) => e.kind === "team").map((e) => e.preset))];
  const out = [];
  for (const id of ids) {
    const e = currentOf(id, p.entries, app.gui, app.lastAt);
    if (e) out.push(e);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * 最近动态：进程之间的信、出错、换段，新的在上。只用已经读到的数据。
 * @param {import("../app.js").App} app
 * @param {import("../lib/derive.js").Project} p
 */
function activityOf(app, p) {
  /** @type {{ key: string, ts: number, kind: "letter" | "reply" | "error" | "handoff", who: string, from?: string, text: string }[]} */
  const out = [];
  for (const e of p.entries) {
    const who = nameOf(app, e);
    const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
    if (e.status === "error" && ended && typeof ended === "object") {
      out.push({ key: `e:${e.id}`, ts: app.lastAt[e.id] ?? e.segmentStartedAt ?? e.createdAt, kind: "error", who, text: ended.error });
    }
    if (e.self.segment > 1 && e.segmentStartedAt !== null) {
      out.push({ key: `s:${e.id}:${e.self.segment}`, ts: e.segmentStartedAt, kind: "handoff", who, text: `第 ${e.self.segment - 1} 段写好了交接说明，开了第 ${e.self.segment} 段。` });
    }
    for (const it of itemsOf(app.messages(e.id))) {
      if (it.kind !== "user") continue;
      it.letters.forEach((l, i) => {
        if (l.from === "user") return;
        const sender = app.entryOf(l.id);
        out.push({ key: `l:${e.id}:${it.ts}:${i}`, ts: app.clock(it.ts), kind: l.from === "reply" ? "reply" : "letter", who, from: sender ? nameOf(app, sender) : l.id, text: clipText(l.text.replace(/\s+/g, " ").trim(), 120) });
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, ACTIVITY_MAX);
}

/**
 * 仓库：当前分支和分支数。读不到时是 null。
 * 直接调 `api.js`，不弹提示：没有预设指向、也没登记的目录（例如会话改了工作目录）桥回 403，读不到就是读不到，不该弹错。
 * @param {import("../lib/derive.js").Project | null} p
 */
function useRepo(p) {
  const path = p?.path ?? null;
  const [repo, setRepo] = useState(/** @type {{ path: string, branch: string | null, count: number } | null} */ (null));
  const idle = (p?.running ?? 0) === 0;
  useEffect(() => {
    let alive = true;
    if (path === null) return;
    api.git(path, "branches").then(
      (r) => {
        if (!alive) return;
        const list = /** @type {{ name: string, current: boolean }[]} */ (r?.branches ?? []);
        setRepo({ path, branch: list.find((b) => b.current)?.name ?? null, count: list.length });
      },
      () => alive && setRepo({ path, branch: null, count: 0 }),
    );
    return () => {
      alive = false;
    };
  }, [path, idle]);
  return repo && repo.path === path ? repo : null;
}

/** 在跑的进程里，父进程在项目外的。停它们，回信会唤醒父进程。 @param {import("../app.js").App} app @param {import("../lib/derive.js").Project} p */
function outsideParents(app, p) {
  /** @type {Set<string>} */
  const names = new Set();
  let n = 0;
  for (const e of p.entries) {
    const parent = e.self.parent;
    if (e.status !== "running" || !parent || p.entries.some((x) => x.id === parent)) continue;
    n++;
    const pe = app.entryOf(parent);
    names.add(pe ? nameOf(app, pe) : parent);
  }
  return { n, names: [...names] };
}

/** 长路径缩成“…\后两段”。 @param {string} path */
function shortDir(path) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : "…\\" + parts.slice(-2).join("\\");
}

/** @param {{ app: import("../app.js").App, p: import("../lib/derive.js").Project, members: import("../lib/derive.js").Entry[], repo: { branch: string | null, count: number } | null }} a */
function Plate({ app, p, members, repo }) {
  const [stopping, setStopping] = useState(false);
  const title = projTitle(app, p);
  const dir = shortDir(p.path);
  const running = members.filter((e) => e.status === "running").length;
  const errors = members.filter((e) => e.status === "error").length;
  const idle = members.length - running - errors;
  const sub = [idle > 0 ? `${idle} 空闲` : "", errors > 0 ? `${errors} 出错` : ""].filter(Boolean).join(" · ");
  const git = repo === null ? "…" : repo.count === 0 && repo.branch === null ? "不是 git 仓库" : `git · ${repo.branch ?? "游离的提交"}`;
  const stopAll = () => {
    setStopping(true);
    app.stopAll(p).then(
      () => setStopping(false),
      () => setStopping(false),
    );
  };
  return html`<section class="plate-wrap" aria-label="当前聚焦的项目">
    <${Tex} kind="tx-grid-d2" />
    <div class="plate">
      <${Tex} kind="tx-dots-y" mask="linear-gradient(100deg, transparent 50%, #000 96%)" />
      <div style="position:relative">
        <div class="plate-top"><span class="tag">当前聚焦</span><span class="mono" style="font-size:11px">${p.pinnedIndex >= 0 ? `项目 ${pad2(p.pinnedIndex + 1)}` : "项目"}</span></div>
        <div class="plate-name">
          <h1>${title.big}</h1>
          ${title.small !== "" && html`<span class="plate-id">${title.small}</span>`}
        </div>
        <dl class="plate-tags pv-tags">
          <div><dt>目录</dt><dd class="mono pv-dir" title=${p.path}>${dir}</dd></div>
          <div><dt>仓库</dt><dd class="mono">${git}</dd></div>
        </dl>
      </div>
    </div>
    <div class="plate-r">
      <span class="slash xl-only" aria-hidden="true"></span>
      <div class="ctx">
        <div class="ctx-l"><b>在跑</b><span>常驻团队</span></div>
        <div class="ctx-n"><span class="num ctx-big">${running}</span><span class="num ctx-pc" style="color:var(--fg2)">/ ${members.length}</span></div>
        <div class="pv-bar" style=${`--n:${Math.max(members.length, 1)}`} role="img" aria-label=${`${members.length} 个成员：${running} 个在跑，${idle} 个空闲，${errors} 个出错`}>
          ${members.map((e) => html`<span class=${e.status === "running" ? "f" : e.status === "error" ? "w" : ""}></span>`)}
        </div>
        <div class="mono ctx-m">${members.length === 0 ? "还没有常驻进程" : sub || "全部在跑"}</div>
      </div>
      <div class="plate-act">
        <${Pill} size="sm" label=${stopping ? "停止中" : "全部停止"} icon="stop" chip="red" disabled=${p.running === 0 || stopping} title="停项目里所有在跑的进程，子孙先停" onClick=${stopAll} />
        ${stopping && html`<div class="mono pv-prog" role="status">还有 ${p.running} 个在跑，继续停</div>`}
      </div>
    </div>
  </section>`;
}

/** @param {{ app: import("../app.js").App, e: import("../lib/derive.js").Entry, n: number, sel: boolean, onSel: () => void }} a */
function MemberRow({ app, e, n, sel, onSel }) {
  const d = app.describe(e);
  const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
  const error = e.status === "error";
  const running = e.status === "running";
  const state = running ? `${d.label}${d.tool ? " " + d.tool : ""} ${d.dur}` : `${d.label} ${d.dur}`;
  const doing = error && ended && typeof ended === "object" ? ended.error : d.doing || d.endedText;
  return html`<div role="row" class=${`pv-row ${sel ? "sel" : ""} ${error ? "err" : ""}`} onClick=${onSel}>
    <div role="cell" class="pv-n"><button type="button" class="pv-pick num" aria-pressed=${sel} aria-label=${`写信给 ${e.name}`} title="写信给它" onClick=${(/** @type {Event} */ ev) => { ev.stopPropagation(); onSel(); }}>${pad2(n)}</button></div>
    <div role="cell" class="pv-who">
      <button type="button" class="pv-name" title="打开这个进程" onClick=${(/** @type {Event} */ ev) => { ev.stopPropagation(); app.focusProcess(e.id); }}>${e.name}</button>
      <span class="mono pv-id">${e.preset}</span>
    </div>
    <div role="cell" class="pv-st"><${Lamp} phase=${e.self.phase.tag} />${error ? html`<span class="tag warn">出错</span><span class="pv-t">${d.dur}</span>` : html`<span class="pv-t">${state}</span>`}</div>
    <div role="cell" class=${`pv-do ${running ? "" : "dim"} ${error ? "mono" : ""}`}>${doing}</div>
    <div role="cell" class="pv-ctx mono">${formatContext(e.self.context)}</div>
  </div>`;
}

/** @param {{ app: import("../app.js").App, items: ReturnType<typeof activityOf> }} a */
function Activity({ app, items }) {
  return html`<section aria-label="最近动态" class="pv-sec">
    <h3 class="pv-h"><span>最近动态</span><span class="label">ACTIVITY</span><span class="pv-line" aria-hidden="true"></span></h3>
    ${items.length === 0
      ? html`<p class="hintp">还没有动态。进程之间寄信、出错、换段，会出现在这里。</p>`
      : html`<ul class="pv-act">${items.map((a) => html`<li key=${a.key}>
          <span class="mono pv-ts">${clockS(a.ts)}</span>
          <div class="pv-ab">
            <div class="pv-ah">
              ${a.kind === "letter" || a.kind === "reply" ? html`<b>${a.from}</b><span aria-hidden="true">→</span><b>${a.who}</b><span class="tag">${a.kind === "reply" ? "回信" : "来信"}</span>` : html`<b>${a.who}</b>${a.kind === "error" ? html`<span class="tag warn">出错</span>` : html`<span class="tag line">换段</span>`}`}
            </div>
            <p class=${`pv-at ${a.kind === "error" ? "mono" : ""}`}>${a.text}</p>
          </div>
        </li>`)}</ul>`}
  </section>`;
}

/** @param {{ app: import("../app.js").App }} p */
export function ProjectView({ app }) {
  const p = app.project;
  const [picked, setPicked] = useState(/** @type {string | null} */ (null));
  const repo = useRepo(p);
  if (!p) return html`<div class="pending"><${Tex} kind="tx-grid-l" /><p class="mono" style="position:relative">没有项目。</p></div>`;
  const members = membersOf(app, p);
  const target = members.find((e) => e.id === picked) ?? members[0] ?? null;
  const outside = outsideParents(app, p);
  const items = activityOf(app, p);
  const num = p.pinnedIndex >= 0 ? pad2(p.pinnedIndex + 1) : "";
  const side = `PROJ ${num || "--"} / ${p.entries.length} PROC${repo && repo.count > 0 ? ` / ${repo.count} BRANCH` : ""}`;
  return html`<${Fragment}>
    <${Plate} app=${app} p=${p} members=${members} repo=${repo} />
    ${outside.n > 0 && html`<div class="carry pv-hint"><span class="tag warn" style="flex:none">会唤醒</span><span>${outside.n} 个在跑的进程是「${outside.names.join("、")}」开的，它不在这个项目里。它们被停止后，回信会唤醒它。界面不去停它。</span></div>`}
    <div class="pv-stage">
      <div class="pv-in">
        <${Tex} kind="tx-grid-l" />
        <${Contour} />
        ${num && html`<span class="bignum wide-only" aria-hidden="true">${num}</span>`}
        <span class="vlabel wide-only" aria-hidden="true">${side}</span>
        <span class="cross wide-only" aria-hidden="true" style="left:16px;top:10px"></span>
        <span class="cross wide-only" aria-hidden="true" style="right:10px;bottom:10px"></span>
        <div class="pv-body">
          ${p.presets.length === 0 && p.entries.length === 0
            ? html`<section aria-label="还没有预设" class="pv-sec pv-empty">
                <p class="hintp">这个项目还没有预设。开进程前要先建一个。</p>
                <${Pill} kind="accent" icon="plus" label="新建预设" onClick=${(/** @type {Event} */ e) => app.openDialog("newpreset", /** @type {Element} */ (e.currentTarget))} />
              </section>`
            : html`<${Fragment}>
              <section aria-label="成员" class="pv-sec">
                <h3 class="pv-h"><span>成员</span><span class="label">MEMBERS</span><span class="pv-line" aria-hidden="true"></span><span class="mono" style="font-size:11px;font-weight:400">${pad2(members.length)}</span></h3>
                ${members.length === 0
                  ? html`<p class="hintp">这个项目还没有常驻进程。用“新进程”选一个常驻预设开一个。</p>`
                  : html`<div class="pv-table" role="table" aria-label="团队成员">
                      <div role="row" class="pv-row pv-head"><span role="columnheader">编号</span><span role="columnheader">成员</span><span role="columnheader">状态</span><span role="columnheader">正在做</span><span role="columnheader" style="text-align:right">上下文</span></div>
                      ${members.map((e, i) => html`<${MemberRow} key=${e.id} app=${app} e=${e} n=${i + 1} sel=${target?.id === e.id} onSel=${() => setPicked(e.id)} />`)}
                    </div>`}
              </section>
              <${Activity} app=${app} items=${items} />
            </${Fragment}>`}
        </div>
      </div>
    </div>
    ${target && html`<${Compose} key=${target.id} app=${app} e=${target} name=${target.name} />`}
  </${Fragment}>`;
}
