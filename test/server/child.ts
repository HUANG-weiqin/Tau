// kill.test.ts 的子进程：在命名管道上跑真的服务。模型是 faux，回复只由上下文决定，会调用 read 和 bash。
// 用法：node test/server/child.ts <pipe> <dbPath> <presetsDir>
// 父进程用 taskkill /T /F 硬杀它，所以这里没有任何退出处理。
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { serve } from "../../src/server/serve.ts";

const [pipe, dbPath, presetsDir] = process.argv.slice(2);
if (!pipe || !dbPath || !presetsDir) throw new Error("用法：child.ts <pipe> <dbPath> <presetsDir>");

const faux = fauxProvider({ models: [{ id: "m", contextWindow: 200_000 }] });

// 先“想”40 到 400 毫秒，让杀进程也会落在模型调用里。最后一条是用户消息就调用 3 个工具，否则用文字结束本轮。
// bash 有时 sleep 0.3 秒，有时立刻结束。
const reply: FauxResponseFactory = async (context) => {
  const n = context.messages.length;
  await sleep(40 + ((n * 67) % 360));
  if (context.messages.at(-1)?.role !== "user") return fauxAssistantMessage(fauxText(`看过 ${n} 条消息，做完了。`));
  return fauxAssistantMessage(
    [
      fauxToolCall("read", { path: "a.txt" }, { id: `r${n}` }),
      fauxToolCall("bash", { command: n % 2 === 0 ? "sleep 0.3; echo slept" : "echo quick" }, { id: `b${n}` }),
      fauxToolCall("read", { path: "a.txt" }, { id: `R${n}` }),
    ],
    { stopReason: "toolUse" },
  );
};
// faux 在调用开始时就从队列里取走一步，几个进程会同时调用，所以一次放足。
faux.setResponses(Array.from({ length: 10_000 }, () => reply));
const models = createModels();
models.setProvider(faux.provider);

await serve({ pipe, dbPath, presetsDir, models, memory: sqliteMemory });

// 保险：父进程死了（标准输入关闭）就退出，不留下孤儿服务。
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
