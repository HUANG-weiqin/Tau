// 真正的动作：调用模型、运行库外工具（设计稿第 6 节、第 10 节）。
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { buildContext, toolDefinitions } from "../kernel/context.ts";
import { outputMax } from "../kernel/derive.ts";
import type { ProcessId } from "../kernel/types.ts";
import { bash } from "../tools/bash.ts";
import { edit, read, write } from "../tools/files.ts";
import type { Actions } from "./executor.ts";

/** `onText` 收到模型的流式文本；它只是预览，不进库。 */
export function createActions(models: Models, onText: (id: ProcessId, delta: string) => void): Actions {
  return {
    async callModel(job, signal) {
      const name = job.process.preset.model;
      const slash = name.indexOf("/");
      const model = models.getModel(name.slice(0, slash), name.slice(slash + 1));
      if (!model) throw new Error(`模型目录里没有 ${name}`);
      // 输出上限不超过窗口的 1/8：换段阈值按这个数留空间（kernel/derive.ts）。
      const maxTokens = Math.min(model.maxTokens, outputMax(job.process.preset));
      const stream = models.streamSimple(model, buildContext(job.process, job.segment), { signal, sessionId: job.process.id, maxTokens });
      for await (const e of stream) if (e.type === "text_delta") onText(job.process.id, e.delta);
      return stream.result();
    },
    async runTool(job, call, signal) {
      const { workdir } = job.process.preset;
      const tool = toolDefinitions(job.process.preset).find((t) => t.name === call.name);
      if (!tool) return { text: `工具 ${call.name} 不存在，或者预设里没有它。`, isError: true };
      let args;
      try {
        args = validateToolArguments(tool, call);
      } catch (e) {
        return { text: `参数错误：${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      switch (call.name) {
        case "read":
          return read(args, workdir);
        case "write":
          return write(args, workdir);
        case "edit":
          return edit(args, workdir);
        case "bash":
          return bash(args, workdir, signal);
        default:
          return { text: `工具 ${call.name} 不由执行器运行。`, isError: true };
      }
    },
  };
}
