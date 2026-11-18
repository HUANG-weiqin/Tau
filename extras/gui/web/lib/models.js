// @ts-check
// 模型选择器和预设表的纯逻辑：窗口的写法、思考级别、搜索、最近用过、表单变成请求。
/** @typedef {import("./types.js").PresetInfo} PresetInfo */

/** 预设 `thinking` 收的级别，从弱到强。不思考就是不写这个键。 */
export const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const RECENT_MAX = 6;

/**
 * @typedef {{ id: string, name: string, window: number, image: boolean, thinking: string[] }} CatalogModel
 * @typedef {"key" | "oauth" | "none" | "unreadable"} KeyStatus
 * @typedef {{ id: string, name: string, key: KeyStatus, models: CatalogModel[] }} CatalogProvider
 */

/** 上下文窗口：128K、1M。 @param {number} n */
export function formatWindow(n) {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * 换了模型，原来的思考级别不被支持：换成支持的最近一档，距离一样取低的。
 * 这个模型没有可选的级别，或者本来就没写，就是不思考（`undefined`）。
 * @param {string[]} supported @param {string | undefined} wanted @returns {string | undefined}
 */
export function nearestLevel(supported, wanted) {
  if (wanted === undefined || supported.length === 0) return undefined;
  if (supported.includes(wanted)) return wanted;
  const at = LEVELS.indexOf(wanted);
  /** @type {string | undefined} */
  let best;
  let bestD = Infinity;
  for (const l of [...supported].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b))) {
    const d = Math.abs(LEVELS.indexOf(l) - at);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

/** `<供应商>/<模型 ID>`，供应商名里没有斜杠，模型 ID 里可以有。 @param {string} ref */
export function splitModel(ref) {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** @param {CatalogProvider[] | null | undefined} providers @param {string} ref */
export function findModel(providers, ref) {
  const s = splitModel(ref);
  if (!s || !providers) return null;
  const provider = providers.find((p) => p.id === s.provider);
  const model = provider?.models.find((m) => m.id === s.id);
  return provider && model ? { provider, model } : null;
}

/** key 状态的先后：配好的在前，读不了的、OAuth 的次之，没配的最后；同样的按名字。 */
const KEY_ORDER = { key: 0, unreadable: 1, oauth: 2, none: 3 };

/** @param {CatalogProvider[]} providers */
export function sortProviders(providers) {
  return [...providers].sort((a, b) => KEY_ORDER[a.key] - KEY_ORDER[b.key] || a.name.localeCompare(b.name, "en"));
}

/**
 * 搜索：空格分开的每个词，都要在“供应商名 + 模型名”里出现（不分大小写）。
 * 供应商本身命中的，整组留下。没有命中的组去掉。
 * @param {CatalogProvider[]} providers @param {string} query
 */
export function filterCatalog(providers, query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return providers;
  /** @type {CatalogProvider[]} */
  const out = [];
  for (const p of providers) {
    const head = `${p.id} ${p.name}`.toLowerCase();
    if (words.every((w) => head.includes(w))) {
      out.push(p);
      continue;
    }
    const models = p.models.filter((m) => {
      const text = `${head} ${m.id} ${m.name}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    if (models.length > 0) out.push({ ...p, models });
  }
  return out;
}

/**
 * 选了一个 key 有问题的供应商，表单里提示一句。没问题是 null。
 * @param {KeyStatus} k @returns {string | null}
 */
export function keyHint(k) {
  if (k === "key") return null;
  if (k === "oauth") return "这家在 pi 里是 OAuth 登录，tau 不支持，进程第一次调模型时会出错；要换成 API key，在 pi 的 auth.json 里配。";
  if (k === "unreadable") return "tau 只认字面量的 key，不认 ! 开头的命令和含 $ 的写法，进程第一次调模型时会出错；在设置里换成字面量的 key。";
  return "这家还没配 key，进程第一次调模型时会出错；key 在设置里填。";
}

/**
 * 新建预设时预填的模型：设置里的默认，没有就是最近用过的，再没有就是第一家配了 key 的第一个模型，都没有是空。
 * 目录里没有的默认值也照用（手写的模型）。
 * @param {{ defaultModel?: string, recentModels: string[] }} gui @param {CatalogProvider[] | null | undefined} providers
 */
export function defaultModelRef(gui, providers) {
  if (gui.defaultModel) return gui.defaultModel;
  const recent = recentEntries(providers, gui.recentModels)[0];
  if (recent) return recent.ref;
  const p = providers?.find((x) => x.key === "key" && x.models.length > 0);
  const m = p?.models[0];
  return p && m ? `${p.id}/${m.id}` : "";
}

/** 最近用过：去重，最新在前，最多 6 个。 @param {string[]} list @param {string} ref */
export function pushRecent(list, ref) {
  const r = ref.trim();
  if (r === "") return list;
  return [r, ...list.filter((x) => x !== r)].slice(0, RECENT_MAX);
}

/** 最近用过的里面，目录里有的。 @param {CatalogProvider[] | null | undefined} providers @param {string[]} recent */
export function recentEntries(providers, recent) {
  return recent.flatMap((ref) => {
    const f = findModel(providers, ref);
    return f ? [{ ref, ...f }] : [];
  });
}

/** @param {KeyStatus} k */
export function keyLabel(k) {
  return k === "key" ? "已配" : k === "oauth" ? "OAuth（tau 不支持）" : k === "unreadable" ? "tau 读不了" : "没配";
}

/**
 * 一家供应商一行右边有哪些动作：填或换 key 的字，能不能清。OAuth 的没有动作；auth.json 读不出时都不可用。
 * @param {KeyStatus} k @param {boolean} authOk
 * @returns {{ set: "填 key" | "换 key", clear: boolean } | null}
 */
export function keyActions(k, authOk) {
  if (!authOk || k === "oauth") return null;
  return { set: k === "none" ? "填 key" : "换 key", clear: k === "key" };
}

/**
 * `options` 一行 JSON。空是没有，只收对象；内容合不合规由服务的 `check` 说了算。
 * @param {string} text
 * @returns {{ ok: true, value: Record<string, unknown> | undefined } | { ok: false, error: string }}
 */
export function parseOptions(text) {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return { ok: false, error: "options 要写成一行 JSON 对象" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "options 要写成一行 JSON 对象" };
  return { ok: true, value: /** @type {Record<string, unknown>} */ (v) };
}

/** 换段阈值：空是没有，否则正整数。 @param {string} text @returns {{ ok: true, value: number | undefined } | { ok: false, error: string }} */
export function parseHandoff(text) {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1) return { ok: false, error: "换段阈值要写正整数（token），不写就是不限" };
  return { ok: true, value: n };
}

/** 上下文文件最多几项，每项最长几个字符。同内核读预设的写法（D72）；路径对不对由服务查，页面只管写得成一行。 */
export const CONTEXT_MAX = 8;
const CONTEXT_CHARS = 260;

/**
 * 上下文文件一行一个路径：去空白、跳空行、重复的去掉（留第一次的）。空是没有。
 * 一项里不许有逗号（预设文件里写成逗号分隔的一行）和控制字符，最长 260 个字符。
 * @param {string} text
 * @returns {{ ok: true, value: string[] | undefined } | { ok: false, error: string }}
 */
export function parseContext(text) {
  const items = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ""))];
  if (items.length === 0) return { ok: true, value: undefined };
  if (items.length > CONTEXT_MAX) return { ok: false, error: `上下文文件最多 ${CONTEXT_MAX} 行` };
  const bad = items.find((x) => x.length > CONTEXT_CHARS || /[\u0000-\u001f\u007f,]/.test(x));
  if (bad !== undefined) return { ok: false, error: `上下文文件的路径最长 ${CONTEXT_CHARS} 个字符，不能有逗号：${bad.slice(0, 40)}` };
  return { ok: true, value: items };
}

/** `AGENTS.md` 勾选管的那一项。界面只认这个文件名，不认 CLAUDE.md。 */
export const AGENTS_FILE = "AGENTS.md";

/** 文件夹名变成能当预设 ID 的字：只留字母、数字、点、下划线、连字符，其余连成一个“-”，小写。一个合法的字都没有就是空串。 @param {string} path */
export function suggestId(path) {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * 新建预设时“更多设置”收起后的一行摘要：带不带记忆、有哪些工具（最多写 4 个）、带不带 AGENTS.md。
 * @param {readonly string[]} tools @param {string} context 上下文文件框里的文字
 */
export function moreSummary(tools, context) {
  const rest = tools.filter((t) => t !== "memory");
  const names = rest.length === 0 ? "没有工具" : rest.length > 4 ? `${rest.slice(0, 4).join(" ")} …共 ${rest.length} 个` : rest.join(" ");
  return [tools.includes("memory") ? "带记忆" : "不带记忆", names, hasAgents(context) ? "带 AGENTS.md" : ""].filter((x) => x !== "").join(" · ");
}

/** 上下文文字里有没有 `AGENTS.md` 这一行。 @param {string} text */
export function hasAgents(text) {
  return text.split(/\r?\n/).some((l) => l.trim() === AGENTS_FILE);
}

/** 勾上就加一行 `AGENTS.md`（已有不重复），取消就去掉这一行，别的行原样。 @param {string} text @param {boolean} on */
export function withAgents(text, on) {
  const lines = text.split(/\r?\n/);
  if (!on) return lines.filter((l) => l.trim() !== AGENTS_FILE).join("\n");
  if (hasAgents(text)) return text;
  const trimmed = text.replace(/\s+$/, "");
  return trimmed === "" ? AGENTS_FILE : `${trimmed}\n${AGENTS_FILE}`;
}

/** 预设和会话快照里的上下文文件，变成输入框里的文字。 @param {string[] | undefined} list */
export function contextText(list) {
  return (list ?? []).join("\n");
}

/** 空数组和没有一样。 @param {string[] | undefined} list */
export function noEmpty(list) {
  return list && list.length > 0 ? list : undefined;
}

/**
 * 预设表里填的东西。`thinking` 是 undefined 表示不思考。`handoff`、`options`、`context` 是输入框里的文字（`context` 一行一个路径）。
 * `workdir` 只有会话表有（预设表里不能改）。`convert` 为真表示用户点了“转成上下文文件”：保存时去掉旧拼接块。
 * @typedef {{ model: string, thinking: string | undefined, tools: string[], handoff: string, options: string, prompt: string, context: string, workdir?: string, convert?: boolean }} Draft
 */

/**
 * 新建：只带填了的 thinking、handoff、options、context。
 * @param {Draft} d
 * @returns {{ ok: true, fields: { thinking?: string, handoff?: number, options?: Record<string, unknown>, context?: string[] } } | { ok: false, error: string }}
 */
export function buildCreate(d) {
  const h = parseHandoff(d.handoff);
  if (!h.ok) return h;
  const o = parseOptions(d.options);
  if (!o.ok) return o;
  const c = parseContext(d.context);
  if (!c.ok) return c;
  return {
    ok: true,
    fields: {
      ...(d.thinking === undefined ? {} : { thinking: d.thinking }),
      ...(h.value === undefined ? {} : { handoff: h.value }),
      ...(o.value === undefined ? {} : { options: o.value }),
      ...(c.value === undefined ? {} : { context: c.value }),
    },
  };
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 改预设：和现在的预设比，只发变了的字段；去掉的字段发 `null`。提示词没动不发。旧拼接块只在 `convert` 时才去掉。
 * @param {Extract<PresetInfo, { ok: true }>} orig 现在预设文件读成的样子
 * @param {string} origPrompt 现在的提示词
 * @param {Draft} d
 * @returns {{ ok: true, patch: Record<string, unknown> } | { ok: false, error: string }}
 */
export function buildUpdate(orig, origPrompt, d) {
  const model = d.model.trim();
  if (model === "") return { ok: false, error: "模型不能空" };
  const h = parseHandoff(d.handoff);
  if (!h.ok) return h;
  const o = parseOptions(d.options);
  if (!o.ok) return o;
  const c = parseContext(d.context);
  if (!c.ok) return c;
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (model !== orig.model) patch["model"] = model;
  if (d.thinking !== orig.thinking) patch["thinking"] = d.thinking === undefined ? null : d.thinking;
  if (!same(d.tools, orig.tools)) patch["tools"] = d.tools;
  if (h.value !== orig.handoff) patch["handoff"] = h.value === undefined ? null : h.value;
  if (!same(o.value, orig.options)) patch["options"] = o.value === undefined ? null : o.value;
  if (!same(c.value, noEmpty(orig.context))) patch["context"] = c.value === undefined ? null : c.value;
  if (d.prompt.trim() !== origPrompt.trim()) patch["prompt"] = d.prompt;
  // 转成上下文文件：去掉提示词里的旧拼接块。`context` 里加 `AGENTS.md` 由表单在点的时候做。
  if (d.convert === true && orig.agentsMd === "legacy") patch["agentsMd"] = false;
  return { ok: true, patch };
}

/**
 * 项目里 AGENTS.md 的情况（`/api/agents-md` 查的结果，连同 `bad`：这个目录查不了）。还没查到是 null。
 * @typedef {{ exists: boolean, bad?: true } | null} AgentsInfo
 */

/**
 * “转成上下文文件”能不能做。项目里没有 AGENTS.md 时，旧块可能是内容的最后一份，转完内核读不到它：不让转。
 * 还没查到、查不了的目录也不让转，因为不能确认文件在。
 * @param {AgentsInfo} info
 * @returns {{ ok: true } | { ok: false, note: string }}
 */
export function convertGate(info) {
  if (info === null) return { ok: false, note: "正在查项目里有没有 AGENTS.md…" };
  if (info.bad === true) return { ok: false, note: "没查到这个目录，不能确认项目里有 AGENTS.md，先不转" };
  if (!info.exists) return { ok: false, note: "项目里没有 AGENTS.md，旧块是最后一份内容，转了就读不到" };
  return { ok: true };
}

/**
 * “转成上下文文件”的补丁：去掉提示词里的旧拼接块，`context` 里加 `AGENTS.md`（已有不重复）。项目概况里一键转用它。
 * 项目里没有 AGENTS.md（`convertGate` 不让转）时不给补丁，只给原因。
 * @param {{ context?: string[] }} preset 现在预设文件读成的样子
 * @param {AgentsInfo} info 预设的工作目录里 AGENTS.md 的情况
 * @returns {{ ok: true, patch: { agentsMd: false, context: string[] } } | { ok: false, note: string }}
 */
export function convertPatch(preset, info) {
  const g = convertGate(info);
  if (!g.ok) return g;
  const c = preset.context ?? [];
  return { ok: true, patch: { agentsMd: false, context: c.includes(AGENTS_FILE) ? c : [...c, AGENTS_FILE] } };
}

/**
 * 换模型时改预设的补丁：模型和思考强度和预设文件现在的不同才发；思考强度去掉发 `null`。
 * @param {{ model: string, thinking?: string }} file 预设文件现在读成的样子
 * @param {string} model @param {string | undefined} thinking
 * @returns {Record<string, unknown>}
 */
export function modelPatch(file, model, thinking) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (model.trim() !== file.model) patch["model"] = model.trim();
  if (thinking !== file.thinking) patch["thinking"] = thinking === undefined ? null : thinking;
  return patch;
}
