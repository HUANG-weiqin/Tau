// 图片的入口检查（设计稿 5.6）：张数、大小、魔数和四种类型、每种格式的尺寸。纯函数，不碰库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkImages, IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, imageSize, imageType } from "../src/images.ts";
import { IMAGES_PER_MESSAGE } from "../src/kernel/derive.ts";
import { gif, jpeg, png, webp } from "./images.ts";

const b64 = (b: Buffer) => b.toString("base64");

test("常量：每封信 2 张，每张 1.5 MiB，边长 2000", () => {
  assert.equal(IMAGES_PER_MESSAGE, 2);
  assert.equal(IMAGE_MAX_BYTES, 1_572_864);
  assert.equal(IMAGE_MAX_EDGE, 2000);
});

test("魔数：四种类型各认各的；不认识的、空的、太短的都是 null", () => {
  assert.equal(imageType(png(1, 1)), "image/png");
  assert.equal(imageType(jpeg(1, 1)), "image/jpeg");
  assert.equal(imageType(gif(1, 1)), "image/gif");
  assert.equal(imageType(gif(1, 1, 0, "87a")), "image/gif");
  for (const k of ["VP8 ", "VP8L", "VP8X"] as const) assert.equal(imageType(webp(k, 1, 1)), "image/webp");
  assert.equal(imageType(Buffer.from("BM....")), null);
  assert.equal(imageType(Buffer.from("RIFF....WAVE")), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
  assert.equal(imageType(Buffer.from([0x89, 0x50])), null);
});

test("尺寸：PNG、GIF、三种 WebP", () => {
  assert.deepEqual(imageSize(png(2000, 1234), "image/png"), { width: 2000, height: 1234 });
  assert.deepEqual(imageSize(gif(640, 480), "image/gif"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(webp("VP8 ", 1999, 1001), "image/webp"), { width: 1999, height: 1001 });
  assert.deepEqual(imageSize(webp("VP8L", 2000, 768), "image/webp"), { width: 2000, height: 768 });
  assert.deepEqual(imageSize(webp("VP8X", 2000, 2000), "image/webp"), { width: 2000, height: 2000 });
  assert.deepEqual(imageSize(webp("VP8L", 16384, 1), "image/webp"), { width: 16384, height: 1 });
});

test("尺寸：JPEG 跳过标记段找 SOF0；带 EXIF（段比 255 字节长）和渐进式 SOF2 也行", () => {
  assert.deepEqual(imageSize(jpeg(800, 600), "image/jpeg"), { width: 800, height: 600 });
  assert.deepEqual(imageSize(jpeg(1920, 1080, { exif: 4000 }), "image/jpeg"), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(jpeg(1500, 900, { progressive: true }), "image/jpeg"), { width: 1500, height: 900 });
  assert.deepEqual(imageSize(jpeg(1500, 900, { progressive: true, exif: 60_000 }), "image/jpeg"), { width: 1500, height: 900 });
});

test("尺寸：JPEG 填充字节 FF 和独立标记不影响；到 SOS 还没有 SOF、头被截断，都是 null", () => {
  const ok = jpeg(30, 20);
  const padded = Buffer.concat([ok.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff, 0x01]), ok.subarray(2)]);
  assert.deepEqual(imageSize(padded, "image/jpeg"), { width: 30, height: 20 });
  const sos = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0]);
  assert.equal(imageSize(sos, "image/jpeg"), null);
  assert.equal(imageSize(ok.subarray(0, ok.length - 20), "image/jpeg"), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"), null);
});

test("尺寸：别的格式的头被截断或写坏，是 null，不抛错", () => {
  assert.equal(imageSize(png(5, 5).subarray(0, 20), "image/png"), null);
  assert.equal(imageSize(gif(5, 5).subarray(0, 8), "image/gif"), null);
  assert.equal(imageSize(webp("VP8L", 5, 5).subarray(0, 22), "image/webp"), null);
  const badChunk = webp("VP8X", 5, 5);
  badChunk.write("ZZZZ", 12, "latin1");
  assert.equal(imageSize(badChunk, "image/webp"), null);
  const noStart = webp("VP8 ", 5, 5);
  noStart[23] = 0;
  assert.equal(imageSize(noStart, "image/webp"), null);
});

