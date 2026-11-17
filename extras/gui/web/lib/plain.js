// @ts-check
// 助手文字的第一行，去掉 Markdown 标记，用在只放得下一行的地方（“正在做”、通知）。

/**
 * 去掉行首的标题、引用、列表标记，和行内的 `**`、反引号。
 * @param {string} line
 */
export function plainLine(line) {
  let s = line.trim();
  for (;;) {
    const next = s.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)/, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\*\*/g, "").replace(/`+/g, "").trim();
}

/**
 * 第一个去掉标记后不空的行。只有代码围栏、分隔线之类的行是空串。
 * @param {string} text
 */
export function plainFirstLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = plainLine(line);
    if (t !== "" && !/^[-*_=~]{3,}$/.test(t)) return t;
  }
  return "";
}
