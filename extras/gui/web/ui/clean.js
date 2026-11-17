// 清理旧进程弹窗（设计稿 7.5）：先列清楚删哪些、留哪些，再一个一个删（叶子在前），最后清图片。删了找不回，记忆不动。
import { html, Popover, DlgHead, SecHead, Pill, Icon, useState, useEffect, useRef, Fragment } from "./common.js";
import { tauAll, tauCommand, tauStream } from "../api.js";
import { activityAt } from "../lib/derive.js";
import { cleanPlan } from "../lib/order.js";
import { extractTitle } from "../lib/titles.js";
import { formatDuration } from "../lib/format.js";

/** @typedef {import("../app.js").App} App */
/** @typedef {{ id: string, title: string, who: string, idle: string }} Item */
/** @typedef {"wait" | "doing" | "ok" | "refused" | "skipped"} Step */

const MAX_DAYS = 3650;

/**
 * 读一个进程当前段最后一条消息的时间戳（服务时钟）。读不到是 null。
 * @param {string} id @param {number} segment @param {number} messages
 * @returns {Promise<number | null>}
 */
async function readLastStamp(id, segment, messages) {
  if (messages <= 0) return null;
  /** @type {number | null} */
  let ts = null;
  try {
    await tauStream({ op: "history", process: id, segment, from: messages - 1 }, (r) => {
      if (r.type === "message" && typeof r.message?.timestamp === "number") ts = r.message.timestamp;
      return r.type === "end" || r.type === "error";
    });
  } catch {
    return null;
  }
  return ts;
}

/**
 * 读第 1 段的第一封信，取标题。读不到是 null。
 * @param {string} id
 * @returns {Promise<string | null>}
 */
async function readTitle(id) {
  /** @type {any} */
  let first = null;
  try {
    await tauStream({ op: "history", process: id, segment: 1, from: 0 }, (r) => {
      if (r.type === "message" && r.message.role === "user") {
        first = r.message;
        return true;
      }
      return r.type === "end" || r.type === "error";
    });
  } catch {
    return null;
  }
  return first ? extractTitle([first]) : null;
}

/** @param {{ n: number | string, label: string, tone?: "warn" | "acc" }} p */
function Stat({ n, label, tone }) {
  return html`<div class=${`cl-stat ${tone ?? ""}`}><span class="num">${n}</span><span>${label}</span></div>`;
}

/** @param {{ item: Item, step?: Step, note?: string }} p */
function Line({ item, step, note }) {
  return html`<li class=${`cl-line ${step ?? ""}`}>
    <span class="cl-mark" aria-hidden="true">${step === "ok" ? html`<${Icon} name="check" size=${14} sw=${3} />` : step === "refused" ? html`<${Icon} name="close" size=${14} sw=${3} />` : step === "doing" ? html`<i class="pulse"></i>` : ""}</span>
    <span class="cl-id mono">${item.id}</span>
    <span class="cl-t ell" title=${item.title}>${item.title}</span>
    <span class="cl-who ell">${item.who}</span>
    <span class="cl-idle">${item.idle}</span>
    ${note && html`<span class="cl-note">${note}</span>`}
  </li>`;
}

