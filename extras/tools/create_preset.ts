// create_preset：在 ~/.tau/presets/<id>.md 新建预设并向服务发 check 验证（kb-extras 的“工具库”）。不导入 src/。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CATALOG, definitionOf } from "./catalog.ts";
import { talk } from "./client.ts";
import { Fail, note, readArgs, refuseUnknown, run, takeArgs, tauEnv } from "./common.ts";
import { checkPresetId, forward, isAbsoluteWinPath, presetIdOf, presetsDir, winPathOf } from "./presets.ts";

const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CONTEXT_MAX_ITEMS = 8;
const CONTEXT_MAX_CHARS = 260;
const BUILTIN = ["read", "write", "edit", "bash", "memory", "agents"];
/** 内核的工具按组给：这些名字单独写会撞“和内置工具或工具组重名”。 */
const GROUP_OF: Record<string, string> = { memory_get: "memory", memory_set: "memory", memory_edit: "memory", memory_delete: "memory", post: "agents", spawn: "agents", stop_process: "agents" };
const SEARCH_TOOLS = ["grep", "glob", "ls", "find", "list_files", "search_files"];

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

/** 规整用的环境：家目录、调用者的工作目录（相对路径按它解析）、工具定义目录、预设目录。 */
export interface Env {
  home: string;
  cwd: string;
  toolsDir: string;
  presetsDir: string;
}

function defaultEnv(): Env {
  const home = homedir();
  return { home, cwd: process.cwd(), toolsDir: path.join(home, ".tau", "tools"), presetsDir: presetsDir() };
}

function singleLine(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || /[\r\n]/.test(v)) throw new Fail(`${name} 必须是单行的非空字符串。`);
  return v.trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** workdir 不是存在的目录：是文件就说是文件，否则列出最近存在的上级里的目录，让模型照抄正确的路径。不给 mkdir：拼错的路径会建出空目录。 */
function missingDir(p: string): string {
  try {
    if (statSync(p).isFile()) return `workdir 不是目录，是文件：${p}`;
  } catch {
    // 不存在：往上找
  }
  for (let d = path.dirname(p), prev = p; d !== prev; prev = d, d = path.dirname(d)) {
    try {
      if (!statSync(d).isDirectory()) continue;
      const names = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(0, 10);
      return `workdir 不是存在的目录：${p}。${forward(d)} 里${names.length === 0 ? "没有子目录" : `的目录：${names.join("、")}`}。照抄正确的路径再调；确实要新目录，先用 bash 建好再调。`;
    } catch {
      // 上一级也读不了：再往上
    }
  }
  return `workdir 不是存在的目录：${p}`;
}

/** tools 的写法规整：逗号串拆开；内置名字的大小写改回；去掉每个进程都有的 self、handoff；按组给的工具名不能单独写。 */
function normTools(raw: unknown, toolsDir: string): string[] {
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) throw new Fail("tools 必须是合法工具名的数组。");
  const fixed = [...new Set((raw as string[]).flatMap((t) => t.split(/[\s,，、;；]+/)).filter((t) => t !== "").map((t) => (t.toLowerCase() !== t && BUILTIN.includes(t.toLowerCase()) && !existsSync(path.join(toolsDir, `${t}.json`)) ? t.toLowerCase() : t)))];
  if (fixed.some((t) => !TOOL_NAME.test(t))) throw new Fail("tools 必须是合法工具名的数组。");
  if (!same(fixed, raw)) note(`tools 当作 ${fixed.join("、")}`);
  const kept: string[] = [];
  for (const t of fixed) {
    if (t.toLowerCase() === "self" || t.toLowerCase() === "handoff") note(`去掉了 tools 里的 ${t}（每个进程都有）`);
    else kept.push(t);
  }
  const bad = kept.filter((t) => GROUP_OF[t] !== undefined && !kept.includes(GROUP_OF[t]!));
  if (bad.length > 0) {
    const fix = [...new Set(kept.map((t) => GROUP_OF[t] ?? t))];
    throw new Fail(
      `tools 里的 ${bad.join("、")} 不能单独给：工具按组给。要记忆工具写 memory（含 memory_get、memory_set、memory_edit、memory_delete）；要 post、spawn、stop_process 写 agents（含这三个）。` +
        `照这样：tools ${JSON.stringify(fix)}，其余参数不变。`,
    );
  }
  return kept.filter((t) => {
    const g = GROUP_OF[t];
    if (g !== undefined) note(`tools 里已经有 ${g}，去掉了多写的 ${t}`);
    return g === undefined;
  });
}

