// @ts-check
// 改这个会话（`reconfigure`，D71）的纯逻辑：会话快照变成表的初值、表变成请求（只发变了的字段）、
// 字段什么时候生效、待换配置的字段名。不碰 DOM，不发请求。
import { joinPrompt, splitPrompt } from "./agentsmd.js";
import { noEmpty, parseContext, parseHandoff, parseOptions } from "./models.js";
import { pathKey } from "./state.js";
/** @typedef {import("./types.js").Self} Self */
/** @typedef {import("./types.js").PresetInfo} PresetInfo */

/**
 * 表的初值：`inspect` 读到的会话快照（有待换配置时取 `next`，服务以它为底改）。形状和预设列表里的一项一样，
 * 所以预设表直接拿它当 `orig`。`prompt` 只有用户写的部分，旧拼接块在 `block` 里，保存时接回去。
 * @typedef {Extract<PresetInfo, { ok: true }> & { block: string[] | null, pending: boolean }} SessionInfo
 */

/**
 * `inspect` 的一行 `process` 变成表的初值。不是 `process` 行、或快照缺必要的字段，是 null。
 * 工具是内置的加工具定义的名字（和 `tools:` 一行里写的一样）。
 * @param {any} line
 * @returns {SessionInfo | null}
 */
export function sessionInfo(line) {
  const rec = line?.type === "process" ? line.process : null;
  const snap = rec?.next ?? rec?.preset;
  if (!snap || typeof snap.workdir !== "string" || typeof snap.model !== "string" || !Array.isArray(snap.tools)) return null;
  /** @type {string[]} */
  const tools = [...snap.tools, ...(Array.isArray(snap.toolDefs) ? snap.toolDefs.map((/** @type {any} */ d) => d?.name).filter((/** @type {unknown} */ n) => typeof n === "string") : [])];
  const { user, block } = splitPrompt(typeof snap.prompt === "string" ? snap.prompt : "");
  const context = Array.isArray(snap.context) ? snap.context.filter((/** @type {unknown} */ x) => typeof x === "string") : [];
  return {
    id: typeof snap.id === "string" ? snap.id : String(rec.preset?.id ?? ""),
    ok: true,
    workdir: snap.workdir,
    model: snap.model,
    tools,
    memory: tools.includes("memory"),
    prompt: user,
    agentsMd: block === null ? "none" : "legacy",
    block,
    pending: rec.next !== undefined,
    ...(typeof snap.thinking === "string" ? { thinking: snap.thinking } : {}),
    ...(typeof snap.handoff === "number" ? { handoff: snap.handoff } : {}),
    ...(snap.options !== null && typeof snap.options === "object" && !Array.isArray(snap.options) ? { options: snap.options } : {}),
    ...(context.length > 0 ? { context } : {}),
  };
}

/** 字段什么时候生效：`call` 下一次调用，`segment` 换段时（空闲且段里还没有助手消息时，服务直接采用）。 */
export const EFFECT = /** @type {const} */ ({ thinking: "call", options: "call", handoff: "call", model: "segment", prompt: "segment", tools: "segment", workdir: "segment", context: "segment" });
/** @typedef {keyof typeof EFFECT} Field */

export const EFFECT_TEXT = { call: "下一次调用生效", segment: "换段时生效" };

/** 这个字段要等换段才生效。 @param {string} field */
export function isStructural(field) {
  return /** @type {Record<string, string>} */ (EFFECT)[field] === "segment";
}

/** `fields`（或待换配置的字段名）里有没有等换段才生效的。 @param {Record<string, unknown> | string[]} fields */
export function hasStructural(fields) {
  return (Array.isArray(fields) ? fields : Object.keys(fields)).some(isStructural);
}

