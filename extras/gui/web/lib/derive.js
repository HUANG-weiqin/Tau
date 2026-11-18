// @ts-check
// 从进程记录、预设和界面数据算出界面要显示的分组、排序和计数。全是纯函数，时间由调用方传入。
import { bgName } from "./messages.js";
import { pathKey } from "./state.js";
/** @typedef {import("./types.js").Self} Self */
/** @typedef {import("./types.js").GuiState} GuiState */
/** @typedef {import("./types.js").PresetInfo} PresetInfo */
/** @typedef {import("./types.js").Frozen} Frozen */
/** @typedef {import("./store.js").ProcRecord} ProcRecord */

const DAY = 24 * 60 * 60 * 1000;

/** 进程的状态：`running` 在跑，`error` 空闲且上一轮出错，`idle` 空闲，`fresh` 空闲且没有结束原因（刚建好）。 @typedef {"running" | "error" | "idle" | "fresh"} Status */
/** @typedef {"chief" | "team" | "temp" | "unknown"} Kind */

/**
 * @typedef {{
 *   id: string, preset: string, name: string, self: Self, status: Status, kind: Kind,
 *   workdir: string | null, tools: string[], memory: boolean, frozen: Frozen | null,
 *   createdAt: number, segmentStartedAt: number | null,
 * }} Entry
 */

/** @param {Self} self @returns {Status} */
export function classify(self) {
  const ph = self.phase;
  if (ph.tag !== "idle") return "running";
  if (ph.ended === undefined) return "fresh";
  return typeof ph.ended === "object" ? "error" : "idle";
}

