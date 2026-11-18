import assert from "node:assert/strict";
import { test } from "node:test";
import { activityAt, applyFilter, attention, buildEntries, buildProjects, classify, currentOf, filterCounts, indexPresets, projectView, railSections, seenFromInspect } from "../../../extras/gui/web/lib/derive.js";
import { formatAgo, formatBytes, formatClock, formatContext, formatDuration, formatElapsed } from "../../../extras/gui/web/lib/format.js";
import { applyEnd, applyMessage, applyPushed, emptyHistory, giveUp, known, lastTimestamp, noteSelf, plan, segmentMessages } from "../../../extras/gui/web/lib/history.js";
import { canHandoff, CARRY_HEADER, describeNow, describeStart, foldMiddle, forkPoints, HANDOFF_HEADER, parseUser, phaseStartedAt, summarizeCall, toItems, turnStart } from "../../../extras/gui/web/lib/messages.js";
import { cleanPlan, stopOrder } from "../../../extras/gui/web/lib/order.js";
import { removePlan, skippedFor } from "../../../extras/gui/web/lib/remove.js";
import { addFork, movePinned, normalizeState, pathKey, pinFolder, prunePatch, setCurrent } from "../../../extras/gui/web/lib/state.js";
import { allProcs, childCounts, emptyStore, reduce, streamingLive, streamingText } from "../../../extras/gui/web/lib/store.js";
import { extractTitle, processTitle } from "../../../extras/gui/web/lib/titles.js";
import { appendDelta, argsPreview, ARGS_KEEP, tailLines } from "../../../extras/gui/web/lib/stream.js";
import { newPace, paceArrive, paceStep } from "../../../extras/gui/web/lib/pace.js";
import { buildCreate, buildUpdate, contextText, CONTEXT_MAX, convertGate, convertPatch, defaultModelRef, filterCatalog, findModel, formatWindow, hasAgents, keyActions, keyHint, keyLabel, modelPatch, nearestLevel, parseContext, parseOptions, pushRecent, recentEntries, sortProviders, splitModel, withAgents } from "../../../extras/gui/web/lib/models.js";
import { markdownToHtml, safeHref } from "../../../extras/gui/web/lib/markdown.js";
import { firstLine, lastReply, notifyText, shouldNotify, tabTitle, trackResults, unseenCount, watchAttention } from "../../../extras/gui/web/lib/notify.js";
import { buildSession, EFFECT, EFFECT_TEXT, hasStructural, isStructural, needsInspect, pendingOf, pendingText, receiptNote, reloadFields, sessionInfo, shownErr } from "../../../extras/gui/web/lib/session.js";
import { reconfigure as apiReconfigure, inspect as apiInspect, tauCommand } from "../../../extras/gui/web/api.js";

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

// ---------- 模型选择、预设表 ----------

const CATALOG = [
  { id: "opencode-go", name: "OpenCode Go", key: "key", models: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", window: 1_000_000, image: true, thinking: ["low", "high", "max"] },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", window: 128_000, image: false, thinking: [] },
  ] },
  { id: "anthropic", name: "Anthropic", key: "none", models: [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", window: 200_000, image: true, thinking: ["minimal", "low", "medium", "high"] },
  ] },
] as any[];

test("models: 窗口写成 128K、1M；思考级别换成支持的最近一档", () => {
  assert.equal(formatWindow(128_000), "128K");
  assert.equal(formatWindow(200_000), "200K");
  assert.equal(formatWindow(1_000_000), "1M");
  assert.equal(formatWindow(2_000_000), "2M");
  assert.equal(formatWindow(1_048_576), "1M");
  assert.equal(formatWindow(1_500_000), "1.5M");
  assert.equal(formatWindow(8192), "8K");
  assert.equal(nearestLevel(["low", "high", "max"], "high"), "high");
  assert.equal(nearestLevel(["low", "high", "max"], "medium"), "low", "距离一样取低的");
  assert.equal(nearestLevel(["low", "high", "max"], "xhigh"), "high");
  assert.equal(nearestLevel(["low", "high", "max"], "minimal"), "low");
  assert.equal(nearestLevel(["high"], "max"), "high");
  assert.equal(nearestLevel([], "high"), undefined, "不支持思考就是不思考");
  assert.equal(nearestLevel(["low"], undefined), undefined);
});

test("models: 模型引用拆成供应商和模型 ID，目录里没有的返回 null", () => {
  assert.deepEqual(splitModel("opencode-go/deepseek-v4.1-flash"), { provider: "opencode-go", id: "deepseek-v4.1-flash" });
  assert.deepEqual(splitModel("a/b/c"), { provider: "a", id: "b/c" });
  assert.equal(splitModel("nomodel"), null);
  assert.equal(splitModel("/x"), null);
  assert.equal(findModel(CATALOG, "anthropic/claude-haiku-4-5")?.model.name, "Claude Haiku 4.5");
  assert.equal(findModel(CATALOG, "anthropic/ghost"), null);
  assert.equal(findModel(CATALOG, "ghost/x"), null);
  assert.equal(findModel(null, "anthropic/claude-haiku-4-5"), null);
});

test("models: 搜索按供应商和模型的名字、ID，每个词都要命中；没有命中的组去掉", () => {
  assert.deepEqual(filterCatalog(CATALOG, "").map((p: any) => p.models.length), [2, 1]);
  assert.deepEqual(filterCatalog(CATALOG, "flash").map((p: any) => p.id), ["opencode-go"]);
  assert.deepEqual(filterCatalog(CATALOG, "FLASH qwen")[0]!.models.map((m: any) => m.id), ["qwen3.8-flash"]);
  assert.deepEqual(filterCatalog(CATALOG, "anthropic")[0]!.models.length, 1, "供应商命中，整组都在");
  assert.deepEqual(filterCatalog(CATALOG, "haiku 4.5").map((p: any) => p.id), ["anthropic"]);
  assert.deepEqual(filterCatalog(CATALOG, "zzz"), []);
});

test("models: 供应商排序：配好的在前，读不了、OAuth 的次之，没配的最后，同样的按名字", () => {
  const p = (id: string, key: string) => ({ id, name: id.toUpperCase(), key, models: [] }) as any;
  const sorted = sortProviders([p("zed", "none"), p("beta", "oauth"), p("alpha", "none"), p("gamma", "key"), p("delta", "unreadable"), p("aaa", "key")]);
  assert.deepEqual(sorted.map((x: any) => x.id), ["aaa", "gamma", "delta", "beta", "alpha", "zed"]);
});

