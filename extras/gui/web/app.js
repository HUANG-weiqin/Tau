// 根组件：把连接、数据、聚焦、弹窗和键盘接在一起。其它模块只拿到下面的 `app`。
import { render } from "preact";
import { html, Pill, useEffect, useState, TipLayer, MenuLayer } from "./ui/common.js";
import * as api from "./api.js";
import { createConn, createHistoryReader, createPeeker } from "./conn.js";
import { emptyStore, reduce, streamingText, streamingLive, childCounts } from "./lib/store.js";
import { emptyHistory, segmentMessages, lastTimestamp, applyPushed } from "./lib/history.js";
import { buildEntries, buildProjects, railSections, projectView, currentOf, attention, seenFromInspect } from "./lib/derive.js";
import { describeNow, phaseStartedAt, HANDOFF_LETTER } from "./lib/messages.js";
import { processTitle, wantsAutoTitle } from "./lib/titles.js";
import { stopOrder } from "./lib/order.js";
import { formatDuration } from "./lib/format.js";
import * as gs from "./lib/state.js";
import { Rail } from "./ui/rail.js";
import { ProcList, railIds } from "./ui/list.js";
import { ProcessView } from "./ui/process.js";
import { Inspector } from "./ui/inspector.js";
import { ProjectView } from "./ui/project.js";
import { ChiefDialog } from "./ui/chief.js";
import { ProjectsDialog } from "./ui/projects.js";
import { CleanDialog } from "./ui/clean.js";
import { NewProcDialog } from "./ui/newproc.js";
import { OpenProjDialog } from "./ui/openproj.js";
import { NewPresetDialog } from "./ui/newpreset.js";
import { EditPresetDialog } from "./ui/editpreset.js";
import { SwitchModelDialog } from "./ui/switchmodel.js";
import { MemoryDialog } from "./ui/memory.js";
import { DiffDialog } from "./ui/diff.js";
import { SettingsDialog } from "./ui/settings.js";
import { ToolsDialog } from "./ui/tools.js";
import { Notifier } from "./ui/notify.js";
import { pushRecent } from "./lib/models.js";
import { ConfirmLayer, confirmOpen } from "./ui/remove.js";
import { ServiceBanner, StartServiceButton } from "./ui/banner.js";
import { autoTitle } from "./ui/titlecache.js";

