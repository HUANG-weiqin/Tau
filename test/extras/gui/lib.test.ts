import assert from "node:assert/strict";
import { test } from "node:test";
import { activityAt, applyFilter, attention, buildEntries, buildProjects, classify, currentOf, filterCounts, indexPresets, projectView, railSections, seenFromInspect } from "../../../extras/gui/web/lib/derive.js";
import { formatAgo, formatBytes, formatClock, formatContext, formatDuration, formatElapsed } from "../../../extras/gui/web/lib/format.js";
import { applyEnd, applyMessage, emptyHistory, giveUp, known, lastTimestamp, noteSelf, plan, segmentMessages } from "../../../extras/gui/web/lib/history.js";
import { canHandoff, CARRY_HEADER, describeNow, describeStart, foldMiddle, forkPoints, HANDOFF_HEADER, parseUser, phaseStartedAt, summarizeCall, toItems, turnStart } from "../../../extras/gui/web/lib/messages.js";
import { cleanPlan, stopOrder } from "../../../extras/gui/web/lib/order.js";
import { removePlan, skippedFor } from "../../../extras/gui/web/lib/remove.js";
import { addFork, movePinned, normalizeState, pathKey, pinFolder, prunePatch, setCurrent } from "../../../extras/gui/web/lib/state.js";
import { allProcs, childCounts, emptyStore, reduce, streamingText } from "../../../extras/gui/web/lib/store.js";
import { extractTitle, processTitle } from "../../../extras/gui/web/lib/titles.js";
import { newPace, paceArrive, paceStep } from "../../../extras/gui/web/lib/pace.js";

type Self = import("../../../extras/gui/web/lib/types.js").Self;
type Msg = import("../../../extras/gui/web/lib/types.js").Message;

const NOW = new Date(2026, 10, 17, 15, 30).getTime();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function self(id: string, o: Partial<Self> = {}): Self {
  return { id, preset: "p", model: "m/x", phase: { tag: "idle" }, age: 1000, segment: 1, segmentAge: 500, context: { used: 100, window: 1000 }, messages: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...o };
}
const running: Self["phase"] = { tag: "awaitingModel", purpose: "turn", steps: 1, queued: 0 };
const failed: Self["phase"] = { tag: "idle", ended: { error: "炸了" } };
const doneIdle: Self["phase"] = { tag: "idle", ended: "done" };
const proj = (s: Self) => ({ now: 0, self: s, siblings: [], children: [], idleChildren: 0 });
const user = (text: string, timestamp = 1): Msg => ({ role: "user", content: text, timestamp });
const asst = (content: any[], timestamp = 2): Msg => ({ role: "assistant", content, timestamp });
const result = (id: string, text: string, isError = false, timestamp = 3): Msg => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError, timestamp });
/** 内核补的工具结果：带 `tau.filled`。 */
const filled = (id: string, kind: "interrupted" | "skipped", timestamp = 3): Msg => ({ ...result(id, kind === "interrupted" ? "被中断，结果未知" : "未执行", true, timestamp), tau: { filled: kind } } as Msg);
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const text = (t: string) => ({ type: "text", text: t });

/** 内核写的用户消息：文本是各封信（可带头）用空行连起来的，`tau.letters[i].at` 指它的正文。头的文字界面不看。 */
type Part = { from: any; head?: string; body: string; hops?: number; replyTo?: string };
function tauMsg(parts: Part[], extra: { after?: any; handoff?: true; prefix?: string } = {}, timestamp = 1): Msg {
  let text = extra.prefix ?? "";
  const letters: any[] = [];
  for (const p of parts) {
    if (text !== "") text += "\n\n";
    if (p.head !== undefined) text += `${p.head}\n`;
    const start = text.length;
    text += p.body;
    letters.push({ from: p.from, hops: p.hops ?? 0, ...(p.replyTo === undefined ? {} : { replyTo: p.replyTo }), at: [start, start + p.body.length] });
  }
  return { role: "user", content: text, timestamp, tau: { letters, ...(extra.after === undefined ? {} : { after: extra.after }), ...(extra.handoff ? { handoff: true } : {}) } } as Msg;
}
const U = { kind: "user" };
const P = (id: string, preset: string) => ({ kind: "process", id, preset });
const R = (id: string, preset: string, ended: any) => ({ kind: "process", id, preset, reply: { ended } });

// ---------- store ----------

test("store: ps 整体替换，update 换一个，removed 删掉", () => {
  let s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a", { age: 4000, segmentAge: 1000 })), proj(self("b"))] }, NOW);
  assert.deepEqual(Object.keys(s.procs).sort(), ["a", "b"]);
  assert.equal(s.procs["a"]!.createdAt, NOW - 4000);
  assert.equal(s.procs["a"]!.segmentStartedAt, NOW - 1000);
  s = reduce(s, { type: "update", self: self("a", { phase: running, age: 5000, segmentAge: null }) }, NOW + 1000);
  assert.equal(s.procs["a"]!.self.phase.tag, "awaitingModel");
  assert.equal(s.procs["a"]!.createdAt, NOW - 4000);
  assert.equal(s.procs["a"]!.segmentStartedAt, null);
  s = reduce(s, { type: "ps", processes: [proj(self("b"))] }, NOW + 2000);
  assert.deepEqual(Object.keys(s.procs), ["b"]);
  s = reduce(s, { type: "removed", process: "b" }, NOW);
  assert.deepEqual(allProcs(s), []);
});

test("store: 先 ps 再 watch 的快照合并，新进程加进来，旧的被换掉", () => {
  let s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a"))] }, NOW);
  s = reduce(s, { type: "update", self: self("a", { messages: 3 }) }, NOW);
  s = reduce(s, { type: "update", self: self("c") }, NOW);
  assert.deepEqual(allProcs(s).map((r) => r.self.id), ["a", "c"]);
  assert.equal(s.procs["a"]!.self.messages, 3);
});

test("store: 流式文本按 n 重来，过时的丢掉，离开等模型就清掉", () => {
  let s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a", { phase: running }))] }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 3, delta: "你" }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 3, delta: "好" }, NOW);
  assert.equal(streamingText(s, "a"), "你好");
  s = reduce(s, { type: "text", process: "a", n: 5, delta: "新" }, NOW);
  assert.equal(streamingText(s, "a"), "新");
  s = reduce(s, { type: "text", process: "a", n: 3, delta: "旧" }, NOW);
  assert.equal(streamingText(s, "a"), "新");
  s = reduce(s, { type: "update", self: self("a", { phase: { tag: "awaitingTool", steps: 1, queued: 0 } }) }, NOW);
  assert.equal(streamingText(s, "a"), "");
  assert.equal(s.text["a"], undefined);
  // 不在等模型时到的文字也不显示。
  s = reduce(s, { type: "text", process: "a", n: 6, delta: "x" }, NOW);
  assert.equal(streamingText(s, "a"), "");
});

test("store: 重连的 ps 清掉不在等模型的流式文本", () => {
  let s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a", { phase: running }))] }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 1, delta: "x" }, NOW);
  s = reduce(s, { type: "ps", processes: [proj(self("a"))] }, NOW);
  assert.deepEqual(s.text, {});
});

test("store: childCounts 按 parent 数", () => {
  const s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a")), proj(self("b", { parent: "a" })), proj(self("c", { parent: "a" }))] }, NOW);
  assert.deepEqual(childCounts(s), { a: 2 });
});

// ---------- history ----------

function feed(h: ReturnType<typeof emptyHistory>, segment: number, from: number, count: number) {
  for (let i = 0; i < count; i++) h = applyMessage(h, { segment, seq: from + i, message: user(`m${segment}-${from + i}`, from + i) });
  return h;
}

