// HTTP 桥（extras/gui/bridge）：每条检查的反例；转发对着真的测试服务；预设、git、后台命令、界面数据。
// 全部用临时目录和测试管道，不碰真的 ~/.tau。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import type { BridgeOptions } from "../../../extras/gui/bridge/server.ts";
import { DIFF_MAX_BYTES, runGit } from "../../../extras/gui/bridge/git.ts";
import { parseExit } from "../../../extras/gui/bridge/bg.ts";
import { seenFromInspect } from "../../../extras/gui/web/lib/derive.js";
import { pendingOf, sessionInfo } from "../../../extras/gui/web/lib/session.js";
import { canHandoff, HANDOFF_LETTER, parseUser } from "../../../extras/gui/web/lib/messages.js";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

interface Opts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** 不结束请求：用来证明服务在读正文之前就回了。 */
  noEnd?: boolean;
}

function raw(port: number, path: string, o: Opts = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        req.destroy();
      });
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    if (o.noEnd) req.flushHeaders();
    else req.end();
  });
}

const JSON_H = { "Content-Type": "application/json" };

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return raw(port, path, { method: "POST", headers: { ...JSON_H, ...headers }, body: JSON.stringify(body) });
}

interface Env {
  dir: string;
  home: string;
  work: string;
  port: number;
  gitCalls: string[][];
  server: http.Server;
  /** 预设里能写的模型：带服务时是 faux 的，否则随便写。 */
  model: string;
}

const MISSING_PIPE = () => `\\\\.\\pipe\\tau-test-gui-${process.pid}-${Math.random().toString(16).slice(2)}`;

/** `service: true`：桥连一个真的测试服务（读预设经它的 `check`）。 */
async function setupBridge(t: TestContext, o: Partial<BridgeOptions> & { service?: boolean } = {}): Promise<Env> {
  const { service, ...opts } = o;
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(work);
  let pipe = MISSING_PIPE();
  let model = "x/m";
  if (service) {
    const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    model = `${faux.getModel().provider}/m`;
    const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, "presets"), toolsDir: join(home, "tools"), models, memory: sqliteMemory });
    t.after(() => svc.close());
  }
  const gitCalls: string[][] = [];
  const bridge = await createBridge({
    port: 0,
    home,
    pipe,
    git: async (args) => {
      gitCalls.push(args);
      return runGit(args);
    },
    pickFolder: async () => {
      throw new Error("测试里不该弹对话框");
    },
    ...opts,
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, home, work, port: bridge.port, gitCalls, server: bridge.server, model };
}

function writePreset(env: Env, id: string, workdir = env.work, model = env.model, tools = "read"): void {
  writeFileSync(join(env.home, "presets", `${id}.md`), `---
workdir: ${workdir}
model: ${model}
tools: ${tools}
---
提示词。
`);
}

// 检查的反例

test("Host：所有请求（含 GET）都查；不认的名字、错的端口、没有端口都 403；额外的 --host 名字可用", async (t) => {
  const e = await setupBridge(t, { hosts: ["Box.tail1234.ts.net"] });
  for (const host of ["evil.com", `127.0.0.1:${e.port + 1}`, "127.0.0.1", "localhost", `evil.com:${e.port}`]) {
    assert.equal((await raw(e.port, "/", { headers: { Host: host } })).status, 403, host);
    assert.equal((await post(e.port, "/api/presets", {}, { Host: host })).status, 403, host);
  }
  assert.equal((await raw(e.port, "/", { headers: { Host: `localhost:${e.port}` } })).status, 200);
  assert.equal((await raw(e.port, "/", { headers: { Host: "box.tail1234.ts.net" } })).status, 200);
  assert.equal((await post(e.port, "/api/presets", {}, { Host: "box.tail1234.ts.net", Origin: "https://box.tail1234.ts.net" })).status, 200);
});

test("Origin：按完整的源比较；null、别的站、少端口、协议不对都 403；同源放行", async (t) => {
  const e = await setupBridge(t);
  for (const origin of ["null", "http://evil.com", "http://127.0.0.1", `http://127.0.0.1:${e.port + 1}`, `https://127.0.0.1:${e.port}`, `http://127.0.0.1:${e.port}.evil.com`, ""]) {
    assert.equal((await post(e.port, "/api/presets", {}, { Origin: origin })).status, 403, JSON.stringify(origin));
    assert.equal((await raw(e.port, "/", { headers: { Origin: origin } })).status, 403, JSON.stringify(origin));
  }
  assert.equal((await post(e.port, "/api/presets", {}, { Origin: `http://127.0.0.1:${e.port}` })).status, 200);
  assert.equal((await post(e.port, "/api/presets", {}, { Origin: `http://localhost:${e.port}` })).status, 200);
});

test("方法：接口只收 POST，别的方法 405；静态只收 GET", async (t) => {
  const e = await setupBridge(t);
  for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
    for (const path of ["/", "/api/presets", "/web/index.html"]) {
      const r = await raw(e.port, path, { method, headers: JSON_H });
      assert.equal(r.status, 405, `${method} ${path}`);
    }
  }
  assert.equal((await raw(e.port, "/api/presets")).status, 405, "GET 接口");
  assert.equal((await raw(e.port, "/", { method: "POST", headers: JSON_H, body: "{}" })).status, 404, "POST 页面");
});

