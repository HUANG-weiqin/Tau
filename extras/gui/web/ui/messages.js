// 消息流里的条目：换段带、交接说明、来信、助手的话、工具调用。
// 每个条目是网格里的两格：左边时间戳，右边内容；整行的带跨两列。
import { html, Icon, Thumb, clockS, useState, Fragment } from "./common.js";
import { formatClock, formatBytes, formatElapsed } from "../lib/format.js";

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
      ${open && item.carried && html`<div class="carried"><span class="tag">带过来的用户消息</span><p class="hbody">${item.carried}</p></div>`}
    </article>`;
}

/** 正在跑的东西底下的扫描线：一直在走，说明还在动。系统要求减少动画时停在原地。 */
const Scan = () => html`<span class="scan" aria-hidden="true"></span>`;

/** 一次工具调用：暗色条。`since` 是发出这批调用的助手消息的时间戳。 */
function CallStrip({ call, running, app, since }) {
  const [open, setOpen] = useState(false);
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
    : html`<span class="cr"><${Icon} name="check" size=${12} sw=${3.4} color="#FFEF00" /><span class="ell">${r?.summary ?? ""}</span></span>`;
  const head = html`<span class="clabel">${label}</span><span class="cbody"><span class="csum">${call.summary || call.name}</span>${right}</span>`;
  const live = st === "pending" && running;
  return html`<li class=${`call ${st} ${live ? "run" : ""}`}>
    ${can ? html`<button type="button" class="chead" aria-expanded=${open} onClick=${() => setOpen(!open)}>${head}</button>` : html`<div class="chead">${head}</div>`}
    ${open && r && html`<div class="cout">
      ${call.name === "bash" && typeof call.args["command"] === "string" && call.summary !== call.args["command"] ? html`<pre class="ccmd">$ ${call.args["command"]}</pre>` : ""}
      ${r.images.length > 0 && html`<div class="thumbs" style="padding:8px 12px 0 72px">${r.images.map((im) => html`<${Thumb} hash=${im.hash} fetchBlob=${app.blob} />`)}</div>`}
      <pre>${r.text.length > 20000 ? r.text.slice(0, 20000) + `\n…（还有 ${formatBytes(r.text.length - 20000)}）` : r.text}</pre>
    </div>`}
    ${live && html`<${Scan} />`}
  </li>`;
}

/** 助手的一条消息：思考、文字、工具调用。 */
export function AssistantRow({ app, item, running }) {
  const hasBody = item.text.trim() !== "" || item.calls.length > 0 || item.thinking.trim() !== "" || item.errorMessage;
  if (!hasBody) return null;
  return html`<${Ts} ts=${item.ts} app=${app} pad=${4} />
    <div class="abox">
      ${item.thinking.trim() !== "" && html`<details class="think"><summary>思考 · ${Array.from(item.thinking).length} 字</summary><p>${item.thinking}</p></details>`}
      ${item.text.trim() !== "" && html`<p class="atext">${item.text}</p>`}
      ${item.errorMessage && html`<div class="aerr"><span class="tag warn">模型出错</span><span class="mono">${item.errorMessage}</span></div>`}
      ${item.calls.length > 0 && html`<ul class="calls">${item.calls.map((c, i) => html`<${CallStrip} key=${c.id + ":" + i} call=${c} running=${running} app=${app} since=${item.ts} />`)}</ul>`}
    </div>`;
}

/** 没有配上调用的工具结果。 */
export function OrphanRow({ app, item }) {
  return html`<${Ts} ts=${item.ts} app=${app} pad=${4} />
    <ul class="calls"><li class="call ok"><div class="chead"><span class="clabel"><span class="cl">${item.name.toUpperCase()}</span></span><span class="cbody"><span class="csum">${item.result.summary}</span><span class="cr dim">没有对应的调用</span></span></div></li></ul>`;
}

/** 模型正在写的文字，末尾带闪烁的光标。 */
export function LiveRow({ app, text, purpose, since }) {
  const doing = purpose === "handoff" ? "在写交接说明" : text === "" ? "在想" : "在写";
  return html`<div class="ts wide-only live"><span class="tag">现在</span><span class="tick" aria-hidden="true"></span></div>
    <div class="abox">
      <div class="working" role="status">
        <span class="wk-l">MODEL</span>
        <span class="wk-t">模型${doing}</span>
        <span class="wk-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="wk-s mono">${since === null ? "" : formatElapsed(app.now - app.clock(since))}</span>
        <${Scan} />
      </div>
      ${text !== "" && html`<p class="atext">${text}<span class="cur" aria-hidden="true"></span></p>`}
    </div>`;
}

export { formatClock, Fragment };
