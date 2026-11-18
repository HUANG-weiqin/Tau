// 换模型：带着当前这一段分叉出一个新进程（进程 ID 会变）。不想换 ID，用“改这个会话”（`session.js`）改模型，换段时生效。
// 默认先改这个进程的预设，再带着这个预设分叉；也可以直接用同一个项目的另一个预设分叉。
import { html, Popover, DlgHead, SecHead, Pill, useState, Fragment } from "./common.js";
import { CheckStrip } from "./presetform.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { findModel, modelPatch } from "../lib/models.js";
import { pathKey } from "../lib/state.js";

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function SwitchModelDialog({ app, onClose }) {
  const pid = /** @type {string} */ (app.dialog?.props?.process ?? "");
  const e = app.byId[pid];
  const preset = e ? app.presets[e.preset] : undefined;
  const info = preset && preset.ok ? preset : undefined;
  const nowModel = e?.self.model ?? "";
  const nowThinking = e?.frozen?.thinking;
  const providers = app.models?.providers ?? null;

  const [mode, setMode] = useState(/** @type {"model" | "preset"} */ ("model"));
  // 默认从预设文件现在的样子起步：改预设 = 改文件。
  const [model, setModel] = useState(info?.model ?? nowModel);
  const [thinking, setThinking] = useState(/** @type {string | undefined} */ (info ? info.thinking : nowThinking));
  const [note, setNote] = useState("");
  const [other, setOther] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(/** @type {string | null} */ (null));

  const others = e ? app.presetList.filter((p) => p.ok && p.id !== e.preset && p.id !== app.gui.chief && e.workdir !== null && pathKey(p.workdir) === pathKey(e.workdir)) : [];
  const running = e?.status === "running";
  const info2 = findModel(providers, model)?.model ?? null;
  const same = model === nowModel && thinking === nowThinking;
  const can = !!e && !running && !busy && (mode === "model" ? !same && model.trim() !== "" && !!info : other !== null);
  const shown = e ? app.gui.names[e.preset] ?? e.preset : "";

  const pickModel = (/** @type {string} */ ref) => {
    setModel(ref);
    const r = thinkingFor(findModel(providers, ref)?.model ?? null, thinking);
    setThinking(r.thinking);
    setNote(r.note);
  };

  const go = async (/** @type {() => void} */ close) => {
    if (!can || !e) return;
    setBusy(true);
    setErr(null);
    let patched = false;
    try {
      if (mode === "model") {
        const patch = info ? modelPatch(info, model, thinking) : {};
        if (Object.keys(patch).length > 0) {
          await app.updatePreset({ id: e.preset, ...patch });
          patched = true;
        }
        app.rememberModel(model.trim()).catch(() => {});
      }
      const npid = await app.fork(e.id, undefined, mode === "model" ? e.preset : (other ?? e.preset));
      app.toast(`已分叉出 ${npid}，旧进程 ${e.id} 还在`);
      close();
    } catch (x) {
      const msg = x instanceof Error ? x.message : String(x);
      setErr(patched ? `预设已经改成新模型了，但分叉失败：${msg}` : msg);
      setBusy(false);
    }
  };

  const cur = findModel(providers, nowModel);
  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="换模型" width=${600} est=${700} class="switchmodel">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="fork" title="换模型" en="SWITCH MODEL" sub=${e ? `${shown} · ${e.id}` : "没有这个进程"} onClose=${close} />
      <div class="dlg-body">
        ${!e
          ? html`<div class="callout">没有这个进程。</div>`
          : html`<${Fragment}>
          <div class="sw-now" aria-label="这个进程现在的模型">
            <span class="kicker">现在</span>
            <span class="sw-now-m"><b>${cur ? cur.model.name : nowModel}</b><span class="mono">${nowModel}</span></span>
            <span class="sw-now-t"><span class="label dim">THINK</span><span class="num">${nowThinking ?? "—"}</span></span>
          </div>
          <p class="dnote">想保留进程 ID，用概况页里的“改这个会话”改模型，换段时生效。旧模型出故障时它换不了模型（交接说明要旧模型写），用这里。</p>
          ${running && html`<div class="callout">进程在跑，不能分叉。等这一轮结束，或者先停止。</div>`}
          ${!info && mode === "model" && html`<div class="callout">预设 ${e.preset} 现在读不出，没法改它的模型。可以换同项目的另一个预设。</div>`}
          <div class="sw-mode" role="group" aria-label="怎么换">
            <button type="button" aria-pressed=${mode === "model"} onClick=${() => setMode("model")}>改这个预设的模型</button>
            <button type="button" aria-pressed=${mode === "preset"} onClick=${() => setMode("preset")}>换同项目的另一个预设</button>
          </div>
          ${mode === "model"
            ? html`<${Fragment}>
                <${SecHead} n="01" title="新模型" en="MODEL" />
                <${ModelPicker} app=${app} value=${model} onPick=${pickModel} label="模型" />
                <${ThinkingBar} levels=${info2 === null ? null : info2.thinking} value=${thinking} onChange=${(/** @type {string | undefined} */ v) => { setThinking(v); setNote(""); }} note=${note} />
                ${same && html`<p class="dnote">和这个进程现在的一样，没有可换的。</p>`}
              </${Fragment}>`
            : html`<${Fragment}>
                <${SecHead} n="01" title="另一个预设" en="PRESET" right=${html`<span class="dnote" style="font-size:11px">同一个项目里的 ${others.length} 个</span>`} />
                ${others.length === 0 && html`<div class="callout">这个项目里没有别的预设。先在“+ 预设”里建一个。</div>`}
                <div class="pgrid">
                  ${others.map((p) => {
                    if (!p.ok) return null;
                    return html`<button type="button" key=${p.id} class=${`pcard ${p.memory ? "" : "temp"}`} aria-pressed=${other === p.id} onClick=${() => setOther(p.id)}>
                      <span class="nm"><b>${app.gui.names[p.id] ?? p.id}</b>${app.gui.names[p.id] && html`<span class="mono">${p.id}</span>`}</span>
                      <span class="tags"><span class="tag line">${p.memory ? "带记忆" : "不带记忆"}</span></span>
                      <span class="cnt mono">${p.model}${p.thinking ? ` · ${p.thinking}` : ""}</span>
                    </button>`;
                  })}
                </div>
              </${Fragment}>`}
          <${SecHead} n="02" title="代价" en="COST" />
          <ul class="sw-cost">
            <li>带着当前这一段的上下文开一个新进程，进程 ID 会变。</li>
            <li>旧进程留着。它的回信和它开的子进程，都留在旧进程那里。</li>
            ${mode === "model"
              ? html`<li>预设 ${e.preset} 也一起改成新模型：预设 ID 不变，记忆库还是同一个，以后新出生的会话也用新模型；其它在跑的会话不受影响。</li>`
              : html`<li>新进程用所选预设的提示词和工具，记忆库也跟着所选预设走。${e.memory ? `预设 ${e.preset} 的文件不动。` : ""}</li>`}
          </ul>
          ${err !== null && html`<${CheckStrip} ok=${false} text=${err} />`}
          </${Fragment}>`}
      </div>
      <div class="dlg-foot">
        <span class="cmdline"></span>
        <${Pill} label="取消" onClick=${close} />
        <${Pill} kind="accent" icon="fork" label=${busy ? "分叉中" : "换模型并分叉"} disabled=${!can} onClick=${() => go(close)} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
