import { StringDecoder } from "node:string_decoder";
// 真正的动作：调用模型、运行库外工具（见 .knowledge/kb-executor.md、.knowledge/kb-tools.md）。
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildContext } from "../kernel/context.ts";
import { outputMax } from "../kernel/derive.ts";
import { findTool, renamed, unknownTool } from "../kernel/tools.ts";
import { textContent } from "../kernel/types.ts";
import type { ProcessId } from "../kernel/types.ts";
import { resolveImages } from "../store/blobs.ts";
import { fixArgs, noted } from "../tools/args.ts";
import { bash } from "../tools/bash.ts";
import type { BashContext } from "../tools/bash.ts";
import { edit, read, write } from "../tools/files.ts";
import { runToolDef } from "../tools/tooldef.ts";
import type { Actions, Job } from "./executor.ts";

/** 模型请求在拿到成功的响应之前的重试次数，交给 pi-ai（设计稿 5.7）。 */
export const MODEL_RETRIES = 5;

/** `onText` 收到模型的流式文本和产生它的副作用编号；思考和工具调用参数的流带 `kind`，正文不带；它只是预览，不进库。`pipe` 是服务实际监听的管道名，bash 工具把它交给命令（TAU_PIPE）。`readBlob` 读 blobs 表：调用模型之前，请求里的 `blob:<hash>` 换成真数据。 */
export function createActions(models: Models, onText: (id: ProcessId, n: number, delta: string, kind?: "thinking" | "toolCall") => void, pipe: string, readBlob: (hash: string) => Buffer | undefined, onOutput: (id: ProcessId, n: number, delta: string) => void = () => {}): Actions {
  /** 命令边跑边写出来的输出（D88）：`StringDecoder` 让跨块的半个汉字不会变成替换符。 */
  const live = (job: Job, hurry?: AbortSignal): BashContext => {
    const decoder = new StringDecoder("utf8");
    return {
      process: job.process.id,
      pipe,
      ...(hurry ? { hurry } : {}),
      onData: (chunk) => {
        const delta = decoder.write(chunk);
        if (delta !== "") onOutput(job.process.id, job.effect.n, delta);
      },
    };
  };
  return {
    async callModel(job, signal) {
      const name = job.process.preset.model;
      const slash = name.indexOf("/");
      const model = models.getModel(name.slice(0, slash), name.slice(slash + 1));
      if (!model) throw new Error(`模型目录里没有 ${name}`);
      // 一次回复的总输出（含思考）不超过 cap：窗口的 1/8，换段阈值按这个数留空间（kernel/derive.ts）。
      // 模型的 maxTokens 也换成 cap：按预算思考的路径把预算加到 maxTokens 上，再按模型的 maxTokens 截。
      const { thinking, options } = job.process.preset;
      const cap = Math.min(model.maxTokens, outputMax(job.process.preset));
      // 先铺预设的 options，再铺内核自己的键：内核的键赢，快照被手改也一样。
      const o: SimpleStreamOptions = { ...options, signal, sessionId: job.process.id, maxTokens: cap, maxRetries: MODEL_RETRIES };
      if (thinking === undefined) delete (o as { reasoning?: unknown }).reasoning;
      else o.reasoning = thinking;
      const stream = models.streamSimple({ ...model, maxTokens: cap }, resolveImages(buildContext(job.process, job.segment), readBlob), o);
      for await (const e of stream) {
        if (e.type === "text_delta") onText(job.process.id, job.effect.n, e.delta);
        else if (e.type === "thinking_delta") onText(job.process.id, job.effect.n, e.delta, "thinking");
        else if (e.type === "toolcall_delta") onText(job.process.id, job.effect.n, e.delta, "toolCall");
      }
      return stream.result();
    },
    async runTool(job, call, signal, hurry) {
      const { workdir } = job.process.preset;
      // 和存储层同一个解析函数（D109）：规范名执行，段里的调用名不改。
      const tool = findTool(job.process.preset, call.name);
      if (!tool) return { content: textContent(unknownTool(job.process.preset, call.name)), isError: true };
      const def = job.process.preset.toolDefs.find((d) => d.name === tool.name);
      const fixed = fixArgs(tool, call, def === undefined);
      if ("error" in fixed) return { content: textContent(fixed.error), isError: true };
      const notes = [...renamed(call.name, tool), ...fixed.notes];
      let args;
      try {
        args = validateToolArguments(tool, { ...call, name: tool.name, arguments: fixed.args as JsonObject });
      } catch (e) {
        return { content: textContent(`参数错误：参数不合 schema（下面是校验器的原文）。\n${e instanceof Error ? e.message : String(e)}`), isError: true };
      }
      // 进程的模型收图片：read 和工具定义带图时才存图，不收时换成一行说明。
      const accepts = job.process.preset.input.includes("image");
      switch (tool.name) {
        // 路径和 edit 的兜底也把说明收进 notes，和工具名、参数的说明一起接成一行。
        case "read":
          return noted(await read(args, workdir, accepts, notes), notes);
        case "write":
          return noted(await write(args, workdir, notes), notes);
        case "edit":
          return noted(await edit(args, workdir, notes), notes);
        case "bash":
          return noted(await bash(args, workdir, signal, live(job, hurry)), notes);
        default: {
          if (!def) return { content: textContent(`工具 ${tool.name} 不由执行器运行。`), isError: true };
          return noted(await runToolDef(def, args, workdir, signal, live(job), accepts), notes);
        }
      }
    },
  };
}
