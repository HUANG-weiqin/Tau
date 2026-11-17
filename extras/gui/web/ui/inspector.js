// 详情栏和竖选项卡。
// 进程三页：概况、改动、后台。项目三页：概况、分支、后台。`app.tab` 是 0 到 2。
// 改动页的文件树只列文件，点一个文件弹出 diff 窗（`diff.js`）。
// git 和后台 log 的数据自己轮询：对象换了就重读，之后每 10 秒读一次，页面藏起来时不读。
// 这里直接调 `api.js`，不用 `app.git`：那个出错会弹提示，轮询会一直弹。
import { html, Icon, Tex, useEffect, useRef, useState, Fragment } from "./common.js";
import * as api from "../api.js";
import { known } from "../lib/history.js";
import { formatAgo } from "../lib/format.js";
import { mailOf, rulerOf } from "../lib/derive.js";
import { pathKey } from "../lib/state.js";

const PROC_TABS = [
  ["grid", "概况"],
  ["branch", "改动"],
  ["term", "后台"],
];
const PROJ_TABS = [
  ["grid", "概况"],
  ["branch", "分支"],
  ["term", "后台"],
];
export const POLL_MS = 10_000;
/** 轮询到的数据：`key` 是它属于哪个对象，对不上就当没有。 */
const NONE = { key: /** @type {string | null} */ (null), value: /** @type {any} */ (null), error: /** @type {string | null} */ (null), loading: true };

/**
 * 读一个数据并定时刷新。`key` 为 null 时不读。`bump` 变了就马上再读一次，但不清掉旧值。
 * @param {string | null} key
 * @param {() => Promise<any>} fn
 * @param {number} ms
 * @param {unknown} [bump]
 */
export function usePoll(key, fn, ms, bump) {
  const [st, setSt] = useState(NONE);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const value = await fnRef.current();
        if (alive) setSt({ key, value, error: null, loading: false });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (alive) setSt((s) => ({ key, value: s.key === key ? s.value : null, error, loading: false }));
      } finally {
        busy = false;
      }
    };
    tick();
    const timer = setInterval(tick, ms);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key, ms, bump]);
  if (key === null) return NONE;
  return st.key === key ? st : { ...NONE, key };
}

/* ------------------------------------------------------------------ 小件 */

/** 三格数字。`items`：`{ en, label, value, unit?, warn?, hot? }`，或者 `{ en, label, pair: [上, 下] }`（两个数上下两行）。 */
function Stats({ items }) {
  return html`<dl class="istats">
    ${items.map((it) => {
      const head = html`<dt><span class="label">${it.en}</span><span>${it.label}</span></dt>`;
      // 两个数（增和删）上下两行，各占半高，合起来和旁边的大字一样高。
      if (it.pair) {
        const n = Math.max(...it.pair.map((s) => s.length));
        return html`<div class="istat">${head}<dd class="pair" style=${`--n:${Math.max(2.5, n).toFixed(2)}`}>${it.pair.map((s) => html`<span>${s}</span>`)}</dd></div>`;
      }
      // 折算的字数：大字一个算一个，单位是小字，一个算 0.4，再加上中间的空格。CSS 按它和格宽定字号，长的数字缩小，不出格。
      const n = String(it.value).length + (it.unit ? 0.5 + String(it.unit).length * 0.4 : 0);
      return html`<div class=${`istat ${it.hot ? "hot" : ""}`}>${head}<dd class=${it.warn ? "warn" : ""} style=${`--n:${Math.max(2.5, n).toFixed(2)}`}><span>${it.value}</span>${it.unit ? html`<span class="u"> ${it.unit}</span>` : ""}</dd></div>`;
    })}
  </dl>`;
}

/** 小节标题：中文、英文、一条线、右边的计数。 */
function Sec({ zh, en, right }) {
  return html`<h3 class="isec"><span>${zh}</span><span class="label dim">${en}</span><span class="sep" aria-hidden="true"></span>${right !== undefined && right !== null ? html`<span class="mono n">${right}</span>` : ""}</h3>`;
}

function Note({ children, kind = "" }) {
  return html`<p class=${`inote ${kind}`}>${children}</p>`;
}

/** 增删行数：增加加粗，删除灰。没有数字（没跟踪的新文件）就不显示。 */
export function Delta({ add, del }) {
  if ((add === null && del === null) || (!add && !del)) return null;
  return html`<span class="mono idelta"><b>+${add ?? 0}</b>${del ? html` <span class="dim">−${del}</span>` : ""}</span>`;
}

/** @param {{ tools: string[] | null }} p */
function ToolTags({ tools }) {
  if (tools === null) return html`<span class="dim">不知道</span>`;
  if (tools.length === 0) return html`<span class="dim">没有</span>`;
  return html`<span class="itags">${tools.map((t) => html`<span class="mono itag">${t}</span>`)}</span>`;
}

