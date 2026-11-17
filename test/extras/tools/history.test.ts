// 历史检索工具（extras/tools 的 history_search、history_read）：纯函数和扫描函数的单测，再加真的服务里的集成测试。
// 集成测试用临时目录和测试管道，脚本的数据目录靠 USERPROFILE 指到临时目录，不碰真的 ~/.tau。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CARRY_HEADER as KERNEL_CARRY_HEADER, HANDOFF_HEADER as KERNEL_HANDOFF_HEADER } from "../../../src/kernel/context.ts";
import type { ToolDef } from "../../../src/kernel/types.ts";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import type { Service } from "../../../src/server/serve.ts";
import { runToolDef } from "../../../src/tools/tooldef.ts";
import { talk } from "../../../extras/tools/client.ts";
import { CATALOG, definitionOf } from "../../../extras/tools/catalog.ts";
import {
  byteEnd,
  byteLength,
  callText,
  capBytes,
  CARRY_HEADER,
  clip,
  fmtTime,
  fold,
  formatSearch,
  HANDOFF_HEADER,
  matchAt,
  messageParts,
  NOTICE,
  pairsOf,
  parsePos,
  parseQuery,
  parseReadArgs,
  parseSearchArgs,
  READ_BYTES,
  renderRead,
  scanHistory,
  SEARCH_BYTES,
  snippetOf,
  summarize,
} from "../../../extras/tools/history.ts";
import type { Row, ScanOptions } from "../../../extras/tools/history.ts";
import { textOfResult } from "../../plain.ts";

const LIB = join(import.meta.dirname, "..", "..", "..", "extras", "tools").replace(/\\/g, "/");

// ---------- 造数据 ----------

const T = new Date(2026, 10, 17, 9, 5).getTime();
const user = (text: string, extra: Record<string, unknown> = {}): any => ({ role: "user", content: text, timestamp: T, ...extra });
const handoff = (text: string): any => user(`（这是你在上一个工作段结束时写的交接说明。）\n\n${text}`, { tau: { letters: [], handoff: true } });
const text = (t: string): any => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown): any => ({ type: "toolCall", id, name, arguments: args });
const asst = (...content: any[]): any => ({ role: "assistant", content, timestamp: T });
const result = (id: string, name: string, t: string, isError = false): any => ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(t)], isError, timestamp: T });
const rowsOf = (...messages: any[]): Row[] => messages.map((message, seq) => ({ seq, message }));
const LONG = (n: number): string => "长".repeat(n);

/** 没有的段（null）算读不到。 */
function fake(segs: Record<number, Row[] | null>, clock?: { t: number; step: number }): Pick<ScanOptions, "read" | "now"> {
  const c = clock ?? { t: 0, step: 0 };
  return {
    read: async (s) => {
      c.t += c.step;
      return segs[s] ?? null;
    },
    now: () => c.t,
  };
}

const base = (o: Partial<ScanOptions> & Pick<ScanOptions, "current" | "read" | "now">): ScanOptions => ({ terms: [], maxHits: 10, ...o });

// ---------- 纯函数 ----------

describe("消息拆部分", () => {
  test("用户：文字，图片写 [图片]；交接说明单独一类", () => {
    assert.deepEqual(messageParts(user("你好")), [{ kind: "user", text: "你好" }]);
    const withImage = { role: "user", content: [text("看"), { type: "image", data: "blob:abc", mimeType: "image/png" }], timestamp: T };
    assert.deepEqual(messageParts(withImage), [{ kind: "user", text: "看\n[图片]" }]);
    assert.deepEqual(messageParts(handoff("目标")).map((p) => p.kind), ["handoff"]);
  });

  test("助手：每个文字块、每个调用各一部分；思考块不要", () => {
    const m = asst({ type: "thinking", thinking: "秘密思考" }, text("先看看"), call("c1", "bash", { command: "ls" }), text("再说"));
    assert.deepEqual(messageParts(m), [
      { kind: "assistant", text: "先看看" },
      { kind: "tool_call", tool: "bash", text: "bash command=ls" },
      { kind: "assistant", text: "再说" },
    ]);
    assert.ok(!JSON.stringify(messageParts(m)).includes("秘密思考"));
  });

  test("工具调用的可搜文字：参数的值按原文，不经 JSON 转义（反斜杠、引号、换行）", () => {
    assert.equal(callText("read", { path: String.raw`E:\tau\src\memory\kv.ts` }), String.raw`read path=E:\tau\src\memory\kv.ts`);
    assert.equal(callText("bash", { command: 'grep -n "version" src/memory/kv.ts\nnode --test' }), 'bash command=grep -n "version" src/memory/kv.ts\nnode --test');
    assert.ok(!callText("write", { path: "a", content: "第一行\n第二行" }).includes("\\n"));
  });

  test("工具调用的可搜文字：数字、布尔、null 写 JSON；嵌套的对象和数组展开；没有参数只有工具名", () => {
    assert.equal(callText("t", { n: 1, ok: true, none: null }), "t n=1 ok=true none=null");
    assert.equal(callText("edit", { path: "a.ts", edits: [{ oldText: 'f("x")', newText: String.raw`g("C:\y")` }, { oldText: "b", newText: "c" }] }), String.raw`edit path=a.ts oldText=f("x") newText=g("C:\y") oldText=b newText=c`);
    assert.equal(callText("wait", { processes: ["a1", "b2"], timeout: 5 }), "wait processes=a1 processes=b2 timeout=5");
    assert.equal(callText("t", {}), "t");
    assert.equal(callText("t", undefined), "t");
    assert.equal(callText("t", "不是对象"), "t");
  });

  test("工具结果：文字，带工具名；图片写 [图片]", () => {
    const m = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [text("第一行"), { type: "image", data: "blob:x", mimeType: "image/png" }], isError: false, timestamp: T };
    assert.deepEqual(messageParts(m), [{ kind: "tool_result", tool: "read", text: "第一行\n[图片]" }]);
  });

  test("这两个工具自己的调用和结果不要；别的工具的照常", () => {
    assert.deepEqual(messageParts(asst(call("c1", "history_search", { query: "x" }), call("c2", "history_read", { at: "1:0" }))), []);
    assert.deepEqual(messageParts(result("c1", "history_search", "回声")), []);
    assert.deepEqual(messageParts(result("c2", "history_read", "回声")), []);
    assert.equal(messageParts(asst(call("c3", "history_search", {}), call("c4", "bash", { command: "ls" }))).length, 1);
    assert.equal(messageParts(result("c5", "peek", "x")).length, 1);
  });

  test("不认识的消息：没有部分", () => {
    assert.deepEqual(messageParts({ role: "system", content: "x" }), []);
    assert.deepEqual(messageParts(null), []);
  });
});

describe("位置", () => {
  test("合法：段号从 1 起，序号从 0 起", () => {
    assert.deepEqual(parsePos("3:12"), { seg: 3, seq: 12 });
    assert.deepEqual(parsePos("1:0"), { seg: 1, seq: 0 });
    assert.deepEqual(parsePos("120:4500"), { seg: 120, seq: 4500 });
  });

  test("非法", () => {
    for (const bad of ["0:1", "3", "3:", ":3", "3:-1", "a:b", "03:1", "1:2:3", " 1:2", "1:2 ", "1.5:2", "", "99999999999999999999:1", 3, null, undefined, { seg: 1 }]) assert.equal(parsePos(bad), null, String(bad));
  });
});

describe("查询", () => {
  test("空白分开的多个词，转小写", () => {
    assert.deepEqual(parseQuery("npm  test\t失败\nABC"), ["npm", "test", "失败", "abc"]);
  });

  test("双引号括起来的短语算一个词", () => {
    assert.deepEqual(parseQuery('"npm test" 失败'), ["npm test", "失败"]);
    assert.deepEqual(parseQuery('a "b  c" d'), ["a", "b  c", "d"]);
    assert.deepEqual(parseQuery('"  x y  "'), ["x y"]);
  });

  test("引号不成对：剩下的算一个词", () => {
    assert.deepEqual(parseQuery('abc "def ghi'), ["abc", "def ghi"]);
    assert.deepEqual(parseQuery('"'), []);
  });

  test("没有词", () => {
    assert.deepEqual(parseQuery("   "), []);
    assert.deepEqual(parseQuery('""'), []);
  });

  test("匹配：每个词都要出现，顺序不限，不分大小写，中文也行；返回第一个词的位置", () => {
    const t = fold("The Quick brown 狐狸 jumps");
    assert.equal(matchAt(t, parseQuery("quick fox")), -1);
    assert.equal(matchAt(t, parseQuery("狐狸 QUICK")), t.indexOf("狐狸"));
    assert.equal(matchAt(t, parseQuery("jumps the")), t.indexOf("jumps"));
    assert.equal(matchAt(t, parseQuery("狐狸 猫")), -1);
    assert.equal(matchAt(t, []), 0);
  });

  test("匹配的词是原文片段，不是正则", () => {
    assert.equal(matchAt(fold("a.b a+b"), parseQuery("a+b")), 4);
    assert.equal(matchAt(fold("axb"), parseQuery("a.b")), -1);
  });

  test("折叠不改长度：İ 之后的位置仍和原文对得上", () => {
    const s = "İstanbul 的 ERROR 日志";
    assert.equal(fold(s).length, s.length);
    const at = matchAt(fold(s), parseQuery("error"));
    assert.equal(s.slice(at, at + 5), "ERROR");
    assert.equal(matchAt(fold(s), parseQuery("istanbul")), 0);
  });
});

