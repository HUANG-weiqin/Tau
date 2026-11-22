// 库内副作用：记忆工具、`self`、`handoff` 和 `post`、`spawn`、`stop_process`，在处理输入的事务里执行，恰好一次（见 .knowledge/kb-store.md、kb-memory.md；设计稿第 5.3、9 节）。
// 永不抛错：抛错会让事务回滚，这条输入留在信箱队头，所有进程都卡住。所有失败都是 isError 的结果。
import { createHash } from "node:crypto";
import { start } from "../kernel/decide.ts";
import { endedText, HOPS_MAX, startError } from "../kernel/derive.ts";
import { observe } from "../kernel/observe.ts";
import { findBuiltin, MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../kernel/tools.ts";
import { textContent, unreachable } from "../kernel/types.ts";
import { utcDate } from "../memory/kv.ts";
import { fixArgs } from "../tools/args.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PhaseView, Projection } from "../kernel/observe.ts";
import type { DeclaredCall, Env, Input, Instant, Memory, Message, PresetSnapshot, Process, ProcessId, ToolCall, ToolResultContent, Versioned } from "../kernel/types.ts";
import { readContextView } from "./context-files.ts";
import { loadProcess, loadProcesses, putMail } from "./db.ts";

/** 读预设的函数，由服务传进来；测试传假的。`workdir` 顶掉预设文件里的工作目录。读不出时抛出，原因是错误信息。 */
export type ReadPreset = (id: string, workdir?: string) => PresetSnapshot;

const noPresets: ReadPreset = (id) => {
  throw new Error(`找不到预设：${id}`);
};

/** 一个进程的 `Env`：记忆视图按它自己的预设算。 */
export function envFor(memory: Memory, preset: PresetSnapshot, now: Instant): Env {
  return { now, memoryView: preset.tools.includes("memory") ? memory.view(preset.id) : "" };
}

/**
 * 可能被采用的那份快照的开段视图（`Env.fresh`，D71、D72）：记忆视图，加读上下文文件。只在两种输入上算，别的输入返回 undefined：`reconfigure`（给它带的新快照算），
 * 和接受交接的那条模型结果（旧记录有 `next` 就给 `next` 算，没有就给 `preset` 算：上下文视图每次换段重读）。`envFor` 每条输入都跑，读文件不能放在里面。
 */
export function freshFor(memory: Memory, old: Process, input: Input, now: Instant): Env["fresh"] {
  const preset = input.kind === "reconfigure" ? input.preset : input.kind === "modelResult" && input.n === old.lastEffect && input.outcome.status === "ok" && old.phase.tag === "awaitingModel" && old.phase.purpose === "handoff" ? (old.next ?? old.preset) : undefined;
  return preset && { memoryView: envFor(memory, preset, now).memoryView, contextView: readContextView(preset) };
}

/** `spawn` 的新进程 ID：父进程 ID、这次调用的副作用编号、尝试次数的 sha256 的前 8 个十六进制字符。 */
export function spawnId(parent: ProcessId, n: number, attempt: number): ProcessId {
  return createHash("sha256").update(`${parent}\n${n}\n${attempt}`).digest("hex").slice(0, 8);
}

export function runInStore(db: DatabaseSync, memory: Memory, p: Process, segment: readonly Message[], call: ToolCall, now: Instant, readPreset: ReadPreset = noPresets): ToolResultContent {
  // 参数的 JSON 不完整时 arguments 是 {}，原因在 argumentsError 里：说清楚，别只回“key 必须是字符串”。
  if (call.argumentsError !== undefined) return fail(`参数的 JSON 不完整或不合法：${call.argumentsError.split("\n")[0]}。请重新发送完整的参数。`);
  // 参数来自模型：pi-ai 把流式 JSON 'null' 解析成 null，所以不能直接解构；先按 schema 修正（tools/args.ts）。
  const spec = findBuiltin(call.name);
  const fixed = fixArgs(spec?.parameters ?? {}, typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {});
  if ("error" in fixed) return fail(fixed.error);
  const allowed = Object.keys(((spec?.parameters as { properties?: Record<string, unknown> })?.properties) ?? {});
  const extra = Object.keys(fixed.args).filter((k) => !allowed.includes(k));
  const badExtra = (): ToolResultContent =>
    call.name === "handoff"
      ? bad(`handoff 不需要参数（收到 ${extra.join(", ")}）。请不带参数调用 handoff，交接说明会在下一步单独写。`)
      : bad(`${call.name} 没有参数 ${extra.join(", ")}。${allowed.length === 0 ? "不需要参数。" : `可用的参数：${allowed.join(", ")}。`}`);
  const { key, value, brief, version } = fixed.args;
  const ns = p.preset.id;
  switch (call.name) {
    case "self":
      return extra.length > 0 ? badExtra() : ok(formatSelf(observe(p, segment, loadProcesses(db), now)));
    case "handoff":
      // 换段由 `decide` 在安全点发起：它看这个结果不是错误。
      return extra.length > 0 ? badExtra() : ok("将在这批工具结果之后换段。");
    case "post": {
      const { to, text, reply } = fixed.args;
      if (typeof to !== "string" || typeof text !== "string") return bad("to 和 text 必须是字符串。");
      if (reply != null && typeof reply !== "boolean") return bad("reply 必须是布尔值，或者省略。");
      if (extra.length > 0) return badExtra();
      if (to === p.id) return fail("不能给自己寄信。");
      if (!loadProcess(db, to)) return noProcess(to);
      const hops = nextHops(p);
      if (hops > HOPS_MAX) return hopsFail();
      putMail(db, to, { kind: "letter", letter: { from: sender(p), content: textContent(text), hops, ...(reply === true ? { replyTo: p.id } : {}) } });
      return ok(`已寄给 ${to}。${reply === true ? POST_REPLY : ""}`);
    }
    case "spawn": {
      const { preset, text, workdir } = fixed.args;
      if (typeof preset !== "string" || typeof text !== "string") return bad("preset 和 text 必须是字符串。");
      if (workdir != null && typeof workdir !== "string") return bad("workdir 必须是字符串，或者省略。");
      if (extra.length > 0) return badExtra();
      const hops = nextHops(p);
      if (hops > HOPS_MAX) return hopsFail();
      let snapshot: PresetSnapshot;
      try {
        snapshot = readPreset(preset, typeof workdir === "string" ? workdir : undefined);
      } catch (e) {
        return fail(`预设 ${preset} 读不出：${e instanceof Error ? e.message : String(e)}`);
      }
      const tooBig = startError(snapshot);
      if (tooBig !== null) return fail(tooBig);
      let attempt = 0;
      let id = spawnId(p.id, p.lastEffect, attempt);
      while (loadProcess(db, id)) id = spawnId(p.id, p.lastEffect, ++attempt);
      // 不调用 startProcess：事务不能嵌套。
      const child: Process = { ...start(id, snapshot, envFor(memory, snapshot, now), readContextView(snapshot)), parent: p.id };
      db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(child));
      putMail(db, id, { kind: "letter", letter: { from: sender(p), content: textContent(text), hops, replyTo: p.id } });
      return ok(`已建进程 ${id}，预设 ${preset}。${SPAWN_REPLY}`);
    }
    case "stop_process": {
      const { process: target } = fixed.args;
      if (typeof target !== "string") return bad("process 必须是字符串。");
      if (extra.length > 0) return badExtra();
      if (target === p.id) return fail("不能停止自己。要结束这一轮，直接回复，不再调用工具。");
      if (!loadProcess(db, target)) return noProcess(target);
      putMail(db, target, { kind: "stop" });
      return ok(`已给 ${target} 发出停止。`);
    }
    case "memory_get": {
      if (typeof key !== "string") return bad("key 必须是字符串。");
      if (extra.length > 0) return badExtra();
      const cur = memory.get(ns, key);
      return ok(cur ? show(key, cur) : `键 ${key} 不存在。`);
    }
    case "memory_set": {
      if (typeof key !== "string" || typeof value !== "string" || typeof brief !== "string") return bad(missing("memory_set", fixed.args, ["key", "value", "brief"]));
      if (version != null && !isInt(version)) return bad("version 必须是整数，或者省略。");
      if (extra.length > 0) return badExtra();
      // 版本号从 1 起，0 和负数不可能是读到的版本：模型常给新键这么填，当作没带。
      const r = memory.set(ns, key, { value, brief, now }, isInt(version) && version > 0 ? version : null);
      if (r.ok) return ok(`已写入 ${key}，版本 ${r.version}。`);
      if ("over" in r) return { content: textContent("超出上限，没有写入：" + overText(r.over, r.bytes)), isError: true };
      return conflict(key, r.current, r.current ? override(r.current.version) : "新建键不要带 version，去掉它再写一次。");
    }
    case "memory_edit": {
      const { old, new: replacement } = fixed.args;
      if (typeof key !== "string" || typeof old !== "string" || typeof replacement !== "string") return bad(missing("memory_edit", fixed.args, ["key", "old", "new"]));
      if (old === "") return bad("old 不能为空。");
      // 孤立的代理项会切开一个表情，写进库就变成替换字符。
      if (!old.isWellFormed()) return bad("old 含不完整的 Unicode 字符。");
      if (!isInt(version)) return bad(VERSION_HINT);
      if (brief != null && typeof brief !== "string") return bad("brief 必须是字符串，或者省略。");
      if (extra.length > 0) return badExtra();
      const cur = memory.get(ns, key);
      if (!cur) return fail(`键 ${key} 不存在。要新建，用 memory_set。`);
      if (cur.version !== version) return conflict(key, cur);
      // 用 split/join 换，不用 String.replace：`new` 里的 `$&`、`$1` 会被当成替换模式。
      const parts = cur.value.split(old);
      if (parts.length === 1) return fail("没找到原文，没有写入。old 必须和值逐字一致，包括标点、空格和换行；先用 memory_get 看现在的值。");
      if (parts.length > 2) return fail(`原文出现 ${parts.length - 1} 次，必须唯一，没有写入。把 old 写长一点，带上前后的字。`);
      // 读、换、写在同一个事务里，版本号也用刚读到的那个：无竞态。
      const r = memory.set(ns, key, { value: parts.join(replacement), brief: brief ?? cur.brief, now }, version);
      if (r.ok) return ok(`已写入 ${key}，版本 ${r.version}。`);
      if ("over" in r) return { content: textContent("超出上限，没有写入：" + overText(r.over, r.bytes)), isError: true };
      return conflict(key, r.current);
    }
    case "memory_delete": {
      if (typeof key !== "string") return bad("key 必须是字符串。");
      if (!isInt(version)) return bad(VERSION_HINT);
      if (extra.length > 0) return badExtra();
      const r = memory.delete(ns, key, version);
      return r.ok ? ok(`已删除 ${key}。`) : conflict(key, r.current);
    }
    default:
      throw new Error(`不是库内工具：${call.name}`);
  }
}

