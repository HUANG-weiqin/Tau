// extras/auth/login.ts（D83）：登录、登出、列出。登录流程本身是 pi-ai 供应商的，这里用假供应商走一遍，再用真的终端交互走一遍 api_key。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { AuthInteraction, Models, MutableModels, OAuthAuth } from "@earendil-works/pi-ai";
import { main, terminal } from "../../../extras/auth/login.ts";
import { fileCredentials } from "../../../extras/auth/store.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "extras", "auth", "login.ts");

function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "tau-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "auth.json");
  const out: string[] = [];
  const err: string[] = [];
  return { dir, file, out, err, deps: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
}

/** 一个假的 OAuth 供应商：登录会提示一次、通知一次设备码，然后给出令牌；`fail` 时登录抛错。 */
function fakeModels(file: string, fail = false): Models {
  const auth: OAuthAuth = {
    name: "Fake",
    login: async (i) => {
      const who = await i.prompt({ type: "text", message: "域名" });
      i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.test/device", expiresInSeconds: 900 });
      if (fail) throw new Error("用户没授权");
      return { type: "oauth", access: `access-${who}`, refresh: "refresh-1", expires: Date.UTC(2100, 0, 1) };
    },
    refresh: async (c) => c,
    toAuth: async (c) => ({ apiKey: c.access }),
  };
  const models = createModels({ credentials: fileCredentials(file) });
  const never = { stream: () => assert.fail("不该调模型"), streamSimple: () => assert.fail("不该调模型") };
  models.setProvider(createProvider({ id: "fake", name: "Fake Co", auth: { oauth: auth }, models: [], api: never as never }));
  return models;
}

const scripted = (answers: string[], events: unknown[] = []): AuthInteraction => ({
  prompt: async () => answers.shift() ?? assert.fail("没有预备的回答"),
  notify: (e) => void events.push(e),
});

test("login：OAuth 登录写进 --file，事件交给交互，输出说明；list 看得到；logout 删掉", async (t) => {
  const { file, out, err, deps } = setup(t);
  const events: unknown[] = [];
  const base = { ...deps, models: (f: string) => fakeModels(f), interaction: scripted(["corp.example"], events) };
  assert.equal(await main(["login", "fake", "--file", file], base), 0, err.join(""));
  assert.equal(events.length, 1);
  assert.match(out.join(""), /已登录 Fake Co（oauth）/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { fake: { type: "oauth", access: "access-corp.example", refresh: "refresh-1", expires: Date.UTC(2100, 0, 1) } });
  out.length = 0;
  assert.equal(await main(["list", "--file", file], base), 0);
  assert.match(out.join(""), /fake（oauth）/);
  assert.match(out.join(""), /可以 OAuth 登录的供应商：.*fake/);
  out.length = 0;
  assert.equal(await main(["logout", "fake", "--file", file], base), 0);
  assert.match(out.join(""), /已登出 Fake Co/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
  assert.equal(await main(["logout", "fake", "--file", file], base), 0, "没存过也算成功");
});

test("login：登录失败退出码 1，说原因，文件不动、没有锁；用法错误和不认识的供应商退出码 2", async (t) => {
  const { file, err, deps } = setup(t);
  writeFileSync(file, '{"deepseek":{"type":"api_key","key":"k"}}');
  const bad = { ...deps, models: (f: string) => fakeModels(f, true), interaction: scripted(["x"]) };
  assert.equal(await main(["login", "fake", "--file", file], bad), 1);
  assert.match(err.join(""), /失败/);
  assert.equal(readFileSync(file, "utf8"), '{"deepseek":{"type":"api_key","key":"k"}}');
  assert.equal(existsSync(`${file}.lock`), false);
  for (const argv of [[], ["bogus"], ["login"], ["logout"], ["list", "x"], ["login", "fake", "oauth", "more"], ["logout", "fake", "oauth"], ["login", "fake", "--nope"], ["login", "fake", "magic"]]) {
    err.length = 0;
    assert.equal(await main([...argv, "--file", file], { ...deps, models: (f) => fakeModels(f), interaction: scripted([]) }), 2, argv.join(" "));
    assert.ok(err.join("").length > 0, argv.join(" "));
  }
  err.length = 0;
  assert.equal(await main(["login", "nobody", "--file", file], { ...deps, models: (f) => fakeModels(f) }), 2);
  assert.match(err.join(""), /没有这家供应商：nobody/);
});

test("login：api_key 登录存进文件，别的条目原样；文件坏了拒绝，文件不动", async (t) => {
  const { file, err, deps } = setup(t);
  writeFileSync(file, `${JSON.stringify({ anthropic: { type: "api_key", key: "keep" } })}`);
  assert.equal(await main(["login", "deepseek", "api_key", "--file", file], { ...deps, interaction: scripted(["  sk-new  "]) }), 0, err.join(""));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.anthropic, { type: "api_key", key: "keep" });
  assert.deepEqual(saved.deepseek, { type: "api_key", key: "sk-new" }, "和界面一样，存的是 trim 后的值");
  // 不带类型：没有 OAuth 的供应商默认 api_key。
  assert.equal(await main(["login", "opencode-go", "--file", file], { ...deps, interaction: scripted(["sk-oc"]) }), 0, err.join(""));
  assert.equal(JSON.parse(readFileSync(file, "utf8"))["opencode-go"].key, "sk-oc");
  writeFileSync(file, "{坏的");
  assert.equal(await main(["login", "deepseek", "api_key", "--file", file], { ...deps, interaction: scripted(["sk-x"]) }), 1);
  assert.equal(readFileSync(file, "utf8"), "{坏的");
});

