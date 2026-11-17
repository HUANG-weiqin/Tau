// 聚焦的进程：铭牌、消息流、写信框。出错时铭牌变橙，流的末尾是结束带。
import { html, Icon, Pill, Tex, Contour, pad2, useRef, useState, useLayoutEffect, Fragment } from "./common.js";
import { toItems, foldMiddle, forkPoints, turnStart, clipText, phaseStartedAt, HANDOFF_LETTER } from "../lib/messages.js";
import { askRemove } from "./remove.js";
import { segmentMessages } from "../lib/history.js";
import { contextPercent, formatClock } from "../lib/format.js";
import { Band, FoldRow, Ts, UserRow, HandoffRow, AssistantRow, OrphanRow, LiveRow } from "./messages.js";
import { Compose } from "./compose.js";

/** 上一轮没有正常结束时，下一条消息前面自动加的说明（内核 decide.ts 的 `endedNote`，这里只用来预告）。 */
const WAITED = "如果有进程在等你回信，它们已经收到上一轮的结束通知，之后的回复不会寄给它们。";
/** @param {any} ended */
function carryNote(ended) {
  if (ended === "stopped") return "（上一轮被停止。上面还没回复的消息都已取消：不要回应它们，只回应下面的信。）";
  if (ended === "stepLimit") return `（上一轮的步数用完了，停在中途。${WAITED}）`;
  if (ended && typeof ended === "object") return `（上一轮出错，没有做完：${ended.error}。${WAITED}）`;
  return null;
}

/** 铭牌右边：上下文占窗口几成、段尺。 */
function Ctx({ e, error, segMessages }) {
  const pct = contextPercent(e.self.context);
  const full = Math.floor(pct / 10);
  const part = pct % 10 >= 3;
  return html`<div class="ctx">
    <div class="ctx-l"><b>第 ${e.self.segment} 段</b><span>上下文已用</span></div>
    <div class="ctx-n"><span class="num ctx-big">${pct}</span><span class="num ctx-pc">%</span></div>
    <div class=${`ctx-bar ${error ? "w" : ""}`} role="img" aria-label=${`上下文已用 ${pct}%`}>${Array.from({ length: 10 }, (_, i) => html`<span class=${i < full ? "f" : i === full && part ? "p" : ""}></span>`)}</div>
    <div class="mono ctx-m">这一段 ${segMessages} 条消息</div>
  </div>`;
}

/** @param {{ app: import("../app.js").App, e: import("../lib/derive.js").Entry }} p */
function Plate({ app, e }) {
  const d = app.describe(e);
  const error = e.status === "error";
  const running = e.status === "running";
  const parent = e.self.parent;
  const title = app.titleOf(e.id);
  const big = e.kind === "temp" ? title.title : e.name;
  const seg = e.self.segment;
  const lastLabel = running ? "已等" : "已空闲";
  return html`<section class=${`plate-wrap ${error ? "err" : ""}`} aria-label="当前聚焦的进程">
    <${Tex} kind="tx-grid-d2" />
    <div class=${`plate ${error ? "err" : ""}`} key=${error ? "e" : "n"}>
      <${Tex} kind="tx-dots-y" mask="linear-gradient(100deg, transparent 50%, #000 96%)" />
      <div style="position:relative">
        <div class="plate-top"><span class="tag">当前聚焦</span><span class="mono" style="font-size:11px">${app.project?.name ?? "总管"} / ${e.id}</span></div>
        <div class="plate-name">
          <h1 class=${e.kind === "temp" ? "small" : ""} title=${big}>${big}</h1>
          <span class="label" style="font-size:15px;letter-spacing:.16em">${e.preset}</span>
        </div>
        ${e.kind === "temp" && title.note && html`<div class="mono" style="font-size:11px;margin-top:6px">${title.note}</div>`}
        <dl class="plate-tags">
          <div><dt>阶段</dt><dd>${d.label}</dd></div>
          ${error && html`<div><dt>上一轮</dt><dd class="w">出错</dd></div>`}
          ${e.self.phase.tag === "idle" && e.self.phase.ended && !error ? html`<div><dt>上一轮</dt><dd>${d.endedText}</dd></div>` : null}
          <div><dt>${lastLabel}</dt><dd class="mono">${d.dur}</dd></div>
          ${parent && html`<div><dt>父进程</dt><dd class="mono">${parent}</dd></div>`}
        </dl>
      </div>
    </div>
    <div class="plate-r">
      <span class="slash xl-only" aria-hidden="true"></span>
      <${Ctx} e=${e} error=${error} segMessages=${e.self.messages} />
      <div class="plate-act">
        <${Pill} label="分叉" icon="fork" disabled=${running} title=${running ? "进程在跑时不能复制整个段。可以在某条消息上分叉" : "复制整个当前段，开一个新进程"} onClick=${() => app.fork(e.id)} />
        <${Pill} label="换段" icon="reply" disabled=${running} title=${running ? "进程在跑时不能换段" : "请模型调用 handoff 换段：下一轮只带交接说明，不用按整段重新算"} onClick=${() => app.send(e.id, HANDOFF_LETTER)} />
        <${Pill} label="停止" icon="stop" chip="red" disabled=${!running} title="Ctrl+. 按两次" onClick=${() => app.stop(e.id)} />
        <${Pill} label="删除" icon="trash" chip="red" disabled=${running} title=${running ? "进程在跑时不能删除" : "删掉这个进程和它的全部段"} onClick=${(/** @type {Event} */ ev) => askRemove(e.id, /** @type {Element} */ (ev.currentTarget))} />
      </div>
    </div>
  </section>`;
}

