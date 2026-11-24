// 工具库（extras/tools）：peek、wait 的脚本在真的服务、真的 Git Bash 里跑（history_dump 见 history.test.ts，web_search 见 web_search.test.ts，create_preset / delete_preset 见 preset_crud.test.ts）；桥的工具定义路由。
// 全部用临时目录和测试管道。脚本的数据目录靠 USERPROFILE 指到临时目录，不碰真的 ~/.tau。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ToolDef } from "../../../src/kernel/types.ts";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import type { Service } from "../../../src/server/serve.ts";
import { runToolDef } from "../../../src/tools/tooldef.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { parseExit } from "../../../extras/gui/bridge/bg.ts";
import { talk } from "../../../extras/tools/client.ts";
import { CATALOG, definitionOf } from "../../../extras/tools/catalog.ts";
import { phaseText } from "../../../extras/tools/wait.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { textOfResult } from "../../plain.ts";

const LIB = join(import.meta.dirname, "..", "..", "..", "extras", "tools").replace(/\\/g, "/");
let dir = "";
let home = "";
let work = "";
let pipe = "";
let svc: Service;
let model = "";
let savedProfile: string | undefined;

/** faux 模型：用户消息带 `slow`（1.5 秒）或 `veryslow`（6 秒）就慢一点；带 `usetool` 就调一次 bash；带 `hold` 就调一次等 30 秒的 bash，进程因此长时间停在等工具。 */
const reply: FauxResponseFactory = async (context) => {
  const last = context.messages.at(-1);
  const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : "";
  if (text.includes("hold")) return fauxAssistantMessage([fauxText("我等着。"), fauxToolCall("bash", { command: "sleep 30" }, { id: "hold1" })], { stopReason: "toolUse" });
  if (text.includes("veryslow")) await sleep(6000);
  else if (text.includes("slow")) await sleep(1500);
  if (text.includes("usetool")) return fauxAssistantMessage([fauxText("我来跑一下。"), fauxToolCall("bash", { command: "echo hi" }, { id: "t1" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText("好的。"));
};

before(async () => {
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "tau-tools-"));
  home = join(dir, "home");
  work = join(dir, "work");
  mkdirSync(join(home, ".tau", "presets"), { recursive: true });
  mkdirSync(join(home, ".tau", "tools"), { recursive: true });
  mkdirSync(work);
  // os.homedir() 在 Windows 上读 USERPROFILE：脚本的数据目录因此落在临时目录。
  savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  pipe = `\\\\.\\pipe\\tau-test-tools-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  faux.setResponses(Array.from({ length: 10_000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  model = `${faux.getModel().provider}/m`;
  writeFileSync(join(home, ".tau", "presets", "t.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash\n---\n提示词。\n`);
  svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, ".tau", "presets"), toolsDir: join(home, ".tau", "tools"), models, memory: sqliteMemory });
});

after(async () => {
  await svc.close();
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

const extras = (...p: string[]) => join(home, ".tau", "extras", ...p);

function defOf(name: string, extra: Partial<ToolDef> = {}): ToolDef {
  const e = CATALOG.find((c) => c.name === name)!;
  return { name, ...(definitionOf(e, LIB) as Omit<ToolDef, "name">), ...extra };
}

/** 像执行器一样运行一个工具：工作目录、环境变量、标准输入的参数都和真的一样。 */
async function tool(name: string, args: unknown, proc: string, extra: Partial<ToolDef> = {}) {
  const r = await runToolDef(defOf(name, extra), args, work, new AbortController().signal, { process: proc, pipe }, true);
  return { text: textOfResult(r), isError: r.isError };
}

async function request(req: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  await talk(pipe, req, (r) => {
    out.push(r);
    return r.type === "receipt" || r.type === "end" || r.type === "error" || r.type === "ps";
  });
  return out;
}

async function start(text: string): Promise<string> {
  const r = await request({ op: "start", preset: "t", text });
  const id = r.find((x) => x.type === "receipt")?.process;
  assert.equal(typeof id, "string", JSON.stringify(r));
  return id;
}

async function phase(id: string): Promise<any> {
  const [ps] = await request({ op: "ps" });
  return ps.processes.find((p: any) => p.self.id === id)?.self.phase;
}

async function untilIdle(id: string, ms = 20_000): Promise<void> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) {
    const p = await phase(id);
    if (p?.tag === "idle" && p.ended !== undefined) return;
  }
  throw new Error(`进程 ${id} 没在 ${ms} 毫秒内结束`);
}

