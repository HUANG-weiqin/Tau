// @ts-check
// MCP 这一节的纯逻辑：能装的定义和它们的字节数、已装定义按服务器分组、工具名折成服务器、
// 空闲多久的文字。不碰 DOM，不发请求（设计稿 7.12 的 MCP，实现见 kb-gui）。

/** 一个预设能带多少工具定义：内核的 `TOOL_DEFS_MAX_BYTES`（kb-tools 的“工具定义”）。 */
export const LIMIT = 64 * 1024;

/**
 * 桥生成的工具定义。
 * @typedef {object} GenTool
 * @property {string} tool 服务器上的原名
 * @property {string} name 工具定义名
 * @property {string} description
 * @property {number} bytes `JSON.stringify(定义)` 的字节数
 * @property {"none" | "installed" | "differs"} status
 * @property {string} [skip] 装不了的原因
 */

/**
 * 一个已装的工具定义（`/api/tools` 的一项）。
 * @typedef {object} InstalledDef
 * @property {string} name
 * @property {{ server: string, tool: string }} [mcp] 是 MCP 生成的时候才有
 */

/**
 * 能装的定义：服务器给的、没有 `skip` 的。一个服务器要么装，要么不装，不能挑几个。
 * @param {readonly GenTool[]} tools
 * @returns {GenTool[]}
 */
export function installable(tools) {
  return tools.filter((t) => t.skip === undefined);
}

/**
 * 能装的定义的字节数之和，对着一个预设的上限。`ratio` 可能大于 1。
 * @param {readonly GenTool[]} tools
 * @returns {{ bytes: number, limit: number, ratio: number, over: boolean }}
 */
export function sizeOf(tools) {
  const bytes = installable(tools).reduce((n, t) => n + t.bytes, 0);
  return { bytes, limit: LIMIT, ratio: bytes / LIMIT, over: bytes > LIMIT };
}

/**
 * 已装的定义按 MCP 服务器分组；不是 MCP 生成的放进 `others`。组的顺序按第一次出现的先后。
 * @param {readonly InstalledDef[]} installed
 * @returns {{ groups: { server: string, defs: InstalledDef[] }[], others: InstalledDef[] }}
 */
export function groupByServer(installed) {
  /** @type {Map<string, InstalledDef[]>} */
  const groups = new Map();
  /** @type {InstalledDef[]} */
  const others = [];
  for (const d of installed) {
    const server = d.mcp?.server;
    if (typeof server !== "string" || server === "") {
      others.push(d);
      continue;
    }
    const list = groups.get(server);
    if (list) list.push(d);
    else groups.set(server, [d]);
  }
  return { groups: [...groups].map(([server, defs]) => ({ server, defs })), others };
}

/**
 * 一组工具全选或全不选以后的新列表：别的保持原顺序，新加的接在后面。
 * @param {readonly string[]} list 现在的
 * @param {readonly string[]} names 这一组的
 * @param {boolean} on
 * @returns {string[]}
 */
export function withGroup(list, names, on) {
  const set = new Set(names);
  const kept = list.filter((t) => !set.has(t));
  return on ? [...kept, ...names.filter((n) => !kept.includes(n))] : kept;
}

/**
 * 工具名折成“一项一个整体”：同一个 MCP 服务器的定义合成一项。
 * 服务器项出现在它第一个定义名在 `names` 里的位置；`tools/` 下已经没有的名字（或不是 MCP 生成的）原样一项。
 * `names` 里一个都没有的服务器不出现。
 * @param {readonly string[]} names 预设或会话的工具名，按文件的顺序
 * @param {readonly InstalledDef[]} defs `/api/tools` 的 installed
 * @returns {({ kind: "tool", name: string } | { kind: "mcp", server: string, on: number, total: number, names: string[] })[]}
 */
export function foldTools(names, defs) {
  /** @type {Map<string, string[]>} 服务器 → 它的全部定义名 */
  const byServer = new Map();
  /** @type {Map<string, string>} 定义名 → 服务器 */
  const serverOf = new Map();
  for (const d of defs) {
    const server = d.mcp?.server;
    if (typeof server !== "string" || server === "") continue;
    serverOf.set(d.name, server);
    const list = byServer.get(server);
    if (list) list.push(d.name);
    else byServer.set(server, [d.name]);
  }
  const inNames = new Set(names);
  /** @type {Set<string>} */
  const done = new Set();
  /** @type {ReturnType<typeof foldTools>} */
  const out = [];
  for (const name of inNames) {
    const server = serverOf.get(name);
    if (server === undefined) {
      out.push({ kind: "tool", name });
      continue;
    }
    if (done.has(server)) continue;
    done.add(server);
    const all = byServer.get(server) ?? [];
    out.push({ kind: "mcp", server, on: all.filter((n) => inNames.has(n)).length, total: all.length, names: all });
  }
  return out;
}

/**
 * 空闲多久的文字：秒、分钟、小时。
 * @param {number} ms
 * @returns {string}
 */
export function idleText(ms) {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