test("models: 最近用过去重、最新在前、最多 6 个；只列目录里有的", () => {
  let r: string[] = [];
  for (const m of ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7"]) r = pushRecent(r, m);
  assert.deepEqual(r, ["a/7", "a/6", "a/5", "a/4", "a/3", "a/2"]);
  assert.deepEqual(pushRecent(r, "a/4"), ["a/4", "a/7", "a/6", "a/5", "a/3", "a/2"]);
  assert.deepEqual(pushRecent([], "  "), []);
  const e = recentEntries(CATALOG, ["anthropic/claude-haiku-4-5", "ghost/x", "opencode-go/qwen3.8-flash"]);
  assert.deepEqual(e.map((x: any) => x.ref), ["anthropic/claude-haiku-4-5", "opencode-go/qwen3.8-flash"]);
});

test("models: key 状态的字", () => {
  assert.equal(keyLabel("key"), "已配");
  assert.equal(keyLabel("oauth"), "OAuth（tau 不支持）");
  assert.equal(keyLabel("none"), "没配");
  assert.equal(keyLabel("unreadable"), "tau 读不了");
});

test("models: key 的动作：没配填、已配和读不了换、只有已配能清、OAuth 没有、文件读不出都不可用", () => {
  assert.deepEqual(keyActions("none", true), { set: "填 key", clear: false });
  assert.deepEqual(keyActions("key", true), { set: "换 key", clear: true });
  assert.deepEqual(keyActions("unreadable", true), { set: "换 key", clear: false });
  assert.equal(keyActions("oauth", true), null);
  for (const k of ["key", "none", "unreadable", "oauth"] as const) assert.equal(keyActions(k, false), null);
});

test("models: 没配 key 的供应商，选中时给提示；配了的没有提示", () => {
  assert.equal(keyHint("key"), null);
  assert.match(keyHint("none")!, /还没配 key.*第一次调模型时会出错.*设置里填/);
  assert.match(keyHint("oauth")!, /OAuth.*不支持/);
  assert.match(keyHint("unreadable")!, /字面量/);
});

test("models: 默认模型：设置里的，再是最近用过的，再是第一家配了 key 的第一个，都没有是空", () => {
  const g = (o: object = {}) => normalizeState(o);
  assert.equal(defaultModelRef(g({ defaultModel: "x/hand-written" }), CATALOG), "x/hand-written");
  assert.equal(defaultModelRef(g({ recentModels: ["ghost/x", "anthropic/claude-haiku-4-5"] }), CATALOG), "anthropic/claude-haiku-4-5");
  assert.equal(defaultModelRef(g(), CATALOG), "opencode-go/deepseek-v4.1-flash", "anthropic 没配 key，跳过");
  assert.equal(defaultModelRef(g(), CATALOG.map((p: any) => ({ ...p, key: "none" }))), "");
  assert.equal(defaultModelRef(g(), null), "");
});

test("models: options 一行 JSON：空是没有，只收对象，错了给原因", () => {
  assert.deepEqual(parseOptions(""), { ok: true, value: undefined });
  assert.deepEqual(parseOptions("  "), { ok: true, value: undefined });
  assert.deepEqual(parseOptions('{"temperature":0.2}'), { ok: true, value: { temperature: 0.2 } });
  for (const bad of ["{", "[]", "3", '"x"', "null"]) {
    const r = parseOptions(bad);
    assert.equal(r.ok, false, bad);
  }
});

const ORIG = { id: "a", ok: true, workdir: "E:\\w", model: "x/m", tools: ["read", "bash", "mytool"], memory: false, thinking: "low", handoff: 150000, options: { temperature: 0.2 } } as any;
const DRAFT = { model: "x/m", thinking: "low", tools: ["read", "bash", "mytool"], handoff: "150000", options: '{"temperature":0.2}', prompt: "p", context: "" };

test("预设表: 改预设只发变了的字段；没变就是空补丁；提示词没动不发", () => {
  assert.deepEqual(buildUpdate(ORIG, "p", DRAFT), { ok: true, patch: {} });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, model: "y/n", thinking: "high" }), { ok: true, patch: { model: "y/n", thinking: "high" } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, thinking: undefined }), { ok: true, patch: { thinking: null } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, tools: ["read", "mytool"] }), { ok: true, patch: { tools: ["read", "mytool"] } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, handoff: "" }), { ok: true, patch: { handoff: null } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, handoff: "160000" }), { ok: true, patch: { handoff: 160000 } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, options: "" }), { ok: true, patch: { options: null } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, options: '{"temperature":0.5}' }), { ok: true, patch: { options: { temperature: 0.5 } } });
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, prompt: "新" }), { ok: true, patch: { prompt: "新" } });
  assert.deepEqual(buildUpdate({ id: "b", ok: true, workdir: "w", model: "x/m", tools: [], memory: false } as any, "", { ...DRAFT, tools: [], thinking: undefined, handoff: "", options: "", prompt: "" }), { ok: true, patch: {} });
  for (const bad of [{ handoff: "0" }, { handoff: "1.5" }, { handoff: "abc" }, { options: "[" }, { model: " " }, { context: "a,b" }, { context: "1\n2\n3\n4\n5\n6\n7\n8\n9" }]) {
    assert.equal(buildUpdate(ORIG, "p", { ...DRAFT, ...bad }).ok, false, JSON.stringify(bad));
  }
});

test("预设表: 上下文文件一行一个路径，去空白、跳空行、去重；最多 8 行；逗号和过长的不行；空是没有", () => {
  assert.deepEqual(parseContext(""), { ok: true, value: undefined });
  assert.deepEqual(parseContext(" \n \r\n"), { ok: true, value: undefined });
  assert.deepEqual(parseContext(" AGENTS.md \r\n\ndocs/a.md\nAGENTS.md\nE:\\x\\b.md"), { ok: true, value: ["AGENTS.md", "docs/a.md", "E:\\x\\b.md"] });
  assert.equal(parseContext(Array.from({ length: CONTEXT_MAX }, (_, i) => `f${i}`).join("\n")).ok, true);
  assert.equal(parseContext(Array.from({ length: CONTEXT_MAX + 1 }, (_, i) => `f${i}`).join("\n")).ok, false);
  assert.equal(parseContext([...Array.from({ length: CONTEXT_MAX }, (_, i) => `f${i}`), "f0"].join("\n")).ok, true, "重复的先去掉再数");
  assert.equal(parseContext("a,b.md").ok, false);
  assert.equal(parseContext("x".repeat(261)).ok, false);
  assert.equal(parseContext("x".repeat(260)).ok, true);
  assert.equal(parseContext("a\u0001b").ok, false);
  assert.equal(CONTEXT_MAX, 8);
});

