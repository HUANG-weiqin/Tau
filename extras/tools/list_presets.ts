// list_presets：列出 ~/.tau/presets 里的预设，给 spawn 选（kb-extras 的“工具库”）。只读文件，不连服务。
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { cut, readArgs, run } from "./common.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUMMARY_CHARS = 120;

export interface Row {
  id: string;
  model: string;
  tools: string;
  workdir: string;
  /** 正文第一个非空行：预设作者写的“你是谁”。 */
  summary: string;
}

/** 一个预设文件读成一行。格式不对也不抛：缺的字段写“?”，这样 spawn 之前就能看出来它会失败。 */
export function summarize(id: string, text: string): Row {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const head = new Map<string, string>();
  for (const line of end < 0 ? [] : lines.slice(1, end)) {
    const i = line.indexOf(":");
    if (i > 0) head.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const body = (end < 0 ? lines : lines.slice(end + 1)).find((l) => l.trim() !== "") ?? "";
  return { id, model: head.get("model") ?? "?", tools: head.get("tools") ?? "?", workdir: head.get("workdir") ?? "?", summary: cut(body.trim(), SUMMARY_CHARS) };
}

export function format(rows: Row[]): string {
  if (rows.length === 0) return "没有预设。";
  const out = [`共 ${rows.length} 个预设。spawn 的 preset 填下面的 ID：`];
  for (const r of rows) out.push(`- ${r.id}：${r.summary === "" ? "（正文是空的）" : r.summary}`, `  model ${r.model}；tools ${r.tools}；workdir ${r.workdir}`);
  return out.join("\n");
}

export async function listPresets(dir: string): Promise<Row[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".md") && ID.test(n.slice(0, -3))).sort();
  return Promise.all(names.map(async (n) => summarize(n.slice(0, -3), await readFile(path.join(dir, n), "utf8"))));
}

if (import.meta.main) {
  run(async () => {
    await readArgs();
    const rows = await listPresets(path.join(homedir(), ".tau", "presets")).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    process.stdout.write(`${format(rows)}\n`);
  });
}
