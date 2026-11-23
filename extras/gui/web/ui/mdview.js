// 助手最终文字的 Markdown 视图：marked 出 HTML（lib/markdown.js），DOMPurify 净化，再放进页面。
// “复制”按钮用事件委托，不写内联脚本（CSP 不许）。mermaid 占位块在 HTML 放进页面以后换成图（ui/mermaid.js）。
import DOMPurify from "dompurify";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { html, copyText, useFlash } from "./common.js";
import { mountDiagrams } from "./mermaid.js";
import { PURIFY_CONFIG, escapeHtml, markdownToHtml, safeHref } from "../lib/markdown.js";

DOMPurify.addHook("afterSanitizeAttributes", (/** @type {Element} */ node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    if (href !== null && safeHref(href) === null) node.removeAttribute("href");
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "INPUT") {
    node.setAttribute("type", "checkbox");
    node.setAttribute("disabled", "");
  }
});

/** 文字变成安全的 HTML。净化不可用（没有 DOM）时退回转义的纯文字。 @param {string} text */
function render(text) {
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(text)}</p>`;
  return String(DOMPurify.sanitize(markdownToHtml(text), PURIFY_CONFIG));
}

/** @param {MouseEvent} e */
function onClick(e) {
  const b = e.target instanceof Element ? e.target.closest("[data-md-copy]") : null;
  if (!(b instanceof HTMLElement)) return;
  const code = b.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
  copyText(code).then((ok) => {
    b.textContent = ok ? "已复制" : "复制失败";
    setTimeout(() => (b.textContent = "复制"), 1500);
  });
}

/** @param {{ text: string }} p */
export function Markdown({ text }) {
  const h = useMemo(() => render(text), [text]);
  const box = useRef(/** @type {HTMLElement | null} */ (null));
  // HTML 变了或卸载时，上一批图收掉；新放进来的占位块换成图。
  useLayoutEffect(() => (box.current ? mountDiagrams(box.current) : undefined), [h]);
  return html`<div class="md" ref=${box} onClick=${onClick} dangerouslySetInnerHTML=${{ __html: h }} />`;
}

/**
 * 整条回复的“复制”：复制 Markdown 原文。只在字吐完、换成 Markdown 以后放（吐字期间不放）。
 * 有指针悬停的设备上悬停才显示，键盘聚焦到它也显示；触屏一直显示（css/markdown.css）。
 * @param {{ text: string }} p
 */
export function CopyReply({ text }) {
  const [label, flash] = useFlash("复制");
  return html`<div class="reply-copy"><button type="button" class="rc" title="复制整条回复的 Markdown 原文" onClick=${() => copyText(text).then((ok) => flash(ok ? "已复制" : "复制失败"))}>${label}</button></div>`;
}
