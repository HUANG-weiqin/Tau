// delete_preset：删除 ~/.tau/presets/<id>.md（kb-extras 的“工具库”）。只删预设文件，记忆库保留不动；有正在运行的进程时拒绝。
import { readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { talk } from "./client.ts";
import { Fail, readArgs, run, tauEnv } from "./common.ts";
import { checkPresetId, presetsDir } from "./presets.ts";

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function deletePreset(
  args: Record<string, unknown>,
  opts: { tauHome: string; pipe: string },
): Promise<string> {
  const id = checkPresetId(args.id);

  const state: { procs: any[] | null; protoErr: string | null } = { procs: null, protoErr: null };
  const ok = await talk(opts.pipe, { op: "ps" }, (r) => {
    if (r.type === "ps" && Array.isArray(r.processes)) {
      state.procs = r.processes;
      return true;
    }
    if (r.type === "error") {
      state.protoErr = String(r.message);
      return true;
    }
    return false;
  });
  if (state.protoErr !== null) throw new Fail(`查询进程列表失败：${state.protoErr}`);
  if (!ok || state.procs === null) throw new Fail("查询进程列表时 tau 服务断开了连接。");

  const samePreset = state.procs.filter((p) => p?.self?.preset === id);
  const running = samePreset.filter((p) => p?.self?.phase?.tag !== "idle");
  if (running.length > 0) {
    const ids = running.map((p) => String(p.self.id)).join("、");
    throw new Fail(`预设 ${id} 还有正在运行的进程（${ids}），不能删除。请先停止它们。`);
  }

  const dir = presetsDir(opts.tauHome);
  const fileName = `${id}.md`;
  const names = readNames(dir);
  if (!names.includes(fileName)) {
    const ci = names.find((n) => n.toLowerCase() === fileName.toLowerCase());
    if (ci !== undefined) throw new Fail(`找不到预设 ${id}（目录里只有 ${ci}，预设 ID 区分大小写）。`);
    throw new Fail(`找不到预设：${id}`);
  }

  const file = path.join(dir, fileName);
  try {
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Fail(`找不到预设：${id}`);
    throw e;
  }

  const idle = samePreset.filter((p) => p?.self?.phase?.tag === "idle");
  const lines = [`已删除预设 ${id}（${file}）。记忆库保留不动；以后用同 ID 重建预设时仍在。`];
  if (idle.length > 0) {
    lines.push(`已有 ${idle.length} 个已结束的历史进程（${idle.map((p) => String(p.self.id)).join("、")}）仍保留各自出生时的会话快照，不受影响。`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  run(async () => {
    const { pipe } = tauEnv();
    const args = await readArgs();
    const out = await deletePreset(args, { tauHome: path.join(homedir(), ".tau"), pipe });
    process.stdout.write(`${out}\n`);
  });
}
