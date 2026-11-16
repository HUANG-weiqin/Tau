// 投影：CLI 的 `tau ps` 和 Agent 的 `self` 看同一份（设计稿第 9 节）。只给时刻和时长，本地时间在内核外格式化。
import { contextUsed, endedReason, segmentStartedAt } from "./derive.ts";
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
  /** 建好后不变；CLI 建的进程没有。 */
  parent?: ProcessId;
}

export interface Projection {
  now: Instant;
  self: ProcessView & {
    segment: number;
    /** 本段开始多久（毫秒）；段里还没有消息时为 null。 */
    segmentAge: number | null;
    context: { used: number; window: number };
    /** 当前段的消息条数。 */
    messages: number;
    /** 累计用量，跨段。 */
    usage: Usage;
  };
  /** 同一个预设下不处于 idle 的其他进程。 */
  siblings: ProcessView[];
  /** parent 是自己、不处于 idle 的进程。 */
  children: ProcessView[];
  /** parent 是自己、处于 idle 的进程个数。 */
  idleChildren: number;
}

export function observe(p: Process, segment: readonly Message[], siblings: readonly Process[], now: Instant): Projection {
  const started = segmentStartedAt(segment);
  const kids = siblings.filter((s) => s.parent === p.id);
  return {
    now,
    self: {
      ...view(p, now),
      segment: p.segment.seq,
      segmentAge: started === undefined ? null : now - started,
      context: { used: contextUsed(p, segment), window: p.preset.contextWindow },
      messages: segment.length,
      usage: { ...p.usage },
    },
    siblings: siblings.filter((s) => s.id !== p.id && s.preset.id === p.preset.id && s.phase.tag !== "idle").map((s) => view(s, now)),
    children: kids.filter((s) => s.phase.tag !== "idle").map((s) => view(s, now)),
    idleChildren: kids.filter((s) => s.phase.tag === "idle").length,
  };
}

function view(p: Process, now: Instant): ProcessView {
  return { id: p.id, preset: p.preset.id, model: p.preset.model, phase: phaseView(p), age: now - p.createdAt, ...(p.parent === undefined ? {} : { parent: p.parent }) };
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
