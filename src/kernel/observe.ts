// 投影：CLI 的 `tau ps` 和 Agent 的 `self` 看同一份（设计稿第 9 节）。只给时刻和时长，本地时间在内核外格式化。
import { contextUsed, endedReason, handoffThreshold, segmentStartedAt } from "./derive.ts";
import { pendingFields } from "./snapshot.ts";
import { findTool } from "./tools.ts";
import { unreachable } from "./types.ts";
import type { Ended, Instant, Message, Process, ProcessId, Purpose, Usage } from "./types.ts";

export type PhaseView =
  | { tag: "idle"; ended?: Ended }
  | { tag: "awaitingModel"; purpose: Purpose; steps: number; queued: number }
  | { tag: "awaitingTool"; steps: number; queued: number };

export interface ProcessView {
  id: ProcessId;
  preset: string;
  model: string;
  phase: PhaseView;
  /** 进程运行了多久（毫秒）。 */
  age: number;
  /** 进入当前阶段、或者发出当前副作用的时刻；旧记录没有。 */
  since?: Instant;
  /** 建好后不变；CLI 建的进程没有。 */
  parent?: ProcessId;
}

export interface Projection {
  now: Instant;
  self: ProcessView & {
    segment: number;
    /** 本段开始多久（毫秒）；段里还没有消息时为 null。 */
    segmentAge: number | null;
    /** `threshold` 是换段阈值（token）。 */
    context: { used: number; window: number; threshold: number };
    /** 当前段的消息条数。 */
    messages: number;
    /** 累计用量，跨段。 */
    usage: Usage;
    /** 有待换配置（`next`）时：它和当前快照结构性字段里不一样的键名（D71）。没有 `next` 就没有这个键。放在 `self` 里，因为 `watch` 的 `update` 只带 `self`。 */
    pending?: { fields: string[] };
    /** 当前段里转入后台、还没收到完成信的 bash 任务（D90 第 2 阶段）。没有就没有这个键。 */
    bgJobs?: { id: string; age: number }[];
  };
  /** 同一个预设下不处于 idle 的其他进程。 */
  siblings: ProcessView[];
  /** parent 是自己、不处于 idle 的进程。 */
  children: ProcessView[];
  /** parent 是自己、处于 idle 的进程个数。 */
  idleChildren: number;
  /** 同一个工作目录下不处于 idle 的其他进程，不看预设，工作目录不分大小写比较（D78）。和 `siblings`、`children` 各自独立，会有重叠。写成可选键，因为契约只加可选键；`observe` 总是给。 */
  sameDir?: ProcessView[];
  /** 传入的全部进程里不处于 idle 的个数，含自己（自己在传入的进程里且不是 idle 时）（D78）。同上，总是给。 */
  running?: number;
}

export function observe(p: Process, segment: readonly Message[], siblings: readonly Process[], now: Instant): Projection {
  const started = segmentStartedAt(segment);
  const kids = siblings.filter((s) => s.parent === p.id);
  const dir = p.preset.workdir.toLowerCase();
  const hot = siblings.filter((s) => s.phase.tag !== "idle");
  const bgJobs = activeBgJobs(segment, now, p.preset);
  return {
    now,
    self: {
      ...view(p, now),
      segment: p.segment.seq,
      segmentAge: started === undefined ? null : now - started,
      context: { used: contextUsed(p, segment), window: p.preset.contextWindow, threshold: handoffThreshold(p.preset) },
      messages: segment.length,
      usage: { ...p.usage },
      ...(p.next === undefined ? {} : { pending: { fields: pendingFields(p.preset, p.next) } }),
      ...(bgJobs.length === 0 ? {} : { bgJobs }),
    },
    siblings: siblings.filter((s) => s.id !== p.id && s.preset.id === p.preset.id && s.phase.tag !== "idle").map((s) => view(s, now)),
    children: kids.filter((s) => s.phase.tag !== "idle").map((s) => view(s, now)),
    idleChildren: kids.filter((s) => s.phase.tag === "idle").length,
    sameDir: hot.filter((s) => s.id !== p.id && s.preset.workdir.toLowerCase() === dir).map((s) => view(s, now)),
    running: hot.length,
  };
}

export const BG_START = /\[转入后台 ([0-9a-f]{6})\] 命令还在运行，没有被结束。\n输出文件：[^\n]*（还在增长，用 read 读，可带 offset 和 limit）\n(?:进程组号：\d+\n)?跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。[ \t\r\n]*$/;
const BG_DONE = /^\[后台任务 ([0-9a-f]{6})\] 退出码 -?\d+$/;

function activeBgJobs(segment: readonly Message[], now: Instant, preset: Process["preset"]): { id: string; age: number }[] {
  const jobs = new Map<string, number>();
  for (const m of segment) {
    const text = typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    if (m.role === "toolResult" && !m.isError) {
      // 调用写成 Bash、functions.bash:0 也算（D109）；原名不看预设，fork 换角色后也认。
      const id = BG_START.exec(text)?.[1];
      if (id !== undefined && (m.toolName === "bash" || findTool(preset, m.toolName)?.name === "bash")) jobs.set(id, Math.max(0, now - m.timestamp));
    } else if (m.role === "user") {
      const lines = m.tau?.letters ? m.tau.letters.flatMap((l) => (l.from.kind === "user" && l.at !== undefined ? [text.slice(l.at[0], l.at[1]).split("\n", 1)[0] ?? ""] : [])) : [text.split("\n", 1)[0] ?? ""];
      for (const line of lines) {
        const id = BG_DONE.exec(line)?.[1];
        if (id !== undefined) jobs.delete(id);
      }
    }
  }
  return [...jobs.entries()].map(([id, age]) => ({ id, age }));
}

function view(p: Process, now: Instant): ProcessView {
  return { id: p.id, preset: p.preset.id, model: p.preset.model, phase: phaseView(p), age: now - p.createdAt, ...(p.since === undefined ? {} : { since: p.since }), ...(p.parent === undefined ? {} : { parent: p.parent }) };
}

function phaseView(p: Process): PhaseView {
  const { phase } = p;
  switch (phase.tag) {
    case "idle":
      // 出错的原因截短，和 `self` 的文字、回信的头一样（设计稿第 4 节）。
      return phase.ended === undefined ? { tag: "idle" } : { tag: "idle", ended: typeof phase.ended === "object" ? { error: endedReason(phase.ended.error) } : phase.ended };
    case "awaitingModel":
      return { tag: "awaitingModel", purpose: phase.purpose, steps: phase.turn.steps, queued: phase.turn.queued.length };
    case "awaitingTool":
      return { tag: "awaitingTool", steps: phase.turn.steps, queued: phase.turn.queued.length };
    default:
      return unreachable(phase);
  }
}
