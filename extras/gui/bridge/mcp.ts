// MCP 页的桥：列配置里的服务器、列工具并生成定义、装选中的、看 relay 的状态。
// 装的是桥自己重新生成的定义，不信客户端送来的内容。不导入 src/。
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { talk } from "../../tools/client.ts";
import { ConfigError, listServers } from "../../mcp/config.ts";
import { generateTools, listServer, parseCommand } from "../../mcp/gen.ts";
import { HttpError } from "./util.ts";
import { canon, readDef } from "./tools.ts";

/** 已知的项目目录：预设的工作目录加界面里登记的文件夹。 */
export type KnownDirs = () => Promise<string[]>;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 和 git 那边一样：workdir 必须是已知的项目目录。 */
export async function checkDir(workdir: unknown, known: KnownDirs): Promise<string> {
  if (typeof workdir !== "string" || workdir === "" || workdir.includes("\0")) throw new HttpError(400, "workdir 必须是字符串");
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  const want = norm(workdir);
  if (!(await known()).some((a) => norm(a) === want)) throw new HttpError(403, "这个目录不是已知的项目目录");
  return path.resolve(workdir);
}

/** 配置读不出、起不来服务器：翻成桥的状态码。 */
const asHttp = (e: unknown): never => {
  if (e instanceof HttpError) throw e;
  const message = e instanceof Error ? e.message : String(e);
  throw new HttpError(e instanceof ConfigError ? 400 : 502, message);
};

/** 配置文件的路径和服务器列表。没有配置文件时 `file` 是 null。 */
export function serverList(workdir: string): ReturnType<typeof listServers> {
  try {
    return listServers(workdir);
  } catch (e) {
    return asHttp(e);
  }
}

/** 一个定义属于哪个 MCP 服务器（命令指向 call.ts 才算）。认不出返回 null。 */
function mcpServerOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const command = (value as Record<string, unknown>)["command"];
  return typeof command === "string" ? (parseCommand(command)?.server ?? null) : null;
}

/** 装着的定义现在的状态：没有、和刚生成的一样、不一样。 */
function statusOf(dir: string, name: string, definition: Record<string, unknown>): "none" | "installed" | "differs" {
  const have = readDef(dir, name);
  if (have === null) return "none";
  return "value" in have && canon(have.value) === canon(definition) ? "installed" : "differs";
}

export interface BridgeTool {
  /** 服务器上的原名。 */
  tool: string;
  /** 工具定义名。 */
  name: string;
  description: string;
  /** `JSON.stringify(定义)` 的字节数。 */
  bytes: number;
  status: "none" | "installed" | "differs";
  /** 跳过这个工具的原因。 */
  skip?: string;
}

export interface BridgeTools {
  instructions: string | undefined;
  tools: BridgeTool[];
  /** 已经装了、服务器上已经没有的定义名。 */
  gone: string[];
  totalBytes: number;
}

/** 列工具并生成定义，不写盘。 */
export async function toolList(home: string, workdir: string, server: string): Promise<BridgeTools> {
  let generated;
  try {
    generated = generateTools(workdir, server, await listServer(workdir, server));
  } catch (e) {
    return asHttp(e);
  }
  const dir = path.join(home, "tools");
  const tools: BridgeTool[] = generated.tools.map((t) => ({
    tool: t.tool,
    name: t.name,
    description: t.description,
    bytes: t.bytes,
    status: t.definition === undefined ? "none" : statusOf(dir, t.name, t.definition),
    ...(t.skip === undefined ? {} : { skip: t.skip }),
  }));
  const have = new Set(tools.map((t) => t.name));
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // 没有工具定义目录：没有装过。
  }
  const gone = files
    .filter((f) => f.endsWith(".json") && NAME.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .filter((name) => !have.has(name))
    .filter((name) => {
      const r = readDef(dir, name);
      return r !== null && "value" in r && mcpServerOf(r.value) === server;
    })
    .sort();
  return { instructions: generated.instructions, tools, gone, totalBytes: generated.totalBytes };
}

/** 重新列一次、重新生成，只装选中的。先写临时文件再改名。 */
export async function installTools(home: string, workdir: string, server: string, raw: unknown): Promise<{ installed: string[]; bytes: number }> {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw new HttpError(400, "tools 必须是工具名的数组");
  const wanted = new Set(raw as string[]);
  let generated;
  try {
    generated = generateTools(workdir, server, await listServer(workdir, server));
  } catch (e) {
    return asHttp(e);
  }
  const missing = [...wanted].filter((tool) => !generated.tools.some((t) => t.tool === tool));
  if (missing.length > 0) throw new HttpError(400, `服务器上没有这些工具：${missing.join("、")}`);
  const bad = generated.tools.filter((t) => wanted.has(t.tool) && t.definition === undefined);
  if (bad.length > 0) throw new HttpError(400, `这些工具装不了：${bad.map((t) => `${t.tool}（${t.skip ?? ""}）`).join("、")}`);
  const picked = generated.tools.filter((t) => wanted.has(t.tool) && t.definition !== undefined);
  const dir = path.join(home, "tools");
  // 同名文件已经存在、又不是这个服务器生成的定义：一个都不写。
  const conflicts = picked
    .map((t) => t.name)
    .filter((name) => {
      const have = readDef(dir, name);
      return have !== null && (!("value" in have) || mcpServerOf(have.value) !== server);
    });
  if (conflicts.length > 0) throw new HttpError(409, `这些名字已经有别的工具定义：${conflicts.join("、")}`);
  mkdirSync(dir, { recursive: true });
  for (const t of picked) {
    const file = path.join(dir, `${t.name}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(t.definition, null, 2)}\n`);
    renameSync(tmp, file);
  }
  return { installed: picked.map((t) => t.name), bytes: picked.reduce((n, t) => n + t.bytes, 0) };
}

/** relay 的状态。它没在跑就回 `{running:false}`：桥绝不拉起 relay。 */
export async function relayStatus(pipe: string): Promise<Record<string, unknown>> {
  let reply: unknown;
  try {
    await talk(pipe, { op: "status" }, (r) => {
      reply = r;
      return true;
    });
  } catch {
    return { running: false };
  }
  const r = (typeof reply === "object" && reply !== null ? reply : {}) as Record<string, unknown>;
  if (r["ok"] !== true) return { running: false };
  return { running: true, pid: r["pid"], instances: r["instances"] };
}
