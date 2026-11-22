import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { main, render } from "../../extras/handbook/install.ts";

const repo = path.resolve(import.meta.dirname, "..", "..");
const script = path.join(repo, "extras", "handbook", "install.ts");
const prototype = path.join(repo, "extras", "handbook", "handbook.md");
const slash = (p: string): string => p.replaceAll("\\", "/");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("render", () => {
  test("换掉三个占位符，重复出现的也都换", () => {
    const out = render("{{TAU_HOME}} {{SKILLS}} {{REPO}} {{REPO}}", { TAU_HOME: "a", SKILLS: "b", REPO: "c" });
    assert.equal(out, "a b c c");
  });
  test("未知占位符抛错，信息里有名字", () => {
    assert.throws(() => render("{{X_Y}} {{REPO}} {{ZZ}}", { REPO: "c" }), (e: Error) => e.message.includes("X_Y") && e.message.includes("ZZ") && !e.message.includes("REPO"));
  });
  test("没有占位符原样返回", () => {
    assert.equal(render("hello {x} {{a}}\r\n", {}), "hello {x} {{a}}\r\n");
  });
  test("真原型用假路径渲染后没有 {{", () => {
    const out = render(readFileSync(prototype, "utf8"), { TAU_HOME: "/t", SKILLS: "/s", REPO: "/r" });
    assert.ok(!out.includes("{{"));
  });
});

describe("install.ts 子进程", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tau-handbook-cli-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const tauHome = path.join(home, ".tau");
  const target = path.join(tauHome, "handbook.md");
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, USERPROFILE: home }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  test("没装：--check 报没装不建文件；安装后内容等于渲染结果；再装没改", () => {
    const c = run("--check");
    assert.equal(c.code, 1);
    assert.match(c.out, /没装/);
    assert.equal(existsSync(tauHome), false);
    assert.equal(run().code, 0);
    const expected = render(readFileSync(prototype, "utf8"), {
      TAU_HOME: slash(tauHome),
      SKILLS: slash(path.join(home, ".agents", "skills")),
      REPO: slash(repo),
    });
    assert.equal(readFileSync(target, "utf8"), expected);
    assert.match(run().out, /已是最新，没改/);
    assert.equal(run("--check").code, 0);
  });
  test("用法错误退出码 2", () => {
    assert.equal(run("--check", "--force").code, 2);
    assert.equal(run("--bogus").code, 2);
    assert.equal(run("extra").code, 2);
  });
  test("盘符大小写不同的路径，结果一样", () => {
    const lower = script.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
    const r = spawnSync(process.execPath, [lower, "--check"], { env: { ...process.env, USERPROFILE: home }, encoding: "utf8" });
    assert.match(r.stdout, /已是最新/);
  });
});

