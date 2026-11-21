// create_preset / delete_preset（extras/tools）：参数校验单元测试，以及针对真实 tau 服务的建、删、回滚、并发和进程保护集成测试。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.throws(() => parseCreateArgs({ ...base, workdir: "/rel/path" }), /Windows 绝对路径/);
    assert.throws(() => parseCreateArgs({ ...base, workdir: join(dir, "missing") }), /不是存在的目录/);
    assert.throws(() => parseCreateArgs({ ...base, model: "no-slash" }), /model 格式/);
    assert.throws(() => parseCreateArgs({ ...base, tools: ["bad name"] }), /tools 必须是合法工具名/);
    assert.throws(() => parseCreateArgs({ ...base, thinking: "turbo" }), /thinking/);
    assert.throws(() => parseCreateArgs({ ...base, handoff: 0 }), /handoff/);
    assert.throws(() => parseCreateArgs({ ...base, options: ["not-obj"] }), /options/);
    assert.throws(() => parseCreateArgs({ ...base, context: ["a,b.md"] }), /逗号/);
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
