// src/kernel/ 只导入 kernel 内部的文件，外部类型只能 import type；纯函数不碰时钟、随机数和 I/O。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const kernel = resolve(import.meta.dirname, "..", "src", "kernel");

function kernelFiles(): string[] {
  if (!existsSync(kernel)) return [];
  return readdirSync(kernel, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const STATIC = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;
const FORBIDDEN = [/\bimport\s*\(/, /\brequire\s*\(/, /\bawait\b/, /\bDate\b/, /\bMath\.random\b/, /\bprocess\./, /\bglobalThis\b/, /\bset(Timeout|Interval|Immediate)\b/];

export function violations(file: string, src: string): string[] {
  const out: string[] = [];
  const code = stripComments(src);
  for (const m of code.matchAll(STATIC)) {
    const [, , typeOnly, spec] = m;
    if (typeOnly || spec === undefined) continue;
    const inside = (spec.startsWith("./") || spec.startsWith("../")) && !relative(kernel, resolve(dirname(file), spec)).startsWith("..");
    if (!inside) out.push(`导入了 kernel 外部：${spec}`);
  }
  for (const re of FORBIDDEN) if (re.test(code)) out.push(`禁止的用法：${re.source}`);
  return out;
}

test("kernel 只导入 kernel 内部的文件，外部只能 import type", () => {
  const bad = kernelFiles().flatMap((f) => violations(f, readFileSync(f, "utf8")).map((v) => `${relative(kernel, f)}: ${v}`));
  assert.deepEqual(bad, []);
});

test("扫描能发现违规", () => {
  const f = join(kernel, "x.ts");
  assert.equal(violations(f, `import { readFileSync } from "node:fs";`).length, 1);
  assert.equal(violations(f, `import {\n  a,\n} from "../store/db.ts";`).length, 1);
  assert.equal(violations(f, `import { type A } from "@earendil-works/pi-ai";`).length, 1);
  assert.equal(violations(f, `export { x } from "node:path";`).length, 1);
  assert.equal(violations(f, `const t = Date.now();`).length, 1);
  assert.deepEqual(violations(f, `import type { A } from "@earendil-works/pi-ai";\nimport { b } from "./b.ts";\nexport type { C } from "./c.ts";`), []);
});
