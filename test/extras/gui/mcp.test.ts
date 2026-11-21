// MCP 页的桥（extras/gui/bridge/mcp.ts）：四个接口 + 装完的状态变化 + 不留下服务器进程。
// 临时家目录、临时项目目录、临时管道；进程检查用 `process.kill(pid, 0)`。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import type { Bridge } from "../../../extras/gui/bridge/server.ts";
import { LIB_DIR, parseCommand } from "../../../extras/mcp/gen.ts";

const FAKE = join(import.meta.dirname, "..", "mcp", "fake-server.ts").replace(/\\/g, "/");
const JSON_H = { "Content-Type": "application/json" };

let dir = "";
let home = "";
let proj = "";
let other = "";
let bridge: Bridge;
let port = 0;
let pidFile = "";
let kidsFile = "";
let relayPipe = "";
const saved: Record<string, string | undefined> = {};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 这个 PID 还是不是那个假服务器（Windows 的 PID 复用很快，只看 PID 会把别人当成它）。 */
const aliveServer = (pid: number): boolean => {
  if (!alive(pid)) return false;
  const cmd = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  return cmd.includes("fake-server.ts");
};

const readPids = (file: string): number[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((s) => s !== "").map(Number) : []);

/** 杀掉记录里的孤儿进程。detached 的孙进程在父进程死后就脱离了进程树，relay 的 `taskkill /T` 收不到；
 *  它们继承的工作目录是 proj，会把临时目录锁住，after 里删目录就报 EPERM。只杀命令行对得上的：Windows 的 PID 复用很快。 */
const killRecorded = (): void => {
  const mine = new Set([...readPids(pidFile), ...readPids(kidsFile)]);
  if (mine.size === 0) return;
  const out =
    spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (m === null || !mine.has(Number(m[1]))) continue;
    if (!/fake-server\.ts|tau-mcp-grandchild/.test(m[2]!)) continue;
    spawnSync("taskkill", ["/F", "/PID", String(m[1])], { stdio: "ignore", windowsHide: true });
  }
};

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: JSON_H }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const toolsDir = (): string => join(home, "tools");

before(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith("TAU_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "tau-mcp-bridge-"));
  home = join(dir, "home");
  proj = join(dir, "proj");
  other = join(dir, "other");
  pidFile = join(dir, "servers.txt");
  kidsFile = join(dir, "kids.txt");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(join(proj, ".pi"), { recursive: true });
  mkdirSync(other, { recursive: true });
  const env = { FAKE_PID_FILE: pidFile.replace(/\\/g, "/"), FAKE_GRANDCHILD_FILE: kidsFile.replace(/\\/g, "/") };
  writeFileSync(
    join(proj, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE, "basic"], env, description: "假服务器", timeout: 60 },
        pyd: { command: process.execPath, args: [FAKE, "pydantic"], env, timeout: 900 },
        broken: { type: "http", command: "x" },
      },
    }),
  );
  relayPipe = `\\\\.\\pipe\\tau-test-mcp-bridge-relay-${process.pid}-${Math.random().toString(16).slice(2)}`;
  bridge = await createBridge({ port: 0, home, pipe: `\\\\.\\pipe\\tau-test-mcp-bridge-none-${process.pid}`, mcpPipe: relayPipe });
  port = bridge.port;
  // 已知的项目目录：界面里登记的文件夹。另一个目录不登记，用来测 403。
  assert.equal((await post("/api/state", { set: { folders: [proj] } })).status, 200);
});

