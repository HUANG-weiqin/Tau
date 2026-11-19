// @ts-check
// 外观：界面数据的 `theme` 换成 <html> 上的属性，样式按它切令牌。取值见 docs/design/gui.md 的“夜间配色”和“VS Code 配色”。

/** 浏览器标题栏的颜色，和各自最深一层暗面一致。 */
const BAR = { day: "#0C0D0C", night: "#0A0B09", vscode: "#333333" };

/**
 * @param {string | undefined} theme 界面数据里的 `theme`
 * @param {Document} [doc]
 */
export function applyTheme(theme, doc = document) {
  const name = theme === "night" || theme === "vscode" ? theme : "day";
  if (name === "day") doc.documentElement.removeAttribute("data-theme");
  else doc.documentElement.setAttribute("data-theme", name);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[name]);
}
