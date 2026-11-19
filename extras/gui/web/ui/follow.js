// 跟着末尾走：留白进纸。
// 末尾离底边不到一行半时，整段平滑地推上去，让末尾停在台面六成高的地方，下面留四成空白。
// 字在空白里写，页面不动；写满了再进一次。读字时页面静止，眼睛不用追着跑。
// 推的动作是临界阻尼弹簧，起步和停下都是缓的。按需跑：推到位就停掉 rAF。
// 只有用户自己的操作能让它离开末尾：往上滚就离开，往下滚到看得见末尾就重新跟上。程序自己设的 scrollTop 不算。
import { motionOn } from "../lib/motion.js";

/** 推一次以后，末尾下面留的空白占台面的比例。 */
const HEAD = 0.4;
/** 内容底部常备 HEAD 台面高的内边距，再多这么多：推到位以后还有余量，收尾变矮（工作条收起）时不会被浏览器夹着跳。 */
const SLACK = 72;
/** 末尾离底边不到这么近，就推一次（约一行半）。 */
const NEAR = 40;
/** 切进程时，末尾离底边留这么多。 */
const BASE = 34;
/** 弹簧的角频率，1/秒。一次推台面的四成，约 0.4 秒停稳。 */
const OMEGA = 10;
/** 弹簧分小步积分：掉帧时一帧可能很长，一步走完会发散。 */
const STEP = 1 / 120;
/** 用户操作之后这么久以内的 scroll 事件才算用户滚的；用户在内容里点了、按了、展开了东西，这么久以内的变高不推。 */
const USER_MS = 400;
/** 点“有新消息”时，离得比这个倍数的一屏还远，就先跳到离目标一屏的地方再滑。 */
const FAR_SCREENS = 1.5;