after(async () => {
  await bridge.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  await sleep(300);
  killRecorded();
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

describe("服务器列表", () => {
  test("配置文件的路径、服务器列表；写错的项带 error，别的照列", async () => {
    const r = await post("/api/mcp/servers", { workdir: proj });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.file, join(proj, ".pi", "mcp.json"));
    assert.deepEqual(
      r.json.servers.map((s: any) => s.name),
      ["fake", "pyd", "broken"],
    );
    const fake = r.json.servers.find((s: any) => s.name === "fake");
    assert.deepEqual(fake, { name: "fake", command: process.execPath, description: "假服务器", timeout: 60 });
    assert.equal(r.json.servers.find((s: any) => s.name === "pyd").timeout, 900);
    assert.match(r.json.servers.find((s: any) => s.name === "broken").error, /只支持 stdio/);
  });

  test("没有配置文件：file 是 null，列表是空的", async () => {
    assert.equal((await post("/api/state", { set: { folders: [proj, other] } })).status, 200);
    const r = await post("/api/mcp/servers", { workdir: other });
    assert.deepEqual(r.json, { file: null, servers: [] });
  });

  test("不是已知的项目目录：403", async () => {
    assert.equal((await post("/api/mcp/servers", { workdir: join(dir, "nope") })).status, 403);
    assert.equal((await post("/api/mcp/tools", { workdir: join(dir, "nope"), server: "fake" })).status, 403);
    assert.equal((await post("/api/mcp/install", { workdir: join(dir, "nope"), server: "fake", tools: [] })).status, 403);
  });
});

describe("列工具并生成定义", () => {
  test("起一次服务器、列完就关掉：定义、状态、总量都对，进程没留下", async () => {
    const before = readPids(pidFile).length;
    const r = await post("/api/mcp/tools", { workdir: proj, server: "fake" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.instructions, undefined);
    const names = r.json.tools.map((t: any) => t.tool);
    assert.ok(names.includes("count") && names.includes("picture"), JSON.stringify(names));
    const count = r.json.tools.find((t: any) => t.tool === "count");
    assert.equal(count.name, "fake_count");
    assert.equal(count.status, "none");
    assert.ok(count.bytes > 0);
    assert.ok(count.description.includes("MCP 服务器 fake：假服务器"));
    assert.deepEqual(r.json.gone, []);
    assert.ok(r.json.totalBytes > 0);

    // 生成的命令能认出服务器名和工具名。
    const started = readPids(pidFile).slice(before);
    assert.equal(started.length, 1, "起过一个服务器进程");
    assert.equal(aliveServer(started[0]!), false, "服务器进程应该已经结束");
    assert.equal([...readPids(kidsFile)].every((p) => !alive(p)), true, "孙进程也收掉了");
  });

  test("$defs、$ref 展开：pydantic 风格的参数规整好，说明里带服务器", async () => {
    const r = await post("/api/mcp/tools", { workdir: proj, server: "pyd" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.instructions, "pydantic 风格的说明。");
    const t = r.json.tools[0];
    assert.equal(t.name, "pyd_draw_point");
    // timeout 900 截到 600。
    const file = join(toolsDir(), "pyd_draw_point.json");
    assert.equal(existsSync(file), false, "列工具不写盘");
    assert.ok(t.bytes > 0);
    const shape = JSON.stringify(t);
    assert.ok(!shape.includes("$ref") && !shape.includes("$defs"), shape.slice(0, 300));
  });

  test("服务器名不对、配置读不出：清楚的错误", async () => {
    const r = await post("/api/mcp/tools", { workdir: proj, server: "nope" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /没有服务器 nope/);
    assert.equal((await post("/api/mcp/tools", { workdir: proj })).status, 400);
  });
});

describe("装定义", () => {
  test("装上选中的：状态从 none 变 installed，定义能被内核读", async () => {
    const r = await post("/api/mcp/install", { workdir: proj, server: "fake", tools: ["count"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.installed, ["fake_count"]);
    const file = join(toolsDir(), "fake_count.json");
    const def = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(def).sort(), ["command", "description", "output", "parameters", "timeout"]);
    assert.equal(def.output, "content");
    assert.equal(def.timeout, 60);
    assert.deepEqual(parseCommand(def.command), { server: "fake", tool: "count" });
    assert.equal(def.command, `node "${LIB_DIR}/call.ts" 'fake' 'count'`);
    assert.deepEqual(readdirSync(toolsDir()).filter((f) => f.endsWith(".tmp")), [], "不留临时文件");

    const again = await post("/api/mcp/tools", { workdir: proj, server: "fake" });
    assert.equal(again.json.tools.find((t: any) => t.tool === "count").status, "installed");
    assert.equal(again.json.tools.find((t: any) => t.tool === "picture").status, "none");
  });

  test("装好的定义被改过：状态是 differs", async () => {
    const file = join(toolsDir(), "fake_count.json");
    const def = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...def, timeout: 5 }));
    const r = await post("/api/mcp/tools", { workdir: proj, server: "fake" });
    assert.equal(r.json.tools.find((t: any) => t.tool === "count").status, "differs");
    writeFileSync(file, JSON.stringify(def));
    assert.equal((await post("/api/mcp/tools", { workdir: proj, server: "fake" })).json.tools.find((t: any) => t.tool === "count").status, "installed");
  });

  test("/api/tools 认出 MCP 生成的定义：带 mcp 字段，库里的和手写的没有", async () => {
    const r = await post("/api/tools", {});
    assert.equal(r.status, 200);
    const fake = r.json.installed.find((t: any) => t.name === "fake_count");
    assert.deepEqual(fake.mcp, { server: "fake", tool: "count" });
    // 手写的没有这个字段。
    writeFileSync(join(toolsDir(), "mine.json"), JSON.stringify({ description: "手写", parameters: { type: "object", properties: {} }, command: "node E:/mine.ts", timeout: 120, output: "text" }));
    const after = await post("/api/tools", {});
    assert.equal(after.json.installed.find((t: any) => t.name === "mine").mcp, undefined);
    for (const lib of after.json.library) assert.equal(lib.mcp, undefined, lib.name);
  });

  test("服务器上已经没有的工具，装着的定义出现在 gone 里", async () => {
    const gone = { ...JSON.parse(readFileSync(join(toolsDir(), "fake_count.json"), "utf8")), command: `node "${LIB_DIR}/call.ts" 'fake' 'removed_tool'` };
    writeFileSync(join(toolsDir(), "fake_removed_tool.json"), JSON.stringify(gone));
    // 别的服务器的定义、不是 MCP 的定义，都不算 gone。
    writeFileSync(join(toolsDir(), "fake_other.json"), JSON.stringify({ ...gone, command: `node "${LIB_DIR}/call.ts" 'pyd' 'x'` }));
    writeFileSync(join(toolsDir(), "mine.json"), JSON.stringify({ ...gone, command: "node E:/x.ts" }));
    const r = await post("/api/mcp/tools", { workdir: proj, server: "fake" });
    assert.deepEqual(r.json.gone, ["fake_removed_tool"]);
  });

  test("同名的非 MCP 定义：409，一个都不写", async () => {
    const mine = { description: "我的", parameters: { type: "object", properties: {} }, command: "node E:/mine.ts", timeout: 120, output: "text" };
    writeFileSync(join(toolsDir(), "fake_picture.json"), JSON.stringify(mine));
    const r = await post("/api/mcp/install", { workdir: proj, server: "fake", tools: ["count", "picture"] });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /fake_picture/);
    assert.deepEqual(JSON.parse(readFileSync(join(toolsDir(), "fake_picture.json"), "utf8")), mine, "冲突的文件不动");
    assert.equal(existsSync(join(toolsDir(), "fake_count.json")), true);
  });

  test("服务器上没有的工具、装不了的工具：400", async () => {
    assert.equal((await post("/api/mcp/install", { workdir: proj, server: "fake", tools: ["nope"] })).status, 400);
    assert.equal((await post("/api/mcp/install", { workdir: proj, server: "fake", tools: "count" })).status, 400);
  });

  test("pydantic 风格的参数装得上，定义的 timeout 截到 600", async () => {
    const r = await post("/api/mcp/install", { workdir: proj, server: "pyd", tools: ["draw_point"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const def = JSON.parse(readFileSync(join(toolsDir(), "pyd_draw_point.json"), "utf8"));
    assert.equal(def.timeout, 600);
    assert.deepEqual((def.parameters.properties as any).point, { type: "object", title: "Point", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], description: "坐标" });
  });

  test("装的时候重新列一次：每次都不留下服务器进程", async () => {
    const before = readPids(pidFile).length;
    await post("/api/mcp/install", { workdir: proj, server: "fake", tools: ["count"] });
    const started = readPids(pidFile).slice(before);
    assert.equal(started.length, 1);
    assert.equal(aliveServer(started[0]!), false);
  });
});

describe("relay 状态", () => {
  test("relay 没在跑：running 是 false，而且没有把它拉起来", async () => {
    const r = await post("/api/mcp/status", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { running: false });
    await sleep(300);
    assert.deepEqual((await post("/api/mcp/status", {})).json, { running: false });
  });
});
