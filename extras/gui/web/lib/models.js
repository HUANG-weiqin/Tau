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
  if (k === "unreadable") return "tau 只认字面量的 key，不认 ! 开头的命令和含 $ 的写法，进程第一次调模型时会出错；在 pi 的 auth.json 里改成字面量。";
  return "这家还没配 key，进程第一次调模型时会出错；key 在 pi 的 auth.json 里配。";
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
function parseHandoff(text) {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1) return { ok: false, error: "换段阈值要写正整数（token），不写就是不限" };
  return { ok: true, value: n };
}

/**
 * 预设表里填的东西。`thinking` 是 undefined 表示不思考。`handoff`、`options` 是输入框里的文字。
 * @typedef {{ model: string, thinking: string | undefined, tools: string[], handoff: string, options: string, prompt: string }} Draft
 */

/**
 * 新建：只带填了的 thinking、handoff、options。
 * @param {Draft} d
 * @returns {{ ok: true, fields: { thinking?: string, handoff?: number, options?: Record<string, unknown> } } | { ok: false, error: string }}
 */
export function buildCreate(d) {
  const h = parseHandoff(d.handoff);
  if (!h.ok) return h;
  const o = parseOptions(d.options);
  if (!o.ok) return o;
  return {
    ok: true,
    fields: {
      ...(d.thinking === undefined ? {} : { thinking: d.thinking }),
      ...(h.value === undefined ? {} : { handoff: h.value }),
      ...(o.value === undefined ? {} : { options: o.value }),
    },
  };
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 改预设：和现在的预设比，只发变了的字段；去掉的字段发 `null`。提示词没动不发。
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
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (model !== orig.model) patch["model"] = model;
  if (d.thinking !== orig.thinking) patch["thinking"] = d.thinking === undefined ? null : d.thinking;
  if (!same(d.tools, orig.tools)) patch["tools"] = d.tools;
  if (h.value !== orig.handoff) patch["handoff"] = h.value === undefined ? null : h.value;
  if (!same(o.value, orig.options)) patch["options"] = o.value === undefined ? null : o.value;
  if (d.prompt.trim() !== origPrompt.trim()) patch["prompt"] = d.prompt;
  return { ok: true, patch };
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
