// 预设表：预设 ID、模型、思考强度、记忆和工具、上下文文件、换段阈值、提示词、折起的高级（options）。
// “新预设”“改预设”“改这个会话”共用；改预设和改这个会话时预设 ID 只读。新建时不常动的字段折在“更多设置”里（设计稿 7.6）。
// 改这个会话（`session`）：`orig` 是 `inspect` 读到的会话快照，工作目录也能改，字段旁标生效的时间。
import { html, Icon, Pill, useEffect, useState, Fragment } from "./common.js";
import { tools as loadTools, agentsMd as loadAgentsMd } from "../api.js";
import { ModelPicker, ThinkingBar, thinkingFor } from "./modelpicker.js";
import { AGENTS_FILE, buildCreate, buildUpdate, contextText, CONTEXT_MAX, convertGate, defaultModelRef, findModel, hasAgents, moreSummary, nearestLevel, parseContext, withAgents } from "../lib/models.js";
import { buildSession, EFFECT, EFFECT_TEXT } from "../lib/session.js";
import { groupByServer, withGroup } from "../lib/mcp.js";
import { formatBytes } from "../lib/format.js";

export const TOOLS = ["read", "write", "edit", "bash", "memory", "agents"];
const NEW_TOOLS = ["read", "write", "edit", "bash", "memory"];

/**
 * 项目里 AGENTS.md 的情况，连同它是对哪个目录查的。`workdir` 是空串、或还没查到，是 null。
 * `bad` 是这个目录查不了（不存在，或桥不可用）。表单和项目概况里的“转成上下文文件”都用它。
 * @param {string} workdir
 * @returns {{ workdir: string, exists: boolean, bytes: number, bad?: true } | null}
 */
