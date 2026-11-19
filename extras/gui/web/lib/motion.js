// @ts-check
// 动效开关。只看界面数据的 `motion`，不看系统的“减少动画”：用户开就开，关就关（见 docs/design/gui.md 第 9 节）。
// 开关落在 <html data-motion="off"> 上：样式按这个属性停掉动画和过渡，脚本这边读同一个属性。

/** 开关关着时 <html> 上的属性值。 */
const OFF = "off";

/**
 * 动效开着没有。没设过属性就是开着。
 * @param {Document} [doc]
 */
export function motionOn(doc = document) {
  return doc.documentElement.getAttribute("data-motion") !== OFF;
}

/**
 * 把开关落到 <html> 上；开着时去掉属性，CSS 不用写默认值。
 * @param {boolean} on
 * @param {Document} [doc]
 */
export function applyMotion(on, doc = document) {
  if (on) doc.documentElement.removeAttribute("data-motion");
  else doc.documentElement.setAttribute("data-motion", OFF);
}