/** `/api/presets` 的列表变成按 ID 查的表。 @param {PresetInfo[]} list @returns {Record<string, PresetInfo>} */
export function indexPresets(list) {
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

/** 预设的显示名，没记过就是预设 ID。 @param {Pick<GuiState, "names">} state @param {string} presetId */
export function displayName(state, presetId) {
  return state.names[presetId] ?? presetId;
}

/**
 * `inspect` 的一行 `process`：进程记录里的会话快照（`preset`，不是待换的 `next`），取界面要的几项。工具是内置的加工具定义的名字。
 * 会话快照能被 `reconfigure` 改，所以每次读到 `inspect` 都用它换掉旧的（`Frozen` 这个名字是历史遗留）。
 * 不是 `process` 行，或者没有快照，是 null。
 * @param {any} line
 * @returns {Frozen | null}
 */
export function seenFromInspect(line) {
  const snap = line?.type === "process" ? line.process?.preset : null;
  if (!snap || typeof snap.workdir !== "string" || !Array.isArray(snap.tools)) return null;
  /** @type {string[]} */
  const tools = [...snap.tools, ...(Array.isArray(snap.toolDefs) ? snap.toolDefs.map((/** @type {any} */ d) => d?.name).filter((/** @type {unknown} */ n) => typeof n === "string") : [])];
  const threshold = line.limits?.threshold;
  return {
    workdir: snap.workdir,
    tools,
    ...(Array.isArray(snap.input) ? { input: snap.input.filter((/** @type {unknown} */ x) => typeof x === "string") } : {}),
    ...(typeof threshold === "number" && threshold > 0 ? { threshold } : {}),
    memory: snap.tools.includes("memory"),
    ...(typeof snap.model === "string" ? { model: snap.model } : {}),
    ...(typeof snap.thinking === "string" ? { thinking: snap.thinking } : {}),
    ...(typeof snap.handoff === "number" ? { handoff: snap.handoff } : {}),
    ...(snap.options !== null && typeof snap.options === "object" && !Array.isArray(snap.options) ? { options: snap.options } : {}),
    ...(Array.isArray(snap.context) && snap.context.length > 0 ? { context: snap.context.filter((/** @type {unknown} */ x) => typeof x === "string") } : {}),
  };
}

/** 会话的模型不收图片：快照里读到了输入类型、并且没有 `image`。读不到就当收（不乱说）。 @param {Frozen | null | undefined} f */
export function refusesImages(f) {
  return !!f && Array.isArray(f.input) && !f.input.includes("image");
}

/** 到换段阈值的这个比例就变警告色。 */
export const NEAR_RATIO = 0.9;

/**
 * 段尺：已用占窗口几成（0 到 100，取整）、换段阈值在尺上的位置（没有阈值是 null）、是否接近或超过阈值。
 * 阈值来自 `inspect` 的 `limits.threshold`。
 * @param {{ used: number, window: number }} ctx @param {number | undefined} threshold
 * @returns {{ pct: number, mark: number | null, near: boolean }}
 */
export function rulerOf(ctx, threshold) {
  const ok = ctx.window > 0;
  const pct = ok ? Math.max(0, Math.min(100, Math.round((ctx.used / ctx.window) * 100))) : 0;
  const has = ok && typeof threshold === "number" && threshold > 0;
  return { pct, mark: has ? Math.max(0, Math.min(100, Math.round((threshold / ctx.window) * 100))) : null, near: has && ctx.used >= NEAR_RATIO * threshold };
}

/** 谁寄的。进程的信带 ID，后台任务的完成通知是带前缀的用户的信（`lib/messages.js` 的 `bgName`），其余是人的信。 @param {any} from @param {string} text */
function senderOf(from, text) {
  if (from?.kind === "process") return { id: String(from.id), label: `${from.preset} · ${from.id}`, reply: !!from.reply };
  const name = bgName(text);
  return name === null ? { id: null, label: "你", reply: false } : { id: null, label: `后台任务 · ${name}`, reply: false };
}

/** 一封信在列表里的样子：谁寄的、第一行。 @param {any} letter */
function letterLine(letter) {
  const from = letter?.from;
  const content = Array.isArray(letter?.content) ? letter.content : [];
  const text = content.find((/** @type {any} */ b) => b?.type === "text");
  const body = typeof text?.text === "string" ? text.text : "";
  const first = (body.split(/\r?\n/).find((/** @type {string} */ l) => l.trim() !== "") ?? "").trim();
  const images = content.filter((/** @type {any} */ b) => b?.type === "image").length;
  const who = senderOf(from, body);
  return { from: who.label, fromId: who.id, reply: who.reply, first: first || (images > 0 ? "（图片）" : ""), images, hops: Number(letter?.hops ?? 0), handoff: letter?.handoff === true };
}

/**
 * 进程的信箱情况，只从 `inspect` 回的原样记录推。
 * - `queued`：它这一轮里排着的信（`phase.turn.queued`），信本身没有时间，所以不给时间。
 * - `waitedBy`：等它回信的进程（它这一轮的 `replyTo`，加排队的信里的 `replyTo`）。
 * - `waitingOn`：它在等的进程：别的进程在跑的一轮里，`replyTo` 或排队的信的 `replyTo` 是它。
 * 空闲的进程没有排队的信，也没有人在等它。
 * @param {any[]} records 全部进程记录（`inspect` 每行的 `process`）
 * @param {string} id
 * @returns {{ queued: ReturnType<typeof letterLine>[], waitedBy: string[], waitingOn: string[] }}
 */
export function mailOf(records, id) {
  /** @param {any} r @returns {string[]} */
  const targets = (r) => {
    const turn = r?.phase?.turn;
    if (!turn) return [];
    /** @type {string[]} */
    const out = Array.isArray(turn.replyTo) ? [...turn.replyTo] : [];
    for (const l of Array.isArray(turn.queued) ? turn.queued : []) if (typeof l?.replyTo === "string") out.push(l.replyTo);
    return [...new Set(out)];
  };
  const mine = records.find((r) => r?.id === id);
  const queued = (Array.isArray(mine?.phase?.turn?.queued) ? mine.phase.turn.queued : []).map(letterLine);
  const waitedBy = targets(mine).filter((x) => x !== id);
  const waitingOn = records.filter((r) => r?.id !== id && targets(r).includes(id)).map((r) => String(r.id)).sort();
  return { queued, waitedBy: waitedBy.sort(), waitingOn };
}

/**
 * 每个进程的分类。进程归到哪个项目、常驻还是临时：看它的会话快照（`snaps`，来自 `inspect`），不看预设文件现在写什么。
 * 还没读到快照的进程是 `unknown`，不归进任何项目。
 * @param {Record<string, ProcRecord>} procs
 * @param {GuiState} state
 * @param {Record<string, Frozen>} snaps 进程 ID → 快照
 * @returns {{ entries: Entry[] }}
 */
export function buildEntries(procs, state, snaps) {
  /** @type {Entry[]} */
  const entries = [];
  for (const id of Object.keys(procs).sort()) {
    const rec = procs[id];
    if (!rec) continue;
    const { self } = rec;
    const info = snaps[id];
    /** @type {Kind} */
    const kind = self.preset === state.chief ? "chief" : !info ? "unknown" : info.memory ? "team" : "temp";
    entries.push({
      id,
      preset: self.preset,
      name: displayName(state, self.preset),
      self,
      status: classify(self),
      kind,
      workdir: info ? info.workdir : null,
      tools: info ? info.tools : [],
      memory: info ? info.memory : false,
      frozen: info ?? null,
      createdAt: rec.createdAt,
      segmentStartedAt: rec.segmentStartedAt,
    });
  }
  return { entries };
}

/**
 * 最后动静的时刻：当前段最后一条消息的时间戳（调用方读到的），没有就用本段开始，再没有就用建进程的时刻。
 * @param {Entry} e
 * @param {Record<string, number>} lastAt
 */
export function activityAt(e, lastAt) {
  return lastAt[e.id] ?? e.segmentStartedAt ?? e.createdAt;
}

/**
 * 新进程弹窗默认选中的预设：调用方指定的（要在可选的里面）；否则这个项目里最近有动静的进程的预设（也要在可选的里面）；再没有取第一个。一个可选的都没有是 null。
 * @param {readonly { id: string }[]} choices 这个项目里能选的预设
 * @param {readonly Entry[]} entries 这个项目的进程
 * @param {Record<string, number>} lastAt
 * @param {string | undefined} asked
 * @returns {string | null}
 */
export function defaultPreset(choices, entries, lastAt, asked) {
  const has = (/** @type {string} */ id) => choices.some((p) => p.id === id);
  if (asked !== undefined && has(asked)) return asked;
  const recent = entries.filter((e) => has(e.preset)).sort((a, b) => activityAt(b, lastAt) - activityAt(a, lastAt))[0];
  return recent?.preset ?? choices[0]?.id ?? null;
}

/**
 * 常驻预设的当前进程：界面数据记的（进程还在才算），否则取最近有动静的。没有进程是 null。
 * @param {string} presetId
 * @param {Entry[]} entries
 * @param {Pick<GuiState, "current">} state
 * @param {Record<string, number>} lastAt
 * @returns {Entry | null}
 */
export function currentOf(presetId, entries, state, lastAt) {
  const mine = entries.filter((e) => e.preset === presetId);
  const wanted = state.current[presetId];
  const rec = mine.find((e) => e.id === wanted);
  if (rec) return rec;
  /** @type {Entry | null} */
  let best = null;
  for (const e of mine) if (!best || activityAt(e, lastAt) > activityAt(best, lastAt) || (activityAt(e, lastAt) === activityAt(best, lastAt) && e.id > best.id)) best = e;
  return best;
}

/** @param {string} path */
function baseName(path) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * @typedef {{
 *   key: string, path: string, name: string, short: string, pinnedIndex: number,
 *   entries: Entry[], presets: Extract<PresetInfo, { ok: true }>[],
 *   running: number, errors: number, lastActive: number,
 * }} Project
 */

/**
 * 项目：一个文件夹。来源是进程的工作目录、预设文件的工作目录、打开过的文件夹和钉住的文件夹。总管的预设和它的进程不归进任何项目。
 * 按名字排序。
 * @param {Entry[]} entries
 * @param {GuiState} state
 * @param {Record<string, PresetInfo>} presets
 * @param {Record<string, number>} [lastAt]
 * @returns {Project[]}
 */
export function buildProjects(entries, state, presets, lastAt = {}) {
  /** @type {Map<string, Project>} */
  const map = new Map();
  /** @param {string} path */
  const ensure = (path) => {
    const key = pathKey(path);
    let p = map.get(key);
    if (!p) {
      const name = baseName(path);
      const custom = Object.entries(state.short).find(([k]) => pathKey(k) === key)?.[1];
      p = { key, path, name, short: custom ?? Array.from(name).slice(0, 5).join(""), pinnedIndex: -1, entries: [], presets: [], running: 0, errors: 0, lastActive: 0 };
      map.set(key, p);
    }
    return p;
  };
  state.pinned.forEach((path, i) => {
    const p = ensure(path);
    if (p.pinnedIndex < 0) p.pinnedIndex = i;
  });
  for (const f of state.folders) ensure(f);
  for (const pr of Object.values(presets)) if (pr.ok && pr.id !== state.chief) ensure(pr.workdir).presets.push(pr);
  for (const e of entries) {
    if (e.kind === "chief" || e.kind === "unknown" || e.workdir === null) continue;
    const p = ensure(e.workdir);
    p.entries.push(e);
    if (e.status === "running") p.running++;
    if (e.status === "error") p.errors++;
    p.lastActive = Math.max(p.lastActive, activityAt(e, lastAt));
  }
  return [...map.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * 项目窄条的分段：钉住的（最多 9 个，按钉的顺序）、有动静的（没钉住，出错的排前面）、其余的（按最近的动静）。
 * `runningTotal` 是全部进程里在跑的个数，总管的也算。
 * @param {Project[]} projects
 * @param {Entry[]} entries
 * @param {Pick<GuiState, "pinned">} state
 * @returns {{ pinned: Project[], active: Project[], rest: Project[], runningTotal: number }}
 */
export function railSections(projects, entries, state) {
  const pinned = projects
    .filter((p) => p.pinnedIndex >= 0 && p.pinnedIndex < 9)
    .sort((a, b) => a.pinnedIndex - b.pinnedIndex);
  const others = projects.filter((p) => !pinned.includes(p));
  const active = others
    .filter((p) => p.running > 0 || p.errors > 0)
    .sort((a, b) => Number(b.errors > 0) - Number(a.errors > 0) || b.lastActive - a.lastActive || (a.name < b.name ? -1 : 1));
  const rest = others.filter((p) => !active.includes(p)).sort((a, b) => b.lastActive - a.lastActive || (a.name < b.name ? -1 : 1));
  return { pinned, active, rest, runningTotal: entries.filter((e) => e.status === "running").length };
}

/** @typedef {"all" | "running" | "error"} Filter */

/** @param {Entry[]} entries @returns {{ all: number, running: number, error: number }} */
export function filterCounts(entries) {
  return { all: entries.length, running: entries.filter((e) => e.status === "running").length, error: entries.filter((e) => e.status === "error").length };
}

/**
 * 搜预设 ID、显示名、进程 ID 和标题，不分大小写。空查询全中。
 * @param {Entry} e
 * @param {string} query
 * @param {string} title
 */
export function matches(e, query, title) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [e.preset, e.name, e.id, title].some((s) => s.toLowerCase().includes(q));
}

/**
 * 筛选和搜索。返回留下的，和藏起来的个数。
 * @param {Entry[]} entries
 * @param {{ filter: Filter, query: string, titleOf: (id: string) => string }} opts
 * @returns {{ visible: Entry[], hidden: number }}
 */
export function applyFilter(entries, opts) {
  const visible = entries.filter((e) => (opts.filter === "all" || e.status === (opts.filter === "running" ? "running" : "error")) && matches(e, opts.query, opts.titleOf(e.id)));
  return { visible, hidden: entries.length - visible.length };
}

/**
 * 空闲的临时进程按最后动静分桶：今天（本地日历）、7 天内、更早。每桶里新的在前。
 * @param {Entry[]} idle
 * @param {Record<string, number>} lastAt
 * @param {number} clientNow
 * @returns {{ today: Entry[], week: Entry[], older: Entry[] }}
 */
export function bucketIdle(idle, lastAt, clientNow) {
  const d = new Date(clientNow);
  d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  const sorted = [...idle].sort((a, b) => activityAt(b, lastAt) - activityAt(a, lastAt) || (a.id < b.id ? -1 : 1));
  return {
    today: sorted.filter((e) => activityAt(e, lastAt) >= todayStart),
    week: sorted.filter((e) => activityAt(e, lastAt) < todayStart && clientNow - activityAt(e, lastAt) <= 7 * DAY),
    older: sorted.filter((e) => clientNow - activityAt(e, lastAt) > 7 * DAY && activityAt(e, lastAt) < todayStart),
  };
}

/**
 * @typedef {{
 *   presetId: string, name: string, current: Entry | null,
 *   shown: Entry[], folded: Entry[],
 *   total: number, runningCount: number, errorCount: number,
 * }} TeamRow
 */

/**
 * @typedef {{
 *   counts: { all: number, running: number, error: number }, hidden: number,
 *   teams: TeamRow[],
 *   temps: { errors: Entry[], running: Entry[], idle: { today: Entry[], week: Entry[], older: Entry[] }, idleCount: number },
 * }} ProjectView
 */

/**
 * 进程栏要显示的东西。
 * - 常驻团队一行一个预设，位置按名字排，不随状态变。行上是当前进程；其它的在跑和出错的露出（`shown`），空闲的折起来（`folded`）。
 *   正在搜索时不折：命中的全在 `shown`。
 * - 临时进程：出错的在前，在跑的其次，空闲的分桶。
 * - 筛选和搜索以后没有命中成员的团队行不出现；没筛选没搜索时，没有进程的常驻预设也有一行。
 * @param {Project} project
 * @param {{ state: GuiState, lastAt: Record<string, number>, clientNow: number, filter: Filter, query: string, titleOf: (id: string) => string }} o
 * @returns {ProjectView}
 */
export function projectView(project, o) {
  const counts = filterCounts(project.entries);
  const { visible, hidden } = applyFilter(project.entries, { filter: o.filter, query: o.query, titleOf: o.titleOf });
  const searching = o.query.trim() !== "";
  const unfiltered = o.filter === "all" && !searching;
  /** @param {Entry} a @param {Entry} b */
  const recent = (a, b) => activityAt(b, o.lastAt) - activityAt(a, o.lastAt) || (a.id < b.id ? -1 : 1);

  /** @type {Map<string, string>} */
  const teamIds = new Map();
  for (const e of project.entries) if (e.kind === "team") teamIds.set(e.preset, e.name);
  if (unfiltered) for (const p of project.presets) if (p.memory) teamIds.set(p.id, displayName(o.state, p.id));

  /** @type {TeamRow[]} */
  const teams = [];
  for (const [presetId, name] of [...teamIds].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1))) {
    const all = project.entries.filter((e) => e.kind === "team" && e.preset === presetId);
    const vis = visible.filter((e) => e.kind === "team" && e.preset === presetId);
    if (vis.length === 0 && !(unfiltered && all.length === 0)) continue;
    const globalCurrent = currentOf(presetId, all, o.state, o.lastAt);
    const current = globalCurrent && vis.includes(globalCurrent) ? globalCurrent : ([...vis].sort(recent)[0] ?? null);
    const others = vis.filter((e) => e !== current).sort(recent);
    const shown = others.filter((e) => searching || e.status === "running" || e.status === "error");
    teams.push({
      presetId,
      name,
      current,
      shown,
      folded: others.filter((e) => !shown.includes(e)),
      total: all.length,
      runningCount: all.filter((e) => e.status === "running").length,
      errorCount: all.filter((e) => e.status === "error").length,
    });
  }

  const temp = visible.filter((e) => e.kind === "temp");
  const idle = temp.filter((e) => e.status === "idle" || e.status === "fresh");
  return {
    counts,
    hidden,
    teams,
    temps: {
      errors: temp.filter((e) => e.status === "error").sort(recent),
      running: temp.filter((e) => e.status === "running").sort(recent),
      idle: bucketIdle(idle, o.lastAt, o.clientNow),
      idleCount: idle.length,
    },
  };
}

