// 模型选择器和思考强度：新建预设、改预设、改这个会话、换模型共用。
// 选择器是一个字段加一块展开的面板：按供应商分组、可以搜索、顶上是最近用过的；每行写窗口、能不能收图、支持的思考级别。
import { html, Icon, useState, useEffect, useRef, Fragment } from "./common.js";
import { LEVELS, configured, filterCatalog, findModel, formatWindow, keyHint, keyLabel, nearestLevel, recentEntries, sortProviders } from "../lib/models.js";

/** 思考级别的两字缩写，六格固定的位置：亮的是这个模型支持的。 */
const LV_SHORT = { minimal: "MN", low: "LO", medium: "MD", high: "HI", xhigh: "XH", max: "MX" };

/** 一个模型支持的思考级别：六个小格，支持的填满。 @param {{ levels: string[] }} p */
function Levels({ levels }) {
  return html`<span class="mp-lv" role="img" aria-label=${levels.length === 0 ? "不支持思考强度" : `思考强度：${levels.join("、")}`} title=${levels.length === 0 ? "不支持思考强度" : `思考强度：${levels.join("、")}`}>
    ${LEVELS.map((l) => html`<i class=${levels.includes(l) ? "on" : ""}>${LV_SHORT[/** @type {keyof typeof LV_SHORT} */ (l)]}</i>`)}
  </span>`;
}

/** @param {{ m: import("../lib/models.js").CatalogModel }} p */
function Facts({ m }) {
  return html`<span class="mp-facts"><span class="num mp-win">${formatWindow(m.window)}</span>${m.image ? html`<span class="tag line mp-img" title="能收图片">IMG</span>` : html`<span class="mp-img" aria-hidden="true"></span>`}<${Levels} levels=${m.thinking} /></span>`;
}

/**
 * 模型字段。`value` 是 `<供应商>/<模型 ID>`；目录读不到时退回一个文本框，目录里没有的值照样显示、不改它。
 * `tag` 是标题旁的小件（改这个会话时写“换段时生效”）。
 * @param {{ app: import("../app.js").App, value: string, onPick: (ref: string) => void, label?: string, tag?: any }} p
 */
