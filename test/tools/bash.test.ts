import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TOOL_RESULT_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { bash } from "../../src/tools/bash.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tau-bash-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(command: string, timeout?: number, signal: AbortSignal = new AbortController().signal) {
  return bash({ command, timeout }, dir, signal);
}

const exists = (name: string): boolean => existsSync(path.join(dir, name));

// bash 后台启动一个 node 孙进程：它先写 <name>-started，2 秒后写 <name>-done。bash 自己在 sleep。
// 用例里的 sleep 都很短：它们是 fork 后 exec 的 msys 程序，超时后会残留（见最后一个用例）。
function grandchild(name: string): string {
  const js = `const fs=require('fs');fs.writeFileSync('${name}-started','');setTimeout(()=>fs.writeFileSync('${name}-done',''),2000)`;
  return `node -e "${js}" & sleep 8`;
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

test("超时及时返回，是错误", async () => {
  const start = Date.now();
  const r = await run("echo before; sleep 8", 1);
  assert.ok(Date.now() - start < 5000, `用了 ${Date.now() - start} 毫秒`);
  assert.equal(r.isError, true);
  assert.equal(r.text, "before\n[超时：1 秒后结束了整棵进程树]");
});

test("超时结束 bash 启动的孙进程", async () => {
  const r = await run(grandchild("t"), 1);
  assert.match(r.text, /超时/);
  await sleep(2500);
  assert.ok(exists("t-started"), "孙进程应该已经启动过");
  assert.equal(exists("t-done"), false);
});

test("中止结束 bash 启动的孙进程", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1000);
  const r = await run(grandchild("a"), 60, ac.signal);
  assert.deepEqual(r, { text: "[已中止，已结束整棵进程树]", isError: true });
  await sleep(2500);
  assert.ok(exists("a-started"), "孙进程应该已经启动过");
  assert.equal(exists("a-done"), false);
});

test("调用前已中止时不运行", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await run("echo x > aborted.txt", undefined, ac.signal);
  assert.equal(r.isError, true);
  assert.equal(exists("aborted.txt"), false);
});

test("巨量输出只留头尾，字节不超上限，省略数准确", async () => {
  const r = await run("echo HEAD-MARK; yes line | head -n 1000000; echo TAIL-MARK");
  const total = 10 + 5 * 1000000 + 10; // 实际输出的字节数
  assert.equal(r.isError, false);
  assert.ok(utf8Bytes(r.text) <= TOOL_RESULT_MAX_BYTES, `${utf8Bytes(r.text)} 字节`);
  assert.ok(r.text.startsWith("HEAD-MARK\nline\n"));
  assert.ok(r.text.endsWith("line\nTAIL-MARK\n[退出码 0]"));
  const marker = /\n…（中间省略 (\d+) 字节）…\n/.exec(r.text);
  assert.ok(marker);
  const kept = utf8Bytes(r.text) - utf8Bytes(marker[0]) - utf8Bytes("[退出码 0]");
  assert.equal(Number(marker[1]) + kept, total);
});

test("后台进程占着管道也不会让调用挂住", async () => {
  const start = Date.now();
  const r = await run("sleep 8 & echo started");
  assert.ok(Date.now() - start < 3000, `用了 ${Date.now() - start} 毫秒`);
  assert.deepEqual(r, { text: "started\n[退出码 0]", isError: false });
});

// 最小反例：msys 程序 fork 后再 exec 的孙进程不在 Windows 父进程链上，taskkill /T 结束不了它。
test("超时结束 msys 程序启动的孙进程", { todo: "taskkill /T 的已知漏洞，见 src/tools/bash.ts" }, async () => {
  await run("sh -c 'sleep 2; echo x > msys-done'; true", 1);
  await sleep(2500);
  assert.equal(exists("msys-done"), false);
});
