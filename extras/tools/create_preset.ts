// create_preset：在 ~/.tau/presets/<id>.md 新建预设并向服务发 check 验证（kb-extras 的“工具库”）。不导入 src/。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CATALOG, definitionOf } from "./catalog.ts";
import { talk } from "./client.ts";
import { Fail, readArgs, run, tauEnv } from "./common.ts";
import { checkPresetId, isAbsoluteWinPath, presetsDir } from "./presets.ts";

const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CONTEXT_MAX_ITEMS = 8;
const CONTEXT_MAX_CHARS = 260;

export interface CreateFields {
  id: string;
  workdir: string;
  model: string;
  tools: string[];
  prompt: string;
  thinking?: string;
  handoff?: number;
  options?: Record<string, unknown>;
  context?: string[];
}

function singleLine(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || /[\r\n]/.test(v)) throw new Fail(`${name} 必须是单行的非空字符串。`);
  return v.trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验并规范化新建预设的参数。 */
export function parseCreateArgs(args: Record<string, unknown>): CreateFields {
  const id = checkPresetId(args.id);
  const workdir = singleLine("workdir", args.workdir);
  if (!isAbsoluteWinPath(workdir)) throw new Fail("workdir 必须是 Windows 绝对路径。");
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new Fail(`workdir 不是存在的目录：${workdir}`);
  }
  const model = singleLine("model", args.model);
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new Fail("model 格式应为 <provider>/<model-id>。");
  if (!Array.isArray(args.tools) || args.tools.some((t) => typeof t !== "string" || !TOOL_NAME.test(t))) {
    throw new Fail("tools 必须是合法工具名的数组。");
  }
  const tools = [...new Set(args.tools as string[])];
  if (typeof args.prompt !== "string") throw new Fail("prompt 必须是字符串。");

  let thinking: string | undefined;
  if (args.thinking !== undefined) {
    if (typeof args.thinking !== "string" || !THINKING.includes(args.thinking)) {
      throw new Fail(`thinking 只能是 ${THINKING.join("、")}。`);
    }
    thinking = args.thinking;
  }

  let handoff: number | undefined;
  if (args.handoff !== undefined) {
    const n = args.handoff;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || String(n).length > 15) {
      throw new Fail("handoff 必须是正整数（token）。");
    }
    handoff = n;
  }

  let options: Record<string, unknown> | undefined;
  if (args.options !== undefined) {
    if (!isObject(args.options)) throw new Fail("options 必须是 JSON 对象。");
    options = args.options;
  }

  let context: string[] | undefined;
  if (args.context !== undefined) {
    if (!Array.isArray(args.context) || args.context.some((x) => typeof x !== "string")) {
      throw new Fail("context 必须是路径字符串数组。");
    }
    const items = [...new Set((args.context as string[]).map((x) => x.trim()).filter((x) => x !== ""))];
    if (items.length > CONTEXT_MAX_ITEMS) throw new Fail(`context 最多 ${CONTEXT_MAX_ITEMS} 项。`);
    if (items.some((x) => x.length > CONTEXT_MAX_CHARS || /[\u0000-\u001f\u007f,]/.test(x))) {
      throw new Fail(`context 每项最长 ${CONTEXT_MAX_CHARS} 个字符，不能有逗号或控制字符。`);
    }
    if (items.length > 0) context = items;
  }

  return { id, workdir, model, tools, prompt: args.prompt, thinking, handoff, options, context };
}

/** 渲染成标准预设 Markdown 文本。 */
export function formatPresetMarkdown(f: CreateFields): string {
  const head = [
    `workdir: ${f.workdir}`,
    `model: ${f.model}`,
    `tools: ${f.tools.join(", ")}`,
    ...(f.thinking === undefined ? [] : [`thinking: ${f.thinking}`]),
    ...(f.handoff === undefined ? [] : [`handoff: ${f.handoff}`]),
    ...(f.options === undefined ? [] : [`options: ${JSON.stringify(f.options)}`]),
    ...(f.context === undefined || f.context.length === 0 ? [] : [`context: ${f.context.join(", ")}`]),
  ];
  return `---\n${head.join("\n")}\n---\n${f.prompt.trim()}\n`;
}

/** 引用了工具库里的工具而 `tools/` 下还没有时先装上；已有的不动。 */
export function ensureLibraryTools(tauHome: string, tools: readonly string[], libDir: string): void {
  const dir = path.join(tauHome, "tools");
  for (const name of tools) {
    const entry = CATALOG.find((c) => c.name === name);
    if (entry === undefined) continue;
    const target = path.join(dir, `${entry.name}.json`);
    if (existsSync(target)) continue;
    if (/["$`]/.test(libDir)) throw new Fail(`工具库路径含有引号、$ 或反引号，写不进工具定义：${libDir}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(target, `${JSON.stringify(definitionOf(entry, libDir), null, 2)}\n`, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function createPreset(
  args: Record<string, unknown>,
  opts: { tauHome: string; pipe: string; libDir: string },
): Promise<string> {
  const fields = parseCreateArgs(args);
  const dir = presetsDir(opts.tauHome);
  const existing = readNames(dir).find((n) => n.toLowerCase() === `${fields.id}.md`.toLowerCase());
  if (existing !== undefined) {
    throw new Fail(`预设已存在（${existing}），不覆盖。要替换请先用 delete_preset 删除，或换一个 ID。`);
  }

  ensureLibraryTools(opts.tauHome, fields.tools, opts.libDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fields.id}.md`);
  try {
    writeFileSync(file, formatPresetMarkdown(fields), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Fail(`预设已存在：${fields.id}`);
    throw e;
  }

  const state: { checked: { snapshot?: any; error: string | null } | null; protoErr: string | null } = { checked: null, protoErr: null };
  try {
    const ok = await talk(opts.pipe, { op: "check", preset: fields.id }, (r) => {
      if (r.type === "check") {
        state.checked = { snapshot: r.snapshot, error: typeof r.error === "string" ? r.error : null };
        return true;
      }
      if (r.type === "error") {
        state.protoErr = String(r.message);
        return true;
      }
      return false;
    });
    if (!ok && state.checked === null && state.protoErr === null) state.protoErr = "tau 服务在回复 check 前断开了连接。";
  } catch (e) {
    state.protoErr = e instanceof Error ? e.message : String(e);
  }

  const failMsg = state.protoErr ?? state.checked?.error ?? null;
  if (failMsg !== null) {
    try {
      unlinkSync(file);
    } catch {
      // ignore rollback unlink errors
    }
    throw new Fail(`预设校验失败，已撤回 ${fields.id}.md：${failMsg}`);
  }

  const snap = state.checked?.snapshot;
  const toolList = fields.tools.length === 0 ? "（仅 self、handoff）" : fields.tools.join(", ");
  const win = typeof snap?.contextWindow === "number" ? `（上下文窗口 ${snap.contextWindow}）` : "";
  return [
    `已创建并校验预设 ${fields.id}（${file}）：`,
    `model ${fields.model}${win}；tools ${toolList}；workdir ${fields.workdir}`,
  ].join("\n");
}

if (import.meta.main) {
  run(async () => {
    const { pipe } = tauEnv();
    const args = await readArgs();
    const tauHome = path.join(homedir(), ".tau");
    const libDir = import.meta.dirname.replace(/\\/g, "/");
    const out = await createPreset(args, { tauHome, pipe, libDir });
    process.stdout.write(`${out}\n`);
  });
}