/**
 * 页面上所有模块拿到的唯一对象 `app`。每次渲染重新生成，只读；改东西调用下面的动作。
 *
 * @typedef {import("./lib/types.js").Self} Self
 * @typedef {import("./lib/types.js").Message} Message
 * @typedef {import("./lib/types.js").GuiState} GuiState
 * @typedef {import("./lib/types.js").PresetInfo} PresetInfo
 * @typedef {import("./lib/derive.js").Entry} Entry
 * @typedef {import("./lib/derive.js").Project} Project
 * @typedef {import("./lib/history.js").History} History
 *
 * 数据（只读）
 * @typedef {object} AppData
 * @property {number} now 页面的当前时刻（毫秒），每秒更新一次。所有“多久以前”都用它算。
 * @property {number} skew 服务时钟减页面时钟。服务给的消息时间戳减去它，才是页面时钟的时刻。`clock(ts)` 已经算好。
 * @property {"connecting" | "online" | "offline"} status 和服务的连接。
 * @property {import("./lib/store.js").Store} store `lib/store` 的状态：`store.procs[id].self` 是进程视图。
 * @property {Record<string, PresetInfo>} presets 预设文件，按预设 ID 查。读不懂的 `ok: false`。
 * @property {PresetInfo[]} presetList 预设文件，列表。
 * @property {GuiState} gui 界面数据（`~/.tau/extras/gui/state.json`）。改它用 `setGui` 和 `lib/state.js` 的补丁函数。
 * @property {{ providers: import("./lib/models.js").CatalogProvider[], auth: { ok: true } | { ok: false, error: string } } | null} models 模型目录（供应商、模型、key 状态）。没读到前是 null。key 状态在打开相关弹窗时重读。
 * @property {string | null} modelsError 模型目录读不到的原因。
 * @property {boolean} ready 界面数据和预设都读到了。
 * @property {boolean} procsReady 连着服务，并且收到过进程表。没到之前，“某个预设没有进程”不可信。
 * @property {Entry[]} entries 全部进程（含总管的），已按预设分好类：`kind` 是 `chief | team | temp | unknown`，`status` 是 `running | error | idle | fresh`。
 * @property {Record<string, Entry>} byId 同上，按进程 ID 查。
 * @property {Record<string, number>} lastAt 进程最后动静的时刻（页面时钟）。没读到的进程没有。
 * @property {Record<string, number>} children 每个进程开的进程个数（含空闲的）。
 * @property {Project[]} projects 全部项目（总管不在内）。
 * @property {{ pinned: Project[], active: Project[], rest: Project[], runningTotal: number }} rail 窄条的分段。
 * @property {{ id: string, preset: string, kind: "error" | "unmerged", detail: string }[]} attention “待你看”里不需要 git 的部分：出错的进程。
 * @property {Entry | null} chiefEntry 总管的当前进程。
 * @property {"process" | "project" | "none"} focusKind 现在聚焦的是进程、项目，还是什么都没有（还没有项目）。
 * @property {Entry | null} focused 聚焦的进程。聚焦项目时是 null。
 * @property {string | null} focusedId 聚焦的进程 ID。进程可能还没出现在 `byId`（刚建好）。
 * @property {Project | null} project 进程栏现在显示的项目（聚焦进程时是它所在的项目）。
 * @property {import("./lib/derive.js").ProjectView | null} view 进程栏的内容（筛选和搜索后）。
 * @property {"all" | "running" | "error"} filter 进程栏的筛选。
 * @property {string} query 进程栏的搜索词。
 * @property {number} tab 详情栏现在的选项卡，0 到 2。聚焦进程时 0 概况、1 改动、2 后台；聚焦项目时 0 概况、1 分支、2 后台。
 * @property {{ name: string, rect: { left: number, top: number, right: number, bottom: number } | null, props: any } | null} dialog 打开着的弹窗：`chief | newproc | newpreset | openproj | projects | clean | settings | editpreset | switchmodel | memory | tools`。`props` 是打开时传的。
 *
 * 读取（函数）
 * @typedef {object} AppReaders
 * @property {(ts: number) => number} clock 服务时间戳换成页面时钟。
 * @property {(id: string) => History} history 这个进程的完整历史缓存（按段）。只有被 `follow` 的进程才读全；没读的是空的。
 * @property {(id: string) => readonly Message[]} messages 这个进程当前段的消息。被 `follow` 的是整段；其它的只有末尾几条。
 * @property {(id: string) => string} streamText 模型正在写的文字（只在等模型时有）。
 * @property {(id: string) => import("./lib/stream.js").Live | null} streamLive 这一次调用流式推来的正文、思考、工具调用参数（只在等模型时有）。
 * @property {(id: string) => { title: string, note?: string, known: boolean }} titleOf 进程的标题。
 * @property {(e: Entry) => { label: string, tool: string, since: number | null, dur: string, doing: string, endedText: string }} describe 进程此刻在做什么：阶段名（空闲时是上一轮的结束原因）、等工具时的工具名、阶段开始的时刻、已经多久、最后一步的摘要。
 * @property {(id: string) => Entry | null} entryOf
 * @property {(path: string) => Project | null} projectOf 路径对应的项目。
 *
 * 动作（都返回 Promise，出错抛错；页面已经弹了提示，调用方不必再提示）
 * @typedef {object} AppActions
 * @property {(id: string) => void} focusProcess
 * @property {(key: string | null) => void} focusProject 项目的 `key`。传 null 回到默认项目。
 * @property {(id: string) => void} follow 让这个进程的完整历史被读到并保持更新。聚焦的进程自动 follow。
 * @property {(id: string, text: string, images?: string[]) => Promise<void>} send 寄信。界面寄过信的常驻进程成为当前进程。
 * @property {(id: string) => Promise<void>} handoff 换段：寄一封换段信（`send` 带 `handoff`）。段里已有助手消息才生效，见 `canHandoff`。
 * @property {(preset: string, text: string, images?: string[]) => Promise<string>} start 建进程，回进程 ID。记进 `mine`，常驻预设成为当前进程，并聚焦它。
 * @property {(id: string, before?: number, preset?: string) => Promise<string>} fork 分叉，回新进程 ID。`before` 是当前段里一条用户消息的段内序号；不给就复制整个当前段（源进程必须空闲）。`preset` 是换角色：新进程用这个预设（读文件现在的样子），记忆库也跟着它走。
 * @property {(id: string) => Promise<void>} stop 停这一轮。
 * @property {(project: Project) => Promise<void>} stopAll 停项目里所有在跑的进程，子孙先停，反复做到都空闲为止。
 * @property {(id: string) => Promise<void>} remove 删一个空闲进程。被拒绝时抛错，原因是服务给的；不弹提示，由调用方写在确认框里。
 * @property {() => Promise<number>} sweep 清没人引用的图片，回删掉的个数。
 * @property {(patch: Record<string, unknown> | ((g: GuiState) => Record<string, unknown>)) => Promise<void>} setGui 改界面数据：顶层键整个覆盖。先改页面里的，再写文件。补丁用 `lib/state.js` 的函数算。传函数时，写之前先读文件里的最新状态再算，别的页面改过的不会被盖掉。
 * @property {(workdir: string, what: "status" | "diff" | "log" | "branches", file?: string) => Promise<any>} git 桥的 `/api/git`。
 * @property {(processes: string[]) => Promise<any[]>} bg 桥的 `/api/bg`。
 * @property {() => Promise<void>} reloadPresets 重读预设文件。
 * @property {(p: Record<string, unknown>) => Promise<void>} createPreset 建预设文件，成功后重读预设。
 * @property {(p: Record<string, unknown>) => Promise<import("./lib/types.js").PresetInfo>} updatePreset 改预设文件（只发变了的字段，`id` 必带），成功后重读预设，回改完读到的样子。读不出时服务改回旧文件，抛错，原因是 `check` 的原文；不弹提示，由调用方写在弹窗里。
 * @property {() => Promise<void>} reloadModels 重读模型目录和 key 状态。
 * @property {(ref: string) => Promise<void>} rememberModel 把这个模型记进“最近用过”。
 * @property {(id: string) => Promise<void>} deletePreset 删预设文件，成功后重读预设。失败抛错，不弹提示，由调用方写在确认框里。
 * @property {() => Promise<string | null>} pickFolder 系统选文件夹的对话框。
 * @property {(hash: string) => Promise<string | null>} blob 一张图片的 data URL。
 * @property {(name: string, anchor?: Element | null, props?: any) => void} openDialog 打开弹窗，贴着 `anchor`（不给就用约定的按钮）。
 * @property {() => void} closeDialog
 * @property {(n: number) => void} setTab
 * @property {(f: "all" | "running" | "error") => void} setFilter
 * @property {(q: string) => void} setQuery
 * @property {(path: string) => Promise<void>} pin 钉住项目。
 * @property {(path: string) => Promise<void>} unpin
 * @property {(path: string, delta: number) => Promise<void>} movePinned 在钉住的顺序里挪一格。
 * @property {(from: string, to: string) => Promise<void>} reorderPinned 把 `from` 项目挪到 `to` 项目的位置。
 * @property {(presetId: string, pid: string) => Promise<void>} makeCurrent 把 `pid` 设为常驻预设的当前进程。
 * @property {(text: string) => void} toast 底下弹一句提示。
 * @typedef {AppData & AppReaders & AppActions} App
 */

