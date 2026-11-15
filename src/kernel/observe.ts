// 投影：CLI 的 `tau ps` 和 Agent 的 `self` 看同一份（设计稿第 9 节）。只给时刻和时长，本地时间在内核外格式化。
import { contextUsed, segmentStartedAt } from "./derive.ts";
import { unreachable } from "./types.ts";
import type { Ended, Instant, Message, Process, ProcessId, Purpose } from "./types.ts";

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
}

export interface Projection {
  now: Instant;
  self: ProcessView & {
    segment: number;
    /** 本段开始多久（毫秒）；段里还没有消息时为 null。 */
    segmentAge: number | null;
    context: { used: number; window: number };
  };
  /** 同一个预设下不处于 idle 的其他进程。 */
  siblings: ProcessView[];
}

export function observe(p: Process, segment: readonly Message[], siblings: readonly Process[], now: Instant): Projection {
  const started = segmentStartedAt(segment);
  return {
    now,
    self: {
      ...view(p, now),
      segment: p.segment.seq,
      segmentAge: started === undefined ? null : now - started,
      context: { used: contextUsed(p, segment), window: p.preset.contextWindow },
    },
    siblings: siblings.filter((s) => s.id !== p.id && s.preset.id === p.preset.id && s.phase.tag !== "idle").map((s) => view(s, now)),
  };
}

function view(p: Process, now: Instant): ProcessView {
  return { id: p.id, preset: p.preset.id, model: p.preset.model, phase: phaseView(p), age: now - p.createdAt };
}

function phaseView(p: Process): PhaseView {
  const { phase } = p;
  switch (phase.tag) {
    case "idle":
      return phase.ended === undefined ? { tag: "idle" } : { tag: "idle", ended: phase.ended };
    case "awaitingModel":
      return { tag: "awaitingModel", purpose: phase.purpose, steps: phase.turn.steps, queued: phase.turn.queued.length };
    case "awaitingTool":
      return { tag: "awaitingTool", steps: phase.turn.steps, queued: phase.turn.queued.length };
    default:
      return unreachable(phase);
  }
}
