// @ts-check
// 图的平移缩放和存图的数学。纯函数，不碰 DOM。ui/mermaid.js 只调用这里。
// 视图 {x, y, k}：内容坐标 (cx, cy) 落在视口的 (x + cx·k, y + cy·k)。

/** @typedef {{ x: number, y: number, k: number }} View */
/** @typedef {{ w: number, h: number }} Size */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ x: number, y: number }} Pt */

/** 缩放的上下限。 */
export const LIMITS = { min: 0.05, max: 8 };
/** 存图的上限：最长边（像素）和总像素。 */
export const EXPORT_SIDE = 12000;
export const EXPORT_PIXELS = 50_000_000;

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {Size} s */
const bad = (s) => !(s.w > 0 && s.h > 0) || !Number.isFinite(s.w) || !Number.isFinite(s.h);

/**
 * 适应：整张图缩进视口、居中。`maxK` 是放大的上限（小图不撑满）。内容或视口没有尺寸时回原样。
 * @param {Size} content @param {Size} vp @param {number} [pad] 留白 @param {number} [maxK]
 * @returns {View}
 */
export function fitView(content, vp, pad = 16, maxK = 1) {
  if (bad(content) || bad(vp)) return { x: 0, y: 0, k: 1 };
  const k = clamp(Math.min((vp.w - 2 * pad) / content.w, (vp.h - 2 * pad) / content.h), LIMITS.min, Math.max(LIMITS.min, maxK));
  return { x: (vp.w - content.w * k) / 2, y: (vp.h - content.h * k) / 2, k };
}

/**
 * 消息流里卡片视口的高度：按栏宽适应（不放大）以后的图高，限在 min 到 max 之间。
 * @param {Size} content @param {number} width @param {{ pad?: number, min?: number, max?: number }} [o]
 */
export function fitHeight(content, width, o = {}) {
  const { pad = 16, min = 160, max = 480 } = o;
  if (bad(content) || !(width > 0)) return min;
  const k = Math.min(1, Math.max(LIMITS.min, (width - 2 * pad) / content.w));
  return Math.round(clamp(content.h * k + 2 * pad, min, max));
}

/**
 * 以视口里的点 p 为中心缩放：p 下面的内容点不动。
 * @param {View} v @param {Pt} p @param {number} factor @param {{ min: number, max: number }} [lim]
 * @returns {View}
 */
export function zoomAt(v, p, factor, lim = LIMITS) {
  return zoomTo(v, p, v.k * factor, lim);
}

/** 同上，直接给目标比例。 @param {View} v @param {Pt} p @param {number} k @param {{ min: number, max: number }} [lim] @returns {View} */
export function zoomTo(v, p, k, lim = LIMITS) {
  const nk = clamp(k, lim.min, lim.max);
  const r = nk / v.k;
  return { x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r, k: nk };
}

/** @param {View} v @param {number} dx @param {number} dy @returns {View} */
export const panBy = (v, dx, dy) => ({ x: v.x + dx, y: v.y + dy, k: v.k });

/**
 * 把内容里的一个矩形移到视口中间。比例至少是 `minK`，图本来就比它大就不缩小。
 * @param {View} v @param {Rect} rect @param {Size} vp @param {number} [minK] @param {{ min: number, max: number }} [lim]
 * @returns {View}
 */
export function centerOn(v, rect, vp, minK = 1, lim = LIMITS) {
  const k = clamp(Math.max(v.k, minK), lim.min, lim.max);
  return { x: vp.w / 2 - (rect.x + rect.w / 2) * k, y: vp.h / 2 - (rect.y + rect.h / 2) * k, k };
}

/** 比例不变，把内容点 (cx, cy) 移到视口中间（点小地图用）。 @param {View} v @param {number} cx @param {number} cy @param {Size} vp @returns {View} */
export function centerAt(v, cx, cy, vp) {
  return { x: vp.w / 2 - cx * v.k, y: vp.h / 2 - cy * v.k, k: v.k };
}

/** 视图对应的内容区域（小地图的框）。 @param {View} v @param {Size} vp @returns {Rect} */
export function visibleRect(v, vp) {
  return { x: -v.x / v.k, y: -v.y / v.k, w: vp.w / v.k, h: vp.h / v.k };
}

/** 整张图（0,0 起，`content` 大小）已经全在视野里。 @param {Rect} vis @param {Size} content */
export function covers(vis, content) {
  return vis.x <= 0.5 && vis.y <= 0.5 && vis.x + vis.w >= content.w - 0.5 && vis.y + vis.h >= content.h - 0.5;
}