test("checkImages：合格的图片，类型来自魔数，哈希是原始字节的 sha256", () => {
  const a = png(100, 50, 1);
  const b = jpeg(2000, 2000, { progressive: true });
  const out = checkImages([b64(a), b64(b)]);
  assert.deepEqual(
    out.map((i) => [i.mimeType, i.hash, i.bytes.equals(i === out[0] ? a : b)]),
    [
      ["image/png", createHash("sha256").update(a).digest("hex"), true],
      ["image/jpeg", createHash("sha256").update(b).digest("hex"), true],
    ],
  );
  assert.match(out[0]!.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(checkImages([]), []);
});

test("checkImages 张数：最多 2 张，3 张拒绝", () => {
  const one = b64(png(1, 1));
  assert.equal(checkImages([one, one]).length, 2);
  assert.throws(() => checkImages([one, one, one]), /最多带 2 张图片，收到 3 张/);
});

test("checkImages 大小：恰好 1.5 MiB 合格，多 1 字节拒绝", () => {
  const pad = (n: number) => Buffer.concat([png(10, 10), Buffer.alloc(n - png(10, 10).length)]);
  assert.equal(checkImages([b64(pad(IMAGE_MAX_BYTES))]).length, 1);
  assert.throws(() => checkImages([b64(pad(IMAGE_MAX_BYTES + 1))]), /第 1 张图片有 1572865 字节，上限 1572864 字节/);
});

test("checkImages 类型：不信扩展名和声明，只看魔数；不认识的拒绝", () => {
  assert.throws(() => checkImages([b64(Buffer.from("BM" + "x".repeat(100)))]), /类型不认识/);
  assert.throws(() => checkImages([b64(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))]), /类型不认识/);
  assert.throws(() => checkImages([b64(Buffer.alloc(0))]), /类型不认识/);
});

test("checkImages 尺寸：2000 合格，2001 拒绝，宽或高都查；读不出尺寸、零尺寸拒绝", () => {
  assert.equal(checkImages([b64(png(2000, 2000))]).length, 1);
  assert.throws(() => checkImages([b64(png(2001, 10))]), /2001×10.*不能超过 2000/);
  assert.throws(() => checkImages([b64(gif(10, 2001))]), /10×2001/);
  assert.throws(() => checkImages([b64(webp("VP8X", 4000, 100))]), /4000×100/);
  assert.throws(() => checkImages([b64(jpeg(8001, 10, { exif: 1000 }))]), /8001×10/);
  assert.throws(() => checkImages([b64(png(0, 10))]), /读不出尺寸/);
  assert.throws(() => checkImages([b64(png(5, 5).subarray(0, 20))]), /读不出尺寸/);
});

test("checkImages 顺序：张数、大小、类型、尺寸；每一步对全部图片做完再做下一步", () => {
  const big = Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_MAX_BYTES)]);
  const bad = Buffer.from("not an image");
  const huge = png(5000, 5000);
  const ok = png(1, 1);
  // 张数先于一切
  assert.throws(() => checkImages([b64(big), b64(bad), b64(huge)]), /最多带/);
  // 第 1 张类型不对、第 2 张太大：先报大小
  assert.throws(() => checkImages([b64(bad), b64(big)]), /第 2 张图片有.*上限/);
  // 第 1 张尺寸不对、第 2 张类型不对：先报类型
  assert.throws(() => checkImages([b64(huge), b64(bad)]), /第 2 张图片的类型不认识/);
  assert.throws(() => checkImages([b64(ok), b64(huge)]), /第 2 张图片是 5000×5000/);
});

test("checkImages：不是合法的 base64 拒绝", () => {
  assert.throws(() => checkImages(["!!!!"]), /不是合法的 base64/);
  assert.throws(() => checkImages(["abc"]), /不是合法的 base64/);
  assert.throws(() => checkImages([b64(png(1, 1)) + "="]), /不是合法的 base64/);
});
