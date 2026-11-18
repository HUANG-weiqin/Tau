// 上下文文件视图（D72）：每一段的格式、额度和截断、读不到、空文件、额度用完；绝不抛错；建进程时读进 segment。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { systemPrompt } from "../../src/kernel/context.ts";
import { utf8Bytes } from "../../src/kernel/derive.ts";
import { CONTEXT_VIEW_MAX_BYTES } from "../../src/kernel/tools.ts";
import type { PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { readContextView } from "../../src/store/context-files.ts";
import { loadProcess, loadProcesses, putMail, tx } from "../../src/store/db.ts";
import { forkProcess, handleNext, startProcess } from "../../src/store/inputs.ts";
import { runInStore } from "../../src/store/instore.ts";
import { fakeMemory, mailbox, PRESET, rng, say, tempDb, tempDir, toolCall } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";
import { plain } from "../plain.ts";

const MAX = CONTEXT_VIEW_MAX_BYTES;
const NO_QUOTA = "（没有额度了，没读）";
const bytes = (s: string) => Buffer.byteLength(s);

/** 一个临时工作目录，和往里写文件的函数。 */
function workdir(t: TestContext): { dir: string; put: (name: string, content: string | Buffer) => void } {
  const dir = tempDir(t);
  return {
    dir,
    put(name, content) {
      writeFileSync(join(dir, name), content);
    },
  };
}

const view = (dir: string, ...context: string[]) => readContextView({ workdir: dir, context });

test("没有 context 或者是空数组：空串，工作目录不存在也不要紧", () => {
  assert.equal(readContextView({ workdir: "E:\\不存在的目录" }), "");
  assert.equal(readContextView({ workdir: "E:\\不存在的目录", context: [] }), "");
});

test("一个文件：标题行是声明的原文，换行，内容原样（含结尾的换行）", (t) => {
  const { dir, put } = workdir(t);
  put("AGENTS.md", "# 规矩\n先读测试。\n");
  assert.equal(view(dir, "AGENTS.md"), "### AGENTS.md\n# 规矩\n先读测试。\n");
});

test("多个文件：按声明的顺序，段之间空一行", (t) => {
  const { dir, put } = workdir(t);
  put("a.md", "甲");
  put("b.md", "乙");
  put("c.md", "丙");
  assert.equal(view(dir, "c.md", "a.md", "b.md"), "### c.md\n丙\n\n### a.md\n甲\n\n### b.md\n乙");
});

test("相对路径按 workdir 解析，标题仍是声明的原文；子目录两种斜杠都行", (t) => {
  const { dir, put } = workdir(t);
  mkdirSync(join(dir, "docs"));
  put("docs\\x.md", "里面");
  assert.equal(view(dir, "docs\\x.md"), "### docs\\x.md\n里面");
  assert.equal(view(dir, "docs/x.md"), "### docs/x.md\n里面");
  assert.equal(view(dir, ".\\docs\\..\\docs\\x.md"), "### .\\docs\\..\\docs\\x.md\n里面");
});

test("绝对路径原样，不看 workdir；标题是声明的原文", (t) => {
  const { dir, put } = workdir(t);
  put("abs.md", "绝对的");
  const other = tempDir(t);
  assert.equal(view(other, join(dir, "abs.md")), `### ${join(dir, "abs.md")}\n绝对的`);
  assert.equal(view("E:\\不存在", join(dir, "abs.md")), `### ${join(dir, "abs.md")}\n绝对的`);
});

test("读不到：不存在、是目录、路径里有空字符，都是一行说明，不抛错；后面的文件照常", (t) => {
  const { dir, put } = workdir(t);
  mkdirSync(join(dir, "sub"));
  put("ok.md", "好");
  const v = view(dir, "nope.md", "sub", "a\0b", "ok.md");
  const sections = v.split("\n\n");
  assert.equal(sections.length, 4);
  assert.match(sections[0]!, /^### nope\.md\n（读不到：.*ENOENT.*）$/);
  assert.equal(sections[1], "### sub\n（读不到：不是普通文件）");
  assert.match(sections[2]!, /^### a\0b\n（读不到：.+）$/);
  assert.equal(sections[3], "### ok.md\n好");
  for (const s of sections.slice(0, 3)) assert.equal(s.split("\n").length, 2, "标题一行，说明一行");
});

test("读不到的原因太长就截：整个说明不过 REASON 的上限，仍是一行", (t) => {
  const { dir } = workdir(t);
  const name = "字".repeat(250) + ".md";
  const v = view(dir, name);
  const [head, note] = v.split("\n");
  assert.equal(head, `### ${name}`);
  assert.match(note!, /^（读不到：.+）$/);
  assert.ok(bytes(note!) <= 200 + bytes("（读不到：）"));
  assert.equal(v.split("\n").length, 2);
});

test("空文件和只有 BOM 的文件：（空文件）", (t) => {
  const { dir, put } = workdir(t);
  put("e.md", "");
  put("bom.md", Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(view(dir, "e.md", "bom.md"), "### e.md\n（空文件）\n\n### bom.md\n（空文件）");
});

test("文件刚好放得下就不截；多 1 字节就截，说明里写文件的字节数", (t) => {
  const { dir, put } = workdir(t);
  const head = "### f.md\n";
  const room = MAX - bytes(head);
  put("f.md", "a".repeat(room));
  const full = view(dir, "f.md");
  assert.equal(bytes(full), MAX);
  assert.equal(full, head + "a".repeat(room));
  put("f.md", "a".repeat(room + 1));
  const cut = view(dir, "f.md");
  const mark = `…（已截，文件共 ${room + 1} 字节）`;
  assert.equal(bytes(cut), MAX, "说明也占额度，内容再少放几个字节");
  assert.ok(cut.endsWith(mark));
  assert.equal(cut, head + "a".repeat(room - bytes(mark)) + mark);
});

test("大文件：截到额度，总字节数不超过上界，截的是开头", (t) => {
  const { dir, put } = workdir(t);
  const text = Array.from({ length: 20_000 }, (_, i) => `第 ${i} 行\n`).join("");
  put("big.md", text);
  const v = view(dir, "big.md");
  assert.ok(bytes(v) <= MAX);
  assert.ok(v.startsWith("### big.md\n第 0 行\n第 1 行\n"));
  assert.ok(v.endsWith(`…（已截，文件共 ${bytes(text)} 字节）`));
});

test("中文多字节不劈开：不管截在哪个字节对齐，都没有替换符，总字节数不超过上界", (t) => {
  const { dir, put } = workdir(t);
  put("zh.md", "字".repeat(30_000));
  put("mix.md", "a😀字é".repeat(10_000));
  for (const file of ["zh.md", "mix.md"]) {
    for (let n = 1; n <= 8; n++) {
      const name = file.replace(".md", "x".repeat(n) + ".md");
      put(name, file === "zh.md" ? "字".repeat(30_000) : "a😀字é".repeat(10_000));
      const v = view(dir, name);
      assert.ok(bytes(v) <= MAX, `${name} 总字节 ${bytes(v)}`);
      assert.ok(bytes(v) > MAX - 4, `${name} 最多少放一个字符，不是少放一大截：${bytes(v)}`);
      assert.ok(!v.includes("\uFFFD"), `${name} 有替换符`);
      assert.ok(v.isWellFormed());
    }
  }
});

test("不合法的 UTF-8 变成替换符，前后的字符不受影响", (t) => {
  const { dir, put } = workdir(t);
  put("bad.md", Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  assert.equal(view(dir, "bad.md"), "### bad.md\na\uFFFD\uFFFDb");
  put("trunc.md", Buffer.from([0xe5, 0xad])); // 半个字
  assert.equal(view(dir, "trunc.md"), "### trunc.md\n\uFFFD");
});

test("满额度的不合法字节：每个字节变成 3 字节的替换符，也不超过上界，说明里是文件的字节数", (t) => {
  const { dir, put } = workdir(t);
  put("bin.md", Buffer.alloc(20_000, 0xff));
  const v = view(dir, "bin.md");
  assert.ok(bytes(v) <= MAX);
  assert.ok(v.endsWith("…（已截，文件共 20000 字节）"));
  put("small-bin.md", Buffer.alloc(MAX - 100, 0xff));
  const w = view(dir, "small-bin.md");
  assert.ok(bytes(w) <= MAX);
  assert.ok(w.endsWith(`…（已截，文件共 ${MAX - 100} 字节）`), "原始字节放得下，解码以后放不下，也算截");
});

test("额度用完：后面每个文件留一行“没读”，哪怕它们存在；总字节数正好是上界", (t) => {
  const { dir, put } = workdir(t);
  put("a.md", "a".repeat(50_000));
  put("b.md", "BBB");
  put("c.md", "CCC");
  const v = view(dir, "a.md", "b.md", "c.md");
  assert.ok(v.endsWith(`\n\n### b.md\n${NO_QUOTA}\n\n### c.md\n${NO_QUOTA}`));
  assert.ok(!v.includes("BBB") && !v.includes("CCC"), "被截的文件之后的文件不读");
  assert.match(v, /…（已截，文件共 50000 字节）\n\n### b\.md/);
  assert.equal(bytes(v), MAX);
});

test("给后面的文件留位置：前面的文件正好放得下时，后面的文件仍有自己的位置", (t) => {
  const { dir, put } = workdir(t);
  put("a.md", "A".repeat(100));
  put("b.md", "B".repeat(100));
  assert.equal(view(dir, "a.md", "b.md"), `### a.md\n${"A".repeat(100)}\n\n### b.md\n${"B".repeat(100)}`);
  // 前面的文件占满整个额度：它被截掉一点，给后面的文件留一行“没读”。
  const headA = "### a.md\n";
  const tail = `\n\n### b.md\n${NO_QUOTA}`;
  put("a.md", "A".repeat(MAX - bytes(headA)));
  const v = view(dir, "a.md", "b.md");
  assert.ok(v.endsWith(tail));
  assert.equal(bytes(v), MAX);
  assert.ok(v.includes("…（已截，文件共"));
});

test("名字长到放不下：放不下的段不放，不超额，不抛错", (t) => {
  const { dir } = workdir(t);
  const names = Array.from({ length: 8 }, (_, i) => "名".repeat(5_000) + i);
  const v = view(dir, ...names);
  assert.ok(bytes(v) <= MAX);
  assert.ok(v.isWellFormed());
  assert.equal(v.split("### ").length - 1, 1, "第一个的标题加一行说明放得下，其余的放不下");
  assert.ok(v.endsWith(NO_QUOTA));
});

test("文件被截的位置够放“没读”那一行时，后一个文件正好是那一行", (t) => {
  const { dir, put } = workdir(t);
  const headA = "### a.md\n";
  put("b.md", "B".repeat(5_000));
  // a 之后剩 45 字节：b 的标题行 11 字节，内容额度 34 字节，放不下被截的说明（39 字节），所以写“没读”（共 41 字节）。
  put("a.md", "A".repeat(MAX - bytes(headA) - 45));
  const v = view(dir, "a.md", "b.md");
  assert.equal(v, headA + "A".repeat(MAX - bytes(headA) - 45) + `\n\n### b.md\n${NO_QUOTA}`);
  assert.ok(bytes(v) <= MAX);
  // 剩 50 字节：内容额度刚好放得下被截的说明，没有内容。
  put("a.md", "A".repeat(MAX - bytes(headA) - 50));
  assert.equal(view(dir, "a.md", "b.md"), headA + "A".repeat(MAX - bytes(headA) - 50) + "\n\n### b.md\n…（已截，文件共 5000 字节）");
});

test("八个长名字、长中文内容的文件：总字节数不超过上界，没有替换符，没有半个字符", (t) => {
  const { dir, put } = workdir(t);
  const names = Array.from({ length: 8 }, (_, i) => "名".repeat(120) + i + ".md");
  for (const n of names) put(n, "字".repeat(20_000));
  const v = view(dir, ...names);
  assert.ok(bytes(v) <= MAX, `总字节 ${bytes(v)}`);
  assert.ok(v.startsWith(`### ${names[0]}\n`));
  assert.ok(!v.includes("\uFFFD") && v.isWellFormed());
  assert.equal(v.split(NO_QUOTA).length - 1, 7, "第一个被截，后面七个各一行");
});

test("随机的文件组合：从不抛错，总字节数不超过上界，是合法的字符串，每一段都以标题行开头", (t) => {
  const { dir, put } = workdir(t);
  const rand = rng(20261118);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const kinds: ((n: number) => string | Buffer | null)[] = [
    (n) => "a".repeat(n),
    (n) => "字".repeat(n),
    (n) => "😀é".repeat(n),
    (n) => Buffer.alloc(n, 0xff),
    (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))),
    () => "",
    () => null,
  ];
  for (let round = 0; round < 60; round++) {
    const count = 1 + Math.floor(rand() * 8);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `f${round}-${i}-${"名".repeat(Math.floor(rand() * 90))}.md`;
      const content = pick(kinds)(Math.floor(rand() ** 3 * 40_000));
      if (content !== null) put(name, content);
      names.push(name);
    }
    const v = view(dir, ...names);
    assert.ok(bytes(v) <= MAX, `第 ${round} 轮：总字节 ${bytes(v)}`);
    assert.ok(v.isWellFormed());
    assert.ok(v === "" || v.startsWith("### "));
    for (const section of v.split("\n\n### ").map((s, i) => (i === 0 ? s : "### " + s))) assert.ok(section.startsWith("### "), section.slice(0, 40));
  }
});

// 建进程时读：startProcess、forkProcess、spawn。

const withContext = (dir: string, context: string[], over: Partial<PresetSnapshot> = {}): PresetSnapshot => ({ ...PRESET, workdir: dir, context, ...over });
const rawState = (db: DatabaseSync, id: string): string => (db.prepare("SELECT state_json FROM processes WHERE id = ?").get(id) as { state_json: string }).state_json;

test("startProcess：快照声明了 context，建进程的事务里读进 segment.contextView，系统提示词带上", (t) => {
  const db = tempDb(t);
  const { dir, put } = workdir(t);
  put("AGENTS.md", "先读测试。");
  const preset = withContext(dir, ["AGENTS.md"]);
  startProcess(db, fakeMemory(), "a", preset, "你好", 0);
  const p = loadProcess(db, "a")!;
  assert.equal(p.segment.contextView, "### AGENTS.md\n先读测试。");
  assert.deepEqual(p.segment, { seq: 1, memoryView: "", contextView: "### AGENTS.md\n先读测试。" });
  assert.ok(systemPrompt(p).includes("## 上下文文件（开段时的快照）\n\n### AGENTS.md\n先读测试。"));
  // 视图是出生那一刻的：文件之后改了，记录不变。
  put("AGENTS.md", "改了。");
  assert.equal(loadProcess(db, "a")!.segment.contextView, "### AGENTS.md\n先读测试。");
  assertStoreInvariants(db);
});

test("startProcess：没声明 context（或是空数组）时 segment 没有 contextView 这个键", (t) => {
  const db = tempDb(t);
  startProcess(db, fakeMemory(), "a", PRESET, "你好", 0);
  startProcess(db, fakeMemory(), "b", { ...PRESET, id: "empty", context: [] }, "你好", 0);
  for (const id of ["a", "b"]) {
    assert.equal(rawState(db, id).includes("contextView"), false, id);
    assert.deepEqual(loadProcess(db, id)!.segment, { seq: 1, memoryView: "" });
  }
});

test("startProcess：文件读不到也能建进程，视图里是一行说明", (t) => {
  const db = tempDb(t);
  const { dir } = workdir(t);
  startProcess(db, fakeMemory(), "a", withContext(dir, ["还没有.md"]), "你好", 0);
  assert.match(loadProcess(db, "a")!.segment.contextView ?? "", /^### 还没有\.md\n（读不到：.+）$/);
  assert.equal(mailbox(db).length, 1);
});

test("startProcess：启动检查带上下文的上界，窗口装不下就抛错，什么都不建", (t) => {
  const db = tempDb(t);
  const { dir, put } = workdir(t);
  put("AGENTS.md", "x");
  const small = withContext(dir, ["AGENTS.md"], { contextWindow: 40_000, tools: ["read"] });
  assert.throws(() => startProcess(db, fakeMemory(), "a", small, "你好", 0), /窗口太小.*上下文的上界 \d+ token/);
  assert.equal(loadProcesses(db).length, 0);
  assert.equal(mailbox(db).length, 0);
  const { context: _, ...bare } = small;
  startProcess(db, fakeMemory(), "b", bare, "你好", 0);
  assert.equal(loadProcesses(db).length, 1, "没有 context 的同一个窗口通得过");
});

/** 一轮之后回到 idle 的进程 a：段里是一问一答。 */
function idleSource(db: DatabaseSync, preset: PresetSnapshot): void {
  const memory = fakeMemory();
  startProcess(db, memory, "a", preset, "问", 0);
  while (handleNext(db, memory, 1)) continue;
  putMail(db, "a", { kind: "modelResult", n: 1, outcome: { status: "ok", message: say("答") } });
  while (handleNext(db, memory, 2)) continue;
  assert.equal(loadProcess(db, "a")!.phase.tag, "idle");
}

test("forkProcess 不带 preset：复制源进程的视图，不重读文件，源的文件已经改了或删了也一样", (t) => {
  const db = tempDb(t);
  const { dir, put } = workdir(t);
  put("AGENTS.md", "原来的");
  idleSource(db, withContext(dir, ["AGENTS.md"]));
  put("AGENTS.md", "改过的");
  const h = forkProcess(db, fakeMemory(), "b", "a", undefined, 500);
  assert.equal(h.process.segment.contextView, "### AGENTS.md\n原来的");
  assert.equal(loadProcess(db, "b")!.segment.contextView, "### AGENTS.md\n原来的");
  assert.deepEqual(loadProcess(db, "b")!.preset.context, ["AGENTS.md"]);
  const none = forkProcess(db, fakeMemory(), "c", "a", 0, 500);
  assert.equal(none.process.segment.contextView, "### AGENTS.md\n原来的", "带 before 也复制");
  assertStoreInvariants(db);
});

test("forkProcess 不带 preset：源进程没有视图，新进程也没有这个键", (t) => {
  const db = tempDb(t);
  idleSource(db, PRESET);
  forkProcess(db, fakeMemory(), "b", "a", undefined, 500);
  assert.equal(rawState(db, "b").includes("contextView"), false);
});

test("forkProcess 带 preset：按新快照重读，不用源进程的视图；新快照没有 context 就没有这个键", (t) => {
  const db = tempDb(t);
  const { dir, put } = workdir(t);
  put("AGENTS.md", "原来的");
  put("NOTES.md", "新的笔记");
  idleSource(db, withContext(dir, ["AGENTS.md"]));
  const memory = fakeMemory();
  const h = forkProcess(db, memory, "b", "a", undefined, 500, withContext(dir, ["NOTES.md"], { id: "other" }));
  assert.equal(h.process.segment.contextView, "### NOTES.md\n新的笔记");
  assert.equal(loadProcess(db, "b")!.segment.contextView, "### NOTES.md\n新的笔记");
  assert.equal(loadProcess(db, "a")!.segment.contextView, "### AGENTS.md\n原来的", "源进程不变");
  forkProcess(db, memory, "c", "a", undefined, 500, { ...PRESET, id: "plain" });
  assert.equal(rawState(db, "c").includes("contextView"), false, "新快照没有 context，源的视图不带过去");
  // 新文件读到的是现在的内容，不是源进程出生时的。
  put("AGENTS.md", "现在的");
  forkProcess(db, memory, "d", "a", undefined, 500, withContext(dir, ["AGENTS.md"], { id: "again" }));
  assert.equal(loadProcess(db, "d")!.segment.contextView, "### AGENTS.md\n现在的");
  assertStoreInvariants(db);
});

test("forkProcess 带 preset：上下文视图的大小算进放不放得下的估算和启动检查，抛错回滚", (t) => {
  const db = tempDb(t);
  const { dir, put } = workdir(t);
  put("big.md", "字".repeat(20_000));
  idleSource(db, PRESET);
  const before = db.prepare("SELECT COUNT(*) AS n FROM processes").get() as { n: number };
  const small = withContext(dir, ["big.md"], { id: "small", contextWindow: 40_000, tools: ["read"] });
  assert.throws(() => forkProcess(db, fakeMemory(), "b", "a", undefined, 500, small), /窗口太小|放不进/);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM processes").get(), before);
});

test("spawn：子进程按它自己的快照读上下文文件，没有 context 就没有这个键；读不到也能建", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { dir, put } = workdir(t);
  put("AGENTS.md", "子进程的规矩");
  startProcess(db, memory, "a", { ...PRESET, id: "boss", tools: ["agents"] }, "开始", 0);
  db.exec("DELETE FROM mailbox");
  const p: Process = { ...loadProcess(db, "a")!, lastEffect: 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } };
  const readPreset = (id: string): PresetSnapshot => (id === "plain" ? { ...PRESET, id } : id === "missing" ? withContext(dir, ["没有.md"], { id }) : withContext(dir, ["AGENTS.md"], { id }));
  const spawn = (preset: string) => {
    const known = new Set(loadProcesses(db).map((x) => x.id));
    const r = plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", { preset, text: "做" }), 0, readPreset)));
    assert.equal(r.isError, false, r.text);
    return loadProcesses(db).find((x) => !known.has(x.id))!;
  };
  const withFile = spawn("rules");
  assert.equal(withFile.segment.contextView, "### AGENTS.md\n子进程的规矩");
  assert.equal(loadProcess(db, withFile.id)!.segment.contextView, "### AGENTS.md\n子进程的规矩");
  const miss = spawn("missing");
  assert.match(miss.segment.contextView ?? "", /^### 没有\.md\n（读不到：/);
  // 同一个父进程同一次调用再 spawn 会换一个 ID（尝试次数加一）。
  const bare = spawn("plain");
  assert.equal(rawState(db, bare.id).includes("contextView"), false);
});