/** 小地图：整张图缩进 maxW×maxH，比例 s，不放大。 @param {Size} content @param {number} maxW @param {number} maxH */
export function miniFit(content, maxW, maxH) {
  if (bad(content)) return { w: 0, h: 0, s: 1 };
  const s = Math.min(1, maxW / content.w, maxH / content.h);
  return { w: Math.round(content.w * s), h: Math.round(content.h * s), s };
}

/**
 * 双指：两个点从 (a0, b0) 移到 (a1, b1)。比例随两点距离，中点下的内容点跟着中点走。
 * @param {View} v0 双指按下时的视图 @param {Pt} a0 @param {Pt} b0 @param {Pt} a1 @param {Pt} b1 @param {{ min: number, max: number }} [lim]
 * @returns {View}
 */
export function pinch(v0, a0, b0, a1, b1, lim = LIMITS) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const k = clamp(d0 > 0 ? (v0.k * d1) / d0 : v0.k, lim.min, lim.max);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const cx = (m0.x - v0.x) / v0.k;
  const cy = (m0.y - v0.y) / v0.k;
  return { x: m1.x - cx * k, y: m1.y - cy * k, k };
}

/** 搜索：不分大小写的子串。回匹配的下标。空查询没有匹配。 @param {string[]} texts @param {string} q */
export function matchIndexes(texts, q) {
  const s = q.trim().toLowerCase();
  if (s === "") return [];
  /** @type {number[]} */
  const out = [];
  texts.forEach((t, i) => {
    if (t.toLowerCase().includes(s)) out.push(i);
  });
  return out;
}

/** 在 n 个匹配里转一圈。`i` 是 -1 表示还没选。n 为 0 回 -1。 @param {number} i @param {number} n @param {1 | -1} dir */
export function cycle(i, n, dir) {
  if (n <= 0) return -1;
  if (i < 0 || i >= n) return dir > 0 ? 0 : n - 1;
  return (i + dir + n) % n;
}

/**
 * 存图的比例：默认 `want` 倍；最长边不超过 `maxSide`，总像素不超过 `maxPixels`，超了按比例缩小。
 * @param {number} w @param {number} h @param {number} [want] @param {number} [maxSide] @param {number} [maxPixels]
 */
export function exportScale(w, h, want = 2, maxSide = EXPORT_SIDE, maxPixels = EXPORT_PIXELS) {
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(want, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
}

/** 存图的文件名：mermaid-YYYYMMDD-HHmmss.png（本地时间）。 @param {Date} d */
export function exportName(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `mermaid-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

/** 从 SVG 文本读 viewBox。没有或不合法回 null。 @param {string} svg @returns {{ x: number, y: number, w: number, h: number } | null} */
export function parseViewBox(svg) {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  const m = tag ? /\sviewBox="([^"]*)"/i.exec(tag) : null;
  if (!m) return null;
  const n = (m[1] ?? "").trim().split(/[\s,]+/).map(Number);
  const [x, y, w, h] = n;
  if (n.length !== 4 || x === undefined || y === undefined || w === undefined || h === undefined) return null;
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/**
 * 给根 `<svg>` 写明宽高（像素），去掉它原来的 width、height、style（mermaid 写的是 100% 和 max-width）；
 * 缺 xmlns 就补上；`&nbsp;` 换成数字实体（当图片加载是严格的 XML，认不得它）。
 * @param {string} svg @param {number} w @param {number} h
 */
export function sizedSvg(svg, w, h) {
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (!m) return svg;
  const attrs = m[0]
    .slice(4, -1)
    .replace(/\s(?:width|height|style)="[^"]*"/gi, "")
    .replace(/\/$/, "");
  const ns = /\sxmlns=/.test(attrs) ? "" : ' xmlns="http://www.w3.org/2000/svg"';
  // 图里用了 xlink: 而根上没声明，当图片加载时 XML 解析会失败。
  const xl = /\sxmlns:xlink=/.test(attrs) || !/\sxlink:[\w-]+=/.test(svg) ? "" : ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  const head = `<svg width="${round(w)}" height="${round(h)}"${ns}${xl}${attrs}>`;
  return (svg.slice(0, m.index) + head + svg.slice(m.index + m[0].length)).replace(/&nbsp;/g, "&#160;");
}

/**
 * 报错文字：去掉头尾的空行和行尾空白，保留换行和行首的空格（插入符那一行靠它对齐），最多 `max` 行，多了加一行省略号。
 * @param {string} msg @param {number} [max]
 */
export function errorText(msg, max = 8) {
  const lines = msg.replace(/\s+$/, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length === 0) return "未知错误";
  return lines.length > max ? [...lines.slice(0, max), "…"].join("\n") : lines.join("\n");
}

/** @param {number} n */
const round = (n) => Math.round(n * 100) / 100;
