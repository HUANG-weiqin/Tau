// 预设表：预设 ID、模型、思考强度、记忆和工具、换段阈值、提示词、折起的高级（options）。
// “打开项目”“新预设”“改预设”共用；改预设时预设 ID 只读。
import { html, Icon, useState, Fragment } from "./common.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { buildCreate, buildUpdate, defaultModelRef, findModel, nearestLevel } from "../lib/models.js";

export const TOOLS = ["read", "write", "edit", "bash", "memory", "agents"];
const NEW_TOOLS = ["read", "write", "edit", "bash", "memory"];

/**
 * 表的状态。`orig` 是改预设时现在的预设（读出来的样子）。`suggest` 是预设 ID 没填时的默认值，`model` 是想预填的模型。
 * 模型没传时：设置里的默认，没有就是最近用过的，再没有就是第一家配了 key 的第一个模型。
 * @param {{ app: import("../app.js").App, orig?: Extract<import("../lib/types.js").PresetInfo, { ok: true }>, model?: string, suggest?: string }} o
 */
export function usePresetForm(o) {
  const { app, orig } = o;
  const providers = app.models?.providers ?? null;
  const [id, setId] = useState("");
  const [picked, setPicked] = useState(/** @type {string | null} */ (null));
  const [thinkingSet, setThinkingSet] = useState(/** @type {{ v: string | undefined } | null} */ (null));
  const [note, setNote] = useState("");
  const [tools, setTools] = useState(orig ? orig.tools : NEW_TOOLS);
  const [handoff, setHandoff] = useState(orig?.handoff !== undefined ? String(orig.handoff) : "");
  const [options, setOptions] = useState(orig?.options !== undefined ? JSON.stringify(orig.options) : "");
  const [prompt, setPrompt] = useState(orig?.prompt ?? "");
  const [advanced, setAdvanced] = useState(orig?.options !== undefined);

  const model = picked ?? orig?.model ?? o.model ?? defaultModelRef(app.gui, providers);
  const info = findModel(providers, model)?.model ?? null;
  const thinking = thinkingSet ? thinkingSet.v : orig ? orig.thinking : nearestLevel(info?.thinking ?? [], app.gui.defaultThinking);
  const idFinal = id.trim() || o.suggest || "";

  const draft = () => ({ model, thinking, tools, handoff, options, prompt });
  return {
    orig, id, setId, idFinal, suggest: o.suggest ?? "",
    model, thinking, note, tools, handoff, setHandoff, options, setOptions, prompt, setPrompt, advanced, setAdvanced,
    /** 选了模型：原来的思考级别不被支持，换成最近的一档，并给一行提示。 @param {string} ref */
    pickModel(ref) {
      setPicked(ref);
      const next = findModel(providers, ref)?.model ?? null;
      const r = thinkingFor(next, thinking);
      setThinkingSet({ v: r.thinking });
      setNote(r.note);
    },
    /** @param {string | undefined} v */
    setThinking(v) {
      setThinkingSet({ v });
      setNote("");
    },
    memory: tools.includes("memory"),
    draft,
    /** 改预设时发给 `/api/presets/update` 的补丁（不含 id）；填错了是 `error`。 */
    update() {
      if (!orig) return { ok: /** @type {const} */ (false), error: "不是改预设" };
      return buildUpdate(orig, orig.prompt ?? "", draft());
    },
    /** 新建时多带的几个字段。 */
    create: () => buildCreate(draft()),
    toggle: (/** @type {string} */ t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]),
    /** ID 合法、没被占（Windows 不分大小写）、模型填了、几个输入框填得对。 @param {Record<string, unknown>} presets */
    valid(presets) {
      return (
        /^[A-Za-z0-9._-]+$/.test(idFinal) &&
        !/^\.+$/.test(idFinal) &&
        !idFinal.endsWith(".") &&
        !Object.keys(presets).some((k) => k.toLowerCase() === idFinal.toLowerCase()) &&
        model.trim() !== "" &&
        buildCreate(draft()).ok
      );
    },
  };
}

