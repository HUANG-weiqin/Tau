import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MESSAGE_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { bash } from "../../src/tools/bash.ts";
import { plain } from "../plain.ts";

// 转后台的命令跑完后，包装脚本运行 notify.ts，经 TAU_PIPE 寄信。这里的假服务收 send、回回执。
const MAIL_PIPE = String.raw`\\.\pipe\tau-bash-mail-` + process.pid;
const CTX = { process: "p-test", pipe: MAIL_PIPE };
const KEEP = MESSAGE_MAX_BYTES / 2 - 256; // bash.ts 的 KEEP_BYTES
const STARTED = Date.now();
let dir = "";
let tmp = "";
let home = "";
let shellRoot = "";
let shellDir = "";

// 结束孙进程的测试用的孙进程是 node 探针：连上这个命名管道，报上名字，然后一直运行，直到被结束或连接被关掉。
// 连上就是启动了；连接断开就是探针进程没了。两件事都是操作系统给的事件，不靠等几秒再看文件。
const PIPE = String.raw`\\.\pipe\tau-bash-test-` + process.pid;
const PROBE = `const s = require("net").connect(${JSON.stringify(PIPE)}, () => s.write(process.argv[2]));
s.on("close", () => process.exit());
s.on("error", () => {});
`;
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.once("data", (name) => {
    const p = probe(String(name));
    p.socket = socket;
    p.start.resolve();
    socket.on("close", () => p.gone.resolve());
  });
});
type Probe = { socket?: net.Socket; start: PromiseWithResolvers<void>; gone: PromiseWithResolvers<void> };
const probes = new Map<string, Probe>();
function probe(name: string): Probe {
  let p = probes.get(name);
  if (p === undefined) probes.set(name, (p = { start: Promise.withResolvers(), gone: Promise.withResolvers() }));
  return p;
}

/** 假的 tau 服务：一行 JSON 一个连接。`answer` 决定怎么回：回执、错误，或什么都不回就断开。 */
function mailServer(pipe: string, answer: (req: any, socket: net.Socket) => void) {
  const requests: any[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\n")));
      requests.push(req);
      answer(req, socket);
    });
  });
  return { requests, server, listen: () => new Promise<void>((ok) => server.listen(pipe, ok)) };
}
const receipt = (req: any, socket: net.Socket): void => void socket.write(`${JSON.stringify({ type: "receipt", process: req.process })}\n`);
const mail = mailServer(MAIL_PIPE, receipt);
const letters = mail.requests as { op: string; process: string; text: string }[];
const lettersOf = (job: string) => letters.filter((l) => l.text.startsWith(`[后台任务 ${job}]`));
/** 等转后台的命令寄来信：按任务号找。 */
async function letterOf(job: string): Promise<{ process: string; text: string }> {
  for (let i = 0; i < 300 && lettersOf(job).length === 0; i++) await sleep(100);
  assert.equal(lettersOf(job).length, 1, `任务 ${job} 的信`);
  return lettersOf(job)[0]!;
}
const jobOf = (text: string): string | undefined => /^\[转入后台 ([0-9a-f]{6})\] 命令还在运行，没有被结束。$/m.exec(text)?.[1];
const logOf = (text: string): string => /^输出文件：(.+?)（还在增长/m.exec(text)?.[1] ?? "";

before(async () => {
  // 从外面继承来的 TAU_ 变量会让环境断言不确定。
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  // 输出文件写在 ~/.tau/extras/shell：home 指到临时目录，不碰真的。
  home = await mkdtemp(path.join(os.tmpdir(), "tau-bash-home-"));
  process.env.USERPROFILE = process.env.HOME = home;
  shellRoot = path.join(home, ".tau", "extras", "shell");
  shellDir = path.join(shellRoot, CTX.process);
  await mail.listen();
  dir = await mkdtemp(path.join(os.tmpdir(), "tau-bash-"));
  // 别的测试文件在别的进程里同时运行 bash，也在系统临时目录里建删 pgid 文件。这个文件的 bash 用自己的临时目录。
  tmp = await mkdtemp(path.join(os.tmpdir(), "tau-bash-tmp-"));
  process.env.TEMP = process.env.TMP = tmp;
  await writeFile(path.join(dir, "probe.cjs"), PROBE);
  await new Promise<void>((listening) => server.listen(PIPE, listening));
});