async function untilPhase(id: string, tag: string, ms = 20_000): Promise<void> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if ((await phase(id))?.tag === tag) return;
  throw new Error(`进程 ${id} 没在 ${ms} 毫秒内到 ${tag}`);
}

/** 直接跑工具脚本，`TAU_PROCESS` 指到一个真的进程（和内核执行器给的环境一样）：要一边等一边寄信，所以不用 spawnSync。 */
function spawnTool(file: string, args: unknown, proc: string, meantime: () => Promise<void>): Promise<{ text: string; err: string; status: number | null; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(process.execPath, [join(LIB, file)], { cwd: work, env: { ...process.env, TAU_PROCESS: proc, TAU_PIPE: pipe } });
    let text = "";
    let err = "";
    p.stdout.setEncoding("utf8").on("data", (c: string) => (text += c));
    p.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    p.on("close", (status) => resolve({ text, err, status, ms: Date.now() - t }));
    p.stdin.end(JSON.stringify(args));
    void meantime();
  });
}

async function messages(id: string): Promise<string[]> {
  const rs = await request({ op: "history", process: id });
  return rs.filter((r) => r.type === "message").map((r) => {
    const c = r.message.content;
    return typeof c === "string" ? c : c.map((b: any) => b.text ?? b.name ?? "").join("");
  });
}

describe("工具脚本", () => {
  test("没有 TAU_PROCESS 或 TAU_PIPE：清楚的错误", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("TAU_")) delete env[k];
    for (const s of ["peek.ts", "wait.ts"]) {
      const [file, ...rest] = s.split(" ");
      const r = spawnSync(process.execPath, [`${LIB}/${file}`, ...rest], { env, input: "{}", encoding: "utf8" });
      assert.equal(r.status, 1, s);
      assert.match(r.stderr, /只能在 tau 的工具调用里运行/, s);
    }
  });
});

describe("peek", () => {
  test("只给最后几条：谁说的、文字、工具调用只写名字；每条截断", async () => {
    const id = await start("第一封");
    await untilIdle(id);
    await request({ op: "send", process: id, text: "usetool 请跑" });
    await untilIdle(id);
    await request({ op: "send", process: id, text: "长".repeat(4000) });
    await untilIdle(id);

    const all = await tool("peek", { process: id, last: 20 }, "pk");
    assert.equal(all.isError, false, all.text);
    assert.match(all.text, /^进程 .+，当前段（第 \d+ 段）共 8 条，最后 8 条：/);
    assert.ok(all.text.includes("#0 用户：\n第一封"));
    assert.ok(all.text.includes("助手：\n我来跑一下。\n调用：bash"));
    assert.ok(all.text.includes("工具结果 bash：\nhi\n"));
    assert.ok(all.text.includes("共 4000 字，已截"));
    assert.ok(!all.text.includes("长".repeat(1600)));

    const two = await tool("peek", { process: id, last: 2 }, "pk");
    assert.match(two.text, /最后 2 条：/);
    assert.ok(two.text.includes("#6 用户：") && two.text.includes("#7 助手："));
    assert.ok(!two.text.includes("#5 "));

    const def6 = await tool("peek", { process: id }, "pk");
    assert.match(def6.text, /最后 6 条：/);
  });

  test("别的进程发来的信写明是谁", async () => {
    const id = await start("hi");
    await untilIdle(id);
    const other = await start("hi");
    await untilIdle(other);
    await request({ op: "send", process: id, text: "转告", from: other });
    await untilIdle(id);
    const r = await tool("peek", { process: id, last: 2 }, "pk");
    assert.ok(r.text.includes(`来自进程 ${other}（t）`) || r.text.includes(`进程 ${other}（t）：`), r.text);
  });

  test("没有这个进程：报错，写明可能已被删除，后面是候选；同样的状态下文字一字不差", async () => {
    const r = await tool("peek", { process: "nope-nope" }, "pk");
    assert.equal(r.isError, true);
    assert.match(r.text, /读不到进程 nope-nope：没有这个进程。/);
    assert.match(r.text, /已经被删除了/);
    assert.match(r.text, /现有的进程：|现在没有别的运行中的进程/);
    assert.equal((await tool("peek", { process: "nope-nope" }, "pk")).text, r.text);
  });

  test("ID 写成大写带空格、last 超过 20：照做，最后一行说明", async () => {
    const id = await start("好");
    await untilIdle(id);
    const r = await tool("peek", { process: ` ${id.toUpperCase()} `, last: 50 }, "pk");
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes(`进程 ${id}，当前段`), r.text);
    assert.ok(r.text.includes(`注：process 当作 ${id}；last 最多 20，给了最后 20 条。`), r.text);
  });

  test("装出去的定义：process_id、count 照做，说明写明", async () => {
    const id = await start("好");
    await untilIdle(id);
    const r = await tool("peek", { process_id: id, count: 2 }, "pk");
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /注：参数 process_id 当作 process；peek 没有参数 count，忽略了。/);
  });
});