test("history: 条数增长从已知的条数读，读完没有下一步", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 3 }));
  assert.deepEqual(plan(h, self("a", { messages: 3 })), { segment: 1, from: 0, sealed: false });
  h = feed(h, 1, 0, 3);
  h = applyEnd(h, { segment: 1, messages: 3 }, { segment: 1, from: 0, sealed: false });
  assert.equal(plan(h, self("a", { messages: 3 })), null);
  const s5 = self("a", { messages: 5 });
  h = noteSelf(h, s5);
  assert.deepEqual(plan(h, s5), { segment: 1, from: 3, sealed: false });
  h = feed(h, 1, 3, 2);
  assert.equal(plan(h, s5), null);
  assert.equal(known(h, 1), 5);
});

test("history: 换段先读完旧段剩下的，再从 0 读新段", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 3 }));
  h = feed(h, 1, 0, 3);
  h = applyEnd(h, { segment: 1, messages: 3 }, { segment: 1, from: 0, sealed: false });
  // 旧段在换段前又长到 5 条，页面没来得及读；新段 2 条。
  const s2 = self("a", { segment: 2, messages: 2 });
  h = noteSelf(h, s2);
  const p1 = plan(h, s2);
  assert.deepEqual(p1, { segment: 1, from: 3, sealed: true });
  h = feed(h, 1, 3, 2);
  h = applyEnd(h, { segment: 1, messages: 5 }, p1!);
  const p2 = plan(h, s2);
  assert.deepEqual(p2, { segment: 2, from: 0, sealed: false });
  h = feed(h, 2, 0, 2);
  assert.equal(plan(h, s2), null);
  assert.equal(segmentMessages(h, 1).length, 5);
  assert.equal(lastTimestamp(h, 2), 1);
});

test("history: 旧段在它还是当前段时读到的结尾，换段后不算数", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 3 }));
  h = feed(h, 1, 0, 3);
  h = applyEnd(h, { segment: 1, messages: 3 }, { segment: 1, from: 0, sealed: false });
  h = noteSelf(h, self("a", { segment: 2, messages: 0 }));
  assert.deepEqual(plan(h, self("a", { segment: 2, messages: 0 })), { segment: 1, from: 3, sealed: true });
});

test("history: 重连后重复读不重复，seq 说了算", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 4 }));
  h = feed(h, 1, 0, 2); // 读到一半断开
  h = feed(h, 1, 0, 4); // 重连后从头再读一遍
  assert.equal(known(h, 1), 4);
  assert.deepEqual(segmentMessages(h, 1).map((m) => m.timestamp), [0, 1, 2, 3]);
  h = applyMessage(h, { segment: 1, seq: 3, message: user("改", 9) });
  assert.equal(known(h, 1), 4);
  assert.equal(segmentMessages(h, 1)[3]!.timestamp, 9);
  h = applyMessage(h, { segment: 1, seq: 9, message: user("跳", 1) });
  assert.equal(known(h, 1), 4);
});

test("history: 断开没读完就从已知的条数接着读", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 6 }));
  h = feed(h, 1, 0, 2);
  assert.deepEqual(plan(h, self("a", { messages: 6 })), { segment: 1, from: 2, sealed: false });
});

test("history: 读不到的旧段放弃，不再重试", () => {
  let h = noteSelf(emptyHistory(), self("a", { messages: 3 }));
  const s2 = self("a", { segment: 2, messages: 1 });
  h = noteSelf(h, s2);
  assert.equal(plan(h, s2)!.segment, 1);
  h = giveUp(h, 1);
  assert.deepEqual(plan(h, s2), { segment: 2, from: 0, sealed: false });
});

test("history: 过时的 update 不会把段号拉回去", () => {
  let h = noteSelf(emptyHistory(), self("a", { segment: 2, messages: 1 }));
  h = noteSelf(h, self("a", { segment: 1, messages: 5 }));
  assert.equal(h.followed, 2);
});

// ---------- titles ----------

test("titles: 第一封信正文的第一行；信头和说明不算，没有 tau 的旧消息取整段文字的第一行", () => {
  assert.equal(extractTitle([tauMsg([{ from: U, body: "修登录\n细节在下面" }])]), "修登录");
  assert.equal(extractTitle([tauMsg([{ from: P("ab12", "worker"), head: "（来自进程 ab12，预设 worker）", body: "整理日志\n更多" }])]), "整理日志");
  assert.equal(extractTitle([tauMsg([{ from: U, body: "\n\n  先空行\n后面" }], { after: "stopped", prefix: "（说明）" })]), "先空行");
  assert.equal(extractTitle([user("修登录\n细节在下面")]), "修登录");
  assert.equal(extractTitle([]), null);
  assert.equal(extractTitle([tauMsg([{ from: U, body: "" }])]), null);
});

test("titles: 分叉自、缓存、进程 ID", () => {
  const st = { titles: { src: "修登录" }, forkedFrom: { f1: "src", f2: "f1" } };
  assert.deepEqual(processTitle("src", st), { title: "修登录", known: true });
  assert.deepEqual(processTitle("f1", st), { title: "修登录", note: "分叉自 src", known: true });
  assert.deepEqual(processTitle("f2", st), { title: "修登录", note: "分叉自 f1", known: true });
  assert.deepEqual(processTitle("zz", st), { title: "zz", known: false });
  assert.deepEqual(processTitle("f9", { titles: {}, forkedFrom: { f9: "nope" } }), { title: "nope", note: "分叉自 nope", known: false });
  assert.equal(processTitle("a", { titles: {}, forkedFrom: { a: "b", b: "a" } }).note, "分叉自 b");
});

// ---------- messages ----------

test("messages: 信的来历读 tau：发送者、跳数、等回信、回信和结束原因", () => {
  const m = tauMsg([
    { from: U, head: "（来自用户）", body: "先看这个" },
    { from: P("ab12", "worker"), head: "（来自进程 ab12，预设 worker）", body: "报告\n\n两段", hops: 2 },
    { from: P("ab12", "worker"), head: "（头的文字随便写）", body: "做完告诉我", replyTo: "ab12", hops: 1 },
    { from: R("cd34", "worker", "stopped"), head: "x", body: "", hops: 3 },
    { from: R("cd34", "worker", { error: "网断了" }), head: "y", body: "半截" },
    { from: U, head: "（来自用户）", body: "还有\n\n一个空行" },
  ]);
  assert.deepEqual(parseUser(m as any).letters, [
    { from: "user", text: "先看这个", hops: 0 },
    { from: "process", id: "ab12", preset: "worker", waiting: false, text: "报告\n\n两段", hops: 2 },
    { from: "process", id: "ab12", preset: "worker", waiting: true, text: "做完告诉我", hops: 1 },
    { from: "reply", id: "cd34", endedText: "被停止", ended: "stopped", text: "", hops: 3 },
    { from: "reply", id: "cd34", endedText: "出错：网断了", ended: { error: "网断了" }, text: "半截", hops: 0 },
    { from: "user", text: "还有\n\n一个空行", hops: 0 },
  ]);
  assert.equal((parseUser(tauMsg([{ from: R("c", "p", "done"), body: "x" }]) as any).letters[0] as any).endedText, "正常结束");
  assert.equal((parseUser(tauMsg([{ from: R("c", "p", "stepLimit"), body: "x" }]) as any).letters[0] as any).endedText, "步数用完");
});