test("terminal：事件打印成人话；设备码、链接、说明都在", () => {
  const out: string[] = [];
  const term = terminal((s) => void out.push(s));
  term.notify({ type: "device_code", userCode: "WXYZ-9999", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 });
  term.notify({ type: "auth_url", url: "https://auth.example/authorize?x=1", instructions: "登录后回到这里" });
  term.notify({ type: "info", message: "提示", links: [{ url: "https://a.example", label: "文档" }] });
  term.notify({ type: "progress", message: "正在启用模型" });
  term.close();
  const text = out.join("");
  assert.match(text, /https:\/\/github.com\/login\/device .*WXYZ-9999.*15 分钟/);
  assert.match(text, /在浏览器里打开：https:\/\/auth.example\/authorize\?x=1\n登录后回到这里/);
  assert.match(text, /提示\n  文档 https:\/\/a.example/);
  assert.match(text, /正在启用模型/);
});

test("脚本：标准输入不是终端时照样走完 api_key 登录；key 不出现在输出里", async (t) => {
  const { file } = setup(t);
  const child = execFile(process.execPath, [SCRIPT, "login", "deepseek", "api_key", "--file", file]);
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  child.stdin?.end("sk-from-pipe-SECRET\n");
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, output);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { deepseek: { type: "api_key", key: "sk-from-pipe-SECRET" } });
  assert.doesNotMatch(output, /SECRET/);
});

test("login：api_key 和界面过一样的检查：空的、含控制字符的、! 开头的、含 $ 的都拒绝，退出码 1，文件不动，说明里没有 key", async (t) => {
  const { file, err, deps } = setup(t);
  const text = '{"anthropic":{"type":"api_key","key":"keep"}}';
  writeFileSync(file, text);
  for (const key of ["", "   ", "$FOO-SECRET", "!ls SECRET", "sk-SECRET\u0000x", "x".repeat(5000)]) {
    err.length = 0;
    assert.equal(await main(["login", "deepseek", "api_key", "--file", file], { ...deps, interaction: scripted([key]) }), 1, JSON.stringify(key.slice(0, 12)));
    assert.match(err.join(""), /失败：key /);
    assert.doesNotMatch(err.join(""), /SECRET/);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("list 和 logout 遇到坏文件：退出码 1，一行说明，没有堆栈，说明不重复，文件不动", async (t) => {
  const { file, err, deps } = setup(t);
  writeFileSync(file, "{坏的");
  for (const argv of [["list"], ["logout", "deepseek"]]) {
    err.length = 0;
    assert.equal(await main([...argv, "--file", file], deps), 1, argv.join(" "));
    const text = err.join("");
    assert.match(text, /不是合法的 JSON/);
    assert.equal(text.split("不是合法的 JSON").length, 2, `只说一遍：${text}`);
    assert.doesNotMatch(text, /\n\s+at /);
  }
  assert.equal(readFileSync(file, "utf8"), "{坏的");
});

test("脚本：输入被关闭（标准输入一上来就结束）：退出码 1 和一行说明，不是 13", async (t) => {
  const { file } = setup(t);
  const child = execFile(process.execPath, [SCRIPT, "login", "deepseek", "api_key", "--file", file]);
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  child.stdin?.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, output);
  assert.match(output, /失败：输入被关闭了/);
  assert.equal(existsSync(file), false);
});

// D105：登录 GitHub Copilot 成功以后生成一次模型补充文件。假供应商用 Copilot 的 id；刷新是注入的，不联网。
function fakeCopilot(file: string): MutableModels {
  const models = createModels({ credentials: fileCredentials(file) });
  const never = { stream: () => assert.fail("不该调模型"), streamSimple: () => assert.fail("不该调模型") };
  const auth: OAuthAuth = { name: "Copilot", login: async () => ({ type: "oauth", access: "A", refresh: "R", expires: Date.UTC(2100, 0, 1) }), refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }) };
  models.setProvider(createProvider({ id: "github-copilot", name: "GitHub Copilot", auth: { oauth: auth }, models: [], api: never as never }));
  return models;
}

