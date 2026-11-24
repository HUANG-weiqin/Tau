// create_preset / delete_preset（extras/tools）：参数校验单元测试，以及针对真实 tau 服务的建、删、回滚、并发和进程保护集成测试。
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ToolDef } from "../../../src/kernel/types.ts";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import type { Service } from "../../../src/server/serve.ts";
import { runToolDef } from "../../../src/tools/tooldef.ts";
import { CATALOG, definitionOf } from "../../../extras/tools/catalog.ts";
import { talk } from "../../../extras/tools/client.ts";
import { takeNotes } from "../../../extras/tools/common.ts";
import { createPreset, formatPresetMarkdown, parseCreateArgs } from "../../../extras/tools/create_preset.ts";
import { deletePreset } from "../../../extras/tools/delete_preset.ts";
import { textOfResult } from "../../plain.ts";

const LIB = join(import.meta.dirname, "..", "..", "..", "extras", "tools").replace(/\\/g, "/");

let dir = "";
let home = "";
let tauHome = "";
let work = "";
let pipe = "";
let svc: Service;
let model = "";
let savedProfile: string | undefined;

const reply: FauxResponseFactory = async (context) => {
  const last = context.messages.at(-1);
  const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : "";
  if (text.includes("hold")) return fauxAssistantMessage([fauxText("等着。"), fauxToolCall("bash", { command: "sleep 30" }, { id: "h1" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText("好了。"));
};

before(async () => {
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "tau-preset-crud-"));
  home = join(dir, "home");
  tauHome = join(home, ".tau");
  work = join(dir, "work");
  mkdirSync(join(tauHome, "presets"), { recursive: true });
  mkdirSync(join(tauHome, "tools"), { recursive: true });
  mkdirSync(work);
  savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  pipe = `\\\\.\\pipe\\tau-test-pcrud-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 100_000 }] });
  faux.setResponses(Array.from({ length: 1000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  model = `${faux.getModel().provider}/m`;
  writeFileSync(join(tauHome, "presets", "root.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash\n---\n总管。\n`);
  svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(tauHome, "presets"), toolsDir: join(tauHome, "tools"), models, memory: sqliteMemory });
});

