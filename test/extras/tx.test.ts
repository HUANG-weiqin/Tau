// tx（extras/tx）：外部主 Agent 用的命令行。真的服务、真的 node 子进程、临时管道和临时目录，不碰正式服务和 ~/.tau。
// 服务在测试进程里，所以命令只能异步起（spawnSync 会堵住服务）。每条命令的 cwd 都是临时目录。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { serve } from "../../src/server/serve.ts";
import type { Service } from "../../src/server/serve.ts";
import { talk } from "../../extras/tools/client.ts";
import { png } from "../images.ts";
import { winPath } from "../../extras/tx/args.ts";
import { finalOf, psLine } from "../../extras/tx/cmds.ts";

const REPO = join(import.meta.dirname, "..", "..");
const MAIN = join(REPO, "extras", "tx", "main.ts");

let dir = "";
let home = "";
let work = "";
let pipe = "";
let svc: Service;
let savedProfile: string | undefined;
let loopId = 0;

const lastUser = (context: { messages: any[] }): string => {
  const last = context.messages.at(-1);
  if (last?.role !== "user") return "";
  return typeof last.content === "string" ? last.content : last.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
};

/** faux 模型：`veryslow` 等 4 秒，`slow` 等 1.2 秒；带 `loop` 的会话一直调 self（用来凑够步数）；其余回“答：”加用户消息的末尾。 */
const reply: FauxResponseFactory = async (context) => {
  const text = lastUser(context as any);
  const lastMsg = (context.messages as any[]).at(-1);
  const first0 = (context.messages as any[]).find((m) => m.role === "user");
  const firstText0 = typeof first0?.content === "string" ? first0.content : (first0?.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
  // bgjob：先调一个转后台的 bash，回“等信”结束这一轮；后台跑完的信来了，才回真结果。spawnkid：派一个慢的子进程，回“派出去了”；子进程的回信来了，才回真结果。
  if (firstText0.includes("bgjob")) {
    if (text.includes("[后台任务")) return fauxAssistantMessage(fauxText("后台好了：真结果"));
    if (lastMsg?.role === "toolResult") return fauxAssistantMessage(fauxText("等信"));
    return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 4", timeout: 0 }, { id: `bg${loopId++}` })], { stopReason: "toolUse" });
  }
  if (firstText0.includes("spawnkid")) {
    if (lastMsg?.role === "toolResult") return fauxAssistantMessage(fauxText("派出去了"));
    if (lastMsg?.role === "user" && lastMsg === first0) return fauxAssistantMessage([fauxToolCall("spawn", { preset: "u", text: "veryslow 子" }, { id: `sp${loopId++}` })], { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxText("子进程回了：真结果"));
  }
  if (text.includes("veryslow")) await sleep(4000);
  else if (text.includes("slow")) await sleep(1200);
  const first = (context.messages as any[]).find((m) => m.role === "user");
  const firstText = typeof first?.content === "string" ? first.content : (first?.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
  if (firstText.includes("loop")) return fauxAssistantMessage([fauxToolCall("self", {}, { id: `s${loopId++}` })], { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText(`答：${text.replace(/\s+/g, " ").slice(-80)}`));
};

before(async () => {
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "tau-tx-"));
  home = join(dir, "home");
  work = join(dir, "work");
  mkdirSync(join(home, ".tau", "presets"), { recursive: true });
  mkdirSync(join(home, ".tau", "tools"), { recursive: true });
  mkdirSync(work);
  savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  pipe = `\\\\.\\pipe\\tau-test-tx-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  faux.setResponses(Array.from({ length: 20_000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = `${faux.getModel().provider}/m`;
  writeFileSync(join(home, ".tau", "presets", "t.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash\n---\n你是测试助手。\n`);
  writeFileSync(join(home, ".tau", "presets", "u.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash\n---\n另一个测试助手。\n`);
  writeFileSync(join(home, ".tau", "presets", "p.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash, agents\n---\n会派子进程的助手。\n`);
  svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, ".tau", "presets"), toolsDir: join(home, ".tau", "tools"), models, memory: sqliteMemory });
});

after(async () => {
  await svc.close();
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

interface Out {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, TAU_PIPE: pipe, USERPROFILE: home, ...extra };
  return e;
}

/** 跑 `tx`：node 直接跑 main.ts，cwd 是临时目录。 */
function tx(args: string[], o: { input?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<Out> {
  return run(process.execPath, [MAIN, ...args], o);
}

function run(cmd: string, args: string[], o: { input?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<Out> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const c = spawn(cmd, args, { cwd: o.cwd ?? work, env: env(o.env), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    c.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const kill = setTimeout(() => c.kill(), 90_000);
    c.on("error", reject);
    c.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, out, err, ms: Date.now() - t0 });
    });
    c.stdin.end(o.input ?? "");
  });
}

/** 发一个请求，收齐回复直到服务关闭连接。 */
async function ask(request: Record<string, unknown>): Promise<any[]> {
  const rs: any[] = [];
  await talk(pipe, request, (r) => void rs.push(r));
  return rs;
}

let counter = 0;
const newId = (): string => `tx${process.pid % 1000}x${counter++}`;

/** 起一个进程，返回 ID。 */
async function startProc(text: string, preset = "t"): Promise<string> {
  const id = newId();
  const r = await tx(["start", "--id", id, preset, text]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), id);
  return id;
}

async function stopAll(...ids: string[]): Promise<void> {
  const r = await tx(["stop", ...ids]);
  assert.equal(r.code, 0, r.err);
}

// ---------- 纯函数 ----------

describe("路径转换", () => {
  const cwd = "C:\\base\\dir";
  test("盘符路径、正斜杠、Git Bash 的 /c/x 都变成 Windows 绝对路径", () => {
    assert.equal(winPath("C:\\x\\y", cwd), "C:\\x\\y");
    assert.equal(winPath("C:/x/y", cwd), "C:\\x\\y");
    assert.equal(winPath("/c/x/y", cwd), "C:\\x\\y");
    assert.equal(winPath("/d", cwd), "D:\\");
    assert.equal(winPath("\\\\host\\share\\x", cwd), "\\\\host\\share\\x");
  });
  test("相对路径按调用方的当前目录解析", () => {
    assert.equal(winPath("sub\\a.png", cwd), "C:\\base\\dir\\sub\\a.png");
    assert.equal(winPath("./a.png", cwd), "C:\\base\\dir\\a.png");
    assert.equal(winPath("..\\a.png", cwd), "C:\\base\\a.png");
  });
  test("其它以 / 开头的路径是用法错误，提示 cygpath -w", () => {
    assert.throws(() => winPath("/tmp/x", cwd), /cygpath -w/);
    assert.throws(() => winPath("/usr", cwd), /cygpath -w/);
  });
});

describe("最终回复和 ps 行", () => {
  const u = (t: string) => ({ role: "user", content: t });
  const a = (...t: string[]) => ({ role: "assistant", content: t.map((x) => ({ type: "text", text: x })) });
  const r = { role: "toolResult", content: [{ type: "text", text: "x" }] };
  test("从末尾往前：先遇到用户消息是空串；先遇到助手消息连接 text 块；工具结果跳过", () => {
    assert.equal(finalOf([u("a"), a("你好", "世界")]), "你好世界");
    assert.equal(finalOf([u("a"), a("答"), r]), "答");
    assert.equal(finalOf([u("a"), a("答"), u("b")]), "");
    assert.equal(finalOf([]), "");
    assert.equal(finalOf([u("a"), { role: "assistant", content: [{ type: "toolCall", id: "1", name: "x", arguments: {} }, { type: "text", text: "只这个" }] }]), "只这个");
  });
  test("ps 行带父进程、模型、排队数、后台命令数、在跑的子进程数；不带累计用量", () => {
    const self = {
      id: "ab", preset: "t", model: "faux/m", parent: "pp", age: 5_400_000, segment: 2, context: { used: 1500, window: 200_000, threshold: 1 },
      phase: { tag: "awaitingTool", steps: 3, queued: 2 }, usage: { input: 1200, output: 30, cacheRead: 5, cacheWrite: 0 },
    };
    const line = psLine({ ...self, bgJobs: [{ id: "a1b2c3", age: 1 }, { id: "d4e5f6", age: 2 }] } as any, 1);
    for (const s of ["ab", "t", "等工具 第3步", "1.5k/200.0k", "段2", "1.5时", "父 pp", "模型 faux/m", "排队 2", "后台 2", "子进程 1"]) assert.ok(line.includes(s), `${s} 不在：${line}`);
    assert.ok(!line.includes("用量"), line);
    const idle = psLine({ ...self, parent: undefined, phase: { tag: "idle", ended: "done" } } as any);
    assert.ok(idle.includes("idle(done)") && idle.includes("父 -") && idle.includes("排队 0") && idle.includes("后台 0") && idle.includes("子进程 0"), idle);
  });
});

// ---------- 帮助和用法 ----------

describe("帮助和用法", () => {
  test("不带参数和 help：打印用法，退出码 0", async () => {
    for (const args of [[], ["help"]]) {
      const r = await tx(args);
      assert.equal(r.code, 0);
      for (const s of ["tx start", "tx post", "tx wait", "tx result", "tx ps", "tx history", "tx stop", "tx rm", "tx fork", "tx presets", "tx req", "<<'EOF'", "inspect", "check", "memory_write", "reconfigure", "prune", "sweep", "backup", "blob", "watch", "~/.tau/presets/<id>.md", "~/.tau/tools/<name>.json", "[Console]::OutputEncoding", "$OutputEncoding = [Text.UTF8Encoding]::new($false)", "@'", "tx.cmd", "main.ts", "--timeout 10", "后台命令"]) {
        assert.ok(r.out.includes(s), `用法里没有 ${s}`);
      }
      const root = join(REPO).replace(/\\/g, "/");
      assert.ok(r.out.includes(`${root}/docs/design/mvp.md`) && r.out.includes(`${root}/.knowledge/kb-tools.md`), "文档路径要是绝对路径");
      assert.ok(r.out.includes(join(REPO, "extras", "tx", "main.ts")), "要有 main.ts 的绝对路径");
      assert.ok(!/^\s+EOF$/m.test(r.out) && !r.out.includes("用量"), "heredoc 的 EOF 要顶格，ps 没有用量列");
    }
  });
  test("不认识的命令：退出码 2，指向 tx help", async () => {
    const r = await tx(["nope"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /tx help/);
  });
  test("选项写在位置参数后面：用法错误；等号写法也是；没发出请求", async () => {
    const before = (await ask({ op: "ps" }))[0].processes.length;
    for (const args of [["start", "t", "任务", "--id", "zz1"], ["start", "t", "任务", "--id=zz1"], ["start", "t", "任务", "--workdir", "x"], ["post", "x", "hi", "--handoff"], ["wait", "x", "--any"], ["history", "x", "--last", "3"], ["fork", "x", "--before", "1"]]) {
      const r = await tx(args);
      assert.equal(r.code, 2, `${args.join(" ")}：${r.err}`);
      assert.match(r.err, /挪到/);
    }
    assert.equal((await ask({ op: "ps" }))[0].processes.length, before);
  });
  test("正文里真要写选项的字：和别的字放进同一个参数就行", async () => {
    const id = newId();
    const r = await tx(["start", "--id", id, "t", "请解释 --id 的意思"]);
    assert.equal(r.code, 0, r.err);
    await tx(["wait", id]);
    await tx(["rm", id]);
  });
  test("未知选项、缺参数、空正文：退出码 2", async () => {
    assert.equal((await tx(["start", "--bogus", "t", "x"])).code, 2);
    assert.equal((await tx(["start"])).code, 2);
    assert.equal((await tx(["start", "t"])).code, 2);
    assert.equal((await tx(["start", "t", ""])).code, 2);
    assert.equal((await tx(["post", "x"])).code, 2);
    assert.equal((await tx(["wait"])).code, 2);
    assert.equal((await tx(["wait", "--timeout", "abc", "x"])).code, 2);
    assert.equal((await tx(["result"])).code, 2);
    assert.equal((await tx(["stop"])).code, 2);
    assert.equal((await tx(["history", "--last", "0", "x"])).code, 2);
    assert.equal((await tx(["start", "--id", "Bad ID", "t", "x"])).code, 2);
  });
  test("连不上服务：退出码 2，提示 tau serve", async () => {
    const r = await tx(["ps"], { env: { TAU_PIPE: `${pipe}-nobody` } });
    assert.equal(r.code, 2);
    assert.match(r.err, /tau serve/);
  });
});

// ---------- start / post ----------

describe("start", () => {
  test("收到回执就返回，不等这一轮结束；ID 就是给的 ID；进程还在跑", async () => {
    const id = newId();
    const r = await tx(["start", "--id", id, "t", "veryslow 任务"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${id}\n`);
    assert.ok(r.ms < 3500, `start 等了 ${r.ms} 毫秒，不该等模型`);
    const ps = await tx(["ps", id]);
    assert.match(ps.out, /等模型/);
    await stopAll(id);
  });
  test("没给 --id：tx 自己生成合格的 ID", async () => {
    const r = await tx(["start", "t", "你好"]);
    assert.equal(r.code, 0, r.err);
    const id = r.out.trim();
    assert.match(id, /^[0-9a-z][0-9a-z_-]{0,31}$/);
    assert.equal((await tx(["wait", id])).code, 0);
  });
  test("其余参数用一个空格连接", async () => {
    const id = newId();
    assert.equal((await tx(["start", "--id", id, "t", "你好", "世界", "三"])).code, 0);
    const rows = await ask({ op: "history", process: id });
    assert.ok(rows.some((m) => m.type === "message" && JSON.stringify(m.message).includes("你好 世界 三")));
  });
  test("正文是 - 从标准输入读，UTF-8，保留多行，去掉末尾换行", async () => {
    const id = newId();
    const r = await tx(["start", "--id", id, "t", "-"], { input: "第一行：中文\n第二行\n\n" });
    assert.equal(r.code, 0, r.err);
    const rows = await ask({ op: "history", process: id });
    const user = rows.find((m) => m.type === "message" && m.message.role === "user");
    assert.ok(JSON.stringify(user.message).includes("第一行：中文\\n第二行"), JSON.stringify(user.message));
    assert.ok(!JSON.stringify(user.message).includes("第二行\\n\\n"));
  });
  test("--workdir：C:/x、C:\\x、/c/x 都认；相对路径按调用方的当前目录；/tmp 是用法错误", async () => {
    const sub = join(work, "sub");
    mkdirSync(sub, { recursive: true });
    const drive = sub[0]!.toLowerCase();
    const rest = sub.slice(2).replace(/\\/g, "/");
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    for (const w of [sub, sub.replace(/\\/g, "/"), `/${drive}${rest}`, "sub"]) {
      const id = newId();
      const r = await tx(["start", "--id", id, "--workdir", w, "t", "x"], { cwd: work });
      assert.equal(r.code, 0, `${w}：${r.err}`);
      const rec = (await ask({ op: "inspect", process: id })).find((x) => x.type === "process");
      assert.equal(norm(rec.process.preset.workdir), norm(sub), w);
    }
    const bad = await tx(["start", "--workdir", "/tmp", "t", "x"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /cygpath -w/);
  });
  test("--image：读文件转 base64，可重复；相对路径；文件读不出退出码 2、没发请求", async () => {
    writeFileSync(join(work, "a.png"), png(2, 2, 1));
    writeFileSync(join(work, "b.png"), png(3, 3, 2));
    const id = newId();
    const r = await tx(["start", "--id", id, "--image", "a.png", "--image", join(work, "b.png"), "t", "看图"]);
    assert.equal(r.code, 0, r.err);
    const rows = await ask({ op: "history", process: id });
    const user = rows.find((m) => m.type === "message" && m.message.role === "user");
    assert.equal(user.message.content.filter((b: any) => b.type === "image").length, 2);
    const id2 = newId();
    const miss = await tx(["start", "--id", id2, "--image", "nofile.png", "t", "看图"]);
    assert.equal(miss.code, 2);
    assert.equal((await ask({ op: "inspect", process: id2 })).at(-1).type, "error");
    assert.equal((await tx(["start", "--image", "/tmp/a.png", "t", "x"])).code, 2);
  });
  test("预设拼错：退出码 1，列出现有的预设；ID 重复：退出码 1", async () => {
    const r = await tx(["start", "tt", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /现有的预设/);
    assert.match(r.err, /\bt\b/);
    assert.match(r.err, /\bu\b/);
    const id = await startProc("占位");
    const dup = await tx(["start", "--id", id, "t", "x"]);
    assert.equal(dup.code, 1);
  });
});

describe("post", () => {
  test("收到回执就返回，退出码 0；寄的信排进队里，下一轮处理", async () => {
    const id = await startProc("一");
    assert.equal((await tx(["wait", id])).code, 0);
    const r = await tx(["post", id, "二", "二"]);
    assert.equal(r.code, 0, r.err);
    const w = await tx(["wait", id]);
    assert.match(w.out, /答：二 二/);
  });
  test("post 之后紧接着 wait：拿到的是新一轮，不是上一轮的 idle(done)", async () => {
    const id = await startProc("第一轮");
    assert.match((await tx(["wait", id])).out, /答：第一轮/);
    for (let i = 0; i < 3; i++) {
      assert.equal((await tx(["post", id, `slow 新一轮${i}`])).code, 0);
      const w = await tx(["wait", id]);
      assert.equal(w.code, 0);
      assert.ok(w.out.includes(`新一轮${i}`), `第 ${i} 次拿到旧的：${w.out}`);
      assert.ok(w.ms > 900, `wait 太快（${w.ms} 毫秒），没等新一轮`);
    }
  });
  test("正文是 -：从标准输入读；--handoff 真调用；进程不存在：退出码 1，列出候选", async () => {
    const id = await startProc("一");
    await tx(["wait", id]);
    const ho = await tx(["post", "--handoff", id, "请交接"]);
    assert.equal(ho.code, 0, ho.err);
    await tx(["wait", id]);
    assert.equal((await tx(["post", id, "-"], { input: "来自\n标准输入\n" })).code, 0);
    assert.match((await tx(["wait", id])).out, /标准输入/);
    const bad = await tx(["post", "nonexist", "x"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, new RegExp(id));
  });
  test("--image 可用", async () => {
    writeFileSync(join(work, "c.png"), png(2, 2, 3));
    const id = await startProc("一");
    await tx(["wait", id]);
    assert.equal((await tx(["post", "--image", "c.png", id, "再看"])).code, 0);
    assert.equal((await tx(["wait", id])).code, 0);
  });
});

// ---------- wait / result ----------

describe("wait", () => {
  test("默认等全部：按给的顺序每个进程一段，标题行写 ID、预设和结束原因，下面是最终回复", async () => {
    const a = await startProc("slow 甲");
    const b = await startProc("乙", "u");
    const r = await tx(["wait", a, b]);
    assert.equal(r.code, 0, r.err);
    const ia = r.out.indexOf(a);
    const ib = r.out.indexOf(b);
    assert.ok(ia >= 0 && ib > ia, r.out);
    assert.match(r.out, new RegExp(`${a}.*t.*正常结束|${a}.*t.*完成`));
    assert.match(r.out, new RegExp(`${b}.*u`));
    assert.ok(r.out.includes("答：slow 甲") && r.out.includes("答：乙"), r.out);
    const rev = await tx(["wait", b, a]);
    assert.ok(rev.out.indexOf(b) < rev.out.indexOf(a));
  });
  test("--any：有一个结束就返回，没结束的只写状态；退出码 0", async () => {
    const slow = await startProc("veryslow 慢");
    const fast = await startProc("快");
    const r = await tx(["wait", "--any", slow, fast]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.ms < 3500, `等了 ${r.ms} 毫秒`);
    assert.ok(r.out.includes("答：快"));
    assert.ok(!r.out.includes("答：veryslow"));
    assert.match(r.out, new RegExp(`${slow}[^\\n]*\\n[^\\n]*运行中`));
    await stopAll(slow);
  });
  test("超时：退出码 4，输出各进程的状态；超时不算错误", async () => {
    const slow = await startProc("veryslow 慢");
    const r = await tx(["wait", "--timeout", "1", slow]);
    assert.equal(r.code, 4);
    assert.match(r.out, /运行中/);
    assert.ok(r.ms < 3500);
    await stopAll(slow);
  });
  test("刚建、不带原因的 idle 不算结束（fork 出来的进程）", async () => {
    const src = await startProc("veryslow 一");
    const f = await tx(["fork", "--before", "0", src]);
    assert.equal(f.code, 0, f.err);
    const r = await tx(["wait", "--timeout", "1", f.out.trim()]);
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /刚建好/);
    await stopAll(src);
  });
  test("进程 ID 转小写、逗号分隔：当作小写，标准错误说一句；不存在的退出码 1，列出候选", async () => {
    const real = await startProc("一");
    const real2 = await startProc("二");
    const mixed = await tx(["wait", `${real.toUpperCase()},${real2}`]);
    assert.equal(mixed.code, 0, mixed.err);
    assert.match(mixed.err, new RegExp(`${real.toUpperCase()}.*${real}`));
    assert.ok(mixed.out.includes("答：一") && mixed.out.includes("答：二"));
    for (const args of [["result", real.toUpperCase()], ["ps", real.toUpperCase()], ["history", real.toUpperCase()]]) {
      const r = await tx(args);
      assert.equal(r.code, 0, `${args[0]}：${r.err}`);
      assert.match(r.err, /转小写|当作/);
    }
    const r = await tx(["wait", real, "nonexist"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /nonexist/);
    assert.match(r.err, new RegExp(real));
  });
  test("被停止的进程也算结束，原因写在输出里，退出码 0", async () => {
    const id = await startProc("veryslow 要停");
    await stopAll(id);
    const r = await tx(["wait", id]);
    assert.equal(r.code, 0);
    assert.match(r.out, /被停止/);
  });
});

describe("result", () => {
  test("正常结束：回复写到标准输出，退出码 0，标准错误是空的", async () => {
    const id = await startProc("你好");
    await tx(["wait", id]);
    const r = await tx(["result", id]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "答：你好\n");
    assert.equal(r.err, "");
  });
  test("还没结束：标准错误写状态，退出码 4，标准输出是空的", async () => {
    const id = await startProc("veryslow 慢");
    const r = await tx(["result", id]);
    assert.equal(r.code, 4);
    assert.match(r.err, /运行中/);
    assert.equal(r.out, "");
    await stopAll(id);
  });
  test("被停止：标准错误写 [本轮结束：被停止]，退出码 1", async () => {
    const id = await startProc("veryslow 慢");
    await stopAll(id);
    await tx(["wait", id]);
    const r = await tx(["result", id]);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[本轮结束：被停止\]/);
  });
  test("步数用完：标准错误写 [本轮结束：步数用完]，退出码 1", { timeout: 180_000 }, async () => {
    const id = await startProc("loop 一直调");
    const w = await tx(["wait", "--timeout", "150", id]);
    assert.equal(w.code, 0, w.out + w.err);
    assert.match(w.out, /步数用完/);
    const r = await tx(["result", id]);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[本轮结束：步数用完\]/);
  });
  test("进程不存在：退出码 1；刚建好：退出码 4", async () => {
    assert.equal((await tx(["result", "nonexist"])).code, 1);
    const src = await startProc("veryslow 一");
    const f = (await tx(["fork", "--before", "0", src])).out.trim();
    const r = await tx(["result", f]);
    assert.equal(r.code, 4);
    assert.match(r.err, /刚建好/);
    await stopAll(src);
  });
});

// ---------- ps / history ----------

describe("ps 和 history", () => {
  test("ps 每个进程一行，带 ID 只列这些；不存在的 ID 退出码 1 并列候选", async () => {
    const a = await startProc("甲");
    const b = await startProc("乙");
    await tx(["wait", a, b]);
    const all = await tx(["ps"]);
    assert.equal(all.code, 0);
    assert.ok(all.out.includes(a) && all.out.includes(b));
    assert.match(all.out, /模型 .*\/m/);
    const one = await tx(["ps", a]);
    assert.equal(one.code, 0);
    assert.ok(one.out.includes(a) && !one.out.includes(b));
    assert.equal(one.out.trim().split("\n").filter((l) => l.includes(a)).length, 1);
    const bad = await tx(["ps", a, "nonexist"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /nonexist/);
  });
  test("history：消息写成可读的文字；--last 只留最后几条；--segment 选段", async () => {
    const id = await startProc("第一句");
    await tx(["wait", id]);
    await tx(["post", id, "第二句"]);
    await tx(["wait", id]);
    const all = await tx(["history", id]);
    assert.equal(all.code, 0);
    assert.ok(all.out.includes("第一句") && all.out.includes("第二句") && all.out.includes("助手"));
    const last = await tx(["history", "--last", "1", id]);
    assert.ok(last.out.includes("答：第二句") && !last.out.includes("第一句"));
    assert.equal((await tx(["history", "--segment", "1", id])).code, 0);
    assert.equal((await tx(["history", "--segment", "9", id])).code, 1);
    assert.equal((await tx(["history", "nonexist"])).code, 1);
  });
});

// ---------- stop / rm / fork / presets ----------

describe("stop、rm、fork、presets", () => {
  test("stop 多个进程；不存在的 ID 退出码 1", async () => {
    const a = await startProc("veryslow 甲");
    const b = await startProc("veryslow 乙");
    assert.equal((await tx(["stop", a, b])).code, 0);
    const w = await tx(["wait", a, b]);
    assert.equal(w.code, 0);
    assert.equal((w.out.match(/被停止/g) ?? []).length, 2);
    assert.equal((await tx(["stop", "nonexist"])).code, 1);
  });
  test("rm：删空闲的进程；之后 ps 它退出码 1；运行中的删不掉，退出码 1", async () => {
    const a = await startProc("甲");
    await tx(["wait", a]);
    const r = await tx(["rm", a]);
    assert.equal(r.code, 0, r.err);
    assert.equal((await tx(["ps", a])).code, 1);
    const b = await startProc("veryslow 乙");
    assert.equal((await tx(["rm", b])).code, 1);
    await stopAll(b);
    assert.equal((await tx(["rm", "nonexist"])).code, 1);
  });
  test("fork：打印新进程的 ID；--id、--before、--preset；运行中的源进程不带 --before 退出码 1", async () => {
    const src = await startProc("第一句");
    await tx(["wait", src]);
    const plain = await tx(["fork", src]);
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out.trim(), /^[0-9a-z][0-9a-z_-]{0,31}$/);
    const id = newId();
    const named = await tx(["fork", "--id", id, "--before", "0", "--preset", "u", src]);
    assert.equal(named.code, 0, named.err);
    assert.equal(named.out.trim(), id);
    const rec = (await ask({ op: "inspect", process: id })).find((x) => x.type === "process");
    assert.equal(rec.process.preset.id, "u");
    const run = await startProc("veryslow 跑");
    assert.equal((await tx(["fork", run])).code, 1);
    assert.equal((await tx(["fork", "--before", "0", run])).code, 0);
    assert.equal((await tx(["fork", "nonexist"])).code, 1);
    await stopAll(run);
  });
  test("presets：每个预设一行，ID 和一句说明", async () => {
    const r = await tx(["presets"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /\bt\b.*你是测试助手/);
    assert.match(r.out, /\bu\b.*另一个测试助手/);
  });
});

// ---------- req ----------

describe("req", () => {
  test("普通请求：每行回复原样一行 JSON，退出码 0", async () => {
    const id = await startProc("一");
    await tx(["wait", id]);
    const r = await tx(["req", '{"op":"ps"}']);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.equal(lines.length, 1);
    const reply = JSON.parse(lines[0]!);
    assert.equal(reply.type, "ps");
    assert.ok(reply.processes.some((p: any) => p.self.id === id));
    const h = await tx(["req", JSON.stringify({ op: "history", process: id })]);
    const types = h.out.trim().split("\n").map((l) => JSON.parse(l).type);
    assert.equal(types.at(-1), "end");
    assert.ok(types.filter((t) => t === "message").length >= 2);
  });
  test("-：从标准输入读请求；协议新加的请求也能走（check、memory）", async () => {
    const r = await tx(["req", "-"], { input: '{"op":"check","preset":"t"}\n' });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out.trim()).type, "check");
    const m = await tx(["req", '{"op":"memory"}']);
    assert.equal(m.code, 0);
    assert.equal(JSON.parse(m.out.trim()).type, "namespaces");
  });
  test("error 回复：照样写出，退出码 1", async () => {
    const r = await tx(["req", '{"op":"history","process":"nonexist"}']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out.trim()).type, "error");
  });
  test("watch 加 --timeout：到点截断，退出码 4，已收到的行都写出来", async () => {
    const id = await startProc("一");
    await tx(["wait", id]);
    const r = await tx(["req", "--timeout", "1", JSON.stringify({ op: "watch", process: id })]);
    assert.equal(r.code, 4);
    const first = JSON.parse(r.out.trim().split("\n")[0]!);
    assert.equal(first.type, "update");
    assert.equal(first.self.id, id);
    assert.ok(r.ms < 4000);
  });
  test("请求不是 JSON、不是带 op 的对象：退出码 2，没发请求", async () => {
    assert.equal((await tx(["req", "not json"])).code, 2);
    assert.equal((await tx(["req", "[1]"])).code, 2);
    assert.equal((await tx(["req", '{"x":1}'])).code, 2);
    assert.equal((await tx(["req"])).code, 2);
  });
});

// ---------- 后台命令和子进程还在跑：不算结束 ----------

describe("后台命令和子进程", () => {
  test("后台命令还在跑：wait 不算结束，状态写清；result 打印回复但退出码 4；ps 标出；跑完才算结束", { timeout: 60_000 }, async () => {
    const id = await startProc("bgjob 跑后台");
    const w = await tx(["wait", "--timeout", "2", id]);
    assert.equal(w.code, 4, w.out + w.err);
    assert.match(w.out, /这一轮停了，但还有 1 个后台命令/);
    assert.ok(!w.out.includes("等信\n\n"), "没结束就不写最终回复");
    const r = await tx(["result", id]);
    assert.equal(r.code, 4, r.err);
    assert.equal(r.out, "等信\n");
    assert.match(r.err, /回复可能还会变/);
    const ps = await tx(["ps", id]);
    assert.match(ps.out, /后台 1/);
    const done = await tx(["wait", "--timeout", "40", id]);
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /后台好了：真结果/);
    assert.equal((await tx(["result", id])).out, "后台好了：真结果\n");
    assert.match((await tx(["ps", id])).out, /后台 0/);
  });
  test("子进程还在跑：同样不算结束；ps 标出子进程数；子进程回信以后才算结束", { timeout: 60_000 }, async () => {
    const id = newId();
    assert.equal((await tx(["start", "--id", id, "p", "spawnkid 派一个"])).code, 0);
    await sleep(800);
    const w = await tx(["wait", "--timeout", "2", id]);
    assert.equal(w.code, 4, w.out + w.err);
    assert.match(w.out, /1 个子进程/);
    const r = await tx(["result", id]);
    assert.equal(r.code, 4);
    assert.match(r.err, /回复可能还会变/);
    assert.match((await tx(["ps", id])).out, /子进程 1/);
    const done = await tx(["wait", "--timeout", "40", id]);
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /子进程回了：真结果/);
    assert.match((await tx(["ps", id])).out, /子进程 0/);
  });
});

// ---------- 标准输入的 BOM、断线的退出码 ----------

describe("BOM 和断线", () => {
  test("标准输入开头有两个 BOM（Windows PowerShell 5.1）：start 的正文干净，req 的 JSON 能解析", async () => {
    const id = newId();
    const r = await tx(["start", "--id", id, "t", "-"], { input: "\uFEFF\uFEFF中文正文\n" });
    assert.equal(r.code, 0, r.err);
    const rows = await ask({ op: "history", process: id });
    const user = rows.find((m) => m.type === "message" && m.message.role === "user");
    assert.ok(JSON.stringify(user.message).includes("中文正文") && !JSON.stringify(user.message).includes("\uFEFF"), JSON.stringify(user.message));
    const q = await tx(["req", "-"], { input: '\uFEFF\uFEFF{"op":"ps"}\n' });
    assert.equal(q.code, 0, q.err);
    assert.equal(JSON.parse(q.out.trim()).type, "ps");
  });
  test("正文里的 & | < > ^ % 和引号：直接用 node 调，一字不差", async () => {
    const id = newId();
    const body = 'R&D a|b >c ^d %USERPROFILE% "引号"';
    assert.equal((await tx(["start", "--id", id, "t", body])).code, 0);
    assert.ok(JSON.stringify(await ask({ op: "history", process: id })).includes(JSON.stringify(body).slice(1, -1)));
  });
  test("stop、rm 遇到断线：退出码 3，不是 1", async () => {
    const dead = `\\\\.\\pipe\\tau-test-tx-dead-${process.pid}`;
    const { createServer } = await import("node:net");
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((res) => srv.listen(dead, res));
    try {
      for (const cmd of ["stop", "rm"]) {
        const r = await tx([cmd, "abc"], { env: { TAU_PIPE: dead } });
        assert.equal(r.code, 3, `${cmd}：${r.err}`);
      }
    } finally {
      srv.close();
    }
  });
});

// ---------- 启动脚本 ----------

describe("启动脚本 tx", () => {
  const bash = (() => {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && existsSync(join(d, "git.exe")));
    return dirs.flatMap((d) => [d, path.dirname(d), path.dirname(path.dirname(d))]).map((r) => join(r, "bin", "bash.exe")).find((p) => existsSync(p));
  })();
  const sh = (args: string[], input = ""): Promise<Out> => run(bash!, [join(REPO, "tx").replace(/\\/g, "/"), ...args], { input });

  test("文件在：tx、tx.cmd；tx 是 #!/bin/sh，设了 MSYS_NO_PATHCONV=1", async () => {
    const { readFileSync } = await import("node:fs");
    const s = readFileSync(join(REPO, "tx"), "utf8");
    assert.ok(s.startsWith("#!/bin/sh\n"));
    assert.match(s, /MSYS_NO_PATHCONV=1/);
    assert.match(s, /cygpath -w/);
    assert.ok(existsSync(join(REPO, "tx.cmd")));
    assert.match(readFileSync(join(REPO, "tx.cmd"), "utf8"), /extras\\tx\\main\.ts/);
  });
  test("Git Bash 真跑：presets、以 / 开头的正文原样到达、heredoc 加 -", { skip: bash === undefined }, async () => {
    const p = await sh(["presets"]);
    assert.equal(p.code, 0, p.err);
    assert.match(p.out, /你是测试助手/);
    const id = newId();
    const s = await sh(["start", "--id", id, "t", "/etc/hosts", "不被改写"]);
    assert.equal(s.code, 0, s.err);
    const rows = await ask({ op: "history", process: id });
    assert.ok(JSON.stringify(rows).includes("/etc/hosts 不被改写"), JSON.stringify(rows).slice(0, 400));
    const id2 = newId();
    const h = await sh(["start", "--id", id2, "t", "-"], "多行\n任务\n");
    assert.equal(h.code, 0, h.err);
    const w = await sh(["wait", id, id2]);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /任务/);
    const bad = await sh(["start", "--workdir", "/tmp", "t", "x"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /cygpath -w/);
  });
});