/** 这一轮的结束带（出错）。 */
function EndBand({ app, e, ts, turn, msgs }) {
  const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
  const reason = ended && typeof ended === "object" ? ended.error : "";
  const broke = msgs.some((m) => m.role === "toolResult" && m.isError && (m.content[0]?.type === "text" ? m.content[0].text === "被中断，结果未知" : false));
  return html`<section class="endband" aria-label="这一轮出错">
    <span class="eb-stripe" aria-hidden="true"></span>
    <${Tex} kind="tx-grid-d2" mask="linear-gradient(90deg, transparent 40%, #000 100%)" />
    <div class="eb-ts wide-only">${ts !== null ? formatClock(app.clock(ts)) : ""}<span class="tick" aria-hidden="true"></span></div>
    <div class="eb-body">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px"><span class="tag warn">本轮结束</span><span class="label dim">TURN ENDED · ERROR</span></div>
      <h2>出错：${reason}</h2>
      <p>${broke ? "正在跑的命令记为“被中断，结果未知”，后面的记为“未执行”。" : ""}tau 不自动重做任何事，重不重做由你定。</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <${Pill} kind="warn" icon="arrow" label="看它改了什么" onClick=${() => app.setTab(1)} />
        <${Pill} icon="fork" label=${turn === null ? "复制整个当前段分叉（这一轮的开头在上一段）" : "从出错前分叉"} onClick=${() => (turn === null ? app.fork(e.id) : app.fork(e.id, turn))} />
      </div>
    </div>
  </section>`;
}

