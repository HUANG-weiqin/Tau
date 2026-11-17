// 共用的小件：html 模板、图标、按钮、三相灯、弹窗外壳、提示牌、右键菜单。
import { h, Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "preact/hooks";
import htm from "htm";
import { pathKey } from "../lib/state.js";

export const html = htm.bind(h);
export { h, Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback };

/**
 * 项目的大标题和小标签。起了简称的，简称是大标题，文件夹名是小标签；没起的，文件夹名是大标题。
 * @param {{ gui: { short: Record<string, string> } }} app @param {{ key: string, name: string, short: string }} p
 * @returns {{ big: string, small: string, custom: boolean }}
 */
export function projTitle(app, p) {
  const custom = Object.keys(app.gui.short).some((k) => pathKey(k) === p.key) && p.short !== p.name;
  return custom ? { big: p.short, small: p.name, custom } : { big: p.name, small: "", custom };
}

/** 图标：24 格，直角线头。 */
const ICONS = {
  tau: ["M5 8h14", "M12 8v8.5a3 3 0 0 0 3 3h1.5"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  plus: ["M12 5v14", "M5 12h14"],
  arrow: ["M4 12h15", "M13 6l6 6-6 6"],
  fork: ["M6 3v18", "M6 14h5a7 7 0 0 0 7-7V3"],
  ext: ["M7 17L17 7", "M9 7h8v8"],
  search: ["M15.5 15.5L21 21", "circle:10.5:10.5:6.5"],
  close: ["M5 5l14 14", "M19 5L5 19"],
  down: ["M6 9l6 6 6-6"],
  up: ["M6 15l6-6 6 6"],
  check: ["M4 12.5l5.5 5.5L20 6.5"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  branch: ["circle:6:5.5:2.5", "circle:6:18.5:2.5", "circle:18:8:2.5", "M6 8v8", "M18 10.5c0 4.5-6 4-12 6"],
  term: ["M3 5h18v14H3z", "M7 9.5l3 2.5-3 2.5", "M12.5 15H17"],
  reply: ["M7 3v10h12", "M15 9l4 4-4 4"],
  folder: ["M3 6h6l2 2h10v11H3z"],
  pin: ["M9 3h6l-1 7 3 3H7l3-3z", "M12 13v8"],
  image: ["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "circle:15.5:9:1.6"],
  info: ["M12 11v6", "M12 7v1", "M3 3h18v18H3z"],
  warn: ["M12 4l9 16H3z", "M12 10v5", "M12 17.5v.5"],
};

/**
 * @param {{ name: keyof typeof ICONS, size?: number, sw?: number, color?: string, class?: string }} p
 */
export function Icon({ name, size = 16, sw = 2.6, color = "currentColor", class: cls }) {
  const parts = ICONS[name] ?? [];
  return html`<svg aria-hidden="true" class=${cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke=${color} stroke-width=${sw} stroke-linecap="square">
    ${parts.map((d) => {
      if (d.startsWith("circle:")) {
        const [, cx, cy, r] = d.split(":");
        return html`<circle cx=${cx} cy=${cy} r=${r} />`;
      }
      return html`<path d=${d} />`;
    })}
  </svg>`;
}

/**
 * 药丸按钮。`kind`：默认是描边，`accent` 黄，`warn` 橙，`dark` 在浅色面上。
 * `icon` 是右边圆里的图标，`chip` 是圆的颜色。没有 icon 就是平的。
 * @param {{ kind?: string, icon?: string, chip?: string, label?: any, class?: string, [k: string]: any }} p
 */
export function Pill({ kind = "", icon, chip = "", label, children, class: cls = "", ...rest }) {
  const isStop = icon === "stop";
  return html`<button type="button" class=${`pill ${kind} ${icon ? "" : "bare"} ${cls}`} ...${rest}>
    <span>${label ?? children}</span>
    ${icon && html`<span class=${`chip ${chip}`} aria-hidden="true">${isStop ? html`<span style="width:11px;height:11px;background:#111211"></span>` : html`<${Icon} name=${icon} size=${16} sw=${icon === "fork" ? 2.6 : 2.8} />`}</span>`}
  </button>`;
}

/** 三个方块的灯。`phase` 是阶段名；亮的那个是当前阶段。直接跳，不渐变。 @param {{ phase: "idle" | "awaitingModel" | "awaitingTool", class?: string }} p */
export function Lamp({ phase, class: cls = "" }) {
  const i = phase === "idle" ? 0 : phase === "awaitingModel" ? 1 : 2;
  const run = phase !== "idle";
  return html`<span class=${`lamp ${run ? "" : "idle"} ${cls}`} aria-hidden="true">
    <i class=${i === 0 ? "on" : ""}></i><i class=${i === 1 ? `on ${run ? "run" : ""}` : ""}></i><i class=${i === 2 ? `on ${run ? "run" : ""}` : ""}></i>
  </span>`;
}

/** 材质层。`kind` 是 base.css 里的 tx-* 类；`mask` 是渐隐。 @param {{ kind: string, mask?: string, style?: string }} p */
export function Tex({ kind, mask, style = "" }) {
  return html`<span aria-hidden="true" class=${`tx ${kind}`} style=${`${mask ? `--m:${mask};` : ""}${style}`}></span>`;
}

/** 两位数编号。 @param {number} n */
export const pad2 = (n) => String(n).padStart(2, "0");

/** 时分秒。 @param {number} ts */
export function clockS(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 等高线：几圈起伏的闭合曲线，装饰用。生成一次。 */
function makeContours() {
  const cx = 380;
  const cy = 300;
  const out = [];
  for (let k = 0; k < 11; k++) {
    const base = 36 + k * 30;
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      const wob = 1 + 0.1 * Math.sin(2 * t + 0.6 + k * 0.1) + 0.07 * Math.sin(3 * t + 1.9) + 0.04 * Math.sin(5 * t + k * 0.3);
      pts.push(`${i === 0 ? "M" : "L"}${(cx + base * 1.25 * wob * Math.cos(t)).toFixed(0)} ${(cy + base * 0.95 * wob * Math.sin(t)).toFixed(0)}`);
    }
    out.push(pts.join("") + "Z");
  }
  return out;
}
const CONTOURS = makeContours();

/** 台面右下角的等高线。 */
export function Contour() {
  return html`<svg aria-hidden="true" width="760" height="560" viewBox="0 0 760 560" fill="none" stroke="rgba(17,18,17,0.14)" stroke-width="1" style="position:absolute;z-index:0;pointer-events:none;right:-150px;bottom:-190px">
    ${CONTOURS.map((d) => html`<path d=${d} />`)}
  </svg>`;
}

/** 图片：按 hash 取，取到前是灰块。 @param {{ hash: string, mimeType?: string, class?: string, fetchBlob: (h: string) => Promise<string | null> }} p */
export function Thumb({ hash, fetchBlob, class: cls = "thumb" }) {
  const [src, setSrc] = useState(/** @type {string | null | undefined} */ (undefined));
  useEffect(() => {
    let alive = true;
    fetchBlob(hash).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [hash]);
  if (src === undefined) return html`<span class=${cls} style="background:#aaa;display:inline-block"></span>`;
  if (src === null) return html`<span class=${cls} style="display:inline-grid;place-items:center;font-size:11px;color:#3D3E3B;background:#C7C8C4">图片读不到</span>`;
  return html`<a href=${src} target="_blank" rel="noopener"><img class=${cls} src=${src} alt="图片" /></a>`;
}

/* ---------- 提示牌 ---------- */
/** @type {{ rect: DOMRect, content: any } | null} */
let tipState = null;
/** @type {Set<() => void>} */
const tipSubs = new Set();
const emitTip = () => tipSubs.forEach((f) => f());

/** 在元素 `el` 旁边浮出一块牌子。 @param {Element} el @param {any} content */
export function showTip(el, content) {
  tipState = { rect: el.getBoundingClientRect(), content };
  emitTip();
}
export function hideTip() {
  if (!tipState) return;
  tipState = null;
  emitTip();
}

/** 绑定提示牌的属性。内容是函数，悬停时才生成。 @param {() => any} content */
export function tipProps(content) {
  return {
    onMouseEnter: (/** @type {MouseEvent} */ e) => showTip(/** @type {Element} */ (e.currentTarget), content()),
    onMouseLeave: hideTip,
    onBlur: hideTip,
    onClick: hideTip,
  };
}

export function TipLayer() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    tipSubs.add(f);
    return () => void tipSubs.delete(f);
  }, []);
  if (!tipState) return null;
  const { rect, content } = tipState;
  const left = Math.min(rect.right + 12, window.innerWidth - 292);
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 120));
  return html`<div class="tip" role="tooltip" style=${`left:${left}px;top:${top}px;--ny:${Math.max(14, rect.top + rect.height / 2 - top)}px`}>${content}</div>`;
}

