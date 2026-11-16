// 真正的动作：调用模型、运行库外工具（见 .knowledge/kb-executor.md、.knowledge/kb-tools.md）。
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { buildContext, toolDefinitions } from "../kernel/context.ts";
import { outputMax } from "../kernel/derive.ts";
import { textContent } from "../kernel/types.ts";
import type { ProcessId } from "../kernel/types.ts";
import { bash } from "../tools/bash.ts";
import { edit, read, write } from "../tools/files.ts";
import type { Actions } from "./executor.ts";

/** 模型请求在拿到成功的响应之前的重试次数，交给 pi-ai（设计稿 5.7）。 */
export const MODEL_RETRIES = 5;

/** `onText` 收到模型的流式文本；它只是预览，不进库。`pipe` 是服务实际监听的管道名，bash 工具把它交给命令（TAU_PIPE）。 */
export function createActions(models: Models, onText: (id: ProcessId, delta: string) => void, pipe: string): Actions {
  return {
    async callModel(job, signal) {
      const name = job.process.preset.model;
      const slash = name.indexOf("/");
      const model = models.getModel(name.slice(0, slash), name.slice(slash + 1));
      if (!model) throw new Error(`模型目录里没有 ${name}`);
      // 一次回复的总输出（含思考）不超过 cap：窗口的 1/8，换段阈值按这个数留空间（kernel/derive.ts）。
      // 模型的 maxTokens 也换成 cap：按预算思考的路径把预算加到 maxTokens 上，再按模型的 maxTokens 截。
      const { thinking } = job.process.preset;
      const cap = Math.min(model.maxTokens, outputMax(job.process.preset));
      const stream = models.streamSimple({ ...model, maxTokens: cap }, buildContext(job.process, job.segment), {
        signal,
        sessionId: job.process.id,
        maxTokens: cap,
        maxRetries: MODEL_RETRIES,
        ...(thinking === undefined ? {} : { reasoning: thinking }),
      });
      for await (const e of stream) if (e.type === "text_delta") onText(job.process.id, e.delta);
      return stream.result();
    },
    async runTool(job, call, signal) {
      const { workdir } = job.process.preset;
      const tool = toolDefinitions(job.process.preset).find((t) => t.name === call.name);
      if (!tool) return { content: textContent(`工具 ${call.name} 不存在，或者预设里没有它。`), isError: true };
      let args;
      try {
        args = validateToolArguments(tool, call);
      } catch (e) {
        return { content: textContent(`参数错误：${e instanceof Error ? e.message : String(e)}`), isError: true };
      }
      switch (call.name) {
        case "read":
          return read(args, workdir);
        case "write":
          return write(args, workdir);
        case "edit":
          return edit(args, workdir);
        case "bash":
          return bash(args, workdir, signal, { process: job.process.id, pipe });
        default:
          return { content: textContent(`工具 ${call.name} 不由执行器运行。`), isError: true };
      }
    },
  };
}