/* ------------------------------------------------------------------ 状态 */

/** 页面的全部状态。只在这里改，改完 `schedule()`。 */
const S = {
  store: emptyStore(),
  /** @type {Record<string, History>} */
  hist: {},
  /** @type {Record<string, { segment: number, total: number, msgs: Message[], lastAt: number | null }>} */
  peek: {},
  /** @type {Record<string, PresetInfo>} */
  presets: {},
  /** @type {PresetInfo[]} */
  presetList: [],
  /** 进程冻结的预设快照（`inspect`），进程 ID → 三项。 @type {Record<string, import("./lib/types.js").Frozen>} */
  snaps: {},
  /** 这次连上以后读过全部快照。 */
  snapsReady: false,
  /** @type {import("./app.js").App["models"]} */
  models: null,
  /** @type {string | null} */
  modelsError: null,
  gui: gs.normalizeState({}),
  guiReady: false,
  presetsReady: false,
  /** @type {"connecting" | "online" | "offline"} */
  status: "connecting",
  statusMsg: "",
  skew: 0,
  now: Date.now(),
  /** @type {{ proc: string | null, proj: string | null }} */
  route: { proc: null, proj: null },
  /** @type {string[]} */
  followed: [],
  /** 这个页面见过的进程 ID。 @type {Set<string>} */
  ever: new Set(),
  /** 第一次拿到进程表后，界面数据里没人认的 ID 都清掉。 */
  firstPrune: false,
  gotPs: false,
  /** 这次连上以后收到过进程表。断开就清掉：重连后、新进程表到之前，旧表里没有别处新建的进程。 */
  psFresh: false,
  /** 界面数据写失败后，这个时刻之前不再自动写（清理）。 */
  guiFailUntil: 0,
  /** @type {"all" | "running" | "error"} */
  filter: "all",
  query: "",
  tab: 0,
  /** @type {{ name: string, rect: any, props: any } | null} */
  dialog: null,
  /** @type {{ text: string, id: number } | null} */
  toastMsg: null,
};

let queued = false;
/** @type {() => void} */
let bump = () => {};
function schedule() {
  if (queued) return;
  queued = true;
  // 页面在后台时 rAF 不跑，用定时器兜底：谁先到谁渲染。
  const go = () => {
    if (!queued) return;
    queued = false;
    bump();
  };
  requestAnimationFrame(go);
  setTimeout(go, 200);
}

/** @param {string} text */
function toast(text) {
  const id = Date.now();
  S.toastMsg = { text, id };
  schedule();
  setTimeout(() => {
    if (S.toastMsg && S.toastMsg.id === id) {
      S.toastMsg = null;
      schedule();
    }
  }, 4500);
}

/** @template T @param {Promise<T>} p @returns {Promise<T>} */
function loud(p) {
  p.catch((e) => toast(e instanceof Error ? e.message : String(e)));
  return p;
}

/* ------------------------------------------------------------------ 界面数据的写入 */

let writeChain = Promise.resolve();
let writing = 0;
/** @param {Record<string, unknown> | ((g: import("./lib/types.js").GuiState) => Record<string, unknown>)} arg */
function setGui(arg) {
  const fn = typeof arg === "function" ? arg : () => arg;
  S.gui = { ...S.gui, ...fn(S.gui) };
  schedule();
  writing++;
  const job = writeChain
    .then(async () => {
      // 先读文件里的最新状态再算补丁，别的页面（手机和桌面同时开着）改过的不会被盖掉。
      const fresh = gs.normalizeState(await api.getState());
      const patch = fn(fresh);
      if (Object.keys(patch).length === 0) return;
      const saved = await api.setState(patch);
      if (writing === 1) {
        S.gui = gs.normalizeState(saved);
        schedule();
      }
    })
    .then(
      () => {
        writing--;
      },
      (e) => {
        writing--;
        S.guiFailUntil = Date.now() + 30000;
        toast(`界面数据没写进去：${e instanceof Error ? e.message : e}`);
        return refreshGui();
      },
    );
  writeChain = job;
  return job;
}

/** 重读界面数据。有写入在排队时不读，免得冲掉乐观的改动。 */
function refreshGui() {
  if (writing > 0) return Promise.resolve();
  return api.getState().then(
    (st) => {
      if (writing > 0) return;
      S.gui = gs.normalizeState(st);
      schedule();
    },
    () => {},
  );
}