describe("main 注入", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-handbook-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const fresh = (template = "手册 {{TAU_HOME}} {{REPO}} v1\n") => {
    const dir = path.join(root, String(n++));
    const home = path.join(dir, "home");
    const source = path.join(dir, "proto.md");
    mkdirSync(home, { recursive: true });
    writeFileSync(source, template);
    const target = path.join(home, ".tau", "handbook.md");
    const record = path.join(home, ".tau", "extras", "handbook", "installed.sha256");
    const run = async (...args: string[]) => {
      let out = "";
      let err = "";
      const code = await main(args, { home, source, repoRoot: repo, out: (s) => (out += s + "\n"), err: (s) => (err += s + "\n") });
      return { code, out, err };
    };
    const setProto = (t: string) => writeFileSync(source, t);
    const tmpLeft = () => {
      const left: string[] = [];
      for (const d of [path.join(home, ".tau"), path.dirname(record)]) if (existsSync(d)) left.push(...readdirSync(d).filter((f) => f.endsWith(".tmp")));
      return left;
    };
    return { run, target, record, setProto, tmpLeft };
  };

  test("第一次装：写目标和记录，记录是内容的哈希", async () => {
    const t = fresh();
    const r = await t.run();
    assert.equal(r.code, 0);
    assert.match(r.out, /已装：/);
    const body = readFileSync(t.target, "utf8");
    assert.ok(body.includes("v1") && !body.includes("{{"));
    assert.equal(readFileSync(t.record, "utf8").trim(), sha(body));
    assert.deepEqual(t.tmpLeft(), []);
  });
  test("改原型后再装：已更新，退出 0，记录跟着变", async () => {
    const t = fresh();
    await t.run();
    t.setProto("手册 {{TAU_HOME}} v2\n");
    const c = await t.run("--check");
    assert.equal(c.code, 1);
    assert.match(c.out, /原型有更新/);
    const r = await t.run();
    assert.equal(r.code, 0);
    assert.match(r.out, /已更新：/);
    const body = readFileSync(t.target, "utf8");
    assert.ok(body.includes("v2"));
    assert.equal(readFileSync(t.record, "utf8").trim(), sha(body));
    assert.deepEqual(t.tmpLeft(), []);
  });
  test("手改装着的：拒绝，文件不变；--check 报被改过；--force 覆盖并更新记录", async () => {
    const t = fresh();
    await t.run();
    const original = readFileSync(t.target, "utf8");
    writeFileSync(t.target, original + "手改\n");
    t.setProto("手册 {{TAU_HOME}} v2\n");
    const r = await t.run();
    assert.equal(r.code, 1);
    assert.match(r.err, /装着的手册被直接改过（和上次装的不一样）。先把要留的改动搬进原型 .*--force/);
    assert.equal(readFileSync(t.target, "utf8"), original + "手改\n");
    const c = await t.run("--check");
    assert.equal(c.code, 1);
    assert.match(c.out, /装着的被改过/);
    const f = await t.run("--force");
    assert.equal(f.code, 0);
    assert.match(f.out, /已覆盖：/);
    const body = readFileSync(t.target, "utf8");
    assert.ok(body.includes("v2"));
    assert.equal(readFileSync(t.record, "utf8").trim(), sha(body));
  });
  test("没有记录且装着的和渲染不同：算被改过", async () => {
    const t = fresh();
    await t.run();
    rmSync(t.record);
    t.setProto("手册 {{TAU_HOME}} v2\n");
    const r = await t.run();
    assert.equal(r.code, 1);
    assert.match((await t.run("--check")).out, /装着的被改过/);
  });
  test("已是最新但没有记录：安装补记录，--check 不补", async () => {
    const t = fresh();
    await t.run();
    const body = readFileSync(t.target, "utf8");
    rmSync(t.record);
    const c = await t.run("--check");
    assert.equal(c.code, 0);
    assert.match(c.out, /已是最新/);
    assert.equal(existsSync(t.record), false);
    const r = await t.run();
    assert.equal(r.code, 0);
    assert.match(r.out, /已是最新，没改/);
    assert.equal(readFileSync(t.record, "utf8").trim(), sha(body));
  });
  test("记录不对但装着的 == 渲染：安装修正记录", async () => {
    const t = fresh();
    await t.run();
    writeFileSync(t.record, "bad");
    await t.run();
    assert.equal(readFileSync(t.record, "utf8").trim(), sha(readFileSync(t.target, "utf8")));
  });
  test("--check 对没装只读：不建任何文件", async () => {
    const t = fresh();
    const c = await t.run("--check");
    assert.equal(c.code, 1);
    assert.match(c.out, /没装/);
    assert.equal(existsSync(t.target), false);
    assert.equal(existsSync(t.record), false);
  });
  test("原型读不出或有未知占位符：退出 2", async () => {
    const t = fresh("{{NOPE}}\n");
    const r = await t.run();
    assert.equal(r.code, 2);
    assert.match(r.err, /NOPE/);
  });
});

describe("worktree 拒绝", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-handbook-wt-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const attempt = async (setup: (dir: string) => void, args: string[]) => {
    const dir = mkdtempSync(path.join(root, "r-"));
    mkdirSync(path.join(dir, "extras", "handbook"), { recursive: true });
    writeFileSync(path.join(dir, "extras", "handbook", "handbook.md"), "x {{REPO}}\n");
    setup(dir);
    const home = path.join(dir, "home");
    mkdirSync(home);
    let err = "";
    let out = "";
    const code = await main(args, { home, repoRoot: dir, out: (s) => (out += s), err: (s) => (err += s) });
    return { code, err, out, home };
  };
  test(".git 是文件：拒绝，退出 2，--check 也拒绝，不写东西", async () => {
    for (const args of [[], ["--check"]]) {
      const r = await attempt((d) => writeFileSync(path.join(d, ".git"), "gitdir: /x/.git/worktrees/y\n"), args);
      assert.equal(r.code, 2);
      assert.match(r.err, /这是 git worktree（.*），装出来的路径会指向它。到主仓库里跑。/);
      assert.equal(existsSync(path.join(r.home, ".tau")), false);
    }
  });
  test(".git 是目录：照常", async () => {
    const r = await attempt((d) => mkdirSync(path.join(d, ".git")), []);
    assert.equal(r.code, 0, r.err);
  });
  test(".git 不存在：照常", async () => {
    const r = await attempt(() => {}, []);
    assert.equal(r.code, 0, r.err);
  });
});