/** 消息流。往上翻着读的时候不拽到底，只在底下提示。 */
function Stream({ app, e }) {
  const el = useRef(/** @type {HTMLElement | null} */ (null));
  const stick = useRef(true);
  const [fresh, setFresh] = useState(false);
  const [openMid, setOpenMid] = useState(false);
  const [openPre, setOpenPre] = useState(false);
  const [openOld, setOpenOld] = useState(/** @type {Record<number, boolean>} */ ({}));
  const h = app.history(e.id);
  const segs = Object.keys(h.segs).map(Number).sort((a, b) => a - b);
  const cur = e.self.segment;
  const msgs = segmentMessages(h, cur);
  const live = app.streamText(e.id);
  const running = e.status === "running";
  const error = e.status === "error";
  const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;

  const onFork = (/** @type {number} */ seq) => app.fork(e.id, seq);
  const items = toItems(msgs);
  const sig = `${cur}:${msgs.length}:${live.length}:${e.self.phase.tag}`;

  useLayoutEffect(() => {
    const n = el.current;
    if (!n) return;
    if (stick.current) n.scrollTop = n.scrollHeight;
    else setFresh(true);
  }, [sig, openMid, openPre]);
  // 写信框长高时台面变矮：贴着底的，继续贴着底。
  useLayoutEffect(() => {
    const n = el.current;
    if (!n) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) n.scrollTop = n.scrollHeight;
    });
    ro.observe(n);
    return () => ro.disconnect();
  }, []);

  /** @type {any[]} */
  const rows = [];
  // 旧的段：一行一段，点开看。
  for (const s of segs) {
    if (s >= cur) continue;
    const old = segmentMessages(h, s);
    if (old.length === 0) continue;
    rows.push(html`<${FoldRow} text=${`第 ${s} 段 · ${old.length} 条消息`} label=${openOld[s] ? "收起" : "展开"} onOpen=${() => setOpenOld({ ...openOld, [s]: !openOld[s] })} />`);
    if (openOld[s]) rows.push(...renderItems(app, e, toItems(old), s, false, null));
  }
  if (msgs.length > 0) {
    const first = msgs[0];
    rows.push(html`<${Band} label="换段" text=${`第 ${cur} 段从 ${first ? formatClock(app.clock(first.timestamp)) : ""} 开始`} />`);
  }

  const turn = error ? turnStart(msgs) : null;
  if (error && msgs.length > 0 && turn !== null) {
    const before = items.filter((it) => it.kind !== "fold" && it.seq < turn);
    const after = items.filter((it) => it.kind !== "fold" && it.seq >= turn);
    if (before.length > 0) {
      rows.push(html`<${FoldRow} text=${`这一轮前面还有 ${turn} 条消息`} label=${openPre ? "收起" : "展开"} onOpen=${() => setOpenPre(!openPre)} />`);
      if (openPre) rows.push(...renderItems(app, e, before, cur, running, onFork));
    }
    const head = msgs[turn];
    const first = head && head.role === "user" ? describeStart(head) : "";
    rows.push(html`<${Band} label="这一轮" text=${`${head ? formatClock(app.clock(head.timestamp)) : ""} ${first}`} warn=${true} />`);
    rows.push(...renderItems(app, e, after, cur, running, onFork));
  } else if (error && turn === null && msgs.length > 0) {
    rows.push(html`<${Band} label="这一轮" text="开头在上一段，这一段里是它的后半" warn=${true} />`);
    rows.push(...renderItems(app, e, items, cur, running, onFork));
  } else {
    const shown = openMid ? items : foldMiddle(items, 2, 14);
    const folded = shown.length !== items.length || shown.some((x) => x.kind === "fold");
    shown.forEach((it, i) => {
      if (it.kind === "fold") {
        const next = shown[i + 1];
        const n = next && next.kind !== "fold" ? next.seq - it.from : it.to - it.from + 1;
        rows.push(html`<${FoldRow} text=${`中间还有 ${n} 条消息`} onOpen=${() => setOpenMid(true)} />`);
      } else rows.push(...renderItems(app, e, [it], cur, running, onFork));
    });
    void folded;
  }

  if (error) {
    const last = msgs[msgs.length - 1];
    const turnMsgs = turn !== null ? msgs.slice(turn) : msgs;
    rows.push(html`<${EndBand} app=${app} e=${e} ts=${last ? last.timestamp : null} turn=${turn} msgs=${turnMsgs} />`);
  } else if (e.self.phase.tag === "awaitingModel") rows.push(html`<${LiveRow} app=${app} text=${live} purpose=${e.self.phase.purpose} since=${phaseStartedAt(msgs, "awaitingModel")} />`);
  else if (msgs.length === 0 && segs.length === 0) rows.push(html`<div class="wide-only"></div><p class="hintp">${running || e.status === "fresh" ? "正在读取消息…" : "这一段还没有消息。"}</p>`);

  return html`<div class="stage">
    <${Tex} kind="tx-grid-l" mask="radial-gradient(ellipse 85% 80% at 90% 90%, #000 0%, transparent 72%)" />
    <${Contour} />
    <span class="bignum wide-only" aria-hidden="true">${pad2(cur)}</span>
    <span class="vlabel wide-only" aria-hidden="true">PROC ${e.id} / SEG ${pad2(cur)} / ${e.self.phase.tag === "idle" ? "IDLE" : `STEP ${String(e.self.phase.steps).padStart(3, "0")}`} / ${e.self.messages} MSG${ended !== undefined ? ` / ENDED: ${typeof ended === "object" ? "ERROR" : String(ended).toUpperCase()}` : ""}</span>
    <span class="cross wide-only" style="left:116px;top:10px"></span><span class="cross" style="right:10px;bottom:10px"></span>
    <div class="scroll" ref=${el} onScroll=${(/** @type {any} */ ev) => {
      const n = ev.currentTarget;
      stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 64;
      if (stick.current) setFresh(false);
    }}>
      <div class="stream"><span class="vrule wide-only" aria-hidden="true"></span>${rows}</div>
    </div>
    ${fresh && html`<button type="button" class="jump" onClick=${() => { const n = el.current; if (n) n.scrollTo({ top: n.scrollHeight }); stick.current = true; setFresh(false); }}><${Icon} name="down" size=${14} sw=${3} />有新消息</button>`}
  </div>`;
}