/** 读取状态：读到前、出错时的占位。有旧值时调用方自己决定还显不显示。 */
export function Waiting({ st, what }) {
  if (st.error !== null) return html`<${Note} kind="warn">${what}：${st.error}<//>`;
  return html`<${Note}>读取中…<//>`;
}

/* ------------------------------------------------------------------ 概况 */

/** 上下文：一块小铭牌（占比大数字、十格段尺、自动换段的刻线），下面是前面各段。前面每段在哪换的：内核不记当时占了多少，所以只写“换段”和已读到的条数。 */
function SegmentRuler({ app, id, self, threshold }) {
  const hist = app.history(id);
  const cur = self.segment;
  const { pct, mark, near } = rulerOf(self.context, threshold);
  const full = Math.floor(pct / 10);
  const part = pct % 10 >= 3;
  // 段很多时只列最近几段。
  const from = Math.max(1, cur - 6);
  /** @type {number[]} */
  const earlier = [];
  for (let s = from; s < cur; s++) earlier.push(s);
  return html`<section class="isection">
    <${Sec} zh="上下文" en="CONTEXT" right=${`${cur} 段`} />
    <div class=${`cc ${near ? "near" : ""}`} role="img" aria-label=${`当前段，上下文占 ${pct}%${mark !== null ? `，自动换段的刻线在 ${mark}%` : ""}${near ? "，快到了" : ""}`}>
      <${Tex} kind="tx-dots-d" mask="linear-gradient(100deg, transparent 30%, #000 100%)" />
      <div class="cc-top">
        <div class="cc-n"><span class="num cc-big">${pct}</span><span class="num cc-pc">%</span></div>
        <div class="cc-l"><b>第 ${cur} 段</b><span>上下文已用</span>${near && html`<span class="tag warn">快到了</span>`}</div>
      </div>
      <div class="cc-rule">
        <div class="cc-bar">${Array.from({ length: 10 }, (_, i) => html`<span class=${i < full ? "f" : i === full && part ? "p" : ""}></span>`)}</div>
        ${mark !== null && html`<span class=${`cc-flag ${mark > 55 ? "r" : ""}`} style=${`left:${mark}%`}><span class="kicker">自动换段</span><span class="mono">${mark}%</span></span>`}
      </div>
    </div>
    ${from > 1 && html`<p class="inote">更早的 ${from - 1} 段都换过段了。</p>`}
    ${earlier.length > 0 && html`<ul class="cc-prev">
      ${earlier.map((s) => {
        const n = known(hist, s);
        return html`<li><span class="mono cc-pn">段 ${s}</span><span class="cc-ph" aria-hidden="true"></span><span class="mono cc-pr">${n > 0 ? `${n} 条 · ` : ""}换段</span></li>`;
      })}
    </ul>`}
  </section>`;
}

/** 一个进程在列表里的名字：预设 ID · 进程 ID。 @param {any[]} records @param {string} id */
function procTag(records, id) {
  const r = records.find((x) => x?.id === id);
  return r?.preset?.id ? `${r.preset.id} · ${id}` : id;
}

/** 信箱：排队的信、谁在等它回信、它在等谁。全从 `inspect` 的记录推；信本身不记时间，所以不显示时间。 */
function Mailbox({ records, id }) {
  const m = mailOf(records, id);
  if (m.queued.length === 0 && m.waitedBy.length === 0 && m.waitingOn.length === 0) return null;
  return html`<section class="isection">
    <${Sec} zh="信箱" en="MAILBOX" right=${m.queued.length > 0 ? `${m.queued.length} 封排队` : null} />
    ${m.queued.length > 0 && html`<ul class="imail">
      ${m.queued.map((l) => html`<li><div class="imail-h"><span class="imail-f mono">${l.from}</span>${l.reply ? html`<span class="tag line">回信</span>` : null}${l.handoff ? html`<span class="tag line">换段信</span>` : null}${l.images > 0 ? html`<span class="mono dim imail-i">${l.images} 图</span>` : null}</div><p class="imail-t" title=${l.first}>${l.first}</p></li>`)}
    </ul>`}
    ${m.queued.length > 0 && html`<p class="inote">排队的信在下一个安全点并进这一轮。只能看，不能撤回。</p>`}
    ${(m.waitedBy.length > 0 || m.waitingOn.length > 0) && html`<dl class="ikv">
      ${m.waitedBy.length > 0 && html`<${Fragment}><dt>等它回信</dt><dd><span class="itags">${m.waitedBy.map((x) => html`<span class="mono itag">${procTag(records, x)}</span>`)}</span></dd></${Fragment}>`}
      ${m.waitingOn.length > 0 && html`<${Fragment}><dt>它在等</dt><dd><span class="itags">${m.waitingOn.map((x) => html`<span class="mono itag">${procTag(records, x)}</span>`)}</span></dd></${Fragment}>`}
    </dl>`}
  </section>`;
}

