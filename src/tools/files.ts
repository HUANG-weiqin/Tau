import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolOutput } from "../executor/executor.ts";
import { checkImages, IMAGE_MAX_BYTES, imageType } from "../images.ts";
import { IMAGE_UNSUPPORTED } from "../kernel/context.ts";
import { textContent } from "../kernel/types.ts";
import type { ToolResultContent } from "../kernel/types.ts";
import { clip, MESSAGE_MAX_BYTES } from "../kernel/derive.ts";
import { imageBlock } from "./tooldef.ts";

/** 整份读入内存的文本保护上限（32 MiB），防止把几百 MB 的构建产物或库文件一次吃进堆内存。 */
export const READ_MAX_BYTES = 32 * 1024 * 1024;
const ok = (text: string): ToolResultContent => ({ content: textContent(text), isError: false });
const fail = (text: string): ToolResultContent => ({ content: textContent(text), isError: true });
const slash = (p: string): string => p.replaceAll("\\", "/");
const q = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`; // 提示里给 bash 的路径：单引号包住，' 写成 '\''

function reason(e: unknown, file: string): string {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return `（文件不存在）。看看目录里有什么：用 bash 运行 ls ${q(path.dirname(file))}`;
  if (code === "EISDIR") return "（是目录；path 要写到文件名）";
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return `（${code}：文件被别的程序占着，或者是只读的、没有权限。换个文件名写，或者告诉用户）`;
  return `（${slash(e instanceof Error ? e.message : String(e))}）`;
}

// 必须是合法 UTF-8 且能无损还原（BOM 保留为 U+FEFF）；否则返回 undefined。
function decode(buf: Buffer): string | undefined {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : undefined;
}

// 不是 UTF-8 时按字节给能照抄的命令（D109）：带 BOM 的是 UTF-16（PowerShell 的 > 写成这样），含 NUL 的是二进制，其余多半是 GBK。edit 给转出副本、改完转回的三步，出错不动原文件。
function notUtf8(b: Buffer, f: string, edit: boolean): string {
  // 按 BOM 写明字节序：转回那一步的 iconv 写“UTF-16”在 Git Bash 里是大端，LE 文件会变成 BE。
  const enc = b[0] === 0xff && b[1] === 0xfe ? "UTF-16LE" : b[0] === 0xfe && b[1] === 0xff ? "UTF-16BE" : b.includes(0) ? "" : "GBK", u = q(`${f}.utf8`), n = q(`${f}.new`);
  return enc === "" ? `这是二进制文件，不能当文本${edit ? "编辑" : "读"}。用 bash 看类型：file ${q(f)}` : `${enc === "GBK" ? "多半是 GBK" : "这是 UTF-16 文本"}。${edit ? `要改它，用 bash 转出 UTF-8 副本：iconv -f ${enc} -t UTF-8 ${q(f)} > ${u} || rm ${u}；用 edit 改副本；再转回原文件：iconv -f UTF-8 -t ${enc} ${u} > ${n} && mv ${n} ${q(f)} && rm ${u}` : `用 bash 转码看：iconv -f ${enc} -t UTF-8 ${q(f)}${enc === "GBK" ? `；报错就是混了编码，只看 UTF-8 的部分：iconv -c -f UTF-8 -t UTF-8 ${q(f)}` : ""}`}`;
}

/**
 * 路径的“只换写法”一半（D109），spawn 的 workdir 也用它，不解析成绝对路径。
 * 不可能是真路径的错写法照做，`fixed` 为真：被 JSON 吃掉的反斜杠（后面跟着字的 \b \t \n \f \r）、首尾空白、包住整个路径的一对引号、斜杠后面又出现盘符时前面多出的部分（/d/D:/x、file:///C:/x、拼了两遍）。
 * bash 里同义的 ~、$HOME、/c/x（D91）照认，不算改过。
 */
export function rewrite(raw: string): { path: string; fixed: boolean } {
  const p = raw.replace(/[\b\t\n\f\r](?=\S)/g, (c) => `\\${"btn_fr"[c.charCodeAt(0) - 8]}`).trim().replace(/^(["'`])\s*(.+?)\s*\1$/, "$2").replace(/^.*[\\/](?=[A-Za-z]:[\\/])/, "");
  return { path: p.replace(/^(?:~|\$HOME)(?=[\\/]|$)/, slash(os.homedir())).replace(/^\/([A-Za-z])(?:\/|$)/, (_, d: string) => `${d.toUpperCase()}:/`), fixed: p !== raw };
}