/** 标题攒一下再写，一次写一批。 */
/** @type {Record<string, string>} */
let pendingTitles = {};
let titleTimer = 0;
/** @param {string} id @param {string | null} title */
function noteTitle(id, title) {
  if (title === null) return;
  pendingTitles[id] = title;
  if (titleTimer) return;
  titleTimer = window.setTimeout(() => {
    titleTimer = 0;
    const batch = pendingTitles;
    pendingTitles = {};
    // 已经自动起过标题的，不拿第一行盖掉。
    setGui((g) => ({ titles: { ...g.titles, ...Object.fromEntries(Object.entries(batch).filter(([id]) => !g.titled.includes(id))) } }));
  }, 400);
}

/* ------------------------------------------------------------------ 读历史 */

const reader = createHistoryReader({
  getSelf: (id) => S.store.procs[id]?.self,
  getHist: (id) => S.hist[id],
  setHist: (id, h) => {
    S.hist[id] = h;
    schedule();
  },
});

const peeker = createPeeker({
  onPeek: (id, v) => {
    S.peek[id] = v;
    schedule();
  },
  onTitle: noteTitle,
});

/** @param {string} id */
function follow(id) {
  const next = [id, ...S.followed.filter((x) => x !== id)];
  // 被挤出去的进程不再保持更新，旧缓存也删掉，免得显示停在被挤出的那一刻。
  for (const old of next.slice(8)) delete S.hist[old];
  S.followed = next.slice(0, 8);
  reader.follow(id);
}

/**
 * watch 推来的追加消息：并进缓存（只有被 follow 的进程有缓存），也并进别的进程的末尾几条。
 * 并不进去的（漏了、没读过）不管：缓存比 self.messages 少，reader 到时候用 history 补。
 * @param {any} r
 */
function onPushed(r) {
  const self = S.store.procs[r.process]?.self;
  if (!self) return;
  const h = S.hist[r.process];
  if (h) S.hist[r.process] = applyPushed(h, self, r);
  peeker.push(r.process, r);
  schedule();
}

/** @param {any} r */
function onReply(r) {
  if (r.type === "message" && typeof r.process === "string") return onPushed(r);
  const now = Date.now();
  // 删的是正在看的进程时，主区回到它的项目。先在进程还在表里时算出项目。
  const home = r.type === "removed" && S.route.proc === r.process ? buildEntries(S.store.procs, S.gui, S.snaps).entries.find((e) => e.id === r.process)?.workdir : undefined;
  if (r.type === "ps" && r.processes[0]) S.skew = r.processes[0].now - now;
  S.store = reduce(S.store, r, now);
  if (r.type === "ps") {
    if (!S.gotPs) S.firstPrune = true;
    S.gotPs = true;
    S.psFresh = true;
    for (const p of r.processes) S.ever.add(p.self.id);
    for (const id of Object.keys(S.hist)) if (!S.store.procs[id]) delete S.hist[id];
    for (const p of r.processes) onSelf(p.self, 0);
    loadSnaps(null);
    const want = S.route.proc;
    if (want && !S.store.procs[want]) setRoute({ proc: null });
  } else if (r.type === "update") {
    S.ever.add(r.self.id);
    // 同一次推送里紧跟着有这次追加的消息：等一等，推来的接得上就不读 history。
    onSelf(r.self, PUSH_GRACE);
    if (S.snapsReady && !S.snaps[r.self.id]) loadSnaps(r.self.id);
  }
  else if (r.type === "removed") {
    delete S.snaps[r.process];
    delete S.hist[r.process];
    delete S.peek[r.process];
    peeker.forget(r.process);
    S.followed = S.followed.filter((x) => x !== r.process);
    if (S.route.proc === r.process) setRoute({ proc: null, proj: home ? gs.pathKey(home) : S.route.proj });
  }
  schedule();
}

/** 正在单独读快照的进程 ID。 @type {Set<string>} */
const snapAsked = new Set();

/**
 * 读进程记录里冻结的预设快照（`inspect`）。`id` 为 null 读全部，并把不在表里的丢掉；否则只读这一个。
 * 一个进程的快照建好以后不变，所以收到 `update` 时只补没读过的。
 * @param {string | null} id
 */
async function loadSnaps(id) {
  if (id !== null) {
    if (snapAsked.has(id)) return;
    snapAsked.add(id);
  }
  try {
    const rs = await api.tauAll(id === null ? { op: "inspect" } : { op: "inspect", process: id });
    /** @type {Record<string, import("./lib/types.js").Frozen>} */
    const got = {};
    for (const x of rs) {
      const f = seenFromInspect(x);
      if (f) got[x.process.id] = f;
    }
    S.snaps = id === null ? Object.fromEntries(Object.entries({ ...S.snaps, ...got }).filter(([k]) => S.store.procs[k])) : { ...S.snaps, ...got };
    if (id === null) S.snapsReady = true;
  } catch (e) {
    if (id === null) toast(`读不到进程的预设快照：${e instanceof Error ? e.message : e}`);
  }
  if (id !== null) snapAsked.delete(id);
  // 读全部的时候新建的进程可能没在里面：补上。
  else for (const k of Object.keys(S.store.procs)) if (!S.snaps[k]) loadSnaps(k);
  schedule();
}

/** 收到 update 以后等多久再决定要不要读 history，毫秒。watch 带 messages: true，追加的消息和 update 同一次推来。 */
const PUSH_GRACE = 250;

/** @param {Self} self @param {number} grace */
function onSelf(self, grace) {
  peeker.note(self, grace);
  if (S.followed.includes(self.id)) reader.follow(self.id, grace);
}

/* ------------------------------------------------------------------ 路由：聚焦的进程或项目，写进地址栏的 # */