function ProcOverview({ app }) {
  const id = app.focusedId;
  // 读全部进程记录。它的阶段、排队数、消息数变了就马上再读一次。
  const cur = id !== null ? app.store.procs[id]?.self : undefined;
  const ph0 = cur?.phase;
  const inspected = usePoll(id !== null ? `inspect:${id}` : null, () => api.tauAll({ op: "inspect" }), POLL_MS, cur ? `${ph0?.tag}:${ph0 && ph0.tag !== "idle" ? ph0.queued : 0}:${cur.messages}` : null);
  /** @type {any[]} */
  const records = Array.isArray(inspected.value) ? inspected.value.filter((/** @type {any} */ x) => x?.type === "process").map((/** @type {any} */ x) => x.process) : [];
  if (id === null) return html`<${Note}>没有聚焦的进程。<//>`;
  const entry = app.focused ?? app.entryOf(id);
  const self = app.store.procs[id]?.self ?? entry?.self;
  if (!self) return html`<${Note}>这个进程还没出现，稍等一下。<//>`;
  const ph = self.phase;
  const steps = ph.tag === "idle" ? null : ph.steps;
  const queued = ph.tag === "idle" ? 0 : ph.queued;
  const workdir = entry?.workdir ?? null;
  const tools = entry?.tools ?? null;
  const memory = entry?.memory ?? null;
  const frozen = entry?.frozen ?? null;
  const file = app.presets[self.preset];
  return html`<div class="ipage">
    <${Stats}
      items=${[
        { en: "MSG", label: "本段消息", value: self.messages },
        { en: "STEP", label: "本轮步数", value: steps ?? "—" },
        { en: "QUEUE", label: "信箱待处理", value: queued, hot: queued > 0 },
      ]}
    />
    <div class="ibody">
      <${SegmentRuler} app=${app} id=${id} self=${self} threshold=${frozen?.threshold} />
      <${Mailbox} records=${records} id=${id} />
      <section class="isection">
        <${Sec} zh="预设快照" en="PRESET" />
        <dl class="ikv">
          <dt>预设</dt><dd><span class="mono">${self.preset}</span></dd>
          <dt>模型</dt><dd><span class="mono">${self.model}</span></dd>
          <dt>思考</dt><dd>${frozen === null ? html`<span class="dim">不知道</span>` : frozen.thinking ? html`<span class="mono">${frozen.thinking}</span>` : html`<span class="dim">不思考</span>`}</dd>
          ${frozen?.handoff !== undefined && html`<${Fragment}><dt>换段阈值</dt><dd><span class="mono">${frozen.handoff}</span> token</dd></${Fragment}>`}
          ${frozen?.options !== undefined && html`<${Fragment}><dt>options</dt><dd><span class="mono">${JSON.stringify(frozen.options)}</span></dd></${Fragment}>`}
          <dt>目录</dt><dd>${workdir !== null ? html`<span class="mono">${workdir}</span>` : html`<span class="dim">没有</span>`}</dd>
          <dt>工具</dt><dd><${ToolTags} tools=${tools} /></dd>
          <dt>记忆</dt><dd>${memory === null ? html`<span class="dim">不知道</span>` : memory ? html`带，库名 <span class="mono">${self.preset}</span>` : "不带"}</dd>
        </dl>
        <p class="inote">这是进程冻结的快照，预设文件之后改了也不影响它。</p>
        ${(file || memory) && html`<div class="ilinks">
          ${file && html`<button type="button" class="link ilink" onClick=${(/** @type {Event} */ ev) => app.openDialog("editpreset", /** @type {Element} */ (ev.currentTarget), { preset: self.preset })}><span>改预设</span><${Icon} name="arrow" size=${13} sw=${2.8} /></button>`}
          ${memory && html`<button type="button" class="link ilink" onClick=${(/** @type {Event} */ ev) => app.openDialog("memory", /** @type {Element} */ (ev.currentTarget), { ns: self.preset })}><span>记忆</span><${Icon} name="arrow" size=${13} sw=${2.8} /></button>`}
        </div>`}
      </section>
    </div>
  </div>`;
}

