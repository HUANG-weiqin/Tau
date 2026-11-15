// 只读复用 pi 的凭据文件：只交出 api_key 条目，不写入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCredentials } from "../../src/server/credentials.ts";

function file(t: { after: (f: () => void) => void }, content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tau-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

test("只交出 api_key 条目；OAuth 条目当作不存在", async (t) => {
  const store = piCredentials(
    file(t, JSON.stringify({ deepseek: { type: "api_key", key: "k1" }, "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } })),
  );
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "k1" });
  assert.equal(await store.read("openai-codex"), undefined);
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.list(), [{ providerId: "deepseek", type: "api_key" }]);
});

test("不写入：modify 和 delete 都拒绝", async (t) => {
  const store = piCredentials(file(t, JSON.stringify({ deepseek: { type: "api_key", key: "k1" } })));
  await assert.rejects(store.modify("deepseek", async () => undefined), /只读/);
  await assert.rejects(store.delete("deepseek"), /只读/);
});

test("文件不存在算没有凭据；格式坏了就报错", async (t) => {
  assert.equal(await piCredentials(file(t)).read("deepseek"), undefined);
  await assert.rejects(piCredentials(file(t, "{坏的")).read("deepseek"));
});

test("每次都重读：文件改了马上生效", async (t) => {
  const path = file(t, JSON.stringify({}));
  const store = piCredentials(path);
  assert.equal(await store.read("deepseek"), undefined);
  writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "k2" } }));
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "k2" });
});
