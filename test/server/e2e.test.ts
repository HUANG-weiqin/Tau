// 第 3 步验收：用 faux 假模型跑通“读一个文件、改一行、跑一次命令”，走真的管道、库和 CLI 协议。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { main, request } from "../../src/cli/main.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import type { Reply } from "../../src/protocol.ts";
import { serve } from "../../src/server/serve.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tau-e2e-"));
  const work = join(dir, "work");
  const presets = join(dir, "presets");
  mkdirSync(work);
  mkdirSync(presets);
  const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { dir, work, presets, faux, models, pipe: `\\\\.\\pipe\\tau-test-${process.pid}-${Math.random().toString(16).slice(2)}` };
}

async function collect(pipe: string, req: Parameters<typeof request>[1]): Promise<Reply[]> {
  const out: Reply[] = [];
  await request(pipe, req, (r) => out.push(r));
  return out;
}

test("faux 模型：读文件、改一行、跑命令，最终回复来自库", async () => {
  const t = setup();
  writeFileSync(join(t.work, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(t.presets, "dev.md"), `---\nworkdir: ${t.work}\nmodel: ${t.faux.getModel().provider}/m\ntools: read, edit, bash\n---\n你是测试助手。\n`);
  t.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt", old: "two", new: "TWO" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bash", { command: "cat a.txt | wc -l" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("改好了。")),
  ]);
  const svc = await serve({ pipe: t.pipe, dbPath: join(t.dir, "tau.db"), presetsDir: t.presets, models: t.models, memory: sqliteMemory });
  try {
    const replies = await collect(t.pipe, { op: "start", preset: "dev", text: "把 two 改成大写" });
    assert.equal(replies[0]?.type, "receipt");
    const final = replies.at(-1);
    assert.deepEqual(final, { type: "final", reply: "改好了。", ended: "done" });
    assert.equal(readFileSync(join(t.work, "a.txt"), "utf8"), "one\nTWO\nthree\n");
    const id = replies[0]?.type === "receipt" ? replies[0].process : "";
    const rows = svc.db.prepare("SELECT message_json FROM segment_messages WHERE process_id = ? ORDER BY seq").all(id);
    const results = rows.map((r) => JSON.parse(r.message_json as string)).filter((m) => m.role === "toolResult");
    assert.equal(results.length, 3);
    assert.match(results[0].content[0].text, /two/);
    assert.match(results[2].content[0].text, /^\s*3\n\[退出码 0\]$/);
    const ps = await collect(t.pipe, { op: "ps" });
    assert.equal(ps[0]?.type === "ps" && ps[0].processes[0]?.self.phase.tag, "idle");
  } finally {
    await svc.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("服务在回执之前断开：CLI 提示结果未知", async () => {
  const pipe = `\\\\.\\pipe\\tau-test-drop-${process.pid}`;
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(pipe, r));
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const code = await main(["send", "abc", "你好"], pipe);
    assert.equal(code, 3);
    assert.match(errors.join("\n"), /结果未知/);
  } finally {
    console.error = orig;
    server.close();
  }
});

test("连不上服务：CLI 提示先运行 tau serve", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    assert.equal(await main(["ps"], `\\\\.\\pipe\\tau-test-none-${process.pid}`), 2);
    assert.match(errors.join("\n"), /tau serve/);
  } finally {
    console.error = orig;
  }
});

test("服务把预设读取函数交给 handleNext：模型 spawn 一个预设，子进程跑完，回信唤醒父进程", async () => {
  const t = setup();
  const head = (tools: string) => `---\nworkdir: ${t.work}\nmodel: ${t.faux.getModel().provider}/m\ntools: ${tools}\n---\n`;
  writeFileSync(join(t.presets, "boss.md"), `${head("agents")}老板。\n`);
  writeFileSync(join(t.presets, "kid.md"), `${head("read")}孩子。\n`);
  // 一个工厂按最后一条消息决定回复；回复按调用顺序消耗，所以放足够多份。
  const brain = (ctx: { messages: { role: string; content: unknown }[] }) => {
    const last = ctx.messages.at(-1);
    const lastText = JSON.stringify(last?.content);
    if (lastText.includes("去做")) return fauxAssistantMessage(fauxText("孩子做完了"));
    if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("派出了"));
    if (lastText.includes("的回信，")) return fauxAssistantMessage(fauxText("收到回信"));
    return fauxAssistantMessage([fauxToolCall("spawn", { preset: "kid", text: "去做" })], { stopReason: "toolUse" });
  };
  t.faux.setResponses(Array.from({ length: 6 }, () => brain));
  const svc = await serve({ pipe: t.pipe, dbPath: join(t.dir, "tau.db"), presetsDir: t.presets, models: t.models, memory: sqliteMemory });
  try {
    const replies = await collect(t.pipe, { op: "start", preset: "boss", text: "开工" });
    assert.equal(replies.at(-1)?.type, "final");
    const deadline = Date.now() + 5000;
    const state = () => svc.db.prepare("SELECT state_json FROM processes").all().map((r) => JSON.parse(r.state_json as string) as { id: string; parent?: string; preset: { id: string }; phase: { tag: string } });
    while (Date.now() < deadline && !(state().length === 2 && state().every((p) => p.phase.tag === "idle") && !svc.db.prepare("SELECT 1 FROM mailbox").get())) await new Promise((r) => setTimeout(r, 20));
    const [boss, kid] = [state().find((p) => p.preset.id === "boss"), state().find((p) => p.preset.id === "kid")];
    assert.ok(boss && kid);
    assert.equal(kid.parent, boss.id);
    const said = svc.db.prepare("SELECT message_json FROM segment_messages WHERE process_id = ? ORDER BY seq").all(boss.id).map((r) => JSON.stringify(JSON.parse(r.message_json as string)));
    assert.ok(said.some((m) => m.includes("孩子做完了")), "父进程应当收到孩子的回信");
    assert.ok(said.some((m) => m.includes("收到回信")));
  } finally {
    await svc.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// 第 4 步验收：bash 工具真的运行仓库的 tau 脚本，经 TAU_PIPE 连到测试服务（不是正式管道），看得到测试进程。
test("bash 工具运行 tau ps，经 TAU_PIPE 连到测试服务", async () => {
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  const t = setup();
  const script = join(import.meta.dirname, "..", "..", "tau").replaceAll("\\", "/");
  writeFileSync(join(t.presets, "dev.md"), `---\nworkdir: ${t.work}\nmodel: ${t.faux.getModel().provider}/m\ntools: bash\n---\n你是测试助手。\n`);
  t.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: `'${script}' ps; echo "$TAU_PROCESS"` })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("看过了。")),
  ]);
  const svc = await serve({ pipe: t.pipe, dbPath: join(t.dir, "tau.db"), presetsDir: t.presets, models: t.models, memory: sqliteMemory });
  try {
    const replies = await collect(t.pipe, { op: "start", preset: "dev", text: "看看进程" });
    const id = replies[0]?.type === "receipt" ? replies[0].process : "";
    assert.ok(id);
    const rows = svc.db.prepare("SELECT message_json FROM segment_messages WHERE process_id = ? ORDER BY seq").all(id);
    const results = rows.map((r) => JSON.parse(r.message_json as string)).filter((m) => m.role === "toolResult");
    const text: string = results[0].content[0].text;
    assert.equal(results[0].isError, false, text);
    assert.match(text, new RegExp(`${id}  dev  `), "ps 的输出里有测试进程");
    assert.ok(text.endsWith(`\n${id}\n[退出码 0]`), "TAU_PROCESS 是这个进程");
  } finally {
    await svc.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
