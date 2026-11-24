// 内核的不变量（执行清单第 1 步）：只看进程记录和当前工作段。
// 存储层的不变量在第 2 步另加，并复用这个函数。
import { isDeepStrictEqual } from "node:util";
import { effectOf } from "../src/kernel/decide.ts";
import { contextUsed, handoffThreshold, IMAGES_PER_MESSAGE, RETRIES_PER_REPLY, STEPS_PER_TURN } from "../src/kernel/derive.ts";
import { findTool } from "../src/kernel/tools.ts";
import { unreachable } from "../src/kernel/types.ts";
import type { Content, Ended, Letter, Message, PresetSnapshot, Process, ToolCall, Turn } from "../src/kernel/types.ts";

type Bad = (what: string) => Error;

/** 最后一条助手消息里还没有结果的工具调用：从 `calls[from]` 起都缺。 */
interface Missing {
  calls: ToolCall[];
  from: number;
}

/**
 * 不变量不成立时抛错，错误信息说明是哪一条。
 * `relaxed`：`reconfigure` 改了 `handoff` 以后，存下的 `purpose` 是进入时的判断，可能和现算的阈值不一致，两个方向都允许（D71）。为真时，和阈值有关的三处不检查：
 * `awaitingModel` 里“用量到阈值，用途就是 handoff”和“用途是 handoff 而用量没到阈值，只能是换段信”，`awaitingTool` 的“已写过结果时用量没到阈值”。
 * 与阈值无关的“有成功的 handoff 调用，用途就是 handoff”照查，其余不变量也不放松。
 */
