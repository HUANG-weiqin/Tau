// 调用一个 MCP 工具：工具定义的命令是 `node call.ts <server> <tool>`（kb-extras 的“MCP 中转”）。
// 它先把请求转发给中转进程，连不上就拉起中转再重试；回复按 `output: content` 的格式写到标准输出。
// 拉起中转是关键：中间隔一层 cmd 的 start，让中转的父进程立刻消失，内核按进程树结束命令时找不到它。
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ConnectError, talk } from "../tools/client.ts";
import { loadServer } from "./config.ts";

/** 一张图片的原始字节上限，和内核的入口条件一样。 */
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/** 宽和高的像素上限，和内核的入口条件一样。 */
const IMAGE_MAX_EDGE = 2000;
/** 一次结果里最多放几张图；多的改成一行文字。 */
const IMAGES_MAX = 2;
/** 存成文件的 MCP 图片保留这么久（7 天），和内核 bash 输出文件、history_dump 一致。 */
export const IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 标准输出最多这么多字节（结尾的换行也算）。内核的上限约 32 KiB，超了整份不合法。 */
const OUT_MAX_BYTES = 30 * 1024 - 2;
/** 等中转连上的上限。 */
const CONNECT_MS = 60_000;

/** 给模型看的错误：消息原样写到标准错误，退出码 1。 */
class Fail extends Error {}

type ImageKind = "png" | "jpeg" | "gif" | "webp";
type ContentItem = { type: "text"; text: string } | { type: "image"; path: string };

const EXT: Record<ImageKind, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

/** 中转的管道名。测试用 `TAU_MCP_PIPE` 换成临时管道。 */
const pipeName = (): string => process.env["TAU_MCP_PIPE"] || "\\\\.\\pipe\\tau-mcp";

const dataDir = (...parts: string[]): string => path.join(homedir(), ".tau", "extras", "mcp", ...parts);

function tryGet<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** 删 `root` 下修改时间超过 `IMAGE_KEEP_MS` 的图片文件，删空了的进程目录也删（`keep` 除外）。单步失败跳过，不影响工具调用。 */
export function pruneOldImages(root: string, now: number, keep?: string): number {
  let gone = 0;
  for (const name of tryGet(() => readdirSync(root)) ?? []) {
    const dir = path.join(root, name);
    for (const f of tryGet(() => (statSync(dir).isDirectory() ? readdirSync(dir) : [])) ?? []) {
      const p = path.join(dir, f);
      if (!(tryGet(() => statSync(p).isFile() && now - statSync(p).mtimeMs > IMAGE_KEEP_MS) ?? false)) continue;
      if (tryGet(() => { unlinkSync(p); return true; }) === true) gone++;
    }
    if (dir !== keep) tryGet(() => (readdirSync(dir).length === 0 ? rmdirSync(dir) : undefined));
  }
  return gone;
}

