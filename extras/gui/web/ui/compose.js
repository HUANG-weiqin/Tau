// 写信框：调度台底座。左边写给谁、它在哪个阶段；右边是墨井，墨井底行是“寄出以后会怎样”、快捷键和寄出键。
// Enter 寄出，Ctrl+Enter 换行，/ 跳过来，Esc 离开（全局键在 app.js）。能贴图片（base64 放进 images）。
import { html, Icon, Lamp, Pill, Tex, pad2, letterKey, useState, useRef, useEffect, useLayoutEffect } from "./common.js";
import { contextPercent } from "../lib/format.js";
import { useAttach, AttachBar, Thumbs } from "./attach.js";
import { refusesImages } from "../lib/derive.js";

/** 草稿按进程记着，切走再回来还在。 @type {Map<string, { text: string, images: { data: string, url: string }[] }>} */
const drafts = new Map();

/**
 * 寄出以后会怎样，全从阶段算。
 * @param {import("../lib/derive.js").Entry} e @param {string | null} note
 * @returns {{ k: "idle" | "run" | "err" | "note", token: string, cap: string, line: string }}
 */
function fateOf(e, note) {
  const ph = e.self.phase;
  if (ph.tag !== "idle") {
    const q = ph.queued ?? 0;
    return { k: "run", token: pad2(q), cap: "封在排队", line: "排进队，下个安全点并进这一轮" };
  }
  if (note) return { k: e.status === "error" ? "err" : "note", token: "NOW", cap: "", line: "先接上一轮的说明，再开始新一轮" };
  return { k: "idle", token: "NOW", cap: "", line: e.status === "fresh" ? "立即开始它的第一轮" : "立即开始新一轮" };
}

/**
 * @param {{ app: import("../app.js").App, e: import("../lib/derive.js").Entry, name: string, note?: string | null }} p
 */
export function Compose({ app, e, name, note = null }) {
  const id = e.id;
  const d0 = drafts.get(id);
  const [text, setText] = useState(d0?.text ?? "");
  const [images, setImages] = useState(d0?.images ?? []);
  const [busy, setBusy] = useState(false);
  const area = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

  useEffect(() => {
    drafts.set(id, { text, images });
  }, [id, text, images]);
  // 高度跟着内容走；最低两行，最高由 CSS 的 max-height 卡住，再多就在框里滚。
  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.flex = "none";
    a.style.height = "0px";
    const h = a.scrollHeight;
    a.style.height = h + "px";
    a.style.flex = "";
  }, [text, images.length]);

  const at = useAttach(images, setImages);
  // 图片还在压缩时不许寄：不然信不带图寄出，图随后落进清空了的草稿。
  const can = (text.trim() !== "" || images.length > 0) && !busy && at.busy === 0;
  const send = async () => {
    if (!can) return;
    setBusy(true);
    try {
      await app.send(id, text, images.map((i) => i.data));
      setText("");
      setImages([]);
      drafts.delete(id);
    } catch {
      // 提示已经弹了，草稿留着。
    } finally {
      setBusy(false);
    }
  };

  const d = app.describe(e);
  const fate = fateOf(e, note);
  const ph = e.self.phase.tag;
  const temp = e.kind === "temp";
  const chars = [...text].length;
  const noteErr = e.status === "error";

  return html`<form class=${`dock k-${fate.k} ${text !== "" || images.length > 0 ? "has" : ""}`} aria-label=${`写信给 ${name}`} onSubmit=${(/** @type {Event} */ ev) => { ev.preventDefault(); send(); }}>
    <div class="dk-edge" aria-hidden="true"></div>
    <div class="dk-grid">
      <div class="dk-side">
        <${Tex} kind="tx-dots-d" mask="linear-gradient(180deg, transparent 20%, #000 100%)" />
        <div class="dk-lbl"><span class="dk-letter">LETTER</span><span class="dk-tick" aria-hidden="true"></span></div>
        <label for="compose-input" class="dk-who"><span class="dk-to">写信给</span><span class=${`dk-name ${temp ? "small" : ""}`} title=${name}>${name}</span></label>
        <div class="dk-ids mono"><span>${e.preset} · <b class="dk-pid">${id}</b></span><span>SEG ${pad2(e.self.segment)} · CTX ${contextPercent(e.self.context)}%</span></div>
        <div class="dk-st">
          <${Lamp} phase=${ph} />
          <b>${d.label}${d.tool ? ` ${d.tool}` : ""}</b>
          <span class="mono">${d.dur}</span>
        </div>
      </div>

      <div class=${`dk-well ${note ? "pre" : ""} ${at.over ? "over" : ""}`} ...${at.drop}>
        <span class="dk-br g" aria-hidden="true"></span><span class="dk-br y" aria-hidden="true"></span>
        <${Tex} kind="tx-grid-d" mask="radial-gradient(ellipse 90% 120% at 100% 100%, #000 0%, transparent 75%)" />
        ${note && html`<div class=${`dk-pre ${noteErr ? "err" : ""}`}>
          <span class=${`tag ${noteErr ? "warn" : "acc"}`}>自动加在信前</span>
          <p class="mono" title=${note}>${note}</p>
        </div>`}
        <${Thumbs} images=${images} onRemove=${(/** @type {number} */ i) => setImages(images.filter((_, j) => j !== i))} />
        <textarea
          id="compose-input" ref=${area} rows="2" class="dk-in" value=${text}
          placeholder=${fate.k === "run" ? `${name} 在跑。写下要补充的话，寄出后排队…` : `写给 ${name}…`}
          onInput=${(/** @type {any} */ ev) => setText(ev.currentTarget.value)} onPaste=${at.onPaste}
          onKeyDown=${(/** @type {KeyboardEvent} */ ev) => letterKey(ev, send, setText)}
        ></textarea>
        <div class="dk-att"><${AttachBar} at=${at} count=${images.length} noImage=${refusesImages(e.frozen)} /></div>
        <div class="dk-row">
          <div class="dk-fate" role="status">
            <span class="dk-tok">${fate.token}</span>${fate.cap && html`<span class="dk-tcap">${fate.cap}</span>`}
            <p title=${fate.line}>${fate.line}</p>
          </div>
          <div class="dk-hints" aria-hidden="true">
            <span><kbd>Enter</kbd>寄出</span><span><kbd>Ctrl+Enter</kbd>换行</span><span><kbd>/</kbd>跳到这里</span><span><kbd>Esc</kbd>离开</span><span class="dk-xl">能贴、拖图片</span>
            <span class="dk-count mono"><b>${String(chars).padStart(4, "0")}</b> 字${images.length > 0 ? ` · ${images.length} 图` : ""}</span>
          </div>
          <${Pill} type="submit" kind=${can ? "accent" : ""} class="dk-go" icon="arrow" disabled=${!can} title="Enter" label=${busy ? "寄出中" : "寄出"} />
        </div>
      </div>
    </div>
  </form>`;
}
