// 测试用的假 MCP 服务器（stdio）。`basic` 用 McpServer，`paged` 用底层的 Server（工具清单分两页），
// `broken` 不答 initialize（起来一半就失败）。`basic` 和 `broken` 都会起一个孙进程，用来测回收收不收得干净。
// SDK 装在 extras/ 的 node_modules 里：从 test/ 直接 import 解析不到，所以经 extras/package.json 解析再动态导入。
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTRAS = path.join(import.meta.dirname, "..", "..", "..", "extras");
const require_ = createRequire(path.join(EXTRAS, "package.json"));

async function sdk<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(require_.resolve(specifier)).href)) as T;
}

/** 一张小 png 的文件头：宽、高各 8 像素，绿色的 1×1 也能被入口检查接受。 */
function png(width = 8, height = 8, tail = 0): Buffer {
  const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return Buffer.from([0x89, ...[...("PNG\r\n")].map((c) => c.charCodeAt(0)), 0x1a, 0x0a, ...u32(13), ...[...("IHDR")].map((c) => c.charCodeAt(0)), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, tail & 0xff]);
}

/** 一张超过 1.5 MiB 的“png”：文件头对，后面塞满字节。 */
function hugePng(): Buffer {
  const head = png(8, 8);
  return Buffer.concat([head, Buffer.alloc(1.6 * 1024 * 1024, 0x41)]);
}

/** 计数工具的状态。换一个服务器进程就从头开始。 */
const state = { count: 0 };

/** 把自己的 PID 记进 `FAKE_PID_FILE`（测试用它查服务器进程有没有被收掉）。 */
function recordPid(): void {
  const file = process.env["FAKE_PID_FILE"];
  if (file !== undefined) appendFileSync(file, `${process.pid}\n`);
}

/** 起一个一直跑的孙进程，把它的 PID 记进 `FAKE_GRANDCHILD_FILE`（测试用它查回收收没收干净）。
 *  `detached` 是为了让它像 python 起的子进程那样：父进程死了它还活着，只有按进程树结束才收得掉。 */
function startGrandchild(): void {
  // 命令行的最后一段是标记：测试认“这是不是那个孙进程”用得上（PID 会被复用）。
  // 每个测试文件在环境变量 FAKE_MARK 里给一个唯一的值，别的文件的进程不会被认成自己的。
  const mark = process.env["FAKE_MARK"];
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", mark === undefined ? "tau-mcp-grandchild" : `tau-mcp-grandchild-${mark}`], { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();
  const file = process.env["FAKE_GRANDCHILD_FILE"];
  if (file !== undefined && child.pid !== undefined) appendFileSync(file, `${child.pid}\n`);
}

async function basic(): Promise<void> {
  recordPid();
  startGrandchild();
  // 起服务器很慢的样子：测 relay 在起服务器中途不会自己退出。
  const delay = Number(process.env["FAKE_START_DELAY_MS"] ?? 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const { McpServer } = await sdk<any>("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await sdk<any>("@modelcontextprotocol/sdk/server/stdio.js");
  const server = new McpServer({ name: "fake-mcp", version: "1" });
  server.registerTool("count", { description: "有状态的计数：每调一次加一，返回当前值。" }, async () => {
    state.count++;
    return { content: [{ type: "text", text: `count=${state.count}` }] };
  });
  server.registerTool("picture", { description: "返回一张小 png。" }, async () => {
    return { content: [{ type: "image", data: png(8, 8).toString("base64"), mimeType: "image/png" }] };
  });
  server.registerTool("boom", { description: "总是返回 isError。" }, async () => {
    return { content: [{ type: "text", text: "炸了：这是 isError 结果。" }], isError: true };
  });
  server.registerTool("slow", { description: "一分钟以后才回。" }, async () => {
    await new Promise((r) => setTimeout(r, 60_000));
    return { content: [{ type: "text", text: "慢了" }] };
  });
  server.registerTool("wide", { description: "长边 3000 像素的 png。" }, async () => {
    return { content: [{ type: "image", data: png(3000, 8, 1).toString("base64"), mimeType: "image/png" }] };
  });
  server.registerTool("huge", { description: "超过 1.5 MiB 的 png。" }, async () => {
    return { content: [{ type: "image", data: hugePng().toString("base64"), mimeType: "image/png" }] };
  });
  server.registerTool("many", { description: "三张小 png。" }, async () => {
    return {
      content: [1, 2, 3].map((n) => ({ type: "image" as const, data: png(8, 8, n).toString("base64"), mimeType: "image/png" })),
    };
  });
  server.registerTool("other", { description: "一个 resource 项和一个文本项。" }, async () => {
    return { content: [{ type: "resource", resource: { uri: "file:///E:/x.txt", text: "内容" } }, { type: "text", text: "后面还有一句。" }] };
  });
  server.registerTool("long", { description: "很长的一段文本。" }, async () => {
    return { content: [{ type: "text", text: "长".repeat(40_000) }] };
  });
  server.registerTool("bigjson", { description: "约 80 KB、很多换行的 JSON 文本。" }, async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `  {"id": ${i}, "name": "项目 ${i}", "ok": true}`);
    return { content: [{ type: "text", text: `{\n"items": [\n${rows.join(",\n")}\n]\n}` }] };
  });
  server.registerTool("biglines", { description: "约 48 KB 的 line\\n。" }, async () => {
    return { content: [{ type: "text", text: "line\n".repeat(9_600) }] };
  });
  await server.connect(new StdioServerTransport());
}