describe("字节、截断、片段", () => {
  test("按 UTF-8 字节截断：中文 3 字节，代理对 4 字节，不劈开", () => {
    assert.equal(byteEnd("中".repeat(10), 0, 10), 3);
    assert.equal(byteEnd("中".repeat(10), 0, 9), 3);
    assert.equal(byteEnd("中".repeat(10), 0, 8), 2);
    assert.equal(byteEnd("a😀b", 0, 4), 1);
    assert.equal(byteEnd("a😀b", 0, 5), 3);
    assert.equal(byteEnd("a😀b", 1, 4), 3);
    assert.equal(byteEnd("abc", 0, 100), 3);
    const s = "混😀合😀文".repeat(1000);
    for (const max of [1, 5, 7, 100, 1001, 4096]) {
      const end = byteEnd(s, 0, max);
      const part = s.slice(0, end);
      assert.ok(byteLength(part) <= max, String(max));
      assert.ok(!part.includes("\uFFFD") && Buffer.from(part).toString("utf8") === part, `${max}：劈开了代理对`);
    }
  });

  test("整段不超字节上限，截了写明", () => {
    const s = "😀中".repeat(5000);
    const out = capBytes(s, 1000);
    assert.ok(byteLength(out) <= 1000);
    assert.ok(out.endsWith("（输出超过上限，已截）"));
    assert.ok(Buffer.from(out).toString("utf8") === out);
    assert.equal(capBytes("短", 1000), "短");
  });

  test("clip：含省略号不超过上限，不劈开代理对", () => {
    assert.equal(clip("abc", 5), "abc");
    assert.equal(clip("abcdef", 5), "abcd…");
    const c = clip("😀".repeat(30), 10);
    assert.ok(c.length <= 10 && Buffer.from(c).toString("utf8") === c);
  });

  test("片段：命中位置前 40、后 200 字符，换行换成空格，截断处写省略号", () => {
    const t = `${"前".repeat(100)}命中${"后".repeat(300)}`;
    const s = snippetOf(t, 100);
    assert.equal(s, `…${"前".repeat(40)}命中${"后".repeat(198)}…`);
    assert.equal(snippetOf("第一行\n第二行\r\n第三行", 0), "第一行 第二行 第三行");
    assert.equal(snippetOf("短文", 0), "短文");
  });

  test("片段：边界落在代理对中间也不劈开", () => {
    const t = "😀".repeat(400);
    for (const at of [0, 1, 40, 41, 81, 82, 199, 200, 301]) {
      const s = snippetOf(t, at).replaceAll("…", "");
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s), `at=${at}`);
    }
  });
});

describe("摘要、时间、配对", () => {
  test("参数摘要：command、path、file_path、pattern、query、url 里第一个有的字符串", () => {
    assert.equal(summarize({ path: "a.txt", command: "ls -l" }), "ls -l");
    assert.equal(summarize({ file_path: "b.ts", pattern: "x" }), "b.ts");
    assert.equal(summarize({ pattern: "TODO", query: "q" }), "TODO");
    assert.equal(summarize({ url: "http://x" }), "http://x");
    assert.equal(summarize({ command: "", path: "p" }), "p");
  });

  test("参数摘要：没有那几个键取第一个字符串值，再没有取紧凑 JSON", () => {
    assert.equal(summarize({ n: 1, other: "第一个字符串", more: "第二个" }), "第一个字符串");
    assert.equal(summarize({ n: 1, list: [1, 2] }), '{"n":1,"list":[1,2]}');
    assert.equal(summarize({}), "{}");
    assert.equal(summarize(undefined), "{}");
  });

  test("参数摘要：最多 60 字符，空白折成一个空格", () => {
    const s = summarize({ command: `echo   一\n二 ${"x".repeat(100)}` });
    assert.ok(s.length <= 60 && s.endsWith("…"), s);
    assert.ok(s.startsWith("echo 一 二 x"));
  });

  test("时间：本地时间 MM-DD HH:mm；没有就空", () => {
    assert.equal(fmtTime(new Date(2026, 10, 17, 9, 5).getTime()), "11-17 09:05");
    assert.equal(fmtTime(new Date(2026, 0, 2, 23, 59).getTime()), "01-02 23:59");
    assert.equal(fmtTime(undefined), "");
    assert.equal(fmtTime(Number.NaN), "");
    assert.equal(fmtTime("x"), "");
  });

  test("配对：同一段里按 toolCallId；配不上的没有", () => {
    const rows = rowsOf(user("x"), asst(call("c1", "bash", { command: "ls" }), call("c2", "read", { path: "a" })), result("c2", "read", "A"), result("c1", "bash", "B"), result("zz", "bash", "孤儿"));
    const p = pairsOf(rows);
    assert.deepEqual([...p.calls].map(([id, c]) => [id, c.seq, c.name]), [["c1", 1, "bash"], ["c2", 1, "read"]]);
    assert.deepEqual([...p.results], [["c2", 2], ["c1", 3], ["zz", 4]]);
    assert.equal(p.calls.get("zz"), undefined);
  });
});

