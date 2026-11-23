// 界面的重启、旧代码提示（extras/gui）。全部用临时目录、临时管道和假的 runner，不起停真的进程。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { createServiceControl, launchArgv, newestMtime, restartCommand } from "../../../extras/gui/bridge/service.ts";
import type { ServiceOps } from "../../../extras/gui/bridge/service.ts";
import { confirmText, staleOf } from "../../../extras/gui/web/lib/service.js";
import { firstLetterText } from "../../../extras/gui/web/lib/titles.js";
import { plainFirstLine, plainLine } from "../../../extras/gui/web/lib/plain.js";
import { describeNow } from "../../../extras/gui/web/lib/messages.js";
import { firstLine } from "../../../extras/gui/web/lib/notify.js";
import { normalizeState, prunePatch } from "../../../extras/gui/web/lib/state.js";

const pipeName = () => `\\\\.\\pipe\\tau-test-svc-${process.pid}-${Math.random().toString(16).slice(2)}`;

function call(port: number, path: string, body: unknown): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    }).on("error", reject);
  });
}

/** 假服务：`ps` 回给定的阶段，别的请求不回。 */
async function fakePs(t: TestContext, tags: string[]): Promise<string> {
  const pipe = pipeName();
  const open = new Set<import("node:net").Socket>();
  const srv = createServer((s) => {
    open.add(s);
    s.on("data", () => s.write(`${JSON.stringify({ type: "ps", processes: tags.map((tag) => ({ self: { phase: { tag } } })) })}\n`));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(pipe, r));
  t.after(() => new Promise<void>((r) => (open.forEach((s) => s.destroy()), srv.close(() => r()))));
  return pipe;
}

function fakeOps(started: number | null) {
  const calls = { find: 0, restart: [] as any[] };
  const ops: ServiceOps = {
    serviceStartedAt: async () => (calls.find++, started),
    restart: (a) => void calls.restart.push(a),
  };
  return { ops, calls };
}

function tmpRepo(t: TestContext): string {
  const repo = mkdtempSync(join(tmpdir(), "tau-gui-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const d of ["src/kernel", "extras/gui/bridge", "extras/tools", "node_modules/x"]) mkdirSync(join(repo, d), { recursive: true });
  return repo;
}
const touch = (file: string, ms: number) => {
  writeFileSync(file, "x");
  utimesSync(file, new Date(ms), new Date(ms));
};

test("newestMtime：取目录树里最新的，跳过 node_modules 和不认的扩展名，不存在的是 0", (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "a.ts"), 1000);
  touch(join(repo, "src", "kernel", "b.ts"), 3000);
  touch(join(repo, "src", "notes.md"), 9000);
  touch(join(repo, "node_modules", "x", "i.js"), 8000);
  assert.equal(newestMtime([join(repo, "src")], [".ts"]), 3000);
  assert.equal(newestMtime([repo, join(repo, "none")], [".ts"]), 3000);
  assert.equal(newestMtime([join(repo, "none")]), 0);
});

test("/api/service：服务和桥的启动时间对比源码的最新修改时间；有几个进程在跑", async (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "kernel", "a.ts"), 5000);
  touch(join(repo, "extras", "gui", "bridge", "s.ts"), 7000);
  touch(join(repo, "extras", "tools", "t.ts"), 2000);
  const pipe = await fakePs(t, ["idle", "awaitingModel", "awaitingTool"]);
  const f = fakeOps(4000);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeStartedAt: 6000 });
  t.after(() => b.close());
  const r = await call(b.port, "/api/service", {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    service: { up: true, startedAt: 4000, stale: true },
    bridge: { startedAt: 6000, stale: true },
    running: 2,
    newestSource: 5000,
    newestBridge: 7000,
  });
  assert.deepEqual(staleOf(r.json), { service: true, bridge: true });
});

test("/api/service：不比源码旧就不算旧；服务不在时没有启动时间和进程数，也不查进程", async (t) => {
  const repo = tmpRepo(t);
  touch(join(repo, "src", "a.ts"), 5000);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pipe = await fakePs(t, []);
  const f = fakeOps(6000);
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeStartedAt: 1 });
  t.after(() => b.close());
  const r = await call(b.port, "/api/service", {});
  assert.deepEqual(r.json.service, { up: true, startedAt: 6000, stale: false });
  assert.equal(r.json.bridge.stale, false);
  assert.equal(r.json.running, 0);

  const down = fakeOps(6000);
  const b2 = await createBridge({ port: 0, home, pipe: pipeName(), repo, serviceOps: down.ops });
  t.after(() => b2.close());
  const r2 = await call(b2.port, "/api/service", {});
  assert.deepEqual(r2.json.service, { up: false, startedAt: null, stale: false });
  assert.equal(r2.json.running, null);
  assert.equal(down.calls.find, 0);
  assert.deepEqual(staleOf(r2.json), { service: false, bridge: false });
});

