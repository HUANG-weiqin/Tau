// 建预设的表：预设 ID、模型、带不带记忆、工具、提示词。“打开项目”和“新预设”共用。
import { html, useState, Fragment } from "./common.js";

export const TOOLS = ["read", "write", "edit", "bash", "memory", "agents"];
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

/**
 * 表的状态。`suggest` 是预设 ID 没填时的默认值。
 * @param {{ model?: string, suggest?: string }} [o]
 */
export function usePresetForm(o = {}) {
  const [id, setId] = useState("");
  const [model, setModel] = useState(o.model ?? DEFAULT_MODEL);
  const [tools, setTools] = useState(["read", "write", "edit", "bash", "memory"]);
  const [prompt, setPrompt] = useState("");
  const idFinal = id.trim() || o.suggest || "";
  return {
    id, setId, model, setModel, tools, setTools, prompt, setPrompt, idFinal,
    memory: tools.includes("memory"),
    suggest: o.suggest ?? "",
    toggle: (/** @type {string} */ t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]),
    /** ID 合法、没被占（Windows 不分大小写）、模型填了。 @param {Record<string, unknown>} presets */
    valid: (presets) =>
      /^[A-Za-z0-9._-]+$/.test(idFinal) && !/^\.+$/.test(idFinal) && !idFinal.endsWith(".") && !Object.keys(presets).some((k) => k.toLowerCase() === idFinal.toLowerCase()) && model.trim() !== "",
  };
}

/** @param {{ form: ReturnType<typeof usePresetForm>, placeholder?: string, promptHint?: string }} p */
export function PresetFields({ form, placeholder = "my-project", promptHint = "这个项目 Agent 是做什么的" }) {
  const { memory, toggle, tools } = form;
  return html`<${Fragment}>
    <div class="fgrid">
      <label class="field">预设 ID，也是文件名<input class="input mono" type="text" value=${form.id} placeholder=${form.suggest || placeholder} onInput=${(/** @type {any} */ e) => form.setId(e.currentTarget.value)} /></label>
      <label class="field">模型<input class="input mono" type="text" value=${form.model} onInput=${(/** @type {any} */ e) => form.setModel(e.currentTarget.value)} /></label>
    </div>
    <div class="twocol">
      <div class="field">记忆
        <div class="toggles" role="group" aria-label="记忆"><button type="button" class="toggle" aria-pressed=${memory} onClick=${() => !memory && toggle("memory")}>带</button><button type="button" class="toggle" aria-pressed=${!memory} onClick=${() => memory && toggle("memory")}>不带</button></div>
      </div>
      <div class="field">工具
        <div class="toggles" role="group" aria-label="工具">${TOOLS.map((t) => html`<button type="button" class="toggle" aria-pressed=${tools.includes(t)} onClick=${() => toggle(t)}>${t}</button>`)}</div>
      </div>
    </div>
    <label class="field">提示词（可以以后在编辑器里补）<textarea class="input" rows="3" value=${form.prompt} onInput=${(/** @type {any} */ e) => form.setPrompt(e.currentTarget.value)} placeholder=${promptHint}></textarea></label>
  </${Fragment}>`;
}
