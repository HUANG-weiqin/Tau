// 改这个会话（D71，设计稿 7.15）：和改预设同一张表（`presetform.js`），初值取 `inspect` 读到的会话快照，不读预设文件。
// 保存发 `reconfigure`，只发变了的字段。服务的错误原文写在检查条里，弹窗不关；出错什么都没改，所以不用回滚。
import { html, Popover, DlgHead, SecHead, Pill, useEffect, useState, Fragment } from "./common.js";
import * as api from "../api.js";
import { CheckStrip, PresetFields, usePresetForm } from "./presetform.js";
import { canHandoff } from "../lib/messages.js";
import { hasStructural, receiptNote, reloadFields, sessionInfo, shownErr } from "../lib/session.js";

/** 一次 `inspect` 读到的东西：还在读、读到了、或读不到的原因。 @typedef {{ pid: string, info: import("../lib/session.js").SessionInfo | null, error: string | null }} Loaded */

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function SessionDialog({ app, onClose }) {
  const pid = /** @type {string} */ (app.dialog?.props?.process ?? "");
  const [loaded, setLoaded] = useState(/** @type {Loaded | null} */ (null));
  useEffect(() => {
    let alive = true;
    api.inspect(pid).then(
      (line) => {
        if (!alive) return;
        app.noteInspect([line]);
        const info = sessionInfo(line);
        setLoaded({ pid, info, error: info ? null : "读到的快照缺字段，没法改" });
      },
      (e) => alive && setLoaded({ pid, info: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [pid]);
  const ready = loaded !== null && loaded.pid === pid ? loaded : null;
  const e = app.byId[pid];
  const shown = e ? (app.gui.names[e.preset] ?? e.preset) : "";

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="改这个会话" width=${660} est=${760} class="editpreset session">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="tau" title="改这个会话" en="EDIT SESSION" sub=${e ? (shown === e.preset ? pid : `${shown} · ${pid}`) : pid} onClose=${close} />
      ${ready === null
        ? html`<div class="dlg-body"><p class="dnote">正在读这个会话的快照…</p></div>`
        : ready.info === null
          ? html`<${Fragment}>
              <div class="dlg-body"><div class="callout">没法改这个会话：${ready.error}</div></div>
              <div class="dlg-foot"><span class="cmdline"></span><${Pill} label="关闭" onClick=${close} /></div>
            </${Fragment}>`
          : html`<${SessionBody} key=${pid} app=${app} pid=${pid} info=${ready.info} close=${close} />`}
    </${Fragment}>`}
  </${Popover}>`;
}

/**
 * 表和底部的键。表的状态只在拿到快照以后才建（初值取自快照），所以是单独的组件。
 * @param {{ app: import("../app.js").App, pid: string, info: import("../lib/session.js").SessionInfo, close: () => void }} p
 */
function SessionBody({ app, pid, info, close }) {
  const form = usePresetForm({ app, orig: info, session: true });
  const [busy, setBusy] = useState(false);
  /** 保存或重读失败时服务回的原文，连同出错时表的样子：表一动就清掉，不再占着检查条（`shownErr`）。 */
  const [err, setErr] = useState(/** @type {{ text: string, sig: string } | null} */ (null));
  /** 重读工具定义以后的一句话。 */
  const [msg, setMsg] = useState(/** @type {string | null} */ (null));
  /** 保存后马上换段。 */
  const [now, setNow] = useState(false);
  const draft = form.reconfig();
  const sig = JSON.stringify(form.draft());
  useEffect(() => {
    if (err !== null && err.sig !== sig) setErr(null);
  }, [sig, err]);
  const fields = draft.ok ? draft.fields : {};
  const changed = draft.ok && Object.keys(fields).length > 0;
  const structural = changed && hasStructural(fields);
  const e = app.byId[pid];
  const running = e?.status === "running";
  const hasReply = canHandoff(app.messages(pid));
  // 换段信要在段里已有助手消息、进程空闲时才生效（`canHandoff`）。段里还没有助手消息时，服务直接采用结构性字段，用不着换段。
  const canNow = !running && hasReply;
  const handoffNow = now && structural && canNow;

  const message = (/** @type {unknown} */ x) => (x instanceof Error ? x.message : String(x));
  const go = async () => {
    if (!draft.ok || !changed || busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    /** @type {{ pending: boolean }} */
    let r;
    try {
      r = await app.reconfigure(pid, { fields });
    } catch (x) {
      setErr({ text: message(x), sig });
      setBusy(false);
      return;
    }
    if (fields["model"] !== undefined) app.rememberModel(form.model.trim()).catch(() => {});
    if (handoffNow) {
      try {
        await app.handoff(pid);
      } catch (x) {
        setErr({ text: `配置已经改了，换段信没发出去：${message(x)}`, sig });
        setBusy(false);
        return;
      }
    }
    app.toast(!structural ? "已改，下一次调用生效" : handoffNow ? "已改，换段信已寄出" : r.pending ? "已改，换段时生效" : "已改。没有待换的配置了：已直接生效，或者和现在的一样");
    close();
  };

  /** 把这个会话已存的工具列表（不是表里没保存的勾选）原样发一次：服务重读工具定义文件，内容变了就成为待换配置（手动刷新）。 */
  const reloadTools = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await app.reconfigure(pid, { fields: reloadFields(info) });
      setMsg(receiptNote(r.pending));
    } catch (x) {
      setErr({ text: message(x), sig });
    }
    setBusy(false);
  };

  const errText = shownErr(err, sig);
  const strip = errText !== null ? { ok: false, text: errText } : !draft.ok ? { ok: false, text: draft.error } : { ok: true, text: msg ?? (info.pending ? "这个会话有待换配置，表里是待换的那一份。" : "按这个会话现在的快照填的。") };

  return html`<${Fragment}>
    <div class="dlg-body">
      <div class="callout"><b>只改这个会话，不改预设文件。</b>预设文件之后改了，这个会话不跟着变。进程在跑也能改。</div>
      <p class="dnote">思考强度、options、换段阈值下一次调用生效；模型、提示词、工具、工作目录、上下文文件换段时生效。${running ? "进程在跑，现在不能换段，改动先存成待换配置。" : ""}</p>
      <${SecHead} n="01" title="会话快照" en="SESSION" right=${html`<span class="dnote" style="font-size:11px">${info.pending ? "表里是待换的那一份" : "表里是现在的快照"}</span>`} />
      <${PresetFields} form=${form} app=${app} promptHint="这个会话的提示词"
        toolsExtra=${html`<div class="td-reload">
          <button type="button" class="link" disabled=${busy} title="把这个会话已存的工具列表原样发一次，服务重读工具定义文件" onClick=${reloadTools}>重读工具定义</button>
          <span class="dnote" style="font-size:11.5px">工具定义文件改了、重装了，点这里让这个会话用上新的（换段时生效）。表里没保存的工具勾选不算。</span>
        </div>`} />
      <${CheckStrip} ok=${strip.ok} text=${strip.text} label="reconfigure" />
    </div>
    <div class="dlg-foot">
      <span class="cmdline">reconfigure ${pid}，只发变了的字段</span>
      ${structural &&
      html`<span class="toggles"><button type="button" class="toggle" aria-pressed=${handoffNow} disabled=${!canNow} title=${running ? "进程在跑，不能马上换段，改动先存成待换配置" : !hasReply ? "这一段里还没有助手的回复，改动会直接生效，不用换段" : "保存以后寄一封换段信，新配置马上生效"} onClick=${() => setNow(!now)}>保存后马上换段</button></span>`}
      <${Pill} label="取消" onClick=${close} />
      <${Pill} kind="accent" icon="arrow" label=${busy ? "保存中" : changed ? "保存" : "没有改动"} disabled=${!draft.ok || !changed || busy} onClick=${go} />
    </div>
  </${Fragment}>`;
}
