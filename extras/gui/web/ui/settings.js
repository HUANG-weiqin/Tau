// 设置：默认模型和思考强度、供应商的 key 状态（只读）、清理的天数。
// 改一项就记一项，没有“保存”。界面不放 token 和费用。
import { html, Popover, DlgHead, SecHead, Pill, useState, Fragment } from "./common.js";
import { CheckStrip } from "./presetform.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { findModel, keyLabel, sortProviders } from "../lib/models.js";

const MAX_DAYS = 3650;

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

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="设置" width=${640} est=${720} class="settings">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="sliders" title="设置" en="SETTINGS" sub="Ctrl+," onClose=${close} />
      <div class="dlg-body">
        <${SecHead} n="01" title="默认模型" en="DEFAULT MODEL" right=${html`<span class="dnote" style="font-size:11px">新建预设时预填</span>`} />
        <${ModelPicker} app=${app} value=${model} onPick=${pickModel} label="默认模型" />
        <${ThinkingBar} levels=${info === null ? null : info.thinking} value=${thinking} onChange=${setThinking} note=${note} />
        <div class="ep-keep">
          ${model === "" ? html`<span>没设默认模型：新建预设时预填项目里已有预设的模型，没有就是最近用过的。</span>` : html`<button type="button" class="link" onClick=${() => { setNote(""); quiet(app.setGui({ defaultModel: "", defaultThinking: "" })); }}>清掉默认</button><span>已记住，下次新建预设就是它。</span>`}
        </div>

        <${SecHead} n="02" title="供应商和 key" en="PROVIDERS" right=${html`<span class="dnote" style="font-size:11px">只读</span>`} />
        ${providers === null
          ? html`<p class="dnote">${app.modelsError !== null ? `读不到模型目录：${app.modelsError}` : "正在读模型目录…"}</p>`
          : html`<${Fragment}>
              <div class="st-big"><span class=${`num ${ready > 0 ? "ok" : ""}`}>${ready}</span><span class="dnote">家配了 key，共 ${providers.length} 家</span></div>
              <ul class="st-prov" aria-label="供应商和 key 状态">
                ${sorted.map((p) => html`<li key=${p.id} class=${`st-row ${p.key === "key" ? "" : "off"}`}>
                  <span class="st-n"><b>${p.name}</b><span class="mono ell">${p.id}</span></span>
                  <span class="ct mono">${p.models.length}</span>
                  <span class=${`tag ${p.key === "key" ? "acc" : p.key === "none" ? "line" : "warn"}`}>${keyLabel(p.key)}</span>
                </li>`)}
              </ul>
            </${Fragment}>`}
        ${auth && !auth.ok && html`<${CheckStrip} ok=${false} text=${auth.error} label="auth.json" />`}
        <p class="dnote">key 在 pi 的 <span class="mono">~/.pi/agent/auth.json</span> 里改，改完不用重启，下次打开这里就是新的。tau 只读这个文件，也不显示 key。</p>

        <${SecHead} n="03" title="清理旧进程" en="CLEAN UP" />
        <div class="cl-days">
          <label for="st-days-in">空闲超过</label>
          <input id="st-days-in" class="input mono" type="number" min="1" max=${MAX_DAYS} step="1" value=${daysText} aria-invalid=${!daysOk} onInput=${(/** @type {any} */ e) => changeDays(e.currentTarget.value)} />
          <span>天的临时进程算旧的。</span>
          ${!daysOk && html`<span class="dnote" style="color:var(--warn)">天数要写 1 到 ${MAX_DAYS} 的整数。</span>`}
        </div>

        <${SecHead} n="04" title="完成通知" en="NOTIFY" />
        <div class="cl-days soft">
          <div class="toggles" role="group" aria-label="完成通知"><button type="button" class="toggle" aria-pressed=${notifyOn} onClick=${() => (!notifyOn || perm !== "granted") && setNotify(true)}>开</button><button type="button" class="toggle" aria-pressed=${!notifyOn} onClick=${() => notifyOn && setNotify(false)}>关</button></div>
          <span>人建的进程跑完一轮、或者任何进程出错，而页面不在前台时，弹一条系统通知。</span>
          ${notifyWhy !== "" && html`<span class="dnote" style="color:var(--warn)">${notifyWhy}</span>`}
        </div>

        <${SecHead} n="05" title="标题用的模型" en="TITLE MODEL" right=${html`<span class="dnote" style="font-size:11px">需要桥在运行</span>`} />
        <${ModelPicker} app=${app} value=${titleModel !== "" ? titleModel : model} onPick=${pickTitleModel} label="标题用的模型" />
        <div class="ep-keep">
          ${titleModel === "" ? html`<span>没单独设：跟默认模型一样；默认模型也没设，就用进程自己的模型。</span>` : html`<button type="button" class="link" onClick=${() => quiet(app.setGui({ titleModel: "" }))}>跟默认模型一样</button><span>已记住。</span>`}
        </div>
        <p class="dnote">人建的进程收到第一封信后，用这个模型调一次，把信概括成不超过 16 个字的标题。每个进程只调一次，失败就照旧显示第一行。</p>

        <${SecHead} n="06" title="工具定义" en="TOOLS" />
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