after(async () => {
  await svc.close();
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

function defOf(name: string): ToolDef {
  const e = CATALOG.find((c) => c.name === name)!;
  return { name, ...(definitionOf(e, LIB) as Omit<ToolDef, "name">) };
}

async function req(r: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  await talk(pipe, r, (m) => {
    out.push(m);
    return m.type === "receipt" || m.type === "end" || m.type === "error" || m.type === "ps";
  });
  return out;
}

async function untilIdle(id: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const [ps] = await req({ op: "ps" });
    const row = ps.processes.find((p: any) => p.self.id === id);
    if (row && row.self.phase.tag === "idle") return;
    await sleep(50);
  }
  throw new Error(`等不到 ${id} idle`);
}

describe("parseCreateArgs 与 formatPresetMarkdown", () => {
  test("拒绝不合法的 ID、workdir、model、tools、可选字段", () => {
    const base = { id: "ok", workdir: work, model: "a/b", tools: ["read"], prompt: "你是助手" };
    assert.throws(() => parseCreateArgs({ ...base, id: ".." }), /预设 ID/);
    assert.throws(() => parseCreateArgs({ ...base, id: "foo." }), /预设 ID/);
    assert.throws(() => parseCreateArgs({ ...base, id: "a/b" }), /预设 ID/);
    assert.throws(() => parseCreateArgs({ ...base, id: "a..b" }), /预设 ID/);
    assert.throws(() => parseCreateArgs({ ...base, workdir: "/rel/path" }), /Windows 绝对路径/);
    assert.throws(() => parseCreateArgs({ ...base, workdir: join(dir, "missing") }), /不是存在的目录/);
    assert.throws(() => parseCreateArgs({ ...base, model: "no-slash" }), /model 格式/);
    assert.throws(() => parseCreateArgs({ ...base, tools: ["bad/name"] }), /tools 必须是合法工具名/);
    assert.throws(() => parseCreateArgs({ ...base, thinking: "turbo" }), /thinking/);
    assert.throws(() => parseCreateArgs({ ...base, handoff: 0 }), /handoff/);
    assert.throws(() => parseCreateArgs({ ...base, options: ["not-obj"] }), /options/);
    assert.throws(() => parseCreateArgs({ ...base, context: ["a\u0001b.md"] }), /控制字符/);
    assert.throws(() => parseCreateArgs({ ...base, context: Array.from({ length: 9 }, (_, i) => `f${i}.md`) }), /最多 8 项/);
  });

  test("去重 tools 和 context，忽略空 context 项并规范渲染 Markdown", () => {
    const f = parseCreateArgs({
      id: "v1.reviewer",
      workdir: work,
      model: "a/b",
      tools: ["read", "bash", "read"],
      prompt: "  只读审查员。\n第二行。  ",
      thinking: "high",
      handoff: 12000,
      options: { temperature: 0.2 },
      context: [" AGENTS.md ", "", "AGENTS.md", "docs/spec.md"],
    });
    assert.deepEqual(f.tools, ["read", "bash"]);
    assert.deepEqual(f.context, ["AGENTS.md", "docs/spec.md"]);
    const md = formatPresetMarkdown(f);
    assert.equal(
      md,
      `---\nworkdir: ${work}\nmodel: a/b\ntools: read, bash\nthinking: high\nhandoff: 12000\noptions: {"temperature":0.2}\ncontext: AGENTS.md, docs/spec.md\n---\n只读审查员。\n第二行。\n`,
    );
  });
});

describe("createPreset 与 deletePreset（对真实 tau 服务）", () => {
  test("创建时自动安装缺失的工具库定义（不覆盖用户改过的）、过 check、可启动", async () => {
    // 预先放一个用户改过的 list_presets.json，确认不会被覆盖。
    const custom = { description: "我的定制版", parameters: { type: "object", properties: {} }, command: `node "${LIB}/list_presets.ts"`, timeout: 12, output: "text" };
    writeFileSync(join(tauHome, "tools", "list_presets.json"), JSON.stringify(custom));

    const out = await createPreset(
      {
        id: "team.coder",
        workdir: work,
        model,
        tools: ["read", "bash", "history_dump", "list_presets"],
        prompt: "代码作者。\n负责写代码。",
        thinking: "medium",
        options: { temperature: 0.1 },
      },
      { tauHome, pipe, libDir: LIB },
    );
    assert.match(out, /已创建并校验预设 team\.coder/);
    assert.match(out, /上下文窗口 100000/);
    // 自动补装了缺失的 history_dump，同时保留了用户改过的 list_presets。
    assert.ok(existsSync(join(tauHome, "tools", "history_dump.json")));
    assert.equal(JSON.parse(readFileSync(join(tauHome, "tools", "list_presets.json"), "utf8")).timeout, 12);

    // 新建预设能真正用来 start。
    const [receipt] = await req({ op: "start", preset: "team.coder", text: "你好" });
    assert.equal(receipt.type, "receipt");
    await untilIdle(receipt.process);
  });

  test("同名或 Windows 大小写碰撞时拒绝覆盖，现有文件不动", async () => {
    await assert.rejects(
      createPreset({ id: "Team.Coder", workdir: work, model, tools: [], prompt: "x" }, { tauHome, pipe, libDir: LIB }),
      /已存在.*不覆盖/,
    );
    assert.match(readFileSync(join(tauHome, "presets", "team.coder.md"), "utf8"), /代码作者/);
  });

  test("kernel check 不通过时自动撤回文件，不留坏预设", async () => {
    const file = join(tauHome, "presets", "bad-model.md");
    await assert.rejects(
      createPreset({ id: "bad-model", workdir: work, model: "unknown/nope", tools: ["read"], prompt: "x" }, { tauHome, pipe, libDir: LIB }),
      /已撤回 bad-model\.md/,
    );
    assert.equal(existsSync(file), false);

    const badOptFile = join(tauHome, "presets", "bad-opt.md");
    await assert.rejects(
      createPreset({ id: "bad-opt", workdir: work, model, tools: [], prompt: "x", options: { apiKey: "secret" } }, { tauHome, pipe, libDir: LIB }),
      /已撤回 bad-opt\.md.*凭据/,
    );
    assert.equal(existsSync(badOptFile), false);
  });

  test("deletePreset：正在运行的进程占用时拒绝；停止变成 idle 后可删且区分大小写", async () => {
    await createPreset({ id: "temp.worker", workdir: work, model, tools: ["bash"], prompt: "临时工。" }, { tauHome, pipe, libDir: LIB });
    const [r] = await req({ op: "start", preset: "temp.worker", text: "hold" });
    const pid = r.process as string;
    // 等它进入 awaitingTool（hold 运行 sleep 30）。
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [ps] = await req({ op: "ps" });
      if (ps.processes.find((p: any) => p.self.id === pid)?.self.phase.tag === "awaitingTool") break;
      await sleep(50);
    }

    await assert.rejects(deletePreset({ id: "temp.worker" }, { tauHome, pipe }), new RegExp(`正在运行的进程.*${pid}`));
    assert.ok(existsSync(join(tauHome, "presets", "temp.worker.md")));

    await req({ op: "stop", process: pid });
    await untilIdle(pid);

    // 大小写不一致不许误删。
    await assert.rejects(deletePreset({ id: "Temp.Worker" }, { tauHome, pipe }), /区分大小写/);
    assert.ok(existsSync(join(tauHome, "presets", "temp.worker.md")));

    const delOut = await deletePreset({ id: "temp.worker" }, { tauHome, pipe });
    assert.match(delOut, /已删除预设 temp\.worker.*记忆库保留不动/);
    assert.match(delOut, new RegExp(`已结束的历史进程（${pid}）仍保留`));
    assert.equal(existsSync(join(tauHome, "presets", "temp.worker.md")), false);
  });

  test("作为工具定义经 runToolDef 端到端运行 create_preset -> list_presets -> delete_preset", async () => {
    const cr = await runToolDef(
      defOf("create_preset"),
      { id: "e2e-role", workdir: work, model, tools: ["read"], prompt: "端到端角色。\n细节。" },
      work,
      new AbortController().signal,
      { process: "p1", pipe },
      true,
    );
    assert.equal(cr.isError, false, textOfResult(cr));
    assert.match(textOfResult(cr), /已创建并校验预设 e2e-role/);

    const ls = await runToolDef(defOf("list_presets"), {}, work, new AbortController().signal, { process: "p1", pipe }, true);
    assert.equal(ls.isError, false, textOfResult(ls));
    assert.match(textOfResult(ls), /- e2e-role：端到端角色。/);

    const dl = await runToolDef(defOf("delete_preset"), { id: "e2e-role" }, work, new AbortController().signal, { process: "p1", pipe }, true);
    assert.equal(dl.isError, false, textOfResult(dl));
    assert.match(textOfResult(dl), /已删除预设 e2e-role/);
    assert.equal(existsSync(join(tauHome, "presets", "e2e-role.md")), false);
  });
});