test("服务启动时间的查询结果缓存一段时间，重启以后立刻作废", async (t) => {
  const repo = tmpRepo(t);
  const pipe = await fakePs(t, []);
  const f = fakeOps(1000);
  let now = 0;
  const c = createServiceControl({ pipe, repo, ops: f.ops, cacheMs: 30_000, now: () => now });
  await c.status();
  now = 29_000;
  await c.status();
  assert.equal(f.calls.find, 1);
  now = 31_000;
  await c.status();
  assert.equal(f.calls.find, 2);
  await c.restart({ service: true, bridge: false, force: false, bridgeArgs: [] });
  await c.status();
  assert.equal(f.calls.find, 3);
});

test("/api/service/restart：有进程在跑又没 force 回 409 和个数，什么都不做；force 才动；只重启桥不拦", async (t) => {
  const repo = tmpRepo(t);
  const pipe = await fakePs(t, ["awaitingModel", "idle", "awaitingTool"]);
  const f = fakeOps(1);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops, bridgeArgs: ["--port", "4317"] });
  t.after(() => b.close());

  const busy = await call(b.port, "/api/service/restart", { service: true });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.running, 2);
  assert.equal(f.calls.restart.length, 0);

  const forced = await call(b.port, "/api/service/restart", { service: true, force: true });
  assert.equal(forced.status, 202);
  assert.deepEqual(f.calls.restart.at(-1), { service: true, bridge: false, bridgePid: process.pid, bridgeArgs: ["--port", "4317"], repo });

  const bridgeOnly = await call(b.port, "/api/service/restart", { bridge: true });
  assert.equal(bridgeOnly.status, 202);
  assert.equal(f.calls.restart.at(-1).service, false);
  assert.equal(f.calls.restart.at(-1).bridge, true);

  assert.equal((await call(b.port, "/api/service/restart", {})).status, 400);
  assert.equal((await call(b.port, "/api/service/restart", { service: "yes" })).status, 400);
  assert.equal((await call(b.port, "/api/service/restart", { bridge: false, service: false })).status, 400);
  assert.equal(f.calls.restart.length, 2);
});

test("/api/service/restart：没有进程在跑，或者服务根本不在，直接 202", async (t) => {
  const repo = tmpRepo(t);
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const pipe of [await fakePs(t, ["idle"]), pipeName()]) {
    const f = fakeOps(1);
    const b = await createBridge({ port: 0, home, pipe, repo, serviceOps: f.ops });
    t.after(() => b.close());
    assert.equal((await call(b.port, "/api/service/restart", { service: true })).status, 202);
    assert.equal(f.calls.restart.length, 1);
  }
});

