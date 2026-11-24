// 消息流里的条目：换段带、交接说明、来信、助手的话、工具调用。
// 每个条目是网格里的两格：左边时间戳，右边内容；整行的带跨两列。
import { html, Icon, Thumb, clockS, useState, useEffect, useLayoutEffect, useRef, Fragment } from "./common.js";
import { Typer, claim, release } from "./typer.js";
import { Markdown, CopyReply } from "./mdview.js";
import { formatClock, formatBytes, formatElapsed } from "../lib/format.js";
import { tailLines, argsPreview } from "../lib/stream.js";

/** 左边的时间戳，窄屏隐藏。 */
export function Ts({ ts, app, pad = 9, children }) {
  return html`<div class="ts wide-only" style=${`padding-top:${pad}px`}>${children ?? (ts == null ? "" : clockS(app.clock(ts)))}<span class="tick" aria-hidden="true"></span></div>`;
}

/** 整行的斜纹带：换段、这一轮。 */
export function Band({ label, text, warn = false }) {
  return html`<div class="band hatch-l"><span class="band-in"><span class=${`bl ${warn ? "warn" : ""}`}>${label}</span><span class="bt">${text}</span></span></div>`;
}

/** 折起来的一行：中间还有 n 条消息 + 展开。 */
export function FoldRow({ text, onOpen, label = "展开" }) {
  return html`<div class="wide-only" aria-hidden="true"></div>
    <div class="foldrow"><span class="fr-line" aria-hidden="true"></span>${text}<button type="button" class="link" onClick=${onOpen}>${label}<${Icon} name="down" size=${12} sw=${2.8} /></button></div>`;
}

/** 一封信的卡片。 */
function LetterCard({ letter, extra }) {
  if (letter.from === "process") {
    return html`<article class="card letter">
      <div class="lh"><span class="lh-k">来信</span><span>发信 <span class="mono" style="color:var(--fg)">${letter.id}</span> · ${letter.preset}</span>
        ${letter.waiting && html`<span class="lh-w" title="信头是写信那一刻的：那一轮结束以后，它在等回信就不再成立">写信时它在等回信</span>`}${extra}</div>
      <div class="perf" aria-hidden="true"></div>
      <p class="lbody">${letter.text}</p>
    </article>`;
  }
  if (letter.from === "bg") {
    return html`<article class="card letter">
      <div class="lh"><span class="lh-k">后台任务</span><span class="mono" style="color:var(--fg)">${letter.name}</span><span>跑完了</span>${extra}</div>
      <div class="perf" aria-hidden="true"></div>
      <p class="lbody">${letter.text}</p>
    </article>`;
  }
  if (letter.from === "reply") {
    return html`<article class="card letter">
      <div class="lh"><span class="lh-k">回信</span><span>进程 <span class="mono" style="color:var(--fg)">${letter.id}</span> 的这一轮</span><span class=${`lh-w ${letter.ended && typeof letter.ended === "object" ? "w" : ""}`}>${letter.endedText}</span>${extra}</div>
      <div class="perf" aria-hidden="true"></div>
      <p class="lbody">${letter.text}</p>
    </article>`;
  }
  return html`<article class="card letter me">
    <div class="lh me"><span class="lh-k">你</span>${extra}</div>
    <p class="lbody">${letter.text}</p>
  </article>`;
}

/**
 * 一条用户消息。`forkSeq` 不是 null 时每封信的头上带一个“从这里分叉”。
 * @param {{ app: any, item: any, onFork: ((seq: number) => void) | null }} p
 */
export function UserRow({ app, item, onFork }) {
  const fork = onFork
    ? html`<button type="button" class="lh-fork" title="从这条消息之前分叉出新进程" aria-label="从这条消息之前分叉" onClick=${() => onFork(item.seq)}><${Icon} name="fork" size=${13} sw=${2.6} />分叉</button>`
    : null;
  return html`<${Ts} ts=${item.ts} app=${app} pad=${11} />
    <div class="userbox">
      ${item.note && html`<div class="autonote"><span class="tag warn">自动加在信前</span><span class="mono ell">${item.note}</span></div>`}
      ${item.letters.map((l, i) => html`<${LetterCard} letter=${l} extra=${i === 0 ? fork : null} />`)}
      ${item.images.length > 0 && html`<div class="thumbs">${item.images.map((im) => html`<${Thumb} hash=${im.hash} fetchBlob=${app.blob} />`)}</div>`}
    </div>`;
}