describe("wait", () => {
  test("等到全部结束：返回每个的状态", async () => {
    const a = await start("slow 一");
    const b = await start("二");
    const t = Date.now();
    const r = await tool("wait", { processes: [a, b], timeout: 30 }, "wt");
    assert.equal(r.isError, false, r.text);
    assert.ok(Date.now() - t < 20_000);
    assert.match(r.text, /^全部结束。/);
    assert.ok(r.text.includes(`- ${a}：已结束，完成`) && r.text.includes(`- ${b}：已结束，完成`), r.text);
  });

  test("已经结束的进程：马上返回", async () => {
    const a = await start("好");
    await untilIdle(a);
    const t = Date.now();
    const r = await tool("wait", { processes: [a, a] }, "wt");
    assert.match(r.text, /^全部结束。/);
    assert.ok(Date.now() - t < 5_000);
  });

  test("超时不算错误：写明还没结束的和它们的阶段", async () => {
    const fast = await start("好");
    // 用 hold（工具等 30 秒）而不是 veryslow（模型睡 6 秒）：全量并发时 spawn 一个工具子进程也可能要几秒，
    // 6 秒的窗口会赶在 wait 读到状态之前关掉，这条测试就偶发地看到“全部结束”。
    const slow = await start("hold 一直想");
    await untilPhase(slow, "awaitingTool");
    const t = Date.now();
    const r = await tool("wait", { processes: [fast, slow], timeout: 1 }, "wt");
    assert.equal(r.isError, false, r.text);
    assert.ok(Date.now() - t < 10_000);
    assert.match(r.text, /^等了 1 秒，还没全部结束/);
    assert.ok(r.text.includes(`- ${slow}：运行中，在等工具`), r.text);
    assert.ok(r.text.includes(`- ${fast}：已结束，完成`), r.text);
    await request({ op: "stop", process: slow });
    await untilIdle(slow);
  });

  test("停止的进程算结束，写明原因", async () => {
    const slow = await start("veryslow 想");
    await sleep(300);
    await request({ op: "stop", process: slow });
    const r = await tool("wait", { processes: [slow], timeout: 30 }, "wt");
    assert.ok(r.text.includes(`- ${slow}：已结束，被停止`), r.text);
  });

  test("没有这个进程：报错，写明已被删除就别再等，列候选；两次文字一样", async () => {
    const r = await tool("wait", { processes: ["nope-nope"], timeout: 5 }, "wt");
    assert.equal(r.isError, true);
    assert.match(r.text, /这些不是现有的进程 ID：nope-nope/);
    assert.match(r.text, /已经被删除了，不用再等/);
    assert.equal((await tool("wait", { processes: ["nope-nope"], timeout: 5 }, "wt")).text, r.text);
  });

  test("一个串里写了逗号分隔的 ID：拆开；timeout 超过 590：照 590 等并说明", async () => {
    const a = await start("好");
    const b = await start("好");
    await untilIdle(a);
    await untilIdle(b);
    const r = await tool("wait", { processes: [`${a},${b}`], timeout: 900 }, "wt");
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^全部结束。/);
    assert.ok(r.text.includes(`- ${a}：已结束`) && r.text.includes(`- ${b}：已结束`), r.text);
    assert.ok(r.text.includes(`注：processes 当作 ${a}、${b}；timeout 最多 590 秒，按 590 秒等。`), r.text);
  });

  test("参数不对：空的、只有自己、超过 8 个", async () => {
    for (const processes of [[], [""]]) {
      const r = await tool("wait", { processes }, "wt");
      assert.equal(r.isError, true, JSON.stringify(processes));
      assert.match(r.text, /processes 是空的/);
    }
    const mine = await tool("wait", { processes: ["wt"] }, "wt");
    assert.equal(mine.isError, true);
    assert.match(mine.text, /processes 里只有你自己（wt）/);
    const many = await tool("wait", { processes: [Array.from({ length: 9 }, (_, i) => `p${i}`).join(",")] }, "wt");
    assert.equal(many.isError, true);
    assert.match(many.text, /一次最多等 8 个进程，收到 9 个/);
  });

  test("等着的时候收到信：提前返回，写明被打断，照常列出每个子进程的状态", async () => {
    const mine = await start("hold 抱着");
    const child = await start("hold 也抱着");
    await untilPhase(mine, "awaitingTool");
    await untilPhase(child, "awaitingTool");
    const r = await spawnTool("wait.ts", { processes: [child], timeout: 10 }, mine, async () => {
      await sleep(400);
      await request({ op: "send", process: mine, text: "来信了" });
    });
    await request({ op: "stop", process: mine });
    await request({ op: "stop", process: child });
    await untilIdle(mine);
    await untilIdle(child);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.ms < 5_000, `用了 ${r.ms} 毫秒`);
    assert.match(r.text, /^被来信打断：有 1 封信排队/);
    assert.match(r.text, /到下一个安全点并入/);
    assert.ok(r.text.includes(`- ${child}：运行中，在等工具`), r.text);
    // 信没丢：这一轮结束以后它在段里。
    assert.ok((await messages(mine)).some((m) => m.includes("来信了")), "信没并进段");
  });

  test("开始等的时候已经有信排队：马上返回，不等 timeout", async () => {
    const mine = await start("hold 抱着");
    const child = await start("hold 也抱着");
    await untilPhase(mine, "awaitingTool");
    await request({ op: "send", process: mine, text: "先来的信" });
    for (let i = 0; i < 100 && ((await phase(mine))?.queued ?? 0) < 1; i++) await sleep(50);
    assert.equal((await phase(mine)).queued, 1, "信没排在队里");
    const r = await spawnTool("wait.ts", { processes: [child], timeout: 10 }, mine, async () => {});
    await request({ op: "stop", process: mine });
    await request({ op: "stop", process: child });
    await untilIdle(mine);
    await untilIdle(child);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.ms < 3_000, `用了 ${r.ms} 毫秒`);
    assert.match(r.text, /^被来信打断：有 1 封信排队/);
    assert.ok(r.text.includes(`- ${child}：运行中，在等工具`), r.text);
  });

  test("processes 里写了自己的 ID：只订阅一次，按等待目标那套规则处理", async () => {
    // 自己的 ID 当普通等待目标：进程在跑就到不了“结束”，所以只能靠被打断或者超时。
    const mine = await start("hold 抱着");
    const child = await start("hold 也抱着");
    await untilPhase(mine, "awaitingTool");
    await untilPhase(child, "awaitingTool");
    const r = await spawnTool("wait.ts", { processes: [mine, child], timeout: 10 }, mine, async () => {
      await sleep(400);
      await request({ op: "send", process: mine, text: "打断" });
    });
    await request({ op: "stop", process: mine });
    await request({ op: "stop", process: child });
    await untilIdle(mine);
    await untilIdle(child);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.ms < 5_000, `用了 ${r.ms} 毫秒`);
    assert.match(r.text, /^被来信打断：有 1 封信排队/);
    assert.ok(!r.text.includes(`- ${mine}：`) && r.text.includes(`- ${child}：运行中，在等工具`), r.text);
    assert.ok(r.text.includes(`注：${mine} 是你自己，等不到自己结束，去掉了。`), r.text);
  });

  test("processes 里有自己和已结束的子进程：去掉自己，马上返回，不等满 timeout", async () => {
    const mine = await start("hold 抱着");
    const child = await start("好");
    await untilPhase(mine, "awaitingTool");
    await untilIdle(child);
    const r = await spawnTool("wait.ts", { processes: [mine, child], timeout: 30 }, mine, async () => {});
    await request({ op: "stop", process: mine });
    await untilIdle(mine);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.ms < 10_000, `用了 ${r.ms} 毫秒`);
    assert.match(r.text, /^全部结束。/);
    assert.ok(!r.text.includes(`- ${mine}：`), r.text);
    assert.equal(r.text.trimEnd().split("\n").at(-1), `注：${mine} 是你自己，等不到自己结束，去掉了。`);
  });

  test("阶段的判断：刚建、还没处理第一封信的 idle 不算结束", () => {
    assert.deepEqual(phaseText({ tag: "idle" }), { text: "刚建好，还没处理第一封信", ended: false });
    assert.equal(phaseText({ tag: "idle", ended: "done" }).ended, true);
    assert.equal(phaseText({ tag: "idle", ended: { error: "炸了" } }).text, "已结束，出错：炸了");
    assert.equal(phaseText({ tag: "awaitingTool" }).ended, false);
  });
});