/** 起来就失败：起一个孙进程，然后对每个请求都回错误。父进程一直活着，所以能测收尾巴收得干不干净。 */
async function broken(): Promise<void> {
  recordPid();
  startGrandchild();
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      let id: unknown;
      try {
        id = (JSON.parse(line) as Record<string, unknown>)["id"];
      } catch {
        continue;
      }
      if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "不干" } })}\n`);
    }
  });
  setInterval(() => {}, 1000);
}

/** 一起来就往 stderr 写一行能认出来的错误，然后退出：真正的原因常常只在这里。 */
async function crash(): Promise<void> {
  recordPid();
  process.stderr.write("ModuleNotFoundError: No module named 'mcp'\n");
  process.exit(1);
}

/** 起来以前先往 stderr 写很多：没人读的话，管道满了就卡住。 */
async function noisy(): Promise<void> {
  recordPid();
  process.stderr.write("x".repeat(300 * 1024));
  await basic();
}

/** 照 FastMCP、pydantic 的样子：`$defs`、`$ref`、`anyOf` 里带 `null`、`title`、`default`。 */
async function pydantic(): Promise<void> {
  recordPid();
  const { Server } = await sdk<any>("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await sdk<any>("@modelcontextprotocol/sdk/server/stdio.js");
  const types = await sdk<any>("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "pydantic-mcp", version: "1" }, { capabilities: { tools: {} }, instructions: "pydantic 风格的说明。" });
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "draw_point",
        description: "按坐标画一个点。",
        inputSchema: {
          type: "object",
          title: "draw_pointArguments",
          properties: {
            point: { $ref: "#/$defs/Point", description: "坐标" },
            color: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Color" },
          },
          required: ["point"],
          $defs: {
            Point: { type: "object", title: "Point", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(types.CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "画好了" }] }));
  await server.connect(new StdioServerTransport());
}

async function paged(): Promise<void> {
  const { Server } = await sdk<any>("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await sdk<any>("@modelcontextprotocol/sdk/server/stdio.js");
  const types = await sdk<any>("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "paged-mcp", version: "1" }, { capabilities: { tools: {} } });
  const tools = [
    { name: "alpha", description: "第一个", inputSchema: { type: "object", properties: {} } },
    { name: "beta", description: "第二个", inputSchema: { type: "object", properties: {} } },
    { name: "gamma", description: "第三个", inputSchema: { type: "object", properties: {} } },
  ];
  server.setRequestHandler(types.ListToolsRequestSchema, async (req: any) => {
    const second = req.params?.cursor === "2";
    return second ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "2" };
  });
  server.setRequestHandler(types.CallToolRequestSchema, async (req: any) => {
    if (req.params.name === "alpha") return { content: [{ type: "text", text: "alpha 回了" }] };
    return { content: [{ type: "text", text: `没有工具 ${req.params.name}` }], isError: true };
  });
  await server.connect(new StdioServerTransport());
}

const modes: Record<string, () => Promise<void>> = { basic, paged, broken, pydantic, crash, noisy };
await (modes[process.argv[2] ?? "basic"] ?? basic)();