export class Follower {
  /**
   * @param {HTMLElement} n 滚动容器
   * @param {HTMLElement} content 里面的内容元素：末尾是它最后一个有高度的子元素
   * @param {(show: boolean) => void} onFresh 跟回末尾时调 false。离开时有没有新消息，由调用方按数据判断
   */
  constructor(n, content, onFresh) {
    this.n = n;
    this.content = content;
    this.onFresh = onFresh;
    this.stick = true;
    this.pos = n.scrollTop;
    this.vel = 0;
    /** 正在推向的位置；null 表示不用动。 */
    /** @type {number | null} */
    this.target = null;
    this.padFor = -1;
    this.lastEnd = 0;
    this.lastV = n.clientHeight;
    this.userAt = -1e9;
    /** 用户最后一次在内容里点、按键、展开的时刻：那之后的变高是用户自己弄的，不推。 */
    this.innerAt = -1e9;
    this.drag = false;
    /** 自己最后写进 scrollTop 的值：它引起的 scroll 事件不算用户滚的。 */
    this.lastSet = n.scrollTop;
    this.raf = 0;
    this.last = 0;
    this.ro = new ResizeObserver(() => this.kick());
    this.ro.observe(content);
    this.ro.observe(n);
    this.ac = new AbortController();
    const o = { passive: true, signal: this.ac.signal };
    const user = () => {
      this.userAt = performance.now();
    };
    const inner = () => {
      this.innerAt = performance.now();
    };
    n.addEventListener(
      "wheel",
      (e) => {
        user();
        // 缩放不是滚动；流里可滚的工具输出自己会滚，不算离开末尾；已经在最上面，滚不动，也不算。
        if (e.deltaY < 0 && !e.ctrlKey && n.scrollTop > 0 && !this.innerScrolls(e.target)) this.leave();
      },
      o,
    );
    n.addEventListener("touchmove", user, o);
    n.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target !== n) return inner();
        this.drag = true;
        user();
      },
      o,
    );
    window.addEventListener("pointerup", () => (this.drag = false), o);
    window.addEventListener("pointercancel", () => (this.drag = false), o);
    n.addEventListener(
      "keydown",
      (e) => {
        user();
        if (e.target !== n) inner();
        if (["ArrowUp", "PageUp", "Home"].includes(e.key) && n.scrollTop > 0) this.leave();
      },
      o,
    );
    // <details> 的展开不冒泡，在捕获阶段听。
    content.addEventListener("toggle", inner, { capture: true, signal: this.ac.signal });
    n.addEventListener(
      "scroll",
      () => {
        const top = n.scrollTop;
        if (Math.abs(top - this.lastSet) < 1) return;
        // 内容变矮、浏览器把位置夹到了新的最下面：不是用户滚的。
        if (top < this.pos && top >= n.scrollHeight - n.clientHeight - 1) {
          this.pos = this.lastSet = top;
          return;
        }
        if (!this.drag && performance.now() - this.userAt > USER_MS) return;
        // 用户滚的：往上就离开；往下滚到看得见末尾就跟上。
        const down = top > this.pos;
        this.pos = this.lastSet = top;
        this.vel = 0;
        this.target = null;
        if (!down) this.leave();
        else if (!this.stick && this.end() <= top + n.clientHeight) {
          this.stick = true;
          this.onFresh(false);
          this.kick();
        }
      },
      o,
    );
    this.kick();
  }

  /** 离开末尾：不再推，停下正在推的。 */
  leave() {
    this.stick = false;
    this.target = null;
    this.vel = 0;
  }

  /** 滚轮的目标到滚动容器之间，有没有还能往上滚的可滚元素（滚的是它，不是容器）。 @param {EventTarget | null} t */
  innerScrolls(t) {
    for (let el = t instanceof Element ? t : null; el && el !== this.n; el = el.parentElement) {
      if (el.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
    }
    return false;
  }

  /** 末尾：内容里最后一个有高度的子元素的底边，按滚动内容的坐标。 */
  end() {
    const top = this.n.getBoundingClientRect().top - this.n.scrollTop;
    for (let el = this.content.lastElementChild; el; el = el.previousElementSibling) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) return r.bottom - top;
    }
    return 0;
  }

  /** 内容底部常备四成台面高的内边距：推的时候有地方可推，收尾变矮时不会被夹着跳。 */
  pad() {
    const v = this.n.clientHeight;
    if (v === this.padFor) return;
    this.padFor = v;
    this.content.style.paddingBottom = `${Math.round(v * HEAD) + SLACK}px`;
  }

  /** 写 scrollTop，记下来，免得它的 scroll 事件被当成用户滚的。 @param {number} p */
  set(p) {
    const n = this.n;
    this.pos = Math.max(0, Math.min(p, n.scrollHeight - n.clientHeight));
    if (Math.abs(n.scrollTop - this.pos) >= 0.5) n.scrollTop = this.pos;
    this.lastSet = n.scrollTop;
  }

  /** 立刻跟上（切了进程）：末尾放在底边上方一点，不留四成空白。 */
  snap() {
    this.pad();
    this.stick = true;
    this.target = null;
    this.vel = 0;
    const e = this.end();
    this.set(e + BASE - this.n.clientHeight);
    this.lastEnd = e;
    this.lastV = this.n.clientHeight;
    this.onFresh(false);
  }

  /** 点了“有新消息”：跟回去，末尾推到六成高。离得太远就先跳到离目标一屏的地方再滑。 */
  attach() {
    const n = this.n;
    const t = Math.max(n.scrollTop, this.end() - n.clientHeight * (1 - HEAD));
    if (t - n.scrollTop > n.clientHeight * FAR_SCREENS) this.set(t - n.clientHeight);
    else this.pos = n.scrollTop;
    this.vel = 0;
    this.target = t;
    this.stick = true;
    this.onFresh(false);
    this.kick();
  }

  /** 内容或容器变了：需要的话开始跑。 */
  kick() {
    if (this.raf) return;
    // 后台页面没有 rAF，直接到位。
    if (document.hidden) {
      this.frame(0);
      return;
    }
    this.last = performance.now() - 16;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** @param {number} now */
  tick = (now) => {
    this.raf = 0;
    const dt = Math.min(0.25, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    if (!this.frame(dt)) this.raf = requestAnimationFrame(this.tick);
  };

  /**
   * 走一帧。返回 true 表示不用再跑。
   * @param {number} dt 秒
   */
  frame(dt) {
    const n = this.n;
    this.pad();
    const v = n.clientHeight;
    const e = this.end();
    // 只为两件事推：末尾自己长了（新字、新消息，不是用户刚在内容里展开的），或者台面变了高。
    const grew = e > this.lastEnd + 0.5 && performance.now() - this.innerAt > USER_MS;
    const resized = v !== this.lastV;
    this.lastEnd = e;
    this.lastV = v;
    if (!this.stick) return true;
    // 浏览器自己改过位置（夹住、滚动锚定）：以它为准。
    if (Math.abs(n.scrollTop - this.pos) > 2) this.pos = n.scrollTop;
    if ((grew || resized) && this.pos + v - e < NEAR) {
      const t = e - v * (1 - HEAD);
      if (this.target === null || t > this.target) this.target = t;
    }
    if (this.target === null) return true;
    const goal = Math.min(this.target, Math.max(0, n.scrollHeight - v));
    // 要推的距离比一屏还大、页面在后台、动效关着：直接到位，不滑。
    if (!motionOn() || document.hidden || goal - this.pos > v) {
      this.target = null;
      this.vel = 0;
      this.set(goal);
      return true;
    }
    let p = this.pos;
    for (let rem = dt; rem > 1e-6; rem -= STEP) {
      const h = Math.min(rem, STEP);
      this.vel += (OMEGA * OMEGA * (goal - p) - 2 * OMEGA * this.vel) * h;
      p += this.vel * h;
    }
    const done = Math.abs(goal - p) < 0.3 && Math.abs(this.vel) < 3;
    if (done) {
      p = goal;
      this.vel = 0;
      this.target = null;
    }
    this.set(p);
    return done;
  }

  /** 拆掉监听、观察器和 rAF。 */
  destroy() {
    this.ac.abort();
    this.ro.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
