// 不画任何东西的页面级副作用：标签页标题、favicon、完成通知、外观（夜间配色）。
// 两类要看的东西：`app.attention`（derive.js 的 `attention`，出错的进程）和根进程的“新结果”（lib/notify.js 的 `trackResults`）。
// 规则都在 lib/notify.js。
import { useEffect } from "preact/hooks";
import { lastReply, notifyText, shouldNotify, tabTitle, trackResults, unseenCount, watchAttention } from "../lib/notify.js";
import { applyTheme } from "../lib/theme.js";

/** 上一次看到的待你看的进程。null 表示还没看过（页面刚打开）。 @type {ReadonlySet<string> | null} */
let seen = null;
/** 点通知时用最新的 `app`。 @type {import("../app.js").App | null} */
let latest = null;
/** 根进程的新结果，只在页面内存里。 @type {import("../lib/notify.js").Results | null} */
let results = null;
let lastIcon = "";

/** 小的 tau 图标；有待你看时右上角一个黄点。 @param {boolean} dot */
function drawIcon(dot) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#0B0C0B";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#ECEDE9";
  g.font = '800 46px "Archivo Variable", "Noto Sans SC Variable", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText("τ", 32, 50);
  if (dot) {
    g.fillStyle = "#FFE600";
    g.fillRect(40, 0, 24, 24);
  }
  return c.toDataURL("image/png");
}

/** @param {boolean} dot */
function setIcon(dot) {
  const key = dot ? "dot" : "plain";
  if (key === lastIcon) return;
  const href = drawIcon(dot);
  if (href === "") return;
  lastIcon = key;
  let link = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel="icon"]'));
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/png";
  link.href = href;
}

/** @param {import("../app.js").App} app @param {string} id */
function notifyFor(app, id) {
  const e = app.byId[id];
  if (!e) return;
  const t = notifyText(e.name, app.describe(e).endedText, lastReply(app.messages(id)));
  try {
    const n = new Notification(t.title, { body: t.body, tag: id });
    n.onclick = () => {
      window.focus();
      latest?.focusProcess(id);
      n.close();
    };
  } catch {
    // 浏览器不让弹（例如没有许可）：不处理。
  }
}

/** @param {{ app: import("../app.js").App }} p */
export function Notifier({ app }) {
  latest = app;
  const ids = app.attention.map((a) => a.id);
  useEffect(() => applyTheme(app.gui.theme), [app.gui.theme]);
  useEffect(() => {
    const ready = app.ready && app.procsReady;
    const away = document.hidden || !document.hasFocus();
    const t = trackResults(results, app.entries.map((e) => ({ id: e.id, root: e.self.parent === undefined, busy: e.status === "running" })), { focusedId: app.focusedId, away, ready });
    results = t.next;
    document.title = tabTitle(unseenCount(ids, results?.results ?? new Set()));
    setIcon(unseenCount(ids, results?.results ?? new Set()) > 0);
    const r = watchAttention(seen, ids, ready);
    seen = r.next;
    const fire = [...new Set([...r.entered, ...t.ended])];
    if (fire.length === 0) return;
    const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
    if (!shouldNotify({ enabled: app.gui.notify === true, permission, away })) return;
    for (const id of fire) notifyFor(app, id);
  });
  return null;
}
