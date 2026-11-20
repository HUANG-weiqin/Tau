// MCP 中转（extras/mcp）：真的拉起 relay、真的起假 MCP 服务器，全部用临时管道、临时家目录。
// 假服务器在 `fake-server.ts`：`basic` 一组工具，`paged` 的工具清单分两页，`broken` 起来就失败。
// `basic` 和 `broken` 会起一个孙进程并记下 PID：回收、重起、起来失败时都要收干净。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { IMAGE_KEEP_MS, pruneOldImages } from "../../../extras/mcp/call.ts";
import { ConnectError, talk } from "../../../extras/tools/client.ts";
import { listServer } from "../../../extras/mcp/gen.ts";

const MCP = join(import.meta.dirname, "..", "..", "..", "extras", "mcp").replace(/\\/g, "/");
const CALL = `${MCP}/call.ts`;
const FAKE = join(import.meta.dirname, "fake-server.ts").replace(/\\/g, "/");

let dir = "";
let home = "";
let work = "";
let pipe = "";
/** 假服务器起的孙进程把 PID 记在这里。 */
let fakeGrandchildren = "";
const saved: Record<string, string | undefined> = {};
/** 用过的管道名。清理时一个个查。 */
const pipes: string[] = [];
/** 见过的 relay、服务器和孙进程 PID。最后确认都死了。 */
const seen = new Set<number>();
const seenKids = new Set<number>();

/** 空闲和退出的时间设短：测试结束时 relay 要能自己退干净。 */
const SHORT = { TAU_MCP_IDLE_MS: "8000", TAU_MCP_EXIT_MS: "1500" };

const envOf = (proc: string, extra: Record<string, string> = {}): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  return { ...e, USERPROFILE: home, TAU_MCP_PIPE: pipe, TAU_PROCESS: proc, ...SHORT, ...extra };
};

/** 像内核那样运行 call.ts：工作目录、环境变量、标准输入的参数都和真的一样。 */
function call(server: string, tool: string, args: object = {}, proc = "p1", extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CALL, server, tool], { cwd: work, env: envOf(proc, extra), input: JSON.stringify(args), encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 同上，但是并发的：用来测两个调用同时拉起 relay。 */
function callAsync(server: string, tool: string, args: object, proc: string, extra: Record<string, string> = {}, to = pipe): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CALL, server, tool], { cwd: work, env: envOf(proc, { TAU_MCP_PIPE: to, ...extra }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("error", () => resolve({ code: null, out, err }));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(args));
  });
}

/** 假服务器起的那些孙进程的 PID。 */
function kids(): number[] {
  if (!existsSync(fakeGrandchildren)) return [];
  const pids = readFileSync(fakeGrandchildren, "utf8").split("\n").filter((s) => s !== "").map(Number);
  for (const pid of pids) seenKids.add(pid);
  return pids;
}

/** 给中转发一个请求。 */
async function ask(request: Record<string, unknown>, to = pipe): Promise<any> {
  let reply: unknown;
  await talk(to, request, (r) => {
    reply = r;
    return true;
  });
  if (reply === undefined) throw new Error("没有回复");
  if (typeof reply === "object" && reply !== null) {
    const pid = (reply as Record<string, unknown>)["pid"];
    if (typeof pid === "number") seen.add(pid);
    const instances = (reply as Record<string, unknown>)["instances"];
    if (Array.isArray(instances)) for (const i of instances) if (typeof i?.pid === "number") seen.add(i.pid);
  }
  return reply;
}

/** 拿状态；连不上（还没起或已经退了）返回 null。 */
async function status(to = pipe): Promise<any | null> {
  try {
    return await ask({ op: "status" }, to);
  } catch (e) {
    if (e instanceof ConnectError) return null;
    throw e;
  }
}

/** 只连一下、不说话：用来判断 relay 还在不在。发请求算“有人用它”，会让它晚点退出。 */
const connectable = (to: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(to);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const instanceOf = (s: any, proc: string): any => s.instances.find((i: any) => i.process === proc);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 这个 PID 还是不是我们的进程（relay、假服务器、孙进程的命令行里都有 `mcp`）。
 *  Windows 的 PID 复用很快：只看 `process.kill(pid, 0)` 会把别人刚拿到的 PID 当成它。 */
const aliveWith = (pid: number): boolean => {
  if (!alive(pid)) return false;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  return out.toLowerCase().includes("mcp");
};

/** 确认还是自己的进程才杀：全量测试并行跑，旧 PID 可能已经属于别人的进程。 */
const killOwn = (pid: number): void => {
  if (aliveWith(pid)) killPid(pid);
};

const killPid = (pid: number): void => {
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
};

/** 等到 `ok()` 为真，超时就报错。 */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (await ok()) return;
  throw new Error(`等不到：${what}`);
}