/* ---------- 右键菜单 ---------- */
/** @type {{ x: number, y: number, items: { label: string, run: () => void }[] } | null} */
let menuState = null;
/** @type {Set<() => void>} */
const menuSubs = new Set();
const emitMenu = () => menuSubs.forEach((f) => f());

/** @param {number} x @param {number} y @param {{ label: string, run: () => void }[]} items */
export function showMenu(x, y, items) {
  menuState = { x, y, items };
  hideTip();
  emitMenu();
}

export function MenuLayer() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    menuSubs.add(f);
    return () => void menuSubs.delete(f);
  }, []);
  useEffect(() => {
    if (!menuState) return;
    const close = () => {
      menuState = null;
      emitMenu();
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuState]);
  if (!menuState) return null;
  const { x, y, items } = menuState;
  return html`<div class="menu" role="menu" style=${`left:${Math.min(x, window.innerWidth - 160)}px;top:${Math.min(y, window.innerHeight - 60 * items.length)}px`}>
    ${items.map((it) => html`<button type="button" role="menuitem" onClick=${it.run}>${it.label}</button>`)}
  </div>`;
}

/* ---------- 弹窗外壳 ---------- */
/**
 * 贴着打开它的按钮的弹窗。进场 320ms，离场 160ms；Esc 或点背景关。
 * `rect` 是按钮的位置（没有时居中）。`align` 为 "bottom" 时底边贴着按钮底边（总管）。
 * 手机宽度下铺满屏幕（样式在 dialogs.css）。
 * `est` 是弹窗大概多高，用来决定它离屏幕顶多远。
 * `onClosing` 在开始关的那一刻同步调用（Esc、点背景、按钮都算），`onClose` 要等离场动效走完。
 * @param {{ rect?: { left: number, top: number, right: number, bottom: number } | null, onClose: () => void, onClosing?: () => void, label: string, width?: number, align?: "top" | "bottom", est?: number, class?: string, children?: any }} p
 */