/** 工具定义能在结果里声明的库内动作。不含 `handoff`、`self`：它们不是“动作”，或者只在模型调用时有意义。 */
const DECLARABLE: readonly string[] = ["post", "spawn", "stop_process", "memory_get", "memory_set", "memory_edit", "memory_delete"];

/**
 * 执行工具结果声明的库内动作（D64 第 10 组），按顺序，复用 `runInStore`：发信人是这个进程，跳数、`replyTo`、`spawn` 的 ID 照常算，记忆是这个预设的库。
 * 不看预设有没有 `agents`、`memory`。第一个失败的那项什么都不写，其余写“未执行”；前面成功的不回滚。
 * 每项写成以 `[<name>] ` 开头的一段，段之间空一行，接在工具自己的最后一个文本块后面（没有文本块就新建一个，放在最前面）。任何一项失败，整条 `isError` 为 true。
 * 永不抛错。`p` 和 `segment` 是处理这条结果之前的记录和当前段。
 */
export function runDeclared(db: DatabaseSync, memory: Memory, p: Process, segment: readonly Message[], content: ToolResultContent, calls: readonly DeclaredCall[], now: Instant, readPreset: ReadPreset = noPresets): ToolResultContent {
  let failed = false;
  const parts = calls.map((c, i) => {
    if (failed) return `[${c.name}] 未执行。`;
    const r = declare(db, memory, p, segment, c, i, now, readPreset);
    failed = r.isError;
    return `[${c.name}] ${r.content.map((b) => (b.type === "text" ? b.text : "")).join("")}`;
  });
  const text = parts.join("\n\n");
  const at = content.content.findLastIndex((b) => b.type === "text");
  const blocks = [...content.content];
  const old = blocks[at];
  if (old?.type === "text") blocks[at] = { type: "text", text: `${old.text}\n\n${text}` };
  else blocks.unshift({ type: "text", text });
  return { content: blocks, isError: content.isError || failed };
}