/** 校验并规范化新建预设的参数。 */
export function parseCreateArgs(args: Record<string, unknown>, env: Env = defaultEnv()): CreateFields {
  const id = checkPresetId(typeof args.id === "string" ? presetIdOf(args.id, env.presetsDir) : args.id);
  if (id !== args.id) note(`id ${String(args.id)} 当作 ${id}`);
  const rawWorkdir = singleLine("workdir", args.workdir);
  const workdir = winPathOf(rawWorkdir, env.cwd, env.home);
  if (workdir !== rawWorkdir) note(`workdir ${rawWorkdir} 当作 ${workdir}`);
  if (!isAbsoluteWinPath(workdir)) throw new Fail(`workdir 要写 Windows 绝对路径，例如 E:/tau，收到 ${rawWorkdir}。`);
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new Fail(missingDir(workdir));
  }
  const model = singleLine("model", args.model);
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new Fail(`model 格式应为 <provider>/<model-id>，收到 ${model}。list_presets 的 model 一栏就是这种写法。`);
  const tools = normTools(args.tools, env.toolsDir);
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
    const trimmed = [...new Set((args.context as string[]).map((x) => x.trim()).filter((x) => x !== ""))];
    // 内核只不许 context 里有半角逗号：一项里写了好几个就按半角逗号拆开。、，；; 在 Windows 文件名里合法，不拆。相对路径不换：它按预设的 workdir 解析。
    const items = [...new Set((args.context as string[]).flatMap((x) => x.split(",")).map((x) => winPathOf(x, null, env.home)).filter((x) => x !== ""))];
    if (!same(items, trimmed)) note(`context 当作 ${items.join("、")}`);
    if (items.length > CONTEXT_MAX_ITEMS) throw new Fail(`context 最多 ${CONTEXT_MAX_ITEMS} 项，收到 ${items.length} 项。只留最要紧的 ${CONTEXT_MAX_ITEMS} 个再调。`);
    if (items.some((x) => x.length > CONTEXT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(x))) {
      throw new Fail(`context 每项最长 ${CONTEXT_MAX_CHARS} 个字符，不能有控制字符。`);
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

/** 向服务发 check。返回快照和失败原因（没失败是 null）。 */
async function checkWithService(pipe: string, id: string): Promise<{ snapshot?: any; error: string | null }> {
  const state: { checked: { snapshot?: any; error: string | null } | null; protoErr: string | null } = { checked: null, protoErr: null };
  try {
    const ok = await talk(pipe, { op: "check", preset: id }, (r) => {
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
  return { snapshot: state.checked?.snapshot, error: state.protoErr ?? state.checked?.error ?? null };
}

/** check 报“找不到工具定义：X”时，接上能用的工具名（内置、已装、工具库里的，按名字排，文字固定）。 */
function toolHint(toolsDir: string, failMsg: string): string {
  const m = /找不到工具定义：([A-Za-z0-9_-]+)/.exec(failMsg);
  if (m === null) return "";
  const installed = readNames(toolsDir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  const library = CATALOG.map((c) => c.name).filter((n) => !installed.includes(n)).sort();
  const parts = [`内置 ${BUILTIN.join("、")}`, ...(installed.length > 0 ? [`已装的 ${installed.join("、")}`] : []), ...(library.length > 0 ? [`工具库里的 ${library.join("、")}`] : [])];
  return `能用的工具：${parts.join("；")}。${SEARCH_TOOLS.includes(m[1]!) ? "搜索和列目录用 bash（rg、ls）。" : ""}`;
}

export async function createPreset(
  rawArgs: Record<string, unknown>,
  opts: { tauHome: string; pipe: string; libDir: string; cwd?: string; home?: string },
): Promise<string> {
  const { args, unknown } = takeArgs("create_preset", rawArgs);
  refuseUnknown("create_preset", unknown, `create_preset 没有预演、覆盖这类开关：去掉 ${unknown.join("、")} 再调，就是照剩下的参数真的建预设（写文件）。只想看现有的预设，调 list_presets {}。`);
  const dir = presetsDir(opts.tauHome);
  const toolsDir = path.join(opts.tauHome, "tools");
  const fields = parseCreateArgs(args, { home: opts.home ?? homedir(), cwd: opts.cwd ?? process.cwd(), toolsDir, presetsDir: dir });
  const text = formatPresetMarkdown(fields);
  const file = path.join(dir, `${fields.id}.md`);
  const names = readNames(dir);
  if (names.includes(`${fields.id}.md`) && readFileSync(file, "utf8") === text) {
    // 同样的参数再调一次（没收到成功的信，或者被打断后重发）：不写，只补校验。
    ensureLibraryTools(opts.tauHome, fields.tools, opts.libDir);
    const again = await checkWithService(opts.pipe, fields.id);
    if (again.error !== null) {
      throw new Fail(
        `预设 ${fields.id} 已经在了，内容和这次要写的一样，但校验不过：${again.error}。这份文件多半是之前一次没校验完留下的。改好参数后，先 delete_preset ${JSON.stringify({ id: fields.id })}，再调 create_preset。`,
      );
    }
    return `预设 ${fields.id} 已经在了，内容和这次要写的一样，已校验，没有改动（${file}）。`;
  }
  const existing = names.find((n) => n.toLowerCase() === `${fields.id}.md`.toLowerCase());
  if (existing !== undefined) {
    let n = 2;
    while (names.some((x) => x.toLowerCase() === `${fields.id}-${n}.md`.toLowerCase())) n++;
    throw new Fail(`预设 ${fields.id} 已存在（${existing}），内容和这次的不同，不覆盖。换一个 id 再调，例如 ${fields.id}-${n}（没被占用），其余参数不变。要替换已有的 ${fields.id}，先问用户：删了找不回。`);
  }

  ensureLibraryTools(opts.tauHome, fields.tools, opts.libDir);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Fail(`预设已存在：${fields.id}`);
    throw e;
  }

  const checked = await checkWithService(opts.pipe, fields.id);
  if (checked.error !== null) {
    try {
      unlinkSync(file);
    } catch {
      // ignore rollback unlink errors
    }
    throw new Fail(`预设校验失败，已撤回 ${fields.id}.md：${checked.error}${/[。.]$/.test(checked.error) ? "" : "。"}${toolHint(toolsDir, checked.error)}`);
  }

  const snap = checked.snapshot;
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
