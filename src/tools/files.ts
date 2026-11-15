import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolResultContent } from "../kernel/types.ts";

const ok = (text: string): ToolResultContent => ({ text, isError: false });
const fail = (text: string): ToolResultContent => ({ text, isError: true });

function reason(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return "文件不存在";
  if (code === "EISDIR") return "是目录";
  return e instanceof Error ? e.message : String(e);
}

export async function read(args: { path: string; offset?: number; limit?: number }, workdir: string): Promise<ToolResultContent> {
  const file = path.resolve(workdir, args.path);
  try {
    if ((await stat(file)).isDirectory()) return fail(`是目录，不能读取：${file}`);
    const text = await readFile(file, "utf8");
    const lines = text === "" ? [] : text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    if (lines.length === 0) return ok(`文件为空：${file}`);
    const offset = args.offset ?? 1;
    if (offset < 1 || (args.limit !== undefined && args.limit < 1)) return fail(`offset 和 limit 必须从 1 开始：${file}`);
    if (offset > lines.length) return ok(`文件共 ${lines.length} 行，offset ${offset} 超出范围：${file}`);
    const end = args.limit === undefined ? lines.length : offset - 1 + args.limit;
    const out = lines
      .slice(offset - 1, end)
      .map((line, i) => `${String(offset + i).padStart(6)}\t${line.replace(/\r$/, "")}`);
    return ok(out.join("\n"));
  } catch (e) {
    return fail(`读取失败：${file}（${reason(e)}）`);
  }
}

export async function write(args: { path: string; content: string }, workdir: string): Promise<ToolResultContent> {
  const file = path.resolve(workdir, args.path);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, args.content, "utf8");
    return ok(`已写入 ${Buffer.byteLength(args.content, "utf8")} 字节：${file}`);
  } catch (e) {
    return fail(`写入失败：${file}（${reason(e)}）`);
  }
}

export async function edit(
  args: { path: string; old: string; new: string; replaceAll?: boolean },
  workdir: string,
): Promise<ToolResultContent> {
  const file = path.resolve(workdir, args.path);
  if (args.old === "") return fail(`原文不能为空：${file}`);
  try {
    const text = await readFile(file, "utf8");
    const parts = text.split(args.old);
    const count = parts.length - 1;
    if (count === 0) return fail(`没找到原文：${file}`);
    if (count > 1 && !args.replaceAll) return fail(`原文出现 ${count} 次，必须唯一，或改用 replaceAll：${file}`);
    await writeFile(file, parts.join(args.new), "utf8");
    return ok(`已替换 ${count} 处：${file}`);
  } catch (e) {
    return fail(`编辑失败：${file}（${reason(e)}）`);
  }
}