// ---------- 弱模型兜底：参数规整、同参重发、换 id 的文字 ----------

afterEach(() => void takeNotes());
const fwd = (p: string): string => p.replace(/\\/g, "/");

describe("parseCreateArgs 的规整（每处都有“注：”）", () => {
  const env = () => ({ home: work, cwd: work, toolsDir: join(tauHome, "tools"), presetsDir: join(tauHome, "presets") });
  const base = () => ({ id: "ok", workdir: work, model: "a/b", tools: ["read"], prompt: "你是助手" });

  test("tools：逗号串拆开，大小写改回，self 和 handoff 去掉，多写的 memory_get 去掉", () => {
    assert.deepEqual(parseCreateArgs({ ...base(), tools: ["read, bash"] }, env()).tools, ["read", "bash"]);
    assert.equal(takeNotes(), "注：tools 当作 read、bash。");
    assert.deepEqual(parseCreateArgs({ ...base(), tools: ["Read", "self"] }, env()).tools, ["read"]);
    assert.match(takeNotes(), /tools 当作 read、self；去掉了 tools 里的 self（每个进程都有）/);
    assert.deepEqual(parseCreateArgs({ ...base(), tools: ["memory", "memory_get"] }, env()).tools, ["memory"]);
    assert.match(takeNotes(), /tools 里已经有 memory，去掉了多写的 memory_get/);
  });

  test("tools：memory_get 单独给就拒绝，给照抄的 tools", () => {
    assert.throws(
      () => parseCreateArgs({ ...base(), tools: ["bash", "memory_get"] }, env()),
      (e: Error) => /工具按组给/.test(e.message) && e.message.includes('tools ["bash","memory"]') && /其余参数不变/.test(e.message),
    );
    assert.throws(() => parseCreateArgs({ ...base(), tools: ["post"] }, env()), /agents/);
  });

  test("id：去掉 .md，取预设目录下完整路径的文件名；别的目录的路径照旧拒绝", () => {
    assert.equal(parseCreateArgs({ ...base(), id: "x.md" }, env()).id, "x");
    assert.equal(takeNotes(), "注：id x.md 当作 x。");
    assert.equal(parseCreateArgs({ ...base(), id: fwd(join(tauHome, "presets", "Y.MD")) }, env()).id, "Y");
    takeNotes();
    assert.throws(() => parseCreateArgs({ ...base(), id: "team/coder" }, env()), /预设 ID.*收到“team\/coder”/);
  });

  test("workdir：/d/x 写法、~、相对路径；context 拆开并换写法", () => {
    const drive = work[0]!;
    const posix = `/${drive.toLowerCase()}${fwd(work).slice(2)}`;
    const want = `${drive.toUpperCase()}${fwd(work).slice(1)}`;
    assert.equal(parseCreateArgs({ ...base(), workdir: posix }, env()).workdir, want);
    assert.equal(takeNotes(), `注：workdir ${posix} 当作 ${want}。`);
    assert.equal(parseCreateArgs({ ...base(), workdir: "~" }, env()).workdir, fwd(work));
    takeNotes();
    assert.equal(parseCreateArgs({ ...base(), workdir: "." }, env()).workdir, fwd(work));
    assert.match(takeNotes(), /workdir \. 当作/);
    const f = parseCreateArgs({ ...base(), context: ["AGENTS.md, docs/spec.md", `${posix}/AGENTS.md`] }, env());
    assert.deepEqual(f.context, ["AGENTS.md", "docs/spec.md", `${want}/AGENTS.md`]);
    assert.match(takeNotes(), /context/);
  });

  test("context 只按半角逗号拆：、，；; 在 Windows 文件名里合法，不拆（E1）", () => {
    const items = ["docs/读书、写作.md", "E:/notes/a;b.md", "规范，第二版.md", "甲；乙.md", "x.md, y.md"];
    assert.deepEqual(parseCreateArgs({ ...base(), context: items }, env()).context, ["docs/读书、写作.md", "E:/notes/a;b.md", "规范，第二版.md", "甲；乙.md", "x.md", "y.md"]);
    takeNotes();
    const five = Array.from({ length: 5 }, (_, i) => `d/读、${i}.md`);
    assert.deepEqual(parseCreateArgs({ ...base(), context: five }, env()).context, five);
  });

  test("拒绝的文字给能照抄的下一步", () => {
    assert.throws(() => parseCreateArgs({ ...base(), workdir: "/tmp/x" }, env()), /Windows 绝对路径，例如 E:\/tau，收到 \/tmp\/x/);
    const missing = join(work, "tua");
    assert.throws(
      () => parseCreateArgs({ ...base(), workdir: missing }, env()),
      (e: Error) => e.message.includes("workdir 不是存在的目录") && e.message.includes(`${fwd(work)} 里`) && e.message.includes("先用 bash 建好再调") && !/mkdir/.test(e.message),
    );
    assert.throws(() => parseCreateArgs({ ...base(), model: "no-slash" }, env()), /model 格式应为 <provider>\/<model-id>，收到 no-slash/);
    assert.throws(() => parseCreateArgs({ ...base(), id: "a..b" }, env()), /不能有连续的点/);
    assert.throws(() => parseCreateArgs({ ...base(), context: Array.from({ length: 9 }, (_, i) => `f${i}.md`) }, env()), /context 最多 8 项，收到 9 项/);
  });
});