/** 给模型看的路径：Windows 的反斜杠写法。 */
const winPath = (p: string): string => path.resolve(p).replace(/\//g, "\\");

/** 按文件头的魔数判断类型。 */
function imageKind(b: Buffer): ImageKind | null {
  const head = (n: number): string => b.toString("latin1", 0, n);
  if (head(8) === "\x89PNG\r\n\x1a\n") return "png";
  if (head(3) === "\xff\xd8\xff") return "jpeg";
  if (head(6) === "GIF87a" || head(6) === "GIF89a") return "gif";
  if (head(4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** 从文件头读宽和高：png、jpeg、gif、webp。头残缺、不认识时返回 null。 */
function imageSize(b: Buffer, kind: ImageKind): { width: number; height: number } | null {
  try {
    switch (kind) {
      case "png":
        return b.toString("latin1", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
      case "gif":
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "webp": {
        const chunk = b.toString("latin1", 12, 16);
        if (chunk === "VP8 ") return b.toString("latin1", 23, 26) === "\x9d\x01\x2a" ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : null;
        if (chunk === "VP8L") {
          if (b[20] !== 0x2f) return null;
          const bits = b.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
        return null;
      }
      case "jpeg": {
        // 从头逐段跳过标记段（APPn、EXIF 等），找 SOFn，包括渐进式的 SOF2。
        let i = 2;
        while (i + 4 <= b.length) {
          if (b[i] !== 0xff) return null;
          const m = b[i + 1]!;
          if (m === 0xff) i++;
          else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2;
          else if (m === 0xd9 || m === 0xda) return null;
          else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
          else {
            const len = b.readUInt16BE(i + 2);
            if (len < 2) return null;
            i += 2 + len;
          }
        }
        return null;
      }
    }
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

const sizeOf = (items: ContentItem[]): number => bytesOf(JSON.stringify(items));

/** 按 UTF-8 字节切一段文本，边界上切开的字符丢掉。 */
function sliceBytes(text: string, max: number): string {
  const b = Buffer.from(text, "utf8");
  return b.length <= max ? text : b.subarray(0, max).toString("utf8").replace(/�+$/, "");
}

/** 按原顺序留前 `keep` 个字节的文本，在切到的那一项末尾加说明。 */
function keepTexts(texts: { type: "text"; text: string }[], keep: number, note: string): ContentItem[] {
  const out: ContentItem[] = [];
  let left = keep;
  let cut = false;
  for (const t of texts) {
    if (left <= 0) {
      cut = true;
      break;
    }
    const bytes = bytesOf(t.text);
    if (bytes <= left) {
      out.push({ type: "text", text: t.text });
      left -= bytes;
    } else {
      out.push({ type: "text", text: sliceBytes(t.text, left) + note });
      left = 0;
      cut = true;
      break;
    }
  }
  if (cut && out.length === 0) out.push({ type: "text", text: note.trimStart() });
  return out;
}

/** 把一段 MCP 结果转成 `output: content` 的内容块，并且保证标准输出不超过上限。
 *  留多少文本按 `JSON.stringify` 以后的大小算：换行、引号转义以后会变大，按原始字节算会超。 */
function fit(items: ContentItem[]): ContentItem[] {
  if (sizeOf(items) <= OUT_MAX_BYTES) return items;
  const images = items.filter((i): i is { type: "image"; path: string } => i.type === "image");
  const texts = items.filter((i): i is { type: "text"; text: string } => i.type === "text");
  const note = "\n…（结果太长，已截断）";
  const total = texts.reduce((n, t) => n + bytesOf(t.text), 0);
  // 二分：装得下就多留一点。
  let lo = 0;
  let hi = total;
  let best: ContentItem[] | null = null;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const candidate = [...keepTexts(texts, keep, note), ...images];
    if (sizeOf(candidate) <= OUT_MAX_BYTES) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  if (best !== null) return best;
  // 真装不下（只有图片项却太多之类）：整份换成一行说明。
  return [{ type: "text", text: `MCP 结果太长（${sizeOf(items)} 字节），已全部省略。` }];
}

/** 把一张 MCP 图片写成文件，返回给模型的路径。 */
function saveImage(proc: string, index: number, data: string, mimeType: unknown): { file: string; text: string } | { text: string } {
  const dir = dataDir("images", proc);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(data, "base64");
  const kind = imageKind(bytes);
  const ext = kind === null ? (typeof mimeType === "string" && /^image\/[a-z]+$/.test(mimeType) ? mimeType.slice(6) : "bin") : EXT[kind];
  const file = path.join(dir, `${Date.now()}-${index}.${ext}`);
  writeFileSync(file, bytes);
  const at = winPath(file);
  if (kind === null) return { text: `[第 ${index} 张图片的类型不认识，没有放进结果（只收 png、jpeg、gif、webp）。已存成 ${at}]` };
  if (bytes.length > IMAGE_MAX_BYTES) return { text: `[第 ${index} 张图片有 ${bytes.length} 字节，超过 1.5 MiB，没有放进结果。已存成 ${at}]` };
  const size = imageSize(bytes, kind);
  if (size === null || size.width < 1 || size.height < 1) return { text: `[第 ${index} 张图片的文件头读不出尺寸，没有放进结果。已存成 ${at}]` };
  if (size.width > IMAGE_MAX_EDGE || size.height > IMAGE_MAX_EDGE) {
    return { text: `[第 ${index} 张图片是 ${size.width}×${size.height}，宽和高都不能超过 ${IMAGE_MAX_EDGE} 像素，没有放进结果。已存成 ${at}]` };
  }
  if (index > IMAGES_MAX) return { text: `[第 ${index} 张图片：一次结果最多放 ${IMAGES_MAX} 张，已存成 ${at}]` };
  return { file, text: "" };
}

/** 一行说明：MCP 结果里转不了的类型（resource、audio 等）。 */
function describe(item: Record<string, unknown>): string {
  const kind = typeof item["type"] === "string" ? item["type"] : "不认识";
  const r = item["resource"];
  const uri = typeof r === "object" && r !== null && typeof (r as Record<string, unknown>)["uri"] === "string" ? String((r as Record<string, unknown>)["uri"]) : undefined;
  const what = uri !== undefined ? `：${uri}` : `：${JSON.stringify(item).slice(0, 300)}`;
  return `[MCP 结果里有一项 ${kind}，没有转成内容${what}]`;
}

const textOf = (item: Record<string, unknown>): string => (typeof item["text"] === "string" ? item["text"] : JSON.stringify(item));

/** MCP 的 content 转成 `output: content` 的项。`restarted` 时开头加一行说明。 */
function toItems(proc: string, content: unknown[], restarted: boolean): ContentItem[] {
  const items: ContentItem[] = [];
  if (restarted) items.push({ type: "text", text: "服务器重启过，之前的状态没了。" });
  let images = 0;
  for (const raw of content) {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (item["type"] === "text") {
      items.push({ type: "text", text: textOf(item) });
    } else if (item["type"] === "image" && typeof item["data"] === "string") {
      images++;
      // 服务器那边动作已经做完：存图失败只少这一张图，不让整次调用失败（模型会重做有副作用的动作）。
      let saved: { file: string; text: string } | { text: string };
      try {
        saved = saveImage(proc, images, item["data"], item["mimeType"]);
      } catch (e) {
        saved = { text: `[第 ${images} 张图片没存下：${e instanceof Error ? e.message : String(e)}]` };
      }
      if ("file" in saved) items.push({ type: "image", path: winPath(saved.file) });
      else items.push({ type: "text", text: saved.text });
    } else {
      items.push({ type: "text", text: describe(item) });
    }
  }
  return items;
}

/** 拉起中转进程：中间隔一层 `cmd /c start`，cmd 立刻退出，中转的父进程消失。
 *  不能直接 spawn node：那样中转是调用者的子进程，内核超时或停止时按进程树结束命令会连它一起杀掉。
 *  等 cmd 退出了再走：它没退就退出父进程时，Windows 上这个中转有时根本没起来。 */
async function launchRelay(): Promise<void> {
  // 不重定向：start 起来的进程拿不到这里的标准输出（重定向留在 start 这一层），日志由 relay 自己写文件。
  const line = `start "" /b "${process.execPath}" "${path.join(import.meta.dirname, "relay.ts")}"`;
  const child = spawn("cmd.exe", ["/c", line], { stdio: "ignore", windowsHide: true, detached: true, windowsVerbatimArguments: true });
  child.on("error", () => {});
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
    setTimeout(() => resolve(), 5000).unref();
  });
}

/** 给中转发一个请求。连不上就拉起中转再重试，最多等 60 秒（机器忙时中转进程起来要十几秒；真正的上限是工具定义的 `timeout`）。 */
async function ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pipe = pipeName();
  const deadline = Date.now() + CONNECT_MS;
  let launched = false;
  for (;;) {
    let reply: unknown;
    try {
      await talk(pipe, request, (r) => {
        reply = r;
        return true;
      });
    } catch (e) {
      if (!(e instanceof ConnectError)) throw new Fail(`和 MCP 中转通信出错：${e instanceof Error ? e.message : String(e)}`);
      if (!launched) {
        launched = true;
        await launchRelay();
      }
      if (Date.now() > deadline) throw new Fail(`连不上 MCP 中转进程，拉起以后也没在 ${CONNECT_MS / 1000} 秒内连上。日志：${winPath(dataDir("relay.log"))} 这是环境问题，重试没用，别再调；告诉用户看日志。`);
      await sleep(100);
      continue;
    }
    if (reply === undefined || typeof reply !== "object" || reply === null) throw new Fail("MCP 中转没有回复就断开了。");
    return reply as Record<string, unknown>;
  }
}

async function main(): Promise<void> {
  const [server, tool] = process.argv.slice(2);
  if (server === undefined || tool === undefined || server === "" || tool === "") throw new Fail("用法：call.ts <server> <tool>");
  const proc = process.env["TAU_PROCESS"];
  if (proc === undefined || proc === "") throw new Fail("这个工具只能在 tau 的工具调用里运行：没有 TAU_PROCESS。");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(proc)) throw new Fail(`TAU_PROCESS 不是合法的进程 ID：${proc}`);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let args: unknown = {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw !== "") {
    try {
      args = JSON.parse(raw);
    } catch {
      throw new Fail("参数不是合法的 JSON。");
    }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Fail("参数必须是 JSON 对象。");
  const workdir = process.cwd();
  // 配置读不出、没有这个服务器：不用去碰中转，直接报。
  try {
    loadServer(workdir, server);
  } catch (e) {
    throw new Fail(`这个工具在当前工作目录用不了，重试没用，别再调；需要的话请用户检查 MCP 配置。${e instanceof Error ? e.message : String(e)}`);
  }
  pruneOldImages(dataDir("images"), Date.now(), dataDir("images", proc));

  const reply = await ask({ op: "call", process: proc, workdir, server, tool, arguments: args });
  if (reply["ok"] !== true) {
    const err = typeof reply["error"] === "string" ? reply["error"] : "MCP 中转返回了不认识的结果。";
    throw new Fail(err.startsWith("起不来 MCP 服务器") ? `MCP 服务器起不来，重试没用，别再调；把下面的原因告诉用户。${err}` : err);
  }
  const content = reply["content"];
  const items = toItems(proc, Array.isArray(content) ? content : [], reply["restarted"] === true);
  if (reply["isError"] === true) {
    // 错误：文字打到标准输出，退出码 1。内核拿标准输出和标准错误当错误文本。
    const text = items.filter((i) => i.type === "text").map((i) => (i as { text: string }).text).join("\n");
    process.stdout.write(`${text === "" ? "MCP 工具返回了错误，没有文字说明。" : text}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(fit(items))}\n`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Fail ? e.message : `调用 MCP 工具出错：${e instanceof Error ? e.message : String(e)}`}\n`);
    process.exitCode = 1;
  });
}