export function ModelPicker({ app, value, onPick, label = "模型", tag = null }) {
  const providers = app.models?.providers ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  const found = findModel(providers, value);
  const searching = query.trim() !== "";

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector("input")?.focus();
    // 弹窗收到 Esc 时，先收起选择器（见 common.js 的 Dialog）。
    const panel = root.current?.querySelector(".mp-panel");
    const onEsc = () => {
      setOpen(false);
      setQuery("");
      /** @type {HTMLElement | null | undefined} */ (root.current?.querySelector(".mp-cur"))?.focus();
    };
    panel?.addEventListener("esc", onEsc);
    return () => panel?.removeEventListener("esc", onEsc);
  }, [open]);

  if (providers === null) {
    return html`<label class="field"><span class="fl">${label}${tag}</span>
      <input class="input mono" type="text" value=${value} onInput=${(/** @type {any} */ e) => onPick(e.currentTarget.value)} />
      <span class="dnote" style="font-size:11.5px">${app.modelsError !== null ? `模型目录读不到（${app.modelsError}），先手写 <供应商>/<模型 ID>。` : "正在读模型目录…"}</span>
    </label>`;
  }

  const groups = filterCatalog(sortProviders(providers), query);
  const recent = searching ? [] : recentEntries(providers, app.gui.recentModels).slice(0, 5);
  const pick = (/** @type {string} */ ref) => {
    onPick(ref);
    setOpen(false);
    setQuery("");
  };
  const hint = found ? keyHint(found.provider.key) : null;

  return html`<div class="field mp" ref=${root}>
    <span id="mp-label" class="fl">${label}${tag}</span>
    <button type="button" autofocus class=${`mp-cur ${(found && !configured(found.provider.key)) || value === "" ? "off" : ""}`} aria-expanded=${open} aria-labelledby="mp-label" onClick=${() => setOpen(!open)}>
      <span class="mp-prov label">${found ? found.provider.name : value === "" ? "NONE" : "CUSTOM"}</span>
      <span class="mp-main">
        <b class="mp-name">${found ? found.model.name : value || "还没有选"}</b>
        <span class="mono mp-ref">${value}</span>
      </span>
      ${found ? html`<${Facts} m=${found.model} />` : value !== "" ? html`<span class="tag warn">目录里没有</span>` : null}
      <span class="mp-chev" aria-hidden="true"><${Icon} name=${open ? "up" : "down"} size=${14} sw=${2.8} /></span>
    </button>
    ${hint !== null && html`<p class="mp-hint" role="status">${hint}</p>`}
    ${found === null && value !== "" && html`<p class="mp-hint plain">模型目录里没有 ${value}，大概是手写的。表单照原样保留它，能不能启动由检查说了算。</p>`}
    ${open && html`<div class="mp-panel" data-esc role="listbox" aria-label="选模型">
      <div class="mp-search"><${Icon} name="search" size=${14} sw=${2.6} /><input type="text" placeholder="搜供应商、模型名" value=${query} aria-label="搜模型"
        onInput=${(/** @type {any} */ e) => setQuery(e.currentTarget.value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const p = groups[0];
          const m = p?.models[0];
          if (p && m) pick(`${p.id}/${m.id}`);
        }} /><span class="mono mp-count">${groups.reduce((n, p) => n + p.models.length, 0)}</span></div>
      ${recent.length > 0 && html`<div class="mp-recent"><span class="kicker acc-fg">最近用过</span>${recent.map((r) => html`<button type="button" key=${r.ref} class=${r.ref === value ? "on" : ""} title=${r.ref} onClick=${() => pick(r.ref)}>${r.model.name}</button>`)}</div>`}
      <div class="mp-list">
        ${groups.length === 0 && html`<p class="mp-none">没有匹配的模型。</p>`}
        ${groups.map(
          (p) => html`<${Fragment} key=${p.id}>
            <div class=${`mp-gh ${configured(p.key) ? "" : "off"}`}><span class="mp-gn">${p.name}</span><span class="label dim">${p.id}</span><span class="sep"></span><span class=${`tag ${configured(p.key) ? "acc" : "line"}`}>${keyLabel(p.key)}</span></div>
            ${p.models.map((m) => {
              const ref = `${p.id}/${m.id}`;
              return html`<button type="button" role="option" key=${ref} class=${`mp-row ${configured(p.key) ? "" : "off"}`} aria-selected=${ref === value} onClick=${() => pick(ref)}>
                <span class="mp-rn"><b>${m.name}</b><span class="mono">${m.id}</span></span>
                <${Facts} m=${m} />
              </button>`;
            })}
          </${Fragment}>`,
        )}
      </div>
    </div>`}
  </div>`;
}

/**
 * 思考强度：一排分段按钮。“不思考”就是预设里不写 `thinking`；选中的是黄块。
 * `levels` 是这个模型支持的级别；目录里没有这个模型时传 null，六档都给。`tag` 是标题旁的小件。
 * @param {{ levels: string[] | null, value: string | undefined, onChange: (v: string | undefined) => void, note?: string, tag?: any }} p
 */
export function ThinkingBar({ levels, value, onChange, note = "", tag = null }) {
  const shown = levels ?? LEVELS;
  return html`<div class="field"><span class="fl">思考强度${tag}</span>
    <div class="seg3" role="group" aria-label="思考强度">
      <button type="button" aria-pressed=${value === undefined} onClick=${() => onChange(undefined)}>不思考</button>
      ${shown.map((l) => html`<button type="button" key=${l} aria-pressed=${value === l} onClick=${() => onChange(l)}>${l}</button>`)}
    </div>
    ${levels !== null && levels.length === 0 && html`<span class="dnote" style="font-size:11.5px">这个模型没有可选的思考强度。</span>`}
    ${note !== "" && html`<span class="mp-note" role="status">${note}</span>`}
  </div>`;
}

/**
 * 换了模型，原来的思考级别不被支持：换成支持的最近一档，并给一行提示。
 * @param {import("../lib/models.js").CatalogModel | null} model 新模型，目录里没有就是 null（不动思考强度）
 * @param {string | undefined} thinking
 * @returns {{ thinking: string | undefined, note: string }}
 */
export function thinkingFor(model, thinking) {
  if (model === null || thinking === undefined || model.thinking.includes(thinking)) return { thinking, note: "" };
  const next = nearestLevel(model.thinking, thinking);
  return { thinking: next, note: next === undefined ? `${model.name} 没有可选的思考强度，${thinking} 改成了不思考。` : `${model.name} 不支持 ${thinking}，换成了最近的一档 ${next}。` };
}
