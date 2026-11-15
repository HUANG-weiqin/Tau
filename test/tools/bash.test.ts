import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MESSAGE_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { bash } from "../../src/tools/bash.ts";

let dir = "";
let tmp = "";

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tau-bash-"));
  // 别的测试文件在别的进程里同时运行 bash，也在系统临时目录里建删 pgid 文件。这个文件的 bash 用自己的临时目录。
  tmp = await mkdtemp(path.join(os.tmpdir(), "tau-bash-tmp-"));
  process.env.TEMP = process.env.TMP = tmp;
});

after(async () => {
  // exec 到一半被结束的 msys 进程可能还占着工作目录一两秒。
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function run(command: string, timeout?: number, signal: AbortSignal = new AbortController().signal) {
  return bash({ command, timeout }, dir, signal);
}

const exists = (name: string): boolean => existsSync(path.join(dir, name));
const pgidFiles = (): string[] => readdirSync(os.tmpdir()).filter((f) => /^tau-bash-.*\.pgid$/.test(f));

// 孙进程先写 <name>-started，3 秒后写 <name>-done。bash 自己在等，所以超时或中止一定先到。
// 原生版：node 在 Windows 父进程链上。msys 版：sh 是 fork 后 exec 的 msys 程序，不在链上。
function nativeGrandchild(name: string): string {
  const js = `const fs=require('fs');fs.writeFileSync('${name}-started','');setTimeout(()=>fs.writeFileSync('${name}-done',''),3000)`;
  return `node -e "${js}" & sleep 8`;
}

function msysGrandchild(name: string): string {
  return `sh -c 'touch ${name}-started; sleep 3; touch ${name}-done'; true`;
}

// 调用返回后再等过孙进程的 3 秒。它启动过、却没写出 done，才说明它被结束了。
async function assertKilled(name: string): Promise<void> {
  await sleep(3500);
  assert.ok(exists(`${name}-started`), "孙进程应该已经启动过");
  assert.equal(exists(`${name}-done`), false);
}

// 孙进程启动后再中止（最多等 5 秒），机器忙时也不会中止得太早。
function abortOnStart(name: string): AbortSignal {
  const ac = new AbortController();
  const start = Date.now();
  const timer = setInterval(() => {
    if (!exists(`${name}-started`) && Date.now() - start < 5000) return;
    clearInterval(timer);
    ac.abort();
  }, 50);
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

test("超时及时返回，是错误，临时文件已删", async () => {
  const files = pgidFiles();
  const start = Date.now();
  const r = await run("echo before; sleep 8", 1);
  assert.ok(Date.now() - start < 5000, `用了 ${Date.now() - start} 毫秒`);
  assert.equal(r.isError, true);
  assert.equal(r.text, "before\n[超时：1 秒后结束了整棵进程树]");
  assert.deepEqual(pgidFiles(), files);
});

// 超时给孙进程留 2 秒启动。两个一组并发跑省时间；同时结束更多调用时 msys 的 ps 偶尔会卡 5 秒。
describe("超时和中止结束孙进程", { concurrency: 2 }, () => {
  test("超时：原生孙进程", async () => {
    assert.match((await run(nativeGrandchild("tn"), 2)).text, /超时/);
    await assertKilled("tn");
  });

  test("中止：原生孙进程", async () => {
    const r = await run(nativeGrandchild("an"), 60, abortOnStart("an"));
    assert.deepEqual(r, { text: "[已中止，已结束整棵进程树]", isError: true });
    await assertKilled("an");
  });

  test("超时：msys 程序启动的孙进程", async () => {
    assert.match((await run(msysGrandchild("tm"), 2)).text, /超时/);
    await assertKilled("tm");
  });

  test("中止：msys 程序启动的孙进程", async () => {
    assert.match((await run(msysGrandchild("am"), 60, abortOnStart("am"))).text, /已中止/);
    await assertKilled("am");
  });
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

// 正常退出时不结束后台进程：它继续运行，只是不再拖住调用。
test("后台进程占着管道也不会让调用挂住，临时文件已删", async () => {
  const files = pgidFiles();
  const start = Date.now();
  const r = await run("sleep 8 & echo started");
  assert.ok(Date.now() - start < 3000, `用了 ${Date.now() - start} 毫秒`);
  assert.deepEqual(r, { text: "started\n[退出码 0]", isError: false });
  assert.deepEqual(pgidFiles(), files);
});