/** 交接说明：默认折起。 */
export function HandoffRow({ app, item, segment }) {
  const [open, setOpen] = useState(false);
  const chars = Array.from(item.note).length;
  return html`<${Ts} ts=${item.ts} app=${app} />
    <article class="card handoff">
      <div class="hh"><span class="tag">交接说明</span><span class="mono dim">第 ${segment - 1} 段写的 · ${chars} 字</span>
        <button type="button" class="link" style="margin-left:auto" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? "收起" : "展开"}<${Icon} name=${open ? "up" : "down"} size=${12} sw=${2.8} /></button></div>
      <p class=${`hbody ${open ? "" : "clamp"}`}>${item.note}</p>
      ${open && item.brief && html`<details class="carried"><summary class="tag">上一段的简略视图</summary><p class="hbody">${item.brief}</p></details>`}
      ${open && item.carried && html`<div class="carried"><span class="tag">带过来的用户消息</span><p class="hbody">${item.carried}</p></div>`}
    </article>`;
}

/** 正在跑的东西底下的扫描线：一直在走，说明还在动。动效关掉时停在原地（css/base.css 的 `data-motion="off"`）。 */
const Scan = () => html`<span class="scan" aria-hidden="true"></span>`;

/** 一次工具调用：暗色条。`since` 是发出这批调用的助手消息的时间戳。 */
function CallStrip({ call, running, app, since, out = "" }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const r = call.result;
  const can = !!r && (r.text.trim() !== "" || r.images.length > 0);
  const st = call.status;
  const name = call.name.toUpperCase();
  const label = html`<span class="cl">${name}</span>`;
  const right =
    st === "interrupted" ? html`<span class="tag warn">被中断，结果未知</span>`
    : st === "skipped" ? html`<span class="cr">未执行</span>`
    : st === "error" ? html`<span class="cr"><span class="tag warn" style="margin-right:6px">出错</span><span class="ell">${r?.summary}</span></span>`
    : st === "pending" ? html`<span class="cr"><span class=${running ? "pulse" : ""} style="width:8px;height:8px;background:var(--acc);display:inline-block"></span>${running ? html`运行中<span class="mono run-s">${formatElapsed(app.now - app.clock(since))}</span>` : "没有结果"}</span>`
    : html`<span class="cr"><${Icon} name="check" size=${12} sw=${3.4} color="var(--acc-t)" /><span class="ell">${r?.summary ?? ""}</span></span>`;
  const head = html`<span class="clabel">${label}</span><span class="cbody"><span class="csum">${call.summary || call.name}</span>${right}</span>`;
  const live = st === "pending" && running;
  const tail = live && out !== "" ? tailLines(out, LIVE_LINES) : null;
  return html`<li class=${`call ${st} ${live ? "run" : ""}`}>
    ${can ? html`<button type="button" class="chead" aria-expanded=${open} onClick=${() => setOpen(!open)}>${head}</button>` : html`<div class="chead">${head}</div>`}
    ${open && r && html`<div class="cout">
      ${typeof call.args["command"] === "string" && call.summary !== call.args["command"] ? html`<pre class="ccmd">$ ${call.args["command"]}</pre>` : ""}
      ${r.images.length > 0 && html`<div class="thumbs" style="padding:8px 14px 0 14px">${r.images.map((im) => html`<${Thumb} hash=${im.hash} fetchBlob=${app.blob} />`)}</div>`}
      <pre>${r.text.length > 20000 ? r.text.slice(0, 20000) + `\n…（还有 ${formatBytes(r.text.length - 20000)}）` : r.text}</pre>
    </div>`}
    ${live && tail && html`<div class="cout live">
      <pre class="cls-out" style=${showAll ? "max-height:60vh" : ""}>${showAll ? out : tail.text}</pre>
      <p class="cls-note">${tail.hidden > 0 || showAll ? html`<button type="button" class="link" aria-expanded=${showAll} onClick=${() => setShowAll(!showAll)}>${showAll ? "收起" : `展开（还有 ${tail.hidden} 行）`}</button> ` : ""}命令还在跑，这是它现在的输出，只是预览（跑完以工具结果为准）。</p>
    </div>`}
    ${live && html`<${Scan} />`}
  </li>`;
}

