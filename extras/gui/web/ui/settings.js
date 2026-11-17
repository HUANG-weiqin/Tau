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
  const changeDays = (/** @type {string} */ v) => {
    setDaysText(v);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DAYS && n !== app.gui.cleanDays) quiet(app.setGui({ cleanDays: n }));
  };

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
      </div>
      <div class="dlg-foot">
        <span class="cmdline">记在 ~/.tau/extras/gui/state.json</span>
        <${Pill} kind="accent" icon="check" label="完成" onClick=${close} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