test("Content-Type：不是 application/json 的 POST 一律 415，不读正文", async (t) => {
  const e = await setupBridge(t);
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json"]) {
    assert.equal((await raw(e.port, "/api/presets", { method: "POST", headers: { "Content-Type": ct }, body: "{}" })).status, 415, ct);
  }
  assert.equal((await raw(e.port, "/api/presets", { method: "POST", body: "{}" })).status, 415, "没有 Content-Type");
  assert.equal((await raw(e.port, "/api/presets", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{}" })).status, 200);
});

test("正文：太大 413（先查头，不等正文）；不是 JSON 对象 400", async (t) => {
  const e = await setupBridge(t);
  // 只声明很大、一个字节也不发：服务读正文之前就回了。
  const early = await raw(e.port, "/api/presets", { method: "POST", headers: { ...JSON_H, "Content-Length": "99999999" }, noEnd: true });
  assert.equal(early.status, 413);
  // 分块、没有 Content-Length：读到超限就回。
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const chunked = await raw(e.port, "/api/presets", { method: "POST", headers: { ...JSON_H, "Transfer-Encoding": "chunked" }, body: big }).catch((err: NodeJS.ErrnoException) => ({ status: err.code ?? 0 }));
  assert.ok(chunked.status === 413 || chunked.status === "ECONNRESET", String(chunked.status));
  for (const body of ["不是 json", "[]", "7", "null", ""]) {
    const r = await raw(e.port, "/api/presets", { method: "POST", headers: JSON_H, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.json.error, "string");
  }
  assert.equal((await post(e.port, "/api/nope", {})).status, 404);
});

test("静态文件：路径穿越、编码的 ..、反斜杠、盘符、NUL 都进不去；不在名单里的包不送", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-static-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "web", "sub"), { recursive: true });
  mkdirSync(join(dir, "vendor", "preact"), { recursive: true });
  mkdirSync(join(dir, "vendor", "htm"), { recursive: true });
  mkdirSync(join(dir, "vendor", "typescript"), { recursive: true });
  const html = readFileSync(join(import.meta.dirname, "..", "..", "..", "extras", "gui", "web", "index.html"));
  writeFileSync(join(dir, "web", "index.html"), html);
  writeFileSync(join(dir, "web", "ok.js"), "export const ok = 1;\n");
  writeFileSync(join(dir, "web", "sub", "a.css"), "a{}\n");
  writeFileSync(join(dir, "secret.txt"), "TOP-SECRET");
  writeFileSync(join(dir, "web", "inner.txt"), "inner");
  writeFileSync(join(dir, "vendor", "preact", "ok.js"), "preact");
  writeFileSync(join(dir, "vendor", "htm", "ok.js"), "htm");
  writeFileSync(join(dir, "vendor", "typescript", "ok.js"), "ts");
  writeFileSync(join(dir, "vendor", "secret.txt"), "TOP-SECRET");
  const e = await setupBridge(t, { webDir: join(dir, "web"), vendorDir: join(dir, "vendor") });

  const ok = await raw(e.port, "/web/ok.js");
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers["content-type"]), /^text\/javascript/);
  assert.equal((await raw(e.port, "/web/sub/a.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await raw(e.port, "/vendor/preact/ok.js")).text, "preact");
  assert.equal((await raw(e.port, "/vendor/htm/ok.js")).text, "htm");

  const bad = [
    "/web/../secret.txt",
    "/web/sub/../../secret.txt",
    "/web/%2e%2e/secret.txt",
    "/web/%2E%2E%2Fsecret.txt",
    "/web/..%2fsecret.txt",
    "/web/..%5csecret.txt",
    "/web/..\\secret.txt",
    "/web/sub\\..\\..\\secret.txt",
    "/web/C:/Windows/win.ini",
    "/web/C%3A/Windows/win.ini",
    "/web/ok.js%00.txt",
    "/web/%00",
    "/web//secret.txt",
    "/web/./ok.js",
    "/web/%",
    "/web/",
    "/web",
    "/vendor/typescript/ok.js",
    "/vendor/preact/../typescript/ok.js",
    "/vendor/preact/../secret.txt",
    "/vendor/preact/%2e%2e/secret.txt",
    "/vendor/secret.txt",
    "/vendor/",
    "/vendor/preactx/ok.js",
    "/vendor/@fontsource-variable/other/ok.js",
    "/secret.txt",
    "/api",
  ];
  for (const p of bad) {
    const r = await raw(e.port, p);
    assert.ok(r.status === 404 || r.status === 405, `${p} → ${r.status}`);
    assert.ok(!r.text.includes("TOP-SECRET"), p);
  }
});

test("安全头：CSP 的 script-src 带 import map 的哈希；各项指令齐全；nosniff；/api/tau 的响应不设 Content-Length", async (t) => {
  const e = await setupBridge(t);
  const r = await raw(e.port, "/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  const csp = String(r.headers["content-security-policy"]);
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(r.text)?.[1];
  assert.ok(map);
  const hash = `'sha256-${createHash("sha256").update(map).digest("base64")}'`;
  const directives = new Map(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
  assert.equal(directives.get("script-src"), `'self' ${hash}`);
  assert.equal(directives.get("style-src"), "'self' 'unsafe-inline'");
  assert.equal(directives.get("img-src"), "'self' data: blob:");
  assert.equal(directives.get("font-src"), "'self'");
  assert.equal(directives.get("connect-src"), "'self'");
  assert.equal(directives.get("frame-ancestors"), "'none'");
  assert.equal(directives.get("base-uri"), "'none'");
  assert.equal(directives.get("form-action"), "'none'");
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  const api = await post(e.port, "/api/presets", {});
  assert.equal(api.headers["x-content-type-options"], "nosniff");
  assert.ok(api.headers["content-security-policy"]);
  const unavailable = await post(e.port, "/api/tau", { op: "ps" });
  assert.equal(unavailable.status, 503);
});

test("只在 127.0.0.1 上监听", async (t) => {
  const e = await setupBridge(t);
  assert.equal((e.server.address() as { address: string }).address, "127.0.0.1");
});

// 转发

async function setupService(t: TestContext, fauxOptions: RegisterFauxProviderOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-svc-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  const presetsDir = join(home, "presets");
  mkdirSync(presetsDir, { recursive: true });
  mkdirSync(work);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }], ...fauxOptions });
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(presetsDir, "p.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: read\n---\n你是测试助手。\n`);
  const pipe = `\\\\.\\pipe\\tau-test-gui-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir, toolsDir: join(dir, "tools"), models, memory: sqliteMemory });
  const open = new Set<Socket>();
  svc.server.on("connection", (s: Socket) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  const bridge = await createBridge({ port: 0, home, pipe });
  t.after(async () => {
    await bridge.close();
    for (const s of open) s.destroy();
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { faux, svc, port: bridge.port, open, pipe, work, home, model: `${faux.getModel().provider}/m` };
}

function lines(res: Res): any[] {
  return res.text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

async function until(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(10)) if (Date.now() > end) throw new Error(`等了 ${ms} 毫秒，仍然没有：${what}`);
}

test("转发：ps、start 加最终回复、history；/api/tau 的响应是分块的 ndjson", async (t) => {
  const s = await setupService(t);
  const ps0 = await post(s.port, "/api/tau", { op: "ps" });
  assert.equal(ps0.status, 200);
  assert.match(String(ps0.headers["content-type"]), /^application\/x-ndjson/);
  assert.equal(ps0.headers["content-length"], undefined);
  assert.equal(ps0.headers["transfer-encoding"], "chunked");
  assert.deepEqual(lines(ps0), [{ type: "ps", processes: [] }]);

  s.faux.setResponses([fauxAssistantMessage(fauxText("你好，我是回复。"))]);
  const started = lines(await post(s.port, "/api/tau", { op: "start", preset: "p", text: "hi" }));
  assert.equal(started[0].type, "receipt");
  assert.deepEqual(started.at(-1), { type: "final", reply: "你好，我是回复。", ended: "done" });
  const id = started[0].process;

  const ps1 = lines(await post(s.port, "/api/tau", { op: "ps" }));
  assert.equal(ps1[0].processes.length, 1);
  assert.equal(ps1[0].processes[0].self.phase.tag, "idle");
  const hist = lines(await post(s.port, "/api/tau", { op: "history", process: id }));
  assert.equal(hist.at(-1).type, "end");
  assert.ok(hist.some((m) => m.type === "message"));

  // 服务校验不过的请求：服务回 error 行，桥原样转回。
  const bad = lines(await post(s.port, "/api/tau", { op: "send", process: 7 }));
  assert.equal(bad[0].type, "error");
  // 桥只查 op 是字符串。
  assert.equal((await post(s.port, "/api/tau", { nope: 1 })).status, 400);
  assert.equal((await post(s.port, "/api/tau", { op: 5 })).status, 400);
});

test("转发：inspect 读到进程的会话快照，预设文件之后改了也不变（界面据此归类）", async (t) => {
  const s = await setupService(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
  const id: string = lines(await post(s.port, "/api/tau", { op: "start", preset: "p", text: "hi" }))[0].process;
  const before = lines(await post(s.port, "/api/tau", { op: "inspect", process: id }));
  assert.deepEqual(seenFromInspect(before[0]), { workdir: s.work, tools: ["read"], input: before[0].process.preset.input, threshold: before[0].limits.threshold, memory: false, model: s.model });
  // 预设文件改了：新进程读到新的，老进程的快照不变。
  writeFileSync(join(s.home, "presets", "p.md"), `---\nworkdir: ${s.home}\nmodel: ${s.model}\ntools: read, memory\n---\n新的。\n`);
  const all = lines(await post(s.port, "/api/tau", { op: "inspect" }));
  assert.deepEqual(seenFromInspect(all[0]), { workdir: s.work, tools: ["read"], input: all[0].process.preset.input, threshold: all[0].limits.threshold, memory: false, model: s.model });
  assert.equal(all.at(-1).type, "inspected");
  assert.deepEqual((await post(s.port, "/api/presets", {})).json.presets[0].tools, ["read", "memory"]);
});

test("转发：reconfigure 原样转发，回执 reconfigured 带 pending；inspect 读到 next，ps 的 self 带 pending；revert 取消；界面据此造表的初值", async (t) => {
  const s = await setupService(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
  const id: string = lines(await post(s.port, "/api/tau", { op: "start", preset: "p", text: "hi" }))[0].process;
  const tau = async (req: Record<string, unknown>) => lines(await post(s.port, "/api/tau", req));
  const rec = async () => (await tau({ op: "inspect", process: id }))[0];

  // 调用参数立即生效，没有待换配置；界面的阈值（limits.threshold）跟着快照变。
  const t0 = seenFromInspect(await rec())!.threshold;
  assert.deepEqual(await tau({ op: "reconfigure", process: id, fields: { thinking: "low", handoff: 50000 } }), [{ type: "reconfigured", process: id, pending: false }]);
  const a = await rec();
  assert.deepEqual([a.process.preset.thinking, a.process.preset.handoff, a.process.next], ["low", 50000, undefined]);
  const f = seenFromInspect(a)!;
  assert.deepEqual([f.thinking, f.handoff, f.threshold !== t0], ["low", 50000, true], "刻线按新的 handoff 算");
  assert.equal(sessionInfo(a)!.pending, false);

  // 结构性字段：段里已有助手消息，存成待换配置，当前快照不变。
  assert.deepEqual(await tau({ op: "reconfigure", process: id, fields: { prompt: "新的提示词", context: ["AGENTS.md"] } }), [{ type: "reconfigured", process: id, pending: true }]);
  const b = await rec();
  assert.equal(b.process.preset.prompt, "你是测试助手。");
  assert.deepEqual([b.process.next.prompt, b.process.next.context, b.process.next.thinking], ["新的提示词", ["AGENTS.md"], "low"], "待换的以现在的为底");
  const info = sessionInfo(b)!;
  assert.deepEqual([info.pending, info.prompt, info.context, info.thinking, info.id], [true, "新的提示词", ["AGENTS.md"], "low", "p"], "表的初值取 next");
  const ps = (await tau({ op: "ps" }))[0].processes[0].self;
  assert.deepEqual(pendingOf(ps), ["prompt", "context"]);
  assert.deepEqual(seenFromInspect(b)!.context, undefined, "界面的会话快照是当前的，不是待换的");

  // 取消：回到当前快照，没有 next，ps 里没有 pending。
  assert.deepEqual(await tau({ op: "reconfigure", process: id, revert: true }), [{ type: "reconfigured", process: id, pending: false }]);
  const c = await rec();
  assert.equal(c.process.next, undefined);
  assert.deepEqual(pendingOf((await tau({ op: "ps" }))[0].processes[0].self), []);

  // 服务的错误原文照样转回，什么都没改。
  const bad = await tau({ op: "reconfigure", process: id, fields: { id: "x" } });
  assert.equal(bad[0].type, "error");
  assert.match(bad[0].message, /id 不能改/);
  assert.equal((await tau({ op: "reconfigure", process: "nobody", fields: { thinking: "low" } }))[0].type, "error");
  assert.equal((await tau({ op: "reconfigure", process: id, fields: { model: "nobody/none" } }))[0].type, "error");
  assert.equal((await rec()).process.next, undefined);
});

test("换段按钮：send 带 handoff 换段，信带进新段；信、段号、交接说明都能用 tau 读出来", async (t) => {
  const s = await setupService(t);
  s.faux.setResponses([fauxAssistantMessage(fauxText("第一轮的回复。")), fauxAssistantMessage(fauxText("目标是 X，做到一半。")), fauxAssistantMessage(fauxText("已换段"))]);
  const id: string = lines(await post(s.port, "/api/tau", { op: "start", preset: "p", text: "开工" }))[0].process;
  const sent = lines(await post(s.port, "/api/tau", { op: "send", process: id, text: HANDOFF_LETTER, handoff: true }));
  assert.deepEqual(sent.at(-1), { type: "final", reply: "已换段", ended: "done" });
  const ps = lines(await post(s.port, "/api/tau", { op: "ps" }));
  assert.equal(ps[0].processes[0].self.segment, 2, "换了一段");
  const hist = lines(await post(s.port, "/api/tau", { op: "history", process: id, segment: 2 })).filter((l) => l.type === "message");
  const first = hist[0].message;
  assert.equal(first.tau.handoff, true);
  const parsed = parseUser(first);
  assert.deepEqual(parsed.handoff, { note: "目标是 X，做到一半。", carried: HANDOFF_LETTER });
  // 在新段里，换段信读不出“用户的信”以外的东西；canHandoff 此时还要等助手说话。
  assert.equal(canHandoff([first]), false);
  assert.equal(canHandoff(hist.map((h) => h.message)), true);
  // 旧段里那封信还是用户的信，正文是“开工”。
  const old = lines(await post(s.port, "/api/tau", { op: "history", process: id, segment: 1 })).filter((l) => l.type === "message");
  assert.deepEqual(parseUser(old[0].message).letters.map((l: any) => [l.from, l.text]), [["user", "开工"]]);
});

test("转发：watch 分块实时推送；浏览器断开后桥断开管道，服务仍然可用", { timeout: 20_000 }, async (t) => {
  const s = await setupService(t, { tokenSize: { min: 1, max: 1 }, tokensPerSecond: 2000 });
  const reply = "流式文本要分成很多块才能证明是实时推送的，不是攒着一起发。";
  s.faux.setResponses([fauxAssistantMessage(fauxText("先有一个进程。")), fauxAssistantMessage(fauxText(reply))]);
  const first = lines(await post(s.port, "/api/tau", { op: "start", preset: "p", text: "一" }));
  const id: string = first[0].process;
  await until(() => s.open.size === 0, "start 的连接关闭");

  const arrivals: { at: number; types: string[] }[] = [];
  const req = http.request({ host: "127.0.0.1", port: s.port, path: "/api/tau", method: "POST", headers: JSON_H });
  let buf = "";
  req.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      const types: string[] = [];
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        types.push(JSON.parse(buf.slice(0, i)).type);
        buf = buf.slice(i + 1);
      }
      arrivals.push({ at: Date.now(), types });
    });
  });
  req.on("error", () => {});
  req.end(JSON.stringify({ op: "watch" }));
  await until(() => arrivals.some((a) => a.types.includes("update")), "watch 的快照");
  assert.equal(s.open.size, 1, "桥为 watch 连着一条管道");

  const sent = lines(await post(s.port, "/api/tau", { op: "send", process: id, text: "二" }));
  assert.deepEqual(sent.at(-1), { type: "final", reply, ended: "done" });
  const textChunks = arrivals.filter((a) => a.types.includes("text"));
  assert.ok(textChunks.length >= 5, `text 应当分很多块到达，实际 ${textChunks.length} 块`);
  const span = (textChunks.at(-1)?.at ?? 0) - (textChunks[0]?.at ?? 0);
  assert.ok(span > 0, "text 的到达分散在不同时刻");

  // 浏览器断开：桥断开管道。
  req.destroy();
  await until(() => s.open.size === 0, "管道连接在浏览器断开后关闭");
  const ps = lines(await post(s.port, "/api/tau", { op: "ps" }));
  assert.equal(ps[0].processes[0].self.phase.tag, "idle");
});

test("转发：连不上管道回 503 和错误原因", async (t) => {
  const e = await setupBridge(t);
  const r = await post(e.port, "/api/tau", { op: "ps" });
  assert.equal(r.status, 503);
  assert.equal(typeof r.json.error, "string");
});

// 预设

test("预设：读得出、读不出、能不能启动都和 start 一致；带 options 的读得出", async (t) => {
  const e = await setupBridge(t, { service: true });
  const m = e.model;
  const p = (id: string, text: string) => writeFileSync(join(e.home, "presets", `${id}.md`), text);
  mkdirSync(join(e.home, "tools"), { recursive: true });
  writeFileSync(join(e.home, "tools", "mytool.json"), JSON.stringify({ description: "d", parameters: { type: "object", properties: {} }, command: "echo" }));
  p("good", `---\nworkdir: ${e.work}\nmodel: ${m}\ntools: read, bash, memory, mytool\nthinking: low\nhandoff: 150000\noptions: {"temperature":0.2}\n---\n提示词\n`);
  p("crlf", `---\r\nworkdir: ${e.work}\r\nmodel: ${m}\r\ntools: read\r\n---\r\n提示词\r\n`);
  p("bom", `﻿---\nworkdir: ${e.work}\nmodel: ${m}\ntools:\n---\n`);
  p("unknown", `---\nworkdir: ${e.work}\nmodel: ${m}\ntools: read\ncolor: red\n---\n`);
  p("relative", `---\nworkdir: rel/dir\nmodel: ${m}\ntools: read\n---\n`);
  p("missing", `---\nworkdir: ${e.work}\nmodel: ${m}\n---\n`);
  p("nodir", `---\nworkdir: ${join(e.dir, "nope")}\nmodel: ${m}\ntools: read\n---\n`);
  p("nofm", "只有正文\n");
  p("badopt", `---\nworkdir: ${e.work}\nmodel: ${m}\ntools: read\noptions: {"model":"x"}\n---\n`);
  p("nomodel", `---\nworkdir: ${e.work}\nmodel: nobody/none\ntools: read\n---\n`);
  p("notool", `---\nworkdir: ${e.work}\nmodel: ${m}\ntools: read, ghost\n---\n`);
  p("tiny", `---\nworkdir: ${e.work}\nmodel: ${m}\ntools: read, bash, memory\nhandoff: 5000\n---\n`);
  writeFileSync(join(e.home, "presets", "ignored.txt"), "x");
  const r = await post(e.port, "/api/presets", {});
  assert.equal(r.status, 200);
  const byId = new Map<string, any>(r.json.presets.map((x: any) => [x.id, x]));
  assert.deepEqual([...byId.keys()].sort(), ["badopt", "bom", "crlf", "good", "missing", "nodir", "nofm", "nomodel", "notool", "relative", "tiny", "unknown"]);
  assert.deepEqual(byId.get("good"), { id: "good", ok: true, workdir: e.work, model: m, tools: ["read", "bash", "memory", "mytool"], memory: true, prompt: "提示词", agentsMd: "none", thinking: "low", handoff: 150000, options: { temperature: 0.2 } });
  assert.deepEqual(byId.get("crlf"), { id: "crlf", ok: true, workdir: e.work, model: m, tools: ["read"], memory: false, prompt: "提示词", agentsMd: "none" });
  assert.deepEqual(byId.get("bom").tools, []);
  assert.match(byId.get("unknown").error, /color/);
  // 读不出和装不下：错误文字一字不差，和 start 回的一样；读得出的，start 也起得来。
  for (const [id, info] of byId) {
    const started = lines(await post(e.port, "/api/tau", { op: "start", preset: id, text: "hi", id: `t-${id}` }))[0];
    if (info.ok) {
      assert.equal(started.type, "receipt", id);
      continue;
    }
    assert.equal(typeof info.error, "string", id);
    assert.equal(started.type, "error", id);
    assert.equal(info.error, started.message, id);
  }
  assert.match(byId.get("tiny").error, /窗口太小/);
});

test("预设：服务不在时回 503，不当成读不出", async (t) => {
  const e = await setupBridge(t);
  writePreset(e, "p");
  const r = await post(e.port, "/api/presets", {});
  assert.equal(r.status, 503);
  assert.equal(typeof r.json.error, "string");
});

test("预设：没有 presets 目录时是空列表", async (t) => {
  const e = await setupBridge(t);
  rmSync(join(e.home, "presets"), { recursive: true });
  assert.deepEqual((await post(e.port, "/api/presets", {})).json, { presets: [] });
});

test("新建预设：只写认识的字段；不覆盖已有的；ID 和工作目录要合法", async (t) => {
  const e = await setupBridge(t, { service: true });
  const ok = await post(e.port, "/api/presets/create", { id: "proj.a-1_x", workdir: e.work, model: e.model, tools: ["read", "memory"], thinking: "low", prompt: "你好\n第二行\n", extra: "忽略" });
  assert.deepEqual(ok.json, { ok: true });
  const file = readFileSync(join(e.home, "presets", "proj.a-1_x.md"), "utf8");
  assert.equal(file, `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read, memory\nthinking: low\n---\n你好\n第二行\n`);
  const lst = await post(e.port, "/api/presets", {});
  assert.equal(lst.status, 200, lst.text);
  const listed = lst.json.presets[0];
  assert.equal(listed.ok, true);
  assert.equal(listed.memory, true);

  const again = await post(e.port, "/api/presets/create", { id: "proj.a-1_x", workdir: e.work, model: "a/b", tools: [], prompt: "新的" });
  assert.equal(again.status, 409);
  assert.equal(readFileSync(join(e.home, "presets", "proj.a-1_x.md"), "utf8"), file, "没有被覆盖");
  const upper = await post(e.port, "/api/presets/create", { id: "PROJ.A-1_X", workdir: e.work, model: "a/b", tools: [], prompt: "x" });
  assert.equal(upper.status, 409, "NTFS 不分大小写");

  const base = { workdir: e.work, model: "a/b", tools: ["read"], prompt: "p" };
  for (const id of ["", "../evil", "a/b", "a\\b", "..", ".", "a b", "x:y", "a.", "中文", 7, undefined]) {
    assert.equal((await post(e.port, "/api/presets/create", { ...base, id })).status, 400, JSON.stringify(id));
  }
  for (const workdir of ["rel/dir", "/abs/nodrive", join(e.dir, "nope"), join(e.work, "..", "nope"), "", 5]) {
    assert.equal((await post(e.port, "/api/presets/create", { ...base, id: "w", workdir })).status, 400, JSON.stringify(workdir));
  }
  for (const patch of [{ model: "nomodel" }, { model: "a/b\nx: y" }, { tools: "read" }, { tools: ["a,b"] }, { thinking: "huge" }, { prompt: 3 }]) {
    assert.equal((await post(e.port, "/api/presets/create", { ...base, id: "w", ...patch })).status, 400, JSON.stringify(patch));
  }
  assert.equal(listDir(join(e.home, "presets")).length, 1, "出错的都没写文件");
});

test("删预设：只删对应的文件；ID 不合法 400；没有这个文件 404；只收 POST", async (t) => {
  const e = await setupBridge(t);
  const mk = (id: string) => post(e.port, "/api/presets/create", { id, workdir: e.work, model: "a/b", tools: ["read"], prompt: "p" });
  assert.equal((await mk("keep")).status, 200);
  assert.equal((await mk("gone")).status, 200);
  const ok = await post(e.port, "/api/presets/delete", { id: "gone" });
  assert.deepEqual(ok.json, { ok: true });
  assert.deepEqual(listDir(join(e.home, "presets")), ["keep.md"]);

  assert.equal((await post(e.port, "/api/presets/delete", { id: "gone" })).status, 404, "已经删了");
  assert.equal((await post(e.port, "/api/presets/delete", { id: "never" })).status, 404);
  for (const id of ["", "../keep", "a/b", "a\b", "..", ".", "a b", "x:y", "a.", "中文", 7, undefined]) {
    assert.equal((await post(e.port, "/api/presets/delete", { id })).status, 400, JSON.stringify(id));
  }
  assert.deepEqual(listDir(join(e.home, "presets")), ["keep.md"], "出错的都没动文件");
  assert.equal((await raw(e.port, "/api/presets/delete")).status, 405, "GET");
});

function listDir(d: string): string[] {
  return execFileSync("cmd", ["/c", "dir", "/b", d], { encoding: "utf8" }).split(/\r?\n/).filter((l) => l !== "");
}

// git

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "第一个提交");
  sh(repo, "branch", "old");
  sh(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "f.txt"), "f1\nf2\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "feature 一");
  writeFileSync(join(repo, "f.txt"), "f1\nf2\nf3\n");
  sh(repo, "commit", "-am", "feature 二");
  sh(repo, "checkout", "main");
  writeFileSync(join(repo, "m.txt"), "m\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "main 前进");
  // 工作区：已跟踪改动、已暂存新文件、未跟踪文件。
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  sh(repo, "add", "b.txt");
  writeFileSync(join(repo, "c.txt"), "hello\nworld\n");
  return repo;
}

test("git：status、diff、log、branches 的结果；每条 git 命令的第一个参数都是 --no-optional-locks", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = makeRepo(e.dir);
  writePreset(e, "proj", repo);
  const git = (what: string, extra: object = {}, workdir = repo) => post(e.port, "/api/git", { workdir, what, ...extra });

  const st = (await git("status")).json;
  assert.equal(st.repo, true);
  assert.equal(st.branch, "main");
  const files = new Map<string, any>(st.files.map((f: any) => [f.path, f]));
  assert.deepEqual(files.get("a.txt"), { path: "a.txt", status: " M", add: 2, del: 1 });
  assert.equal(files.get("b.txt").status, "A ");
  assert.equal(files.get("b.txt").add, 1);
  assert.deepEqual(files.get("c.txt"), { path: "c.txt", status: "??", add: null, del: null });
  assert.equal(st.files.length, 3);

  const d1 = (await git("diff", { file: "a.txt" })).json;
  assert.equal(d1.truncated, false);
  assert.match(d1.text, /\+TWO/);
  assert.match(d1.text, /-two/);
  const d2 = (await git("diff", { file: "c.txt" })).json;
  assert.match(d2.text, /\+hello/);
  assert.match(d2.text, /\+world/);
  const d3 = (await git("diff", { file: "b.txt" })).json;
  assert.match(d3.text, /\+b/);

  const lg = (await git("log")).json.commits;
  assert.deepEqual(lg.map((c: any) => c.subject), ["main 前进", "第一个提交"]);
  assert.equal(lg[0].author, "t");
  assert.equal(lg[0].hash.length, 40);
  assert.ok(lg[0].hash.startsWith(lg[0].short));
  assert.ok(Math.abs(lg[0].time - Date.now()) < 3600_000);

  const br = (await git("branches")).json;
  assert.equal(br.main, "main");
  const by = new Map<string, any>(br.branches.map((b: any) => [b.name, b]));
  assert.deepEqual([...by.keys()].sort(), ["feature", "main", "old"]);
  assert.deepEqual(by.get("main"), { name: "main", current: true, ahead: 0, behind: 0, merged: true, add: 0, del: 0 });
  assert.deepEqual(by.get("feature"), { name: "feature", current: false, ahead: 2, behind: 1, merged: false, add: 3, del: 0 });
  assert.equal(by.get("old").merged, true);
  assert.equal(by.get("old").ahead, 0);
  assert.equal(by.get("old").behind, 1);

  assert.ok(e.gitCalls.length >= 10);
  for (const args of e.gitCalls) assert.equal(args[0], "--no-optional-locks", args.join(" "));
  // status 不碰 index.lock：运行以后也没有留下。
  assert.throws(() => readFileSync(join(repo, ".git", "index.lock")));
});

test("git：file 按字面当路径，foo[1].txt 不会匹配 foo1.txt", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = makeRepo(e.dir);
  writePreset(e, "proj", repo);
  writeFileSync(join(repo, "foo[1].txt"), "x\n");
  writeFileSync(join(repo, "foo1.txt"), "y\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "glob");
  writeFileSync(join(repo, "foo[1].txt"), "x2\n");
  writeFileSync(join(repo, "foo1.txt"), "y2\n");
  const d = (await post(e.port, "/api/git", { workdir: repo, what: "diff", file: "foo[1].txt" })).json;
  assert.match(d.text, /\+x2/);
  assert.doesNotMatch(d.text, /y2/);
  // 已跟踪的 a[b].txt 不能因为未跟踪的 ab.txt 被当成新文件。
  writeFileSync(join(repo, "a[b].txt"), "t\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "bracket");
  writeFileSync(join(repo, "a[b].txt"), "t2\n");
  writeFileSync(join(repo, "ab.txt"), "n\n");
  const d2 = (await post(e.port, "/api/git", { workdir: repo, what: "diff", file: "a[b].txt" })).json;
  assert.match(d2.text, /-t\n/);
  assert.match(d2.text, /\+t2/);
});

test("git：diff 超过 256 KB 截断；坏的 file 参数 400；不是仓库回 repo: false；what 不认识 400", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = makeRepo(e.dir);
  writePreset(e, "proj", repo);
  writeFileSync(join(repo, "big.txt"), "x".repeat(79) + "\n".repeat(1) + ("y".repeat(79) + "\n").repeat(5000));
  const d = (await post(e.port, "/api/git", { workdir: repo, what: "diff", file: "big.txt" })).json;
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.text) <= DIFF_MAX_BYTES);
  for (const file of ["../x", "..\\x", "-p", "", "C:\\Windows\\win.ini", "/etc/passwd", "a\0b", 3]) {
    assert.equal((await post(e.port, "/api/git", { workdir: repo, what: "diff", file })).status, 400, JSON.stringify(file));
  }
  assert.equal((await post(e.port, "/api/git", { workdir: repo, what: "push" })).status, 400);
  const plain = join(e.dir, "plain");
  mkdirSync(plain);
  writePreset(e, "plain", plain);
  assert.deepEqual((await post(e.port, "/api/git", { workdir: plain, what: "status" })).json, { repo: false });
});

test("git：工作目录必须是预设的 workdir 或界面数据里的文件夹，比较不分大小写；否则 403 且不跑 git", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = makeRepo(e.dir);
  const other = join(e.dir, "other");
  mkdirSync(other);
  sh(other, "init", "-b", "main");
  const git = (workdir: unknown) => post(e.port, "/api/git", { workdir, what: "status" });

  assert.equal((await git(repo)).status, 403);
  assert.equal(e.gitCalls.length, 0);
  writePreset(e, "proj", repo);
  assert.equal((await git(repo)).status, 200);
  assert.equal((await git(repo.toUpperCase())).status, 200, "大小写不同");
  assert.equal((await git(repo + "\\")).status, 200, "尾部的分隔符");
  for (const bad of [other, join(repo, ".."), join(repo, ".git"), e.dir, "C:\\", "", 5, undefined]) {
    assert.equal((await git(bad)).status, typeof bad === "string" && bad !== "" ? 403 : 400, JSON.stringify(bad));
  }
  assert.equal((await post(e.port, "/api/state", { set: { folders: [other] } })).status, 200);
  assert.equal((await git(other)).status, 200, "界面数据里的文件夹");
  assert.equal((await git(other.toLowerCase())).status, 200);
  assert.equal((await post(e.port, "/api/state", { set: { folders: [] } })).status, 200);
  assert.equal((await git(other)).status, 403, "移出以后又被拒");
});

// 后台命令

test("后台命令：按进程 ID 前缀列出，tail 取末尾，exit 取最后一行的退出码，没有就是 null", async (t) => {
  const e = await setupBridge(t);
  const bg = join(e.home, "extras", "bg");
  mkdirSync(bg, { recursive: true });
  writeFileSync(join(bg, "p1-build.log"), "编译中\n[后台任务 build] 退出码 3\n[后台任务 build] 退出码 0\n");
  writeFileSync(join(bg, "p1-watch-x.log"), "还在跑\n");
  writeFileSync(join(bg, "p10-other.log"), "不属于 p1\n[后台任务 other] 退出码 9\n");
  writeFileSync(join(bg, "p1-note.txt"), "不是 log");
  writeFileSync(join(bg, "p2-big.log"), "中".repeat(10000) + "\n[后台任务 big] 退出码 7\n[后台任务 big] 完成，退出码 7\n");
  const r = (await post(e.port, "/api/bg", { processes: ["p1", "p2", "nobody"] })).json.logs as any[];
  assert.deepEqual(r.map((l) => [l.process, l.name, l.exit]), [["p1", "build", 0], ["p1", "watch-x", null], ["p2", "big", 7]]);
  const build = r[0];
  assert.equal(build.tail, "编译中\n[后台任务 build] 退出码 3\n[后台任务 build] 退出码 0\n");
  assert.equal(build.size, Buffer.byteLength(build.tail));
  assert.equal(typeof build.mtime, "number");
  const big = r[2];
  assert.ok(Buffer.byteLength(big.tail) <= 8 * 1024);
  assert.ok(big.tail.endsWith("完成，退出码 7\n"));
  assert.ok(!big.tail.includes("\uFFFD"), "不从字符中间截断");
  assert.equal(big.size, Buffer.byteLength("中".repeat(10000) + "\n[后台任务 big] 退出码 7\n[后台任务 big] 完成，退出码 7\n"));

  assert.deepEqual((await post(e.port, "/api/bg", { processes: [] })).json, { logs: [] });
  assert.equal((await post(e.port, "/api/bg", { processes: "p1" })).status, 400);
  assert.equal((await post(e.port, "/api/bg", { processes: ["../x"] })).status, 400);
  assert.equal(parseExit("[后台任务 a] 退出码 -1\n"), -1);
  assert.equal(parseExit("[后台任务 a] 完成，退出码 1\n"), null);
});

test("后台命令：没有 extras/bg 目录时是空列表", async (t) => {
  const e = await setupBridge(t);
  assert.deepEqual((await post(e.port, "/api/bg", { processes: ["p1"] })).json, { logs: [] });
});

// 界面数据

test("界面数据：set 覆盖顶层键并回整个文件；不带 set 只读；不是对象 400；太大 413", async (t) => {
  const e = await setupBridge(t);
  assert.deepEqual((await post(e.port, "/api/state", {})).json, { state: {} });
  assert.deepEqual((await post(e.port, "/api/state", { set: { chief: "boss", names: { a: "甲" } } })).json, { state: { chief: "boss", names: { a: "甲" } } });
  assert.deepEqual((await post(e.port, "/api/state", { set: { names: { b: "乙" }, cleanDays: 3 } })).json, { state: { chief: "boss", names: { b: "乙" }, cleanDays: 3 } });
  const file = join(e.home, "extras", "gui", "state.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { chief: "boss", names: { b: "乙" }, cleanDays: 3 });
  assert.deepEqual((await post(e.port, "/api/state", {})).json.state, { chief: "boss", names: { b: "乙" }, cleanDays: 3 });
  for (const set of ["x", [1], 5, null]) assert.equal((await post(e.port, "/api/state", { set })).status, 400, JSON.stringify(set));
  const big = await post(e.port, "/api/state", { set: { blob: "x".repeat(900 * 1024), more: "y".repeat(200 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).chief, "boss", "超限的写入没动文件");
});

test("界面数据：写临时文件失败时旧文件完好；坏掉的文件不被覆盖；并发写不丢键", async (t) => {
  const e = await setupBridge(t);
  const dir = join(e.home, "extras", "gui");
  const file = join(dir, "state.json");
  await post(e.port, "/api/state", { set: { chief: "boss" } });
  const before = readFileSync(file, "utf8");
  // 临时文件的位置被一个目录占住：写它必然失败。
  mkdirSync(`${file}.tmp`);
  const failed = await post(e.port, "/api/state", { set: { chief: "changed" } });
  assert.equal(failed.status, 500);
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(`${file}.tmp`, { recursive: true });

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(e.port, "/api/state", { set: { [`k${i}`]: i } })));
  assert.ok(results.every((r) => r.status === 200));
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(state.chief, "boss");
  for (let i = 0; i < 10; i++) assert.equal(state[`k${i}`], i);

  writeFileSync(file, "{坏掉");
  assert.equal((await post(e.port, "/api/state", { set: { a: 1 } })).status, 500);
  assert.equal(readFileSync(file, "utf8"), "{坏掉", "坏文件留给人处理");
});

// 选文件夹

test("选文件夹：回对话框给的路径；取消是 null；同时只开一个（测试里注入，不弹真的对话框）", async (t) => {
  let answer: string | null = "C:\\proj";
  let release: () => void = () => {};
  let opened = false;
  const e = await setupBridge(t, { pickFolder: async () => {
      opened = true;
      await new Promise<void>((r) => (release = r));
      opened = false;
      return answer;
    } });
  const first = post(e.port, "/api/pick-folder", {});
  await until(() => opened, "对话框打开");
  await sleep(20);
  assert.equal((await post(e.port, "/api/pick-folder", {})).status, 409);
  release();
  assert.deepEqual((await first).json, { path: "C:\\proj" });
  answer = null;
  const second = post(e.port, "/api/pick-folder", {});
  await sleep(20);
  release();
  assert.deepEqual((await second).json, { path: null });
});

test("git：暂存的删除（git rm）也能取到 diff", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = join(e.dir, "rm");
  mkdirSync(repo);
  sh(repo, "init", "-b", "main");
  writeFileSync(join(repo, "gone.txt"), "x\ny\nz\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "一");
  sh(repo, "rm", "gone.txt");
  writePreset(e, "rm", repo);
  const d = (await post(e.port, "/api/git", { workdir: repo, what: "diff", file: "gone.txt" })).json;
  assert.match(d.text, /-x/);
  assert.match(d.text, /-z/);
});

test("git：工作目录是仓库的子目录时，status 给的路径能直接取 diff", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = join(e.dir, "mono");
  const pkg = join(repo, "pkg");
  mkdirSync(pkg, { recursive: true });
  sh(repo, "init", "-b", "main");
  writeFileSync(join(pkg, "a.txt"), "ONE\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "一");
  writeFileSync(join(pkg, "a.txt"), "ONE\nTWO\n");
  writeFileSync(join(pkg, "new.txt"), "fresh\n");
  writePreset(e, "mono", pkg);
  const st = (await post(e.port, "/api/git", { workdir: pkg, what: "status" })).json;
  assert.equal(st.files.length, 2);
  for (const f of st.files) {
    const d = (await post(e.port, "/api/git", { workdir: pkg, what: "diff", file: f.path })).json;
    assert.match(d.text, f.path.endsWith("a.txt") ? /\+TWO/ : /\+fresh/, f.path);
  }
  assert.equal((await post(e.port, "/api/git", { workdir: pkg, what: "diff", file: "../outside" })).status, 400);
});

test("git：输出超过缓冲上限时，diff 照常截断，status 回 500", async (t) => {
  const e = await setupBridge(t, { service: true });
  const repo = join(e.dir, "huge");
  mkdirSync(repo);
  sh(repo, "init", "-b", "main");
  writeFileSync(join(repo, "k.txt"), "k\n");
  sh(repo, "add", "."), sh(repo, "commit", "-m", "一");
  writeFileSync(join(repo, "big.txt"), ("z".repeat(99) + "\n").repeat(100_000));
  writePreset(e, "huge", repo);
  const d = (await post(e.port, "/api/git", { workdir: repo, what: "diff", file: "big.txt" })).json;
  assert.equal(d.truncated, true);
  assert.ok(d.text.length > 0 && Buffer.byteLength(d.text) <= DIFF_MAX_BYTES);
  const all = (await post(e.port, "/api/git", { workdir: repo, what: "diff" })).json;
  assert.equal(all.truncated, false, "整体 diff 只看已跟踪文件，这里没有改动");

  const e2 = await setupBridge(t, { service: true, git: async (args) => (args.includes("status") ? { code: 0, stdout: "## main\0", overflow: true } : { code: 0, stdout: "" }) });
  writePreset(e2, "huge", repo);
  assert.equal((await post(e2.port, "/api/git", { workdir: repo, what: "status" })).status, 500);
});

// 模型目录和 key 状态

test("模型目录：供应商、模型、窗口、能不能收图、思考级别都来自 pi-ai；key 状态读 auth.json，值不进回复；改了不用重启", async (t) => {
  const { getBuiltinModels, getBuiltinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = join(dir, "auth.json");
  const e = await setupBridge(t, { authFile });

  // 文件不存在：全是“没配”。
  const none = await post(e.port, "/api/models", {});
  assert.equal(none.status, 200, none.text);
  assert.ok(none.json.providers.length > 10);
  assert.ok(none.json.providers.every((p: any) => p.key === "none"));
  assert.deepEqual(none.json.auth, { ok: true });

  // 目录和 pi-ai 一致，思考级别是 pi-ai 算的（去掉预设不收的 off）。
  const ids = getBuiltinProviders().filter((p) => getBuiltinModels(p).length > 0);
  assert.deepEqual(none.json.providers.map((p: any) => p.id), ids);
  const oc = none.json.providers.find((p: any) => p.id === "opencode-go");
  assert.equal(typeof oc.name, "string");
  const want = getBuiltinModels("opencode-go").find((m) => m.id === "deepseek-v4.1-flash");
  const got = oc.models.find((m: any) => m.id === "deepseek-v4.1-flash");
  assert.ok(want && got);
  assert.deepEqual(got, {
    id: want.id,
    name: want.name,
    window: want.contextWindow,
    image: want.input.includes("image"),
    thinking: getSupportedThinkingLevels(want).filter((l) => l !== "off"),
  });
  assert.equal(got.image, true);
  for (const p of none.json.providers) {
    const real = getBuiltinModels(p.id);
    assert.equal(p.models.length, real.length, p.id);
    for (const [i, m] of p.models.entries()) assert.deepEqual(m.thinking, getSupportedThinkingLevels(real[i]!).filter((l) => l !== "off"), `${p.id}/${m.id}`);
  }

  // 三种状态加“读不了”；回复里没有 key 的任何一部分。
  writeFileSync(
    authFile,
    JSON.stringify({
      anthropic: { type: "api_key", key: "sk-ant-SECRET-1111" },
      openai: { type: "oauth", access: "OAUTH-SECRET-2222", refresh: "OAUTH-SECRET-3333", expires: 1 },
      google: { type: "api_key", key: "!op read SECRET-cmd" },
      deepseek: { type: "api_key", key: "pre$SECRET-var" },
      "opencode-go": { type: "api_key", key: 12345 },
      "not-a-provider": { type: "api_key", key: "sk-SECRET-orphan" },
      mistral: { type: "oauth", access: "OAUTH-SECRET-4444" },
      xai: { type: "api_key", env: { ACCOUNT: "x" } },
    }),
  );
  const mixed = await post(e.port, "/api/models", {});
  const status = Object.fromEntries(mixed.json.providers.map((p: any) => [p.id, p.key]));
  assert.equal(status["anthropic"], "key");
  assert.equal(status["openai"], "oauth");
  assert.equal(status["google"], "unreadable");
  assert.equal(status["deepseek"], "unreadable");
  assert.equal(status["opencode-go"], "unreadable");
  assert.equal(status["mistral"], "unreadable", "OAuth 缺 refresh 和 expires：凭据库 read 会报错，界面也说读不了");
  assert.equal(status["xai"], "key", "只有 env 没有 key，凭据库放行");
  assert.doesNotMatch(mixed.text, /SECRET|12345|op read/);

  // 文件坏了：全是“没配”，说明原因，不带文件内容。
  writeFileSync(authFile, '{"anthropic": {"type": "api_key", "key": "sk-LEAK-9999"');
  const bad = await post(e.port, "/api/models", {});
  assert.equal(bad.status, 200);
  assert.ok(bad.json.providers.every((p: any) => p.key === "none"));
  assert.equal(bad.json.auth.ok, false);
  assert.equal(typeof bad.json.auth.error, "string");
  assert.doesNotMatch(bad.text, /LEAK|9999/);
  assert.equal((await raw(e.port, "/api/models")).status, 405, "GET");
});

test("模型目录：GitHub Copilot 登录后只列账号的可用清单（pi-ai 的 filterModels）；没清单、没登录、api_key 都列全部；别家不受影响；清单不进回复；改了不用重启", async (t) => {
  const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-avail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = join(dir, "auth.json");
  const e = await setupBridge(t, { authFile });
  const all = getBuiltinModels("github-copilot").map((m) => m.id);
  assert.ok(all.length > 3);
  const copilot = async () => (await post(e.port, "/api/models", {})).json.providers.find((p: any) => p.id === "github-copilot");
  const write = (c: unknown) => writeFileSync(authFile, JSON.stringify({ "github-copilot": c, anthropic: { type: "api_key", key: "sk-ant-X" } }));
  const oauth = { type: "oauth", access: "A-SECRET", refresh: "R-SECRET", expires: 1 };

  assert.deepEqual((await copilot()).models.map((m: any) => m.id), all, "没登录：全部");
  write({ ...oauth, availableModelIds: [all[2], "no-such-model", all[0]] });
  const some = await copilot();
  assert.deepEqual(some.models.map((m: any) => m.id), [all[0], all[2]], "按目录的顺序，清单里目录没有的忽略");
  assert.equal(some.key, "oauth");
  write({ ...oauth, availableModelIds: [] });
  const none = await copilot();
  assert.deepEqual(none.models, [], "清单是空的：这个账号什么都用不了，供应商还在，设置页还能登出");
  assert.equal(none.key, "oauth");
  write(oauth);
  assert.deepEqual((await copilot()).models.map((m: any) => m.id), all, "登录了但没有清单：全部");
  write({ ...oauth, availableModelIds: "oops" });
  assert.deepEqual((await copilot()).models.map((m: any) => m.id), all, "清单形状不对：全部");
  write({ type: "api_key", key: "ghu_X", availableModelIds: [all[0]] });
  assert.deepEqual((await copilot()).models.map((m: any) => m.id), all, "api_key 不过滤");

  // 别家不受影响；回复里没有清单和令牌。
  write({ ...oauth, availableModelIds: [all[0]] });
  const r = await post(e.port, "/api/models", {});
  assert.equal(r.json.providers.find((p: any) => p.id === "anthropic").models.length, getBuiltinModels("anthropic").length);
  assert.doesNotMatch(r.text, /availableModelIds|SECRET|sk-ant-X/);
});

// 填写和清除 api_key，登出 OAuth（D69、D83）

async function keysEnv(t: TestContext, name = "auth.json") {
  const root = mkdtempSync(join(tmpdir(), "tau-gui-keys-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const authFile = join(root, "agent", name);
  const e = await setupBridge(t, { authFile });
  const set = (provider: unknown, key: unknown) => post(e.port, "/api/keys/set", { provider, key });
  const clear = (provider: unknown) => post(e.port, "/api/keys/clear", { provider });
  const status = async (provider: string) => (await post(e.port, "/api/models", {})).json.providers.find((p: any) => p.id === provider).key;
  return { e, authFile, set, clear, status, dir: join(root, "agent") };
}

test("填 key：文件和目录都不存在也能建；换已有 api_key 只换 key，别的字段留着；清掉；响应是 key 状态，值不进任何响应", async (t) => {
  const { authFile, set, clear, status, dir } = await keysEnv(t);
  assert.equal(await status("anthropic"), "none");

  const created = await set("anthropic", "  sk-ant-SECRET-1111  ");
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.json, { ok: true, key: "key" });
  assert.doesNotMatch(created.text, /SECRET|1111/);
  // 存的是 trim 后的值；格式和凭据库写的一样。
  assert.equal(readFileSync(authFile, "utf8"), `${JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-SECRET-1111" } }, null, 2)}\n`);
  assert.equal(await status("anthropic"), "key", "写完立刻读到，不用重启");

  // 换：保留这一条的其它字段，只换 key；其它条目原样。
  const before = { zeta: { type: "oauth", access: "A", refresh: "R", expires: 1, extra: { n: [1, 2] } }, anthropic: { type: "api_key", key: "old", note: "x" }, alpha: { type: "api_key", key: "keep", more: true } };
  writeFileSync(authFile, `${JSON.stringify(before, null, 2)}\n`);
  const swapped = await set("anthropic", "sk-ant-NEW-2222");
  assert.deepEqual(swapped.json, { ok: true, key: "key" });
  assert.doesNotMatch(swapped.text, /NEW|2222|old/);
  assert.equal(readFileSync(authFile, "utf8"), `${JSON.stringify({ ...before, anthropic: { type: "api_key", key: "sk-ant-NEW-2222", note: "x" } }, null, 2)}\n`);

  // 读不了的（含 $）换成好的以后变成已配。
  writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "a$b" } }));
  assert.equal(await status("openai"), "unreadable");
  assert.deepEqual((await set("openai", "sk-fixed")).json, { ok: true, key: "key" });
  assert.equal(await status("openai"), "key");

  // 清掉：只删这一家，其它原样；没有这一条就什么也不做。
  writeFileSync(authFile, `${JSON.stringify(before, null, 2)}\n`);
  const cleared = await clear("anthropic");
  assert.deepEqual(cleared.json, { ok: true, key: "none" });
  const { anthropic: _gone, ...rest } = before;
  assert.equal(readFileSync(authFile, "utf8"), `${JSON.stringify(rest, null, 2)}\n`);
  assert.equal(await status("anthropic"), "none");
  const bytes = readFileSync(authFile);
  assert.deepEqual((await clear("anthropic")).json, { ok: true, key: "none" });
  assert.deepEqual(readFileSync(authFile), bytes);

  // 文件不存在时清掉：成功，也不建文件。
  rmSync(dir, { recursive: true });
  assert.deepEqual((await clear("anthropic")).json, { ok: true, key: "none" });
  assert.equal(existsSync(authFile), false);

  // 写完没有残留的临时文件。
  await set("anthropic", "k1");
  await set("anthropic", "k2");
  await clear("anthropic");
  assert.deepEqual(readdirSync(dir), ["auth.json"]);
});