describe("扫描", () => {
  const segs = (): Record<number, Row[]> => ({
    1: rowsOf(user("开工 alpha"), asst(text("跑 alpha"), call("c1", "bash", { command: "npm test 2>&1 | tail" })), result("c1", "bash", "FAIL alpha"), asst(text("结论一"))),
    2: rowsOf(handoff("交接 alpha"), asst(text("alpha 二")), result("c9", "read", "alpha 孤儿结果", true)),
    3: rowsOf(user("alpha 三"), asst(text("alpha 三的回复")), asst(text("无关"))),
  });

  test("从新到旧：先是当前段号减 1 那段，每段从最后一条往前", async () => {
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], ...fake(segs()) }));
    assert.deepEqual(r.hits.map((h) => `${h.pos.seg}:${h.pos.seq}`), ["3:1", "3:0", "2:2", "2:1", "2:0", "1:2", "1:1", "1:0"]);
    assert.equal(r.total, 8);
    assert.deepEqual(r.bySegment, [[3, 2], [2, 3], [1, 3]]);
    assert.equal(r.complete, true);
    assert.equal(r.read, 3);
    assert.deepEqual(r.missing, []);
  });

  test("max_hits 只限制显示：总数和每段的分布照数", async () => {
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], maxHits: 2, ...fake(segs()) }));
    assert.deepEqual(r.hits.map((h) => `${h.pos.seg}:${h.pos.seq}`), ["3:1", "3:0"]);
    assert.equal(r.total, 8);
    assert.deepEqual(r.bySegment, [[3, 2], [2, 3], [1, 3]]);
  });

  test("before：只搜更旧的位置，段号更小，或同一段里序号更小", async () => {
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], before: { seg: 2, seq: 1 }, ...fake(segs()) }));
    assert.deepEqual(r.hits.map((h) => `${h.pos.seg}:${h.pos.seq}`), ["2:0", "1:2", "1:1", "1:0"]);
    assert.equal(r.total, 4);
    const none = await scanHistory(base({ current: 4, terms: ["alpha"], before: { seg: 1, seq: 0 }, ...fake(segs()) }));
    assert.equal(none.total, 0);
    assert.equal(none.complete, true);
  });

  test("segment：只搜这一段，可以是当前段", async () => {
    const s = { ...segs(), 4: rowsOf(user("alpha 当前")) };
    const two = await scanHistory(base({ current: 4, terms: ["alpha"], segment: 2, ...fake(s) }));
    assert.deepEqual(two.bySegment, [[2, 3]]);
    const cur = await scanHistory(base({ current: 4, terms: ["alpha"], segment: 4, ...fake(s) }));
    assert.deepEqual(cur.hits.map((h) => `${h.pos.seg}:${h.pos.seq}`), ["4:0"]);
    // 不带 segment 时当前段不搜。
    const all = await scanHistory(base({ current: 4, terms: ["alpha 当前"], ...fake(s) }));
    assert.equal(all.total, 0);
  });

  test("scope：范围里要扫几段；before 之外的段不算在里面", async () => {
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], ...fake(segs()) }))).scope, 3);
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], segment: 2, ...fake(segs()) }))).scope, 1);
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], before: { seg: 2, seq: 1 }, ...fake(segs()) }))).scope, 2);
    // before 的序号是 0：这一段没有更旧的位置，它自己也不算进范围。
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], before: { seg: 2, seq: 0 }, ...fake(segs()) }))).scope, 1);
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], segment: 3, before: { seg: 3, seq: 0 }, ...fake(segs()) }))).scope, 0);
    // segment 与 before 冲突：范围是空的，和“这个进程没有旧段”不是一回事。
    assert.equal((await scanHistory(base({ current: 4, terms: ["alpha"], segment: 2, before: { seg: 1, seq: 0 }, ...fake(segs()) }))).scope, 0);
    assert.equal((await scanHistory(base({ current: 1, terms: ["alpha"], ...fake({}) }))).scope, 0);
  });

  test("读不到的段：跳过，记下，不中断", async () => {
    const s: Record<number, Row[] | null> = { ...segs(), 2: null };
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], ...fake(s) }));
    assert.deepEqual(r.missing, [2]);
    assert.equal(r.read, 2);
    assert.deepEqual(r.bySegment, [[3, 2], [1, 3]]);
    assert.equal(r.complete, true);
  });

  test("时间到了：没扫完，写下第一个没扫的段；用它续搜能接上", async () => {
    const clock = { t: 0, step: 30_000 };
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], ...fake(segs(), clock) }));
    assert.equal(r.complete, false);
    assert.equal(r.resumeSeg, 1);
    assert.equal(r.read, 2);
    assert.deepEqual(r.bySegment, [[3, 2], [2, 3]]);
    const rest = await scanHistory(base({ current: 4, terms: ["alpha"], before: { seg: 2, seq: 0 }, ...fake(segs()) }));
    assert.deepEqual(rest.bySegment, [[1, 3]]);
    assert.equal(rest.complete, true);
  });

  test("时间用注入的时钟：预算由参数给", async () => {
    const clock = { t: 0, step: 1000 };
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], budgetMs: 500, ...fake(segs(), clock) }));
    assert.equal(r.complete, false);
    assert.equal(r.resumeSeg, 2);
  });

  test("一条消息最多算一个命中：第一个匹配的部分", async () => {
    const s = { 1: rowsOf(asst(text("看 foo"), call("c1", "bash", { command: "foo" }))) };
    const r = await scanHistory(base({ current: 2, terms: ["foo"], ...fake(s) }));
    assert.equal(r.total, 1);
    assert.equal(r.hits[0]!.kind, "assistant");
    const calls = await scanHistory(base({ current: 2, terms: ["foo"], kind: "tool_call", ...fake(s) }));
    assert.equal(calls.hits[0]!.kind, "tool_call");
  });

  test("kind：user 不含交接说明，handoff 只含交接说明", async () => {
    const s = { 1: rowsOf(handoff("目标"), user("目标"), asst(text("目标"))) };
    const u = await scanHistory(base({ current: 2, terms: ["目标"], kind: "user", ...fake(s) }));
    assert.deepEqual(u.hits.map((h) => h.pos.seq), [1]);
    const h = await scanHistory(base({ current: 2, terms: ["目标"], kind: "handoff", ...fake(s) }));
    assert.deepEqual(h.hits.map((x) => x.pos.seq), [0]);
    const a = await scanHistory(base({ current: 2, terms: ["目标"], kind: "assistant", ...fake(s) }));
    assert.deepEqual(a.hits.map((x) => x.pos.seq), [2]);
  });

  test("tool：工具名精确匹配；不给 kind 时只考虑调用和结果", async () => {
    const s = { 1: rowsOf(user("bash 是什么"), asst(text("bash"), call("c1", "bash", { command: "ls" })), result("c1", "bash", "文件"), asst(call("c2", "read", { path: "ls" })), result("c2", "read", "ls 的内容")) };
    const t = await scanHistory(base({ current: 2, terms: ["ls"], tool: "bash", ...fake(s) }));
    assert.deepEqual(t.hits.map((h) => [h.pos.seq, h.kind]), [[1, "tool_call"]]);
    const all = await scanHistory(base({ current: 2, terms: [], tool: "bash", ...fake(s) }));
    assert.deepEqual(all.hits.map((h) => [h.pos.seq, h.kind]), [[2, "tool_result"], [1, "tool_call"]]);
    const onlyResults = await scanHistory(base({ current: 2, terms: [], tool: "bash", kind: "tool_result", ...fake(s) }));
    assert.deepEqual(onlyResults.hits.map((h) => h.pos.seq), [2]);
    const none = await scanHistory(base({ current: 2, terms: [], tool: "bas", ...fake(s) }));
    assert.equal(none.total, 0);
  });

  test("Windows 路径和带引号的命令：按原文写 query 就能搜到调用，片段里的词也能抄回去搜", async () => {
    const path = String.raw`E:\tau\src\memory\kv.ts`;
    const cmd = 'grep -n "version" src/memory/kv.ts\nnode --test';
    const s = { 1: rowsOf(user("开工"), asst(call("c1", "read", { path }), call("c2", "bash", { command: cmd })), result("c1", "read", "export const x = 1"), result("c2", "bash", "12: version")) };
    const hitsOf = async (query: string, kind?: ScanOptions["kind"]) => (await scanHistory(base({ current: 2, terms: parseQuery(query), kind, ...fake(s) }))).hits.map((h) => `${h.pos.seg}:${h.pos.seq}`);
    for (const q of [path, String.raw`src\memory\kv.ts`, String.raw`E:\TAU\SRC`, "kv.ts", `read ${path}`]) assert.deepEqual(await hitsOf(q, "tool_call"), ["1:1"], q);
    for (const q of ['grep -n "version"', 'grep "version"', "grep version", 'version" src/memory', "node --test"])assert.deepEqual(await hitsOf(q, "tool_call"), ["1:1"], q);
    // 不写 kind 也一样；调用的文字不会被当成结果的文字。
    assert.deepEqual(await hitsOf(path), ["1:1"]);
    assert.deepEqual(await hitsOf(path, "tool_result"), []);
    // 命中的片段里是原文，不是转义后的文字。
    const r = await scanHistory(base({ current: 2, terms: parseQuery("grep version"), ...fake(s) }));
    assert.equal(r.hits[0]!.snippet, 'bash command=grep -n "version" src/memory/kv.ts node --test');
    const out = formatSearch(await scanHistory(base({ current: 2, terms: parseQuery(path), ...fake(s) })), { current: 2 });
    assert.ok(out.includes(`tool_call（read）：read path=${path}`), out);
    assert.ok(!out.includes("没有命中"), out);
  });

  test("不写查询：按类型列出，片段从开头取", async () => {
    const r = await scanHistory(base({ current: 4, kind: "handoff", ...fake(segs()) }));
    assert.equal(r.total, 1);
    assert.equal(r.hits[0]!.snippet, "交接 alpha");
  });

  test("交接说明：可搜的文字去掉开头和中间的固定文字，片段和查询都不靠它", async () => {
    assert.equal(HANDOFF_HEADER, KERNEL_HANDOFF_HEADER, "和内核的固定文字一致");
    assert.equal(CARRY_HEADER, KERNEL_CARRY_HEADER, "和内核的固定文字一致");
    assert.deepEqual(messageParts(handoff("目标是 X")), [{ kind: "handoff", text: "目标是 X" }]);
    // 没有这句固定文字（不该有，但不能因此丢内容）：原样。
    assert.deepEqual(messageParts(user("没有开头", { tau: { letters: [], handoff: true } })), [{ kind: "handoff", text: "没有开头" }]);
    // 带过去的信：内核在中间写的那句固定文字也去掉，信本身照常可搜。
    assert.deepEqual(messageParts(user(`${HANDOFF_HEADER}目标\n\n${CARRY_HEADER}\n\n进入第二段`, { tau: { letters: [], handoff: true } })), [{ kind: "handoff", text: "目标\n\n进入第二段" }]);
    const s = { 1: rowsOf(handoff("目标是 X"), user("交接说明 在这里")) };
    // 固定文字里的词搜不到交接说明，用户消息里写了就是用户消息的命中。
    const header = await scanHistory(base({ current: 2, terms: parseQuery("上一个工作段结束时写的"), ...fake(s) }));
    assert.equal(header.total, 0);
    const kindHandoff = await scanHistory(base({ current: 2, terms: parseQuery("交接说明"), kind: "handoff", ...fake(s) }));
    assert.equal(kindHandoff.total, 0);
    const all = await scanHistory(base({ current: 2, terms: parseQuery("交接说明"), ...fake(s) }));
    assert.deepEqual(all.hits.map((h) => [h.pos.seq, h.kind]), [[1, "user"]]);
    // 正文里的词照常命中，片段从正文取。
    const body = await scanHistory(base({ current: 2, terms: parseQuery("目标"), kind: "handoff", ...fake(s) }));
    assert.deepEqual(body.hits.map((h) => [h.pos.seq, h.snippet]), [[0, "目标是 X"]]);
    // 中间那句固定文字也不靠它命中。
    const carry = { 1: rowsOf(user(`${HANDOFF_HEADER}目标\n\n${CARRY_HEADER}\n\n进入第二段 alpha`, { tau: { letters: [], handoff: true } })) };
    assert.equal((await scanHistory(base({ current: 2, terms: parseQuery("没处理的用户消息"), kind: "handoff", ...fake(carry) }))).total, 0);
    assert.equal((await scanHistory(base({ current: 2, terms: parseQuery("进入第二段"), kind: "handoff", ...fake(carry) }))).total, 1);
    // 带过去的信、图片：开头的固定文字照样去掉。
    const withImage = { role: "user", content: [text(`${HANDOFF_HEADER}目标\n\n${CARRY_HEADER}`), { type: "image", data: "blob:x", mimeType: "image/png" }], timestamp: T, tau: { letters: [], handoff: true } };
    assert.deepEqual(messageParts(withImage), [{ kind: "handoff", text: "目标\n[图片]" }]);
  });

  test("命中带时间；工具结果带对应调用的摘要，配不上只写工具名，出错写明", async () => {
    const r = await scanHistory(base({ current: 4, terms: ["alpha"], kind: "tool_result", ...fake(segs()) }));
    assert.deepEqual(r.hits.map((h) => [h.pos.seg, h.detail]), [[2, "read，出错"], [1, "bash：npm test 2>&1 | tail"]]);
    assert.equal(r.hits[0]!.time, "11-17 09:05");
    const noTime = await scanHistory(base({ current: 2, terms: ["x"], ...fake({ 1: rowsOf({ role: "user", content: "x" }) }) }));
    assert.equal(noTime.hits[0]!.time, "");
  });

  test("用户消息带发送者：别的进程的信写进程和预设", async () => {
    const letter = user("转告", { tau: { letters: [{ from: { kind: "process", id: "ab", preset: "worker" }, hops: 1 }, { from: { kind: "user" }, hops: 0 }] } });
    const r = await scanHistory(base({ current: 2, terms: ["转告"], ...fake({ 1: rowsOf(letter, user("转告")) }) }));
    assert.deepEqual(r.hits.map((h) => h.detail), ["用户", "进程 ab（预设 worker）、用户"]);
  });

  test("没有旧段：什么都不读", async () => {
    let reads = 0;
    const r = await scanHistory(base({ current: 1, terms: ["x"], read: async () => (reads++, null), now: () => 0 }));
    assert.deepEqual([reads, r.read, r.total, r.complete], [0, 0, 0, true]);
  });
});