describe("工具库装出去的定义", () => {
  const lax = (name: string): any => definitionOf(CATALOG.find((c) => c.name === name)!, LIB).parameters;
  const check = (name: string, args: Record<string, unknown>): void => {
    validateToolArguments({ name, description: "", parameters: lax(name) } as any, { type: "toolCall", id: "x", name, arguments: args } as any);
  };

  test("顶层没有 additionalProperties 和 required；必填的说明以（必填）结尾；enum 和范围原样在", () => {
    for (const e of CATALOG) {
      const p = lax(e.name);
      assert.ok(!("additionalProperties" in p) && !("required" in p), e.name);
      for (const r of (e.parameters.required ?? []) as string[]) assert.ok(p.properties[r].description.endsWith("（必填）"), `${e.name}.${r}`);
      for (const [k, v] of Object.entries(e.parameters.properties as Record<string, any>)) {
        for (const key of ["type", "enum", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]) assert.deepEqual(p.properties[k][key], v[key], `${e.name}.${k}.${key}`);
      }
      assert.ok("additionalProperties" in e.parameters || e.parameters.properties !== undefined, "CATALOG 不变");
    }
    assert.equal(CATALOG.find((c) => c.name === "peek")!.parameters.additionalProperties, false);
  });

  test("别的写法能到脚本；取值和范围照旧被内核拒", () => {
    check("peek", { process_id: "x" });
    check("wait", { process: "x" });
    check("web_search", { q: "x" });
    check("history_dump", { segment: 2 });
    assert.throws(() => check("computer", { action: "left_click" }));
    assert.throws(() => check("wait", { processes: [] }));
    assert.throws(() => check("create_preset", { id: "a", workdir: "E:/", model: "a/b", tools: [], prompt: "x", thinking: "HIGH" }));
  });
});

