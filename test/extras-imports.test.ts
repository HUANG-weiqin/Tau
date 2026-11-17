// extras/ 不导入仓库里 extras/ 之外的文件，见 .knowledge/kb-extras.md#依赖规则
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const extras = join(root, "extras");
const EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;

function extrasFiles(): string[] {
  if (!existsSync(extras)) return [];
  return readdirSync(extras, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && EXT.test(e.name) && !e.parentPath.split(/[\\/]/).includes("node_modules"))
    .map((e) => join(e.parentPath, e.name));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;,(){}[\]])\/\/.*$/gm, "$1");
}

const STATIC = /\b(?:import|export)\b\s*(?:type\b\s*)?(?:[^'"`;]*?\bfrom\s*)?["'`]([^"'`]+)["'`]/g;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function outside(file: string, rawSpec: string): boolean {
  // Windows 把反斜杠开头的 `..` 也当相对路径
  const spec = rawSpec.replace(/[\\]+/g, "/");
  let target: string;
  if (spec.startsWith("file:")) {
    try {
      target = fileURLToPath(spec);
    } catch {
      return false;
    }
  } else if (spec.startsWith("./") || spec.startsWith("../") || isAbsolute(spec)) {
    target = resolve(dirname(file), spec);
  } else {
    return false;
  }
  const inRepo = !relative(root, target).startsWith("..") && !isAbsolute(relative(root, target));
  const inExtras = !relative(extras, target).startsWith("..") && !isAbsolute(relative(extras, target));
  return inRepo && !inExtras;
}

export function violations(file: string, src: string): string[] {
  const code = stripComments(src);
  const specs = [...code.matchAll(STATIC), ...code.matchAll(DYNAMIC)].map((m) => m[1]);
  return specs.filter((s): s is string => s !== undefined && outside(file, s)).map((s) => `导入了 extras/ 外部的仓库文件：${s}`);
}

test("extras/ 不导入仓库里 extras/ 之外的文件", () => {
  const bad = extrasFiles().flatMap((f) => violations(f, readFileSync(f, "utf8")).map((v) => `${relative(extras, f)}: ${v}`));
  assert.deepEqual(bad, []);
});

test("扫描跳过 node_modules", () => {
  assert.equal(extrasFiles().some((f) => f.split(/[\\/]/).includes("node_modules")), false);
});

test("扫描能发现违规", () => {
  const f = join(extras, "notes", "notes.mjs");
  const src = join(root, "src", "protocol.ts").replaceAll("\\", "/");
  // 违规
  assert.equal(violations(f, `import { x } from "../../src/protocol.ts";`).length, 1);
  assert.equal(violations(f, `import {\n  a,\n} from "../../test/helper.ts";`).length, 1);
  assert.equal(violations(f, `import type { A } from "../../src/kernel/types.ts";`).length, 1);
  assert.equal(violations(f, `export { x } from "../../src/x.ts";`).length, 1);
  assert.equal(violations(f, `import "../../src/side.ts";`).length, 1);
  assert.equal(violations(f, `const m = await import("../../src/x.ts");`).length, 1);
  assert.equal(violations(f, `const m = require("../../src/x.js");`).length, 1);
  assert.equal(violations(f, `import { x } from "${src}";`).length, 1);
  assert.equal(violations(f, `import { x } from "${pathToFileHref(src)}";`).length, 1);
  assert.equal(violations(f, `import { x } from "../../package.json";`).length, 1);
  assert.equal(violations(f, `import{x}from"../../src/protocol.ts";`).length, 1);
  assert.equal(violations(f, `import"../../src/side.ts";`).length, 1);
  assert.equal(violations(f, `import a from "./a.ts"; import b from "../../src/b.ts";`).length, 1);
  assert.equal(violations(f, "const m = await import(`../../src/x.ts`);").length, 1);
  assert.equal(violations(f, `const m = require("..\\..\\src\\x.cjs");`).length, 1);
  assert.equal(violations(f, `import x from '..\\..\\src\\x.ts';`).length, 1);
  // 不违规
  assert.deepEqual(violations(f, `import { readFileSync } from "node:fs";\nimport fs from "fs";`), []);
  assert.deepEqual(violations(f, `import { a } from "./a.ts";\nimport { b } from "../shared/b.ts";\nexport { c } from "./c.ts";`), []);
  assert.deepEqual(violations(f, `const m = await import("./x.mjs");\nconst r = require("./y.cjs");`), []);
  assert.deepEqual(violations(f, `import x from "left-pad";\nimport y from "@scope/pkg";\nconst z = require("lodash");`), []);
  assert.deepEqual(violations(f, `import { x } from "${join(extras, "a.ts").replaceAll("\\", "/")}";`), []);
  assert.deepEqual(violations(f, `import { x } from "${pathToFileHref(join(extras, "a.ts"))}";`), []);
  assert.deepEqual(violations(f, `import { x } from "/somewhere/else/outside-repo.ts";`), []);
  assert.deepEqual(violations(f, `// import { x } from "../../src/x.ts";\n/* require("../../src/y.ts") */`), []);
});

function pathToFileHref(p: string): string {
  return "file:///" + p.replaceAll("\\", "/");
}