test("messages: 正文里长得像信头的行不是信头，信的边界只看 tau", () => {
  const body = "引用：\n\n（来自进程 ab12，预设 worker）\n还是同一封\n\n（进程 cd34 的回信，这一轮被停止）\n也是";
  const p = parseUser(tauMsg([{ from: U, body }]) as any);
  assert.deepEqual(p.letters, [{ from: "user", text: body, hops: 0 }]);
});

test("messages: 没有 tau 的旧消息按普通用户消息显示，整段文字当一封信", () => {
  const old = "（来自进程 ab12，预设 worker）\n帮我看看\n\n第二段";
  const p = parseUser(user(old) as any);
  assert.deepEqual(p.letters, [{ from: "user", text: old }]);
  assert.equal(p.note, null);
  assert.equal(p.handoff, null);
  // 旧的新段第一条也只是一条普通消息。
  assert.equal(parseUser(user(HANDOFF_HEADER + "目标是 X") as any).handoff, null);
});

test("messages: 文字被截过没有 at 时，整段文字当一封信，发送者取第一封", () => {
  const m = { role: "user", content: "被截断的很长的文字", timestamp: 1, tau: { letters: [{ from: P("ab12", "worker"), hops: 1 }, { from: U, hops: 0 }] } } as Msg;
  assert.deepEqual(parseUser(m as any).letters, [{ from: "process", id: "ab12", preset: "worker", waiting: false, text: "被截断的很长的文字", hops: 1 }]);
});

test("messages: 数组内容只看第一个文本块；图片信的正文是空的", () => {
  const m = tauMsg([{ from: U, body: "看图" }]) as any;
  m.content = [{ type: "text", text: m.content }, { type: "image", data: "blob:abc", mimeType: "image/png" }];
  assert.deepEqual(parseUser(m).letters.map((l: any) => l.text), ["看图"]);
  const onlyImage = { role: "user", content: [{ type: "image", data: "blob:abc", mimeType: "image/png" }], timestamp: 1, tau: { letters: [{ from: U, hops: 0 }] } } as any;
  assert.deepEqual(parseUser(onlyImage).letters, [{ from: "user", text: "", hops: 0 }]);
});

test("messages: 上一轮的说明读 tau.after，不看文字", () => {
  const prefix = "（上一轮被停止。上面还没回复的消息都已取消：不要回应它们，只回应下面的信。）";
  const p = parseUser(tauMsg([{ from: U, body: "继续" }], { after: "stopped", prefix }) as any);
  assert.equal(p.note, "上一轮被停止");
  assert.deepEqual(p.letters, [{ from: "user", text: "继续", hops: 0 }]);
  assert.equal(parseUser(tauMsg([{ from: U, body: "x" }], { after: { error: "炸了" }, prefix: "任意文字" }) as any).note, "上一轮出错：炸了");
  assert.equal(parseUser(tauMsg([{ from: U, body: "x" }], { after: "stepLimit", prefix: "说明" }) as any).note, "上一轮步数用完");
  assert.equal(parseUser(tauMsg([{ from: U, body: "x" }]) as any).note, null);
  // 没有 after，开头像说明的文字也不是说明。
  assert.equal(parseUser(tauMsg([{ from: U, body: "（上一轮被停止了。）看起来像说明的正文" }]) as any).note, null);
});

test("messages: 换段后的第一条读 tau.handoff：说明，和带过来的信", () => {
  const plain = { role: "user", content: HANDOFF_HEADER + "目标是 X\n\n第二行", timestamp: 1, tau: { letters: [], handoff: true } } as any;
  assert.deepEqual(parseUser(plain).handoff, { note: "目标是 X\n\n第二行", carried: null });
  assert.deepEqual(parseUser(plain).letters, []);
  const head = HANDOFF_HEADER + "目标是 X\n\n第二行\n\n" + CARRY_HEADER + "\n\n";
  const text = head + "用户又说了\n\n还有一句";
  const carried = { role: "user", content: text, timestamp: 1, tau: { handoff: true, letters: [{ from: U, hops: 0, at: [head.length, head.length + 5] }, { from: P("ab", "w"), hops: 1, at: [head.length + 7, text.length] }] } } as any;
  const p = parseUser(carried);
  assert.deepEqual(p.handoff, { note: "目标是 X\n\n第二行", carried: "用户又说了\n\n还有一句" });
  assert.equal(toItems([carried])[0]!.kind, "handoff");
  // 带过来的消息只有图片：说明后面有标题，没有正文。
  const noBody = { role: "user", content: HANDOFF_HEADER + "说明\n\n" + CARRY_HEADER, timestamp: 1, tau: { handoff: true, letters: [{ from: U, hops: 0 }] } } as any;
  assert.deepEqual(parseUser(noBody).handoff, { note: "说明", carried: null });
});

test("messages: describeStart 看开头那封信的发送者", () => {
  assert.equal(describeStart(tauMsg([{ from: P("ab", "worker"), body: "x" }]) as any), "由 worker 的来信开始");
  assert.equal(describeStart(tauMsg([{ from: U, body: "x" }]) as any), "由你的来信开始");
  assert.equal(describeStart(tauMsg([{ from: R("ab", "worker", "done"), body: "x" }]) as any), "开始");
  assert.equal(describeStart(user("（来自进程 a，预设 b）\nx") as any), "由你的来信开始");
});

test("messages: 图片块是 blob:hash", () => {
  const m: Msg = { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "blob:abc123", mimeType: "image/png" }], timestamp: 1 };
  const [it] = toItems([m]);
  assert.equal(it!.kind, "user");
  assert.deepEqual((it as any).images, [{ hash: "abc123", mimeType: "image/png" }]);
});

test("messages: 工具调用和结果配对，含被中断和未执行", () => {
  const msgs: Msg[] = [
    user("干活"),
    asst([text("先看看"), call("c1", "bash", { command: "ls -la\necho hi" }), call("c2", "read", { path: "a.txt" }), call("c3", "bash", { command: "sleep 9" }), call("c4", "edit", { path: "x" })], 5),
    result("c1", "total 0\nfile", false, 6),
    result("c2", "boom", true, 7),
    filled("c3", "interrupted", 8),
    filled("c4", "skipped", 9),
    asst([call("c5", "bash", { command: "pwd" })], 10),
  ];
  const items = toItems(msgs);
  assert.equal(items.length, 3);
  const a = items[1] as any;
  assert.equal(a.kind, "assistant");
  assert.equal(a.text, "先看看");
  assert.deepEqual(a.calls.map((c: any) => [c.id, c.status]), [["c1", "ok"], ["c2", "error"], ["c3", "interrupted"], ["c4", "skipped"]]);
  assert.equal(a.calls[0].summary, "ls -la");
  assert.equal(a.calls[0].result.text, "total 0\nfile");
  assert.equal(a.calls[0].result.summary, "total 0");
  assert.equal(a.calls[0].result.seq, 2);
  assert.equal(a.calls[1].summary, "a.txt");
  assert.equal((items[2] as any).calls[0].status, "pending");
  assert.equal((items[2] as any).calls[0].result, null);
  // 看 tau.filled，不看文字：同样的文字没有 tau，就只是工具报错。
  const other = toItems([asst([call("z", "bash", {})]), result("z", "被中断，结果未知", true)])[0] as any;
  assert.equal(other.calls[0].status, "error");
});

test("messages: 找不到调用的结果单列", () => {
  assert.equal(toItems([result("zz", "孤儿")])[0]!.kind, "orphanResult");
});