/** read、write、edit 的路径：换写法、再解析成正斜杠的绝对路径（模型把反斜杠路径抄进 JSON 会出事）。/tmp 是 Git Bash 的临时目录。改过写法就带说明。 */
export function fixPath(workdir: string, raw: string): { file: string; notes: string[] } {
  const { path: p, fixed } = rewrite(raw);
  const file = slash(path.resolve(workdir, p.replace(/^\/tmp(?=\/|$)/, slash(os.tmpdir()))));
  return { file, notes: fixed ? [`路径 ${JSON.stringify(raw)} 当作 ${file}`] : [] };
}

/** read 印的行：6 位右对齐的行号、Tab、去掉 \r 的原文。edit 找不到原文时也这样印。 */
const numbered = (lines: string[], from: number): string => lines.map((l, i) => `${String(from + i).padStart(6)}\t${l.replace(/\r$/, "")}`).join("\n");

/** `notes` 收路径写法的说明，由执行器接在结果最后（`noted`）。 */
export async function read(args: { path: string; offset?: number; limit?: number }, workdir: string, accepts: boolean, notes: string[] = []): Promise<ToolOutput> {
  const fixed = fixPath(workdir, args.path), file = fixed.file;
  notes.push(...fixed.notes);
  try {
    const st = await stat(file);
    if (st.isDirectory()) return fail(`是目录，不能读取：${file}。要看里面有什么，用 bash 运行 ls -la ${q(file)}`);
    if (st.size > IMAGE_MAX_BYTES) {
      const fh = await open(file, "r");
      const head = Buffer.alloc(16);
      try {
        await fh.read(head);
      } finally {
        await fh.close();
      }
      if (imageType(head)) return fail(`图片不合格：${file}（有 ${st.size} 字节，上限 ${IMAGE_MAX_BYTES} 字节）。不缩放，重试也一样。`);
    }
    if (st.size > READ_MAX_BYTES) return fail(`文件有 ${st.size} 字节（上限 ${READ_MAX_BYTES} 字节），不能整份读取：${file}。用 bash 看其中一段：sed -n '1,200p' ${q(file)}（1,200 换成要的行号）；搜内容：grep -n '关键词' ${q(file)}`);
    const buf = await readFile(file);
    if (imageType(buf)) return image(buf, file, accepts);
    const text = decode(buf);
    if (text === undefined) return fail(`不是 UTF-8 文本：${file}。${notUtf8(buf, file, false)}`);
    const lines = text === "" ? [] : text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    if (lines.length === 0) return ok(`文件为空：${file}`);
    const offset = args.offset || 1; // 别家的 read 从 0 计，limit 0 或 -1 是不限：都照做，读出的行号写明了实际读了哪些，不加说明
    if (offset < 1) return fail(`offset 从 1 计，不能是 ${offset}：${file}。文件共 ${lines.length} 行，要看最后 ${-offset} 行，用 offset=${Math.max(1, lines.length + offset + 1)}。`);
    if (offset > lines.length) return ok(`文件共 ${lines.length} 行，offset ${offset} 超出范围：${file}`);
    const end = args.limit === undefined || args.limit < 1 ? lines.length : offset - 1 + args.limit;
    return ok(clip(numbered(lines.slice(offset - 1, end), offset), MESSAGE_MAX_BYTES - 1024)); // 给执行器接的“注：”留 1 KiB，免得 decide 再截一次、省略的字节数变错
  } catch (e) {
    return fail(`读取失败：${file}${reason(e, file)}`);
  }
}

/** 图片文件：先做入口检查（大小、类型、尺寸），不缩放。模型不收图片时照旧检查，但不存，换成一行说明。 */
function image(buf: Buffer, file: string, accepts: boolean): ToolOutput {
  try {
    const images = checkImages([buf.toString("base64")]);
    return accepts ? { content: [imageBlock(images[0]!)], isError: false, images } : ok(IMAGE_UNSUPPORTED);
  } catch (e) {
    return fail(`图片不合格：${file}（${e instanceof Error ? e.message : String(e)}）。不缩放，重试也一样。`);
  }
}