export function Popover({ rect, onClose, onClosing, label, width = 640, align = "top", est = 420, class: cls = "", children }) {
  const [leaving, setLeaving] = useState(false);
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  const back = useRef(/** @type {HTMLElement | null} */ (null));
  const closing = useRef(false);
  // onClose 每次渲染都是新的；存进 ref，下面的 effect 只在挂载时跑一次，不抢焦点。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onClosingRef = useRef(onClosing);
  onClosingRef.current = onClosing;
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    onClosingRef.current?.();
    setLeaving(true);
    const quick = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => onCloseRef.current(), quick ? 0 : 160);
  }, []);

  useEffect(() => {
    const prev = /** @type {HTMLElement | null} */ (document.activeElement);
    const first = root.current?.querySelector("[autofocus], input, textarea, select");
    /** @type {HTMLElement | null} */ (first ?? root.current)?.focus();
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close();
      } else if (e.key === "Tab" && root.current) {
        const f = /** @type {HTMLElement[]} */ ([...root.current.querySelectorAll("button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])")]).filter((x) => !x.hasAttribute("disabled") && x.offsetParent !== null);
        const firstEl = f[0];
        const last = f[f.length - 1];
        if (!firstEl || !last) return;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [close]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = rect ? Math.max(12, Math.min(rect.right + 12, vw - width - 12)) : Math.max(12, (vw - width) / 2);
  /** @type {string} */
  let pos;
  let ny = 40;
  if (!rect) pos = `--t:${Math.max(12, (vh - 520) / 2)}px;`;
  else if (align === "bottom") {
    const bottom = Math.max(12, vh - rect.bottom - 8);
    pos = `--b:${bottom}px;`;
    ny = Math.max(16, Math.min(vh - bottom - 20, 400));
  } else {
    const top = Math.max(12, Math.min(rect.top - 24, vh - est - 12));
    pos = `--t:${top}px;`;
    ny = Math.max(16, rect.top + (rect.bottom - rect.top) / 2 - top);
  }
  const style = `--l:${left}px;--w:${width}px;${pos}`;
  return html`<div class="dlg-layer">
    <div ref=${back} class=${`dlg-back ${leaving ? "leaving" : ""}`} onClick=${close} aria-hidden="true"></div>
    <section ref=${root} tabindex="-1" role="dialog" aria-modal="true" aria-label=${label} class=${`dlg ${align === "bottom" ? "bottom" : ""} ${leaving ? "leaving" : ""} ${cls}`} style=${style}>
      ${rect && html`<span class="dlg-ptr" aria-hidden="true" style=${`top:${ny}px`}></span>`}
      <div class="dlg-in">${typeof children === "function" ? children(close) : children}</div>
    </section>
  </div>`;
}

/**
 * 弹窗的头：黄色方块图标、标题、英文小标、副标题、关闭按钮。
 * @param {{ icon: string, title: string, en: string, sub?: any, onClose: () => void }} p
 */
export function DlgHead({ icon, title, en, sub, onClose }) {
  return html`<div class="dlg-head">
    <span class="dlg-ico" aria-hidden="true"><${Icon} name=${icon} size=${16} sw=${2.8} /></span>
    <div class="dlg-title">
      <h2>${title}</h2>
      <div><span class="label" style="color:var(--acc)">${en}</span>${sub && html`<span class="dlg-sub">${sub}</span>`}</div>
    </div>
    <button type="button" class="pill closer" aria-label="关闭" onClick=${onClose}><span class="mono">Esc</span><${Icon} name="close" size=${18} /></button>
  </div>`;
}

/** 弹窗里的小节标题：编号、中文、英文。 @param {{ n?: string, title: string, en: string, right?: any }} p */
export function SecHead({ n, title, en, right }) {
  return html`<h3 class="sec-head">
    ${n && html`<span class="num" style="font-size:18px;color:var(--acc)">${n}</span>`}<span>${title}</span><span class="label dim">${en}</span><span class="sep"></span>${right}
  </h3>`;
}