describe("桥：工具定义", () => {
  function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }

  test("列、装、再装、改过以后拒绝覆盖、更新、被预设用到时拒删", async (t) => {
    const bhome = join(dir, "bridge-home");
    mkdirSync(join(bhome, "presets"), { recursive: true });
    const bridge = await createBridge({ port: 0, home: bhome, pipe: `\\\\.\\pipe\\tau-test-none-${process.pid}` });
    t.after(() => bridge.close());
    const { port } = bridge;
    const list = async () => (await post(port, "/api/tools", {})).json;

    let l = await list();
    assert.deepEqual(l.installed, []);
    assert.deepEqual(l.library.map((x: any) => [x.name, x.status]), CATALOG.map((c) => [c.name, "none"]));
    assert.deepEqual(l.library.find((x: any) => x.name === "wait").params, ["processes", "timeout"]);

    assert.equal((await post(port, "/api/tools/install", { name: "nope" })).status, 404);
    for (const e of CATALOG) assert.equal((await post(port, "/api/tools/install", { name: e.name })).status, 200, e.name);
    const file = join(bhome, "tools", "history_dump.json");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["command", "description", "output", "parameters", "timeout"]);
    assert.ok(written.command.includes(`${LIB}/history_dump.ts`), written.command);
    assert.equal(written.timeout, 60);
    assert.deepEqual(Object.keys(written.parameters.properties), []);
    assert.deepEqual(readdirSync(join(bhome, "tools")).sort(), [
      "computer.json",
      "create_preset.json",
      "delete_preset.json",
      "history_dump.json",
      "list_presets.json",
      "peek.json",
      "wait.json",
      "web_search.json",
    ]);

    l = await list();
    assert.deepEqual(l.library.map((x: any) => x.status), CATALOG.map(() => "installed"));
    const hd = l.installed.find((x: any) => x.name === "history_dump");
    assert.deepEqual([hd.params, hd.timeout, hd.output, hd.usedBy], [[], 60, "text", []]);
    assert.equal((await post(port, "/api/tools/install", { name: "history_dump" })).status, 200, "内容一样：再装不报错");

    // 用户改过：状态变成“不同”，不带 replace 就拒绝，文件不动。
    const mine = { ...written, timeout: 5 };
    writeFileSync(file, JSON.stringify(mine));
    assert.equal((await list()).library.find((x: any) => x.name === "history_dump").status, "differs");
    const refused = await post(port, "/api/tools/install", { name: "history_dump" });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /内容和工具库里的不同/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).timeout, 5);
    assert.equal((await post(port, "/api/tools/install", { name: "history_dump", replace: true })).status, 200);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).timeout, 60);
    assert.ok(!existsSync(`${file}.tmp`));

    // 读不出的定义列出来，带原因。
    writeFileSync(join(bhome, "tools", "broken.json"), "{ 不是 json");
    assert.equal((await list()).installed.find((x: any) => x.name === "broken").error, "不是合法的 JSON");

    // 预设用到它：拒删，说是哪些；去掉以后能删。
    writeFileSync(join(bhome, "presets", "p1.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: read, history_dump\n---\nx\n");
    writeFileSync(join(bhome, "presets", "p2.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: peek\n---\nx\n");
    assert.deepEqual((await list()).installed.find((x: any) => x.name === "history_dump").usedBy, ["p1"]);
    const busy = await post(port, "/api/tools/remove", { name: "history_dump" });
    assert.equal(busy.status, 409);
    assert.match(busy.json.error, /p1/);
    assert.ok(existsSync(file));
    writeFileSync(join(bhome, "presets", "p1.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: read\n---\nx\n");
    assert.equal((await post(port, "/api/tools/remove", { name: "history_dump" })).status, 200);
    assert.ok(!existsSync(file));
    assert.equal((await post(port, "/api/tools/remove", { name: "history_dump" })).status, 404);
    assert.equal((await post(port, "/api/tools/remove", { name: "../x" })).status, 400);
    assert.equal((await post(port, "/api/tools/remove", { name: "peek" })).status, 409);
    assert.equal((await list()).library.find((x: any) => x.name === "history_dump").status, "none");
  });

  test("装进去的定义内核认：check 读得出，八个工具都在快照里", async () => {
    const bhome = join(dir, "kernel-home");
    mkdirSync(join(bhome, "presets"), { recursive: true });
    const bridge = await createBridge({ port: 0, home: bhome, pipe: `\\\\.\\pipe\\tau-test-none-${process.pid}` });
    try {
      for (const e of CATALOG) await post(bridge.port, "/api/tools/install", { name: e.name });
    } finally {
      await bridge.close();
    }
    // 服务的工具目录是 home/.tau/tools：把装好的全部拷贝过去，让真的服务读。
    for (const e of CATALOG) writeFileSync(join(home, ".tau", "tools", `${e.name}.json`), readFileSync(join(bhome, "tools", `${e.name}.json`)));
    writeFileSync(
      join(home, ".tau", "presets", "all.md"),
      `---\nworkdir: ${work}\nmodel: ${model}\ntools: read, peek, wait, history_dump, web_search, list_presets, create_preset, delete_preset, computer\n---\nx\n`,
    );
    const [r] = await request({ op: "check", preset: "all" });
    assert.equal(r.type, "check", JSON.stringify(r));
    assert.equal(r.error, null);
    assert.deepEqual(
      r.snapshot.toolDefs.map((d: ToolDef) => d.name).sort(),
      ["computer", "create_preset", "delete_preset", "history_dump", "list_presets", "peek", "wait", "web_search"],
    );
  });
});