describe("搜索结果的文字", () => {
  const view = (current: number, extra: Record<string, unknown> = {}) => ({ current, ...extra });

  test("提示、范围、计数、命中；位置写成 [段:序]", async () => {
    const s = {
      1: rowsOf(user("开工"), asst(call("c1", "bash", { command: "npm test" })), result("c1", "bash", "FAIL 失败了")),
      2: rowsOf(user("再来"), asst(text("好"))),
    };
    const r = await scanHistory(base({ current: 3, terms: ["失败"], ...fake(s) }));
    const out = formatSearch(r, view(3)).split("\n");
    assert.equal(out[0], NOTICE);
    assert.equal(out[1], "范围：当前是第 3 段，旧段共 2 个。");
    assert.equal(out[2], "命中 1 条（第 1 段 1 条）：");
    assert.equal(out[3], "[1:2] 11-17 09:05 tool_result（bash：npm test）：FAIL 失败了");
    assert.equal(out.length, 4);
  });

  test("命中比 max_hits 多：计数照数，写“还有更旧的命中：before=最后一条显示的位置”", async () => {
    const s = { 1: rowsOf(user("x 一"), user("x 二")), 2: rowsOf(user("x 三"), user("x 四"), user("x 五")) };
    const r = await scanHistory(base({ current: 3, terms: ["x"], maxHits: 2, ...fake(s) }));
    const out = formatSearch(r, view(3));
    assert.match(out, /命中 5 条（第 2 段 3 条、第 1 段 2 条），显示最近 2 条：/);
    assert.ok(out.endsWith("还有更旧的命中：其它参数照旧，加上 before=2:1"), out);
    assert.equal(out.split("\n").filter((l) => l.startsWith("[")).length, 2);
  });

  test("分布最多列 10 段，多的写“…另有 M 段”", async () => {
    const s: Record<number, Row[]> = {};
    for (let i = 1; i <= 12; i++) s[i] = rowsOf(user("命中"));
    const r = await scanHistory(base({ current: 13, terms: ["命中"], maxHits: 30, ...fake(s) }));
    const out = formatSearch(r, view(13));
    assert.match(out, /命中 12 条（第 12 段 1 条、第 11 段 1 条.*第 3 段 1 条、…另有 2 段）/);
    assert.ok(!out.includes("第 2 段 1 条"));
  });

  test("时间到了：写“至少”，原因，零命中不等于没有，续搜的 before", async () => {
    const s = { 1: rowsOf(user("x")), 2: rowsOf(user("x")), 3: rowsOf(user("x")) };
    const r = await scanHistory(base({ current: 4, terms: ["x"], ...fake(s, { t: 0, step: 30_000 }) }));
    const out = formatSearch(r, view(4));
    assert.match(out, /至少命中 2 条/);
    assert.match(out, /时间到了（40 秒），第 1 段和更旧的段没扫/);
    assert.match(out, /零命中不等于没有/);
    assert.ok(out.endsWith("续搜：其它参数照旧，加上 before=2:0"), out);
    // 时间到了又零命中。
    const zero = await scanHistory(base({ current: 4, terms: ["没有的词"], ...fake(s, { t: 0, step: 30_000 }) }));
    const zeroOut = formatSearch(zero, view(4));
    assert.match(zeroOut, /目前没有命中/);
    assert.match(zeroOut, /零命中不等于没有/);
    assert.ok(!zeroOut.includes("没有命中。换个词"));
  });

  test("时间到了又有没显示的命中：续搜从最后一条显示的位置接", async () => {
    const s = { 1: rowsOf(user("x")), 2: rowsOf(user("x"), user("x")), 3: rowsOf(user("x")) };
    const r = await scanHistory(base({ current: 4, terms: ["x"], maxHits: 1, ...fake(s, { t: 0, step: 30_000 }) }));
    const out = formatSearch(r, view(4));
    assert.match(out, /还有更旧的命中没显示/);
    assert.ok(out.endsWith("续搜：其它参数照旧，加上 before=3:0"), out);
  });

  test("零命中且扫完：说怎么办", async () => {
    const r = await scanHistory(base({ current: 3, terms: ["没有的词"], ...fake({ 1: rowsOf(user("x")), 2: rowsOf(user("y")) }) }));
    const out = formatSearch(r, view(3));
    assert.ok(out.endsWith("没有命中。换个词，或者少写几个词（多个词要同时出现）；kind: handoff 可以看各段的交接说明。"), out);
    assert.ok(!out.includes("零命中不等于没有"));
  });

  test("读不到的段：连续的写成“第 a–b 段”", async () => {
    const r = await scanHistory(base({ current: 7, terms: ["x"], ...fake({ 4: rowsOf(user("x")), 6: rowsOf(user("x")) }) }));
    assert.equal(formatSearch(r, view(7)).split("\n")[1], "范围：当前是第 7 段，旧段共 6 个，读不到的：第 1–3 段、第 5 段（多半已被清理）。");
  });

  test("没有旧段：不是错误，写明", async () => {
    const r = await scanHistory(base({ current: 1, terms: ["x"], ...fake({}) }));
    const out = formatSearch(r, view(1));
    assert.ok(out.endsWith("这个进程还没有旧段。当前段的内容你已经有了。"), out);
    assert.ok(!out.includes("没有命中"));
  });

  test("旧段全被清理：写明", async () => {
    const r = await scanHistory(base({ current: 3, terms: ["x"], ...fake({}) }));
    const out = formatSearch(r, view(3));
    assert.match(out, /读不到的：第 1–2 段/);
    assert.ok(out.endsWith("这个进程还没有可搜的旧段：第 1–2 段都已被清理或读不到。"), out);
  });

  test("范围行写明 segment 和 before 的限制", async () => {
    const r = await scanHistory(base({ current: 5, terms: ["x"], segment: 2, before: { seg: 2, seq: 9 }, ...fake({ 2: rowsOf(user("x")) }) }));
    assert.equal(formatSearch(r, view(5, { segment: 2, before: { seg: 2, seq: 9 } })).split("\n")[1], "范围：当前是第 5 段，旧段共 4 个；只搜第 2 段；只搜比 2:9 更旧的位置。");
  });

  test("范围是空的：segment 与 before 冲突，不写成“还没有旧段”", async () => {
    const r = await scanHistory(base({ current: 5, terms: ["x"], segment: 2, before: { seg: 1, seq: 0 }, ...fake({ 2: rowsOf(user("x")) }) }));
    assert.deepEqual([r.scope, r.read, r.complete], [0, 0, true]);
    const out = formatSearch(r, view(5, { segment: 2, before: { seg: 1, seq: 0 } }));
    assert.ok(out.endsWith("范围是空的：第 2 段不比 1:0 更旧。去掉 before，或者把 segment 换成更旧的段。"), out);
    assert.ok(!out.includes("还没有旧段"));
  });

  test("一段都没扫到：写“还不知道有没有命中”，不写“没有命中”", async () => {
    const s = { 1: rowsOf(user("x")) };
    // 预算一开始就到期：一段都没读。
    const zero = await scanHistory(base({ current: 3, terms: ["x"], budgetMs: 0, ...fake(s) }));
    assert.deepEqual([zero.read, zero.scope, zero.complete], [0, 2, false]);
    const out = formatSearch(zero, view(3));
    assert.ok(out.includes("一段都没扫到，还不知道有没有命中。"), out);
    assert.ok(!out.includes("目前没有命中"));
    // 读了但段没了，也没扫完。
    const gone = await scanHistory(base({ current: 4, terms: ["x"], budgetMs: 1, ...fake({}, { t: 0, step: 30_000 }) }));
    assert.deepEqual([gone.read, gone.missing, gone.complete], [0, [3], false]);
    assert.ok(formatSearch(gone, view(4)).includes("一段都没扫到，还不知道有没有命中。"));
    // 续搜的 before 不超过当前段：超了会被 history_search 的参数校验拒掉。
    const seg = await scanHistory(base({ current: 4, terms: ["x"], segment: 4, budgetMs: 0, ...fake(s) }));
    assert.ok(formatSearch(seg, view(4, { segment: 4 })).trimEnd().endsWith("续搜：其它参数照旧，加上 before=4:0"));
  });

  test("before 到最早的位置、segment 与 before 取不出位置：各自说清，不提示“换个词”", async () => {
    const oldest = await scanHistory(base({ current: 4, terms: ["x"], before: { seg: 1, seq: 0 }, ...fake({ 1: rowsOf(user("x")) }) }));
    assert.equal(oldest.scope, 0);
    assert.ok(formatSearch(oldest, view(4, { before: { seg: 1, seq: 0 } })).endsWith("1:0 之前没有内容，已经到最早的位置了。去掉 before 可以搜全部旧段。"));
    // segment 撞上 before 的序号 0：这一段没有比 3:0 更旧的位置，换词也没用。
    const same = await scanHistory(base({ current: 4, terms: ["x"], segment: 3, before: { seg: 3, seq: 0 }, ...fake({ 3: rowsOf(user("x")) }) }));
    assert.equal(same.scope, 0);
    assert.ok(formatSearch(same, view(4, { segment: 3, before: { seg: 3, seq: 0 } })).endsWith("范围是空的：第 3 段不比 3:0 更旧。去掉 before，或者把 segment 换成更旧的段。"));
    const older = await scanHistory(base({ current: 4, terms: ["y"], before: { seg: 2, seq: 0 }, ...fake({ 1: rowsOf(user("x")) }) }));
    assert.ok(formatSearch(older, view(4, { before: { seg: 2, seq: 0 } })).endsWith("在 2:0 之前没有命中。换个词，或者少写几个词。"));
    // 没给 before 时照旧。
    const plain = await scanHistory(base({ current: 2, terms: ["没有的词"], ...fake({ 1: rowsOf(user("x")) }) }));
    assert.ok(formatSearch(plain, view(2)).endsWith("没有命中。换个词，或者少写几个词（多个词要同时出现）；kind: handoff 可以看各段的交接说明。"));
  });

  test("before 之前的段读不到：说清是这个范围，不写“这个进程还没有可搜的旧段”", async () => {
    const r = await scanHistory(base({ current: 4, terms: ["x"], before: { seg: 2, seq: 0 }, ...fake({}) }));
    assert.deepEqual([r.scope, r.read, r.missing, r.complete], [1, 0, [1], true]);
    const out = formatSearch(r, view(4, { before: { seg: 2, seq: 0 } }));
    assert.ok(out.endsWith("2:0 之前的旧段都读不到：第 1 段（多半已被清理）。去掉 before 可以搜其它旧段。"), out);
    assert.ok(!out.includes("这个进程还没有可搜的旧段"));
  });

  test("segment 指向被删的段：写明下一步", async () => {
    const r = await scanHistory(base({ current: 3, terms: ["x"], segment: 2, ...fake({}) }));
    const out = formatSearch(r, view(3, { segment: 2 }));
    assert.ok(out.endsWith("这一段读不到，没有可搜的内容。去掉 segment 可以搜其它旧段。"), out);
  });

  test("输出到上限：少显示命中，计数照数，续搜指到最后一条显示的", async () => {
    const s: Record<number, Row[]> = {};
    for (let seg = 1; seg <= 3; seg++) s[seg] = rowsOf(...Array.from({ length: 10 }, (_, i) => user(`${"文".repeat(100)}词${"文".repeat(400)}${seg}-${i}`)));
    const r = await scanHistory(base({ current: 4, terms: ["词"], maxHits: 30, ...fake(s) }));
    assert.equal(r.hits.length, 30);
    const out = formatSearch(r, view(4));
    assert.ok(byteLength(out) <= SEARCH_BYTES, `${byteLength(out)} 字节`);
    assert.match(out, /命中 30 条（第 3 段 10 条、第 2 段 10 条、第 1 段 10 条），显示最近 (\d+) 条：/);
    const shown = Number(/显示最近 (\d+) 条/.exec(out)![1]);
    assert.ok(shown >= 1 && shown < 30, String(shown));
    const lines = out.split("\n").filter((l) => l.startsWith("["));
    assert.equal(lines.length, shown);
    const last = /^\[(\d+:\d+)\]/.exec(lines.at(-1)!)![1];
    assert.ok(out.endsWith(`还有更旧的命中：其它参数照旧，加上 before=${last}`), out.slice(-80));
  });
});

