// 设置：默认模型和思考强度、供应商的 key（填、换、清）、清理的天数。
// 除了填 key 要点“保存”，改一项就记一项。界面不放 token 和费用，也不显示 key。
import { html, Popover, DlgHead, SecHead, Pill, useState, useRef, useEffect, Fragment } from "./common.js";
import { CheckStrip } from "./presetform.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { findModel, keyActions, keyLabel, sortProviders } from "../lib/models.js";
import { setKey, clearKey } from "../api.js";

const MAX_DAYS = 3650;

/** @param {unknown} e */
const reason = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 一家的 key 输入框：密码框加保存、取消。输入只留在这里，收起就丢；失败时原因写在框下面，框和输入都留着。
 * 回车保存，Esc 取消（弹窗的 Esc 先交给带 data-esc 的面板，见 common.js 的 Popover）。
 * @param {{ p: import("../lib/models.js").CatalogProvider, app: import("../app.js").App, onDone: () => void, onCancel: () => void }} q
 */
function KeyEdit({ p, app, onDone, onCancel }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const panel = useRef(/** @type {HTMLElement | null} */ (null));
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const key = draft.trim();

  useEffect(() => {
    const el = panel.current;
    /** @type {HTMLElement | null | undefined} */ (el?.querySelector("input"))?.focus();
    const onEsc = () => cancel.current();
    el?.addEventListener("esc", onEsc);
    return () => el?.removeEventListener("esc", onEsc);
  }, []);

  const save = async () => {
    if (key === "" || busy) return;
    setBusy(true);
    setErr("");
    try {
      await setKey(p.id, key);
    } catch (e) {
      setBusy(false);
      setErr(reason(e));
      return;
    }
    // 收起后这个组件已卸载，不再动它的状态。
    onDone();
    await app.reloadModels();
  };

  return html`<div class="st-sub" data-esc ref=${panel}>
    <input class="input mono" type="password" autocomplete="off" spellcheck=${false} placeholder="粘贴 key" aria-label=${`${p.name} 的 key`} value=${draft} disabled=${busy} aria-invalid=${err !== ""} onInput=${(/** @type {any} */ e) => setDraft(e.currentTarget.value)} onKeyDown=${(/** @type {KeyboardEvent} */ e) => e.key === "Enter" && (e.preventDefault(), save())} />
    <${Pill} size="sm" kind="accent" label=${busy ? "保存中" : "保存"} disabled=${busy || key === ""} aria-label=${`保存 ${p.name} 的 key`} onClick=${save} />
    <${Pill} size="sm" label="取消" disabled=${busy} aria-label=${`取消填写 ${p.name} 的 key`} onClick=${onCancel} />
    ${err !== "" && html`<div class="st-err" role="alert">没有保存：${err}</div>`}
  </div>`;
}

/**
 * 一家供应商一行：名字、模型个数、key 状态，右边是动作；展开时下面是输入框。
 * 清掉要点两次：第一次按钮变成“确定清掉？”，失焦还原。
 * @param {{ p: import("../lib/models.js").CatalogProvider, app: import("../app.js").App, authOk: boolean, editing: string | null, setEditing: (id: string | null) => void }} q
 */
