// extras/models/file.ts：读法和内核一样（共用 test/modelfile-suite.ts），写是先临时文件再改名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS_FILE_MAX_BYTES, isValidEntry, readModelFile, writeModelFile } from "../../../extras/models/file.ts";
import { entry, modelFileSuite } from "../../modelfile-suite.ts";

modelFileSuite("extras/models/file.ts", (dir, provider) => readModelFile(dir, provider) as never);

test("写：内容读得回来，目录里没有留下临时文件，再写一次换成新的", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sub = join(dir, "not", "yet");
  await writeModelFile(sub, "x", { generatedAt: "t", models: [entry("a")] });
  assert.deepEqual(readModelFile(sub, "x").map((m) => m.id), ["a"]);
  assert.equal(JSON.parse(readFileSync(join(sub, "x.json"), "utf8")).generatedAt, "t", "别的顶层键留着");
  await writeModelFile(sub, "x", { models: [entry("b")] });
  assert.deepEqual(readModelFile(sub, "x").map((m) => m.id), ["b"]);
  assert.deepEqual(readdirSync(sub), ["x.json"]);
});

test("写：超过内核的大小上限就不写，旧文件原样", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x.json"), JSON.stringify({ models: [entry("old")] }));
  await assert.rejects(writeModelFile(dir, "x", { models: [entry("a")], pad: "x".repeat(MODELS_FILE_MAX_BYTES) }), /超过/);
  assert.deepEqual(readModelFile(dir, "x").map((m) => m.id), ["old"]);
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("写：两个写的人同时写，留下的是其中一个完整的文件", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-modelw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 8 }, (_, i) => writeModelFile(dir, "x", { models: [entry(`m${i}`)] })));
  const ids = readModelFile(dir, "x").map((m) => m.id);
  assert.equal(ids.length, 1);
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("isValidEntry 和读法同一套条件", () => {
  assert.equal(isValidEntry(entry("a"), "p"), true);
  assert.equal(isValidEntry(entry("a", { provider: "q" }), "p"), false);
  assert.equal(isValidEntry(entry("a", { maxTokens: 0 }), "p"), false);
});