function parseHash() {
  const q = new URLSearchParams(location.hash.replace(/^#/, ""));
  const raw = location.hash.replace(/^#/, "");
  return { proc: q.get("p"), proj: q.get("proj"), dlg: q.get("dlg") ?? (raw === "chief" ? "chief" : null), ns: q.get("ns") };
}

function writeHash() {
  const q = new URLSearchParams();
  if (S.route.proc) q.set("p", S.route.proc);
  else if (S.route.proj) q.set("proj", S.route.proj);
  if (S.dialog && HASH_DIALOGS.includes(S.dialog.name)) q.set("dlg", S.dialog.name);
  // 记忆页要知道开的是哪个预设的库，写在 ns 里。
  if (S.dialog && S.dialog.name === "memory" && S.dialog.props?.ns) q.set("ns", S.dialog.props.ns);
  const s = q.toString();
  const next = s ? `#${s}` : location.pathname + location.search;
  try {
    history.replaceState(null, "", next);
  } catch {
    // 地址栏改不了就算了。
  }
}

/** @param {Partial<typeof S.route>} patch */
function setRoute(patch) {
  S.route = { ...S.route, ...patch };
  writeHash();
  schedule();
}

/* ------------------------------------------------------------------ 推导 */

/** 最近一次渲染算出来的东西，给动作用。 @type {App | null} */
let LAST = null;

/** @param {string} id @returns {readonly Message[]} */
function messagesOf(id) {
  const self = S.store.procs[id]?.self;
  const h = S.hist[id];
  if (self && h && S.followed.includes(id) && h.followed === self.segment && (h.segs[self.segment]?.msgs.length ?? 0) > 0) return segmentMessages(h, self.segment);
  const p = S.peek[id];
  return p && self && p.segment === self.segment ? p.msgs : [];
}

/** @param {any} ended */
function endedText(ended) {
  if (ended === undefined) return "";
  if (ended === "done") return "正常结束";
  if (ended === "stepLimit") return "步数用完";
  if (ended === "stopped") return "被停止";
  return "出错";
}

function compute() {
  const now = S.now;
  const procs = S.store.procs;
  const { entries } = buildEntries(procs, S.gui, S.snaps);
  /** @type {Record<string, number>} */
  const lastAt = {};
  for (const [id, p] of Object.entries(S.peek)) if (p.lastAt !== null) lastAt[id] = p.lastAt - S.skew;
  for (const [id, h] of Object.entries(S.hist)) {
    const self = procs[id]?.self;
    if (!self) continue;
    const t = lastTimestamp(h, self.segment);
    if (t !== null) lastAt[id] = Math.max(lastAt[id] ?? 0, t - S.skew);
  }
  /** @type {Record<string, Entry>} */
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const projects = buildProjects(entries, S.gui, S.presets, lastAt);
  const rail = railSections(projects, entries, S.gui);
  const titleOf = (/** @type {string} */ id) => processTitle(id, S.gui);

  const focusedId = S.route.proc;
  const focused = focusedId ? (byId[focusedId] ?? null) : null;
  /** @type {Project | null} */
  let project = null;
  if (focused && focused.kind !== "chief" && focused.workdir !== null) project = projects.find((p) => p.key === gs.pathKey(focused.workdir ?? "")) ?? null;
  if (!project && S.route.proj) project = projects.find((p) => p.key === S.route.proj) ?? null;
  if (!project) project = rail.pinned[0] ?? rail.active[0] ?? rail.rest[0] ?? projects[0] ?? null;
  const focusKind = focusedId ? "process" : project ? "project" : "none";
  const view = project ? projectView(project, { state: S.gui, lastAt, clientNow: now, filter: S.filter, query: S.query, titleOf: (id) => titleOf(id).title }) : null;
  const chiefEntry = S.gui.chief ? currentOf(S.gui.chief, entries.filter((e) => e.kind === "chief"), S.gui, lastAt) : null;

  /** @type {App} */
  const app = {
    now,
    skew: S.skew,
    status: S.status,
    store: S.store,
    presets: S.presets,
    presetList: S.presetList,
    gui: S.gui,
    models: S.models,
    modelsError: S.modelsError,
    ready: S.guiReady && S.presetsReady && S.snapsReady,
    procsReady: S.psFresh && S.status === "online",
    entries,
    byId,
    lastAt,
    children: childCounts(S.store),
    projects,
    rail,
    attention: attention(entries, { lastAt, clientNow: now }),
    chiefEntry,
    focusKind,
    focused,
    focusedId,
    project,
    view,
    filter: S.filter,
    query: S.query,
    tab: S.tab,
    dialog: S.dialog,

    clock: (ts) => ts - S.skew,
    history: (id) => S.hist[id] ?? emptyHistory(),
    messages: messagesOf,
    streamText: (id) => streamingText(S.store, id),
    streamLive: (id) => streamingLive(S.store, id),
    titleOf,
    describe: (e) => {
      const msgs = messagesOf(e.id);
      const tag = e.self.phase.tag;
      const at = phaseStartedAt(msgs, tag);
      const since = at !== null ? at - S.skew : (lastAt[e.id] ?? e.segmentStartedAt ?? e.createdAt);
      const dur = formatDuration(now - since);
      const ended = e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
      /** @type {string} */
      let tool = "";
      if (tag === "awaitingTool") {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role !== "assistant") continue;
          const calls = m.content.filter((b) => b.type === "toolCall");
          tool = /** @type {any} */ (calls[calls.length - 1])?.name ?? "";
          break;
        }
      }
      const label = tag === "awaitingModel" ? (e.self.phase.tag === "awaitingModel" && e.self.phase.purpose === "handoff" ? "写交接说明" : "等模型") : tag === "awaitingTool" ? "等工具" : "空闲";
      return { label, tool, since, dur, doing: describeNow(msgs), endedText: endedText(ended) };
    },
    entryOf: (id) => byId[id] ?? null,
    projectOf: (path) => projects.find((p) => p.key === gs.pathKey(path)) ?? null,

    focusProcess: (id) => {
      follow(id);
      const keep = byId[id]?.kind === "chief" ? (project?.key ?? null) : null;
      S.tab = Math.min(S.tab, 2);
      setRoute({ proc: id, proj: keep });
    },
    focusProject: (key) => {
      if (key !== (project?.key ?? null)) S.query = "";
      setRoute({ proc: null, proj: key });
    },
    follow,
    send: (id, text, images) =>
      loud(
        (async () => {
          await api.tauCommand({ op: "send", process: id, text, ...(images && images.length ? { images } : {}) });
          const e = byId[id];
          if (e && e.kind === "team" && S.gui.current[e.preset] !== id) await setGui((g) => gs.setCurrent(g, e.preset, id));
        })(),
      ),
    handoff: (id) => loud(api.tauCommand({ op: "send", process: id, text: HANDOFF_LETTER, handoff: true }).then(() => {})),
    start: (preset, text, images) =>
      loud(
        (async () => {
          const r = await api.tauCommand({ op: "start", preset, text, ...(images && images.length ? { images } : {}) });
          const pid = r.process ?? "";
          if (!pid) throw new Error("服务没有回进程 ID");
          const memory = !!(S.presets[preset]?.ok && /** @type {any} */ (S.presets[preset]).memory);
          await setGui((g) => ({ ...gs.addMine(g, pid), ...(memory ? gs.setCurrent(g, preset, pid) : {}) }));
          follow(pid);
          setRoute({ proc: pid, proj: null });
          return pid;
        })(),
      ),
    fork: (id, before, preset) =>
      loud(
        (async () => {
          const r = await api.tauCommand({ op: "fork", process: id, ...(before !== undefined ? { before } : {}), ...(preset !== undefined ? { preset } : {}) });
          const pid = r.process ?? "";
          if (!pid) throw new Error("服务没有回进程 ID");
          const src = byId[id];
          // 换了预设，新进程属于新预设：带记忆的，它成为新预设的当前进程。
          const dest = preset ?? src?.preset;
          const team = preset === undefined ? src?.kind === "team" : !!(S.presets[preset]?.ok && /** @type {any} */ (S.presets[preset]).memory);
          await setGui((g) => ({ ...gs.addFork(g, pid, id), ...(dest && team ? gs.setCurrent(g, dest, pid) : {}) }));
          follow(pid);
          setRoute({ proc: pid, proj: null });
          return pid;
        })(),
      ),
    stop: (id) => loud(api.tauCommand({ op: "stop", process: id }).then(() => {})),
    stopAll: (proj) =>
      loud(
        (async () => {
          for (let round = 0; round < 12; round++) {
            // 每一轮都按项目路径重新算成员：停的过程中新冒出来的子进程也要停。
            const ents = buildEntries(S.store.procs, S.gui, S.snaps).entries.filter((e) => e.workdir !== null && gs.pathKey(e.workdir) === proj.key);
            const order = stopOrder(ents);
            if (order.length === 0) return;
            for (const id of order) {
              if (!S.store.procs[id]) continue;
              await api.tauCommand({ op: "stop", process: id });
            }
            await new Promise((r) => setTimeout(r, 400));
          }
        })(),
      ),
    remove: async (id) => {
      await api.tauCommand({ op: "remove", process: id });
    },
    sweep: () => loud(api.tauAll({ op: "sweep" }).then((rs) => rs.find((r) => r.type === "swept")?.blobs ?? 0)),
    setGui,
    git: (w, what, file) => loud(api.git(w, what, file)),
    bg: (ids) => loud(api.bg(ids)),
    reloadPresets,
    createPreset: (p) =>
      loud(
        api.createPreset(p).then(async () => {
          await reloadPresets();
          // 建的时候不查；建好以后读一遍，起不来就当场说原因。
          const made = S.presets[String(p["id"])];
          if (made && !made.ok) toast(`预设建好了，但现在起不来：${made.error}`);
        }),
      ),
    updatePreset: async (p) => {
      const info = await api.updatePreset(p);
      await reloadPresets();
      return info;
    },
    reloadModels,
    rememberModel: (ref) => setGui((g) => ({ recentModels: pushRecent(g.recentModels, ref) })),
    deletePreset: async (id) => {
      await api.deletePreset(id);
      await reloadPresets();
    },
    pickFolder: () => loud(api.pickFolder()),
    blob: api.blobUrl,
    openDialog,
    closeDialog: () => {
      S.dialog = null;
      writeHash();
      schedule();
    },
    setTab: (n) => {
      S.tab = Math.max(0, Math.min(2, n));
      schedule();
    },
    setFilter: (f) => {
      S.filter = f;
      schedule();
    },
    setQuery: (q) => {
      S.query = q;
      schedule();
    },
    pin: (p) => setGui((g) => gs.pinFolder(g, p)),
    unpin: (p) => setGui((g) => gs.unpinFolder(g, p)),
    movePinned: (p, d) => setGui((g) => gs.movePinned(g, p, d)),
    reorderPinned: (from, to) => {
      return setGui((g) => {
        const a = g.pinned.findIndex((x) => gs.pathKey(x) === gs.pathKey(from));
        const b = g.pinned.findIndex((x) => gs.pathKey(x) === gs.pathKey(to));
        if (a < 0 || b < 0 || a === b) return {};
        const next = g.pinned.slice();
        const [it] = next.splice(a, 1);
        if (it !== undefined) next.splice(b, 0, it);
        return { pinned: next };
      });
    },
    makeCurrent: (preset, pid) => setGui((g) => gs.setCurrent(g, preset, pid)),
    toast,
  };
  return { app, entries };
}

/* 弹窗的锚点：约定的按钮。 */
const ANCHORS = { chief: "btn-chief", newproc: "btn-newproc", openproj: "btn-open", projects: "btn-all", clean: "btn-clean", settings: "btn-settings" };
/** 写进地址栏 hash 的弹窗。别的弹窗要靠打开时传的东西，刷新以后还原不了。 */
const HASH_DIALOGS = ["chief", "newproc", "newpreset", "openproj", "projects", "clean", "settings", "memory", "tools"];

/** @param {string} name @param {Element | null} [anchor] @param {any} [props] */
function openDialog(name, anchor, props) {
  const el = anchor ?? document.getElementById(/** @type {any} */ (ANCHORS)[name] ?? "") ?? null;
  const r = el ? el.getBoundingClientRect() : null;
  if (name === "newproc" || name === "openproj" || name === "newpreset" || name === "editpreset") reloadPresets();
  // 这几个弹窗显示 key 状态：打开时重读，pi 里改了就是新的。
  if (["openproj", "newpreset", "editpreset", "switchmodel", "settings"].includes(name)) reloadModels();
  S.dialog = { name, rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null, props: props ?? null };
  writeHash();
  schedule();
}

async function reloadModels() {
  try {
    const r = await api.models();
    S.models = { providers: r.providers ?? [], auth: r.auth ?? { ok: true } };
    S.modelsError = null;
  } catch (e) {
    S.modelsError = e instanceof Error ? e.message : String(e);
  }
  schedule();
}

async function reloadPresets() {
  try {
    const list = await api.presets();
    S.presetList = list;
    S.presets = Object.fromEntries(list.map((p) => [p.id, p]));
    S.presetsReady = true;
    schedule();
  } catch (e) {
    toast(`读不到预设：${e instanceof Error ? e.message : e}`);
  }
}

/* ------------------------------------------------------------------ 键盘 */

let lastStopKey = 0;
/** 地址栏里带着的弹窗：等数据读到、按钮就位以后再开。 @type {string | null} */
let pendingDlg = null;
/** 地址栏里带着的记忆页的 ns。 @type {string | null} */
let pendingNs = null;

/** @param {KeyboardEvent} e @param {App} app */
function onKey(e, app) {
  const t = /** @type {HTMLElement | null} */ (e.target);
  const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  if (app.dialog || confirmOpen()) return; // 弹窗自己处理 Esc 和 Tab。
  if (e.key === "Escape") {
    if (typing) /** @type {HTMLElement} */ (t).blur();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[0-9]$/.test(e.key)) {
    e.preventDefault();
    if (e.key === "0") return app.openDialog("projects");
    const p = app.rail.pinned[Number(e.key) - 1];
    if (p) app.focusProject(p.key);
    return;
  }
  if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && app.project && app.project.pinnedIndex >= 0) {
    e.preventDefault();
    app.movePinned(app.project.path, e.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (e.altKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && app.view) {
    e.preventDefault();
    const ids = railIds(app.view, app.gui, app.query);
    const i = app.focusedId ? ids.indexOf(app.focusedId) : -1;
    const n = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)))];
    if (n) app.focusProcess(n);
    return;
  }
  if (e.ctrlKey && !e.altKey && /^[1-3]$/.test(e.key)) {
    e.preventDefault();
    app.setTab(Number(e.key) - 1);
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    app.openDialog("newproc");
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key === ",") {
    e.preventDefault();
    app.openDialog("settings");
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    app.openDialog("chief");
    return;
  }
  if (e.ctrlKey && e.key === "." && app.focused) {
    e.preventDefault();
    const now = Date.now();
    if (now - lastStopKey < 700) {
      lastStopKey = 0;
      if (app.focused.status === "running") app.stop(app.focused.id);
    } else {
      lastStopKey = now;
      app.toast("再按一次 Ctrl+. 停止这一轮");
    }
    return;
  }
  if (e.key === "/" && !typing && !e.ctrlKey && !e.altKey) {
    const el = document.getElementById("compose-input");
    if (el) {
      e.preventDefault();
      el.focus();
    }
  }
}

