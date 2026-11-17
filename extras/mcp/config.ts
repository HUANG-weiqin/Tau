// 读工作目录里的 MCP 配置：先找 `.pi/mcp.json`，没有就找 `.mcp.json`（kb-extras 的“MCP 中转”）。
// 只认 stdio 的服务器。不导入 src/。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 配置文件里一项 `mcpServers` 的内容，已经查过类型。 */
export interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 配置里写的 `cwd`。没有时用请求里的工作目录。 */
  cwd: string | undefined;
  /** 给模型看的服务器说明。生成工具定义时写进工具描述。 */
  description: string | undefined;
  /** 工具的默认超时（秒）。生成工具定义时用。 */
  timeout: number | undefined;
}

/** 桥列服务器时的一项：写错的项带 `error`，别的照列。 */
export interface ServerEntry {
  name: string;
  command?: string;
  description?: string;
  timeout?: number;
  error?: string;
}

/** 配置读不出、没有这个服务器、不是 stdio：消息就是原因，给模型看。 */
export class ConfigError extends Error {}

const FILES = [".pi/mcp.json", ".mcp.json"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 读出 `mcpServers`：键是名字，值是没查过的配置。没有配置文件时 `file` 是 null。 */
function readServers(workdir: string): { file: string | null; servers: Record<string, unknown> } {
  const found = FILES.map((f) => path.join(workdir, f)).find((f) => existsSync(f));
  if (found === undefined) return { file: null, servers: {} };
  let all: unknown;
  try {
    all = JSON.parse(readFileSync(found, "utf8"));
  } catch (e) {
    throw new ConfigError(`MCP 配置文件不是合法的 JSON：${found}（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!isObject(all) || !isObject(all["mcpServers"])) throw new ConfigError(`MCP 配置文件里没有 mcpServers 对象：${found}`);
  return { file: found, servers: all["mcpServers"] };
}

/** 查一项配置。`server` 只是用来说错误信息。 */
function parseEntry(server: string, raw: unknown, file: string): ServerConfig {
  if (!isObject(raw)) throw new ConfigError(`MCP 服务器 ${server} 的配置不是对象：${file}`);
  if (raw["type"] !== undefined && raw["type"] !== "stdio") {
    throw new ConfigError(`只支持 stdio 的 MCP 服务器：${server} 的 type 是 ${JSON.stringify(raw["type"])}。`);
  }
  const command = raw["command"];
  if (typeof command !== "string" || command === "") throw new ConfigError(`MCP 服务器 ${server} 的 command 必须是非空字符串：${file}`);
  const args = raw["args"] ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new ConfigError(`MCP 服务器 ${server} 的 args 必须是字符串数组：${file}`);
  }
  const rawEnv = raw["env"] ?? {};
  if (!isObject(rawEnv) || Object.values(rawEnv).some((v) => typeof v !== "string")) {
    throw new ConfigError(`MCP 服务器 ${server} 的 env 必须是字符串到字符串的对象：${file}`);
  }
  const cwd = raw["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") throw new ConfigError(`MCP 服务器 ${server} 的 cwd 必须是字符串：${file}`);
  const description = raw["description"];
  if (description !== undefined && typeof description !== "string") throw new ConfigError(`MCP 服务器 ${server} 的 description 必须是字符串：${file}`);
  const timeout = raw["timeout"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout))) {
    throw new ConfigError(`MCP 服务器 ${server} 的 timeout 必须是秒数：${file}`);
  }
  return { command, args: args as string[], env: rawEnv as Record<string, string>, cwd, description, timeout };
}

/** 读出一个服务器的配置。`server` 是 `mcpServers` 下的名字。 */
export function loadServer(workdir: string, server: string): ServerConfig {
  const { file, servers } = readServers(workdir);
  if (file === null) throw new ConfigError(`找不到 MCP 配置文件：${FILES.map((f) => path.join(workdir, f)).join(" 和 ")} 都不存在。`);
  const names = Object.keys(servers);
  const raw = servers[server];
  if (raw === undefined) {
    throw new ConfigError(`MCP 配置文件里没有服务器 ${server}：${file}${names.length === 0 ? "（一个都没有）" : `（有：${names.join("、")}）`}`);
  }
  return parseEntry(server, raw, file);
}

/** 列配置里的全部服务器，一项写错了只标记那一项。没有配置文件时 `file` 是 null、列表是空的。 */
export function listServers(workdir: string): { file: string | null; servers: ServerEntry[] } {
  const { file, servers } = readServers(workdir);
  const names = Object.keys(servers);
  return {
    file,
    servers: names.map((name) => {
      try {
        const cfg = parseEntry(name, servers[name], file ?? workdir);
        return {
          name,
          command: cfg.command,
          ...(cfg.description === undefined ? {} : { description: cfg.description }),
          ...(cfg.timeout === undefined ? {} : { timeout: cfg.timeout }),
        };
      } catch (e) {
        return { name, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  };
}