test("login github-copilot：登录成功后跑一次刷新，输出它的摘要；刷新用刚存的凭据所在的文件", async (t) => {
  const { file, out, err, deps } = setup(t);
  const seen: string[] = [];
  const refresh = async (f: string, m: Models) => {
    seen.push(f);
    assert.ok(await m.getAuth("github-copilot"), "刷新用的 Models 已经有刚登录的凭据");
    return { kind: "ok" as const, summary: "模型列表已更新：3 个。" };
  };
  assert.equal(await main(["login", "github-copilot", "--file", file], { ...deps, models: fakeCopilot, interaction: scripted([]), refresh }), 0, err.join(""));
  assert.deepEqual(seen, [file]);
  assert.match(out.join(""), /已登录 GitHub Copilot[\s\S]*模型列表已更新：3 个。/);
  assert.equal(err.join(""), "");
});

test("login github-copilot：刷新失败（返回失败或抛错）只打警告，登录照样成功，退出码 0，凭据已存", async (t) => {
  for (const refresh of [async () => ({ kind: "failed" as const, summary: "刷新失败：HTTP 500" }), async (): Promise<never> => Promise.reject(new Error("炸了"))]) {
    const { file, out, err, deps } = setup(t);
    assert.equal(await main(["login", "github-copilot", "--file", file], { ...deps, models: fakeCopilot, interaction: scripted([]), refresh }), 0);
    assert.match(out.join(""), /已登录 GitHub Copilot/);
    assert.match(err.join(""), /警告：.*(HTTP 500|炸了)/);
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["github-copilot"].type, "oauth");
  }
});

test("login：登录失败不刷新；别家的登录不刷新；登出不刷新", async (t) => {
  const { file, deps } = setup(t);
  const refresh = async (): Promise<never> => assert.fail("不该刷新");
  const failing = (f: string): Models => {
    const m = fakeCopilot(f);
    const p = m.getProvider("github-copilot")!;
    m.setProvider({ ...p, auth: { oauth: { ...p.auth.oauth!, login: async () => Promise.reject(new Error("没授权")) } } } as never);
    return m;
  };
  assert.equal(await main(["login", "github-copilot", "--file", file], { ...deps, models: failing, interaction: scripted([]), refresh }), 1);
  assert.equal(await main(["login", "fake", "--file", file], { ...deps, models: (f) => fakeModels(f), interaction: scripted(["x"]), refresh }), 0);
  assert.equal(await main(["logout", "fake", "--file", file], { ...deps, models: (f) => fakeModels(f), refresh }), 0);
});

test("login github-copilot（默认刷新）：不认旧的见过状态，换账号后旧账号的模型不留；用登录用的凭据文件所在的家", async (t) => {
  const { file, deps } = setup(t);
  const home = dirname(file);
  const stateFile = join(home, "extras", "models", "github-copilot.json");
  mkdirSync(dirname(stateFile), { recursive: true });
  const old = { id: "old-account-model", name: "o", api: "openai-completions", provider: "github-copilot", baseUrl: "https://x.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
  writeFileSync(stateFile, JSON.stringify({ lastSuccess: Date.now(), seen: { [old.id]: { lastSeen: Date.now(), entry: old } } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ data: [{ id: "new-account-model", name: "n", model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", limits: { max_prompt_tokens: 50_000, max_output_tokens: 4_000 }, supports: { tool_calls: true } } }] })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  assert.equal(await main(["login", "github-copilot", "--file", file], { ...deps, models: fakeCopilot, interaction: scripted([]) }), 0);
  const written = JSON.parse(readFileSync(join(home, "models", "github-copilot.json"), "utf8")) as { models: { id: string }[] };
  assert.deepEqual(written.models.map((m) => m.id), ["new-account-model"]);
});
