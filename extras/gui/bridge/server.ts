// HTTP 桥：检查、路由、转发（见 .knowledge/kb-gui.md 和 kb-extras 的“HTTP 桥要做的检查”）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { listBgLogs } from "./bg.ts";
import { forward } from "./forward.ts";
import { createGit, runGit } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { pickFolder as realPick } from "./pick.ts";
import type { PickFolder } from "./pick.ts";
import { createPreset, listPresets, presetWorkdirs } from "./presets.ts";
import { contentType, readStatic, routeStatic } from "./static.ts";
import { createStateStore } from "./state.ts";
import { HttpError, isObject } from "./util.ts";

const API_BODY_MAX = 1024 * 1024;
/** 图片是 base64，单张上限 1.5 MiB，允许带几张。 */
const TAU_BODY_MAX = 32 * 1024 * 1024;

export interface BridgeOptions {
  /** 0 表示让系统挑。默认 4317。 */
  port?: number;
  /** 默认 ~/.tau。 */
  home?: string;
  /** 命名管道。默认 TAU_PIPE，再默认 \\.\pipe\tau。 */
  pipe?: string;
  /** 额外认的 Host 名字（Tailscale）。 */
  hosts?: string[];
  webDir?: string;
  vendorDir?: string;
  /** 测试注入。 */
  git?: GitRunner;
  pickFolder?: PickFolder;
}

export interface Bridge {
  port: number;
  server: Server;
  csp: string;
  close(): Promise<void>;
}

const DEFAULT_WEB = path.join(import.meta.dirname, "..", "web");
const DEFAULT_VENDOR = path.join(import.meta.dirname, "..", "..", "node_modules");

/** index.html 里内联 import map 的 CSP 哈希。 */
export function importMapHash(html: string): string {
  const m = /<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("index.html 里没有 import map");
  return `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`;
}

export function buildCsp(hash: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${hash}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export async function createBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const home = opts.home ?? path.join(os.homedir(), ".tau");
  const pipe = opts.pipe ?? process.env.TAU_PIPE ?? "\\\\.\\pipe\\tau";
  const webDir = opts.webDir ?? DEFAULT_WEB;
  const vendorDir = opts.vendorDir ?? DEFAULT_VENDOR;
  const extraHosts = (opts.hosts ?? []).map((h) => h.toLowerCase());
  const html = readFileSync(path.join(webDir, "index.html"));
  const csp = buildCsp(importMapHash(html.toString("utf8")));
  const state = createStateStore(home);
  const git = createGit(opts.git ?? runGit, () => {
    const folders = state.read().folders;
    return [...presetWorkdirs(home), ...(Array.isArray(folders) ? folders.filter((f): f is string => typeof f === "string") : [])];
  });
  const pick = opts.pickFolder ?? realPick;
  let picking = false;

  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  };

  async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new HttpError(413, "请求太大");
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "正文不是合法的 JSON");
    }
  }

  async function api(name: string, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (name) {
      case "tau":
        if (typeof body.op !== "string") throw new HttpError(400, "请求要带字符串 op");
        forward(pipe, body, req, res);
        return;
      case "presets":
        return json(res, 200, { presets: listPresets(home) });
      case "presets/create":
        createPreset(home, body);
        return json(res, 200, { ok: true });
      case "git":
        return json(res, 200, await git(body));
      case "bg": {
        const p = body.processes;
        if (!Array.isArray(p) || p.some((x) => typeof x !== "string" || x === "" || /[\\/:\0]/.test(x))) throw new HttpError(400, "processes 必须是进程 ID 的数组");
        return json(res, 200, { logs: listBgLogs(home, p as string[]) });
      }
      case "state": {
        if (body.set !== undefined && !isObject(body.set)) throw new HttpError(400, "set 必须是对象");
        return json(res, 200, { state: body.set === undefined ? state.read() : await state.update(body.set) });
      }
      case "pick-folder": {
        if (picking) throw new HttpError(409, "已经有一个选文件夹的对话框");
        picking = true;
        try {
          return json(res, 200, { path: await pick() });
        } finally {
          picking = false;
        }
      }
      default:
        throw new HttpError(404, "没有这个接口");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !allowedHosts.has(host)) throw new HttpError(403, "Host 不对");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, "Origin 不对");
    // 用原始路径，不经 URL 规范化，让路径检查自己看到 .. 和编码。
    const pathname = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
    if (!pathname.startsWith("/")) throw new HttpError(400, "请求路径不合法");
    const method = req.method ?? "";
    if (method === "GET") {
      if (pathname.startsWith("/api/")) throw new HttpError(405, "接口只收 POST");
      const file = routeStatic(pathname, webDir, vendorDir);
      const data = file === null ? null : file === path.join(webDir, "index.html") ? html : await readStatic(file);
      if (file === null || data === null) throw new HttpError(404, "找不到");
      res.writeHead(200, { "Content-Type": contentType(file), "Content-Length": data.length, "Cache-Control": pathname.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache" });
      res.end(data);
      return;
    }
    if (method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      throw new HttpError(405, "不支持这个方法");
    }
    if (!pathname.startsWith("/api/")) throw new HttpError(404, "没有这个接口");
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Content-Type 必须是 application/json");
    const name = pathname.slice(5);
    const max = name === "tau" ? TAU_BODY_MAX : API_BODY_MAX;
    const len = req.headers["content-length"];
    if (len !== undefined && Number(len) > max) throw new HttpError(413, "请求太大");
    const body = await readBody(req, max);
    if (!isObject(body)) throw new HttpError(400, "正文必须是 JSON 对象");
    await api(name, body, req, res);
  }

  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", csp);
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, `内部错误：${e instanceof Error ? e.message : String(e)}`);
      if (res.headersSent) return void res.destroy();
      // 没读完正文就拒绝：回完以后关连接，不再等剩下的字节。
      if (err.status === 413) res.setHeader("Connection", "close");
      json(res, err.status, { error: err.message });
    });
  });
  server.on("clientError", (_e, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4317, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听失败");
  const port = addr.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraHosts.flatMap((h) => [`https://${h}`, `http://${h}`])]);

  return {
    port,
    server,
    csp,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