test("messages: summarizeCall、describeNow、phaseStartedAt、forkPoints、turnStart", () => {
  assert.equal(summarizeCall("memory", { key: "k", value: "v" }), "k");
  assert.equal(summarizeCall("x", {}), "");
  assert.equal(summarizeCall("x", { n: 1 }), '{"n":1}');
  const msgs: Msg[] = [user("a"), asst([text("好的")], 2), user("b", 3), asst([text("读\n第二行"), call("c", "read", { path: "f.ts" })], 4), result("c", "ok", false, 5)];
  assert.equal(describeNow(msgs), "read f.ts");
  assert.equal(describeNow(msgs.slice(0, 2)), "好的");
  assert.equal(describeNow([user("a")]), "");
  assert.equal(phaseStartedAt(msgs, "awaitingModel"), 5);
  assert.equal(phaseStartedAt(msgs, "awaitingTool"), 4);
  assert.equal(phaseStartedAt([], "idle"), null);
  assert.deepEqual(forkPoints(msgs), [0, 2]);
  // 工具结果之后合并进来的信不是这一轮的开头。
  const mid: Msg[] = [user("开头"), asst([call("c", "bash", {})]), result("c", "x"), user("插话", 9), asst([text("完")])];
  assert.equal(turnStart(mid), 0);
  assert.equal(turnStart([user("一"), asst([text("好")]), user("二"), user("三"), asst([text("好")])]), 2);
  assert.equal(turnStart([]), null);
});

test("messages: foldMiddle", () => {
  const items = toItems(Array.from({ length: 10 }, (_, i) => user(`m${i}`, i)));
  const f = foldMiddle(items, 2, 3);
  assert.equal(f.length, 6);
  assert.deepEqual(f[2], { kind: "fold", count: 5, from: 2, to: 6 });
  assert.equal(foldMiddle(items, 5, 5), items);
});

// ---------- derive ----------

const presetList = indexPresets([
  { id: "dev", ok: true, workdir: "C:\\work\\Alpha", model: "m", tools: ["read", "memory"], memory: true },
  { id: "qa", ok: true, workdir: "c:/work/alpha/", model: "m", tools: ["read", "memory"], memory: true },
  { id: "tmp", ok: true, workdir: "C:\\work\\alpha", model: "m", tools: ["read", "bash"], memory: false },
  { id: "other", ok: true, workdir: "C:\\work\\beta", model: "m", tools: ["read", "bash"], memory: false },
  { id: "boss", ok: true, workdir: "C:\\Users\\me", model: "m", tools: ["memory", "agents"], memory: true },
  { id: "bad", ok: false, error: "坏了" },
]);
const gstate = (o: object = {}) => normalizeState({ chief: "boss", names: { dev: "渲染" }, ...o });

/** 进程冻结的快照：`inspect` 里进程记录的 `preset`，界面只取三项。 */
const snapOf = (workdir: string, tools: string[], toolDefs: string[] = []) => seenFromInspect({ type: "process", process: { id: "x", preset: { workdir, tools, toolDefs: toolDefs.map((name) => ({ name })) } }, messages: 0, limits: {} })!;

/** 默认：每个进程建的时候，预设文件就是现在这样；`frozen` 里写的进程例外。 */
function world(list: Self[], st = gstate(), frozen: Record<string, ReturnType<typeof snapOf>> = {}) {
  const s = reduce(emptyStore(), { type: "ps", processes: list.map(proj) }, NOW);
  const snaps = { ...frozen };
  for (const x of list) {
    const p = presetList[x.preset];
    if (!(x.id in snaps) && p && p.ok) snaps[x.id] = snapOf(p.workdir, p.tools);
  }
  return buildEntries(s.procs, st, snaps);
}

test("derive: seenFromInspect 只取工作目录、工具（内置加工具定义）、有没有记忆", () => {
  assert.deepEqual(snapOf("C:\\w", ["read", "memory"], ["mytool"]), { workdir: "C:\\w", tools: ["read", "memory", "mytool"], memory: true });
  assert.deepEqual(snapOf("C:\\w", ["bash"]), { workdir: "C:\\w", tools: ["bash"], memory: false });
  assert.equal(seenFromInspect({ type: "process" } as any), null);
});

test("derive: classify", () => {
  assert.equal(classify(self("a", { phase: running })), "running");
  assert.equal(classify(self("a", { phase: { tag: "awaitingTool", steps: 1, queued: 0 } })), "running");
  assert.equal(classify(self("a", { phase: failed })), "error");
  assert.equal(classify(self("a", { phase: doneIdle })), "idle");
  assert.equal(classify(self("a", { phase: { tag: "idle", ended: "stopped" } })), "idle");
  assert.equal(classify(self("a")), "fresh");
});

test("derive: 进程用冻结的快照归类，不看预设文件现在写什么；没有快照的是 unknown；总管不归项目", () => {
  const st = gstate();
  // 预设文件现在说 dev 在 Alpha、带记忆；a 建的时候不是：快照说它在 C:\old、不带记忆。
  const { entries } = world([self("a", { preset: "dev" }), self("b", { preset: "dev" }), self("c", { preset: "boss" }), self("d", { preset: "gone" })], st, { a: snapOf("C:\\old", ["read"]) });
  const by = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(by["a"]!.workdir, "C:\\old");
  assert.equal(by["a"]!.kind, "temp");
  assert.equal(by["b"]!.kind, "team");
  assert.equal(by["b"]!.name, "渲染");
  assert.equal(by["c"]!.kind, "chief");
  assert.equal(by["d"]!.kind, "unknown");
  assert.equal(by["d"]!.workdir, null);
  const projects = buildProjects(entries, st, presetList);
  assert.ok(!projects.some((p) => p.entries.some((e) => e.id === "c")));
  assert.ok(!projects.some((p) => p.key === pathKey("C:\\Users\\me")));
  const alpha = projects.find((p) => p.key === pathKey("C:\\work\\alpha"))!;
  assert.deepEqual(alpha.entries.map((e) => e.id), ["b"]);
  assert.deepEqual(alpha.presets.map((p) => p.id).sort(), ["dev", "qa", "tmp"]);
  assert.equal(alpha.name, "Alpha");
  assert.ok(projects.some((p) => p.key === pathKey("C:\\old")));
});

test("derive: 当前进程：记的优先，没记取最近有动静的，记的没了就退回", () => {
  const { entries } = world([self("a", { preset: "dev", age: 9000, segmentAge: null }), self("b", { preset: "dev", age: 3000, segmentAge: null }), self("c", { preset: "dev", age: 5000, segmentAge: null })]);
  assert.equal(currentOf("dev", entries, gstate(), {})!.id, "b");
  assert.equal(currentOf("dev", entries, gstate({ current: { dev: "a" } }), {})!.id, "a");
  assert.equal(currentOf("dev", entries, gstate({ current: { dev: "gone" } }), {})!.id, "b");
  assert.equal(currentOf("dev", entries, gstate(), { c: NOW + 1 })!.id, "c");
  assert.equal(currentOf("qa", entries, gstate(), {}), null);
});

test("derive: 筛选计数和搜索（预设 ID、显示名、进程 ID、标题）", () => {
  const { entries } = world([self("a1", { preset: "dev", phase: running }), self("b2", { preset: "tmp", phase: failed }), self("c3", { preset: "tmp", phase: doneIdle }), self("d4", { preset: "tmp", phase: running })]);
  assert.deepEqual(filterCounts(entries), { all: 4, running: 2, error: 1 });
  const titleOf = (id: string) => (id === "c3" ? "整理日志" : id);
  const f = (filter: any, query: string) => applyFilter(entries, { filter, query, titleOf });
  assert.deepEqual(f("running", "").visible.map((e) => e.id), ["a1", "d4"]);
  assert.equal(f("running", "").hidden, 2);
  assert.deepEqual(f("error", "").visible.map((e) => e.id), ["b2"]);
  assert.deepEqual(f("all", "渲染").visible.map((e) => e.id), ["a1"]);
  assert.deepEqual(f("all", "DEV").visible.map((e) => e.id), ["a1"]);
  assert.deepEqual(f("all", "c3").visible.map((e) => e.id), ["c3"]);
  assert.deepEqual(f("all", "日志").visible.map((e) => e.id), ["c3"]);
  assert.deepEqual(f("running", "tmp").visible.map((e) => e.id), ["d4"]);
  assert.equal(f("all", "不存在").hidden, 4);
});

