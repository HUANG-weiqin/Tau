// 只读复用 pi 的凭据文件：只交出 api_key 条目，不写入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
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
  await assert.rejects(piCredentials(file(t, "{坏的")).read("deepseek"), /不是合法的 JSON/);
});

test("格式坏了时，报错不带文件内容：V8 的报错会引用出错处附近的原文，可能是 key 的开头", async (t) => {
  const store = piCredentials(file(t, `{"deepseek":{"type":"api_key","key":'sk-FAKESECRET'}}`));
  await assert.rejects(store.read("deepseek"), (e: Error) => /不是合法的 JSON/.test(e.message) && !e.message.includes("FAKE") && !e.message.includes("sk-"));
});

test("合法的 JSON 但顶层不是对象：报错，不悄悄当成没有凭据", async (t) => {
  for (const content of [`"oops"`, "[]", "null", "42"]) {
    await assert.rejects(piCredentials(file(t, content)).read("deepseek"), /不是 JSON 对象/, content);
  }
});

test("只支持字面量 key：pi 的命令（!）和变量（$）写法报错，不原样发出去", async (t) => {
  const store = piCredentials(
    file(
      t,
      JSON.stringify({
        cmd: { type: "api_key", key: "!op read 'op://vault/item'" },
        env: { type: "api_key", key: "$MY_KEY" },
        braces: { type: "api_key", key: "pre_${X}" },
        escaped: { type: "api_key", key: "$$literal" },
        number: { type: "api_key", key: 42 },
        plain: { type: "api_key", key: "k1" },
      }),
    ),
  );
  for (const id of ["cmd", "env", "braces", "escaped"]) await assert.rejects(store.read(id), /字面量/, id);
  await assert.rejects(store.read("number"), /不是字符串/);
  assert.deepEqual(await store.read("plain"), { type: "api_key", key: "k1" });
  // 某个条目写法不对，不影响列出和读取别的条目。
  assert.equal((await store.list()).length, 6);
});

test("接进 pi-ai：文件里的 key 优先；只有 OAuth 或 key 为空时用环境变量；文件坏了，这次调用以 error 结束", async (t) => {
  const path = file(t);
  const env: Record<string, string> = { DEEPSEEK_API_KEY: "env-ds", ANTHROPIC_API_KEY: "env-an" };
  const models = builtinModels({ credentials: piCredentials(path), authContext: { env: async (n) => env[n], fileExists: async () => false } });
  writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "file-ds" }, anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
  assert.deepEqual((await models.getAuth("deepseek"))?.auth, { apiKey: "file-ds" });
  assert.deepEqual((await models.getAuth("anthropic"))?.auth, { apiKey: "env-an" });
  // deepseek 的 key 为空串时仍读环境变量。cloudflare 和 google-vertex 不是这样（kb-service）。
  writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "" } }));
  assert.deepEqual((await models.getAuth("deepseek"))?.auth, { apiKey: "env-ds" });
  // 读凭据在发请求之前失败，所以不连网络。
  writeFileSync(path, `{"deepseek":{"type":"api_key","key":'sk-FAKESECRET'}}`);
  const model = models.getModel("deepseek", "deepseek-flash");
  assert.ok(model);
  const reply = await models.streamSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }).result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /不是合法的 JSON/);
  assert.doesNotMatch(reply.errorMessage ?? "", /FAKE/);
});

test("每次都重读：文件改了马上生效", async (t) => {
  const path = file(t, JSON.stringify({}));
  const store = piCredentials(path);
  assert.equal(await store.read("deepseek"), undefined);
  writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "k2" } }));
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "k2" });
});
