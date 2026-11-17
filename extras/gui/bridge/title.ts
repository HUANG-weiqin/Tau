// 自动标题：读进程第一封信，调一次模型概括成短标题。结果由页面存进界面数据。
import type { Models } from "@earendil-works/pi-ai";
import { firstLetterText } from "../web/lib/titles.js";
import { pipeRequest } from "./pipe.ts";
import { HttpError } from "./util.ts";

export const TITLE_MAX_CHARS = 16;
/** 给模型看的信的字数上限。 */
const LETTER_MAX_CHARS = 2000;
const MAX_TOKENS = 100;
const TIMEOUT_MS = 30_000;

export const TITLE_SYSTEM = "你给一段对话起标题。用户会给出对话的第一封信。用不超过 16 个字概括它在做什么。只输出标题本身，不加引号，不加句号，不加解释。";

/** 模型的原话整理成标题：只取第一个非空行，去掉引号和结尾标点，超长截断。空是 null。 */
export function cleanTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const t = line.replace(/^["'“”‘’「」『』《》`]+|["'“”‘’「」『』《》`]+$/g, "").replace(/[。.!！]+$/, "").trim();
  if (t === "") return null;
  return Array.from(t).slice(0, TITLE_MAX_CHARS).join("");
}

/** 第 1 段的第一条用户消息；读不到是 null。 */
async function firstUserMessage(pipe: string, id: string): Promise<unknown> {
  let first: unknown = null;
  await pipeRequest(pipe, { op: "history", process: id, segment: 1, from: 0 }, (r) => {
    if (r?.type === "message" && r.message?.role === "user") {
      first = r.message;
      return true;
    }
    if (r?.type === "error") throw new HttpError(404, String(r.message ?? "读不到这个进程"));
    return r?.type === "end";
  });
  return first;
}

export async function generateTitle(o: { pipe: string; models: Models; process: string; model: string }): Promise<string> {
  const slash = o.model.indexOf("/");
  if (slash <= 0) throw new HttpError(400, "model 要写成 供应商/模型");
  const model = o.models.getModel(o.model.slice(0, slash), o.model.slice(slash + 1));
  if (!model) throw new HttpError(422, `模型目录里没有 ${o.model}`);
  let msg: unknown;
  try {
    msg = await firstUserMessage(o.pipe, o.process);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, "连不上 tau 服务，先运行 tau serve");
  }
  if (msg === null) throw new HttpError(404, "这个进程还没有第一封信");
  const text = firstLetterText(msg).trim();
  if (text === "") throw new HttpError(422, "第一封信没有文字");
  let result;
  try {
    result = await o.models.completeSimple(
      { ...model, maxTokens: MAX_TOKENS },
      { systemPrompt: TITLE_SYSTEM, messages: [{ role: "user", content: `第一封信：\n${Array.from(text).slice(0, LETTER_MAX_CHARS).join("")}`, timestamp: Date.now() }] },
      { signal: AbortSignal.timeout(TIMEOUT_MS), maxRetries: 1 },
    );
  } catch (e) {
    throw new HttpError(502, `模型调用失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new HttpError(502, `模型调用失败：${result.errorMessage ?? result.stopReason}`);
  const title = cleanTitle(result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
  if (title === null) throw new HttpError(502, "模型没有给出标题");
  return title;
}