test("derive: 临时进程排序：出错，在跑，再按今天、7 天内、更早分桶", () => {
  const ids = ["e1", "r1", "t1", "t2", "w1", "o1"];
  const { entries } = world(ids.map((id) => self(id, { preset: "tmp", phase: id === "e1" ? failed : id === "r1" ? running : doneIdle })));
  const lastAt = { t1: NOW - HOUR, t2: NOW - 2 * HOUR, w1: NOW - 3 * DAY, o1: NOW - 30 * DAY, e1: NOW, r1: NOW };
  const st = gstate();
  const project = buildProjects(entries, st, presetList, lastAt).find((p) => p.name === "Alpha")!;
  const v = projectView(project, { state: st, lastAt, clientNow: NOW, filter: "all", query: "", titleOf: (id) => id });
  assert.deepEqual(v.temps.errors.map((e) => e.id), ["e1"]);
  assert.deepEqual(v.temps.running.map((e) => e.id), ["r1"]);
  assert.deepEqual(v.temps.idle.today.map((e) => e.id), ["t1", "t2"]);
  assert.deepEqual(v.temps.idle.week.map((e) => e.id), ["w1"]);
  assert.deepEqual(v.temps.idle.older.map((e) => e.id), ["o1"]);
  assert.equal(v.temps.idleCount, 4);
  assert.deepEqual(v.counts, { all: 6, running: 1, error: 1 });
  assert.equal(v.hidden, 0);
  const vr = projectView(project, { state: st, lastAt, clientNow: NOW, filter: "running", query: "", titleOf: (id) => id });
  assert.equal(vr.hidden, 5);
  assert.equal(vr.temps.idleCount, 0);
});

test("derive: 昨天 23 点不算今天，也在 7 天内", () => {
  const { entries } = world([self("y", { preset: "tmp", phase: doneIdle })]);
  const lastAt = { y: new Date(2026, 10, 16, 23, 0).getTime() };
  const st = gstate();
  const project = buildProjects(entries, st, presetList, lastAt).find((p) => p.name === "Alpha")!;
  const v = projectView(project, { state: st, lastAt, clientNow: NOW, filter: "all", query: "", titleOf: (id) => id });
  assert.deepEqual(v.temps.idle.today, []);
  assert.deepEqual(v.temps.idle.week.map((e) => e.id), ["y"]);
});

test("derive: 团队行：位置不随状态变，在跑和出错的露出，空闲的折起，搜索时不折", () => {
  const list = [self("a", { preset: "dev", phase: doneIdle }), self("b", { preset: "dev", phase: running }), self("c", { preset: "dev", phase: doneIdle }), self("d", { preset: "dev", phase: failed }), self("q", { preset: "qa", phase: doneIdle })];
  const { entries } = world(list);
  const st = gstate({ current: { dev: "a" } });
  const project = buildProjects(entries, st, presetList).find((p) => p.name === "Alpha")!;
  const base = { state: st, lastAt: {}, clientNow: NOW, filter: "all" as const, titleOf: (id: string) => id };
  const v = projectView(project, { ...base, query: "" });
  assert.deepEqual(v.teams.map((t) => t.name), ["qa", "渲染"]);
  const dev = v.teams.find((t) => t.presetId === "dev")!;
  assert.equal(dev.current!.id, "a");
  assert.deepEqual(dev.shown.map((e) => e.id).sort(), ["b", "d"]);
  assert.deepEqual(dev.folded.map((e) => e.id), ["c"]);
  assert.equal(dev.runningCount, 1);
  assert.equal(dev.errorCount, 1);
  assert.equal(dev.total, 4);
  const s = projectView(project, { ...base, query: "dev" });
  assert.deepEqual(s.teams.map((t) => t.presetId), ["dev"]);
  assert.equal(s.teams[0]!.folded.length, 0);
  assert.equal(s.teams[0]!.shown.length, 3);
  // 没有进程的常驻预设：不筛选时也有一行；筛选时没有。
  const p2 = buildProjects([], st, presetList).find((p) => p.name === "Alpha")!;
  const v2 = projectView(p2, { ...base, query: "" });
  assert.deepEqual(v2.teams.map((t) => [t.presetId, t.current]).sort(), [["dev", null], ["qa", null]]);
  assert.deepEqual(projectView(p2, { ...base, filter: "running", query: "" }).teams, []);
});

test("derive: 窄条分段：钉住最多 9 个，有动静的出错在前，在跑总数含总管", () => {
  const { entries } = world([self("a", { preset: "dev", phase: running }), self("b", { preset: "other", phase: failed }), self("c", { preset: "boss", phase: running })]);
  const st = gstate({ pinned: ["C:\\p1", "C:\\work\\Alpha", "C:\\p3", "C:\\p4", "C:\\p5", "C:\\p6", "C:\\p7", "C:\\p8", "C:\\p9", "C:\\p10"] });
  const r = railSections(buildProjects(entries, st, presetList), entries, st);
  assert.equal(r.pinned.length, 9);
  assert.equal(r.pinned[1]!.name, "Alpha");
  assert.equal(r.pinned[0]!.path, "C:\\p1");
  assert.ok(!r.pinned.some((p) => p.path === "C:\\p10"));
  assert.ok(r.rest.some((p) => p.path === "C:\\p10"));
  assert.deepEqual(r.active.map((p) => p.name), ["beta"]);
  assert.equal(r.runningTotal, 2);
  const r2 = railSections(buildProjects(entries, gstate(), presetList), entries, gstate());
  assert.deepEqual(r2.active.map((p) => p.name), ["beta", "Alpha"]);
});

test("derive: 待你看：出错的，和做完了但分支没合并的", () => {
  const { entries } = world([self("e", { preset: "tmp", phase: failed }), self("d", { preset: "tmp", phase: doneIdle }), self("o", { preset: "other", phase: doneIdle }), self("c", { preset: "boss", phase: failed })]);
  assert.deepEqual(attention(entries).map((x) => [x.id, x.kind]), [["e", "error"]]);
  const a = attention(entries, { unmerged: { "c:/work/ALPHA": ["feat-x"] } });
  assert.deepEqual(a.map((x) => [x.id, x.kind, x.detail]), [["e", "error", "炸了"], ["d", "unmerged", "feat-x"]]);
  const old = attention(entries, { unmerged: { "C:\\work\\alpha": ["f"] }, lastAt: { d: NOW - 3 * DAY }, clientNow: NOW });
  assert.deepEqual(old.map((x) => x.id), ["e"]);
});

test("derive: activityAt 回退顺序", () => {
  const { entries } = world([self("a", { age: 1000, segmentAge: 200 }), self("b", { age: 1000, segmentAge: null })]);
  assert.equal(activityAt(entries[0]!, {}), NOW - 200);
  assert.equal(activityAt(entries[1]!, {}), NOW - 1000);
  assert.equal(activityAt(entries[0]!, { a: 7 }), 7);
});

// ---------- order ----------