test("填 key：文件读不出（坏 JSON、顶层是数组、顶层是字符串）时填和清都 409，文件字节不变，回复不带文件内容", async (t) => {
  const { authFile, set, clear, dir } = await keysEnv(t);
  mkdirSync(dir, { recursive: true });
  for (const content of ['{"anthropic": {"type": "api_key", "key": "sk-LEAK-9999"', '[{"anthropic":{"type":"api_key","key":"sk-LEAK-9999"}}]', '"sk-LEAK-9999"', ""]) {
    writeFileSync(authFile, content);
    const bytes = readFileSync(authFile);
    for (const r of [await set("anthropic", "sk-NEW-SECRET"), await clear("anthropic")]) {
      assert.equal(r.status, 409, content);
      assert.equal(typeof r.json.error, "string");
      assert.doesNotMatch(r.text, /LEAK|9999|NEW-SECRET/);
    }
    assert.deepEqual(readFileSync(authFile), bytes, content);
  }
  assert.deepEqual(readdirSync(dir), ["auth.json"]);
});

test("填 key：OAuth 登录的，填 key 409、文件不变；清掉就是登出，只删这一家；不认识的条目可以换、可以删", async (t) => {
  const { authFile, set, clear, status, dir } = await keysEnv(t);
  mkdirSync(dir, { recursive: true });
  const before = { openai: { type: "oauth", access: "OAUTH-SECRET-1", refresh: "OAUTH-SECRET-2", expires: 1 }, google: { type: "weird", key: "X-SECRET" }, anthropic: { type: "api_key", key: "keep" } };
  const text = `${JSON.stringify(before, null, 2)}\n`;
  writeFileSync(authFile, text);
  assert.equal(await status("openai"), "oauth");
  const r = await set("openai", "sk-new");
  assert.equal(r.status, 409);
  assert.match(r.json.error, /OAuth 登录的，先登出/);
  assert.doesNotMatch(r.text, /SECRET|sk-new/);
  assert.equal(readFileSync(authFile, "utf8"), text);
  // 登出：只删这一家，响应里是新状态，令牌不进响应。
  const out = await clear("openai");
  assert.deepEqual(out.json, { ok: true, key: "none" });
  assert.doesNotMatch(out.text, /SECRET/);
  const { openai: _gone, ...rest } = before;
  assert.equal(readFileSync(authFile, "utf8"), `${JSON.stringify(rest, null, 2)}\n`);
  // 登出以后可以填 key。
  assert.deepEqual((await set("openai", "sk-new")).json, { ok: true, key: "key" });
  // 类型不认识的条目（别的程序写的、手改的）：填是换掉，清是删掉。
  assert.deepEqual((await set("google", "sk-g")).json, { ok: true, key: "key" });
  assert.deepEqual(JSON.parse(readFileSync(authFile, "utf8")).google, { type: "api_key", key: "sk-g" });
  writeFileSync(authFile, `${JSON.stringify({ google: { type: "weird" }, mistral: "oops", anthropic: { type: "api_key", key: "keep" } }, null, 2)}\n`);
  assert.equal((await clear("mistral")).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(authFile, "utf8"))), ["google", "anthropic"]);
  assert.deepEqual(readdirSync(dir), ["auth.json"]);
});

