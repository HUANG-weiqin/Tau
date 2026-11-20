import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolOutput } from "../executor/executor.ts";
import { checkImages, imageType } from "../images.ts";
import { IMAGE_UNSUPPORTED } from "../kernel/context.ts";
import { textContent } from "../kernel/types.ts";
import type { ToolResultContent } from "../kernel/types.ts";
import { clip } from "../kernel/derive.ts";
import { imageBlock } from "./tooldef.ts";

const ok = (text: string): ToolResultContent => ({ content: textContent(text), isError: false });
const fail = (text: string): ToolResultContent => ({ content: textContent(text), isError: true });

function reason(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return "文件不存在";
  if (code === "EISDIR") return "是目录";
  return e instanceof Error ? e.message : String(e);
}

// 必须是合法 UTF-8 且能无损还原（BOM 保留为 U+FEFF）；否则返回 undefined。
function decode(buf: Buffer): string | undefined {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : undefined;
}

// Git Bash 的 /c/Users/x 写法：模型在 bash 里用惯了，read、write、edit 也会这样写。
// path.resolve 会把它当成当前盘根下的 \c\Users\x，悄悄读写到别处，所以先换成 C:/Users/x。
const MSYS_DRIVE = /^\/([a-zA-Z])(?:\/|$)/;
const resolvePath = (workdir: string, p: string): string => path.resolve(workdir, p.replace(MSYS_DRIVE, (_, d: string) => `${d.toUpperCase()}:/`));

export async function read(args: { path: string; offset?: number; limit?: number }, workdir: string, accepts: boolean): Promise<ToolOutput> {
  const file = resolvePath(workdir, args.path);
  try {
    if ((await stat(file)).isDirectory()) return fail(`是目录，不能读取：${file}`);
    const buf = await readFile(file);
    if (imageType(buf)) return image(buf, file, accepts);
    const text = decode(buf);
    if (text === undefined) return fail(`不是 UTF-8 文本：${file}`);
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
    return ok(clip(out.join("\n")));
  } catch (e) {
    return fail(`读取失败：${file}（${reason(e)}）`);
  }
}

/** 图片文件：先做入口检查（大小、类型、尺寸），不缩放。模型不收图片时照旧检查，但不存，换成一行说明。 */
function image(buf: Buffer, file: string, accepts: boolean): ToolOutput {
  try {
    const images = checkImages([buf.toString("base64")]);
    return accepts ? { content: [imageBlock(images[0]!)], isError: false, images } : ok(IMAGE_UNSUPPORTED);
  } catch (e) {
    return fail(`图片不合格：${file}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

export async function write(args: { path: string; content: string }, workdir: string): Promise<ToolResultContent> {
  const file = resolvePath(workdir, args.path);
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
  const file = resolvePath(workdir, args.path);
  if (args.old === "") return fail(`原文不能为空：${file}`);
  try {
    const text = decode(await readFile(file));
    if (text === undefined) return fail(`不是 UTF-8 文本，不能编辑：${file}`);
    // 模型看到的行不含 \r。CRLF 文件里：多行原文换成 \r\n 再匹配，新文本的 \n 也换成 \r\n。
    const crlf = text.includes("\r\n") && !args.old.includes("\r");
    let parts = text.split(args.old);
    if (parts.length === 1 && crlf) parts = text.split(args.old.replaceAll("\n", "\r\n"));
    const count = parts.length - 1;
    if (count === 0) return fail(`没找到原文：${file}`);
    if (count > 1 && !args.replaceAll) return fail(`原文出现 ${count} 次，必须唯一，或改用 replaceAll：${file}`);
    const repl = crlf ? args.new.replace(/(?<!\r)\n/g, "\r\n") : args.new;
    await writeFile(file, parts.join(repl), "utf8");
    return ok(`已替换 ${count} 处：${file}`);
  } catch (e) {
    return fail(`编辑失败：${file}（${reason(e)}）`);
  }
}
