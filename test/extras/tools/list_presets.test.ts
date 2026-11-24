// list_presets（extras/tools）：纯函数，加一次子进程；数据目录靠 USERPROFILE 指到临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, listPresets, summarize } from "../../../extras/tools/list_presets.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "extras", "tools", "list_presets.ts");
const GOOD = "---\nworkdir: E:/tau\nmodel: a/b\ntools: read, bash\n---\n\n你是审查员，只读。\n第二行不显示。\n";

test("summarize：取头部三项和正文第一个非空行", () => {
  assert.deepEqual(summarize("r", GOOD), { id: "r", model: "a/b", tools: "read, bash", workdir: "E:/tau", summary: "你是审查员，只读。" });
  assert.equal(summarize("r", `\uFEFF${GOOD.replace(/\n/g, "\r\n")}`).summary, "你是审查员，只读。");
});

test("summarize：格式不对不抛，缺的写问号；正文太长截断", () => {
  assert.deepEqual(summarize("x", "没有头部"), { id: "x", model: "?", tools: "?", workdir: "?", summary: "没有头部" });
  assert.equal(summarize("x", "---\nmodel: m\n---\n").summary, "");
  assert.ok(summarize("x", "字".repeat(500)).summary.length < 200);
});

test("format：空列表和有内容", () => {
  assert.equal(format([]), "没有预设。");
  const s = format([summarize("r", GOOD), summarize("e", "---\nmodel: m\n---\n")]);
  assert.match(s, /共 2 个预设/);
  assert.match(s, /- r：你是审查员，只读。\n {2}model a\/b；tools read, bash；workdir E:\/tau/);
  assert.match(s, /- e：（正文是空的）/);
});

test("脚本：按 ID 排序，跳过非 .md 和不合法的文件名；没有目录就说没有预设", () => {
  const home = mkdtempSync(join(tmpdir(), "tau-listpresets-"));
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const run = () => execFileSync(process.execPath, [SCRIPT], { env, input: "{}", encoding: "utf8" });
    assert.equal(run().trim(), "没有预设。");
    const dir = join(home, ".tau", "presets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.md"), GOOD);
    writeFileSync(join(dir, "a.md"), GOOD);
    writeFileSync(join(dir, "v1.coder.md"), GOOD);
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, "bad name.md"), GOOD);
    writeFileSync(join(dir, "trailing..md"), GOOD);
    writeFileSync(join(dir, "x..y.md"), GOOD);
    const out = run();
    const filtered = execFileSync(process.execPath, [SCRIPT], { env, input: JSON.stringify({ filter: "x" }), encoding: "utf8" });
    assert.match(filtered, /共 3 个预设/);
    assert.equal(filtered.trimEnd().split("\n").at(-1), "注：list_presets 没有参数 filter，忽略了。");
    assert.match(out, /共 3 个预设/);
    assert.ok(out.indexOf("- a：") < out.indexOf("- b："));
    assert.ok(out.includes("- v1.coder："));
    assert.ok(!out.includes("bad name"));
    assert.ok(!out.includes("trailing."));
    assert.ok(!out.includes("x..y"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listPresets：目录里读不出的项让调用抛出（不是 ENOENT 的错不吞）", async () => {
  await assert.rejects(listPresets(join(tmpdir(), "tau-no-such-dir-xyz")), { code: "ENOENT" });
});
