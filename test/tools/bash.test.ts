import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MESSAGE_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { bash } from "../../src/tools/bash.ts";

let dir = "";
let tmp = "";

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

before(async () => {
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
  // exec 到一半被结束的 msys 进程可能还占着工作目录一两秒。
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function run(command: string, timeout?: number, signal: AbortSignal = new AbortController().signal) {
  return bash({ command, timeout }, dir, signal);
}

const exists = (name: string): boolean => existsSync(path.join(dir, name));
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
// 中止会正好落在它创建进程的时候，那一刻创建的原生进程结束不了（kb-tools 的“结束进程”）。
function abortOnStart(name: string): AbortSignal {
  const ac = new AbortController();
  void probe(name).start.promise.then(() => ac.abort());
  return ac.signal;
}

test("echo 成功，退出码 0", async () => {
  assert.deepEqual(await run("echo hello"), { text: "hello\n[退出码 0]", isError: false });
});

test("超过 600 的 timeout 被压到上限，照常运行", async () => {
  assert.deepEqual(await run("echo hi", 100000), { text: "hi\n[退出码 0]", isError: false });
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

test("命令的子进程看不到传命令用的环境变量", async () => {
  assert.equal((await run("env | grep '^TAU_' || echo none")).text, "none\n[退出码 0]");
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

test("timeout 不是正数时报错，不运行", async () => {
  const r = await run("echo x > zero.txt", 0);
  assert.equal(r.isError, true);
  assert.equal(exists("zero.txt"), false);
});

// 命令要跑 60 秒，调用远早于此返回，就说明没等命令。不卡紧时间：bash 启动和 ps 都偶尔卡约 5 秒（kb-tools 坑点）。
// bash 启动卡住时，1 秒的超时会落在命令运行之前，没有 before。超时前的输出保留，由“超时：原生孙进程”检查。
test("超时及时返回，是错误，临时文件已删", async () => {
  const files = pgidFiles();
  const start = Date.now();
  const r = await run("echo before; sleep 60", 1);
  assert.ok(Date.now() - start < 30_000, `用了 ${Date.now() - start} 毫秒`);
  assert.equal(r.isError, true);
  assert.match(r.text, /^(before\n)?\[超时：1 秒后结束了命令启动的进程\]$/);
  assert.deepEqual(pgidFiles(), files);
});

// 超时设 8 秒：bash 偶尔要卡约 5 秒才启动（kb-tools 坑点），探针得在超时前连上。两个一组并发跑省时间。
// 没被结束的探针一直连着，测试到 30 秒失败。
describe("超时和中止结束孙进程", { concurrency: 2, timeout: 30_000 }, () => {
  // 探针连上过，说明命令在超时前就在运行，所以 before 一定在输出里。
  test("超时：原生孙进程", async () => {
    const r = await run(`echo before; ${nativeGrandchild("tn")}`, 8);
    await assertKilled("tn");
    assert.deepEqual(r, { text: "before\n[超时：8 秒后结束了命令启动的进程]", isError: true });
  });

  test("中止：原生孙进程", async () => {
    const r = await run(nativeGrandchild("an"), 60, abortOnStart("an"));
    assert.deepEqual(r, { text: "[已中止，结束了命令启动的进程]", isError: true });
    await assertKilled("an");
  });

  test("超时：msys 程序启动的孙进程", async () => {
    assert.match((await run(msysGrandchild("tm"), 8)).text, /超时/);
    await assertKilled("tm");
  });

  test("中止：msys 程序启动的孙进程", async () => {
    assert.match((await run(msysGrandchild("am"), 60, abortOnStart("am"))).text, /已中止/);
    await assertKilled("am");
  });
});

// bash 刚启动、还没写 pgid 时就中止，它可能在结束进程的途中写下 pgid、启动 sh。先读 pgid 再结束 bash 的话，
// 读到的是空，不按进程组找，这样的 sh 就漏掉了。中止时刻铺满启动期（约 0.1 秒）。
// 只测 msys 版：这时创建的原生进程本来就可能漏掉（kb-tools 的“结束进程”）。
// 没漏掉的探针要么没启动，要么已断开。漏掉的 sh 在之后一两百毫秒内启动探针，探针一直连着。
test("启动途中中止：msys 程序启动的孙进程也被结束", async () => {
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

test("巨量输出只留头尾，字节不超上限，省略数准确", async () => {
  const r = await run("echo HEAD-MARK; yes line | head -n 1000000; echo TAIL-MARK");
  const total = 10 + 5 * 1000000 + 10; // 实际输出的字节数
  assert.equal(r.isError, false);
  assert.ok(utf8Bytes(r.text) <= MESSAGE_MAX_BYTES, `${utf8Bytes(r.text)} 字节`);
  assert.ok(r.text.startsWith("HEAD-MARK\nline\n"));
  assert.ok(r.text.endsWith("line\nTAIL-MARK\n[退出码 0]"));
  const marker = /\n…（中间省略 (\d+) 字节）…\n/.exec(r.text);
  assert.ok(marker);
  const kept = utf8Bytes(r.text) - utf8Bytes(marker[0]) - utf8Bytes("[退出码 0]");
  assert.equal(Number(marker[1]) + kept, total);
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
