// 预设的列出和新建、删除。读预设不自己解析：经管道问服务的 `check`，读得出、能不能启动、错误文字都和 `start` 一致。
// 这里只写文件，不导入 src/。
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { HttpError, isAbsoluteWinPath, isObject } from "./util.ts";

const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CHECK_TIMEOUT_MS = 10_000;

export interface PresetOk {
  id: string;
  ok: true;
  workdir: string;
  model: string;
  tools: string[];
  memory: boolean;
  thinking?: string;
  handoff?: number;
  options?: Record<string, unknown>;
}
export type PresetInfo = PresetOk | { id: string; ok: false; error: string };

/** 问服务一次 `check`。回 `check` 行，或者 `error` 的原文。连不上抛 503。 */
function check(pipe: string, id: string): Promise<{ snapshot: any; error: string | null } | { fail: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let buf = "";
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      f();
    };
    const timer = setTimeout(() => finish(() => reject(new HttpError(504, "tau 服务没有回应 check"))), CHECK_TIMEOUT_MS);
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "check", preset: id })}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let r: any;
      try {
        r = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(() => reject(new HttpError(502, "tau 服务回的不是 JSON")));
      }
      if (r.type === "check") finish(() => resolve({ snapshot: r.snapshot, error: typeof r.error === "string" ? r.error : null }));
      else if (r.type === "error") finish(() => resolve({ fail: String(r.message) }));
      else finish(() => reject(new HttpError(502, "tau 服务回了意外的内容")));
    });
    socket.on("error", () => finish(() => reject(new HttpError(503, "连不上 tau 服务，先运行 tau serve"))));
    socket.on("close", () => finish(() => reject(new HttpError(503, "tau 服务在回复前断开了"))));
  });
}

type Checked = Awaited<ReturnType<typeof check>>;

/** 一个预设此刻读成什么。读不出或者装不下，都是 `ok: false`，文字和 `start` 的一样。 */
export async function presetInfo(pipe: string, id: string): Promise<PresetInfo> {
  return infoOf(id, await check(pipe, id));
}

function infoOf(id: string, r: Checked): PresetInfo {
  if ("fail" in r) return { id, ok: false, error: r.fail };
  if (r.error !== null) return { id, ok: false, error: r.error };
  const s = r.snapshot;
  const tools: string[] = [...s.tools, ...s.toolDefs.map((d: { name: string }) => d.name)];
  return {
    id,
    ok: true,
    workdir: s.workdir,
    model: s.model,
    tools,
    memory: tools.includes("memory"),
    ...(s.thinking === undefined ? {} : { thinking: s.thinking }),
    ...(s.handoff === undefined ? {} : { handoff: s.handoff }),
    ...(s.options === undefined ? {} : { options: s.options }),
  };
}

/** `presets/` 下每个 `.md` 一项，按 ID 排序。没有目录是空列表。 */
export async function listPresets(home: string, pipe: string): Promise<PresetInfo[]> {
  let names: string[];
  try {
    names = readdirSync(path.join(home, "presets"));
  } catch {
    return [];
  }
  const ids = names.filter((n) => n.endsWith(".md")).sort().map((n) => n.slice(0, -3));
  return Promise.all(ids.map((id) => presetInfo(pipe, id)));
}

export async function presetWorkdirs(home: string, pipe: string): Promise<string[]> {
  return (await listPresets(home, pipe)).flatMap((p) => (p.ok ? [p.workdir] : []));
}

function line(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || /[\r\n]/.test(v)) throw new HttpError(400, `${name} 必须是单行的非空字符串`);
  return v.trim();
}

function presetId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw) || /^\.+$/.test(raw) || raw.endsWith(".")) throw new HttpError(400, "预设 ID 只许字母、数字、点、下划线和连字符");
  return raw;
}