test("order: 全部停止，子孙在前，祖先在后，空闲的不停", () => {
  const { entries } = world([
    self("root", { phase: running }),
    self("kid", { phase: running, parent: "root" }),
    self("grand", { phase: running, parent: "kid" }),
    self("lone", { phase: running }),
    self("sleeper", { phase: doneIdle, parent: "root" }),
    self("deep", { phase: running, parent: "sleeper" }),
  ]);
  const o = stopOrder(entries);
  assert.ok(o.indexOf("grand") < o.indexOf("kid"));
  assert.ok(o.indexOf("kid") < o.indexOf("root"));
  assert.ok(o.indexOf("deep") < o.indexOf("root"));
  assert.ok(!o.includes("sleeper"));
  assert.equal(o.length, 5);
});

test("order: 父进程环不死循环", () => {
  const { entries } = world([self("a", { phase: running, parent: "b" }), self("b", { phase: running, parent: "a" })]);
  assert.equal(stopOrder(entries).length, 2);
});

test("order: 清理计划，当前进程不删，有挡路的孩子就删不了，叶子在前", () => {
  const old = NOW - 10 * DAY;
  const lastAt: Record<string, number> = {};
  const list = [
    self("t-old", { age: 20 * DAY, preset: "tmp", phase: doneIdle }),
    self("t-new", { age: 20 * DAY, preset: "tmp", phase: doneIdle }),
    self("t-parent", { age: 20 * DAY, preset: "tmp", phase: doneIdle }), // 孩子在跑
    self("t-kid", { age: 20 * DAY, preset: "tmp", phase: running, parent: "t-parent" }),
    self("t-p2", { age: 20 * DAY, preset: "tmp", phase: doneIdle }), // 孩子也是候选
    self("t-k2", { age: 20 * DAY, preset: "tmp", phase: doneIdle, parent: "t-p2" }),
    self("t-g", { age: 20 * DAY, preset: "tmp", phase: doneIdle }), // 祖父，孙子不够旧
    self("t-m", { age: 20 * DAY, preset: "tmp", phase: doneIdle, parent: "t-g" }),
    self("t-s", { age: 20 * DAY, preset: "tmp", phase: doneIdle, parent: "t-m" }),
    self("d-cur", { age: 20 * DAY, preset: "dev", phase: doneIdle }),
    self("d-old", { age: 20 * DAY, preset: "dev", phase: doneIdle }),
    self("d-run", { age: 20 * DAY, preset: "dev", phase: running }),
    self("c-old", { age: 20 * DAY, preset: "boss", phase: doneIdle }),
    self("c-cur", { age: 20 * DAY, preset: "boss", phase: doneIdle }),
  ];
  for (const id of ["t-old", "t-parent", "t-p2", "t-k2", "t-g", "t-m", "d-cur", "d-old", "d-run", "c-old", "c-cur"]) lastAt[id] = old;
  lastAt["t-new"] = NOW - 2 * DAY;
  lastAt["t-s"] = NOW - DAY;
  const st = gstate({ current: { dev: "d-cur" } });
  const { entries } = world(list, st);
  const p = cleanPlan(entries, { state: st, lastAt, clientNow: NOW });
  assert.ok(!p.remove.includes("t-new"));
  assert.ok(!p.remove.includes("d-cur"));
  assert.ok(!p.remove.includes("d-run"));
  assert.ok(p.remove.includes("d-old"));
  assert.ok(p.remove.includes("t-old"));
  // 总管没记当前：取最近有动静的，同一时刻取 ID 大的，所以 c-cur 能删，c-old 留着。
  assert.ok(p.remove.includes("c-cur") && !p.remove.includes("c-old"));
  assert.ok(p.remove.indexOf("t-k2") < p.remove.indexOf("t-p2"));
  assert.ok(!p.remove.includes("t-parent"));
  assert.match(p.blocked.find((b) => b.id === "t-parent")!.reason, /t-kid/);
  for (const id of ["t-g", "t-m"]) assert.ok(p.blocked.some((b) => b.id === id), id);
  assert.match(p.blocked.find((b) => b.id === "t-g")!.reason, /t-m/);
  assert.ok(!p.remove.includes("t-s"));
});

test("order: 清理天数用界面数据的", () => {
  const { entries } = world([self("a", { age: 20 * DAY, preset: "tmp", phase: doneIdle })]);
  const lastAt = { a: NOW - 10 * DAY };
  assert.deepEqual(cleanPlan(entries, { state: gstate({ cleanDays: 30 }), lastAt, clientNow: NOW }).remove, []);
  assert.deepEqual(cleanPlan(entries, { state: gstate({ cleanDays: 7 }), lastAt, clientNow: NOW }).remove, ["a"]);
});

test("order: 刚分叉出来的进程消息是旧的，也不进清理名单", () => {
  const { entries } = world([self("fresh-fork", { preset: "tmp", phase: doneIdle, age: 60 * 1000 })]);
  const lastAt = { "fresh-fork": NOW - 10 * DAY };
  assert.deepEqual(cleanPlan(entries, { state: gstate({ cleanDays: 7 }), lastAt, clientNow: NOW }).remove, []);
});

// ---------- state ----------

test("state: normalizeState 补默认值，坏的键当没有", () => {
  const s = normalizeState({ pinned: ["a", 3], cleanDays: -1, names: [], current: { x: "y", z: 1 } });
  assert.deepEqual(s.pinned, ["a"]);
  assert.equal(s.cleanDays, 7);
  assert.deepEqual(s.names, {});
  assert.deepEqual(s.current, { x: "y" });
  assert.equal("seen" in s, false, "进程用的快照从 inspect 读，不再存");
  assert.equal(s.chief, undefined);
  assert.equal(normalizeState(null).cleanDays, 7);
  assert.equal(normalizeState({ chief: "boss" }).chief, "boss");
});

test("state: 钉住、挪动、当前进程、分叉的补丁", () => {
  let s = normalizeState({ pinned: ["C:\\a", "C:\\b", "C:\\c"] });
  assert.deepEqual(pinFolder(s, "c:/A/").pinned, ["C:\\a", "C:\\b", "C:\\c"]);
  assert.deepEqual(movePinned(s, "C:\\c", -1).pinned, ["C:\\a", "C:\\c", "C:\\b"]);
  assert.deepEqual(movePinned(s, "C:\\a", -1).pinned, ["C:\\a", "C:\\b", "C:\\c"]);
  assert.deepEqual(setCurrent(s, "dev", "p1"), { current: { dev: "p1" } });
  const f = addFork(s, "n1", "src");
  assert.deepEqual(f.forkedFrom, { n1: "src" });
  assert.deepEqual(f.mine, ["n1"]);
  s = normalizeState({ pinned: Array.from({ length: 9 }, (_, i) => `C:\\p${i}`) });
  assert.equal(pinFolder(s, "C:\\new").pinned.length, 9);
});

// ---------- format ----------