test("预设表: AGENTS.md 勾选是上下文文件字段的快捷：勾上加一行（已有不重复），取消去掉这一行，别的行原样", () => {
  assert.equal(hasAgents(""), false);
  assert.equal(hasAgents("docs/AGENTS.md"), false, "整行才算");
  assert.equal(hasAgents("a.md\n AGENTS.md \nb.md"), true);
  assert.equal(withAgents("", true), "AGENTS.md");
  assert.equal(withAgents("a.md\n", true), "a.md\nAGENTS.md");
  assert.equal(withAgents("a.md\nAGENTS.md", true), "a.md\nAGENTS.md");
  assert.equal(withAgents("a.md\nAGENTS.md\nb.md", false), "a.md\nb.md");
  assert.equal(withAgents("a.md", false), "a.md");
  assert.equal(withAgents("AGENTS.md", false), "");
  assert.equal(contextText(["a.md", "b.md"]), "a.md\nb.md");
  assert.equal(contextText(undefined), "");
});

test("预设表: 改预设的上下文文件——加、换、去掉（发 null）；没变不发；空数组和没有一样", () => {
  assert.deepEqual(buildUpdate(ORIG, "p", { ...DRAFT, context: "AGENTS.md" }), { ok: true, patch: { context: ["AGENTS.md"] } });
  const withCtx = { ...ORIG, context: ["AGENTS.md", "docs/a.md"] };
  assert.deepEqual(buildUpdate(withCtx, "p", { ...DRAFT, context: "AGENTS.md\ndocs/a.md" }), { ok: true, patch: {} });
  assert.deepEqual(buildUpdate(withCtx, "p", { ...DRAFT, context: "docs/a.md" }), { ok: true, patch: { context: ["docs/a.md"] } });
  assert.deepEqual(buildUpdate(withCtx, "p", { ...DRAFT, context: "" }), { ok: true, patch: { context: null } });
  assert.deepEqual(buildUpdate({ ...ORIG, context: [] }, "p", DRAFT), { ok: true, patch: {} });
});

test("预设表: 转成上下文文件——保存时发 agentsMd: false，context 里加 AGENTS.md；只在有旧块时；项目概况里一键转的补丁", () => {
  const legacy = { ...ORIG, agentsMd: "legacy" };
  assert.deepEqual(buildUpdate(legacy, "p", { ...DRAFT, context: "AGENTS.md", convert: true }), { ok: true, patch: { context: ["AGENTS.md"], agentsMd: false } });
  assert.deepEqual(buildUpdate(legacy, "p", DRAFT), { ok: true, patch: {} }, "没点就不动旧块");
  assert.deepEqual(buildUpdate({ ...ORIG, agentsMd: "none" }, "p", { ...DRAFT, convert: true }), { ok: true, patch: {} }, "没有旧块就没有可转的");
  const here = { exists: true };
  assert.deepEqual(convertPatch({}, here), { ok: true, patch: { agentsMd: false, context: ["AGENTS.md"] } });
  assert.deepEqual(convertPatch({ context: ["docs/a.md"] }, here), { ok: true, patch: { agentsMd: false, context: ["docs/a.md", "AGENTS.md"] } });
  assert.deepEqual(convertPatch({ context: ["AGENTS.md", "docs/a.md"] }, here), { ok: true, patch: { agentsMd: false, context: ["AGENTS.md", "docs/a.md"] } }, "已有不重复");
});

test("预设表: 转成上下文文件要项目里有 AGENTS.md——没有时旧块可能是最后一份内容，不让转；没查到、查不了也不让转", () => {
  assert.deepEqual(convertGate({ exists: true }), { ok: true });
  const none = convertGate({ exists: false });
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.note : "", /项目里没有 AGENTS\.md，旧块是最后一份内容，转了就读不到/);
  const loading = convertGate(null);
  assert.equal(loading.ok, false, "还没查到：不能确认文件在");
  const bad = convertGate({ exists: false, bad: true });
  assert.equal(bad.ok, false);
  assert.notEqual(!bad.ok ? bad.note : "", !none.ok ? none.note : "", "查不了的目录，原因不一样");
  // 项目概况里一键转也一样：没有 AGENTS.md 不给补丁，只给原因。
  assert.deepEqual(convertPatch({ context: ["docs/a.md"] }, { exists: false }), { ok: false, note: !none.ok ? none.note : "" });
  assert.equal(convertPatch({}, null).ok, false);
  assert.equal(convertPatch({}, { exists: false, bad: true }).ok, false);
});

test("换模型: 改预设的补丁只带和文件不同的模型和思考强度", () => {
  const file = { model: "x/m", thinking: "low" };
  assert.deepEqual(modelPatch(file, "x/m", "low"), {});
  assert.deepEqual(modelPatch(file, "y/n", "low"), { model: "y/n" });
  assert.deepEqual(modelPatch(file, "x/m", "high"), { thinking: "high" });
  assert.deepEqual(modelPatch(file, "x/m", undefined), { thinking: null });
  assert.deepEqual(modelPatch({ model: "x/m" }, "y/n", undefined), { model: "y/n" });
  assert.deepEqual(modelPatch({ model: "x/m" }, " y/n ", "max"), { model: "y/n", thinking: "max" });
});

test("预设表: 新建只带填了的 thinking、handoff、options、context", () => {
  assert.deepEqual(buildCreate({ ...DRAFT, thinking: undefined, handoff: "", options: "" }), { ok: true, fields: {} });
  assert.deepEqual(buildCreate(DRAFT), { ok: true, fields: { thinking: "low", handoff: 150000, options: { temperature: 0.2 } } });
  assert.deepEqual(buildCreate({ ...DRAFT, context: "AGENTS.md\ndocs/a.md" }), { ok: true, fields: { thinking: "low", handoff: 150000, options: { temperature: 0.2 }, context: ["AGENTS.md", "docs/a.md"] } });
  assert.equal(buildCreate({ ...DRAFT, context: "a,b" }).ok, false);
  assert.equal(buildCreate({ ...DRAFT, handoff: "-3" }).ok, false);
  assert.equal(buildCreate({ ...DRAFT, options: "{" }).ok, false);
});