function ProviderRow({ p, app, authOk, editing, setEditing }) {
  const acts = keyActions(p.key, authOk);
  const open = editing === p.id && acts !== null;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setBtn = useRef(/** @type {HTMLButtonElement | null} */ (null));

  const toggleSet = () => {
    setConfirm(false);
    setErr("");
    setEditing(open ? null : p.id);
  };
  const closeEdit = () => {
    setEditing(null);
    setBtn.current?.focus();
  };
  const clear = async () => {
    if (!confirm) {
      setErr("");
      setConfirm(true);
      return;
    }
    setBusy(true);
    try {
      await clearKey(p.id);
      await app.reloadModels();
    } catch (e) {
      setErr(reason(e));
    }
    setBusy(false);
    setConfirm(false);
  };

  return html`<li class=${`st-row ${p.key === "key" ? "" : "off"}`}>
    <span class="st-n"><b>${p.name}</b><span class="mono ell">${p.id}</span></span>
    <span class="ct mono">${p.models.length}</span>
    <span class=${`tag ${p.key === "key" ? "acc" : p.key === "none" ? "line" : "warn"}`} aria-live="polite">${keyLabel(p.key)}</span>
    ${acts && html`<span class="st-acts">
      <button type="button" class="link" ref=${setBtn} aria-expanded=${open} aria-label=${`${acts.set === "填 key" ? "填" : "换"} ${p.name} 的 key`} disabled=${busy} onClick=${toggleSet}>${acts.set}</button>
      ${acts.clear && html`<button type="button" class=${`link ${confirm ? "warn" : ""}`} aria-label=${confirm ? `确定清掉 ${p.name} 的 key？` : `清掉 ${p.name} 的 key`} disabled=${busy} onClick=${clear} onBlur=${() => !busy && setConfirm(false)}>${confirm ? "确定清掉？" : "清掉"}</button>`}
    </span>`}
    ${open && html`<${KeyEdit} p=${p} app=${app} onDone=${closeEdit} onCancel=${closeEdit} />`}
    ${err !== "" && html`<div class="st-sub"><div class="st-err" role="alert">没有清掉：${err}</div></div>`}
  </li>`;
}

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function SettingsDialog({ app, onClose }) {
  const providers = app.models?.providers ?? null;
  const model = app.gui.defaultModel ?? "";
  const thinking = app.gui.defaultThinking;
  const info = findModel(providers, model)?.model ?? null;
  const [note, setNote] = useState("");
  const [notifyNote, setNotifyNote] = useState("");
  const [daysText, setDaysText] = useState(String(app.gui.cleanDays));
  const days = Number(daysText);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;

  const quiet = (/** @type {Promise<void>} */ p) => p.catch(() => {});
  const pickModel = (/** @type {string} */ ref) => {
    const r = thinkingFor(findModel(providers, ref)?.model ?? null, thinking);
    setNote(r.note);
    quiet(app.setGui({ defaultModel: ref, defaultThinking: r.thinking ?? "" }));
  };
  const setThinking = (/** @type {string | undefined} */ v) => {
    setNote("");
    quiet(app.setGui({ defaultThinking: v ?? "" }));
  };
  const titleModel = app.gui.titleModel ?? "";
  const pickTitleModel = (/** @type {string} */ ref) => quiet(app.setGui({ titleModel: ref }));
  const changeDays = (/** @type {string} */ v) => {
    setDaysText(v);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DAYS && n !== app.gui.cleanDays) quiet(app.setGui({ cleanDays: n }));
  };

  const night = app.gui.theme === "night";

  // 开关在点击的处理函数里申请许可：浏览器只认用户操作里的申请。
  const notifyOn = app.gui.notify === true;
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const setNotify = (/** @type {boolean} */ want) => {
    if (!want) {
      setNotifyNote("");
      quiet(app.setGui({ notify: false }));
    } else if (perm === "unsupported") setNotifyNote("这个浏览器不支持通知。");
    else
      Notification.requestPermission().then((p) => {
        if (p === "granted") {
          setNotifyNote("");
          quiet(app.setGui({ notify: true }));
        } else setNotifyNote(p === "denied" ? "浏览器拒绝了通知。在地址栏左边的站点设置里改成允许，再回来打开。" : "没有选择允许，通知没有打开。");
      });
  };
  const notifyWhy = notifyNote !== "" ? notifyNote : notifyOn && perm !== "granted" ? "开关开着，但浏览器没有许可通知，所以不会弹。" : "";

  const sorted = providers ? sortProviders(providers) : [];
  const ready = sorted.filter((p) => p.key === "key").length;
  const auth = app.models?.auth;
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="设置" width=${640} est=${720} class="settings">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="sliders" title="设置" en="SETTINGS" sub="Ctrl+," onClose=${close} />
      <div class="dlg-body">
        <${SecHead} n="01" title="外观" en="APPEARANCE" />
        <div class="cl-days soft">
          <div class="toggles" role="group" aria-label="外观"><button type="button" class="toggle" aria-pressed=${!night} onClick=${() => night && quiet(app.setGui({ theme: "day" }))}>亮</button><button type="button" class="toggle" aria-pressed=${night} onClick=${() => !night && quiet(app.setGui({ theme: "night" }))}>夜</button></div>
          <span>夜：台面和黄色都调暗，适合昏暗的环境。</span>
        </div>

        <${SecHead} n="02" title="默认模型" en="DEFAULT MODEL" right=${html`<span class="dnote" style="font-size:11px">新建预设时预填</span>`} />
        <${ModelPicker} app=${app} value=${model} onPick=${pickModel} label="默认模型" />
        <${ThinkingBar} levels=${info === null ? null : info.thinking} value=${thinking} onChange=${setThinking} note=${note} />
        <div class="ep-keep">
          ${model === "" ? html`<span>没设默认模型：新建预设时预填项目里已有预设的模型，没有就是最近用过的。</span>` : html`<button type="button" class="link" onClick=${() => { setNote(""); quiet(app.setGui({ defaultModel: "", defaultThinking: "" })); }}>清掉默认</button><span>已记住，下次新建预设就是它。</span>`}
        </div>

        <${SecHead} n="03" title="供应商和 key" en="PROVIDERS" />
        ${providers === null
          ? html`<p class="dnote">${app.modelsError !== null ? `读不到模型目录：${app.modelsError}` : "正在读模型目录…"}</p>`
          : html`<${Fragment}>
              <div class="st-big"><span class=${`num ${ready > 0 ? "ok" : ""}`}>${ready}</span><span class="dnote">家配了 key，共 ${providers.length} 家</span></div>
              <ul class="st-prov" aria-label="供应商和 key 状态">
                ${sorted.map((p) => html`<${ProviderRow} key=${p.id} p=${p} app=${app} authOk=${auth?.ok !== false} editing=${editing} setEditing=${setEditing} />`)}
              </ul>
            </${Fragment}>`}
        ${auth && !auth.ok && html`<${CheckStrip} ok=${false} text=${auth.error} label="auth.json" />`}
        <p class="dnote">key 写在 pi 的 <span class="mono">~/.pi/agent/auth.json</span> 里。tau 只动 api_key 条目，OAuth 的不碰。改完不用重启。界面不显示 key。</p>

        <${SecHead} n="04" title="清理旧进程" en="CLEAN UP" />
        <div class="cl-days">
          <label for="st-days-in">空闲超过</label>
          <input id="st-days-in" class="input mono" type="number" min="1" max=${MAX_DAYS} step="1" value=${daysText} aria-invalid=${!daysOk} onInput=${(/** @type {any} */ e) => changeDays(e.currentTarget.value)} />
          <span>天的临时进程算旧的。</span>
          ${!daysOk && html`<span class="dnote" style="color:var(--warn)">天数要写 1 到 ${MAX_DAYS} 的整数。</span>`}
        </div>

        <${SecHead} n="05" title="完成通知" en="NOTIFY" />
        <div class="cl-days soft">
          <div class="toggles" role="group" aria-label="完成通知"><button type="button" class="toggle" aria-pressed=${notifyOn} onClick=${() => (!notifyOn || perm !== "granted") && setNotify(true)}>开</button><button type="button" class="toggle" aria-pressed=${!notifyOn} onClick=${() => notifyOn && setNotify(false)}>关</button></div>
          <span>人建的进程跑完一轮、或者任何进程出错，而页面不在前台时，弹一条系统通知。</span>
          ${notifyWhy !== "" && html`<span class="dnote" style="color:var(--warn)">${notifyWhy}</span>`}
        </div>

        <${SecHead} n="06" title="标题用的模型" en="TITLE MODEL" right=${html`<span class="dnote" style="font-size:11px">需要桥在运行</span>`} />
        <${ModelPicker} app=${app} value=${titleModel !== "" ? titleModel : model} onPick=${pickTitleModel} label="标题用的模型" />
        <div class="ep-keep">
          ${titleModel === "" ? html`<span>没单独设：跟默认模型一样；默认模型也没设，就用进程自己的模型。</span>` : html`<button type="button" class="link" onClick=${() => quiet(app.setGui({ titleModel: "" }))}>跟默认模型一样</button><span>已记住。</span>`}
        </div>
        <p class="dnote">人建的进程收到第一封信后，用这个模型调一次，把信概括成不超过 16 个字的标题。每个进程只调一次，失败就照旧显示第一行。</p>

        <${SecHead} n="07" title="工具定义" en="TOOLS" />
        <div class="cl-days soft">
          <${Pill} label="打开工具定义" onClick=${(/** @type {Event} */ e) => app.openDialog("tools", /** @type {Element} */ (e.currentTarget))} />
          <span>~/.tau/tools 里已装的定义，和能一键装的工具库。</span>
        </div>
      </div>
      <div class="dlg-foot">
        <span class="cmdline">记在 ~/.tau/extras/gui/state.json</span>
        <${Pill} kind="accent" icon="check" label="完成" onClick=${close} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
