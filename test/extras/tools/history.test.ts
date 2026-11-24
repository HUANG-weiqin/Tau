// history_dump（extras/tools）：渲染、输出、清理、幂等的单测，再加一条对着真的服务的集成测试。
// 集成测试用临时目录和测试管道，脚本的数据目录靠 USERPROFILE 指到临时目录，不碰真的 ~/.tau。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { HANDOFF_HEADER as KERNEL_HANDOFF_HEADER } from "../../../src/kernel/context.ts";
import type { ToolDef } from "../../../src/kernel/types.ts";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import type { Service } from "../../../src/server/serve.ts";
import { runToolDef } from "../../../src/tools/tooldef.ts";
import { talk } from "../../../extras/tools/client.ts";
import { CATALOG, definitionOf } from "../../../extras/tools/catalog.ts";
import { bodyOf, fmtTime, formatDump, headFromMarkdown, headOf, KEEP_MS, LISTED, NOTICE, pruneOld, readExistingSegment, clipBytes, renderBrief, renderSegment, renderSegmentParts, titleOf, usageOf, writeBrief, writeSegment } from "../../../extras/tools/history.ts";
import type { Row } from "../../../extras/tools/history.ts";
import { textOfResult } from "../../plain.ts";

const LIB = join(import.meta.dirname, "..", "..", "..", "extras", "tools").replace(/\\/g, "/");

// ---------- 造数据 ----------

const T = new Date(2026, 10, 17, 9, 5).getTime();
const user = (text: string, extra: Record<string, unknown> = {}): any => ({ role: "user", content: text, timestamp: T, ...extra });
const handoff = (text: string): any => user(`${KERNEL_HANDOFF_HEADER}${text}`, { tau: { letters: [], handoff: true } });
const text = (t: string): any => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown): any => ({ type: "toolCall", id, name, arguments: args });
const asst = (...content: any[]): any => ({ role: "assistant", content, timestamp: T });
const result = (id: string, name: string, t: string, isError = false): any => ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(t)], isError, timestamp: T });
const rowsOf = (...messages: any[]): Row[] => messages.map((message, seq) => ({ seq, message }));

/** 临时目录，每个测试自己一个。 */
const tempRoots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tau-dump-"));
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

// ---------- 纯函数 ----------

describe("标题行", () => {
  test("角色和本地时间：用户、助手、工具结果、交接说明", () => {
    assert.equal(titleOf(3, 13, user("x")), "## [3:13] 用户 11-17 09:05");
    assert.equal(titleOf(1, 0, handoff("目标")), "## [1:0] 交接说明 11-17 09:05");
    assert.equal(titleOf(2, 4, asst(text("x"))), "## [2:4] 助手 11-17 09:05");
    assert.equal(titleOf(3, 13, result("c1", "bash", "x")), "## [3:13] 工具结果 bash 11-17 09:05");
    assert.equal(titleOf(3, 13, result("c1", "bash", "x", true)), "## [3:13] 工具结果 bash（错误） 11-17 09:05");
  });

  test("没有时间戳就不写时间", () => {
    assert.equal(titleOf(1, 1, { role: "user", content: "x" }), "## [1:1] 用户");
    assert.equal(titleOf(1, 2, { role: "toolResult", toolName: "read", content: "x", isError: true }), "## [1:2] 工具结果 read（错误）");
  });

  test("不认识的消息没有标题行", () => {
    assert.equal(titleOf(1, 0, { role: "system", content: "x" }), null);
    assert.equal(titleOf(1, 0, null), null);
  });
});

describe("正文", () => {
  test("助手：文字原样，工具调用一行 JSON，思考块不写", () => {
    const m = asst({ type: "thinking", thinking: "秘密" }, text("先看看"), call("c1", "bash", { command: "ls -l" }), text("再说"));
    assert.equal(bodyOf(m), '先看看\n调用 bash {"command":"ls -l"}\n再说');
    assert.ok(!bodyOf(m).includes("秘密"));
  });

  test("用户和工具结果的文字原样；图片写 [图片]", () => {
    assert.equal(bodyOf({ role: "user", content: [text("看"), { type: "image", data: "blob:x", mimeType: "image/png" }] }), "看\n[图片]");
    assert.equal(bodyOf(result("c1", "read", "第一行\n第二行")), "第一行\n第二行");
    assert.equal(bodyOf({ role: "system", content: "x" }), "");
  });
});

