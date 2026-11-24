// 总管弹窗：待你看、和总管的对话、写信框。总管是全局助手的进程，哪个预设由界面数据的 `chief` 记。
import { html, Popover, Pill, Icon, Lamp, Fragment, useState, useRef, useEffect, useLayoutEffect } from "./common.js";
import * as api from "../api.js";
import * as gs from "../lib/state.js";
import { itemsOf, clipText, canHandoff } from "../lib/messages.js";
import { attention, refusesImages } from "../lib/derive.js";
import { findModel } from "../lib/models.js";
import { useAttach, AttachBar, Thumbs } from "./attach.js";
import { Typer, claim, pending, slotKey } from "./typer.js";
import { Markdown, CopyReply } from "./mdview.js";
import { Follower } from "./follow.js";
import { askRemove } from "./remove.js";

/** 草稿记着，关掉再开还在。 */
let draft = "";
/** 草稿里的图片。 @type {import("./attach.js").Pic[]} */
let draftImages = [];
/** 点了“稍后”的条目，这次打开页面期间不再显示。 @type {Set<string>} */
const later = new Set();
/** 对话里最多先显示几条，更早的点开看。 */
const SHOW = 30;
/** 待你看最多先显示几件。 */
const FOR_YOU = 2;

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function ChiefDialog({ app, onClose }) {
  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="总管" width=${560} align="bottom" est=${860} class="chief">
    ${(/** @type {() => void} */ close) => html`<${Body} app=${app} close=${close} />`}
  </${Popover}>`;
}

/** 条目的显示名：临时进程用标题，常驻的用预设显示名。 @param {import("../app.js").App} app @param {import("../lib/derive.js").Entry} e */
function nameOf(app, e) {
  return e.kind === "temp" ? app.titleOf(e.id).title : e.name;
}

/**
 * 分支还没合并的工作目录：去问桥。只问有“做完了”的进程的目录。
 * @param {import("../app.js").App} app
 * @returns {Record<string, string[]>}
 */
function useUnmerged(app) {
  const dirs = [
    ...new Set(
      app.entries
        .filter((e) => e.kind !== "chief" && e.status === "idle" && e.self.phase.tag === "idle" && e.self.phase.ended === "done" && e.workdir !== null)
        .map((e) => /** @type {string} */ (e.workdir)),
    ),
  ].slice(0, 12);
  const sig = dirs.join("\n");
  const [map, setMap] = useState(/** @type {Record<string, string[]>} */ ({}));
  useEffect(() => {
    let alive = true;
    for (const dir of dirs) {
      api.git(dir, "branches").then(
        (r) => {
          /** @type {any[]} */
          const list = Array.isArray(r?.branches) ? r.branches : [];
          const names = list.filter((b) => !b.merged && b.ahead > 0 && b.name !== r.main).map((b) => String(b.name));
          if (alive) setMap((m) => ({ ...m, [dir]: names }));
        },
        () => {
          // 不是仓库或读不到：当没有分支。
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [sig]);
  return map;
}

/** 顶上的“待你看”。 @param {{ app: import("../app.js").App, close: () => void }} p */
function ForYou({ app, close }) {
  const unmerged = useUnmerged(app);
  const [, again] = useState(0);
  const [all, setAll] = useState(false);
  const list = attention(app.entries, { unmerged, lastAt: app.lastAt, clientNow: app.now }).filter((a) => !later.has(`${a.kind}:${a.id}`));
  const shown = all ? list : list.slice(0, FOR_YOU);
  /** @param {string} id @param {number} tab */
  const go = (id, tab) => {
    app.focusProcess(id);
    app.setTab(tab);
    close();
  };
  return html`<div class="ch-for">
    <h3 class="ch-sec"><span>待你看</span><span class="label dim">FOR YOU</span><span class="sep" aria-hidden="true"></span><span class="mono dim" style="font-weight:400;font-size:11px">${String(list.length).padStart(2, "0")}</span></h3>
    ${list.length === 0
      ? html`<p class="ch-none"><${Icon} name="check" size=${14} sw=${3} color="var(--acc-t)" />没有要你看的。出错的进程和做完了还没合并的分支会出现在这里。</p>`
      : html`<ul class="ch-list">
          ${shown.map((a) => {
            const e = app.entryOf(a.id);
            const err = a.kind === "error";
            const proj = e && e.workdir ? app.projectOf(e.workdir) : null;
            return html`<li key=${`${a.kind}:${a.id}`} class="ch-item">
              <span class=${`ch-kind ${err ? "w" : ""}`}>${err ? "出错" : "合并"}</span>
              <div class="ch-item-b">
                <p>${proj ? html`<span class="dim ch-gap">${proj.name}</span>` : null}<b class="ch-gap">${e ? nameOf(app, e) : a.preset}</b><span class="mono dim ch-gap">${a.id}</span>
                  ${err ? ` 这一轮出错${a.detail ? "：" + clipText(a.detail, 60) : ""}。` : ` 做完了。分支 ${a.detail} 还没合并。`}</p>
                <div class="ch-acts">
                  <${Pill} size="sm" kind=${err ? "" : "accent"} label=${err ? "去看看" : "看改动"} onClick=${() => go(a.id, err ? 0 : 1)} />
                  ${!err && html`<${Pill} size="sm" label="稍后" onClick=${() => { later.add(`${a.kind}:${a.id}`); again((n) => n + 1); }} />`}
                </div>
              </div>
            </li>`;
          })}
        </ul>
        ${list.length > FOR_YOU && html`<button type="button" class="link" style="align-self:flex-start" aria-expanded=${all} onClick=${() => setAll(!all)}>${all ? "收起" : `还有 ${list.length - FOR_YOU} 件`}<${Icon} name=${all ? "up" : "down"} size=${12} sw=${2.8} /></button>`}`}
  </div>`;
}

/** 信里开头的“在看 …”拆出来。 @param {string} text */
function splitTarget(text) {
  const m = /^在看 ([^\n]+)\n/.exec(text);
  return m ? { target: /** @type {string} */ (m[1]), body: text.slice(m[0].length) } : { target: null, body: text };
}

/** 一封信：你写的、后台任务寄来的，或别的进程寄来的。 @param {{ letter: any }} p */
function Letter({ letter }) {
  if (letter.from === "bg") return html`<div class="ch-me"><div class="ch-who"><span>后台任务</span><span class="ch-chip mono">${letter.name}</span></div><p>${letter.text}</p></div>`;
  if (letter.from === "user") {
    const { target, body } = splitTarget(letter.text);
    return html`<div class="ch-me"><div class="ch-who"><span>你</span>${target && html`<span class="ch-chip mono">在看 ${target}</span>`}</div><p>${body}</p></div>`;
  }
  const who = letter.from === "process" ? `来信 · ${letter.preset}` : `回信 · ${letter.endedText}`;
  return html`<div class="ch-me"><div class="ch-who"><span>${who}</span><span class="ch-chip mono">${letter.id}</span></div><p>${letter.text}</p></div>`;
}

/**
 * 总管说的话和它调的工具。`slot` 是记录键（typer.js 的 slotKey）：live 的行用它记正在吐的字；
 * 消息行用它接手刚写完、还没吐完的字；`held` 是写完了、历史还没读到的那段字。旧的直接显示。
 * @param {{ text: string, calls: any[], error?: string | null, live?: boolean, slot?: string, held?: boolean, wait?: boolean }} p
 */
function Said({ text, calls, error, live = false, slot = "", held = false, wait }) {
  const [claimed] = useState(() => (!live && slot !== "" ? claim(slot, text) : null));
  const typed = live || (claimed !== null && text.trim() !== "");
  // 吐字期间是纯文字；追平以后（或本来就是历史）换成 Markdown，规则和消息流一样（messages.js 的 AssistantRow）。
  const [caught, setCaught] = useState(false);
  const md = text.trim() !== "" && !live && (!typed || caught);
  return html`<div class="ch-bot">
    <div class="ch-bot-l"><span class="ch-dia" aria-hidden="true"></span>总管</div>
    ${md ? html`<div class="reply"><${Markdown} text=${text} /><${CopyReply} text=${text} /></div>` : typed ? html`<${Typer} text=${text} live=${live} slot=${slot} claimed=${claimed} final=${!live && !held} cls="" cur="y" onCaught=${() => setCaught(true)} />` : null}
    ${wait && html`<p class="dim"><span class="pulse">正在想…</span></p>`}
    ${error && html`<p><span class="tag warn">模型出错</span> <span class="mono" style="font-size:12px">${error}</span></p>`}
    ${calls.length > 0 && html`<ul class="ch-calls">${calls.map((c) => html`<li class=${c.status === "error" || c.status === "interrupted" ? "w" : ""}><b>${String(c.name).toUpperCase()}</b><span class="ell">${c.summary || c.name}</span>${c.status === "pending" ? html`<span class="pulse" style="width:7px;height:7px;background:var(--acc);flex:none"></span>` : null}</li>`)}</ul>`}
  </div>`;
}

/** 弹窗里的对话：总管当前段的消息。 @param {{ app: import("../app.js").App, e: import("../lib/derive.js").Entry }} p */
function Log({ app, e }) {
  const scrollEl = useRef(/** @type {HTMLElement | null} */ (null));
  const flowEl = useRef(/** @type {HTMLElement | null} */ (null));
  const [more, setMore] = useState(false);
  const msgs = app.messages(e.id);
  const items = itemsOf(msgs).filter((it) => it.kind !== "fold" && it.kind !== "orphanResult");
  const shown = more ? items : items.slice(-SHOW);
  const phase = e.self.phase.tag;
  const live = phase === "awaitingModel" ? app.streamText(e.id) : "";
  // 正在写的字将来是当前段第 e.self.messages 条消息；写完了、历史还没读到那条的，先留住（typer.js）。
  const seg = e.self.segment;
  const liveSeq = phase === "awaitingModel" ? e.self.messages : -1;
  const holds = msgs.length < e.self.messages ? pending(e.id, seg, msgs.length, liveSeq) : [];
  // 贴底跟随：弹窗里没有“有新消息”的提示，往上翻着读时只是不拽。
  useLayoutEffect(() => {
    const n = scrollEl.current;
    const c = flowEl.current;
    if (!n || !c) return;
    const f = new Follower(n, c, () => {});
    f.snap();
    return () => f.destroy();
  }, []);

  return html`<div class="ch-log" ref=${scrollEl} tabindex="0"><div class="ch-flow" ref=${flowEl}>
    ${items.length > shown.length && html`<button type="button" class="link" style="align-self:flex-start" onClick=${() => setMore(true)}>更早的 ${items.length - shown.length} 条<${Icon} name="up" size=${12} sw=${2.8} /></button>`}
    ${msgs.length === 0 && html`<p class="dnote">${phase === "idle" && e.status !== "fresh" ? "这一段还没有消息。" : "正在读取对话…"}</p>`}
    ${shown.map((it) => {
      if (it.kind === "user") return html`<${Fragment} key=${`u${it.seq}`}>${it.letters.map((l) => html`<${Letter} letter=${l} />`)}</${Fragment}>`;
      if (it.kind === "handoff") return html`<p key=${`h${it.seq}`} class="ch-hand mono">这一段从上一段的交接说明开始</p>`;
      if (it.kind === "assistant") {
        if (it.text.trim() === "" && it.calls.length === 0 && !it.errorMessage) return null;
        return html`<${Said} key=${`a${e.id}:${seg}:${it.seq}`} text=${it.text} calls=${it.calls} error=${it.errorMessage} slot=${slotKey(e.id, seg, it.seq)} />`;
      }
      return null;
    })}
    ${holds.map((r) => html`<${Said} key=${`held${r.key}`} text=${r.text} calls=${[]} slot=${r.key} held=${true} />`)}
    ${phase === "awaitingModel" && html`<${Said} key=${`live${slotKey(e.id, seg, liveSeq)}`} text=${live} calls=${[]} live=${true} slot=${slotKey(e.id, seg, liveSeq)} wait=${live === ""} />`}
  </div></div>`;
}

/** 没选总管预设时，从预设里选一个。 @param {{ app: import("../app.js").App, onDone?: () => void }} p */
function Picker({ app, onDone }) {
  const list = app.presetList.filter((p) => p.ok);
  const [pick, setPick] = useState(/** @type {string | null} */ (app.gui.chief ?? null));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      await app.setGui({ chief: pick });
      onDone?.();
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="ch-pick">
    <h3 class="ch-sec"><span>选总管</span><span class="label dim">CHIEF PRESET</span><span class="sep" aria-hidden="true"></span></h3>
    <p class="dnote">总管是全局助手的进程，用哪个预设由你定。选带记忆的预设，它才记得住你们聊过的事。选好以后记在界面数据里，随时能换。</p>
    ${list.length === 0 && html`<div class="callout">还没有预设。先新建一个预设，再回来选。</div>`}
    <div class="pgrid">
      ${list.map((p) => {
        if (!p.ok) return null;
        const on = pick === p.id;
        return html`<button type="button" key=${p.id} class=${`pcard ${p.memory ? "" : "temp"}`} aria-pressed=${on} onClick=${() => setPick(p.id)}>
          <span class="nm"><b>${app.gui.names[p.id] ?? p.id}</b>${app.gui.names[p.id] && html`<span class="mono">${p.id}</span>`}</span>
          <span class="tags"><span class="tag line">${p.memory ? "带记忆" : "不带记忆"}</span></span>
          <span class="cnt ell" style="max-width:100%">${p.workdir}</span>
        </button>`;
      })}
    </div>
    <div class="ch-acts">
      <${Pill} kind="accent" label="设为总管" disabled=${!pick || busy} onClick=${save} />
      ${list.length === 0 && html`<${Pill} label="新建预设" onClick=${(/** @type {Event} */ ev) => app.openDialog("openproj", /** @type {Element} */ (ev.currentTarget))} />`}
      ${onDone && html`<${Pill} label="取消" onClick=${onDone} />`}
    </div>
  </div>`;
}