describe("读一条消息的文字", () => {
  const rows = rowsOf(
    user("开头"),
    asst({ type: "thinking", thinking: "不写的思考" }, text("我来跑"), call("c1", "bash", { command: "npm test" }), call("c2", "read", { path: "a.txt" })),
    result("c1", "bash", "FAIL"),
    result("c2", "read", "没有这个文件", true),
    asst(text("收尾")),
  );
  const at = (seq: number, extra: Partial<{ before: number; after: number; offset: number }> = {}) => ({ at: { seg: 2, seq }, before: 0, after: 0, offset: 0, ...extra });

  test("单条：标题行，正文；调用写成“调用 name {JSON}”，思考块不写", () => {
    const out = renderRead(2, rows, at(1)).split("\n");
    assert.equal(out[0], NOTICE);
    assert.equal(out[1], "第 2 段，共 5 条。");
    assert.equal(out[2], "");
    assert.equal(out[3], "[2:1] 11-17 09:05 assistant");
    assert.equal(out[4], "对应的结果在 [2:2]（bash）、[2:3]（read）");
    assert.equal(out[5], "我来跑");
    assert.equal(out[6], '调用 bash {"command":"npm test"}');
    assert.equal(out[7], '调用 read {"path":"a.txt"}');
    assert.ok(!out.join("\n").includes("不写的思考"));
    assert.ok(!out.join("\n").includes("←目标"), "只读一条时不标目标");
  });

  test("工具结果：标题带调用的摘要，出错写明，指回调用", () => {
    const out = renderRead(2, rows, at(3));
    assert.match(out, /\[2:3\] 11-17 09:05 tool_result（read：a\.txt，出错）\n对应的调用在 \[2:1\]\n没有这个文件/);
    assert.match(renderRead(2, rows, at(2)), /tool_result（bash：npm test）\n对应的调用在 \[2:1\]\nFAIL/);
  });

  test("配不上调用的结果：只写工具名，没有配对行", () => {
    const out = renderRead(1, rowsOf(result("zz", "bash", "孤儿")), { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: 0 });
    assert.match(out, /\[1:0\] 11-17 09:05 tool_result（bash）\n孤儿/);
    assert.ok(!out.includes("对应的"));
  });

  test("前后几条：不跨段，目标标出来，邻居不写配对行", () => {
    const out = renderRead(2, rows, at(2, { before: 4, after: 4 }));
    assert.equal(out.split("\n").filter((l) => /^\[2:\d+\]/.test(l)).length, 5, "只有 5 条，不跨段");
    assert.match(out, /\[2:2\] 11-17 09:05 tool_result（bash：npm test） ←目标\n对应的调用在 \[2:1\]/);
    assert.equal(out.split("对应的").length - 1, 1, "只有目标写配对行");
    assert.ok(out.indexOf("[2:0]") < out.indexOf("[2:1]") && out.indexOf("[2:3]") < out.indexOf("[2:4]"), "按时间顺序");
    const head = renderRead(2, rows, at(0, { before: 3, after: 1 }));
    assert.ok(head.includes("[2:0]") && head.includes("[2:1]") && !head.includes("[2:2]"), "前面没有消息就从目标起");
  });

  test("交接说明、别的进程的信、图片", () => {
    const letter = user("转告", { tau: { letters: [{ from: { kind: "process", id: "ab", preset: "worker" }, hops: 1 }] } });
    const img = { role: "user", content: [text("看这张"), { type: "image", data: "blob:x", mimeType: "image/png" }], timestamp: T };
    const out = renderRead(1, rowsOf(handoff("目标是 X"), letter, img), { at: { seg: 1, seq: 0 }, before: 0, after: 2, offset: 0 });
    assert.match(out, /\[1:0\] 11-17 09:05 handoff（交接说明） ←目标\n（这是你在上一个工作段结束时写的交接说明。）\n\n目标是 X/);
    assert.match(out, /\[1:1\] 11-17 09:05 user（进程 ab（预设 worker））\n转告/);
    assert.match(out, /\[1:2\] 11-17 09:05 user（用户）\n看这张\n\[图片\]/);
  });

  test("没有文字的消息", () => {
    assert.match(renderRead(1, rowsOf(asst({ type: "thinking", thinking: "x" })), { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: 0 }), /assistant\n（这条消息没有文字）/);
  });

  test("长消息分页：一页最多 12 KiB，写明下一页的 offset；用 offset 接着读，直到末尾", () => {
    const body = `头${LONG(9000)}尾`;
    const long = rowsOf(user(body));
    let offset = 0;
    let got = "";
    for (let page = 0; page < 5; page++) {
      const out = renderRead(1, long, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset });
      assert.ok(byteLength(out) <= READ_BYTES);
      const next = /用 offset=(\d+) 接着读；共 9002 字/.exec(out);
      // 正文是一行：去掉头（提示、范围、空行、标题）和页首页尾的说明。
      got += out.split("\n").slice(4).filter((l) => !l.startsWith("（从第") && !l.startsWith("（后面还有")).join("\n");
      if (!next) break;
      assert.equal(Number(next[1]), offset + 4096, "中文一页 4096 字，12 KiB");
      offset = Number(next[1]);
      assert.match(renderRead(1, long, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset }), new RegExp(`（从第 ${offset} 字读起，共 9002 字）`));
    }
    assert.equal(got, body);
    assert.equal(offset, 8192);
  });

  test("offset 大于文字长度：错误；等于长度：写“到此为止”", () => {
    const one = rowsOf(user("四个字啊"));
    assert.throws(() => renderRead(1, one, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: 5 }), /offset=5 超过了这条消息的文字长度（4 字）/);
    assert.match(renderRead(1, one, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: 4 }), /（文字到此为止）/);
  });

  test("offset 落在代理对中间：往前挪一位，页从完整的字符开始；别的位置不动", () => {
    const one = rowsOf(user("甲🙂乙🙂丙"));
    const page = (offset: number): string => renderRead(1, one, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset });
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // 甲 0，🙂 1–2，乙 3，🙂 4–5，丙 6。
    for (const [offset, from] of [[2, 1], [5, 4], [1, 1], [3, 3], [4, 4], [6, 6], [0, 0]] as const) {
      const out = page(offset);
      const body = out.split("\n").slice(4).filter((l) => !l.startsWith("（从第")).join("\n");
      assert.ok(!lone.test(out), `offset=${offset}：有孤立的代理项`);
      assert.equal(body, "甲🙂乙🙂丙".slice(from), `offset=${offset}`);
      if (from > 0) assert.ok(out.includes(`（从第 ${from} 字读起，共 7 字）`), `offset=${offset}`);
      else assert.ok(!out.includes("（从第"), `offset=${offset}`);
    }
    // 续读的 offset 照常：长消息一页结尾写的 offset 不会落在代理对中间，也不重复。
    const long = rowsOf(user("🙂".repeat(6000)));
    const first = renderRead(1, long, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: 0 });
    const next = Number(/用 offset=(\d+) 接着读/.exec(first)![1]);
    assert.equal(next, 6144, "一页 12 KiB，每个 🙂 4 字节，3072 个，6144 个 UTF-16 单元");
    assert.match(renderRead(1, long, { at: { seg: 1, seq: 0 }, before: 0, after: 0, offset: next + 1 }), new RegExp(`（从第 ${next} 字读起，共 12000 字）`));
  });

  test("邻居超过 1.5 KiB 就截，写明总字数；目标不截", () => {
    const rs = rowsOf(user(LONG(5000)), user("目标"), user(LONG(3000)));
    const out = renderRead(1, rs, { at: { seg: 1, seq: 1 }, before: 1, after: 1, offset: 0 });
    assert.match(out, /（共 5000 字，已截；要看全文就读它的位置）/);
    assert.match(out, /（共 3000 字，已截；要看全文就读它的位置）/);
    assert.ok(out.includes(LONG(512)) && !out.includes(LONG(513)), "邻居一条最多 1536 字节，中文 512 字");
    assert.match(out, /user（用户） ←目标\n目标\n\n\[1:2\]/, "目标没被截");
  });

  test("序号越界、没有消息：错误里写清", () => {
    assert.throws(() => renderRead(2, rows, at(9)), /第 2 段没有序号 9 的消息：这一段共 5 条，序号从 0 到 4/);
    assert.throws(() => renderRead(2, [], at(0)), /第 2 段没有消息/);
  });

  test("全是中文、每条都很长：输出不超过 28 KiB", () => {
    const big = rowsOf(...Array.from({ length: 12 }, (_, i) => (i % 3 === 1 ? asst(text(LONG(40_000)), call(`c${i}`, "write", { path: `文件${i}.txt`, content: LONG(30_000) })) : i % 3 === 2 ? result(`c${i - 1}`, "write", LONG(40_000)) : user(LONG(40_000)))));
    for (const seq of [0, 4, 5, 6, 11]) {
      const out = renderRead(1, big, { at: { seg: 1, seq }, before: 4, after: 4, offset: 0 });
      assert.ok(byteLength(out) <= READ_BYTES, `seq=${seq}：${byteLength(out)} 字节`);
      assert.match(out, /后面还有，用 offset=\d+ 接着读/);
    }
    // 工具名、发送者很长也不超。
    const nasty = rowsOf(...Array.from({ length: 9 }, (_, i) => result(`n${i}`, "工".repeat(200), LONG(40_000))));
    const out = renderRead(1, nasty, { at: { seg: 1, seq: 4 }, before: 4, after: 4, offset: 0 });
    assert.ok(byteLength(out) <= READ_BYTES);
  });
});