/** 这一轮是谁开的：看开头那封信。 @param {any} m */
function describeStart(m) {
  const text = typeof m.content === "string" ? m.content : m.content.map((/** @type {any} */ b) => (b.type === "text" ? b.text : "")).join("\n");
  const x = /^（来自进程 (\S+?)，预设 (.+?)(。它在等回信：.*)?）/.exec(text);
  if (x) return `由 ${x[2]} 的来信开始`;
  return text.startsWith("（来自用户）") || !text.startsWith("（") ? "由你的来信开始" : "开始";
}

/**
 * 条目变成行。`onFork` 非 null 时用户消息带分叉入口（只有当前段的用户消息）。
 * @param {any} app @param {any} e @param {any[]} items @param {number} seg @param {boolean} running @param {((seq: number) => void) | null} onFork
 */
function renderItems(app, e, items, seg, running, onFork) {
  /** @type {any[]} */
  const out = [];
  for (const it of items) {
    if (it.kind === "user") out.push(html`<${UserRow} key=${`u${seg}:${it.seq}`} app=${app} item=${it} onFork=${onFork} />`);
    else if (it.kind === "handoff") out.push(html`<${HandoffRow} key=${`h${seg}:${it.seq}`} app=${app} item=${it} segment=${seg} />`);
    else if (it.kind === "assistant") out.push(html`<${AssistantRow} key=${`a${seg}:${it.seq}`} app=${app} item=${it} running=${running && e.self.phase.tag === "awaitingTool"} />`);
    else if (it.kind === "orphanResult") out.push(html`<${OrphanRow} key=${`o${seg}:${it.seq}`} app=${app} item=${it} />`);
  }
  return out;
}

/** @param {{ app: import("../app.js").App }} p */
export function ProcessView({ app }) {
  const e = app.focused;
  if (!e) {
    return html`<div class="pending"><${Tex} kind="tx-grid-l" /><p class="mono">正在读取进程 ${app.focusedId}…</p><button type="button" class="pill dark" onClick=${() => app.focusProject(null)}>回到项目</button></div>`;
  }
  const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
  const note = e.status === "error" || ended === "stopped" || ended === "stepLimit" ? carryNote(ended) : null;
  // 临时进程的标题是第一封信的第一行，可能很长；写信框里只写开头。
  const name = e.kind === "temp" ? clipText(app.titleOf(e.id).title, 16) : e.name;
  return html`<${Fragment}>
    <${Plate} app=${app} e=${e} />
    <${Stream} app=${app} e=${e} />
    <${Compose} key=${e.id} app=${app} e=${e} name=${name} note=${note} />
  </${Fragment}>`;
}