describe("一段渲染成 Markdown", () => {
  test("一条一个标题行，下面接正文，消息之间空一行；全文，不截断", () => {
    const long = "长".repeat(9000);
    const md = renderSegment(2, rowsOf(handoff("交接一：目标 beta。"), asst(text(long), call("c1", "bash", { command: `echo ${long}` })), result("c1", "bash", "输出")));
    const lines = md.split("\n");
    assert.equal(lines[0], `## [2:0] 交接说明 ${fmtTime(T)}`);
    assert.ok(md.includes(`\n\n${KERNEL_HANDOFF_HEADER}交接一：目标 beta。`), "交接说明的固定文字照原样写");
    assert.ok(md.includes("长".repeat(9000)), "长正文不截断");
    assert.ok(md.includes(`调用 bash {"command":"echo ${long}"}`), "工具调用的参数不截断");
    assert.ok(md.includes(`## [2:2] 工具结果 bash ${fmtTime(T)}\n\n输出`));
    assert.ok(md.endsWith("\n") && !md.endsWith("\n\n"));
  });

  test("空段、不认识的消息：什么都不写；没有正文的消息只有标题行", () => {
    assert.equal(renderSegment(1, []), "");
    assert.equal(renderSegment(1, rowsOf({ role: "system", content: "x" })), "");
    assert.equal(renderSegment(1, rowsOf({ role: "assistant", content: [], timestamp: T })), `## [1:0] 助手 ${fmtTime(T)}\n`);
  });
});

describe("每段的开头一句", () => {
  test("第一条消息正文的第一行，最多 60 字", () => {
    assert.equal(headOf(rowsOf(user("开工 alpha"), asst(text("后面")))), "开工 alpha");
    assert.equal(headOf(rowsOf(user("第一行\n第二行"))), "第一行");
    const c = headOf(rowsOf(user("字".repeat(100))));
    assert.equal(c.length, 60);
    assert.ok(c.endsWith("…"));
    assert.equal(headOf([]), "");
  });

  test("交接说明跳过内核写的那行固定文字", () => {
    assert.equal(headOf(rowsOf(handoff("交接一：目标 beta，要点 alpha-key。\n\n第二段"))), "交接一：目标 beta，要点 alpha-key。");
  });
});

describe("输出的样子", () => {
  test("第一行是目录，每段一行：文件名、大小 KB、行数、开头；最后是用法和提示", () => {
    const out = formatDump("C:/x/history/p1", [
      { seg: 1, bytes: 2048, lines: 42, head: "开工 alpha" },
      { seg: 2, bytes: 10, lines: 1, head: "" },
    ]).split("\n");
    assert.equal(out[0], "C:/x/history/p1");
    assert.equal(out[1], "seg-1.md  2.0 KB  42行  开工 alpha");
    assert.equal(out[2], "seg-2.md  0.0 KB  1行  ");
    assert.equal(out[3], usageOf("C:/x/history/p1"));
    assert.equal(out[4], NOTICE);
  });

  test("有简略视图：写大小和行数；用法是先读简略视图、按 L 读原文、rg 搜原文", () => {
    const out = formatDump("C:/x/h", [{ seg: 1, bytes: 2048, lines: 42, head: "开工", brief: { bytes: 512, lines: 9 } }]).split("\n");
    assert.equal(out[1], "seg-1.md  2.0 KB  42行  简略视图 0.5 KB 9行  开工");
    assert.equal(out[2], '先 read C:/x/h/seg-<n>.brief.md 看这段做了什么，超过 30 KB 的分几次读（带 offset 和 limit）；要原文，按行首的 L行号+行数 读 seg-<n>.md 那一截；新段开头简略视图里的 [段号:序号]，到 seg-<段号>.brief.md 里找行首 "[序号 " 的那一行；要搜命令输出、文件内容里的字，用 rg -n -i -C2 "关键词" C:/x/h/seg-*.md。');
    assert.equal(out[3], NOTICE);
  });

  test("简略视图大于 30 KB：行末标“较大，分几次读”；刚好 30 KB 不标", () => {
    const out = formatDump("d", [
      { seg: 1, bytes: 1, lines: 1, head: "a", brief: { bytes: 30 * 1024 + 1, lines: 9 } },
      { seg: 2, bytes: 1, lines: 1, head: "b", brief: { bytes: 30 * 1024, lines: 9 } },
    ]).split("\n");
    assert.equal(out[1], "seg-1.md  0.0 KB  1行  简略视图 30.0 KB 9行（较大，分几次读）  a");
    assert.equal(out[2], "seg-2.md  0.0 KB  1行  简略视图 30.0 KB 9行  b");
  });

  test("超过 20 段：只列最近 20 段，写明总数", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ seg: i + 1, bytes: 1024, lines: 1, head: `第 ${i + 1} 段` }));
    const out = formatDump("d", entries).split("\n");
    assert.equal(out[1], "旧段共 25 个，只列最近 20 个（第 6–25 段），更旧的段也在目录里。");
    assert.equal(out.length, 1 + 1 + LISTED + 2);
    assert.equal(out[2], "seg-6.md  1.0 KB  1行  第 6 段");
    assert.equal(out.at(-3), "seg-25.md  1.0 KB  1行  第 25 段");
  });

  test("读不到的段：写一句原因，别的段照旧", () => {
    const out = formatDump("d", [{ seg: 1, missing: "第 1 段已经被删掉" }, { seg: 2, bytes: 10, lines: 1, head: "x" }]).split("\n");
    assert.equal(out[1], "seg-1.md  读不到：第 1 段已经被删掉");
    assert.equal(out[2], "seg-2.md  0.0 KB  1行  x");
  });
});