describe("createPreset / deletePreset 的兜底（对真实 tau 服务）", () => {
  const opts = () => ({ tauHome, pipe, libDir: LIB, cwd: work });

  test("同参重发：第二次不写文件，说已经在了、已校验；内容不同的撞名换 id、不提 delete_preset", async () => {
    const args = { id: "again", workdir: work, model, tools: ["read"], prompt: "重发。" };
    await createPreset(args, opts());
    const file = join(tauHome, "presets", "again.md");
    const before = statSync(file).mtimeMs;
    await sleep(30);
    const out = await createPreset(args, opts());
    assert.match(out, /预设 again 已经在了，内容和这次要写的一样，已校验，没有改动/);
    assert.equal(statSync(file).mtimeMs, before);
    await assert.rejects(
      createPreset({ ...args, prompt: "不一样。" }, opts()),
      (e: Error) => /已存在.*不覆盖/.test(e.message) && e.message.includes("换一个 id") && e.message.includes("again-2") && !e.message.includes("delete_preset") && e.message.includes("先问用户"),
    );
    assert.match(readFileSync(file, "utf8"), /重发。/);
  });

  test("同参重发但校验不过：拒绝，写明是之前留下的，不删文件", async () => {
    const file = join(tauHome, "presets", "stale.md");
    const f = { id: "stale", workdir: work, model: "unknown/nope", tools: ["read"], prompt: "x" };
    writeFileSync(file, formatPresetMarkdown(parseCreateArgs(f)));
    await assert.rejects(createPreset(f, opts()), (e: Error) => /校验不过/.test(e.message) && /之前一次没校验完留下的/.test(e.message) && e.message.includes('delete_preset {"id":"stale"}'));
    assert.ok(existsSync(file));
  });

  test("带了不认识的参数 dry_run：拒绝，文件没建", async () => {
    await assert.rejects(createPreset({ id: "dry", workdir: work, model, tools: [], prompt: "x", dry_run: true }, opts()), /create_preset 没有参数 dry_run.*去掉 dry_run 再调，就是照剩下的参数真的建预设/);
    assert.equal(existsSync(join(tauHome, "presets", "dry.md")), false);
  });

  test("delete_preset 带 dry_run：拒绝，写明没有预演、去掉就真删，给只看不删的路；文件还在（E2）", async () => {
    const file = join(tauHome, "presets", "reviewer.md");
    writeFileSync(file, "---\nworkdir: x\nmodel: a/b\ntools: read\n---\nx\n");
    await assert.rejects(deletePreset({ id: "reviewer", dry_run: true }, { tauHome, pipe }), (e: Error) => /delete_preset 没有预演/.test(e.message) && /去掉 dry_run 就会真删 reviewer，找不回/.test(e.message) && e.message.includes("list_presets {}") && !/其余参数不变/.test(e.message));
    assert.ok(existsSync(file));
  });

  test("校验失败：找不到工具定义时列出能用的工具", async () => {
    await assert.rejects(
      createPreset({ id: "needs-grep", workdir: work, model, tools: ["grep"], prompt: "x" }, opts()),
      (e: Error) => e.message.includes("找不到工具定义：grep") && e.message.includes("能用的工具：内置 read、write、edit、bash、memory、agents") && e.message.includes("搜索和列目录用 bash（rg、ls）"),
    );
    assert.equal(existsSync(join(tauHome, "presets", "needs-grep.md")), false);
  });

  test("deletePreset：id 写成 x.md 当作 x；notes.md.md 和 notes.md 都在时删的是 notes.md.md", async () => {
    writeFileSync(join(tauHome, "presets", "temp.worker2.md"), "---\nworkdir: x\n---\n");
    const out = await deletePreset({ id: "temp.worker2.md" }, { tauHome, pipe });
    assert.match(out, /已删除预设 temp\.worker2/);
    assert.equal(takeNotes(), "注：id temp.worker2.md 当作 temp.worker2。");
    writeFileSync(join(tauHome, "presets", "notes.md.md"), "a");
    writeFileSync(join(tauHome, "presets", "notes.md"), "b");
    await deletePreset({ id: "notes.md" }, { tauHome, pipe });
    assert.equal(existsSync(join(tauHome, "presets", "notes.md.md")), false);
    assert.equal(existsSync(join(tauHome, "presets", "notes.md")), true);
    rmSync(join(tauHome, "presets", "notes.md"));
    takeNotes();
  });

  test("deletePreset：不存在算成功，列现有的；大小写不对给照抄的精确 ID", async () => {
    const out = await deletePreset({ id: "gone" }, { tauHome, pipe });
    assert.match(out, /没有预设 gone，什么都没删。现有的预设：/);
    assert.ok(out.includes("root"), out);
    writeFileSync(join(tauHome, "presets", "reviewer.md"), "x");
    await assert.rejects(deletePreset({ id: "Reviewer" }, { tauHome, pipe }), (e: Error) => /区分大小写/.test(e.message) && e.message.includes('delete_preset {"id":"reviewer"}'));
    rmSync(join(tauHome, "presets", "reviewer.md"));
  });

  test("deletePreset：运行中的文字不给 stop_process；调用者自己在跑时写明是你自己", async () => {
    await createPreset({ id: "busy", workdir: work, model, tools: ["bash"], prompt: "忙。" }, opts());
    const [r] = await req({ op: "start", preset: "busy", text: "hold" });
    const pid = r.process as string;
    for (const t = Date.now(); Date.now() - t < 10_000; await sleep(50)) {
      const [ps] = await req({ op: "ps" });
      if (ps.processes.find((p: any) => p.self.id === pid)?.self.phase.tag === "awaitingTool") break;
    }
    await assert.rejects(deletePreset({ id: "busy" }, { tauHome, pipe }), (e: Error) => e.message.includes(pid) && !e.message.includes("stop_process") && e.message.includes("等它们结束再删"));
    await assert.rejects(deletePreset({ id: "busy" }, { tauHome, pipe, proc: pid }), /你自己.*不能删自己正在用的预设/);
    await req({ op: "stop", process: pid });
    await untilIdle(pid);
  });
});