test("界面数据: 最近用过的模型、默认模型和思考强度有默认值，坏的当没有", () => {
  const g = normalizeState({});
  assert.deepEqual(g.recentModels, []);
  assert.equal(g.defaultModel, undefined);
  assert.equal(g.defaultThinking, undefined);
  const h = normalizeState({ recentModels: ["a/b", 3, "c/d"], defaultModel: "x/y", defaultThinking: "high" });
  assert.deepEqual(h.recentModels, ["a/b", "c/d"]);
  assert.equal(h.defaultModel, "x/y");
  assert.equal(h.defaultThinking, "high");
  const bad = normalizeState({ defaultModel: 5, defaultThinking: "huge", recentModels: "x" });
  assert.equal(bad.defaultModel, undefined);
  assert.equal(bad.defaultThinking, undefined);
  assert.deepEqual(bad.recentModels, []);
});

test("inspect: 快照里还带模型、思考强度、换段阈值和 options", () => {
  const f = seenFromInspect({ type: "process", process: { preset: { workdir: "E:\\w", tools: ["read", "memory"], toolDefs: [{ name: "t" }], model: "x/m", thinking: "high", handoff: 90000, options: { temperature: 0.1 } } } });
  assert.deepEqual(f, { workdir: "E:\\w", tools: ["read", "memory", "t"], memory: true, model: "x/m", thinking: "high", handoff: 90000, options: { temperature: 0.1 } });
  const g = seenFromInspect({ type: "process", process: { preset: { workdir: "E:\\w", tools: ["read"], model: "x/m" } } });
  assert.deepEqual(g, { workdir: "E:\\w", tools: ["read"], memory: false, model: "x/m" });
  const c = seenFromInspect({ type: "process", process: { preset: { workdir: "E:\\w", tools: ["read"], model: "x/m", context: ["AGENTS.md", 3, "a.md"] } } });
  assert.deepEqual(c?.context, ["AGENTS.md", "a.md"]);
  assert.equal(seenFromInspect({ type: "process", process: { preset: { workdir: "E:\\w", tools: ["read"], model: "x/m", context: [] } } })?.context, undefined, "空的当没有");
});

// ---------- Markdown ----------

test("markdown: GFM 的表格、删除线、任务列表、围栏代码块", () => {
  const h = markdownToHtml("## 标题\n\n~~旧~~ **新** `x`\n\n- [x] 做完\n- [ ] 没做\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1 < 2;\n```\n");
  assert.match(h, /<h2>标题<\/h2>/);
  assert.match(h, /<del>旧<\/del>/);
  assert.match(h, /<input checked="" disabled="" type="checkbox">/);
  assert.match(h, /<div class="md-tw"><table>[\s\S]*<\/table><\/div>/);
  assert.match(h, /<span class="md-lang">ts<\/span><button type="button" class="md-copy" data-md-copy>复制<\/button>/);
  assert.match(h, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
});

test("markdown: 原始 HTML 按文字转义，块级和行内都一样", () => {
  const h = markdownToHtml("<script>alert(1)</script>\n\n行内 <img src=x onerror=alert(1)> 和 <b>粗</b>");
  assert.ok(!/<script|<img|<b>/.test(h), h);
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("markdown: 链接只认 http、https、mailto，新标签页打开", () => {
  assert.equal(safeHref("https://a.com/x?y=1"), "https://a.com/x?y=1");
  assert.equal(safeHref("HTTP://a.com"), "HTTP://a.com");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "/rel/path", "#frag", "ftp://x", "https://a b", ""]) assert.equal(safeHref(bad), null, bad);
  const h = markdownToHtml("[好](https://a.com) [坏](javascript:alert(1)) [引](https://a.com \"t\\\"x\")");
  assert.match(h, /<a href="https:\/\/a.com" target="_blank" rel="noopener noreferrer">好<\/a>/);
  assert.ok(!h.includes("javascript"), h);
  assert.match(h, / 坏 /);
  assert.match(h, /title="t&quot;x"/);
});

test("markdown: 图片不加载，显示成链接或文字", () => {
  const h = markdownToHtml("![图](https://a.com/x.png) ![坏](javascript:x)");
  assert.ok(!h.includes("<img"), h);
  assert.match(h, /<a href="https:\/\/a.com\/x.png"[^>]*>图<\/a>/);
  assert.match(h, /坏/);
});

test("markdown: 代码块的语言标签只留短的字母数字，内容转义", () => {
  const h = markdownToHtml("```\"><b>\n<i>&\n```");
  assert.match(h, /<span class="md-lang"><\/span>/);
  assert.match(h, /&lt;i&gt;&amp;/);
  assert.ok(!/<b>|<i>/.test(h), h);
});

// ---------- 通知 ----------

test("notify: 标签页标题", () => {
  assert.equal(tabTitle(0), "tau");
  assert.equal(tabTitle(3), "(3) tau");
});

test("notify: 谁刚进入待你看——首次只记下，离开再进入算新的一轮，数据没读全不动", () => {
  let r = watchAttention(null, ["a"], false);
  assert.deepEqual(r, { next: null, entered: [] });
  r = watchAttention(r.next, ["a"], true);
  assert.deepEqual([...(r.next ?? [])], ["a"]);
  assert.deepEqual(r.entered, []);
  r = watchAttention(r.next, ["a", "b"], true);
  assert.deepEqual(r.entered, ["b"]);
  r = watchAttention(r.next, ["a", "b"], true);
  assert.deepEqual(r.entered, []);
  const gone = watchAttention(r.next, ["a"], true);
  assert.deepEqual(gone.entered, []);
  assert.deepEqual(watchAttention(gone.next, ["a", "b"], true).entered, ["b"]);
  const held = watchAttention(gone.next, [], false);
  assert.equal(held.next, gone.next);
});

test("notify: 开关开着、许可了、页面不在前台才通知", () => {
  assert.equal(shouldNotify({ enabled: true, permission: "granted", away: true }), true);
  assert.equal(shouldNotify({ enabled: false, permission: "granted", away: true }), false);
  assert.equal(shouldNotify({ enabled: true, permission: "denied", away: true }), false);
  assert.equal(shouldNotify({ enabled: true, permission: "default", away: true }), false);
  assert.equal(shouldNotify({ enabled: true, permission: "granted", away: false }), false);
});

test("notify: 正文是结束原因加最终回复的第一行，长的截短", () => {
  assert.equal(firstLine("\n  \n 第一行 \n第二行"), "第一行");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("字".repeat(100), 5), "字字字字字…");
  const msgs = [user("hi"), asst([text("旧")]), asst([call("1", "bash", {})]), asst([text("\n结果在这\n别的"), text("尾")])];
  assert.equal(lastReply(msgs as any), "\n结果在这\n别的\n尾");
  assert.equal(lastReply([user("x")] as any), "");
  assert.deepEqual(notifyText("甲", "出错", "\n好了\n后面"), { title: "甲", body: "出错：好了" });
  assert.deepEqual(notifyText("甲", "出错", ""), { title: "甲", body: "出错" });
});

