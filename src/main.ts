// 入口：`tau serve` 启动服务，其余命令走 CLI。CLI 不加载服务的代码。
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "serve") {
  const { mkdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const { sqliteMemory } = await import("./memory/kv.ts");
  const { fileCredentials } = await import("./server/credentials.ts");
  const { withModelFiles } = await import("./server/modelfiles.ts");
  const { presetsDir } = await import("./presets/load.ts");
  const { toolsDir } = await import("./presets/tooldefs.ts");
  const { PIPE } = await import("./protocol.ts");
  const { serve } = await import("./server/serve.ts");
  const home = join(homedir(), ".tau");
  mkdirSync(join(home, "presets"), { recursive: true });
  const service = await serve({ pipe: PIPE, dbPath: join(home, "tau.db"), presetsDir: presetsDir(), toolsDir: toolsDir(), models: withModelFiles(builtinModels({ credentials: fileCredentials(join(home, "auth.json")) }), join(home, "models")), memory: sqliteMemory });
  console.error(`tau 服务在 ${PIPE} 上运行。按 Ctrl+C 停止。`);
  const stop = (): void => void service.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  const { main } = await import("./cli/main.ts");
  process.exitCode = await main([cmd ?? "", ...rest]);
}