test("format: 时长、时钟、百分比、字节", () => {
  assert.equal(formatDuration(0), "刚刚");
  assert.equal(formatDuration(4999), "刚刚");
  assert.equal(formatDuration(-5), "刚刚");
  assert.equal(formatDuration(12_000), "12 秒");
  assert.equal(formatDuration(5 * 60_000), "5 分钟");
  assert.equal(formatDuration(3 * HOUR), "3 小时");
  assert.equal(formatDuration(2 * DAY + HOUR), "2 天");
  assert.equal(formatAgo(2 * DAY), "2 天前");
  assert.equal(formatAgo(10), "刚刚");
  assert.equal(formatClock(new Date(2026, 0, 1, 9, 5).getTime()), "09:05");
  assert.equal(formatContext({ used: 372, window: 1000 }), "37%");
  assert.equal(formatContext({ used: 5000, window: 1000 }), "100%");
  assert.equal(formatContext({ used: 1, window: 0 }), "0%");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

// ---------- 审阅修复 ----------

test("order: 没读过最后动静的进程不进清理计划，也不拿来选当前进程", () => {
  const list = [
    self("A", { preset: "dev", phase: doneIdle, age: 30 * DAY, segmentAge: 20 * DAY }),
    self("B", { preset: "dev", phase: doneIdle, age: 30 * DAY, segmentAge: 15 * DAY }),
    self("T", { preset: "tmp", phase: doneIdle, age: 30 * DAY, segmentAge: 10 * DAY }),
  ];
  const st = gstate();
  const { entries } = world(list, st);
  assert.deepEqual(cleanPlan(entries, { state: st, lastAt: {}, clientNow: NOW }), { remove: [], blocked: [] });
  // 只有 B 读过：A 没读过，不删；B 是已知最近的，受保护。
  assert.deepEqual(cleanPlan(entries, { state: st, lastAt: { B: NOW - 12 * DAY }, clientNow: NOW }).remove, []);
  // 读过而且确实旧的，照删。
  assert.deepEqual(cleanPlan(entries, { state: st, lastAt: { T: NOW - 12 * DAY }, clientNow: NOW }).remove, ["T"]);
});

test("messages: 空的和重复的调用 ID 按位置配对", () => {
  const pending = toItems([user("a"), asst([call("", "bash", { command: "ls" })]), result("", "file-list"), asst([call("", "bash", { command: "sleep 100" })])]);
  const a2 = pending[2] as any;
  assert.equal(a2.calls[0].status, "pending");
  assert.equal(a2.calls[0].result, null);
  assert.equal((pending[1] as any).calls[0].result.text, "file-list");
  const two = toItems([asst([call("", "bash", { command: "ls" }), call("", "bash", { command: "rm x" })]), result("", "file-list", false, 3), filled("", "interrupted", 4)]);
  assert.equal(two.length, 1);
  assert.deepEqual((two[0] as any).calls.map((c: any) => [c.summary, c.status]), [["ls", "ok"], ["rm x", "interrupted"]]);
  // 多出来的结果单列。
  const extra = toItems([asst([call("x", "bash", {})]), result("x", "a", false, 3), result("y", "b", false, 4)]);
  assert.deepEqual(extra.map((i) => i.kind), ["assistant", "orphanResult"]);
});

test("messages: turnStart 非正常结束后的下一封信（tau.after）开新的一轮", () => {
  const afterLimit: Msg[] = [user("L1"), asst([call("a", "bash", {})]), result("a", "x"), tauMsg([{ from: U, body: "L2" }], { after: "stepLimit", prefix: "（说明）" }, 9), asst([call("b", "bash", {})]), result("b", "y")];
  assert.equal(turnStart(afterLimit), 3);
  const afterError: Msg[] = [user("L1"), asst([call("a", "bash", {})]), result("a", "x"), tauMsg([{ from: U, body: "继续" }], { after: { error: "炸了" }, prefix: "（说明）" }, 9)];
  assert.equal(turnStart(afterError), 3);
  const afterStop: Msg[] = [user("L1"), asst([call("a", "bash", {})]), filled("a", "interrupted"), tauMsg([{ from: U, body: "继续" }], { after: "stopped", prefix: "（说明）" }, 9), asst([text("好")])];
  assert.equal(turnStart(afterStop), 3);
  // 只看 tau：开头像说明、没有 after 的，是安全点并进来的信，不开新的一轮。
  const merged: Msg[] = [user("L1"), asst([call("a", "bash", {})]), result("a", "x"), user("（上一轮被停止了。）插话", 9), asst([text("完")])];
  assert.equal(turnStart(merged), 0);
});

test("messages: 换段后的第一条不是一轮的开头，轮的开头在上一段", () => {
  const first = { role: "user", content: HANDOFF_HEADER + "x", timestamp: 1, tau: { letters: [], handoff: true } } as Msg;
  assert.equal(turnStart([first, asst([call("c", "bash", {})]), result("c", "x")]), null);
  assert.equal(turnStart([user(HANDOFF_HEADER + "x"), asst([call("c", "bash", {})]), result("c", "x")]), 0, "没有 tau 的旧消息是普通消息");
});

test("history: 断开期间段号跳了不止一段，中间的段也要读", () => {
  let h = noteSelf(emptyHistory(), self("a", { segment: 3, messages: 2 }));
  h = feed(h, 3, 0, 2);
  const s5 = self("a", { segment: 5, messages: 1 });
  h = noteSelf(h, s5);
  const reads: number[] = [];
  for (let p = plan(h, s5); p; p = plan(h, s5)) {
    reads.push(p.segment);
    if (reads.length > 10) break;
    h = applyEnd(h, { segment: p.segment, messages: known(h, p.segment) }, p);
    if (!p.sealed) h = feed(h, p.segment, 0, 1);
  }
  assert.deepEqual(reads, [3, 4, 5]);
});

test("formatElapsed：跑了多久精确到秒", () => {
  assert.equal(formatElapsed(-1), "0 秒");
  assert.equal(formatElapsed(999), "0 秒");
  assert.equal(formatElapsed(12_400), "12 秒");
  assert.equal(formatElapsed(65_000), "1 分 05 秒");
  assert.equal(formatElapsed(3_780_000), "1 小时 03 分");
});

test("remove: 单个进程的子树只有它自己；目标不在表里也是", () => {
  const all = [self("a"), self("b")];
  assert.deepEqual(removePlan("a", all), { order: ["a"], depth: { a: 0 }, parent: {}, running: [] });
  assert.deepEqual(removePlan("zz", all).order, ["zz"]);
});

test("remove: 链和分叉的树，叶子在前，目标最后；只算目标往下的", () => {
  const chain = [self("a"), self("b", { parent: "a" }), self("c", { parent: "b" }), self("x")];
  const p = removePlan("a", chain);
  assert.deepEqual(p.order, ["c", "b", "a"]);
  assert.deepEqual(p.depth, { a: 0, b: 1, c: 2 });
  assert.deepEqual(removePlan("b", chain).order, ["c", "b"]);
  const tree = [self("r"), self("k2", { parent: "r" }), self("k1", { parent: "r" }), self("g", { parent: "k1" }), self("h", { parent: "k1" })];
  const t = removePlan("r", tree);
  assert.deepEqual(t.order, ["g", "h", "k1", "k2", "r"]);
  for (const id of t.order) for (const [c, par] of Object.entries(t.parent)) if (par === id) assert.ok(t.order.indexOf(c) < t.order.indexOf(id));
});

test("remove: 子树里在跑的成员列出来，别的分支在跑不算", () => {
  const all = [self("r"), self("k1", { parent: "r", phase: running }), self("k2", { parent: "r" }), self("g", { parent: "k2", phase: running }), self("o", { phase: running })];
  assert.deepEqual(removePlan("r", all).running, ["k1", "g"]);
  assert.deepEqual(removePlan("k1", all).running, ["k1"]);
  assert.deepEqual(removePlan("o", all).running, ["o"]);
  assert.deepEqual(removePlan("k2", [self("k2"), self("c", { parent: "k2" })]).running, []);
});

test("remove: 环不会死循环；父进程不在表里的不算子树", () => {
  const cyc = [self("a", { parent: "b" }), self("b", { parent: "a" })];
  const p = removePlan("a", cyc);
  assert.deepEqual(p.order, ["b", "a"]);
  assert.deepEqual(removePlan("b", cyc).order, ["a", "b"]);
  const all = [self("a"), self("orphan", { parent: "gone" }), self("self", { parent: "self" })];
  assert.deepEqual(removePlan("a", all).order, ["a"]);
  assert.deepEqual(removePlan("self", all).order, ["self"]);
});

test("remove: 被拒绝的进程，只跳过它的祖先，别的分支照删", () => {
  const all = [self("r"), self("k1", { parent: "r" }), self("k2", { parent: "r" }), self("g", { parent: "k1" }), self("h", { parent: "k1" })];
  const { order, parent } = removePlan("r", all);
  assert.deepEqual(skippedFor(order, parent, []), []);
  assert.deepEqual(skippedFor(order, parent, ["g"]), ["k1", "r"], "h 和 k2 不在其中");
  assert.deepEqual(skippedFor(order, parent, ["k2"]), ["r"]);
  assert.deepEqual(skippedFor(order, parent, ["g", "k1"]), ["r"], "已被拒绝的不重复算作跳过");
  assert.deepEqual(skippedFor(order, parent, ["r"]), []);
  assert.deepEqual(skippedFor(["a", "b"], { a: "b", b: "a" }, ["a"]), ["b"], "环不死循环");
});

test("state: prunePatch 清掉没了的进程，被还在的分叉指着的标题留着，当前进程记录也清", () => {
  const g = normalizeState({
    titles: { src: "标题", old: "旧的", mid: "中间" },
    forkedFrom: { fork: "src", gone: "old", f2: "mid" },
    mine: ["fork", "gone"],
    current: { team: "gone", other: "fork" },
  });
  const stale = (id: string) => ["src", "old", "mid", "gone"].includes(id);
  const patch = prunePatch(g, stale) as any;
  assert.deepEqual(patch.titles, { src: "标题", mid: "中间" }, "fork 和 f2 还在，src 和 mid 的标题留着；old 没人指着就清");
  assert.deepEqual(patch.forkedFrom, { fork: "src", f2: "mid" });
  assert.deepEqual(patch.mine, ["fork"]);
  assert.deepEqual(patch.current, { other: "fork" });
  assert.deepEqual(prunePatch(g, () => false), {});
  // 分叉也没了：标题跟着清。
  const g2 = { ...g, forkedFrom: {}, titles: { src: "标题" }, mine: [], current: {} };
  assert.deepEqual(prunePatch(g2, stale), { titles: {} });
});

test("messages: canHandoff 段里要已有助手消息，换段信才生效", () => {
  assert.equal(canHandoff([]), false);
  assert.equal(canHandoff([user("刚开始")]), false);
  const fresh = { role: "user", content: HANDOFF_HEADER + "说明", timestamp: 1, tau: { letters: [], handoff: true } } as Msg;
  assert.equal(canHandoff([fresh]), false, "刚换段的新段开头");
  assert.equal(canHandoff([user("a"), asst([text("好")])]), true);
  assert.equal(canHandoff([fresh, asst([text("好")])]), true);
});

// ---------- pace ----------

/** 确定性的小随机数：线性同余。 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

type Pace = import("../../../extras/gui/web/lib/pace.js").Pace;

/** 按 16ms 一帧模拟：`arrivals` 是 [时刻 ms, 字数]，`endAt` 之后置 ending。返回每帧的 [时刻, 已吐字数, 已到字数]。 */
function simulate(arrivals: [number, number][], untilMs: number, endAt: number | null = null) {
  let p: Pace = newPace();
  let received = 0;
  let i = 0;
  const frames: [number, number, number][] = [];
  for (let t = 0; t <= untilMs; t += 16) {
    while (i < arrivals.length && arrivals[i]![0] <= t) {
      p = paceArrive(p, arrivals[i]![0], arrivals[i]![1]);
      received += arrivals[i]![1];
      i++;
    }
    p = paceStep(p, t, received, endAt !== null && t >= endAt, 0.016);
    frames.push([t, p.shown, received]);
  }
  return frames;
}
const steps = (frames: [number, number, number][], fromMs: number) => {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) if (frames[i]![0] >= fromMs) out.push(frames[i]![1] - frames[i - 1]![1]);
  return out;
};

test("pace: 平稳的小块，热身以后相邻两帧的前进量几乎不变，也不超过已到的字数", () => {
  const r = lcg(11);
  const arrivals: [number, number][] = [];
  for (let t = 600; t < 8000; t += between(r, 20, 45)) arrivals.push([t, 1 + Math.floor(r() * 4)]);
  const frames = simulate(arrivals, 8000);
  for (const f of frames) assert.ok(f[1] <= f[2] + 1e-9);
  const d = steps(frames, 1100);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  let worst = 0;
  for (let i = 1; i < d.length; i++) worst = Math.max(worst, Math.abs(d[i]! - d[i - 1]!) / mean);
  assert.ok(worst < 0.1, `相邻两帧最大变化 ${worst}`);
});

test("pace: 一批一批地来，流没结束时没有一帧停住", () => {
  // 固定一个典型序列：连着几个 700ms 的空档会让缓冲见底，那是算法的极限，不是这条测试要抓的。
  const r = lcg(11);
  const arrivals: [number, number][] = [];
  for (let t = 600; t < 12000; ) {
    const gap = between(r, 250, 700);
    t += gap;
    arrivals.push([t, Math.max(1, Math.round((gap / 1000) * 90 * between(r, 0.7, 1.3)))]);
  }
  const last = arrivals[arrivals.length - 1]![0];
  const frames = simulate(arrivals, last);
  for (const d of steps(frames, 2600)) assert.ok(d > 0);
});

test("pace: 最后一块到了以后置 ending，700ms 内追平，比不置 ending 快", () => {
  // 一批一批的流，末尾有积压：追平靠的是 ending 分支，不是前馈。
  const r = lcg(5);
  const arrivals: [number, number][] = [];
  for (let t = 600; t < 6000; ) {
    const gap = between(r, 250, 700);
    t += gap;
    arrivals.push([t, Math.max(1, Math.round((gap / 1000) * 90 * between(r, 0.7, 1.3)))]);
  }
  const end = arrivals[arrivals.length - 1]![0];
  const catchAt = (endAt: number | null) => simulate(arrivals, end + 3000, endAt).find((f) => f[0] >= end && f[1] >= f[2] - 1e-6)?.[0];
  const withEnding = catchAt(end);
  const without = catchAt(null);
  assert.ok(withEnding !== undefined && withEnding - end <= 700, `追平用了 ${withEnding === undefined ? "∞" : withEnding - end}ms`);
  assert.ok(without === undefined || without - end > withEnding - end + 100, "不置 ending 应该明显更慢");
});

test("pace: 一次来 1000 字，1.5 秒内追平", () => {
  const frames = simulate([[100, 1000]], 3000);
  const caught = frames.find((f) => f[0] >= 100 && f[1] >= f[2] - 1e-6);
  assert.ok(caught && caught[0] - 100 <= 1500, `追平用了 ${caught ? caught[0] - 100 : "∞"}ms`);
});

test("pace: 平稳地流到一半突然来 1000 字，1 秒后积压不到 150 字", () => {
  // 开头一次来一大块时前馈就够快；流到一半来一大块，靠的是积压太多时的加速。
  const r = lcg(3);
  const arrivals: [number, number][] = [];
  for (let t = 100; t < 5000; t += between(r, 20, 45)) arrivals.push([t, 1 + Math.floor(r() * 4)]);
  arrivals.push([5000, 1000]);
  const frames = simulate(arrivals, 6000);
  const at = frames.find((f) => f[0] >= 6000)!;
  assert.ok(at[2] - at[1] < 150, `1 秒后还积压 ${Math.round(at[2] - at[1])} 字`);
});