describe("写文件", () => {
  test("第一次写：先写临时文件再改名，不留临时文件", () => {
    const dir = join(tempRoot(), "p");
    const w = writeSegment(dir, 2, "## [2:0] 用户\n\n正文\n", T);
    assert.deepEqual(w, { bytes: Buffer.byteLength("## [2:0] 用户\n\n正文\n"), lines: 3, rewritten: true });
    assert.deepEqual(readdirSync(dir), ["seg-2.md"]);
    assert.equal(readFileSync(join(dir, "seg-2.md"), "utf8"), "## [2:0] 用户\n\n正文\n");
  });

  test("目标已经在了：不重写，只刷新修改时间", () => {
    const dir = join(tempRoot(), "p");
    writeSegment(dir, 1, "第一份\n", T);
    const file = join(dir, "seg-1.md");
    writeFileSync(file, "改过的\n");
    const later = T + 5 * 60 * 1000;
    const w = writeSegment(dir, 1, "第二份\n", later);
    assert.equal(w.rewritten, false);
    assert.deepEqual([w.bytes, w.lines], [Buffer.byteLength("改过的\n"), 1]);
    assert.equal(readFileSync(file, "utf8"), "改过的\n", "没有重写");
    assert.ok(Math.abs(statSync(file).mtimeMs - later) < 5, `修改时间没刷新：${statSync(file).mtimeMs}`);
    assert.deepEqual(readdirSync(dir), ["seg-1.md"], "没有留下临时文件");
  });
});

