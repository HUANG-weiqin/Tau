// 凭据文件（~/.tau/auth.json，D83）的行为测试。
// src/server/credentials.ts 和 extras/auth/store.ts 是同一份实现的两个拷贝（extras 不许导入 src），
// 同一套测试对两份各跑一遍，拷贝漂移了这里会红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Credential, CredentialStore, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

type Make = (file: string, opts?: { lockTimeoutMs?: number; staleMs?: number }) => CredentialStore;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FUTURE = Date.UTC(2100, 0, 1);
const oauth = (n: number, expires = FUTURE): OAuthCredential => ({ type: "oauth", access: `a${n}`, refresh: `r${n}`, expires });

export function credentialSuite(name: string, make: Make, moduleUrl: URL): void {
  function file(t: { after: (f: () => void) => void }, content?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tau-cred-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "auth.json");
    if (content !== undefined) writeFileSync(path, content);
    return path;
  }
  const disk = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

  test(`${name}：api_key 和 oauth 条目都交出；别的类型和不存在的当作没有`, async (t) => {
    const store = make(
      file(t, JSON.stringify({ deepseek: { type: "api_key", key: "k1" }, copilot: oauth(1, 5), weird: { type: "magic" }, junk: 7 })),
    );
    assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "k1" });
    assert.deepEqual(await store.read("copilot"), oauth(1, 5));
    for (const id of ["weird", "junk", "absent"]) assert.equal(await store.read(id), undefined, id);
    assert.deepEqual(await store.list(), [
      { providerId: "deepseek", type: "api_key" },
      { providerId: "copilot", type: "oauth" },
    ]);
  });

  test(`${name}：文件不存在算没有凭据；modify 会建出目录和文件`, async (t) => {
    const path = join(file(t, undefined), "..", "sub", "auth.json");
    const store = make(path);
    assert.equal(await store.read("deepseek"), undefined);
    assert.deepEqual(await store.list(), []);
    await store.modify("deepseek", async () => ({ type: "api_key", key: "k1" }));
    assert.deepEqual(disk(path), { deepseek: { type: "api_key", key: "k1" } });
  });

  test(`${name}：格式坏了报错，报错不带文件内容（V8 的报错会引用出错处的原文，可能是 key 的开头）`, async (t) => {
    const store = make(file(t, `{"deepseek":{"type":"api_key","key":'sk-FAKESECRET'}}`));
    await assert.rejects(store.read("deepseek"), (e: Error) => /不是合法的 JSON/.test(e.message) && !e.message.includes("FAKE") && !e.message.includes("sk-"));
    for (const content of [`"oops"`, "[]", "null", "42"]) await assert.rejects(make(file(t, content)).read("x"), /不是 JSON 对象/, content);
  });

  test(`${name}：文件坏了时 modify 和 delete 拒绝，文件一个字节都不动`, async (t) => {
    const bad = `{"deepseek": 坏的`;
    const path = file(t, bad);
    const store = make(path);
    await assert.rejects(store.modify("x", async () => ({ type: "api_key", key: "k" })), /不是合法的 JSON/);
    await assert.rejects(store.delete("deepseek"), /不是合法的 JSON/);
    assert.equal(readFileSync(path, "utf8"), bad);
    assert.equal(existsSync(`${path}.lock`), false, "锁要释放");
  });

  test(`${name}：只支持字面量 key，条目字段不对报错，不原样发出去`, async (t) => {
    const store = make(
      file(
        t,
        JSON.stringify({
          cmd: { type: "api_key", key: "!op read 'op://vault/item'" },
          env: { type: "api_key", key: "$MY_KEY" },
          braces: { type: "api_key", key: "pre_${X}" },
          number: { type: "api_key", key: 42 },
          noAccess: { type: "oauth", refresh: "r", expires: 1 },
          badExpires: { type: "oauth", access: "a", refresh: "r", expires: "soon" },
          plain: { type: "api_key", key: "k1" },
        }),
      ),
    );
    for (const id of ["cmd", "env", "braces"]) await assert.rejects(store.read(id), /字面量/, id);
    await assert.rejects(store.read("number"), /不是字符串/);
    for (const id of ["noAccess", "badExpires"]) await assert.rejects(store.read(id), /OAuth 条目/, id);
    assert.deepEqual(await store.read("plain"), { type: "api_key", key: "k1" });
    // 某条写得不对，不影响列出别的条目，也不挡着 modify 把它换掉。
    assert.equal((await store.list()).length, 7);
    assert.deepEqual(await store.modify("cmd", async () => ({ type: "api_key", key: "ok" })), { type: "api_key", key: "ok" });
  });

  test(`${name}：modify 看得到当前条目，写进去的原样读回，别的条目原样保留，fn 返回 undefined 不写`, async (t) => {
    const original = { deepseek: { type: "api_key", key: "k1", extra: [1, { a: 2 }] }, odd: { type: "magic", x: 1 } };
    const path = file(t, JSON.stringify(original));
    const store = make(path);
    let seen: Credential | undefined;
    const after = await store.modify("anthropic", async (cur) => {
      seen = cur;
      return { type: "api_key", key: "k2", env: { A: "b" } };
    });
    assert.equal(seen, undefined);
    assert.deepEqual(after, { type: "api_key", key: "k2", env: { A: "b" } });
    assert.deepEqual(disk(path), { ...original, anthropic: { type: "api_key", key: "k2", env: { A: "b" } } });
    const before = readFileSync(path, "utf8");
    assert.deepEqual(await store.modify("deepseek", async (cur) => (assert.deepEqual(cur, original.deepseek), undefined)), original.deepseek);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test(`${name}：fn 抛错，文件不动，锁释放，下一次照常`, async (t) => {
    const path = file(t, JSON.stringify({ a: { type: "api_key", key: "1" } }));
    const store = make(path);
    const before = readFileSync(path, "utf8");
    await assert.rejects(store.modify("a", async () => Promise.reject(new Error("刷新失败"))), /刷新失败/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(existsSync(`${path}.lock`), false);
    await store.modify("a", async () => ({ type: "api_key", key: "2" }));
    assert.deepEqual(disk(path), { a: { type: "api_key", key: "2" } });
  });

  test(`${name}：delete 删掉这一条，别的原样；没有这一条就不碰文件`, async (t) => {
    const path = file(t, JSON.stringify({ a: { type: "api_key", key: "1" }, b: oauth(1) }));
    const store = make(path);
    await store.delete("a");
    assert.deepEqual(disk(path), { b: oauth(1) });
    const before = readFileSync(path, "utf8");
    await store.delete("a");
    assert.equal(readFileSync(path, "utf8"), before);
    await make(join(file(t), "..", "none.json")).delete("a"); // 文件不存在也不报错
  });

  test(`${name}：写完目录里只剩 auth.json，没有锁和临时文件；遗留的临时文件不影响读写`, async (t) => {
    const path = file(t);
    writeFileSync(`${path}.tmp`, "上次崩溃时写了一半");
    const store = make(path);
    await store.modify("a", async () => ({ type: "api_key", key: "1" }));
    assert.deepEqual(readdirSync(join(path, "..")), [basename(path)]);
  });

  test(`${name}：陈旧的锁（持锁的进程崩了）被清掉；新鲜的锁被占着就等；一直占着就超时，不动文件`, async (t) => {
    const path = file(t);
    const lock = `${path}.lock`;
    // 陈旧：锁目录的修改时间在很久以前。
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await make(path, { staleMs: 1000 }).modify("a", async () => ({ type: "api_key", key: "1" }));
    assert.equal(existsSync(lock), false);
    // 新鲜：别人持锁，释放以后接着做。
    mkdirSync(lock);
    const waiting = make(path, { lockTimeoutMs: 5000, staleMs: 10_000 }).modify("b", async () => ({ type: "api_key", key: "2" }));
    await sleep(150);
    assert.deepEqual(disk(path), { a: { type: "api_key", key: "1" } }, "锁被占着，还没写");
    rmSync(lock, { recursive: true });
    await waiting;
    assert.deepEqual(disk(path), { a: { type: "api_key", key: "1" }, b: { type: "api_key", key: "2" } });
    // 一直占着：超时报错，不动文件，也不删别人的锁。
    mkdirSync(lock);
    const before = readFileSync(path, "utf8");
    await assert.rejects(make(path, { lockTimeoutMs: 150, staleMs: 10_000 }).modify("c", async () => ({ type: "api_key", key: "3" })), /被别的进程占着/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(existsSync(lock), true);
  });

  test(`${name}：持锁的进程崩了（没人再刷新锁目录）：等锁的人在超时之前清掉它，不是等到超时报错`, async (t) => {
    const path = file(t);
    mkdirSync(`${path}.lock`); // 刚建的锁，没有人持有它
    const started = Date.now();
    await make(path, { lockTimeoutMs: 3000, staleMs: 300 }).modify("a", async () => ({ type: "api_key", key: "1" }));
    const waited = Date.now() - started;
    assert.ok(waited >= 250 && waited < 2000, `等了 ${waited} 毫秒`);
    assert.deepEqual(disk(path), { a: { type: "api_key", key: "1" } });
  });

  test(`${name}：持锁的人慢（超过 staleMs）也不会被偷锁：持锁时一直刷新锁的修改时间`, async (t) => {
    const path = file(t);
    const opts = { lockTimeoutMs: 5000, staleMs: 300 };
    const bump = (cur: Credential | undefined): OAuthCredential => oauth(0, ((cur as OAuthCredential | undefined)?.expires ?? 0) + 1);
    const slow = make(path, opts).modify("n", async (cur) => (await sleep(1000), bump(cur))); // 是 staleMs 的三倍多
    await sleep(100);
    const quick = make(path, opts).modify("n", async (cur) => bump(cur));
    await Promise.all([slow, quick]);
    assert.equal(((await make(path).read("n")) as OAuthCredential).expires, 2, "两次加一都在，没有被偷锁丢掉一次");
  });

  test(`${name}：同一个文件上并发 modify 不交错：每个 fn 看到的是前一个写下的`, async (t) => {
    const path = file(t);
    const a = make(path);
    const b = make(path); // 两个实例，等于两个进程
    const run = (s: CredentialStore, delay: number): Promise<unknown> =>
      s.modify("counter", async (cur) => {
        const n = (cur as OAuthCredential | undefined)?.expires ?? 0;
        await sleep(delay); // 持锁时让出，别人要是能插进来，这里就会丢更新
        return oauth(0, n + 1);
      });
    await Promise.all([run(a, 30), run(b, 10), run(a, 20), run(b, 0), run(a, 5)]);
    assert.equal(((await a.read("counter")) as OAuthCredential).expires, 5);
  });

  test(`${name}：三个进程各改 15 次同一条，一次不丢`, async (t) => {
    const path = file(t);
    const child = new URL("./credential-child.ts", import.meta.url);
    const run = (): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [child.pathname.replace(/^\/(\w:)/, "$1"), moduleUrl.href, path, "15"], { stdio: "inherit" });
        p.on("error", reject);
        p.on("exit", resolve);
      });
    assert.deepEqual(await Promise.all([run(), run(), run()]), [0, 0, 0]);
    assert.equal(((await make(path).read("counter")) as OAuthCredential).expires, 45);
  });

  test(`${name}：别人在写的时候读，读到的总是完整的一份，不报错`, async (t) => {
    const path = file(t, JSON.stringify({ x: oauth(0, 0) }));
    const store = make(path);
    let done = false;
    const writer = (async () => {
      for (let i = 1; i <= 40; i++) await store.modify("x", async () => oauth(i, i));
      done = true;
    })();
    let reads = 0;
    while (!done) {
      await sleep(50); // 界面和服务读它是偶尔的。读得比这密，文件几乎一直被打开着，改名会一直被挡在门外，那不是真实的读法
      const c = (await make(path).read("x")) as OAuthCredential;
      assert.equal(c.type, "oauth");
      reads++;
    }
    await writer;
    assert.ok(reads > 0);
  });

  // 接进 pi-ai：用一个假的 OAuth 供应商，走它真的登录、刷新、登出流程。
  function fake(store: CredentialStore, calls: { refresh: number }, refreshFails = false) {
    let n = 1;
    const auth: OAuthAuth = {
      name: "Fake",
      login: async () => oauth(1),
      refresh: async (c) => {
        calls.refresh++;
        if (refreshFails) throw new Error("invalid_grant");
        n++;
        return { ...c, access: `a${n}`, refresh: `r${n}`, expires: Date.now() + 3_600_000 };
      },
      toAuth: async (c) => ({ apiKey: c.access }),
    };
    const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
    const never = { stream: () => assert.fail("不该调模型"), streamSimple: () => assert.fail("不该调模型") };
    models.setProvider(createProvider({ id: "fake", auth: { oauth: auth }, models: [], api: never as never }));
    return models;
  }
  const interaction = { prompt: async () => assert.fail("不该提问"), notify: () => {} };

  test(`${name}：接进 pi-ai：登录写进文件；快过期的令牌刷新一次，轮换后的 refresh 写回；登出删掉条目`, async (t) => {
    const path = file(t, JSON.stringify({ deepseek: { type: "api_key", key: "k1" } }));
    const calls = { refresh: 0 };
    const models = fake(make(path), calls);
    assert.equal((await models.login("fake", "oauth", interaction)).type, "oauth");
    assert.deepEqual((disk(path) as Record<string, unknown>).fake, oauth(1));
    assert.deepEqual((await models.getAuth("fake"))?.auth, { apiKey: "a1" });
    assert.equal(calls.refresh, 0);
    // 令牌 1 分钟后过期（pi-ai 5 分钟内就刷新）：刷新一次，写回，再取就不刷新了。另一个实例（另一个进程）读到新的。
    writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "k1" }, fake: oauth(1, Date.now() + 60_000) }));
    assert.deepEqual((await models.getAuth("fake"))?.auth, { apiKey: "a2" });
    assert.deepEqual((await models.getAuth("fake"))?.auth, { apiKey: "a2" });
    assert.equal(calls.refresh, 1);
    assert.equal(((await make(path).read("fake")) as OAuthCredential).refresh, "r2");
    assert.deepEqual((disk(path) as { deepseek: unknown }).deepseek, { type: "api_key", key: "k1" });
    await models.logout("fake");
    assert.equal(await make(path).read("fake"), undefined);
    assert.deepEqual(Object.keys(disk(path) as object), ["deepseek"]);
  });

  test(`${name}：接进 pi-ai：刷新失败，条目原样留着，换个时候还能再试`, async (t) => {
    const expiring = oauth(1, Date.now() + 60_000);
    const path = file(t, JSON.stringify({ fake: expiring }));
    const calls = { refresh: 0 };
    const models = fake(make(path), calls, true);
    await assert.rejects(models.getAuth("fake"), /OAuth refresh failed/);
    assert.deepEqual(disk(path), { fake: expiring });
    assert.equal(existsSync(`${path}.lock`), false);
    await assert.rejects(models.getAuth("fake"), /OAuth refresh failed/);
    assert.equal(calls.refresh, 2);
  });

  test(`${name}：接进 pi-ai：文件里的 key 优先；key 为空或没有条目时用环境变量；文件坏了，这次调用以 error 结束`, async (t) => {
    const path = file(t);
    const env: Record<string, string> = { DEEPSEEK_API_KEY: "env-ds", ANTHROPIC_API_KEY: "env-an" };
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    const all = builtinModels({ credentials: make(path), authContext: { env: async (n) => env[n], fileExists: async () => false } });
    writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "file-ds" } }));
    assert.deepEqual((await all.getAuth("deepseek"))?.auth, { apiKey: "file-ds" });
    assert.deepEqual((await all.getAuth("anthropic"))?.auth, { apiKey: "env-an" });
    writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "" } }));
    assert.deepEqual((await all.getAuth("deepseek"))?.auth, { apiKey: "env-ds" });
    // 读凭据在发请求之前失败，所以不连网络。
    writeFileSync(path, `{"deepseek":{"type":"api_key","key":'sk-FAKESECRET'}}`);
    const model = all.getModel("deepseek", "deepseek-flash");
    assert.ok(model);
    const reply = await all.streamSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }).result();
    assert.equal(reply.stopReason, "error");
    assert.match(reply.errorMessage ?? "", /不是合法的 JSON/);
    assert.doesNotMatch(reply.errorMessage ?? "", /FAKE/);
  });
}
