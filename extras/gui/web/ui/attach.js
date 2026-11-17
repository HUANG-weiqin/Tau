// 附图：贴、拖、选文件三条路进同一个入口。写信框和总管输入框共用。
// 图在页面里先缩小压缩（lib/image.js），张数照服务的上限。
import { html, Icon, useState, useRef } from "./common.js";
import { PER_MESSAGE, prepare, room, addNote } from "../lib/image.js";

/** @typedef {{ data: string, url: string }} Pic */

/**
 * @param {Pic[]} images 当前的图 @param {(f: (xs: Pic[]) => Pic[]) => void} setImages
 */
export function useAttach(images, setImages) {
  const [note, setNote] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const count = useRef(images.length);
  count.current = images.length;
  const depth = useRef(0);

  /** @param {File[]} files */
  const add = async (files) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    const { take, dropped } = room(count.current, imgs.length);
    /** @type {string[]} */
    const failed = [];
    setNote(addNote(dropped, failed));
    if (take === 0) return;
    // 先占住名额，免得连着加几次超出上限。
    count.current += take;
    setBusy((n) => n + take);
    for (const f of imgs.slice(0, take)) {
      try {
        const r = await prepare(f);
        setImages((xs) => (xs.length >= PER_MESSAGE ? xs : [...xs, { data: r.data, url: r.url }]));
        if (r.resized) failed.push(`${f.name || "图片"} 已缩小压缩`);
      } catch (e) {
        count.current -= 1;
        failed.push(`${f.name || "图片"}：${e instanceof Error ? e.message : e}`);
      }
      setBusy((n) => n - 1);
    }
    setNote(addNote(dropped, failed));
  };

  /** @param {ClipboardEvent} ev */
  const onPaste = (ev) => {
    const files = [...(ev.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
    const got = /** @type {File[]} */ (files.filter(Boolean));
    if (got.length === 0) return;
    ev.preventDefault();
    add(got);
  };

  /** @param {DragEvent} ev */
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes("Files");
  const drop = {
    onDragEnter: (/** @type {DragEvent} */ ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver: (/** @type {DragEvent} */ ev) => {
      if (hasFiles(ev)) ev.preventDefault();
    },
    onDragLeave: (/** @type {DragEvent} */ ev) => {
      if (!hasFiles(ev)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (/** @type {DragEvent} */ ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth.current = 0;
      setOver(false);
      add([...(ev.dataTransfer?.files ?? [])]);
    },
  };
  return { add, onPaste, drop, over, note, busy, clear: () => setNote(null), full: images.length + busy >= PER_MESSAGE };
}

/**
 * 选文件的按钮、张数、提示。`noImage` 为真时写一行模型不收图的说明。
 * @param {{ at: ReturnType<typeof useAttach>, count: number, noImage: boolean }} p
 */
export function AttachBar({ at, count, noImage }) {
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  return html`<div class="att">
    <input ref=${input} type="file" accept="image/*" multiple hidden onChange=${(/** @type {any} */ ev) => {
      at.add([...ev.currentTarget.files]);
      ev.currentTarget.value = "";
    }} />
    <button type="button" class="link att-pick" disabled=${at.full} title=${at.full ? `一封信最多 ${PER_MESSAGE} 张图片` : "选图片文件，也可以直接贴或拖进来"} onClick=${() => input.current?.click()}><${Icon} name="image" size=${13} sw=${2.4} /><span>${at.busy > 0 ? "处理中" : "添加图片"}</span><span class="mono att-n">${count + at.busy}/${PER_MESSAGE}</span></button>
    ${at.full && html`<span class="att-note">已经是 ${PER_MESSAGE} 张，不能再加</span>`}
    ${at.note && html`<span class="att-note" role="status">${at.note}</span>`}
    ${noImage && count > 0 && html`<span class="att-note warn" role="status">这个模型不收图片，图会被省略</span>`}
  </div>`;
}

/** 缩略图一排。 @param {{ images: Pic[], onRemove: (i: number) => void, class?: string }} p */
export function Thumbs({ images, onRemove, class: cls = "dk-thumbs" }) {
  if (images.length === 0) return null;
  return html`<div class=${cls}>${images.map((im, i) => html`<span class="cthumb"><img src=${im.url} alt="要寄出的图片" /><button type="button" aria-label="去掉这张图片" onClick=${() => onRemove(i)}><${Icon} name="close" size=${12} sw=${3} /></button></span>`)}</div>`;
}