/** 预设提示词里拼的 AGENTS.md 过期了或文件没了。过期时给“重新拼”，只发 `agentsMd: true`。 @param {{ app: import("../app.js").App, pr: Extract<import("../lib/types.js").PresetInfo, { ok: true }> }} p */
function AgentsMdMark({ app, pr }) {
  const [busy, setBusy] = useState(false);
  if (pr.agentsMd === "missing") return html`<div class="agents-stale"><span class="tag warn">AGENTS.md 没了</span><span class="dim">预设里拼的是旧的，新进程还会用它。</span></div>`;
  if (pr.agentsMd !== "stale") return null;
  const regen = async () => {
    setBusy(true);
    try {
      await app.updatePreset({ id: pr.id, agentsMd: true });
      app.toast(`预设 ${pr.id} 重新拼好了。新开的进程用新的，在跑的进程不变`);
    } catch (e) {
      app.toast(`没拼成：${e instanceof Error ? e.message : e}`);
    }
    setBusy(false);
  };
  return html`<div class="agents-stale"><span class="tag acc">AGENTS.md 改过了</span><button type="button" class="link ilink" disabled=${busy} onClick=${regen}>${busy ? "拼接中" : "重新拼"}</button><span class="dim">只对新进程生效。</span></div>`;
}

function ProjOverview({ app, status, branches }) {
  const p = app.project;
  if (!p) return html`<${Note}>还没有项目。<//>`;
  const st = status.value;
  const unmerged = unmergedOf(branches.value);
  return html`<div class="ipage">
    <${Stats}
      items=${[
        { en: "LIVE", label: "在跑", value: p.running, unit: `/${p.entries.length}` },
        { en: "ERROR", label: "出错", value: p.errors, warn: p.errors > 0 },
        { en: "PRESET", label: "预设", value: p.presets.length },
      ]}
    />
    <div class="ibody">
      <section class="isection">
        <${Sec} zh="位置" en="PLACE" />
        <dl class="ikv">
          <dt>目录</dt><dd><span class="mono">${p.path}</span></dd>
          <dt>仓库</dt>
          <dd>${st ? (st.repo ? html`git${st.branch ? html`，在 <span class="mono">${st.branch}</span>` : "，不在任何分支上"}` : html`<span class="dim">不是 git 仓库</span>`) : status.error !== null ? html`<span class="dim">读不到：${status.error}</span>` : html`<span class="dim">读取中…</span>`}</dd>
          ${branches.value && html`<dt>未合并</dt><dd>${unmerged.length === 0 ? "没有" : `${unmerged.length} 个分支`}</dd>`}
        </dl>
      </section>
      <section class="isection">
        <${Sec} zh="预设" en="PRESETS" right=${p.presets.length} />
        ${p.presets.length === 0 && html`<${Note}>这个项目还没有预设。<//>`}
        <ul class="ipresets">
          ${p.presets.map(
            (pr) => html`<li>
              <div class="ipreset-h"><span class="mono ipreset-id">${pr.id}</span><span class=${`tag ${pr.memory ? "acc" : "line"}`}>${pr.memory ? "带记忆" : "不带记忆"}</span>${pr.memory && html`<button type="button" class="link ilink" onClick=${(/** @type {Event} */ ev) => app.openDialog("memory", /** @type {Element} */ (ev.currentTarget), { ns: pr.id })}>记忆</button>`}<button type="button" class="link ilink" onClick=${(/** @type {Event} */ ev) => app.openDialog("editpreset", /** @type {Element} */ (ev.currentTarget), { preset: pr.id })}>改预设</button><${AgentsMdMark} app=${app} pr=${pr} /></div>
              <dl class="ikv small"><dt>模型</dt><dd><span class="mono">${pr.model}</span>${pr.thinking ? html` <span class="tag line">${pr.thinking}</span>` : ""}</dd><dt>工具</dt><dd><${ToolTags} tools=${pr.tools} /></dd></dl>
            </li>`,
          )}
        </ul>
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 改动 */

/** @param {{ path: string, status: string, add: number | null, del: number | null }[]} files */
export function buildTree(files) {
  const mk = (/** @type {string} */ name) => ({ name, dirs: /** @type {Map<string, any>} */ (new Map()), files: /** @type {any[]} */ ([]), add: 0, del: 0, count: 0 });
  const root = mk("");
  for (const f of files) {
    const parts = f.path.split("/");
    const name = parts.pop() ?? f.path;
    let node = root;
    const chain = [root];
    for (const d of parts) {
      let n = node.dirs.get(d);
      if (!n) {
        n = mk(d);
        node.dirs.set(d, n);
      }
      node = n;
      chain.push(n);
    }
    node.files.push({ ...f, name });
    for (const n of chain) {
      n.add += f.add ?? 0;
      n.del += f.del ?? 0;
      n.count += 1;
    }
  }
  return root;
}

/**
 * 摊平成一行行：目录行和文件行。只有一个子目录的目录链并成一行。
 * 目录行的 `key` 是它从根起的路径；`closed` 里有的目录只出一行，不出里面的东西。
 * @param {any} node @param {number} depth @param {any[]} out @param {string} prefix @param {Set<string> | null} closed
 */
export function flatten(node, depth, out = [], prefix = "", closed = null) {
  const byName = (/** @type {any} */ a, /** @type {any} */ b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const d of [...node.dirs.values()].sort(byName)) {
    let cur = d;
    let label = d.name;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      cur = cur.dirs.values().next().value;
      label += `/${cur.name}`;
    }
    const key = `${prefix}${label}/`;
    const open = !closed || !closed.has(key);
    out.push({ kind: "dir", depth, key, label: `${label}/`, add: d.add, del: d.del, count: d.count, open });
    if (open) flatten(cur, depth + 1, out, key, closed);
  }
  const files = [...node.files].sort(byName);
  files.forEach((f, i) => out.push({ kind: "file", depth, file: f, last: i === files.length - 1 }));
  return out;
}