test("restartCommand：脚本路径加引号，-BridgeArgs 整体传给 restart.ps1，最后是 Start-Process", () => {
  const argv = restartCommand("C:\\repo path\\extras\\gui\\restart.ps1", { service: true, bridge: true, bridgePid: 1234, bridgeArgs: ["--port", "4317"] });
  assert.deepEqual(argv.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  const line = argv[3] ?? "";
  assert.equal(
    line,
    `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\repo path\\extras\\gui\\restart.ps1" -Service -Bridge -BridgePid 1234 -BridgeArgs "--port 4317"' -WindowStyle Hidden`,
  );
  const bridgeOnly = restartCommand("C:\\r\\restart.ps1", { service: false, bridge: true, bridgePid: 9, bridgeArgs: [] });
  assert.ok(!(bridgeOnly[3] ?? "").includes("-Service"));
  assert.ok((bridgeOnly[3] ?? "").includes('-BridgeArgs ""'));
});

test("launchArgv：父进程退出以后，Start-Process 起的孙进程照样跑完", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const out = join(dir, "out.txt");
  const script = join(dir, "write.ps1");
  writeFileSync(script, `Set-Content -Path '${out}' -Value ok`, "utf8");
  const argv = launchArgv(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
  // 中间这层 node 相当于桥：等 powershell 做完 Start-Process 退出，它也退出，孙进程得自己活下来。
  // 不能按固定时间退：机器忙时 powershell 起来要好几秒，没做完就被一起带走（非 detached 的子进程会被带走）。
  // 30 秒是兜底；真实的桥也活到这几百毫秒，restart.ps1 最后才停桥。
  const js = `const{spawn}=require("node:child_process");const c=spawn("powershell.exe",${JSON.stringify(argv)},{stdio:"ignore",windowsHide:true});c.on("error",()=>process.exit(0));c.on("exit",()=>process.exit(0));setTimeout(()=>process.exit(0),30000);`;
  spawn(process.execPath, ["-e", js], { stdio: "ignore" }).unref();
  for (let i = 0; i < 450 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(out), true, "孙进程没写出文件：Start-Process 这条链断了");
  assert.equal(readFileSync(out, "utf8").trim(), "ok");
});

test("静态文件：/web/ 每次都要校验（no-cache），vendor 照旧缓存", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "tau-gui-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const b = await createBridge({ port: 0, home, pipe: pipeName() });
  t.after(() => b.close());
  const js = await get(b.port, "/web/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["cache-control"], "no-cache");
  assert.equal((await get(b.port, "/web/styles.css")).headers["cache-control"], "no-cache");
  const v = await get(b.port, "/vendor/preact/package.json");
  if (v.status === 200) assert.match(String(v.headers["cache-control"]), /max-age/);
});

test("页面的横幅文字：确认框写明会中断几个进程和“被中断”", () => {
  assert.match(confirmText(3), /3 个在跑的进程/);
  assert.match(confirmText(3), /被中断/);
  assert.match(confirmText(3), /不自动重做/);
  assert.deepEqual(staleOf(null), { service: false, bridge: false });
  assert.deepEqual(staleOf({ service: { up: false, stale: true }, bridge: { stale: false } }), { service: false, bridge: false });
});

test("第一封信的正文：纯文本和带信头的用户消息都能取，不是用户消息是空串", () => {
  assert.equal(firstLetterText({ role: "user", content: "你好\n第二行", timestamp: 1 }), "你好\n第二行");
  assert.equal(firstLetterText({ role: "assistant", content: [], timestamp: 1 }), "");
  assert.equal(firstLetterText(null), "");
});

test("界面数据：标题和来源读得出；进程被清掉后它名下的记录也清掉", () => {
  const g = normalizeState({ titles: { a: "甲", b: "乙" }, forkedFrom: { b: "a" }, mine: ["a", "b"], current: { x: "a" } });
  assert.deepEqual(g.titles, { a: "甲", b: "乙" });
  assert.deepEqual(normalizeState({}).titles, {});
  assert.deepEqual(prunePatch(g, (id) => id === "a"), { mine: ["b"], current: {} });
});

test("Markdown 小修：去掉行首的标题、列表、引用标记和行内的 ** 与反引号", () => {
  assert.equal(plainLine("## 方案"), "方案");
  assert.equal(plainLine("###### 小标题"), "小标题");
  assert.equal(plainLine("- 第一条"), "第一条");
  assert.equal(plainLine("* 第一条"), "第一条");
  assert.equal(plainLine("1. 先做这个"), "先做这个");
  assert.equal(plainLine("2) 再做这个"), "再做这个");
  assert.equal(plainLine("> 引用的话"), "引用的话");
  assert.equal(plainLine("> - 引用里的列表"), "引用里的列表");
  assert.equal(plainLine("- [ ] 待办"), "待办");
  assert.equal(plainLine("**重点**：改 `foo.ts` 里的 **bar**"), "重点：改 foo.ts 里的 bar");
  assert.equal(plainLine("2026 年的计划"), "2026 年的计划");
  assert.equal(plainLine("#标签不是标题"), "#标签不是标题");
  assert.equal(plainLine("a * b"), "a * b");
  assert.equal(plainFirstLine("\n```ts\nconst a = 1\n```"), "ts");
  assert.equal(plainFirstLine("---\n\n## 方案\n细节"), "方案");
  assert.equal(plainFirstLine("   \n\n"), "");
});

test("Markdown 小修：“正在做”和通知用的第一行不再露出标记", () => {
  const msg = { role: "assistant", content: [{ type: "text", text: "## 方案\n**先**读 `a.ts`" }], timestamp: 1 } as any;
  assert.equal(describeNow([msg]), "方案");
  assert.equal(firstLine("**做完了**：改了 `x`"), "做完了：改了 x");
});
