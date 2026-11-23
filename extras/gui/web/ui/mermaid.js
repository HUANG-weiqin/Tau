// @ts-check
// mermaid 图：回复里 ```mermaid 的代码块画成图。数学在 lib/panzoom.js，这里只管 DOM、事件和加载。
// 库（`mermaid` 包）只在页面上真有 mermaid 块时才加载，加载和初始化只做一次；包不在或出错时显示原代码块。
// 图总是放在一张浅色的“纸”上（暗色主题、总管弹窗里也一样，像一张印出来的图）；颜色写死，不跟主题走（css/mermaid.css 同）。
import DOMPurify from "dompurify";
import { render } from "preact";
import { useMemo } from "preact/hooks";
import { html, useState, useEffect, useLayoutEffect, useRef, useCallback, copyText, useFlash } from "./common.js";
import * as pz from "../lib/panzoom.js";

/** 模块名放进变量：`import()` 的参数不是字面量，tsc 就不去找它的类型。 @type {string} */
const MERMAID = "mermaid";
/** 纸边：图四周的留白（内容像素）。存出的图一样。 */
const PAD = 16;
/** 视口里适应时离边的距离。 */
const FIT_PAD = 12;
/** 渲染结果的缓存条数。 */
const CACHE_MAX = 50;
/** 适应以后比例小于它，头部提示“图很大，全屏看”。 */
const SMALL_K = 0.5;
/** 按钮和键盘每次缩放的倍数。 */
const STEP = 1.25;

const INK = "#111211";
const INK2 = "#464843";
const PAPER = "#F1F2EE";
const PAPER2 = "#E4E6DF";
const STAGE = "#DFE0DA";
/** 只用系统字体：SVG 当图片画时加载不了网页字体，屏幕和存出的图要一致。 */
const FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif';

/**
 * `htmlLabels: false`（根上和 flowchart 里都设）：带 foreignObject 的 SVG 画到 canvas 上会污染 canvas，存不成 PNG。
 * `suppressErrorRendering`：语法错时 mermaid 不往页面里画炸弹图。
 */
const CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  suppressErrorRendering: true,
  fontFamily: FONT,
  themeVariables: {
    fontFamily: FONT,
    fontSize: "14px",
    background: PAPER,
    mainBkg: PAPER2,
    primaryColor: PAPER2,
    primaryTextColor: INK,
    primaryBorderColor: INK,
    secondaryColor: STAGE,
    secondaryTextColor: INK,
    secondaryBorderColor: INK2,
    tertiaryColor: PAPER,
    tertiaryTextColor: INK,
    tertiaryBorderColor: INK2,
    lineColor: INK,
    textColor: INK,
    nodeBorder: INK,
    nodeTextColor: INK,
    clusterBkg: "#EAEBE6",
    clusterBorder: INK2,
    edgeLabelBackground: PAPER,
    titleColor: INK,
    noteBkgColor: "#EAEBE6",
    noteTextColor: INK,
    noteBorderColor: INK2,
    actorBkg: PAPER2,
    actorBorder: INK,
    actorTextColor: INK,
    actorLineColor: INK2,
    signalColor: INK,
    signalTextColor: INK,
    labelBoxBkgColor: PAPER2,
    labelBoxBorderColor: INK2,
    labelTextColor: INK,
    loopTextColor: INK,
    activationBkgColor: STAGE,
    activationBorderColor: INK,
  },
};

/** 库没装上或加载失败。 */
class LibError extends Error {}

/** @type {Promise<any> | null} */
let lib = null;

/** 加载并初始化 mermaid，全页只做一次。失败也记住，不反复去试。 */
function loadLib() {
  lib ??= import(MERMAID).then(
    (m) => {
      const mm = m.default ?? m;
      mm.initialize(CONFIG);
      return mm;
    },
    () => {
      throw new LibError("画图的库没装上");
    },
  );
  return lib;
}

/**
 * @typedef {{ id: string, svg: string, w: number, h: number, W: number, H: number }} Diagram
 * `w`、`h` 是 SVG 的 viewBox 尺寸；`W`、`H` 加上四周的纸边，是“纸”的尺寸（内容坐标）。
 */