after(async () => {
  // 测试失败时可能留下没被结束的探针。关掉连接，它们自己退出。
  for (const p of probes.values()) p.socket?.destroy();
  server.close();
  mail.server.close();
  // fork 或 exec 到一半被结束的 msys 进程可能还占着工作目录约 5 秒（kb-tools 坑点）。重试共等约 12 秒。
  await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  await rm(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
});

async function run(command: string, timeout?: number, signal: AbortSignal = new AbortController().signal) {
  return plain(await bash({ command, timeout }, dir, signal, CTX));
}

const exists = (name: string): boolean => existsSync(path.join(dir, name));
const filesLeft = (): string[] => (existsSync(shellDir) ? readdirSync(shellDir) : []);
// 转后台的命令按设计留下 log（7 天后清；claim 在汇报完就删）。要查“没留下东西”的测试先清空。
const clearShell = (): void => rmSync(shellDir, { recursive: true, force: true });
const pgidFiles = (): string[] => readdirSync(os.tmpdir()).filter((f) => /^tau-bash-.*\.pgid$/.test(f));

// bash 自己在等，探针又从不自己退出，所以超时或中止一定先到。
// 原生版：探针在 Windows 父进程链上。msys 版：sh 是 fork 后 exec 的 msys 程序，不在链上，探针是 sh 的子进程，
// 只有按进程组才找得到。
const nativeGrandchild = (name: string): string => `node probe.cjs ${name} & sleep 30`;
const msysGrandchild = (name: string): string => `sh -c 'node probe.cjs ${name}; true'; true`;

// 被结束的探针几毫秒内断开。没被结束的一直连着，这里等不到，测试按 describe 的 timeout 失败。
// 结束得慢（msys 的 ps 偶尔卡约 5 秒）不算错。只有 killAll 会结束探针，所以断开就说明它结束了探针。
async function assertKilled(name: string): Promise<void> {
  assert.ok(probe(name).socket, "孙进程应该已经启动过");
  await probe(name).gone.promise;
}

// 探针连上才中止。这时 bash 已经启动完，在等它。不能按时间中止：bash 偶尔要卡约 5 秒才启动，
// 中止会正好落在它创建进程的时候，那一刻创建的进程可能结束不了（kb-tools 的“结束进程”）。
function abortOnStart(name: string): AbortSignal {
  const ac = new AbortController();
  void probe(name).start.promise.then(() => ac.abort());
  return ac.signal;
}

test("echo 成功，退出码 0；输出文件和 claim 都没留下", async () => {
  assert.deepEqual(await run("echo hello"), { text: "hello\n[退出码 0]", isError: false });
  assert.deepEqual(filesLeft(), []);
  assert.equal(letters.length, 0, "跑完就返回的命令不寄信");
});

test("命令里的 exit N 也走完收尾：退出码照旧，不留文件", async () => {
  assert.deepEqual(await run("echo bye; exit 7"), { text: "bye\n[退出码 7]", isError: true });
  assert.deepEqual(filesLeft(), []);
});

// 超过 2^31 毫秒的定时器，Node 会改成 1 毫秒：不封顶的话，命令 sleep 3 一毫秒就转后台了。
test("超过 600 的 timeout 被压到上限：等到命令跑完，不会立刻转后台", async () => {
  assert.deepEqual(await run("sleep 3; echo ok", 3_000_000), { text: "ok\n[退出码 0]", isError: false });
});

// spawn 对含 NUL 的命令同步抛错。bash 工具不抛，写成错误结果。
test("命令含 NUL 字符：结果是错误，不抛出，不留文件", async () => {
  const r = await run("echo a\u0000b");
  assert.equal(r.isError, true);
  assert.match(r.text, /^无法启动 bash（工作目录 .+）：/);
  assert.deepEqual(filesLeft(), []);
});

test("非零退出码是错误，并写出退出码", async () => {
  assert.deepEqual(await run("echo out; exit 3"), { text: "out\n[退出码 3]", isError: true });
});

test("多行命令和 set -e 照常工作", async () => {
  assert.deepEqual(await run("set -e\necho one\nfalse\necho two"), { text: "one\n[退出码 1]", isError: true });
});

test("反斜杠和引号原样交给 bash", async () => {
  const r = await run(String.raw`printf '%s\n' '\\server\share' "a\"b"`);
  assert.equal(r.text, String.raw`\\server\share` + '\na"b\n[退出码 0]');
});

test("命令的子进程看不到传命令用的环境变量，只看得到 TAU_PROCESS 和 TAU_PIPE", async () => {
  const r = await run("env | grep '^TAU_' | sort");
  assert.equal(r.text, `TAU_PIPE=${CTX.pipe}\nTAU_PROCESS=${CTX.process}\n[退出码 0]`);
});

test("服务从外面继承来的 TAU_PROCESS 和 TAU_PIPE 被换成这次的", async () => {
  process.env.TAU_PROCESS = "outer";
  process.env.TAU_PIPE = "outer-pipe";
  try {
    const r = await run('echo "$TAU_PROCESS $TAU_PIPE"');
    assert.equal(r.text, `${CTX.process} ${CTX.pipe}\n[退出码 0]`);
  } finally {
    delete process.env.TAU_PROCESS;
    delete process.env.TAU_PIPE;
  }
});

// node 是 Windows 程序：msys 默认把 /usr 这样的参数改成 Windows 路径；服务带着 MSYS_NO_PATHCONV 时，命令也应照常转换。
test("服务的环境带 MSYS_NO_PATHCONV：命令看不到它，msys 路径照常转换", async () => {
  process.env.MSYS_NO_PATHCONV = "1";
  try {
    assert.equal((await run("env | grep '^MSYS_NO_PATHCONV' || echo none")).text, "none\n[退出码 0]");
    const r = await run(`node -p "process.argv[1]" /usr`);
    assert.match(r.text, /^[A-Za-z]:[\\/].*usr\n\[退出码 0\]$/);
  } finally {
    delete process.env.MSYS_NO_PATHCONV;
  }
});

test("stderr 也收进输出", async () => {
  const r = await run("echo oops >&2");
  assert.equal(r.text, "oops\n[退出码 0]");
});

test("没有换行结尾的输出补一个换行", async () => {
  assert.equal((await run("printf abc")).text, "abc\n[退出码 0]");
});

test("在 workdir 里运行", async () => {
  await run("echo x > here.txt");
  assert.ok(exists("here.txt"));
});

test("timeout 是负数、NaN、小数时报参数错误，不运行", async () => {
  for (const t of [-1, Number.NaN, 1.5]) {
    const r = await run("echo x > badtimeout.txt", t);
    assert.equal(r.isError, true, String(t));
    assert.match(r.text, /^timeout 必须是非负整数/);
  }
  assert.equal(exists("badtimeout.txt"), false);
  assert.deepEqual(filesLeft(), []);
});

// 超时不再结束命令：到时间就转后台，命令继续跑完，跑完寄信。调用远早于命令结束就返回，说明没等它。
// 不卡紧时间：bash 启动偶尔卡约 5 秒（kb-tools 坑点）。bash 启动卡住时，1 秒的超时会落在命令运行之前，没有 before。
test("超时转后台：及时返回，不是错误；命令跑完，log 有退出码行，信寄到了，临时文件已删", async () => {
  const files = pgidFiles();
  const start = Date.now();
  const r = await run("echo before; sleep 4; echo after", 1);
  assert.ok(Date.now() - start < 3500, `用了 ${Date.now() - start} 毫秒`);
  assert.equal(r.isError, false);
  const job = jobOf(r.text);
  assert.ok(job, r.text);
  const log = logOf(r.text);
  assert.match(r.text, /^(before\n)?\[转入后台 [0-9a-f]{6}\] 命令还在运行，没有被结束。\n输出文件：/);
  assert.match(r.text, /（还在增长，用 read 读，可带 offset 和 limit）\n(进程组号：\d+\n)?跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。$/);
  assert.equal(log, path.join(shellDir, path.basename(log)), "文件在 <home>\\.tau\\extras\\shell\\<进程 ID> 里，Windows 写法");
  assert.match(path.basename(log), new RegExp(`^\\d{13}-${job}\\.log$`));
  const letter = await letterOf(job);
  assert.equal(letter.process, CTX.process);
  assert.equal(letter.text.split("\n").slice(0, 2).join("\n"), `[后台任务 ${job}] 退出码 0\nlog：${log}`);
  assert.match(letter.text, /\n(before\n)?after$/, "尾部是命令的输出，脚本写的退出码行不再重复一遍");
  assert.equal(letter.text.match(/退出码/g)?.length, 1);
  assert.match(readFileSync(log, "utf8"), /^(before\n)?after\n\n\[后台任务 [0-9a-f]{6}\] 退出码 0\n$/);
  assert.deepEqual(pgidFiles(), files);
  for (let i = 0; i < 40 && existsSync(`${log}.claim`); i++) await sleep(50);
  assert.equal(existsSync(`${log}.claim`), false, "汇报完就删 claim，log 留到 7 天后清");
  assert.equal(existsSync(log), true);
});

test("退出码不是 0 的后台命令：信里写退出码，log 里有退出码行", async () => {
  const r = await run("echo bad; sleep 2; exit 5", 1);
  const job = jobOf(r.text)!;
  assert.ok(job, r.text);
  const letter = await letterOf(job);
  assert.match(letter.text, new RegExp(`^\\[后台任务 ${job}\\] 退出码 5\\n`));
  assert.match(readFileSync(logOf(r.text), "utf8"), /退出码 5\n$/);
});

test("timeout 0：不等，立刻转后台；命令照常跑完", async () => {
  const r = await run("echo zero > zero.txt; sleep 2", 0);
  assert.equal(r.isError, false);
  const job = jobOf(r.text);
  assert.ok(job, r.text);
  await letterOf(job);
  assert.equal(readFileSync(path.join(dir, "zero.txt"), "utf8"), "zero\n");
});

// 非 UTF-8 的 LANG 下，msys 把命令行参数里的非 ASCII 字符转走样：TAU_LOG 含中文路径，不能经参数交给 node。
test("LANG 是 zh_CN.GBK、home 含中文：信照样寄到，log 路径原样", async () => {
  const cjk = await mkdtemp(path.join(os.tmpdir(), "tau-家-"));
  const saved = process.env.USERPROFILE;
  process.env.USERPROFILE = process.env.HOME = cjk;
  process.env.LANG = "zh_CN.GBK";
  try {
    const r = await run("echo gbk; sleep 2", 0);
    const job = jobOf(r.text);
    assert.ok(job, r.text);
    const letter = await letterOf(job);
    assert.equal(letter.text.split("\n")[1], `log：${logOf(r.text)}`);
    assert.ok(logOf(r.text).startsWith(cjk));
    assert.match(readFileSync(logOf(r.text), "utf8"), /gbk\n\n\[后台任务 [0-9a-f]{6}\] 退出码 0\n$/);
  } finally {
    delete process.env.LANG;
    process.env.USERPROFILE = process.env.HOME = saved;
    await rm(cjk, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

// 转后台前最后再推一次：命令每 60 毫秒左右写一行，上一次轮询以后写的几行，要在转后台那刻补上。
test("转后台前最后推一次：预览收到的，和结果里已有的输出一字不差", { timeout: 60_000 }, async () => {
  const command = `i=0; while [ $i -lt 40 ]; do echo line$i-${"x".repeat(60)}; sleep 0.05; i=$((i+1)); done`;
  const one = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    const r = await bash({ command, timeout: 1 }, dir, new AbortController().signal, { ...CTX, onData: (c) => chunks.push(c) });
    const text = plain(r).text;
    const job = jobOf(text);
    assert.ok(job, text);
    const body = text.slice(0, text.indexOf("[转入后台"));
    assert.equal(Buffer.concat(chunks).toString(), body);
    await letterOf(job);
    return job;
  };
  await Promise.all([one(), one(), one(), one()]);
});

// 一次轮询最多读 1 MiB：写得快的命令不能让一次推送占住事件循环。轮询和命令退出的回调可能落在同一轮事件循环里
// （两次读，各不超过 1 MiB），所以在 setImmediate 之前交出去的字节数不超过 2 MiB。不限的话，最后那次会一口气推出剩下的十几 MiB。
test("预览每次读最多 1 MiB", async () => {
  let burst = 0;
  let maxBurst = 0;
  let total = 0;
  let pending = false;
  const onData = (c: Buffer): void => {
    burst += c.length;
    total += c.length;
    maxBurst = Math.max(maxBurst, burst);
    if (!pending) {
      pending = true;
      setImmediate(() => {
        burst = 0;
        pending = false;
      });
    }
  };
  const r = await bash({ command: `head -c 20971520 /dev/zero | tr '\\0' a`, timeout: 60 }, dir, new AbortController().signal, { ...CTX, onData });
  assert.equal(r.isError, false);
  assert.ok(total > 0);
  assert.ok(maxBurst <= 2 * 1024 * 1024, `一口气推了 ${maxBurst} 字节`);
  clearShell();
});

// 汇报只能有一个赢家：抢到 claim 的内核转后台、脚本寄信；脚本先抢到，就正常返回、不寄信。
// 命令的 sleep 取 0.40 到 0.97 秒，加上 bash 的启动和收尾（0.2 到 0.4 秒，随机器忙闲），结束时刻跨过 1 秒的 timeout，两种结果都会出现。
// 每次必居其一：转后台就恰好一封信，正常返回就一封也没有。
test("claim 竞态：20 次命令在 timeout 前后结束，每次要么正常返回没有信，要么转后台恰好一封信", { timeout: 180_000 }, async (t) => {
  letters.length = 0;
  clearShell();
  const jobs: string[] = [];
  let normal = 0;
  for (let i = 0; i < 20; i++) {
    const r = await run(`sleep 0.${40 + i * 3}; echo done${i}`, 1);
    const job = jobOf(r.text);
    if (job === undefined) {
      assert.deepEqual(r, { text: `done${i}\n[退出码 0]`, isError: false });
      normal++;
    } else jobs.push(job);
  }
  for (const job of jobs) await letterOf(job);
  await sleep(2000); // 正常返回的那几次若还寄了信，早该到了
  assert.equal(letters.length, jobs.length, `转后台 ${jobs.length} 次、正常返回 ${normal} 次，信 ${letters.length} 封`);
  assert.deepEqual(new Set(letters.map((l) => /^\[后台任务 ([0-9a-f]{6})\]/.exec(l.text)?.[1])), new Set(jobs));
  assert.deepEqual(filesLeft().filter((n) => !jobs.some((j) => n.includes(j))), [], "正常返回的没留文件");
  assert.equal(filesLeft().length, jobs.length, "转后台的各留一个 log；claim 汇报完就删");
  t.diagnostic(`转后台 ${jobs.length} 次，正常返回 ${normal} 次`);
});

// 没被结束的探针一直连着，测试到 30 秒失败。
describe("中止结束孙进程", { concurrency: 2, timeout: 30_000 }, () => {
  test("中止：原生孙进程", async () => {
    const r = await run(nativeGrandchild("an"), 60, abortOnStart("an"));
    assert.deepEqual(r, { text: "[已中止，结束了命令启动的进程]", isError: true });
    await assertKilled("an");
  });

  test("中止：msys 程序启动的孙进程", async () => {
    assert.match((await run(msysGrandchild("am"), 60, abortOnStart("am"))).text, /已中止/);
    await assertKilled("am");
  });
});

// 转后台以后命令不归这次调用管了：中止信号不再结束它。探针一直连着，说明没被结束；之后关掉连接，探针自己退出。
test("转后台以后中止：不结束命令，监听已摘掉", async () => {
  const ac = new AbortController();
  const r = await run(`node probe.cjs bg & sleep 4`, 1, ac.signal);
  const job = jobOf(r.text);
  assert.ok(job, r.text);
  ac.abort();
  await probe("bg").start.promise;
  const state = await Promise.race([probe("bg").gone.promise.then(() => "killed"), sleep(1500).then(() => "alive")]);
  assert.equal(state, "alive");
  probe("bg").socket?.destroy();
  const letter = await letterOf(job);
  assert.match(letter.text, /^\[后台任务 [0-9a-f]{6}\] 退出码 0\n/, "sleep 跑完了，不是被杀");
});

// bash 刚启动、还没写 pgid 时就中止，它可能在结束进程的途中写下 pgid、启动 sh。先读 pgid 再结束 bash 的话，
// 读到的是空，不按进程组找，这样的 sh 就漏掉了。中止时刻从 0 到 240 毫秒，盖住 bash 的启动期（约 0.1 秒）。
// 漏掉的 sh 在之后一两百毫秒内启动探针，探针一直连着；没漏掉的探针要么没启动，要么已断开。
// 只测 msys 版：那一刻创建的原生进程本来就可能漏掉。那一刻 exec 到一半的 sh 可能卡在启动里，
// 不启动探针，这里看不见；它也不运行命令（kb-tools 的“结束进程”）。
// killAll 没结束启动器时 run 不返回，所以给个上限。
test("启动途中中止：msys 程序启动的孙进程也被结束", { timeout: 90_000 }, async () => {
  const names: string[] = [];
  for (let ms = 0; ms <= 240; ms += 20) {
    names.push(`s${ms}`);
    await run(msysGrandchild(`s${ms}`), 60, AbortSignal.timeout(ms));
  }
  await sleep(1000);
  assert.deepEqual(names.filter((n) => probe(n).socket?.destroyed === false), []);
});

test("调用前已中止时不运行", async () => {
  const r = await run("echo x > aborted.txt", undefined, AbortSignal.abort());
  assert.equal(r.isError, true);
  assert.equal(exists("aborted.txt"), false);
});

// 写不进 pgid 就运行的话，超时或中止时没人按进程组去找它启动的 msys 进程。
test("pgid 文件写不进时不运行命令", async () => {
  process.env.TEMP = process.env.TMP = path.join(tmp, "missing");
  try {
    const r = await run("echo x > nopgid.txt");
    assert.match(r.text, /No such file or directory\n\[退出码 1\]$/);
    assert.equal(r.isError, true);
    assert.equal(exists("nopgid.txt"), false);
  } finally {
    process.env.TEMP = process.env.TMP = tmp;
  }
});

test("巨量输出只留头尾，字节不超上限，省略数准确", async () => {
  const r = await run("echo HEAD-MARK; yes line | head -n 1000000; echo TAIL-MARK");
  const total = 10 + 5 * 1000000 + 10; // 实际输出的字节数
  assert.equal(r.isError, false);
  assert.ok(utf8Bytes(r.text) <= MESSAGE_MAX_BYTES, `${utf8Bytes(r.text)} 字节`);
  assert.ok(r.text.startsWith("HEAD-MARK\nline\n"));
  assert.ok(r.text.includes("line\nTAIL-MARK\n输出共 "));
  assert.ok(r.text.endsWith("\n[退出码 0]"));
  const marker = /\n…（中间省略 (\d+) 字节）…\n/.exec(r.text);
  assert.ok(marker);
  const note = /输出共 (\d+) 字节，只显示了头尾。完整输出在 (.+?)，用 read 读（可带 offset 和 limit）。\n/.exec(r.text);
  assert.ok(note, "说明里有总字节数和完整输出的路径");
  const kept = utf8Bytes(r.text) - utf8Bytes(marker[0]) - utf8Bytes(note[0]) - utf8Bytes("[退出码 0]");
  assert.equal(Number(marker[1]) + kept, total);
  assert.equal(Number(note[1]), total);
  assert.equal(statSync(note[2]!).size, total, "完整输出的文件留着，内容是全部");
  assert.ok(note[2]!.startsWith(shellDir));
});

// 头尾各 KEEP 字节放得下就整个回，文件删掉；多一个字节就只回头尾，文件留着。
test("输出刚好 2*KEEP_BYTES：整个回、删文件；多一个字节：头尾加路径、文件留着", async () => {
  clearShell();
  const exact = await run(`head -c ${2 * KEEP} /dev/zero | tr '\\0' a`);
  assert.deepEqual(exact, { text: `${"a".repeat(2 * KEEP)}\n[退出码 0]`, isError: false });
  assert.deepEqual(filesLeft(), []);
  const over = await run(`head -c ${2 * KEEP + 1} /dev/zero | tr '\\0' a`);
  const note = /完整输出在 (.+?)，用 read/.exec(over.text);
  assert.ok(note, over.text.slice(-300));
  assert.match(over.text, /\n…（中间省略 1 字节）…\n/);
  assert.equal(statSync(note[1]!).size, 2 * KEEP + 1);
  assert.equal(filesLeft().length, 1);
  await rm(note[1]!);
  assert.deepEqual(filesLeft().filter((n) => n.endsWith(".log")), []);
});

test("转后台时已有的输出也只回头尾，路径在固定那段话里", async () => {
  const r = await run(`head -c ${2 * KEEP + 100} /dev/zero | tr '\\0' b; sleep 3`, 2);
  const job = jobOf(r.text);
  assert.ok(job, r.text.slice(-300));
  assert.match(r.text, /\n…（中间省略 \d+ 字节）…\n/);
  assert.ok(utf8Bytes(r.text) <= MESSAGE_MAX_BYTES);
  await letterOf(job);
});

// 每次调用顺手清 shell/ 下 7 天前的东西：文件、claim 目录，空了的进程目录。当前进程的目录不删。
test("清理：8 天前的文件和 claim 被删，空目录被删；新文件、当前进程的目录不动", async () => {
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const fresh = path.join(shellRoot, "oldproc");
  const stale = path.join(shellRoot, "staleproc");
  const empty = path.join(shellRoot, "emptyproc");
  clearShell();
  mkdirSync(fresh, { recursive: true });
  mkdirSync(stale, { recursive: true });
  mkdirSync(empty, { recursive: true });
  mkdirSync(shellDir, { recursive: true });
  writeFileSync(path.join(fresh, "keep.log"), "k");
  writeFileSync(path.join(fresh, "old.log"), "o");
  // claim 只在同名 log 已经没了才清；反过来，有 claim 的 log 也不清。
  writeFileSync(path.join(fresh, "x.log.claim"), "");
  writeFileSync(path.join(fresh, "live.log"), "l");
  writeFileSync(path.join(fresh, "live.log.claim"), "");
  writeFileSync(path.join(fresh, "pair.log"), "p");
  writeFileSync(path.join(fresh, "pair.log.claim"), "");
  writeFileSync(path.join(stale, "old.log"), "o");
  writeFileSync(path.join(shellDir, "mine-old.log"), "m");
  for (const p of [path.join(fresh, "old.log"), path.join(fresh, "x.log.claim"), path.join(fresh, "live.log.claim"), path.join(fresh, "pair.log"), path.join(fresh, "pair.log.claim"), path.join(stale, "old.log"), path.join(shellDir, "mine-old.log")]) utimesSync(p, old, old);
  await run("echo hi");
  assert.deepEqual(readdirSync(fresh).sort(), ["keep.log", "live.log", "live.log.claim", "pair.log", "pair.log.claim"], "claim 和它的 log 都过期才一起删；有 claim 的 log 不清：转后台的命令可能只是安静，清掉它就寄不出信了");
  assert.equal(existsSync(stale), false, "文件删光，目录空了，也删");
  assert.equal(existsSync(empty), false);
  assert.equal(existsSync(shellDir), true, "当前进程的目录留着");
  assert.deepEqual(filesLeft(), [], "当前进程目录里 8 天前的文件同样删");
  await rm(fresh, { recursive: true });
});

// 正常退出时不结束后台进程：它继续运行，只是不再拖住调用。后台进程要跑 30 秒，调用远早于此返回，就说明没等它。
// 不卡紧时间：bash 启动偶尔卡约 5 秒（kb-tools 坑点）。
test("后台进程占着管道也不会让调用挂住，临时文件已删", async () => {
  const files = pgidFiles();
  const start = Date.now();
  const r = await run("sleep 30 & echo started");
  assert.ok(Date.now() - start < 15_000, `用了 ${Date.now() - start} 毫秒`);
  assert.deepEqual(r, { text: "started\n[退出码 0]", isError: false });
  assert.deepEqual(pgidFiles(), files);
});

// 通知脚本 notify.ts：包装脚本在后台命令跑完后运行它。参数：退出码、重试间隔（毫秒，省略是 5000）。
// 任务号和 log 路径经环境变量 TAU_JOB、TAU_LOG 传：非 UTF-8 的 LANG 下，命令行里的非 ASCII 会走样。
const NOTIFY = path.join(import.meta.dirname, "..", "..", "src", "tools", "notify.ts");
let pipeN = 0;
const mailPipe = (): string => String.raw`\\.\pipe\tau-notify-test-${process.pid}-${pipeN++}`;
function notify(pipe: string, log: string, code: number) {
  const child = spawn(process.execPath, [NOTIFY, String(code), "100"], { env: { ...process.env, TAU_PROCESS: "np", TAU_PIPE: pipe, TAU_JOB: "abc123", TAU_LOG: log }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
  return new Promise<{ code: number | null; err: string }>((done) => child.on("close", (c) => done({ code: c, err })));
}
const logFile = async (name: string, content: string): Promise<string> => {
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
};

test("notify：服务没起时每隔一会儿重试，起来后寄出；只取最后 20 行；信的头和路径格式", async () => {
  const log = await logFile("n1.log", Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const pipe = mailPipe();
  const m = mailServer(pipe, receipt);
  const done = notify(pipe, log, 3);
  await sleep(700);
  assert.equal(m.requests.length, 0);
  await m.listen();
  try {
    assert.deepEqual(await done, { code: 0, err: "" });
    assert.deepEqual(m.requests, [{ op: "send", process: "np", text: `[后台任务 abc123] 退出码 3\nlog：${log}\n${Array.from({ length: 20 }, (_, i) => `l${i + 11}`).join("\n")}` }]);
  } finally {
    m.server.close();
  }
});

test("notify：最后几行超过 3000 字时从中间截；log 尾部切开多字节字符时去掉开头的残字", async () => {
  const pipe = mailPipe();
  const m = mailServer(pipe, receipt);
  await m.listen();
  try {
    assert.equal((await notify(pipe, await logFile("n2.log", "x".repeat(5000)), 0)).code, 0);
    const body = m.requests[0].text.split("\n").slice(2).join("\n");
    assert.equal(body, `…${"x".repeat(3000)}`);
    assert.equal((await notify(pipe, await logFile("n3.log", "汉".repeat(30000)), 0)).code, 0);
    const han = m.requests[1].text.split("\n").slice(2).join("\n");
    assert.ok(!han.includes("\uFFFD"));
    assert.equal(han, `…${"汉".repeat(3000)}`);
  } finally {
    m.server.close();
  }
});

// 日志尾部按 UTF-16 切到 3000 个单位，边界可能落在 emoji（两个单位）中间：切开的半个不能留在信里。
test("notify：尾部边界落在 emoji 中间：信里没有孤立代理项", async () => {
  const pipe = mailPipe();
  const m = mailServer(pipe, receipt);
  await m.listen();
  try {
    for (const [i, body] of ["😀".repeat(2000), "x" + "😀".repeat(2000)].entries()) {
      assert.equal((await notify(pipe, await logFile(`n6-${i}.log`, body), 0)).code, 0);
      const text: string = m.requests[i].text;
      assert.ok(text.isWellFormed(), `第 ${i} 个：有孤立代理项`);
      const shown = text.split("\n").slice(2).join("\n");
      assert.ok(shown.startsWith("…😀") && shown.endsWith("😀"));
      assert.ok(shown.length >= 2999 && shown.length <= 3001, String(shown.length));
    }
  } finally {
    m.server.close();
  }
});

// 脚本在 log 末尾写了一行退出码行，信的第一行已经是它的内容：正文里不再重复。只去最后一行，且要完整匹配。
test("notify：去掉 log 里最后那行脚本写的退出码行；别处的和格式不对的留着；信的第一行格式不变", async () => {
  const pipe = mailPipe();
  const m = mailServer(pipe, receipt);
  await m.listen();
  try {
    const cases: [string, string][] = [
      ["a\nb\n\n[后台任务 0a1b2c] 退出码 3\n", "a\nb"],
      ["[后台任务 0a1b2c] 退出码 -1\n[后台任务 0a1b2c] 退出码 -1\n", "[后台任务 0a1b2c] 退出码 -1"],
      ["a\n[后台任务 0a1b2c] 退出码 3\nb\n", "a\n[后台任务 0a1b2c] 退出码 3\nb"],
      ["a\n[后台任务 0a1b2c] 退出码 abc\n", "a\n[后台任务 0a1b2c] 退出码 abc"],
      ["a\n[后台任务 0a1b2c] 退出码 3 多余\n", "a\n[后台任务 0a1b2c] 退出码 3 多余"],
    ];
    for (const [i, [content, shown]] of cases.entries()) {
      assert.equal((await notify(pipe, await logFile(`n7-${i}.log`, content), 3)).code, 0);
      const lines: string[] = m.requests[i].text.split("\n");
      assert.equal(lines[0], "[后台任务 abc123] 退出码 3");
      assert.equal(lines.slice(2).join("\n"), shown, `第 ${i} 个`);
    }
  } finally {
    m.server.close();
  }
});

test("notify：没收到回执就被断开：不重试，说明在标准错误里", async () => {
  const pipe = mailPipe();
  const m = mailServer(pipe, (_req, socket) => socket.destroy());
  await m.listen();
  try {
    const r = await notify(pipe, await logFile("n4.log", "a\n"), 0);
    assert.equal(r.code, 0);
    assert.match(r.err, /没有收到回执就断开了.*不重试/);
    await sleep(500);
    assert.equal(m.requests.length, 1);
  } finally {
    m.server.close();
  }
});

test("notify：被拒绝：不重试，原因在标准错误里", async () => {
  const pipe = mailPipe();
  const m = mailServer(pipe, (_req, socket) => void socket.write(`${JSON.stringify({ type: "error", message: "没有这个进程" })}\n`));
  await m.listen();
  try {
    const r = await notify(pipe, await logFile("n5.log", "a\n"), 0);
    assert.equal(r.code, 0);
    assert.match(r.err, /被拒绝，不重试：没有这个进程/);
    await sleep(500);
    assert.equal(m.requests.length, 1);
  } finally {
    m.server.close();
  }
});

// 转后台的命令都等到了信，通知脚本也就都退出了。服务不在时它按设计重试约 1 小时，不能留给测试之后。
// 按进程的创建时间找：本文件开始以后起的、命令行里有 notify.ts 的 node。
function notifyProcs(): number[] {
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*notify.ts*' } | ForEach-Object { "$($_.ProcessId) $(([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  return out
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter((p) => p.length === 2 && Number(p[1]) >= STARTED - 1000)
    .map((p) => Number(p[0]));
}

test("测试结束时没有留下 notify.ts 进程", { timeout: 60_000 }, async () => {
  let left = notifyProcs();
  for (let i = 0; i < 40 && left.length > 0; i++) {
    await sleep(500);
    left = notifyProcs();
  }
  assert.deepEqual(left, [], "还有通知脚本在重试");
});