/** 写信框：开头加一句“在看 …”。 @param {{ app: import("../app.js").App, chiefId: string, e: import("../lib/derive.js").Entry | null, target: { text: string, label: string, name: string } | null }} p */
function ComposeBox({ app, chiefId, e, target }) {
  const [text, setText] = useState(draft);
  const [withTarget, setWithTarget] = useState(true);
  const [images, setImages] = useState(draftImages);
  const at = useAttach(images, setImages);
  const [busy, setBusy] = useState(false);
  const area = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  useEffect(() => {
    draft = text;
    draftImages = images;
  }, [text, images]);
  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.height = "auto";
    a.style.height = Math.min(a.scrollHeight, 150) + "px";
  }, [text]);
  const can = (text.trim() !== "" || images.length > 0) && !busy && at.busy === 0;
  const imgs = images.map((i) => i.data);
  const model = chiefId ? app.presets[chiefId] : undefined;
  const noImage = e ? refusesImages(e.frozen) : model && model.ok ? findModel(app.models?.providers, model.model)?.model.image === false : false;

  const send = async () => {
    if (!can) return;
    setBusy(true);
    try {
      const body = target && withTarget ? `在看 ${target.text}\n${text}` : text;
      if (e) {
        await app.send(e.id, body, imgs);
        if (app.gui.current[chiefId] !== e.id) await app.makeCurrent(chiefId, e.id);
      } else {
        // 还没有总管的进程：这一封信就是它的第一封信。不走 app.start，免得把主区切到总管上。
        try {
          const r = await api.tauCommand({ op: "start", preset: chiefId, text: body, ...(imgs.length ? { images: imgs } : {}) });
          const pid = r.process ?? "";
          if (!pid) throw new Error("服务没有回进程 ID");
          await app.setGui((g) => ({ ...gs.addMine(g, pid), ...gs.setCurrent(g, chiefId, pid) }));
          app.follow(pid);
        } catch (err) {
          app.toast(err instanceof Error ? err.message : String(err));
          throw err;
        }
      }
      setText("");
      setImages([]);
      draft = "";
      draftImages = [];
    } catch {
      // 提示已经弹了，草稿留着。
    } finally {
      setBusy(false);
    }
  };

  return html`<form class=${`ch-form ${at.over ? "over" : ""}`} ...${at.drop} onSubmit=${(/** @type {Event} */ ev) => { ev.preventDefault(); send(); }}>
    <div class="ch-tgt">
      ${target
        ? html`<span>当前在看</span>
            <button type="button" class=${`ch-chip on mono ${withTarget ? "" : "off"}`} aria-pressed=${withTarget} title=${withTarget ? "点一下，这封信不带上它" : "点一下，这封信带上它"} onClick=${() => setWithTarget(!withTarget)}>${target.label}</button>
            ${target.name && withTarget && html`<span class="dim ell">${target.name}</span>`}
            <span>${withTarget ? "，你说的话会带上它" : "，这封信不带它"}</span>`
        : html`<span>现在没有在看的对象，信里不加“在看”。</span>`}
    </div>
    <${Thumbs} images=${images} class="ch-thumbs" onRemove=${(/** @type {number} */ i) => setImages(images.filter((_, j) => j !== i))} />
    <div class="ch-row">
      <label for="chief-input" class="sr">对总管说</label>
      <textarea id="chief-input" ref=${area} rows="1" autofocus class="ch-in" value=${text} placeholder=${e ? "对总管说…（Enter 寄出，Ctrl+Enter 换行）" : "对总管说第一句话…（Enter 寄出，Ctrl+Enter 换行）"}
        onInput=${(/** @type {any} */ ev) => setText(ev.currentTarget.value)} onPaste=${at.onPaste}
        onKeyDown=${(/** @type {KeyboardEvent} */ ev) => letterKey(ev, send, setText)}></textarea>
      <button type="submit" class="ch-go" aria-label=${busy ? "寄出中" : "寄出"} title="Enter" disabled=${!can}><${Icon} name="arrow" size=${20} sw=${2.8} /></button>
    </div>
    <${AttachBar} at=${at} count=${images.length} noImage=${!!noImage} />
  </form>`;
}

