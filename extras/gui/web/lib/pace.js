// @ts-check
// 匀速吐字的算法：网络一块一块地到，屏幕上匀速出字。纯函数，不碰 DOM、不读时钟，时间由参数传入。
// 前馈：最近两秒的到达速度；反馈：把积压拉向一个设定值，设定值跟着最近的到达间隔走（网络越卡，缓冲越厚）。

/**
 * @typedef {object} Pace
 * @property {number} shown 已经吐出的字数（小数，整数部分是屏幕上的字数）
 * @property {number} rate 当前的吐字速度，字/秒
 * @property {number} gm 最近到达间隔的慢衰减峰值，秒
 * @property {number | null} last 上一块到达的时刻 ms
 * @property {number | null} first 第一块到达的时刻 ms
 * @property {[number, number][]} win 两秒窗口里的到达：[时刻 ms, 字数]
 */

/** 到达速度的统计窗口，ms。 */
const WINDOW_MS = 2000;
/** 到达间隔峰值每秒衰减的时间常数，秒。 */
const GAP_DECAY = 2;
/** 设定的积压 = 到达速度 × 峰值间隔 × 这个倍数，再夹在下面两个数之间（秒）：卡的网络多留一点，顺的网络少留一点。 */
const BACKLOG_GAIN = 1.15;
const BACKLOG_MIN = 0.15;
const BACKLOG_MAX = 0.8;
/** 一直有一点速度，免得第一块来了没有起步。字/秒。 */
const RATE_FLOOR = 12;
/** 写完时，要在这么多秒里追平积压；积压很大（一次来了很多）时，在 BIG_SECONDS 里追平。 */
const ENDING_SECONDS = 0.3;
const BIG_BACKLOG = 400;
const BIG_SECONDS = 0.5;
/** 速度跟上目标的时间常数，秒：写完时快，平时慢，平时才不抖。 */
const TAU_ENDING = 0.12;
const TAU_NORMAL = 0.4;

/** @param {number} [shown] @returns {Pace} */
export function newPace(shown = 0) {
  return { shown, rate: 0, gm: 0, last: null, first: null, win: [] };
}

/**
 * 记一块到达：`n` 个字，`now` 是到达时刻 ms。
 * @param {Pace} p @param {number} now @param {number} n @returns {Pace}
 */
export function paceArrive(p, now, n) {
  let gm = p.gm;
  if (p.last !== null) {
    const g = (now - p.last) / 1000;
    gm = Math.max(g, gm * Math.exp(-g / GAP_DECAY));
  }
  return { ...p, gm, last: now, first: p.first ?? now, win: [...p.win, [now, n]] };
}

/**
 * 走一帧。`received` 是已经到的总字数，`ending` 表示不会再有字了，`dt` 是这一帧的秒数。
 * @param {Pace} p @param {number} now @param {number} received @param {boolean} ending @param {number} dt @returns {Pace}
 */
export function paceStep(p, now, received, ending, dt) {
  const win = p.win.filter((a) => a[0] >= now - WINDOW_MS);
  let w = 0;
  for (const a of win) w += a[1];
  w /= Math.max(0.25, Math.min(2, p.first === null ? 2 : (now - p.first) / 1000 + 0.1));
  const back = received - p.shown;
  const want = Math.min(BACKLOG_MAX, Math.max(BACKLOG_MIN, p.gm * BACKLOG_GAIN));
  let target = Math.max(RATE_FLOOR, w) + (back - w * want);
  if (ending) target = Math.max(target, back / ENDING_SECONDS);
  if (back > BIG_BACKLOG) target = Math.max(target, back / BIG_SECONDS);
  target = Math.max(0, target);
  const rate = p.rate + (target - p.rate) * (1 - Math.exp(-dt / (ending ? TAU_ENDING : TAU_NORMAL)));
  return { ...p, win, rate, shown: Math.min(received, p.shown + rate * dt) };
}