describe("简略视图", () => {
  // 内核的 BRIEF_HEADER 等文字是内部的，这里用自己的一份。
  const BRIEF_FIRST = "（下面是旧段的简略视图：程序把每条消息截成一行。）";
  const letterOf = (from: any, at: [number, number]): any => ({ from, hops: 0, at });

  const briefOf = (seg: number, rows: Row[]): string[] => renderBrief(seg, renderSegmentParts(seg, rows)).trimEnd().split("\n");

  test("每行的 L 正好指向 seg-<n>.md 里对应的标题行；第一行说明段号、条数和符号", () => {
    const rows = rowsOf(
      user("开工\n第二行"),
      asst(text("先看\n看"), call("c1", "read", { path: "a.ts" })),
      result("c1", "read", "第一行\n第二行\n\n第四行"),
      { role: "system", content: "不认识" },
      asst(text("好了")),
      user("再来"),
    );
    const parts = renderSegmentParts(3, rows);
    const md = parts.text.split("\n");
    const brief = renderBrief(3, parts).trimEnd().split("\n");
    assert.equal(brief[0], "# 第 3 段的简略视图：5 条。每条消息一行；行首 [序号 L行号+行数]，read seg-3.md 带 offset=行号、limit=行数，正好读到这条原文；✗ 是失败。");
    for (const line of brief.slice(1)) {
      const m = /^\[(\d+) L(\d+)\+(\d+)\] /.exec(line)!;
      assert.ok(m, line);
      assert.ok(md[Number(m[2]) - 1]!.startsWith(`## [3:${m[1]}] `), `${line} → ${md[Number(m[2]) - 1]}`);
    }
    assert.equal(brief.length, 6);
    // 照 read 的语义核对：offset 落在标题行，limit 行读完正好到下一条标题之前（最后一条到文件末尾）。
    const fileLines = md.slice(0, -1);
    const read = (offset: number, limit: number): string[] => fileLines.slice(offset - 1, offset - 1 + limit);
    const titleRe = /^## \[3:\d+\] /;
    for (const line of brief.slice(1)) {
      const m = /^\[(\d+) L(\d+)\+(\d+)\] /.exec(line)!;
      const got = read(Number(m[2]), Number(m[3]));
      assert.ok(titleRe.test(got[0]!), line);
      assert.equal(got.filter((l) => titleRe.test(l)).length, 1, `${line} 读到不止一条`);
      const after = fileLines[Number(m[2]) - 1 + Number(m[3])];
      assert.ok(after === undefined || titleRe.test(after), `${line} 之后不是标题：${after}`);
    }
    const lastM = /^\[\d+ L(\d+)\+(\d+)\] /.exec(brief.at(-1)!)!;
    assert.equal(Number(lastM[1]) - 1 + Number(lastM[2]), fileLines.length, "最后一条正好到文件末尾");
    assert.ok(brief[1]!.endsWith("用户：开工 第二行"));
    assert.ok(brief[2]!.endsWith("助手：先看 看"));
    assert.ok(brief[3]!.endsWith("read a.ts"));
  });

  test("第 0 条带 tau.brief：那一块的行不出现，交接说明不含它，带过来的信各一行", () => {
    const note = "交接目标 X。\n细节 Y";
    const block = `${BRIEF_FIRST}\n[1:3] 用户：更早的段里的一行\n[1:4] 助手：另一行\n（结束）`;
    const carry = "（下面是写交接说明时还没处理的用户消息。）";
    const head = `${KERNEL_HANDOFF_HEADER}${note}\n\n`;
    const l1 = "人写的信  正文";
    const l2 = "进程写的信";
    const textBody = `${head}${block}\n\n${carry}\n\n${l1}\n\n${l2}`;
    const b0 = head.length;
    const b1 = b0 + block.length;
    const a1 = textBody.indexOf(l1);
    const a2 = textBody.indexOf(l2);
    const m = user(textBody, { tau: { handoff: true, brief: [b0, b1], letters: [letterOf({ kind: "user" }, [a1, a1 + l1.length]), letterOf({ kind: "process", id: "abc123", preset: "w" }, [a2, a2 + l2.length])] } });
    const lines = briefOf(2, rowsOf(m, user("后面")));
    const all = lines.join("\n");
    assert.ok(!all.includes("更早的段里的一行") && !all.includes("另一行") && !all.includes("简略视图：程序"), all);
    assert.ok(!all.includes(KERNEL_HANDOFF_HEADER.trim()), "交接说明不含内核写的固定文字");
    assert.ok(lines[1]!.endsWith("交接说明：交接目标 X。 细节 Y"), lines[1]);
    assert.ok(lines[2]!.endsWith("用户：人写的信 正文"), lines[2]);
    assert.ok(lines[3]!.endsWith("信（来自 abc123）：进程写的信"), lines[3]);
    assert.ok(lines[4]!.endsWith("用户：后面"));
    assert.equal(lines.length, 5);
    assert.ok(lines[1]!.startsWith("[0 L1+") && lines[3]!.startsWith("[0 L1+"));
  });

  test("没有 tau.brief 的换段消息：交接说明取到带过去的信之前", () => {
    const l1 = "信一";
    const textBody = `${KERNEL_HANDOFF_HEADER}说明。\n\n（下面是写交接说明时还没处理的用户消息。）\n\n${l1}`;
    const at = textBody.indexOf(l1);
    const lines = briefOf(2, rowsOf(user(textBody, { tau: { handoff: true, letters: [letterOf({ kind: "user" }, [at, at + 2])] } })));
    assert.ok(lines[1]!.endsWith("交接说明：说明。"), lines[1]);
    assert.ok(lines[2]!.endsWith("用户：信一"));
  });

  test("工具调用 ID 是空串：按位置配对；失败写头尾，退出码在前；成功的库外工具只写名字和参数开头", () => {
    const rows = rowsOf(
      user("干活"),
      asst(call("", "bash", { command: "make   all" }), call("", "write", { path: "/x/y.txt", content: "很长的内容" }), call("", "spawn", { preset: "w", text: "去做" })),
      result("", "bash", "编译开始\n中间\nerror: boom\n[退出码 1]", true),
      result("", "write", "写好了 100 字节"),
      result("", "spawn", "新进程 ab12cd\n其它"),
      asst(call("", "read", { path: "gone.txt" })),
      result("", "read", "没有这个文件", true),
    );
    const lines = briefOf(1, rows).slice(1);
    assert.ok(lines[1]!.endsWith("✗ bash make all：[退出码 1] 编译开始 … error: boom"), lines[1]);
    assert.ok(lines[2]!.endsWith("] write /x/y.txt") && !lines[2]!.includes("写好了"), lines[2]);
    assert.ok(lines[3]!.endsWith("] spawn w → 新进程 ab12cd"), lines[3]);
    assert.ok(lines[4]!.endsWith("] ✗ read gone.txt：没有这个文件"), lines[4]);
    assert.ok(/^\[2 L\d+\+\d+\] /.test(lines[1]!) && /^\[3 L\d+\+\d+\] /.test(lines[2]!), "序号是结果的序号");
  });

  test("不写思考；图片写 [图片]；参数没有 command 和 path 时取第一个字符串值", () => {
    const rows = rowsOf(
      { role: "user", content: [text("看这个"), { type: "image", data: "b", mimeType: "image/png" }], timestamp: T },
      asst({ type: "thinking", thinking: "秘密想法" }, text("答"), call("c1", "web_search", { n: 3, query: "tau  rocks" })),
      result("c1", "web_search", "x"),
    );
    const all = briefOf(1, rows).join("\n");
    assert.ok(!all.includes("秘密想法"));
    assert.ok(all.includes("用户：看这个 [图片]"), all);
    assert.ok(all.includes("web_search tau rocks"), all);
  });

  test("每行截短：很长的信、助手回复、命令，每行不超过 300 字节，行首位置完整，不劈开字符", () => {
    const long = "长文😀".repeat(500);
    const l1 = `信${long}`;
    const rows = rowsOf(
      user(l1, { tau: { letters: [letterOf({ kind: "user" }, [0, l1.length])] } }),
      asst(text(long), call("c1", "bash", { command: `echo ${long}` })),
      result("c1", "bash", long, true),
      asst(text(long)),
      user(long),
    );
    const brief = briefOf(2, rows).slice(1);
    assert.equal(brief.length, 5);
    for (const line of brief) {
      assert.ok(Buffer.byteLength(line) <= 300, `${Buffer.byteLength(line)} 字节`);
      assert.match(line, /^\[\d+ L\d+\+\d+\] /);
      assert.ok(!line.includes("\uFFFD"), line);
    }
    assert.ok(Buffer.byteLength(brief[1]!.split("助手：")[1]!) <= 120, "带工具调用的助手文字最多 120 字节");
    assert.ok(brief[2]!.startsWith("[2 L") && brief[2]!.includes("✗ bash echo "));
    assert.ok(brief[0]!.endsWith("…"));
    assert.ok(clipBytes("字".repeat(100), 100).length <= 34 && Buffer.byteLength(clipBytes("字".repeat(100), 100)) <= 100);
    assert.equal(clipBytes("短", 100), "短");
  });
});