test("state: notify 只在为 true 时保留", () => {
  assert.equal(normalizeState({ notify: true }).notify, true);
  assert.equal("notify" in normalizeState({ notify: false }), false);
  assert.equal("notify" in normalizeState({ notify: "yes" }), false);
});

test("notify: 新结果——根进程一轮结束算，子进程不算，首次不算", () => {
  const P = (id: string, busy: boolean, root = true) => ({ id, root, busy });
  const o = { focusedId: null as string | null, away: true, ready: true };
  let r = trackResults(null, [P("a", false), P("b", true)], { ...o, ready: false });
  assert.equal(r.next, null);
  r = trackResults(null, [P("a", false), P("b", true)], o);
  assert.deepEqual(r.ended, []);
  assert.equal(r.next!.results.size, 0);
  r = trackResults(r.next, [P("a", false), P("b", false), P("c", true, false)], o);
  assert.deepEqual(r.ended, ["b"]);
  assert.deepEqual([...r.next!.results], ["b"]);
  r = trackResults(r.next, [P("a", false), P("b", false), P("c", false, false)], o);
  assert.deepEqual(r.ended, []);
  assert.deepEqual([...r.next!.results], ["b"]);
});

test("notify: 新结果在前台聚焦时清掉，页面不在前台不清，进程没了也清", () => {
  const P = (id: string, busy: boolean) => ({ id, root: true, busy });
  let r = trackResults(null, [P("a", true), P("b", true)], { focusedId: null, away: true, ready: true });
  r = trackResults(r.next, [P("a", false), P("b", false)], { focusedId: "a", away: true, ready: true });
  assert.deepEqual(r.ended, ["a", "b"]);
  assert.deepEqual([...r.next!.results].sort(), ["a", "b"]);
  r = trackResults(r.next, [P("a", false), P("b", false)], { focusedId: "a", away: false, ready: true });
  assert.deepEqual([...r.next!.results], ["b"]);
  r = trackResults(r.next, [P("a", false)], { focusedId: null, away: false, ready: true });
  assert.equal(r.next!.results.size, 0);
  // 前台时聚焦的进程结束：算刚结束（由调用方决定弹不弹），但不留在结果里。
  r = trackResults(trackResults(null, [P("a", true)], { focusedId: "a", away: false, ready: true }).next, [P("a", false)], { focusedId: "a", away: false, ready: true });
  assert.deepEqual(r.ended, ["a"]);
  assert.equal(r.next!.results.size, 0);
});

test("notify: 标题的数是待你看和新结果去重后的进程数", () => {
  assert.equal(unseenCount(["a", "b"], new Set(["b", "c"])), 3);
  assert.equal(unseenCount([], new Set()), 0);
});

test("stream: 按 kind 分开存，正文照旧，编号的规则不变", () => {
  const running = { tag: "awaitingModel", steps: 1, purpose: "turn" } as Self["phase"];
  let s = reduce(emptyStore(), { type: "ps", processes: [proj(self("a", { phase: running }))] }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 4, delta: "嗯", kind: "thinking" }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 4, delta: "，先看看", kind: "thinking" }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 4, delta: "你好" }, NOW);
  s = reduce(s, { type: "text", process: "a", n: 4, delta: '{"command":', kind: "toolCall" }, NOW);
  assert.deepEqual(streamingLive(s, "a"), { n: 4, text: "你好", thinking: "嗯，先看看", args: '{"command":', argsLen: 11 });
  assert.equal(streamingText(s, "a"), "你好");
  // 新编号：三样一起从头来；旧编号的思考丢掉。
  s = reduce(s, { type: "text", process: "a", n: 5, delta: "新", kind: "thinking" }, NOW);
  assert.deepEqual(streamingLive(s, "a"), { n: 5, text: "", thinking: "新", args: "", argsLen: 0 });
  assert.equal(reduce(s, { type: "text", process: "a", n: 4, delta: "旧", kind: "thinking" }, NOW), s);
  // 不认识的 kind 不当成正文。
  assert.equal(appendDelta(undefined, { n: 1, delta: "x", kind: "other" }), undefined);
  assert.equal(appendDelta(streamingLive(s, "a")!, { n: 5, delta: "x", kind: "other" })!.text, "");
  // 离开等模型：全清。
  s = reduce(s, { type: "update", self: self("a", { phase: { tag: "awaitingTool", steps: 1, queued: 0 } as Self["phase"] }) }, NOW);
  assert.equal(streamingLive(s, "a"), null);
  assert.equal(s.text["a"], undefined);
});

test("stream: 参数只存尾巴，总字数另记；预览压成一行", () => {
  let l = appendDelta(undefined, { n: 1, delta: "a".repeat(ARGS_KEEP), kind: "toolCall" })!;
  l = appendDelta(l, { n: 1, delta: "b".repeat(10), kind: "toolCall" })!;
  assert.equal(l.args.length, ARGS_KEEP);
  assert.equal(l.args.endsWith("bbbbbbbbbb"), true);
  assert.equal(l.argsLen, ARGS_KEEP + 10);
  assert.equal(argsPreview('{\n  "a":  1\n}', 50), '{ "a": 1 }');
  assert.equal(argsPreview("一二三四五六", 3), "…四五六");
});

test("stream: tailLines 留最后几行，末尾空行不算", () => {
  assert.deepEqual(tailLines("a\nb\nc\n\n", 5), { text: "a\nb\nc", hidden: 0 });
  assert.deepEqual(tailLines("1\n2\n3\n4\n5", 2), { text: "4\n5", hidden: 3 });
});