/**
 * 底部一条检查结果：能启动，或者用警示色写出错误原文。`text` 是 null 时不显示。
 * @param {{ ok: boolean, text: string | null, label?: string }} p
 */
export function CheckStrip({ ok, text, label = "check" }) {
  if (text === null) return null;
  return html`<div class=${`chk ${ok ? "ok" : "bad"}`} role="status"><span class="label">${label}</span><span class="chk-t">${text}</span></div>`;
}

/**
 * @param {{ form: ReturnType<typeof usePresetForm>, app: import("../app.js").App, placeholder?: string, promptHint?: string }} p
 */
export function PresetFields({ form, app, placeholder = "my-project", promptHint = "这个项目 Agent 是做什么的" }) {
  const { memory, toggle, tools, orig } = form;
  const edit = !!orig;
  const info = findModel(app.models?.providers, form.model)?.model ?? null;
  const allTools = [...TOOLS, ...tools.filter((t) => !TOOLS.includes(t))];
  const optErr = (() => {
    const b = form.draft().options.trim();
    if (b === "") return "";
    try {
      const v = JSON.parse(b);
      return v !== null && typeof v === "object" && !Array.isArray(v) ? "" : "要写成一行 JSON 对象";
    } catch {
      return "要写成一行 JSON 对象";
    }
  })();
  return html`<${Fragment}>
    <label class="field">预设 ID，也是文件名
      ${edit
        ? html`<span class="input mono ro" role="textbox" aria-readonly="true" aria-label="预设 ID，不能改">${orig.id}</span>`
        : html`<input class="input mono" type="text" value=${form.id} placeholder=${form.suggest || placeholder} onInput=${(/** @type {any} */ e) => form.setId(e.currentTarget.value)} />`}
    </label>
    <${ModelPicker} app=${app} value=${form.model} onPick=${form.pickModel} />
    <${ThinkingBar} levels=${info === null ? null : info.thinking} value=${form.thinking} onChange=${form.setThinking} note=${form.note} />
    <div class="twocol">
      <div class="field">记忆
        <div class="toggles" role="group" aria-label="记忆"><button type="button" class="toggle" aria-pressed=${memory} onClick=${() => !memory && toggle("memory")}>带</button><button type="button" class="toggle" aria-pressed=${!memory} onClick=${() => memory && toggle("memory")}>不带</button></div>
      </div>
      <div class="field">工具
        <div class="toggles" role="group" aria-label="工具">${allTools.map((t) => html`<button type="button" key=${t} class="toggle" aria-pressed=${tools.includes(t)} title=${TOOLS.includes(t) ? undefined : "工具定义，原样保留"} onClick=${() => toggle(t)}>${t}</button>`)}</div>
      </div>
    </div>
    <label class="field">换段阈值（token，可以不填）
      <input class="input mono" style="max-width:240px" type="text" inputmode="numeric" value=${form.handoff} placeholder="不填就按窗口自己定" onInput=${(/** @type {any} */ e) => form.setHandoff(e.currentTarget.value)} />
    </label>
    <label class="field">提示词${edit ? "" : "（可以以后在编辑器里补）"}<textarea class="input" rows=${edit ? 7 : 3} value=${form.prompt} onInput=${(/** @type {any} */ e) => form.setPrompt(e.currentTarget.value)} placeholder=${promptHint}></textarea></label>
    <div class="adv">
      <button type="button" class="adv-h" aria-expanded=${form.advanced} onClick=${() => form.setAdvanced(!form.advanced)}><span class="label">高级</span><span class="dim" style="font-size:12px">options</span><span class="sep"></span><${Icon} name=${form.advanced ? "up" : "down"} size=${13} sw=${2.8} /></button>
      ${form.advanced && html`<label class="field" style="margin-top:10px">options：一行 JSON，只收服务认的键
        <input class="input mono" type="text" value=${form.options} placeholder='{"temperature":0.2}' aria-invalid=${optErr !== ""} onInput=${(/** @type {any} */ e) => form.setOptions(e.currentTarget.value)} />
        ${optErr !== "" && html`<span class="dnote" style="color:var(--warn);font-size:11.5px">${optErr}</span>`}
      </label>`}
    </div>
  </${Fragment}>`;
}