/** 工作条：模型在想、在写。 */
const Working = ({ text, secs }) => html`<span class="wk-l">MODEL</span>
  <span class="wk-t">${text}</span>
  <span class="wk-dots" aria-hidden="true"><i></i><i></i><i></i></span>
  ${secs !== undefined && html`<span class="wk-s mono">${secs}</span>`}
  <${Scan} />`;

/**
 * 助手的一条消息：思考、文字、工具调用。`slot` 是它的记录键（typer.js 的 slotKey）。
 * 这条消息刚写完、字还没吐完时，接手那条记录：字接着吐；那时下面有工作条的，先放一条一样的“幽灵”工作条，
 * 字追平了它收起，工具条长出来，字不再往上窜。没有记录：直接显示，没有动画。
 * 吐字期间是纯文字；追平以后（或本来就没有记录）换成 Markdown 渲染的结果。
 * @param {{ app: any, item: any, running: boolean, slot?: string }} p
 */
export function AssistantRow({ app, item, running, slot = "", out = "" }) {
  const hasText = item.text.trim() !== "";
  const [claimed] = useState(() => (slot !== "" ? claim(slot, item.text) : null));
  const [ghost] = useState(() => claimed !== null && claimed.bar);
  const [caught, setCaught] = useState(claimed === null);
  // 没有文字就没有要追的东西：记录用完，画过一帧以后直接收起。
  useEffect(() => {
    if (!claimed || hasText) return;
    release(claimed);
    requestAnimationFrame(() => requestAnimationFrame(() => setCaught(true)));
  }, []);
  const hasBody = hasText || item.calls.length > 0 || item.thinking.trim() !== "" || item.errorMessage;
  if (!hasBody) return null;
  const calls = item.calls.length > 0 && html`<ul class="calls">${item.calls.map((c, i) => html`<${CallStrip} key=${c.id + ":" + i} call=${c} running=${running} app=${app} since=${item.ts} out=${out} />`)}</ul>`;
  return html`<${Ts} ts=${item.ts} app=${app} pad=${4} />
    <div class="abox">
      ${item.thinking.trim() !== "" && html`<details class="think"><summary>思考 · ${Array.from(item.thinking).length} 字</summary><p>${item.thinking}</p></details>`}
      ${hasText && (caught ? html`<div class="reply"><${Markdown} text=${item.text} /><${CopyReply} text=${item.text} /></div>` : html`<${Typer} text=${item.text} claimed=${claimed} final=${true} onCaught=${() => setCaught(true)} />`)}
      ${item.errorMessage && html`<div class="aerr"><span class="tag warn">模型出错</span><span class="mono">${item.errorMessage}</span></div>`}
      ${ghost && html`<div class=${`gx ${caught ? "out" : "in"}`} aria-hidden="true"><div class="gi"><div class="working"><${Working} text="模型在写" /></div></div></div>`}
      ${claimed ? calls && html`<div class=${`gx ${caught ? "in" : ""}`}><div class="gi">${calls}</div></div>` : calls}
    </div>`;
}

/** 没有配上调用的工具结果。 */
export function OrphanRow({ app, item }) {
  return html`<${Ts} ts=${item.ts} app=${app} pad=${4} />
    <ul class="calls"><li class="call ok"><div class="chead"><span class="clabel"><span class="cl">${item.name.toUpperCase()}</span></span><span class="cbody"><span class="csum">${item.result.summary}</span><span class="cr dim">没有对应的调用</span></span></div></li></ul>`;
}

/** 思考块收起时留最后几行。 */
const THINK_LINES = 6;
/** 运行中的命令预览收起时留最后这么多行。 */
const LIVE_LINES = 24;
/** 工具调用参数的预览留最后这么多字。 */
const ARGS_CHARS = 220;
/** 一步写完、那条消息还没读到时，留住这一步的思考，免得思考块先消失再出现。 @type {Map<string, { text: string, at: number }>} */
const thoughts = new Map();

