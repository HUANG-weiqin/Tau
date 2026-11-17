// 吐字：一个 <p>，里面的字由这里用 DOM 操作，Preact 只管这个 <p> 本身。
// 网络一块一块地到，字匀速出来（算法在 lib/pace.js）。最近 200ms 出来的字是单独的 span，由淡到实。
// 所有 Typer 共用一个 rAF 时钟，没有在动的就停掉。
//
// 衔接：一次模型调用写的字，将来是当前段的第几条消息，开始写时就知道（投影的 messages）。
// 所以按“进程、段、序号”记一条记录：正在写的行、写完后历史还没回来时留住的行、最后读到的消息行，
// 依次接手同一条记录，字接着出，不重来，也不会认错别的消息。
import { html, useRef, useLayoutEffect } from "./common.js";
import { newPace, paceArrive, paceStep } from "../lib/pace.js";

/** 新出的字由淡到实用多久，ms。 */
const FADE_MS = 200;
/** 光标淡出的时间（大于 --t-leave），之后移除。 */
const BYE_MS = 200;
/** 两帧间隔超过这么久（页面在后台过），直接显示全部，不回放。 */
const GAP_MS = 1000;
/** 没人接手的记录留这么久。 */
const STALE_MS = 3000;
/** 写完以后历史还没回来，最多留住字这么久。 */
const HOLD_MS = 3000;

const reduceQ = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * 一次模型调用的字：已收到的文字、吐字进度。`owner` 是正在显示它的那个 Typer。
 * `ended` 是它不再是正在写的那一刻（0 表示还在写）；`bar` 表示它下面现在有工作条。
 * @typedef {{ key: string, id: string, seg: number, seq: number, text: string, pace: import("../lib/pace.js").Pace, at: number, owner: Run | null, ended: number, bar: boolean }} Rec
 */

// ---------------------------------------------------------------- 记录

/** @type {Map<string, Rec>} */
const recs = new Map();
let sweeper = 0;

/** 记录的键。 @param {string} id @param {number} seg @param {number} seq */
export function slotKey(id, seg, seq) {
  return `${id}:${seg}:${seq}`;
}

function sweep() {
  sweeper = 0;
  const now = performance.now();
  for (const [k, r] of recs) if (!r.owner && now - r.at > STALE_MS) recs.delete(k);
  if (recs.size > 0) sweeper = window.setTimeout(sweep, STALE_MS);
}

function sweepLater() {
  if (!sweeper) sweeper = window.setTimeout(sweep, STALE_MS);
}

/**
 * 接手一条记录。`text` 是接手的这一行要显示的全文：它得以记录里的字开头，不然不是同一段字。
 * 没人接手太久的不要。接手时它就不再是正在写的了。
 * @param {string} key @param {string} text @returns {Rec | null}
 */
export function claim(key, text) {
  const r = recs.get(key);
  if (!r || !text.startsWith(r.text)) return null;
  const now = performance.now();
  if (!r.owner && now - r.at > STALE_MS) return null;
  if (!r.ended) r.ended = now;
  return r;
}

/** 接手了、但没有字要吐的记录（只调工具）：用完就扔。 @param {Rec} r */
export function release(r) {
  if (recs.get(r.key) === r) recs.delete(r.key);
}

/**
 * 写完了、历史还没读到它那条消息的记录，按序号排。`have` 是已经读到的条数，`liveSeq` 是正在写的那条（不算）。
 * 最多留 HOLD_MS。
 * @param {string} id @param {number} seg @param {number} have @param {number} liveSeq @returns {Rec[]}
 */
