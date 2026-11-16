// 工具结果的测试辅助：内容块和纯文本之间的转换。
import { textContent } from "../src/kernel/types.ts";
import type { ToolResultContent } from "../src/kernel/types.ts";

/** 文本的工具结果。 */
export const res = (text: string, isError = false): ToolResultContent => ({ content: textContent(text), isError });

/** 工具结果的全部文本块连起来。 */
export const textOfResult = (r: ToolResultContent): string => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** 只有文本的工具结果，摊平成 `{ text, isError }`，方便比较。 */
export const plain = (r: ToolResultContent): { text: string; isError: boolean } => {
  const texts = r.content.filter((c) => c.type === "text").length;
  if (texts !== 1) throw new Error(`工具结果应当恰有一个文本块，实际 ${texts} 个`);
  return { text: textOfResult(r), isError: r.isError };
};