describe("写简略视图文件", () => {
  test("先写临时文件再改名；已有不重写，只刷新修改时间；不留临时文件", () => {
    const dir = join(tempRoot(), "p");
    const w = writeBrief(dir, 2, "# x\n[0 L1+3] 用户：a\n", T);
    assert.deepEqual(w, { bytes: Buffer.byteLength("# x\n[0 L1+3] 用户：a\n"), lines: 2, rewritten: true });
    assert.deepEqual(readdirSync(dir), ["seg-2.brief.md"]);
    const file = join(dir, "seg-2.brief.md");
    writeFileSync(file, "改过的\n");
    const later = T + 60_000;
    const again = writeBrief(dir, 2, "第二份\n", later);
    assert.equal(again.rewritten, false);
    assert.equal(readFileSync(file, "utf8"), "改过的\n");
    assert.ok(Math.abs(statSync(file).mtimeMs - later) < 5);
    assert.deepEqual(readdirSync(dir), ["seg-2.brief.md"]);
  });

  test("7 天清理也清简略视图", () => {
    const root = join(tempRoot(), "history");
    const now = Date.UTC(2026, 10, 20);
    mkdirSync(join(root, "p"), { recursive: true });
    const f = join(root, "p", "seg-1.brief.md");
    writeFileSync(f, "旧");
    utimesSync(f, (now - KEEP_MS - 1000) / 1000, (now - KEEP_MS - 1000) / 1000);
    assert.equal(pruneOld(root, now), 1);
    assert.ok(!existsSync(join(root, "p")));
  });
});

describe("清理", () => {
  test("删 7 天前的文件，删空了的进程目录也删；新的和刚满 7 天的留着", () => {
    const root = join(tempRoot(), "history");
    const now = Date.UTC(2026, 10, 20);
    const dead = join(root, "dead");
    const live = join(root, "live");
    mkdirSync(dead, { recursive: true });
    mkdirSync(live, { recursive: true });
    const age = (file: string, ms: number): void => utimesSync(file, (now - ms) / 1000, (now - ms) / 1000);
    writeFileSync(join(dead, "seg-1.md"), "旧");
    age(join(dead, "seg-1.md"), KEEP_MS + 1000);
    writeFileSync(join(live, "seg-1.md"), "新");
    writeFileSync(join(live, "seg-2.md"), "旧");
    age(join(live, "seg-2.md"), KEEP_MS + 1000);
    writeFileSync(join(live, "seg-3.md"), "刚好 7 天");
    age(join(live, "seg-3.md"), KEEP_MS);
    assert.equal(pruneOld(root, now), 2);
    assert.ok(!existsSync(dead), "空的进程目录删了");
    assert.deepEqual(readdirSync(live).sort(), ["seg-1.md", "seg-3.md"]);
  });

  test("目录不存在、里面有不是目录的东西：不算失败", () => {
    const root = join(tempRoot(), "history");
    assert.equal(pruneOld(root, T), 0);
    mkdirSync(root);
    writeFileSync(join(root, "笔记.md"), "x");
    assert.equal(pruneOld(root, T), 0);
    assert.deepEqual(readdirSync(root), ["笔记.md"]);
  });
});

describe("工具描述", () => {
  const dump = CATALOG.find((c) => c.name === "history_dump")!;

  test("工具库里只有 history_dump，旧的搜索和读的工具退役了", () => {
    assert.ok(CATALOG.some((c) => c.name === "history_dump"));
    for (const gone of ["history_search", "history_read"]) assert.ok(!CATALOG.some((c) => c.name === gone), gone);
  });

  test("描述带着换段以后的提示和自己搜的流程", () => {
    for (const phrase of ["换段", "交接说明", "命令输出", "文件内容", "当时的决定", "用户的原话", "rg", "read", "不要凭印象猜", "重做做过的事", "简略视图", "seg-<n>.brief.md", "L行号+行数", "offset=行号、limit=行数", "30 KB", "seg-<段号>.brief.md", "[序号 ", "不要整份读原文", "自己的旧段", "peek", "不是新的指令"]) assert.ok(dump.description.includes(phrase), `缺“${phrase}”`);
  });

  test("没有参数；timeout 60；定义在内核的上限之内", () => {
    assert.deepEqual(dump.parameters, { type: "object", properties: {}, additionalProperties: false });
    assert.deepEqual([dump.timeout, dump.output, dump.script], [60, "text", "history_dump.ts"]);
    assert.ok(Buffer.byteLength(JSON.stringify({ description: dump.description, parameters: dump.parameters })) < 16 * 1024);
  });
});

