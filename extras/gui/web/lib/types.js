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
 * `update` 的 `self`，也就是投影的 `self`。
 * @typedef {ProcessView & {
 *   segment: number,
 *   segmentAge: number | null,
 *   context: { used: number, window: number },
 *   messages: number,
 *   usage: { input: number, output: number, cacheRead: number, cacheWrite: number },
 * }} Self
 */

/** @typedef {{ now: number, self: Self, siblings: ProcessView[], children: ProcessView[], idleChildren: number }} Projection */

/** @typedef {{ type: "text", text: string }} TextBlock */
/** @typedef {{ type: "image", data: string, mimeType: string }} ImageBlock */
/** @typedef {{ type: "thinking", thinking: string }} ThinkingBlock */
/** @typedef {{ type: "toolCall", id: string, name: string, arguments: Record<string, unknown> }} ToolCallBlock */

/** @typedef {{ role: "user", content: string | (TextBlock | ImageBlock)[], timestamp: number }} UserMessage */
/** @typedef {{ role: "assistant", content: (TextBlock | ThinkingBlock | ToolCallBlock)[], timestamp: number, stopReason?: string, errorMessage?: string }} AssistantMessage */
/** @typedef {{ role: "toolResult", toolCallId: string, toolName: string, content: (TextBlock | ImageBlock)[], isError: boolean, timestamp: number }} ToolResultMessage */
/** @typedef {UserMessage | AssistantMessage | ToolResultMessage} Message */

/**
 * 线协议的回复（页面会用到的部分）。
 * @typedef {{ type: "ps", processes: Projection[] }
 *   | { type: "update", self: Self }
 *   | { type: "removed", process: string }
 *   | { type: "text", process: string, n: number, delta: string }
 *   | { type: "message", segment: number, seq: number, message: Message }
 *   | { type: "end", segment: number, messages: number }
 *   | { type: "receipt", process: string }
 *   | { type: "error", message: string }} Reply
 */

/** @typedef {{ workdir: string, tools: string[], memory: boolean }} Seen */

/**
 * `/api/presets` 回的一项。
 * @typedef {{ id: string, ok: true, workdir: string, model: string, tools: string[], memory: boolean, thinking?: string, handoff?: number }
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
 *   seen: Record<string, Seen>,
 *   collapsed: Record<string, boolean>,
 *   cleanDays: number,
 * }} GuiState
 */

export {};
