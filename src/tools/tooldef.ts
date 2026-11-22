// 运行工具定义（设计稿 5.5，见 .knowledge/kb-tools.md）：用 bash 的整套机制运行 `command`，参数的 JSON 走标准输入。
import { readFile, stat } from "node:fs/promises";
import type { ToolOutput } from "../executor/executor.ts";
import { checkImages, IMAGE_MAX_BYTES } from "../images.ts";
import type { Image } from "../images.ts";
import { IMAGE_UNSUPPORTED } from "../kernel/context.ts";
import { IMAGES_PER_MESSAGE } from "../kernel/derive.ts";
import { textContent } from "../kernel/types.ts";
import type { Content, DeclaredCall, ToolDef, ToolResultContent } from "../kernel/types.ts";
import { BLOB_PREFIX } from "../store/blobs.ts";
import { runCommand } from "./bash.ts";
import type { BashContext } from "./bash.ts";

/** 一条结果最多声明这么多个库内动作。 */
export const CALLS_PER_RESULT = 8;

/** `accepts`：进程的模型收图片。不收时，图片照样检查，但不存，每张换成一行说明，和信一样。 */
export async function runToolDef(def: ToolDef, args: unknown, workdir: string, signal: AbortSignal, ctx: BashContext, accepts: boolean): Promise<ToolOutput> {
  const split = def.output === "content";
  const run = await runCommand({ command: def.command, seconds: def.timeout, stdin: JSON.stringify(args), split }, workdir, signal, ctx);
  if (!split || run.result.isError || !run.stdout) return run.result;
  return fromContentOutput(run.stdout, accepts);
}

const invalid = (why: string): ToolResultContent => ({ content: textContent(`content 输出不合法：${why}`), isError: true });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 只认盘符路径和 UNC 路径，和预设的 workdir 一样：msys 的 /tmp/x.png 会落在服务当前盘符下。
const isWindowsAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);

type Item = { type: "text"; text: string } | { type: "image"; path: string } | { type: "call"; call: DeclaredCall };

/** 退出码 0 时的标准输出：先解析 JSON，查每一项的格式、声明的个数和图片张数，再读图片文件（先看大小）。 */
async function fromContentOutput(stdout: { text: string; truncated: boolean }, accepts: boolean): Promise<ToolOutput> {
  if (stdout.truncated) return invalid("标准输出超过上限，被截断了");
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.text);
  } catch (e) {
    return invalid(`不是合法的 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!Array.isArray(raw)) return invalid("必须是 JSON 数组");
  const items: Item[] = [];
  for (const [i, v] of raw.entries()) {
    const o = isObject(v) ? v : {};
    if (o.type === "text" && typeof o.text === "string") items.push({ type: "text", text: o.text });
    else if (o.type === "image" && typeof o.path === "string") items.push({ type: "image", path: o.path });
    else if (o.type === "call" && typeof o.name === "string" && (o.arguments === undefined || isObject(o.arguments))) items.push({ type: "call", call: { name: o.name, arguments: o.arguments ?? {} } });
    else return invalid(`第 ${i + 1} 项的格式不对，只能是 { "type": "text", "text": 字符串 }、{ "type": "image", "path": 字符串 } 或 { "type": "call", "name": 字符串, "arguments": 对象（可省略） }`);
  }
  const calls = items.flatMap((it) => (it.type === "call" ? [it.call] : []));
  if (calls.length > CALLS_PER_RESULT) return invalid(`有 ${calls.length} 个 call，最多 ${CALLS_PER_RESULT} 个`);
  const paths = items.flatMap((it) => (it.type === "image" ? [it.path] : []));
  if (paths.length > IMAGES_PER_MESSAGE) return invalid(`有 ${paths.length} 张图片，最多 ${IMAGES_PER_MESSAGE} 张`);
  const bad = paths.find((p) => !isWindowsAbsolute(p));
  if (bad !== undefined) return invalid(`图片的 path 必须是 Windows 的绝对路径（盘符开头或 UNC）：${bad}`);
  let images: Image[];
  try {
    images = checkImages((await Promise.all(paths.map(readImage))).map((b) => b.toString("base64")));
  } catch (e) {
    return invalid(e instanceof Error ? e.message : String(e));
  }
  const declared = calls.length > 0 ? { calls } : {};
  if (!accepts) return { content: lines(items.flatMap((it) => (it.type === "text" ? [it.text] : it.type === "image" ? [IMAGE_UNSUPPORTED] : []))), isError: false, ...declared };
  const text = items.flatMap((it) => (it.type === "text" ? [it.text] : [])).join("\n");
  return { content: [...(text === "" ? [] : textContent(text)), ...images.map(imageBlock)], isError: false, ...(images.length > 0 ? { images } : {}), ...declared };
}

/** 图片内容块：`data` 是 `blob:<hash>` 引用，字节由执行器存进 `blobs`。 */
export const imageBlock = (im: Image): Content => ({ type: "image", data: BLOB_PREFIX + im.hash, mimeType: im.mimeType });

const lines = (parts: string[]): Content[] => (parts.join("\n") === "" ? [] : textContent(parts.join("\n")));

/** 读一个图片文件。读之前先看大小：超过上限就不读。 */
async function readImage(path: string): Promise<Buffer> {
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("不是文件");
    if (s.size > IMAGE_MAX_BYTES) throw new Error(`有 ${s.size} 字节，上限 ${IMAGE_MAX_BYTES} 字节，没有读取`);
    return await readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`图片文件读不出：${path}（${code === "ENOENT" ? "文件不存在" : e instanceof Error ? e.message : String(e)}）`);
  }
}