/**
 * “待你看”：出错的进程，以及说做完了、分支还没合并的进程。
 * `unmerged` 是工作目录 → 还没合并的分支名；给了才算第二类。总管的进程不算。
 * 第二类只看在 `recentMs` 内有动静的进程（默认 1 天），不知道动静时刻的也算。
 * @param {Entry[]} entries
 * @param {{ unmerged?: Record<string, string[]>, lastAt?: Record<string, number>, clientNow?: number, recentMs?: number }} [o]
 * @returns {{ id: string, preset: string, kind: "error" | "unmerged", detail: string }[]}
 */
export function attention(entries, o = {}) {
  const lastAt = o.lastAt ?? {};
  /** @type {Record<string, string[]>} */
  const byDir = {};
  for (const [dir, list] of Object.entries(o.unmerged ?? {})) byDir[pathKey(dir)] = list;
  const out = [];
  for (const e of entries) {
    if (e.kind === "chief") continue;
    if (e.status === "error") {
      const ph = e.self.phase;
      out.push({ id: e.id, preset: e.preset, kind: /** @type {const} */ ("error"), detail: ph.tag === "idle" && typeof ph.ended === "object" ? ph.ended.error : "" });
    }
  }
  for (const e of entries) {
    if (e.kind === "chief" || e.status !== "idle" || e.self.phase.tag !== "idle" || e.self.phase.ended !== "done" || e.workdir === null) continue;
    const branches = byDir[pathKey(e.workdir)];
    if (!branches || branches.length === 0) continue;
    const at = lastAt[e.id];
    if (at !== undefined && o.clientNow !== undefined && o.clientNow - at > (o.recentMs ?? DAY)) continue;
    out.push({ id: e.id, preset: e.preset, kind: /** @type {const} */ ("unmerged"), detail: branches.join("、") });
  }
  return out;
}