/* ------------------------------------------------------------------ 根组件 */

function Root() {
  const [, setN] = useState(0);
  bump = () => setN((n) => n + 1);

  useEffect(() => {
    const tick = setInterval(() => {
      S.now = Date.now();
      schedule();
    }, 1000);
    const h = parseHash();
    S.route = { proc: h.proc, proj: h.proj };
    if (h.proc) follow(h.proc);
    api.getState().then(
      (s) => {
        S.gui = gs.normalizeState(s);
        S.guiReady = true;
        schedule();
      },
      (e) => toast(`读不到界面数据：${e instanceof Error ? e.message : e}`),
    );
    reloadPresets();
    reloadModels();
    const conn = createConn({
      reply: onReply,
      status: (s, msg) => {
        if (s !== "online") S.psFresh = false;
        // 预设经服务的 check 读：服务不在时读不到，连上了再读。
        if (s === "online" && !S.presetsReady) reloadPresets();
        S.status = s;
        S.statusMsg = msg ?? "";
        schedule();
      },
    });
    const onHash = () => {
      const x = parseHash();
      S.route = { proc: x.proc, proj: x.proj };
      if (x.proc) follow(x.proc);
      schedule();
    };
    const onFocus = () => {
      reloadPresets();
      refreshGui();
    };
    const onVis = () => {
      if (!document.hidden) refreshGui();
    };
    const resync = setInterval(refreshGui, 30000);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    pendingDlg = h.dlg;
    pendingNs = h.ns;
    return () => {
      clearInterval(tick);
      clearInterval(resync);
      document.removeEventListener("visibilitychange", onVis);
      conn.stop();
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const { app, entries } = compute();
  LAST = app;

  // 已经删掉的进程，清掉界面数据里它们的键，文件才不会越长越大。
  useEffect(() => {
    if (!app.ready || !S.gotPs || Date.now() < S.guiFailUntil) return;
    const live = S.store.procs;
    const first = S.firstPrune;
    const stale = (/** @type {string} */ id) => !live[id] && (first || S.ever.has(id));
    S.firstPrune = false;
    if (Object.keys(gs.prunePatch(S.gui, stale)).length > 0) setGui((g) => gs.prunePatch(g, stale));
  });
  // 临时进程的标题：没缓存的去读第 1 段。
  useEffect(() => {
    if (!app.ready) return;
    for (const e of entries) if (e.kind === "temp" && S.gui.titles[e.id] === undefined) peeker.wantTitle(e.id);
  });
  // 人建的根进程：第一封信到了，让桥起一个标题。每个进程只试一次。
  useEffect(() => {
    if (!app.ready || app.status !== "online") return;
    for (const e of entries) if (wantsAutoTitle(e, S.gui)) autoTitle(app, e);
  });
  // 聚焦的进程要读全。
  useEffect(() => {
    if (app.focusedId && app.store.procs[app.focusedId]) follow(app.focusedId);
  }, [app.focusedId, !!(app.focusedId && app.store.procs[app.focusedId])]);
  useEffect(() => {
    if (pendingDlg && app.ready && app.status === "online") {
      const name = pendingDlg;
      const ns = pendingNs;
      pendingDlg = null;
      pendingNs = null;
      // 记忆页没有 ns 就开不了，当没有这个弹窗。
      if (name === "memory") {
        if (ns) setTimeout(() => openDialog(name, undefined, { ns }), 60);
      } else setTimeout(() => openDialog(name), 60);
    }
  });
  // 键盘。
  useEffect(() => {
    const f = (/** @type {KeyboardEvent} */ e) => onKey(e, /** @type {App} */ (LAST));
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  const d = app.dialog;
  const close = app.closeDialog;
  const main =
    app.focusKind === "process" ? html`<${ProcessView} key=${app.focusedId} app=${app} />` : app.focusKind === "project" ? html`<${ProjectView} app=${app} />` : html`<${Empty} app=${app} />`;

  return html`<div class="shell">
    <${Rail} app=${app} />
    <div class="shell-body">
      <${ProcList} app=${app} />
      <main class="main" aria-label="主区">${main}</main>
      <${Inspector} app=${app} />
    </div>
    ${d && d.name === "chief" && html`<${ChiefDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "newproc" && html`<${NewProcDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "newpreset" && html`<${NewPresetDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "openproj" && html`<${OpenProjDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "projects" && html`<${ProjectsDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "clean" && html`<${CleanDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "settings" && html`<${SettingsDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "tools" && html`<${ToolsDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "editpreset" && html`<${EditPresetDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "switchmodel" && html`<${SwitchModelDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "memory" && html`<${MemoryDialog} app=${app} onClose=${close} />`}
    ${d && d.name === "diff" && html`<${DiffDialog} app=${app} onClose=${close} />`}
    <${ConfirmLayer} app=${app} />
    <${TipLayer} />
    <${Notifier} app=${app} />
    <${MenuLayer} />
    <${ServiceBanner} app=${app} />
    ${app.status !== "online" && html`<div class="conn" role="status">${app.status === "connecting" ? "正在连接 tau 服务…" : html`和 tau 服务断开了：${S.statusMsg}。正在重连 <${StartServiceButton} app=${app} />`}</div>`}
    ${S.toastMsg && html`<div class="toast" role="status" key=${S.toastMsg.id}>${S.toastMsg.text}</div>`}
  </div>`;
}

/** 还没有任何项目。 @param {{ app: App }} p */
function Empty({ app }) {
  if (!app.ready) return html`<div class="pending" aria-busy="true"></div>`;
  return html`<div class="empty">
    <span class="num" style="font-size:96px;color:#111211;opacity:.18">00</span>
    <h2>还没有项目</h2>
    <p>项目就是一个文件夹。打开一个文件夹，把它的进程归到一起。</p>
    <${Pill} kind="dark" icon="plus" label="打开项目" onClick=${(/** @type {Event} */ e) => app.openDialog("openproj", /** @type {Element} */ (e.currentTarget))} />
  </div>`;
}

render(html`<${Root} />`, /** @type {HTMLElement} */ (document.getElementById("app")));