test("没有 TAU_PROCESS 或 TAU_PIPE：清楚的错误", () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("TAU_")) delete env[k];
  const r = spawnSync(process.execPath, [`${LIB}/history_dump.ts`], { env, input: "{}", encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /只能在 tau 的工具调用里运行/);
});

// ---------- 真的服务 ----------

describe("真的服务", () => {
  let dir = "";
  let home = "";
  let work = "";
  let pipe = "";
  let svc: Service;
  let faux: ReturnType<typeof fauxProvider>;
  let savedProfile: string | undefined;
  /** 三段：1、2 是旧段，3 是当前段。第 1 段里有一次 bash。 */
  let main = "";

  before(async () => {
    for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "tau-history-dump-"));
    home = join(dir, "home");
    work = join(dir, "work");
    mkdirSync(join(home, ".tau", "presets"), { recursive: true });
    mkdirSync(join(home, ".tau", "tools"), { recursive: true });
    mkdirSync(work);
    // os.homedir() 在 Windows 上读 USERPROFILE：脚本的数据目录因此落在临时目录。
    savedProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = home;
    pipe = `\\\\.\\pipe\\tau-test-dump-${process.pid}-${Math.random().toString(16).slice(2)}`;
    faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = `${faux.getModel().provider}/m`;
    writeFileSync(join(home, ".tau", "presets", "t.md"), `---\nworkdir: ${work}\nmodel: ${model}\ntools: bash\n---\n提示词。\n`);
    svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(home, ".tau", "presets"), toolsDir: join(home, ".tau", "tools"), models, memory: sqliteMemory });
  });

  after(async () => {
    await svc.close();
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });

  const say = (t: string) => fauxAssistantMessage(fauxText(t));
  const run = (t: string, id: string, command: string) => fauxAssistantMessage([fauxText(t), fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

  /** 像执行器一样运行一个工具。内核给每条工具结果加一行退出码：成功时去掉，方便比较结尾。 */
  async function tool(name: string, args: unknown, proc: string) {
    const e = CATALOG.find((c) => c.name === name)!;
    const r = await runToolDef({ name, ...(definitionOf(e, LIB) as Omit<ToolDef, "name">) }, args, work, new AbortController().signal, { process: proc, pipe }, true);
    return { text: textOfResult(r).replace(/\n\[退出码 0\]$/, ""), isError: r.isError };
  }

  async function request(req: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    await talk(pipe, req, (r) => {
      out.push(r);
      return r.type === "receipt" || r.type === "end" || r.type === "error" || r.type === "ps";
    });
    return out;
  }

  async function untilIdle(id: string, ms = 30_000): Promise<void> {
    for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) {
      const [ps] = await request({ op: "ps" });
      const p = ps.processes.find((x: any) => x.self.id === id)?.self.phase;
      if (p?.tag === "idle" && p.ended !== undefined) return;
    }
    throw new Error(`进程 ${id} 没在 ${ms} 毫秒内结束`);
  }

  async function begin(textBody: string): Promise<string> {
    const r = await request({ op: "start", preset: "t", text: textBody });
    const id = r.find((x) => x.type === "receipt")?.process;
    assert.equal(typeof id, "string", JSON.stringify(r));
    await untilIdle(id);
    return id;
  }

  /** 换段：带 handoff 的信。模型先写交接说明，再在新段里回复。 */
  async function next(id: string, textBody: string): Promise<void> {
    const r = await request({ op: "send", process: id, text: textBody, handoff: true });
    assert.equal(r[0]?.type, "receipt", JSON.stringify(r));
    await untilIdle(id);
  }

  const dumpDir = (id: string) => join(home, ".tau", "extras", "history", id);

  before(async () => {
    faux.setResponses([run("第一段动手。", "c1", "echo first-output alpha"), say("第一段结论。"), say("交接一：目标 beta，要点 alpha-key。"), say("第二段回复 beta。"), say("交接二：目标 gamma。"), say("第三段回复 gamma。")]);
    main = await begin("开工 alpha");
    await next(main, "进入第二段");
    await next(main, "进入第三段");
  });

  test("dump 出旧段：第 3 段是当前段，不写", async () => {
    assert.deepEqual((await request({ op: "inspect", process: main }))[0].process.segment.seq, 3);
    const r = await tool("history_dump", {}, main);
    assert.equal(r.isError, false, r.text);
    const out = r.text.split("\n");
    assert.equal(out[0], dumpDir(main).replace(/\\/g, "/"), "第一行是目录，正斜杠");
    assert.match(out[1]!, /^seg-1\.md  \d+\.\d KB  \d+行  简略视图 \d+\.\d KB \d+行  开工 alpha$/);
    assert.match(out[2]!, /^seg-2\.md  \d+\.\d KB  \d+行  简略视图 \d+\.\d KB \d+行  交接一：目标 beta，要点 alpha-key。$/);
    assert.deepEqual(out.slice(3), [usageOf(dumpDir(main).replace(/\\/g, "/")), NOTICE]);
    assert.deepEqual(readdirSync(dumpDir(main)).sort(), ["seg-1.brief.md", "seg-1.md", "seg-2.brief.md", "seg-2.md"]);
    assert.ok(!existsSync(join(dumpDir(main), "seg-3.md")), "当前段不 dump");
  });

  test("文件内容：位置标题、角色、时间、原样的正文，工具调用一行 JSON", () => {
    const s1 = readFileSync(join(dumpDir(main), "seg-1.md"), "utf8");
    assert.match(s1, /^## \[1:0\] 用户 \d\d-\d\d \d\d:\d\d\n\n开工 alpha\n/);
    assert.match(s1, /## \[1:1\] 助手 \d\d-\d\d \d\d:\d\d\n\n第一段动手。\n调用 bash \{"command":"echo first-output alpha"\}/);
    assert.match(s1, /## \[1:2\] 工具结果 bash \d\d-\d\d \d\d:\d\d\n\nfirst-output alpha/);
    assert.match(s1, /## \[1:4\] 用户 \d\d-\d\d \d\d:\d\d\n\n进入第二段\n/);
    const s2 = readFileSync(join(dumpDir(main), "seg-2.md"), "utf8");
    assert.match(s2, /^## \[2:0\] 交接说明 \d\d-\d\d \d\d:\d\d\n\n（这是你在上一个工作段结束时写的交接说明。）\n\n交接一：目标 beta，要点 alpha-key。/);
    assert.ok(s2.includes("第二段回复 beta。"));
  });

  test("第二次调用不重写：内容、inode 不变，修改时间刷新；顺手清掉 7 天前的文件", async () => {
    const file = join(dumpDir(main), "seg-1.md");
    const text = readFileSync(file, "utf8");
    const first = statSync(file);
    // 7 天前的段文件和整个进程目录：下一次调用清掉。
    const grumpy = join(dumpDir(main), "seg-9.md");
    writeFileSync(grumpy, "陈旧");
    utimesSync(grumpy, (Date.now() - KEEP_MS - 60_000) / 1000, (Date.now() - KEEP_MS - 60_000) / 1000);
    const deadProc = join(home, ".tau", "extras", "history", "deadproc");
    mkdirSync(deadProc, { recursive: true });
    writeFileSync(join(deadProc, "seg-1.md"), "陈旧");
    utimesSync(join(deadProc, "seg-1.md"), (Date.now() - KEEP_MS - 60_000) / 1000, (Date.now() - KEEP_MS - 60_000) / 1000);

    await sleep(20);
    const again = await tool("history_dump", {}, main);
    assert.equal(again.isError, false, again.text);
    assert.ok(again.text.includes("seg-1.md"), again.text);
    const second = statSync(file);
    assert.equal(readFileSync(file, "utf8"), text, "内容没变");
    if (first.ino !== 0) assert.equal(second.ino, first.ino, "没有换文件");
    assert.ok(second.mtimeMs > first.mtimeMs, `修改时间没刷新：${first.mtimeMs} → ${second.mtimeMs}`);
    assert.ok(!existsSync(grumpy), "7 天前的段文件清掉了");
    assert.ok(!existsSync(deadProc), "空了的进程目录清掉了");
    assert.ok(existsSync(join(dumpDir(main), "seg-2.md")), "新的文件留着");
  });

  test("headFromMarkdown 与 headOf 口径一致；readExistingSegment 直接读缓存算大小、行数和开头", () => {
    const samples: Row[][] = [
      [{ seq: 0, message: user("第一行\n第二行") }],
      [{ seq: 0, message: handoff("\n\n交接内容第一行\n第二行") }],
      [{ seq: 0, message: user("") }, { seq: 1, message: { role: "assistant", content: [text("答复")], timestamp: T } }],
      [{ seq: 0, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }], timestamp: T } }],
    ];
    for (const rows of samples) {
      assert.equal(headFromMarkdown(renderSegment(1, rows)), headOf(rows));
    }
    const cacheDir = join(dir, "cache-read");
    const md = renderSegment(1, [{ seq: 0, message: handoff("交接目标 X。\n细节 Y") }, { seq: 1, message: user("后续") }]);
    writeSegment(cacheDir, 1, md, T);
    const later = T + 10_000;
    const cached = readExistingSegment(cacheDir, 1, later);
    assert.deepEqual(cached, { bytes: Buffer.byteLength(md), lines: md.split("\n").length - 1, head: "交接目标 X。" });
    assert.ok(Math.abs(statSync(join(cacheDir, "seg-1.md")).mtimeMs - later) < 5);
  });

  test("只有一段的进程：写明没有旧段，不建目录", async () => {
    faux.setResponses([say("好。")]);
    const one = await begin("单段的进程");
    const r = await tool("history_dump", {}, one);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^现在是第 1 段，没有旧段。当前段的内容你已经有了，不用再调；看别的进程用 peek。/);
    assert.ok(!existsSync(dumpDir(one)));
  });

  test("带了参数（指向别的进程）：照写自己的旧段，写明忽略了", async () => {
    const r = await tool("history_dump", { process: "other111", segment: 2 }, main);
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes("注：history_dump 没有参数 process、segment，忽略了；它只写你自己的旧段，看别的进程用 peek。"), r.text);
    assert.ok(r.text.startsWith(dumpDir(main).replace(/\\/g, "/")), r.text);
  });

  test("被 prune 删掉的段：写一句原因，别的段照常（已缓存过的文件也能感知到 prune）", async () => {
    faux.setResponses([say("一。"), say("交接一：清掉。"), say("二。"), say("交接二：清掉。"), say("三。")]);
    const id = await begin("要被删的段");
    await next(id, "进入第二段");
    await next(id, "进入第三段");
    const first = await tool("history_dump", {}, id);
    assert.equal(first.isError, false, first.text);
    assert.ok(existsSync(join(dumpDir(id), "seg-1.md")));
    const [receipt] = await request({ op: "prune", process: id, before: 2 });
    assert.equal(receipt.type, "receipt");
    const r = await tool("history_dump", {}, id);
    assert.equal(r.isError, false, r.text);
    const out = r.text.split("\n");
    assert.match(out[1]!, /^seg-1\.md  \d+\.\d KB  \d+行  简略视图 \d+\.\d KB \d+行  （库里的这一段已 prune，本地文件还在）/);
    assert.match(out[2]!, /^seg-2\.md  \d+\.\d KB  \d+行  /);
    assert.ok(existsSync(join(dumpDir(id), "seg-1.brief.md")));
    assert.ok(existsSync(join(dumpDir(id), "seg-1.md")));
    assert.ok(existsSync(join(dumpDir(id), "seg-2.md")));
  });

  test("已有 seg-<n>.md、没有简略视图（以前写的）：补写，原文不重写；两个调用同时跑不会读到半截", async () => {
    const brief = join(dumpDir(main), "seg-1.brief.md");
    const md = join(dumpDir(main), "seg-1.md");
    const before = readFileSync(md, "utf8");
    const ino = statSync(md).ino;
    rmSync(brief);
    rmSync(join(dumpDir(main), "seg-2.brief.md"));
    const [a, b] = await Promise.all([tool("history_dump", {}, main), tool("history_dump", {}, main)]);
    for (const r of [a, b]) {
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /seg-1\.md  \d+\.\d KB  \d+行  简略视图 /);
    }
    assert.equal(readFileSync(md, "utf8"), before, "原文没重写");
    if (ino !== 0) assert.equal(statSync(md).ino, ino);
    const text = readFileSync(brief, "utf8");
    assert.ok(text.startsWith("# 第 1 段的简略视图：5 条。"), text);
    assert.ok(text.endsWith("\n") && text.includes("用户：开工 alpha"), text);
    assert.ok(text.includes("bash echo first-output alpha"), text);
    assert.deepEqual(readdirSync(dumpDir(main)).filter((f) => f.endsWith(".tmp")), [], "没有留临时文件");
    // L 指向原文里的标题行。
    const lines = before.split("\n");
    for (const line of text.trimEnd().split("\n").slice(1)) {
      const m = /^\[(\d+) L(\d+)\+(\d+)\] /.exec(line)!;
      assert.ok(lines[Number(m[2]) - 1]!.startsWith(`## [1:${m[1]}] `), line);
    }
  });

  test("被 prune 的段、本地有原文没简略视图：只列原文，不补", async () => {
    faux.setResponses([say("一。"), say("交接一：x。"), say("二。"), say("交接二：y。"), say("三。")]);
    const id = await begin("老段");
    await next(id, "进入第二段");
    await next(id, "进入第三段");
    mkdirSync(dumpDir(id), { recursive: true });
    writeFileSync(join(dumpDir(id), "seg-1.md"), "## [1:0] 用户 11-17 09:05\n\n老段\n");
    await request({ op: "prune", process: id, before: 2 });
    const r = await tool("history_dump", {}, id);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text.split("\n")[1]!, /^seg-1\.md  \d+\.\d KB  3行  （库里的这一段已 prune，本地文件还在）老段$/);
    assert.ok(!existsSync(join(dumpDir(id), "seg-1.brief.md")));
  });

  test("没有这个进程：错误里有服务的原因", async () => {
    const r = await tool("history_dump", {}, "nope-nope");
    assert.equal(r.isError, true);
    assert.match(r.text, /读不到进程 nope-nope/);
  });
});
