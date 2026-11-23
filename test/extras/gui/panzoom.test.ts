import assert from "node:assert/strict";
import { test } from "node:test";
import { centerAt, centerOn, covers, cycle, errorText, exportName, exportScale, fitHeight, fitView, LIMITS, matchIndexes, miniFit, panBy, parseViewBox, pinch, sizedSvg, unsupportedType, visibleRect, zoomAt } from "../../../extras/gui/web/lib/panzoom.js";
import { markdownToHtml } from "../../../extras/gui/web/lib/markdown.js";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} 应接近 ${b}`);

test("适应：居中，留白，小图不放大，没有尺寸时回原样", () => {
  const v = fitView({ w: 400, h: 200 }, { w: 800, h: 400 }, 0, 1);
  assert.deepEqual(v, { x: 200, y: 100, k: 1 });
  const big = fitView({ w: 2000, h: 500 }, { w: 1000, h: 600 }, 20, 1);
  near(big.k, 0.48);
  near(big.x, 20);
  near(big.y, (600 - 500 * 0.48) / 2);
  assert.equal(fitView({ w: 100, h: 100 }, { w: 1000, h: 1000 }, 0, 2).k, 2);
  assert.deepEqual(fitView({ w: 0, h: 10 }, { w: 100, h: 100 }), { x: 0, y: 0, k: 1 });
  assert.deepEqual(fitView({ w: 10, h: 10 }, { w: 0, h: 0 }), { x: 0, y: 0, k: 1 });
});

test("卡片高度：按栏宽适应后的图高，限在 160 到 480", () => {
  assert.equal(fitHeight({ w: 400, h: 100 }, 800, { pad: 0 }), 160);
  assert.equal(fitHeight({ w: 400, h: 300 }, 800, { pad: 0 }), 300);
  assert.equal(fitHeight({ w: 400, h: 2000 }, 800, { pad: 0 }), 480);
  // 图比栏宽，先缩到栏宽：1600×800 在 800 宽里是 400 高。
  assert.equal(fitHeight({ w: 1600, h: 800 }, 800, { pad: 0 }), 400);
  assert.equal(fitHeight({ w: 1600, h: 800 }, 0), 160);
});

test("以点为中心缩放：那个点下面的内容不动；带上下限", () => {
  const v = { x: 30, y: -10, k: 1 };
  const p = { x: 200, y: 120 };
  const z = zoomAt(v, p, 2);
  assert.equal(z.k, 2);
  // 内容点在缩放前后落在同一个屏幕位置。
  near((p.x - v.x) / v.k, (p.x - z.x) / z.k);
  near((p.y - v.y) / v.k, (p.y - z.y) / z.k);
  assert.equal(zoomAt(v, p, 1000).k, LIMITS.max);
  assert.equal(zoomAt(v, p, 0.0001).k, LIMITS.min);
});

test("平移，视图对应的内容区域", () => {
  const v = panBy({ x: 10, y: 20, k: 2 }, 5, -5);
  assert.deepEqual(v, { x: 15, y: 15, k: 2 });
  assert.deepEqual(visibleRect({ x: -100, y: -50, k: 2 }, { w: 400, h: 200 }), { x: 50, y: 25, w: 200, h: 100 });
});

test("把矩形移到中间：比例至少是 minK，已经更大就不缩小", () => {
  const rect = { x: 100, y: 50, w: 40, h: 20 };
  const vp = { w: 800, h: 400 };
  const a = centerOn({ x: 0, y: 0, k: 0.3 }, rect, vp, 1);
  assert.equal(a.k, 1);
  near(a.x + 120 * a.k, 400);
  near(a.y + 60 * a.k, 200);
  const b = centerOn({ x: 0, y: 0, k: 2.5 }, rect, vp, 1);
  assert.equal(b.k, 2.5);
  near(b.x + 120 * b.k, 400);
  const c = centerAt({ x: 0, y: 0, k: 2 }, 300, 100, vp);
  assert.deepEqual(c, { x: -200, y: 0, k: 2 });
});

test("整张图都在视野里：小地图不显示", () => {
  const content = { w: 500, h: 300 };
  assert.equal(covers(visibleRect({ x: 0, y: 0, k: 1 }, { w: 600, h: 400 }), content), true);
  assert.equal(covers(visibleRect({ x: -10, y: 0, k: 1 }, { w: 600, h: 400 }), content), false);
  assert.equal(covers(visibleRect({ x: 0, y: 0, k: 2 }, { w: 600, h: 400 }), content), false);
  assert.deepEqual(miniFit({ w: 1000, h: 500 }, 200, 140), { w: 200, h: 100, s: 0.2 });
  assert.equal(miniFit({ w: 100, h: 50 }, 200, 140).s, 1);
});

test("双指：比例跟距离，中点下的内容点跟着中点", () => {
  const v0 = { x: 10, y: 20, k: 1 };
  const a0 = { x: 100, y: 100 };
  const b0 = { x: 200, y: 100 };
  const same = pinch(v0, a0, b0, a0, b0);
  near(same.x, 10);
  near(same.k, 1);
  const out = pinch(v0, a0, b0, { x: 50, y: 100 }, { x: 250, y: 100 });
  near(out.k, 2);
  // 按下时中点 (150,100) 下的内容点，现在在新的中点 (150,100)。
  const c = { x: (150 - v0.x) / v0.k, y: (100 - v0.y) / v0.k };
  near(out.x + c.x * out.k, 150);
  near(out.y + c.y * out.k, 100);
  assert.equal(pinch(v0, a0, b0, { x: 0, y: 0 }, { x: 1e6, y: 0 }).k, LIMITS.max);
});

test("搜索：不分大小写的子串，空查询没有匹配；转一圈", () => {
  const texts = ["Start", "Check Cache", "cache miss", "Done"];
  assert.deepEqual(matchIndexes(texts, "CACHE"), [1, 2]);
  assert.deepEqual(matchIndexes(texts, "  "), []);
  assert.deepEqual(matchIndexes(texts, "zzz"), []);
  assert.equal(cycle(-1, 3, 1), 0);
  assert.equal(cycle(-1, 3, -1), 2);
  assert.equal(cycle(2, 3, 1), 0);
  assert.equal(cycle(0, 3, -1), 2);
  assert.equal(cycle(0, 0, 1), -1);
});

test("存图的比例：默认 2 倍，最长边和总像素超了按比例缩小", () => {
  assert.equal(exportScale(400, 300), 2);
  assert.equal(exportScale(10000, 100), 1.2);
  // 8000×8000：最长边允许 1.5 倍，总像素 5000 万允许 0.97 倍，取小的。
  const s = exportScale(8000, 8000);
  near(s, Math.sqrt(50_000_000 / 64_000_000));
  assert.ok(8000 * s * 8000 * s <= 50_000_000 + 1);
  assert.ok(exportScale(20000, 20000) < 1);
  assert.equal(exportScale(0, 5), 1);
});

test("存图的文件名", () => {
  assert.equal(exportName(new Date(2026, 10, 23, 9, 5, 7)), "mermaid-20261123-090507.png");
});

test("viewBox 和给根 svg 写宽高", () => {
  const svg = '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 300px; background-color: white;" viewBox="0 0 300 120.5" role="graphics-document"><g>a&nbsp;b</g><rect stroke-width="2" height="3"/></svg>';
  assert.deepEqual(parseViewBox(svg), { x: 0, y: 0, w: 300, h: 120.5 });
  assert.equal(parseViewBox("<svg></svg>"), null);
  assert.equal(parseViewBox('<svg viewBox="0 0 0 5"></svg>'), null);
  const out = sizedSvg(svg, 600, 241);
  assert.match(out, /^<svg width="600" height="241" /);
  assert.ok(!out.includes("max-width"));
  assert.ok(!out.includes('width="100%"'));
  assert.ok(out.includes('viewBox="0 0 300 120.5"'));
  assert.ok(out.includes('stroke-width="2" height="3"'), "子元素的属性不动");
  assert.ok(out.includes("a&#160;b"));
  // 缺 xmlns 就补上。
  assert.ok(sizedSvg('<svg viewBox="0 0 1 1"></svg>', 1, 1).includes('xmlns="http://www.w3.org/2000/svg"'));
});

test("Markdown：mermaid 代码块是带属性的占位块，源码转义；别的语言照旧", () => {
  const h = markdownToHtml("```mermaid\ngraph TD\nA[<b>x</b>] --> B\n```\n");
  assert.ok(h.includes('<div class="md-mermaid" data-md-mermaid>'));
  assert.ok(h.includes("A[&lt;b&gt;x&lt;/b&gt;] --&gt; B"));
  assert.ok(!h.includes("data-md-copy"));
  assert.ok(markdownToHtml("```Mermaid\ngraph TD\n```").includes("data-md-mermaid"));
  const js = markdownToHtml("```js\nx\n```");
  assert.ok(js.includes("data-md-copy") && !js.includes("data-md-mermaid"));
});

test("存图：图里有 xlink: 而根上没声明，补 xmlns:xlink；已声明的不重复", () => {
  const bare = '<svg viewBox="0 0 1 1"><a xlink:href="https://x.test"><text>a</text></a></svg>';
  assert.ok(sizedSvg(bare, 1, 1).includes('xmlns:xlink="http://www.w3.org/1999/xlink"'));
  const has = '<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>';
  assert.equal(sizedSvg(has, 1, 1).split("xmlns:xlink").length - 1, 1);
  assert.ok(!sizedSvg('<svg viewBox="0 0 1 1"></svg>', 1, 1).includes("xlink"));
});

test("报错文字：保留换行和行首空格，去头尾空行，最多 8 行", () => {
  const msg = "\nParse error on line 2:\n...ph TD\n  A -->\n----------^\nExpecting 'X', got 'Y'\n\n";
  assert.equal(errorText(msg), "Parse error on line 2:\n...ph TD\n  A -->\n----------^\nExpecting 'X', got 'Y'");
  const long = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
  assert.equal(errorText(long).split("\n").length, 9);
  assert.ok(errorText(long).endsWith("\n…"));
  assert.equal(errorText("  \n "), "未知错误");
});

test("精简版画不了的图：按第一行有效内容认出，跳过空行、注释、init 指令和 frontmatter", () => {
  assert.equal(unsupportedType("mindmap\n  root"), "mindmap");
  assert.equal(unsupportedType("architecture-beta\n  group api(cloud)[API]"), "architecture-beta");
  assert.equal(unsupportedType("architecture\n x"), "architecture");
  assert.equal(unsupportedType("\n\n%% 注释\n  Mindmap\n root"), "mindmap");
  assert.equal(unsupportedType("---\ntitle: x\nconfig:\n  theme: dark\n---\nmindmap\n root"), "mindmap");
  assert.equal(unsupportedType('%%{init: {"theme": "dark"}}%%\nmindmap\n root'), "mindmap");
  assert.equal(unsupportedType("%%{init: {\n  \"theme\": \"dark\"\n}}%%\narchitecture-beta"), "architecture-beta");
  assert.equal(unsupportedType("\uFEFFmindmap"), "mindmap");
  // 认得出的图、名字只是前缀、frontmatter 没结束，都不算。
  assert.equal(unsupportedType("graph TD\n A --> B"), null);
  assert.equal(unsupportedType("flowchart LR\n mindmap --> A"), null);
  assert.equal(unsupportedType("mindmapper"), null);
  assert.equal(unsupportedType("---\ntitle: mindmap"), null);
  assert.equal(unsupportedType(""), null);
});