describe("参数", () => {
  test("search：默认值、词、类型", () => {
    assert.deepEqual(parseSearchArgs({}), { terms: [], maxHits: 10 });
    assert.deepEqual(parseSearchArgs({ query: '"npm test" 失败', kind: "tool_result", tool: "bash", segment: 3, max_hits: 30, before: "4:7" }), {
      terms: ["npm test", "失败"],
      maxHits: 30,
      kind: "tool_result",
      tool: "bash",
      segment: 3,
      before: { seg: 4, seq: 7 },
    });
    assert.equal(parseSearchArgs({ tool: "bash" }).tool, "bash");
    assert.equal(parseSearchArgs({ tool: "bash", kind: "tool_call" }).kind, "tool_call");
  });

  test("search：不合规矩的参数给清楚的错", () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ query: "" }, /query 必须是 1 到 256/],
      [{ query: "x".repeat(257) }, /query 必须是 1 到 256/],
      [{ query: 5 }, /query 必须是 1 到 256/],
      [{ query: '  ""  ' }, /query 里没有可搜的词/],
      [{ kind: "thinking" }, /kind 必须是/],
      [{ kind: 1 }, /kind 必须是/],
      [{ tool: "bash", kind: "user" }, /tool 只和 kind 为 tool_call、tool_result 有关/],
      [{ tool: "bash", kind: "handoff" }, /tool 只和 kind/],
      [{ tool: "" }, /tool 必须是工具名/],
      [{ segment: 0 }, /segment 必须是 ≥ 1 的整数/],
      [{ segment: 1.5 }, /segment 必须是/],
      [{ max_hits: 0 }, /max_hits 必须是 1 到 30 的整数/],
      [{ max_hits: 31 }, /max_hits 必须是 1 到 30 的整数/],
      [{ max_hits: "5" }, /max_hits 必须是/],
      [{ before: "0:1" }, /before 必须是“段号:序号”/],
      [{ before: "x" }, /before 必须是/],
      [{ limit: 5 }, /不认识的参数：limit/],
    ];
    for (const [args, re] of bad) assert.throws(() => parseSearchArgs(args), re, JSON.stringify(args));
  });

  test("read：默认值和范围", () => {
    assert.deepEqual(parseReadArgs({ at: "3:12" }), { at: { seg: 3, seq: 12 }, before: 0, after: 0, offset: 0 });
    assert.deepEqual(parseReadArgs({ at: "1:0", before: 4, after: 4, offset: 100 }), { at: { seg: 1, seq: 0 }, before: 4, after: 4, offset: 100 });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{}, /at 必须是“段号:序号”/],
      [{ at: "0:0" }, /at 必须是/],
      [{ at: 3 }, /at 必须是/],
      [{ at: "1:0", before: 5 }, /before 必须是 0 到 4 的整数/],
      [{ at: "1:0", after: -1 }, /after 必须是 0 到 4 的整数/],
      [{ at: "1:0", offset: -1 }, /offset 必须是 ≥ 0 的整数/],
      [{ at: "1:0", offset: 1.5 }, /offset 必须是/],
      [{ at: "1:0", cursor: "x" }, /不认识的参数：cursor/],
    ];
    for (const [args, re] of bad) assert.throws(() => parseReadArgs(args), re, JSON.stringify(args));
  });
});