function declare(db: DatabaseSync, memory: Memory, p: Process, segment: readonly Message[], c: DeclaredCall, i: number, now: Instant, readPreset: ReadPreset): ToolResultContent {
  if (!DECLARABLE.includes(c.name)) return fail(`不能在结果里声明这个动作。能声明的有：${DECLARABLE.join("、")}。`);
  try {
    return runInStore(db, memory, p, segment, { type: "toolCall", id: `declared-${i}`, name: c.name, arguments: c.arguments as ToolCall["arguments"] }, now, readPreset);
  } catch (e) {
    return fail(`执行出错：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 第一个没给或类型不对的参数名，加上模型实际给的那批名字：弱模型常把 value 写成 content。调用方已经确认有一个不是字符串。 */
function missing(name: string, args: Record<string, unknown>, fields: readonly string[]): string {
  return `${name} 缺少 ${fields.find((f) => typeof args[f] !== "string") ?? fields[0]}（字符串）。收到的参数名：${Object.keys(args).join(", ")}。`;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

const AFTER_REPLY = "，之后的几轮不会。";
const POST_REPLY = "它处理这封信的那一轮结束时会给你回信" + AFTER_REPLY;
const SPAWN_REPLY = "它这一轮结束时会给你回信" + AFTER_REPLY;
const VERSION_HINT = "version 必须是整数。先用 memory_get 读到现在的版本号。";
const override = (version: number): string => `要覆盖，带 version=${version} 再写一次。`;

/** `p` 寄出的信的跳数：不空闲时是本轮的跳数加 1，空闲时是 1。库内工具只在等工具时执行；协议的 `send` 带 `from` 时，`p` 可能在等模型。 */
export function nextHops(p: Process): number {
  return (p.phase.tag === "idle" ? 0 : p.phase.turn.hops) + 1;
}

export function sender(p: Process): { kind: "process"; id: ProcessId; preset: string } {
  return { kind: "process", id: p.id, preset: p.preset.id };
}

function fail(text: string): ToolResultContent {
  return { content: textContent(text), isError: true };
}

const noProcess = (id: string): ToolResultContent => fail(`没有进程 ${id}。用 self 查运行中的进程 ID。`);

const hopsFail = (): ToolResultContent => fail(`跳数到上限（${HOPS_MAX}）：这封信是被进程之间的信一路引出来的。结束本轮，等用户的下一封信。`);

function ok(text: string): ToolResultContent {
  return { content: textContent(text), isError: false };
}

function bad(text: string): ToolResultContent {
  return { content: textContent(`参数错误：${text}`), isError: true };
}

function show(key: string, v: Versioned): string {
  return `${key}（版本 ${v.version}，更新 ${utcDate(v.updated)}）：\n摘要：${v.brief}\n${v.value}`;
}

function overText(over: "key" | "value" | "view", bytes: number): string {
  switch (over) {
    case "key":
      return `键有 ${bytes} 字节，上限 ${MEMORY_KEY_MAX_BYTES} 字节。`;
    case "value":
      return `值有 ${bytes} 字节，上限 ${MEMORY_VALUE_MAX_BYTES} 字节。一个汉字占 3 字节。把内容拆成几个键，或者写进文件。`;
    case "view":
      return `写入后记忆视图有 ${bytes} 字节，上限 ${MEMORY_VIEW_MAX_BYTES} 字节。先删掉不需要的键，或缩短键和摘要。`;
    default:
      return unreachable(over);
  }
}

function conflict(key: string, current: Versioned | null, hint = ""): ToolResultContent {
  // 带现值时提示另起一行：值可能以任何字符结尾，接在同一行会黏在一起。
  return { content: textContent(`版本冲突，没有写入。${current ? `现在的值是 ${show(key, current)}${hint === "" ? "" : `\n${hint}`}` : `键 ${key} 现在不存在。${hint}`}`), isError: true };
}

/** 本地时间和时区在内核外格式化（见 .knowledge/kb-kernel.md）。 */
function formatSelf(v: Projection): string {
  const s = v.self;
  // 同预设的、子进程的已经在别的段列过，这里不重复。
  const shown = new Set([...v.siblings, ...v.children].map((x) => x.id));
  const dir = (v.sameDir ?? []).filter((x) => !shown.has(x.id));
  const lines = [
    `现在：${new Date(v.now).toLocaleString("zh-CN", { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    `进程：${s.id}，预设 ${s.preset}，模型 ${s.model}，已运行 ${duration(s.age)}`,
    ...(s.parent === undefined ? [] : [`父进程：${s.parent}`]),
    `阶段：${phaseText(s.phase)}`,
    `工作段：第 ${s.segment} 段${s.segmentAge === null ? "" : `，开始于 ${duration(s.segmentAge)}前`}，共 ${s.messages} 条消息`,
    `上下文：已用约 ${s.context.used} token，窗口 ${s.context.window} token`,
    `换段阈值：${s.context.threshold} token`,
    ...(s.pending === undefined ? [] : [`待换配置：${s.pending.fields.join("、")}（换段时生效）`]),
    ...(s.bgJobs === undefined ? [] : ["当前段仍在运行的后台命令：", ...s.bgJobs.map((j) => `- ${j.id}（已转后台 ${duration(j.age)}）`)]),
    `累计用量：输入 ${s.usage.input}，输出 ${s.usage.output}，缓存读 ${s.usage.cacheRead}，缓存写 ${s.usage.cacheWrite}（token）`,
    v.siblings.length === 0 ? "同一个预设下没有其他运行中的进程。" : "同一个预设下运行中的其他进程：",
    ...v.siblings.map((x) => `- ${x.id}：${phaseText(x.phase)}，已运行 ${duration(x.age)}`),
    ...(dir.length === 0 ? [] : ["同一个工作目录下运行中的其他进程：", ...dir.map((x) => `- ${x.id}：预设 ${x.preset}，${phaseText(x.phase)}，已运行 ${duration(x.age)}`)]),
    ...(v.children.length === 0 ? [] : ["运行中的子进程：", ...v.children.map((x) => `- ${x.id}：预设 ${x.preset}，${phaseText(x.phase)}，已运行 ${duration(x.age)}`)]),
    ...(v.idleChildren === 0 ? [] : [`空闲的子进程：${v.idleChildren} 个`]),
    ...((v.running ?? 0) > 1 ? [`全部运行中的进程：${v.running} 个（含自己）`] : []),
  ];
  return lines.join("\n");
}

function phaseText(ph: PhaseView): string {
  switch (ph.tag) {
    case "idle":
      return ph.ended === undefined ? "空闲" : `空闲，上一轮${endedText(ph.ended)}`;
    case "awaitingModel":
      return `${ph.purpose === "handoff" ? "等模型写交接说明" : "等模型回复"}，本轮第 ${ph.steps} 步，排队消息 ${ph.queued} 条`;
    case "awaitingTool":
      return `等工具结果，本轮第 ${ph.steps} 步，排队消息 ${ph.queued} 条`;
    default:
      return unreachable(ph);
  }
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const parts: [number, string][] = [
    [Math.floor(s / 86400), "天"],
    [Math.floor(s / 3600) % 24, "小时"],
    [Math.floor(s / 60) % 60, "分"],
    [s % 60, "秒"],
  ];
  const shown = parts.filter(([n]) => n > 0).slice(0, 2);
  return shown.length === 0 ? "0 秒" : shown.map(([n, unit]) => `${n} ${unit}`).join(" ");
}
