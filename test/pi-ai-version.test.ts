// pi-ai 两处必须同版本（D84）：服务用根目录的那份，桥的模型目录用 extras/ 的那份。差了，界面会列出服务不认的模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string): { version?: string; packages?: Record<string, { version?: string }> } => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const PKG = "@earendil-works/pi-ai";

test("根目录和 extras/ 的锁文件里 pi-ai 是同一个版本", () => {
  const a = read("package-lock.json").packages?.[`node_modules/${PKG}`]?.version;
  const b = read("extras/package-lock.json").packages?.[`node_modules/${PKG}`]?.version;
  assert.ok(a, "根目录的锁文件里没有 pi-ai");
  assert.equal(b, a, "两个锁文件里 pi-ai 的版本不一样：两处各 npm update 一次");
});

test("装好的 pi-ai 两份版本一样，也和锁文件一样", () => {
  const lock = read("package-lock.json").packages?.[`node_modules/${PKG}`]?.version;
  const root = read(`node_modules/${PKG}/package.json`).version;
  const extras = read(`extras/node_modules/${PKG}/package.json`).version;
  assert.equal(root, lock, "根目录装的和锁文件不一样：npm ci");
  assert.equal(extras, lock, "extras/ 装的和锁文件不一样：在 extras/ 里 npm ci");
});
