// 单实例（设计稿第 11 节）：同一个命名管道不能被监听两次，跨进程也一样。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listen } from "../../src/server/listen.ts";

const pipe = () => String.raw`\\.\pipe\tau-test-` + `${process.pid}-${Math.random().toString(36).slice(2)}`;

test("第二个进程在同一个命名管道上监听会失败；第一个关掉之后可以再监听", async () => {
  const path = pipe();
  const server = await listen(path, (socket) => socket.end());
  try {
    const helper = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "server", "listen.ts")).href;
    const script = `import { listen } from ${JSON.stringify(helper)};
listen(${JSON.stringify(path)}, () => {}).then(
  () => { console.log("listening"); process.exit(0); },
  (e) => { console.log(e.message); process.exit(3); },
);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 3, child.stdout + child.stderr);
    assert.match(child.stdout, /已经有一个 tau 服务/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const again = await listen(path, () => {});
  await new Promise((resolve) => again.close(resolve));
});

test("同一个进程里第二次监听也会失败", async () => {
  const path = pipe();
  const server = await listen(path, () => {});
  try {
    await assert.rejects(listen(path, () => {}), /已经有一个 tau 服务/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