export function assertInvariants(p: Process, segment: readonly Message[], relaxed = false): void {
  const bad: Bad = (what) => new Error(`不变量不成立（进程 ${p.id}，阶段 ${p.phase.tag}，第 ${p.segment.seq} 段，${segment.length} 条消息）：${what}`);

  if (!Number.isInteger(p.lastEffect) || p.lastEffect < 0) throw bad(`lastEffect 是 ${p.lastEffect}，应为非负整数`);
  if (!Number.isInteger(p.segment.seq) || p.segment.seq < 1) throw bad(`段号是 ${p.segment.seq}，应为正整数`);
  const first = segment[0];
  if (first !== undefined && first.role !== "user") throw bad(`工作段的第一条是 ${first.role}，应为用户消息`);

  checkShapes(segment, p.segment.seq, bad);
  const missing = pairing(segment, bad);
  const effect = effectOf(p, segment);
  const threshold = handoffThreshold(p.preset);
  const { phase } = p;
  switch (phase.tag) {
    case "idle":
      if (missing) throw bad(`idle 时工具调用 ${missing.calls[missing.from]?.id} 没有结果`);
      if (effect !== null) throw bad(`idle 时 effectOf 应为 null，实际是 ${JSON.stringify(effect)}`);
      if (phase.ended === undefined) {
        // ended 缺省表示这个进程自己还没跑过一轮：由 start 建出来（工作段是空的），或者由 fork 带 before 建出来（工作段是复制的前缀）。
        if (p.lastEffect !== 0) throw bad(`还没跑过一轮，lastEffect 却是 ${p.lastEffect}`);
        if (p.segment.seq !== 1) throw bad(`还没跑过一轮，段号却是 ${p.segment.seq}`);
      } else {
        checkEnded(phase.ended, bad);
        // lastEffect 为 0 只可能是不带 before 的 fork：第 1 段、复制来的结束原因。
        if (p.lastEffect < 1 && p.segment.seq !== 1) throw bad("跑过一轮，lastEffect 却是 0");
        if (segment.length === 0) throw bad("跑过一轮，工作段却是空的");
      }
      return;
    case "awaitingModel": {
      checkTurn(p, phase.turn, segment, bad);
      if (missing) throw bad(`等模型时工具调用 ${missing.calls[missing.from]?.id} 没有结果`);
      if (segment.at(-1)?.role === "assistant") throw bad("等模型时，工作段最后一条是助手消息");
      const expected = { kind: "callModel", n: p.lastEffect, purpose: phase.purpose };
      if (!isDeepStrictEqual(effect, expected)) throw bad(`effectOf 是 ${JSON.stringify(effect)}，应为 ${JSON.stringify(expected)}`);
      // 等模型时工作段不变，所以存下的用途和现在重算的一致。
      const requested = handoffCalled(segment, p.preset);
      // 成功的 handoff 调用和阈值无关：reconfigure 改了 handoff 也不会让它不要求换段，所以 relaxed 也要查。
      if (requested && phase.purpose !== "handoff") throw bad(`用途是 ${phase.purpose}，但最后一条助手消息里有成功的 handoff 调用`);
      if (relaxed) return;
      const used = contextUsed(p, segment);
      // D64 第 7 组：两条蕴含。(a) 用量到阈值或有成功的 handoff 调用，用途就是 handoff；(b) 用途是 handoff、两者又都不成立，只能是换段信：段末是用户消息，段里有助手消息。
      const trigger = used >= threshold || requested;
      if (trigger && phase.purpose !== "handoff") {
        throw bad(`用途是 ${phase.purpose}，但上下文用量 ${used} ${used >= threshold ? "已经" : "没有"}达到阈值 ${threshold}，最后一条助手消息里${requested ? "有" : "没有"}成功的 handoff 调用`);
      }
      if (phase.purpose === "handoff" && !trigger && (segment.at(-1)?.role !== "user" || !segment.some((m) => m.role === "assistant"))) {
        throw bad("用途是 handoff，但用量没到阈值、也没有成功的 handoff 调用，段末不是用户消息或者段里没有助手消息");
      }
      return;
    }
    case "awaitingTool": {
      checkTurn(p, phase.turn, segment, bad);
      if (phase.turn.retry !== undefined) throw bad("等工具时 turn 里不应有 retry（D92：好的回复被接受时去掉）");
      if (!missing) throw bad("awaitingTool 时没有待执行的工具调用");
      const call = missing.calls[missing.from];
      const expected = { kind: "runTool", n: p.lastEffect, call };
      if (!isDeepStrictEqual(effect, expected)) throw bad(`effectOf 是 ${JSON.stringify(effect)}，应指向第一个缺结果的调用 ${call?.id}`);
      if (relaxed) return;
      // 第一个之后的工具，只在上一个结果写入后用量没到阈值时才会开始。
      const used = contextUsed(p, segment);
      if (missing.from > 0 && used >= threshold) throw bad(`已有 ${missing.from} 个结果，上下文用量 ${used} 达到阈值 ${threshold}，却还在等下一个工具`);
      return;
    }
    default:
      unreachable(phase);
  }
}

/** 最后一条助手消息里有 handoff 调用，并且它的结果不是错误。 */
function handoffCalled(segment: readonly Message[], preset: PresetSnapshot): boolean {
  const at = segment.findLastIndex((m) => m.role === "assistant");
  const m = segment[at];
  if (m?.role !== "assistant") return false;
  const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
  return calls.some((c, k) => {
    const r = segment[at + 1 + k];
    return findTool(preset, c.name)?.name === "handoff" && r?.role === "toolResult" && !r.isError;
  });
}

/**
 * 写进段的用户消息只有两种形状：字符串，或者一个可有可无的文本块后面接至少一张图片。
 * 工具结果最多一个文本块，在最前，后面是图片。工具结果和 seq 大于 1 的段的第一条，图片不超过 IMAGES_PER_MESSAGE。
 */
function checkShapes(segment: readonly Message[], seq: number, bad: Bad): void {
  segment.forEach((m, i) => {
    if (m.role === "assistant" || typeof m.content === "string") return;
    const blocks: readonly Content[] = m.content;
    const images = blocks.filter((c) => c.type === "image").length;
    const texts = blocks.filter((c) => c.type === "text").length;
    if (texts + images !== blocks.length) throw bad(`第 ${i} 条的内容块有别的类型`);
    if (texts > 1 || (texts === 1 && blocks[0]?.type !== "text")) throw bad(`第 ${i} 条应当最多一个文本块，并且在最前`);
    if (m.role === "user" && images === 0) throw bad(`第 ${i} 条用户消息是内容块，却没有图片：没有图片时正文应当是字符串`);
    if ((m.role === "toolResult" || (i === 0 && seq > 1)) && images > IMAGES_PER_MESSAGE) throw bad(`第 ${i} 条有 ${images} 张图片，超过 ${IMAGES_PER_MESSAGE}`);
  });
}