test("history: watch 推来的消息接在后面，重复和跳号的丢掉，换段从 0 起", () => {
  const s1 = self("a", { segment: 1, messages: 3 });
  let h = noteSelf(emptyHistory(), s1);
  h = feed(h, 1, 0, 2);
  // 正好接上。
  h = applyPushed(h, s1, { segment: 1, seq: 2, message: user("m1-2", 2) });
  assert.equal(known(h, 1), 3);
  // 重复（重连后重读和推送重叠）：不变，不覆盖。
  const same = applyPushed(h, s1, { segment: 1, seq: 1, message: user("改", 9) });
  assert.equal(segmentMessages(same, 1)[1]!.timestamp, 1);
  // 跳号：不收，缓存比 self.messages 少，plan 会用 history 补。
  const s2 = self("a", { segment: 1, messages: 6 });
  h = applyPushed(h, s2, { segment: 1, seq: 5, message: user("跳", 5) });
  assert.equal(known(h, 1), 3);
  assert.deepEqual(plan(h, s2), { segment: 1, from: 3, sealed: false });
  // 补上以后，推送接着来。
  h = feed(h, 1, 3, 2);
  h = applyPushed(h, s2, { segment: 1, seq: 5, message: user("m1-5", 5) });
  assert.equal(known(h, 1), 6);
  // 换段：update 先到（段号变了），新段的消息从 0 起；旧段留给 plan 读完。
  const s3 = self("a", { segment: 2, messages: 1 });
  h = applyPushed(h, s3, { segment: 2, seq: 0, message: user("新段", 7) });
  assert.equal(known(h, 2), 1);
  assert.deepEqual(plan(h, s3), { segment: 1, from: 6, sealed: true });
  // 没读过的段：不收。
  assert.equal(known(applyPushed(h, s3, { segment: 9, seq: 0, message: user("x", 1) }), 9), 0);
});

test("peeker: watch 推来的消息接在末尾后面，不再读 history；跳号的不收", async () => {
  const { createPeeker } = await import("../../../extras/gui/web/conn.js");
  const got: { segment: number; total: number; n: number }[] = [];
  const p = createPeeker({ onPeek: (_id: string, v: any) => got.push({ segment: v.segment, total: v.total, n: v.msgs.length }), onTitle: () => {} });
  p.push("a", { segment: 1, seq: 3, message: user("跳", 1) });
  assert.equal(got.length, 0);
  for (let i = 0; i < 8; i++) p.push("a", { segment: 1, seq: i, message: user(`m${i}`, i) });
  assert.deepEqual(got.at(-1), { segment: 1, total: 8, n: 6 });
  p.push("a", { segment: 1, seq: 8, message: user("m8", 8) });
  assert.equal(got.at(-1)!.total, 9);
  p.push("a", { segment: 2, seq: 0, message: user("新段", 9) });
  assert.deepEqual(got.at(-1), { segment: 2, total: 1, n: 1 });
  p.forget("a");
});

// ---------- 改这个会话（reconfigure，D71）----------

const BEGIN_MARK = "<!-- tau-gui:agents-md begin | 说明 | E:\\w\\AGENTS.md -->";
const END_MARK = "<!-- tau-gui:agents-md end -->";
const LEGACY = [BEGIN_MARK, "# 规则", "一条", END_MARK];

/** `inspect` 的一行 `process`：会话快照 `preset`，可选的待换配置 `next`。 */
function procLine(preset: Record<string, unknown>, next?: Record<string, unknown>) {
  const base = { id: "p", workdir: "E:\\w", model: "x/m", tools: ["read", "memory"], toolDefs: [{ name: "mytool" }], prompt: "提示词", contextWindow: 200_000, input: ["text"], ...preset };
  return { type: "process", process: { id: "abc", preset: base, ...(next ? { next: { ...base, ...next } } : {}) }, messages: 3, limits: { threshold: 100_000 } };
}

test("会话表: 初值取 inspect 的会话快照；有 next 取 next；工具是内置加工具定义的名字；旧拼接块拆出来", () => {
  const a = sessionInfo(procLine({ thinking: "low", handoff: 90000, options: { temperature: 0.1 }, context: ["AGENTS.md", "docs/a.md"] }))!;
  assert.deepEqual(a, {
    id: "p", ok: true, workdir: "E:\\w", model: "x/m", tools: ["read", "memory", "mytool"], memory: true, prompt: "提示词", agentsMd: "none", block: null, pending: false,
    thinking: "low", handoff: 90000, options: { temperature: 0.1 }, context: ["AGENTS.md", "docs/a.md"],
  });
  const n = sessionInfo(procLine({}, { model: "y/n", prompt: `新的\n\n${LEGACY.join("\n")}`, context: ["AGENTS.md"] }))!;
  assert.deepEqual([n.model, n.pending, n.prompt, n.agentsMd, n.block, n.context], ["y/n", true, "新的", "legacy", LEGACY, ["AGENTS.md"]]);
  const bare = sessionInfo(procLine({ toolDefs: undefined, context: [] }))!;
  assert.deepEqual([bare.tools, bare.context, "thinking" in bare], [["read", "memory"], undefined, false]);
  assert.equal(sessionInfo({ type: "inspected" }), null);
  assert.equal(sessionInfo({ type: "process", process: { preset: { model: "x/m" } } }), null);
});

const SESSION = () => sessionInfo(procLine({ thinking: "low", handoff: 90000, options: { temperature: 0.1 }, context: ["AGENTS.md"], prompt: `手写\n\n${LEGACY.join("\n")}` }))!;
const SDRAFT = { model: "x/m", thinking: "low", tools: ["read", "memory", "mytool"], handoff: "90000", options: '{"temperature":0.1}', prompt: "手写", context: "AGENTS.md", workdir: "E:\\w" };

test("会话表: 变成 reconfigure 的 fields——只发变了的，去掉的发 null；没变是空", () => {
  const o = SESSION();
  assert.deepEqual(buildSession(o, SDRAFT), { ok: true, fields: {} });
  assert.deepEqual(buildSession(o, { ...SDRAFT, model: " y/n " }), { ok: true, fields: { model: "y/n" } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, thinking: "high" }), { ok: true, fields: { thinking: "high" } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, thinking: undefined }), { ok: true, fields: { thinking: null } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, handoff: "" }), { ok: true, fields: { handoff: null } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, handoff: "50000" }), { ok: true, fields: { handoff: 50000 } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, options: "" }), { ok: true, fields: { options: null } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, options: '{"temperature":0.5}' }), { ok: true, fields: { options: { temperature: 0.5 } } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, context: "" }), { ok: true, fields: { context: null } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, context: "AGENTS.md\ndocs/a.md" }), { ok: true, fields: { context: ["AGENTS.md", "docs/a.md"] } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, tools: ["read", "bash", "mytool"] }), { ok: true, fields: { tools: ["read", "bash", "mytool"] } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, model: "y/n", thinking: "high", context: "" }), { ok: true, fields: { model: "y/n", thinking: "high", context: null } });
  // 没有这些键的快照：填上就是加，空着就是没变。
  const bare = sessionInfo(procLine({}))!;
  assert.deepEqual(buildSession(bare, { ...SDRAFT, thinking: undefined, handoff: "", options: "", context: "", prompt: "提示词", tools: ["read", "memory", "mytool"] }), { ok: true, fields: {} });
  assert.deepEqual(buildSession(bare, { ...SDRAFT, thinking: "low", handoff: "9", options: '{"temperature":1}', context: "a.md", prompt: "提示词" }), { ok: true, fields: { thinking: "low", handoff: 9, options: { temperature: 1 }, context: ["a.md"] } });
});

