// briefOf：摘要的截取（不切断字符和代理对）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefOf, utf8Bytes } from "../../src/kernel/derive.ts";
import { MEMORY_BRIEF_MAX_BYTES } from "../../src/kernel/tools.ts";

test("briefOf：不超过上限时原样返回", () => {
  assert.equal(MEMORY_BRIEF_MAX_BYTES, 200);
  assert.equal(briefOf(""), "");
  assert.equal(briefOf("住在上海"), "住在上海");
  assert.equal(briefOf("x".repeat(199)), "x".repeat(199));
  assert.equal(briefOf("x".repeat(200)), "x".repeat(200));
  assert.equal(briefOf("汉".repeat(66) + "ab"), "汉".repeat(66) + "ab", "66 × 3 + 2 = 200 字节");
});

test("briefOf：超过上限时取前 200 字节", () => {
  assert.equal(briefOf("x".repeat(201)), "x".repeat(200));
  assert.equal(utf8Bytes(briefOf("x".repeat(4096))), 200);
});

test("briefOf：不切断汉字", () => {
  // 199 个字节之后是一个汉字：加上它就是 201 字节，所以停在 198。
  const brief = briefOf("x".repeat(198) + "汉字");
  assert.equal(brief, "x".repeat(198));
  assert.equal(utf8Bytes(brief), 198);
  // 正好到边界时带上这个汉字。
  assert.equal(briefOf("x".repeat(197) + "汉字"), "x".repeat(197) + "汉");
});

test("briefOf：不切断代理对", () => {
  const emoji = "\u{1F600}"; // 4 字节，一对代理项
  assert.equal(briefOf("x".repeat(196) + emoji), "x".repeat(196) + emoji, "加上正好 200 字节");
  const brief = briefOf("x".repeat(197) + emoji);
  assert.equal(brief, "x".repeat(197), "加上就超过 200 字节，整个代理对都丢掉");
  assert.equal(utf8Bytes(brief), 197);
  assert.equal(/[\uD800-\uDFFF]/.test(brief), false, "结果里没有孤立的代理项");
});
