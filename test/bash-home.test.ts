// 内置 bash 把输出写在 ~/.tau/extras/shell（D90）。凡是真会跑它的测试文件，都要先把 home 指到临时目录，
// 免得写进真的 ~/.tau：导入 test/home.ts，或者自己设 USERPROFILE。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;

test("真会跑内置 bash 的测试文件都把 home 指到了临时目录", () => {
  const offenders: string[] = [];
  let runners = 0;
  for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".ts") || path.basename(rel) === "home.ts" || path.basename(rel) === path.basename(import.meta.filename)) continue;
    const text = readFileSync(path.join(root, rel), "utf8");
    // 模型调用 bash 工具，或者直接调用 tools/bash.ts。
    if (!/fauxToolCall\(\s*"bash"|tools\/bash\.ts/.test(text)) continue;
    runners++;
    if (!/import "(\.\.\/)*home\.ts"|USERPROFILE/.test(text)) offenders.push(rel);
  }
  assert.ok(runners >= 5, `只找到 ${runners} 个会跑 bash 的文件，规则可能失效了`);
  assert.deepEqual(offenders, []);
});