/** @param {{ app: import("../app.js").App, close: () => void }} p */
function Body({ app, close }) {
  const chiefId = app.gui.chief;
  const e = app.chiefEntry;
  const preset = chiefId ? app.presets[chiefId] : undefined;
  const [choosing, setChoosing] = useState(false);

  // Ctrl+K 再按一次关上。
  useEffect(() => {
    const f = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [close]);
  // 总管的对话要读全、保持更新。
  useEffect(() => {
    if (e) app.follow(e.id);
  }, [e?.id]);

  const running = app.entries.filter((x) => x.kind !== "chief" && x.status === "running").length;
  const fe = app.focused;
  /** @type {{ text: string, label: string, name: string } | null} */
  let target = null;
  if (fe && fe.kind !== "chief") target = { text: fe.id, label: fe.id, name: nameOf(app, fe) };
  else if (!fe && app.project) target = { text: app.project.path, label: `项目 ${app.project.name}`, name: "" };

  const d = e ? app.describe(e) : null;
  const ended = e && e.self.phase.tag === "idle" ? e.self.phase.ended : undefined;
  const bad = !!chiefId && !e && !(preset && preset.ok);

  return html`<div class="ch-body">
    <div class="ch-stripe" aria-hidden="true"></div>
    <div class="ch-head">
      <span class="ch-hico" aria-hidden="true"><span></span></span>
      <div class="ch-title">
        <h2>总管</h2>
        <div><span class="label acc-fg">CHIEF</span><span class="dlg-sub">管着 ${app.projects.length} 个项目，${running} 个进程在跑</span></div>
      </div>
      <button type="button" class="closer" aria-label="关闭总管" onClick=${close}><span class="mono">Esc</span><${Icon} name="close" size=${13} sw=${2.8} /></button>
    </div>
    <${ForYou} app=${app} close=${close} />
    ${!app.ready
      ? html`<div class="ch-pick"><p class="dnote" aria-busy="true">正在读取…</p></div>`
      : !chiefId || choosing || bad
        ? html`<${Picker} app=${app} onDone=${chiefId && !bad ? () => setChoosing(false) : undefined} />${bad && html`<div class="ch-pick"><div class="callout">预设 ${chiefId} 读不到或读不懂，换一个。</div></div>`}`
        : html`<div class="ch-logwrap">
              <h3 class="ch-sec"><span>对话</span><span class="label dim">LOG</span><span class="sep" aria-hidden="true"></span>
                ${e && d && html`<span class="ch-state"><${Lamp} phase=${e.self.phase.tag} /><span>${d.label}</span></span>`}
                <span class="mono dim" style="font-weight:400;font-size:11px">${chiefId}</span>
                ${e && html`<button type="button" class="link dim" disabled=${e.status === "running" || !canHandoff(app.messages(e.id))} title=${e.status === "running" ? "总管在跑时不能换段" : !canHandoff(app.messages(e.id)) ? "这一段里还没有总管的回复，没有可交接的内容" : "寄一封换段信：下一轮只带交接说明"} onClick=${() => app.handoff(e.id)}>换段</button>`}
                <button type="button" class="link dim" onClick=${() => setChoosing(true)}>换预设</button>
                ${e && html`<button type="button" class="link dim" title="删掉这个会话和它的全部段，下一句话就是新会话的第一句" onClick=${(/** @type {Event} */ ev) => askRemove(e.id, /** @type {Element} */ (ev.currentTarget))}>删除</button>`}</h3>
              ${e && e.status === "error" && html`<div class="callout ch-err">总管上一轮出错${ended && typeof ended === "object" ? "：" + clipText(ended.error, 120) : ""}。再给它写一封信，它会接着做。</div>`}
              ${e
                ? html`<${Log} app=${app} e=${e} />`
                : html`<div class="ch-log"><p class="dnote">还没有和总管说过话。写下第一句，它就会开始工作，替你管着各个项目。</p></div>`}
            </div>
            <${ComposeBox} app=${app} chiefId=${chiefId} e=${e} target=${target} />`}
  </div>`;
}