test("catalog：每个工具的名字合规，脚本存在，定义没有多余字段", () => {
  assert.deepEqual(CATALOG.map((c) => c.name), ["peek", "wait", "history_dump", "web_search", "list_presets", "create_preset", "delete_preset", "computer"]);
  for (const e of CATALOG) {
    assert.match(e.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(existsSync(join(LIB, e.script)), e.script);
    assert.deepEqual(Object.keys(definitionOf(e, LIB)), ["description", "parameters", "command", "timeout", "output"]);
    assert.ok(e.timeout >= 1 && e.timeout <= 600);
    assert.equal((e.parameters as any).type, "object");
  }
  // 带 wait 参数的工具：自己的 timeout 必须比 wait 的上限大，留出启动和收尾，不然 wait 取大值时被内核先杀掉，走不到“转后台”。
  for (const e of CATALOG) {
    const wait = (e.parameters as any).properties?.wait;
    if (wait !== undefined) assert.ok(e.timeout >= wait.maximum + 30, `${e.name} 的 timeout ${e.timeout} 要比 wait 上限 ${wait.maximum} 至少大 30`);
  }
  // 脚本都能被 node 解析（类型擦除语法）。
  for (const e of CATALOG) execFileSync(process.execPath, ["--check", join(LIB, e.script)]);
});