test("填 key：不合格的 key 都 400，文件不变，错误文字里没有 key 的任何字符", async (t) => {
  const { e, authFile, set, dir } = await keysEnv(t);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ openai: { type: "api_key", key: "keep" } }, null, 2)}\n`;
  writeFileSync(authFile, text);
  const bad: unknown[] = [
    "!op read SECRET-cmd",
    "  !SECRET",
    "pre$SECRET-var",
    "",
    "   \t ",
    "sk-SECRET\nsk-more",
    "sk-SECRET\r\nx",
    "sk-SECRET\u0000x",
    "sk-SECRET\u007fx",
    "sk-SECRET\ttab",
    `SECRET${"x".repeat(5000)}`,
    "密".repeat(1366), // 4098 字节：字符数不到 4096，字节数超了
    12345,
    null,
    ["sk-SECRET"],
    { key: "sk-SECRET" },
    true,
  ];
  for (const key of bad) {
    const r = await set("anthropic", key);
    assert.equal(r.status, 400, JSON.stringify(key)?.slice(0, 40));
    assert.doesNotMatch(r.text, /SECRET|xxxx|密|12345/);
  }
  assert.equal((await post(e.port, "/api/keys/set", { provider: "anthropic" })).status, 400, "没有 key");
  assert.deepEqual(readFileSync(authFile, "utf8"), text);
  assert.equal(existsSync(join(dir, "auth.json.tmp")), false);
  // 边界：恰好 4096 字节可以，trim 后的值被存下。
  const edge = "k".repeat(4096);
  assert.equal((await set("anthropic", ` ${edge} `)).status, 200);
  assert.equal(JSON.parse(readFileSync(authFile, "utf8")).anthropic.key, edge);
  assert.equal((await set("anthropic", `${edge}k`)).status, 400);
});

test("填 key：provider 必须是模型目录里的供应商；只收 POST；key 最长的请求装得下", async (t) => {
  const { e, authFile, set, clear } = await keysEnv(t);
  for (const p of ["nobody", "", "__proto__", "constructor", 5, null, undefined, ["anthropic"]]) {
    assert.equal((await set(p, "sk-ok")).status, 400, String(p));
    assert.equal((await clear(p)).status, 400, String(p));
  }
  assert.equal(existsSync(authFile), false);
  assert.equal((await raw(e.port, "/api/keys/set")).status, 405, "GET");
  assert.equal((await raw(e.port, "/api/keys/clear")).status, 405, "GET");
  assert.equal((await post(e.port, "/api/keys/set", [])).status, 400);
  // 4096 字节的 key 经整个请求链路。
  assert.equal((await set("anthropic", "x".repeat(4096))).status, 200);
});

// 改预设

const read =(e: Env, id: string) => readFileSync(join(e.home, "presets", `${id}.md`), "utf8");
const upd = (e: Env, body: Record<string, unknown>) => post(e.port, "/api/presets/update", body);

test("改预设：只换收到的字段，别的行、顺序、换行符、正文原样；写完经 check 读得出", async (t) => {
  const e = await setupBridge(t, { service: true });
  const file = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read, bash\nhandoff: 150000\noptions: {"temperature":0.2}\n---\n提示词\n第二行\n`;
  writeFileSync(join(e.home, "presets", "a.md"), file);

  // 只改 thinking：追加到头部末尾，别的行不动。
  const r1 = await upd(e, { id: "a", thinking: "high" });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.preset.id, "a");
  assert.equal(r1.json.preset.thinking, "high");
  assert.equal(r1.json.preset.prompt, "提示词\n第二行", "改预设要显示提示词");
  assert.equal(read(e, "a"), file.replace('{"temperature":0.2}\n---', '{"temperature":0.2}\nthinking: high\n---'));

  // 改已有的行：留在原位。
  const r2 = await upd(e, { id: "a", tools: ["read", "write", "memory"], thinking: "low", handoff: 160000, options: { temperature: 0.5 } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(read(e, "a"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read, write, memory\nhandoff: 160000\noptions: {"temperature":0.5}\nthinking: low\n---\n提示词\n第二行\n`);

  // 上下文文件：追加到头部末尾，换已有的留在原位。
  const r2b = await upd(e, { id: "a", context: ["AGENTS.md", "docs/x.md"] });
  assert.equal(r2b.status, 200, r2b.text);
  assert.deepEqual(r2b.json.preset.context, ["AGENTS.md", "docs/x.md"]);
  assert.ok(read(e, "a").includes("thinking: low\ncontext: AGENTS.md, docs/x.md\n---\n"));
  assert.equal((await upd(e, { id: "a", context: ["b.md"] })).status, 200);
  assert.ok(read(e, "a").includes("thinking: low\ncontext: b.md\n---\n"));

  // null 删掉这一行；提示词整个换掉。
  const r3 = await upd(e, { id: "a", thinking: null, handoff: null, options: null, context: null, prompt: "新的\n" });
  assert.equal(r3.status, 200, r3.text);
  assert.equal(read(e, "a"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read, write, memory\n---\n新的\n`);
  assert.equal(r3.json.preset.thinking, undefined);
  assert.equal(r3.json.preset.context, undefined);

  // CRLF 和 BOM 照旧；没提到 prompt 就不动正文。
  writeFileSync(join(e.home, "presets", "crlf.md"), `﻿---\r\nworkdir: ${e.work}\r\nmodel: ${e.model}\r\ntools: read\r\n---\r\n正文\r\n`);
  const r4 = await upd(e, { id: "crlf", thinking: "medium" });
  assert.equal(r4.status, 200, r4.text);
  assert.equal(read(e, "crlf"), `﻿---\r\nworkdir: ${e.work}\r\nmodel: ${e.model}\r\ntools: read\r\nthinking: medium\r\n---\r\n正文\r\n`);

  // ID 和工作目录不能改：body 里的 workdir 被忽略。没有临时文件留下。
  const before = read(e, "a");
  const r5 = await upd(e, { id: "a", workdir: join(e.dir, "elsewhere"), model: e.model });
  assert.equal(r5.status, 200, r5.text);
  assert.equal(read(e, "a"), before);
  assert.deepEqual(listDir(join(e.home, "presets")).sort(), ["a.md", "crlf.md"]);
});

test("改预设：读不出或起不来就改回旧文件，错误原文回给页面", async (t) => {
  const e = await setupBridge(t, { service: true });
  const file = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read, bash, memory\n---\n提示词\n`;
  writeFileSync(join(e.home, "presets", "a.md"), file);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ model: "nobody/none" }, /模型目录里没有/],
    [{ options: { model: "x" } }, /options/],
    [{ handoff: 5000 }, /窗口太小/],
    [{ context: ["/e/x.md"] }, /context/],
    [{ tools: ["read", "ghost"] }, /ghost/],
  ];
  for (const [patch, re] of cases) {
    const r = await upd(e, { id: "a", ...patch });
    assert.equal(r.status, 422, r.text);
    assert.match(r.json.error, re);
    assert.equal(read(e, "a"), file, JSON.stringify(patch));
  }
  assert.deepEqual(listDir(join(e.home, "presets")), ["a.md"], "没有临时文件");

  // 文件里本来就有不认识的键：保留它，所以 check 读不出，改回去。
  const odd = `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\ncolor: red\n---\n`;
  writeFileSync(join(e.home, "presets", "odd.md"), odd);
  const r = await upd(e, { id: "odd", thinking: "low" });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /color/);
  assert.equal(read(e, "odd"), odd);
});

test("改预设：服务不在时回 503 并改回去；请求不合法 400；没有这个预设 404；只收 POST", async (t) => {
  const e = await setupBridge(t);
  writePreset(e, "a");
  const before = read(e, "a");
  const r = await upd(e, { id: "a", thinking: "low" });
  assert.equal(r.status, 503);
  assert.equal(read(e, "a"), before, "改回去了");
  assert.deepEqual(listDir(join(e.home, "presets")), ["a.md"]);

  for (const id of ["", "../a", "a/b", "..", "a.", 7, undefined]) assert.equal((await upd(e, { id, thinking: "low" })).status, 400, JSON.stringify(id));
  assert.equal((await upd(e, { id: "ghost", thinking: "low" })).status, 404);
  for (const patch of [{ thinking: "huge" }, { thinking: 3 }, { model: "a/b\nx: y" }, { model: "nomodel" }, { model: "" }, { tools: "read" }, { tools: ["a,b"] }, { handoff: 0 }, { handoff: 1.5 }, { handoff: "9" }, { options: [] }, { options: "x" }, { prompt: 3 }, { context: "x" }, { context: ["a,b"] }, {}]) {
    assert.equal((await upd(e, { id: "a", ...patch })).status, 400, JSON.stringify(patch));
  }
  assert.equal(read(e, "a"), before, "出错的都没动文件");
  writeFileSync(join(e.home, "presets", "nofm.md"), "只有正文\n");
  assert.equal((await upd(e, { id: "nofm", thinking: "low" })).status, 400);
  assert.equal(read(e, "nofm"), "只有正文\n");
  assert.equal((await raw(e.port, "/api/presets/update")).status, 405, "GET");
});

test("新建预设：也收 thinking、handoff、options、context，写成一行；不合法的 400", async (t) => {
  const e = await setupBridge(t, { service: true });
  const ok = await post(e.port, "/api/presets/create", { id: "n", workdir: e.work, model: e.model, tools: ["read"], thinking: "high", handoff: 150000, options: { temperature: 0.3, metadata: { a: "b\nc" } }, context: ["AGENTS.md", "docs/x.md"], prompt: "p" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(read(e, "n"), `---\nworkdir: ${e.work}\nmodel: ${e.model}\ntools: read\nthinking: high\nhandoff: 150000\noptions: {"temperature":0.3,"metadata":{"a":"b\\nc"}}\ncontext: AGENTS.md, docs/x.md\n---\np\n`);
  const lst = (await post(e.port, "/api/presets", {})).json.presets[0];
  assert.equal(lst.ok, true, JSON.stringify(lst));
  assert.deepEqual(lst.options, { temperature: 0.3, metadata: { a: "b\nc" } });
  assert.deepEqual(lst.context, ["AGENTS.md", "docs/x.md"]);
  const base = { workdir: e.work, model: e.model, tools: ["read"], prompt: "p" };
  for (const patch of [{ handoff: 0 }, { handoff: "1" }, { options: [] }, { options: 5 }, { context: "AGENTS.md" }, { context: ["a,b"] }]) {
    assert.equal((await post(e.port, "/api/presets/create", { ...base, id: "w", ...patch })).status, 400, JSON.stringify(patch));
  }
  assert.deepEqual(listDir(join(e.home, "presets")), ["n.md"]);
});
