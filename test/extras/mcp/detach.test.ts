// 拉起中转时脱离调用者的进程树：用真的服务、真的工具定义跑一次 call.ts。
// 工具 1 秒超时，内核按进程树和 msys 进程组结束命令；relay 和 MCP 服务器必须还活着，之后还能用。
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import type { Service } from "../../../src/server/serve.ts";
import { talk } from "../../../extras/tools/client.ts";

const MCP = join(import.meta.dirname, "..", "..", "..", "extras", "mcp").replace(/\\/g, "/");
const FAKE = join(import.meta.dirname, "fake-server.ts").replace(/\\/g, "/");

let dir = "";
let home = "";
let work = "";
let pipe = "";
let svc: Service;
const saved: Record<string, string | undefined> = {};
const seen = new Set<number>();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killPid = (pid: number): void => void spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });

/** 确认还是我们的进程才杀：全量测试并行跑，旧 PID 可能已经属于别人了。 */
const killOwn = (pid: number): void => {
  if (!alive(pid)) return;
  const cmd = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  if (cmd.toLowerCase().includes("mcp")) killPid(pid);
};

/** 模型的回话：第一次让模型调 mcp_slow，之后收工。 */
const reply: FauxResponseFactory = async (context) => {
  const last = context.messages.at(-1);
  const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : "";
  if (text.includes("跑一下")) return fauxAssistantMessage([fauxText("我来跑一下。"), fauxToolCall("mcp_slow", {}, { id: "t1" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText("好的。"));
};

before(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith("TAU_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "tau-mcp-detach-"));
  home = join(dir, "home");
  work = join(dir, "work");
  mkdirSync(join(home, ".tau", "presets"), { recursive: true });
  mkdirSync(join(home, ".tau", "tools"), { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  saved["USERPROFILE"] = process.env["USERPROFILE"];
  process.env["USERPROFILE"] = home;
  pipe = `\\\\.\\pipe\\tau-test-mcp-detach-${process.pid}-${Math.random().toString(16).slice(2)}`;
  process.env["TAU_MCP_PIPE"] = pipe;

  writeFileSync(join(work, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE, "basic"] } } }));
  // 工具定义：10 秒超时（测试机忙的时候，拉起 relay、起服务器、把调用发出去要好几秒），
  // 慢工具一分钟才回，所以调用一定发出去过，内核也在它回来之前结束了命令。
  writeFileSync(
    join(home, ".tau", "tools", "mcp_slow.json"),
    JSON.stringify({
      description: "调用 MCP 的慢工具。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      command: `node "${MCP}/call.ts" fake slow`,
      timeout: 10,
      output: "content",
    }),
  );
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  faux.setResponses(Array.from({ length: 100 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  writeFileSync(join(home, ".tau", "presets", "t.md"), `---\nworkdir: ${work}\nmodel: ${faux.getModel().provider}/m\ntools: mcp_slow\n---\n提示词。\n`);
  svc = await serve({ pipe: `\\\\.\\pipe\\tau-test-mcp-detach-svc-${process.pid}`, dbPath: join(dir, "tau.db"), presetsDir: join(home, ".tau", "presets"), toolsDir: join(home, ".tau", "tools"), models, memory: sqliteMemory });
});

after(async () => {
  const s = await ask({ op: "status" }).catch(() => null);
  if (s !== null) for (const pid of [s.pid, ...s.instances.map((i: any) => i.pid)]) if (typeof pid === "number") killOwn(pid);
  for (const pid of seen) killOwn(pid);
  await svc.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  await sleep(300);
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

async function request(req: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  await talk(`\\\\.\\pipe\\tau-test-mcp-detach-svc-${process.pid}`, req, (r) => {
    out.push(r);
    return r.type === "receipt" || r.type === "end" || r.type === "error" || r.type === "ps";
  });
  return out;
}

/** 给中转发请求。 */
async function ask(req: Record<string, unknown>): Promise<any> {
  for (let i = 0; i < 100; i++) {
    let reply: any;
    try {
      await talk(pipe, req, (r) => {
        reply = r;
        return true;
      });
    } catch {
      await sleep(100);
      continue;
    }
    if (typeof reply?.pid === "number") seen.add(reply.pid);
    if (Array.isArray(reply?.instances)) for (const x of reply.instances) if (typeof x?.pid === "number") seen.add(x.pid);
    return reply;
  }
  throw new Error("连不上中转进程");
}

test("内核按进程树结束命令以后，中转和 MCP 服务器还活着，之后还能用", async () => {
  const [started] = await request({ op: "start", preset: "t", text: "跑一下" });
  const id = started?.process;
  assert.equal(typeof id, "string", JSON.stringify(started));
  for (let i = 0; i < 400; i++) {
    const [ps] = await request({ op: "ps" });
    const phase = ps.processes.find((p: any) => p.self.id === id)?.self.phase;
    if (phase?.tag === "idle" && phase.ended !== undefined) break;
    await sleep(50);
  }
  const history = await request({ op: "history", process: id });
  const texts = history.filter((r) => r.type === "message").map((r) => (typeof r.message.content === "string" ? r.message.content : r.message.content.map((b: any) => b.text ?? "").join("")));
  assert.ok(
    texts.some((t: string) => t.includes("超时")),
    `工具结果里应该有超时：${JSON.stringify(texts)}`,
  );
  assert.ok(texts.some((t: string) => t.includes("好的。")), "模型应该收到了结果");

  // relay 和服务器都还活着；慢工具那次调用还在服务器那边跑着（busy 大于 0 说明调用确实发出去了）。
  let s = await ask({ op: "status" });
  for (let i = 0; i < 400 && s.instances.length === 0; i++) {
    await sleep(50);
    s = await ask({ op: "status" });
  }
  assert.equal(s.instances.length, 1, JSON.stringify(s));
  assert.equal(alive(s.pid), true, "relay 被一起杀掉了");
  assert.equal(alive(s.instances[0].pid), true, "MCP 服务器被一起杀掉了");
  assert.ok(s.instances[0].busy > 0, "慢工具应该在服务器那边还在跑");

  // 换一个调用方，用同一个 relay 再调一次：管道和实例都还能用。
  const again = spawnSync(process.execPath, [`${MCP}/call.ts`, "fake", "count"], {
    cwd: work,
    env: { ...(process.env as Record<string, string>), TAU_PROCESS: "after-kill", TAU_MCP_PIPE: pipe },
    input: "{}",
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), [{ type: "text", text: "count=1" }]);
});
