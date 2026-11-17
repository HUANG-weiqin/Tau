// HTTP 桥（extras/gui/bridge）：每条检查的反例；转发对着真的测试服务；预设、git、后台命令、界面数据。
// 全部用临时目录和测试管道，不碰真的 ~/.tau。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

const MISSING_PIPE = () => `\\\\.\\pipe\\tau-test-gui-${process.pid}-${Math.random().toString(16).slice(2)}`;

async function setupBridge(t: TestContext, o: Partial<BridgeOptions> = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, "presets"), { recursive: true });
  mkdirSync(work);
  const gitCalls: string[][] = [];
  const bridge = await createBridge({
    port: 0,
    home,
    pipe: MISSING_PIPE(),
    git: async (args) => {
      gitCalls.push(args);
      return runGit(args);
    },
    pickFolder: async () => {
      throw new Error("测试里不该弹对话框");
    },
    ...o,
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, home, work, port: bridge.port, gitCalls, server: bridge.server };
}

function writePreset(env: Env, id: string, workdir = env.work, model = "x/m", tools = "read"): void {
  writeFileSync(join(env.home, "presets", `${id}.md`), `---\nworkdir: ${workdir}\nmodel: ${model}\ntools: ${tools}\n---\n提示词。\n`);
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
  return { faux, svc, port: bridge.port, open, pipe };
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

test("预设：正常、未知字段、BOM、CRLF、缺字段都列出；读不懂的标 ok: false", async (t) => {
  const e = await setupBridge(t);
  const p = (id: string, text: string) => writeFileSync(join(e.home, "presets", `${id}.md`), text);
  p("good", `---\nworkdir: ${e.work}\nmodel: anthropic/haiku\ntools: read, bash, memory, mytool\nthinking: low\nhandoff: 5000\n---\n提示词\n`);
  p("crlf", `---\r\nworkdir: ${e.work}\r\nmodel: a/b\r\ntools: read\r\n---\r\n提示词\r\n`);
  p("bom", `\uFEFF---\nworkdir: ${e.work}\nmodel: a/b\ntools:\n---\n`);
  p("unknown", `---\nworkdir: ${e.work}\nmodel: a/b\ntools: read\ncolor: red\n---\n`);
  p("relative", `---\nworkdir: rel/dir\nmodel: a/b\ntools: read\n---\n`);
  p("missing", `---\nworkdir: ${e.work}\nmodel: a/b\n---\n`);
  p("nodir", `---\nworkdir: ${join(e.dir, "nope")}\nmodel: a/b\ntools: read\n---\n`);
  p("nofm", "只有正文\n");
  writeFileSync(join(e.home, "presets", "ignored.txt"), "x");
  const r = await post(e.port, "/api/presets", {});
  assert.equal(r.status, 200);
  const byId = new Map<string, any>(r.json.presets.map((x: any) => [x.id, x]));
  assert.deepEqual([...byId.keys()].sort(), ["bom", "crlf", "good", "missing", "nodir", "nofm", "relative", "unknown"]);
  assert.deepEqual(byId.get("good"), { id: "good", ok: true, workdir: e.work, model: "anthropic/haiku", tools: ["read", "bash", "memory", "mytool"], memory: true, thinking: "low", handoff: 5000 });
  assert.deepEqual(byId.get("crlf"), { id: "crlf", ok: true, workdir: e.work, model: "a/b", tools: ["read"], memory: false });
  assert.equal(byId.get("bom").ok, true);
  assert.deepEqual(byId.get("bom").tools, []);
  for (const id of ["unknown", "relative", "missing", "nodir", "nofm"]) {
    assert.equal(byId.get(id).ok, false, id);
    assert.equal(typeof byId.get(id).error, "string");
  }
  assert.match(byId.get("unknown").error, /color/);
});

test("预设：没有 presets 目录时是空列表", async (t) => {
  const e = await setupBridge(t);
  rmSync(join(e.home, "presets"), { recursive: true });
  assert.deepEqual((await post(e.port, "/api/presets", {})).json, { presets: [] });
});

test("新建预设：只写认识的字段；不覆盖已有的；ID 和工作目录要合法", async (t) => {
  const e = await setupBridge(t);
  const ok = await post(e.port, "/api/presets/create", { id: "proj.a-1_x", workdir: e.work, model: "anthropic/haiku", tools: ["read", "memory"], thinking: "low", prompt: "你好\n第二行\n", extra: "忽略" });
  assert.deepEqual(ok.json, { ok: true });
  const file = readFileSync(join(e.home, "presets", "proj.a-1_x.md"), "utf8");
  assert.equal(file, `---\nworkdir: ${e.work}\nmodel: anthropic/haiku\ntools: read, memory\nthinking: low\n---\n你好\n第二行\n`);
  const listed = (await post(e.port, "/api/presets", {})).json.presets[0];
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
  const e = await setupBridge(t);
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

test("git：diff 超过 256 KB 截断；坏的 file 参数 400；不是仓库回 repo: false；what 不认识 400", async (t) => {
  const e = await setupBridge(t);
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
  const e = await setupBridge(t);
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
  const e = await setupBridge(t);
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
  const e = await setupBridge(t);
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
  const e = await setupBridge(t);
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

  const e2 = await setupBridge(t, { git: async (args) => (args.includes("status") ? { code: 0, stdout: "## main\0", overflow: true } : { code: 0, stdout: "" }) });
  writePreset(e2, "huge", repo);
  assert.equal((await post(e2.port, "/api/git", { workdir: repo, what: "status" })).status, 500);
});