/** 头部的可选字段，按写入顺序。`partial` 为真（改预设）时都可以不给，`null` 表示删掉这一行。 */
function headFields(body: Record<string, unknown>, partial: boolean): [string, string | null][] {
  const out: [string, string | null][] = [];
  if (!partial || body.model !== undefined) {
    const model = line("model", body.model);
    if (!/^[^/\s]+\/\S+$/.test(model)) throw new HttpError(400, "模型格式应为 <provider>/<model-id>");
    out.push(["model", model]);
  }
  if (!partial || body.tools !== undefined) {
    const tools = body.tools;
    if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !/^[A-Za-z0-9._-]+$/.test(t))) throw new HttpError(400, "tools 必须是名字的数组");
    out.push(["tools", tools.join(", ")]);
  }
  if (body.thinking !== undefined && !(partial && body.thinking === null)) {
    if (typeof body.thinking !== "string" || !THINKING.includes(body.thinking)) throw new HttpError(400, `thinking 只能是 ${THINKING.join(", ")}`);
    out.push(["thinking", body.thinking]);
  } else if (partial && body.thinking === null) out.push(["thinking", null]);
  if (body.handoff !== undefined && !(partial && body.handoff === null)) {
    const n = body.handoff;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || String(n).length > 15) throw new HttpError(400, "handoff 必须是正整数（token）");
    out.push(["handoff", String(n)]);
  } else if (partial && body.handoff === null) out.push(["handoff", null]);
  if (body.options !== undefined && !(partial && body.options === null)) {
    if (!isObject(body.options)) throw new HttpError(400, "options 必须是对象");
    out.push(["options", JSON.stringify(body.options)]);
  } else if (partial && body.options === null) out.push(["options", null]);
  return out;
}

export function createPreset(home: string, body: Record<string, unknown>): void {
  const id = presetId(body.id);
  const workdir = line("workdir", body.workdir);
  if (!isAbsoluteWinPath(workdir)) throw new HttpError(400, "工作目录必须是绝对路径");
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "工作目录不存在");
  }
  const fields = headFields(body, false);
  if (typeof body.prompt !== "string") throw new HttpError(400, "prompt 必须是字符串");
  const head = [`workdir: ${workdir}`, ...fields.map(([k, v]) => `${k}: ${v}`)];
  const dir = path.join(home, "presets");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, `${id}.md`), `---\n${head.join("\n")}\n---\n${body.prompt.trim()}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `预设已经存在：${id}`);
    throw e;
  }
}

/**
 * 在预设文本上改头部的几行：已有的原位替换，`null` 删掉，没有的追加到头部末尾；别的行、换行符、BOM 原样。
 * `prompt` 给了就换掉整个正文。文本没有头部就抛 400。
 */
export function patchPreset(text: string, fields: [string, string | null][], prompt: string | undefined): string {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const eol = /^[^\n]*\r\n/.test(body) ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) throw new HttpError(400, "预设文件的头部读不懂，请在编辑器里改");
  const head = lines.slice(1, end);
  for (const [key, value] of fields) {
    const i = head.findIndex((l) => l.slice(0, Math.max(0, l.indexOf(":"))).trim() === key);
    if (i >= 0) {
      if (value === null) head.splice(i, 1);
      else head[i] = `${key}: ${value}`;
    } else if (value !== null) head.push(`${key}: ${value}`);
  }
  const rest = prompt === undefined ? lines.slice(end + 1) : [prompt.trim(), ""];
  return (bom ? "\uFEFF" : "") + ["---", ...head, "---", ...rest].join(eol);
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

let updating: Promise<unknown> = Promise.resolve();

/**
 * 改预设：只换收到的字段（model、thinking、tools、handoff、options、prompt）。写临时文件再改名，
 * 写完立刻 check；读不出或起不来，改回旧文件，错误原文抛 422。预设 ID 和工作目录不能改。
 * 一次只改一个，免得两次改动互相覆盖。
 */
export function updatePreset(home: string, pipe: string, body: Record<string, unknown>): Promise<PresetOk> {
  const run = updating.then(() => doUpdate(home, pipe, body));
  updating = run.catch(() => {});
  return run;
}

async function doUpdate(home: string, pipe: string, body: Record<string, unknown>): Promise<PresetOk> {
  const id = presetId(body.id);
  const fields = headFields(body, true);
  if (body.prompt !== undefined && typeof body.prompt !== "string") throw new HttpError(400, "prompt 必须是字符串");
  if (fields.length === 0 && body.prompt === undefined) throw new HttpError(400, "没有要改的字段");
  const file = path.join(home, "presets", `${id}.md`);
  let old: Buffer;
  try {
    old = readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `没有这个预设：${id}`);
    throw e;
  }
  writeAtomic(file, patchPreset(old.toString("utf8"), fields, body.prompt as string | undefined));
  let info: PresetInfo | undefined;
  try {
    info = infoOf(id, await check(pipe, id));
  } finally {
    if (info === undefined || !info.ok) writeAtomic(file, old);
  }
  if (!info.ok) throw new HttpError(422, info.error);
  return info;
}

/** 删 `presets/<ID>.md`。记忆库不动。 */
export function deletePreset(home: string, body: Record<string, unknown>): void {
  const id = presetId(body.id);
  try {
    unlinkSync(path.join(home, "presets", `${id}.md`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `没有这个预设：${id}`);
    throw e;
  }
}
