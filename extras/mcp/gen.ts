// 由 MCP 服务器的工具清单生成 tau 的工具定义（kb-extras 的“MCP 中转”）。
// 命名、规整参数、拼说明、算大小都是纯函数，好测；只有 listServer 会真的起服务器。
import { createHash } from "node:crypto";
import path from "node:path";
import { loadServer } from "./config.ts";
import { startServer } from "./server.ts";

/** 仓库里 extras/mcp 的位置，正斜杠：写进命令里的路径。 */
export const LIB_DIR = path.resolve(import.meta.dirname).replace(/\\/g, "/");
/** 一个定义的上限：`JSON.stringify({ description, parameters })` 的字节数（kb-tools 的“工具定义”）。 */
export const DEF_MAX_BYTES = 16 * 1024;
/** 起服务器加列工具的时限。 */
export const LIST_TIMEOUT_MS = 30_000;
/** 配置里没写 `timeout` 时用的秒数，和工具定义的默认值一样。 */
const TIMEOUT_DEFAULT = 120;
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 600;
const NAME_MAX = 64;
const NAME_OK = /^[A-Za-z0-9_-]+$/;
/** 内置工具和工具组：工具定义不能和它们重名（kb-tools 的“工具定义”）。 */
const RESERVED = new Set(["read", "write", "edit", "bash", "self", "handoff", "post", "spawn", "stop_process", "memory_get", "memory_set", "memory_delete", "memory", "agents"]);
/** `$ref` 展开的最大深度：再深就换成 `{}`，递归的 schema 不会无限展开。 */
const REF_DEPTH = 8;
const NOTE_CUT = "…（说明太长，已截断）";
const DROP = new Set(["$defs", "definitions", "$schema", "$id"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bytesOf = (v: unknown): number => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

/** 服务器上的一个工具。 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 一次列工具的结果。 */
export interface Listing {
  /** 服务器初始化时给的说明，可能没有。 */
  instructions: string | undefined;
  tools: McpTool[];
}

/** 一个工具的生成结果。跳过时有 `skip`，没有 `definition`。 */
export interface GeneratedTool {
  /** 服务器上的工具名。 */
  tool: string;
  /** 工具定义名。 */
  name: string;
  /** 最终的说明。 */
  description: string;
  /** `JSON.stringify(定义)` 的字节数，给界面算总量用。 */
  bytes: number;
  definition?: Record<string, unknown>;
  /** 跳过这个工具的原因。 */
  skip?: string;
}

export interface Generated {
  instructions: string | undefined;
  tools: GeneratedTool[];
  /** 能装的这些定义加起来多少字节。 */
  totalBytes: number;
}

/** 起服务器、走完分页列出工具、关掉。整体限时 `LIST_TIMEOUT_MS`，超时也结束进程树。 */
export async function listServer(workdir: string, server: string): Promise<Listing> {
  const deadline = Date.now() + LIST_TIMEOUT_MS;
  const left = (): number => Math.max(1, deadline - Date.now());
  const running = await startServer(workdir, server, { timeoutMs: left() });
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await Promise.race([
        running.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: left() }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`列工具超过 ${LIST_TIMEOUT_MS / 1000} 秒，已经结束服务器`)), left()).unref()),
      ]);
      for (const t of page.tools) tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== "");
    return { instructions: running.instructions, tools };
  } catch (e) {
    // 列工具失败也带上 stderr 的尾巴：真正的原因常常只在那里。
    const why = e instanceof Error ? e.message : String(e);
    const tail = running.stderrTail();
    throw new Error(tail === "" ? why : `${why}\n服务器的 stderr：\n${tail}`);
  } finally {
    // 列完（或者超时、出错）一定要关掉：它是一次性的，不留给以后。
    await running.close();
  }
}

/** 去掉 $ref 的数字、转义，得到 `$defs` 里的键。 */
function refKey(ref: string): string | null {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  return m?.[1] === undefined ? null : m[1].replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 收集各个层级的 `$defs`、`definitions`（顶层先来，同名的留第一个）。
 *  Python 的服务器一般把 `$defs` 都放在顶层，嵌套的也认，省得指不上。 */
function collectDefs(node: unknown, into: Record<string, unknown>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectDefs(v, into);
    return;
  }
  if (!isObject(node)) return;
  for (const key of ["$defs", "definitions"]) {
    const d = node[key];
    if (isObject(d)) for (const [k, v] of Object.entries(d)) if (!(k in into)) into[k] = v;
  }
  for (const v of Object.values(node)) collectDefs(v, into);
}

/** 把本地 `$ref` 就地展开，去掉 `$defs`、`definitions`、`$schema`、`$id`。别的键原样留。 */
function expand(node: unknown, defs: Record<string, unknown>, stack: readonly string[]): unknown {
  if (Array.isArray(node)) return node.map((v) => expand(v, defs, stack));
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k] = expand(v, defs, stack);
  }
  const ref = out["$ref"];
  delete out["$ref"];
  if (typeof ref !== "string") return out;
  const key = refKey(ref);
  const target = key === null ? undefined : defs[key];
  // 递归的、指不上的：$ref 去掉，剩下的键留着（通常就是空对象）。
  if (target === undefined || stack.includes(ref) || stack.length >= REF_DEPTH) return out;
  const expanded = expand(target, defs, [...stack, ref]);
  // $ref 旁边的键（description 之类）盖住展开的结果。
  return isObject(expanded) ? { ...expanded, ...out } : out;
}