before(() => {
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith("TAU_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "tau-mcp-"));
  home = join(dir, "home");
  work = join(dir, "work");
  fakeGrandchildren = join(dir, "grandchildren.txt");
  mkdirSync(join(home, ".tau"), { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  const grandchildEnv = { FAKE_GRANDCHILD_FILE: fakeGrandchildren.replace(/\\/g, "/") };
  writeFileSync(
    join(work, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE, "basic"], env: grandchildEnv },
        broken: { command: process.execPath, args: [FAKE, "broken"], env: grandchildEnv },
        crash: { command: process.execPath, args: [FAKE, "crash"], env: grandchildEnv },
        noisy: { command: process.execPath, args: [FAKE, "noisy"], env: grandchildEnv },
        paged: { command: process.execPath, args: [FAKE, "paged"] },
      },
    }),
  );
  saved["USERPROFILE"] = process.env["USERPROFILE"];
  // 脚本用 os.homedir()：它读 USERPROFILE，所以数据目录落在临时目录。
  process.env["USERPROFILE"] = home;
  pipe = `\\\\.\\pipe\\tau-test-mcp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  pipes.push(pipe);
});

after(async () => {
  // 兜底：测试自己没等到退出时，这里收拾。
  for (const p of pipes) {
    const s = await status(p).catch(() => null);
    if (s === null) continue;
    for (const pid of [s.pid, ...s.instances.map((i: any) => i.pid)]) if (typeof pid === "number") killOwn(pid);
  }
  for (const pid of [...seen, ...seenKids]) killOwn(pid);
  if (saved["USERPROFILE"] === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = saved["USERPROFILE"];
  for (const [k, v] of Object.entries(saved)) {
    if (k === "USERPROFILE") continue;
    if (v !== undefined) process.env[k] = v;
  }
  // 结束的进程放手要一点时间；撤不掉就让它报错，别把残留藏起来。
  await sleep(300);
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

describe("relay 和 call", () => {
  test("第一次调用拉起 relay，之后的调用复用它；同一个进程的计数是 1、2", async () => {
    assert.equal(await status(), null, "开始前不该有 relay");
    const a = call("fake", "count");
    assert.equal(a.code, 0, a.err);
    assert.deepEqual(JSON.parse(a.out), [{ type: "text", text: "count=1" }]);
    const s1 = await status();
    assert.equal(s1.instances.length, 1);
    assert.equal(s1.instances[0].server, "fake");
    const b = call("fake", "count");
    assert.deepEqual(JSON.parse(b.out), [{ type: "text", text: "count=2" }]);
    const s2 = await status();
    assert.equal(s2.pid, s1.pid, "还是同一个 relay");
    assert.equal(s2.instances[0].pid, s1.instances[0].pid, "还是同一个服务器实例");
    assert.equal(s2.instances[0].workdir, work);
    assert.equal(kids().length, 1, "假服务器起了一个孙进程");
  });

  test("换一个 TAU_PROCESS：另起一个实例，计数从 1 开始", async () => {
    const r = call("fake", "count", {}, "p2");
    assert.deepEqual(JSON.parse(r.out), [{ type: "text", text: "count=1" }]);
    const s = await status();
    const mine = instanceOf(s, "p2");
    assert.ok(mine !== undefined, JSON.stringify(s));
    const other = instanceOf(s, "p1");
    if (other !== undefined) assert.notEqual(mine.pid, other.pid);
  });

  test("图片写成文件，输出里是 image 项，路径是 Windows 绝对路径", () => {
    const r = call("fake", "picture");
    assert.equal(r.code, 0, r.err);
    const items = JSON.parse(r.out);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "image");
    assert.match(items[0].path, /^[A-Za-z]:\\/);
    assert.match(items[0].path, new RegExp(`\\\\\\.tau\\\\extras\\\\mcp\\\\images\\\\p1\\\\\\d+-1\\.png$`));
    const bytes = readFileSync(items[0].path);
    assert.equal(bytes.subarray(0, 8).toString("latin1"), "\x89PNG\r\n\x1a\n");
  });

  test("isError：文字打到标准输出，退出码 1", () => {
    const r = call("fake", "boom");
    assert.equal(r.code, 1);
    assert.equal(r.out.trim(), "炸了：这是 isError 结果。");
  });

  test("不合入口条件的图片也存成文件，改成一行文字写出路径；超过 2 张的也改成文字", () => {
    const wide = JSON.parse(call("fake", "wide").out);
    assert.equal(wide.length, 1);
    assert.equal(wide[0].type, "text");
    assert.match(wide[0].text, /3000×8/);
    assert.match(wide[0].text, /2000 像素/);
    const widePath = /已存成 (.+?)\]$/.exec(wide[0].text)?.[1];
    assert.ok(widePath !== undefined && existsSync(widePath), wide[0].text);

    const huge = JSON.parse(call("fake", "huge").out);
    assert.equal(huge[0].type, "text");
    assert.match(huge[0].text, /超过 1\.5 MiB/);

    const many = JSON.parse(call("fake", "many").out);
    assert.deepEqual(
      many.map((i: any) => i.type),
      ["image", "image", "text"],
    );
    assert.match(many[2].text, /最多放 2 张/);
    assert.ok(existsSync(many[2].text.match(/已存成 (.+?)\]$/)[1]));
  });

  test("图片清理：7 天前的文件和变空的进程目录被删；未满和刚满 7 天的保留，目录不存在或不纯不出错；调用工具会顺手清理", () => {
    const root = join(dir, "prune-images");
    const now = Date.UTC(2026, 10, 20);
    assert.equal(pruneOldImages(root, now), 0);
    const dead = join(root, "dead");
    const live = join(root, "live");
    mkdirSync(dead, { recursive: true });
    mkdirSync(live, { recursive: true });
    const age = (file: string, ms: number): void => utimesSync(file, (now - ms) / 1000, (now - ms) / 1000);
    writeFileSync(join(dead, "1-1.png"), "old");
    age(join(dead, "1-1.png"), IMAGE_KEEP_MS + 1000);
    writeFileSync(join(live, "1-1.png"), "fresh");
    writeFileSync(join(live, "2-1.png"), "old");
    age(join(live, "2-1.png"), IMAGE_KEEP_MS + 1000);
    writeFileSync(join(live, "3-1.png"), "exact");
    age(join(live, "3-1.png"), IMAGE_KEEP_MS);
    writeFileSync(join(root, "stray.txt"), "x");
    assert.equal(pruneOldImages(root, now), 2);
    assert.ok(!existsSync(dead));
    assert.deepEqual(readdirSync(live).sort(), ["1-1.png", "3-1.png"]);
    assert.ok(existsSync(join(root, "stray.txt")));

    const oldDir = join(home, ".tau", "extras", "mcp", "images", "expired");
    mkdirSync(oldDir, { recursive: true });
    const expired = join(oldDir, "1-1.png");
    writeFileSync(expired, "old");
    const past = (Date.now() - IMAGE_KEEP_MS - 60_000) / 1000;
    utimesSync(expired, past, past);
    const r = call("fake", "count");
    assert.equal(r.code, 0, r.err);
    assert.ok(!existsSync(oldDir), "真实调用 call.ts 时顺手清掉了 7 天前的图片目录");
  });

  test("其它类型转成一行文字说明", () => {
    const items = JSON.parse(call("fake", "other").out);
    assert.equal(items[0].type, "text");
    assert.match(items[0].text, /有一项 resource/);
    assert.ok(items[0].text.includes("file:///E:/x.txt"));
    assert.equal(items[1].text, "后面还有一句。");
  });

  test("文本太长：截断并写明，标准输出不超过 30 KiB", () => {
    const r = call("fake", "long");
    assert.equal(r.code, 0, r.err);
    assert.ok(Buffer.byteLength(r.out, "utf8") <= 30 * 1024, `输出 ${r.out.length}`);
    assert.ok(r.out.includes("结果太长，已截断"));
    const items = JSON.parse(r.out);
    assert.equal(items[0].type, "text");
    assert.ok(items[0].text.startsWith("长长长"));
  });

  test("长文本要转义：按转义以后的大小截，不整份丢掉", () => {
    for (const tool of ["bigjson", "biglines"]) {
      const r = call("fake", tool);
      assert.equal(r.code, 0, r.err);
      assert.ok(Buffer.byteLength(r.out, "utf8") <= 30 * 1024, `${tool} 输出 ${Buffer.byteLength(r.out, "utf8")} 字节`);
      assert.ok(r.out.includes("结果太长，已截断"), `${tool} 应该写明截断了`);
      assert.ok(!r.out.includes("已全部省略"), `${tool} 不该整份丢掉`);
      const items = JSON.parse(r.out);
      assert.equal(items.length, 1, tool);
      assert.equal(items[0].type, "text", tool);
      // 前面还有内容，而且留了不少。
      assert.ok(items[0].text.length > 5_000, `${tool} 只留了 ${items[0].text.length} 字`);
      assert.ok(items[0].text.startsWith(tool === "bigjson" ? '{\n"items": [' : "line\nline"), items[0].text.slice(0, 40));
    }
  });

  test("list 处理分页，给出 name、description、inputSchema", async () => {
    const r = await ask({ op: "list", process: "p1", workdir: work, server: "paged" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      r.tools.map((t: any) => t.name),
      ["alpha", "beta", "gamma"],
    );
    assert.equal(r.tools[0].description, "第一个");
    assert.equal(r.tools[0].inputSchema.type, "object");
  });

  test("服务器自己退出了：下次调用重起，带提示，状态从头开始", async () => {
    // 先让它有一个实例：前面测试之间可能已经被空闲回收了。
    call("fake", "count");
    const s = await status();
    const pid = instanceOf(s, "p1").pid;
    assert.equal(typeof pid, "number");
    killPid(pid);
    await until("relay 发现服务器没了", async () => instanceOf(await status(), "p1")?.dead === true);
    assert.equal(alive(pid), false);

    const r = call("fake", "count");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [
      { type: "text", text: "服务器重启过，之前的状态没了。" },
      { type: "text", text: "count=1" },
    ]);
    // 重起以后的调用不再带这句提示。
    const again = JSON.parse(call("fake", "count").out);
    assert.deepEqual(again, [{ type: "text", text: "count=2" }]);
  });

  test("起服务器失败：起来一半的服务器和它的孙进程都收掉", async () => {
    const before = kids().length;
    const r = call("broken", "count");
    assert.equal(r.code, 1);
    assert.match(r.err, /起不来 MCP 服务器 broken/);
    const started = kids().slice(before);
    assert.equal(started.length, 1, "broken 服务器起过一个孙进程");
    await until("孙进程被收掉", () => !alive(started[0]!));
  });

  test("配置没有、服务器名不对：清楚的错误，退出码 1", () => {
    const empty = join(dir, "no-config");
    mkdirSync(empty, { recursive: true });
    const r = spawnSync(process.execPath, [CALL, "fake", "count"], { cwd: empty, env: envOf("p1"), input: "{}", encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /找不到 MCP 配置文件/);
    assert.ok(r.stderr.includes(join(empty, ".pi", "mcp.json")), r.stderr);

    const bad = call("nope", "count");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /没有服务器 nope/);
    assert.match(bad.err, /有：fake、broken、crash、noisy、paged/);

    const notStdio = join(dir, "http-config");
    mkdirSync(join(notStdio, ".pi"), { recursive: true });
    writeFileSync(join(notStdio, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { web: { type: "http", command: "x" } } }));
    const w = spawnSync(process.execPath, [CALL, "web", "count"], { cwd: notStdio, env: envOf("p1"), input: "{}", encoding: "utf8" });
    assert.equal(w.status, 1);
    assert.match(w.stderr, /只支持 stdio/);

    const noProc = spawnSync(process.execPath, [CALL, "fake", "count"], { cwd: work, env: { ...envOf("p1"), TAU_PROCESS: "" }, input: "{}", encoding: "utf8" });
    assert.equal(noProc.status, 1);
    assert.match(noProc.stderr, /没有 TAU_PROCESS/);
  });

  test("两个调用同时拉起：只有一个 relay 占住管道，两个调用都成功", async () => {
    const race = `${pipe}-race`;
    pipes.push(race);
    const [a, b] = await Promise.all([callAsync("fake", "count", {}, "r1", {}, race), callAsync("fake", "count", {}, "r1", {}, race)]);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    const counts = [JSON.parse(a.out)[0].text, JSON.parse(b.out)[0].text].sort();
    assert.deepEqual(counts, ["count=1", "count=2"]);
    const s = await ask({ op: "status" }, race);
    assert.equal(s.instances.length, 1);
  });

  test("空闲回收：实例的服务器和孙进程都没了；没有实例以后 relay 也退出", async () => {
    const short = `${pipe}-idle`;
    pipes.push(short);
    // 窗口要够宽：测试机同时跑别的文件时，一次调用可能超过 1 秒。
    const quick = { TAU_MCP_IDLE_MS: "3000", TAU_MCP_EXIT_MS: "1000" };
    const before = kids().length;
    const r = await callAsync("fake", "count", {}, "idle1", quick, short);
    assert.equal(r.code, 0, r.err);
    const s = await ask({ op: "status" }, short);
    assert.equal(s.instances.length, 1);
    const serverPid = s.instances[0].pid;
    const started = kids().slice(before);
    assert.equal(started.length, 1);

    await until("实例被回收", async () => (await status(short))?.instances.length === 0);
    await until("服务器进程没了", () => !alive(serverPid));
    await until("孙进程没了", () => !alive(started[0]!));
    await until("relay 自己退出", async () => !(await connectable(short)));
  });

  test("列工具时一直读服务器的 stderr：写满 300 KB 也不卡", async () => {
    const r = await listServer(work, "noisy");
    assert.ok(
      r.tools.some((t) => t.name === "count"),
      JSON.stringify(r.tools.map((t) => t.name)),
    );
    // 服务器进程收掉了（gen 里 finally 关的）。
    const r2 = await listServer(work, "noisy");
    assert.ok(r2.tools.length > 0);
  });

  test("起不来的错误里有 stderr 的尾巴：调用和列工具都看得到", async () => {
    const r = call("crash", "count");
    assert.equal(r.code, 1);
    assert.match(r.err, /No module named 'mcp'/);
    await assert.rejects(
      () => listServer(work, "crash"),
      (e: Error) => {
        assert.match(e.message, /起不来 MCP 服务器 crash/);
        assert.match(e.message, /No module named 'mcp'/);
        return true;
      },
    );
  });

  test("起服务器要几秒时，relay 不会在调用中途退出", async () => {
    const p = `${pipe}-slowstart`;
    pipes.push(p);
    // EXIT_MS 很短：起服务器的这几秒里实例表还是空的，relay 不能在这时退。
    const env = { TAU_MCP_PIPE: p, TAU_MCP_IDLE_MS: "60000", TAU_MCP_EXIT_MS: "500", FAKE_START_DELAY_MS: "2500" };
    const r = await callAsync("fake", "count", {}, "slow1", env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [{ type: "text", text: "count=1" }]);
    const s = await ask({ op: "status" }, p);
    assert.equal(s.instances.length, 1);
  });

  test("status 不算活动：一直问也不会推迟 relay 退出", async () => {
    const p = `${pipe}-statusidle`;
    pipes.push(p);
    const quick = { TAU_MCP_IDLE_MS: "3000", TAU_MCP_EXIT_MS: "1000" };
    const r = await callAsync("fake", "count", {}, "s1", quick, p);
    assert.equal(r.code, 0, r.err);
    let polls = 0;
    for (const stopAt = Date.now() + 15_000; Date.now() < stopAt; await sleep(100)) {
      const s = await ask({ op: "status" }, p).catch(() => null);
      if (s === null) break;
      polls++;
    }
    assert.equal(await connectable(p), false, "一直问 status，relay 也应该按空闲时间退");
    assert.ok(polls > 3, `问过 ${polls} 次`);
  });

  test("测试结束时没有留下 relay、服务器和孙进程", async () => {
    const pids = [...seen];
    const started = kids();
    assert.ok(pids.length > 0);
    assert.ok(started.length > 0);
    // 不杀，等它们自己到时间退出：空闲回收、relay 退出都要走一遍。
    await until("relay 和服务器都退了", () => pids.every((pid) => !aliveWith(pid)), 60_000);
    await until("孙进程都没了", () => started.every((pid) => !aliveWith(pid)), 30_000);
    // 日志里能看到起过、关过：出问题时有线索。
    const log = readFileSync(join(home, ".tau", "extras", "mcp", "relay.log"), "utf8");
    assert.match(log, /起了服务器 fake/);
  });
});