/** @param {string} slot @param {string} text */
function holdThought(slot, text) {
  const now = performance.now();
  for (const [k, v] of thoughts) if (now - v.at > 10000) thoughts.delete(k);
  thoughts.set(slot, { text, at: now });
}

/**
 * 模型正在想：暗色小字，边到边显示。收起时只留最后几行，贴着底；展开后能滚，新字来了跟到底（往上滚着读时不拽）。
 * @param {{ text: string }} p
 */
function ThinkLive({ text }) {
  const [open, setOpen] = useState(false);
  const box = useRef(/** @type {HTMLElement | null} */ (null));
  const near = useRef(true);
  const tail = open ? { text, hidden: 0 } : tailLines(text, THINK_LINES);
  useLayoutEffect(() => {
    const n = box.current;
    if (n && open && near.current) n.scrollTop = n.scrollHeight;
  }, [text, open]);
  return html`<div class="thinkl" role="status">
    <div class="tl-h"><span class="tl-k">思考中</span><span class="mono dim">${Array.from(text).length} 字</span>
      <button type="button" class="link" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? "收起" : tail.hidden > 0 ? `展开（还有 ${tail.hidden} 行）` : "展开"}<${Icon} name=${open ? "up" : "down"} size=${12} sw=${2.8} /></button></div>
    <div class=${`tl-b ${open ? "open" : ""}`} ref=${box} onScroll=${(/** @type {any} */ e) => (near.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 24)}><pre>${tail.text}</pre></div>
  </div>`;
}

/** 工具调用的参数正在长出来：只有 JSON 片段，没有工具名。等宽，一行，留最后一截。 @param {{ args: string, len: number }} p */
function ArgsLive({ args, len }) {
  return html`<div class="argl" role="status"><span class="tl-k">工具调用</span><span class="mono dim">参数 ${len} 字</span><code>${argsPreview(args, ARGS_CHARS)}</code></div>`;
}

/** 写完了、消息还没读到的思考：已经是收起的样子。 @param {{ text: string }} p */
function ThoughtHeld({ text }) {
  return html`<details class="think"><summary>思考 · ${Array.from(text).length} 字</summary><p>${text}</p></details>`;
}

/**
 * 模型正在写的文字：思考在最上，正文在中间，工具调用参数在正文下面，工作条在最下面，像出纸口。
 * `slot` 是这段字将来那条消息的记录键。`think`、`args` 是这一次调用流式推来的思考和工具调用参数。
 */
export function LiveRow({ app, slot, text, think = "", args = "", argsLen = 0, purpose, since }) {
  const doing = purpose === "handoff" ? "在写交接说明" : text === "" ? (args !== "" ? "在写工具调用" : "在想") : "在写";
  if (think.trim() !== "") holdThought(slot, think);
  return html`<div class="ts wide-only live"><span class="tag">现在</span><span class="tick" aria-hidden="true"></span></div>
    <div class="abox">
      ${think.trim() !== "" && html`<${ThinkLive} text=${think} />`}
      <${Typer} text=${text} live=${true} slot=${slot} />
      ${args !== "" && html`<${ArgsLive} args=${args} len=${argsLen} />`}
      <div class="working" role="status"><${Working} text=${"模型" + doing} secs=${since === null ? "" : formatElapsed(app.now - app.clock(since))} /></div>
    </div>`;
}

/**
 * 写完了、历史还没读到那条消息：留住这段字，接着吐完，等消息行来接手。
 * `bar`：后面没有新的正在写的行时，工作条留着，消息行来了再收起。
 * @param {{ rec: import("./typer.js").Rec, bar: boolean }} p
 */
export function HeldRow({ rec, bar }) {
  const [claimed] = useState(() => claim(rec.key, rec.text));
  rec.bar = bar;
  const th = thoughts.get(rec.key);
  return html`<div class="ts wide-only live"><span class="tag">现在</span><span class="tick" aria-hidden="true"></span></div>
    <div class="abox">
      ${th && html`<${ThoughtHeld} text=${th.text} />`}
      <${Typer} text=${rec.text} claimed=${claimed} />
      ${bar && html`<div class="working" role="status"><${Working} text="模型在写" /></div>`}
    </div>`;
}

export { formatClock, Fragment };