/** 把服务器的 `inputSchema` 规整成 tau 能用的参数：顶层一定是 `type: "object"`。 */
export function normalizeSchema(raw: unknown): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  collectDefs(raw, defs);
  const body = expand(raw, defs, []);
  const out: Record<string, unknown> = isObject(body) ? { ...body } : {};
  if (out["properties"] === undefined) out["properties"] = {};
  // 顶层不是对象的话，有的 provider 会拒绝每一次请求（kb-tools 的“工具定义”）。
  if (out["type"] !== "object") out["type"] = "object";
  return out;
}

/** 一段文字最多留 `max` 个字节，切在字符边界上。 */
function sliceBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** 说明太长时截到装得下：按转义以后的真实字节数二分。真的留不下就返回 null。 */
function fitDescription(text: string, parameters: unknown): string | null {
  const size = (d: string): number => bytesOf({ description: d, parameters });
  if (size(text) <= DEF_MAX_BYTES) return text;
  const total = bytesOf(text);
  let lo = 0;
  let hi = total - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const candidate = `${sliceBytes(text, keep)}${NOTE_CUT}`;
    if (size(candidate) <= DEF_MAX_BYTES) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}

/** 子进程命令里能安全地用单引号括起来吗。 */
const quotable = (s: string): boolean => !/['\u0000-\u001f\u007f]/.test(s);

/** 工具定义的命令。名字没法安全地写进 bash 的命令行时返回 null。 */
export function commandFor(server: string, tool: string): string | null {
  if (/["$`]/.test(LIB_DIR) || !quotable(server) || !quotable(tool)) return null;
  return `node "${LIB_DIR}/call.ts" '${server}' '${tool}'`;
}

/** 从命令认出这是 MCP 生成的定义：读出服务器名和工具名。不是就返回 null。 */
export function parseCommand(command: string): { server: string; tool: string } | null {
  const m = /^node "[^"]*[\\/]extras[\\/]mcp[\\/]call\.ts" '([^']*)' '([^']*)'$/.exec(command);
  return m === null ? null : { server: m[1] ?? "", tool: m[2] ?? "" };
}

/** 由原工具名算出的短哈希：同样的输入永远得到同样的名字。 */
const shortHash = (server: string, tool: string): string => createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 8);

/**
 * 一个服务器的全部工具定义名：`<服务器>_<工具>`，非法字符换成 `_`。
 * 太长、和内置工具重名、去掉非法字符以后互相重名，就截短并加上短哈希。
 */
export function toolNames(server: string, tools: readonly string[]): Map<string, string> {
  const base = new Map(tools.map((t) => [t, `${server}_${t}`.replace(/[^A-Za-z0-9_-]/g, "_")]));
  const count = new Map<string, number>();
  for (const b of base.values()) count.set(b.toLowerCase(), (count.get(b.toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const [tool, b] of base) {
    const plain = NAME_OK.test(b) && b.length <= NAME_MAX && !RESERVED.has(b) && (count.get(b.toLowerCase()) ?? 0) === 1;
    if (plain) {
      out.set(tool, b);
      continue;
    }
    const head = b.slice(0, NAME_MAX - 9) || server.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, NAME_MAX - 9) || "mcp";
    out.set(tool, `${head}_${shortHash(server, tool)}`);
  }
  return out;
}

/** 工具描述：工具自己的说明在前，后面一行写服务器名和配置里的 `description`。 */
export function toolDescription(tool: McpTool, server: string, note: string | undefined): string {
  const tail = `MCP 服务器 ${server}${note === undefined || note === "" ? "" : `：${note}`}`;
  return tool.description === "" ? tail : `${tool.description}\n\n${tail}`;
}

/** 配置里的 `timeout` 截到 1 到 600 秒，没写就是 120。 */
export function clampTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return TIMEOUT_DEFAULT;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(timeout)));
}

/** 由一次列工具的结果生成工具定义。`workdir` 只用来读配置里的 `description` 和 `timeout`。 */
export function generateTools(workdir: string, server: string, listing: Listing): Generated {
  const cfg = loadServer(workdir, server);
  const names = toolNames(
    server,
    listing.tools.map((t) => t.name),
  );
  const timeout = clampTimeout(cfg.timeout);
  const tools: GeneratedTool[] = [];
  let total = 0;
  for (const tool of listing.tools) {
    const name = names.get(tool.name) ?? tool.name;
    const command = commandFor(server, tool.name);
    const skip = (why: string): void => void tools.push({ tool: tool.name, name, description: "", bytes: 0, skip: why });
    if (command === null) {
      skip("工具名里有单引号、控制字符，或者仓库路径里有引号、$、反引号，写不进命令");
      continue;
    }
    const parameters = normalizeSchema(tool.inputSchema);
    // 先截说明；只靠参数就超了，这个工具就装不下。
    const description = fitDescription(toolDescription(tool, server, cfg.description), parameters);
    if (description === null) {
      skip(`参数就有 ${bytesOf(parameters)} 字节，超过一个定义的 ${DEF_MAX_BYTES} 字节上限`);
      continue;
    }
    const definition: Record<string, unknown> = { description, parameters, command, timeout, output: "content" };
    const bytes = bytesOf(definition);
    total += bytes;
    tools.push({ tool: tool.name, name, description, bytes, definition });
  }
  return { instructions: listing.instructions, tools, totalBytes: total };
}
