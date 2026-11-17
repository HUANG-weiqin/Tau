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
import { piCredentials } from "./credentials.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { buildCatalog, readKeys } from "./models.ts";
import type { CatalogProvider } from "./models.ts";
import { agentsMdInfo } from "./agentsmd.ts";
import { createPreset, deletePreset, listPresets, presetWorkdirs, updatePreset } from "./presets.ts";
import { createServiceControl } from "./service.ts";
import type { ServiceOps } from "./service.ts";
import { generateTitle } from "./title.ts";
import { contentType, readStatic, routeStatic } from "./static.ts";
import { installTool, listTools, removeTool } from "./tools.ts";
import { checkDir, installTools, relayStatus, serverList, toolList } from "./mcp.ts";
import { createStateStore } from "./state.ts";
import { HttpError, isObject } from "./util.ts";
import type { Models } from "@earendil-works/pi-ai";

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
  /** pi 的凭据文件，只读它每个条目的 provider 名和类型。默认 ~/.pi/agent/auth.json。 */
  authFile?: string;
  /** 自动标题用的模型集合。默认是内置的全部供应商，凭据读 authFile。测试注入假的。 */
  titleModels?: Models;
  /** 查服务进程、起重启脚本。测试注入假的，不真的起停进程。 */
  serviceOps?: ServiceOps;
  /** 重启桥时原样带给新桥的命令行参数。默认是本进程的。 */
  bridgeArgs?: string[];
  /** 仓库根目录，用来比源码的修改时间。默认是这个文件往上三层。 */
  repo?: string;
  /** 桥的启动时间（毫秒）。测试注入。 */
  bridgeStartedAt?: number;
  /** MCP 中转的管道。默认 TAU_MCP_PIPE，再默认 \\.\pipe\tau-mcp。桥只查它，不拉起。 */
  mcpPipe?: string;
}

export interface Bridge {
  port: number;
  server: Server;
  csp: string;
  close(): Promise<void>;
}

const DEFAULT_WEB = path.join(import.meta.dirname, "..", "web");
const DEFAULT_REPO = path.resolve(import.meta.dirname, "..", "..", "..");
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
  // 已知的项目目录：预设的工作目录，加界面里登记的文件夹。git 和 MCP 两边都用它。
  const knownDirs = async (): Promise<string[]> => {
    const folders = state.read().folders;
    return [...(await presetWorkdirs(home, pipe)), ...(Array.isArray(folders) ? folders.filter((f): f is string => typeof f === "string") : [])];
  };
  const git = createGit(opts.git ?? runGit, knownDirs);
  const mcpPipe = opts.mcpPipe ?? process.env.TAU_MCP_PIPE ?? "\\\\.\\pipe\\tau-mcp";
  const authFile = opts.authFile ?? path.join(os.homedir(), ".pi", "agent", "auth.json");
  let catalog: CatalogProvider[] | null = null;
  let titleModels: Models | null = opts.titleModels ?? null;
  const control = createServiceControl({ pipe, repo: opts.repo ?? DEFAULT_REPO, ...(opts.serviceOps ? { ops: opts.serviceOps } : {}), ...(opts.bridgeStartedAt === undefined ? {} : { bridgeStartedAt: opts.bridgeStartedAt }) });
  const bridgeArgs = opts.bridgeArgs ?? process.argv.slice(2);
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
        return json(res, 200, { presets: await listPresets(home, pipe) });
      case "presets/create":
        createPreset(home, body);
        return json(res, 200, { ok: true });
      case "presets/update":
        return json(res, 200, { ok: true, preset: await updatePreset(home, pipe, body) });
      case "models": {
        // 目录算一次；key 状态每次现读，pi 里改了不用重启。
        catalog ??= buildCatalog();
        const { keys, auth } = readKeys(authFile);
        return json(res, 200, { providers: catalog.map((p) => ({ ...p, key: keys.get(p.id) ?? "none" })), auth });
      }
      case "service":
        return json(res, 200, await control.status());
      case "service/restart": {
        for (const k of ["service", "bridge", "force"]) if (body[k] !== undefined && typeof body[k] !== "boolean") throw new HttpError(400, `${k} 必须是布尔值`);
        if (body.service !== true && body.bridge !== true) throw new HttpError(400, "service 和 bridge 至少要有一个是 true");
        const r = await control.restart({ service: body.service === true, bridge: body.bridge === true, force: body.force === true, bridgeArgs });
        if (!r.ok) return json(res, 409, { error: `有 ${r.running} 个进程在跑，重启服务会中断它们`, running: r.running });
        return json(res, 202, { ok: true });
      }
      case "title": {
        if (typeof body.process !== "string" || body.process === "" || /[\\/:\0]/.test(body.process)) throw new HttpError(400, "process 必须是进程 ID");
        if (typeof body.model !== "string" || body.model === "") throw new HttpError(400, "model 必须是 供应商/模型");
        titleModels ??= builtinModels({ credentials: piCredentials(authFile) });
        return json(res, 200, { title: await generateTitle({ pipe, models: titleModels, process: body.process, model: body.model }) });
      }
      case "agents-md":
        return json(res, 200, agentsMdInfo(body));
      case "presets/delete":
        deletePreset(home, body);
        return json(res, 200, { ok: true });
      case "tools":
        return json(res, 200, listTools(home));
      case "tools/install":
        return json(res, 200, { ok: true, status: installTool(home, body) });
      case "tools/remove":
        removeTool(home, body);
        return json(res, 200, { ok: true });
      case "mcp/servers":
        return json(res, 200, serverList(await checkDir(body.workdir, knownDirs)));
      case "mcp/tools": {
        const dir = await checkDir(body.workdir, knownDirs);
        if (typeof body.server !== "string" || body.server === "") throw new HttpError(400, "server 必须是字符串");
        return json(res, 200, await toolList(home, dir, body.server));
      }
      case "mcp/install": {
        const dir = await checkDir(body.workdir, knownDirs);
        if (typeof body.server !== "string" || body.server === "") throw new HttpError(400, "server 必须是字符串");
        return json(res, 200, { ok: true, ...(await installTools(home, dir, body.server, body.tools)) });
      }
      case "mcp/status":
        return json(res, 200, await relayStatus(mcpPipe));
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
