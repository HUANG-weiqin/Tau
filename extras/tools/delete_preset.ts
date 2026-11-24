// delete_preset：删除 ~/.tau/presets/<id>.md（kb-extras 的“工具库”）。只删预设文件，记忆库保留不动；有正在运行的进程时拒绝。
import { readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { talk } from "./client.ts";
import { Fail, note, readArgs, refuseUnknown, run, takeArgs, tauEnv } from "./common.ts";
import { checkPresetId, isPresetId, presetIdOf, presetsDir } from "./presets.ts";

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function deletePreset(
  rawArgs: Record<string, unknown>,
  opts: { tauHome: string; pipe: string; proc?: string },
): Promise<string> {
  const { args, unknown } = takeArgs("delete_preset", rawArgs);
  const shown = typeof args.id === "string" ? args.id.trim() : "";
  refuseUnknown("delete_preset", unknown, `delete_preset 没有预演、确认这类开关：去掉 ${unknown.join("、")} 就会真删${shown === "" ? "预设" : ` ${shown}`}，找不回。只想看有哪些预设，调 list_presets {}；确实要删，再调 delete_preset ${JSON.stringify({ id: shown === "" ? "<预设 ID>" : shown })}。`);
  const dir = presetsDir(opts.tauHome);
  const names = readNames(dir);
  // 精确的 <id>.md 在就用它；否则去掉 .md、取预设目录下路径的文件名，得到的 <新>.md 在就用它。都不在用原值。
  const raw = typeof args.id === "string" ? args.id.trim() : args.id;
  const guess = typeof raw === "string" ? presetIdOf(raw, dir) : raw;
  const id = checkPresetId(typeof raw === "string" && !names.includes(`${raw}.md`) && typeof guess === "string" && names.includes(`${guess}.md`) ? guess : raw);
  if (id !== args.id) note(`id ${String(args.id)} 当作 ${id}`);

  const fileName = `${id}.md`;
  if (!names.includes(fileName)) {
    const ci = names.find((n) => n.toLowerCase() === fileName.toLowerCase());
    if (ci !== undefined) throw new Fail(`找不到预设 ${id}（目录里有 ${ci}，预设 ID 区分大小写）。要删它：delete_preset ${JSON.stringify({ id: ci.slice(0, -3) })}`);
    // 要的结果（这个预设不在）已经成立：算成功，列出现有的，拼错了看得出来。
    const have = names.filter((n) => n.endsWith(".md") && isPresetId(n.slice(0, -3))).map((n) => n.slice(0, -3)).sort();
    return `没有预设 ${id}，什么都没删。${have.length === 0 ? "现在没有预设。" : `现有的预设：${have.join("、")}。`}`;
  }

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
    const ids = running.map((p) => String(p.self.id));
    const mine = opts.proc !== undefined && ids.includes(opts.proc);
    throw new Fail(
      `预设 ${id} 还有正在运行的进程：${ids.map((x) => (x === opts.proc ? `${x}（你自己）` : x)).join("、")}。` +
        (mine ? "不能删自己正在用的预设；需要的话，请用户在界面里删。" : "现在删不了：等它们结束再删，或者请用户决定。"),
    );
  }

  const file = path.join(dir, fileName);
  try {
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return `没有预设 ${id}，什么都没删。`;
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
    const { proc, pipe } = tauEnv();
    const args = await readArgs();
    const out = await deletePreset(args, { tauHome: path.join(homedir(), ".tau"), pipe, proc });
    process.stdout.write(`${out}\n`);
  });
}
