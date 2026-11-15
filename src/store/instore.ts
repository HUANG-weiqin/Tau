// 库内副作用：记忆工具和 `self`，在处理输入的事务里执行，恰好一次（见 .knowledge/kb-store.md、kb-memory.md；设计稿第 9 节）。
import { observe } from "../kernel/observe.ts";
import { MEMORY_KEY_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../kernel/tools.ts";
import { unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PhaseView, Projection } from "../kernel/observe.ts";
import type { Ended, Instant, Memory, Message, Process, ToolCall, ToolResultContent, Versioned } from "../kernel/types.ts";
import { loadProcesses } from "./db.ts";

export function runInStore(db: DatabaseSync, memory: Memory, p: Process, segment: readonly Message[], call: ToolCall, now: Instant): ToolResultContent {
  // 参数来自模型：pi-ai 把流式 JSON 'null' 解析成 null，所以不能直接解构。
  const args: Record<string, unknown> = typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {};
  const { key, value, version } = args;
  const ns = p.preset.id;
  switch (call.name) {
    case "self":
      return ok(formatSelf(observe(p, segment, loadProcesses(db), now)));
    case "memory_get": {
      if (typeof key !== "string") return bad("key 必须是字符串。");
      const cur = memory.get(ns, key);
      return ok(cur ? show(key, cur) : `键 ${key} 不存在。`);
    }
    case "memory_set": {
      if (typeof key !== "string" || typeof value !== "string") return bad("key 和 value 必须是字符串。");
      if (version != null && !isInt(version)) return bad("version 必须是整数，或者省略。");
      const r = memory.set(ns, key, value, isInt(version) ? version : null);
      if (r.ok) return ok(`已写入 ${key}，版本 ${r.version}。`);
      if ("over" in r) return { text: "超出上限，没有写入：" + overText(r.over, r.bytes), isError: true };
      return conflict(key, r.current);
    }
    case "memory_delete": {
      if (typeof key !== "string" || !isInt(version)) return bad("key 必须是字符串，version 必须是整数。");
      const r = memory.delete(ns, key, version);
      return r.ok ? ok(`已删除 ${key}。`) : conflict(key, r.current);
    }
    default:
      throw new Error(`不是库内工具：${call.name}`);
  }
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function ok(text: string): ToolResultContent {
  return { text, isError: false };
}

function bad(text: string): ToolResultContent {
  return { text: `参数错误：${text}`, isError: true };
}

function show(key: string, v: Versioned): string {
  return `${key}（版本 ${v.version}）：\n${v.value}`;
}

function overText(over: "key" | "value" | "view", bytes: number): string {
  switch (over) {
    case "key":
      return `键有 ${bytes} 字节，上限 ${MEMORY_KEY_MAX_BYTES} 字节。`;
    case "value":
      return `值有 ${bytes} 字节，上限 ${MEMORY_VALUE_MAX_BYTES} 字节。`;
    case "view":
      return `写入后记忆视图有 ${bytes} 字节，上限 ${MEMORY_VIEW_MAX_BYTES} 字节。先删掉或缩短不需要的键。`;
    default:
      return unreachable(over);
  }
}

function conflict(key: string, current: Versioned | null): ToolResultContent {
  return { text: `版本冲突，没有写入。${current ? `现在的值是 ${show(key, current)}` : `键 ${key} 现在不存在。`}`, isError: true };
}

/** 本地时间和时区在内核外格式化（见 .knowledge/kb-kernel.md）。 */
function formatSelf(v: Projection): string {
  const s = v.self;
  const lines = [
    `现在：${new Date(v.now).toLocaleString("zh-CN", { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    `进程：${s.id}，预设 ${s.preset}，模型 ${s.model}，已运行 ${duration(s.age)}`,
    `阶段：${phaseText(s.phase)}`,
    `工作段：第 ${s.segment} 段${s.segmentAge === null ? "" : `，开始于 ${duration(s.segmentAge)}前`}`,
    `上下文：已用约 ${s.context.used} token，窗口 ${s.context.window} token`,
    v.siblings.length === 0 ? "同一个预设下没有其他运行中的进程。" : "同一个预设下运行中的其他进程：",
    ...v.siblings.map((x) => `- ${x.id}：${phaseText(x.phase)}，已运行 ${duration(x.age)}`),
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

function endedText(e: Ended): string {
  if (typeof e === "object") return `出错：${e.error}`;
  switch (e) {
    case "done":
      return "正常结束";
    case "stepLimit":
      return "步数用完";
    case "stopped":
      return "被停止";
    default:
      return unreachable(e);
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
