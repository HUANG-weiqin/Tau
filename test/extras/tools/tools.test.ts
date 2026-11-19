// 工具库（extras/tools）：七个工具里 shell、bg_run、peek、wait 的脚本在真的服务、真的 Git Bash 里跑（history_search、history_read 见 history.test.ts，web_search 见 web_search.test.ts）；桥的工具定义路由。
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
import { KEEP_BYTES } from "../../../extras/tools/shell.ts";
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

describe("shell", () => {
  test("短输出原样回，加状态行；不留输出文件", async () => {
    const r = await tool("shell", { command: "echo 你好 'q' \"d\"; echo err >&2" }, "sh-a");
    assert.deepEqual(r, { text: "你好 q d\nerr\n[退出码 0]", isError: false });
    const files = existsSync(extras("shell", "sh-a")) ? readdirSync(extras("shell", "sh-a")) : [];
    assert.deepEqual(files, []);
  });

  test("退出码就是命令的退出码；命令里的 exit 也不丢它", async () => {
    assert.deepEqual(await tool("shell", { command: "echo a; exit 3" }, "sh-b"), { text: "a\n[退出码 3]", isError: true });
    assert.deepEqual(await tool("shell", { command: "false" }, "sh-b"), { text: "[退出码 1]", isError: true });
  });

  test("命令从空设备读标准输入，不读参数 JSON", async () => {
    assert.deepEqual(await tool("shell", { command: "cat; echo done" }, "sh-c"), { text: "done\n[退出码 0]", isError: false });
  });

  test("命令在工具定义自己的 bash 里跑：TAU_PROCESS 看得到", async () => {
    const r = await tool("shell", { command: "pwd; echo $TAU_PROCESS" }, "sh-d");
    assert.equal(r.isError, false);
    assert.match(r.text, /sh-d\n\[退出码 0\]$/);
  });

  test("输出太长：只回头尾，完整输出存文件，结果给出 Windows 路径；文件是完整的", async () => {
    const r = await tool("shell", { command: "seq 1 30000; exit 2" }, "sh-e");
    assert.equal(r.isError, true);
    assert.ok(r.text.length < 16 * 1024, `结果太长：${r.text.length}`);
    assert.match(r.text, /…（中间省略 \d+ 字节）…/);
    assert.match(r.text, /\n\[退出码 2\]$/);
    const file = /完整输出在 (.+?)，用 read 读/.exec(r.text)?.[1];
    assert.ok(file !== undefined, r.text);
    assert.match(file, /^[A-Za-z]:\\.*\\\.tau\\extras\\shell\\sh-e\\.+\.log$/);
    const want = `${Array.from({ length: 30000 }, (_, i) => i + 1).join("\n")}\n`;
    assert.equal(readFileSync(file, "utf8"), want);
    assert.ok(r.text.startsWith("1\n2\n3\n"));
    assert.ok(r.text.includes("\n30000\n"));
    assert.ok(statSync(file).size > KEEP_BYTES * 2);
  });

  test("顺手删掉 7 天前的文件和空了的目录，新的不动", async () => {
    mkdirSync(extras("shell", "old-proc"), { recursive: true });
    mkdirSync(extras("shell", "new-proc"), { recursive: true });
    const old = extras("shell", "old-proc", "a.log");
    const fresh = extras("shell", "new-proc", "b.log");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, t, t);
    await tool("shell", { command: "true" }, "sh-f");
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(extras("shell", "old-proc")), false);
    assert.equal(existsSync(fresh), true);
  });

  test("wait 用完还没跑完：命令留在后台继续跑，立刻返回输出文件；之后能读到新输出和退出码", async () => {
    const id = "sh-j";
    const go = join(dir, `go-sh-${id}`).replace(/\\/g, "/");
    const out = await tool("shell", { command: `echo 第一行; while [ ! -e "${go}" ]; do sleep 0.1; done; echo 后来; exit 5`, wait: 1 }, id);
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /等了 1 秒还没跑完：命令已经转到后台继续跑/);
    assert.match(out.text, /跑完会给你寄一封信/);
    const file = /输出写到 (.+?)（还在增长/.exec(out.text)?.[1];
    assert.ok(file !== undefined, out.text);
    assert.ok(readFileSync(file, "utf8").includes("第一行"), "已经写出来的输出在文件里");
    // 命令留在后台继续跑，没被结束：放它走，它能写完剩下的输出和退出码。
    writeFileSync(go, "");
    for (let i = 0; i < 300 && !existsSync(`${file}.exit`); i++) await sleep(100);
    assert.ok(readFileSync(file, "utf8").includes("后来"));
    assert.equal(readFileSync(`${file}.exit`, "utf8").trim(), "5");
  });

  test("转后台的命令跑完会寄信唤醒进程：信里有退出码和最后几行", async () => {
    const id = await start("你好");
    await untilIdle(id);
    // 命令等一个文件才结束：不靠时间判断，机器慢也稳。
    const go = join(dir, `go-wake-${id}`).replace(/\\/g, "/");
    const r = await tool("shell", { command: `echo 一; while [ ! -e "${go}" ]; do sleep 0.1; done; echo 二; exit 4`, wait: 1 }, id);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /转到后台继续跑/);
    assert.match(r.text, /可以接着做别的事，也可以直接结束这一轮等这封信/);
    writeFileSync(go, "");
    let letter: string | undefined;
    for (let i = 0; i < 300 && letter === undefined; i++) {
      await sleep(100);
      letter = (await messages(id)).find((m) => m.includes("[后台任务") && m.includes("退出码 4"));
    }
    assert.ok(letter !== undefined, "没有收到唤醒的信");
    assert.ok(letter.includes("二"), letter);
  });

  test("wait 里跑完：和以前一样返回输出和退出码，不留输出文件", async () => {
    const r = await tool("shell", { command: "echo 快; exit 7", wait: 20 }, "sh-k");
    assert.deepEqual(r, { text: "快\n[退出码 7]", isError: true });
    const files = existsSync(extras("shell", "sh-k")) ? readdirSync(extras("shell", "sh-k")) : [];
    assert.deepEqual(files, [], "输出文件、.exit、.wait 都清掉");
  });

  test("wait 的值不对：清楚的错误，不跑命令", async () => {
    for (const wait of [-1, 301, 1.5, "60"]) {
      const r = await tool("shell", { command: "echo x", wait }, "sh-l");
      assert.equal(r.isError, true, String(wait));
      assert.match(r.text, /wait 是 0 到 300 的整数/, String(wait));
    }
  });

  test("超时：内核按进程组结束命令，不挂着", async () => {
    const t = Date.now();
    const r = await tool("shell", { command: "sleep 60; echo late" }, "sh-g", { timeout: 2 });
    assert.equal(r.isError, true);
    assert.ok(Date.now() - t < 20_000, `用了 ${Date.now() - t} 毫秒`);
    assert.ok(!r.text.includes("late"));
    // 超时时结果里没有输出，描述必须告诉模型去哪个目录找。
    assert.ok(CATALOG[0]!.description.includes("~/.tau/extras/shell/<进程 ID>/"), CATALOG[0]!.description);
    // 超时留下的文件：输出文件加 <输出文件>.wait（模板读的秒数）。
    const files = readdirSync(extras("shell", "sh-g"));
    assert.deepEqual(files.filter((f) => !/\.(wait|sync|exit)$/.test(f)).length, 1, "超时留下的输出文件");
  });

  test("超时：命令里启动的后台进程也被结束，不会在超时以后继续写文件", async () => {
    const marker = join(dir, "marker.txt").replace(/\\/g, "/");
    const r = await tool("shell", { command: `(sleep 3; echo x > "${marker}") & sleep 3; echo y > "${marker}"` }, "sh-i", { timeout: 1 });
    assert.equal(r.isError, true);
    await sleep(4500);
    assert.equal(existsSync(marker), false);
  });

  test("参数不对：清楚的错误", async () => {
    const r = await tool("shell", { command: "  " }, "sh-h");
    assert.equal(r.isError, true);
    assert.match(r.text, /command 必须是非空字符串/);
  });
});

