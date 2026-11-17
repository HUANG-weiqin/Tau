// 助手最终文字的 Markdown 视图：marked 出 HTML（lib/markdown.js），DOMPurify 净化，再放进页面。
// “复制”按钮用事件委托，不写内联脚本（CSP 不许）。
import DOMPurify from "dompurify";
import { useMemo } from "preact/hooks";
import { html } from "./common.js";
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
  const say = (/** @type {string} */ s) => {
    b.textContent = s;
    setTimeout(() => (b.textContent = "复制"), 1500);
  };
  // 不是安全上下文时没有 navigator.clipboard。
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(code))
    .then(
      () => say("已复制"),
      () => say("复制失败"),
    );
}

/** @param {{ text: string }} p */
export function Markdown({ text }) {
  const h = useMemo(() => render(text), [text]);
  return html`<div class="md" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: h }} />`;
}