/** 工具名的集合是否一样，不看顺序。 @param {string[]} a @param {string[]} b */
function sameSet(a, b) {
  return a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 会话表变成 `reconfigure` 的 `fields`：和初值（`orig`，会话快照）比，只发变了的；去掉的发 `null`。
 * 工具名只看集合，顺序变了不算改。提示词只有用户写的部分在框里，旧拼接块原样接回去；点了“转成上下文文件”才去掉。
 * 工作目录不分大小写和斜杠方向地比。
 * @param {SessionInfo} orig
 * @param {import("./models.js").Draft} d
 * @returns {{ ok: true, fields: Record<string, unknown> } | { ok: false, error: string }}
 */
export function buildSession(orig, d) {
  const model = d.model.trim();
  if (model === "") return { ok: false, error: "模型不能空" };
  const h = parseHandoff(d.handoff);
  if (!h.ok) return h;
  const o = parseOptions(d.options);
  if (!o.ok) return o;
  const c = parseContext(d.context);
  if (!c.ok) return c;
  const workdir = (d.workdir ?? orig.workdir).trim();
  if (workdir === "") return { ok: false, error: "工作目录不能空" };
  /** @type {Record<string, unknown>} */
  const fields = {};
  if (model !== orig.model) fields["model"] = model;
  if (d.thinking !== orig.thinking) fields["thinking"] = d.thinking === undefined ? null : d.thinking;
  if (!sameSet(d.tools, orig.tools)) fields["tools"] = d.tools;
  if (h.value !== orig.handoff) fields["handoff"] = h.value === undefined ? null : h.value;
  if (!same(o.value, orig.options)) fields["options"] = o.value === undefined ? null : o.value;
  if (!same(c.value, noEmpty(orig.context))) fields["context"] = c.value === undefined ? null : c.value;
  if (pathKey(workdir) !== pathKey(orig.workdir)) fields["workdir"] = workdir;
  const drop = d.convert === true && orig.block !== null;
  if (d.prompt.trim() !== (orig.prompt ?? "").trim() || drop) fields["prompt"] = joinPrompt(d.prompt, drop ? null : orig.block);
  return { ok: true, fields };
}

/**
 * “重读工具定义”发的 `fields`：这个会话现在已存的工具列表（`info.tools`）原样发一次。
 * 服务重读工具定义文件，内容变了就成为待换配置。表里还没保存的工具勾选不算，不然没点保存也会被存成待换配置。
 * @param {Pick<SessionInfo, "tools">} info
 * @returns {{ tools: string[] }}
 */
export function reloadFields(info) {
  return { tools: [...info.tools] };
}

/**
 * 保存失败的原文，只在表没动的时候显示：它说的是动之前的那份表，动了就不该再占着检查条、盖住新的填写错误。
 * @param {{ text: string, sig: string } | null} err `sig` 是出错时表的样子（`JSON.stringify` 一下表的草稿）
 * @param {string} sig 表现在的样子
 * @returns {string | null}
 */
export function shownErr(err, sig) {
  return err !== null && err.sig === sig ? err.text : null;
}

/** 待换配置里字段名的中文。服务以后加的字段原样写。 */
const FIELD_LABEL = /** @type {Record<string, string>} */ ({ model: "模型", prompt: "提示词", tools: "工具", workdir: "工作目录", context: "上下文文件" });

/**
 * 概况页顶上待换段条的字。没有待换配置（空数组）是 null。
 * @param {readonly string[]} fields 投影里 `self.pending.fields`
 * @returns {string | null}
 */
export function pendingText(fields) {
  if (fields.length === 0) return null;
  return `待换段：${fields.map((f) => FIELD_LABEL[f] ?? f).join("、")}`;
}

/** 投影里 `self.pending.fields`；没有这个键是空数组。 @param {Self | null | undefined} self @returns {string[]} */
export function pendingOf(self) {
  const f = self?.pending?.fields;
  return Array.isArray(f) ? f.filter((x) => typeof x === "string") : [];
}

/**
 * 收到新的 `update` 以后，要不要重读这个进程的 `inspect`（快照、阈值可能变了）：第一次见、模型变了、换段了、待换配置变了。
 * 其余的变化（调用参数被别的客户端改了）靠概况页的轮询、窗口回到前台和自己发的 `reconfigure` 后的重读追上。
 * @param {Self | undefined} prev @param {Self} cur
 */
export function needsInspect(prev, cur) {
  return !prev || prev.model !== cur.model || prev.segment !== cur.segment || pendingOf(prev).join(",") !== pendingOf(cur).join(",");
}

/** 回执 `pending` 的意思。`pending: false` 有几种（没变、已直接采用、已取消），分不清就不乱说。 @param {boolean} pending */
export function receiptNote(pending) {
  return pending ? "已发出。现在有待换配置，换段时生效。" : "已发出。没有待换配置：只改了调用参数，或者已经直接采用，或者内容没变。";
}
