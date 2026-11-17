// @ts-check
// 助手文字的 Markdown：文本 → HTML 字符串。纯函数，不碰 DOM，净化在 ui/mdview.js 里做。
// 原始 HTML 一律按文字转义；链接只认 http、https、mailto；图片不加载，显示成链接。
import { Marked } from "marked";

/** @param {string} s */
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * 可以放进 `href` 的地址：http、https、mailto。其余（javascript、data、相对路径）回 null。
 * @param {string} href @returns {string | null}
 */
export function safeHref(href) {
  const s = href.trim();
  if (/[\u0000- \u007f-\u009f]/.test(s)) return null;
  return /^(?:https?:\/\/|mailto:)[^\s]+$/i.test(s) ? s : null;
}

/** 语言标签：只留短的字母数字，其余不显示。 @param {string | undefined} lang */
function langOf(lang) {
  const w = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,20}$/.test(w) ? w : "";
}

/** @param {string} href @param {string | null | undefined} title @param {string} inner */
function anchor(href, title, inner) {
  const safe = safeHref(href);
  if (safe === null) return inner;
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    html: (t) => escapeHtml(t.text),
    link(t) {
      return anchor(t.href, t.title, this.parser.parseInline(t.tokens));
    },
    image: (t) => anchor(t.href, t.title, escapeHtml(t.text || t.href)),
    code(t) {
      const lang = langOf(t.lang);
      const head = `<div class="md-ch"><span class="md-lang">${escapeHtml(lang)}</span><button type="button" class="md-copy" data-md-copy>复制</button></div>`;
      return `<div class="md-code">${head}<pre><code>${escapeHtml(t.text)}</code></pre></div>\n`;
    },
  },
});

/**
 * Markdown 变成 HTML 字符串（还没净化）。解析出错时退回转义的纯文字。
 * 表格外面套一层，窄屏横向滚动在里面，不撑破消息流。原始 HTML 已经被转义，所以输出里的 `<table>` 都是自己生成的。
 * @param {string} text
 */
export function markdownToHtml(text) {
  try {
    const out = marked.parse(text, { async: false });
    return out.replace(/<table>/g, '<div class="md-tw"><table>').replace(/<\/table>/g, "</table></div>");
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

/** 净化只放行这些标签和属性。href 的协议由 ui/mdview.js 的钩子再查一遍（DOMPurify 自带的协议表更宽）。 */
export const PURIFY_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "a", "table", "thead", "tbody", "tr", "th", "td", "input", "div", "span", "button"],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "type", "checked", "disabled", "class", "data-md-copy", "align", "start"],
  ALLOW_DATA_ATTR: false,
};