test("会话表: 工具只看集合，顺序变了不算改；工作目录不分大小写和斜杠方向，真的变了才发", () => {
  const o = SESSION();
  assert.deepEqual(buildSession(o, { ...SDRAFT, tools: ["mytool", "read", "memory"] }), { ok: true, fields: {} });
  assert.deepEqual(buildSession(o, { ...SDRAFT, tools: ["read", "memory"] }), { ok: true, fields: { tools: ["read", "memory"] } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, workdir: "e:/w/" }), { ok: true, fields: {} });
  assert.deepEqual(buildSession(o, { ...SDRAFT, workdir: " E:\\other " }), { ok: true, fields: { workdir: "E:\\other" } });
  const { workdir: _w, ...noDir } = SDRAFT;
  assert.deepEqual(buildSession(o, noDir), { ok: true, fields: {} }, "表里没有工作目录（预设表）就是没变");
});

test("会话表: 提示词只编辑用户写的部分，旧拼接块接回去；点了转成上下文文件才去掉", () => {
  const o = SESSION();
  assert.deepEqual([o.prompt, o.agentsMd], ["手写", "legacy"]);
  assert.deepEqual(buildSession(o, { ...SDRAFT, prompt: "手写 " }), { ok: true, fields: {} }, "没动不发");
  assert.deepEqual(buildSession(o, { ...SDRAFT, prompt: "新写的" }), { ok: true, fields: { prompt: `新写的\n\n${LEGACY.join("\n")}` } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, prompt: "" }), { ok: true, fields: { prompt: LEGACY.join("\n") } });
  assert.deepEqual(buildSession(o, { ...SDRAFT, convert: true, context: "AGENTS.md" }), { ok: true, fields: { prompt: "手写" } }, "去块，context 本来就有");
  assert.deepEqual(buildSession(o, { ...SDRAFT, convert: true, prompt: "新写的", context: "AGENTS.md\ndocs/a.md" }), { ok: true, fields: { prompt: "新写的", context: ["AGENTS.md", "docs/a.md"] } });
  // 没有旧块：prompt 就是用户写的；convert 没有意义。
  const plain = sessionInfo(procLine({}))!;
  const same = { ...SDRAFT, thinking: undefined, handoff: "", options: "", context: "" };
  assert.deepEqual(buildSession(plain, { ...same, prompt: "改了" }), { ok: true, fields: { prompt: "改了" } });
  assert.deepEqual(buildSession(plain, { ...same, prompt: "提示词", convert: true }), { ok: true, fields: {} });
});

test("会话表: 填错了不发——模型、工作目录不能空，换段阈值、options、上下文文件的写法", () => {
  const o = SESSION();
  for (const bad of [{ model: " " }, { workdir: "  " }, { handoff: "0" }, { handoff: "abc" }, { options: "[" }, { context: "a,b" }, { context: "1\n2\n3\n4\n5\n6\n7\n8\n9" }]) {
    assert.equal(buildSession(o, { ...SDRAFT, ...bad }).ok, false, JSON.stringify(bad));
  }
});

test("会话表: 字段什么时候生效——调用参数下一次调用，结构性字段换段时；有结构性字段才给“保存后马上换段”", () => {
  assert.deepEqual(["thinking", "options", "handoff"].map((f) => (EFFECT as any)[f]), ["call", "call", "call"]);
  assert.deepEqual(["model", "prompt", "tools", "workdir", "context"].map((f) => (EFFECT as any)[f]), ["segment", "segment", "segment", "segment", "segment"]);
  assert.deepEqual([EFFECT_TEXT.call, EFFECT_TEXT.segment], ["下一次调用生效", "换段时生效"]);
  assert.deepEqual(["thinking", "model", "context", "id", "nope"].map(isStructural), [false, true, true, false, false]);
  assert.equal(hasStructural({ thinking: null, handoff: 1, options: null }), false);
  assert.equal(hasStructural({ thinking: null, prompt: "x" }), true);
  assert.equal(hasStructural({}), false);
  assert.equal(hasStructural(["model", "prompt"]), true);
  assert.equal(hasStructural([]), false);
});

test("待换段条: 字段名写成中文，顺序照投影；没有待换配置没有这一条；新字段原样写", () => {
  assert.equal(pendingText([]), null);
  assert.equal(pendingText(["model", "prompt"]), "待换段：模型、提示词");
  assert.equal(pendingText(["model", "prompt", "tools", "workdir", "context"]), "待换段：模型、提示词、工具、工作目录、上下文文件");
  assert.equal(pendingText(["context", "future"]), "待换段：上下文文件、future");
  assert.deepEqual(pendingOf(self("a", { pending: { fields: ["model", "prompt"] } })), ["model", "prompt"]);
  assert.deepEqual(pendingOf(self("a")), []);
  assert.deepEqual(pendingOf(undefined), []);
  assert.deepEqual(pendingOf({ pending: { fields: [1, "tools"] } } as any), ["tools"]);
});

test("快照的更新: update 带来的变化——第一次见、模型、换段、待换配置变了才重读 inspect", () => {
  const a = self("a", { segment: 2 });
  assert.equal(needsInspect(undefined, a), true);
  assert.equal(needsInspect(a, self("a", { segment: 2, messages: 9, context: { used: 500, window: 1000 }, phase: running })), false, "别的变化不重读");
  assert.equal(needsInspect(a, self("a", { segment: 3 })), true, "换段：采用了待换的快照");
  assert.equal(needsInspect(a, self("a", { segment: 2, model: "y/n" })), true);
  assert.equal(needsInspect(a, self("a", { segment: 2, pending: { fields: ["prompt"] } })), true, "出现待换配置");
  const p = self("a", { segment: 2, pending: { fields: ["prompt"] } });
  assert.equal(needsInspect(p, self("a", { segment: 2, pending: { fields: ["prompt"] } })), false);
  assert.equal(needsInspect(p, self("a", { segment: 2, pending: { fields: ["prompt", "tools"] } })), true);
  assert.equal(needsInspect(p, a), true, "取消或采用以后没有了");
});