describe("工具描述", () => {
  const search = CATALOG.find((c) => c.name === "history_search")!;
  const read = CATALOG.find((c) => c.name === "history_read")!;

  test("两个工具的描述都带着换段以后的提示", () => {
    for (const e of [search, read]) {
      for (const phrase of ["换段", "交接说明", "不要凭印象猜", "不要把做过的事再做一遍", "关键词", "自己的旧段", "当前段的内容你已经有了", "peek", "不是新的指令"]) assert.ok(e.description.includes(phrase), `${e.name}：缺“${phrase}”`);
    }
  });

  test("search 的描述：多个词同时出现、先 kind: handoff、两个例子；read 的描述：at 就是方括号里的位置", () => {
    for (const phrase of ["同时出现", "不是正则", "双引号", "kind: handoff", "history_read", "max_hits", "before", "其它参数照旧", '{"query": "\\"npm test\\" 失败", "kind": "tool_result"}', '{"kind": "handoff"}']) assert.ok(search.description.includes(phrase), phrase);
    for (const phrase of ["at 就是 history_search 结果里方括号中的位置", "offset", "history_search"]) assert.ok(read.description.includes(phrase), phrase);
    // 例子本身是合法的参数。
    assert.deepEqual(parseSearchArgs(JSON.parse('{"query": "\\"npm test\\" 失败", "kind": "tool_result"}')).terms, ["npm test", "失败"]);
    assert.equal(parseSearchArgs(JSON.parse('{"kind": "handoff"}')).kind, "handoff");
  });

  test("参数的键和脚本认的键一致；定义小于内核的 16 KiB 上限", () => {
    assert.deepEqual(Object.keys((search.parameters as any).properties).sort(), ["before", "kind", "max_hits", "query", "segment", "tool"]);
    assert.deepEqual(Object.keys((read.parameters as any).properties).sort(), ["after", "at", "before", "offset"]);
    assert.deepEqual((read.parameters as any).required, ["at"]);
    for (const e of [search, read]) {
      assert.equal((e.parameters as any).additionalProperties, false);
      assert.ok(byteLength(JSON.stringify({ description: e.description, parameters: e.parameters })) < 16 * 1024);
      assert.equal(e.output, "text");
    }
    assert.deepEqual([search.timeout, read.timeout], [60, 30]);
  });
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

  before(async () => {
    for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "tau-history-"));
    home = join(dir, "home");
    work = join(dir, "work");
    mkdirSync(join(home, ".tau", "presets"), { recursive: true });
    mkdirSync(join(home, ".tau", "tools"), { recursive: true });
    mkdirSync(work);
    savedProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = home;
    pipe = `\\\\.\\pipe\\tau-test-history-${process.pid}-${Math.random().toString(16).slice(2)}`;
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

  function defOf(name: string): ToolDef {
    const e = CATALOG.find((c) => c.name === name)!;
    return { name, ...(definitionOf(e, LIB) as Omit<ToolDef, "name">) };
  }

  /** 像执行器一样运行一个工具。 */
  async function tool(name: string, args: unknown, proc: string) {
    const r = await runToolDef(defOf(name), args, work, new AbortController().signal, { process: proc, pipe }, true);
    // 内核给每条工具结果加一行退出码：成功时去掉，方便比较结尾。
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

  const say = (t: string) => fauxAssistantMessage(fauxText(t));
  const run = (t: string, id: string, command: string) => fauxAssistantMessage([fauxText(t), fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

  /**
   * 四段：1 到 3 是旧段，4 是当前段。第 1、2、3 段各跑一条 bash。
   * 触发换段的信先写进旧段（旧段最后一条），换段后又被带进新段的第一条，所以第 1 到 3 段各 5 条，第 4 段 2 条。
   */
  let main = "";
  /** 三段，全是文字，第一条用户消息很长：给分页和 prune 用。 */
  let small = "";

  before(async () => {
    faux.setResponses([
      run("先跑测试。", "c1", "echo npm-test 失败 alpha-log"),
      say("第一段结论：alpha 已处理，beta 待办。"),
      say("交接一：目标是整理 beta，要点 delta-key。"),
      run("第二段开始。", "c2", "echo second-segment-output epsilon"),
      say("第二段结论：epsilon 已完成。"),
      say("交接二：目标是收尾，要点 eta-key。"),
      run("第三段开始。", "c3", "echo third-segment-output iota; exit 3"),
      say("第三段结论：iota 出错了。"),
      say("交接三：目标是验收，要点 kappa-key。"),
      say("第四段当前内容 theta-only-current。"),
    ]);
    main = await begin("开工：整理 alpha 文件");
    await next(main, "进入第二段 gamma");
    await next(main, "进入第三段 zeta");
    await next(main, "进入第四段 lambda");

    faux.setResponses([say("长文已收到。"), say("交接甲。"), say("第二段回复。"), say("交接乙。"), say("第三段回复。")]);
    small = await begin(`头标记${LONG(9000)}尾标记`);
    await next(small, "小的第二段 mu");
    await next(small, "小的第三段 nu");
  });

  test("造出的进程：当前段号是 4 和 3", async () => {
    const [m] = await request({ op: "inspect", process: main });
    assert.equal(m.process.segment.seq, 4);
    const [s] = await request({ op: "inspect", process: small });
    assert.equal(s.process.segment.seq, 3);
  });

  test("history_search：搜到旧段里的词，带位置、时间、对应调用的摘要", async () => {
    const r = await tool("history_search", { query: "alpha-log", kind: "tool_result" }, main);
    assert.equal(r.isError, false, r.text);
    const lines = r.text.split("\n");
    assert.equal(lines[0], NOTICE);
    assert.equal(lines[1], "范围：当前是第 4 段，旧段共 3 个。");
    assert.equal(lines[2], "命中 1 条（第 1 段 1 条）：");
    assert.match(lines[3]!, /^\[1:2\] \d\d-\d\d \d\d:\d\d tool_result（bash：echo npm-test 失败 alpha-log）：npm-test 失败 alpha-log/);
  });

  test("history_search：多个词要同时出现，顺序不限，不分大小写；短语用双引号", async () => {
    const both = await tool("history_search", { query: "EPSILON second-segment-output", kind: "tool_result" }, main);
    assert.match(both.text, /命中 1 条（第 2 段 1 条）/);
    const phrase = await tool("history_search", { query: '"npm-test 失败" alpha-log' }, main);
    assert.match(phrase.text, /\[1:2\]/);
    const wrongOrderPhrase = await tool("history_search", { query: '"失败 npm-test"' }, main);
    assert.match(wrongOrderPhrase.text, /没有命中。换个词/);
    const missing = await tool("history_search", { query: "alpha-log 不存在的词" }, main);
    assert.match(missing.text, /没有命中。换个词/);
  });

  test("history_search：搜不到当前段里的词；写明范围", async () => {
    const r = await tool("history_search", { query: "theta-only-current" }, main);
    assert.equal(r.isError, false);
    assert.match(r.text, /范围：当前是第 4 段，旧段共 3 个。/);
    assert.match(r.text, /没有命中。换个词，或者少写几个词/);
    assert.ok(!r.text.includes("[4:"));
    // 指定当前段就能搜到。
    const cur = await tool("history_search", { query: "theta-only-current", segment: 4 }, main);
    assert.match(cur.text, /只搜第 4 段/);
    assert.match(cur.text, /命中 1 条（第 4 段 1 条）/);
    assert.match(cur.text, /\[4:1\] .* assistant：第四段当前内容 theta-only-current/);
  });

  test("history_search：kind: handoff 列出各旧段的交接说明；kind 的区分", async () => {
    const r = await tool("history_search", { kind: "handoff" }, main);
    assert.match(r.text, /命中 2 条（第 3 段 1 条、第 2 段 1 条）/);
    const lines = r.text.split("\n").filter((l) => /^\[\d+:\d+\]/.test(l));
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\[3:0\] \d\d-\d\d \d\d:\d\d handoff（交接说明）：交接二：目标是收尾，要点 eta-key。/);
    assert.ok(!r.text.includes("这是你在上一个工作段结束时写的交接说明"), "片段里没有固定文字");
    assert.match(lines[1]!, /^\[2:0\] .* handoff（交接说明）：.*交接一：目标是整理 beta，要点 delta-key。/);
    // 触发换段的信留在旧段里（第 1 段最后一条，算 user），也被带进新段的第一条（交接说明，算 handoff）。
    const users = await tool("history_search", { query: "gamma", kind: "user" }, main);
    assert.match(users.text, /命中 1 条（第 1 段 1 条）/);
    assert.match(users.text, /\[1:4\] .* user（用户）：进入第二段 gamma/);
    const hand = await tool("history_search", { query: "gamma", kind: "handoff" }, main);
    assert.match(hand.text, /命中 1 条（第 2 段 1 条）/);
    assert.match(hand.text, /\[2:0\] .* handoff（交接说明）：/);
    // 带过去的信中间那句固定文字不靠它命中；信本身照常命中。
    const carry = await tool("history_search", { query: "没处理的用户消息", kind: "handoff" }, main);
    assert.match(carry.text, /没有命中/, carry.text);
    const calls = await tool("history_search", { query: "second-segment-output", kind: "tool_call" }, main);
    assert.match(calls.text, /\[2:1\] .* tool_call（bash）：/);
  });

  test("history_search：tool 筛选；tool 和别的 kind 同时给报错", async () => {
    const r = await tool("history_search", { tool: "bash", kind: "tool_result", max_hits: 5 }, main);
    assert.match(r.text, /命中 3 条（第 3 段 1 条、第 2 段 1 条、第 1 段 1 条）/);
    assert.match(r.text, /tool_result（bash：echo third-segment-output iota; exit 3，出错）/);
    const bad = await tool("history_search", { tool: "bash", kind: "user" }, main);
    assert.equal(bad.isError, true);
    assert.match(bad.text, /tool 只和 kind 为 tool_call、tool_result 有关/);
  });

  test("history_search：max_hits 只限制显示，before 接着看更旧的", async () => {
    const first = await tool("history_search", { query: "结论", max_hits: 1 }, main);
    assert.match(first.text, /命中 3 条（第 3 段 1 条、第 2 段 1 条、第 1 段 1 条），显示最近 1 条：/);
    assert.match(first.text, /\[3:3\] .* assistant：第三段结论：iota 出错了。/);
    assert.ok(first.text.trimEnd().endsWith("还有更旧的命中：其它参数照旧，加上 before=3:3"), first.text);
    const second = await tool("history_search", { query: "结论", max_hits: 1, before: "3:3" }, main);
    assert.match(second.text, /只搜比 3:3 更旧的位置/);
    assert.match(second.text, /命中 2 条（第 2 段 1 条、第 1 段 1 条），显示最近 1 条：/);
    assert.match(second.text, /\[2:3\] .* assistant：第二段结论/);
    assert.ok(second.text.trimEnd().endsWith("还有更旧的命中：其它参数照旧，加上 before=2:3"), second.text);
    const third = await tool("history_search", { query: "结论", max_hits: 1, before: "2:3" }, main);
    assert.match(third.text, /命中 1 条（第 1 段 1 条）：/);
    assert.match(third.text, /\[1:3\] .* assistant：第一段结论/);
    assert.ok(!third.text.includes("还有更旧的命中"));
  });

  test("history_search：segment 只搜一段；超出当前段报错", async () => {
    const r = await tool("history_search", { query: "结论", segment: 2 }, main);
    assert.match(r.text, /命中 1 条（第 2 段 1 条）/);
    const far = await tool("history_search", { query: "x", segment: 9 }, main);
    assert.equal(far.isError, true);
    assert.match(far.text, /没有第 9 段，现在是第 4 段/);
  });

  test("history_search：只有一段的进程：写明还没有旧段，不是错误", async () => {
    faux.setResponses([say("好。")]);
    const one = await begin("单段的进程");
    const r = await tool("history_search", { query: "单段" }, one);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /这个进程还没有旧段。当前段的内容你已经有了。/);
  });

  test("history_search：参数不对给清楚的错", async () => {
    const r = await tool("history_search", { query: "x", max_hits: 100 }, main);
    assert.equal(r.isError, true);
    assert.match(r.text, /max_hits 必须是 1 到 30 的整数/);
    // before 比当前段还新：范围行会写一句不起作用的约束，所以直接拒绝。
    const far = await tool("history_search", { query: "x", before: "9:0" }, main);
    assert.equal(far.isError, true);
    assert.match(far.text, /before 是 9:0，但现在是第 4 段/);
  });

  test("history_search：范围为空、before 到最早，各说清楚", async () => {
    const empty = await tool("history_search", { query: "结论", segment: 2, before: "1:0" }, main);
    assert.equal(empty.isError, false, empty.text);
    assert.match(empty.text, /范围是空的：第 2 段不比 1:0 更旧/);
    assert.ok(!empty.text.includes("还没有旧段"));
    const same = await tool("history_search", { query: "结论", segment: 3, before: "3:0" }, main);
    assert.match(same.text, /范围是空的：第 3 段不比 3:0 更旧/);
    const oldest = await tool("history_search", { query: "结论", before: "1:0" }, main);
    assert.ok(oldest.text.trimEnd().endsWith("1:0 之前没有内容，已经到最早的位置了。去掉 before 可以搜全部旧段。"), oldest.text);
  });

  test("history_read：读目标和前后各一条，标出配对的位置", async () => {
    const r = await tool("history_read", { at: "2:2", before: 1, after: 1 }, main);
    assert.equal(r.isError, false, r.text);
    const lines = r.text.split("\n");
    assert.equal(lines[0], NOTICE);
    assert.equal(lines[1], "第 2 段，共 5 条。");
    assert.match(r.text, /\[2:1\] \d\d-\d\d \d\d:\d\d assistant\n第二段开始。\n调用 bash \{"command":"echo second-segment-output epsilon"\}/);
    assert.match(r.text, /\[2:2\] \d\d-\d\d \d\d:\d\d tool_result（bash：echo second-segment-output epsilon） ←目标\n对应的调用在 \[2:1\]\nsecond-segment-output epsilon/);
    assert.match(r.text, /\[2:3\] \d\d-\d\d \d\d:\d\d assistant\n第二段结论：epsilon 已完成。/);
    const call = await tool("history_read", { at: "2:1" }, main);
    assert.match(call.text, /\[2:1\] .* assistant\n对应的结果在 \[2:2\]\n第二段开始。/);
  });

  test("history_read：交接说明是新段的第一条，带过去的信也在里面", async () => {
    const r = await tool("history_read", { at: "3:0" }, main);
    assert.match(r.text, /\[3:0\] .* handoff（交接说明）\n（这是你在上一个工作段结束时写的交接说明。）\n\n交接二：目标是收尾，要点 eta-key。/);
    assert.match(r.text, /进入第三段 zeta/);
  });

  test("history_read：长消息用 offset 分页，读到末尾；offset 超出报错", async () => {
    const first = await tool("history_read", { at: "1:0" }, small);
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /\[1:0\] .* user（用户）\n头标记/);
    assert.match(first.text, /（后面还有，用 offset=4096 接着读；共 9006 字）/);
    assert.ok(byteLength(first.text) <= READ_BYTES);
    const second = await tool("history_read", { at: "1:0", offset: 4096 }, small);
    assert.match(second.text, /（从第 4096 字读起，共 9006 字）/);
    assert.match(second.text, /用 offset=8192 接着读/);
    const last = await tool("history_read", { at: "1:0", offset: 8192 }, small);
    assert.ok(last.text.includes("尾标记"));
    assert.ok(!last.text.includes("后面还有"));
    const over = await tool("history_read", { at: "1:0", offset: 9007 }, small);
    assert.equal(over.isError, true);
    assert.match(over.text, /offset=9007 超过了这条消息的文字长度（9006 字）/);
  });

  test("history_read：序号越界、段不存在、位置写错都报清楚的错", async () => {
    const out = await tool("history_read", { at: "2:99" }, main);
    assert.equal(out.isError, true);
    assert.match(out.text, /第 2 段没有序号 99 的消息：这一段共 5 条，序号从 0 到 4/);
    const seg = await tool("history_read", { at: "9:0" }, main);
    assert.equal(seg.isError, true);
    assert.match(seg.text, /读不到第 9 段：进程 .* 没有第 9 段，现在是第 4 段/);
    const bad = await tool("history_read", { at: "二:0" }, main);
    assert.equal(bad.isError, true);
    assert.match(bad.text, /at 必须是“段号:序号”/);
    const noAt = await tool("history_read", {}, main);
    assert.match(noAt.text, /at 必须是/);
  });

  test("没有这个进程：错误里有服务的原因", async () => {
    const s = await tool("history_search", { query: "x" }, "nope-nope");
    assert.equal(s.isError, true);
    assert.match(s.text, /读不到进程 nope-nope/);
    const r = await tool("history_read", { at: "1:0" }, "nope-nope");
    assert.equal(r.isError, true);
    assert.match(r.text, /读不到第 1 段/);
  });

  test("prune 掉一段以后：搜索写明读不到的段，不中断；读它报错；别的段照常", async () => {
    const [receipt] = await request({ op: "prune", process: small, before: 2 });
    assert.equal(receipt.type, "receipt");
    const r = await tool("history_search", { query: "回复" }, small);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /范围：当前是第 3 段，旧段共 2 个，读不到的：第 1 段（多半已被清理）。/);
    assert.match(r.text, /命中 1 条（第 2 段 1 条）/);
    assert.match(r.text, /\[2:1\] .* assistant：第二段回复。/);
    const gone = await tool("history_search", { query: "头标记" }, small);
    assert.match(gone.text, /没有命中。换个词/);
    const read = await tool("history_read", { at: "1:0" }, small);
    assert.equal(read.isError, true);
    assert.match(read.text, /读不到第 1 段：.*第 1 段已经被删掉/);
    const ok = await tool("history_read", { at: "2:1" }, small);
    assert.match(ok.text, /第二段回复。/);
    // 旧段全被清理。
    await request({ op: "prune", process: small, before: 3 });
    const all = await tool("history_search", { query: "回复" }, small);
    assert.equal(all.isError, false);
    assert.match(all.text, /这个进程还没有可搜的旧段：第 1–2 段都已被清理或读不到。/);
  });

  test("没有 TAU_PROCESS 或 TAU_PIPE：清楚的错误", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("TAU_")) delete env[k];
    for (const [file, input] of [["history_search.ts", "{}"], ["history_read.ts", '{"at":"1:0"}']] as const) {
      const r = spawnSync(process.execPath, [`${LIB}/${file}`], { env, input, encoding: "utf8" });
      assert.equal(r.status, 1, file);
      assert.match(r.stderr, /只能在 tau 的工具调用里运行/, file);
    }
  });
});