/**
 * 每条带工具调用的助手消息后面，紧跟它的工具结果，顺序相同，中间没有别的消息。
 * 只有工作段最后一条助手消息可以缺结果，而且缺的是末尾连续的一段。
 */
function pairing(segment: readonly Message[], bad: Bad): Missing | null {
  let missing: Missing | null = null;
  let i = 0;
  while (i < segment.length) {
    const m = segment[i]!;
    switch (m.role) {
      case "user":
        i++;
        break;
      case "toolResult":
        throw bad(`第 ${i} 条工具结果（${m.toolCallId}）前面不是它的调用`);
      case "assistant": {
        const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
        let j = i + 1;
        let k = 0;
        for (; k < calls.length && j < segment.length; k++, j++) {
          const r = segment[j]!;
          const c = calls[k]!;
          if (r.role !== "toolResult") throw bad(`第 ${i} 条的工具调用 ${c.id} 后面紧跟的是第 ${j} 条 ${r.role}，不是它的结果`);
          if (r.toolCallId !== c.id || r.toolName !== c.name) {
            throw bad(`第 ${j} 条结果属于 ${r.toolCallId}（${r.toolName}），按顺序应属于 ${c.id}（${c.name}）`);
          }
        }
        // 循环停下时，要么结果齐了，要么工作段到头了：缺结果的只能是最后一条助手消息。
        if (k < calls.length) missing = { calls, from: k };
        i = j;
        break;
      }
      default:
        unreachable(m);
    }
  }
  return missing;
}

function checkTurn(p: Process, turn: Turn, segment: readonly Message[], bad: Bad): void {
  if (!Number.isInteger(turn.steps) || turn.steps < 1 || turn.steps > STEPS_PER_TURN) {
    throw bad(`本轮步数是 ${turn.steps}，应在 1 到 ${STEPS_PER_TURN} 之间`);
  }
  // 本轮每调用一次模型，lastEffect 都加过一。
  if (p.lastEffect < turn.steps) throw bad(`lastEffect ${p.lastEffect} 小于本轮步数 ${turn.steps}`);
  if (!Array.isArray(turn.queued) || turn.queued.some((q) => !isLetter(q))) throw bad("turn.queued 应为信件数组");
  if (!Number.isInteger(turn.hops) || turn.hops < 0) throw bad(`本轮跳数是 ${turn.hops}`);
  if (!Array.isArray(turn.replyTo) || new Set(turn.replyTo).size !== turn.replyTo.length) throw bad("turn.replyTo 应为去重的进程 ID 数组");
  if (segment.length === 0) throw bad("运行中工作段却是空的");
  // D92：retry 只在重试期间有值；次数从 1 数，不超过上限，每次重试都计过一步。
  const { retry } = turn;
  if (retry !== undefined && (!["empty", "length", "handoff", "error"].includes(retry.kind) || !Number.isInteger(retry.n) || retry.n < 1 || retry.n > RETRIES_PER_REPLY || retry.n >= turn.steps)) throw bad(`turn.retry 不合法：${JSON.stringify(retry)}`);
}

function isLetter(x: unknown): boolean {
  const l = x as Partial<Letter> | null;
  return typeof l === "object" && l !== null && typeof l.from === "object" && Array.isArray(l.content) && Number.isInteger(l.hops);
}

function checkEnded(e: Ended, bad: Bad): void {
  if (typeof e === "string") {
    if (e !== "done" && e !== "stepLimit" && e !== "stopped") throw bad(`未知的结束原因 ${JSON.stringify(e)}`);
  } else if (typeof e.error !== "string") {
    throw bad(`结束原因 ${JSON.stringify(e)} 缺少 error 文本`);
  }
}
