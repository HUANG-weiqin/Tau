// 测试用的图片：只拼文件头，够入口检查读出类型和尺寸，不是能解码的图片。`salt` 让字节不同、哈希不同。
const u16le = (n: number) => [n & 0xff, n >> 8];
const u16be = (n: number) => [n >> 8, n & 0xff];
const u32be = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const tail = (salt: number) => [salt & 0xff, salt >> 8];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function png(width: number, height: number, salt = 0): Buffer {
  return Buffer.from([0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...tail(salt)]);
}

export function gif(width: number, height: number, salt = 0, version = "89a"): Buffer {
  return Buffer.from([...ascii(`GIF${version}`), ...u16le(width), ...u16le(height), 0, 0, 0, ...tail(salt)]);
}

/** 三种 WebP：有损（VP8）、无损（VP8L）、扩展（VP8X）。 */
export function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number, salt = 0): Buffer {
  let chunk: number[];
  if (kind === "VP8 ") chunk = [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
  else if (kind === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14);
    chunk = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff];
  } else {
    const w = width - 1;
    const h = height - 1;
    chunk = [0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16];
  }
  chunk.push(...tail(salt));
  const size = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  return Buffer.from([...ascii("RIFF"), ...size(4 + 8 + chunk.length), ...ascii("WEBP"), ...ascii(kind), ...size(chunk.length), ...chunk]);
}

/** JPEG：SOI，`exif` 个字节的 APP1，一个 DQT，再是 SOF。`progressive` 用 SOF2，否则 SOF0。 */
export function jpeg(width: number, height: number, opts: { exif?: number; progressive?: boolean; salt?: number } = {}): Buffer {
  const segment = (marker: number, body: number[]) => [0xff, marker, ...u16be(body.length + 2), ...body];
  const app1 = opts.exif === undefined ? [] : segment(0xe1, [...ascii("Exif\0\0"), ...new Array<number>(opts.exif).fill(0xff)]);
  const dqt = segment(0xdb, new Array<number>(65).fill(1));
  const sof = segment(opts.progressive ? 0xc2 : 0xc0, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]);
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...u16be(16), ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0, ...app1, ...dqt, ...sof, 0xff, 0xda, ...tail(opts.salt ?? 0)]);
}