/** @param {{ app: App, onClose: () => void }} p */
export function CleanDialog({ app, onClose }) {
  const appRef = useRef(app);
  appRef.current = app;
  const alive = useRef(true);
  const stopped = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
      stopped.current = true;
    },
    [],
  );

  const [daysText, setDaysText] = useState(String(app.gui.cleanDays));
  /** 没读到最后动静的进程，读回来的时刻（页面时钟）。没有消息可读的记 -1。 */
  const [fill, setFill] = useState(/** @type {Record<string, number>} */ ({}));
  const tried = useRef(/** @type {Set<string>} */ (new Set()));
  const [reading, setReading] = useState(0);

  const [phase, setPhase] = useState(/** @type {"plan" | "run" | "done"} */ ("plan"));
  const [items, setItems] = useState(/** @type {Item[]} */ ([]));
  const [steps, setSteps] = useState(/** @type {Record<string, { s: Step, msg?: string }>} */ ({}));
  const [sweep, setSweep] = useState(/** @type {{ s: "wait" | "doing" | "ok" | "fail" | "skipped", n?: number, msg?: string }} */ ({ s: "wait" }));

  // 清理只删有最后动静时刻的进程。没有的先读，读完才给计划。
  useEffect(() => {
    if (phase !== "plan") return;
    const todo = app.entries.filter((e) => e.status !== "running" && app.lastAt[e.id] === undefined && fill[e.id] === undefined && !tried.current.has(e.id));
    if (todo.length === 0) return;
    for (const e of todo) tried.current.add(e.id);
    setReading((n) => n + todo.length);
    (async () => {
      /** @type {Record<string, number>} */
      const got = {};
      const queue = todo.slice();
      const worker = async () => {
        for (let e = queue.shift(); e && alive.current; e = queue.shift()) {
          const ts = await readLastStamp(e.id, e.self.segment, e.self.messages);
          if (ts !== null) got[e.id] = ts - appRef.current.skew;
          setReading((n) => n - 1);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (alive.current) setFill((f) => ({ ...f, ...got }));
    })();
  }, [phase, app.entries.length]);

  const lastAt = { ...app.lastAt, ...fill };
  const days = Number(daysText);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
  const state = daysOk ? { ...app.gui, cleanDays: days } : app.gui;
  const plan = cleanPlan(app.entries, { state, lastAt, clientNow: app.now });

  /** @param {string} id @returns {Item} */
  const itemOf = (id) => {
    const a = appRef.current;
    const e = a.byId[id];
    const t = a.titleOf(id);
    const who = e ? (e.kind === "temp" ? "临时" : e.name) : "";
    const la = { ...a.lastAt, ...fill };
    return { id, title: t.title, who, idle: e ? `空闲 ${formatDuration(a.now - Math.max(activityAt(e, la), e.createdAt))}` : "" };
  };

  const changeDays = (/** @type {string} */ v) => {
    setDaysText(v);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DAYS && n !== app.gui.cleanDays) app.setGui({ cleanDays: n }).catch(() => {});
  };

  const go = async () => {
    const ids = plan.remove.slice();
    if (ids.length === 0 || !daysOk) return;
    stopped.current = false;
    setItems(ids.map(itemOf));
    setSteps(Object.fromEntries(ids.map((id) => [id, { s: /** @type {Step} */ ("wait") }])));
    setSweep({ s: "wait" });
    setPhase("run");

    // 先把标题缓存下来：删了以后第 1 段就没了。
    /** @type {Record<string, string>} */
    const batch = {};
    for (const id of ids) {
      if (appRef.current.titleOf(id).known) continue;
      const t = await readTitle(id);
      if (t !== null) batch[id] = t;
    }
    if (Object.keys(batch).length > 0) {
      try {
        await appRef.current.setGui((g) => ({ titles: { ...g.titles, ...batch } }));
      } catch {
        // 提示已经弹了；标题缓存失败不拦着清理，只是以后这几个进程显示 ID。
      }
    }

    for (const id of ids) {
      if (stopped.current) break;
      setSteps((s) => ({ ...s, [id]: { s: "doing" } }));
      try {
        await tauCommand({ op: "remove", process: id });
        if (alive.current) setSteps((s) => ({ ...s, [id]: { s: "ok" } }));
      } catch (e) {
        if (alive.current) setSteps((s) => ({ ...s, [id]: { s: "refused", msg: e instanceof Error ? e.message : String(e) } }));
      }
    }
    if (stopped.current) {
      if (alive.current) {
        setSweep({ s: "skipped" });
        setPhase("done");
      }
      return;
    }
    if (alive.current) setSweep({ s: "doing" });
    try {
      const rs = await tauAll({ op: "sweep" });
      const n = rs.find((r) => r.type === "swept")?.blobs ?? 0;
      if (alive.current) setSweep({ s: "ok", n });
    } catch (e) {
      if (alive.current) setSweep({ s: "fail", msg: e instanceof Error ? e.message : String(e) });
    }
    if (alive.current) setPhase("done");
  };

  const count = (/** @type {Step} */ s) => items.filter((it) => steps[it.id]?.s === s).length;
  const refused = items.filter((it) => steps[it.id]?.s === "refused");
  const left = items.filter((it) => steps[it.id]?.s === "wait" || steps[it.id]?.s === "doing").length;
  const total = items.length;
  const sub = `空闲超过 ${daysOk ? days : app.gui.cleanDays} 天的临时进程，和常驻团队里不是当前进程的进程`;

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="清理旧进程" width=${620} est=${680} class="clean">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="trash" title="清理旧进程" en="CLEAN UP" sub=${sub} onClose=${close} />
      ${phase === "plan" &&
      html`<div class="dlg-body">
        <div class="cl-days">
          <label for="cl-days-in">空闲超过</label>
          <input id="cl-days-in" class="input mono" type="number" min="1" max=${MAX_DAYS} step="1" value=${daysText} aria-invalid=${!daysOk} onInput=${(/** @type {any} */ e) => changeDays(e.currentTarget.value)} />
          <span>天的算旧的。</span>
          <span class="dnote">当前进程永远不清理。</span>
        </div>
        ${!daysOk && html`<p class="dnote" style="color:var(--warn)">天数要写 1 到 ${MAX_DAYS} 的整数。</p>`}
        <div class="cl-stats">
          <${Stat} n=${plan.remove.length + plan.blocked.length} label=${`空闲超过 ${daysOk ? days : app.gui.cleanDays} 天`} />
          <${Stat} n=${plan.remove.length} label="这次删掉" tone="warn" />
          <${Stat} n=${plan.blocked.length} label="删不了，留着" />
        </div>
        ${reading > 0 && html`<p class="dnote">正在读 ${reading} 个进程最后一条消息的时间。读完才能算出该删哪些。</p>`}

        <${SecHead} n="01" title="删掉的" en="REMOVE" right=${html`<span class="dnote" style="font-size:11px">从叶子往上删</span>`} />
        ${plan.remove.length === 0
          ? html`<p class="dnote">${reading > 0 ? "稍等。" : "没有要清理的进程。"}</p>`
          : html`<ul class="cl-list" aria-label="要删掉的进程">${plan.remove.map((id) => html`<${Line} key=${id} item=${itemOf(id)} />`)}</ul>`}

        ${plan.blocked.length > 0 &&
        html`<${Fragment}>
          <${SecHead} n="02" title="留着的" en="KEPT" right=${html`<span class="dnote" style="font-size:11px">它开的进程还在</span>`} />
          <ul class="cl-list" aria-label="删不了的进程">${plan.blocked.map((b) => html`<${Line} key=${b.id} item=${itemOf(b.id)} note=${b.reason} />`)}</ul>
        </${Fragment}>`}
        <p class="dnote">还有两种情况现在看不出来：有进程要给它回信，或者信箱里有它的输入。删的时候服务会拒绝，删完把被拒的和原因列出来。</p>

        <div class="cl-warn" role="note">
          <b>删了找不回。</b>删掉的是进程记录和它的全部段。记忆不动。图片没人引用以后，另外清。
        </div>
      </div>
      <div class="dlg-foot">
        <span class="cmdline">${plan.remove.length > 0 ? `remove × ${plan.remove.length}，按这个顺序一个一个删` : ""}</span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="warn" icon="trash" label=${`删掉 ${plan.remove.length} 个`} disabled=${plan.remove.length === 0 || reading > 0 || !daysOk} onClick=${go} />
      </div>`}
      ${phase !== "plan" &&
      html`<div class="dlg-body">
        <div class="cl-stats">
          <${Stat} n=${count("ok")} label=${phase === "run" ? `已删，共 ${total} 个` : "删掉了"} tone="warn" />
          <${Stat} n=${count("refused")} label="被拒绝，留着" />
          <${Stat} n=${sweep.s === "ok" ? (sweep.n ?? 0) : "–"} label=${sweep.s === "doing" ? "正在清图片" : sweep.s === "ok" ? "张图片没人引用，已清" : "清图片"} />
        </div>
        <${SecHead} n="01" title=${phase === "run" ? "正在删" : "删的结果"} en="PROGRESS" right=${html`<span class="dnote" style="font-size:11px">${phase === "run" ? `剩 ${left} 个` : left > 0 ? `停下了，${left} 个没动` : ""}</span>`} />
        <ul class="cl-list tall" aria-label="删除进度" aria-live="polite">${items.map((it) => html`<${Line} key=${it.id} item=${it} step=${steps[it.id]?.s} note=${steps[it.id]?.msg} />`)}</ul>
        ${phase === "done" &&
        html`<${Fragment}>
          ${refused.length > 0 && html`<p class="dnote">被拒的${refused.length}个，原因是服务给的，原样写在上面。过一阵再清一次，条件也许就变了。</p>`}
          ${sweep.s === "ok" && html`<p class="dnote">图片：清掉 ${sweep.n ?? 0} 张。</p>`}
          ${sweep.s === "fail" && html`<p class="dnote" style="color:var(--warn)">清图片没成功：${sweep.msg}</p>`}
          ${sweep.s === "skipped" && html`<p class="dnote">中途停下了，没有清图片。</p>`}
        </${Fragment}>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline">${phase === "run" ? "删了找不回。关掉这个窗口会停下，已经删的不能撤销。" : ""}</span>
        ${phase === "run" ? html`<${Pill} label="停下" onClick=${() => (stopped.current = true)} />` : html`<${Pill} kind="accent" icon="check" label="完成" onClick=${close} />`}
      </div>`}
    </${Fragment}>`}
  </${Popover}>`;
}