/** 源码 → 渲染结果。Map 的插入顺序当 LRU 用。 @type {Map<string, Diagram>} */
const cache = new Map();
/** 正在画的，同样的源码不画两遍。 @type {Map<string, Promise<Diagram>>} */
const inflight = new Map();
let seq = 0;

/** 出错时 mermaid 可能在 body 里留下临时元素。 @param {string} id */
function sweep(id) {
  for (const x of [id, `d${id}`, `i${id}`]) document.getElementById(x)?.remove();
}

/** 整段报错（最多约 8 行）：插入符那一行和 “Expecting …” 都要看得到。 @param {unknown} e */
function errText(e) {
  return pz.errorText(e instanceof Error ? e.message : String(e));
}

/**
 * 出图以后再净化一遍：strict 模式下 mermaid 仍会保留 `click … href` 的 `<a xlink:href>`，它能聚焦、能点，会把界面标签页导航走。
 * 去掉所有 `<a>`（里面的内容留下），也不要 tabindex 和事件属性。卡片、查看器、小地图、存图用的都是这份结果。
 * @param {string} svg
 */
function clean(svg) {
  if (!DOMPurify.isSupported) throw new Error("没法净化图，不显示");
  return String(
    DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["a", "script", "foreignObject"],
      FORBID_ATTR: ["tabindex", "target", "onclick"],
      KEEP_CONTENT: true,
    }),
  );
}

