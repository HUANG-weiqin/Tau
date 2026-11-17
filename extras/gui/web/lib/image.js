// @ts-check
// 图片：入口条件（要和 src/images.ts、src/kernel/derive.ts 的常量一致，测试盯着）、缩放压缩、张数。
// 纯函数在前，浏览器里才跑的 canvas 部分在后。

/** 每张图片的字节数上限。 */
export const MAX_BYTES = 1.5 * 1024 * 1024;
/** 宽和高的像素上限。 */
export const MAX_EDGE = 2000;
/** 一封信最多几张图片。 */
export const PER_MESSAGE = 2;
/** 服务收的类型。 */
export const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** 缩小后重新压的质量，从高到低。 */
export const QUALITIES = [0.9, 0.8, 0.7, 0.55, 0.4];
/** 压到最低质量还超，就把边长再乘一次这些比例。 */
export const SHRINKS = [0.75, 0.5, 0.35];

/**
 * 缩到长边不超过 `max`，保持比例。已经合格就原尺寸。
 * @param {number} width @param {number} height @param {number} [max]
 * @returns {{ width: number, height: number }}
 */
export function fitSize(width, height, max = MAX_EDGE) {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * 原图能不能原样发：类型认识、字节和尺寸都在上限内。
 * @param {{ type: string, bytes: number, width: number, height: number }} f
 */
export function isFit(f) {
  return ACCEPTED.includes(f.type) && f.bytes <= MAX_BYTES && f.width <= MAX_EDGE && f.height <= MAX_EDGE;
}

/**
 * 重新编码的尝试表，从好到差：
 * 1. 原格式（png、jpeg、webp）缩到上限内，质量 0.92；gif 没有编码器，跳过这一项。
 * 2. 转 JPEG，缩到上限内，质量从高到低。
 * 3. 还超就再缩小边长，每一档 JPEG 两个质量。
 * 前一项合格就停（由调用方判）。
 * @param {string} type 原图类型 @param {number} width @param {number} height
 * @returns {{ mime: string, quality: number, width: number, height: number }[]}
 */
export function attempts(type, width, height) {
  const base = fitSize(width, height);
  /** @type {{ mime: string, quality: number, width: number, height: number }[]} */
  const out = [];
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp") out.push({ mime: type, quality: 0.92, ...base });
  for (const q of QUALITIES) out.push({ mime: "image/jpeg", quality: q, ...base });
  for (const k of SHRINKS) {
    const s = fitSize(Math.round(base.width * k), Math.round(base.height * k));
    for (const q of [0.8, 0.6]) out.push({ mime: "image/jpeg", quality: q, ...s });
  }
  return out;
}

/**
 * 还能再加几张：`have` 是已有的，`adding` 是这次要加的。
 * @param {number} have @param {number} adding
 * @returns {{ take: number, dropped: number }}
 */
export function room(have, adding) {
  const take = Math.max(0, Math.min(adding, PER_MESSAGE - have));
  return { take, dropped: adding - take };
}

/** 加图以后给用户的一行说明。没有要说的是 null。 @param {number} dropped @param {string[]} failed */
export function addNote(dropped, failed) {
  /** @type {string[]} */
  const parts = [];
  if (dropped > 0) parts.push(`一封信最多 ${PER_MESSAGE} 张图片，多的 ${dropped} 张没有加`);
  for (const f of failed) parts.push(f);
  return parts.length ? parts.join("；") : null;
}

/* ------------------------------------------------------------------ 浏览器里才跑的部分 */

/** @param {Blob} blob @returns {Promise<string>} data URL */
function readUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读不了这个文件"));
    r.readAsDataURL(blob);
  });
}

/** @param {string} url */
function parts(url) {
  return { url, data: url.slice(url.indexOf(",") + 1) };
}

/**
 * 把一个图片文件变成能寄的：合格就原样，不合格就在 canvas 里缩小重新编码。
 * 转 JPEG 时先垫白底。压不到上限以内就抛错。
 * @param {File | Blob} file
 * @returns {Promise<{ data: string, url: string, resized: boolean }>}
 */
export async function prepare(file) {
  /** @type {ImageBitmap} */
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("这个文件不是浏览器能读的图片");
  }
  try {
    if (isFit({ type: file.type, bytes: file.size, width: bmp.width, height: bmp.height })) return { ...parts(await readUrl(file)), resized: false };
    for (const a of attempts(file.type, bmp.width, bmp.height)) {
      const c = document.createElement("canvas");
      c.width = a.width;
      c.height = a.height;
      const g = c.getContext("2d");
      if (!g) throw new Error("浏览器画不了图");
      if (a.mime === "image/jpeg") {
        g.fillStyle = "#fff";
        g.fillRect(0, 0, a.width, a.height);
      }
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, a.width, a.height);
      const blob = await new Promise((resolve) => c.toBlob(resolve, a.mime, a.quality));
      // 浏览器不会编这个格式时回的是 png：跳过这一项。
      if (!(blob instanceof Blob) || blob.type !== a.mime || blob.size > MAX_BYTES) continue;
      return { ...parts(await readUrl(blob)), resized: true };
    }
    throw new Error("压不到 1.5 MB 以内");
  } finally {
    bmp.close();
  }
}