export function useAgentsInfo(workdir) {
  const [found, setFound] = useState(/** @type {{ workdir: string, exists: boolean, bytes: number, bad?: true } | null} */ (null));
  useEffect(() => {
    if (workdir === "") return;
    let alive = true;
    // 改这个会话时工作目录是一个字一个字敲的：等一下再查。
    const t = setTimeout(
      () =>
        loadAgentsMd(workdir).then(
          (r) => alive && setFound({ workdir, exists: r.exists, bytes: r.bytes ?? 0 }),
          () => alive && setFound({ workdir, exists: false, bytes: 0, bad: true }),
        ),
      300,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [workdir]);
  return found && found.workdir === workdir ? found : null;
}

/**
 * 表的状态。`orig` 是改预设时现在的预设（读出来的样子），或者改这个会话时的会话快照（`session` 为真）。
 * `suggest` 是预设 ID 没填时的默认值，`model` 是想预填的模型。
 * 模型没传时：设置里的默认，没有就是最近用过的，再没有就是第一家配了 key 的第一个模型。
 * `workdir` 是预设的工作目录（改预设时取现在的），用来查项目里有没有 AGENTS.md；没有就不查。改这个会话时工作目录在表里改。
 * @param {{ app: import("../app.js").App, orig?: Extract<import("../lib/types.js").PresetInfo, { ok: true }>, model?: string, suggest?: string, workdir?: string, session?: boolean }} o
 */
export function usePresetForm(o) {
  const { app, orig } = o;
  const session = o.session === true;
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

  const [workdirText, setWorkdirText] = useState(orig?.workdir ?? "");
  const workdir = session ? workdirText.trim() : (o.workdir ?? orig?.workdir ?? "");
  const agentsInfo = useAgentsInfo(workdir);
  /** 用户动过上下文文件的框以后是他的文字；没动过，新建时项目里有 AGENTS.md 就默认写上它，改预设和改会话取现在的。 */
  const [ctxPick, setCtxPick] = useState(/** @type {string | null} */ (null));
  const ctx = ctxPick ?? (orig ? contextText(orig.context) : agentsInfo?.exists ? AGENTS_FILE : "");
  /** 用户点了“转成上下文文件”。真正生效还要项目里有 AGENTS.md：改了工作目录、新目录里没有时，点过也不算。 */
  const [convertPicked, setConvertState] = useState(false);
  const convertGateNow = convertGate(agentsInfo);
  const convert = convertPicked && convertGateNow.ok;
  const model = picked ?? orig?.model ?? o.model ?? defaultModelRef(app.gui, providers);
  const info = findModel(providers, model)?.model ?? null;
  const thinking = thinkingSet ? thinkingSet.v : orig ? orig.thinking : nearestLevel(info?.thinking ?? [], app.gui.defaultThinking);
  const idFinal = id.trim() || o.suggest || "";

  const draft = () => ({ model, thinking, tools, handoff, options, prompt, context: ctx, convert, ...(session ? { workdir: workdirText } : {}) });
  return {
    orig, session, id, setId, idFinal, suggest: o.suggest ?? "",
    model, thinking, note, tools, agentsInfo, ctx, convert, convertGate: convertGateNow, workdir,
    /** @param {string} v */
    setCtx: (v) => setCtxPick(v),
    /** “用项目的 AGENTS.md”：勾上加一行，取消去掉这一行。 @param {boolean} v */
    setAgents: (v) => setCtxPick(withAgents(ctx, v)),
    /** “转成上下文文件”：记下保存时要去掉旧块，并在上下文文件里加 AGENTS.md。项目里没有 AGENTS.md 时不做（键是灰的）。 @param {boolean} v */
    setConvert(v) {
      if (v && !convertGateNow.ok) return;
      setConvertState(v);
      if (v) setCtxPick(withAgents(ctx, true));
    },
    workdirText, setWorkdirText,
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
      if (!orig || session) return { ok: /** @type {const} */ (false), error: "不是改预设" };
      return buildUpdate(orig, orig.prompt ?? "", draft());
    },
    /** 改这个会话时发给 `reconfigure` 的 `fields`（只有变了的）；填错了是 `error`。 */
    reconfig() {
      if (!orig || !session) return { ok: /** @type {const} */ (false), error: "不是改这个会话" };
      return buildSession(/** @type {any} */ (orig), draft());
    },
    /** 新建时多带的几个字段。 */
    create: () => buildCreate(draft()),
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

/** 改这个会话时字段旁的小标：什么时候生效。 @param {{ field: string }} p */
export function Eff({ field }) {
  const k = /** @type {Record<string, "call" | "segment">} */ (EFFECT)[field];
  if (!k) return null;
  return html`<span class=${`tag eff ${k === "call" ? "acc" : "line"}`}>${EFFECT_TEXT[k]}</span>`;
}

/**
 * @param {{ form: ReturnType<typeof usePresetForm>, app: import("../app.js").App, placeholder?: string, promptHint?: string, toolsExtra?: any, compact?: boolean, idExtra?: any }} p
 * `toolsExtra` 是工具区底下多放的一块（改这个会话时的“重读工具定义”）。
 * `compact` 只在新建时用：ID、模型、提示词之外的字段折进“更多设置”。字段里有填错的，自动展开。`idExtra` 放在预设 ID 的下面。
 */
export function PresetFields({ form, app, placeholder = "my-project", promptHint = "这个项目 Agent 是做什么的", toolsExtra = null, compact = false, idExtra = null }) {
  const { memory, toggle, tools, orig, session } = form;
  const edit = !!orig;
  const [more, setMore] = useState(false);
  const folded = compact && !edit && !session;
  const moreOpen = !folded || more || !form.create().ok;
  const info = findModel(app.models?.providers, form.model)?.model ?? null;
  /** @param {string} f */
  const eff = (f) => (session ? html`<${Eff} field=${f} />` : null);
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
  const pickWorkdir = async () => {
    try {
      const p = await app.pickFolder();
      if (p) form.setWorkdirText(p);
    } catch {
      // 提示已经弹了，可以手写路径。
    }
  };
  const idField = html`<label class="field">预设 ID，也是文件名
      ${edit
        ? html`<span class="input mono ro" role="textbox" aria-readonly="true" aria-label="预设 ID，不能改">${orig.id}</span>`
        : html`<input class="input mono" type="text" value=${form.id} placeholder=${form.suggest || placeholder} onInput=${(/** @type {any} */ e) => form.setId(e.currentTarget.value)} />`}
    </label>`;
  const promptField = html`<label class="field"><span class="fl">提示词${edit ? "" : "（可以以后在编辑器里补）"}${eff("prompt")}</span><textarea class="input" rows=${edit ? 7 : 3} value=${form.prompt} onInput=${(/** @type {any} */ e) => form.setPrompt(e.currentTarget.value)} placeholder=${promptHint}></textarea></label>`;
  const restFields = html`<${Fragment}>
    <div class="twocol">
      <div class="field">记忆
        <div class="toggles" role="group" aria-label="记忆"><button type="button" class="toggle" aria-pressed=${memory} onClick=${() => !memory && toggle("memory")}>带</button><button type="button" class="toggle" aria-pressed=${!memory} onClick=${() => memory && toggle("memory")}>不带</button></div>
      </div>
      <div class="field"><span class="fl">内置工具${eff("tools")}</span>
        <div class="toggles" role="group" aria-label="内置工具">${TOOLS.map((t) => html`<button type="button" key=${t} class="toggle" aria-pressed=${tools.includes(t)} onClick=${() => toggle(t)}>${t}</button>`)}</div>
      </div>
    </div>
    <div class="field"><span class="fl">工具定义${eff("tools")}</span>
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
      ${toolsExtra}
    </div>
    <label class="field"><span class="fl">换段阈值（token，可以不填）${eff("handoff")}</span>
      <input class="input mono" style="max-width:240px" type="text" inputmode="numeric" value=${form.handoff} placeholder="不填就按窗口自己定" onInput=${(/** @type {any} */ e) => form.setHandoff(e.currentTarget.value)} />
    </label>
    <${ContextField} form=${form} />
</${Fragment}>`;
  const tailFields = html`<${Fragment}>
    <${LegacyRow} form=${form} />
    <div class="adv">
      <button type="button" class="adv-h" aria-expanded=${form.advanced} onClick=${() => form.setAdvanced(!form.advanced)}><span class="kicker">高级</span><span class="dim" style="font-size:12px">options</span><span class="sep"></span><${Icon} name=${form.advanced ? "up" : "down"} size=${13} sw=${2.8} /></button>
      ${form.advanced && html`<label class="field" style="margin-top:10px"><span class="fl">options：一行 JSON，只收服务认的键${eff("options")}</span>
        <input class="input mono" type="text" value=${form.options} placeholder='{"temperature":0.2}' aria-invalid=${optErr !== ""} onInput=${(/** @type {any} */ e) => form.setOptions(e.currentTarget.value)} />
        ${optErr !== "" && html`<span class="dnote" style="color:var(--warn);font-size:11.5px">${optErr}</span>`}
      </label>`}
    </div>
</${Fragment}>`;
  return html`<${Fragment}>
    ${idField}
    ${folded && idExtra}
    ${session && html`<div class="field"><span class="fl">工作目录${eff("workdir")}</span>
      <div class="pathrow"><input class="input mono" type="text" value=${form.workdirText} aria-label="工作目录" onInput=${(/** @type {any} */ e) => form.setWorkdirText(e.currentTarget.value)} /><${Pill} label="选文件夹" onClick=${pickWorkdir} /></div>
    </div>`}
    <${ModelPicker} app=${app} value=${form.model} onPick=${form.pickModel} tag=${eff("model")} />
    <${ThinkingBar} levels=${info === null ? null : info.thinking} value=${form.thinking} onChange=${form.setThinking} note=${form.note} tag=${eff("thinking")} />
    ${folded
      ? html`<${Fragment}>
          ${promptField}
          <div class="adv">
            <button type="button" class="adv-h" aria-expanded=${moreOpen} onClick=${() => setMore(!more)}><span class="kicker">更多设置</span><span class="dim ell" style="font-size:12px">${moreOpen ? "" : moreSummary(tools, form.ctx)}</span><span class="sep"></span><${Icon} name=${moreOpen ? "up" : "down"} size=${13} sw=${2.8} /></button>
          </div>
          ${moreOpen && html`<${Fragment}>${restFields}${tailFields}</${Fragment}>`}
        </${Fragment}>`
      : html`<${Fragment}>${restFields}${promptField}${tailFields}</${Fragment}>`}
  </${Fragment}>`;
}

/**
 * 上下文文件：一行一个路径，最多 8 行，内核每次开段重读。“用项目的 AGENTS.md”是它的快捷：勾上加一行，取消去掉这一行。
 * 路径写得对不对由服务查（读预设时只查写法，不查文件在不在），这里只管写得成一行。
 * @param {{ form: ReturnType<typeof usePresetForm> }} p
 */
function ContextField({ form }) {
  const { ctx, agentsInfo, session } = form;
  const parsed = parseContext(ctx);
  const n = parsed.ok ? (parsed.value?.length ?? 0) : ctx.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  const agents = hasAgents(ctx);
  const exists = agentsInfo?.exists === true;
  // 文件不在、又没勾着：开不了。勾着而文件没了：只能取消。
  const locked = !exists && !agents;
  return html`<div class="field ctx"><span class="fl">上下文文件${session && html`<${Eff} field="context" />`}<span class="dnote ctx-cap">每次换段重读，最多 24 KiB</span></span>
    <textarea class="input mono" rows="3" value=${ctx} aria-label="上下文文件，一行一个路径" aria-invalid=${!parsed.ok} placeholder=${"一行一个路径，最多 8 行\n相对路径按工作目录算"} onInput=${(/** @type {any} */ e) => form.setCtx(e.currentTarget.value)}></textarea>
    <span class=${`dnote ctx-n ${n > CONTEXT_MAX ? "over" : ""}`}>${n} / ${CONTEXT_MAX} 行</span>
    ${!parsed.ok && html`<span class="dnote" style="color:var(--warn);font-size:11.5px">${parsed.error}</span>`}
    <div class="agents-row">
      <span class="toggles"><button type="button" class="toggle" aria-pressed=${agents} disabled=${locked} onClick=${() => form.setAgents(!agents)}>用项目的 AGENTS.md</button></span>
      <span class="dnote">${agentsInfo === null ? (form.workdir === "" ? "选好文件夹才能查" : "正在查…") : agentsInfo.bad ? "没查到这个目录" : exists ? formatBytes(agentsInfo.bytes) : "项目里没有 AGENTS.md"}</span>
    </div>
    <span class="dnote" style="font-size:11.5px">${session ? "文件改了，这个会话要等下一次换段才读到。" : "文件改了，在跑的会话要等下一次换段才读到；新出生的会话一出生就读。"}只查写法，不查文件在不在。</span>
  </div>`;
}

/**
 * 提示词里有 D58 留下的旧拼接块（以前界面把 AGENTS.md 拼在提示词末尾）：它不会再更新。
 * “转成上下文文件”：保存时去掉旧块，在上下文文件里加 AGENTS.md。项目里没有 AGENTS.md 时键是灰的：旧块可能是内容的最后一份。
 * @param {{ form: ReturnType<typeof usePresetForm> }} p
 */
function LegacyRow({ form }) {
  const { orig, convert, convertGate: gate } = form;
  if (!orig || orig.agentsMd !== "legacy") return null;
  return html`<div class="agents-legacy">
    <span class="tag warn">有旧的拼接块</span>
    <span class="dnote">提示词末尾有以前拼进去的 AGENTS.md，不会再更新。</span>
    <span class="toggles"><button type="button" class="toggle" aria-pressed=${convert} disabled=${!gate.ok} title="去掉旧块，改成每次换段重读 AGENTS.md" onClick=${() => form.setConvert(!convert)}>转成上下文文件</button></span>
    ${!gate.ok && html`<span class="dnote">${gate.note}</span>`}
    ${convert && html`<span class="dnote">保存时去掉旧块，上下文文件里加 AGENTS.md。</span>`}
  </div>`;
}