/** @param {string} code @returns {Promise<Diagram>} */
function draw(code) {
  const hit = cache.get(code);
  if (hit) {
    cache.delete(code);
    cache.set(code, hit);
    return Promise.resolve(hit);
  }
  const busy = inflight.get(code);
  if (busy) return busy;
  const p = (async () => {
    const mm = await loadLib();
    const id = `mmd${(++seq).toString(36)}x${Date.now().toString(36)}`;
    try {
      const out = await mm.render(id, code);
      const svg = clean(out.svg);
      const vb = pz.parseViewBox(svg);
      if (!vb) throw new Error("没有拿到图的尺寸");
      /** @type {Diagram} */
      const d = { id, svg, w: vb.w, h: vb.h, W: vb.w + 2 * PAD, H: vb.h + 2 * PAD };
      cache.set(code, d);
      while (cache.size > CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
      return d;
    } catch (e) {
      sweep(id);
      throw e;
    }
  })();
  inflight.set(code, p);
  const done = () => inflight.delete(code);
  p.then(done, done);
  return p;
}

/** @typedef {{ tag: "load" } | { tag: "nolib" } | { tag: "err", msg: string } | { tag: "ok", d: Diagram }} State */

/** @param {string} code @returns {State} */
function useDiagram(code) {
  const [s, setS] = useState(/** @returns {State} */ () => {
    const hit = cache.get(code);
    return hit ? { tag: "ok", d: hit } : { tag: "load" };
  });
  useEffect(() => {
    let alive = true;
    const hit = cache.get(code);
    if (hit) {
      setS({ tag: "ok", d: hit });
      return;
    }
    setS({ tag: "load" });
    draw(code).then(
      (d) => alive && setS({ tag: "ok", d }),
      (e) => alive && setS(e instanceof LibError ? { tag: "nolib" } : { tag: "err", msg: errText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [code]);
  return s;
}

let inst = 0;

/**
 * 同一张图会同时出现在卡片、查看器和小地图里：给每份换一个 id，免得标记（marker）按 id 找错对象。
 * 宽高写明成 viewBox 的尺寸。
 * @param {Diagram} d
 */
function domSvg(d) {
  return pz.sizedSvg(d.svg.split(d.id).join(`${d.id}-${++inst}`), d.w, d.h);
}

// ---- 存图 ----

/** @param {Diagram} d */
export async function savePng(d) {
  const s = pz.exportScale(d.W, d.H);
  const svg = pz.sizedSvg(d.svg, d.w * s, d.h * s);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = () => no(new Error("图片加载失败"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(d.W * s));
    c.height = Math.max(1, Math.round(d.H * s));
    const g = c.getContext("2d");
    if (!g) throw new Error("没有 canvas");
    // SVG 是透明的：先填纸的底色。
    g.fillStyle = PAPER;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, PAD * s, PAD * s, d.w * s, d.h * s);
    // canvas 被污染时 toBlob 抛安全错误，落到调用方的“存图失败”。
    const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
    if (!blob) throw new Error("生成不了 PNG");
    const a = document.createElement("a");
    const href = URL.createObjectURL(/** @type {Blob} */ (blob));
    a.href = href;
    a.download = pz.exportName(new Date());
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- 平移缩放 ----

/**
 * 元素大小，跟着变。
 * @param {{ current: HTMLElement | null }} ref
 */
function useSize(ref) {
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const f = () => setSz((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return sz;
}

/**
 * 视图状态和手势。`o.wheel`：`"ctrl"` 只有按住 Ctrl/⌘ 的滚轮才缩放（普通滚轮留给页面），`"free"` 滚轮就缩放。
 * `o.touch`：`"pinch"` 单指不拦（页面能滚），双指缩放；`"pan"` 单指平移，双指缩放。
 * 拖动和滚轮跟手（`set`），按钮、双击、跳转用过渡（`go`，样式里 200ms）。
 * @param {{ current: HTMLElement | null }} host @param {pz.Size} content @param {pz.Size} vp
 * @param {{ wheel: "ctrl" | "free", touch: "pinch" | "pan", pad: number, fitMax: number }} o
 */
function usePanZoom(host, content, vp, o) {
  const [st, setSt] = useState(() => ({ view: pz.fitView(content, vp, o.pad, o.fitMax), anim: false }));
  const R = useRef({ view: st.view, fitted: true, content, vp, o }).current;
  R.content = content;
  R.vp = vp;
  R.o = o;

  const commit = useCallback((/** @type {pz.View} */ view, /** @type {boolean} */ anim) => {
    R.view = view;
    setSt({ view, anim });
  }, []);
  const api = useRef({
    get: () => R.view,
    /** 跟手：不加过渡。 */
    set: (/** @type {pz.View} */ v) => {
      R.fitted = false;
      commit(v, false);
    },
    /** 程序触发的移动：200ms 过渡。 */
    go: (/** @type {pz.View} */ v) => {
      R.fitted = false;
      commit(v, true);
    },
    fit: (anim = false) => {
      R.fitted = true;
      commit(pz.fitView(R.content, R.vp, R.o.pad, R.o.fitMax), anim);
    },
    /** 以视口中心为中心缩放 factor 倍（回到 1 就是 1:1）。 */
    zoom: (/** @type {number} */ factor) => api.go(pz.zoomAt(R.view, { x: R.vp.w / 2, y: R.vp.h / 2 }, factor)),
    actual: () => api.go(pz.zoomTo(R.view, { x: R.vp.w / 2, y: R.vp.h / 2 }, 1)),
  }).current;

  // 没动过就跟着视口和内容重新适应。
  useLayoutEffect(() => {
    if (R.fitted && vp.w > 0 && vp.h > 0) api.fit(false);
  }, [vp.w, vp.h, content.w, content.h]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    /** @type {Map<number, pz.Pt>} */
    const pts = new Map();
    /** @type {{ id: number, sx: number, sy: number, v: pz.View, moved: boolean } | null} */
    let drag = null;
    /** @type {{ ids: number[], a0: pz.Pt, b0: pz.Pt, v: pz.View } | null} */
    let pin = null;
    const rel = (/** @type {MouseEvent} */ e) => {
      const b = el.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const startDrag = (/** @type {number} */ id, /** @type {pz.Pt} */ p) => {
      drag = { id, sx: p.x, sy: p.y, v: R.view, moved: false };
    };

    const onWheel = (/** @type {WheelEvent} */ e) => {
      const zoomKey = e.ctrlKey || e.metaKey;
      if (R.o.wheel === "ctrl" && !zoomKey) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // 触控板双指捏合是带 ctrlKey 的小步长滚轮；鼠标滚轮一格是 100 上下。
      const sens = e.ctrlKey && Math.abs(dy) < 40 ? 0.012 : 0.0016;
      api.set(pz.zoomAt(R.view, rel(e), Math.exp(-dy * sens)));
    };
    const onDown = (/** @type {PointerEvent} */ e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("button, input, a")) return;
      pts.set(e.pointerId, rel(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pin = { ids: [...pts.keys()], a0: /** @type {pz.Pt} */ (a), b0: /** @type {pz.Pt} */ (b), v: R.view };
        drag = null;
        R.fitted = false;
        el.setPointerCapture?.(e.pointerId);
        return;
      }
      if (pts.size > 2) return;
      // 消息流里单指不拦：让页面能滚。
      if (e.pointerType === "touch" && R.o.touch === "pinch") return;
      startDrag(e.pointerId, rel(e));
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (/** @type {PointerEvent} */ e) => {
      if (!pts.has(e.pointerId)) return;
      const p = rel(e);
      pts.set(e.pointerId, p);
      if (pin) {
        const a = pts.get(/** @type {number} */ (pin.ids[0]));
        const b = pts.get(/** @type {number} */ (pin.ids[1]));
        if (a && b) api.set(pz.pinch(pin.v, pin.a0, pin.b0, a, b));
      } else if (drag && drag.id === e.pointerId) {
        if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) < 3) return;
        if (!drag.moved) el.classList.add("grab");
        drag.moved = true;
        api.set(pz.panBy(drag.v, p.x - drag.sx, p.y - drag.sy));
      }
    };
    const onUp = (/** @type {PointerEvent} */ e) => {
      pts.delete(e.pointerId);
      if (pin && pts.size < 2) {
        pin = null;
        // 一指抬起，另一指接着平移（只在单指平移的查看器里）。
        const [id, p] = [...pts.entries()][0] ?? [];
        if (id !== undefined && p && R.o.touch === "pan") startDrag(id, p);
      }
      if (drag && drag.id === e.pointerId) drag = null;
      if (!drag) el.classList.remove("grab");
    };
    const onDbl = (/** @type {MouseEvent} */ e) => {
      if (e.target instanceof Element && e.target.closest("button, input, a")) return;
      e.preventDefault();
      api.go(pz.zoomAt(R.view, rel(e), 2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("dblclick", onDbl);
    };
  }, []);

  return { view: st.view, anim: st.anim, ...api };
}

// ---- 小件 ----

/**
 * 纸：内容坐标系。图在纸边里面，搜索命中的框盖在上面（框的线宽按屏幕像素算，所以带 `--k`）。
 * @param {{ d: Diagram, svg: string, view: pz.View, anim?: boolean, hits?: pz.Rect[], cur?: number, sheetRef?: { current: HTMLElement | null } }} p
 */
function Sheet({ d, svg, view, anim = false, hits = [], cur = -1, sheetRef }) {
  return html`<div class=${`mm-sheet${anim ? " go" : ""}`} ref=${sheetRef} style=${`width:${d.W}px;height:${d.H}px;transform:translate(${view.x}px,${view.y}px) scale(${view.k});--k:${view.k}`}>
    <div class="mm-svg" style=${`left:${PAD}px;top:${PAD}px;width:${d.w}px;height:${d.h}px`} dangerouslySetInnerHTML=${{ __html: svg }} />
    ${hits.map((r, i) => html`<div key=${i} class=${`mm-hl${i === cur ? " cur" : ""}`} style=${`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`}></div>`)}
  </div>`;
}

/**
 * 原代码块：带复制。`note` 是下面一行说明（加载中、库没装上），`error` 是渲染的整段报错（等宽，保留换行和空格），
 * `onBack` 有就多一个“图”键。
 * @param {{ code: string, note?: string, warn?: boolean, error?: string, onBack?: () => void }} p
 */
function Source({ code, note, warn = false, error, onBack }) {
  const [label, flash] = useFlash("复制");
  return html`<div class="md-code mm">
    <div class="md-ch"><span class="md-lang">mermaid</span>
      <span class="mm-bs">
        <button type="button" class="mm-b" onClick=${() => copyText(code).then((ok) => flash(ok ? "已复制" : "复制失败"))}>${label}</button>
        ${onBack && html`<button type="button" class="mm-b" title="切回图" onClick=${onBack}>图</button>`}
      </span></div>
    <pre><code>${code}</code></pre>
    ${note && html`<p class=${`mm-note${warn ? " warn" : ""}`}>${note}</p>`}
    ${error !== undefined && html`<div class="mm-note warn"><p>图画不出来：</p><pre class="mm-err">${error}</pre></div>`}
  </div>`;
}

/** 消息流里的卡：头部一排小键，下面是图。 @param {{ d: Diagram, onSource: () => void }} p */
function Picture({ d, onSource }) {
  const viewEl = useRef(/** @type {HTMLElement | null} */ (null));
  const size = useSize(viewEl);
  const content = { w: d.W, h: d.H };
  const height = size.w > 0 ? pz.fitHeight(content, size.w, { pad: FIT_PAD }) : 160;
  const vp = { w: size.w, h: height };
  const svg = useMemo(() => domSvg(d), [d]);
  const pan = usePanZoom(viewEl, content, vp, { wheel: "ctrl", touch: "pinch", pad: FIT_PAD, fitMax: 1 });
  const [saveLabel, flash] = useFlash("存图");
  const small = size.w > 0 && pz.fitView(content, vp, FIT_PAD, 1).k < SMALL_K;
  const save = () => savePng(d).then(() => flash("已存"), () => flash("存图失败"));
  return html`<div class="md-code mm">
    <div class="md-ch"><span class="md-lang">mermaid</span>${small && html`<span class="mm-hint">图很大，全屏看</span>`}
      <span class="mm-bs">
        <button type="button" class="mm-b" title="整张图适应视口" onClick=${() => pan.fit(true)}>适应</button>
        <button type="button" class="mm-b" aria-label="缩小" title="缩小" onClick=${() => pan.zoom(1 / STEP)}>−</button>
        <button type="button" class="mm-b" aria-label="放大" title="放大（按住 Ctrl 滚轮也行）" onClick=${() => pan.zoom(STEP)}>+</button>
        <button type="button" class="mm-b" title="看原代码块" onClick=${onSource}>源码</button>
        <button type="button" class="mm-b" title="存成 PNG" onClick=${save}>${saveLabel}</button>
        <button type="button" class="mm-b" title="全屏查看" onClick=${(/** @type {Event} */ e) => openViewer(d, /** @type {HTMLElement} */ (e.currentTarget))}>全屏</button>
      </span></div>
    <div class="mm-view" ref=${viewEl} style=${`height:${height}px`} role="img" aria-label="mermaid 图">
      <${Sheet} d=${d} svg=${svg} view=${pan.view} anim=${pan.anim} />
    </div>
  </div>`;
}

/** 一个 mermaid 块：先是原代码块，画好换成图。 @param {{ code: string }} p */
function MermaidBlock({ code }) {
  const s = useDiagram(code);
  const [src, setSrc] = useState(false);
  if (s.tag === "ok") return src ? html`<${Source} code=${code} onBack=${() => setSrc(false)} />` : html`<${Picture} d=${s.d} onSource=${() => setSrc(true)} />`;
  if (s.tag === "load") return html`<${Source} code=${code} note="正在画图…" />`;
  if (s.tag === "nolib") return html`<${Source} code=${code} note="画图的库没装上" warn=${true} />`;
  return html`<${Source} code=${code} error=${s.msg} />`;
}

/**
 * 把 root 里的 mermaid 占位块换成图。返回清理函数：HTML 变了或卸载时收掉。
 * 有占位块时才会碰到 mermaid 库（`draw` 里才加载）。
 * @param {HTMLElement} root
 */
export function mountDiagrams(root) {
  const nodes = [...root.querySelectorAll("[data-md-mermaid]")];
  for (const n of nodes) {
    const code = n.querySelector("code")?.textContent ?? "";
    n.textContent = "";
    render(html`<${MermaidBlock} code=${code} />`, n);
  }
  return () => {
    for (const n of nodes) render(null, n);
  };
}

// ---- 全屏查看器 ----

/**
 * 盖住整个窗口。挂在 body 下：弹窗带 transform，`position: fixed` 在里面会按弹窗定位。
 * @param {Diagram} d @param {HTMLElement | null} opener 关闭后焦点回到它
 */
function openViewer(d, opener) {
  const host = document.createElement("div");
  document.body.append(host);
  const close = () => {
    render(null, host);
    host.remove();
    if (opener && opener.isConnected) opener.focus();
  };
  render(html`<${Viewer} d=${d} onClose=${close} />`, host);
}

/** 小地图：整张图的缩略，信号黄的框是当前视野。点它或在上面拖，视野跳到那里。整张图已经都在视野里时不显示。 @param {{ d: Diagram, view: pz.View, vp: pz.Size, pan: ReturnType<typeof usePanZoom> }} p */
function Minimap({ d, view, vp, pan }) {
  const svg = useMemo(() => domSvg(d), [d]);
  const down = useRef(false);
  const m = pz.miniFit({ w: d.W, h: d.H }, 200, 140);
  const vis = pz.visibleRect(view, vp);
  if (vp.w <= 0 || pz.covers(vis, { w: d.W, h: d.H })) {
    // 元素要被移除了，收不到 pointerup：按下的状态在这里清掉。
    down.current = false;
    return null;
  }
  const at = (/** @type {PointerEvent} */ e) => {
    const b = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
    return pz.centerAt(pan.get(), (e.clientX - b.left) / m.s, (e.clientY - b.top) / m.s, vp);
  };
  return html`<div class="mmv-map" style=${`width:${m.w}px;height:${m.h}px`} role="presentation" title="点一下或拖动，视野跳到那里"
    onPointerDown=${(/** @type {PointerEvent} */ e) => {
      down.current = true;
      /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
      pan.go(at(e));
    }}
    onPointerMove=${(/** @type {PointerEvent} */ e) => {
      if (!down.current) return;
      // 没有按键了（在别处松开的）就收起按下状态。
      if (!(e.buttons & 1)) down.current = false;
      else pan.set(at(e));
    }}
    onPointerUp=${() => (down.current = false)}
    onPointerCancel=${() => (down.current = false)}>
    <${Sheet} d=${d} svg=${svg} view=${{ x: 0, y: 0, k: m.s }} />
    <div class="mmv-map-f" style=${`left:${vis.x * m.s}px;top:${vis.y * m.s}px;width:${vis.w * m.s}px;height:${vis.h * m.s}px`}></div>
  </div>`;
}

/** @param {{ d: Diagram, onClose: () => void }} p */
function Viewer({ d, onClose }) {
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  const stage = useRef(/** @type {HTMLElement | null} */ (null));
  const sheet = useRef(/** @type {HTMLElement | null} */ (null));
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const size = useSize(stage);
  const content = { w: d.W, h: d.H };
  const svg = useMemo(() => domSvg(d), [d]);
  const pan = usePanZoom(stage, content, size, { wheel: "free", touch: "pan", pad: 32, fitMax: 2 });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(/** @type {pz.Rect[]} */ ([]));
  const [cur, setCur] = useState(-1);
  const [saveLabel, flash] = useFlash("存图");

  /** 把一个命中移到中间，至少放大到 100%。 @param {pz.Rect | undefined} r */
  const jump = (r) => {
    if (r) pan.go(pz.centerOn(pan.get(), r, size, 1));
  };
  /** @param {1 | -1} dir */
  const step = (dir) => {
    const i = pz.cycle(cur, hits.length, dir);
    setCur(i);
    jump(hits[i]);
  };

  // 搜索：按节点上的文字找，命中的框坐标换算成纸上的坐标。
  useEffect(() => {
    const el = sheet.current;
    const svgEl = el?.querySelector("svg");
    if (!el || !svgEl || q.trim() === "") {
      setHits([]);
      setCur(-1);
      return;
    }
    /** @type {Map<Element, string>} */
    const groups = new Map();
    for (const t of svgEl.querySelectorAll("text")) {
      const g = t.closest("g.node, g.cluster") ?? t;
      groups.set(g, `${groups.get(g) ?? ""} ${t.textContent ?? ""}`);
    }
    const els = [...groups.keys()];
    const idx = pz.matchIndexes([...groups.values()], q);
    // 过渡中读到的是显示出来的比例，不是目标比例。
    const sr = el.getBoundingClientRect();
    const k = sr.width / el.offsetWidth || 1;
    const rects = idx.map((i) => {
      const r = /** @type {Element} */ (els[i]).getBoundingClientRect();
      return { x: (r.left - sr.left) / k - 4, y: (r.top - sr.top) / k - 4, w: r.width / k + 8, h: r.height / k + 8 };
    });
    setHits(rects);
    setCur(rects.length > 0 ? 0 : -1);
    jump(rects[0]);
  }, [q]);

  // 键盘归查看器：窗口上抢先收下，不让页面和弹窗的快捷键也动。
  const live = useRef({ q, step, onClose });
  live.current = { q, step, onClose };
  useEffect(() => {
    const focusFind = () => {
      input.current?.focus();
      input.current?.select();
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      e.stopPropagation();
      const L = live.current;
      if (e.key === "Tab" && root.current) {
        const f = /** @type {HTMLElement[]} */ ([...root.current.querySelectorAll("button, input")]).filter((x) => !x.hasAttribute("disabled"));
        const first = f[0];
        const last = f[f.length - 1];
        if (first && last) {
          if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // 搜索框里有字，先清字；再按才关。
        if (L.q !== "") setQ("");
        else L.onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        focusFind();
        return;
      }
      // 带修饰键的留给浏览器（Ctrl+加减是整页缩放）。
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target === input.current) {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          L.step(e.shiftKey ? -1 : 1);
        }
        return;
      }
      const go = (/** @type {number} */ dx, /** @type {number} */ dy) => {
        e.preventDefault();
        pan.set(pz.panBy(pan.get(), dx, dy));
      };
      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          pan.zoom(STEP);
          break;
        case "-":
        case "_":
          e.preventDefault();
          pan.zoom(1 / STEP);
          break;
        case "0":
          e.preventDefault();
          pan.fit(true);
          break;
        case "1":
          e.preventDefault();
          pan.actual();
          break;
        case "/":
          e.preventDefault();
          focusFind();
          break;
        case "ArrowLeft":
          go(60, 0);
          break;
        case "ArrowRight":
          go(-60, 0);
          break;
        case "ArrowUp":
          go(0, 60);
          break;
        case "ArrowDown":
          go(0, -60);
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    root.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const n = hits.length;
  const count = q.trim() === "" ? "" : n === 0 ? "没有" : `${cur + 1}/${n}`;
  const save = () => savePng(d).then(() => flash("已存"), () => flash("存图失败"));
  return html`<div class="mmv" data-mmv role="dialog" aria-modal="true" aria-label="mermaid 图" tabindex="-1" ref=${root}>
    <div class="mmv-bar">
      <span class="mmv-t">MERMAID</span>
      <span class="mmv-find">
        <input ref=${input} type="text" class="mmv-in" aria-label="搜索节点上的文字" placeholder="搜索节点文字（/）" value=${q} autocomplete="off" spellcheck=${false} onInput=${(/** @type {any} */ e) => setQ(e.currentTarget.value)} />
        <span class=${`mmv-count mono${count === "没有" ? " none" : ""}`} aria-live="polite">${count}</span>
      </span>
      <span class="mmv-pct mono" title="当前缩放">${Math.round(pan.view.k * 100)}%</span>
      <span class="mm-bs">
        <button type="button" class="mm-b" aria-label="缩小" title="缩小（-）" onClick=${() => pan.zoom(1 / STEP)}>−</button>
        <button type="button" class="mm-b" aria-label="放大" title="放大（+）" onClick=${() => pan.zoom(STEP)}>+</button>
        <button type="button" class="mm-b" title="整张图适应窗口（0）" onClick=${() => pan.fit(true)}>适应</button>
        <button type="button" class="mm-b" title="100%（1）" onClick=${() => pan.actual()}>1:1</button>
        <button type="button" class="mm-b" title="存成 PNG" onClick=${save}>${saveLabel}</button>
        <button type="button" class="mm-b" title="关闭（Esc）" onClick=${onClose}>关闭</button>
      </span>
    </div>
    <div class="mmv-main">
      <div class="mmv-stage" ref=${stage}>
        <${Sheet} d=${d} svg=${svg} view=${pan.view} anim=${pan.anim} hits=${hits} cur=${cur} sheetRef=${sheet} />
      </div>
      <${Minimap} d=${d} view=${pan.view} vp=${size} pan=${pan} />
    </div>
  </div>`;
}
