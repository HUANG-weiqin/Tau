// 写信框：Ctrl+Enter 寄出，Enter 换行，能贴图片（base64 放进 images）。
import { html, Icon, Pill, useState, useRef, useEffect, useLayoutEffect } from "./common.js";

/** 草稿按进程记着，切走再回来还在。 @type {Map<string, { text: string, images: { data: string, url: string }[] }>} */
const drafts = new Map();

/**
 * @param {{ app: import("../app.js").App, id: string, name: string }} p
 */
export function Compose({ app, id, name }) {
  const d = drafts.get(id);
  const [text, setText] = useState(d?.text ?? "");
  const [images, setImages] = useState(d?.images ?? []);
  const [busy, setBusy] = useState(false);
  const area = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

  useEffect(() => {
    drafts.set(id, { text, images });
  }, [id, text, images]);
  // 高度跟着内容，最多 8 行。
  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.height = "auto";
    a.style.height = Math.min(a.scrollHeight, 190) + "px";
  }, [text]);

  const can = (text.trim() !== "" || images.length > 0) && !busy;
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

  /** @param {ClipboardEvent} e */
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      if (!f) continue;
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        const data = url.slice(url.indexOf(",") + 1);
        setImages((xs) => [...xs, { data, url }]);
      };
      r.readAsDataURL(f);
    }
  };

  return html`<form class="compose" onSubmit=${(/** @type {Event} */ e) => { e.preventDefault(); send(); }}>
    ${images.length > 0 && html`<div class="cthumbs">${images.map((im, i) => html`<span class="cthumb"><img src=${im.url} alt="要寄出的图片" /><button type="button" aria-label="去掉这张图片" onClick=${() => setImages(images.filter((_, j) => j !== i))}><${Icon} name="close" size=${12} sw=${3} /></button></span>`)}</div>`}
    <div class="crow">
      <label for="compose-input" class="clab">写信</label>
      <textarea
        id="compose-input" ref=${area} rows="1" class="cin" value=${text} placeholder=${`直接给 ${name} 写一封信（Ctrl+Enter 寄出，/ 跳过来）`}
        onInput=${(/** @type {any} */ e) => setText(e.currentTarget.value)} onPaste=${onPaste}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
      ></textarea>
      <div style="padding:0 8px;align-self:center"><${Pill} type="submit" icon="arrow" label=${busy ? "寄出中" : "寄出"} disabled=${!can} title="Ctrl+Enter" /></div>
    </div>
  </form>`;
}