describe("bg_run", () => {
  test("立刻返回；跑完把退出码和 log 最后几行寄给自己；log 的命名和退出码行界面认得", async () => {
    const id = await start("你好");
    await untilIdle(id);
    // 命令等一个文件出现才结束：工具返回时它一定还在跑，不靠时间判断“立刻”。
    const go = join(dir, `go-${id}`).replace(/\\/g, "/");
    const r = await tool("bg_run", { name: "job1", command: `while [ ! -e "${go}" ]; do sleep 0.1; done; echo 第一行; echo second >&2; exit 4` }, id);
    assert.equal(r.isError, false, r.text);
    const log = extras("bg", `${id}-job1.log`);
    assert.ok(r.text.includes("已在后台运行：job1") && r.text.includes(log.replace(/\//g, "\\")), r.text);
    assert.match(r.text, /跑完会给你寄一封信/);
    assert.equal(parseExit(readFileSync(log, "utf8")), null, "跑完以前没有退出码行");

    // 同名任务还在跑：拒绝，也没有清掉它的 log。
    const again = await tool("bg_run", { name: "job1", command: "echo x" }, id);
    assert.equal(again.isError, true);
    assert.match(again.text, /还在运行/);
    writeFileSync(go, "");

    for (let i = 0; i < 300 && !(await messages(id)).some((m) => m.includes("[后台任务 job1] 完成")); i++) await sleep(100);
    const letter = (await messages(id)).find((m) => m.includes("[后台任务 job1] 完成"));
    assert.ok(letter !== undefined, "没有收到通知");
    assert.match(letter, /\[后台任务 job1\] 完成，退出码 4/);
    assert.ok(letter.includes("第一行") && letter.includes("second"));
    assert.equal(parseExit(readFileSync(log, "utf8")), 4);
    assert.ok(readFileSync(log, "utf8").includes("第一行"));
    await untilIdle(id);

    // 跑完以后同名可以再用：log 重新开始。输出不以换行结尾时，退出码行照样独占一行，认得出。
    const third = await tool("bg_run", { name: "job1", command: "printf again" }, id);
    assert.equal(third.isError, false, third.text);
    for (let i = 0; i < 100 && parseExit(readFileSync(log, "utf8")) !== 0; i++) await sleep(100);
    assert.equal(parseExit(readFileSync(log, "utf8")), 0);
    assert.ok(!readFileSync(log, "utf8").includes("第一行"));
    for (let i = 0; i < 100 && !(await messages(id)).some((m) => m.includes("完成，退出码 0")); i++) await sleep(100);
    const fourth = await tool("bg_run", { name: "job1", command: "true" }, id);
    assert.equal(fourth.isError, false, fourth.text);
  });

  test("名字不合规矩、命令为空：错误，不建 log", async () => {
    for (const name of ["", "a b", "../x", "x".repeat(41)]) {
      const r = await tool("bg_run", { name, command: "true" }, "bg-x");
      assert.equal(r.isError, true, name);
    }
    assert.equal((await tool("bg_run", { name: "ok", command: " " }, "bg-x")).isError, true);
    assert.equal(existsSync(extras("bg", "bg-x-ok.log")), false);
  });

  test("没有 TAU_PROCESS 或 TAU_PIPE：清楚的错误", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("TAU_")) delete env[k];
    for (const s of ["shell.ts start", "bg_run.ts start", "peek.ts", "wait.ts"]) {
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

  test("没有这个进程：错误里有服务的原因", async () => {
    const r = await tool("peek", { process: "nope-nope" }, "pk");
    assert.equal(r.isError, true);
    assert.match(r.text, /读不到进程 nope-nope/);
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
    const slow = await start("veryslow 一直想");
    const t = Date.now();
    const r = await tool("wait", { processes: [fast, slow], timeout: 1 }, "wt");
    assert.equal(r.isError, false, r.text);
    assert.ok(Date.now() - t < 10_000);
    assert.match(r.text, /^等了 1 秒，还没全部结束/);
    assert.ok(r.text.includes(`- ${slow}：运行中，在等模型`), r.text);
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

  test("没有这个进程：不再等它，写明读不到", async () => {
    const r = await tool("wait", { processes: ["nope-nope"], timeout: 5 }, "wt");
    assert.equal(r.isError, false);
    assert.match(r.text, /不用再等了/);
    assert.match(r.text, /- nope-nope：读不到/);
  });

  test("参数不对：1 到 8 个进程", async () => {
    for (const processes of [[], Array.from({ length: 9 }, (_, i) => `p${i}`), [""], "x"]) {
      const r = await tool("wait", { processes }, "wt");
      assert.equal(r.isError, true, JSON.stringify(processes));
    }
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
    assert.ok(r.text.includes(`- ${mine}：运行中，在等工具`) && r.text.includes(`- ${child}：运行中，在等工具`), r.text);
  });

  test("阶段的判断：刚建、还没处理第一封信的 idle 不算结束", () => {
    assert.deepEqual(phaseText({ tag: "idle" }), { text: "刚建好，还没处理第一封信", ended: false });
    assert.equal(phaseText({ tag: "idle", ended: "done" }).ended, true);
    assert.equal(phaseText({ tag: "idle", ended: { error: "炸了" } }).text, "已结束，出错：炸了");
    assert.equal(phaseText({ tag: "awaitingTool" }).ended, false);
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
    const file = join(bhome, "tools", "shell.json");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["command", "description", "output", "parameters", "timeout"]);
    assert.ok(written.command.includes(`${LIB}/shell.ts`), written.command);
    assert.equal(written.timeout, 360, "shell 先等 60 秒、wait 最多 300 秒：工具自己的超时要更大，留出余量");
    assert.deepEqual(Object.keys(written.parameters.properties).sort(), ["command", "wait"]);
    assert.deepEqual(readdirSync(join(bhome, "tools")).sort(), ["bg_run.json", "history_read.json", "history_search.json", "peek.json", "shell.json", "wait.json", "web_search.json"]);

    l = await list();
    assert.deepEqual(l.library.map((x: any) => x.status), ["installed", "installed", "installed", "installed", "installed", "installed", "installed"]);
    const shell = l.installed.find((x: any) => x.name === "shell");
    assert.deepEqual([shell.params, shell.timeout, shell.output, shell.usedBy], [["command", "wait"], 360, "text", []]);
    assert.equal((await post(port, "/api/tools/install", { name: "shell" })).status, 200, "内容一样：再装不报错");

    // 用户改过：状态变成“不同”，不带 replace 就拒绝，文件不动。
    const mine = { ...written, timeout: 5 };
    writeFileSync(file, JSON.stringify(mine));
    assert.equal((await list()).library.find((x: any) => x.name === "shell").status, "differs");
    const refused = await post(port, "/api/tools/install", { name: "shell" });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /内容和工具库里的不同/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).timeout, 5);
    assert.equal((await post(port, "/api/tools/install", { name: "shell", replace: true })).status, 200);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).timeout, 360);
    assert.ok(!existsSync(`${file}.tmp`));

    // 读不出的定义列出来，带原因。
    writeFileSync(join(bhome, "tools", "broken.json"), "{ 不是 json");
    assert.equal((await list()).installed.find((x: any) => x.name === "broken").error, "不是合法的 JSON");

    // 预设用到它：拒删，说是哪些；去掉以后能删。
    writeFileSync(join(bhome, "presets", "p1.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: read, shell\n---\nx\n");
    writeFileSync(join(bhome, "presets", "p2.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: peek\n---\nx\n");
    assert.deepEqual((await list()).installed.find((x: any) => x.name === "shell").usedBy, ["p1"]);
    const busy = await post(port, "/api/tools/remove", { name: "shell" });
    assert.equal(busy.status, 409);
    assert.match(busy.json.error, /p1/);
    assert.ok(existsSync(file));
    writeFileSync(join(bhome, "presets", "p1.md"), "---\nworkdir: C:/x\nmodel: a/b\ntools: read\n---\nx\n");
    assert.equal((await post(port, "/api/tools/remove", { name: "shell" })).status, 200);
    assert.ok(!existsSync(file));
    assert.equal((await post(port, "/api/tools/remove", { name: "shell" })).status, 404);
    assert.equal((await post(port, "/api/tools/remove", { name: "../x" })).status, 400);
    assert.equal((await post(port, "/api/tools/remove", { name: "peek" })).status, 409);
    assert.equal((await list()).library.find((x: any) => x.name === "shell").status, "none");
  });

  test("装进去的定义内核认：check 读得出，七个工具都在快照里", async () => {
    const bhome = join(dir, "kernel-home");
    mkdirSync(join(bhome, "presets"), { recursive: true });
    const bridge = await createBridge({ port: 0, home: bhome, pipe: `\\\\.\\pipe\\tau-test-none-${process.pid}` });
    try {
      for (const e of CATALOG) await post(bridge.port, "/api/tools/install", { name: e.name });
    } finally {
      await bridge.close();
    }
    // 服务的工具目录是 home/.tau/tools：把装好的七个拷过去，让真的服务读。
    for (const e of CATALOG) writeFileSync(join(home, ".tau", "tools", `${e.name}.json`), readFileSync(join(bhome, "tools", `${e.name}.json`)));
    writeFileSync(join(home, ".tau", "presets", "all.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: read, shell, bg_run, peek, wait, history_search, history_read, web_search\n---\nx\n`);
    const [r] = await request({ op: "check", preset: "all" });
    assert.equal(r.type, "check", JSON.stringify(r));
    assert.equal(r.error, null);
    assert.deepEqual(r.snapshot.toolDefs.map((d: ToolDef) => d.name).sort(), ["bg_run", "history_read", "history_search", "peek", "shell", "wait", "web_search"]);
  });
});

test("catalog：每个工具的名字合规，脚本存在，定义没有多余字段", () => {
  assert.deepEqual(CATALOG.map((c) => c.name), ["shell", "bg_run", "peek", "wait", "history_search", "history_read", "web_search"]);
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