export function pending(id, seg, have, liveSeq) {
  const now = performance.now();
  /** @type {Rec[]} */
  const out = [];
  for (const r of recs.values()) {
    if (r.id !== id || r.seg !== seg || r.seq < have || r.seq === liveSeq) continue;
    if (r.ended && now - r.ended > HOLD_MS) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** 两次渲染之后：保证初始样子至少画过一帧，再切 class 才有过渡。 @param {() => void} f */
function afterPaint(f) {
  requestAnimationFrame(() => requestAnimationFrame(f));
}

// ---------------------------------------------------------------- 共用的时钟

/** @type {Set<Run>} */
const running = new Set();
let raf = 0;
let lastTs = 0;

/** @param {number} now */
function tick(now) {
  raf = 0;
  const gap = now - lastTs;
  lastTs = now;
  const dt = Math.min(0.25, Math.max(0.001, gap / 1000));
  for (const r of [...running]) {
    if (gap > GAP_MS) r.showAll();
    else r.frame(now, dt);
    if (!r.busy()) running.delete(r);
  }
  if (running.size > 0) raf = requestAnimationFrame(tick);
}

/** @param {Run} r */
function wake(r) {
  running.add(r);
  if (raf) return;
  lastTs = performance.now() - 16;
  raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- 一段在吐的字

class Run {
  /**
   * @param {HTMLElement} p
   * @param {{ live: boolean, final: boolean, cur: string, caught: () => void }} o
   */
  constructor(p, o) {
    this.p = p;
    this.live = o.live;
    /** 最后读到的消息行：追平以后记录就用完了。 */
    this.final = o.final;
    this.curClass = o.cur;
    this.caught = o.caught;
    this.reduced = reduceQ.matches;
    /** 已经收到的全文，和按字（码点）拆开的样子。 */
    this.text = "";
    /** @type {string[]} */
    this.chars = [];
    this.pace = newPace();
    /** 屏幕上已有几个字。 */
    this.vis = 0;
    this.node = document.createTextNode("");
    /** 最近 200ms 出来的字。 @type {{ s: HTMLSpanElement, born: number }[]} */
    this.tail = [];
    /** @type {HTMLSpanElement | null} */
    this.cur = null;
    this.wantCur = true;
    this.byeTimer = 0;
    this.done = false;
    /** 没有记录、也不是 live：直接显示全部，不动。 */
    this.instant = false;
    /** @type {Rec | null} */
    this.rec = null;
    p.hidden = true;
    p.append(this.node);
  }

  /** 直接显示、不做动画。 */
  get fast() {
    return this.reduced || this.instant;
  }

  /**
   * 起头。live 的：同一个位置有记录就接着吐（切走又切回），没有就新建；新建时已经有字（中途切进来），直接全部显示。
   * 不是 live 的：有接手的记录就接着吐，没有就直接显示全部。
   * @param {string} text @param {string} slot @param {Rec | null} claimed
   */
  init(text, slot, claimed) {
    const now = performance.now();
    if (this.live) {
      let r = recs.get(slot);
      if (r && text.startsWith(r.text)) this.adopt(r);
      else {
        const [id = "", seg = "0", seq = "0"] = slot.split(":");
        r = { key: slot, id, seg: Number(seg), seq: Number(seq), text: "", pace: newPace(), at: now, owner: null, ended: 0, bar: true };
        recs.set(slot, r);
        if (text !== "") this.shownAll(text);
      }
      r.owner = this;
      r.ended = 0;
      r.bar = true;
      this.rec = r;
    } else if (claimed) {
      claimed.owner = this;
      this.rec = claimed;
      this.adopt(claimed);
    } else {
      this.instant = true;
      this.wantCur = false;
      this.shownAll(text);
    }
    this.update(text, this.live);
  }

  /** @param {Rec} r */
  adopt(r) {
    this.text = r.text;
    this.chars = Array.from(r.text);
    this.pace = r.pace;
    this.vis = Math.min(this.chars.length, Math.floor(r.pace.shown + 1e-6));
    this.node.data = this.chars.slice(0, this.vis).join("");
  }

  /** 已有的字全部直接显示。 @param {string} text */
  shownAll(text) {
    this.text = text;
    this.chars = Array.from(text);
    this.vis = this.chars.length;
    this.pace = newPace(this.vis);
    this.node.data = text;
  }

  /** 文字变了。新文字以旧文字开头，多出来的算一块到达；不是（同一个位置换了一次调用），清空从头来。 @param {string} text @param {boolean} live */
  update(text, live) {
    const now = performance.now();
    this.live = live;
    if (text !== this.text) {
      if (!text.startsWith(this.text)) this.reset();
      const more = Array.from(text.slice(this.text.length));
      for (const c of more) this.chars.push(c);
      this.text = text;
      if (more.length > 0) this.pace = paceArrive(this.pace, now, more.length);
    }
    if (this.fast) this.showAll();
    else if (this.busy()) wake(this);
    this.after();
    this.sync(now);
  }

  reset() {
    this.p.replaceChildren(this.node);
    this.node.data = "";
    this.tail = [];
    this.cur = null;
    this.chars = [];
    this.text = "";
    this.vis = 0;
    this.pace = newPace();
    this.done = false;
    this.wantCur = !this.instant;
  }

  busy() {
    return this.vis < this.chars.length || this.tail.length > 0;
  }

  /** 全部直接显示，定形。 */
  showAll() {
    this.flushTail(this.tail.length);
    if (this.vis < this.chars.length) {
      this.node.appendData(this.chars.slice(this.vis).join(""));
      this.vis = this.chars.length;
    }
    this.pace = { ...this.pace, shown: this.vis };
    this.after();
    this.sync(performance.now());
  }

  /** 把最老的 k 个淡入中的字并进文本节点。 @param {number} k */
  flushTail(k) {
    if (k <= 0) return;
    const old = this.tail.splice(0, k);
    this.node.appendData(old.map((t) => t.s.textContent).join(""));
    for (const t of old) t.s.remove();
  }

  /**
   * 走一帧。
   * @param {number} now @param {number} dt
   */
  frame(now, dt) {
    const N = this.chars.length;
    this.pace = paceStep(this.pace, now, N, !this.live, dt);
    const k = Math.min(N, Math.floor(this.pace.shown + 1e-6));
    for (let i = this.vis; i < k; i++) {
      const s = document.createElement("span");
      s.textContent = this.chars[i] ?? "";
      s.style.opacity = "0";
      this.p.insertBefore(s, this.cur);
      this.tail.push({ s, born: now });
    }
    this.vis = Math.max(this.vis, k);
    let drop = 0;
    for (const t of this.tail) {
      const a = (now - t.born) / FADE_MS;
      if (a >= 1) drop++;
      else t.s.style.opacity = (1 - (1 - a) ** 3).toFixed(3);
    }
    this.flushTail(drop);
    this.after();
    this.sync(now);
  }

  /** 第一个字出来以后才显示 <p>、才有光标；不是 live 并且追平了：光标淡出，通知一次。 */
  after() {
    const shown = this.vis > 0;
    if (this.p.hidden === shown) this.p.hidden = !shown;
    if (shown && !this.cur && this.wantCur) {
      this.cur = document.createElement("span");
      this.cur.className = `cur ${this.curClass}`.trim();
      this.cur.setAttribute("aria-hidden", "true");
      this.p.append(this.cur);
    }
    if (!this.live && !this.done && this.vis >= this.chars.length) {
      this.done = true;
      this.wantCur = false;
      const c = this.cur;
      if (c) {
        if (this.reduced) c.remove();
        else {
          c.classList.add("bye");
          this.byeTimer = window.setTimeout(() => c.remove(), BYE_MS);
        }
      }
      // 最后读到的消息行追平了：这段字不会再有人接手。
      if (this.final && this.rec) {
        release(this.rec);
        this.rec = null;
      }
      this.caught();
    }
  }

  /** 把进度写回记录（只有正在显示它的那个写）。 @param {number} now */
  sync(now) {
    const r = this.rec;
    if (!r || r.owner !== this) return;
    r.text = this.text;
    r.pace = this.pace;
    r.at = now;
  }

  destroy() {
    running.delete(this);
    clearTimeout(this.byeTimer);
    const r = this.rec;
    if (!r || r.owner !== this) return;
    const now = performance.now();
    this.sync(now);
    r.owner = null;
    if (this.live && !r.ended) r.ended = now;
    sweepLater();
  }
}

/**
 * 一段吐出来的文字。
 * - live：正在写的行，`slot` 是它将来那条消息的记录键（slotKey）。从空开始吐，或者接着同一个位置的记录。
 * - 不是 live：有 `claimed`（见 claim）就接着它吐，追平后调一次 `onCaught`；没有就直接显示全部。
 *   `final` 表示这是最后读到的消息行，追平后记录用完扔掉；留住的行不扔，等消息行来接手。
 * 挂载以后 `slot`、`claimed`、`final`、`cur`、`cls` 不再看。
 * @param {{ text: string, live?: boolean, slot?: string, claimed?: Rec | null, final?: boolean, cls?: string, cur?: string, onCaught?: () => void }} p
 */
export function Typer({ text, live = false, slot = "", claimed = null, final = false, cls = "atext", cur = "", onCaught }) {
  const p = useRef(/** @type {HTMLElement | null} */ (null));
  const run = useRef(/** @type {Run | null} */ (null));
  const cb = useRef(onCaught);
  cb.current = onCaught;
  useLayoutEffect(() => {
    const el = p.current;
    if (!el) return;
    // 挂载时就已经追平：等初始样子画过一帧再通知，过渡才有起点。
    let starting = true;
    const r = new Run(el, { live, final, cur, caught: () => (starting ? afterPaint(() => cb.current?.()) : cb.current?.()) });
    run.current = r;
    r.init(text, slot, claimed);
    starting = false;
    return () => {
      r.destroy();
      run.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    run.current?.update(text, live);
  }, [text, live]);
  return html`<p ref=${p} class=${cls} />`;
}
