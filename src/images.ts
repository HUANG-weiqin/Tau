// 图片的入口检查：张数、大小、类型、尺寸，按这个顺序（设计稿 5.6）。纯函数，不读库，不依赖别的模块（除了张数上限）。
import { createHash } from "node:crypto";
import { IMAGES_PER_MESSAGE } from "./kernel/derive.ts";

/** 每张图片的原始字节数上限。 */
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/** 宽和高的像素上限，和 pi-ai 模型目录给收图片的模型定的缩放尺寸一样。 */
export const IMAGE_MAX_EDGE = 2000;

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** 通过检查的图片：哈希是原始字节的 sha256，64 位小写十六进制。 */
export interface Image {
  hash: string;
  mimeType: ImageType;
  bytes: Buffer;
}

/** 按文件头的魔数判断类型。不信声明的类型和扩展名。 */
export function imageType(b: Buffer): ImageType | null {
  const head = (n: number) => b.toString("latin1", 0, n);
  if (head(8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (head(3) === "\xff\xd8\xff") return "image/jpeg";
  if (head(6) === "GIF87a" || head(6) === "GIF89a") return "image/gif";
  if (head(4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** 从文件头读宽和高。头残缺、不认识时返回 null。 */
export function imageSize(b: Buffer, type: ImageType): { width: number; height: number } | null {
  try {
    switch (type) {
      case "image/png":
        return b.toString("latin1", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
      case "image/gif":
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "image/webp":
        return webpSize(b);
      case "image/jpeg":
        return jpegSize(b);
    }
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  switch (b.toString("latin1", 12, 16)) {
    case "VP8 ":
      return b.toString("latin1", 23, 26) === "\x9d\x01\x2a" ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : null;
    case "VP8L": {
      if (b[20] !== 0x2f) return null;
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** 从头逐段跳过标记段（APPn、EXIF 等），找 SOFn，包括渐进式的 SOF2。 */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) i++;
    else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2;
    else if (m === 0xd9 || m === 0xda) return null;
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    else {
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** 一批 base64 图片的入口检查。按顺序，每一步对全部图片做完再做下一步；不合格就抛出，原因是错误信息。 */
export function checkImages(encoded: readonly string[]): Image[] {
  if (encoded.length > IMAGES_PER_MESSAGE) throw new Error(`一个请求最多带 ${IMAGES_PER_MESSAGE} 张图片，收到 ${encoded.length} 张。`);
  const all = encoded.map((s, i) => {
    if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error(`第 ${i + 1} 张图片不是合法的 base64。`);
    return Buffer.from(s, "base64");
  });
  all.forEach((b, i) => {
    if (b.length > IMAGE_MAX_BYTES) throw new Error(`第 ${i + 1} 张图片有 ${b.length} 字节，上限 ${IMAGE_MAX_BYTES} 字节。`);
  });
  const types = all.map((b, i) => {
    const type = imageType(b);
    if (!type) throw new Error(`第 ${i + 1} 张图片的类型不认识：按文件头只收 png、jpeg、gif、webp。`);
    return type;
  });
  return all.map((bytes, i) => {
    const mimeType = types[i]!;
    const size = imageSize(bytes, mimeType);
    if (!size || size.width < 1 || size.height < 1) throw new Error(`第 ${i + 1} 张图片的文件头读不出尺寸。`);
    if (size.width > IMAGE_MAX_EDGE || size.height > IMAGE_MAX_EDGE) throw new Error(`第 ${i + 1} 张图片是 ${size.width}×${size.height}，宽和高都不能超过 ${IMAGE_MAX_EDGE} 像素。`);
    return { hash: createHash("sha256").update(bytes).digest("hex"), mimeType, bytes };
  });
}