/** porcelain 的两位状态码 → 一个字母和读屏用的字。 */
export function statusLetter(/** @type {string} */ code) {
  if (code === "??") return ["A", "新"];
  const c = code[0] !== " " && code[0] !== undefined ? code[0] : (code[1] ?? "M");
  const label = { A: "新", M: "改", D: "删", R: "改名", C: "复制", U: "冲突", T: "改类型" }[/** @type {"A"} */ (c)] ?? "改";
  return [c, label];
}

/** 文件多时，一开始只展开最上一层目录。 */
const TREE_OPEN_MAX = 15;

/** @param {{ files: any[], onOpen: (path: string, el: Element) => void }} p */
function FileTree({ files, onOpen }) {
  const tree = buildTree(files);
  const dirKeys = flatten(tree, 0).filter((r) => r.kind === "dir");
  const [closed, setClosed] = useState(() => new Set(files.length > TREE_OPEN_MAX ? dirKeys.filter((r) => r.depth > 0).map((r) => r.key) : []));
  const rows = flatten(tree, 0, [], "", closed);
  const toggle = (/** @type {string} */ key) => {
    const next = new Set(closed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setClosed(next);
  };
  const anyOpen = dirKeys.some((r) => !closed.has(r.key));
  return html`<ul class="itree">
    ${dirKeys.length > 1 && html`<li class="ttools"><button type="button" class="link" onClick=${() => setClosed(new Set(anyOpen ? dirKeys.map((r) => r.key) : []))}>${anyOpen ? "全部折起" : "全部展开"}</button></li>`}
    ${rows.map((r) => {
      if (r.kind === "dir") {
        return html`<li key=${`d${r.key}`}><button type="button" class=${`trow dir ${r.open ? "" : "shut"}`} aria-expanded=${r.open} onClick=${() => toggle(r.key)} style=${`padding-left:${12 + r.depth * 16}px`}>
          <span class="tchev" aria-hidden="true"><${Icon} name="down" size=${12} sw=${3} /></span>
          <${Icon} name="folder" size=${14} sw=${2} /><span class="mono trow-n">${r.label}${!r.open && html`<span class="tcount"> ${r.count} 个文件</span>`}</span><${Delta} add=${r.add} del=${r.del} />
        </button></li>`;
      }
      const f = r.file;
      const [letter, label] = statusLetter(f.status);
      const nested = r.depth > 0;
      const left = 25 + (r.depth - 1) * 16;
      return html`<li key=${f.path}>
        <button type="button" class="trow file" aria-haspopup="dialog" onClick=${(/** @type {Event} */ ev) => onOpen(f.path, /** @type {Element} */ (ev.currentTarget))} style=${`padding-left:${nested ? 42 + (r.depth - 1) * 16 : 18}px`}>
          ${nested && html`<span aria-hidden="true" class="tl" style=${`left:${left}px;${r.last ? "height:50%" : "bottom:0"}`}></span><span aria-hidden="true" class="tl h" style=${`left:${left}px`}></span>`}
          <span class=${`tmark ${letter === "A" ? "add" : letter === "D" ? "del" : ""}`} aria-label=${label}>${letter}</span>
          <span class="mono trow-n">${f.name}</span>
          <${Delta} add=${f.add} del=${f.del} />
        </button>
      </li>`;
    })}
  </ul>`;
}

function fmtCommitTime(/** @type {number} */ t, /** @type {number} */ now) {
  const d = new Date(t);
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return now - t < 24 * 3600_000 ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function CommitList({ commits, now }) {
  return html`<ul class="icommits">
    ${commits.slice(0, 8).map((c) => html`<li key=${c.hash}><span class="mono dim">${c.short}</span><span class="csub">${c.subject}</span><span class="mono dim">${fmtCommitTime(c.time, now)}</span></li>`)}
  </ul>`;
}

/** 没合并的分支（主分支自己不算）。 */
function unmergedOf(/** @type {any} */ b) {
  if (!b || !Array.isArray(b.branches)) return [];
  return b.branches.filter((x) => !x.merged && x.name !== b.main);
}

function ProcChanges({ app, workdir, status }) {
  const st = status.value;
  const files = st && st.repo ? st.files : [];
  const sig = files.map((f) => `${f.path}:${f.status}:${f.add}:${f.del}`).join("|");
  const br = usePoll(st && st.repo ? `br|${workdir}` : null, () => api.git(workdir, "branches"), 3 * POLL_MS);
  const lg = usePoll(st && st.repo ? `lg|${workdir}` : null, () => api.git(workdir, "log"), 3 * POLL_MS, sig);
  if (!st) return html`<div class="ipage"><div class="ibody"><${Waiting} st=${status} what="读不到 git 状态" /></div></div>`;
  if (!st.repo) return html`<div class="ipage"><div class="ibody"><${Note}>这个目录不是 git 仓库，没有改动可看。<//></div></div>`;
  const add = files.reduce((n, f) => n + (f.add ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.del ?? 0), 0);
  const bd = br.value;
  const mine = bd && Array.isArray(bd.branches) ? bd.branches.find((b) => b.current) : null;
  const onMain = mine && mine.name === bd.main;
  const shared = app.entries.filter((e) => e.workdir !== null && pathKey(e.workdir) === pathKey(workdir)).length;
  return html`<div class="ipage">
    <${Stats}
      items=${[
        { en: "FILES", label: "改动文件", value: files.length },
        { en: "DIFF", label: "增 / 删", pair: [`+${add}`, `−${del}`] },
        { en: "AHEAD", label: bd && bd.main ? `领先 ${bd.main}` : "领先主分支", value: mine && !onMain ? mine.ahead : "—", unit: mine && !onMain ? "提交" : "" },
      ]}
    />
    <div class="ibody wide">
      <dl class="ichips">
        <div><dt>分支</dt><dd class="mono">${st.branch ?? "（没在分支上）"}</dd></div>
        ${bd && bd.main && mine && !onMain && html`<div><dt>基于</dt><dd class="mono">${bd.main}</dd></div><div><dt>状态</dt><dd>${mine.merged ? "已合并" : "没合并"}</dd></div>`}
      </dl>
      ${shared > 1 && html`<${Note} kind="warn">这个工作目录有 ${shared} 个进程共用，看不出改动是谁做的。<//>`}
      ${shared <= 1 && html`<${Note}>这是工作目录里的改动，git 的原样输出。<//>`}
      <section class="isection flush">
        <div class="pad"><${Sec} zh="工作区" en="FILES" right=${files.length} /></div>
        ${files.length === 0 ? html`<div class="pad"><${Note}>工作区是干净的。<//></div>` : html`<${FileTree} files=${files} onOpen=${(/** @type {string} */ file, /** @type {Element} */ el) => app.openDialog("diff", el, { workdir, file, files })} />`}
      </section>
      <section class="isection">
        <${Sec} zh="提交" en="COMMITS" right=${lg.value ? lg.value.commits.length : ""} />
        ${lg.value ? (lg.value.commits.length === 0 ? html`<${Note}>还没有提交。<//>` : html`<${CommitList} commits=${lg.value.commits} now=${Date.now()} />`) : html`<${Waiting} st=${lg} what="读不到提交" />`}
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 分支 */

function ProjBranches({ app, workdir, status, branches }) {
  const p = app.project;
  const lg = usePoll(`lg|${workdir}`, () => api.git(workdir, "log"), 3 * POLL_MS);
  const bd = branches.value;
  if (!bd) return html`<div class="ipage"><div class="ibody"><${Waiting} st=${branches} what="读不到分支" /></div></div>`;
  const list = /** @type {any[]} */ (bd.branches);
  if (list.length === 0) return html`<div class="ipage"><div class="ibody"><${Note}>这个目录没有分支，可能不是 git 仓库。<//></div></div>`;
  const un = unmergedOf(bd);
  const files = status.value && status.value.repo ? status.value.files.length : null;
  const rank = (/** @type {any} */ b) => (b.name === bd.main ? 0 : !b.merged ? 1 : 2);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const last = lg.value && lg.value.commits[0];
  return html`<div class="ipage">
    <${Stats}
      items=${[
        { en: "BRANCH", label: "分支", value: list.length },
        { en: "OPEN", label: "没合并", value: un.length },
        { en: "FILES", label: "改动文件", value: files ?? "—" },
      ]}
    />
    <div class="ibody wide">
      <ul class="ibranches">
        ${sorted.map((b) => {
          const isMain = b.name === bd.main;
          const tag = isMain ? "主分支" : b.merged ? "已合并" : "没合并";
          return html`<li key=${b.name} class=${!isMain && !b.merged ? "open" : ""}>
            <div class="ibr-h"><span class="mono ibr-n">${b.name}</span>${b.current && html`<span class="tag line">当前</span>`}<span class=${`tag ${!isMain && !b.merged ? "acc" : "line"}`}>${tag}</span></div>
            <div class="ibr-s dim">${isMain ? "其它分支都和它比。" : html`领先 ${b.ahead} 提交，落后 ${b.behind}${b.add || b.del ? html` · <${Delta} add=${b.add} del=${b.del} />` : ""}`}</div>
          </li>`;
        })}
      </ul>
      <section class="isection">
        <${Sec} zh="主分支" en="MAIN" />
        <dl class="ikv">
          <dt>最新</dt><dd>${last ? html`<span class="mono dim">${last.short}</span> ${last.subject}` : html`<span class="dim">${lg.error !== null ? "读不到" : "读取中…"}</span>`}</dd>
          ${last && html`<dt>时间</dt><dd class="mono">${fmtCommitTime(last.time, Date.now())}</dd>`}
          <dt>工作区</dt><dd>${files === null ? "—" : files === 0 ? "干净" : `${files} 个文件有改动`}</dd>
        </dl>
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 后台 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** log 的末尾：去掉颜色码，只留最后几行。 */
function tailLines(/** @type {string} */ tail, full) {
  const lines = tail.replace(ANSI, "").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  if (full) return lines.join("\n");
  return lines.slice(-6).join("\n").slice(-700);
}

function BgCard({ app, log }) {
  const [open, setOpen] = useState(false);
  const ago = app.now - app.clock(log.mtime);
  const noExit = log.exit === null;
  const kind = noExit ? "run" : log.exit === 0 ? "ok" : "bad";
  const fresh = noExit && ago < 120_000;
  const text = tailLines(log.tail, open);
  const plain = log.tail.replace(ANSI, "").replace(/\n+$/, "");
  const more = plain.split("\n").length > 6 || plain.length > 700 || log.size > new TextEncoder().encode(log.tail).length;
  return html`<li class=${`bgcard ${kind}`}>
    <span aria-hidden="true" class=${`bgbar ${fresh ? "pulse" : ""}`}></span>
    <div class="bg-h"><span class="bgtag">${noExit ? "没看到退出码" : `退出 ${log.exit}`}</span><span class="mono bg-n">${log.name}</span><span class="mono dim bg-t">${formatAgo(ago)}</span></div>
    ${text.trim() !== "" ? html`<pre class="bg-pre">${text}</pre>` : html`<p class="inote bg-empty">log 里还没有输出。</p>`}
    <div class="bg-f dim">
      <span>最后输出在 ${formatAgo(ago)}</span>
      ${more && html`<button type="button" class="link" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? "收起" : "展开"}</button>`}
      <span class="mono ell bg-file">log：${log.process}-${log.name}.log</span>
    </div>
  </li>`;
}

function sortLogs(/** @type {any[]} */ logs) {
  return [...logs].sort((a, b) => (a.exit === null ? 0 : 1) - (b.exit === null ? 0 : 1) || b.mtime - a.mtime);
}

function BgPage({ app, ids, bgs, project }) {
  const logs = bgs.value;
  if (ids.length === 0) return html`<div class="ipage"><div class="ibody"><${Note}>没有进程。<//></div></div>`;
  if (!logs) return html`<div class="ipage"><div class="ibody"><${Waiting} st=${bgs} what="读不到后台 log" /></div></div>`;
  const run = logs.filter((l) => l.exit === null).length;
  const bad = logs.filter((l) => l.exit !== null && l.exit !== 0).length;
  /** @type {Record<string, any[]>} */
  const by = {};
  for (const l of logs) (by[l.process] ??= []).push(l);
  const groups = ids.filter((i) => by[i]);
  return html`<div class="ipage">
    <${Stats}
      items=${[
        { en: "RUNNING", label: "没看到退出码", value: run },
        { en: "EXITED", label: "已退出", value: logs.length - run },
        { en: "FAILED", label: "退出码非 0", value: bad, warn: bad > 0 },
      ]}
    />
    <div class="ibody">
      <p class="inote">按后台命令的配方跑的命令，log 在 <span class="mono fg">~/.tau/extras/bg/</span>。${project ? "停止进程不会结束它们。" : ""}</p>
      ${!project && html`<div class="iband"><span class="tx" aria-hidden="true"></span><i aria-hidden="true"></i><span>停止这个进程，不会结束它们</span></div>`}
      ${logs.length === 0 && html`<${Note}>${project ? "这个项目的进程" : "这个进程"}还没有后台命令的 log。<//>`}
      ${project
        ? groups.map((id) => {
            const e = app.entryOf(id);
            return html`<section class="isection" key=${id}>
              <${Sec} zh=${e?.name ?? id} en=${id} right=${by[id].length} />
              <ul class="bglist">${sortLogs(by[id]).map((l) => html`<${BgCard} key=${l.name} app=${app} log=${l} />`)}</ul>
            </section>`;
          })
        : html`<ul class="bglist">${sortLogs(logs).map((l) => html`<${BgCard} key=${`${l.process}-${l.name}`} app=${app} log=${l} />`)}</ul>`}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 壳 */

/** 竖选项卡上的小计数。`hot` 黄底，`run` 带闪的方块。 */
function Count({ n, hot, run }) {
  if (!n) return null;
  return html`<span class=${`itab-c ${hot ? "hot" : ""}`}>${run && html`<i class="pulse" aria-hidden="true"></i>`}${n}</span>`;
}

/** @param {{ app: import("../app.js").App }} p */
export function Inspector({ app }) {
  const isProc = app.focusKind === "process";
  const isProj = app.focusKind === "project";
  const tabs = isProc ? PROC_TABS : PROJ_TABS;
  const tab = Math.min(app.tab, 2);
  const workdir = isProc ? (app.focused?.workdir ?? app.entryOf(app.focusedId ?? "")?.workdir ?? null) : isProj ? (app.project?.path ?? null) : null;
  const ids = isProc ? (app.focusedId ? [app.focusedId] : []) : isProj ? (app.project?.entries.map((e) => e.id) ?? []) : [];
  const scope = isProc ? "p" : "j";

  const status = usePoll(workdir !== null ? `st|${workdir}` : null, () => api.git(/** @type {string} */ (workdir), "status"), POLL_MS);
  // 项目的分支数据要给选项卡的计数用，所以一直读；进程的分支只在改动页读。
  const branches = usePoll(isProj && workdir !== null ? `br|${workdir}` : null, () => api.git(/** @type {string} */ (workdir), "branches"), 2 * POLL_MS);
  const bgKey = ids.length > 0 ? `bg|${scope}|${ids.join(",")}` : null;
  const bgs = usePoll(bgKey, () => api.bg(ids), POLL_MS);

  const files = status.value && status.value.repo ? status.value.files.length : 0;
  const running = bgs.value ? bgs.value.filter((/** @type {any} */ l) => l.exit === null).length : 0;
  const unmerged = unmergedOf(branches.value).length;
  const counts = isProc ? [null, files, running] : [null, unmerged, running];
  const hot = [false, !isProc, false];
  const label = tabs[tab]?.[1] ?? "";
  const en = isProc ? ["OVERVIEW", "CHANGES", "BACKGROUND"][tab] : ["OVERVIEW", "BRANCHES", "BACKGROUND"][tab];
  const sub = isProc ? app.focusedId : app.project?.name;
  const tabLabel = (/** @type {number} */ i) => {
    const n = counts[i];
    const name = tabs[i]?.[1] ?? "";
    if (!n) return name;
    return `${name}，${n} ${i === 2 ? "个没看到退出码" : isProc ? "个文件" : "个没合并"}`;
  };

  /** @type {any} */
  let page;
  if (!isProc && !isProj) page = html`<${Note}>还没有项目，先打开一个。<//>`;
  else if (tab === 0) page = isProc ? html`<${ProcOverview} app=${app} />` : html`<${ProjOverview} app=${app} status=${status} branches=${branches} />`;
  else if (tab === 1) {
    if (workdir === null) page = html`<div class="ipage"><div class="ibody"><${Note}>这个进程没有工作目录。<//></div></div>`;
    else page = isProc ? html`<${ProcChanges} key=${workdir} app=${app} workdir=${workdir} status=${status} />` : html`<${ProjBranches} key=${workdir} app=${app} workdir=${workdir} status=${status} branches=${branches} />`;
  } else page = html`<${BgPage} app=${app} ids=${ids} bgs=${bgs} project=${isProj} />`;

  return html`<aside class="inspector" aria-label="详情">
    <div class="insp-col">
      <${Tex} kind="tx-grid-d" mask="linear-gradient(transparent 35%, #000 100%)" />
      <div class="insp-head"><${Tex} kind="tx-hatch-d" mask="linear-gradient(90deg, transparent 35%, #000 100%)" /><h2>${label}</h2><span class="label dim">${en}</span><span class="mono ell insp-sub">${sub ?? ""}</span></div>
      <div role="tabpanel" aria-label=${label} class="insp-body" key=${`${tab}|${app.focusKind}`}>${page}</div>
    </div>
    <div role="tablist" aria-orientation="vertical" aria-label="详情的选项卡" class="insp-tabs">
      <${Tex} kind="tx-hatch-d" mask="linear-gradient(transparent 55%, #000 100%)" />
      ${tabs.map(([icon, name], i) => html`<button type="button" role="tab" class="itab" aria-selected=${tab === i} aria-label=${tabLabel(i)} onClick=${() => app.setTab(i)}>
        <span class="mono itab-n">${String(i + 1).padStart(2, "0")}</span><${Icon} name=${icon} size=${18} sw=${2.4} /><span class="itab-t">${name}</span>
        <${Count} n=${counts[i]} hot=${hot[i]} run=${i === 2} />
      </button>`)}
      <span class="label itab-foot" aria-hidden="true">INSPECTOR / 03</span>
    </div>
  </aside>`;
}