export async function write(args: { path: string; content: string }, workdir: string, notes: string[] = []): Promise<ToolResultContent> {
  const fixed = fixPath(workdir, args.path), file = fixed.file;
  notes.push(...fixed.notes);
  if (/[<>:"|?*]|[. ](?:\/|$)/.test(file.slice(2))) return fail(`写入失败：${file}（Windows 的文件名不能含 < > : " | ? *，也不能以点或空格结尾；冒号后面的内容会写进看不见的数据流）。换掉这些字符再写，例如冒号换成 -。`);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, args.content, "utf8");
    return ok(`已写入 ${Buffer.byteLength(args.content, "utf8")} 字节：${file}`);
  } catch (e) {
    return fail(`写入失败：${file}${reason(e, file)}`);
  }
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[ \\t]*(?:\\r?\\n|$)"; // 行尾空白加换行，或者文件末尾

/** old 照抄了 read 印的行、原样又找不到：去掉行号（连续、不超过文件行数，空行可以只剩行号或什么都不剩），new 里 read 样子的前缀也去掉。 */
function unnumber(text: string, old: string, neu: string): { old: string; neu: string; note?: string } {
  const first = Number(/^(?=[ \d]{6}\t) *(\d+)\t/.exec(old)?.[1]), p = (i: number) => `${String(first + i).padStart(6)}\t`;
  const lines = old.split(/\r?\n/).map((l, i) => (l.startsWith(p(i)) ? l.slice(p(i).length) : l === "" || `${l}\t` === p(i) ? "" : undefined));
  if (!(first > 0) || lines.includes(undefined) || first + lines.length - 1 > text.split("\n").length || !/\S/.test(lines.join(""))) return { old, neu };
  if (text.replaceAll("\r\n", "\n").includes(old.replaceAll("\r\n", "\n"))) return { old, neu };
  // new 的前缀要正好是 read 的样子（6 位右对齐，接 Tab 或行尾）：以空格开头、接 Tab 的都去；其余（6 位数、只剩行号）要在这次的行号附近。
  const end = first + lines.length + neu.split("\n").length;
  const strip = (m: string, d: string, t: string) => (String(+d).padStart(6) + t === m && ((t && m[0] === " ") || (+d >= first && +d < end)) ? "" : m);
  return { old: lines.join("\n"), neu: neu.replace(/^ *(\d+)(\t|$)/gm, strip), note: "old 每行开头带着 read 加的行号，已去掉，new 里有的也去掉了" };
}

/** 找不到原文：用 old 里最长、文件里只有一行含有它的一行定位（写错的行号先去掉），印出那一段（read 的格式），点出第一处缩进不同（第 0 行可能只抄了半行，它自己带缩进才比）。 */
function notFound(text: string, old: string, file: string): string {
  const want = old.split(/\r?\n/).map((l) => l.replace(/^ *\d+[\t→]/, "")), lines = text.split(/\r?\n/), lead = (s = "") => JSON.stringify(/^[ \t]*/.exec(s)![0]);
  const once = (s: string) => s !== "" && lines.filter((l) => l.includes(s)).length === 1;
  const j = [...want.keys()].sort((a, b) => want[b]!.trim().length - want[a]!.trim().length).slice(0, 3).find((i) => once(want[i]!.trim()));
  if (j === undefined) return `没找到原文：${file}。old 里最长的几行，在文件里要么没有，要么不止一处：文件可能改过，或者不是这个文件。先 read，再照抄要改的那几行，多带一两行只出现一次的上下文。`;
  const from = Math.max(0, lines.findIndex((l) => l.includes(want[j]!.trim())) - j), got = lines.slice(from, from + want.length);
  const d = got.findIndex((l, i) => (i > 0 || /^\s/.test(want[0]!)) && l !== want[i] && l.trimStart() === want[i]?.trimStart());
  const indent = d < 0 ? "" : `，第 ${from + d + 1} 行缩进不同：文件里是 ${lead(got[d])}，old 里是 ${lead(want[d])}`;
  return `没找到原文：${file}。最像的是第 ${from + 1}${got.length > 1 ? ` 到 ${from + got.length}` : ""} 行${indent}。文件里这几行是（可以连行号整段复制进 old，行号会被去掉）：\n${numbered(got, from + 1)}`;
}

/** 在 text 里找 old 换成 new；找不到返回 undefined。依次找：逐字；换行写成 \r\n 再逐字；不计行尾的空格和 Tab（用正则：old 只剩空白时不试，上千行时 V8 建不出就当没找到）。 */
async function replaceOnce(file: string, text: string, o: string, n: string, all: boolean | undefined, notes: string[]): Promise<ToolResultContent | undefined> {
  const u = unnumber(text, o, n), old = u.old, neu = u.neu;
  const lines = old.split(/\r?\n/), lf = lines.join("\n"), eol = text.includes("\r\n") ? "\r\n" : "\n";
  const loose = lines.map((l) => esc(l.replace(/[ \t]+$/, ""))).join(SEP) + (/[ \t]$/.test(lines.at(-1)!) ? `[ \\t]*(?=${SEP})` : "");
  // new 里和 old 某行一模一样的（没改的行）写回文件里原来那一行，行尾空白不丢；换行跟文件走。
  const fill = (m: string): string => {
    const was = m.split(/\r?\n/), keep = new Map(lines.map((l, i) => [l, was[i]!]));
    return neu.split(/\r?\n/).map((l) => keep.get(l) ?? l).join(eol);
  };
  for (const [k, p] of [lf, lf.replaceAll("\n", "\r\n"), loose].entries()) {
    const at: number[] = [];
    let out = text;
    try {
      if (k < 2 || /\S/.test(lf)) out = text.replaceAll(k < 2 ? p : new RegExp(p, "g"), (m: string, i: number) => (at.push(i), fill(m)));
    } catch {}
    if (at.length === 0) continue;
    const where = () => [...new Set(at.slice(0, 5).map((i) => text.slice(0, i).split("\n").length))].join("、") + (at.length > 5 ? "…" : "");
    if (at.length > 1 && !all) return fail(`原文出现 ${at.length} 次（在第 ${where()} 行），必须唯一：${file}。只改一处：old 多带上下一两行；全部都改：加 "replaceAll": true。`);
    if (out === text && old === neu) return fail(`替换以后文件一模一样，没有写：${file}。new 要写改好以后的文字，不能和 old 一样。`);
    if (out !== text) await writeFile(file, out, "utf8");
    if (u.note) notes.push(u.note);
    if (k === 2) notes.push("old 和文件的行尾空白不一样，按不计行尾空白找到了原文");
    return ok(out === text ? `文件已经是 new 的样子，没有改动：${file}` : `已替换 ${at.length} 处：${file}`);
  }
  return undefined;
}

export async function edit(args: { path: string; old: string; new: string; replaceAll?: boolean }, workdir: string, notes: string[] = []): Promise<ToolResultContent> {
  const fixed = fixPath(workdir, args.path), file = fixed.file;
  notes.push(...fixed.notes);
  // old 为空：文件不存在或是空的，按新建写（Claude Code、Aider 的习惯）。stat 不出来的交给 write，它会报自己的错。
  const size = args.old === "" ? await stat(file).then((s) => s.size, () => 0) : -1;
  if (size === 0) return notes.push("old 是空的，文件原来不存在或者是空的，按新建写入"), write({ path: file, content: args.new }, workdir, notes);
  if (size > 0) return fail(`old 是空的，可这个文件已经有 ${size} 字节：${file}。先 read 看内容；要改其中一段，old 写那一段；要插入，old 写插入点那一行，new 写这一行加上新内容；确实要整个换掉，读过以后再用 write。`);
  try {
    const buf = await readFile(file), text = decode(buf);
    if (text === undefined) return fail(`不是 UTF-8 文本，不能编辑：${file}。${notUtf8(buf, file, true)}`);
    // 原样找不到时：old、new 末尾都有同一行“注：…”，是抄结果时连执行器接的说明一起抄来的，去掉再找一遍。两行不一样就不去：那是模型自己写的，去掉会改到别处。
    const tail = (s: string): string | undefined => /\r?\n(注：[^\n]*)$/.exec(s)?.[1];
    const cut = (s: string): string => s.replace(/\r?\n注：[^\n]*$/, "");
    const same = tail(args.old) !== undefined && tail(args.old) === tail(args.new);
    const tries = same ? [[args.old, args.new], [cut(args.old), cut(args.new)]] : [[args.old, args.new]];
    for (const [o, n] of tries) {
      const r = await replaceOnce(file, text, o!, n!, args.replaceAll, notes);
      if (r) return same && o !== args.old && !r.isError ? (notes.push("old、new 末尾都有同一行“注：…”，当作从结果里抄来的，已去掉再找"), r) : r;
    }
    return fail(notFound(text, tries.at(-1)![0]!, file));
  } catch (e) {
    return fail(`编辑失败：${file}${reason(e, file)}`);
  }
}
