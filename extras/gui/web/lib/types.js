// @ts-check
// 页面用到的数据形状。只有类型，没有逻辑。

/** @typedef {"done" | "stepLimit" | "stopped" | { error: string }} Ended */

/**
 * @typedef {{ tag: "idle", ended?: Ended }
 *   | { tag: "awaitingModel", purpose: "turn" | "handoff", steps: number, queued: number }
 *   | { tag: "awaitingTool", steps: number, queued: number }} PhaseView
 */

/**
 * `ps` 里的进程视图，也是 `update` 的 `self` 的一部分。
 * @typedef {{ id: string, preset: string, model: string, phase: PhaseView, age: number, parent?: string }} ProcessView
 */

/**
 * `update` 的 `self`，也就是投影的 `self`。`pending` 有待换配置（`reconfigure` 存下的 `next`）时才有，`fields` 是和当前快照不一样的结构性字段名（D71）。
 * @typedef {ProcessView & {
 *   segment: number,
 *   segmentAge: number | null,
 *   context: { used: number, window: number },
 *   messages: number,
 *   usage: { input: number, output: number, cacheRead: number, cacheWrite: number },
 *   pending?: { fields: string[] },
 * }} Self
 */

/** @typedef {{ now: number, self: Self, siblings: ProcessView[], children: ProcessView[], idleChildren: number }} Projection */

/** @typedef {{ type: "text", text: string }} TextBlock */
/** @typedef {{ type: "image", data: string, mimeType: string }} ImageBlock */
/** @typedef {{ type: "thinking", thinking: string }} ThinkingBlock */
/** @typedef {{ type: "toolCall", id: string, name: string, arguments: Record<string, unknown> }} ToolCallBlock */

/** 发信的人：用户，或者另一个进程；`reply` 有值表示是回信（`src/kernel/types.ts` 的 `Sender`）。 @typedef {{ kind: "user" } | { kind: "process", id: string, preset: string, reply?: { ended: Ended } }} Sender */
/** 一封信在用户消息里的结构；`at` 是正文在消息文本里的起止位置（UTF-16），文本被截过的消息没有。 @typedef {{ from: Sender, hops: number, replyTo?: string, handoff?: true, at?: [number, number] }} LetterMeta */
/** 内核写的用户消息带的结构；旧消息没有。`after` 是上一轮的结束原因，`handoff` 表示换段后的第一条，`brief` 是其中旧段简略视图那一块的起止位置（UTF-16）。 @typedef {{ letters: LetterMeta[], after?: Ended, handoff?: true, brief?: [number, number] }} UserTau */
/** @typedef {{ role: "user", content: string | (TextBlock | ImageBlock)[], timestamp: number, tau?: UserTau }} UserMessage */
/** @typedef {{ role: "assistant", content: (TextBlock | ThinkingBlock | ToolCallBlock)[], timestamp: number, stopReason?: string, errorMessage?: string }} AssistantMessage */
/** @typedef {{ role: "toolResult", toolCallId: string, toolName: string, content: (TextBlock | ImageBlock)[], isError: boolean, timestamp: number, tau?: { filled: "interrupted" | "skipped" } }} ToolResultMessage */
/** @typedef {UserMessage | AssistantMessage | ToolResultMessage} Message */

/**
 * 线协议的回复（页面会用到的部分）。
 * @typedef {{ type: "ps", processes: Projection[] }
 *   | { type: "update", self: Self }
 *   | { type: "removed", process: string }
 *   | { type: "text", process: string, n: number, delta: string, kind?: "thinking" | "toolCall" | "output" }
 *   | { type: "message", process?: string, segment: number, seq: number, message: Message }
 *   | { type: "end", segment: number, messages: number }
 *   | { type: "receipt", process: string }
 *   | { type: "reconfigured", process: string, pending: boolean }
 *   | { type: "error", message: string }} Reply
 */

/** 进程的会话快照里界面要的几项（`inspect` 读来，`reconfigure` 之后会变，所以每次读到都更新）。名字是历史遗留。 @typedef {{ workdir: string, tools: string[], memory: boolean, model?: string, thinking?: string, handoff?: number, options?: Record<string, unknown>, context?: string[], input?: string[], threshold?: number }} Frozen */

/**
 * `/api/presets` 回的一项。
 * @typedef {{ id: string, ok: true, workdir: string, model: string, tools: string[], memory: boolean, thinking?: string, handoff?: number, options?: Record<string, unknown>, context?: string[], prompt?: string, agentsMd?: "none" | "legacy" }
 *   | { id: string, ok: false, error: string }} PresetInfo
 */

/**
 * 界面数据文件（`~/.tau/extras/gui/state.json`）。
 * @typedef {{
 *   chief?: string,
 *   names: Record<string, string>,
 *   current: Record<string, string>,
 *   folders: string[],
 *   pinned: string[],
 *   short: Record<string, string>,
 *   mine: string[],
 *   forkedFrom: Record<string, string>,
 *   titles: Record<string, string>,
 *   collapsed: Record<string, boolean>,
 *   cleanDays: number,
 *   recentModels: string[],
 *   defaultModel?: string,
 *   defaultThinking?: string,
 *   notify?: boolean,
 *   theme?: "night" | "vscode",
 *   motion: boolean,
 * }} GuiState
 */

export {};