test("会话快照: 每次读到 inspect 都更新归类用的快照（阈值、模型、工具），不是建好后读一次", () => {
  const before = seenFromInspect(procLine({ handoff: 90000 }))!;
  const line = procLine({ handoff: 50000, thinking: "high", model: "y/n", toolDefs: [] });
  (line as any).limits = { threshold: 50000 };
  const after = seenFromInspect(line)!;
  assert.deepEqual([before.threshold, before.handoff, before.model], [100_000, 90000, "x/m"]);
  assert.deepEqual([after.threshold, after.handoff, after.thinking, after.model, after.tools], [50000, 50000, "high", "y/n", ["read", "memory"]]);
  // 有 next 时，界面的会话快照还是当前的：threshold 按当前的算，next 只给表的初值。
  const pending = procLine({}, { model: "z/w", context: ["AGENTS.md"] });
  assert.deepEqual([seenFromInspect(pending)!.model, seenFromInspect(pending)!.context, sessionInfo(pending)!.model], ["x/m", undefined, "z/w"]);
});

test("回执的话: pending 为真说有待换配置，为假不乱说是哪一种", () => {
  assert.match(receiptNote(true), /待换配置/);
  assert.match(receiptNote(false), /没有待换配置/);
  assert.notEqual(receiptNote(true), receiptNote(false));
});

test("重读工具定义: 发的是会话已存的工具列表，不是表里没保存的勾选；发的是副本", () => {
  const o = SESSION();
  assert.deepEqual(reloadFields(o), { tools: ["read", "memory", "mytool"] });
  // 表里勾掉了 mytool、加了 bash 但没保存：reloadFields 只看会话快照，不看表。
  const unsaved = { ...SDRAFT, tools: ["read", "bash"] };
  assert.deepEqual(buildSession(o, unsaved), { ok: true, fields: { tools: ["read", "bash"] } }, "表确实改了");
  assert.deepEqual(reloadFields(o), { tools: ["read", "memory", "mytool"] }, "但重读发的没变");
  reloadFields(o).tools.push("x");
  assert.deepEqual(o.tools, ["read", "memory", "mytool"], "改发出去的不动快照");
  // 有待换配置时，快照取的是待换的那一份，重读发的也是它。
  const pending = sessionInfo(procLine({}, { tools: ["read"], toolDefs: [] }))!;
  assert.deepEqual(reloadFields(pending), { tools: ["read"] });
});

test("保存失败的原文: 只在表没动的时候显示；表一动（样子变了）就不显示，别的填写错误能露出来", () => {
  const sig = JSON.stringify(SDRAFT);
  assert.equal(shownErr(null, sig), null);
  const err = { text: "服务拒绝：工具定义不存在", sig };
  assert.equal(shownErr(err, sig), "服务拒绝：工具定义不存在");
  assert.equal(shownErr(err, JSON.stringify({ ...SDRAFT, handoff: "abc" })), null, "改了换段阈值");
  assert.equal(shownErr(err, JSON.stringify({ ...SDRAFT, tools: ["read"] })), null, "改了工具");
  assert.equal(shownErr(err, JSON.stringify({ ...SDRAFT, workdir: "E:\\other" })), null, "改了工作目录");
});

/** 把全局 fetch 换成假的：回给定的几行，记下请求的正文。 */
async function withFetch(lines: unknown[], fn: (calls: any[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push({ url: String(_url), body: JSON.parse(init.body) });
    return new Response(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, { status: 200 });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("api: tauCommand 认 reconfigured 回执，和 receipt、swept 一样当作成功；reconfigure 的封装带回 pending", async () => {
  await withFetch([{ type: "reconfigured", process: "abc", pending: true }], async (calls) => {
    assert.deepEqual(await tauCommand({ op: "reconfigure", process: "abc", fields: { prompt: "x" } }), { type: "reconfigured", process: "abc", pending: true });
    assert.deepEqual(await apiReconfigure("abc", { fields: { thinking: null } }), { pending: true });
    assert.deepEqual(await apiReconfigure("abc", { revert: true }), { pending: true });
    assert.deepEqual(calls.map((c) => [c.url, c.body]), [
      ["/api/tau", { op: "reconfigure", process: "abc", fields: { prompt: "x" } }],
      ["/api/tau", { op: "reconfigure", process: "abc", fields: { thinking: null } }],
      ["/api/tau", { op: "reconfigure", process: "abc", revert: true }],
    ]);
  });
  await withFetch([{ type: "reconfigured", process: "abc", pending: false }], async () => assert.deepEqual(await apiReconfigure("abc", { fields: { handoff: 1 } }), { pending: false }));
  await withFetch([{ type: "swept", blobs: 2 }], async () => assert.deepEqual(await tauCommand({ op: "sweep" }), { type: "swept", blobs: 2 }));
  await withFetch([{ type: "receipt", process: "abc" }], async () => assert.equal((await tauCommand({ op: "stop", process: "abc" })).process, "abc"));
});

test("api: reconfigure 出错抛服务的原文，什么都没改；回执缺 pending、没有回执也抛错", async () => {
  await withFetch([{ type: "error", message: "id 不能改：它是记忆库的 ID，换角色用 fork 带 preset" }], async () => {
    await assert.rejects(apiReconfigure("abc", { fields: { id: "x" } as any }), /id 不能改/);
  });
  await withFetch([{ type: "reconfigured", process: "abc" }], async () => {
    await assert.rejects(apiReconfigure("abc", { fields: { handoff: 1 } }), /回执/);
  });
  await withFetch([], async () => {
    await assert.rejects(tauCommand({ op: "reconfigure", process: "abc", revert: true }), /没有回执/);
  });
});

test("api: inspect 读一个进程的记录，没有这个进程时抛服务的错误", async () => {
  const line = procLine({}, { prompt: "新" });
  await withFetch([line, { type: "inspected", processes: 1, now: 1 }], async (calls) => {
    assert.equal((await apiInspect("abc")).process.next.prompt, "新");
    assert.deepEqual(calls[0].body, { op: "inspect", process: "abc" });
  });
  await withFetch([{ type: "error", message: "没有这个进程：abc" }], async () => {
    await assert.rejects(apiInspect("abc"), /没有这个进程/);
  });
});
