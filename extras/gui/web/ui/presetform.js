// 预设表：预设 ID、模型、思考强度、记忆和工具、换段阈值、提示词、折起的高级（options）。
// “打开项目”“新预设”“改预设”共用；改预设时预设 ID 只读。
import { html, Icon, useEffect, useState, Fragment } from "./common.js";
import { tools as loadTools, agentsMd as loadAgentsMd } from "../api.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { buildCreate, buildUpdate, defaultModelRef, findModel, nearestLevel } from "../lib/models.js";
import { groupByServer, withGroup } from "../lib/mcp.js";
import { formatBytes } from "../lib/format.js";

export const TOOLS = ["read", "write", "edit", "bash", "memory", "agents"];
const NEW_TOOLS = ["read", "write", "edit", "bash", "memory"];

/**
 * 表的状态。`orig` 是改预设时现在的预设（读出来的样子）。`suggest` 是预设 ID 没填时的默认值，`model` 是想预填的模型。
 * 模型没传时：设置里的默认，没有就是最近用过的，再没有就是第一家配了 key 的第一个模型。
 * `workdir` 是预设的工作目录（改预设时取现在的），用来查项目里有没有 AGENTS.md；没有就不查。
 * @param {{ app: import("../app.js").App, orig?: Extract<import("../lib/types.js").PresetInfo, { ok: true }>, model?: string, suggest?: string, workdir?: string }} o
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
  /** 已装的工具定义（`/api/tools` 的 installed，MCP 生成的带 `mcp`）；还没读到或读不到是 null。 */
  const [defs, setDefs] = useState(/** @type {import("../lib/mcp.js").InstalledDef[] | null} */ (null));
  useEffect(() => {
    let alive = true;
    loadTools().then(
      (r) => alive && setDefs(r.installed ?? []),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const workdir = o.workdir ?? orig?.workdir ?? "";
  /** 项目里 AGENTS.md 的情况，连同它是对哪个目录查的；还没查到是 null。 */
  const [agentsFile, setAgentsFile] = useState(/** @type {{ workdir: string, exists: boolean, bytes: number } | null} */ (null));
  useEffect(() => {
    if (workdir === "") return;
    let alive = true;
    // 打开项目时路径是一个字一个字敲的：等一下再查。
    const t = setTimeout(
      () =>
        loadAgentsMd(workdir).then(
          (r) => alive && setAgentsFile({ workdir, exists: r.exists, bytes: r.bytes ?? 0 }),
          () => alive && setAgentsFile(null),
        ),
      300,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [workdir]);
  const agentsInfo = agentsFile && agentsFile.workdir === workdir ? agentsFile : null;
  /** 用户点过勾选以后是他的选择；没点过，新建时文件在就默认勾上，改预设时跟现在有没有块。 */
  const [agentsPick, setAgentsPick] = useState(/** @type {boolean | null} */ (null));
  const agents = agentsPick ?? (orig ? orig.agentsMd !== "none" : !!agentsInfo?.exists);
  /** 块过期了，用户要求保存时重新拼。 */
  const [regen, setRegen] = useState(false);
  const model = picked ?? orig?.model ?? o.model ?? defaultModelRef(app.gui, providers);
  const info = findModel(providers, model)?.model ?? null;
  const thinking = thinkingSet ? thinkingSet.v : orig ? orig.thinking : nearestLevel(info?.thinking ?? [], app.gui.defaultThinking);
  const idFinal = id.trim() || o.suggest || "";

  const draft = () => ({ model, thinking, tools, handoff, options, prompt });
  return {
    orig, id, setId, idFinal, suggest: o.suggest ?? "",
    model, thinking, note, tools, agents, agentsInfo, agentsState: orig?.agentsMd ?? "none", regen,
    /** @param {boolean} v */
    setAgents(v) {
      setAgentsPick(v);
      if (!v) setRegen(false);
    },
    /** @param {boolean} v */
    setRegen,
     defs, handoff, setHandoff, options, setOptions, prompt, setPrompt, advanced, setAdvanced,
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
      const r = buildUpdate(orig, orig.prompt ?? "", draft());
      // 勾选和现在的块不一样才发；块过期了，选了“重新拼”也发。其余不动这段块。
      if (r.ok) {
        if (agents !== (orig.agentsMd !== "none")) r.patch["agentsMd"] = agents;
        else if (agents && regen) r.patch["agentsMd"] = true;
      }
      return r;
    },
    /** 新建时多带的几个字段。 */
    create() {
      const r = buildCreate(draft());
      return r.ok && agents && agentsInfo?.exists ? { ok: /** @type {const} */ (true), fields: { ...r.fields, agentsMd: true } } : r;
    },
    toggle: (/** @type {string} */ t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]),
    /** 一组一起开关（MCP 的小组头“全选”“全不选”）。 @param {readonly string[]} names @param {boolean} on */
    setMany: (names, on) => setTools((now) => withGroup(now, names, on)),
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
  // 已装的工具定义，加上预设里写了、但 tools/ 下没有的（原样保留，可以取消）。
  const defs = form.defs ?? [];
  const have = new Set(defs.map((d) => d.name));
  const orphans = tools.filter((t) => !TOOLS.includes(t) && !have.has(t));
  const { groups, others } = groupByServer(defs);
  /** 一组工具的小组头：服务器名，带“全选”“全不选”。 @param {string} title @param {string[]} names */
  const groupHead = (title, names) => {
    const on = names.filter((n) => tools.includes(n)).length;
    return html`<div class="def-group" key=${title}>
      <span class="def-group-h"><b>${title}</b><span class="dnote" style="font-size:11px">${on}/${names.length}</span></span>
      <button type="button" class="link" onClick=${() => form.setMany(names, true)}>全选</button>
      <button type="button" class="link" onClick=${() => form.setMany(names, false)}>全不选</button>
    </div>`;
  };
  const toggleOf = (t) =>
    html`<button type="button" key=${t} class="toggle" aria-pressed=${tools.includes(t)} title=${have.has(t) ? undefined : "tools/ 下没有这个定义，原样保留"} onClick=${() => toggle(t)}>${t}</button>`;
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
      <div class="field">内置工具
        <div class="toggles" role="group" aria-label="内置工具">${TOOLS.map((t) => html`<button type="button" key=${t} class="toggle" aria-pressed=${tools.includes(t)} onClick=${() => toggle(t)}>${t}</button>`)}</div>
      </div>
    </div>
    <div class="field">工具定义
      ${form.defs === null
        ? html`<span class="dnote">正在读…</span>`
        : defs.length === 0 && orphans.length === 0
          ? html`<span class="dnote">还没有装工具定义。在设置里打开“工具定义”装。</span>`
          : html`<${Fragment}>
              ${groups.map(
                (g) => html`<div class="def-mcp" key=${g.server}>
                  ${groupHead(`MCP · ${g.server}`, g.defs.map((d) => d.name))}
                  <div class="toggles" role="group" aria-label=${`MCP ${g.server} 的工具定义`}>${g.defs.map((d) => toggleOf(d.name))}</div>
                </div>`,
              )}
              ${(others.length > 0 || orphans.length > 0) &&
              html`<div class="def-mcp">
                ${others.length > 0 && groupHead("工具库和手写的", others.map((d) => d.name))}
                <div class="toggles" role="group" aria-label="工具定义">${others.map((d) => toggleOf(d.name))}${orphans.map((t) => toggleOf(t))}</div>
              </div>`}
            </${Fragment}>`}
      ${tools.includes("shell") && tools.includes("bash") && html`<span class="dnote" style="font-size:11.5px">shell 和 bash 同时开着：两个都能运行命令，通常只留一个。</span>`}
    </div>
    <label class="field">换段阈值（token，可以不填）
      <input class="input mono" style="max-width:240px" type="text" inputmode="numeric" value=${form.handoff} placeholder="不填就按窗口自己定" onInput=${(/** @type {any} */ e) => form.setHandoff(e.currentTarget.value)} />
    </label>
    <${AgentsMdField} form=${form} />
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

/** “拼上项目的 AGENTS.md”：一个勾选，旁边写文件大小。只对新进程生效。 @param {{ form: ReturnType<typeof usePresetForm> }} p */
function AgentsMdField({ form }) {
  const { agents, agentsInfo, agentsState, regen } = form;
  const edit = !!form.orig;
  const exists = agentsInfo?.exists === true;
  // 文件不在、又没勾着：开不了。勾着而文件没了（旧的块还在）：只能取消。
  const locked = !exists && !agents;
  return html`<div class="field">AGENTS.md
    <div class="agents-row">
      <button type="button" class="toggle" aria-pressed=${agents} disabled=${locked} onClick=${() => form.setAgents(!agents)}>拼上项目的 AGENTS.md</button>
      <span class="dnote">${agentsInfo === null ? "正在查…" : exists ? formatBytes(agentsInfo.bytes) : "项目里没有 AGENTS.md"}</span>
      ${edit && agentsState === "stale" && agents && html`<button type="button" class="toggle" aria-pressed=${regen} onClick=${() => form.setRegen(!regen)}>保存时重新拼</button>`}
    </div>
    ${edit && agentsState === "stale" && html`<span class="dnote" style="font-size:11.5px;color:var(--acc)">AGENTS.md 改过了，预设里拼的还是旧的。</span>`}
    ${edit && agentsState === "missing" && html`<span class="dnote" style="font-size:11.5px;color:var(--warn)">项目里的 AGENTS.md 没了，预设里拼的是旧的。</span>`}
    <span class="dnote" style="font-size:11.5px">放在提示词末尾，由界面管，别手改。只对新进程生效，在跑的进程冻结着旧的。</span>
  </div>`;
}
