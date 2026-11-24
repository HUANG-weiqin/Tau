// 统计 src/ 中不含测试的非空行数，对照 AGENTS.md 的代码量预算。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUDGET = 4280;
const root = join(import.meta.dirname, "..", "src");

let total = 0;
const rows: [string, number][] = [];
for (const entry of existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : []) {
  if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
  const path = join(entry.parentPath, entry.name);
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  rows.push([path.slice(root.length + 1).replaceAll("\\", "/"), lines]);
  total += lines;
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
for (const [path, lines] of rows) console.log(`${String(lines).padStart(6)}  ${path}`);
console.log(`${String(total).padStart(6)}  合计（预算 ${BUDGET}）`);
if (total > BUDGET) process.exitCode = 1;
